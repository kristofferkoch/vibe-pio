// pio_block — one PIO block, assembled (KANBAN C10): instruction memory
// (C1, u_imem), four state machines (C9, u_sm0..u_sm3 — no generate,
// DESIGN.md conventions), the IRQ flag block (C6, u_irq) and the GPIO
// window mux (C7, u_gpio), all behind a flat reg-bus slave whose decode
// mirrors the datasheet register map 1:1 (SPEC-7-x; DESIGN.md §Interface
// decisions #3). One PIO block per instance; pio_top (later card) owns
// the 3-block assembly, the pad-window selection (GPIOBASE, SPEC-1-4)
// and the cross-block IRQ relay registers (CC-38).
//
// Block-boundary cycle contracts owned here:
//   CC-33 — an INSTR_MEM write retiring at end of clk e is visible to
//           every fetch from e+1 (u_imem's combinational read at each
//           SM's pc; no prefetch, no bypass).
//   CC-30 — a TXFx write retiring at end of clk e reaches the SM's FIFO
//           level from e+1, releasing a stalled blocking PULL on the
//           SM's first tick >= e+1; RXFx/FLEVEL/FSTAT reads observe the
//           registered levels.
//   CC-37 — the flag path stays registered end-to-end: SMs and the bus
//           read u_irq's flag register only; IRQ / IRQ_FORCE writes and
//           the imported nb_set/nb_clr requests land at the write edge
//           (clear-wins per CC-39) and are visible from the next cycle.
//
// Register decode (word index widx = reg_addr[8:2]; byte map SPEC-7-x):
//   0x000 CTRL (SM_ENABLE storage; SM_RESTART / CLKDIV_RESTART are
//          self-clearing one-clk pulses off the write strobe, SPEC-7-2..4),
//   0x004 FSTAT RO, 0x008 FDEBUG W1C, 0x00c FLEVEL RO (SPEC-7-29),
//   0x010..0x01c TXF0..3 WO (SPEC-7-28), 0x020..0x02c RXF0..3 RO,
//   0x030 IRQ W1C, 0x034 IRQ_FORCE (SPEC-7-6), 0x038 INPUT_SYNC_BYPASS
//          RW (SPEC-7-7), 0x03c/0x040 DBG_PADOUT/DBG_PADOE RO (SPEC-7-8),
//   0x044 DBG_CFGINFO RO (SPEC-7-9), 0x048..0x0c4 INSTR_MEM0..31 WO
//          (SPEC-7-10), 0x0c8+0x18*i SMx window (SPEC-7-14..26; SMx_INSTR
//          write = forced instruction SPEC-7-23, read = imem[pc]
//          SPEC-7-24), 0x128+0x10*x+4*y RXFx_PUTGETy (SPEC-7-13).
//   Undecoded (reads 0, writes ignored): CTRL NEXTPREV_* and PREV/NEXT
//   masks (SPEC-7-5 — pio_top's cross-block fan-out), GPIOBASE (SPEC-7-11
//   — window selection is pio_top's), IRQ0/1 INTE/INTF/INTS (SPEC-7-12 —
//   interrupt-controller integration is a non-goal; the INTR composition
//   itself is exported on `intr`).
//
// Datasheet reset defaults on every field: CTRL 0, INPUT_SYNC_BYPASS 0
// (block regs below), the SM config banks / FIFO stickies / divider /
// IRQ flags / GPIO registers inside their owner modules (SPEC-7-26 and
// per-module resets).

module pio_block (
    input  logic clk,
    input  logic rst,

    // Flat reg-bus slave (DESIGN.md §Interface decisions #3): reg_addr
    // is the datasheet byte address of a word register (0x000..0x184 —
    // 9 bits; the RP2350 map outgrew one byte when SM3/PUTGET landed),
    // strobes one clk wide, one-clk retire, no wait states.
    input  logic [8:0]  reg_addr,
    input  logic [31:0] reg_wdata,
    input  logic        reg_write,
    input  logic        reg_read,
    output logic [31:0] reg_rdata,

    // 32-pin GPIO window (SPEC-1-4; GPIOBASE windowing is pio_top's).
    input  logic [31:0] gpio_in,
    output logic [31:0] gpio_out,
    output logic [31:0] gpio_oe,

    // IRQ: neighbour flag views for JMP/WAIT PREV/NEXT (SPEC-3.8-5/7;
    // CC-38 — pio_top registers the neighbour's flags), imported
    // neighbour requests (one-clk registered at pio_top, CC-38/CC-39),
    // and this block's flag register + PREV/NEXT-mode SM exports for
    // the relay.
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr,
    output logic [7:0]  irq_prev_o,
    output logic [7:0]  irq_next_o,
    output logic [7:0]  prev_exp_set,
    output logic [7:0]  prev_exp_clr,
    output logic [7:0]  next_exp_set,
    output logic [7:0]  next_exp_clr,

    // INTR composition (SPEC-7-12): SM flags 15:8, TXNFULL 7:4,
    // RXNEMPTY 3:0. Stub — no interrupt controller (non-goal).
    output logic [15:0] intr,

    // Verification readbacks (formal C10; pio_top leaves them dangling —
    // same rationale as C7/C9: yosys cannot probe instance internals
    // from a wrapper, and these keep the block-level invariants
    // port-observable equations).
    output logic [3:0]     dbg_sm_en,   // CTRL.SM_ENABLE bank (SPEC-7-2)
    output logic [3:0][4:0] dbg_sm_pc,  // SM PCs — the fetch addrs (CC-33)
    output logic [3:0]     dbg_force,   // per-SM force_tick (CC-35)

    // SM0 live-state view for the wasm engine's browser client (C18;
    // SPEC-16-4 single-SM scope): phase, scratch, shifters, FIFO level
    // and the per-clk strobes the view animates from. SM1..3 stay
    // dangling (the pio_sm dbg idiom); pio_top leaves all of these
    // dangling too.
    output logic [3:0]  dbg_sm0_state,    // u_exec onehot FSM (ST_*)
    output logic [4:0]  dbg_sm0_delay,    // delay countdown (CC-10)
    output logic [31:0] dbg_sm0_x,        // G2 scratch
    output logic [31:0] dbg_sm0_y,
    output logic [31:0] dbg_sm0_osr,      // u_shift shifter view (SPEC-5-1)
    output logic [31:0] dbg_sm0_isr,
    output logic [5:0]  dbg_sm0_osr_cnt,  // saturating counters (SPEC-5-4)
    output logic [5:0]  dbg_sm0_isr_cnt,
    output logic [3:0]  dbg_sm0_tx_level, // FLEVEL TX nibble (SPEC-6-6)
    output logic [3:0]  dbg_sm0_rx_level,
    output logic        dbg_sm0_tx_empty, // FSTAT bits (SPEC-7-29)
    output logic        dbg_sm0_tx_full,
    output logic        dbg_sm0_tick,     // sm_tick strobe (CC-1)
    output logic        dbg_sm0_exec,     // an instruction executes this clk
    output logic        dbg_sm0_complete, // …and completes (effects land)
    output logic        dbg_sm0_pc_wr,    // taken jmp / explicit PC write
    output logic        dbg_sm0_tx_pop,   // PULL consumed a TX word (CC-29)
    output logic        dbg_sm0_rx_push   // PUSH wrote RX (CC-9)
);

  // -----------------------------------------------------------------------
  // Address decode — word index (SPEC-7-x byte map, word-aligned).
  // -----------------------------------------------------------------------
  logic [6:0] widx_c;
  assign widx_c = reg_addr[8:2];

  // Range hits and sub-decodes (bounds from the map above).
  logic imem_hit_c, sm_hit_c, aux_hit_c;
  logic [4:0] imem_addr_c;
  logic [1:0] sm_sel_c, aux_sel_c;
  logic [2:0] sm_reg_c;
  logic [1:0] aux_idx_c;
  logic [6:0] sm_off_c, aux_off_c;

  assign imem_hit_c = (widx_c >= 7'd18) && (widx_c <= 7'd49); // 0x048..0x0c4
  assign imem_addr_c = 5'(widx_c - 7'd18);                    // SPEC-7-10
  assign sm_hit_c   = (widx_c >= 7'd50) && (widx_c <= 7'd73); // 0x0c8..0x124
  assign aux_hit_c  = (widx_c >= 7'd74) && (widx_c <= 7'd89); // 0x128..0x164
  assign sm_off_c   = widx_c - 7'd50;   // 0..23 inside the SM window
  assign aux_off_c  = widx_c - 7'd74;   // 0..15 inside the PUTGET window

  always_comb begin
    // SM window: stride 6 words (0x18) per SM (SPEC-7 "Per-SM" heading).
    if      (sm_hit_c && sm_off_c >= 7'd18) sm_sel_c = 2'd3;
    else if (sm_hit_c && sm_off_c >= 7'd12) sm_sel_c = 2'd2;
    else if (sm_hit_c && sm_off_c >= 7'd6)  sm_sel_c = 2'd1;
    else                                    sm_sel_c = 2'd0;
    sm_reg_c = 3'(sm_off_c - 7'd6 * {5'd0, sm_sel_c});
    // PUTGET window: stride 4 words (0x10) per SM (SPEC-7-13).
    aux_sel_c = 2'(aux_off_c >> 2);
    aux_idx_c = aux_off_c[1:0];
  end

  // -----------------------------------------------------------------------
  // Block-level registers (datasheet reset defaults; one always_ff per
  // register group).
  // -----------------------------------------------------------------------
  logic [3:0]  ctrl_r;   // CTRL.SM_ENABLE storage (SPEC-7-2; reset 0)
  logic [31:0] isb_r;    // INPUT_SYNC_BYPASS (SPEC-7-7; reset 0)

  always_ff @(posedge clk) begin
    if (rst) ctrl_r <= 4'd0;
    else if (reg_write && (widx_c == 7'd0)) ctrl_r <= reg_wdata[3:0];
  end

  always_ff @(posedge clk) begin
    if (rst) isb_r <= 32'd0;
    else if (reg_write && (widx_c == 7'd14)) isb_r <= reg_wdata;
  end

  // IRQ bus writes (SPEC-7-6): W1C on IRQ, set-on-write on IRQ_FORCE —
  // one-clk vectors, retired by u_irq at the write edge (CC-37/CC-39).
  logic [7:0] irq_w1c_c, irq_force_c;
  assign irq_w1c_c   = (reg_write && (widx_c == 7'd12)) ? reg_wdata[7:0] : 8'd0;
  assign irq_force_c = (reg_write && (widx_c == 7'd13)) ? reg_wdata[7:0] : 8'd0;

  // -----------------------------------------------------------------------
  // Per-SM decode products (writes forwarded as one-clk strobes, SPEC-7-25
  // — a write retiring at end of e is visible to consumers from e+1).
  // -----------------------------------------------------------------------
  logic [3:0] clkdiv_we, execctrl_we, shiftctrl_we, pinctrl_we;
  logic [3:0] force_we, sm_restart, clkdiv_restart;
  logic [3:0] sys_tx_wr, sys_rx_rd, sys_aux_wr, sys_aux_rd;
  logic [3:0][3:0] fdbg_clr;   // per-SM {tx_stall,rx_stall,tx_over,rx_under}

  always_comb begin
    for (int i = 0; i < 4; i++) begin
      clkdiv_we[i]       = reg_write && sm_hit_c && (sm_sel_c == 2'(i)) && (sm_reg_c == 3'd0);
      execctrl_we[i]     = reg_write && sm_hit_c && (sm_sel_c == 2'(i)) && (sm_reg_c == 3'd1);
      shiftctrl_we[i]    = reg_write && sm_hit_c && (sm_sel_c == 2'(i)) && (sm_reg_c == 3'd2);
      pinctrl_we[i]      = reg_write && sm_hit_c && (sm_sel_c == 2'(i)) && (sm_reg_c == 3'd5);
      force_we[i]        = reg_write && sm_hit_c && (sm_sel_c == 2'(i)) && (sm_reg_c == 3'd4);
      // CTRL self-clearing pulses (SPEC-7-3/4): one clk by construction,
      // the write strobe is one clk.
      sm_restart[i]      = reg_write && (widx_c == 7'd0) && reg_wdata[4+i];
      clkdiv_restart[i]  = reg_write && (widx_c == 7'd0) && reg_wdata[8+i];
      // FIFO system side (SPEC-7-28/13): TX push on write, RX pop on read.
      sys_tx_wr[i]       = reg_write && (widx_c == 7'(4 + i));
      sys_rx_rd[i]       = reg_read  && (widx_c == 7'(8 + i));
      sys_aux_wr[i]      = reg_write && aux_hit_c && (aux_sel_c == 2'(i));
      sys_aux_rd[i]      = reg_read  && aux_hit_c && (aux_sel_c == 2'(i));
      // FDEBUG W1C (SPEC-7-29 layout): TXSTALL 27:24, TXOVER 19:16,
      // RXUNDER 11:8, RXSTALL 3:0 -> u_fifo's {tx_stall,rx_stall,tx_over,
      // rx_under} bit order.
      fdbg_clr[i] = (reg_write && (widx_c == 7'd2))
                    ? {reg_wdata[24+i], reg_wdata[0+i], reg_wdata[16+i], reg_wdata[8+i]}
                    : 4'd0;
    end
  end

  // -----------------------------------------------------------------------
  // SM-facing nets (bundled per SM index; each SM instance below drives
  // or reads its slice). Declared ahead of all instances.
  // -----------------------------------------------------------------------
  logic [3:0][4:0]  sm_pc;
  logic [3:0][3:0]  sm_tx_level, sm_rx_level;
  logic [3:0]       sm_exec_stalled, sm_out_sticky;
  logic [3:0]       sm_tx_full, sm_tx_empty, sm_rx_full, sm_rx_empty;
  logic [3:0][31:0] sm_clkdiv_q, sm_execctrl_q, sm_shiftctrl_q, sm_pinctrl_q;
  logic [3:0][4:0]  sm_in_base, sm_in_count, sm_jmp_pin;

  logic [3:0]       sm_out_we, sm_out_pindir, sm_set_we, sm_set_pindir;
  logic [3:0]       sm_ss_we, sm_ss_pindir;
  logic [3:0][4:0]  sm_out_base, sm_set_base, sm_set_data;
  logic [3:0][4:0]  sm_ss_base, sm_ss_data;
  logic [3:0][5:0]  sm_out_count;
  logic [3:0][2:0]  sm_set_num, sm_ss_num;
  logic [3:0][31:0] sm_out_data;

  logic [3:0]       sm_irq_set, sm_irq_clr;
  logic [3:0][2:0]  sm_irq_idx;
  logic [3:0][1:0]  sm_irq_mode;

  logic [3:0][31:0] sm_sys_rx_rdata, sm_sys_aux_rdata;

  logic [3:0]       sm_fdbg_tx_stall, sm_fdbg_rx_stall;
  logic [3:0]       sm_fdbg_tx_over, sm_fdbg_rx_under;

  logic [3:0][31:0] gm_in_bus;
  logic [31:0]      gpio_seen_c;
  logic [7:0]       irq_flags;
  logic [3:0][15:0] imem_rd_c;
  logic [3:0]       sm_dbg_force;

  // -----------------------------------------------------------------------
  // u_imem (C1): 1 write port from the INSTR_MEM decode (SPEC-7-10),
  // 4 combinational read ports at the SMs' PCs (CC-33).
  // -----------------------------------------------------------------------
  pio_instr_mem u_imem (
      .clk      (clk),
      .rst      (rst),
      .wr_en    (reg_write && imem_hit_c),
      .wr_addr  (imem_addr_c),
      .wr_data  (reg_wdata[15:0]),
      .rd_addr0 (sm_pc[0]),
      .rd_addr1 (sm_pc[1]),
      .rd_addr2 (sm_pc[2]),
      .rd_addr3 (sm_pc[3]),
      .rd_data0 (imem_rd_c[0]),
      .rd_data1 (imem_rd_c[1]),
      .rd_data2 (imem_rd_c[2]),
      .rd_data3 (imem_rd_c[3])
  );

  // -----------------------------------------------------------------------
  // u_sm0..u_sm3 (C9). dbg_* verification readbacks stay dangling
  // (DESIGN.md §pio_sm assembly notes); config wdata is common to all.
  // -----------------------------------------------------------------------
  pio_sm #(.SM_IDX(2'd0)) u_sm0 (
      .clk             (clk),
      .rst             (rst),
      .instr           (imem_rd_c[0]),
      .gpio_seen       (gpio_seen_c),
      .in_bus          (gm_in_bus[0]),
      .irq_flags       (irq_flags),
      .irq_prev_r      (irq_prev_r),
      .irq_next_r      (irq_next_r),
      .clkdiv_we       (clkdiv_we[0]),
      .clkdiv_wdata    (reg_wdata),
      .execctrl_we     (execctrl_we[0]),
      .execctrl_wdata  (reg_wdata),
      .shiftctrl_we    (shiftctrl_we[0]),
      .shiftctrl_wdata (reg_wdata),
      .pinctrl_we      (pinctrl_we[0]),
      .pinctrl_wdata   (reg_wdata),
      .sm_en           (ctrl_r[0]),
      .sm_restart      (sm_restart[0]),
      .clkdiv_restart  (clkdiv_restart[0]),
      .force_we        (force_we[0]),
      .force_instr     (reg_wdata[15:0]),
      .gpio_out_we     (sm_out_we[0]),
      .gpio_out_pindir (sm_out_pindir[0]),
      .gpio_out_base   (sm_out_base[0]),
      .gpio_out_count  (sm_out_count[0]),
      .gpio_out_data   (sm_out_data[0]),
      .gpio_set_we     (sm_set_we[0]),
      .gpio_set_pindir (sm_set_pindir[0]),
      .gpio_set_base   (sm_set_base[0]),
      .gpio_set_num    (sm_set_num[0]),
      .gpio_set_data   (sm_set_data[0]),
      .gpio_ss_we      (sm_ss_we[0]),
      .gpio_ss_pindir  (sm_ss_pindir[0]),
      .gpio_ss_base    (sm_ss_base[0]),
      .gpio_ss_num     (sm_ss_num[0]),
      .gpio_ss_data    (sm_ss_data[0]),
      .out_sticky      (sm_out_sticky[0]),
      .irq_set_req     (sm_irq_set[0]),
      .irq_clr_req     (sm_irq_clr[0]),
      .irq_flag_idx    (sm_irq_idx[0]),
      .irq_idx_mode    (sm_irq_mode[0]),
      .sys_tx_wr       (sys_tx_wr[0]),
      .sys_tx_wdata    (reg_wdata),
      .sys_rx_rd       (sys_rx_rd[0]),
      .sys_rx_rdata    (sm_sys_rx_rdata[0]),
      .sys_aux_wr      (sys_aux_wr[0]),
      .sys_aux_addr    (aux_idx_c),
      .sys_aux_wdata   (reg_wdata),
      .sys_aux_rd      (sys_aux_rd[0]),
      .sys_aux_rdata   (sm_sys_aux_rdata[0]),
      .fdbg_clr        (fdbg_clr[0]),
      .fdbg_tx_stall   (sm_fdbg_tx_stall[0]),
      .fdbg_rx_stall   (sm_fdbg_rx_stall[0]),
      .fdbg_tx_over    (sm_fdbg_tx_over[0]),
      .fdbg_rx_under   (sm_fdbg_rx_under[0]),
      .pc              (sm_pc[0]),
      .tx_level        (sm_tx_level[0]),
      .rx_level        (sm_rx_level[0]),
      .exec_stalled    (sm_exec_stalled[0]),
      .tx_full         (sm_tx_full[0]),
      .tx_empty        (sm_tx_empty[0]),
      .rx_full         (sm_rx_full[0]),
      .rx_empty        (sm_rx_empty[0]),
      .clkdiv_q        (sm_clkdiv_q[0]),
      .execctrl_q      (sm_execctrl_q[0]),
      .shiftctrl_q     (sm_shiftctrl_q[0]),
      .pinctrl_q       (sm_pinctrl_q[0]),
      .cfg_in_base     (sm_in_base[0]),
      .cfg_in_count    (sm_in_count[0]),
      .cfg_jmp_pin     (sm_jmp_pin[0]),
      .dbg_force_tick  (sm_dbg_force[0]),
      // SM0 view bundle (C18, SPEC-16-4): the wasm client's live state.
      .dbg_sm_tick     (dbg_sm0_tick),
      .dbg_state       (dbg_sm0_state),
      .dbg_delay       (dbg_sm0_delay),
      .dbg_x           (dbg_sm0_x),
      .dbg_y           (dbg_sm0_y),
      .dbg_pc_wr       (dbg_sm0_pc_wr),
      .dbg_exec        (dbg_sm0_exec),
      .dbg_complete    (dbg_sm0_complete),
      .dbg_tx_pop      (dbg_sm0_tx_pop),
      .dbg_rx_push     (dbg_sm0_rx_push),
      .dbg_osr         (dbg_sm0_osr),
      .dbg_isr         (dbg_sm0_isr),
      .dbg_osr_cnt     (dbg_sm0_osr_cnt),
      .dbg_isr_cnt     (dbg_sm0_isr_cnt),
      .dbg_tx_empty    (dbg_sm0_tx_empty)
  );

  pio_sm #(.SM_IDX(2'd1)) u_sm1 (
      .clk             (clk),
      .rst             (rst),
      .instr           (imem_rd_c[1]),
      .gpio_seen       (gpio_seen_c),
      .in_bus          (gm_in_bus[1]),
      .irq_flags       (irq_flags),
      .irq_prev_r      (irq_prev_r),
      .irq_next_r      (irq_next_r),
      .clkdiv_we       (clkdiv_we[1]),
      .clkdiv_wdata    (reg_wdata),
      .execctrl_we     (execctrl_we[1]),
      .execctrl_wdata  (reg_wdata),
      .shiftctrl_we    (shiftctrl_we[1]),
      .shiftctrl_wdata (reg_wdata),
      .pinctrl_we      (pinctrl_we[1]),
      .pinctrl_wdata   (reg_wdata),
      .sm_en           (ctrl_r[1]),
      .sm_restart      (sm_restart[1]),
      .clkdiv_restart  (clkdiv_restart[1]),
      .force_we        (force_we[1]),
      .force_instr     (reg_wdata[15:0]),
      .gpio_out_we     (sm_out_we[1]),
      .gpio_out_pindir (sm_out_pindir[1]),
      .gpio_out_base   (sm_out_base[1]),
      .gpio_out_count  (sm_out_count[1]),
      .gpio_out_data   (sm_out_data[1]),
      .gpio_set_we     (sm_set_we[1]),
      .gpio_set_pindir (sm_set_pindir[1]),
      .gpio_set_base   (sm_set_base[1]),
      .gpio_set_num    (sm_set_num[1]),
      .gpio_set_data   (sm_set_data[1]),
      .gpio_ss_we      (sm_ss_we[1]),
      .gpio_ss_pindir  (sm_ss_pindir[1]),
      .gpio_ss_base    (sm_ss_base[1]),
      .gpio_ss_num     (sm_ss_num[1]),
      .gpio_ss_data    (sm_ss_data[1]),
      .out_sticky      (sm_out_sticky[1]),
      .irq_set_req     (sm_irq_set[1]),
      .irq_clr_req     (sm_irq_clr[1]),
      .irq_flag_idx    (sm_irq_idx[1]),
      .irq_idx_mode    (sm_irq_mode[1]),
      .sys_tx_wr       (sys_tx_wr[1]),
      .sys_tx_wdata    (reg_wdata),
      .sys_rx_rd       (sys_rx_rd[1]),
      .sys_rx_rdata    (sm_sys_rx_rdata[1]),
      .sys_aux_wr      (sys_aux_wr[1]),
      .sys_aux_addr    (aux_idx_c),
      .sys_aux_wdata   (reg_wdata),
      .sys_aux_rd      (sys_aux_rd[1]),
      .sys_aux_rdata   (sm_sys_aux_rdata[1]),
      .fdbg_clr        (fdbg_clr[1]),
      .fdbg_tx_stall   (sm_fdbg_tx_stall[1]),
      .fdbg_rx_stall   (sm_fdbg_rx_stall[1]),
      .fdbg_tx_over    (sm_fdbg_tx_over[1]),
      .fdbg_rx_under   (sm_fdbg_rx_under[1]),
      .pc              (sm_pc[1]),
      .tx_level        (sm_tx_level[1]),
      .rx_level        (sm_rx_level[1]),
      .exec_stalled    (sm_exec_stalled[1]),
      .tx_full         (sm_tx_full[1]),
      .tx_empty        (sm_tx_empty[1]),
      .rx_full         (sm_rx_full[1]),
      .rx_empty        (sm_rx_empty[1]),
      .clkdiv_q        (sm_clkdiv_q[1]),
      .execctrl_q      (sm_execctrl_q[1]),
      .shiftctrl_q     (sm_shiftctrl_q[1]),
      .pinctrl_q       (sm_pinctrl_q[1]),
      .cfg_in_base     (sm_in_base[1]),
      .cfg_in_count    (sm_in_count[1]),
      .cfg_jmp_pin     (sm_jmp_pin[1]),
      .dbg_force_tick  (sm_dbg_force[1])
  );

  pio_sm #(.SM_IDX(2'd2)) u_sm2 (
      .clk             (clk),
      .rst             (rst),
      .instr           (imem_rd_c[2]),
      .gpio_seen       (gpio_seen_c),
      .in_bus          (gm_in_bus[2]),
      .irq_flags       (irq_flags),
      .irq_prev_r      (irq_prev_r),
      .irq_next_r      (irq_next_r),
      .clkdiv_we       (clkdiv_we[2]),
      .clkdiv_wdata    (reg_wdata),
      .execctrl_we     (execctrl_we[2]),
      .execctrl_wdata  (reg_wdata),
      .shiftctrl_we    (shiftctrl_we[2]),
      .shiftctrl_wdata (reg_wdata),
      .pinctrl_we      (pinctrl_we[2]),
      .pinctrl_wdata   (reg_wdata),
      .sm_en           (ctrl_r[2]),
      .sm_restart      (sm_restart[2]),
      .clkdiv_restart  (clkdiv_restart[2]),
      .force_we        (force_we[2]),
      .force_instr     (reg_wdata[15:0]),
      .gpio_out_we     (sm_out_we[2]),
      .gpio_out_pindir (sm_out_pindir[2]),
      .gpio_out_base   (sm_out_base[2]),
      .gpio_out_count  (sm_out_count[2]),
      .gpio_out_data   (sm_out_data[2]),
      .gpio_set_we     (sm_set_we[2]),
      .gpio_set_pindir (sm_set_pindir[2]),
      .gpio_set_base   (sm_set_base[2]),
      .gpio_set_num    (sm_set_num[2]),
      .gpio_set_data   (sm_set_data[2]),
      .gpio_ss_we      (sm_ss_we[2]),
      .gpio_ss_pindir  (sm_ss_pindir[2]),
      .gpio_ss_base    (sm_ss_base[2]),
      .gpio_ss_num     (sm_ss_num[2]),
      .gpio_ss_data    (sm_ss_data[2]),
      .out_sticky      (sm_out_sticky[2]),
      .irq_set_req     (sm_irq_set[2]),
      .irq_clr_req     (sm_irq_clr[2]),
      .irq_flag_idx    (sm_irq_idx[2]),
      .irq_idx_mode    (sm_irq_mode[2]),
      .sys_tx_wr       (sys_tx_wr[2]),
      .sys_tx_wdata    (reg_wdata),
      .sys_rx_rd       (sys_rx_rd[2]),
      .sys_rx_rdata    (sm_sys_rx_rdata[2]),
      .sys_aux_wr      (sys_aux_wr[2]),
      .sys_aux_addr    (aux_idx_c),
      .sys_aux_wdata   (reg_wdata),
      .sys_aux_rd      (sys_aux_rd[2]),
      .sys_aux_rdata   (sm_sys_aux_rdata[2]),
      .fdbg_clr        (fdbg_clr[2]),
      .fdbg_tx_stall   (sm_fdbg_tx_stall[2]),
      .fdbg_rx_stall   (sm_fdbg_rx_stall[2]),
      .fdbg_tx_over    (sm_fdbg_tx_over[2]),
      .fdbg_rx_under   (sm_fdbg_rx_under[2]),
      .pc              (sm_pc[2]),
      .tx_level        (sm_tx_level[2]),
      .rx_level        (sm_rx_level[2]),
      .exec_stalled    (sm_exec_stalled[2]),
      .tx_full         (sm_tx_full[2]),
      .tx_empty        (sm_tx_empty[2]),
      .rx_full         (sm_rx_full[2]),
      .rx_empty        (sm_rx_empty[2]),
      .clkdiv_q        (sm_clkdiv_q[2]),
      .execctrl_q      (sm_execctrl_q[2]),
      .shiftctrl_q     (sm_shiftctrl_q[2]),
      .pinctrl_q       (sm_pinctrl_q[2]),
      .cfg_in_base     (sm_in_base[2]),
      .cfg_in_count    (sm_in_count[2]),
      .cfg_jmp_pin     (sm_jmp_pin[2]),
      .dbg_force_tick  (sm_dbg_force[2])
  );

  pio_sm #(.SM_IDX(2'd3)) u_sm3 (
      .clk             (clk),
      .rst             (rst),
      .instr           (imem_rd_c[3]),
      .gpio_seen       (gpio_seen_c),
      .in_bus          (gm_in_bus[3]),
      .irq_flags       (irq_flags),
      .irq_prev_r      (irq_prev_r),
      .irq_next_r      (irq_next_r),
      .clkdiv_we       (clkdiv_we[3]),
      .clkdiv_wdata    (reg_wdata),
      .execctrl_we     (execctrl_we[3]),
      .execctrl_wdata  (reg_wdata),
      .shiftctrl_we    (shiftctrl_we[3]),
      .shiftctrl_wdata (reg_wdata),
      .pinctrl_we      (pinctrl_we[3]),
      .pinctrl_wdata   (reg_wdata),
      .sm_en           (ctrl_r[3]),
      .sm_restart      (sm_restart[3]),
      .clkdiv_restart  (clkdiv_restart[3]),
      .force_we        (force_we[3]),
      .force_instr     (reg_wdata[15:0]),
      .gpio_out_we     (sm_out_we[3]),
      .gpio_out_pindir (sm_out_pindir[3]),
      .gpio_out_base   (sm_out_base[3]),
      .gpio_out_count  (sm_out_count[3]),
      .gpio_out_data   (sm_out_data[3]),
      .gpio_set_we     (sm_set_we[3]),
      .gpio_set_pindir (sm_set_pindir[3]),
      .gpio_set_base   (sm_set_base[3]),
      .gpio_set_num    (sm_set_num[3]),
      .gpio_set_data   (sm_set_data[3]),
      .gpio_ss_we      (sm_ss_we[3]),
      .gpio_ss_pindir  (sm_ss_pindir[3]),
      .gpio_ss_base    (sm_ss_base[3]),
      .gpio_ss_num     (sm_ss_num[3]),
      .gpio_ss_data    (sm_ss_data[3]),
      .out_sticky      (sm_out_sticky[3]),
      .irq_set_req     (sm_irq_set[3]),
      .irq_clr_req     (sm_irq_clr[3]),
      .irq_flag_idx    (sm_irq_idx[3]),
      .irq_idx_mode    (sm_irq_mode[3]),
      .sys_tx_wr       (sys_tx_wr[3]),
      .sys_tx_wdata    (reg_wdata),
      .sys_rx_rd       (sys_rx_rd[3]),
      .sys_rx_rdata    (sm_sys_rx_rdata[3]),
      .sys_aux_wr      (sys_aux_wr[3]),
      .sys_aux_addr    (aux_idx_c),
      .sys_aux_wdata   (reg_wdata),
      .sys_aux_rd      (sys_aux_rd[3]),
      .sys_aux_rdata   (sm_sys_aux_rdata[3]),
      .fdbg_clr        (fdbg_clr[3]),
      .fdbg_tx_stall   (sm_fdbg_tx_stall[3]),
      .fdbg_rx_stall   (sm_fdbg_rx_stall[3]),
      .fdbg_tx_over    (sm_fdbg_tx_over[3]),
      .fdbg_rx_under   (sm_fdbg_rx_under[3]),
      .pc              (sm_pc[3]),
      .tx_level        (sm_tx_level[3]),
      .rx_level        (sm_rx_level[3]),
      .exec_stalled    (sm_exec_stalled[3]),
      .tx_full         (sm_tx_full[3]),
      .tx_empty        (sm_tx_empty[3]),
      .rx_full         (sm_rx_full[3]),
      .rx_empty        (sm_rx_empty[3]),
      .clkdiv_q        (sm_clkdiv_q[3]),
      .execctrl_q      (sm_execctrl_q[3]),
      .shiftctrl_q     (sm_shiftctrl_q[3]),
      .pinctrl_q       (sm_pinctrl_q[3]),
      .cfg_in_base     (sm_in_base[3]),
      .cfg_in_count    (sm_in_count[3]),
      .cfg_jmp_pin     (sm_jmp_pin[3]),
      .dbg_force_tick  (sm_dbg_force[3])
  );

  // -----------------------------------------------------------------------
  // u_irq (C6): flag register with IdxMode routing (SPEC-3.8-4..7) and
  // the bus/import writers (CC-37/CC-39).
  // -----------------------------------------------------------------------
  pio_irq_flags u_irq (
      .clk          (clk),
      .rst          (rst),
      .sm_flag_idx  (sm_irq_idx),
      .sm_idx_mode  (sm_irq_mode),
      .sm_irq_set   (sm_irq_set),
      .sm_irq_clr   (sm_irq_clr),
      .irq_w1c      (irq_w1c_c),
      .irq_force    (irq_force_c),
      .nb_set       (nb_set),
      .nb_clr       (nb_clr),
      .flags        (irq_flags),
      .irq_prev_o   (irq_prev_o),
      .irq_next_o   (irq_next_o),
      .prev_exp_set (prev_exp_set),
      .prev_exp_clr (prev_exp_clr),
      .next_exp_set (next_exp_set),
      .next_exp_clr (next_exp_clr)
  );

  // -----------------------------------------------------------------------
  // u_gpio (C7): input sync/rotation + output priority resolution. The
  // per-SM window config comes back out of the SMs (u_regs owns the
  // registers); dbg_sticky_* and jmp_pin stay dangling (C7 header).
  // -----------------------------------------------------------------------
  logic [31:0] dbg_padout_c, dbg_padoe_c;

  pio_gpio_mux u_gpio (
      .clk            (clk),
      .rst            (rst),
      .gpio_in        (gpio_in),
      .sync_bypass    (isb_r),           // SPEC-7-7 RW storage
      .in_base        (sm_in_base),      // SPEC-10-3
      .in_count       (sm_in_count),
      .jmp_pin_idx    (sm_jmp_pin),
      .out_we         (sm_out_we),
      .out_pindir     (sm_out_pindir),
      .out_base       (sm_out_base),
      .out_count      (sm_out_count),
      .out_data       (sm_out_data),
      .set_we         (sm_set_we),
      .set_pindir     (sm_set_pindir),
      .set_base       (sm_set_base),
      .set_num        (sm_set_num),
      .set_data       (sm_set_data),
      .ss_we          (sm_ss_we),
      .ss_pindir      (sm_ss_pindir),
      .ss_base        (sm_ss_base),
      .ss_num         (sm_ss_num),
      .ss_data        (sm_ss_data),
      .sticky_en      (sm_out_sticky),
      .gpio_out       (gpio_out),
      .gpio_oe        (gpio_oe),
      .dbg_padout     (dbg_padout_c),    // SPEC-7-8 readback
      .dbg_padoe      (dbg_padoe_c),
      .in_bus         (gm_in_bus),
      .jmp_pin        (),
      .gpio_seen      (gpio_seen_c),
      .dbg_sticky_mask (),
      .dbg_sticky_lvl  (),
      .dbg_sticky_dir  (),
      .dbg_sticky_isdir()
  );

  // -----------------------------------------------------------------------
  // Status compositions (SPEC-7-29 layouts; sdk regs/pio.h nibbles).
  // -----------------------------------------------------------------------
  logic [31:0] fstat_c, fdebug_c, flevel_c;

  always_comb begin
    fstat_c  = 32'd0;
    fdebug_c = 32'd0;
    flevel_c = 32'd0;
    for (int i = 0; i < 4; i++) begin
      fstat_c[24+i]  = sm_tx_empty[i];    // TXEMPTY 27:24
      fstat_c[16+i]  = sm_tx_full[i];     // TXFULL  19:16
      fstat_c[8+i]   = sm_rx_empty[i];    // RXEMPTY 11:8
      fstat_c[0+i]   = sm_rx_full[i];     // RXFULL  3:0
      fdebug_c[24+i] = sm_fdbg_tx_stall[i];  // TXSTALL 27:24 (SPEC-6-7)
      fdebug_c[16+i] = sm_fdbg_tx_over[i];   // TXOVER  19:16
      fdebug_c[8+i]  = sm_fdbg_rx_under[i];  // RXUNDER 11:8
      fdebug_c[0+i]  = sm_fdbg_rx_stall[i];  // RXSTALL 3:0
      flevel_c[8*i   +: 4]   = sm_tx_level[i];  // TXi at 8i (SPEC-7-29)
      flevel_c[8*i+4 +: 4]   = sm_rx_level[i];  // RXi at 8i+4
    end
  end

  // INTR composition (SPEC-7-12): SM flags 15:8, TXNFULL 7:4,
  // RXNEMPTY 3:0.
  always_comb begin
    intr = 16'd0;
    intr[15:8] = irq_flags;
    for (int i = 0; i < 4; i++) begin
      intr[4+i] = !sm_tx_full[i];
      intr[0+i] = !sm_rx_empty[i];
    end
  end

  // EXECCTRL readback with the RO EXEC_STALLED bit-31 overlay
  // (SPEC-7-15) — the stored bit 31 is not readable.
  logic [3:0][31:0] sm_execctrl_rb_c;
  always_comb begin
    for (int i = 0; i < 4; i++) begin
      sm_execctrl_rb_c[i] = (sm_execctrl_q[i] & 32'h7fff_ffff)
                            | (sm_exec_stalled[i] ? 32'h8000_0000 : 32'd0);
    end
  end

  // -----------------------------------------------------------------------
  // Read mux (combinational; valid in the read-strobe cycle — DESIGN.md
  // §Interface decisions #3). WO locations and undecoded addresses
  // read 0.
  // -----------------------------------------------------------------------
  always_comb begin
    reg_rdata = 32'd0;
    if (widx_c == 7'd0) begin
      reg_rdata = {28'd0, ctrl_r};                 // SPEC-7-2 (SC bits 0)
    end else if (widx_c == 7'd1) begin
      reg_rdata = fstat_c;                         // SPEC-7-29
    end else if (widx_c == 7'd2) begin
      reg_rdata = fdebug_c;
    end else if (widx_c == 7'd3) begin
      reg_rdata = flevel_c;
    end else if ((widx_c >= 7'd8) && (widx_c <= 7'd11)) begin
      reg_rdata = sm_sys_rx_rdata[2'(widx_c - 7'd8)];  // RXF RO (SPEC-7-28)
    end else if (widx_c == 7'd12) begin
      reg_rdata = {24'd0, irq_flags};              // SPEC-7-6
    end else if (widx_c == 7'd14) begin
      reg_rdata = isb_r;                           // SPEC-7-7
    end else if (widx_c == 7'd15) begin
      reg_rdata = dbg_padout_c;                    // SPEC-7-8
    end else if (widx_c == 7'd16) begin
      reg_rdata = dbg_padoe_c;
    end else if (widx_c == 7'd17) begin
      reg_rdata = 32'h1020_0404;                   // SPEC-7-9
    end else if (sm_hit_c) begin
      // SMx window: 0 CLKDIV .. 5 PINCTRL (SPEC-7-14..26).
      if (sm_reg_c == 3'd0)      reg_rdata = sm_clkdiv_q[sm_sel_c];
      else if (sm_reg_c == 3'd1) reg_rdata = sm_execctrl_rb_c[sm_sel_c]; // +bit31
      else if (sm_reg_c == 3'd2) reg_rdata = sm_shiftctrl_q[sm_sel_c];
      else if (sm_reg_c == 3'd3) reg_rdata = {27'd0, sm_pc[sm_sel_c]};      // SPEC-7-22
      else if (sm_reg_c == 3'd4) reg_rdata = {16'd0, imem_rd_c[sm_sel_c]};  // SPEC-7-24
      else if (sm_reg_c == 3'd5) reg_rdata = sm_pinctrl_q[sm_sel_c];
    end else if (aux_hit_c) begin
      reg_rdata = sm_sys_aux_rdata[aux_sel_c];     // SPEC-7-13
    end
    // Else: TXF/IRQ_FORCE/INSTR_MEM write-only, GPIOBASE / NEXTPREV /
    // IRQ0-1 INT* undecoded — read 0.
  end

  // Verification readbacks (header).
  assign dbg_sm_en  = ctrl_r;
  assign dbg_sm_pc  = sm_pc;
  assign dbg_force  = sm_dbg_force;

  assign dbg_sm0_tx_level = sm_tx_level[0];  // FLEVEL nibbles (SPEC-6-6)
  assign dbg_sm0_rx_level = sm_rx_level[0];
  assign dbg_sm0_tx_full  = sm_tx_full[0];   // FSTAT bit (SPEC-7-29)

endmodule

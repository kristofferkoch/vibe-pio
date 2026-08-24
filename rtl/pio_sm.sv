// pio_sm — one state machine, assembled (KANBAN C9): config bank +
// divider (C5, u_regs), decode (C4, u_decoder), the tick-rate exec core
// (C8, u_exec), shifters (C2, u_shift) and FIFOs (C3, u_fifo), wired per
// the DESIGN.md pio_sm diagram. One PIO block instantiates four of these
// as u_sm0..u_sm3 (no generate loop — DESIGN.md conventions).
//
// The module is wiring plus two decode details:
//   * FIFO mode (SPEC-6-2/6-3): FJOIN_RX_PUT / FJOIN_RX_GET override the
//     FJOIN_TX / FJOIN_RX joins ("setting either clears FJOIN_TX and
//     FJOIN_RX", SPEC-6-3), producing the C3 encoding
//     txrx | tx | rx | txput | txget | putget.
//   * The tick strobe fed to the shifter and FIFO datapaths is
//     `sm_tick || force_tick`: per CC-1 an SM's state advances on sm_tick
//     *or* the force-tick of CC-35, so a forced PULL/OUT/PUSH/IN moves
//     the datapath in its force clk (u_regs already CC-36-defers a
//     colliding sm_tick). u_exec qualifies every op port by the
//     completing tick, so multi-clk forced stalls never double-shift.
//
// Config arrives exclusively through the register write ports
// (SPEC-7-25: fields visible to consumers the cycle after the write
// retires); SM_RESTART reaches u_exec directly and clears exactly the
// SPEC-7-3 subset (not OSR/X/Y/PC — the SDK relocates the PC with a
// forced JMP via SMx_INSTR, SPEC-7-3 sdk N2). CLKDIV_RESTART goes to
// u_regs (CC-27). `gpio_seen` is the whole synchroniser bus (CC-23):
// WAIT GPIO/JMPPIN and JMP PIN index it by EXECCTRL.JMP_PIN inside
// u_exec, superseding DESIGN's single-bit jmp_pin port. IRQ requests
// leave with their raw IdxMode (SPEC-3.8-4..7) — C6 routes by SM
// position; the flag readback must be the registered flags (CC-37).
//
// dbg_* are verification readbacks for the C9 formal harness and TB
// (yosys cannot probe instance internals from a wrapper); pio_block
// leaves them dangling.

module pio_sm #(
    parameter [1:0] SM_IDX = 2'd0    // SM position in the block (SPEC-3.8-6 REL)
) (
    input  logic        clk,
    input  logic        rst,

    // Instruction source: imem word at pc, combinational (CC-33 —
    // pio_block drives rd_addr = pc into pio_instr_mem).
    input  logic [15:0] instr,

    // GPIO input path (C7): muxed synchroniser outputs (CC-23/CC-24)
    // and this SM's rotated+masked input bus (SPEC-10-3).
    input  logic [31:0] gpio_seen,
    input  logic [31:0] in_bus,

    // IRQ flag readbacks (C6 flags; pio_top relay registers, CC-38).
    input  logic [7:0]  irq_flags,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,

    // Per-SM register-bus decode (pio_block forwards SMx_* writes as
    // one-clk strobes; SPEC-7-14..26 layouts).
    input  logic        clkdiv_we,
    input  logic [31:0] clkdiv_wdata,
    input  logic        execctrl_we,
    input  logic [31:0] execctrl_wdata,
    input  logic        shiftctrl_we,
    input  logic [31:0] shiftctrl_wdata,
    input  logic        pinctrl_we,
    input  logic [31:0] pinctrl_wdata,

    // CTRL decode (SPEC-7-2): enable level + one-clk pulses.
    input  logic        sm_en,           // SM_ENABLE
    input  logic        sm_restart,      // SM_RESTART (SPEC-7-3)
    input  logic        clkdiv_restart,  // CLKDIV_RESTART (CC-27)

    // SMx_INSTR write (SPEC-7-23, CC-35).
    input  logic        force_we,
    input  logic [15:0] force_instr,

    // Pin-write bundles to the GPIO mux (C7 resolves priority CC-6/7).
    // Bundles asserted only on the executing tick (CC-5/CC-8).
    output logic        gpio_out_we,     // OUT/MOV PINS|PINDIRS
    output logic        gpio_out_pindir,
    output logic [4:0]  gpio_out_base,
    output logic [5:0]  gpio_out_count,  // 0 = 32 pins (SPEC-7-26)
    output logic [31:0] gpio_out_data,
    output logic        gpio_set_we,     // SET PINS|PINDIRS
    output logic        gpio_set_pindir,
    output logic [4:0]  gpio_set_base,
    output logic [2:0]  gpio_set_num,    // 0 = no write (SPEC-7-26)
    output logic [4:0]  gpio_set_data,
    output logic        gpio_ss_we,      // side-set, first tick only (CC-5)
    output logic        gpio_ss_pindir,
    output logic [4:0]  gpio_ss_base,
    output logic [2:0]  gpio_ss_num,
    output logic [4:0]  gpio_ss_data,
    output logic        out_sticky,      // EXECCTRL.OUT_STICKY to C7 (SPEC-7-18)

    // IRQ requests to the flag register (C6; IdxMode routed there).
    output logic        irq_set_req,     // SPEC-3.8-1/2
    output logic        irq_clr_req,
    output logic [2:0]  irq_flag_idx,
    output logic [1:0]  irq_idx_mode,

    // FIFO system side (clk-rate block bus; CC-29/CC-30 boundaries).
    input  logic        sys_tx_wr,       // SPEC-6-5
    input  logic [31:0] sys_tx_wdata,
    input  logic        sys_rx_rd,
    output logic [31:0] sys_rx_rdata,
    input  logic        sys_aux_wr,      // RXFx_PUTGET (SPEC-7-13)
    input  logic [1:0]  sys_aux_addr,
    input  logic [31:0] sys_aux_wdata,
    input  logic        sys_aux_rd,
    output logic [31:0] sys_aux_rdata,
    input  logic [3:0]  fdbg_clr,        // FDEBUG W1C (SPEC-6-7)
    output logic        fdbg_tx_stall,
    output logic        fdbg_rx_stall,
    output logic        fdbg_tx_over,
    output logic        fdbg_rx_under,

    // Block readbacks.
    output logic [4:0]  pc,              // SMx_ADDR (SPEC-7-22)
    output logic [3:0]  tx_level,        // FLEVEL TX nibble (SPEC-6-6)
    output logic [3:0]  rx_level,        // FLEVEL RX nibble
    output logic        exec_stalled,    // SPEC-7-15
    // FSTAT status bits (SPEC-7-29) — re-exported from u_fifo so the
    // block read mux needs no level/depth model of its own.
    output logic        tx_full,         // FSTAT.TXFULL bit
    output logic        tx_empty,        // FSTAT.TXEMPTY bit
    output logic        rx_full,         // FSTAT.RXFULL bit
    output logic        rx_empty,        // FSTAT.RXEMPTY bit
    // Raw config readbacks (SMx_CLKDIV/EXECCTRL/SHIFTCTRL/PINCTRL are RW,
    // SPEC-7-14..26) — re-exported from u_regs.
    output logic [31:0] clkdiv_q,
    output logic [31:0] execctrl_q,
    output logic [31:0] shiftctrl_q,
    output logic [31:0] pinctrl_q,
    // GPIO-mux window config this SM owns (C7 consumer): IN_BASE/
    // IN_COUNT come from PINCTRL/SHIFTCTRL, JMP_PIN from EXECCTRL.
    output logic [4:0]  cfg_in_base,     // SPEC-10-3 rotate base
    output logic [4:0]  cfg_in_count,    // SPEC-7-21 IN_COUNT, 0 = 32
    output logic [4:0]  cfg_jmp_pin,     // SPEC-7-16 JMP_PIN index

    // Verification readbacks (formal + TB; pio_block leaves dangling).
    output logic        dbg_sm_tick,
    output logic        dbg_force_tick,
    output logic [3:0]  dbg_state,       // u_exec onehot FSM
    output logic        dbg_exec,        // an instruction executes this clk
    output logic        dbg_complete,    // …and completes (effects land)
    output logic        dbg_is_in,       // executing word's class strobes
    output logic        dbg_is_out,
    output logic        dbg_is_push,
    output logic        dbg_out_en,      // shifter op strobes
    output logic        dbg_tx_pop,      // FIFO SM-side op strobes
    output logic        dbg_rx_push,
    output logic [31:0] dbg_rx_push_data,
    output logic [31:0] dbg_autopush_data, // post-shift ISR (CC-9)
    output logic        dbg_osr_wr_en,
    output logic [31:0] dbg_osr_wr_data,
    output logic [31:0] dbg_tx_head_data,
    output logic        dbg_autopull_ge_thr,
    output logic [31:0] dbg_osr,
    output logic [31:0] dbg_isr,
    output logic [5:0]  dbg_osr_cnt,
    output logic [5:0]  dbg_isr_cnt,
    output logic        dbg_tx_empty,
    output logic [2:0]  dbg_fifo_mode,
    output logic        dbg_fjoin_tx,    // raw SHIFTCTRL bits (SPEC-7-21)
    output logic        dbg_fjoin_rx,
    output logic        dbg_fjoin_rx_put,
    output logic        dbg_fjoin_rx_get
);

  // -----------------------------------------------------------------------
  // u_regs (C5): config banks + divider. Dangling outputs (clkdiv readback
  // fields, divider state, unimplemented EXECCTRL bits) are C5-internal.
  // -----------------------------------------------------------------------
  logic        sm_tick;
  logic        force_tick;
  logic        side_en, side_pindir, out_sticky_cfg, inline_out_en;
  logic [4:0]  jmp_pin_cfg, out_en_sel, wrap_top, wrap_bottom, status_n;
  logic [1:0]  status_sel;
  logic        fjoin_rx, fjoin_tx, fjoin_rx_put, fjoin_rx_get;
  logic [4:0]  pull_thresh, push_thresh, in_base, sideset_base, set_base,
               out_base;
  logic        out_shift_left, in_shift_left, autopull, autopush;
  logic [2:0]  sideset_count, set_count;
  logic [5:0]  out_count_cfg;
  logic [4:0]  in_mask_count;

  pio_sm_regs u_regs (
      .clk             (clk),
      .rst             (rst),
      .clkdiv_we       (clkdiv_we),
      .clkdiv_wdata    (clkdiv_wdata),
      .execctrl_we     (execctrl_we),
      .execctrl_wdata  (execctrl_wdata),
      .shiftctrl_we    (shiftctrl_we),
      .shiftctrl_wdata (shiftctrl_wdata),
      .pinctrl_we      (pinctrl_we),
      .pinctrl_wdata   (pinctrl_wdata),
      .sm_en           (sm_en),
      .clkdiv_restart  (clkdiv_restart),
      .force_tick      (force_tick),
      .sm_tick         (sm_tick),          // CC-26/CC-36-shaped
      // Dangling: tick_pending, sm_tick_period, dbg_phase/count/stretch,
      // clkdiv_int/frac, out_en_sel, inline_out_en (IDEAS.md),
      // in_base, in_mask_count.
      .side_en         (side_en),
      .side_pindir     (side_pindir),
      .jmp_pin         (jmp_pin_cfg),
      .out_en_sel      (out_en_sel),
      .inline_out_en   (inline_out_en),
      .out_sticky      (out_sticky_cfg),
      .wrap_top        (wrap_top),
      .wrap_bottom     (wrap_bottom),
      .status_sel      (status_sel),
      .status_n        (status_n),
      .fjoin_rx        (fjoin_rx),
      .fjoin_tx        (fjoin_tx),
      .pull_thresh     (pull_thresh),
      .push_thresh     (push_thresh),
      .out_shift_left  (out_shift_left),
      .in_shift_left   (in_shift_left),
      .autopull        (autopull),
      .autopush        (autopush),
      .fjoin_rx_put    (fjoin_rx_put),
      .fjoin_rx_get    (fjoin_rx_get),
      .in_mask_count   (in_mask_count),
      .sideset_count   (sideset_count),
      .set_count       (set_count),
      .out_count       (out_count_cfg),
      .in_base         (in_base),
      .sideset_base    (sideset_base),
      .set_base        (set_base),
      .out_base        (out_base),
      .clkdiv_q        (clkdiv_q),
      .execctrl_q      (execctrl_q),
      .shiftctrl_q     (shiftctrl_q),
      .pinctrl_q       (pinctrl_q)
  );

  // -----------------------------------------------------------------------
  // FIFO mode decode (SPEC-6-2/6-3): aux bits clear the joins
  // encode-side, so they take priority; joins are otherwise exclusive.
  // -----------------------------------------------------------------------
  localparam logic [2:0] FM_TXRX   = 3'd0;
  localparam logic [2:0] FM_TX     = 3'd1;   // SPEC-6-2
  localparam logic [2:0] FM_RX     = 3'd2;   // SPEC-6-2
  localparam logic [2:0] FM_TXPUT  = 3'd3;   // SPEC-6-3
  localparam logic [2:0] FM_TXGET  = 3'd4;
  localparam logic [2:0] FM_PUTGET = 3'd5;

  logic [2:0] fifo_mode;
  always_comb begin
    if (fjoin_rx_put)      fifo_mode = fjoin_rx_get ? FM_PUTGET : FM_TXPUT;
    else if (fjoin_rx_get) fifo_mode = FM_TXGET;               // SPEC-6-3
    else if (fjoin_tx)     fifo_mode = FM_TX;                  // SPEC-6-2
    else if (fjoin_rx)     fifo_mode = FM_RX;
    else                   fifo_mode = FM_TXRX;
  end

  // -----------------------------------------------------------------------
  // Tick strobe to the datapaths (CC-1, CC-35): sm_tick OR force-tick —
  // forced instructions move shifters/FIFOs in their force clk.
  // -----------------------------------------------------------------------
  logic tick_any;
  assign tick_any = sm_tick || force_tick;

  // -----------------------------------------------------------------------
  // u_decoder (C4): pure decode of u_exec's selected word.
  // -----------------------------------------------------------------------
  logic [15:0] instr_cur;
  logic [4:0]  dec_delay;
  logic        dec_ss_valid;
  logic [4:0]  dec_ss_val;
  logic [2:0]  dec_ss_bits;
  logic        dec_is_jmp, dec_is_wait, dec_is_in, dec_is_out, dec_is_push;
  logic        dec_is_pull, dec_is_put, dec_is_get, dec_is_mov, dec_is_irq;
  logic        dec_is_set, dec_illegal;
  logic [2:0]  dec_jmp_cond;
  logic [4:0]  dec_jmp_addr;
  logic        dec_wait_pol;
  logic [1:0]  dec_wait_src;
  logic [4:0]  dec_wait_index;
  logic [2:0]  dec_in_src;
  logic [5:0]  dec_in_count;
  logic [2:0]  dec_out_dst;
  logic [5:0]  dec_out_count;
  logic        dec_push_iff, dec_push_blk, dec_pull_ife, dec_pull_blk;
  logic        dec_aux_idxi;
  logic [1:0]  dec_aux_index;
  logic [2:0]  dec_mov_dst, dec_mov_src;
  logic [1:0]  dec_mov_op;
  logic        dec_irq_clr, dec_irq_wait;
  logic [1:0]  dec_irq_idxmode;
  logic [2:0]  dec_irq_index;
  logic [2:0]  dec_set_dst;
  logic [4:0]  dec_set_data;

  pio_sm_decoder u_decoder (
      .instr         (instr_cur),
      .side_en       (side_en),
      .sideset_count (sideset_count),
      .delay         (dec_delay),
      .ss_valid      (dec_ss_valid),
      .ss_val        (dec_ss_val),
      .ss_bits       (dec_ss_bits),
      .is_jmp        (dec_is_jmp),
      .is_wait       (dec_is_wait),
      .is_in         (dec_is_in),
      .is_out        (dec_is_out),
      .is_push       (dec_is_push),
      .is_pull       (dec_is_pull),
      .is_put        (dec_is_put),
      .is_get        (dec_is_get),
      .is_mov        (dec_is_mov),
      .is_irq        (dec_is_irq),
      .is_set        (dec_is_set),
      .illegal       (dec_illegal),
      .jmp_cond      (dec_jmp_cond),
      .jmp_addr      (dec_jmp_addr),
      .wait_pol      (dec_wait_pol),
      .wait_src      (dec_wait_src),
      .wait_index    (dec_wait_index),
      .in_src        (dec_in_src),
      .in_count      (dec_in_count),
      .out_dst       (dec_out_dst),
      .out_count     (dec_out_count),
      .push_iff      (dec_push_iff),
      .push_blk      (dec_push_blk),
      .pull_ife      (dec_pull_ife),
      .pull_blk      (dec_pull_blk),
      .aux_idxi      (dec_aux_idxi),
      .aux_index     (dec_aux_index),
      .mov_dst       (dec_mov_dst),
      .mov_src       (dec_mov_src),
      .mov_op        (dec_mov_op),
      .irq_clr       (dec_irq_clr),
      .irq_wait      (dec_irq_wait),
      .irq_idxmode   (dec_irq_idxmode),
      .irq_index     (dec_irq_index),
      .set_dst       (dec_set_dst),
      .set_data      (dec_set_data)
  );

  // -----------------------------------------------------------------------
  // u_shift (C2): OSR/ISR + counters + autop decisions (CC-4 start-of-tick
  // sampling; CC-9 post-shift autopush value).
  // -----------------------------------------------------------------------
  logic        out_en, osr_wr_en, in_en, in_src_isr, isr_wr_en;
  logic [31:0] osr_wr_data, in_data, isr_wr_data;
  logic [5:0]  osr_wr_cnt, isr_wr_cnt;
  logic [31:0] osr, isr, out_data, autopush_data;
  logic [5:0]  osr_cnt, isr_cnt;
  logic        autopull_ge_thr, autopull_post_thr, autopush_req;

  pio_sm_shift u_shift (
      .clk              (clk),
      .rst              (rst),
      .sm_tick          (tick_any),         // CC-1/CC-35: sm_tick OR force-tick
      .in_shift_left    (in_shift_left),   // SPEC-5-2 from SHIFTCTRL
      .out_shift_left   (out_shift_left),
      .autopull_en      (autopull),
      .autopush_en      (autopush),
      .pull_thresh      (pull_thresh),
      .push_thresh      (push_thresh),
      .out_count        (dec_out_count),
      .in_count         (dec_in_count),
      .out_en           (out_en),
      .osr_wr_en        (osr_wr_en),
      .osr_wr_data      (osr_wr_data),
      .osr_wr_cnt       (osr_wr_cnt),
      .in_en            (in_en),
      .in_data          (in_data),
      .in_src_isr       (in_src_isr),
      .isr_wr_en        (isr_wr_en),
      .isr_wr_data      (isr_wr_data),
      .isr_wr_cnt       (isr_wr_cnt),
      .osr              (osr),
      .isr              (isr),
      .osr_cnt          (osr_cnt),
      .isr_cnt          (isr_cnt),
      .out_data         (out_data),
      .autopull_ge_thr  (autopull_ge_thr),
      .autopull_post_thr(autopull_post_thr),
      .autopush_req     (autopush_req),
      .autopush_data    (autopush_data)
  );

  // -----------------------------------------------------------------------
  // u_fifo (C3): queues/join/aux storage + FDEBUG stickiness (CC-29/CC-30
  // system-side boundaries; CC-21 aux single-tick).
  // -----------------------------------------------------------------------
  logic        rx_push, tx_pop, aux_put, aux_get;
  logic [31:0] rx_push_data, aux_put_data, tx_head_data, aux_get_data;
  logic [1:0]  aux_put_idx, aux_get_idx;
  logic        tx_stall_req, rx_stall_req;
  // rx_full/rx_empty/tx_full/tx_empty are the FSTAT readback ports
  // (SPEC-7-29), driven by u_fifo below.

  pio_sm_fifo u_fifo (
      .clk           (clk),
      .rst           (rst),
      .fifo_mode     (fifo_mode),
      .sm_tick       (tick_any),           // CC-1/CC-35: sm_tick OR force-tick
      .rx_push       (rx_push),
      .rx_push_data  (rx_push_data),
      .tx_pop        (tx_pop),
      .tx_head_data  (tx_head_data),
      .aux_put       (aux_put),
      .aux_put_idx   (aux_put_idx),
      .aux_put_data  (aux_put_data),
      .aux_get       (aux_get),
      .aux_get_idx   (aux_get_idx),
      .aux_get_data  (aux_get_data),
      .rx_level      (rx_level),
      .tx_level      (tx_level),
      .rx_full       (rx_full),
      .rx_empty      (rx_empty),
      .tx_full       (tx_full),
      .tx_empty      (tx_empty),
      .tx_stall_req  (tx_stall_req),
      .rx_stall_req  (rx_stall_req),
      .fdbg_tx_stall (fdbg_tx_stall),
      .fdbg_rx_stall (fdbg_rx_stall),
      .fdbg_tx_over  (fdbg_tx_over),
      .fdbg_rx_under (fdbg_rx_under),
      .fdbg_clr      (fdbg_clr),
      .sys_tx_wr     (sys_tx_wr),
      .sys_tx_wdata  (sys_tx_wdata),
      .sys_rx_rd     (sys_rx_rd),
      .sys_rx_rdata  (sys_rx_rdata),
      .sys_aux_wr    (sys_aux_wr),
      .sys_aux_addr  (sys_aux_addr),
      .sys_aux_wdata (sys_aux_wdata),
      .sys_aux_rd    (sys_aux_rd),
      .sys_aux_rdata (sys_aux_rdata)
  );

  // -----------------------------------------------------------------------
  // u_exec (C8): tick-rate control core. instr_cur feeds u_decoder above;
  // gpio bundles and IRQ requests go straight to the block boundary.
  // -----------------------------------------------------------------------
  pio_sm_exec u_exec (
      .clk             (clk),
      .rst             (rst),
      .sm_tick         (sm_tick),
      .sm_restart      (sm_restart),       // SPEC-7-3 subset clear
      .force_tick      (force_tick),
      .instr_mem       (instr),
      .instr_cur       (instr_cur),
      .force_we        (force_we),
      .force_instr     (force_instr),
      .pc              (pc),
      .exec_stalled    (exec_stalled),
      .delay           (dec_delay),
      .ss_valid        (dec_ss_valid),
      .ss_val          (dec_ss_val),
      .ss_bits         (dec_ss_bits),
      .is_jmp          (dec_is_jmp),
      .is_wait         (dec_is_wait),
      .is_in           (dec_is_in),
      .is_out          (dec_is_out),
      .is_push         (dec_is_push),
      .is_pull         (dec_is_pull),
      .is_put          (dec_is_put),
      .is_get          (dec_is_get),
      .is_mov          (dec_is_mov),
      .is_irq          (dec_is_irq),
      .is_set          (dec_is_set),
      .illegal         (dec_illegal),
      .jmp_cond        (dec_jmp_cond),
      .jmp_addr        (dec_jmp_addr),
      .wait_pol        (dec_wait_pol),
      .wait_src        (dec_wait_src),
      .wait_index      (dec_wait_index),
      .in_src          (dec_in_src),
      .out_dst         (dec_out_dst),
      .out_count       (dec_out_count),
      .push_iff        (dec_push_iff),
      .push_blk        (dec_push_blk),
      .pull_ife        (dec_pull_ife),
      .pull_blk        (dec_pull_blk),
      .aux_idxi        (dec_aux_idxi),
      .aux_index       (dec_aux_index),
      .mov_dst         (dec_mov_dst),
      .mov_src         (dec_mov_src),
      .mov_op          (dec_mov_op),
      .irq_clr         (dec_irq_clr),
      .irq_wait        (dec_irq_wait),
      .irq_idxmode     (dec_irq_idxmode),
      .irq_index       (dec_irq_index),
      .set_dst         (dec_set_dst),
      .set_data        (dec_set_data),
      .sm_id           (SM_IDX),
      .cfg_wrap_top    (wrap_top),
      .cfg_wrap_bottom (wrap_bottom),
      .cfg_jmp_pin     (jmp_pin_cfg),
      .cfg_status_sel  (status_sel),
      .cfg_status_n    (status_n),
      .cfg_autopull    (autopull),
      .cfg_autopush    (autopush),
      .cfg_pull_thresh (pull_thresh),
      .cfg_push_thresh (push_thresh),
      .cfg_side_pindir (side_pindir),
      .cfg_sideset_base(sideset_base),
      .cfg_out_base    (out_base),
      .cfg_out_count   (out_count_cfg),
      .cfg_set_base    (set_base),
      .cfg_set_count   (set_count),
      .out_en          (out_en),
      .osr_wr_en       (osr_wr_en),
      .osr_wr_data     (osr_wr_data),
      .osr_wr_cnt      (osr_wr_cnt),
      .in_en           (in_en),
      .in_data         (in_data),
      .in_src_isr      (in_src_isr),
      .isr_wr_en       (isr_wr_en),
      .isr_wr_data     (isr_wr_data),
      .isr_wr_cnt      (isr_wr_cnt),
      .osr             (osr),
      .isr             (isr),
      .osr_cnt         (osr_cnt),
      .isr_cnt         (isr_cnt),
      .out_data        (out_data),
      .autopull_ge_thr (autopull_ge_thr),
      .autopull_post_thr(autopull_post_thr),
      .autopush_req    (autopush_req),
      .autopush_data   (autopush_data),
      .fifo_mode       (fifo_mode),
      .rx_push         (rx_push),
      .rx_push_data    (rx_push_data),
      .tx_pop          (tx_pop),
      .aux_put         (aux_put),
      .aux_put_idx     (aux_put_idx),
      .aux_put_data    (aux_put_data),
      .aux_get         (aux_get),
      .aux_get_idx     (aux_get_idx),
      .tx_stall_req    (tx_stall_req),
      .rx_stall_req    (rx_stall_req),
      .tx_head_data    (tx_head_data),
      .rx_level        (rx_level),
      .tx_level        (tx_level),
      .rx_full         (rx_full),
      .rx_empty        (rx_empty),
      .tx_full         (tx_full),
      .tx_empty        (tx_empty),
      .aux_get_data    (aux_get_data),
      .gpio_seen       (gpio_seen),
      .in_bus          (in_bus),
      .gpio_out_we     (gpio_out_we),
      .gpio_out_pindir (gpio_out_pindir),
      .gpio_out_base   (gpio_out_base),
      .gpio_out_count  (gpio_out_count),
      .gpio_out_data   (gpio_out_data),
      .gpio_set_we     (gpio_set_we),
      .gpio_set_pindir (gpio_set_pindir),
      .gpio_set_base   (gpio_set_base),
      .gpio_set_num    (gpio_set_num),
      .gpio_set_data   (gpio_set_data),
      .gpio_ss_we      (gpio_ss_we),
      .gpio_ss_pindir  (gpio_ss_pindir),
      .gpio_ss_base    (gpio_ss_base),
      .gpio_ss_num     (gpio_ss_num),
      .gpio_ss_data    (gpio_ss_data),
      .irq_flags       (irq_flags),
      .irq_prev        (irq_prev_r),
      .irq_next        (irq_next_r),
      .irq_set_req     (irq_set_req),
      .irq_clr_req     (irq_clr_req),
      .irq_flag_idx    (irq_flag_idx),
      .irq_idx_mode    (irq_idx_mode),
      // Dangling u_exec readbacks (dbg_delay, dbg_first, dbg_latch_* …)
      // stay inside; the integration-relevant subset is re-exported
      // below.
      .dbg_state       (dbg_state),
      .dbg_exec        (dbg_exec),
      .dbg_complete    (dbg_complete)
  );

  // -----------------------------------------------------------------------
  // Config pass-through and verification readbacks.
  // -----------------------------------------------------------------------
  assign out_sticky = out_sticky_cfg;   // C7 re-assert enable (SPEC-7-18)

  assign cfg_in_base  = in_base;        // C7 window config (SPEC-10-3)
  assign cfg_in_count = in_mask_count;  // SPEC-7-21 raw, 0 = 32
  assign cfg_jmp_pin  = jmp_pin_cfg;    // SPEC-7-16

  assign dbg_sm_tick        = sm_tick;
  assign dbg_force_tick     = force_tick;
  assign dbg_is_in          = dec_is_in;
  assign dbg_is_out         = dec_is_out;
  assign dbg_is_push        = dec_is_push;
  assign dbg_out_en         = out_en;
  assign dbg_tx_pop         = tx_pop;
  assign dbg_rx_push        = rx_push;
  assign dbg_rx_push_data   = rx_push_data;
  assign dbg_autopush_data  = autopush_data;
  assign dbg_osr_wr_en      = osr_wr_en;
  assign dbg_osr_wr_data    = osr_wr_data;
  assign dbg_tx_head_data   = tx_head_data;
  assign dbg_autopull_ge_thr= autopull_ge_thr;
  assign dbg_osr            = osr;
  assign dbg_isr            = isr;
  assign dbg_osr_cnt        = osr_cnt;
  assign dbg_isr_cnt        = isr_cnt;
  assign dbg_tx_empty       = tx_empty;
  assign dbg_fifo_mode      = fifo_mode;
  assign dbg_fjoin_tx       = fjoin_tx;
  assign dbg_fjoin_rx       = fjoin_rx;
  assign dbg_fjoin_rx_put   = fjoin_rx_put;
  assign dbg_fjoin_rx_get   = fjoin_rx_get;

endmodule

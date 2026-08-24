// pio_sm_exec — tick-rate control core of one state machine (KANBAN C8).
//
// Owns (DESIGN.md §pio_sm_exec):
//   - the onehot FSM ST_FETCH / ST_EXEC / ST_STALL / ST_DELAY deciding
//     what each sm_tick / force-tick does (CC-1, CC-2, CC-10, CC-14),
//   - PC update + wrap (SPEC-8-1..4), the delay counter (SPEC-4-3,
//     CC-10), X/Y scratch writes (SPEC-3.1-4/6, SPEC-3.4-3, SPEC-3.6-2/3,
//     SPEC-3.9-1),
//   - JMP condition evaluation (SPEC-3.1-2..11, SPEC-14.5-1),
//   - WAIT gpio/pin/jmppin/irq and IRQ-wait stall management incl. the
//     `irq wait` two-phase (SPEC-3.2-1..9, SPEC-3.8-1..3, CC-14..CC-16),
//   - OUT/IN/PUSH/PULL/MOV put+get/SET/IRQ dispatch to the shifter (C2)
//     and FIFO (C3) ports, applying the CC-11/CC-12/CC-13 autopull and
//     autopush handshakes and the CC-19/CC-20/CC-32 blocking rules,
//   - side-set application on the instruction's first executing tick
//     (SPEC-4-1..9, CC-5) and the OUT/SET/MOV pin-write bundles (CC-8),
//   - the shared EXEC / forced-instruction latch with the force-tick OR
//     and CC-36 deferral (SPEC-3.4-10, SPEC-11-1, SPEC-7-15/23/25,
//     CC-34..CC-36),
//   - SM_RESTART clearing exactly the SPEC-7-3 subset.
//
// Division of labour: the decoder (C4) is combinational and lives beside
// this module at pio_sm level, decoding `instr_cur` (the word this module
// selects between imem-at-pc and the latch); the shifter (C2) and FIFO
// (C3) are pure datapaths — this module samples their status outputs at
// start-of-tick (CC-4) and drives their operation ports. The divider is
// C5's: sm_tick arrives already deferred against force_tick (CC-36).
//
// Interpretation notes (choices on unpinned corners, kept local):
//   * Illegal/reserved encodings (SPEC-13-1) execute as pure no-ops:
//     no effects, no stall, normal PC advance + delay load.
//   * The background autopull refill (CC-12) fires on every executing
//     non-OUT tick — including stall re-executions of non-OUT
//     instructions — but never on delay ticks (CC-10: "no FIFO effects")
//     and never on ticks whose instruction itself loads the OSR (PULL,
//     MOV/GET-to-OSR — SPEC-3.6-13, and to avoid a double TX pop).
//   * SM_RESTART ([MODEL] timing): delay/forced/irq-wait clears land at
//     the restart clk edge; the ISR/counter clears ride the shifter
//     write ports, so they consume the *next* sm_tick (execution on that
//     tick is suppressed). SPEC-7-3 pins no cycle for any of this.
//   * With autopull on a dead (join-stolen) TX, or autopush on a
//     non-queue RX, the auto machinery is disabled (undefined configs,
//     SPEC-6-2/SPEC-3.7-6); a *blocking* PULL on a dead TX still stalls
//     forever (the literal CC-20 reading of FSTAT's both-full-and-empty).
//   * PULL with autopull enabled is a no-op while the OSR counter is
//     below PULL_THRESH ("no-op while the OSR is full", SPEC-3.5-13).
//   * STATUS_SEL=3 (reserved; the EXECCTRL reset value) reads all-zeros.
//   * EXECCTRL.OUT_EN_SEL/INLINE_OUT_EN (SPEC-7-17) have no pinned
//     microsemantics in docs/ and are not implemented here; see IDEAS.md.

module pio_sm_exec (
    input  logic        clk,
    input  logic        rst,

    // ------------------------------------------------------------------
    // Tick / control. sm_tick comes from the divider (C5) and is already
    // CC-36-deferred against this module's force_tick; a coinciding
    // sm_tick is dropped defensively (the tick model re-delivers it).
    // ------------------------------------------------------------------
    input  logic        sm_tick,
    input  logic        sm_restart,   // CTRL.SM_RESTART pulse (SPEC-7-3)
    output logic        force_tick,   // CC-35/CC-36 forced-instruction tick

    // ------------------------------------------------------------------
    // Instruction sources.
    // ------------------------------------------------------------------
    input  logic [15:0] instr_mem,    // imem word at pc (async read, CC-33)
    output logic [15:0] instr_cur,    // selected word — feeds the decoder
    input  logic        force_we,     // SMx_INSTR write (SPEC-7-23, CC-35)
    input  logic [15:0] force_instr,
    output logic [4:0]  pc,           // SMx_ADDR readback (SPEC-7-22)
    output logic        exec_stalled, // EXECCTRL.EXEC_STALLED (SPEC-7-15)

    // ------------------------------------------------------------------
    // Decoded instruction bundle (C4 output contract, decode of
    // instr_cur). Bitcounts arrive 0-decoded to 32 (SPEC-2-18).
    // ------------------------------------------------------------------
    input  logic [4:0]  delay,
    input  logic        ss_valid,     // SPEC-4-1..3
    input  logic [4:0]  ss_val,
    input  logic [2:0]  ss_bits,
    input  logic        is_jmp,       // SPEC-2-7
    input  logic        is_wait,      // SPEC-2-8
    input  logic        is_in,        // SPEC-2-9
    input  logic        is_out,       // SPEC-2-10
    input  logic        is_push,      // SPEC-2-11
    input  logic        is_pull,      // SPEC-2-13
    input  logic        is_put,       // SPEC-3.7-1
    input  logic        is_get,       // SPEC-3.7-2
    input  logic        is_mov,       // SPEC-2-15
    input  logic        is_irq,       // SPEC-2-16
    input  logic        is_set,       // SPEC-2-17
    input  logic        illegal,      // SPEC-13-1
    input  logic [2:0]  jmp_cond,     // SPEC-3.1-2..9
    input  logic [4:0]  jmp_addr,
    input  logic        wait_pol,     // SPEC-3.2-1
    input  logic [1:0]  wait_src,     // SPEC-3.2-2..5
    input  logic [4:0]  wait_index,
    input  logic [2:0]  in_src,       // SPEC-3.3-2..6
    input  logic [2:0]  out_dst,      // SPEC-3.4-2..8
    input  logic [5:0]  out_count,    // OUT bitcount (SPEC-2-18)
    input  logic        push_iff,     // SPEC-3.5-1/5
    input  logic        push_blk,     // SPEC-3.5-6
    input  logic        pull_ife,     // SPEC-3.5-2/10
    input  logic        pull_blk,     // SPEC-3.5-11
    input  logic        aux_idxi,     // SPEC-3.7-4
    input  logic [1:0]  aux_index,    // SPEC-3.7-3
    input  logic [2:0]  mov_dst,      // SPEC-3.6-1..8
    input  logic [2:0]  mov_src,
    input  logic [1:0]  mov_op,       // SPEC-3.6-9
    input  logic        irq_clr,      // SPEC-3.8-1
    input  logic        irq_wait,     // SPEC-3.8-2
    input  logic [1:0]  irq_idxmode,  // SPEC-3.8-4..7
    input  logic [2:0]  irq_index,
    input  logic [2:0]  set_dst,      // SPEC-3.9-1/2
    input  logic [4:0]  set_data,

    // ------------------------------------------------------------------
    // Config (C5 decoded fields; cfg_ prefix throughout).
    // ------------------------------------------------------------------
    input  logic [1:0]  sm_id,          // REL decode (SPEC-3.8-6)
    input  logic [4:0]  cfg_wrap_top,   // SPEC-8-2
    input  logic [4:0]  cfg_wrap_bottom,
    input  logic [4:0]  cfg_jmp_pin,    // SPEC-7-16
    input  logic [1:0]  cfg_status_sel, // SPEC-7-20
    input  logic [4:0]  cfg_status_n,
    input  logic        cfg_autopull,   // SPEC-5-8
    input  logic        cfg_autopush,   // SPEC-5-9
    input  logic [4:0]  cfg_pull_thresh,// SPEC-5-7 (raw; 0 encodes 32)
    input  logic [4:0]  cfg_push_thresh,
    input  logic        cfg_side_pindir, // SPEC-4-4
    input  logic [4:0]  cfg_sideset_base, // SPEC-4-5
    input  logic [4:0]  cfg_out_base,   // SPEC-3.4-2
    input  logic [5:0]  cfg_out_count,  // SPEC-7-26 (0 = 32 pins)
    input  logic [4:0]  cfg_set_base,   // SPEC-3.9-3
    input  logic [2:0]  cfg_set_count,  // SPEC-7-26 (0 = no write)

    // ------------------------------------------------------------------
    // Shifter interface (C2 port contract).
    // ------------------------------------------------------------------
    output logic        out_en,        // shift OUT bitcount bits (SPEC-3.4-1)
    output logic        osr_wr_en,
    output logic [31:0] osr_wr_data,
    output logic [5:0]  osr_wr_cnt,
    output logic        in_en,         // shift in_count bits in (SPEC-3.3-1)
    output logic [31:0] in_data,       // source LSBs (SPEC-3.3-7)
    output logic        in_src_isr,    // rotate semantics (SPEC-3.3-8)
    output logic        isr_wr_en,
    output logic [31:0] isr_wr_data,
    output logic [5:0]  isr_wr_cnt,
    input  logic [31:0] osr,
    input  logic [31:0] isr,
    input  logic [5:0]  osr_cnt,
    input  logic [5:0]  isr_cnt,
    input  logic [31:0] out_data,      // extracted OUT value (SPEC-3.4-1)
    input  logic        autopull_ge_thr,  // CC-11: start-of-tick c >= thr
    input  logic        autopull_post_thr,// CC-11 else-branch
    input  logic        autopush_req,     // CC-13
    input  logic [31:0] autopush_data,    // CC-9: post-shift ISR

    // ------------------------------------------------------------------
    // FIFO interface (C3 port contract).
    // ------------------------------------------------------------------
    input  logic [2:0]  fifo_mode,     // C3 encoding, decoded upstream
    output logic        rx_push,       // SPEC-3.5-4 / CC-9
    output logic [31:0] rx_push_data,
    output logic        tx_pop,        // CC-29
    output logic        aux_put,       // SPEC-3.7-3, CC-21
    output logic [1:0]  aux_put_idx,
    output logic [31:0] aux_put_data,
    output logic        aux_get,       // SPEC-3.7-3, CC-21
    output logic [1:0]  aux_get_idx,
    output logic        tx_stall_req,  // SPEC-6-7 (CC-11/CC-20)
    output logic        rx_stall_req,  // SPEC-6-7 (CC-13/CC-32)
    input  logic [31:0] tx_head_data,  // start-of-tick head (CC-4/29)
    input  logic [3:0]  rx_level,
    input  logic [3:0]  tx_level,
    input  logic        rx_full,
    input  logic        rx_empty,
    input  logic        tx_full,
    input  logic        tx_empty,
    input  logic [31:0] aux_get_data,

    // ------------------------------------------------------------------
    // GPIO interface (C7 input path; C7 write bundles — priority CC-6/7
    // applied there). Bundles asserted only on the executing tick.
    // ------------------------------------------------------------------
    input  logic [31:0] gpio_seen,     // muxed sync outputs (SPEC-10-4/5)
    input  logic [31:0] in_bus,        // rotated+masked (SPEC-10-3)
    output logic        gpio_out_we,   // OUT/MOV PINS|PINDIRS (CC-8)
    output logic        gpio_out_pindir,
    output logic [4:0]  gpio_out_base,
    output logic [5:0]  gpio_out_count,
    output logic [31:0] gpio_out_data,
    output logic        gpio_set_we,   // SET PINS|PINDIRS (CC-8)
    output logic        gpio_set_pindir,
    output logic [4:0]  gpio_set_base,
    output logic [2:0]  gpio_set_num,
    output logic [4:0]  gpio_set_data,
    output logic        gpio_ss_we,    // side-set, first tick only (CC-5)
    output logic        gpio_ss_pindir,
    output logic [4:0]  gpio_ss_base,
    output logic [2:0]  gpio_ss_num,
    output logic [4:0]  gpio_ss_data,

    // ------------------------------------------------------------------
    // IRQ flag interface (C6 per-SM slice; IdxMode routed there).
    // ------------------------------------------------------------------
    input  logic [7:0]  irq_flags,     // this block (CC-37 registered)
    input  logic [7:0]  irq_prev,      // relayed prev-block flags (CC-38)
    input  logic [7:0]  irq_next,
    output logic        irq_set_req,   // SPEC-3.8-1/2 (C6 sm_irq_set slice)
    output logic        irq_clr_req,   // (C6 sm_irq_clr slice)
    output logic [2:0]  irq_flag_idx,
    output logic [1:0]  irq_idx_mode,

    // ------------------------------------------------------------------
    // Verification readbacks (formal + TB; pio_sm may leave dangling).
    // ------------------------------------------------------------------
    output logic [3:0]  dbg_state,
    output logic [4:0]  dbg_delay,       // delay counter value
    output logic        dbg_exec,        // an instruction executes this clk
    output logic        dbg_complete,    // …and completes (effects land)
    output logic        dbg_first,       // …and it is its first exec tick
    output logic        dbg_latch_src,   // executing word is latch-sourced
    output logic        dbg_forced,      // executing word is a forced instr
    output logic        dbg_pc_wr,       // completing instr explicitly sets PC
    output logic        dbg_rel_cond,    // WAIT/irq-wait release condition
    output logic        dbg_restart_pend,
    output logic        dbg_latch_vld,   // latch holds a pending word
    output logic        dbg_latch_force, // …sourced from SMx_INSTR
    output logic [15:0] dbg_latch_word   // the latched word itself
);

  // -----------------------------------------------------------------------
  // Encodings (SPEC-2/§3 tables; C3 fifo_mode contract).
  // -----------------------------------------------------------------------
  localparam logic [3:0] ST_FETCH  = 4'b0001;  // next tick: imem word at pc
  localparam logic [3:0] ST_EXEC   = 4'b0010;  // next tick: latched executee
  localparam logic [3:0] ST_STALL  = 4'b0100;  // in-progress instr re-executes
  localparam logic [3:0] ST_DELAY  = 4'b1000;  // delay counting (CC-10)

  localparam logic [2:0] JC_ALWAYS = 3'd0, JC_NOTX = 3'd1, JC_XDEC = 3'd2,
                         JC_NOTY  = 3'd3, JC_YDEC = 3'd4, JC_XNEY = 3'd5,
                         JC_PIN   = 3'd6, JC_NOTOSRE = 3'd7;  // SPEC-3.1-2..9
  localparam logic [1:0] WSRC_GPIO = 2'd0, WSRC_PIN = 2'd1,
                         WSRC_IRQ  = 2'd2, WSRC_JMPPIN = 2'd3;  // SPEC-3.2-2..5
  localparam logic [2:0] INS_PINS = 3'd0, INS_X = 3'd1, INS_Y = 3'd2,
                         INS_NULL = 3'd3, INS_ISR = 3'd6, INS_OSR = 3'd7;  // SPEC-3.3-2..6
  localparam logic [2:0] OUTD_PINS = 3'd0, OUTD_X = 3'd1, OUTD_Y = 3'd2,
                         OUTD_NULL = 3'd3, OUTD_PINDIRS = 3'd4, OUTD_PC = 3'd5,
                         OUTD_ISR = 3'd6, OUTD_EXEC = 3'd7;  // SPEC-3.4-2..8
  localparam logic [2:0] MOVD_PINS = 3'd0, MOVD_X = 3'd1, MOVD_Y = 3'd2,
                         MOVD_PINDIRS = 3'd3, MOVD_EXEC = 3'd4, MOVD_PC = 3'd5,
                         MOVD_ISR = 3'd6, MOVD_OSR = 3'd7;  // SPEC-3.6-1..8
  localparam logic [2:0] MOVS_PINS = 3'd0, MOVS_X = 3'd1, MOVS_Y = 3'd2,
                         MOVS_NULL = 3'd3, MOVS_STATUS = 3'd5,
                         MOVS_ISR = 3'd6, MOVS_OSR = 3'd7;  // SPEC-3.6-1..8
  localparam logic [1:0] MOP_NONE = 2'd0, MOP_INV = 2'd1, MOP_REV = 2'd2;  // SPEC-3.6-9
  localparam logic [2:0] SETD_PINS = 3'd0, SETD_X = 3'd1, SETD_Y = 3'd2,
                         SETD_PINDIRS = 3'd4;  // SPEC-3.9-1/2
  localparam logic [1:0] IDX_THIS = 2'd0, IDX_PREV = 2'd1,
                         IDX_REL  = 2'd2, IDX_NEXT = 2'd3;  // SPEC-3.8-4..7
  localparam logic [2:0] FM_TXRX = 3'd0, FM_TX = 3'd1, FM_RX = 3'd2,
                         FM_TXPUT = 3'd3, FM_TXGET = 3'd4, FM_PUTGET = 3'd5;

  // -----------------------------------------------------------------------
  // Registered state — one always_ff per register group (conventions).
  // -----------------------------------------------------------------------
  logic [3:0]  state_r;
  logic [4:0]  pc_r;
  logic [31:0] x_r, y_r;
  logic [4:0]  delay_cnt_r;
  logic [15:0] latch_r;        // EXEC / forced-instruction latch (CC-34/35)
  logic        latch_vld_r;
  logic        latch_force_r;  // 1: word came from SMx_INSTR (SPEC-7-23)
  logic        force_pend_r;   // execute the forced word next clk (CC-35)
  logic        forced_stall_r; // EXEC_STALLED (SPEC-7-15, CC-35)
  logic        irqw_wait_r;    // irq wait two-phase (CC-16)
  logic        restart_pend_r; // shift-clear consumes the next sm_tick

  // -----------------------------------------------------------------------
  // Helpers.
  // -----------------------------------------------------------------------
  function automatic logic [31:0] bitrev32(input logic [31:0] v);  // SPEC-3.6-9
    for (int i = 0; i < 32; i++) bitrev32[i] = v[31 - i];
  endfunction

  // IdxMode flag read (SPEC-3.8-4..7, SPEC-14.3-1; REL adds sm id mod 4
  // on the two LSBs, bit 2 unaffected — SPEC-3.8-6).
  function automatic logic flag_rd(input logic [7:0] f_this,
                                   input logic [7:0] f_prev,
                                   input logic [7:0] f_next,
                                   input logic [1:0] mode,
                                   input logic [2:0] idx,
                                   input logic [1:0] sm);
    case (mode)
      IDX_THIS: flag_rd = f_this[idx];
      IDX_PREV: flag_rd = f_prev[idx];
      IDX_REL:  flag_rd = f_this[{idx[2], idx[1:0] + sm}];
      default:  flag_rd = f_next[idx];
    endcase
  endfunction

  // -----------------------------------------------------------------------
  // Tick arbitration and instruction selection (CC-1/CC-2, CC-35, CC-36).
  // -----------------------------------------------------------------------
  assign force_tick    = force_pend_r || forced_stall_r;  // CC-35 force-tick OR
  logic tick_forced_c, tick_sm_c;
  assign tick_forced_c = force_tick;
  assign tick_sm_c     = sm_tick && !tick_forced_c;  // CC-36: forced wins

  logic m_restart_c, m_delay_c, m_exec_c;
  always_comb begin
    m_restart_c = tick_sm_c && restart_pend_r;  // [MODEL] restart timing
    m_delay_c   = tick_sm_c && !restart_pend_r && (state_r == ST_DELAY);
    m_exec_c    = tick_forced_c
               || (tick_sm_c && !restart_pend_r && (state_r != ST_DELAY));
  end

  // Executing word: the forced word on force-ticks, the latched executee
  // while it is pending/in progress, otherwise the imem word at pc
  // (CC-33: fetch is the read of the word at the PC during the tick).
  logic src_latch_c;
  assign src_latch_c = tick_forced_c || (latch_vld_r && !latch_force_r);
  assign instr_cur   = src_latch_c ? latch_r : instr_mem;

  // First executing tick of the instruction: side-set and the irq-wait
  // set fire here only (CC-5, CC-16); a stalled forced instruction that
  // is replaced restarts from its first tick (forced_stall_r cleared on
  // the write).
  logic first_tick_c;
  assign first_tick_c = m_exec_c
                     && (tick_forced_c ? !forced_stall_r
                                      : (state_r != ST_STALL));

  // -----------------------------------------------------------------------
  // Config decodes and status values.
  // -----------------------------------------------------------------------
  logic [5:0] pull_thr_dcd_c, push_thr_dcd_c;
  always_comb begin
    pull_thr_dcd_c = (cfg_pull_thresh == 5'd0) ? 6'd32  // SPEC-5-7
                                           : {1'b0, cfg_pull_thresh};
    push_thr_dcd_c = (cfg_push_thresh == 5'd0) ? 6'd32
                                           : {1'b0, cfg_push_thresh};
  end

  logic tx_queue_c, rx_queue_c, put_ok_c, get_ok_c;
  always_comb begin
    tx_queue_c = (fifo_mode == FM_TXRX) || (fifo_mode == FM_TX)     // SPEC-6-1..4
              || (fifo_mode == FM_TXPUT) || (fifo_mode == FM_TXGET);
    rx_queue_c = (fifo_mode == FM_TXRX) || (fifo_mode == FM_RX);
    put_ok_c   = (fifo_mode == FM_TXPUT) || (fifo_mode == FM_PUTGET);  // SPEC-3.7-5
    get_ok_c   = (fifo_mode == FM_TXGET) || (fifo_mode == FM_PUTGET);
    // Autopull/autopush on a dead direction: undefined config — disabled.
    ap_on_c    = cfg_autopull && tx_queue_c;
    aph_on_c   = cfg_autopush && rx_queue_c;
  end
  logic ap_on_c, aph_on_c;

  logic [31:0] status_val_c;  // SPEC-3.6-12, SPEC-14.10-1
  always_comb begin
    case (cfg_status_sel)
      2'd0: status_val_c = ({1'b0, tx_level} < {1'b0, cfg_status_n})
                           ? 32'hFFFF_FFFF : 32'd0;
      2'd1: status_val_c = ({1'b0, rx_level} < {1'b0, cfg_status_n})
                           ? 32'hFFFF_FFFF : 32'd0;
      2'd2: status_val_c = flag_rd(irq_flags, irq_prev, irq_next,
                                   {cfg_status_n[4], cfg_status_n[3]},
                                   cfg_status_n[2:0], sm_id)
                           ? 32'hFFFF_FFFF : 32'd0;
      default: status_val_c = 32'd0;  // reserved selector: zeros
    endcase
  end

  // -----------------------------------------------------------------------
  // JMP condition (SPEC-3.1-2..11, SPEC-14.5-1: decrement is
  // unconditional, branch tests the pre-decrement value).
  // -----------------------------------------------------------------------
  logic jmp_pin_val_c, osre_c, jmp_taken_c;
  assign jmp_pin_val_c = gpio_seen[cfg_jmp_pin];             // SPEC-3.1-8
  assign osre_c        = (osr_cnt >= pull_thr_dcd_c);        // SPEC-3.1-9
  always_comb begin
    case (jmp_cond)
      JC_ALWAYS:  jmp_taken_c = 1'b1;
      JC_NOTX:    jmp_taken_c = (x_r == 32'd0);
      JC_XDEC:    jmp_taken_c = (x_r != 32'd0);
      JC_NOTY:    jmp_taken_c = (y_r == 32'd0);
      JC_YDEC:    jmp_taken_c = (y_r != 32'd0);
      JC_XNEY:    jmp_taken_c = (x_r != y_r);
      JC_PIN:     jmp_taken_c = jmp_pin_val_c;
      default:    jmp_taken_c = !osre_c;                     // !osre
    endcase
  end

  // -----------------------------------------------------------------------
  // WAIT condition (SPEC-3.2-1..9, CC-15; samples synchroniser outputs
  // at start of tick — CC-24 via the registered gpio_seen/in_bus).
  // -----------------------------------------------------------------------
  logic wait_pin_c, wait_cond_c;
  logic wait_irq_flag_c;
  assign wait_irq_flag_c = flag_rd(irq_flags, irq_prev, irq_next,
                                   wait_index[4:3], wait_index[2:0],
                                   sm_id);                    // SPEC-3.2-6
  always_comb begin
    case (wait_src)
      WSRC_GPIO:   wait_pin_c = gpio_seen[wait_index];        // SPEC-3.2-2
      WSRC_PIN:    wait_pin_c = in_bus[wait_index];           // SPEC-3.2-3
      WSRC_IRQ:    wait_pin_c = wait_irq_flag_c;              // SPEC-3.2-4
      default:     wait_pin_c = gpio_seen[cfg_jmp_pin
                                        + {3'b0, wait_index[1:0]}];  // SPEC-3.2-5
    endcase
    wait_cond_c = (wait_pin_c == wait_pol);
  end

  // -----------------------------------------------------------------------
  // MOV source value + op (SPEC-3.6-1..14).
  // -----------------------------------------------------------------------
  logic [31:0] mov_src_val_c, mov_result_c;
  always_comb begin
    case (mov_src)
      MOVS_PINS:   mov_src_val_c = in_bus;
      MOVS_X:      mov_src_val_c = x_r;
      MOVS_Y:      mov_src_val_c = y_r;
      MOVS_NULL:   mov_src_val_c = 32'd0;
      MOVS_ISR:    mov_src_val_c = isr;
      MOVS_OSR:    mov_src_val_c = osr;
      default:     mov_src_val_c = status_val_c;              // STATUS
    endcase
    case (mov_op)
      MOP_INV: mov_result_c = ~mov_src_val_c;
      MOP_REV: mov_result_c = bitrev32(mov_src_val_c);
      default: mov_result_c = mov_src_val_c;
    endcase
  end

  // -----------------------------------------------------------------------
  // Stall evaluation for the executing instruction (SPEC-9-1..7).
  // -----------------------------------------------------------------------
  logic push_guard_c, pull_guard_c, pull_fence_c;
  logic irqw_flag_c, irqw_rel_c;
  logic out_ap_ge_c;
  logic stall_c, compl_c;

  assign push_guard_c = !push_iff || (isr_cnt >= push_thr_dcd_c);  // SPEC-3.5-5, CC-31
  assign pull_guard_c = !pull_ife || (osr_cnt >= pull_thr_dcd_c);  // SPEC-3.5-10, CC-31
  assign pull_fence_c = !cfg_autopull || (osr_cnt >= pull_thr_dcd_c);  // SPEC-3.5-13

  assign irqw_flag_c = flag_rd(irq_flags, irq_prev, irq_next,
                               irq_idxmode, irq_index, sm_id);
  assign irqw_rel_c  = irqw_wait_r && !irqw_flag_c;           // CC-16

  assign out_ap_ge_c = m_exec_c && is_out && !illegal
                     && ap_on_c && autopull_ge_thr;           // CC-11

  always_comb begin
    stall_c = 1'b0;
    if (m_exec_c && !illegal) begin
      if (is_wait)
        stall_c = !wait_cond_c;                               // CC-15
      else if (is_irq && irq_wait && !irq_clr)
        stall_c = !irqw_rel_c;                                // CC-16
      else if (is_push)
        stall_c = push_guard_c && push_blk && rx_full && rx_queue_c;  // CC-19
      else if (is_pull)
        stall_c = pull_guard_c && pull_fence_c && pull_blk && tx_empty;  // CC-20
      else if (is_out)
        stall_c = out_ap_ge_c;                                // CC-11
      else if (is_in)
        stall_c = aph_on_c && autopush_req && rx_full;         // CC-13
      // JMP/MOV/SET/PUT/GET/irq-clear never stall: SPEC-3.1-11,
      // SPEC-3.6-14, SPEC-3.8-1, SPEC-3.9-3, CC-21, SPEC-9-7.
    end
  end
  assign compl_c = m_exec_c && !stall_c;

  // -----------------------------------------------------------------------
  // PC / explicit-PC writes / just-latched-executee (SPEC-8-1..4,
  // SPEC-3.4-6/10, SPEC-3.6-11, CC-34/CC-35).
  // -----------------------------------------------------------------------
  logic pc_wr_explicit_c;
  logic [4:0] pc_wr_val_c, pc_next_c;
  logic just_latched_c;
  logic [15:0] exec_word_c;
  assign pc_wr_explicit_c = compl_c && !illegal
                          && ((is_jmp && jmp_taken_c)
                           || (is_out && (out_dst == OUTD_PC))
                           || (is_mov && (mov_dst == MOVD_PC)));
  assign pc_wr_val_c = is_jmp ? jmp_addr
                     : is_out ? out_data[4:0]
                              : mov_result_c[4:0];
  assign pc_next_c = pc_wr_explicit_c ? pc_wr_val_c
                   : src_latch_c      ? pc_r              // no implicit advance
                   : (pc_r == cfg_wrap_top) ? cfg_wrap_bottom  // SPEC-8-2
                   : (pc_r + 5'd1);                        // SPEC-8-3
  assign just_latched_c = compl_c && !illegal
                        && ((is_out && (out_dst == OUTD_EXEC))
                         || (is_mov && (mov_dst == MOVD_EXEC)));  // CC-34
  assign exec_word_c = is_out ? out_data[15:0] : mov_result_c[15:0];

  // Delay load: executee honours its delay field; the EXEC-latching
  // instruction's own delay is ignored (SPEC-3.4-10) and so is a forced
  // instruction's (SPEC-7-23).
  logic delay_load_c;
  assign delay_load_c = compl_c && !just_latched_c && !tick_forced_c;

  // -----------------------------------------------------------------------
  // X / Y writes (SPEC-3.1-4/6, SPEC-3.4-3, SPEC-3.6-2/3, SPEC-3.9-1).
  // -----------------------------------------------------------------------
  logic x_wr_c, y_wr_c;
  logic [31:0] x_val_c, y_val_c;
  assign x_wr_c = compl_c && !illegal && ((is_jmp && (jmp_cond == JC_XDEC))
                                       || (is_out && (out_dst == OUTD_X))
                                       || (is_set && (set_dst == SETD_X))
                                       || (is_mov && (mov_dst == MOVD_X)));
  assign y_wr_c = compl_c && !illegal && ((is_jmp && (jmp_cond == JC_YDEC))
                                       || (is_out && (out_dst == OUTD_Y))
                                       || (is_set && (set_dst == SETD_Y))
                                       || (is_mov && (mov_dst == MOVD_Y)));
  always_comb begin
    x_val_c = is_jmp  ? (x_r - 32'd1)   // SPEC-14.5-1
            : is_out  ? out_data
            : is_set  ? {27'd0, set_data}
                      : mov_result_c;
    y_val_c = is_jmp  ? (y_r - 32'd1)
            : is_out  ? out_data
            : is_set  ? {27'd0, set_data}
                      : mov_result_c;
  end

  // -----------------------------------------------------------------------
  // Shifter / FIFO dispatch.
  // -----------------------------------------------------------------------
  // Autopull refills (CC-11/CC-12; see header interpretation note).
  logic ap_ge_refill_c, ap_post_refill_c, ap_bg_c;
  logic pull_load_c, pull_fallb_c;
  logic get_en_c, mov_osr_c;
  assign ap_ge_refill_c   = out_ap_ge_c && !tx_empty;   // refill on the CC-11 stall tick
  assign ap_post_refill_c = compl_c && is_out && !illegal && ap_on_c
                          && autopull_post_thr && !tx_empty;  // CC-11 else-branch
  assign ap_bg_c = m_exec_c && !illegal && !is_out && ap_on_c
                 && autopull_ge_thr && !tx_empty
                 && !(is_pull || (is_get && get_ok_c)
                      || (is_mov && (mov_dst == MOVD_OSR)));  // CC-12

  assign pull_load_c = compl_c && !illegal && is_pull
                     && pull_guard_c && pull_fence_c && !tx_empty;  // CC-20
  assign pull_fallb_c = compl_c && !illegal && is_pull
                     && pull_guard_c && pull_fence_c && !pull_blk
                     && tx_empty;                              // CC-32, SPEC-14.7-1
  assign get_en_c = compl_c && !illegal && is_get && get_ok_c;  // CC-21
  assign mov_osr_c = compl_c && !illegal && is_mov
                   && (mov_dst == MOVD_OSR);                   // SPEC-5-6

  assign out_en = compl_c && !illegal && is_out;               // CC-11/CC-17

  assign osr_wr_en = m_restart_c || ap_ge_refill_c || ap_post_refill_c
                  || ap_bg_c
                  || pull_load_c || pull_fallb_c || get_en_c || mov_osr_c;
  always_comb begin
    if (m_restart_c)             osr_wr_data = osr;    // contents preserved
    else if (pull_load_c || ap_ge_refill_c || ap_post_refill_c || ap_bg_c)
                                 osr_wr_data = tx_head_data;
    else if (pull_fallb_c)       osr_wr_data = x_r;    // SPEC-3.5-12
    else if (get_en_c)           osr_wr_data = aux_get_data;
    else                         osr_wr_data = mov_result_c;
  end
  assign osr_wr_cnt = m_restart_c ? 6'd32 : 6'd0;  // SPEC-5-3/5-5/5-6

  assign tx_pop = pull_load_c || ap_ge_refill_c || ap_post_refill_c
               || ap_bg_c;                                     // CC-29

  assign in_en = compl_c && !illegal && is_in;                 // CC-9
  assign in_src_isr = (in_src == INS_ISR);                     // SPEC-3.3-8
  always_comb begin
    case (in_src)
      INS_PINS: in_data = in_bus;                              // SPEC-3.3-2
      INS_X:    in_data = x_r;
      INS_Y:    in_data = y_r;
      INS_OSR:  in_data = osr;                                 // SPEC-3.3-8
      default:  in_data = 32'd0;   // NULL shifts zeroes (SPEC-3.3-4, SPEC-14.6-1)
    endcase
  end

  // Autopush (CC-9/CC-13): post-shift ISR pushed in the completing cycle.
  logic in_ap_c, push_do_c;
  assign in_ap_c = compl_c && !illegal && is_in && aph_on_c
                 && autopush_req && !rx_full;
  // PUSH (SPEC-3.5-4..8): full no-op unless the RX side is a queue
  // (SPEC-3.5-8 undefined — RTL choice).
  assign push_do_c = compl_c && !illegal && is_push
                   && rx_queue_c && push_guard_c;

  assign rx_push = in_ap_c || (push_do_c && !rx_full);
  assign rx_push_data = is_push ? isr : autopush_data;  // CC-29 / CC-9

  logic out_isr_c, mov_isr_c;
  assign out_isr_c = compl_c && !illegal && is_out && (out_dst == OUTD_ISR);
  assign mov_isr_c = compl_c && !illegal && is_mov && (mov_dst == MOVD_ISR);
  assign isr_wr_en = m_restart_c || in_ap_c || push_do_c
                  || out_isr_c || mov_isr_c;
  always_comb begin
    if (m_restart_c)      isr_wr_data = 32'd0;   // SPEC-7-3 clear
    else if (out_isr_c)   isr_wr_data = out_data;
    else if (mov_isr_c)   isr_wr_data = mov_result_c;
    else                  isr_wr_data = 32'd0;   // PUSH/autopush clear (SPEC-5-1/5-5)
    isr_wr_cnt = out_isr_c ? out_count : 6'd0;   // SPEC-5-6; others 0
  end

  // FDEBUG stall causes (SPEC-6-7): exec judges, C3 latches stickiness.
  assign tx_stall_req = (m_exec_c && !illegal && is_pull
                         && pull_guard_c && pull_fence_c && pull_blk
                         && tx_empty)                       // CC-20, CC-17 note
                     || (out_ap_ge_c && tx_empty);          // CC-11

  assign rx_stall_req = (m_exec_c && !illegal && is_in && aph_on_c
                         && autopush_req && rx_full)    // CC-13
                     || (push_do_c && !push_blk && rx_full);  // CC-32

  // FIFO-aux (SPEC-3.7-3/4, CC-21): index literal or Y[1:0].
  logic [1:0] aux_idx_c;
  assign aux_idx_c   = aux_idxi ? aux_index : y_r[1:0];
  assign aux_put     = compl_c && !illegal && is_put && put_ok_c;
  assign aux_get     = get_en_c;
  assign aux_put_idx = aux_idx_c;
  assign aux_get_idx = aux_idx_c;
  assign aux_put_data = isr;

  // -----------------------------------------------------------------------
  // GPIO write bundles (CC-5, CC-8; C7 resolves priority CC-6/CC-7).
  // -----------------------------------------------------------------------
  assign gpio_ss_we    = first_tick_c && ss_valid && !illegal;  // CC-5
  assign gpio_ss_pindir = cfg_side_pindir;                      // SPEC-4-4
  assign gpio_ss_base  = cfg_sideset_base;                      // SPEC-4-5
  assign gpio_ss_num   = ss_bits;
  assign gpio_ss_data  = ss_val;

  assign gpio_out_we = compl_c && !illegal
                     && ((is_out && ((out_dst == OUTD_PINS)
                                 || (out_dst == OUTD_PINDIRS)))
                      || (is_mov && ((mov_dst == MOVD_PINS)
                                 || (mov_dst == MOVD_PINDIRS))));
  assign gpio_out_pindir = is_out ? (out_dst == OUTD_PINDIRS)
                                  : (mov_dst == MOVD_PINDIRS);
  assign gpio_out_base  = cfg_out_base;
  assign gpio_out_count = cfg_out_count;
  assign gpio_out_data  = is_out ? out_data : mov_result_c;

  assign gpio_set_we = compl_c && !illegal && is_set
                     && ((set_dst == SETD_PINS) || (set_dst == SETD_PINDIRS));
  assign gpio_set_pindir = (set_dst == SETD_PINDIRS);
  assign gpio_set_base  = cfg_set_base;
  assign gpio_set_num   = cfg_set_count;
  assign gpio_set_data  = set_data;

  // -----------------------------------------------------------------------
  // IRQ requests (SPEC-3.8-1/2; set on the first tick, clear on the
  // completing tick — CC-37 visibility is C6's registered flags).
  // -----------------------------------------------------------------------
  assign irq_set_req = first_tick_c && !illegal && is_irq && !irq_clr;
  assign irq_clr_req = compl_c && !illegal
                    && ((is_irq && irq_clr)
                     || (is_wait && (wait_src == WSRC_IRQ) && wait_pol));  // CC-15
  assign irq_flag_idx = is_irq ? irq_index : wait_index[2:0];
  assign irq_idx_mode = is_irq ? irq_idxmode : wait_index[4:3];

  // -----------------------------------------------------------------------
  // Readbacks / debug.
  // -----------------------------------------------------------------------
  assign pc           = pc_r;
  assign exec_stalled = forced_stall_r;  // SPEC-7-15
  assign dbg_state    = state_r;
  assign dbg_delay    = delay_cnt_r;
  assign dbg_exec     = m_exec_c;
  assign dbg_complete = compl_c;
  assign dbg_first    = first_tick_c;
  assign dbg_latch_src = m_exec_c && src_latch_c;
  assign dbg_forced   = m_exec_c && tick_forced_c;
  assign dbg_pc_wr    = pc_wr_explicit_c;
  assign dbg_rel_cond = (m_exec_c && !illegal && is_wait) ? wait_cond_c
                      : (m_exec_c && !illegal && is_irq && irq_wait && !irq_clr)
                        ? irqw_rel_c
                      : 1'b0;
  assign dbg_restart_pend = restart_pend_r;
  assign dbg_latch_vld    = latch_vld_r;
  assign dbg_latch_force  = latch_force_r;
  assign dbg_latch_word   = latch_r;

  // -----------------------------------------------------------------------
  // G1: FSM state (onehot by construction; asserted in formal).
  // Ordering note: a completing tick outranks SM_RESTART's delay-exit,
  // mirroring G3 (delay-load beats the restart clear) — otherwise a
  // restart coinciding with a completion loads a delay the FSM never
  // counts. The restart's own branch still exits ST_DELAY when the
  // restart lands off-tick (SPEC-7-3: delay cleared).
  // -----------------------------------------------------------------------
  always_ff @(posedge clk) begin
    if (rst) begin
      state_r <= ST_FETCH;
    end else if (m_restart_c) begin
      // The clear tick consumes the tick ([MODEL]) — but a new restart
      // pulse on this edge still clears the delay (G3); exit with it.
      if (sm_restart && state_r == ST_DELAY) state_r <= ST_FETCH;
    end else if (tick_forced_c) begin
      if (compl_c) begin
        if (just_latched_c) begin
          state_r <= ST_EXEC;  // CC-34: executee pending, delay dropped
        end else if (pc_wr_explicit_c) begin
          // CC-35: a pc-writing forced instruction abandons any
          // in-progress instruction.
          state_r <= ST_FETCH;
        end else if (state_r == ST_EXEC) begin
          // A forced word that replaced a pending executee completed
          // without chaining: the latch is empty, so the next sm tick
          // must fetch — ST_EXEC would claim a latch that is gone.
          state_r <= ST_FETCH;
        end else if (sm_restart && state_r == ST_DELAY) begin
          // G3 clears the delay on this same edge; the hold must not
          // preserve an empty ST_DELAY.
          state_r <= ST_FETCH;
        end
        // otherwise the forced instruction merely interleaved: hold —
        // unless SM_RESTART acts on this same edge (G3 clears the
        // delay, G4 may drop a forced latch word), emptying the state
        // the hold would preserve.
      end else if (sm_restart
                   && (state_r == ST_DELAY || state_r == ST_EXEC)) begin
        state_r <= ST_FETCH;
      end
    end else if (m_exec_c) begin
      if (!compl_c)            state_r <= ST_STALL;
      else if (just_latched_c) state_r <= ST_EXEC;
      else if (delay != 5'd0)  state_r <= ST_DELAY;      // CC-10
      else                     state_r <= ST_FETCH;
    end else if (sm_restart) begin
      // SPEC-7-3: delay cleared. A dropped stalled forced word also
      // empties the latch (G4), so ST_EXEC must not outlive it.
      if (state_r == ST_DELAY
          || (state_r == ST_EXEC && latch_force_r))
        state_r <= ST_FETCH;
    end else if (m_delay_c && !sm_restart) begin
      if (delay_cnt_r == 5'd1) state_r <= ST_FETCH;      // last delay tick
      // !sm_restart: G3's restart clear empties the delay on this
      // edge instead of decrementing — the sm_restart branch above
      // then exits ST_DELAY rather than holding an empty one.
    end
  end

  // -----------------------------------------------------------------------
  // G2: PC + X + Y. SM_RESTART preserves all three (SPEC-7-3, sdk N2);
  // PC changes only on completing ticks (CC-10, CC-34, CC-35).
  // -----------------------------------------------------------------------
  always_ff @(posedge clk) begin
    if (rst) begin
      pc_r <= 5'd0;
      x_r  <= 32'd0;
      y_r  <= 32'd0;
    end else if (compl_c) begin
      pc_r <= pc_next_c;
      if (x_wr_c) x_r <= x_val_c;
      if (y_wr_c) y_r <= y_val_c;
    end
  end

  // -----------------------------------------------------------------------
  // G3: delay counter (CC-10: loads at the completing tick, decrements
  // on delay ticks, frozen during stalls — CC-14). A forced instruction
  // that changes the flow (pc write or EXEC latch) preempts a pending
  // delay (CC-35 [MODEL], G1 abandons the in-progress instruction) —
  // the frozen remainder is dropped so ST_DELAY ⇒ delay > 0 holds.
  // -----------------------------------------------------------------------
  always_ff @(posedge clk) begin
    if (rst)                    delay_cnt_r <= 5'd0;
    else if (delay_load_c)      delay_cnt_r <= delay;
    else if (sm_restart)        delay_cnt_r <= 5'd0;   // SPEC-7-3
    else if (tick_forced_c && compl_c
             && (just_latched_c || pc_wr_explicit_c))
                                 delay_cnt_r <= 5'd0;  // preempted delay
    else if (m_delay_c)         delay_cnt_r <= delay_cnt_r - 5'd1;
  end

  // -----------------------------------------------------------------------
  // G4: EXEC / forced-instruction latch (SPEC-7-23, SPEC-11-1, CC-34/35).
  // Priority: force write > SM_RESTART > execution. A force write
  // replaces an in-progress executee or a stalled forced instruction;
  // SM_RESTART drops the stalled forced instruction but keeps a fresh
  // executee latched on the same edge.
  // -----------------------------------------------------------------------
  always_ff @(posedge clk) begin
    if (rst) begin
      latch_r        <= 16'd0;
      latch_vld_r    <= 1'b0;
      latch_force_r  <= 1'b0;
      force_pend_r   <= 1'b0;
      forced_stall_r <= 1'b0;
    end else if (force_we) begin
      latch_r        <= force_instr;  // SPEC-7-23 overwrite
      latch_vld_r    <= 1'b1;
      latch_force_r  <= 1'b1;
      force_pend_r   <= 1'b1;
      forced_stall_r <= 1'b0;         // replacement starts from tick one
    end else if (sm_restart) begin
      force_pend_r   <= 1'b0;   // SPEC-7-3: stalled forced instruction
      forced_stall_r <= 1'b0;
      if (compl_c && just_latched_c) begin
        latch_r       <= exec_word_c;  // fresh executee survives restart
        latch_vld_r   <= 1'b1;
        latch_force_r <= 1'b0;
      end else if (latch_force_r) begin
        latch_vld_r   <= 1'b0;
        latch_force_r <= 1'b0;  // drop the flag with the word
      end
    end else if (tick_forced_c) begin
      if (compl_c) begin
        force_pend_r   <= 1'b0;
        forced_stall_r <= 1'b0;
        latch_vld_r    <= just_latched_c;
        latch_force_r  <= 1'b0;       // any new latch content is an executee
        if (just_latched_c) latch_r <= exec_word_c;
      end else begin
        forced_stall_r <= 1'b1;       // EXEC_STALLED (SPEC-7-15)
      end
    end else if (compl_c && just_latched_c) begin
      // A fetched OUT/MOV EXEC latches its executee (CC-34) — and an
      // executee that is itself an EXEC chains into the same latch.
      latch_r       <= exec_word_c;
      latch_vld_r   <= 1'b1;
      latch_force_r <= 1'b0;
    end else if (m_exec_c && src_latch_c && compl_c) begin
      latch_vld_r <= 1'b0;            // executee completed, nothing chained
    end
  end

  // -----------------------------------------------------------------------
  // G5: irq-wait two-phase + restart pending (CC-16, SPEC-7-3).
  // -----------------------------------------------------------------------
  always_ff @(posedge clk) begin
    if (rst) begin
      irqw_wait_r    <= 1'b0;
      restart_pend_r <= 1'b0;
    end else if (sm_restart) begin
      irqw_wait_r    <= 1'b0;   // SPEC-7-3: waiting-on-IRQ state
      restart_pend_r <= 1'b1;
    end else begin
      if (m_restart_c) restart_pend_r <= 1'b0;
      if (m_exec_c && !illegal && is_irq && irq_wait && !irq_clr)
        irqw_wait_r <= !compl_c;               // set on the stalled first tick
      else if (tick_forced_c && compl_c && pc_wr_explicit_c)
        irqw_wait_r <= 1'b0;   // in-progress instruction abandoned (CC-35)
    end
  end

endmodule

// Formal properties for pio_sm (KANBAN C9) — the assembly-level
// integration proof. The wrapper instantiates the real pio_sm (all five
// submodules, exactly as pio_block will); assertions probe only its
// ports, using the dbg_* readback bundle the module exports for this
// purpose (yosys cannot probe instance internals from a wrapper).
//
// Checked (bmc + prove), per the C9 acceptance:
//   P1  onehot FSM inherited from u_exec (DESIGN.md conventions).
//   P2  CC-36 wiring: u_regs' deferral keeps sm_tick and force_tick
//       mutually exclusive.
//   P3  CC-11/CC-12 fence: an OUT whose start-of-tick OSR counter is at
//       threshold with TX data available stalls without shifting while
//       the refill (pop + OSR load of the TX head) lands — the refill
//       never feeds the same tick's OUT; the only completing OUT that
//       pops is the else-branch simultaneous last-shift refill, whose
//       fresh word lands at the same edge.
//   P4  CC-9/CC-29 push data wiring: PUSH pushes the start-of-tick ISR,
//       autopush the post-shift ISR; an autopush clears ISR+counter.
//   P5  CC-13 stall freeze: an IN that cannot land its autopush stalls
//       with the shifter frozen (no shift, no push, ISR/counter hold)
//       and latches the FDEBUG.RXSTALL sticky (SPEC-6-7).
//   P6  FIFO mode decode (SPEC-6-2/6-3): aux bits override the joins.
//
// Assumptions (documented proof scoping):
//   A1  rst asserted in the initial state (CC-1 protocol).
//   A2  FIFO system side idle except TX writes: sys_aux_wr/rd idle and
//       sys_rx_rd idle (RX drain and the PUTGET bus port are C3's and
//       C10's; TX writes must stay live for the CC-12 refill guards to
//       be reachable at all). Free sys_tx_wr exercises CC-30's fence.
//   A3  clkdiv_we idle — the divider is *assumed* per the card: it runs
//       at the reset divisor 1 (sm_tick every enabled clk, CC-26),
//       whose behaviour C5 proved independently; CLKDIV_RESTART itself
//       stays free (harmless: it only delays ticks).
//   A4  fdbg_clr free (P5 guards the W1C priority).
//
// Style note (owner convention): immediate assertions inside
// `always @(posedge clk)` with explicit previous-cycle registers;
// formal-only file (never compiled by iverilog).

module pio_sm_fv (
    input  logic        clk,
    input  logic        rst,
    input  logic [15:0] instr,
    input  logic [31:0] gpio_seen,
    input  logic [31:0] in_bus,
    input  logic [7:0]  irq_flags,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic        clkdiv_we,
    input  logic [31:0] clkdiv_wdata,
    input  logic        execctrl_we,
    input  logic [31:0] execctrl_wdata,
    input  logic        shiftctrl_we,
    input  logic [31:0] shiftctrl_wdata,
    input  logic        pinctrl_we,
    input  logic [31:0] pinctrl_wdata,
    input  logic        sm_en,
    input  logic        sm_restart,
    input  logic        clkdiv_restart,
    input  logic        force_we,
    input  logic [15:0] force_instr,
    input  logic        sys_tx_wr,
    input  logic [31:0] sys_tx_wdata,
    input  logic        sys_rx_rd,
    input  logic        sys_aux_wr,
    input  logic [1:0]  sys_aux_addr,
    input  logic [31:0] sys_aux_wdata,
    input  logic        sys_aux_rd,
    input  logic [3:0]  fdbg_clr
);

  localparam logic [3:0] ST_FETCH  = 4'b0001;
  localparam logic [3:0] ST_EXEC   = 4'b0010;
  localparam logic [3:0] ST_STALL  = 4'b0100;
  localparam logic [3:0] ST_DELAY  = 4'b1000;
  localparam logic [2:0] FM_TXRX   = 3'd0, FM_TX = 3'd1, FM_RX = 3'd2,
                         FM_TXPUT  = 3'd3, FM_TXGET = 3'd4, FM_PUTGET = 3'd5;

  // -----------------------------------------------------------------------
  // DUT + outputs.
  // -----------------------------------------------------------------------
  logic        gpio_out_we, gpio_out_pindir, gpio_set_we, gpio_set_pindir;
  logic [4:0]  gpio_out_base, gpio_set_base, gpio_set_data;
  logic [5:0]  gpio_out_count;
  logic [31:0] gpio_out_data;
  logic [2:0]  gpio_set_num;
  logic        gpio_ss_we, gpio_ss_pindir;
  logic [4:0]  gpio_ss_base, gpio_ss_data;
  logic [2:0]  gpio_ss_num;
  logic        out_sticky;
  logic        irq_set_req, irq_clr_req;
  logic [2:0]  irq_flag_idx;
  logic [1:0]  irq_idx_mode;
  logic [31:0] sys_rx_rdata, sys_aux_rdata;
  logic        fdbg_tx_stall, fdbg_rx_stall, fdbg_tx_over, fdbg_rx_under;
  logic [4:0]  pc;
  logic [3:0]  tx_level, rx_level;
  logic        exec_stalled;
  logic        dbg_sm_tick, dbg_force_tick;
  logic [3:0]  dbg_state;
  logic        dbg_exec, dbg_complete, dbg_is_in, dbg_is_out, dbg_is_push;
  logic        dbg_out_en, dbg_tx_pop, dbg_rx_push, dbg_osr_wr_en;
  logic        dbg_autopull_ge_thr, dbg_tx_empty;
  logic [31:0] dbg_rx_push_data, dbg_autopush_data, dbg_osr_wr_data;
  logic [31:0] dbg_tx_head_data, dbg_osr, dbg_isr;
  logic [5:0]  dbg_osr_cnt, dbg_isr_cnt;
  logic [2:0]  dbg_fifo_mode;
  logic        dbg_fjoin_tx, dbg_fjoin_rx, dbg_fjoin_rx_put, dbg_fjoin_rx_get;

  pio_sm #(.SM_IDX(2'd0)) u_dut (
      .clk(clk), .rst(rst),
      .instr(instr),
      .gpio_seen(gpio_seen), .in_bus(in_bus),
      .irq_flags(irq_flags), .irq_prev_r(irq_prev_r), .irq_next_r(irq_next_r),
      .clkdiv_we(clkdiv_we), .clkdiv_wdata(clkdiv_wdata),
      .execctrl_we(execctrl_we), .execctrl_wdata(execctrl_wdata),
      .shiftctrl_we(shiftctrl_we), .shiftctrl_wdata(shiftctrl_wdata),
      .pinctrl_we(pinctrl_we), .pinctrl_wdata(pinctrl_wdata),
      .sm_en(sm_en), .sm_restart(sm_restart), .clkdiv_restart(clkdiv_restart),
      .force_we(force_we), .force_instr(force_instr),
      .gpio_out_we(gpio_out_we), .gpio_out_pindir(gpio_out_pindir),
      .gpio_out_base(gpio_out_base), .gpio_out_count(gpio_out_count),
      .gpio_out_data(gpio_out_data),
      .gpio_set_we(gpio_set_we), .gpio_set_pindir(gpio_set_pindir),
      .gpio_set_base(gpio_set_base), .gpio_set_num(gpio_set_num),
      .gpio_set_data(gpio_set_data),
      .gpio_ss_we(gpio_ss_we), .gpio_ss_pindir(gpio_ss_pindir),
      .gpio_ss_base(gpio_ss_base), .gpio_ss_num(gpio_ss_num),
      .gpio_ss_data(gpio_ss_data),
      .out_sticky(out_sticky),
      .irq_set_req(irq_set_req), .irq_clr_req(irq_clr_req),
      .irq_flag_idx(irq_flag_idx), .irq_idx_mode(irq_idx_mode),
      .sys_tx_wr(sys_tx_wr), .sys_tx_wdata(sys_tx_wdata),
      .sys_rx_rd(sys_rx_rd), .sys_rx_rdata(sys_rx_rdata),
      .sys_aux_wr(sys_aux_wr), .sys_aux_addr(sys_aux_addr),
      .sys_aux_wdata(sys_aux_wdata),
      .sys_aux_rd(sys_aux_rd), .sys_aux_rdata(sys_aux_rdata),
      .fdbg_clr(fdbg_clr),
      .fdbg_tx_stall(fdbg_tx_stall), .fdbg_rx_stall(fdbg_rx_stall),
      .fdbg_tx_over(fdbg_tx_over), .fdbg_rx_under(fdbg_rx_under),
      .pc(pc), .tx_level(tx_level), .rx_level(rx_level),
      .exec_stalled(exec_stalled),
      .dbg_sm_tick(dbg_sm_tick), .dbg_force_tick(dbg_force_tick),
      .dbg_state(dbg_state),
      .dbg_exec(dbg_exec), .dbg_complete(dbg_complete),
      .dbg_is_in(dbg_is_in), .dbg_is_out(dbg_is_out), .dbg_is_push(dbg_is_push),
      .dbg_out_en(dbg_out_en), .dbg_tx_pop(dbg_tx_pop), .dbg_rx_push(dbg_rx_push),
      .dbg_rx_push_data(dbg_rx_push_data), .dbg_autopush_data(dbg_autopush_data),
      .dbg_osr_wr_en(dbg_osr_wr_en), .dbg_osr_wr_data(dbg_osr_wr_data),
      .dbg_tx_head_data(dbg_tx_head_data),
      .dbg_autopull_ge_thr(dbg_autopull_ge_thr),
      .dbg_osr(dbg_osr), .dbg_isr(dbg_isr),
      .dbg_osr_cnt(dbg_osr_cnt), .dbg_isr_cnt(dbg_isr_cnt),
      .dbg_tx_empty(dbg_tx_empty),
      .dbg_fifo_mode(dbg_fifo_mode),
      .dbg_fjoin_tx(dbg_fjoin_tx), .dbg_fjoin_rx(dbg_fjoin_rx),
      .dbg_fjoin_rx_put(dbg_fjoin_rx_put), .dbg_fjoin_rx_get(dbg_fjoin_rx_get)
  );

  // -----------------------------------------------------------------------
  // Previous-cycle bookkeeping (explicit $past replacement).
  // -----------------------------------------------------------------------
  logic        p_rst_r = 1'b1;
  logic        p_exec_r = 1'b0, p_complete_r = 1'b0;
  logic        p_is_out_r = 1'b0, p_is_in_r = 1'b0, p_is_push_r = 1'b0;
  logic        p_out_en_r = 1'b0, p_tx_pop_r = 1'b0, p_rx_push_r = 1'b0;
  logic        p_autopull_ge_thr_r = 1'b0, p_tx_empty_r = 1'b1;
  logic [31:0] p_tx_head_r = 32'd0;
  logic [31:0] p_isr_r = 32'd0;
  logic [5:0]  p_isr_cnt_r = 6'd0;
  logic [3:0]  p_fdbg_clr_r = 4'd0;
  logic [2:0]  p_fifo_mode_r = FM_TXRX;
  always_ff @(posedge clk) begin
    p_rst_r              <= rst;
    p_exec_r             <= dbg_exec;
    p_complete_r         <= dbg_complete;
    p_is_out_r           <= dbg_is_out;
    p_is_in_r            <= dbg_is_in;
    p_is_push_r          <= dbg_is_push;
    p_out_en_r           <= dbg_out_en;
    p_tx_pop_r           <= dbg_tx_pop;
    p_rx_push_r          <= dbg_rx_push;
    p_autopull_ge_thr_r  <= dbg_autopull_ge_thr;
    p_tx_empty_r         <= dbg_tx_empty;
    p_tx_head_r          <= dbg_tx_head_data;
    p_isr_r              <= dbg_isr;
    p_isr_cnt_r          <= dbg_isr_cnt;
    p_fdbg_clr_r         <= fdbg_clr;
    p_fifo_mode_r        <= dbg_fifo_mode;
  end

  // -----------------------------------------------------------------------
  // Assumptions.
  // -----------------------------------------------------------------------
  always @(posedge clk) begin
    if ($initstate) assume (rst);                     // A1 (CC-1)

    // A2: FIFO system side idle except TX writes (proof scoping).
    assume (!sys_rx_rd);
    assume (!sys_aux_wr);
    assume (!sys_aux_rd);

    // A3: divider assumed — pinned at the reset divisor 1 (C5 proven).
    assume (!clkdiv_we);
  end

  // -----------------------------------------------------------------------
  // Assertions.
  // -----------------------------------------------------------------------
  always @(posedge clk) begin
    // !p_rst_r: previous-cycle evidence must postdate the reset edge
    // (the C8 harness idiom — at $initstate the DUT registers are free).
    if (!$initstate && !rst && !p_rst_r) begin
      // P1: onehot FSM (inherited; CC-1).
      a_p1_onehot : assert (dbg_state == ST_FETCH || dbg_state == ST_EXEC
                            || dbg_state == ST_STALL
                            || dbg_state == ST_DELAY);

      // P2: CC-36 deferral wired through u_regs.
      a_p2_no_coincide : assert (!(dbg_sm_tick && dbg_force_tick));

      // P3: CC-11 first branch — ge-thr OUT with TX data: stall without
      // shifting; the refill (pop + head load) lands in the same tick.
      // This is the CC-12 fence: the fresh word cannot feed this OUT.
      // The mode term mirrors u_exec's tx_queue_c: the autopull
      // machinery is scoped to the queue modes (C8 interpretation —
      // SPEC-6-4 keeps the TX FIFO live in aux modes for explicit PULL,
      // but FM_PUTGET carries no autopull). !dbg_tx_empty additionally
      // excludes a join-stolen TX, which reports both full and empty
      // (SPEC-6-2).
      if (dbg_exec && dbg_is_out && dbg_autopull_ge_thr && !dbg_tx_empty
          && dbg_fifo_mode != FM_RX && dbg_fifo_mode != FM_PUTGET) begin
        a_p3_stall  : assert (!dbg_out_en && !dbg_complete);
        a_p3_refill : assert (dbg_tx_pop && dbg_osr_wr_en
                              && dbg_osr_wr_data == dbg_tx_head_data);
      end
      // …and the refill registers despite the stall (same mode scope as
      // the stall guard above).
      if (p_exec_r && p_is_out_r && p_autopull_ge_thr_r && !p_tx_empty_r
          && p_fifo_mode_r != FM_RX && p_fifo_mode_r != FM_PUTGET)
        a_p3_land : assert (dbg_osr == p_tx_head_r && dbg_osr_cnt == 6'd0);

      // P3 else-branch: the only completing OUT that pops the TX is the
      // simultaneous last-shift refill; the fresh word lands at the edge
      // (the shifted bits are the pre-refill OSR — C2's registered
      // extraction, proven there).
      if (dbg_out_en && dbg_tx_pop)
        a_p3_simul : assert (dbg_osr_wr_en
                             && dbg_osr_wr_data == dbg_tx_head_data);
      if (p_out_en_r && p_tx_pop_r)
        a_p3_simul_land : assert (dbg_osr == p_tx_head_r
                                  && dbg_osr_cnt == 6'd0);

      // P4: CC-29 / CC-9 push data wiring.
      if (dbg_rx_push)
        a_p4_data : assert (dbg_rx_push_data
                            == (dbg_is_push ? dbg_isr : dbg_autopush_data));
      // An autopush clears ISR and counter at the same edge (CC-9).
      if (p_rx_push_r && !p_is_push_r)
        a_p4_clear : assert (dbg_isr == 32'd0 && dbg_isr_cnt == 6'd0);

      // P5: CC-13 — an IN that cannot land its autopush stalls frozen.
      // (exec && is_in && !complete is exactly that stall: IN never
      // stalls otherwise — CC-18 — and an illegal IN completes.)
      if (p_exec_r && p_is_in_r && !p_complete_r) begin
        a_p5_freeze : assert (dbg_isr == p_isr_r && dbg_isr_cnt == p_isr_cnt_r);
        a_p5_nopush : assert (!p_rx_push_r);
      end
      // …and latches the RXSTALL sticky unless cleared the same edge.
      if (p_exec_r && p_is_in_r && !p_complete_r && !p_fdbg_clr_r[2])
        a_p5_sticky : assert (fdbg_rx_stall);            // SPEC-6-7

      // P6: FIFO mode decode (SPEC-6-2/6-3) — aux overrides joins.
      if (dbg_fjoin_rx_put || dbg_fjoin_rx_get)
        a_p6_aux : assert (dbg_fifo_mode == FM_TXPUT
                           || dbg_fifo_mode == FM_TXGET
                           || dbg_fifo_mode == FM_PUTGET);
      else if (dbg_fjoin_tx) a_p6_tx  : assert (dbg_fifo_mode == FM_TX);
      else if (dbg_fjoin_rx) a_p6_rx  : assert (dbg_fifo_mode == FM_RX);
      else                   a_p6_txrx : assert (dbg_fifo_mode == FM_TXRX);
    end
  end

  // -----------------------------------------------------------------------
  // Covers (sanity that the interesting behaviours are reachable).
  // -----------------------------------------------------------------------
  always @(posedge clk) begin
    if (!$initstate && !rst) begin
      if (dbg_exec && dbg_is_out && dbg_autopull_ge_thr && !dbg_tx_empty)
        c_cc11_stall_refill : cover (1'b1);           // CC-11 first branch
      if (dbg_out_en && dbg_tx_pop)
        c_cc12_simul_refill : cover (1'b1);           // CC-11 else-branch
      if (dbg_rx_push && !dbg_is_push)
        c_autopush : cover (1'b1);                    // CC-9
      if (dbg_exec && dbg_is_in && !dbg_complete)
        c_cc13_in_stall : cover (1'b1);               // CC-13
      if (dbg_force_tick)
        c_force_tick : cover (1'b1);                  // CC-35
      if (dbg_fifo_mode == FM_TXPUT || dbg_fifo_mode == FM_TXGET
          || dbg_fifo_mode == FM_PUTGET)
        c_aux_mode : cover (1'b1);                    // SPEC-6-3
      if (exec_stalled)
        c_exec_stalled : cover (1'b1);                // SPEC-7-15
    end
  end

endmodule

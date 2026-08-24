// tb_pio_sm — directed TB for rtl/pio_sm.sv (KANBAN C9): the assembled
// state machine with config arriving through the register write ports
// (SPEC-7-25), the divider producing sm_tick in-circuit (CC-26), and the
// block-boundary bundles (pin writes, IRQ requests, FIFO system bus).
//
// The TB plays the block (C10 preview): imem (async read at pc, CC-33),
// the gpio-mux input buses (gpio_seen / in_bus driven directly — the
// 2-FF sync is C7's, CC-23), a mini irq-flag register (CC-37 next-cycle
// visibility, CC-39 clear-wins, THIS/REL routing), the CTRL decode
// (sm_en / SM_RESTART / CLKDIV_RESTART) and the SMx_INSTR write port.
//
// Coverage (C9 acceptance):
//   1.  Reset defaults; config through reg writes (SPEC-7-14..26).
//   2.  One program per instruction class at divisor 1, cycle-by-cycle:
//       JMP / WAIT / IN / OUT / PUSH / PULL / MOV / IRQ / SET
//       (SPEC-3.1..3.9).
//   3.  ws2812-style side-set stall persistence (CC-5/CC-22): side-set
//       fires once on the first (stalling) tick, never re-fires through
//       the stall or on completion; the divider keeps ticking.
//   4.  Divider: CLKDIV write + CLKDIV_RESTART cadence (CC-26/CC-27,
//       CC-25 min-gap as the inter-tick distance).
//   5.  Forced instructions (SPEC-7-23, SPEC-11-1, CC-35/CC-36),
//       including a forced PULL — the datapath force whose tick strobe
//       is the CC-1/CC-35 `sm_tick || force_tick` OR.
//   6.  SM_RESTART clears exactly the SPEC-7-3 subset.
//   7.  FLEVEL / FDEBUG readbacks incl. TXOVER/RXUNDER (SPEC-6-5..7).
//
// Red/green note (AGENTS.md): section T12's forced-PULL check is the
// regression for the tick-strobe OR — against shift/FIFO fed plain
// sm_tick it fails with the OSR untouched (first failing check: the
// osr==0x12345678 compare after force_run).

`include "tb_common.sv"

module tb_pio_sm;

  logic clk;
  logic rst;
  tb_clk_rst u_cr (.clk(clk));

  localparam logic [2:0] JC_ALWAYS = 3'd0, JC_XDEC = 3'd2, JC_PIN = 3'd6;
  localparam logic [1:0] WSRC_GPIO = 2'd0, WSRC_PIN = 2'd1,
                         WSRC_IRQ  = 2'd2, WSRC_JMPPIN = 2'd3;
  localparam logic [2:0] INS_PINS = 3'd0;
  localparam logic [2:0] OUTD_PINS = 3'd0, OUTD_X = 3'd1, OUTD_PINDIRS = 3'd4;
  localparam logic [2:0] MOVD_X = 3'd1, MOVD_Y = 3'd2, MOVD_PINS = 3'd0,
                         MOVD_PINDIRS = 3'd3;
  localparam logic [2:0] MOVS_X = 3'd1, MOVS_Y = 3'd2, MOVS_PINS = 3'd0;
  localparam logic [1:0] MOP_NONE = 2'd0;
  localparam logic [2:0] SETD_PINS = 3'd0, SETD_X = 3'd1, SETD_Y = 3'd2,
                         SETD_PINDIRS = 3'd4;
  localparam logic [1:0] IDX_THIS = 2'd0, IDX_REL = 2'd2;
  localparam logic [1:0] SM_ID = 2'd2;      // DUT SM_IDX (REL tests)

  localparam logic [3:0] ST_FETCH = 4'b0001, ST_EXEC = 4'b0010,
                         ST_STALL = 4'b0100, ST_DELAY = 4'b1000;

  // ---------------------------------------------------------------------
  // Encoders (SPEC-2-1..18 master table).
  // ---------------------------------------------------------------------
  function automatic logic [15:0] E_JMP(input logic [2:0] cond,
                                        input logic [4:0] addr,
                                        input logic [4:0] dly);
    E_JMP = {3'b000, dly, cond, addr};
  endfunction
  function automatic logic [15:0] E_WAIT(input logic pol,
                                         input logic [1:0] src,
                                         input logic [4:0] idx,
                                         input logic [4:0] dly);
    E_WAIT = {3'b001, dly, pol, src, idx};
  endfunction
  function automatic logic [15:0] E_IN(input logic [2:0] src,
                                       input logic [4:0] bc,
                                       input logic [4:0] dly);
    E_IN = {3'b010, dly, src, bc};
  endfunction
  function automatic logic [15:0] E_OUT(input logic [2:0] dst,
                                        input logic [4:0] bc,
                                        input logic [4:0] dly);
    E_OUT = {3'b011, dly, dst, bc};
  endfunction
  // OUT with a 1-bit side-set value in bit 12 (sideset_count=1, SPEC-4-1).
  function automatic logic [15:0] E_OUT_SIDE(input logic [2:0] dst,
                                             input logic [4:0] bc,
                                             input logic ss);
    E_OUT_SIDE = {3'b011, ss, 4'd0, dst, bc};
  endfunction
  function automatic logic [15:0] E_PUSH(input logic iffull, input logic blk,
                                         input logic [4:0] dly);
    E_PUSH = {3'b100, dly, 1'b0, iffull, blk, 5'd0};
  endfunction
  function automatic logic [15:0] E_PULL(input logic ife, input logic blk,
                                         input logic [4:0] dly);
    E_PULL = {3'b100, dly, 1'b1, ife, blk, 5'd0};
  endfunction
  function automatic logic [15:0] E_MOV(input logic [2:0] dst,
                                        input logic [1:0] op,
                                        input logic [2:0] src,
                                        input logic [4:0] dly);
    E_MOV = {3'b101, dly, dst, op, src};
  endfunction
  function automatic logic [15:0] E_IRQ(input logic clr, input logic waitb,
                                        input logic [1:0] mode,
                                        input logic [2:0] idx,
                                        input logic [4:0] dly);
    E_IRQ = {3'b110, dly, 1'b0, clr, waitb, mode, idx};
  endfunction
  function automatic logic [15:0] E_SET(input logic [2:0] dst,
                                        input logic [4:0] data,
                                        input logic [4:0] dly);
    E_SET = {3'b111, dly, dst, data};
  endfunction
  localparam logic [15:0] E_NOP = 16'b101_00000_010_00_010;  // mov y,y (SPEC-3.6-10)

  // ---------------------------------------------------------------------
  // Environment: imem, input buses, flag register, system FIFO side,
  // CTRL decode, SMx_INSTR port.
  // ---------------------------------------------------------------------
  logic [15:0] imem [0:31];
  logic [15:0] instr;
  logic [4:0]  pc_rb;
  assign instr = imem[pc_rb];               // CC-33 async read at pc

  logic [31:0] gpio_seen;
  logic [31:0] in_bus;
  logic [7:0]  irq_prev, irq_next;

  logic        clkdiv_we, execctrl_we, shiftctrl_we, pinctrl_we;
  logic [31:0] clkdiv_wdata, execctrl_wdata, shiftctrl_wdata, pinctrl_wdata;
  logic        sm_en, sm_restart, clkdiv_restart;
  logic        force_we;
  logic [15:0] force_instr;

  logic        sys_tx_wr, sys_rx_rd, sys_aux_wr, sys_aux_rd;
  logic [31:0] sys_tx_wdata, sys_aux_wdata;
  logic [1:0]  sys_aux_addr;
  logic [3:0]  fdbg_clr;

  // DUT outputs.
  logic        gpio_out_we_w, gpio_out_pindir_w, gpio_set_we_w;
  logic [4:0]  gpio_out_base_w, gpio_set_base_w, gpio_set_data_w;
  logic [5:0]  gpio_out_count_w;
  logic [31:0] gpio_out_data_w;
  logic [2:0]  gpio_set_num_w;
  logic        gpio_ss_we_w, gpio_ss_pindir_w;
  logic [4:0]  gpio_ss_base_w, gpio_ss_data_w;
  logic [2:0]  gpio_ss_num_w;
  logic        out_sticky_w;
  logic        irq_set_req_w, irq_clr_req_w;
  logic [2:0]  irq_flag_idx_w;
  logic [1:0]  irq_idx_mode_w;
  logic [31:0] sys_rx_rdata_w, sys_aux_rdata_w;
  logic        fdbg_tx_stall_w, fdbg_rx_stall_w, fdbg_tx_over_w, fdbg_rx_under_w;
  logic [3:0]  tx_level_w, rx_level_w;
  logic        exec_stalled_w;
  logic        dbg_sm_tick_w, dbg_force_tick_w, dbg_exec_w, dbg_complete_w;
  logic [3:0]  dbg_state_w;
  logic        dbg_is_in_w, dbg_is_out_w, dbg_is_push_w, dbg_out_en_w;
  logic        dbg_tx_pop_w, dbg_rx_push_w, dbg_osr_wr_en_w;
  logic        dbg_autopull_ge_thr_w, dbg_tx_empty_w;
  logic [31:0] dbg_rx_push_data_w, dbg_autopush_data_w, dbg_osr_wr_data_w;
  logic [31:0] dbg_tx_head_data_w, dbg_osr_w, dbg_isr_w;
  logic [5:0]  dbg_osr_cnt_w, dbg_isr_cnt_w;
  logic [2:0]  dbg_fifo_mode_w;
  logic        dbg_fjoin_tx_w, dbg_fjoin_rx_w, dbg_fjoin_rx_put_w, dbg_fjoin_rx_get_w;

  // Mini flag register (C6 stand-in): THIS/REL routing, next-cycle
  // visibility (CC-37), clear-wins (CC-39). External writers model
  // sibling SMs / the bus. Placed after the DUT-output declarations and
  // before the DUT (whose irq_flags port reads flags_r).
  logic        ext_set_req, ext_clr_req;
  logic [2:0]  ext_idx;
  logic [7:0]  flags_r;
  logic [2:0]  req_idx_c;
  logic        req_local_c;
  always_comb begin
    req_idx_c   = (irq_idx_mode_w == IDX_REL)
                ? {irq_flag_idx_w[2], irq_flag_idx_w[1:0] + SM_ID}
                : irq_flag_idx_w;                                // SPEC-3.8-6
    req_local_c = (irq_idx_mode_w == IDX_THIS) || (irq_idx_mode_w == IDX_REL);
  end
  always_ff @(posedge clk) begin
    if (rst) flags_r <= 8'd0;
    else begin
      if (irq_set_req_w && req_local_c) flags_r[req_idx_c] <= 1'b1;
      if (ext_set_req)                  flags_r[ext_idx]   <= 1'b1;
      if ((irq_clr_req_w && req_local_c) || (ext_clr_req && ext_idx == req_idx_c))
        flags_r[req_idx_c] <= 1'b0;   // CC-39 clear wins
      if (ext_clr_req)                  flags_r[ext_idx]   <= 1'b0;
    end
  end

  pio_sm #(.SM_IDX(SM_ID)) u_dut (
      .clk             (clk),
      .rst             (rst),
      .instr           (instr),
      .gpio_seen       (gpio_seen),
      .in_bus          (in_bus),
      .irq_flags       (flags_r),
      .irq_prev_r      (irq_prev),
      .irq_next_r      (irq_next),
      .clkdiv_we       (clkdiv_we),
      .clkdiv_wdata    (clkdiv_wdata),
      .execctrl_we     (execctrl_we),
      .execctrl_wdata  (execctrl_wdata),
      .shiftctrl_we    (shiftctrl_we),
      .shiftctrl_wdata (shiftctrl_wdata),
      .pinctrl_we      (pinctrl_we),
      .pinctrl_wdata   (pinctrl_wdata),
      .sm_en           (sm_en),
      .sm_restart      (sm_restart),
      .clkdiv_restart  (clkdiv_restart),
      .force_we        (force_we),
      .force_instr     (force_instr),
      .gpio_out_we     (gpio_out_we_w),
      .gpio_out_pindir (gpio_out_pindir_w),
      .gpio_out_base   (gpio_out_base_w),
      .gpio_out_count  (gpio_out_count_w),
      .gpio_out_data   (gpio_out_data_w),
      .gpio_set_we     (gpio_set_we_w),
      .gpio_set_pindir (gpio_set_pindir_w),
      .gpio_set_base   (gpio_set_base_w),
      .gpio_set_num    (gpio_set_num_w),
      .gpio_set_data   (gpio_set_data_w),
      .gpio_ss_we      (gpio_ss_we_w),
      .gpio_ss_pindir  (gpio_ss_pindir_w),
      .gpio_ss_base    (gpio_ss_base_w),
      .gpio_ss_num     (gpio_ss_num_w),
      .gpio_ss_data    (gpio_ss_data_w),
      .out_sticky      (out_sticky_w),
      .irq_set_req     (irq_set_req_w),
      .irq_clr_req     (irq_clr_req_w),
      .irq_flag_idx    (irq_flag_idx_w),
      .irq_idx_mode    (irq_idx_mode_w),
      .sys_tx_wr       (sys_tx_wr),
      .sys_tx_wdata    (sys_tx_wdata),
      .sys_rx_rd       (sys_rx_rd),
      .sys_rx_rdata    (sys_rx_rdata_w),
      .sys_aux_wr      (sys_aux_wr),
      .sys_aux_addr    (sys_aux_addr),
      .sys_aux_wdata   (sys_aux_wdata),
      .sys_aux_rd      (sys_aux_rd),
      .sys_aux_rdata   (sys_aux_rdata_w),
      .fdbg_clr        (fdbg_clr),
      .fdbg_tx_stall   (fdbg_tx_stall_w),
      .fdbg_rx_stall   (fdbg_rx_stall_w),
      .fdbg_tx_over    (fdbg_tx_over_w),
      .fdbg_rx_under   (fdbg_rx_under_w),
      .pc              (pc_rb),
      .tx_level        (tx_level_w),
      .rx_level        (rx_level_w),
      .exec_stalled    (exec_stalled_w),
      .dbg_sm_tick     (dbg_sm_tick_w),
      .dbg_force_tick  (dbg_force_tick_w),
      .dbg_state       (dbg_state_w),
      .dbg_exec        (dbg_exec_w),
      .dbg_complete    (dbg_complete_w),
      .dbg_is_in       (dbg_is_in_w),
      .dbg_is_out      (dbg_is_out_w),
      .dbg_is_push     (dbg_is_push_w),
      .dbg_out_en      (dbg_out_en_w),
      .dbg_tx_pop      (dbg_tx_pop_w),
      .dbg_rx_push     (dbg_rx_push_w),
      .dbg_rx_push_data(dbg_rx_push_data_w),
      .dbg_autopush_data(dbg_autopush_data_w),
      .dbg_osr_wr_en   (dbg_osr_wr_en_w),
      .dbg_osr_wr_data (dbg_osr_wr_data_w),
      .dbg_tx_head_data(dbg_tx_head_data_w),
      .dbg_autopull_ge_thr (dbg_autopull_ge_thr_w),
      .dbg_osr         (dbg_osr_w),
      .dbg_isr         (dbg_isr_w),
      .dbg_osr_cnt     (dbg_osr_cnt_w),
      .dbg_isr_cnt     (dbg_isr_cnt_w),
      .dbg_tx_empty    (dbg_tx_empty_w),
      .dbg_fifo_mode   (dbg_fifo_mode_w),
      .dbg_fjoin_tx    (dbg_fjoin_tx_w),
      .dbg_fjoin_rx    (dbg_fjoin_rx_w),
      .dbg_fjoin_rx_put(dbg_fjoin_rx_put_w),
      .dbg_fjoin_rx_get(dbg_fjoin_rx_get_w)
  );

  // ---------------------------------------------------------------------
  // Bundle monitors (single always block; mon_clr resets).
  // ---------------------------------------------------------------------
  logic        mon_clr;
  integer      ss_fires_q;
  logic        out_we_q, out_pindir_q;
  logic [31:0] out_data_q;
  logic [5:0]  out_count_q;
  logic        set_we_q, set_pindir_q;
  logic [2:0]  set_num_q;
  logic [4:0]  set_data_q;
  logic        ss_base_q, ss_num_q;   // one-bit captures (value checks)
  logic        irq_set_q, irq_clr_q;
  logic [2:0]  irq_set_idx_q, irq_clr_idx_q;
  always @(posedge clk) begin
    if (rst || mon_clr) begin
      ss_fires_q    <= 0;
      out_we_q      <= 1'b0; out_pindir_q <= 1'b0; out_data_q <= 32'd0;
      out_count_q   <= 6'd0;
      set_we_q      <= 1'b0; set_pindir_q <= 1'b0;
      set_num_q     <= 3'd0; set_data_q   <= 5'd0;
      ss_base_q     <= 1'b0; ss_num_q     <= 1'b0;
      irq_set_q     <= 1'b0; irq_clr_q    <= 1'b0;
      irq_set_idx_q <= 3'd0; irq_clr_idx_q <= 3'd0;
    end else begin
      if (gpio_ss_we_w) begin
        ss_fires_q <= ss_fires_q + 1;
        ss_base_q  <= gpio_ss_base_w[0];   // base 10 → bit0 = 0
        ss_num_q   <= gpio_ss_num_w[0];
      end
      if (gpio_out_we_w) begin
        out_we_q      <= 1'b1;
        out_pindir_q  <= gpio_out_pindir_w;
        out_data_q    <= gpio_out_data_w;
        out_count_q   <= gpio_out_count_w;
      end
      if (gpio_set_we_w) begin
        set_we_q     <= 1'b1;
        set_pindir_q <= gpio_set_pindir_w;
        set_num_q    <= gpio_set_num_w;
        set_data_q   <= gpio_set_data_w;
      end
      if (irq_set_req_w) begin
        irq_set_q     <= 1'b1;
        irq_set_idx_q <= irq_flag_idx_w;
      end
      if (irq_clr_req_w) begin
        irq_clr_q     <= 1'b1;
        irq_clr_idx_q <= irq_flag_idx_w;
      end
    end
  end

  // clk counter for divider-cadence measurements (CC-25/CC-26).
  integer clk_count = 0;
  always @(posedge clk) clk_count = clk_count + 1;

  // ---------------------------------------------------------------------
  // Helpers.
  // ---------------------------------------------------------------------
  // Advance to the next sm_tick cycle and retire it. sm_tick is
  // combinational and stable through the clk cycle, so sample it at the
  // negedge and retire the upcoming posedge; returning immediately
  // after that edge (not at the following negedge) keeps the next call
  // from skipping an intervening tick — at divisor 1 every clk cycle is
  // a tick cycle (CC-2). At divisor 1 this is one clk per call.
  task automatic tick;
    logic done;
    begin
      done = 1'b0;
      while (!done) begin
        @(negedge clk);
        if (dbg_sm_tick_w === 1'b1) done = 1'b1;
      end
      @(posedge clk);   // retiring edge — effects land here (CC-3)
      #1;               // let the NBAs settle before checks read state
    end
  endtask

  // Helper idiom: block-level housekeeping tasks halt the SM for their
  // duration (SM_ENABLE low drops sm_tick combinationally — SPEC-7-2)
  // and pulse CLKDIV_RESTART (CC-27), so a divisor-1 SM executes no
  // instructions while the TB pokes config or the system FIFO side, and
  // the resume cadence is deterministic (pending killed at the halt
  // edge; the next tick comes the canonical period later). Without the
  // restart, a pending tick frozen high through the halt would retire
  // an instruction at the very first posedge after restore.
  task automatic mon_clear;
    logic saved;
    begin
      @(negedge clk);
      saved = sm_en; sm_en = 1'b0; clkdiv_restart = 1'b1;
      mon_clr = 1'b1;
      @(negedge clk);
      mon_clr = 1'b0; clkdiv_restart = 1'b0; sm_en = saved;
    end
  endtask

  task automatic wr_clkdiv(input logic [31:0] d);
    logic saved;
    begin
      @(negedge clk);
      saved = sm_en; sm_en = 1'b0; clkdiv_restart = 1'b1;
      clkdiv_we = 1'b1; clkdiv_wdata = d;
      @(negedge clk);
      clkdiv_we = 1'b0; clkdiv_restart = 1'b0; sm_en = saved;
    end
  endtask
  task automatic wr_execctrl(input logic [31:0] d);
    logic saved;
    begin
      @(negedge clk);
      saved = sm_en; sm_en = 1'b0; clkdiv_restart = 1'b1;
      execctrl_we = 1'b1; execctrl_wdata = d;
      @(negedge clk);
      execctrl_we = 1'b0; clkdiv_restart = 1'b0; sm_en = saved;
    end
  endtask
  task automatic wr_shiftctrl(input logic [31:0] d);
    logic saved;
    begin
      @(negedge clk);
      saved = sm_en; sm_en = 1'b0; clkdiv_restart = 1'b1;
      shiftctrl_we = 1'b1; shiftctrl_wdata = d;
      @(negedge clk);
      shiftctrl_we = 1'b0; clkdiv_restart = 1'b0; sm_en = saved;
    end
  endtask
  task automatic wr_pinctrl(input logic [31:0] d);
    logic saved;
    begin
      @(negedge clk);
      saved = sm_en; sm_en = 1'b0; clkdiv_restart = 1'b1;
      pinctrl_we = 1'b1; pinctrl_wdata = d;
      @(negedge clk);
      pinctrl_we = 1'b0; clkdiv_restart = 1'b0; sm_en = saved;
    end
  endtask

  task automatic restart_pulse;   // CTRL.SM_RESTART (SPEC-7-3)
    logic saved;
    begin
      @(negedge clk);
      saved = sm_en; sm_en = 1'b0; clkdiv_restart = 1'b1;
      sm_restart = 1'b1;
      @(negedge clk);
      sm_restart = 1'b0; clkdiv_restart = 1'b0; sm_en = saved;
    end
  endtask
  task automatic clkdiv_restart_pulse;   // CC-27
    logic saved;
    begin
      @(negedge clk);
      saved = sm_en; sm_en = 1'b0;
      clkdiv_restart = 1'b1;
      @(negedge clk);
      clkdiv_restart = 1'b0; sm_en = saved;
    end
  endtask

  // Forced instruction (CC-35): SMx_INSTR write, executed the following
  // clk with the divider bypassed; waits out any stall it enters. The
  // SM is halted around the write clk (no imem tick consumed there) and
  // the divider re-anchored; on return exactly one ambient imem tick —
  // the one the force deferred or displaced — has retired, so callers
  // see a deterministic pc (CC-36 keeps the schedule; nothing is lost).
  task automatic force_run(input logic [15:0] w);
    logic saved;
    begin
      @(negedge clk);
      saved = sm_en; sm_en = 1'b0; clkdiv_restart = 1'b1;
      force_we    = 1'b1;
      force_instr = w;
      @(negedge clk);
      force_we    = 1'b0; clkdiv_restart = 1'b0; sm_en = saved;
      while (dbg_force_tick_w === 1'b1) @(negedge clk);
      @(posedge clk);   // the displaced ambient tick retires here
      #1;
    end
  endtask

  task automatic sys_tx_write(input logic [31:0] d);
    logic saved;
    begin
      @(negedge clk);
      saved = sm_en; sm_en = 1'b0; clkdiv_restart = 1'b1;
      sys_tx_wr    = 1'b1;
      sys_tx_wdata = d;
      @(negedge clk);
      sys_tx_wr    = 1'b0; clkdiv_restart = 1'b0; sm_en = saved;
    end
  endtask
  task automatic sys_rx_read;
    logic saved;
    begin
      @(negedge clk);
      saved = sm_en; sm_en = 1'b0; clkdiv_restart = 1'b1;
      sys_rx_rd = 1'b1;
      @(negedge clk);
      sys_rx_rd = 1'b0; clkdiv_restart = 1'b0; sm_en = saved;
    end
  endtask
  task automatic fdbg_w1c(input logic [3:0] m);   // SPEC-6-7
    logic saved;
    begin
      @(negedge clk);
      saved = sm_en; sm_en = 1'b0; clkdiv_restart = 1'b1;
      fdbg_clr = m;
      @(negedge clk);
      fdbg_clr = 4'd0; clkdiv_restart = 1'b0; sm_en = saved;
    end
  endtask

  task automatic ext_flag_set(input logic [2:0] i);
    logic saved;
    begin
      @(negedge clk);
      saved = sm_en; sm_en = 1'b0; clkdiv_restart = 1'b1;
      ext_set_req = 1'b1; ext_idx = i;
      @(negedge clk);
      ext_set_req = 1'b0; clkdiv_restart = 1'b0; sm_en = saved;
    end
  endtask
  task automatic ext_flag_clr(input logic [2:0] i);
    logic saved;
    begin
      @(negedge clk);
      saved = sm_en; sm_en = 1'b0; clkdiv_restart = 1'b1;
      ext_clr_req = 1'b1; ext_idx = i;
      @(negedge clk);
      ext_clr_req = 1'b0; clkdiv_restart = 1'b0; sm_en = saved;
    end
  endtask

  task automatic sec(input string s);
    begin
      $display("--- %0s", s);
    end
  endtask

  integer t0, t1, t2, t3, t4, t5;

  // ---------------------------------------------------------------------
  // Stimulus.
  // ---------------------------------------------------------------------
  initial begin
    sm_restart      = 1'b0;
    clkdiv_restart  = 1'b0;
    force_we        = 1'b0;
    force_instr     = 16'd0;
    mon_clr         = 1'b0;
    ext_set_req     = 1'b0;
    ext_clr_req     = 1'b0;
    ext_idx         = 3'd0;
    gpio_seen       = 32'd0;
    in_bus          = 32'd0;
    irq_prev        = 8'd0;
    irq_next        = 8'd0;
    clkdiv_we       = 1'b0;  clkdiv_wdata    = 32'd0;
    execctrl_we     = 1'b0;  execctrl_wdata  = 32'd0;
    shiftctrl_we    = 1'b0;  shiftctrl_wdata = 32'd0;
    pinctrl_we      = 1'b0;  pinctrl_wdata   = 32'd0;
    sm_en           = 1'b0;   // SPEC-7-2: disabled until SM_ENABLE
    sys_tx_wr       = 1'b0;  sys_tx_wdata  = 32'd0;
    sys_rx_rd       = 1'b0;
    sys_aux_wr      = 1'b0;  sys_aux_wdata = 32'd0;
    sys_aux_rd      = 1'b0;  sys_aux_addr  = 2'd0;
    fdbg_clr        = 4'd0;
    for (int i = 0; i < 32; i++) imem[i] = E_NOP;

    `DO_RESET(4)

    // ------------------------------------------------------------------
    sec("T0: reset defaults (SPEC-7-14..26, SPEC-5-3)");
    `check32(pc_rb, 32'd0)
    `check_eq(dbg_state_w, ST_FETCH)
    `check1(exec_stalled_w, 1'b0)
    `check32(tx_level_w, 32'd0)
    `check32(rx_level_w, 32'd0)
    `check1(fdbg_tx_stall_w, 1'b0)
    `check1(fdbg_rx_stall_w, 1'b0)
    `check1(fdbg_tx_over_w, 1'b0)
    `check1(fdbg_rx_under_w, 1'b0)
    `check32(dbg_osr_cnt_w, 32'd32)   // SPEC-5-3
    `check32(dbg_isr_cnt_w, 32'd0)
    `check32(u_dut.u_exec.x_r, 32'd0)
    `check32(u_dut.u_exec.y_r, 32'd0)
    `check32(u_dut.u_exec.delay_cnt_r, 32'd0)
    `check32(dbg_fifo_mode_w, 32'd0)  // txrx reset default

    sec("T0b: config via reg writes, enable (SPEC-7-25)");
    wr_execctrl(32'h0001_F000);       // WRAP_TOP=31, WRAP_BOTTOM=0
    @(negedge clk);
    sm_en = 1'b1;                     // SPEC-7-2: SM_ENABLE gates ticks

    // ------------------------------------------------------------------
    sec("T1: jmp always / x-- (SPEC-3.1-2..4, SPEC-8-1, SPEC-14.5-1)");
    imem[0] = E_JMP(JC_ALWAYS, 5'd5, 5'd0);
    tick;
    `check32(pc_rb, 32'd5)
    imem[5] = E_JMP(JC_XDEC, 5'd5, 5'd0);   // x==0 → not taken, wraps
    tick;
    `check32(pc_rb, 32'd6)
    `check32(u_dut.u_exec.x_r, 32'hFFFF_FFFF)
    imem[6] = E_JMP(JC_XDEC, 5'd6, 5'd0);   // x!=0 → taken, stays at 6
    tick;
    `check32(pc_rb, 32'd6)
    `check32(u_dut.u_exec.x_r, 32'hFFFF_FFFE)

    // ------------------------------------------------------------------
    sec("T2: wait gpio / wait irq (SPEC-3.2-1..6, CC-15, CC-37)");
    gpio_seen[4] = 1'b0;
    imem[6] = E_WAIT(1'b1, WSRC_GPIO, 5'd4, 5'd0);
    tick;                                    // first tick: stalls
    `check_eq(dbg_state_w, ST_STALL)
    `check32(pc_rb, 32'd6)
    tick;
    tick;                                    // re-evaluated each tick (CC-14)
    `check_eq(dbg_state_w, ST_STALL)
    `check32(pc_rb, 32'd6)
    gpio_seen[4] = 1'b1;
    tick;                                    // first true tick completes
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(pc_rb, 32'd7)
    gpio_seen[4] = 1'b0;
    mon_clear;
    imem[7] = E_WAIT(1'b1, WSRC_IRQ, {IDX_THIS, 3'd2}, 5'd0);
    tick;                                    // flag clear → stall
    `check_eq(dbg_state_w, ST_STALL)
    ext_flag_set(3'd2);                      // visible next cycle (CC-37)
    tick;                                    // completes and clears
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(pc_rb, 32'd8)
    `check1(flags_r[2], 1'b0)
    `check1(irq_clr_q, 1'b1)                 // WAIT 1 IRQ clears (CC-15)
    `check32(irq_clr_idx_q, 32'd2)

    // ------------------------------------------------------------------
    sec("T3: in pins (SPEC-3.3-1/2, CC-9)");
    in_bus = 32'h0000_00AB;
    imem[8] = E_IN(INS_PINS, 5'd8, 5'd0);    // right shift → MSB end
    tick;
    `check32(dbg_isr_w, 32'hAB00_0000)
    `check32(dbg_isr_cnt_w, 32'd8)
    `check32(pc_rb, 32'd9)
    in_bus = 32'd0;

    // ------------------------------------------------------------------
    sec("T4: pull block / noblock (SPEC-3.5-9..13, CC-20, CC-32)");
    imem[9] = E_PULL(1'b0, 1'b1, 5'd0);      // TX empty → stall + TXSTALL
    tick;
    `check_eq(dbg_state_w, ST_STALL)
    `check1(fdbg_tx_stall_w, 1'b1)
    tick;
    `check_eq(dbg_state_w, ST_STALL)
    sys_tx_write(32'hDEAD_BEEF);             // releases from next tick (CC-30)
    tick;
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(dbg_osr_w, 32'hDEAD_BEEF)
    `check32(dbg_osr_cnt_w, 32'd0)
    `check32(tx_level_w, 32'd0)
    `check32(pc_rb, 32'd10)
    fdbg_w1c(4'b1000);
    `check1(fdbg_tx_stall_w, 1'b0)
    imem[10] = E_PULL(1'b0, 1'b0, 5'd0);     // noblock on empty: OSR←X
    tick;                                    // (CC-32, SPEC-14.7-1)
    `check32(dbg_osr_w, 32'hFFFF_FFFE)
    `check32(dbg_osr_cnt_w, 32'd0)
    `check32(pc_rb, 32'd11)

    // ------------------------------------------------------------------
    sec("T5: out pins / out x (SPEC-3.4-1..3, CC-8, CC-17)");
    mon_clear;
    imem[11] = E_OUT(OUTD_PINS, 5'd8, 5'd0); // data 0xFE (LSB end)
    tick;
    `check1(out_we_q, 1'b1)
    `check1(out_pindir_q, 1'b0)
    `check32(out_data_q, 32'hFE)
    `check32(out_count_q, 32'd0)             // 0 = 32 pins (SPEC-7-26)
    `check32(dbg_osr_cnt_w, 32'd8)
    `check32(pc_rb, 32'd12)
    imem[12] = E_OUT(OUTD_X, 5'd8, 5'd0);    // x ← next 0xFF bits
    tick;
    `check32(u_dut.u_exec.x_r, 32'hFF)
    `check32(dbg_osr_cnt_w, 32'd16)
    `check32(pc_rb, 32'd13)

    // ------------------------------------------------------------------
    sec("T6: in + push (SPEC-3.5-4..8, CC-29, SPEC-5-1)");
    in_bus = 32'h0000_00CD;
    imem[13] = E_IN(INS_PINS, 5'd8, 5'd0);   // onto 0xAB000000
    tick;
    `check32(dbg_isr_w, 32'hCDAB_0000)
    `check32(dbg_isr_cnt_w, 32'd16)
    imem[14] = E_PUSH(1'b0, 1'b1, 5'd0);
    tick;
    `check32(rx_level_w, 32'd1)
    `check32(dbg_isr_w, 32'd0)               // ISR cleared (SPEC-5-1)
    `check32(dbg_isr_cnt_w, 32'd0)
    `check32(pc_rb, 32'd15)
    `check32(sys_rx_rdata_w, 32'hCDAB_0000)  // head readback (CC-29)
    sys_rx_read;
    `check32(rx_level_w, 32'd0)

    // ------------------------------------------------------------------
    sec("T7: mov (SPEC-3.6-1..11, CC-8)");
    imem[15] = E_MOV(MOVD_Y, MOP_NONE, MOVS_X, 5'd0);  // y ← 0xFF
    tick;
    `check32(u_dut.u_exec.y_r, 32'hFF)
    `check32(pc_rb, 32'd16)
    in_bus = 32'h5A5A_00FF;
    imem[16] = E_MOV(MOVD_X, MOP_NONE, MOVS_PINS, 5'd0);
    tick;
    `check32(u_dut.u_exec.x_r, 32'h5A5A_00FF)
    `check32(pc_rb, 32'd17)
    in_bus = 32'd0;
    mon_clear;
    imem[17] = E_MOV(MOVD_PINS, MOP_NONE, MOVS_Y, 5'd0);
    tick;
    `check1(out_we_q, 1'b1)
    `check1(out_pindir_q, 1'b0)
    `check32(out_data_q, 32'hFF)
    `check32(pc_rb, 32'd18)
    imem[18] = E_MOV(MOVD_PINDIRS, MOP_NONE, MOVS_Y, 5'd0);
    tick;
    `check1(out_we_q, 1'b1)
    `check1(out_pindir_q, 1'b1)
    `check32(pc_rb, 32'd19)

    // ------------------------------------------------------------------
    sec("T8: irq nowait/wait/clear/rel (SPEC-3.8-1..7, CC-16, CC-37)");
    mon_clear;
    imem[19] = E_IRQ(1'b0, 1'b0, IDX_THIS, 3'd4, 5'd0);
    tick;                                    // nowait: sets, never stalls
    `check_eq(dbg_state_w, ST_FETCH)
    `check1(flags_r[4], 1'b1)
    `check1(irq_set_q, 1'b1)
    `check32(irq_set_idx_q, 32'd4)
    imem[20] = E_IRQ(1'b0, 1'b1, IDX_THIS, 3'd5, 5'd0);
    tick;                                    // wait: sets + stalls (CC-16)
    `check_eq(dbg_state_w, ST_STALL)
    `check1(flags_r[5], 1'b1)
    `check32(pc_rb, 32'd20)
    tick;                                    // flag reads 1 → still stalled
    `check_eq(dbg_state_w, ST_STALL)
    ext_flag_clr(3'd5);
    tick;                                    // reads 0 → completes
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(pc_rb, 32'd21)
    imem[21] = E_IRQ(1'b1, 1'b0, IDX_THIS, 3'd4, 5'd0);
    tick;
    `check1(flags_r[4], 1'b0)
    `check32(pc_rb, 32'd22)
    imem[22] = E_IRQ(1'b0, 1'b0, IDX_REL, 3'd1, 5'd0);  // 1+SM_ID(2)=3
    tick;
    `check1(flags_r[3], 1'b1)                // SPEC-3.8-6
    `check1(flags_r[1], 1'b0)
    `check32(pc_rb, 32'd23)

    // ------------------------------------------------------------------
    sec("T9: set (SPEC-3.9-1..3, CC-8)");
    imem[23] = E_SET(SETD_X, 5'd10, 5'd0);
    tick;
    `check32(u_dut.u_exec.x_r, 32'd10)
    `check32(pc_rb, 32'd24)
    mon_clear;
    imem[24] = E_SET(SETD_PINS, 5'b00101, 5'd0);   // 5 pins at base 0
    tick;
    `check1(set_we_q, 1'b1)
    `check1(set_pindir_q, 1'b0)
    `check32(set_num_q, 32'd5)               // default SET_COUNT (SPEC-7-26)
    `check32(set_data_q, 32'd5)
    `check32(pc_rb, 32'd25)
    imem[25] = E_SET(SETD_PINDIRS, 5'd1, 5'd0);
    tick;
    `check1(set_we_q, 1'b1)
    `check1(set_pindir_q, 1'b1)
    `check32(pc_rb, 32'd26)

    // ------------------------------------------------------------------
    sec("T10: ws2812 side-set stall persistence (CC-5, CC-11, CC-22)");
    wr_shiftctrl(32'h100E_0000);   // autopull, PULL_THRESH 8, right/right
    wr_pinctrl(32'h3400_2800);     // SIDESET_COUNT 1, SIDESET_BASE 10
    mon_clear;
    imem[26] = E_OUT_SIDE(OUTD_X, 5'd8, 1'b1);  // out x,8 side 1
    tick;                                    // ge-thr + TX empty: stall
    `check_eq(dbg_state_w, ST_STALL)
    `check32(ss_fires_q, 32'd1)              // fired on the stalled first tick
    `check1(fdbg_tx_stall_w, 1'b1)           // CC-11
    `check32(u_dut.u_exec.x_r, 32'd10)       // no shift on the stall tick
    `check32(pc_rb, 32'd26)
    tick;                                    // still stalled, no re-fire
    `check_eq(dbg_state_w, ST_STALL)
    `check32(ss_fires_q, 32'd1)              // CC-5
    `check32(u_dut.u_exec.x_r, 32'd10)
    sys_tx_write(32'h0000_00AB);
    tick;                                    // refill + one-tick stall fence
    `check_eq(dbg_state_w, ST_STALL)         // CC-11/CC-12
    `check32(dbg_osr_w, 32'hAB)
    `check32(dbg_osr_cnt_w, 32'd0)
    `check32(tx_level_w, 32'd0)
    `check32(ss_fires_q, 32'd1)
    tick;                                    // re-executes: completes
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(u_dut.u_exec.x_r, 32'hAB)
    `check32(dbg_osr_cnt_w, 32'd8)
    `check32(ss_fires_q, 32'd1)              // no re-fire on completion (CC-5)
    `check32(pc_rb, 32'd27)
    fdbg_w1c(4'b1000);
    `check1(fdbg_tx_stall_w, 1'b0)
    wr_shiftctrl(32'h000C_0000);   // autopull off, defaults
    wr_pinctrl(32'h1400_0000);     // PINCTRL defaults

    // ------------------------------------------------------------------
    sec("T11: divider cadence (CC-26, CC-27, CC-25)");
    wr_clkdiv(32'h0002_0000);      // INT=2
    clkdiv_restart_pulse;          // canonical period from count 0 (CC-27)
    tick;                          // first tick after the restart
    t1 = clk_count;
    tick;
    t2 = clk_count;
    `check32(t2 - t1, 32'd2)                 // inter-tick gap = INT (CC-25)
    tick;
    t3 = clk_count;
    `check32(t3 - t2, 32'd2)
    wr_clkdiv(32'h0001_0000);      // back to divisor 1
    tick;                                    // first tick at the new rate
    t4 = clk_count;
    tick;
    t5 = clk_count;
    `check32(t5 - t4, 32'd1)                 // divisor 1: every clk (CC-2)

    // ------------------------------------------------------------------
    sec("T12: forced instructions (SPEC-7-23, SPEC-11-1, CC-35, CC-36)");
    imem[27] = E_NOP;
    imem[28] = E_NOP;
    force_run(E_JMP(JC_ALWAYS, 5'd27, 5'd0));  // park: T11 walked the pc
    `check32(pc_rb, 32'd28)                    // through stale T1/T2 words
    force_run(E_SET(SETD_X, 5'd9, 5'd0));    // next clk, divider bypassed
    `check32(u_dut.u_exec.x_r, 32'd9)
    `check32(pc_rb, 32'd29)                  // ambient nop retired; the
                                             // forced SET did not advance PC
    force_run(E_JMP(JC_ALWAYS, 5'd29, 5'd0));
    `check32(pc_rb, 32'd30)                  // forced JMP moved PC (29),
                                             // ambient nop advanced to 30
    // Forced PULL: the datapath force — RED/GREEN regression for the
    // CC-1/CC-35 tick-strobe OR (against a plain-sm_tick strobe the OSR
    // stays untouched and this check fails first).
    sys_tx_write(32'h1234_5678);
    force_run(E_PULL(1'b0, 1'b1, 5'd0));
    `check32(dbg_osr_w, 32'h1234_5678)       // CC-35 + CC-1
    `check32(dbg_osr_cnt_w, 32'd0)
    `check32(tx_level_w, 32'd0)
    `check32(pc_rb, 32'd31)
    // Stalled forced WAIT: latched, re-executed, EXEC_STALLED (CC-35);
    // halted section — the force path bypasses the (halted) divider.
    @(negedge clk);
    sm_en = 1'b0;
    @(negedge clk);
    force_we = 1'b1; force_instr = E_WAIT(1'b1, WSRC_GPIO, 5'd4, 5'd0);
    @(negedge clk);
    force_we = 1'b0;
    @(negedge clk);                          // first force-tick: stalls
    `check1(exec_stalled_w, 1'b1)            // SPEC-7-15
    `check32(pc_rb, 32'd31)
    @(negedge clk);                          // re-executed every clk
    `check1(exec_stalled_w, 1'b1)
    gpio_seen[4] = 1'b1;
    @(negedge clk);                          // condition true -> completes
    `check1(exec_stalled_w, 1'b0)
    `check32(pc_rb, 32'd31)
    gpio_seen[4] = 1'b0;
    // Replacement of a stalled forced instruction (SPEC-7-23).
    @(negedge clk);
    force_we = 1'b1; force_instr = E_WAIT(1'b1, WSRC_GPIO, 5'd5, 5'd0);
    @(negedge clk);
    force_we = 1'b0;
    @(negedge clk);                          // stalls on gpio 5
    `check1(exec_stalled_w, 1'b1)
    @(negedge clk);
    force_we = 1'b1; force_instr = E_SET(SETD_X, 5'd14, 5'd0);
    @(negedge clk);
    force_we = 1'b0;
    @(negedge clk);                          // replacement completes
    `check1(exec_stalled_w, 1'b0)
    `check32(u_dut.u_exec.x_r, 32'd14)
    @(negedge clk);                          // resume: restart while still
    clkdiv_restart = 1'b1;                   // halted (kills the frozen
    @(negedge clk);                          // pending), then enable
    clkdiv_restart = 1'b0;
    sm_en = 1'b1;

    // ------------------------------------------------------------------
    sec("T13: SM_RESTART clears the SPEC-7-3 subset");
    in_bus = 32'h0000_0077;
    imem[31] = E_IN(INS_PINS, 5'd8, 5'd0);
    tick;                                    // pc 31 wraps to 0 (SPEC-8-2)
    `check32(dbg_isr_w, 32'h7700_0000)
    `check32(dbg_isr_cnt_w, 32'd8)
    `check32(pc_rb, 32'd0)
    imem[0] = E_SET(SETD_X, 5'd5, 5'd3);     // delay 3
    tick;
    `check32(u_dut.u_exec.delay_cnt_r, 32'd3)
    `check_eq(dbg_state_w, ST_DELAY)
    `check32(u_dut.u_exec.x_r, 32'd5)
    `check32(pc_rb, 32'd1)
    restart_pulse;
    `check32(u_dut.u_exec.delay_cnt_r, 32'd0)   // SPEC-7-3: delay cleared
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(pc_rb, 32'd1)                   // PC preserved (sdk N2)
    `check32(u_dut.u_exec.x_r, 32'd5)        // X preserved
    `check32(dbg_isr_w, 32'h7700_0000)       // clear not yet applied
    `check32(dbg_osr_w, 32'h1234_5678)       // OSR preserved
    tick;                                    // consumed by the clear
    `check32(dbg_isr_w, 32'd0)               // SPEC-7-3: ISR cleared
    `check32(dbg_isr_cnt_w, 32'd0)           // SPEC-5-3: counters 0/32
    `check32(dbg_osr_cnt_w, 32'd32)
    `check32(dbg_osr_w, 32'h1234_5678)
    `check32(pc_rb, 32'd1)
    imem[1] = E_SET(SETD_Y, 5'd7, 5'd0);     // marker: runs on the next tick
    tick;
    `check32(u_dut.u_exec.y_r, 32'd7)
    `check32(pc_rb, 32'd2)

    // ------------------------------------------------------------------
    sec("T14: FLEVEL / FDEBUG integration (SPEC-6-5..7)");
    sys_tx_write(32'h0000_000A);
    sys_tx_write(32'h0000_000B);
    `check32(tx_level_w, 32'd2)              // FLEVEL TX nibble
    imem[2] = E_PUSH(1'b0, 1'b1, 5'd0);      // pushes the cleared ISR
    tick;
    `check32(rx_level_w, 32'd1)
    `check32(sys_rx_rdata_w, 32'd0)
    sys_rx_read;                             // pops
    sys_rx_read;                             // on empty: RXUNDER (SPEC-6-5)
    `check1(fdbg_rx_under_w, 1'b1)
    fdbg_w1c(4'b0001);
    `check1(fdbg_rx_under_w, 1'b0)
    sys_tx_write(32'h0000_000C);
    sys_tx_write(32'h0000_000D);
    `check32(tx_level_w, 32'd4)
    sys_tx_write(32'h0000_000E);             // on full: dropped + TXOVER
    `check32(tx_level_w, 32'd4)
    `check1(fdbg_tx_over_w, 1'b1)
    fdbg_w1c(4'b0010);
    `check1(fdbg_tx_over_w, 1'b0)

    `TB_FINISH
  end

endmodule

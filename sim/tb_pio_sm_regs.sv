// tb_pio_sm_regs.sv — directed TB for rtl/pio_sm_regs.sv (KANBAN C5).
//
// Coverage (per the C5 acceptance):
//   1. Reset defaults: CLKDIV=0x00010000, EXECCTRL=0x00001fff,
//      SHIFTCTRL=0x000c0000 (both shift dirs right), PINCTRL=0x14000000
//      (SET_COUNT=5) — datasheet defaults, SPEC-7-14..26.
//   2. Field decode: every decoded output matches the written register
//      word (SPEC-7-14..26 bit positions).
//   3. Divisor 1: sm_tick every clk (CC-26).
//   4. INT/FRAC delta-sigma: periods alternate INT and INT+1 — gaps,
//      average period = INT + FRAC/256 (SPEC-7-14), min gap = INT
//      (CC-25).
//   5. INT=0 ⇒ 65536: first tick exactly 65536 clks after the enable
//      cycle (SPEC-7-14, CC-26); FRAC forced 0.
//   6. clkdiv_restart: phase/count clear the next cycle, next tick the
//      canonical period later (CC-27).
//   7. Disabled SM: no ticks, divider frozen; resumes on enable
//      (SPEC-7-2).
//   8. force_tick deferral: a coinciding tick is masked for that clk
//      and fires the next clk; the divider schedule is untouched, so
//      the gap before the deferred tick is INT+1 and the gap after it
//      is INT-1 (CC-36 phase continuity).
//
// Timing: inputs driven at negedge (settled before each posedge);
// sm_tick monitored at posedge (value during the ending clk cycle);
// gaps counted in posedges between sm_tick observations.

`include "tb_common.sv"

module tb_pio_sm_regs;

  logic clk;
  logic rst;
  tb_clk_rst u_cr (.clk(clk));

  logic        clkdiv_we, execctrl_we, shiftctrl_we, pinctrl_we;
  logic [31:0] clkdiv_wdata, execctrl_wdata, shiftctrl_wdata, pinctrl_wdata;
  logic        sm_en, clkdiv_restart, force_tick;
  logic        sm_tick, tick_pending;
  logic [16:0] sm_tick_period;
  logic [7:0]  dbg_phase;
  logic [16:0] dbg_count;
  logic [15:0] clkdiv_int;
  logic [7:0]  clkdiv_frac;
  logic        side_en, side_pindir, inline_out_en, out_sticky;
  logic [4:0]  jmp_pin, out_en_sel, wrap_top, wrap_bottom, status_n;
  logic [1:0]  status_sel;
  logic        fjoin_rx, fjoin_tx, out_shift_left, in_shift_left;
  logic        autopull, autopush, fjoin_rx_put, fjoin_rx_get;
  logic [4:0]  pull_thresh, push_thresh, in_mask_count;
  logic [2:0]  sideset_count, set_count;
  logic [5:0]  out_count;
  logic [4:0]  in_base, sideset_base, set_base, out_base;

  pio_sm_regs u_dut (
      .clk (clk), .rst (rst),
      .clkdiv_we (clkdiv_we), .clkdiv_wdata (clkdiv_wdata),
      .execctrl_we (execctrl_we), .execctrl_wdata (execctrl_wdata),
      .shiftctrl_we (shiftctrl_we), .shiftctrl_wdata (shiftctrl_wdata),
      .pinctrl_we (pinctrl_we), .pinctrl_wdata (pinctrl_wdata),
      .sm_en (sm_en), .clkdiv_restart (clkdiv_restart),
      .force_tick (force_tick),
      .sm_tick (sm_tick), .tick_pending (tick_pending),
      .sm_tick_period (sm_tick_period),
      .dbg_phase (dbg_phase), .dbg_count (dbg_count),
      .clkdiv_int (clkdiv_int), .clkdiv_frac (clkdiv_frac),
      .side_en (side_en), .side_pindir (side_pindir),
      .jmp_pin (jmp_pin), .out_en_sel (out_en_sel),
      .inline_out_en (inline_out_en), .out_sticky (out_sticky),
      .wrap_top (wrap_top), .wrap_bottom (wrap_bottom),
      .status_sel (status_sel), .status_n (status_n),
      .fjoin_rx (fjoin_rx), .fjoin_tx (fjoin_tx),
      .pull_thresh (pull_thresh), .push_thresh (push_thresh),
      .out_shift_left (out_shift_left), .in_shift_left (in_shift_left),
      .autopull (autopull), .autopush (autopush),
      .fjoin_rx_put (fjoin_rx_put), .fjoin_rx_get (fjoin_rx_get),
      .in_mask_count (in_mask_count),
      .sideset_count (sideset_count), .set_count (set_count),
      .out_count (out_count),
      .in_base (in_base), .sideset_base (sideset_base),
      .set_base (set_base), .out_base (out_base)
  );

  // ---------------------------------------------------------------------------
  // Tick / gap monitor. cycle_c counts posedges; on sm_tick the gap since
  // the previous tick and the latched period are recorded.
  // ---------------------------------------------------------------------------
  integer cycle_c = 0;
  integer n_ticks = 0;
  integer last_tick = -1;
  integer gap_min = 999999;
  integer gap_max = 0;
  integer period_min = 999999;
  integer period_max = 0;
  integer sum_periods = 0;
  integer period_at_tick = 0;
  always @(posedge clk) begin
    cycle_c <= cycle_c + 1;
    if (sm_tick) begin
      n_ticks <= n_ticks + 1;
      period_at_tick <= sm_tick_period;
      if (last_tick >= 0) begin
        if (cycle_c - last_tick < gap_min) gap_min <= cycle_c - last_tick;
        if (cycle_c - last_tick > gap_max) gap_max <= cycle_c - last_tick;
      end
      if (sm_tick_period < period_min) period_min <= sm_tick_period;
      if (sm_tick_period > period_max) period_max <= sm_tick_period;
      last_tick <= cycle_c;
      sum_periods <= sum_periods + sm_tick_period;
    end
  end

  task clear_stats;
    begin
      n_ticks = 0; last_tick = -1; gap_min = 999999; gap_max = 0;
      period_min = 999999; period_max = 0; sum_periods = 0;
    end
  endtask

  task drive_idle;  // all inputs inert
    begin
      clkdiv_we = 0; execctrl_we = 0; shiftctrl_we = 0; pinctrl_we = 0;
      clkdiv_wdata = '0; execctrl_wdata = '0;
      shiftctrl_wdata = '0; pinctrl_wdata = '0;
      sm_en = 0; clkdiv_restart = 0; force_tick = 0;
    end
  endtask

  task wr_clkdiv(input logic [15:0] i, input logic [7:0] f);
    begin
      @(negedge clk);
      clkdiv_wdata = {i, f, 8'h00};
      clkdiv_we = 1;
      @(negedge clk);
      clkdiv_we = 0;
    end
  endtask

  // Enable the SM at a negedge and run <n> posedges. run_base = the
  // monitor's cycle_c index read at the first enabled posedge, so a
  // tick in that posedge's cycle j (0-based, counting from the enable
  // cycle) records last_tick - run_base == j.
  integer run_base = 0;
  integer n4 = 0;
  task run_enabled(input integer n);
    begin
      @(negedge clk);
      run_base = cycle_c;
      sm_en = 1;
      repeat (n) @(posedge clk);
    end
  endtask

  task disable_sm;
    begin
      @(negedge clk);
      sm_en = 0;
    end
  endtask

  initial begin
    drive_idle;

    // -----------------------------------------------------------------
    // 1. Reset defaults (SPEC-7-14..26).
    // -----------------------------------------------------------------
    `DO_RESET(4)
    `check32(clkdiv_int, 16'd1)
    `check32(clkdiv_frac, 8'd0)
    `check1(side_en, 1'b0)
    `check1(side_pindir, 1'b0)
    `check32(jmp_pin, 5'd0)
    `check32(out_en_sel, 5'd0)
    `check1(inline_out_en, 1'b0)
    `check1(out_sticky, 1'b0)
    `check32(wrap_top, 5'd1)        // EXECCTRL reset 0x1fff
    `check32(wrap_bottom, 5'd31)    // EXECCTRL reset 0x1fff
    `check32(status_sel, 2'd3)      // EXECCTRL reset 0x1fff (word-level
                                    // datasheet reset; STATUS_SEL=3)
    `check32(status_n, 5'd31)       // EXECCTRL reset 0x1fff
    `check1(fjoin_rx, 1'b0)
    `check1(fjoin_tx, 1'b0)
    `check32(pull_thresh, 5'd0)
    `check32(push_thresh, 5'd0)
    `check1(out_shift_left, 1'b0)   // SHIFTCTRL reset 0xc0000: right
    `check1(in_shift_left, 1'b0)
    `check1(autopull, 1'b0)
    `check1(autopush, 1'b0)
    `check1(fjoin_rx_put, 1'b0)
    `check1(fjoin_rx_get, 1'b0)
    `check32(in_mask_count, 5'd0)
    `check32(sideset_count, 3'd0)
    `check32(set_count, 3'd5)       // PINCTRL reset 0x14000000
    `check32(out_count, 6'd0)
    `check32(in_base, 5'd0)
    `check32(sideset_base, 5'd0)
    `check32(set_base, 5'd0)
    `check32(out_base, 5'd0)
    `check1(sm_tick, 1'b0)          // disabled after reset (SPEC-7-2)
    `check32(dbg_phase, 8'd0)
    `check32(dbg_count, 17'd0)

    // -----------------------------------------------------------------
    // 2. Field decode of written words (SPEC-7-14..26 bit positions).
    // -----------------------------------------------------------------
    @(negedge clk);
    clkdiv_wdata = 32'h0002_8000;    clkdiv_we = 1;   // INT=2 FRAC=128
    // side_en=1, side_pindir=1, jmp_pin=0x0f, out_en_sel=0x0a,
    // inline_out_en=1, out_sticky=1, wrap_top=0x0c, wrap_bottom=0x05,
    // status_sel=2, status_n=0x1b
    execctrl_wdata = 32'h6f56_c2db;  execctrl_we = 1;
    // fjoin_rx=1, fjoin_tx=1, pull_thresh=0x0f, push_thresh=0x0e,
    // out_shiftdir=1 (right), in_shiftdir=0 (left), autopull=1,
    // autopush=0, fjoin_rx_put=1, fjoin_rx_get=0, in_count=5
    shiftctrl_wdata = 32'hdeea_8005; shiftctrl_we = 1;
    // sideset_count=2, set_count=4, out_count=6, in_base=0x0f,
    // sideset_base=0x0a, set_base=0x15, out_base=0x1d
    pinctrl_wdata = 32'h5067_aabd;   pinctrl_we = 1;
    @(negedge clk);
    clkdiv_we = 0; execctrl_we = 0; shiftctrl_we = 0; pinctrl_we = 0;

    `check32(clkdiv_int, 16'd2)
    `check32(clkdiv_frac, 8'h80)
    `check1(side_en, 1'b1)          // bit 30
    `check1(side_pindir, 1'b1)      // bit 29
    `check32(jmp_pin, 5'h0f)        // 28:24
    `check32(out_en_sel, 5'h0a)     // 23:19
    `check1(inline_out_en, 1'b1)    // 18
    `check1(out_sticky, 1'b1)       // 17
    `check32(wrap_top, 5'h0c)       // 16:12
    `check32(wrap_bottom, 5'h05)    // 11:7
    `check32(status_sel, 2'd2)      // 6:5
    `check32(status_n, 5'h1b)       // 4:0
    `check1(fjoin_rx, 1'b1)         // 31
    `check1(fjoin_tx, 1'b1)         // 30
    `check32(pull_thresh, 5'h0f)    // 29:25
    `check32(push_thresh, 5'h0e)    // 24:20
    `check1(out_shift_left, 1'b0)   // bit19 = 1 → right
    `check1(in_shift_left, 1'b1)    // bit18 = 0 → left
    `check1(autopull, 1'b1)         // 17
    `check1(autopush, 1'b0)         // 16
    `check1(fjoin_rx_put, 1'b1)     // 15
    `check1(fjoin_rx_get, 1'b0)     // 14
    `check32(in_mask_count, 5'h05)  // 4:0
    `check32(sideset_count, 3'd2)   // 31:29
    `check32(set_count, 3'd4)       // 28:26
    `check32(out_count, 6'd6)       // 25:20
    `check32(in_base, 5'h0f)        // 19:15
    `check32(sideset_base, 5'h0a)   // 14:10
    `check32(set_base, 5'h15)       // 9:5
    `check32(out_base, 5'h1d)       // 4:0

    // -----------------------------------------------------------------
    // 3. Divisor 1 (default after reset): tick every clk (CC-26).
    //    Enable cycle e = run_base; first tick at e+1, then every clk.
    // -----------------------------------------------------------------
    `DO_RESET(4)
    clear_stats;
    run_enabled(12);
    disable_sm;
    if (n_ticks != 11) begin
      tb_fail_count = tb_fail_count + 1;
      $display("FAIL div1: %0d ticks in 12 clks, expected 11", n_ticks);
    end else begin
      tb_pass_count = tb_pass_count + 1;
      $display("PASS div1: %0d ticks, min gap %0d max gap %0d",
               n_ticks, gap_min, gap_max);
    end
    `check32(gap_min, 1)  // CC-26 divisor 1
    `check32(gap_max, 1)

    // -----------------------------------------------------------------
    // 4. INT=3 FRAC=128: periods alternate 3,4 (avg 3.5), min gap 3
    //    (SPEC-7-14, CC-25).
    // -----------------------------------------------------------------
    `DO_RESET(4)
    wr_clkdiv(16'd3, 8'd128);
    clear_stats;
    run_enabled(100);
    disable_sm;
    if (n_ticks < 20) begin
      tb_fail_count = tb_fail_count + 1;
      $display("FAIL int3frac128: only %0d ticks in 100 clks", n_ticks);
    end
    `check32(gap_min, 3)     // CC-25 min gap = INT
    `check32(gap_max, 4)     // CC-25 periods are INT or INT+1
    `check32(period_min, 3)  // latched period matches the gap
    `check32(period_max, 4)
    // Average period = INT + FRAC/256 = 3.5: delta-sigma periods are
    // 3,3,4,3,4,... (phase accumulates from 0, so the first carry lands
    // on the second terminal) — #4s ∈ {#3s, #3s−2}.
    n4 = sum_periods - 3 * n_ticks;
    if (n4 < n_ticks - n4 - 2 || n4 > n_ticks - n4) begin
      tb_fail_count = tb_fail_count + 1;
      $display("FAIL int3frac128 avg: %0d short / %0d long periods",
               n_ticks - n4, n4);
    end else begin
      tb_pass_count = tb_pass_count + 1;
      $display("PASS int3frac128 avg: %0d short / %0d long periods",
               n_ticks - n4, n4);
    end

    // -----------------------------------------------------------------
    // 5. INT=2 FRAC=0: gaps all 2.
    // -----------------------------------------------------------------
    `DO_RESET(4)
    wr_clkdiv(16'd2, 8'd0);
    clear_stats;
    run_enabled(40);
    disable_sm;
    `check32(gap_min, 2)
    `check32(gap_max, 2)

    // -----------------------------------------------------------------
    // 6. INT=0 ⇒ 65536, FRAC ignored (SPEC-7-14): exactly one tick in a
    //    65538-clk run, at e+65536, with the full period latched.
    // -----------------------------------------------------------------
    `DO_RESET(4)
    wr_clkdiv(16'd0, 8'd255);  // FRAC must be 0 when INT=0; forced
    clear_stats;
    run_enabled(65538);
    disable_sm;
    if (n_ticks != 1) begin
      tb_fail_count = tb_fail_count + 1;
      $display("FAIL int0: %0d ticks in 65538 clks, expected 1", n_ticks);
    end else begin
      tb_pass_count = tb_pass_count + 1;
      $display("PASS int0: tick at %0d clks after enable cycle",
               last_tick - run_base);
    end
    `check32(last_tick - run_base, 65536)  // CC-26 tick = terminal + 1
    `check32(period_at_tick, 65536)

    // -----------------------------------------------------------------
    // 7. clkdiv_restart (CC-27): phase/count clear the cycle after the
    //    restart retires; the next tick comes INT clks after the
    //    restart cycle.
    // -----------------------------------------------------------------
    `DO_RESET(4)
    wr_clkdiv(16'd5, 8'd128);
    clear_stats;
    run_enabled(8);              // tick at e+5; then 3 clks into period 2
    disable_sm;
    `WAIT_CLKS(2)
    `check32(dbg_phase, 8'd128)  // mid-period, fractional residual
    `check32(dbg_count, 17'd3)
    // Restart (works while disabled too — CC-27 is a divider reset).
    @(negedge clk); clkdiv_restart = 1;
    @(negedge clk); clkdiv_restart = 0;
    `check32(dbg_phase, 8'd0)    // CC-27: cleared the cycle after
    `check32(dbg_count, 17'd0)
    `check1(tick_pending, 1'b0)
    // Restart cycle r (the posedge that retired it): count starts 0 the
    // cycle after r, so the next tick is at r+5 = 5 enabled clks later.
    clear_stats;
    run_enabled(6);              // tick on the 6th clk after the restart
    disable_sm;
    `check32(n_ticks, 1)
    `check32(period_at_tick, 5)  // canonical period after restart (CC-27)

    // -----------------------------------------------------------------
    // 8. Disable: no ticks, divider frozen; resume completes the
    //    interrupted period (SPEC-7-2 SM_ENABLE gating).
    // -----------------------------------------------------------------
    `DO_RESET(4)
    wr_clkdiv(16'd4, 8'd0);
    clear_stats;
    run_enabled(2);              // 2 clks into the first period
    disable_sm;
    `WAIT_CLKS(10)
    `check1(sm_tick, 1'b0)       // disabled SM produces no ticks
    `check32(dbg_count, 17'd2)   // frozen mid-period
    `check32(dbg_phase, 8'd0)
    clear_stats;
    run_enabled(3);              // 2 more clks to terminal, tick on the 3rd
    disable_sm;
    `check32(n_ticks, 1)         // period completed after re-enable
    `check32(period_at_tick, 4)

    // -----------------------------------------------------------------
    // 9. Force-tick deferral (CC-36): force_tick during a pending tick
    //    masks it for that clk; it fires the next clk. The divider
    //    schedule is untouched (phase continuity), so the gap before
    //    the deferred tick is INT+1 and the gap after it is INT-1.
    // -----------------------------------------------------------------
    `DO_RESET(4)
    wr_clkdiv(16'd3, 8'd0);
    clear_stats;
    @(negedge clk); sm_en = 1;
    // Enable negedge then posedges P1..: terminal at P3, tick cycle =
    // the clk after P3. Arm force inside that cycle.
    @(posedge clk);              // P1
    @(posedge clk);              // P2
    @(posedge clk);              // P3 (terminal retires: pending set)
    @(negedge clk); force_tick = 1;
    @(posedge clk);              // P4: would-be tick cycle
    if (sm_tick !== 1'b0) begin
      tb_fail_count = tb_fail_count + 1;
      $display("FAIL defer: sm_tick high during force_tick (CC-36)");
    end else begin
      tb_pass_count = tb_pass_count + 1;
      $display("PASS defer: sm_tick masked during force_tick (CC-36)");
    end
    @(negedge clk); force_tick = 0;
    @(posedge clk);              // P5: deferred tick fires
    @(posedge clk); @(posedge clk); @(posedge clk); @(posedge clk);
    @(posedge clk);
    // P6 (terminal), P7 (tick), P8, P9 (terminal), P10 (tick)
    @(negedge clk); sm_en = 0;
    `check32(n_ticks, 3)         // deferred + two scheduled ticks
    `check32(gap_min, 2)         // INT-1 after the deferred tick (CC-36)
    `check32(gap_max, 3)         // back on the free-running cadence
    // Phase continuity: the divider kept the INT=3 schedule throughout
    // (the last tick is exactly on the free-running cadence).
    `check32(period_at_tick, 3)

    `TB_FINISH
  end

endmodule

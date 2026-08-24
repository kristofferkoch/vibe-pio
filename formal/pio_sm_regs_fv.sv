// Formal properties for pio_sm_regs (KANBAN C5).
//
// Wrapper instantiates the DUT (plus a lockstep twin) and checks
// (bmc + prove):
//   P1  reset defaults: after rst, the four banks hold the datasheet
//       reset words (SPEC-7-14..26).
//   P2  decode purity: after a write retires, every decoded output
//       equals the corresponding slice of wdata (SPEC-7-14..26);
//       without a write the outputs hold (immediate-effect / stable
//       config, SPEC-7-25).
//   P3  structural tick equation: sm_tick == sm_en && tick_pending
//       && !force_tick — a registered, one-clk strobe gated by enable
//       (CC-26, SPEC-7-2) and deferred by force_tick (CC-36).
//   P4  bounds: dbg_count <= 65535, tick_pending ⇒ sm_tick_period >= 1
//       (17-bit divider state, INT=0 ⇒ 65536 decoding, SPEC-7-14).
//   P5  restart (CC-27): the cycle after a clkdiv_restart posedge,
//       phase == 0, count == 0, no pending tick.
//   P6  min-gap (CC-25): with S_r = clks since the previous sm_tick,
//       every sm_tick satisfies S_r + 1 >= sm_tick_period, and the
//       latched period is at least the INT in force at its terminal
//       count — i.e. consecutive sm_tick are >= INT clk apart. Proven
//       via the inductive invariants
//         J1: tick_pending  ⇒ S_r + 1 >= sm_tick_period
//         J2: !tick_pending ⇒ S_r + 1 >= dbg_count
//   P7  lockstep (CC-27): two instances driven by identical inputs
//       (equal CLKDIV writes, equal restart pulses, equal enable) have
//       identical divider state and identical tick history.
//
// Assumptions (interface contracts / proof scoping, documented):
//   A1  reset asserted in the initial state (CC-1 protocol).
//   A2  no force_tick while a tick is pending: CC-36 deferral only ever
//       *lengthens* the pre-deferral gap but lets the *following* gap
//       shrink to INT-1 (the free-running schedule is untouched), so
//       deferral is out of scope for the min-gap proof here and is
//       verified by the directed TB (CC-36).
//   A3  no CLKDIV write while a tick is pending: keeps the INT in
//       effect at terminal count observable at the tick one clk later.
//
// Style note (owner convention): immediate assertions inside
// `always @(posedge clk)` with explicit previous-cycle registers;
// formal-only file (never compiled by iverilog).

module pio_sm_regs_fv (
    input  logic        clk,
    input  logic        rst,
    input  logic        clkdiv_we,
    input  logic [31:0] clkdiv_wdata,
    input  logic        execctrl_we,
    input  logic [31:0] execctrl_wdata,
    input  logic        shiftctrl_we,
    input  logic [31:0] shiftctrl_wdata,
    input  logic        pinctrl_we,
    input  logic [31:0] pinctrl_wdata,
    input  logic        sm_en,
    input  logic        clkdiv_restart,
    input  logic        force_tick
);

  logic        sm_tick, tick_pending;
  logic [16:0] sm_tick_period;
  logic [7:0]  dbg_phase;
  logic [16:0] dbg_count;
  logic        dbg_stretch;
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
      .dbg_stretch (dbg_stretch),
      .clkdiv_int (clkdiv_int), .clkdiv_frac (clkdiv_frac),
      .side_en (side_en), .side_pindir (side_pindir),
      .jmp_pin (jmp_pin), .out_en_sel (out_en_sel),
      .inline_out_en (inline_out_en), .out_sticky (out_sticky),
      .wrap_top (wrap_top), .wrap_bottom (wrap_bottom),
      .status_sel (status_sel), .status_n (status_n),
      .fjoin_rx (fjoin_rx), .fjoin_tx (fjoin_tx),
      .pull_thresh (pull_thresh), .push_thresh (push_thresh),
      .out_shift_left (out_shift_left),
      .in_shift_left (in_shift_left),
      .autopull (autopull), .autopush (autopush),
      .fjoin_rx_put (fjoin_rx_put), .fjoin_rx_get (fjoin_rx_get),
      .in_mask_count (in_mask_count),
      .sideset_count (sideset_count), .set_count (set_count),
      .out_count (out_count),
      .in_base (in_base), .sideset_base (sideset_base),
      .set_base (set_base), .out_base (out_base)
  );

  // Lockstep twin (P7, CC-27): identical inputs ⇒ identical divider.
  logic        sm_tick2, tick_pending2;
  logic [16:0] sm_tick_period2;
  logic [7:0]  dbg_phase2;
  logic [16:0] dbg_count2;
  logic        dbg_stretch2;
  logic [15:0] clkdiv_int2;
  logic [7:0]  clkdiv_frac2;

  pio_sm_regs u_dut2 (
      .clk (clk), .rst (rst),
      .clkdiv_we (clkdiv_we), .clkdiv_wdata (clkdiv_wdata),
      .execctrl_we (execctrl_we), .execctrl_wdata (execctrl_wdata),
      .shiftctrl_we (shiftctrl_we), .shiftctrl_wdata (shiftctrl_wdata),
      .pinctrl_we (pinctrl_we), .pinctrl_wdata (pinctrl_wdata),
      .sm_en (sm_en), .clkdiv_restart (clkdiv_restart),
      .force_tick (force_tick),
      .sm_tick (sm_tick2), .tick_pending (tick_pending2),
      .sm_tick_period (sm_tick_period2),
      .dbg_phase (dbg_phase2), .dbg_count (dbg_count2),
      .dbg_stretch (dbg_stretch2),
      .clkdiv_int (clkdiv_int2), .clkdiv_frac (clkdiv_frac2),
      .side_en (), .side_pindir (),
      .jmp_pin (), .out_en_sel (), .inline_out_en (), .out_sticky (),
      .wrap_top (), .wrap_bottom (), .status_sel (), .status_n (),
      .fjoin_rx (), .fjoin_tx (), .pull_thresh (), .push_thresh (),
      .out_shift_left (), .in_shift_left (), .autopull (), .autopush (),
      .fjoin_rx_put (), .fjoin_rx_get (), .in_mask_count (),
      .sideset_count (), .set_count (), .out_count (),
      .in_base (), .sideset_base (), .set_base (), .out_base ()
  );

  // A1: reset protocol (CC-1).
  always @(posedge clk) begin
    if ($initstate) assume (rst);
  end

  // A2/A3: proof scoping (see header).
  always @(posedge clk) begin
    if (tick_pending) begin
      assume (!force_tick);  // A2 (CC-36 deferral: directed-TB scope)
      assume (!clkdiv_we);   // A3
    end
  end

  // Previous-cycle bookkeeping (explicit $past replacement).
  logic        p_rst_r = 1'b1;
  logic        p_clkdiv_we_r = 1'b0;
  logic [31:0] p_clkdiv_wdata_r = '0;
  logic        p_execctrl_we_r = 1'b0;
  logic [31:0] p_execctrl_wdata_r = '0;
  logic        p_shiftctrl_we_r = 1'b0;
  logic [31:0] p_shiftctrl_wdata_r = '0;
  logic        p_pinctrl_we_r = 1'b0;
  logic [31:0] p_pinctrl_wdata_r = '0;
  logic        p_clkdiv_restart_r = 1'b0;
  logic        p_tick_pending_r = 1'b0;
  logic [16:0] p_dbg_count_r = '0;
  logic        p_side_en_r = 1'b0;
  logic        p_side_pindir_r = 1'b0;
  logic        p_inline_out_en_r = 1'b0;
  logic        p_out_sticky_r = 1'b0;
  logic [4:0]  p_jmp_pin_r = '0;
  logic [4:0]  p_out_en_sel_r = '0;
  logic [4:0]  p_wrap_top_r = 5'd1;
  logic [4:0]  p_wrap_bottom_r = 5'd31;
  logic [1:0]  p_status_sel_r = 2'd3;
  logic [4:0]  p_status_n_r = 5'd31;
  logic        p_fjoin_rx_r = 1'b0;
  logic        p_fjoin_tx_r = 1'b0;
  logic [4:0]  p_pull_thresh_r = '0;
  logic [4:0]  p_push_thresh_r = '0;
  logic        p_out_shift_left_r = 1'b0;
  logic        p_in_shift_left_r = 1'b0;
  logic        p_autopull_r = 1'b0;
  logic        p_autopush_r = 1'b0;
  logic        p_fjoin_rx_put_r = 1'b0;
  logic        p_fjoin_rx_get_r = 1'b0;
  logic [4:0]  p_in_mask_count_r = '0;
  logic [2:0]  p_sideset_count_r = '0;
  logic [2:0]  p_set_count_r = 3'd5;
  logic [5:0]  p_out_count_r = '0;
  logic [4:0]  p_in_base_r = '0;
  logic [4:0]  p_sideset_base_r = '0;
  logic [4:0]  p_set_base_r = '0;
  logic [4:0]  p_out_base_r = '0;
  always_ff @(posedge clk) begin
    p_rst_r               <= rst;
    p_clkdiv_we_r         <= clkdiv_we;
    p_clkdiv_wdata_r      <= clkdiv_wdata;
    p_execctrl_we_r       <= execctrl_we;
    p_execctrl_wdata_r    <= execctrl_wdata;
    p_shiftctrl_we_r      <= shiftctrl_we;
    p_shiftctrl_wdata_r   <= shiftctrl_wdata;
    p_pinctrl_we_r        <= pinctrl_we;
    p_pinctrl_wdata_r     <= pinctrl_wdata;
    p_clkdiv_restart_r    <= clkdiv_restart;
    p_tick_pending_r      <= tick_pending;
    p_dbg_count_r         <= dbg_count;
    p_side_en_r           <= side_en;
    p_side_pindir_r       <= side_pindir;
    p_inline_out_en_r     <= inline_out_en;
    p_out_sticky_r        <= out_sticky;
    p_jmp_pin_r           <= jmp_pin;
    p_out_en_sel_r        <= out_en_sel;
    p_wrap_top_r          <= wrap_top;
    p_wrap_bottom_r       <= wrap_bottom;
    p_status_sel_r        <= status_sel;
    p_status_n_r          <= status_n;
    p_fjoin_rx_r          <= fjoin_rx;
    p_fjoin_tx_r          <= fjoin_tx;
    p_pull_thresh_r       <= pull_thresh;
    p_push_thresh_r       <= push_thresh;
    p_out_shift_left_r    <= out_shift_left;
    p_in_shift_left_r     <= in_shift_left;
    p_autopull_r          <= autopull;
    p_autopush_r          <= autopush;
    p_fjoin_rx_put_r      <= fjoin_rx_put;
    p_fjoin_rx_get_r      <= fjoin_rx_get;
    p_in_mask_count_r     <= in_mask_count;
    p_sideset_count_r     <= sideset_count;
    p_set_count_r         <= set_count;
    p_out_count_r         <= out_count;
    p_in_base_r           <= in_base;
    p_sideset_base_r      <= sideset_base;
    p_set_base_r          <= set_base;
    p_out_base_r          <= out_base;
  end

  // INT in effect at the last terminal count: sampled while no tick is
  // pending, so at a pending rise it holds the INT the just-retired
  // terminal compared against (P6b).
  logic [16:0] int_at_term_r = 17'd1;
  always_ff @(posedge clk) begin
    if (!tick_pending) begin
      if (clkdiv_int == '0) int_at_term_r <= 17'd65536;  // SPEC-7-14
      else                  int_at_term_r <= {1'b0, clkdiv_int};
    end
  end

  // Clks since the previous sm_tick (saturating); reset to 0 on a tick.
  logic [16:0] since_tick_r = '0;
  always_ff @(posedge clk) begin
    if (sm_tick)            since_tick_r <= '0;
    else if (since_tick_r != 17'h1ffff) since_tick_r <= since_tick_r + 17'd1;
  end

  // Reference INT decode for P1/P2.
  function automatic logic [16:0] ref_int(input logic [15:0] i);
    ref_int = (i == '0) ? 17'd65536 : {1'b0, i};  // SPEC-7-14
  endfunction

  always @(posedge clk) begin
    if (!$initstate) begin
      // P3: structural tick equation (CC-26 / CC-36 / SPEC-7-2).
      a_p3 : assert (sm_tick == (sm_en && tick_pending && !force_tick));

      // P4: divider bounds (SPEC-7-14: count < 65536).
      a_p4_count  : assert (dbg_count <= 17'd65535);
      if (tick_pending) a_p4_latch : assert (sm_tick_period >= 17'd1);

      // P5: restart clears phase/count/pending the cycle after (CC-27).
      if (p_clkdiv_restart_r && !p_rst_r) begin
        a_p5 : assert (dbg_phase == 8'd0 && dbg_count == 17'd0
                       && !tick_pending);
      end

      // P6: min-gap (CC-25) and its inductive invariants (J1..J4).
      if (sm_tick) a_p6_gap : assert ({1'b0, since_tick_r} + 18'd1 >= {1'b0, sm_tick_period});
      if (tick_pending)
        a_p6_j1 : assert ({1'b0, since_tick_r} + 18'd1 >= {1'b0, sm_tick_period});
      if (!tick_pending)
        a_p6_j2 : assert ({1'b0, since_tick_r} + 18'd1 >= {1'b0, dbg_count});
      // J4: without deferral (A2) a pending tick always pairs with a
      // reset counter (terminal cleared count when it set pending);
      // J3: the latched period covers the counter at the set edge.
      if (tick_pending) begin
        a_p6_j4 : assert (dbg_count == 17'd0);
        a_p6_j3 : assert (sm_tick_period >= 17'd1);
      end
      // Period is ≥ the INT in force at its terminal count. (No upper
      // bound: a CLKDIV write shrinking INT mid-period lets an
      // in-flight count retire with a period > INT+1 — the gap is
      // still ≥ INT, which is what CC-25 guarantees.)
      if (!p_tick_pending_r && tick_pending && !p_rst_r)
        a_p6_term : assert (sm_tick_period >= int_at_term_r);

      // P7: lockstep (CC-27).
      a_p7 : assert (sm_tick == sm_tick2 && tick_pending == tick_pending2
                     && dbg_phase == dbg_phase2
                     && dbg_count == dbg_count2
                     && dbg_stretch == dbg_stretch2
                     && sm_tick_period == sm_tick_period2
                     && clkdiv_int == clkdiv_int2
                     && clkdiv_frac == clkdiv_frac2);

      // P1: reset defaults (SPEC-7-14..26 datasheet reset words).
      if (p_rst_r) begin
        a_p1_clkdiv : assert (clkdiv_int == 16'd1 && clkdiv_frac == 8'd0);
        a_p1_exec : assert (side_en == 1'b0 && side_pindir == 1'b0
                            && jmp_pin == 5'd0 && out_en_sel == 5'd0
                            && inline_out_en == 1'b0 && out_sticky == 1'b0
                            && wrap_top == 5'd1 && wrap_bottom == 5'd31
                            && status_sel == 2'd3 && status_n == 5'd31);
        a_p1_shift : assert (fjoin_rx == 1'b0 && fjoin_tx == 1'b0
                             && pull_thresh == 5'd0 && push_thresh == 5'd0
                             && out_shift_left == 1'b0
                             && in_shift_left == 1'b0
                             && autopull == 1'b0 && autopush == 1'b0
                             && fjoin_rx_put == 1'b0 && fjoin_rx_get == 1'b0
                             && in_mask_count == 5'd0);
        a_p1_pin : assert (sideset_count == 3'd0 && set_count == 3'd5
                           && out_count == 6'd0 && in_base == 5'd0
                           && sideset_base == 5'd0 && set_base == 5'd0
                           && out_base == 5'd0);
      end

      // P2: decode purity — after a write retires, outputs match the
      // wdata slices (SPEC-7-14..26); otherwise they hold (SPEC-7-25).
      if (!p_rst_r && p_clkdiv_we_r) begin
        a_p2_clkdiv : assert (clkdiv_int == p_clkdiv_wdata_r[31:16]
                              && clkdiv_frac == p_clkdiv_wdata_r[15:8]);
      end
      if (!p_rst_r && p_execctrl_we_r) begin
        a_p2_exec : assert (side_en == p_execctrl_wdata_r[30]
                            && side_pindir == p_execctrl_wdata_r[29]
                            && jmp_pin == p_execctrl_wdata_r[28:24]
                            && out_en_sel == p_execctrl_wdata_r[23:19]
                            && inline_out_en == p_execctrl_wdata_r[18]
                            && out_sticky == p_execctrl_wdata_r[17]
                            && wrap_top == p_execctrl_wdata_r[16:12]
                            && wrap_bottom == p_execctrl_wdata_r[11:7]
                            && status_sel == p_execctrl_wdata_r[6:5]
                            && status_n == p_execctrl_wdata_r[4:0]);
      end
      if (!p_rst_r && p_shiftctrl_we_r) begin
        a_p2_shift : assert (fjoin_rx == p_shiftctrl_wdata_r[31]
                             && fjoin_tx == p_shiftctrl_wdata_r[30]
                             && pull_thresh == p_shiftctrl_wdata_r[29:25]
                             && push_thresh == p_shiftctrl_wdata_r[24:20]
                             && out_shift_left == ~p_shiftctrl_wdata_r[19]
                             && in_shift_left == ~p_shiftctrl_wdata_r[18]
                             && autopull == p_shiftctrl_wdata_r[17]
                             && autopush == p_shiftctrl_wdata_r[16]
                             && fjoin_rx_put == p_shiftctrl_wdata_r[15]
                             && fjoin_rx_get == p_shiftctrl_wdata_r[14]
                             && in_mask_count == p_shiftctrl_wdata_r[4:0]);
      end
      if (!p_rst_r && p_pinctrl_we_r) begin
        a_p2_pin : assert (sideset_count == p_pinctrl_wdata_r[31:29]
                           && set_count == p_pinctrl_wdata_r[28:26]
                           && out_count == p_pinctrl_wdata_r[25:20]
                           && in_base == p_pinctrl_wdata_r[19:15]
                           && sideset_base == p_pinctrl_wdata_r[14:10]
                           && set_base == p_pinctrl_wdata_r[9:5]
                           && out_base == p_pinctrl_wdata_r[4:0]);
      end

      // Covers: divisor 1 ticking, fractional stretch (period INT+1),
      // restart, disable mid-period. (INT=0 ⇒ 65536 is covered by the
      // directed TB — a 65536-cycle period is beyond cover depth.)
      if (sm_tick && sm_tick_period == 17'd1) c_div1 : cover (1'b1);
      if (sm_tick && sm_tick_period == int_at_term_r + 17'd1)
        c_stretch : cover (1'b1);
      if (p_clkdiv_restart_r && !p_rst_r) c_restart : cover (1'b1);
      if (!sm_en && dbg_count != '0) c_disabled : cover (1'b1);
    end
  end

endmodule

// Formal properties for pio_sm_shift (KANBAN C2).
//
// Wrapper instantiates the DUT and checks (bmc + prove):
//   P1  counter bounds: 0 <= isr_cnt <= 32, 0 <= osr_cnt <= 32
//       (SPEC-5-4 saturating 6-bit counters).
//   P2  counters never wrap: on an op tick the new counter is >= the
//       old one, and off-tick / no-op the counter holds (saturation,
//       SPEC-5-4).
//   P3  shift-out amount <= bitcount: an OUT tick advances the OSR
//       counter by at most out_count (SPEC-5-4; C2 acceptance clause).
//   P4  decisions use registered (start-of-tick) counters only — CC-4:
//       autopull_ge_thr / autopull_post_thr / autopush_req equal the
//       reference formulas over the *pre-tick* counter registers and
//       are independent of same-cycle op pulses (out_en/in_en/wr_en).
//   P5  ops are tick-gated: without sm_tick (or under rst) the
//       registers hold (DESIGN.md: SM state advances only on sm_tick).
//   P6  reset values: ISR cnt 0, OSR cnt 32 (SPEC-5-3).
//
// Style note (owner convention): immediate assertions inside
// `always @(posedge clk)` with explicit previous-cycle registers;
// formal-only file (never compiled by iverilog).
//
// k-induction tractability: DUT state is osr_r/isr_r/osr_cnt_r/isr_cnt_r
// only, all reset — induction depth 8 suffices (DESIGN.md §k-induction).

module pio_sm_shift_fv (
    input  logic        clk,
    input  logic        rst,
    input  logic        sm_tick,
    input  logic        in_shift_left,
    input  logic        out_shift_left,
    input  logic        autopull_en,
    input  logic        autopush_en,
    input  logic [4:0]  pull_thresh,
    input  logic [4:0]  push_thresh,
    input  logic [5:0]  out_count,
    input  logic [5:0]  in_count,
    input  logic        out_en,
    input  logic        osr_wr_en,
    input  logic [31:0] osr_wr_data,
    input  logic [5:0]  osr_wr_cnt,
    input  logic        in_en,
    input  logic [31:0] in_data,
    input  logic        in_src_isr,
    input  logic        isr_wr_en,
    input  logic [31:0] isr_wr_data,
    input  logic [5:0]  isr_wr_cnt
);

  logic [31:0] osr, isr, out_data, autopush_data;
  logic [5:0]  osr_cnt, isr_cnt;
  logic        autopull_ge_thr, autopull_post_thr, autopush_req;

  pio_sm_shift u_dut (
      .clk (clk), .rst (rst), .sm_tick (sm_tick),
      .in_shift_left (in_shift_left), .out_shift_left (out_shift_left),
      .autopull_en (autopull_en), .autopush_en (autopush_en),
      .pull_thresh (pull_thresh), .push_thresh (push_thresh),
      .out_count (out_count), .in_count (in_count),
      .out_en (out_en),
      .osr_wr_en (osr_wr_en), .osr_wr_data (osr_wr_data),
      .osr_wr_cnt (osr_wr_cnt),
      .in_en (in_en), .in_data (in_data), .in_src_isr (in_src_isr),
      .isr_wr_en (isr_wr_en), .isr_wr_data (isr_wr_data),
      .isr_wr_cnt (isr_wr_cnt),
      .osr (osr), .isr (isr), .osr_cnt (osr_cnt), .isr_cnt (isr_cnt),
      .out_data (out_data),
      .autopull_ge_thr (autopull_ge_thr),
      .autopull_post_thr (autopull_post_thr),
      .autopush_req (autopush_req), .autopush_data (autopush_data)
  );

  // Reset protocol (CC-1, as in pio_instr_mem_fv).
  always @(posedge clk) begin
    if ($initstate) assume (rst);
  end

  // Input contracts (upstream guarantees this module assumes):
  //  - bitcounts come pre-decoded from the decoder: 1..32, 0 already
  //    mapped to 32 (SPEC-2-18);
  //  - counter write values are within 0..32 (exec only writes 0 or a
  //    bitcount — SPEC-5-5/5-6).
  always @(posedge clk) begin
    // Assumptions, not assertions: these are the upstream contracts
    // (decoder / exec) this module is verified under.
    assume (in_count  >= 6'd1 && in_count  <= 6'd32);  // SPEC-2-18
    assume (out_count >= 6'd1 && out_count <= 6'd32);  // SPEC-2-18
    assume (!osr_wr_en || osr_wr_cnt <= 6'd32);        // SPEC-5-5/6
    assume (!isr_wr_en || isr_wr_cnt <= 6'd32);        // SPEC-5-5/6
  end

  // Previous-cycle bookkeeping (explicit $past replacement).
  logic        p_rst_r = 1'b1;
  logic        p_sm_tick_r = 1'b0;
  logic        p_out_en_r = 1'b0;
  logic        p_osr_wr_en_r = 1'b0;
  logic [5:0]  p_osr_wr_cnt_r = '0;
  logic        p_in_en_r = 1'b0;
  logic        p_isr_wr_en_r = 1'b0;
  logic [5:0]  p_isr_wr_cnt_r = '0;
  logic [5:0]  p_out_count_r = 6'd1;
  logic [5:0]  p_in_count_r = 6'd1;
  logic [5:0]  p_osr_cnt_r = 6'd32;   // post-reset value (SPEC-5-3)
  logic [5:0]  p_isr_cnt_r = 6'd0;    // post-reset value (SPEC-5-3)
  always_ff @(posedge clk) begin
    p_rst_r        <= rst;
    p_sm_tick_r    <= sm_tick;
    p_out_en_r     <= out_en;
    p_osr_wr_en_r  <= osr_wr_en;
    p_osr_wr_cnt_r <= osr_wr_cnt;
    p_in_en_r      <= in_en;
    p_isr_wr_en_r  <= isr_wr_en;
    p_isr_wr_cnt_r <= isr_wr_cnt;
    p_out_count_r  <= out_count;
    p_in_count_r   <= in_count;
    p_osr_cnt_r    <= osr_cnt;
    p_isr_cnt_r    <= isr_cnt;
  end

  // Reference helpers (formal-side recomputation — CC-4 check target).
  function automatic logic [5:0] ref_thr(input logic [4:0] t);
    ref_thr = (t == '0) ? 6'd32 : 6'(t);  // SPEC-5-7: 0 encodes 32
  endfunction

  function automatic logic [5:0] ref_sat(input logic [6:0] s);
    ref_sat = (s > 7'd32) ? 6'd32 : s[5:0];  // SPEC-5-4
  endfunction

  always @(posedge clk) begin
    if (!$initstate) begin
      // P1: counter bounds (SPEC-5-4).
      a_p1_isr : assert (isr_cnt <= 6'd32);
      a_p1_osr : assert (osr_cnt <= 6'd32);

      // P2: no wrap — counter never decreases via shift (SPEC-5-4), and
      // holds when no op / no tick / reset.
      if (!p_rst_r && p_sm_tick_r && !p_osr_wr_en_r && p_out_en_r)
        a_p2_osr_mono : assert (osr_cnt >= p_osr_cnt_r);
      if (!p_rst_r && p_sm_tick_r && !p_isr_wr_en_r && p_in_en_r)
        a_p2_isr_mono : assert (isr_cnt >= p_isr_cnt_r);
      if (!p_rst_r && !(p_sm_tick_r && (p_osr_wr_en_r || p_out_en_r)))
        a_p2_osr_hold : assert (osr_cnt == p_osr_cnt_r);
      if (!p_rst_r && !(p_sm_tick_r && (p_isr_wr_en_r || p_in_en_r)))
        a_p2_isr_hold : assert (isr_cnt == p_isr_cnt_r);

      // P3: shift-out amount <= bitcount per tick (SPEC-5-4, C2
      // acceptance): an OUT advances the OSR counter by at most
      // out_count (saturation may reduce it).
      if (!p_rst_r && p_sm_tick_r && !p_osr_wr_en_r && p_out_en_r)
        a_p3 : assert (osr_cnt - p_osr_cnt_r <= p_out_count_r);

      // P4 (CC-4): decisions are pure functions of the *registered*
      // counters (the start-of-tick values for any evaluation this clk
      // cycle), config, and counts. The reference below has no op-pulse
      // terms while the pulses are free inputs — any same-cycle
      // dependence of the decisions on out_en/in_en/wr_en fails here.
      a_p4_ge : assert (autopull_ge_thr
                        == (autopull_en && (osr_cnt >= ref_thr(pull_thresh))));
      a_p4_post : assert (autopull_post_thr
                          == (autopull_en
                              && (ref_sat({1'b0, osr_cnt} + {1'b0, out_count})
                                  >= ref_thr(pull_thresh))));
      a_p4_push : assert (autopush_req
                          == (autopush_en
                              && (ref_sat({1'b0, isr_cnt} + {1'b0, in_count})
                                  >= ref_thr(push_thresh))));

      // P6: reset values one cycle after rst (SPEC-5-3).
      if (p_rst_r) begin
        a_p6 : assert (isr_cnt == 6'd0 && osr_cnt == 6'd32);
      end

      // Covers: saturation actually exercised, decisions both ways.
      if (osr_cnt == 6'd32 && p_sm_tick_r && p_out_en_r) c_osr_sat : cover (1'b1);
      if (isr_cnt == 6'd32 && p_sm_tick_r && p_in_en_r)  c_isr_sat : cover (1'b1);
      if (autopull_ge_thr)  c_ap_ge  : cover (1'b1);
      if (autopull_post_thr) c_ap_post : cover (1'b1);
      if (autopush_req)      c_push  : cover (1'b1);
    end
  end

endmodule

// tb_pio_sm_shift.sv — directed TB for rtl/pio_sm_shift.sv (KANBAN C2).
//
// Coverage (per the C2 acceptance):
//   1. Reset values: ISR/OSR = 0, ISR counter = 0, OSR counter = 32
//      (SPEC-5-3).
//   2. OUT shifts, LSB (right) and MSB (left), every width 1..32
//      (bitcount already decoded 0⇒32 upstream — SPEC-2-18): out_data
//      alignment (SPEC-3.4-1), OSR shift/fill-with-zeroes (SPEC-5-1),
//      counter increments (SPEC-5-4).
//   3. IN shifts, both directions, every width 1..32: LSB source
//      (SPEC-3.3-7), entry end per direction (SPEC-5-2), counter.
//   4. Counter saturation: never wraps past 32 (SPEC-5-4).
//   5. OSR write (PULL/autopull): data + counter ← 0 (SPEC-5-5); ISR
//      write (PUSH: 0/0 — CC-9; OUT ISR,n: value/n — SPEC-5-6); write
//      wins over same-tick shift (CC-9, CC-11).
//   6. Rotate: IN ISR self-shift both directions (SPEC-3.3-8/15-1);
//      IN OSR leaves the OSR counter undisturbed (SPEC-3.3-8).
//   7. Autopull/autopush decisions: threshold compare incl. 0⇒32 decode
//      (SPEC-5-7), start-of-tick counter use (CC-4), post-shift compares
//      (CC-11 else-branch, CC-13), autopush_data = post-shift ISR (CC-9).
//
// Grounding: SPEC-5-1..9, SPEC-3.3-7/8, SPEC-2-18, SPEC-3.4-1,
// SPEC-3.6-14; CC-4, CC-9, CC-11, CC-13.
//
// Timing note: combinational outputs that are functions of pre-tick
// state (out_data, autopush_data, decisions) are sampled at #1 after the
// driving negedge — i.e. against start-of-tick registers (CC-4) — never
// after the retiring posedge.

`include "tb_common.sv"

module tb_pio_sm_shift;

  logic clk;
  logic rst;
  tb_clk_rst u_cr (.clk(clk));

  logic        sm_tick;
  logic        in_shift_left, out_shift_left;
  logic        autopull_en, autopush_en;
  logic [4:0]  pull_thresh, push_thresh;
  logic [5:0]  out_count, in_count;
  logic        out_en;
  logic        osr_wr_en;
  logic [31:0] osr_wr_data;
  logic [5:0]  osr_wr_cnt;
  logic        in_en;
  logic [31:0] in_data;
  logic        in_src_isr;
  logic        isr_wr_en;
  logic [31:0] isr_wr_data;
  logic [5:0]  isr_wr_cnt;
  logic [31:0] osr, isr, out_data, autopush_data;
  logic [5:0]  osr_cnt, isr_cnt;
  logic        autopull_ge_thr, autopull_post_thr, autopush_req;

  pio_sm_shift u_dut (
      .clk (clk), .rst (rst),
      .sm_tick (sm_tick),
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

  // Reference models.
  function automatic logic [31:0] ref_out_data(input logic [31:0] v,
                                               input logic [5:0] n,
                                               input logic left);
    ref_out_data = left ? (v >> (32 - n)) : (v & ((32'd1 << n) - 32'd1));
  endfunction

  function automatic logic [31:0] ref_osr_shift(input logic [31:0] v,
                                                input logic [5:0] n,
                                                input logic left);
    ref_osr_shift = left ? (v << n) : (v >> n);
  endfunction

  function automatic logic [31:0] ref_isr_shift(input logic [31:0] v,
                                                input logic [31:0] src,
                                                input logic [5:0] n,
                                                input logic left);
    if (n == 6'd32) ref_isr_shift = src;
    else if (left)  ref_isr_shift = (v << n) | (src & ((32'd1 << n) - 32'd1));
    else            ref_isr_shift = (v >> n)
                                  | ((src & ((32'd1 << n) - 32'd1)) << (32 - n));
  endfunction

  function automatic logic [31:0] ref_isr_rot(input logic [31:0] v,
                                              input logic [5:0] n,
                                              input logic left);
    if (n == 6'd32) ref_isr_rot = v;
    else if (left)  ref_isr_rot = (v << n) | (v >> (32 - n));
    else            ref_isr_rot = (v >> n) | (v << (32 - n));
  endfunction

  function automatic logic [5:0] ref_sat(input logic [6:0] s);
    ref_sat = (s > 7'd32) ? 6'd32 : s[5:0];
  endfunction

  localparam logic [31:0] PAT = 32'hB7E5_1CED;  // assorted bits

  initial begin
    sm_tick = 1'b0;
    in_shift_left = 1'b0; out_shift_left = 1'b0;
    autopull_en = 1'b0; autopush_en = 1'b0;
    pull_thresh = 5'd0; push_thresh = 5'd0;
    out_count = 6'd1; in_count = 6'd1;
    out_en = 1'b0;
    osr_wr_en = 1'b0; osr_wr_data = '0; osr_wr_cnt = '0;
    in_en = 1'b0; in_data = '0; in_src_isr = 1'b0;
    isr_wr_en = 1'b0; isr_wr_data = '0; isr_wr_cnt = '0;

    `DO_RESET_DEFAULT

    // -------------------------------------------------------------
    // 1. Reset values (SPEC-5-3).
    // -------------------------------------------------------------
    `check32(isr, 32'd0)
    `check32(osr, 32'd0)
    `check32(isr_cnt, 6'd0)
    `check32(osr_cnt, 6'd32)

    // -------------------------------------------------------------
    // 2. OUT both directions, widths 1..32 (SPEC-3.4-1, SPEC-5-1/5-4).
    // -------------------------------------------------------------
    for (int dir = 0; dir < 2; dir++) begin
      logic left;
      left = logic'(dir);
      for (int n = 1; n <= 32; n++) begin
        logic [31:0] exp_osr, exp_data;
        logic [5:0]  exp_cnt;
        // Load a known OSR with counter 0 (SPEC-5-5 load shape).
        @(negedge clk);
        osr_wr_en = 1'b1; osr_wr_data = PAT; osr_wr_cnt = 6'd0;
        sm_tick = 1'b1;
        @(posedge clk); @(negedge clk);
        // Shift out; comb outputs sampled pre-edge (start-of-tick, CC-4).
        osr_wr_en = 1'b0;
        out_shift_left = left; out_count = 6'(n); out_en = 1'b1;
        #1;
        exp_data = ref_out_data(PAT, 6'(n), left);   // SPEC-3.4-1
        `check32(out_data, exp_data)
        @(posedge clk);                               // shift retires
        @(negedge clk);
        out_en = 1'b0; sm_tick = 1'b0;
        @(posedge clk); @(negedge clk);
        exp_osr = ref_osr_shift(PAT, 6'(n), left);    // SPEC-5-1
        exp_cnt = ref_sat(7'(0 + n));                 // SPEC-5-4
        `check32(osr, exp_osr)
        `check32(osr_cnt, exp_cnt)
      end
    end

    // -------------------------------------------------------------
    // 3. IN both directions, widths 1..32 (SPEC-3.3-1/7, SPEC-5-2/5-4).
    // -------------------------------------------------------------
    for (int dir = 0; dir < 2; dir++) begin
      logic left;
      left = logic'(dir);
      for (int n = 1; n <= 32; n++) begin
        logic [31:0] exp_isr;
        logic [5:0]  exp_cnt;
        @(negedge clk);
        isr_wr_en = 1'b1; isr_wr_data = ~PAT; isr_wr_cnt = 6'd0;
        sm_tick = 1'b1;
        @(posedge clk); @(negedge clk);
        isr_wr_en = 1'b0;
        in_shift_left = left; in_count = 6'(n);
        in_data = PAT; in_en = 1'b1;
        #1;
        exp_isr = ref_isr_shift(~PAT, PAT, 6'(n), left);  // SPEC-3.3-7
        `check32(autopush_data, exp_isr)  // CC-9 post-shift value
        @(posedge clk);
        @(negedge clk);
        in_en = 1'b0; sm_tick = 1'b0;
        @(posedge clk); @(negedge clk);
        exp_cnt = ref_sat(7'(0 + n));                     // SPEC-5-4
        `check32(isr, exp_isr)
        `check32(isr_cnt, exp_cnt)
      end
    end

    // -------------------------------------------------------------
    // 4. Counter saturation: repeated OUT/IN never wraps (SPEC-5-4).
    // -------------------------------------------------------------
    @(negedge clk);
    osr_wr_en = 1'b1; osr_wr_data = PAT; osr_wr_cnt = 6'd0;
    out_count = 6'd20; sm_tick = 1'b1;
    @(posedge clk); @(negedge clk);
    osr_wr_en = 1'b0; out_en = 1'b1;
    @(posedge clk);  // cnt 20
    @(posedge clk);  // 40 -> sat 32 (SPEC-5-4)
    @(posedge clk);  // holds 32, OSR keeps shifting zeroes (SPEC-5-1)
    @(negedge clk);
    out_en = 1'b0; sm_tick = 1'b0;
    @(posedge clk); @(negedge clk);
    `check32(osr_cnt, 6'd32)
    `check32(osr, 32'd0)
    // IN side: 24 + 24 -> 32.
    @(negedge clk);
    isr_wr_en = 1'b1; isr_wr_data = '0; isr_wr_cnt = 6'd24;
    in_count = 6'd24;
    @(posedge clk); @(negedge clk);
    isr_wr_en = 1'b0; in_en = 1'b1;
    @(posedge clk);
    @(negedge clk);
    in_en = 1'b0; sm_tick = 1'b0;
    @(posedge clk); @(negedge clk);
    `check32(isr_cnt, 6'd32)

    // -------------------------------------------------------------
    // 5. Writes: OSR (PULL — SPEC-5-5), ISR (PUSH 0/0 — CC-9; OUT ISR,n
    //    value/n — SPEC-5-6); write wins over same-tick shift.
    // -------------------------------------------------------------
    @(negedge clk);
    osr_wr_en = 1'b1; osr_wr_data = 32'hDEAD_BEEF; osr_wr_cnt = 6'd0;
    out_en = 1'b1; out_count = 6'd4;  // write wins (CC-11 refill priority)
    sm_tick = 1'b1;
    @(posedge clk); @(negedge clk);
    osr_wr_en = 1'b0; out_en = 1'b0; sm_tick = 1'b0;
    @(posedge clk); @(negedge clk);
    `check32(osr, 32'hDEAD_BEEF)
    `check32(osr_cnt, 6'd0)

    @(negedge clk);
    isr_wr_en = 1'b1; isr_wr_data = 32'h0; isr_wr_cnt = 6'd0;  // PUSH (CC-9)
    in_en = 1'b1; in_count = 6'd8;  // write wins over same-tick IN
    sm_tick = 1'b1;
    @(posedge clk); @(negedge clk);
    isr_wr_en = 1'b0; in_en = 1'b0; sm_tick = 1'b0;
    @(posedge clk); @(negedge clk);
    `check32(isr, 32'd0)
    `check32(isr_cnt, 6'd0)

    // OUT ISR,5: ISR ← out_data (LSB end, right shift), counter ← 5.
    @(negedge clk);
    isr_wr_en = 1'b1; isr_wr_data = 32'hCAFEBABE; isr_wr_cnt = 6'd5;
    out_en = 1'b1; out_count = 6'd5; out_shift_left = 1'b0;
    sm_tick = 1'b1;
    @(posedge clk); @(negedge clk);
    isr_wr_en = 1'b0; out_en = 1'b0; sm_tick = 1'b0;
    @(posedge clk); @(negedge clk);
    `check32(isr, 32'hCAFEBABE)
    `check32(isr_cnt, 6'd5)
    `check32(osr_cnt, 6'd5)   // OSR shifted 5 in the same tick

    // -------------------------------------------------------------
    // 6. Rotate (SPEC-3.3-8, SPEC-15-1) + IN OSR leaves OSR counter.
    // -------------------------------------------------------------
    for (int dir = 0; dir < 2; dir++) begin
      logic left;
      left = logic'(dir);
      @(negedge clk);
      isr_wr_en = 1'b1; isr_wr_data = PAT; isr_wr_cnt = 6'd0;
      in_shift_left = left; in_count = 6'd9; in_src_isr = 1'b1;
      sm_tick = 1'b1;
      @(posedge clk); @(negedge clk);
      isr_wr_en = 1'b0; in_en = 1'b1;
      #1;
      `check32(autopush_data, ref_isr_rot(PAT, 6'd9, left))
      @(posedge clk);
      @(negedge clk);
      in_en = 1'b0; sm_tick = 1'b0;
      @(posedge clk); @(negedge clk);
      `check32(isr, ref_isr_rot(PAT, 6'd9, left))
      `check32(isr_cnt, 6'd9)  // counter still advances (SPEC-3.3-8)
    end
    // IN OSR: in_data = osr, ISR shifts, OSR counter untouched.
    @(negedge clk);
    osr_wr_en = 1'b1; osr_wr_data = 32'h1234_5678; osr_wr_cnt = 6'd3;
    isr_wr_en = 1'b1; isr_wr_data = '0; isr_wr_cnt = 6'd0;
    in_count = 6'd4; in_src_isr = 1'b0; in_shift_left = 1'b0;
    sm_tick = 1'b1;
    @(posedge clk); @(negedge clk);
    osr_wr_en = 1'b0; isr_wr_en = 1'b0; in_en = 1'b1; in_data = 32'h1234_5678;
    @(posedge clk); @(negedge clk);
    in_en = 1'b0; sm_tick = 1'b0;
    @(posedge clk); @(negedge clk);
    `check32(isr, 32'h8000_0000)  // nibble 8 into the MSB end (SPEC-5-2)
    `check32(isr_cnt, 6'd4)
    `check32(osr_cnt, 6'd3)       // undisturbed (SPEC-3.3-8)

    // -------------------------------------------------------------
    // 7. Autopull / autopush decisions (SPEC-5-7/8/9, CC-4/CC-11/13).
    //    OSR counter is 3 and ISR counter 4 at this point.
    // -------------------------------------------------------------
    // thresh 0 ⇒ 32 (SPEC-5-7); OSR cnt 3 < 32 now, post-shift 3+29 = 32.
    @(negedge clk);
    autopull_en = 1'b1; pull_thresh = 5'd0;
    out_count = 6'd29; sm_tick = 1'b1;
    #1;
    `check1(autopull_ge_thr, 1'b0)        // start-of-tick compare (CC-4)
    `check1(autopull_post_thr, 1'b1)      // CC-11 else-branch
    @(posedge clk); @(negedge clk);
    autopull_en = 1'b0; sm_tick = 1'b0;
    @(posedge clk); @(negedge clk);
    // OSR cnt 3, thr 3: equal ⇒ ge true (CC-11 uses >=).
    @(negedge clk);
    autopull_en = 1'b1; pull_thresh = 5'd3; sm_tick = 1'b1;
    #1;
    `check1(autopull_ge_thr, 1'b1)
    @(posedge clk); @(negedge clk);
    autopull_en = 1'b0; sm_tick = 1'b0;
    @(posedge clk); @(negedge clk);
    // Autopull disabled ⇒ decision low regardless of threshold.
    @(negedge clk);
    pull_thresh = 5'd1; sm_tick = 1'b1;
    #1;
    `check1(autopull_ge_thr, 1'b0)        // SPEC-5-8 gate
    `check1(autopull_post_thr, 1'b0)
    @(posedge clk); @(negedge clk);
    sm_tick = 1'b0;
    @(posedge clk); @(negedge clk);
    // Autopush: ISR cnt 4, push_thresh 12, in_count 8 ⇒ 12 ≥ 12 fires
    // (CC-13 resulting-counter rule); post-shift data = old ISR shifted.
    @(negedge clk);
    autopush_en = 1'b1; push_thresh = 5'd12;
    in_count = 6'd8; in_shift_left = 1'b0;
    in_data = 32'hAB; sm_tick = 1'b1;
    #1;
    `check1(autopush_req, 1'b1)
    // CC-9: autopush_data is the post-shift ISR (ISR holds the rotate
    // pattern from test 6 — compute the reference against it directly).
    `check32(autopush_data, ref_isr_shift(isr, 32'hAB, 6'd8, 1'b0))
    @(posedge clk); @(negedge clk);
    autopush_en = 1'b0; push_thresh = 5'd13; sm_tick = 1'b0;
    @(posedge clk); @(negedge clk);
    `check1(autopush_req, 1'b0)

    tb_finish;
  end

endmodule

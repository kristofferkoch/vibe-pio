// pio_sm_shift — ISR/OSR shift registers, saturating counters, and the
// autopull/autopush *decision* logic (KANBAN C2).
//
// Pure tick-rate datapath (DESIGN.md §pio_sm_shift):
//   - 32-bit OSR/ISR with independent shift directions (SPEC-5-2),
//   - two saturating 6-bit counters, reset ISR←0 / OSR←32 (SPEC-5-3),
//   - IN rotate semantics when the source is the ISR itself
//     (SPEC-3.3-8, SPEC-15-1), IN from OSR leaves the OSR counter alone,
//   - autopull/autopush decisions computed against the *registered*
//     (start-of-tick) counters (CC-4) with 0⇒32 threshold decoding
//     (SPEC-5-7).
//
// Division of labour: this module never stalls and never touches the
// FIFOs. Exec (C8) samples the decision outputs, applies the CC-11/CC-13
// stall/refill handshakes, and drives the write/shift operation ports
// below (which is why e.g. an explicit PUSH clears ISR via `isr_wr_*`
// with data 0 / count 0 rather than a dedicated port — one write port,
// exec picks the values; SPEC-5-1/5-5, CC-9's clear-at-same-edge).
// All operations are qualified by `sm_tick` (DESIGN.md: SM state advances
// only on sm_tick).

module pio_sm_shift (
    input  logic        clk,
    input  logic        rst,

    // Tick strobe from the divider (C5); ops below are ignored off-tick.
    input  logic        sm_tick,

    // Shift configuration (from SHIFTCTRL, C5). Thresholds are the raw
    // 5-bit fields; 0 encodes 32 (SPEC-5-7).
    input  logic        in_shift_left,   // SPEC-5-2: 0 = right (reset default)
    input  logic        out_shift_left,  // SPEC-5-2: 0 = right (reset default)
    input  logic        autopull_en,     // SPEC-5-8
    input  logic        autopush_en,     // SPEC-5-9
    input  logic [4:0]  pull_thresh,
    input  logic [4:0]  push_thresh,

    // Bitcounts, pre-decoded 0⇒32 by the decoder (C4, SPEC-2-18): 1..32.
    input  logic [5:0]  out_count,
    input  logic [5:0]  in_count,

    // OSR operations (tick-qualified):
    //   out_en: shift out_count bits out of OSR (SPEC-3.4-1, SPEC-5-4).
    //   osr_wr_en: write OSR + counter (PULL/autopull refill: cnt 0,
    //     SPEC-5-5; MOV OSR: cnt 0, SPEC-5-6). Write wins over shift —
    //     CC-11's simultaneous last-shift + refill loads the fresh word.
    input  logic        out_en,
    input  logic        osr_wr_en,
    input  logic [31:0] osr_wr_data,
    input  logic [5:0]  osr_wr_cnt,

    // ISR operations (tick-qualified):
    //   in_en: shift in_count bits of in_data into ISR (SPEC-3.3-1).
    //     in_data is the source's LSBs (SPEC-3.3-7); in_src_isr selects
    //     rotate semantics (SPEC-3.3-8). IN from OSR just feeds in_data
    //     from OSR — the OSR side is untouched (SPEC-3.3-8).
    //   isr_wr_en: write ISR + counter (PUSH/autopush: 0/0, SPEC-5-1/5-5,
    //     CC-9 same-edge clear; MOV ISR: value/0, SPEC-5-6; OUT ISR,n:
    //     value/n, SPEC-5-6). Write wins over shift.
    input  logic        in_en,
    input  logic [31:0] in_data,
    input  logic        in_src_isr,
    input  logic        isr_wr_en,
    input  logic [31:0] isr_wr_data,
    input  logic [5:0]  isr_wr_cnt,

    // State readback (combinational; counters are the registered
    // start-of-tick values — CC-4).
    output logic [31:0] osr,
    output logic [31:0] isr,
    output logic [5:0]  osr_cnt,
    output logic [5:0]  isr_cnt,

    // OUT destination value: the out_count bits taken from the LSB end
    // (right) or MSB end (left) of OSR, remainder zero (SPEC-3.4-1).
    output logic [31:0] out_data,

    // Autopull decision (CC-11/CC-12, SPEC-5-8): OSR counter ≥ decoded
    // PULL_THRESH. Exec's use: on an OUT tick start ⇒ stall/refill path;
    // on a non-OUT tick ⇒ refill (CC-12).
    output logic        autopull_ge_thr,
    // CC-11 else-branch: the *resulting* counter after this OUT's shift
    // reaches threshold — simultaneous refill at end of tick (if TX
    // non-empty; exec gates that).
    output logic        autopull_post_thr,
    // Autopush decision (CC-13, SPEC-5-9): resulting ISR counter
    // (saturating) ≥ decoded PUSH_THRESH. Exec stalls iff rx_full.
    output logic        autopush_req,
    // Post-shift ISR value for the same-cycle autopush (CC-9).
    output logic [31:0] autopush_data
);

  localparam int DW  = 32;  // OSR/ISR width (SPEC-5-1)
  localparam int CW  = 6;   // counter width, 0..32 saturating (SPEC-5-4)

  logic [DW-1:0] osr_r;
  logic [DW-1:0] isr_r;
  logic [CW-1:0] osr_cnt_r;
  logic [CW-1:0] isr_cnt_r;

  assign osr     = osr_r;
  assign isr     = isr_r;
  assign osr_cnt = osr_cnt_r;
  assign isr_cnt = isr_cnt_r;
  assign out_data = out_data_c;  // SPEC-3.4-1

  // -----------------------------------------------------------------------
  // Threshold decode: 0 encodes 32 (SPEC-5-7).
  // -----------------------------------------------------------------------
  logic [CW-1:0] pull_thr_c;
  logic [CW-1:0] push_thr_c;
  always_comb begin
    pull_thr_c = (pull_thresh == '0) ? CW'(DW) : CW'(pull_thresh);  // SPEC-5-7
    push_thr_c = (push_thresh == '0) ? CW'(DW) : CW'(push_thresh);  // SPEC-5-7
  end

  // -----------------------------------------------------------------------
  // Shift helpers (pure functions of OSR/ISR state and counts).
  // -----------------------------------------------------------------------
  logic [DW-1:0] out_mask_c;      // low out_count ones
  logic [DW-1:0] in_mask_c;       // low in_count ones
  logic [DW-1:0] out_data_c;      // SPEC-3.4-1 destination value
  logic [DW-1:0] osr_shifted_c;   // OSR after shifting out (SPEC-5-1)
  logic [DW-1:0] isr_shifted_c;   // ISR after IN (normal, SPEC-3.3-1/7)
  logic [DW-1:0] isr_rotated_c;   // ISR after IN ISR (rotate, SPEC-3.3-8)
  logic [DW-1:0] isr_next_in_c;   // which of the two IN applies

  always_comb begin
    out_mask_c = (DW'(1) << out_count) - 32'd1;
    in_mask_c  = (DW'(1) << in_count)  - 32'd1;

    // SPEC-3.4-1: bits from the LSB end (right) or MSB end (left),
    // remainder zero.
    out_data_c = out_shift_left ? (osr_r >> (CW'(DW) - out_count))
                                : (osr_r & out_mask_c);

    // SPEC-5-1: OSR fills with zeroes as it empties.
    osr_shifted_c = out_shift_left ? (osr_r << out_count)
                                   : (osr_r >> out_count);

    // SPEC-3.3-1/7: source always contributes its LSBs; right shift ⇒
    // data enters at the MSB end (SPEC-5-2).
    if (in_count == CW'(DW)) begin
      isr_shifted_c = in_data;   // full 32-bit shift-in replaces the ISR
      isr_rotated_c = isr_r;     // rotate by 32 = identity
    end else if (in_shift_left) begin
      isr_shifted_c = (isr_r << in_count) | (in_data & in_mask_c);
      isr_rotated_c = (isr_r << in_count) | (isr_r >> (CW'(DW) - in_count));
    end else begin
      isr_shifted_c = (isr_r >> in_count)
                    | ((in_data & in_mask_c) << (CW'(DW) - in_count));
      isr_rotated_c = (isr_r >> in_count) | (isr_r << (CW'(DW) - in_count));
    end
    // SPEC-3.3-8: self-shift rotates.
    isr_next_in_c = in_src_isr ? isr_rotated_c : isr_shifted_c;
  end

  // Edge case: a full 32-bit rotate is the identity and a full shift-in
  // replaces the ISR, but (x>>32)|(x<<32) evaluates to 0 in 32-bit
  // arithmetic — handle in_count == 32 explicitly above (SPEC-3.3-1/8).
  // out_count == 32 needs no special case: the mask is all-ones and
  // (DW - out_count) == 0, so both directions are exact.

  // -----------------------------------------------------------------------
  // Decision outputs — computed from *registered* counters only, so any
  // exec evaluation at tick T sees start-of-T state (CC-4).
  // -----------------------------------------------------------------------
  logic [CW:0] osr_cnt_sum_c;  // 7-bit: counter + count, pre-saturation
  logic [CW:0] isr_cnt_sum_c;
  logic [CW-1:0] osr_cnt_sat_c;
  logic [CW-1:0] isr_cnt_sat_c;

  always_comb begin
    osr_cnt_sum_c = {1'b0, osr_cnt_r} + {1'b0, out_count};  // SPEC-5-4
    isr_cnt_sum_c = {1'b0, isr_cnt_r} + {1'b0, in_count};
    osr_cnt_sat_c = (osr_cnt_sum_c > {1'b0, CW'(DW)}) ? CW'(DW) : CW'(osr_cnt_sum_c);
    isr_cnt_sat_c = (isr_cnt_sum_c > {1'b0, CW'(DW)}) ? CW'(DW) : CW'(isr_cnt_sum_c);

    // CC-11 / CC-12 / SPEC-5-8: start-of-tick threshold compare.
    autopull_ge_thr  = autopull_en && (osr_cnt_r >= pull_thr_c);
    // CC-11 else-branch: post-shift counter reaches threshold.
    autopull_post_thr = autopull_en && (osr_cnt_sat_c >= pull_thr_c);
    // CC-13 / SPEC-3.3-9: resulting counter reaches threshold.
    autopush_req     = autopush_en && (isr_cnt_sat_c >= push_thr_c);
    autopush_data    = isr_next_in_c;  // CC-9: push the post-shift ISR
  end

  // -----------------------------------------------------------------------
  // State update — one always_ff per register group (OSR pair, ISR pair),
  // everything reset by rst (SPEC-5-3 counter values).
  // -----------------------------------------------------------------------
  always_ff @(posedge clk) begin
    if (rst) begin
      osr_r     <= '0;
      osr_cnt_r <= CW'(DW);  // SPEC-5-3: OSR counter ← 32 ("full")
    end else if (sm_tick) begin
      if (osr_wr_en) begin
        osr_r     <= osr_wr_data;   // SPEC-5-5/5-6: counter ← 0 on load
        osr_cnt_r <= osr_wr_cnt;
      end else if (out_en) begin
        osr_r     <= osr_shifted_c;  // SPEC-5-1/5-4
        osr_cnt_r <= osr_cnt_sat_c;
      end
    end
  end

  always_ff @(posedge clk) begin
    if (rst) begin
      isr_r     <= '0;
      isr_cnt_r <= '0;        // SPEC-5-3: ISR counter ← 0
    end else if (sm_tick) begin
      if (isr_wr_en) begin
        isr_r     <= isr_wr_data;  // SPEC-5-1/5-5/5-6: write wins over IN
        isr_cnt_r <= isr_wr_cnt;   // (autopush: 0/0 at the same edge, CC-9)
      end else if (in_en) begin
        isr_r     <= isr_next_in_c;  // SPEC-3.3-1/8, CC-9
        isr_cnt_r <= isr_cnt_sat_c;  // SPEC-5-4
      end
    end
  end

endmodule

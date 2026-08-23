// tb_smoke.sv — C0 infrastructure canary (KANBAN C0).
//
// Proves the sim infrastructure end-to-end: clock/reset generator, DO_RESET,
// wait helpers, check macros, and tb_finish exit-status plumbing. No real DUT
// — a trivial always_ff counter stands in so `rst` does something observable.
//
// Grounding: CC-1 (reset assertion/release modelled by `DO_RESET`).

`include "tb_common.sv"

module tb_smoke;

  logic clk;
  logic rst;
  tb_clk_rst u_cr (.clk(clk));

  // Trivial DUT: 4-bit counter, synchronous active-high reset (CC-1).
  logic [3:0] cnt_r;
  always_ff @(posedge clk) begin
    if (rst) begin
      cnt_r <= 4'd0;
    end else begin
      cnt_r <= cnt_r + 4'd1;
    end
  end

  initial begin
    // CC-1: synchronous reset assertion and release.
    `DO_RESET_DEFAULT
    `check1(rst, 1'b0)
    `check32(cnt_r, 32'd0)

    // Run some cycles; counter must advance one per clk.
    `WAIT_CLKS(3)
    `check32(cnt_r, 32'd3)
    `TICK
    `check32(cnt_r, 32'd4)

    // Re-assert reset (CC-1): counter clears.
    `DO_RESET(2)
    `check32(cnt_r, 32'd0)

    // check1 true condition.
    `check1(cnt_r[0], 1'b0)

    tb_finish;
  end

endmodule

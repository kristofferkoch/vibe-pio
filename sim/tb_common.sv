// tb_common.sv — shared testbench infrastructure for all sim/tb_*.sv.
//
// Usage (each testbench `include`s this file; the Makefile adds -I sim):
//
//   `include "tb_common.sv"
//   module tb_xxx;
//     logic clk, rst;
//     tb_clk_rst u_cr (.clk(clk));
//     // rst is driven only by `DO_RESET below (asserted from time 0).
//     // DUT, driven by clk/rst
//     initial begin
//       `DO_RESET(4)
//       `WAIT_CLKS(3)
//       `check32(dut_out, 32'd3)
//       `TB_FINISH
//     end
//   endmodule
//
// Notes:
// - clk/rst live in the *testbench module* (not at file scope): iverilog 12
//   aborts on `always_ff` referencing $root-scope signals, so the generator
//   drives them through ports.
// - Helpers that manipulate clk/rst are therefore macros (expanded in the
//   TB's scope); pure bookkeeping (counters, finish) stays in tasks.
//
// This is testbench-only code (never read by yosys), so the RTL synthesizable
// subset does not apply; conventions (logic, .sv, explicit widths, UPPER_SNAKE
// localparams) are followed where sensible.
//
// Grounding: CC-1 — reset assertion/release is modelled by `DO_RESET`
// (synchronous, active-high, per DESIGN.md "RTL conventions").

`ifndef TB_COMMON_SV
`define TB_COMMON_SV

`timescale 1ns/1ps

// ---------------------------------------------------------------------------
// Clock generator. `DO_RESET drives the TB's local rst signal directly, so
// rst is single-owner (the testbench) — avoids multi-driver elaboration.
// ---------------------------------------------------------------------------
module tb_clk_rst #(parameter int HALF_PERIOD_NS = 5)  // 100 MHz
                   (output logic clk);
  initial begin
    clk = 1'b0;
    forever #(HALF_PERIOD_NS) clk = ~clk;
  end
endmodule

// ---------------------------------------------------------------------------
// Pass/fail bookkeeping (file-scope integers are safe: no always_ff reads them)
// ---------------------------------------------------------------------------
integer tb_fail_count = 0;
integer tb_pass_count = 0;

// tb_finish — task (not macro): prints summary, $fatal(1) on any failure so
// vvp exits nonzero and `make sim` can aggregate.
task tb_finish;
  begin
    $display("--------------------------------------------------");
    $display("TB RESULT: %0d passed, %0d failed", tb_pass_count, tb_fail_count);
    if (tb_fail_count != 0) begin
      $display("TB STATUS : FAIL");
      $fatal(1, "tb_finish: %0d check(s) failed", tb_fail_count);
    end else begin
      $display("TB STATUS : PASS");
      $finish;
    end
  end
endtask

// ---------------------------------------------------------------------------
// Reset / wait helpers — macros over the TB's local clk/rst signals.
// ---------------------------------------------------------------------------

// CC-1: synchronous reset assertion and release. Hold rst high for <n> clk
// cycles, release on an edge, then advance one more edge so post-reset state
// (cnt==0, rst==0) is observable.
`define DO_RESET(n)                                                           \
  begin                                                                        \
    rst = 1'b1;                                                                \
    repeat ((n)) @(posedge clk);                                               \
    rst = 1'b0;                                                                \
    @(posedge clk);                                                            \
  end

// Default reset: 4 cycles.
`define DO_RESET_DEFAULT `DO_RESET(4)

// Wait for n rising clk edges.
`define WAIT_CLKS(n) repeat ((n)) @(posedge clk);

// One clk tick (rising edge).
`define TICK @(posedge clk);

// ---------------------------------------------------------------------------
// Check helpers. Macros (not tasks) so file/line report the *call site*.
// `check32 / `check1 print PASS/FAIL lines and bump the counters.
// ---------------------------------------------------------------------------

// check32: compare a 32-bit (or narrower) actual against expected.
`define check32(act_, exp_)                                              \
  begin                                                                        \
    logic [31:0] a32;                                                          \
    logic [31:0] e32;                                                          \
    a32 = (32'(act_));                                                       \
    e32 = (32'(exp_));                                                     \
    if (a32 !== e32) begin                                                     \
      tb_fail_count = tb_fail_count + 1;                                       \
      $display("FAIL %0s:%0d check32: got %h expected %h",                     \
               `__FILE__, `__LINE__, a32, e32);                                \
    end else begin                                                             \
      tb_pass_count = tb_pass_count + 1;                                       \
      $display("PASS %0s:%0d check32: %h", `__FILE__, `__LINE__, a32);         \
    end                                                                        \
  end

// check1: single-bit compare.
`define check1(act_, exp_)                                               \
  begin                                                                        \
    logic a1;                                                                  \
    logic e1;                                                                  \
    a1 = (1'(act_));                                                         \
    e1 = (1'(exp_));                                                       \
    if (a1 !== e1) begin                                                       \
      tb_fail_count = tb_fail_count + 1;                                       \
      $display("FAIL %0s:%0d check1: got %b expected %b",                      \
               `__FILE__, `__LINE__, a1, e1);                                  \
    end else begin                                                             \
      tb_pass_count = tb_pass_count + 1;                                       \
      $display("PASS %0s:%0d check1: %b", `__FILE__, `__LINE__, a1);           \
    end                                                                        \
  end

// check_eq: generic X-aware equality for any width.
`define check_eq(act_, exp_)                                             \
  begin                                                                        \
    if ((act_) !== (exp_)) begin                                         \
      tb_fail_count = tb_fail_count + 1;                                       \
      $display("FAIL %0s:%0d check_eq: got %h expected %h",                    \
               `__FILE__, `__LINE__, (act_), (exp_)); \
    end else begin                                                             \
      tb_pass_count = tb_pass_count + 1;                                       \
      $display("PASS %0s:%0d check_eq: %h", `__FILE__, `__LINE__, (act_));   \
    end                                                                        \
  end

// tb_finish as macro synonym (task call of the same name).
`define TB_FINISH tb_finish;

`endif  // TB_COMMON_SV

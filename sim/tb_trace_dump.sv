// tb_trace_dump — generic file-driven RTL trace-dump TB for pio_block
// (KANBAN C12, done-when 2/3/4): replays a pio-stim v1 schedule through
// one pio_block instance and writes its SPEC-16-7 trace. The Python
// golden model (tools/pio_model) runs the identical schedule and the
// differ (tools/pio_model/difftest.py) compares the two traces — that
// harness is the C12 gate; this TB alone only proves the replay plumbing
// (trace written, one G line per clk, no X on the observables).
//
// Timeline contract (mirrors the model's step(), SPEC-16-7):
//   - 4 reset clks; rst deasserts just after the 4th posedge; clk 0 is
//     the cycle that follows, so clk-0 observables are reset values;
//   - per clk k: the schedule's gpio_in (after lb_mask folding),
//     bus op and neighbour IRQ vectors are driven for the whole cycle,
//     the G line (+ R line for a read) is sampled at the cycle's
//     negedge (outputs stable since the posedge; reg_rdata is a
//     combinational function of reg_addr + state, SPEC-16-2), and the
//     cycle-closing posedge retires every effect (CC-3).
//
// Stimulus format ($readmemh image, pio-stim v1 — tools/pio_model/stim):
//   word 0 = N (cycle count); then 6 words per cycle k:
//     6k+1 gpio_in, 6k+2 lb_mask, 6k+3 op<<9|addr (op 0/1/2 = idle/
//     write/read), 6k+4 wdata, 6k+5 nb_set<<8|nb_clr, 6k+6
//     irq_prev<<8|irq_next.
//
// Plusargs: +stim=<file> (default sim/trace_dump_smoke.mem — the
// committed squarewave case so `make sim` needs no Python), +trace=<file>
// (default build/tb_trace_dump.trace).
//
// lb_mask folds each DUT output back to its input (the tb_conf_pioexamples
// loopback idiom): gpio_in[k] = gpio_oe[k] ? gpio_out[k] : 0 — the model
// folds the identical function, so closed-loop programs run single-SM.

`include "tb_common.sv"

module tb_trace_dump;

  localparam int MAXC = 8192;   // schedule capacity (clks)

  logic clk;
  logic rst;
  tb_clk_rst u_cr (.clk(clk));

  logic [8:0]  reg_addr;
  logic [31:0] reg_wdata;
  logic        reg_write, reg_read;
  logic [31:0] reg_rdata_w;
  logic [31:0] stim_gpio, lb_mask, gpio_in;
  logic [31:0] gpio_out_w, gpio_oe_w;
  logic [7:0]  irq_prev_r, irq_next_r, nb_set, nb_clr;
  logic [7:0]  irq_prev_o_w, irq_next_o_w;
  logic [7:0]  prev_exp_set_w, prev_exp_clr_w, next_exp_set_w, next_exp_clr_w;
  logic [15:0] intr_w;

  integer stim_mem [0:6*MAXC];
  integer n, k, base, op, fd, x_seen;

  // Loopback folding (tb_conf_pioexamples lb_mask idiom).
  always @* begin
    gpio_in = stim_gpio;
    for (int p = 0; p < 32; p++)
      if (lb_mask[p]) gpio_in[p] = gpio_oe_w[p] ? gpio_out_w[p] : 1'b0;
  end

  pio_block u_dut (
      .clk            (clk),
      .rst            (rst),
      .reg_addr       (reg_addr),
      .reg_wdata      (reg_wdata),
      .reg_write      (reg_write),
      .reg_read       (reg_read),
      .reg_rdata      (reg_rdata_w),
      .gpio_in        (gpio_in),
      .gpio_out       (gpio_out_w),
      .gpio_oe        (gpio_oe_w),
      .irq_prev_r     (irq_prev_r),
      .irq_next_r     (irq_next_r),
      .nb_set         (nb_set),
      .nb_clr         (nb_clr),
      .irq_prev_o     (irq_prev_o_w),
      .irq_next_o     (irq_next_o_w),
      .prev_exp_set   (prev_exp_set_w),
      .prev_exp_clr   (prev_exp_clr_w),
      .next_exp_set   (next_exp_set_w),
      .next_exp_clr   (next_exp_clr_w),
      .intr           (intr_w),
      .dbg_sm_en      (),
      .dbg_sm_pc      (),
      .dbg_force      ()
  );

  task automatic fail(input string msg);
    begin
      tb_fail_count = tb_fail_count + 1;
      $display("FAIL %0s", msg);
    end
  endtask

  initial begin
    reg [8*256:1] stim_path, trace_path;
    // Inputs idle from time 0 (reset cycles see 0, not X).
    reg_addr = 9'd0; reg_wdata = 32'd0;
    reg_write = 1'b0; reg_read = 1'b0;
    stim_gpio = 32'd0; lb_mask = 32'd0;
    irq_prev_r = 8'd0; irq_next_r = 8'd0; nb_set = 8'd0; nb_clr = 8'd0;

    if (!$value$plusargs("stim=%s", stim_path))
      stim_path = "sim/trace_dump_smoke.mem";
    if (!$value$plusargs("trace=%s", trace_path))
      trace_path = "build/tb_trace_dump.trace";

    $readmemh(stim_path, stim_mem);
    n = stim_mem[0];
    if (n <= 0 || n > MAXC) begin
      fail($sformatf("bad schedule length %0d", n));
      `TB_FINISH
    end

    // CC-1 reset protocol: 4 clks, deassert just after the 4th edge.
    rst = 1'b1;
    repeat (4) @(posedge clk);
    rst = 1'b0;

    fd = $fopen(trace_path, "w");
    if (fd == 0) begin
      fail($sformatf("cannot open trace %0s", trace_path));
      `TB_FINISH
    end
    $fdisplay(fd, "pio-trace v1");

    x_seen = 0;
    for (k = 0; k < n; k++) begin
      // Drive cycle-k inputs at the negedge (mid-cycle): the values are
      // then stable across the cycle-closing posedge — driving right
      // after the previous posedge would race the DUT's always_ff
      // evaluation in the same timestep (tb_conf bus_wr idiom).
      @(negedge clk);
      base = 1 + 6*k;
      stim_gpio = stim_mem[base+0];
      lb_mask   = stim_mem[base+1];
      op        = stim_mem[base+2] >> 9;
      reg_addr  = stim_mem[base+2] & 32'h1ff;
      reg_wdata = stim_mem[base+3];
      nb_set    = (stim_mem[base+4] >> 8) & 32'hff;
      nb_clr    =  stim_mem[base+4]        & 32'hff;
      irq_prev_r= (stim_mem[base+5] >> 8) & 32'hff;
      irq_next_r=  stim_mem[base+5]        & 32'hff;
      reg_write = (op == 1);               // SPEC-7-x strobes, one clk
      reg_read  = (op == 2);
      #1;                                   // let the muxes settle

      $fdisplay(fd, "%0d G %08h %08h %04h", k, gpio_out_w, gpio_oe_w, intr_w);
      if (op == 2)
        $fdisplay(fd, "%0d R %03h %08h", k, reg_addr, reg_rdata_w);
      if ((^gpio_out_w) === 1'bx || (^gpio_oe_w) === 1'bx
          || (^intr_w) === 1'bx
          || ((op == 2) && (^reg_rdata_w) === 1'bx)) begin
        x_seen = x_seen + 1;
        if (x_seen == 1)
          $display("NOTE first X on observables at clk %0d (G %08h %08h %04h)",
                   k, gpio_out_w, gpio_oe_w, intr_w);
      end
      @(posedge clk);                      // cycle-closing edge (CC-3)
    end
    $fclose(fd);

    $display("trace: %0d clks -> %0s", n, trace_path);
    if (x_seen != 0) fail($sformatf("%0d clk(s) with X observables", x_seen));
    else tb_pass_count = tb_pass_count + 1;
    `TB_FINISH
  end

endmodule

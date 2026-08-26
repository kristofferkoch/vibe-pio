// tb_pio_mon — C15 spec-conformance monitors, standalone use (b): the
// rtl/pio_mon_* checkers watch one pio_block instance's gpio_out[0]
// while the TB plays bus master, running the reference programs and
// their corrupted variants (SPEC-16-9).
//
// Programs (assembled + waveform-verified against the C12 golden model
// before freezing; see the C15 commit):
//   sq_ref     E081 E101 E000 0001  wrap 3->0 : halves (2,2) — the
//              squarewave example at CLKDIV 1 (SPEC-15-x conformance
//              family), SET base 0 count 1.
//   sq_bad     E081 E301 E000 0001  wrap 3->0 : halves (4,2) — one
//              delay tampered, the wrong-"baud" corruption.
//   uart_tx9   9FA0 F728 6001 0642  wrap 3->0 : pull side 1 [7] /
//              set x,8 side 0 [7] / out pins,1 / jmp x-- [6] — 8 data
//              bits + the OSR 9th bit as even parity, 8 clk/bit
//              (CC-26 INT=1 FRAC=0: exact window), LSB first
//              (SPEC-15-3 stall-holds-idle-high between frames).
//   uart_tx9_baud  9FA0 F328 6001 0642 : start slot [3] instead of
//              [7] — 4-clk start bit, timing corruption only.
//   uart_tx9_par0  9FA0 F727 6001 0642 B742 : 8-bit loop + a forced
//              parity-0 slot (`nop side 0 [7]`) — timing clean, the
//              parity VALUE is the corruption (wrong for odd-ones
//              bytes such as 0x07, right for even-ones 0x55).
//   speq_a/b   E081 E301 E300 (+0001 / wrap 2->1) : halves (4,5) /
//              (4,4) — the spec-eq demo pair (SPEC-16-10): B is the
//              rw_wrap_speed mechanism (terminal JMP -> free wrap,
//              SPEC-8-2/CC-10, no delay compensation), so the
//              waveforms differ trace-wise but both fit the [4,5]
//              window — the CC-26 delta-sigma shape (INT=4 FRAC!=0
//              vs FRAC=0).
//
// Scenarios (SPEC-16-9 contract: violation => sticky err + halt):
//   M1 sq_ref accepted (edges counted, oe stays driven)
//   M2 sq_bad rejected as err_hi (long half) — red
//   M3 uart_tx9: two frames (0x55, 0x07) accepted, data decoded
//   M4 uart_tx9_baud rejected as err_timing — red
//   M5 uart_tx9_par0: 0x55 accepted (timing-clean control), then 0x07
//      rejected as err_frame (parity) — red
//   M6 speq_a and speq_b both accepted under the [4,5] window — the
//      sim face of the spec-eq claim (formal twin: pio_mon_spec_eq)
//
// Red/green (AGENTS.md): the rejection scenarios M2/M4/M5 are the
// non-vacuity regressions — re-inject the defect by widening the
// monitor window (BIT_HI/HALF_HI +2) or deleting the parity check and
// they FAIL (no rejection observed). Demonstrations recorded in the
// finishing commit.

`include "tb_common.sv"

module tb_pio_mon;

  logic clk;
  logic rst;
  tb_clk_rst u_cr (.clk(clk));

  // ---------------------------------------------------------------------
  // Register map (SPEC-7-x; same addresses as tb_pio_block).
  // ---------------------------------------------------------------------
  localparam logic [8:0] A_CTRL = 9'h000;                         // SPEC-7-2
  function automatic logic [8:0] A_TXF(input int i);  A_TXF  = 9'h010 + 9'(4*i); endfunction
  function automatic logic [8:0] A_IMEM(input int i); A_IMEM = 9'h048 + 9'(4*i); endfunction
  function automatic logic [8:0] A_SM(input int i, input int r);
    A_SM = 9'h0c8 + 9'(8'h18*i) + 9'(4*r);    // r: 0 CLKDIV .. 5 PINCTRL
  endfunction

  // Config words (SPEC-7-14..26 packing as tb_conf_pioexamples MFY_*):
  // uart: SIDESET_COUNT=2 (1 opt) + OUT base 0 count 1; SHIFT out/in
  // right, no autopull; EXECCTRL SIDE_EN + wrap. square: SET count 1
  // base 0; EXECCTRL wrap only.
  localparam logic [31:0] UART_PCTRL  = 32'h4010_0000;
  localparam logic [31:0] UART_SHIFT  = 32'h000C_0000;
  localparam logic [31:0] UART_EXEC_W3 = 32'h4000_3000;  // wrap 3->0 + SIDE_EN
  localparam logic [31:0] UART_EXEC_W4 = 32'h4000_4000;  // wrap 4->0 + SIDE_EN
  localparam logic [31:0] SQ_PCTRL    = 32'h0400_0000;  // SET count 1, base 0
  localparam logic [31:0] SQ_EXEC_W3  = 32'h0000_3000;  // wrap 3->0
  localparam logic [31:0] SQ_EXEC_W21 = 32'h0000_2080;  // wrap 2->1

  // Program words (header: model-verified encodings); word i lives at
  // bits [16*i +: 16] of the packed vector.
  localparam logic [79:0] SQ_REF  = {48'd0, 16'h0001, 16'hE000, 16'hE101, 16'hE081};
  localparam logic [79:0] SQ_BAD  = {48'd0, 16'h0001, 16'hE000, 16'hE301, 16'hE081};
  localparam logic [79:0] SPEQ_A  = {48'd0, 16'h0001, 16'hE300, 16'hE301, 16'hE081};
  localparam logic [79:0] SPEQ_B  = {64'd0, 16'hE300, 16'hE301, 16'hE081};
  localparam logic [79:0] UART9   = {48'd0, 16'h0642, 16'h6001, 16'hF728, 16'h9FA0};
  localparam logic [79:0] UART9B  = {48'd0, 16'h0642, 16'h6001, 16'hF328, 16'h9FA0};
  localparam logic [79:0] UART9P  = {16'hB742, 16'h0642, 16'h6001, 16'hF727, 16'h9FA0};

  // ---------------------------------------------------------------------
  // DUT + monitors (SPEC-16-9: monitors watch gpio_out only; the TB
  // checks gpio_oe separately).
  // ---------------------------------------------------------------------
  logic [8:0]  reg_addr;
  logic [31:0] reg_wdata;
  logic        reg_write, reg_read;
  logic [31:0] reg_rdata_w;
  logic [31:0] gpio_in, gpio_out_w, gpio_oe_w;
  logic [7:0]  irq_prev_r, irq_next_r, nb_set, nb_clr;
  logic [7:0]  irq_prev_o_w, irq_next_o_w;
  logic [7:0]  prev_exp_set_w, prev_exp_clr_w, next_exp_set_w, next_exp_clr_w;
  logic [15:0] intr_w;

  assign gpio_in = 32'd0;   // output-only programs (SPEC-16-9 scope)

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
      .intr           (intr_w)
  );

  logic        m_err, m_et, m_ef, m_fd;
  logic [15:0] m_frames;
  logic [7:0]  m_data;

  pio_mon_uart_tx #(.DBITS(8), .PARITY(1'b1), .BIT_LO(8), .BIT_HI(8))
      u_mon_uart (.clk(clk), .rst(rst), .rx(gpio_out_w[0]),
                  .err(m_err), .err_timing(m_et), .err_frame(m_ef),
                  .frame_done(m_fd), .frames(m_frames), .data(m_data),
                  .dbg_state(), .dbg_len(), .dbg_pos());

  logic        s_err, s_lo, s_hi;
  logic [15:0] s_edges;

  pio_mon_square #(.HALF_LO(2), .HALF_HI(2))
      u_mon_sq (.clk(clk), .rst(rst), .sig(gpio_out_w[0]),
                .err(s_err), .err_lo(s_lo), .err_hi(s_hi),
                .edge_t(), .edges(s_edges), .dbg_state(), .dbg_len());

  // The M6 spec-window instance (SPEC-16-10): [4,5] = the CC-26
  // delta-sigma shape. Shares rst, so each scenario's conf_reset
  // re-arms it; unchecked in the exact-window scenarios.
  logic        s45_err, s45_lo, s45_hi;
  logic [15:0] s45_edges;

  pio_mon_square #(.HALF_LO(4), .HALF_HI(5))
      u_mon_sq45 (.clk(clk), .rst(rst), .sig(gpio_out_w[0]),
                  .err(s45_err), .err_lo(s45_lo), .err_hi(s45_hi),
                  .edge_t(), .edges(s45_edges), .dbg_state(), .dbg_len());

  // ---------------------------------------------------------------------
  // Bus master (tb_pio_block protocol: drive at negedge, retire at the
  // posedge between).
  // ---------------------------------------------------------------------
  task automatic bus_wr(input logic [8:0] a, input logic [31:0] d);
    begin
      @(negedge clk);
      reg_addr  = a;
      reg_wdata = d;
      reg_write = 1'b1;
      @(negedge clk);
      reg_write = 1'b0;
    end
  endtask

  task automatic conf_reset;
    begin
      `DO_RESET(3)
      `WAIT_CLKS(1)
      irq_prev_r = 8'd0;
      irq_next_r = 8'd0;
      nb_set     = 8'd0;
      nb_clr     = 8'd0;
    end
  endtask

  task automatic load_prog(input logic [79:0] prog, input int n);
    begin
      for (int i = 0; i < n; i++)
        bus_wr(A_IMEM(i), 32'(prog[16*i +: 16]));   // SPEC-7-10
    end
  endtask

  task automatic enable_sm0(input logic on);
    begin
      bus_wr(A_CTRL, on ? 32'd1 : 32'd0);   // SPEC-7-2
    end
  endtask

  // putc9: feed one 9-bit word = data + computed even parity (the
  // reference feeder; monitor parity class is SPEC-16-9).
  task automatic putc9(input logic [7:0] b);
    logic p;
    begin
      p = ^b;
      bus_wr(A_TXF(0), {23'd0, p, b});      // SPEC-7-28
    end
  endtask

  // Wait until the uart monitor accepted n frames (tmo clks).
  task automatic wait_frames(input int n, input int tmo, output logic ok);
    int k;
    begin
      ok = 0;
      for (k = 0; k < tmo && !ok; k++) begin
        @(posedge clk);
        #1;
        ok = (m_frames == 16'(n));
      end
    end
  endtask

  // Wait until the square monitor counted n edges.
  task automatic wait_edges(input int n, input int tmo, output logic ok);
    int k;
    begin
      ok = 0;
      for (k = 0; k < tmo && !ok; k++) begin
        @(posedge clk);
        #1;
        ok = (s_edges >= 16'(n));
      end
    end
  endtask

  // Wait for the square monitor to halt with the expected error class.
  task automatic wait_sq_err(input logic want_hi, input int tmo, output logic ok);
    int k;
    begin
      ok = 0;
      for (k = 0; k < tmo && !ok; k++) begin
        @(posedge clk);
        #1;
        ok = s_err && (want_hi ? s_hi : s_lo);
      end
    end
  endtask

  task automatic wait_uart_err(input logic want_t, input logic want_f,
                               input int tmo, output logic ok);
    int k;
    begin
      ok = 0;
      for (k = 0; k < tmo && !ok; k++) begin
        @(posedge clk);
        #1;
        ok = m_err && (m_et == want_t) && (m_ef == want_f);
      end
    end
  endtask

  // =====================================================================
  // Scenarios.
  // =====================================================================
  task automatic m1_sq_ref;
    logic ok;
    begin
      $display("--- M1: squarewave reference accepted (halves 2,2)");
      conf_reset;
      load_prog(SQ_REF, 4);
      bus_wr(A_SM(0, 5), SQ_PCTRL);
      bus_wr(A_SM(0, 1), SQ_EXEC_W3);
      enable_sm0(1'b1);
      wait_edges(8, 60, ok);
      `check1(ok, 1'b1)
      `check1(s_err, 1'b0)
      `check1(gpio_oe_w[0], 1'b1)   // set pindirs,1 landed
      enable_sm0(1'b0);
    end
  endtask

  task automatic m2_sq_bad;
    logic ok;
    begin
      $display("--- M2: squarewave corrupted (halves 4,2) rejected");
      conf_reset;
      load_prog(SQ_BAD, 4);
      bus_wr(A_SM(0, 5), SQ_PCTRL);
      bus_wr(A_SM(0, 1), SQ_EXEC_W3);
      enable_sm0(1'b1);
      wait_sq_err(1'b1, 40, ok);    // the 4-clk half is long (SPEC-16-9)
      `check1(ok, 1'b1)
      enable_sm0(1'b0);
    end
  endtask

  task automatic m3_uart_ref;
    logic ok;
    begin
      $display("--- M3: uart_tx9 frames 0x55 + 0x07 accepted, decoded");
      conf_reset;
      load_prog(UART9, 4);
      bus_wr(A_SM(0, 5), UART_PCTRL);
      bus_wr(A_SM(0, 1), UART_EXEC_W3);
      bus_wr(A_SM(0, 2), UART_SHIFT);
      putc9(8'h55);                 // idle-high until release (SPEC-15-3)
      enable_sm0(1'b1);
      wait_frames(1, 200, ok);
      `check1(ok, 1'b1)
      `check32(m_data, 32'h55)
      `check1(m_err, 1'b0)
      putc9(8'h07);                 // second frame through the stall
      wait_frames(2, 200, ok);
      `check1(ok, 1'b1)
      `check32(m_data, 32'h07)
      `check1(m_err, 1'b0)
      enable_sm0(1'b0);
    end
  endtask

  task automatic m4_uart_baud;
    logic ok;
    begin
      $display("--- M4: uart_tx9_baud (4-clk start bit) rejected");
      conf_reset;
      load_prog(UART9B, 4);
      bus_wr(A_SM(0, 5), UART_PCTRL);
      bus_wr(A_SM(0, 1), UART_EXEC_W3);
      bus_wr(A_SM(0, 2), UART_SHIFT);
      putc9(8'h55);
      enable_sm0(1'b1);
      wait_uart_err(1'b1, 1'b0, 100, ok);   // timing class (SPEC-16-9)
      `check1(ok, 1'b1)
      enable_sm0(1'b0);
    end
  endtask

  task automatic m5_uart_par0;
    logic ok;
    begin
      $display("--- M5: uart_tx9_par0 — 0x55 accepted, 0x07 parity-rejected");
      conf_reset;
      load_prog(UART9P, 5);
      bus_wr(A_SM(0, 5), UART_PCTRL);
      bus_wr(A_SM(0, 1), UART_EXEC_W4);
      bus_wr(A_SM(0, 2), UART_SHIFT);
      putc9(8'h55);                 // forced parity 0 == correct here
      enable_sm0(1'b1);
      wait_frames(1, 200, ok);
      `check1(ok, 1'b1)
      `check1(m_err, 1'b0)          // timing-clean control
      conf_reset;
      load_prog(UART9P, 5);
      bus_wr(A_SM(0, 5), UART_PCTRL);
      bus_wr(A_SM(0, 1), UART_EXEC_W4);
      bus_wr(A_SM(0, 2), UART_SHIFT);
      putc9(8'h07);                 // forced parity 0, true parity 1
      enable_sm0(1'b1);
      wait_uart_err(1'b0, 1'b1, 200, ok);   // parity class (SPEC-16-9)
      `check1(ok, 1'b1)
      enable_sm0(1'b0);
    end
  endtask

  task automatic m6_speq_window;
    logic ok;
    begin
      $display("--- M6: spec window [4,5] accepts both (4,5) and (4,4)");
      conf_reset;
      load_prog(SPEQ_A, 4);
      bus_wr(A_SM(0, 5), SQ_PCTRL);
      bus_wr(A_SM(0, 1), SQ_EXEC_W3);
      enable_sm0(1'b1);
      for (int k = 0; k < 80 && s45_edges < 16'd6; k++) begin
        @(posedge clk);
        #1;
      end
      ok = (s45_edges >= 16'd6);
      `check1(ok, 1'b1)
      `check1(s45_err, 1'b0)
      enable_sm0(1'b0);
      conf_reset;
      load_prog(SPEQ_B, 3);
      bus_wr(A_SM(0, 5), SQ_PCTRL);
      bus_wr(A_SM(0, 1), SQ_EXEC_W21);      // wrap 2->1 (SPEC-16-10 pair)
      enable_sm0(1'b1);
      for (int k = 0; k < 80 && s45_edges < 16'd6; k++) begin
        @(posedge clk);
        #1;
      end
      ok = (s45_edges >= 16'd6);
      `check1(ok, 1'b1)
      `check1(s45_err, 1'b0)
      enable_sm0(1'b0);
    end
  endtask

  initial begin
    reg_write = 1'b0;
    reg_read  = 1'b0;
    m1_sq_ref;
    m2_sq_bad;
    m3_uart_ref;
    m4_uart_baud;
    m5_uart_par0;
    m6_speq_window;
    `TB_FINISH
  end

endmodule

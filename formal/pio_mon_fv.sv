// Formal spec-conformance harnesses for the C15 monitors (KANBAN C15)
// — the C11 miter's observables feeding rtl/pio_mon_* protocol checkers
// (SPEC-16-9), standalone (use b) and as the spec-eq comparison
// predicate (use a, SPEC-16-10). Four wrappers, one per sby task family
// (tops selected by prep), plus three red tops that no committed task
// preps (recipes in pio_mon.sby's header):
//
//   pio_mon_uart_fv  (uart_bmc + uart_cover) — one pio_block running
//   ================    uart_tx9 (pull side 1 [7] / set x,8 side 0 [7]
//                       / out pins,1 / jmp x-- [6]; 8 data bits + the
//                       OSR 9th bit as even parity, 8 clk/bit — the
//                       CC-26 INT=1 exact window), SM0 only (SPEC-16-4),
//                       deterministic prologue (imem, PINCTRL, EXECCTRL,
//                       SHIFTCTRL, CTRL), free phase confined to TXF0
//                       writes whose data carries the correct even
//                       parity (the feeder contract; SPEC-16-5/9).
//     u_noerr  the monitor accepts every frame the block transmits
//              through the horizon (SPEC-16-9) — the card's green.
//     c_frame  non-vacuity: a frame completed (cover).
//     c_data   ...and the monitor decoded a real payload (0x55).
//
//   pio_mon_sq_fv    (sq_bmc + sq_cover) — one pio_block running the
//   ================    squarewave example (halves 2,2 at CLKDIV 1;
//     s_noerr             CC-26 exact window) — accepted (SPEC-16-9).
//     s_cov               edges actually counted (cover).
//
//   pio_mon_spec_eq_fv  (eq_bmc + eq_cover) — the SPEC-16-10 twin: two
//   ==================    pio_block instances (pio_equiv_miter's
//     eq_a/eq_b            prologue discipline, SPEC-16-4/5/8) whose
//                          gpio_out[0] each feed their OWN pio_mon_square
//                          with the SAME window [4,5] (the CC-26
//                          delta-sigma shape: INT=4 with FRAC != 0 vs
//                          FRAC = 0). Program A = E081 E301 E300 0001
//                          (halves 4,5); program B = E081 E301 E300
//                          with wrap 2->1 (halves 4,4) — B is the C14
//                          rw_wrap_speed mechanism (terminal JMP ->
//                          free wrap, SPEC-8-2/CC-10, no delay
//                          compensation), so the traces differ by
//                          design while both stay inside the window:
//                          spec-eq holds where trace-eq (E1) would
//                          fail — what unlocks the spec-only speed
//                          rewrites. Each side is checked
//                          independently (an overlay breaking
//                          conformance on either side fails).
//     eq_cov               both monitors counted real edges (cover).
//
//   pio_mon_probe_fv  (mon_prove — k-induction) — the bare monitors
//   =================    under free rx/sig stimulus: the port-level
//     p1..p6               invariants of the SPEC-16-9 status contract
//                          (onehot states; HALT <-> class flags; run
//                          length/position bounds; RUN -> L >= 1;
//                          halted monitors quiet; counters monotonic;
//                          err sticky). The block-level harnesses run
//                          as BMC+cover only — their live SM needs the
//     full C5/C8/C3 invariant set for induction, which lives in the
//     per-module proofs (the pio_block_fv_b precedent).
//
// Red cases (NOT tasks — `make formal` must stay green; recipes in
// pio_mon.sby): pio_mon_uart_fv_red (uart_tx9_baud — 4-clk start bit:
// u_noerr fails at the start-bit edge), pio_mon_sq_fv_red (sq_bad —
// 4-clk half: s_noerr fails), pio_mon_spec_eq_fv_red (window [4,4]:
// eq_a fails on A's 5-clk low half). Recorded results in the sby
// header.
//
// Style: immediate assertions in always @(posedge clk) (owner
// convention); formal-only file (never compiled by iverilog).

// ===========================================================================
// uart_fv — standalone UART-TX conformance (SPEC-16-9).
// ===========================================================================
module pio_mon_uart_fv #(
    // 32 x 16-bit words, word i = PROG[16*i +: 16] (LSB = word 0).
    parameter [511:0] PROG = {{28{16'd0}},
                              16'h0642,   // word 3: jmp x--, 2    [6]
                              16'h6001,   // word 2: out pins, 1
                              16'hF728,   // word 1: set x, 8 side 0 [7]
                              16'h9FA0},  // word 0: pull block side 1 [7]
    parameter [4:0]   PROG_LEN = 5'd4,
    parameter [31:0]  SM0_EXECCTRL = 32'h4000_3000   // wrap 3->0 + SIDE_EN
) (
    input  logic        clk,
    input  logic        rst,
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr,
    input  logic        wren_free,
    input  logic [8:0]  waddr_free,
    input  logic [31:0] wdata_free
);

  logic [8:0]  reg_addr;
  logic [31:0] reg_wdata;
  logic        reg_write, reg_read;
  logic [31:0] reg_rdata;
  logic [31:0] gpio_out, gpio_oe;
  logic [7:0]  irq_prev_o, irq_next_o;
  logic [7:0]  prev_exp_set, prev_exp_clr, next_exp_set, next_exp_clr;
  logic [15:0] intr;

  // ------------------------------------------------------------------
  // Prologue sequencer (pio_equiv_miter's, SPEC-16-4): PROG_LEN imem
  // writes, then PINCTRL / EXECCTRL / SHIFTCTRL / CTRL, then free.
  // ------------------------------------------------------------------
  localparam int SEQ_STEPS = PROG_LEN + 4;

  logic [5:0] seq_r;
  logic       free_c;

  always_ff @(posedge clk) begin
    if (rst)                        seq_r <= 6'd0;
    else if (seq_r < 6'(SEQ_STEPS)) seq_r <= seq_r + 6'd1;
  end
  assign free_c = (seq_r == 6'(SEQ_STEPS));

  always_comb begin
    reg_addr  = 9'd0;
    reg_wdata = 32'd0;
    reg_write = 1'b0;
    reg_read  = 1'b0;
    if (!free_c) begin
      reg_write = 1'b1;
      if (seq_r < 6'(PROG_LEN)) begin
        reg_addr  = 9'h048 + 9'(4 * seq_r);          // SPEC-7-10
        reg_wdata = {16'd0, PROG[16*seq_r +: 16]};
      end else begin
        case (seq_r - 6'(PROG_LEN))
          6'd0: begin reg_addr = 9'h0dc; reg_wdata = 32'h4010_0000; end // PINCTRL
          6'd1: begin reg_addr = 9'h0cc; reg_wdata = SM0_EXECCTRL; end  // SPEC-7-15
          6'd2: begin reg_addr = 9'h0d0; reg_wdata = 32'h000C_0000; end // SHIFTCTRL
          default: begin reg_addr = 9'h000; reg_wdata = 32'h1; end      // CTRL
        endcase
      end
    end else begin
      // Free phase: TXF0 writes only (SPEC-16-5).
      reg_write = wren_free;
      reg_addr  = waddr_free;
      reg_wdata = wdata_free;
    end
  end

  pio_block u_dut (
      .clk (clk), .rst (rst),
      .reg_addr (reg_addr), .reg_wdata (reg_wdata),
      .reg_write (reg_write), .reg_read (reg_read), .reg_rdata (reg_rdata),
      .gpio_in (gpio_in), .gpio_out (gpio_out), .gpio_oe (gpio_oe),
      .irq_prev_r (irq_prev_r), .irq_next_r (irq_next_r),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .irq_prev_o (irq_prev_o), .irq_next_o (irq_next_o),
      .prev_exp_set (prev_exp_set), .prev_exp_clr (prev_exp_clr),
      .next_exp_set (next_exp_set), .next_exp_clr (next_exp_clr),
      .intr (intr),
      .dbg_sm_en (), .dbg_sm_pc (), .dbg_force ()
  );

  logic        m_err, m_et, m_ef, m_fd;
  logic [15:0] m_frames;
  logic [7:0]  m_data;

  pio_mon_uart_tx #(.DBITS(8), .PARITY(1'b1), .BIT_LO(8), .BIT_HI(8))
      u_mon (.clk (clk), .rst (rst), .rx (gpio_out[0]),
             .err (m_err), .err_timing (m_et), .err_frame (m_ef),
             .frame_done (m_fd), .frames (m_frames), .data (m_data),
             .dbg_state (), .dbg_len (), .dbg_pos ());

  wire [6:0] w_c = waddr_free[8:2];

  always @(posedge clk) begin
    if ($initstate) assume (rst);                                    // A1 (CC-1)
    if (free_c && wren_free) begin
      // A2/A3 (SPEC-16-5): traffic-only free writes — TXF0 (SPEC-7-28)
      // carrying the feeder's even-parity byte (SPEC-16-9).
      assume (w_c == 7'd4);
      assume (wdata_free[8] == (^wdata_free[7:0]));
    end

    if (!$initstate && !rst) begin
      // The green claim: every frame through the horizon conforms
      // (SPEC-16-9).
      u_noerr : assert (!m_err);
    end

    if (free_c) begin
      c_frame : cover (m_frames != 16'd0);                           // SPEC-16-9
      c_data  : cover (m_fd && (m_data == 8'h55));                   // SPEC-16-9
    end
  end

endmodule

// ===========================================================================
// sq_fv — standalone square-wave conformance (SPEC-16-9).
// ===========================================================================
module pio_mon_sq_fv #(
    parameter [511:0] PROG = {{28{16'd0}},
                              16'h0001,   // word 3: jmp 1
                              16'hE000,   // word 2: set pins, 0
                              16'hE101,   // word 1: set pins, 1 [1]
                              16'hE081},  // word 0: set pindirs, 1
    parameter [4:0]   PROG_LEN = 5'd4,
    parameter [31:0]  SM0_EXECCTRL = 32'h0000_3000    // wrap 3->0
) (
    input  logic        clk,
    input  logic        rst,
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr,
    input  logic        wren_free,
    input  logic [8:0]  waddr_free,
    input  logic [31:0] wdata_free
);

  logic [8:0]  reg_addr;
  logic [31:0] reg_wdata;
  logic        reg_write, reg_read;
  logic [31:0] reg_rdata;
  logic [31:0] gpio_out, gpio_oe;
  logic [7:0]  irq_prev_o, irq_next_o;
  logic [7:0]  prev_exp_set, prev_exp_clr, next_exp_set, next_exp_clr;
  logic [15:0] intr;

  // Prologue: imem, PINCTRL, EXECCTRL, CTRL (SPEC-16-4).
  localparam int SEQ_STEPS = PROG_LEN + 3;

  logic [5:0] seq_r;
  logic       free_c;

  always_ff @(posedge clk) begin
    if (rst)                        seq_r <= 6'd0;
    else if (seq_r < 6'(SEQ_STEPS)) seq_r <= seq_r + 6'd1;
  end
  assign free_c = (seq_r == 6'(SEQ_STEPS));

  always_comb begin
    reg_addr  = 9'd0;
    reg_wdata = 32'd0;
    reg_write = 1'b0;
    reg_read  = 1'b0;
    if (!free_c) begin
      reg_write = 1'b1;
      if (seq_r < 6'(PROG_LEN)) begin
        reg_addr  = 9'h048 + 9'(4 * seq_r);          // SPEC-7-10
        reg_wdata = {16'd0, PROG[16*seq_r +: 16]};
      end else begin
        case (seq_r - 6'(PROG_LEN))
          6'd0: begin reg_addr = 9'h0dc; reg_wdata = 32'h0400_0000; end // PINCTRL
          6'd1: begin reg_addr = 9'h0cc; reg_wdata = SM0_EXECCTRL; end  // SPEC-7-15
          default: begin reg_addr = 9'h000; reg_wdata = 32'h1; end      // CTRL
        endcase
      end
    end else begin
      reg_write = wren_free;
      reg_addr  = waddr_free;
      reg_wdata = wdata_free;
    end
  end

  pio_block u_dut (
      .clk (clk), .rst (rst),
      .reg_addr (reg_addr), .reg_wdata (reg_wdata),
      .reg_write (reg_write), .reg_read (reg_read), .reg_rdata (reg_rdata),
      .gpio_in (gpio_in), .gpio_out (gpio_out), .gpio_oe (gpio_oe),
      .irq_prev_r (irq_prev_r), .irq_next_r (irq_next_r),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .irq_prev_o (irq_prev_o), .irq_next_o (irq_next_o),
      .prev_exp_set (prev_exp_set), .prev_exp_clr (prev_exp_clr),
      .next_exp_set (next_exp_set), .next_exp_clr (next_exp_clr),
      .intr (intr),
      .dbg_sm_en (), .dbg_sm_pc (), .dbg_force ()
  );

  logic        s_err, s_lo, s_hi, s_et;
  logic [15:0] s_edges;

  pio_mon_square #(.HALF_LO(2), .HALF_HI(2))
      u_mon (.clk (clk), .rst (rst), .sig (gpio_out[0]),
             .err (s_err), .err_lo (s_lo), .err_hi (s_hi),
             .edge_t (s_et), .edges (s_edges), .dbg_state (), .dbg_len ());

  wire [6:0] w_c = waddr_free[8:2];

  always @(posedge clk) begin
    if ($initstate) assume (rst);                                    // A1 (CC-1)
    // A2/A3 (SPEC-16-5), minimal form: the square wave needs no bus
    // traffic — config mutation stays out of the free phase entirely.
    if (free_c) assume (!wren_free);

    if (!$initstate && !rst) begin
      // The green claim (SPEC-16-9): the 2-clk halves conform.
      s_noerr : assert (!s_err);
    end

    if (free_c) begin
      s_cov : cover (s_edges >= 16'd4);                              // SPEC-16-9
    end
  end

endmodule

// ===========================================================================
// spec_eq_fv — the SPEC-16-10 twin: monitors as the miter comparison
// predicate. Same discipline as pio_equiv_miter (SPEC-16-4/5; per-side
// EXECCTRL per SPEC-16-8), but E1..E4 are replaced by per-instance
// monitor conformance with a shared window — the spec-eq mode.
// ===========================================================================
module pio_mon_spec_eq_fv #(
    // A = E081 E301 E300 0001 (halves 4,5); B = E081 E301 E300 with
    // wrap 2->1 (halves 4,4) — the rw_wrap_speed mechanism (SPEC-16-10).
    parameter [511:0] PROG_A = {{28{16'd0}},
                                 16'h0001,   // word 3: jmp 1 (deleted in B)
                                 16'hE300,   // word 2: set pins, 0 [3]
                                 16'hE301,   // word 1: set pins, 1 [3]
                                 16'hE081},  // word 0: set pindirs, 1
    parameter [511:0] PROG_B = {{29{16'd0}},
                                 16'hE300,
                                 16'hE301,
                                 16'hE081},
    parameter [4:0]   PROG_LEN = 5'd4,
    parameter [31:0]  SM0_EXECCTRL_A = 32'h0000_3000,  // wrap 3->0
    parameter [31:0]  SM0_EXECCTRL_B = 32'h0000_2080,  // wrap 2->1
    // The spec window (SPEC-16-10): both sides must fit [SPEC_LO, SPEC_HI].
    parameter int unsigned SPEC_LO = 4,
    parameter int unsigned SPEC_HI = 5
) (
    input  logic        clk,
    input  logic        rst,
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr,
    input  logic        wren_free,
    input  logic [8:0]  waddr_free,
    input  logic [31:0] wdata_free
);

  logic [8:0]  reg_addr_a, reg_addr_b;
  logic [31:0] reg_wdata_a, reg_wdata_b;
  logic        reg_write_a, reg_write_b, reg_read_a, reg_read_b;
  logic [31:0] reg_rdata_a, reg_rdata_b;
  logic [31:0] gpio_out_a, gpio_out_b, gpio_oe_a, gpio_oe_b;
  logic [7:0]  irq_prev_o_a, irq_next_o_a, irq_prev_o_b, irq_next_o_b;
  logic [7:0]  prev_exp_set_a, prev_exp_clr_a, next_exp_set_a, next_exp_clr_a;
  logic [7:0]  prev_exp_set_b, prev_exp_clr_b, next_exp_set_b, next_exp_clr_b;
  logic [15:0] intr_a, intr_b;

  // Prologue: per-side imem (SPEC-16-4), broadcast PINCTRL, per-side
  // EXECCTRL (SPEC-16-8), broadcast CTRL.
  localparam int SEQ_STEPS = PROG_LEN + 3;

  logic [5:0] seq_r;
  logic       free_c;

  always_ff @(posedge clk) begin
    if (rst)                        seq_r <= 6'd0;
    else if (seq_r < 6'(SEQ_STEPS)) seq_r <= seq_r + 6'd1;
  end
  assign free_c = (seq_r == 6'(SEQ_STEPS));

  always_comb begin
    reg_addr_a  = 9'd0;   reg_addr_b  = 9'd0;
    reg_wdata_a = 32'd0;  reg_wdata_b = 32'd0;
    reg_write_a = 1'b0;   reg_write_b = 1'b0;
    reg_read_a  = 1'b0;   reg_read_b  = 1'b0;
    if (!free_c) begin
      reg_write_a = 1'b1;
      reg_write_b = 1'b1;
      if (seq_r < 6'(PROG_LEN)) begin
        reg_addr_a  = 9'h048 + 9'(4 * seq_r);
        reg_addr_b  = 9'h048 + 9'(4 * seq_r);
        reg_wdata_a = {16'd0, PROG_A[16*seq_r +: 16]};
        reg_wdata_b = {16'd0, PROG_B[16*seq_r +: 16]};
      end else begin
        case (seq_r - 6'(PROG_LEN))
          6'd0: begin
            reg_addr_a = 9'h0dc; reg_wdata_a = 32'h0400_0000;  // PINCTRL
            reg_addr_b = 9'h0dc; reg_wdata_b = 32'h0400_0000;
          end
          6'd1: begin
            reg_addr_a = 9'h0cc; reg_wdata_a = SM0_EXECCTRL_A; // SPEC-7-15
            reg_addr_b = 9'h0cc; reg_wdata_b = SM0_EXECCTRL_B;
          end
          default: begin
            reg_addr_a = 9'h000; reg_wdata_a = 32'h1;           // CTRL
            reg_addr_b = 9'h000; reg_wdata_b = 32'h1;
          end
        endcase
      end
    end else begin
      reg_write_a = wren_free;
      reg_write_b = wren_free;
      reg_addr_a  = waddr_free;
      reg_addr_b  = waddr_free;
      reg_wdata_a = wdata_free;
      reg_wdata_b = wdata_free;
    end
  end

  pio_block u_a (
      .clk (clk), .rst (rst),
      .reg_addr (reg_addr_a), .reg_wdata (reg_wdata_a),
      .reg_write (reg_write_a), .reg_read (reg_read_a), .reg_rdata (reg_rdata_a),
      .gpio_in (gpio_in), .gpio_out (gpio_out_a), .gpio_oe (gpio_oe_a),
      .irq_prev_r (irq_prev_r), .irq_next_r (irq_next_r),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .irq_prev_o (irq_prev_o_a), .irq_next_o (irq_next_o_a),
      .prev_exp_set (prev_exp_set_a), .prev_exp_clr (prev_exp_clr_a),
      .next_exp_set (next_exp_set_a), .next_exp_clr (next_exp_clr_a),
      .intr (intr_a),
      .dbg_sm_en (), .dbg_sm_pc (), .dbg_force ()
  );

  pio_block u_b (
      .clk (clk), .rst (rst),
      .reg_addr (reg_addr_b), .reg_wdata (reg_wdata_b),
      .reg_write (reg_write_b), .reg_read (reg_read_b), .reg_rdata (reg_rdata_b),
      .gpio_in (gpio_in), .gpio_out (gpio_out_b), .gpio_oe (gpio_oe_b),
      .irq_prev_r (irq_prev_r), .irq_next_r (irq_next_r),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .irq_prev_o (irq_prev_o_b), .irq_next_o (irq_next_o_b),
      .prev_exp_set (prev_exp_set_b), .prev_exp_clr (prev_exp_clr_b),
      .next_exp_set (next_exp_set_b), .next_exp_clr (next_exp_clr_b),
      .intr (intr_b),
      .dbg_sm_en (), .dbg_sm_pc (), .dbg_force ()
  );

  logic        a_err, a_lo, a_hi, a_et;
  logic [15:0] a_edges;
  logic        b_err, b_lo, b_hi, b_et;
  logic [15:0] b_edges;

  pio_mon_square #(.HALF_LO(SPEC_LO), .HALF_HI(SPEC_HI))
      u_mon_a (.clk (clk), .rst (rst), .sig (gpio_out_a[0]),
               .err (a_err), .err_lo (a_lo), .err_hi (a_hi),
               .edge_t (a_et), .edges (a_edges), .dbg_state (), .dbg_len ());
  pio_mon_square #(.HALF_LO(SPEC_LO), .HALF_HI(SPEC_HI))
      u_mon_b (.clk (clk), .rst (rst), .sig (gpio_out_b[0]),
               .err (b_err), .err_lo (b_lo), .err_hi (b_hi),
               .edge_t (b_et), .edges (b_edges), .dbg_state (), .dbg_len ());

  always @(posedge clk) begin
    if ($initstate) assume (rst);                                    // A1 (CC-1)
    if (free_c) assume (!wren_free);                                 // A2/A3 (SPEC-16-5)

    if (!$initstate && !rst) begin
      // SPEC-16-10: the spec-eq predicate — each side conformant to the
      // shared window through the horizon (SPEC-16-3 bounded claim).
      eq_a : assert (!a_err);
      eq_b : assert (!b_err);
    end

    if (free_c) begin
      eq_cov : cover ((a_edges >= 16'd4) && (b_edges >= 16'd4));     // SPEC-16-10
    end
  end

endmodule

// ===========================================================================
// probe_fv — the bare monitors under free stimulus, k-induction over
// the SPEC-16-9 status contract (port-level equations via dbg_*).
// Parameter-coupled constants restated here: BIT window 8/8 with
// parity => STOP_POS = 10, run-length saturation cap = 10*8 = 80,
// pos cap = 11; HALF window 2/2 => run-length cap = 2.
// ===========================================================================
module pio_mon_probe_fv (
    input  logic clk,
    input  logic rst,
    input  logic rx,
    input  logic sig
);

  logic        u_err, u_et, u_ef, u_fd;
  logic [15:0] u_frames;
  logic [7:0]  u_data;
  logic [2:0]  u_st;
  logic [15:0] u_len;
  logic [5:0]  u_pos;
  logic        s_err, s_lo, s_hi, s_et;
  logic [15:0] s_edges;
  logic [2:0]  s_st;
  logic [15:0] s_len;

  pio_mon_uart_tx #(.DBITS(8), .PARITY(1'b1), .BIT_LO(8), .BIT_HI(8))
      u_uart (.clk (clk), .rst (rst), .rx (rx),
              .err (u_err), .err_timing (u_et), .err_frame (u_ef),
              .frame_done (u_fd), .frames (u_frames), .data (u_data),
              .dbg_state (u_st), .dbg_len (u_len), .dbg_pos (u_pos));

  pio_mon_square #(.HALF_LO(2), .HALF_HI(2))
      u_sq (.clk (clk), .rst (rst), .sig (sig),
            .err (s_err), .err_lo (s_lo), .err_hi (s_hi),
            .edge_t (s_et), .edges (s_edges), .dbg_state (s_st), .dbg_len (s_len));

  localparam logic [2:0] IDLE = 3'b001, RUN = 3'b010, HALT = 3'b100;

  // Previous-cycle registers (the pio_gpio_mux_fv explicit-$past
  // replacement idiom — initializers pin the induction window's first
  // step): p_rst_r skips the rst boundary, p_err/p_frames/p_edges feed
  // the stickiness/monotonicity properties.
  logic        p_rst_r     = 1'b1;
  logic        p_u_err_r   = 1'b0;
  logic        p_s_err_r   = 1'b0;
  logic [15:0] p_u_frames_r = 16'd0;
  logic [15:0] p_s_edges_r  = 16'd0;

  always_ff @(posedge clk) begin
    p_rst_r      <= rst;
    p_u_err_r    <= u_err;
    p_s_err_r    <= s_err;
    p_u_frames_r <= u_frames;
    p_s_edges_r  <= s_edges;
  end

  always @(posedge clk) begin
    if ($initstate) assume (rst);   // A1 (CC-1) — canonical init
    if (!$initstate && !rst) begin
      // p1: onehot state encodings (SPEC-16-9).
      p1a : assert (u_st == IDLE || u_st == RUN || u_st == HALT);
      p1b : assert (s_st == IDLE || s_st == RUN || s_st == HALT);
      // p2: halted <=> a class flag is set (the sticky error, SPEC-16-9).
      p2a : assert (u_err == (u_et || u_ef));
      p2b : assert (s_err == (s_lo || s_hi));
      // p3: run-length / position bounds (the saturation caps).
      p3a : assert (u_len <= 16'd80);
      p3b : assert (s_len <= 16'd2);
      p3c : assert (u_pos <= 6'd11);
      // p4: a measured run has length >= 1.
      p4a : assert ((u_st != RUN) || (u_len != 16'd0));
      p4b : assert ((s_st != RUN) || (s_len != 16'd0));
      // p5: halted monitors are quiet.
      p5a : assert (!u_err || !u_fd);
      p5b : assert (!s_err || !s_et);
    end
    // Counters advance by at most one per clk (monotone modulo the 2^16
    // wrap — the induction counterexample that motivated this form sits
    // at the 0xffff->0 boundary), and err is sticky, across clk steps
    // that are not reset boundaries (SPEC-16-9: sticky *until rst*).
    if (!$initstate && !rst && !p_rst_r) begin
      p5c : assert ((u_frames == p_u_frames_r) || (u_frames == p_u_frames_r + 16'd1));
      p5d : assert ((s_edges == p_s_edges_r) || (s_edges == p_s_edges_r + 16'd1));
      p6a : assert (!p_u_err_r || u_err);
      p6b : assert (!p_s_err_r || s_err);
    end
  end

endmodule

// ===========================================================================
// Red cases (C15 done-when) — NOT prepped by any committed task; see
// pio_mon.sby for the reproduction recipes and recorded results.
// ===========================================================================
module pio_mon_uart_fv_red (
    input  logic        clk,
    input  logic        rst,
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr,
    input  logic        wren_free,
    input  logic [8:0]  waddr_free,
    input  logic [31:0] wdata_free
);
  // uart_tx9_baud: word 1 = F328 — `set x, 8 side 0 [3]`: a 4-clk start
  // bit, everything else identical. Expected: u_noerr fails at the
  // start-bit edge.
  pio_mon_uart_fv #(
      .PROG({{28{16'd0}},
             16'h0642, 16'h6001, 16'hF328, 16'h9FA0})
  ) u (
      .clk (clk), .rst (rst), .gpio_in (gpio_in),
      .irq_prev_r (irq_prev_r), .irq_next_r (irq_next_r),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .wren_free (wren_free), .waddr_free (waddr_free), .wdata_free (wdata_free)
  );
endmodule

module pio_mon_sq_fv_red (
    input  logic        clk,
    input  logic        rst,
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr,
    input  logic        wren_free,
    input  logic [8:0]  waddr_free,
    input  logic [31:0] wdata_free
);
  // sq_bad: word 1 = E301 — `set pins, 1 [3]`: halves (4,2) against the
  // [2,2] window. Expected: s_noerr fails at the first falling edge.
  pio_mon_sq_fv #(
      .PROG({{28{16'd0}},
             16'h0001, 16'hE000, 16'hE301, 16'hE081})
  ) u (
      .clk (clk), .rst (rst), .gpio_in (gpio_in),
      .irq_prev_r (irq_prev_r), .irq_next_r (irq_next_r),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .wren_free (wren_free), .waddr_free (waddr_free), .wdata_free (wdata_free)
  );
endmodule

module pio_mon_spec_eq_fv_red (
    input  logic        clk,
    input  logic        rst,
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr,
    input  logic        wren_free,
    input  logic [8:0]  waddr_free,
    input  logic [31:0] wdata_free
);
  // The tight spec [4,4]: A's 5-clk low half violates it — expected
  // eq_a fails (the monitor actually gates the predicate; non-vacuity
  // for the spec-eq claim).
  pio_mon_spec_eq_fv #(
      .SPEC_LO(4),
      .SPEC_HI(4)
  ) u (
      .clk (clk), .rst (rst), .gpio_in (gpio_in),
      .irq_prev_r (irq_prev_r), .irq_next_r (irq_next_r),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .wren_free (wren_free), .waddr_free (waddr_free), .wdata_free (wdata_free)
  );
endmodule

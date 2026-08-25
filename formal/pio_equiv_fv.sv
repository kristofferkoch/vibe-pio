// Formal trace-equivalence miter for pio_block (KANBAN C11) — the
// observable-contract proof, generalizing the pio_sm_regs_fv lockstep
// twin (P7/CC-27) from one divider to two whole blocks.
//
// Two pio_block instances run in lockstep on shared clk/rst and shared
// free stimulus. A deterministic prologue sequencer (the pio_block_fv_b
// pattern) writes program A into u_a's imem and program B into u_b's
// (word-serial INSTR_MEM writes, SPEC-7-10), then broadcasts one SM0
// EXECCTRL wrap write and the CTRL write enabling SM0. The free phase
// then broadcasts identical reg writes and reads (imem window excluded
// by assumption, CC-33) and identical gpio_in / IRQ-neighbour stimulus.
//
// Properties (asserted every clk, no windowing — SPEC-16-1):
//   E1  gpio_out[31:0] equal            — SPEC-16-1
//   E2  gpio_oe[31:0] equal             — SPEC-16-1
//   E3  intr[15:0] equal (SPEC-7-12)    — SPEC-16-1
//   E4  reg_rdata equal at every reg_addr outside the exclusion window
//       (SMx_INSTR = imem[pc] SPEC-7-24, SMx_ADDR = pc SPEC-7-22);
//       SMx_EXECCTRL compared with bit 31 masked (EXEC_STALLED overlay,
//       SPEC-7-15) — SPEC-16-2. reg_rdata is a pure function of state,
//       so E4 runs every clk, not just on read strobes; the strobes'
//       side effects (RXF pop SPEC-7-28, PUTGET SPEC-7-13) are issued
//       identically, which is what compares RX data order.
//   Reads are taken at an anyconst reg-bus address (the pio_instr_mem_fv
//   idiom): fixed per trace, universally quantified by BMC, so every
//   address is covered without widening the state.
//
// Assumptions:
//   A1  rst asserted in the initial state (CC-1 protocol); after that
//       rst is free — a mid-trace reset re-runs the prologue on both
//       instances symmetrically (programs are re-written), so the
//       equivalence claim is unaffected.
//   A2  free-phase writes exclude the INSTR_MEM window (SPEC-16-5,
//       CC-33): program text is fixed at load; the claim quantifies
//       over the loaded pair only.
//   A3  free-phase writes are bus TRAFFIC only — TXF0 (SPEC-7-28),
//       FDEBUG W1C (SPEC-7-29), IRQ/IRQ_FORCE (SPEC-7-6) and
//       INPUT_SYNC_BYPASS (SPEC-7-7) — broadcast identically. All
//       config mutation stays out of the free phase: CTRL (SM1..3 stay
//       disabled, SM0 enabled — SPEC-16-4), the INSTR_MEM window (A2),
//       the SMx config windows, SMx_INSTR force writes and the PUTGET
//       window (SPEC-16-6: mid-run config rewrites are the C14
//       config-overlay extension point; v1 claims instruction-stream
//       equivalence under fixed config only). Measured justification:
//       free CLKDIV writes (divider counters, CC-26) and free
//       SM0_INSTR force writes (tick deferral, CC-36) each alone stall
//       the solvers past step ~13/14 at doubled design size, and the
//       wider EXECCTRL/SHIFTCTRL/PINCTRL/PUTGET set past step ~17;
//       DESIGN.md §k-induction tractability decouples exactly these
//       two mechanisms into their per-module proofs.
//
// Scope (SPEC-16-3): bounded equivalence only — BMC depth N is the
// horizon (default 48 clk = 7 prologue + 41 free ticks at the reset
// CLKDIV INT=1); k-induction over the twin is out of scope. Config
// overlays / spec-conformance predicates are C14/C15's extension points
// (SPEC-16-6). The shared trace exchange format induced by this
// observable contract (emitted by the C12 model and RTL trace-dump TBs,
// consumed by the C13 differ) is SPEC-16-7.
//
// Default program pair (5 words, wrap 4->0): both run
//   pull block / set pins,1 [1] / <word2> / set pins,0 [1] / push block
// with word2 = `nop` = mov y,y (SPEC-3.6-10) in A and `mov x,x`
// (SPEC-3.6-2) in B — structurally different (imem really differs), yet
// X and Y are never otherwise written or read, so every observable is
// identical: the non-vacuity demo for the green case.
//
// Red case: pio_equiv_miter_red (bottom of file) = same pair with B's
// word1 flipped to `set pins,0 [1]` — the card's "flipped pin polarity"
// inequivalence. Reproduce (temporary task file, never committed —
// `make formal` must stay green):
//   cd formal && sed 's/prep -top pio_equiv_miter$/prep -top pio_equiv_miter_red/' \
//       pio_equiv.sby > pio_equiv_red.sby && sby -f pio_equiv_red.sby bmc
//   rm -rf pio_equiv_red.sby pio_equiv_red_bmc
// Recorded result (2026-08-25): e_out fails at step 12 — the first clk
// after the `set pins` tick of the first fed loop (TXF0 write at free
// step 8, PULL released, gpio_out[0] 1 vs 0); the anyconst read
// address in the witness was 83 (arbitrary — gpio is where the pair
// diverges, not any CPU-visible read).
//
// Style: immediate assertions in always @(posedge clk) (owner
// convention); formal-only file (never compiled by iverilog).

module pio_equiv_miter #(
    // 32 x 16-bit words, word i = PROG_x[16*i +: 16] (LSB = word 0).
    parameter [511:0] PROG_A = {{27{16'd0}},
                                16'h8020,   // word 4: push block     (SPEC-2-11)
                                16'hE100,   // word 3: set pins,0 [1] (SPEC-3.9-1, SPEC-4-6)
                                16'hA042,   // word 2: mov y, y = nop (SPEC-3.6-10)
                                16'hE101,   // word 1: set pins,1 [1]
                                16'h80A0},  // word 0: pull block     (SPEC-2-13)
    parameter [511:0] PROG_B = {{27{16'd0}},
                                16'h8020,
                                16'hE100,
                                16'hA021,   // word 2: mov x, x (SPEC-3.6-2) — A/B differ here
                                16'hE101,
                                16'h80A0},
    parameter [4:0]   PROG_LEN     = 5'd5,          // words to load
    parameter [31:0]  SM0_EXECCTRL = 32'h0000_4000  // wrap 4->0 (SPEC-7-15 wrap fields)
) (
    input  logic        clk,
    input  logic        rst,
    // Free stimulus (anyseq at the sby top), broadcast to both
    // instances (SPEC-16-5).
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr,
    // Free-phase write channel (reads use the anyconst address below).
    input  logic        wren_free,
    input  logic [8:0]  waddr_free,
    input  logic [31:0] wdata_free
);

  // Per-instance reg-bus nets (driven by the prologue mux below).
  logic [8:0]  reg_addr_a, reg_addr_b;
  logic [31:0] reg_wdata_a, reg_wdata_b;
  logic        reg_write_a, reg_write_b;
  logic        reg_read_a, reg_read_b;

  logic [31:0] reg_rdata_a, reg_rdata_b;
  logic [31:0] gpio_out_a, gpio_out_b, gpio_oe_a, gpio_oe_b;
  logic [7:0]  irq_prev_o_a, irq_prev_o_b, irq_next_o_a, irq_next_o_b;
  logic [7:0]  prev_exp_set_a, prev_exp_set_b, prev_exp_clr_a, prev_exp_clr_b;
  logic [7:0]  next_exp_set_a, next_exp_set_b, next_exp_clr_a, next_exp_clr_b;
  logic [15:0] intr_a, intr_b;

  // ------------------------------------------------------------------
  // Prologue sequencer (pio_block_fv_b pattern): PROG_LEN imem writes,
  // one SM0 EXECCTRL write, one CTRL write, then the free phase.
  // Mid-trial rst restarts it symmetrically (A1).
  // ------------------------------------------------------------------
  localparam int SEQ_STEPS = PROG_LEN + 2;

  logic [5:0] seq_r;
  logic       free_c;

  always_ff @(posedge clk) begin
    if (rst)                     seq_r <= 6'd0;
    else if (seq_r < 6'(SEQ_STEPS)) seq_r <= seq_r + 6'd1;
  end
  assign free_c = (seq_r == 6'(SEQ_STEPS));

  // Anyconst observed read address (pio_instr_mem_fv idiom) — SPEC-16-2.
  (* anyconst *) logic [8:0] ra;

  always_comb begin
    reg_addr_a  = 9'd0;   reg_addr_b  = 9'd0;
    reg_wdata_a = 32'd0;  reg_wdata_b = 32'd0;
    reg_write_a = 1'b0;   reg_write_b = 1'b0;
    reg_read_a  = 1'b0;   reg_read_b  = 1'b0;
    if (!free_c) begin
      if (seq_r < 6'(PROG_LEN)) begin
        // Programs diverge here and only here (SPEC-7-10, SPEC-16-4).
        reg_addr_a  = 9'h048 + 9'(4 * seq_r);
        reg_addr_b  = 9'h048 + 9'(4 * seq_r);
        reg_wdata_a = {16'd0, PROG_A[16*seq_r +: 16]};
        reg_wdata_b = {16'd0, PROG_B[16*seq_r +: 16]};
        reg_write_a = 1'b1;
        reg_write_b = 1'b1;
      end else if (seq_r == 6'(PROG_LEN)) begin
        reg_addr_a  = 9'h0cc;             // SM0_EXECCTRL (SPEC-7-15)
        reg_addr_b  = 9'h0cc;
        reg_wdata_a = SM0_EXECCTRL;
        reg_wdata_b = SM0_EXECCTRL;
        reg_write_a = 1'b1;
        reg_write_b = 1'b1;
      end else begin
        reg_addr_a  = 9'h000;             // CTRL: enable SM0 (SPEC-7-2)
        reg_addr_b  = 9'h000;
        reg_wdata_a = 32'h1;
        reg_wdata_b = 32'h1;
        reg_write_a = 1'b1;
        reg_write_b = 1'b1;
      end
    end else begin
      // Free phase: one bus op per clk — a broadcast write (A2/A3
      // constrain the address) or a read at the anyconst address.
      reg_write_a = wren_free;
      reg_write_b = wren_free;
      reg_wdata_a = wdata_free;
      reg_wdata_b = wdata_free;
      reg_addr_a  = wren_free ? waddr_free : ra;
      reg_addr_b  = wren_free ? waddr_free : ra;
      reg_read_a  = !wren_free;
      reg_read_b  = !wren_free;
    end
  end

  // ------------------------------------------------------------------
  // The twin (generalizes pio_sm_regs_fv's u_dut/u_dut2).
  // ------------------------------------------------------------------
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

  // ------------------------------------------------------------------
  // Shared-address window decode (pio_block's sm window map).
  // ------------------------------------------------------------------
  logic [6:0] w_c;
  logic       smhit_c;
  logic [2:0] smreg_c;

  assign w_c    = reg_addr_a[8:2];               // identical buses by construction
  assign smhit_c = (w_c >= 7'd50) && (w_c <= 7'd73);
  assign smreg_c = 3'((w_c - 7'd50) % 7'd6);

  // Sticky "pin has been high" for the loop cover.
  logic saw_hi_r = 1'b0;
  always_ff @(posedge clk) begin
    if (rst)     saw_hi_r <= 1'b0;
    else         saw_hi_r <= saw_hi_r || gpio_out_a[0];
  end

  always @(posedge clk) begin
    if ($initstate) assume (rst);                                    // A1 (CC-1)
    if (free_c && reg_write_a) begin
      // A2 (SPEC-16-5, CC-33): no INSTR_MEM rewrites in the free phase.
      assume (!((w_c >= 7'd18) && (w_c <= 7'd49)));
      // A3 (SPEC-16-5/6 + header): traffic-only free writes — config
      // mutation (CTRL, SMx config/force/PUTGET windows) is C14's
      // config-overlay extension point, out of v1's fixed-config claim.
      assume ((w_c == 7'd4)                            // TXF0      (SPEC-7-28)
              || (w_c == 7'd2)                         // FDEBUG W1C (SPEC-7-29)
              || (w_c == 7'd12) || (w_c == 7'd13)      // IRQ / IRQ_FORCE (SPEC-7-6)
              || (w_c == 7'd14));                      // ISB        (SPEC-7-7)
    end

    if (!$initstate && !rst) begin
      // E1..E3: per-clk observables (SPEC-16-1).
      e_out  : assert (gpio_out_a == gpio_out_b);
      e_oe   : assert (gpio_oe_a == gpio_oe_b);
      e_intr : assert (intr_a == intr_b);                           // SPEC-7-12

      // E4: CPU-visible read observables (SPEC-16-2). Exclusions:
      // SMx_INSTR (smreg 4, SPEC-7-24) and SMx_ADDR (smreg 3,
      // SPEC-7-22); EXECCTRL (smreg 1) masked on bit 31 (SPEC-7-15).
      if (!smhit_c || ((smreg_c != 3'd3) && (smreg_c != 3'd4)))
        e_rd  : assert (reg_rdata_a == reg_rdata_b);
      else if (smreg_c == 3'd1)
        e_rdx : assert (reg_rdata_a[30:0] == reg_rdata_b[30:0]);

      // Covers (cover task): the comparison is exercised on live data,
      // not vacuously.
      if (free_c) begin
        // Program really ran: a TXF0 write released the PULL and
        // `set pins,1` landed (SPEC-16-4 init protocol end-to-end).
        if (gpio_out_a[0])                     c_pin_hi : cover (1'b1);
        // ...and the loop wrapped back to `set pins,0` (CC-10).
        if (saw_hi_r && !gpio_out_a[0])        c_pin_lo : cover (1'b1);
        // FLEVEL read observing a non-empty RX0 (the PUSH landed).
        if (reg_read_a && (w_c == 7'd3) && (reg_rdata_a[7:4] != 4'd0))
          c_flvl : cover (1'b1);
        // A popping RXF0 read with data in flight — data-order compare.
        if (reg_read_a && (w_c == 7'd8) && intr_a[0])
          c_rxf : cover (1'b1);
      end
    end
  end

endmodule

// ===========================================================================
// Red case (C11 done-when): B's word 1 flipped to `set pins,0 [1]` —
// identical everything except one polarity bit, so the first `set pins`
// execution drives gpio_out[0] to 1 on A and 0 on B. Not prepped by any
// committed sby task (`make formal` stays green); see the header for the
// reproduction recipe. Expected: e_out fails at the first divergent clk.
// ===========================================================================
module pio_equiv_miter_red (
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
  pio_equiv_miter #(
      .PROG_B({{27{16'd0}},
               16'h8020,
               16'hE100,
               16'hA021,
               16'hE100,   // word 1: set pins,0 [1] — the flipped polarity
               16'h80A0})
  ) u (
      .clk (clk), .rst (rst),
      .gpio_in (gpio_in),
      .irq_prev_r (irq_prev_r), .irq_next_r (irq_next_r),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .wren_free (wren_free), .waddr_free (waddr_free), .wdata_free (wdata_free)
  );
endmodule

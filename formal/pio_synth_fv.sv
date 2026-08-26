// Formal symbolic-program synthesis harness (KANBAN C16) — free imem
// words + the C15 monitors as cover goals (SPEC-16-11).
//
// Mechanism (ratified at launch): pio_instr_mem's default-off SYM
// parameter, enabled here only by the sby script's
// `chparam -set SYM 1 pio_instr_mem` — the 32 words become one flat
// anyconst vector with no reset and no write port, the surrounding RTL
// (all four SMs) untouched (DESIGN.md §Symbolic-friendliness; SPEC-16-11).
// The harness then fixes the SM0 config via a deterministic prologue
// (SPEC-16-4's discipline, minus the word-serial imem writes the free
// words replace) and lets the solver search the program space for a
// witness that satisfies a C15 monitor cover goal (SPEC-16-9) —
// cover/BMC only, never k-induction (SPEC-16-3; the anyconst words make
// induction meaningless: the state space is the program space).
//
// Tops (one per sby task family):
//
//   pio_synth_sq_fv    (sq_cover) — square-wave smoke target: the
//   ================    [2,2]-window monitor counting >= 8 edges with
//                       gpio_oe[0] driven (a real pad). Window [2,2] is
//                       the CC-26 exact window at CLKDIV 1 (reset value,
//                       no CLKDIV write — INT=1 FRAC=0).
//
//   pio_synth_uart_fv  (uart_cover) — UART-TX-byte real target: one
//   ==================    accepted frame (start + 8 data + even parity
//                       + stop, SPEC-16-9) with payload 0x55 and
//                       gpio_oe[0] driven. BIT window [2,2] — the same
//                       CC-26 exact-window discipline as sq, sized for
//                       a bounded-horizon search (a frame is 11 slots x
//                       2 clk; the growth path to wider windows is
//                       cover-mining protocol masters, SPEC-16-11).
//
//   pio_synth_red_fv   (NOT a task — red case, `make formal` stays
//   ================    green): the contradictory spec — the same pin
//                       feeding two square monitors with windows [2,2]
//                       and [3,3]; a half-period cannot be both 2 and 3
//                       clk, so the cover is UNSAT at every depth: the
//                       non-vacuity demo that the solver really reads
//                       the monitor goals (SPEC-16-11). Reproduce:
//                         cd formal && sed 's/prep -top pio_synth_sq_fv$/\
//prep -top pio_synth_red_fv/' pio_synth.sby > pio_synth_red.sby \
//                           && sby -f pio_synth_red.sby sq_cover \
//                           && rm -rf pio_synth_red.sby pio_synth_red_sq_cover
//                       (recorded result in pio_synth.sby's header).
//
// FREE/PROG reuse (SPEC-16-12): each target top takes FREE (default 1 =
// synthesis cover) and, for FREE=0, PROG/PROG_LEN/HORIZON — the same
// prologue then loads the concrete witness words word-serially
// (SPEC-7-10) and a sticky goal-moment flag gates the standing
// assertion (goal_hit || !err), so tools/hypersynth.py re-runs the
// *same* harness as a bounded-conformance BMC on the extracted witness
// (the C16 re-verify step; SPEC-16-12). The wrapper's replay of the
// witness environment (gpio_in / IRQ neighbours) is the generated
// top's job — see hypersynth's case_sv().

// ===========================================================================
// sq_fv — square-wave synthesis target (SPEC-16-9/11).
// ===========================================================================
module pio_synth_sq_fv #(
    // SPEC-16-11 mode select: 1 = free words + cover (synthesis),
    // 0 = load PROG + assert conformance (SPEC-16-12 witness re-verify).
    parameter bit        FREE     = 1'b1,
    // 32 x 16-bit words, word i = PROG[16*i +: 16] (LSB = word 0).
    parameter [511:0]    PROG     = 512'd0,
    parameter [5:0]      PROG_LEN = 6'd32,
    // The spec window [HALF, HALF] (CC-26 exact; monitor parameter).
    parameter int unsigned HALF   = 2
) (
    input  logic        clk,
    input  logic        rst,
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr
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
  // Prologue (pio_equiv_miter's discipline, SPEC-16-4/11): in FREE mode
  // config only — PINCTRL (SET base 0 count 1), EXECCTRL (wrap 31->0),
  // CTRL (SM0 enable, SM1..3 stay disabled per SPEC-16-4 scoping); in
  // conformance mode PROG_LEN imem writes precede them (SPEC-7-10).
  // CLKDIV stays at reset (INT=1 FRAC=0 — the CC-26 exact window's
  // divider), SHIFTCTRL at reset (OUT/IN shift right).
  // ------------------------------------------------------------------
  localparam int SEQ_STEPS = (FREE ? 0 : PROG_LEN) + 3;

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
    reg_write = 1'b1;
    reg_read  = 1'b0;
    if (!free_c) begin
      if (!FREE && (seq_r < PROG_LEN)) begin
        reg_addr  = 9'h048 + 9'(4 * seq_r);               // SPEC-7-10
        reg_wdata = {16'd0, PROG[16*seq_r +: 16]};
      end else begin
        case (seq_r - (FREE ? 6'd0 : PROG_LEN))
          6'd0: begin reg_addr = 9'h0dc; reg_wdata = 32'h0400_0000; end // PINCTRL
          6'd1: begin reg_addr = 9'h0cc; reg_wdata = 32'h0000_0000; end // SPEC-7-15
          default: begin reg_addr = 9'h000; reg_wdata = 32'h1; end      // CTRL
        endcase
      end
    end else begin
      // Free phase: no bus traffic at all — the synthesized programs
      // are self-contained (SPEC-16-5's traffic-only rule degenerates:
      // there is nothing the feeder needs to feed).
      reg_write = 1'b0;
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

  pio_mon_square #(.HALF_LO(HALF), .HALF_HI(HALF))
      u_mon (.clk (clk), .rst (rst), .sig (gpio_out[0]),
             .err (s_err), .err_lo (s_lo), .err_hi (s_hi),
             .edge_t (s_et), .edges (s_edges), .dbg_state (), .dbg_len ());

  // SPEC-16-12 leg (c): the conformance claim is the cover's claim on
  // the loaded program — the goal moment arrives (sticky goal_hit_r)
  // with the monitor error-free up to and including it. An error before
  // the goal fails; one after passes (the bounded claim is through the
  // goal, SPEC-16-3 — a boundary-riding witness is legal for any finite
  // horizon, and over-checking past it would reject it arbitrarily).
  // The goal-must-fire half of the claim is the sim TB's check (leg b).
  logic goal_hit_r;

  always_ff @(posedge clk) begin
    if (rst) goal_hit_r <= 1'b0;
    else     goal_hit_r <= goal_hit_r || ((s_edges >= 16'd8) && gpio_oe[0] && !s_err);
  end

  always @(posedge clk) begin
    if ($initstate) assume (rst);                                    // A1 (CC-1)
    // A2 (SPEC-16-4/5 scoping, SPEC-16-11): the target is a self-contained
    // output protocol — pin the environment idle (gpio_in and the IRQ
    // neighbour views 0) so a witness is a program of the machine, not of
    // the free inputs. This also keeps the witness replay-equivalent: the
    // re-verification prologue (word-serial load, SPEC-16-12) is 32 clks
    // longer than this run's, and an input-dependent program could
    // otherwise ride the input synchronizers' 2-clk ghost (CC-23) of a
    // prologue-phase environment that the replay cannot reproduce.
    assume ((gpio_in == 32'd0) && (irq_prev_r == 8'd0) && (irq_next_r == 8'd0));
    assume ((nb_set == 8'd0) && (nb_clr == 8'd0));

    // !$initstate excludes the free (pre-reset) initial state — without
    // it the cover is vacuously satisfiable at step 0 from arbitrary
    // init values (seq_r, monitor counters); !rst keeps it out of the
    // reset boundary itself (the pio_equiv_miter cover-guard idiom).
    if (!$initstate && !rst && free_c) begin
      // SPEC-16-11: the synthesis goal — >= 8 accepted edges (>= 4 full
      // periods) with the pad actually driven (oe) and the monitor still
      // live (a toggle-then-stall program is not a square wave).
      sq_cov : cover ((s_edges >= 16'd8) && gpio_oe[0] && !s_err); // SPEC-16-9
    end
    if (!FREE && !$initstate && !rst && free_c) begin
      // SPEC-16-12: witness conformance — error-free through the goal.
      sq_conf : assert (goal_hit_r || !s_err);                       // SPEC-16-9
    end
  end

endmodule

// ===========================================================================
// uart_fv — UART-TX-byte synthesis target (SPEC-16-9/11).
// ===========================================================================
module pio_synth_uart_fv #(
    parameter bit        FREE     = 1'b1,
    parameter [511:0]    PROG     = 512'd0,
    parameter [5:0]      PROG_LEN = 6'd32,
    parameter int unsigned BIT    = 2,   // [BIT, BIT] window per bit-time (CC-26)
    parameter [7:0]      PAYLOAD  = 8'h55 // the cover's decoded data (SPEC-16-9)
) (
    input  logic        clk,
    input  logic        rst,
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr
);

  logic [8:0]  reg_addr;
  logic [31:0] reg_wdata;
  logic        reg_write, reg_read;
  logic [31:0] reg_rdata;
  logic [31:0] gpio_out, gpio_oe;
  logic [7:0]  irq_prev_o, irq_next_o;
  logic [7:0]  prev_exp_set, prev_exp_clr, next_exp_set, next_exp_clr;
  logic [15:0] intr;

  localparam int SEQ_STEPS = (FREE ? 0 : PROG_LEN) + 3;

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
    reg_write = 1'b1;
    reg_read  = 1'b0;
    if (!free_c) begin
      if (!FREE && (seq_r < PROG_LEN)) begin
        reg_addr  = 9'h048 + 9'(4 * seq_r);               // SPEC-7-10
        reg_wdata = {16'd0, PROG[16*seq_r +: 16]};
      end else begin
        case (seq_r - (FREE ? 6'd0 : PROG_LEN))
          6'd0: begin reg_addr = 9'h0dc; reg_wdata = 32'h0400_0000; end // PINCTRL
          6'd1: begin reg_addr = 9'h0cc; reg_wdata = 32'h0000_0000; end // SPEC-7-15
          default: begin reg_addr = 9'h000; reg_wdata = 32'h1; end      // CTRL
        endcase
      end
    end else begin
      reg_write = 1'b0;
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

  pio_mon_uart_tx #(.DBITS(8), .PARITY(1'b1), .BIT_LO(BIT), .BIT_HI(BIT))
      u_mon (.clk (clk), .rst (rst), .rx (gpio_out[0]),
             .err (m_err), .err_timing (m_et), .err_frame (m_ef),
             .frame_done (m_fd), .frames (m_frames), .data (m_data),
             .dbg_state (), .dbg_len (), .dbg_pos ());

  // SPEC-16-12 leg (c), sq twin: error-free through the goal moment
  // (the accepted PAYLOAD frame); the goal-must-fire half is leg (b).
  logic goal_hit_r;

  always_ff @(posedge clk) begin
    if (rst) goal_hit_r <= 1'b0;
    else     goal_hit_r <= goal_hit_r || (m_fd && (m_data == PAYLOAD) && gpio_oe[0] && !m_err);
  end

  always @(posedge clk) begin
    if ($initstate) assume (rst);                                    // A1 (CC-1)
    // A2: environment pinned idle — see pio_synth_sq_fv's A2 (SPEC-16-11).
    assume ((gpio_in == 32'd0) && (irq_prev_r == 8'd0) && (irq_next_r == 8'd0));
    assume ((nb_set == 8'd0) && (nb_clr == 8'd0));

    if (!$initstate && !rst && free_c) begin
      // SPEC-16-11: the synthesis goal — one accepted frame whose
      // decoded payload is the nontrivial byte PAYLOAD, with the pad
      // driven and the monitor still live. Nontrivial: 0x55's
      // alternating bits force every slot boundary to be real (start 0,
      // bits 1,0,1,... then even parity 0 merged into the trailing
      // ones-run, SPEC-16-9).
      uart_cov : cover (m_fd && (m_data == PAYLOAD) && gpio_oe[0] && !m_err); // SPEC-16-9
    end
    if (!FREE && !$initstate && !rst && free_c) begin
      // SPEC-16-12: witness conformance — error-free through the goal.
      uart_conf : assert (goal_hit_r || !m_err);                     // SPEC-16-9
    end
  end

endmodule

// ===========================================================================
// red_fv — the contradictory spec (NOT prepped by any committed task):
// [2,2] AND [3,3] on the same pin. Whatever the words, one monitor halts
// before its 8th edge — the joint cover is UNSAT at every depth.
// Self-contained (no hierarchical probes — yosys cannot see into
// instances, the pio_sm dbg-port rationale); mirrors pio_synth_sq_fv.
// ===========================================================================
module pio_synth_red_fv (
    input  logic        clk,
    input  logic        rst,
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr
);

  logic [8:0]  reg_addr;
  logic [31:0] reg_wdata;
  logic        reg_write, reg_read;
  logic [31:0] reg_rdata;
  logic [31:0] gpio_out, gpio_oe;
  logic [7:0]  irq_prev_o, irq_next_o;
  logic [7:0]  prev_exp_set, prev_exp_clr, next_exp_set, next_exp_clr;
  logic [15:0] intr;

  localparam int SEQ_STEPS = 3;

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
    reg_write = 1'b1;
    reg_read  = 1'b0;
    if (!free_c) begin
      case (seq_r)
        6'd0: begin reg_addr = 9'h0dc; reg_wdata = 32'h0400_0000; end // PINCTRL
        6'd1: begin reg_addr = 9'h0cc; reg_wdata = 32'h0000_0000; end // SPEC-7-15
        default: begin reg_addr = 9'h000; reg_wdata = 32'h1; end      // CTRL
      endcase
    end else begin
      reg_write = 1'b0;
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

  logic        e22, e22_lo, e22_hi, e22_et;
  logic [15:0] n22;
  logic        e33, e33_lo, e33_hi, e33_et;
  logic [15:0] n33;

  pio_mon_square #(.HALF_LO(2), .HALF_HI(2))
      u_mon22 (.clk (clk), .rst (rst), .sig (gpio_out[0]),
               .err (e22), .err_lo (e22_lo), .err_hi (e22_hi),
               .edge_t (e22_et), .edges (n22), .dbg_state (), .dbg_len ());
  pio_mon_square #(.HALF_LO(3), .HALF_HI(3))
      u_mon33 (.clk (clk), .rst (rst), .sig (gpio_out[0]),
               .err (e33), .err_lo (e33_lo), .err_hi (e33_hi),
               .edge_t (e33_et), .edges (n33), .dbg_state (), .dbg_len ());

  always @(posedge clk) begin
    if ($initstate) assume (rst);                                    // A1 (CC-1)
    // A2: environment pinned idle — see pio_synth_sq_fv's A2 (SPEC-16-11).
    assume ((gpio_in == 32'd0) && (irq_prev_r == 8'd0) && (irq_next_r == 8'd0));
    assume ((nb_set == 8'd0) && (nb_clr == 8'd0));
    if (!$initstate && !rst && free_c) begin
      // SPEC-16-11 non-vacuity: no program satisfies both windows —
      // the solver must prove the cover unreachable (UNSAT).
      red_cov : cover ((n22 >= 16'd8) && (n33 >= 16'd8));
    end
  end

endmodule

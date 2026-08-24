// Formal properties for pio_irq_flags (KANBAN C6).
//
// Wrapper instantiates the DUT and checks (bmc + prove):
//   P1  reset default: flags == 0 after rst (SPEC-7-6 register reset
//       family; DESIGN.md reset/formal).
//   P2  registered flags / exact next-state equation: flags equal
//       (prev flags | prev set vector) & ~prev clear vector — per-bit
//       RMW at one edge, clear wins (CC-39). This subsumes "no change
//       without a writer" (no combinational request→read path) and
//       next-cycle-only visibility (CC-37): current-cycle request
//       vectors do not appear in the equation for current flags.
//   P3  clear-wins corners (CC-39): a same-cycle set+clear of one flag
//       (SM vs SM, force vs W1C) leaves it 0.
//   P4  IdxMode routing (SPEC-3.8-4..7): the combinational export buses
//       equal a reference decode over the current PREV/NEXT-mode
//       requests, and P2's equation already pins THIS/REL locality —
//       PREV/NEXT-mode requests never appear in the local write
//       vectors (checked structurally: ref_loc_* only fold modes 00/10).
//   P5  relay outputs equal the registered flags (CC-38 source stage;
//       the inter-block register is pio_top's).
//
// Assumption: reset asserted in the initial state (CC-1 protocol).
//
// Style note (owner convention): immediate assertions inside
// `always @(posedge clk)` with explicit previous-cycle registers.

module pio_irq_flags_fv (
    input  logic        clk,
    input  logic        rst,
    input  logic [3:0][2:0] sm_flag_idx,
    input  logic [3:0][1:0] sm_idx_mode,
    input  logic [3:0]  sm_irq_set,
    input  logic [3:0]  sm_irq_clr,
    input  logic [7:0]  irq_w1c,
    input  logic [7:0]  irq_force,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr
);

  logic [7:0] flags, irq_prev_o, irq_next_o;
  logic [7:0] prev_exp_set, prev_exp_clr, next_exp_set, next_exp_clr;

  pio_irq_flags u_dut (
      .clk (clk), .rst (rst),
      .sm_flag_idx (sm_flag_idx), .sm_idx_mode (sm_idx_mode),
      .sm_irq_set (sm_irq_set), .sm_irq_clr (sm_irq_clr),
      .irq_w1c (irq_w1c), .irq_force (irq_force),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .flags (flags),
      .irq_prev_o (irq_prev_o), .irq_next_o (irq_next_o),
      .prev_exp_set (prev_exp_set), .prev_exp_clr (prev_exp_clr),
      .next_exp_set (next_exp_set), .next_exp_clr (next_exp_clr)
  );

  // A1: reset protocol (CC-1).
  always @(posedge clk) begin
    if ($initstate) assume (rst);
  end

  function automatic logic [7:0] idx_onehot(input logic [2:0] idx);
    idx_onehot = 8'd1 << idx;
  endfunction

  // -----------------------------------------------------------------------
  // Previous-cycle input registers (explicit $past replacement).
  // -----------------------------------------------------------------------
  logic            p_rst_r = 1'b1;
  logic [3:0][2:0] p_flag_idx_r = '0;
  logic [3:0][1:0] p_idx_mode_r = '0;
  logic [3:0]      p_set_r = '0;
  logic [3:0]      p_clr_r = '0;
  logic [7:0]      p_w1c_r = '0;
  logic [7:0]      p_force_r = '0;
  logic [7:0]      p_nb_set_r = '0;
  logic [7:0]      p_nb_clr_r = '0;
  logic [7:0]      p_flags_r = '0;

  always_ff @(posedge clk) begin
    p_rst_r      <= rst;
    p_flag_idx_r <= sm_flag_idx;
    p_idx_mode_r <= sm_idx_mode;
    p_set_r      <= sm_irq_set;
    p_clr_r      <= sm_irq_clr;
    p_w1c_r      <= irq_w1c;
    p_force_r    <= irq_force;
    p_nb_set_r   <= nb_set;
    p_nb_clr_r   <= nb_clr;
    p_flags_r    <= flags;
  end

  // Reference local set vector for the previous cycle's requests
  // (SPEC-3.8-4 THIS + SPEC-3.8-6 REL + SPEC-7-6 force + CC-38 import;
  // PREV/NEXT modes deliberately absent — they are export-only).
  function automatic logic [7:0] ref_loc_set_prev();
    logic [7:0] v;
    v = p_force_r | p_nb_set_r;
    for (int i = 0; i < 4; i++) begin
      if (p_idx_mode_r[i] == 2'd0 && p_set_r[i])            // SPEC-3.8-4
        v |= idx_onehot(p_flag_idx_r[i]);
      if (p_idx_mode_r[i] == 2'd2 && p_set_r[i])            // SPEC-3.8-6
        v |= idx_onehot({p_flag_idx_r[i][2],
                         p_flag_idx_r[i][1:0] + 2'(i)});
    end
    ref_loc_set_prev = v;
  endfunction

  function automatic logic [7:0] ref_loc_clr_prev();
    logic [7:0] v;
    v = p_w1c_r | p_nb_clr_r;
    for (int i = 0; i < 4; i++) begin
      if (p_idx_mode_r[i] == 2'd0 && p_clr_r[i])            // SPEC-3.8-4
        v |= idx_onehot(p_flag_idx_r[i]);
      if (p_idx_mode_r[i] == 2'd2 && p_clr_r[i])            // SPEC-3.8-6
        v |= idx_onehot({p_flag_idx_r[i][2],
                         p_flag_idx_r[i][1:0] + 2'(i)});
    end
    ref_loc_clr_prev = v;
  endfunction

  // Reference export decodes over the *current* combinational inputs
  // (SPEC-3.8-5 PREV, SPEC-3.8-7 NEXT).
  function automatic logic [7:0] ref_prev_exp_set();
    logic [7:0] v;
    v = '0;
    for (int i = 0; i < 4; i++)
      if (sm_idx_mode[i] == 2'd1 && sm_irq_set[i]) v |= idx_onehot(sm_flag_idx[i]);
    ref_prev_exp_set = v;
  endfunction

  function automatic logic [7:0] ref_prev_exp_clr();
    logic [7:0] v;
    v = '0;
    for (int i = 0; i < 4; i++)
      if (sm_idx_mode[i] == 2'd1 && sm_irq_clr[i]) v |= idx_onehot(sm_flag_idx[i]);
    ref_prev_exp_clr = v;
  endfunction

  function automatic logic [7:0] ref_next_exp_set();
    logic [7:0] v;
    v = '0;
    for (int i = 0; i < 4; i++)
      if (sm_idx_mode[i] == 2'd3 && sm_irq_set[i]) v |= idx_onehot(sm_flag_idx[i]);
    ref_next_exp_set = v;
  endfunction

  function automatic logic [7:0] ref_next_exp_clr();
    logic [7:0] v;
    v = '0;
    for (int i = 0; i < 4; i++)
      if (sm_idx_mode[i] == 2'd3 && sm_irq_clr[i]) v |= idx_onehot(sm_flag_idx[i]);
    ref_next_exp_clr = v;
  endfunction

  always @(posedge clk) begin
    if (!$initstate) begin
      // P5: relay sources are the registered flags (CC-38).
      a_p5 : assert (irq_prev_o == flags && irq_next_o == flags);

      // P1: reset default.
      if (p_rst_r) a_p1 : assert (flags == 8'd0);

      // P2: exact registered next-state equation — per-bit RMW, clear
      // wins (CC-39), driven only by previous-cycle inputs (CC-37: no
      // combinational request→read path, next-cycle visibility).
      if (!p_rst_r)
        a_p2 : assert (flags == ((p_flags_r | ref_loc_set_prev())
                                 & ~ref_loc_clr_prev()));

      // P3: clear-wins corners (CC-39), on a previously-clear flag.
      if (!p_rst_r) begin
        // SM set vs SM clear of the same flag (modes THIS).
        if (p_idx_mode_r[0] == 2'd0 && p_idx_mode_r[1] == 2'd0
            && p_flag_idx_r[0] == p_flag_idx_r[1]
            && p_set_r[0] && p_clr_r[1] && !p_flags_r[p_flag_idx_r[0]])
          a_p3_sm : assert (flags[p_flag_idx_r[0]] == 1'b0);
        // force vs W1C of the same flag.
        if (p_force_r[0] && p_w1c_r[0])
          a_p3_bus : assert (flags[0] == 1'b0);
      end

      // P4: export buses equal the reference PREV/NEXT decode
      // (SPEC-3.8-5/7); locality of THIS/REL is pinned by a_p2's
      // reference folding only modes 00/10.
      a_p4_prev_set : assert (prev_exp_set == ref_prev_exp_set());
      a_p4_prev_clr : assert (prev_exp_clr == ref_prev_exp_clr());
      a_p4_next_set : assert (next_exp_set == ref_next_exp_set());
      a_p4_next_clr : assert (next_exp_clr == ref_next_exp_clr());

      // Covers.
      if (flags == 8'hff) c_allset : cover (1'b1);
      if (p_set_r[0] && p_clr_r[1]) c_setclr : cover (1'b1);
      if (p_force_r != '0 && p_w1c_r != '0) c_bus : cover (1'b1);
    end
  end

endmodule

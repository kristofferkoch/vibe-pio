// pio_irq_flags — the block's 8 SM IRQ flags (KANBAN C6).
//
// Structure (DESIGN.md §pio_irq_flags):
//   - 8 registered flags, set/cleared from 4 SMs, W1C from the reg bus
//     (IRQ), set from IRQ_FORCE (SPEC-7-6), plus requests imported from
//     the neighbouring blocks' PREV/NEXT exports (CC-38 relay wiring is
//     pio_top's job; this module only owns the local flag register).
//   - IdxMode decode per requesting SM (SPEC-3.8-4..7, SPEC-14.3-1):
//     00 this block, 10 REL (SM id added mod-4 on the two LSBs, bit 2
//     unaffected), 01/11 exported as onehot request buses for the
//     prev/next blocks — PREV/NEXT requests never touch local flags.
//
// Cycle contract: all writers land at one clk edge as a per-bit
// read-modify-write; a set and a clear of the same flag in one cycle
// resolve clear-wins (CC-39). Flags are purely registered — there is no
// combinational path from any request to the `flags` readback, so a set
// in cycle c is readable from c+1 only (CC-37; CC-16's `irq wait` /
// WAIT-1-irq visibility rests on this). The prev/next relay outputs are
// the registered flags themselves (the extra inter-block register stage
// of CC-38 is instantiated by pio_top).

module pio_irq_flags (
    input  logic clk,
    input  logic rst,

    // Per-SM IRQ requests, tick-qualified by the caller (exec C8 drives
    // these only on the completing tick). IdxMode + 3-bit index decode
    // (SPEC-3.8-4..7, SPEC-14.3-1).
    input  logic [3:0][2:0] sm_flag_idx,
    input  logic [3:0][1:0] sm_idx_mode,
    input  logic [3:0]      sm_irq_set,
    input  logic [3:0]      sm_irq_clr,

    // Reg bus (SPEC-7-6): IRQ is write-1-to-clear, IRQ_FORCE write-1-sets.
    input  logic [7:0] irq_w1c,
    input  logic [7:0] irq_force,

    // Imported requests: the neighbour blocks' exported PREV/NEXT
    // onehot buses, pre-registered by pio_top (CC-38).
    input  logic [7:0] nb_set,
    input  logic [7:0] nb_clr,

    // Registered flag readback to SMs (WAIT/JMP/STATUS) and INTR (CC-37).
    output logic [7:0] flags,
    // Relay buses to the neighbour blocks (CC-38: pio_top adds the
    // inter-block register stage).
    output logic [7:0] irq_prev_o,
    output logic [7:0] irq_next_o,
    // PREV/NEXT-mode SM requests routed out to the neighbours (SPEC-3.8-5,
    // SPEC-3.8-7): onehot over the decoded flag index, combinational.
    output logic [7:0] prev_exp_set,
    output logic [7:0] prev_exp_clr,
    output logic [7:0] next_exp_set,
    output logic [7:0] next_exp_clr
);

  // IdxMode encodings (SPEC-3.8-4..7).
  localparam logic [1:0] IDX_THIS = 2'd0;
  localparam logic [1:0] IDX_PREV = 2'd1;
  localparam logic [1:0] IDX_REL  = 2'd2;
  localparam logic [1:0] IDX_NEXT = 2'd3;

  logic [7:0] flags_r;

  // Onehot decode helper.
  function automatic logic [7:0] idx_onehot(input logic [2:0] idx);
    idx_onehot = 8'd1 << idx;
  endfunction

  // Effective local index for REL mode (SPEC-3.8-6): SM id mod-4 on the
  // two LSBs, bit 2 passes through.
  function automatic logic [2:0] rel_index(input logic [2:0] idx,
                                           input logic [1:0] sm);
    rel_index = {idx[2], idx[1:0] + sm};
  endfunction

  // Per-bit writer resolution (CC-39): every local writer class ORs into
  // one set vector and one clear vector; the register update applies
  // set-then-clear so a same-cycle set+clear of one flag clears it.
  logic [7:0] loc_set_c, loc_clr_c;
  always_comb begin
    loc_set_c    = irq_force | nb_set;  // SPEC-7-6 force; CC-38 import
    loc_clr_c    = irq_w1c  | nb_clr;   // SPEC-7-6 W1C; CC-38 import
    prev_exp_set = '0;
    prev_exp_clr = '0;
    next_exp_set = '0;
    next_exp_clr = '0;
    for (int i = 0; i < 4; i++) begin
      if (sm_idx_mode[i] == IDX_THIS) begin              // SPEC-3.8-4
        if (sm_irq_set[i]) loc_set_c |= idx_onehot(sm_flag_idx[i]);
        if (sm_irq_clr[i]) loc_clr_c |= idx_onehot(sm_flag_idx[i]);
      end else if (sm_idx_mode[i] == IDX_REL) begin      // SPEC-3.8-6
        if (sm_irq_set[i])
          loc_set_c |= idx_onehot(rel_index(sm_flag_idx[i], 2'(i)));
        if (sm_irq_clr[i])
          loc_clr_c |= idx_onehot(rel_index(sm_flag_idx[i], 2'(i)));
      end else if (sm_idx_mode[i] == IDX_PREV) begin     // SPEC-3.8-5
        if (sm_irq_set[i]) prev_exp_set |= idx_onehot(sm_flag_idx[i]);
        if (sm_irq_clr[i]) prev_exp_clr |= idx_onehot(sm_flag_idx[i]);
      end else begin                                     // SPEC-3.8-7
        if (sm_irq_set[i]) next_exp_set |= idx_onehot(sm_flag_idx[i]);
        if (sm_irq_clr[i]) next_exp_clr |= idx_onehot(sm_flag_idx[i]);
      end
    end
  end

  // The flag register: one edge, per-bit RMW, clear wins (CC-39);
  // registered only — next-cycle visibility (CC-37).
  always_ff @(posedge clk) begin
    if (rst) flags_r <= '0;
    else     flags_r <= (flags_r | loc_set_c) & ~loc_clr_c;
  end

  assign flags      = flags_r;
  assign irq_prev_o = flags_r;  // CC-38: relay source
  assign irq_next_o = flags_r;  // CC-38: relay source

endmodule

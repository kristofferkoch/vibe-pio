// pio_instr_mem — 32 x 16-bit PIO instruction memory (register file).
//
// 1 synchronous write port (reg-bus INSTR_MEM0..31 decode), 4 independent
// combinational read ports (one per SM PC). The combinational read is the
// owner-ratified exception to the synchronous-read convention (DESIGN.md
// "RTL conventions" / Architecture §instruction memory): CC-33 requires a
// write retiring at end of cycle e to be visible to a fetch in cycle e+1
// while the SM presents its PC during that same cycle — a registered read
// would add a cycle and need a write-bypass.
//
// Reset decision (convention: "all state reset by rst"): the 32-word array
// itself is reset to all-zero words (KANBAN C1), not just the write-port
// registers. Justification: at 32x16 flops the cost is nil, and resetting
// the array gives formal (k-induction) a canonical post-reset state — no
// unreachable-state induction counterexamples from arbitrary initial
// memory contents, and no X-propagation at time 0. The symbolic-program
// mode (SYM, below) lifts exactly this reset for the 32 words — the one
// owner-ratified exception (SPEC-16-11, DESIGN.md §Symbolic-friendliness).

// Symbolic-program mode (SPEC-16-11): default OFF. When SYM=1 (only the
// C16 synthesis harness sets it, via a yosys `chparam` — never a sim or
// elaboration flow), the 32 words become free `anyconst` constants with
// no reset and no write port, so an SMT solver searches the program space
// itself (DESIGN.md §Symbolic-friendliness "swap point"). The read ports
// stay combinational in both modes (CC-33).

module pio_instr_mem #(
    parameter bit SYM = 1'b0   // SPEC-16-11: free words (C16 synthesis only)
) (
    input  logic        clk,
    input  logic        rst,

    // Synchronous write port (clk-rate; from block reg decode of
    // INSTR_MEM0..31, SPEC-7-10).
    input  logic        wr_en,
    input  logic [4:0]  wr_addr,
    input  logic [15:0] wr_data,

    // 4 combinational read ports, one per SM (rd_addr_i = pc_r of SM i).
    input  logic [4:0]  rd_addr0,
    input  logic [4:0]  rd_addr1,
    input  logic [4:0]  rd_addr2,
    input  logic [4:0]  rd_addr3,
    output logic [15:0] rd_data0,
    output logic [15:0] rd_data1,
    output logic [15:0] rd_data2,
    output logic [15:0] rd_data3
);

  // SPEC-1-2, SPEC-14.1-1: 32 instructions x 16 bits per block.
  localparam int WORDS = 32;   // SPEC-1-2
  localparam int AW    = 5;    // log2(32), 5-bit PC / JMP address (SPEC-8-x)
  localparam int DW    = 16;   // 16-bit instruction word (SPEC-1-2)

  // Packed (flattened) array: elaborates as plain flops in yosys (no
  // $mem cell), which keeps the whole-array synchronous reset modelled
  // exactly and makes the anyconst swap a per-word register change —
  // DESIGN.md §Symbolic-friendliness ("plain flop arrays").
  logic [WORDS-1:0][DW-1:0] mem_r;

  // Synchronous write, one always_ff per the register-group convention.
  // Reset clears all words to zero (see header note) — SPEC-7-10 slots
  // are write-only, reset content is a model decision (DESIGN.md
  // "Reset/formal": all-zero, i.e. `jmp 0`-class encodings).
  always_ff @(posedge clk) begin
    if (rst) begin
      for (int i = 0; i < WORDS; i++) begin
        mem_r[i] <= '0;
      end
    end else if (wr_en) begin
      mem_r[wr_addr] <= wr_data;  // write retires end of cycle e (CC-33)
    end
  end

  // Word selects stay at module scope: yosys does not resolve indexed
  // accesses to packed 2-D arrays declared inside generate blocks (the
  // "Failed to detect width" frontend error), so the real-mode array is
  // indexed here and only the final read mux is mode-selected below.
  logic [DW-1:0] mem_word0, mem_word1, mem_word2, mem_word3;

  always_comb begin
    mem_word0 = mem_r[rd_addr0];
    mem_word1 = mem_r[rd_addr1];
    mem_word2 = mem_r[rd_addr2];
    mem_word3 = mem_r[rd_addr3];
  end

  generate
    if (SYM) begin : g_sym
      // SPEC-16-11: the 32 free words — one flat anyconst vector (flat,
      // not 2-D, for the same generate-scope reason as above), indexed
      // by the shift-only form {rd_addr, 4'd0} = 16*rd_addr. No reset,
      // no write port: the words are fixed per solver run. mem_r and
      // its flops become dead in this mode and are optimized away by
      // `prep` (verified: no $dff survives for the array).
      (* anyconst *) logic [WORDS*DW-1:0] sym_words;

      always_comb begin
        rd_data0 = sym_words[{rd_addr0, 4'd0} +: DW];
        rd_data1 = sym_words[{rd_addr1, 4'd0} +: DW];
        rd_data2 = sym_words[{rd_addr2, 4'd0} +: DW];
        rd_data3 = sym_words[{rd_addr3, 4'd0} +: DW];
      end
    end else begin : g_real
      // Combinational read ports — the ratified exception (CC-33: a
      // fetch in tick T reads the word at the PC against start-of-T
      // state; write @e is visible to reads from e+1 because there is
      // no output register).
      always_comb begin
        rd_data0 = mem_word0;
        rd_data1 = mem_word1;
        rd_data2 = mem_word2;
        rd_data3 = mem_word3;
      end
    end
  endgenerate

endmodule

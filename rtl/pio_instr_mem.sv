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
// harness later disables exactly this reset (DESIGN.md §Symbolic-
// friendliness), which is a harness-local change, not an RTL one.

module pio_instr_mem (
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

  // Combinational read ports — the ratified exception (CC-33: a fetch in
  // tick T reads the word at the PC against start-of-T state; write @e is
  // visible to reads from e+1 because there is no output register).
  always_comb begin
    rd_data0 = mem_r[rd_addr0];
    rd_data1 = mem_r[rd_addr1];
    rd_data2 = mem_r[rd_addr2];
    rd_data3 = mem_r[rd_addr3];
  end

endmodule

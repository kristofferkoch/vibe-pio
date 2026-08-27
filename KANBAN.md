# KANBAN

Planned work items **only**. When an item is completed, the finishing commit
deletes it from this file. Loose ideas must NOT be added here — put them in
`IDEAS.md` and promote them after a grilling session.

Card conventions (all RTL cards):

- RTL follows DESIGN.md "RTL conventions": `.sv` files, `clk`/`rst`,
  `_r`/`_n` suffixes, onehot `localparam` FSM states, one `always_ff` per
  register group, all state reset by `rst`, `logic` only, explicit widths.
- **Traceability rule**: every RTL comment and formal assertion cites the
  SPEC-/CC- IDs it implements/verifies. An assertion citing no fact is
  unsourced; a fact with no assertion is unverified.
- **Done-when (every card)**: `iverilog -g2012` compiles the module plus
  its testbench; `yosys read_verilog -sv` elaborates the module clean
  (hierarchy check); `make sim` runs the card's directed TB and passes;
  its `formal/*.sby` passes BMC and `prove` (k-induction) unless noted.
- Full port lists live in DESIGN.md §Module descriptions — not duplicated
  here.

## Hyperoptimization & synthesis track (C11–C16)

Promoted from the two later-level backlog bullets after the grilling
session (2026-08-25). Owner decisions: trace-equivalence first, then
spec-conformance monitors; Python golden model drives the search, sby
certifies the winners; Pareto (size, speed) objective; synthesis runs
on `pio_block` (pio_top stays a separate later card). Dependency
order: C11 ∥ C12 → C13 → C14; C15 after C11; C16 after C12 + C15.
C11 (trace-equivalence miter + observable contract), C12 (Python
golden model + assembler/disassembler, `make model`), C13 (equivalence
oracle CLI, `make equiv`), C14 (hyperoptimizer, `make hyperopt`),
C15 (spec-conformance monitors + spec-eq predicate) and C16
(symbolic-program synthesis harness + witness pipeline, `make synth`)
are done.
Tooling cards (C14/C16) state their own done-when gates; the RTL-card
template above applies to the RTL they touch.

## Browser game engine track (C17–C19)

Promoted from the IDEAS game entry after the grilling round
(2026-08-26, round 3 — browser pivot). Owner decisions: the browser
runs the verified RTL itself (Verilator→wasm, AOT build of the
Verilated model — Verilator itself is not shipped into the browser);
pio_model stays the CI cross-check oracle, so difftest gains a third
backend; the SSH daemon is deferred (browser-only now, reconsidered
once the game loop lands); the in-browser assembler is a JS port of
pio_model asm/disasm gated by golden bit-vectors — "never forked" is
relaxed for the assembler only, never the referee. The game loop
(levels, monitor profiles, scoring) is deliberately NOT promoted: it
gets its own grilling after C18 re-reads the fun gate on the real
engine. Dependency order: C17 → C18 ∥ C19. Tooling/web cards state
their own done-when gates; the RTL-card template applies only to the
lint-compat work C17 does. C17 (Verilator backend + wasm build +
three-way trace gate, `make web`) and C18 (the shipped SM-view client
under web/ on the wasm engine — worker + batch stepping, client gate
vs the model oracle; the fun-gate re-read now happens on the real
engine) are done. C18's re-assemble-on-edit milestone is folded into
C19's landing (the client marks unbuilt edits meanwhile).

- C19 (in-browser assembler/disassembler): JS port of pio_model
  asm/disasm + encoding tables; CI gate = golden bit-vectors
  generated from pio_model (already bit-equal to pioasm) plus the
  canonical round-trip property (C12 1-1: canonical disassembly
  re-assembles bit-identical). Landing it wires the client's
  re-assemble-on-edit commit path (C18's deferred milestone).

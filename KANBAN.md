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
oracle CLI, `make equiv`) and C14 (hyperoptimizer, `make hyperopt`)
are done.
Tooling cards (C14) state their own done-when gates; the RTL-card
template above applies to C15/C16.

- [ ] **C15 — Spec-conformance monitors.** SV monitors over the C11
      observables (UART-TX frame and square-wave period first; timing
      windows cite CC-23/25/26), usable (a) as the miter comparison
      predicate (spec-eq mode — timing may change, which unlocks speed
      rewrites) and (b) standalone on one instance; shared between
      formal/ and sim/ so synthesized witnesses get re-checked in sim.
      Done-when: ≥2 monitors; reference program accepted and corrupted
      program (wrong baud/parity) rejected — red/green recorded; sby
      tasks pass; `make audit` green. Depends: C11.
- [ ] **C16 — Symbolic-program synthesis harness (stretch).**
      `formal/pio_synth.sby` + harness with the imem words free per
      DESIGN.md §Symbolic-friendliness. Mechanism ratified at launch:
      primary = default-off `SYM` parameter on `pio_instr_mem` gating
      anyconst words/reset/write-port; fallback per DESIGN.md text =
      harness-local module copies; simplest = prologue init-sequencer
      writing 32 anyconst words (no RTL change at all). Behaviours =
      C15 monitors as cover goals on free stimulus; run as BMC/cover,
      not k-induction; SM0-only scoping assumptions. Witness pipeline:
      extract the 32 words from the cover trace → disassemble to .pio
      (C12) → re-verify (Python-model replay against the spec +
      auto-generated sim TB running the witness under the C15 monitors,
      optional bounded formal conformance) — synthesis output is itself
      verified. Growth path past these targets: cover-mining of
      protocol masters (I2C/SPI).
      Done-when: nontrivial witness for square wave (smoke) and
      UART-TX-byte (real); witness passes re-verification; red case —
      deliberately contradictory spec yields UNSAT cover (non-vacuity
      demo). Depends: C12, C15.

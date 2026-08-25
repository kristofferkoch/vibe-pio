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
Tooling cards (C12–C14) state their own done-when gates; the RTL-card
template above applies to C11/C15/C16.

- [ ] **C11 — Trace-equivalence miter + observable contract.** Lockstep
      miter of two `pio_block` instances in `formal/pio_equiv_fv.sv` +
      `formal/pio_equiv.sby` (bind-free wrapper, immediate assertions,
      `$initstate` reset assumption — generalizes the `pio_sm_regs_fv`
      twin). Prologue init-sequencer writes program A/B into each
      instance's imem over the reg bus (`pio_block_fv_b` pattern); free
      phase broadcasts identical reg writes (imem window excluded by
      assumption, CC-33), free `gpio_in` to both. Observables, every
      clk: `gpio_out`/`gpio_oe`/INTR equal; CPU-visible reads compared
      via an anyconst reg-bus read address (the `pio_instr_mem_fv`
      idiom) — covers RX data order, FSTAT/FLEVEL, stickies. v1 scope:
      identical config except imem (instruction-stream refactors only);
      config overlays (e.g. side-set rewrites) are the declared
      extension point C14 consumes. The contract and the shared trace
      exchange format (emitted by C12 and by RTL trace-dump TBs) become
      facts `SPEC-16-n` in a new pio-spec.md §16: bounded-by-default
      equivalence with parameterized horizon, stated explicitly —
      k-induction over the twin is out of scope.
      Done-when: equivalent pair PASS at depth N (default 40–64 ticks);
      red/green recorded — inequivalent pair (e.g. flipped pin
      polarity) BMC-flagged at the first divergent cycle; `make audit`/
      `sim`/`formal` stay green. Engines btormc/boolector (doubled FIFO
      memories case-split z3), single-SM-enabled scoping if needed.
      Depends: none (C10 done).
- [ ] **C12 — Python golden model + assembler/disassembler.**
      `tools/pio_model/`: clk-accurate single-SM simulator (divider
      CC-26; shift/autopull/autopush CC-11..13/19/20/30; MOV/JMP/WAIT/
      IRQ/SET/OUT per SPEC-3.x; delay/side-set SPEC-4 + CC-5/22; wrap
      CC-10/SPEC-8-2; input sampling CC-23/25; EXEC/force optional;
      multi-SM out of scope v1) plus native assembler and disassembler,
      emitting/consuming the SPEC-16 trace format.
      Done-when: (1) assembler bit-equal to pioasm on every
      `conf_pioexamples.svh` program (existing docker recipe); (2) model
      trace == RTL trace for every conformance program (auto-generated
      trace-dump TB on `pio_block`); (3) randomized differential
      fuzzing — random programs × stimulus, model vs RTL; (4) mutation
      demo — injected model bug caught by the differ (red), removed
      (green). Depends: C11 only for the trace format (otherwise
      parallel).
- [ ] **C13 — Equivalence oracle CLI.** `tools/hyperequiv.py`: program
      pair + horizon → Python-model pre-filter on random stimulus →
      generated C11 miter instance → sby verdict; on FAIL decode the
      counterexample into a divergence report (first differing
      observable, cycle, pin, disassembled PCs — via C12). A `make
      equiv` target runs its self-test suite (patterned on
      `tools/trace_audit.py --self-test`).
      Done-when: green case PASS, red case FAIL with decoded report;
      self-test suite committed (equivalent pair, inequivalent pair,
      timeout path); `make audit` green. Depends: C11, C12.
- [ ] **C14 — Hyperoptimizer: rewrite catalog + Pareto search.**
      `tools/hyperopt.py`: catalog of semantics-preserving rewrites,
      each tagged trace-eq or spec-conformance-only and cited to the
      SPEC-/CC- fact it exploits (side-set fusion SPEC-4/CC-5; wrap
      instead of JMP CC-10/SPEC-8-2; delay absorption during stall
      CC-22; autopull replacing PULL+OUT pairs CC-11/12; MOV ~ folding
      SPEC-3.6; dead-code elimination via model reachability; …).
      Search: exhaustive peephole closure + bounded stochastic
      exploration; candidates evaluated by the C12 model; Pareto filter
      on (imem words, ticks per loop iteration); final front certified
      through the C13 oracle. Config-overlay support lands here if
      rewrites need it (C11 extension point).
      Done-when: conformance programs as seeds → formally-certified
      Pareto set per program (or an honest "certified optimal within
      rewrite closure at horizon N"); red/green — an intentionally
      unsound rewrite (delay tamper) caught by the oracle; every
      catalog rewrite carries a committed regression case.
      Depends: C12, C13.
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

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

## Browser game engine track (C17–C20)

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
three-way trace gate, `make web`), C18 (the shipped SM-view client
under web/ on the wasm engine — worker + batch stepping, client gate
vs the model oracle; the fun-gate re-read now happens on the real
engine) and C20 (the `make js` gate: Biome format+lint over
web/ js+css+html with `sm-view.css` extracted, the `node --test`
hermetic unit suite with the fake engine, `package.json`+lockfile,
`docs/js-tooling.md`, the AGENTS.md JS line) and C19 (the in-browser
assembler/disassembler `web/pio-asm.js` — a pio_model asm/disasm port
anchored by golden bit-vectors + the 65536-word canonical round-trip
in `make js`, wiring the client's re-assemble-on-edit commit path)
are done. The browser-game track is complete; the game loop (levels,
monitor profiles, scoring) stays in IDEAS.md pending its own grilling
round after the fun gate re-read.

C20 was promoted after the 2026-08-27 JS-tooling grilling round
(all owner decisions = the presented recommendations): **Biome** is
the single format+lint tool for js+css+html (the ruff analog — one
curated strict set, every waiver documented in `biome.json` and
`docs/js-tooling.md`); the test runner is bare **`node --test`**
(the stdlib-only pytest mirror — the unit suite stays runnable under
the container's bare node); day-one scope is **all three languages**,
which requires extracting `sm-view.html`'s inline `<style>` into
`sm-view.css` first; the initial churn is absorbed by **one
mechanical** biome-format commit (behavior-identical, `make web`
re-verified); `sm-view.js` is **extract-on-touch** (lint/format from
day one; logic moves into require-able tested modules only as it is
touched — DOM glue is verified by the browser session and `make
web`, never unit tests); and `make js` is a **standalone host-side
gate** (needs node+npm, like `make py` needs uv) — `make web` stays
container-runnable and runtime JS stays dependency-free. Dependency
order is thereby revised to C17 → C18 → **C20 → C19**: the
assembler's encoding tables must land TDD from their first commit.

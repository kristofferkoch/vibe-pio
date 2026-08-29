# AGENTS.md

Conventions for AI agents (and subagents) working in this repo.

- **KANBAN.md** is the work queue: planned items only. Pick items respecting
  their dependency order. When you complete an item, your commit must delete
  it from the board. Never add loose ideas to KANBAN — append them to
  **IDEAS.md** instead; they get promoted only via a grilling session.
- Every commit you make must carry an `Agent:` trailer identifying the
  model and harness that performed the work, e.g.
  `Agent: ZCode (builtin:zai-coding-plan/GLM-5.3)`.
- **Formal findings get sim regressions.** Every bug a formal property
  uncovers (a BMC counterexample, or a k-induction "hole" that turns out
  to be a real design defect rather than a missing invariant) is
  reproduced as a directed check in the module's `sim/` testbench, in
  the same commit that fixes it. The TB comment names the fv assertion
  that found the bug. `make sim` is the fast gate — formal-only corners
  must stay visible (and re-checked) there.
- **Red/green TDD.** A regression check is not done until it has been
  shown **red** against the defect (bug re-injected, or the fix
  reverted) and **green** with the fix — a check that has only ever
  passed may be vacuous. Run the demonstration before committing and
  record it in the commit message (which check, which re-injected
  defect, first failing section). Prefer this order for any fix: write
  the failing check first, watch it fail, then fix the RTL.
- Code goes in the SystemVerilog subset common to iverilog (`-g2012`),
  yosys (`read_verilog -sv`) and verilator (`--lint-only -Wall`): 
  `always_ff`/`always_comb`, no interfaces or classes. The verilator leg
  waives exactly the four documented idiom classes (see the lint gate in
  `tools/webbuild.py`); widths stay explicit — WIDTHEXPAND/WIDTHTRUNC
  are fixed in RTL, never waived. See `DESIGN.md` before structural
  changes.
- **Python follows the same discipline** (see `docs/python-tooling.md`):
  uv + ruff + ty + pytest, gated by `make py` (host-side; the runtime
  scripts stay stdlib-only so `make model`/`make audit` also run in the
  container). Python fixes are red/green TDD like RTL: the regression
  check must be shown red against the re-injected defect, with the
  demonstration recorded in the commit. Doctests are part of the suite
  — every `pio_model` module carries them.
- **JavaScript follows the same discipline** (see `docs/js-tooling.md`):
  npm (dev-only) + Biome format/lint + bare `node --test`, gated by
  `make js` (host-side, needs node+npm; the runtime JS under `web/`
  stays dependency-free and classic-script-loadable so `make web` also
  runs in the container). JS fixes are red/green TDD like RTL/Python —
  the driver's `--defect=pin`/`--defect=mirror` hooks and the fake
  engine are the cheap red cases; the in-browser assembler port is anchored
  to pio_model by golden bit-vectors (drift-checked in `make js`),
  never to itself. DOM glue is verified by the browser session and
  `make web`, never unit tests — with two exceptions, both headless-
  Chromium checks in the `node --test` suite (a chromium on PATH or
  `$PIO_BROWSER`; see `docs/js-tooling.md`): page *geometry* is gated
  by `web/tests/layout.test.js`, and keyboard *operation* is gated by
  the C25 keyboard walk, `web/tests/keyboard.test.js`, which drives the
  shipped page with key events only through the core loop. Both follow
  the same red/green rule — each gate ran red against the shipped page
  it was written for.

## Fact and clause citations

- Spec facts in `docs/pio-spec.md` carry stable IDs `SPEC-<section>-<n>`
  (e.g. `SPEC-3.2-4`); cycle-level timing clauses in
  `docs/cycle-contract.md` are cited as `CC-<n>` (e.g. `CC-7`).
- RTL comments, formal assertions, and tests should cite the fact or
  clause they implement/verify, e.g.
  `// SPEC-3.4-11: autopull stall at cycle start` or
  `assert property (...) ##[...] $info("CC-7");`.
- New facts always take the **next free ID in their (sub-)section** —
  never reuse or renumber an existing ID, so citations stay stable across
  insertions. The scheme is documented at the top of `docs/pio-spec.md`.

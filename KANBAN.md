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

## Game track (C21–C24)

Promoted from the IDEAS game entry after the 2026-08-27 game-loop
grilling (round 1: sandbox). Owner decisions: **sandbox first,
SM0-only** — "all features unlocked" means the complete per-SM
surface (FIFO join/aux modes, real CLKDIV, shift/autopush/autopull
config, pin mapping in both directions, IRQ flags, RX drain); the
other three SMs are their own later cards. The **multi-SM gate
oracle is pio_model extended to multi-SM** — the Python referee
grows, no iverilog-oracle detour (C23 lands before any multi-SM
client work). Config UI is an **inspector-first hybrid**: a full
datasheet register-inspector panel guarantees 100 % field coverage
from day one, and the DESIGN-NOTES drawn grammar (shift arrows, join
ghosts, wrap steppers, pin tags) lands incrementally on top (C22).
**Real CLKDIV is exposed** even in sandbox (levels may still
abstract it per level). Input stimulus is **manual pin drives + hold
latches + a tiny pattern generator** (square / pasted bitstream on
one pin — deliberately short of level-stimulus machinery). The
receiver monitor becomes a **selectable lens** (off by default /
square / uart, target pin picked — a lens, never a judge, until
levels). **No game shell yet** — sm-view stays the entry page; the
menu lands with the first level card. Persistence is **localStorage
autosave + JSON export/import** of the stored-program format
(32 words + config overlay — the same JSON seeds level authoring)
plus copy-as-canonical-listing via pio-asm. Sandbox boots to **empty
memory** (all-zero = the jmp-0 park, the DESIGN-NOTES lesson), the
old level-02 uart_tx fixture demoted to a loadable demo (promotion
default, re-decidable at C21 kickoff). Dependency order:
C21 → C22 ∥ C23; C24 after C21 + C23. Tooling/web cards state their
own done-when gates below; the RTL-card template does not apply
(the RTL is already multi-SM complete).

### C21 — sandbox: the full single-SM feature surface

- The driver's LEVEL fixture is retired: `VibeDriver` loads a
  sandbox state object (words + config overlay covering PINCTRL/
  EXECCTRL/SHIFTCTRL/CLKDIV incl. join/aux bits — every field the
  inspector shows) as the same one-reg-write-per-rendered-clk
  timeline, and post-load field edits land as queued reg writes
  (the feed discipline, SPEC-6-2 settle clk included). New driver
  faces: per-pin drive ops + hold latches + a deterministic pattern
  generator (square period / pasted bitstream, one pin); RX drain
  (queued RXF0 reads) with an RX contents mirror bookkept against
  the engine's rx_push strobes (the TX-mirror precedent); IRQ flags
  + INTR readback view.
- UI: the register inspector panel (datasheet map: block regs +
  SM0 CLKDIV/PINCTRL/EXECCTRL/SHIFTCTRL/SM0_INSTR + TXF/RXF/FLEVEL —
  every field readable and settable, field tooltips citing SPEC-7-x;
  the universal "everything unlocked" guarantee); a pin I/O strip
  (drive, hold, pattern source per pin); RX panel; clkdiv header
  chip; monitor lens selector (off default) with target-pin pick;
  empty boot + demo loads. Persistence: the JSON serializer is pure
  driver code; localStorage/export/import glue lives in sm-view.js.
- Done when: `make js` covers the new driver logic against the fake
  engine (pattern-gen determinism, RX mirror vs rx_level, lens
  verdicts on canned pin series, overlay→reg-write mapping, JSON
  round-trip) with red/green defect hooks (rx / lens / pattern /
  overlay — same register as the C18 pin/mirror hooks); `make web`'s
  client gate grows model-oracle sandbox legs — pio-stim schedules
  using pin drives (`set_gpio`), clkdiv≠1, join/aux overlays and
  RXF0 drains must yield pin-identical samples + FLEVEL + read
  rdata vs pio_model, with the lens decoding checked over that
  oracle series (the C18 'PIO!' precedent); the browser session
  plays it (fun-gate flavor: every feature reachable without
  opening a devtool).

### C22 — drawn config (the DESIGN-NOTES grammar)

- The cyan structural config, on top of C21's overlay: shift
  direction + autopush/autopull flow arrows with threshold steppers
  over OSR/ISR; FIFO join ghosts (ticked upper TX slots, dimmed
  ghost RX panel); wrap steppers on the wrap arc; pin-mapping tags
  (out/side base·count) on the waveform. Every control is a real
  reg write through the C21 overlay (the ds-allocator precedent) —
  nothing is display-only.
- Done when: `make js` units pin the field↔reg-write mapping;
  `make web` and the browser session verify the glue (DOM work is
  never unit-tested, the C20 discipline).

### C23 — pio_model multi-SM extension (the multi-SM oracle)

- The Python referee grows from SPEC-16-4's SM0 scope to all four
  SMs: per-SM config/divider/FIFOs, cross-SM gpio priority
  resolution (CC-6/CC-7), inter-SM IRQ, TXF1..3 and SM1..3 window
  accesses. stim grows the SM-indexed vocabulary (a compatible
  widening if possible); the C12 conformance matrix gains multi-SM
  programs (parallel SMs on the shared imem, inter-SM IRQ handoff,
  pin arbitration), plus fuzz and the mutation demo — an injected
  multi-SM model bug must go red.
- Done when: `make model` and `make web`'s three-way gate (which
  gains the multi-SM corpus) show line-identical SPEC-16-7 traces
  model ↔ iverilog ↔ verilator-wasm on multi-SM schedules, and the
  C12 red/green discipline is re-demonstrated on a multi-SM
  transcription bug.

### C24 — sandbox multi-SM (four machines, one playground)

- The shim's pre-edge sample extends per-SM (PioCycle grows the
  SM1..3 fields or becomes an array — the CC-40 sampling point
  unchanged); the view shows the shared listing with four PC
  cursors, per-SM register/FIFO columns, and pad ownership
  (highest-numbered SM wins, CC-7) on the pin strip; inspector and
  detail panes select the SM. Client-gate legs run multi-SM
  timelines against the C23-extended model.
- Done when: `make js` and the `make web` client gate are green on
  multi-SM timelines vs pio_model (load, parallel run, inter-SM
  IRQ, pin-arbitration legs) with red/green defect hooks; browser
  session; fun-gate re-read on four machines.

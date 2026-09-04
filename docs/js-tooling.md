# JS tooling: npm + Biome + node --test

The web client side of the repo (the SM view, the shared driver
core, the headless gate runners, and the in-browser
assembler) is developed under the same discipline as the RTL and
the Python: one strict format+lint gate, and **red/green TDD** for every
behavior change.

## Layout

| Path | What |
|---|---|
| `web/engine-driver.js` | the client core (the sandbox driver: overlay→reg-write mapping, pin drives + pattern generator, RX drain + mirrors, the monitor lens, the stored-program serializer) — the same module runs in the browser worker, under the `make web` client gate's nine model-oracle legs (five sandbox + four multi-SM), and under `node --test` against the fake engine |
| `web/engine-worker.js` | the Web Worker transport around the driver |
| `web/pio-asm.js` | the in-browser assembler/disassembler — a JS port of pio_model's asm/disasm/encoding trio, anchored to that oracle by golden bit-vectors + the 65536-word canonical round-trip (never to itself) |
| `web/row-complete.js` | the C32 row-editor completion slot model (extracted from sm-view.js's computeCands) — per-instruction slots over the canonical signatures the disassembler spells, vocabularies derived from PioAsm's own operand tables, canonical accept separators, complete-slot suppression; the pre-C32 token-index model ships as its `{defect:'token-index'}` hook |
| `web/sm-view.js` | the view's DOM glue (**extract-on-touch**: lint/format always; logic migrates into require-able tested modules only as it is touched) — the listing itself is assembler-derived: rows disassemble from the loaded words and committed edits re-assemble through `pio-asm.js` into a live imem patch |
| `web/sm-view.html` / `web/sm-view.css` | the shipped page and its stylesheet (the `<style>` extracted so css joins the gate) |
| `web/node_gate.js` / `web/node_client_gate.js` | the headless `make web` runners (wasm engine / client-vs-oracle; the client gate also round-trips the level listing through `pio-asm.js`) |
| `web/tests/` | the `node --test` suite: `fake-engine.js` (the scripted wasm-ABI stand-in), `engine-driver.test.js`, `pio-asm.test.js` + the committed `pio-asm-golden.json` fixture, `row-complete.test.js` (the C32 slot model), `sandbox.test.js` (the C21 surface), `drawn-config.test.js` (the C22 field↔reg-write mapping), `multi-sm.test.js` (the C24 four-machine surface), `pin-map.test.js` (the C27 mapping marks: `pinExtents` ranges + the was-driven mask), `browser.js` + `layout.test.js` (the headless-Chromium layout gate — see below), `fake-engine-module.js` + `keyboard.test.js` (the headless-Chromium keyboard walk — see below) |
| `tools/gen_pio_asm_golden.py` | generates `web/tests/pio-asm-golden.json` from pio_model (stdlib-only; `--check` is the drift gate in `make js`) |
| `biome.json` | the format+lint configuration (waivers documented below) |
| `package.json` + `package-lock.json` | dev-only dependency: `@biomejs/biome` |

**Runtime JS is dependency-free.** Nothing under `web/` imports or
requires anything outside the Node/browser standard library — the
browser loads `engine-driver.js`/`engine-worker.js` as classic scripts
and the assembler must keep that property. `node_modules/` exists
only on the host for the biome gate; `make web` (container-runnable)
never needs it, and the unit suite runs under the container's bare
node (`node --test web/tests/*.test.js`).

## npm

`package.json` carries exactly one dev dependency, pinned exactly
(`@biomejs/biome 2.5.9` — the newest published before the registry's
2026-08-20 cutoff; the npm mirror of uv's `exclude-newer` note in
docs/python-tooling.md). The lockfile is committed; the gate reinstalls
from it:

```sh
npm ci          # reproducible node_modules from the lock (make js does this)
make js         # the full gate: biome ci + node --test
```

## The gate: `make js`

| Step | Tool | Scope |
|---|---|---|
| install | `npm ci` | dev-only, from the committed lockfile |
| format + lint | `biome ci web` | js + css + html + json under `web/` (incl. `web/tests/`); `mockups/` is outside `files.includes` and stays free-form |
| golden drift | `python3 tools/gen_pio_asm_golden.py --check` | the committed `pio-asm-golden.json` must deep-equal fresh pio_model asm/disasm output (content-wise — biome owns the file's layout, so regenerate then `npx biome format --write` it) |
| tests | `node --test web/tests/*.test.js` | hermetic unit suite — no wasm build, no model, no network; the one exception is `layout.test.js` (below), which needs a headless Chromium on the machine but still no wasm/model |

JS changes are not done until `make js` is green. The heavier gates
stay separate: `make web` (the wasm engine build, the three-way trace
gate, and the client-vs-oracle gate — needs verilator+em++/node or the
vibe-pio container image) and the browser session for DOM glue.

## Biome configuration rationale

`biome.json` selects the recommended rule set over `web/**` with
**documented** exceptions only:

- `suspicious/noRedundantUseStrict` — the files run as classic
  `<script>`s / CommonJS, where `'use strict'` is load-bearing (scripts
  are sloppy-mode by default); Biome's module assumption would have the
  auto-fix silently *drop strictness*. Never auto-fix this away.
- `complexity/noImportantStyles` — two deliberate `!important`s in the
  mock-up's CSS: the `[hidden]{display:none!important}` guard (author
  display rules must not defeat the attribute) and the `.fifofull`
  flash color override.
- `style/noDescendingSpecificity` — the mock-up's cascade layering
  (base rule early, contextual override later) is deliberate display
  structure; reordering for the linter churns the sheet for nothing.
- `a11y/noNoninteractiveTabindex` — scoped override for `web/sm-view.html`
  only (the C25 keyboard surface): the spinbox stops — the ds allocator
  row and the thr/maptag stepper pairs — are deliberately focusable
  plain divs/spans, one Tab stop per pair with hand-managed −/+/arrow
  keys, the era idiom rather than `input[type=number]` widgets. Every
  other group carries an honest role (listbox/group semantics, with the
  cursor as `aria-activedescendant`); the C26 era skin re-drew their
  chrome (silver bevels, dotted focus rects) but kept them role-less —
  the drawn stepper look is the affordance.
- Inline ignores (each carries its reason at the site): the Web Worker
  `onmessage` assignment (`noGlobalAssign` — it IS the worker API),
  `PioEngine` in `web/tests/fake-engine-module.js`
  (`noUnusedVariables` — the assignment IS the export: the worker reads
  it as a worker global after `importScripts`), and the live-redrawn
  waveform `<svg>` (`noSvgWithoutTitle` — its
  innerHTML is replaced every render, a `<title>` child would be wiped;
  the frame map carries the meaning).

Formatter: 2-space indent, width 100, single quotes, semicolons. When
a new lint fires: fix the code, or add the ignore with a comment saying
why — never silence a rule wholesale without a rationale entry here or
in `biome.json`.

`biome lint --write` applies only *safe* fixes; the three
unsafe-but-mechanical rewrites (`useTemplate`,
`useNodejsImportProtocol`, `useOptionalChain`) were applied rule-by-rule
with `--only=... --unsafe` and reviewed/verified
against the oracle gate. Prefer that route over blanket `--unsafe`.

## Tests and red/green TDD

- **Unit suite** (`web/tests/`): fast and hermetic — `fake-engine.js`
  implements the wasm ABI (HEAPU8 + `_pio_*` exports, the little-endian
  PioCycle struct) over a plain ArrayBuffer, with scripted per-clk
  effects. `engine-driver.test.js` pins the driver core: the exact demo
  load timeline (the reg-bus sequence `webbuild.py`'s client-gate legs
  mirror clk for clk), the struct decode (including the 64-bit clk),
  the receiver monitor (frame tags, decode, back-to-back re-arm), the
  TX mirror and refusal, `displayPc`/phase derivation, `stepInsn`,
  flashes, the `setProgram` patch path, and the two engine defect
  hooks. `sandbox.test.js` pins the sandbox surface: the overlay composes
  bit-exact with the stim.py builders (incl. the reset words), the
  load timelines, queued overlay edits with the SPEC-6-2 settle clk
  and the FIFO-mirror flush on fifo-mode changes, the drive/pattern
  gpio composition (sticky on op clks), the RX drain + count mirror,
  the lens (uart/square verdicts, the replay on pin change), the
  stored-program round-trip (v2, plus the v1 flat format parsing as the
  SM0-authored scope), and the four sandbox defect hooks (rx / lens
  / pattern / overlay). `multi-sm.test.js` pins the C24 surface: the
  per-SM load timeline (0x18 window stride, per-SM entry forces and TXF
  feeds, the CTRL enable mask), per-SM overlay routing and FIFO-mirror
  flushes, per-SM feeds/drains, the selected-SM aliases + `stepInsn`,
  the pad-ownership tracking (last writer, CC-7 scan order), and the
  two C24 defect hooks (smaddr / owner) red/green in process.
  `pin-map.test.js` pins the C27 mapping surface: `pinExtents` (the
  OUT/SIDESET/SET/IN ranges as masks — wrapping past GPIO31, the
  0-encodes-32 counts, the opt bit that is not a pin), the selected
  SM's `pinMap` in `getState`, and the was-driven `stale` mask (OE ∧
  owner ∧ the owner's write extents moved away — judged by the OWNER's
  extents, CC-7 lens).
  `drawn-config.test.js` pins the C22 drawn-config
  grammar at its unit-testable core: every drawn control (the
  DESIGN-NOTES table in engine-driver.js — `CFG_CONTROLS` +
  `controlEdit`) maps to real overlay edits with the right encodings
  (steppers wrap; counts store 0 for 32), the FIFO-join cycle walks
  split → tx → rx clearing aux bits, `setOverlayFields` lands a
  multi-field edit as ONE composed write per group with a single
  SPEC-6-2 settle clk, and the `cfgctrl` defect hook (the join cycle
  swapping FJOIN_TX onto FJOIN_RX) runs red/green in process. The DOM
  glue (arrows, steppers, ghosts, the wrap-arc buttons) is verified by
  the browser session and `make web`, never unit tests.
- **The assembler suite is oracle-anchored, never self-anchored**: a
  port can be *consistently* wrong (assemble and disassemble
  agreeing with each other but not with the hardware), so
  `pio-asm.test.js` checks against `pio-asm-golden.json` — words,
  canonical text and expression goldens generated from pio_model
  (itself bit-equal to pioasm 2.3.0 per `make model`'s asm-check) —
  plus pio_model's own 1-1 round-trip property ported whole:
  `assemble(disassemble(w)) === w` over all 65536 words x 4 side-set
  configs, with the canonical/reserved partition pinned to the oracle
  total (141912 — pio_model's own count over those configs).
  `row-complete.test.js` (C32) pins the completion slot model the
  same way: the vocabularies must equal PioAsm's own operand tables,
  and every accept-composed row must round-trip through
  assemble/disassemble to *itself* — the canonical spelling, not just
  an assembler-tolerated one (`push iffull, block` assembles but is
  not what the disassembler says). The pre-C32 token-index model is
  the module's standing `{defect:'token-index'}` hook and every C32
  behavior asserts divergence from it, so reverting the fix turns the
  suite red on its own checks.
- **The defect hooks are the cheap red cases** (the
  `TestMutationsDiverge` idiom): `create(M, {pin:true})` /
`{mirror:true}` re-inject the mutation-demo defects; the suite
asserts the clean driver is green against the oracle series *and* that
the very same checks go red on the defective one. `make web` runs the
same demonstration end-to-end (subprocess gates expected to FAIL).
- **Red/green rule (applies to JS exactly as to RTL/Python):** a
  regression check is not done until it has been shown **red** against
  the re-injected defect and **green** with the fix. Record it in the
  commit message (which check, which re-injected defect, first failing
  assertion). Prefer: write the failing check first, watch it fail,
  then fix.

Worked example (from the suite's own first commit): the
`displayedPc latches the exec pc through DELAY` test went red against
the shipped driver (`0 !== 2` — `lastExecPc` was recomputed lazily at
read time, so an unobserved batch spanning EXEC→DELAY — the worker's
`{cmd:'run',cycles:N}`, the `?t=` URL pre-run — displayed a stale pc).
The fix latches `lastExecPc` eagerly in `record()`; the same suite
then passed, and the `make web` client gate re-verified the driver
against the pio_model oracle. The hook-based checks were additionally
demonstrated by sabotaging `pinBit` to sample bit 1 unconditionally:
4 tests red (first failing: `monitor decodes a scripted 8N1 frame`),
14/14 green after restore.

Worked examples from the assembler port: the operand-passing defect —
`encodeCore` pre-resolving operand names to numeric codes that the
name-taking encoders then looked up again — went red on the very first
golden run (`golden squarewave`, word 0: 0xE001 vs pio_model 0xE081,
plus `addition`'s `mov x, ~osr` failing operand lookup outright);
passing names across the Python `except KeyError` boundary made it
green. The classic JS trap was demonstrated by injection: swapping the
evaluator's C truncating division for native floor division turned
`golden exprs` red on `-7/2` (expected -3, floor gives -4); restored,
27/27 green.

## The layout gate: `web/tests/layout.test.js`

The unit suite is DOM-free by design; the *geometry* a user gets is
gated at the browser level instead. `layout.test.js` loads the real
`sm-view.html` in a headless Chromium driven over CDP by
`web/tests/browser.js` — a zero-dependency client (Node ≥ 22's global
WebSocket; no puppeteer/playwright), so the runtime-stays-depend-free
rule holds even for this. It pins the layout-defect classes the
project has hit by hand:

- **Fit** — every fixed right-column panel (all of `#regs` except the
  inspector) ends above the column's clip edge at 13"-laptop viewports
  (1280×800, 1366×768) in all three FIFO postures (split / join tx /
  join rx): the rx fifo never drops below the fold. The edge, not the
  viewport, is the honest bound — a row ending between the two renders
  under the footer, invisible just the same.
- **Honesty** — no panel is squeezed below its content
  (`scrollHeight ≤ clientHeight`, both axes): the C22 spill mechanism,
  where `min-height: 0` let a track shrink and the overflow painted
  over the panels below while the boxes "fit" any viewport.
- **Hit targets** — every drawn control in the fixed rows is topmost at
  its center (`elementFromPoint`), the C22 buried-controls failure.
- **Hover and press never reflow** (the C26 era skin): the first cut
  bolded hovered buttons and the bitmap bold face ran wider —
  auto-width controls grew under the pointer and re-flowed their
  rows; the pressed nudge then leaked through specificity onto the
  drawn mini-controls (`button:active`/`button.on` out-rank
  single-class rules), growing the toggles/paddles and crushing the
  fixed steppers on press. The gate sweeps the pointer (CDP
  `mouseMoved`) over every control family, then presses one
  representative per face family (`mousePressed`/`mouseReleased`),
  requiring the boxes to hold exactly throughout. Hover restyles are
  color-only; the pressed bevel swap keeps its padding sum on the
  push-button faces and does not reach the drawn ones.
- **The wiring marks track the overlay** (C27): the pin strip's three
  cyan-family lanes per cell draw the selected SM's OUT/SIDESET/IN
  extents at fixed lane metrics (2px lanes, 1px apart, under the pin
  number), the filled lanes must match the overlay exactly in an
  overlap scenario, and one `side-base` stepper gesture — applied the
  way `sendCtl` applies it — must move the mark in the same render. The
  twin check pins live vs was-driven: an OE pad inside the owner's
  wiring renders driven; the moved-from pad carries the `stale` class,
  the gray mark, and the "wiring has moved away" narration. Both ran
  red against their re-injected defects (a boot-captured overlay; the
  stale class dropped).
- **State changes never reflow the strip; the program column is
  content-anchored** (the C27 follow-up from the owner's live session):
  the ▲/D/◆ pin marks ride the level line — its 16px line box exists on
  every cell, so a drive latch or OE appearing must not move a single
  cell box (the empty mark row had none: the first mark anywhere
  stretched every cell 16px); and the program column lands at its
  content clamp (the row editor's ~364px need — the old 32vw track
  carried 46px+ of dead width at 1280–1440 that the wave never saw),
  with the editor's instruction cell keeping its typing room.
- **Priority** — the register column is not the exec pane's leftover
  (the layout reprioritization, four passes): at the 13" references
  its drawn control rows render single-line (the measured wrapped
  values are 36–63px), the column holds its 356px floor, the inspector
  gets real room (≥ 200px — the datapath and both fifos live in the
  exec column, not stacked over it), the exec echo is two lines rather
  than a flex:1 body wall, and the exec column's own residents get the
  same honesty/spill/fit checks. The fifo twins must sit side by side
  in the exec column at equal width (±2px), the isr must ride above
  them (the shift registers sandwich the pair, osr below), and the
  inspector reads as a ledger: register names column-aligned at equal
  width, field chips at one height, and every field's value input
  ending flush at its chip's right edge — name/bits/value on three
  fixed columns. The wave keeps a 64px floor — the
  sandwich buys its room from the wave, but it never collapses. At
  1920×1080 the app caps with the register column at its 430px ceiling
  and the center at the waveform's natural 896px scale — measured from
  both sides since the C26 era window (whose 2px bevel padding used to
  tax the drawn grid down to 890; the gate wants 896, the integer
  scale the drawn geometry snaps to). Since C26 the geometry is also
  font-dependent (the two bitmap webfonts), so `load()` awaits
  `document.fonts.ready` before measuring.

Practicalities:

- The browser is found via `$PIO_BROWSER`, else `chromium` /
  `chromium-browser` / `google-chrome` / `chrome` / `headless_shell` on
  PATH; a missing browser fails the gate loudly. Firefox cannot drive
  this gate: it dropped CDP support in 2024 (its automation surface is
  WebDriver BiDi — a second driver would slot in behind the same
  launch/evaluate shape if ever needed).
- The suite stays hermetic even though this file leaves it: the test's
  static server *holds the engine request open forever* — the worker's
  `importScripts` blocks, so no wasm build is needed and no `werr`/`ready`
  race can mutate the page mid-measurement. The view's geometry is
  complete at script load (`render(V.state)` runs before the worker
  answers); join postures are driven by calling `render()` with a
  doctored `fifoDepths`.
- Container use: the runner is stdlib node, so it runs unchanged inside
  the vibe-pio image once a chromium exists there
  (`apt-get install -y chromium`; the image ships emsdk's node ≥ 22,
  which has the global WebSocket).

Worked example (this gate's first commit): the shipped page squeezed
every `#regs` track below its content — `#xy` measured 85px of content
in a 79px box painting over the irq panel, the OSR/ISR controls were
buried under the spill, and the tx fifo's 96px level gauge pushed the
rx fifo below the fold at 1280×800. Red: all six checks, first failing
`#xy is squeezed at 1280×800 (split): content 85px in a 79px box`.
Green after the fix (content-based `min-height` on the fixed rows +
panel compaction + the level gauge and join slots capped so the slots
column, not a gauge, sets the tx-fifo height): 6/6.

## The keyboard gate: `web/tests/keyboard.test.js`

The second sanctioned DOM-glue exception (C25). It drives the real
`sm-view.html` with **keyboard events only** — CDP
`Input.dispatchKeyEvent` through the same `browser.js` plumbing as the
layout gate; not one mouse event, not one `element.click()` — through
the mouseless core loop: Tab into the machines bar and the pin strip,
walk the arrows, latch a pin; Tab into the listing (a listbox), walk
the row cursor, type an instruction (the editor opens under the keys
alone), exercise the row editor's completion-list contract (C31 — the
list is its own box next to the always-on machine-code strip: ←/Home/End
recompute it under the caret, Esc closes it for its slot while the strip
stays, Enter commits in both states, Tab is the only accept key), commit
the row, walk the gutter pick; spin a drawn stepper through
its wrap; retarget the wave row's lens-pin picker (C28 — one Tab stop,
−/+/←/→, wrapping both ways); take an Alt+letter mnemonic.

The engine is hermetic: the test's static server answers the engine
request with `web/tests/fake-engine-module.js` — the suite's own
`fake-engine.js` wearing the `PioEngine` factory face — so the REAL
`engine-worker.js` boots unmodified and every keystroke's effect (a
drive latch, a threshold wrap) is the engine truth the view renders,
not a stub. Note for CDP key events: the DOM event's modifier state
(`e.altKey` & co.) rides the `modifiers` bitmask (alt 1, ctrl 2, meta
4, shift 8); the per-modifier boolean params alone do not set it.
C32 adds the slot-sense legs: typing `set x, 3` leaves the list
closed (a complete slot offers nothing; the empty slot behind ←
still lists its four counts), and the walks for `wait` (polarity
first, then the sources), `push` (the block flag slot follows
iffull — the menu no longer empties mid-instruction) and `irq`
(set/wait/clear at the mode slot, rel/prev/next after the index)
compose and commit their canonical spellings.

The focus model the walk pins: keys are owned by focus — text surfaces
type, every interactive group ([data-rovi]) is ONE Tab stop with an
internal cursor rendered as view state (the items are rebuilt every
rendered clk, so per-item tabindex would drop focus each frame — the
cursor classes and `aria-activedescendant` survive), and the global
accelerators fire on body focus only. A click that lands on no
interactive owner releases the keyboard back to the accelerators, so
mouse users keep SPACE/R.

Worked example (this gate's first commit): the shipped pre-C25 page
could not be operated at all without the mouse — Tab never reached the
machines bar (the walk's first failing check, 60 stops exhausted; the
listing had no tab stop at all, so the row editor could not open under
the keys). Red against that page; green after the C25 surface landed
(listbox listing, arrow groups, spinbox stops, mnemonics, status line).

## Conventions for new JS code (future levels)

1. Runtime code stays dependency-free and loads as a classic script;
   anything that needs npm is dev tooling, not shipped.
2. New logic goes in require-able modules under `web/` with unit tests
   in `web/tests/` from the first commit (the encoding tables landed
   TDD against golden bit-vectors generated from pio_model); `sm-view.js`
   stays extract-on-touch.
3. DOM glue is never unit-tested — it is verified by the browser
   session and `make web` — with exactly two exceptions, both
   headless-Chromium gates in the suite: page *geometry*
   (`layout.test.js`) and keyboard *operation* (`keyboard.test.js`,
   the C25 walk).
4. Red/green for every behavior fix; `make js` green before commit,
   `make web` green when the driver/gate runners changed.

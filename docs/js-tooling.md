# JS tooling: npm + Biome + node --test

The web client side of the repo (the C18 SM view, the shared driver
core, the C17 headless gate runners, and — landing with C19 — the
in-browser assembler) is developed under the same discipline as the
RTL and the Python: one strict format+lint gate, and **red/green TDD**
for every behavior change.

## Layout

| Path | What |
|---|---|
| `web/engine-driver.js` | the C18 client core — the same module runs in the browser worker, under the `make web` client gate (vs the pio_model oracle), and under `node --test` against the fake engine |
| `web/engine-worker.js` | the C18 Web Worker transport around the driver |
| `web/sm-view.js` | the view's DOM glue (**extract-on-touch**: lint/format always; logic migrates into require-able tested modules only as it is touched) |
| `web/sm-view.html` / `web/sm-view.css` | the shipped page and its stylesheet (the `<style>` was extracted in C20 so css joins the gate) |
| `web/node_gate.js` / `web/node_client_gate.js` | the headless `make web` runners (wasm engine / client-vs-oracle) |
| `web/tests/` | the `node --test` suite: `fake-engine.js` (the scripted wasm-ABI stand-in) + `engine-driver.test.js` |
| `biome.json` | the format+lint configuration (waivers documented below) |
| `package.json` + `package-lock.json` | dev-only dependency: `@biomejs/biome` |

**Runtime JS is dependency-free.** Nothing under `web/` imports or
requires anything outside the Node/browser standard library — the
browser loads `engine-driver.js`/`engine-worker.js` as classic scripts
and the C19 assembler must keep that property. `node_modules/` exists
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
| format + lint | `biome ci web` | js + css + html under `web/` (incl. `web/tests/`); `mockups/` is outside `files.includes` and stays free-form |
| tests | `node --test web/tests/*.test.js` | hermetic unit suite — no wasm build, no model, no network |

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
- Inline ignores (each carries its reason at the site): the Web Worker
  `onmessage` assignment (`noGlobalAssign` — it IS the worker API) and
  the live-redrawn waveform `<svg>` (`noSvgWithoutTitle` — its
  innerHTML is replaced every render, a `<title>` child would be wiped;
  the frame map carries the meaning).

Formatter: 2-space indent, width 100, single quotes, semicolons. When
a new lint fires: fix the code, or add the ignore with a comment saying
why — never silence a rule wholesale without a rationale entry here or
in `biome.json`.

`biome lint --write` applies only *safe* fixes; the three
unsafe-but-mechanical rewrites used once in the C20 mechanical commit
(`useTemplate`, `useNodejsImportProtocol`, `useOptionalChain`) were
applied rule-by-rule with `--only=... --unsafe` and reviewed/verified
against the oracle gate. Prefer that route over blanket `--unsafe`.

## Tests and red/green TDD

- **Unit suite** (`web/tests/`): fast and hermetic — `fake-engine.js`
  implements the wasm ABI (HEAPU8 + `_pio_*` exports, the little-endian
  PioCycle struct) over a plain ArrayBuffer, with scripted per-clk
  effects. The suite pins the driver's logic: the exact load timeline
  (the reg-bus sequence `webbuild.py::_client_level_sched` mirrors),
  the struct decode (including the 64-bit clk), the receiver monitor
  (frame tags, decode, back-to-back re-arm), the TX mirror and
  refusal, `displayPc`/phase derivation, `stepInsn`, flashes, and the
  two defect hooks.
- **The defect hooks are the cheap red cases** (the
  `TestMutationsDiverge` idiom): `create(M, {pin:true})` /
`{mirror:true}` re-inject the C18 mutation-demo defects; the suite
asserts the clean driver is green against the oracle series *and* that
the very same checks go red on the defective one. `make web` runs the
same demonstration end-to-end (subprocess gates expected to FAIL).
- **Red/green rule (applies to JS exactly as to RTL/Python):** a
  regression check is not done until it has been shown **red** against
  the re-injected defect and **green** with the fix. Record it in the
  commit message (which check, which re-injected defect, first failing
  assertion). Prefer: write the failing check first, watch it fail,
  then fix.

Worked example from the C20 suite commit itself: the
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

## Conventions for new JS code (C19 assembler, future levels)

1. Runtime code stays dependency-free and loads as a classic script;
   anything that needs npm is dev tooling, not shipped.
2. New logic goes in require-able modules under `web/` with unit tests
   in `web/tests/` from the first commit (C19's encoding tables land
   TDD against golden bit-vectors generated from pio_model); `sm-view.js`
   stays extract-on-touch.
3. DOM glue is never unit-tested — it is verified by the browser
   session and `make web`.
4. Red/green for every behavior fix; `make js` green before commit,
   `make web` green when the driver/gate runners changed.

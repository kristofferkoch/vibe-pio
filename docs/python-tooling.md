# Python tooling: uv + ruff + ty + pytest

The Python side of the repo (the C12 golden model, assembler/disassembler,
trace differ, audits) is developed under the same discipline as the RTL:
strict tooling gates, and **red/green TDD** for every behavior change.

## Layout

| Path | What |
|---|---|
| `tools/pio_model/` | the golden-model package (encoding, asm, disasm, model, tracefmt, stim, difftest CLI) |
| `tools/trace_audit.py` | SPEC-/CC- traceability audit (`make audit`) |
| `tools/hyperequiv.py` | C13 equivalence oracle: program pair + horizon -> pre-filter, generated C11 miter instance, sby verdict, decoded divergence reports (`make equiv`) |
| `sim/gen_conf_pioexamples.py` | regenerates `sim/conf_pioexamples.svh` from pioasm |
| `tests/` | pytest suite: unit tests + the doctest gate (`tests/test_doctests.py`) |

**Runtime code is stdlib-only.** `pio_model` and the audit/oracle
scripts must import with a bare `python3` — they run inside the vibe-pio
container (`make model`, `make audit`, `make equiv`), which has no uv,
no venv, and no network. The oracle shells out to `sby` (native or
through the same container image as difftest) but never pip-installs
anything. Dependencies (ruff, ty, pytest) are *dev-only* and live in the
uv environment.

## uv

`uv` manages the dev environment (`pyproject.toml` + `uv.lock`, both
committed; `.python-version` pins the interpreter). All quality tools run
through it so everyone gets the locked versions:

```sh
uv sync          # create/update .venv from the lock (once per checkout)
make py          # the full gate: format --check, lint, types, tests
```

`uv.lock` is committed for reproducibility; bump tool versions by
editing `[dependency-groups].dev` in `pyproject.toml` and re-locking.
The lock respects the global `uv` `exclude-newer` policy if configured
(a rolling cutoff; if a requested version "does not exist", pick the
newest published before the cutoff).

## The gate: `make py`

| Step | Tool | Scope |
|---|---|---|
| formatting | `ruff format --check .` | line length **120** |
| lint | `ruff check .` | strict curated rule set (below) |
| types | `ty check` | every function annotated; strictness knobs in `[tool.ty.rules]` |
| tests | `pytest` | `tests/` unit suite **+ doctests** of all `pio_model` modules and the C13 oracle |

Python changes are not done until `make py` is green. The heavier
RTL-facing gates stay separate: `make model` (differential vs RTL, needs
iverilog or the vibe-pio container image), `make equiv` (C13 oracle
self-test, needs sby or the container image) and `make audit`.

## ruff configuration rationale

`[tool.ruff]` in `pyproject.toml` selects a broad strict set (E/W/F/I/N,
UP, B, A, C4, EXE, ISC, ICN, PIE, PT, Q, RET, RSE, RUF, SIM, TID, PTH,
PGH, PL, PERF, FURB, TRY, ARG, SLF) with **documented** exceptions:

- `E501` — the formatter owns line breaking; it never splits strings, and
  citation/hex strings read better whole.
- `TRY003`, dropped `EM*` — rich inline exception messages
  (`AsmError(f"{name}:{lineno}: ...")`) are this codebase's UX.
- `PLR2004` — magic numbers are the domain (bit masks/field positions,
  each carrying its SPEC-/CC- citation).
- `PLR0911/0912/0913/0915`, `PLR0917` — the model and the config-word
  builders are deliberate 1:1 transcriptions of the RTL / the
  `tb_conf_pioexamples.sv` `MFY_*` helpers; branchiness mirrors hardware.
- `N812`, `N818` — `encoding as E` is the package-wide alias;
  `ReservedEncoding`/`TraceMismatch`/`AsmError` are pinned names cited in
  docs and tests.
- `PTH123` — builtin `open()` is used uniformly with `str | Path`.
- Per-file: `model.py` keeps RTL-mirroring if-trees (`SIM102/114`) and
  `step()`'s protocol parameter `lb_mask` (`ARG002`); `trace_audit.py`
  uses `glob.glob` for absolute fixture patterns (`PTH207`); `stim.py`
  keeps the established `s` variable (`E741`); tests may poke privates
  (`SLF001`).

When a new lint fires: fix the code, or add the ignore **with a comment
saying why** — never silence a rule wholesale without a rationale entry
here or in `pyproject.toml`.

## ty

`ty check` covers `tools/`, `sim/`, `tests/` (config: `[tool.ty]` in
`pyproject.toml`). Everything is annotated; the decode bundle is a
`TypedDict` (`encoding.Decoded`) and `step()` returns
`model.Observables`, so key typos in field access are compile-time
errors. `pio_model` is imported through a `sys.path` shim (it is never
installed), so ty gets the same view via
`[tool.ty.environment] extra-paths = ["tools"]`.

## Tests, doctests, and red/green TDD

- **Unit suite** (`tests/`): fast, hermetic (no RTL, no `third_party/`,
  no docker) — encoding/asm/disasm/tracefmt/stim facts, model cadence
  (delay CC-10, divider CC-26), reset observables, and model-vs-model
  mutation divergence (the pure-Python half of the C12 mutation demo).
- **Doctests**: every `pio_model` module must have doctest examples;
  `tests/test_doctests.py` runs each module's `DocTestSuite` and fails
  if a module has none. Doctests double as usage documentation — prefer
  them for "what does this return" examples, unit tests for laws and
  corners. (pytest's `--doctest-modules` cannot import the
  relative-import package; the explicit suite replaces it.)
- **Red/green rule (applies to Python exactly as to RTL/formal):** a
  regression check is not done until it has been shown **red** against
  the re-injected defect and **green** with the fix. Record it in the
  commit message (which check, which re-injected defect, first failing
  assertion). Prefer: write the failing check first, watch it fail, then
  fix.

Worked example from the tooling commit itself: the assembler accepted
`irq clear` (no index) and crashed with a bare `TypeError` inside the
encoder. The check `tests/test_asm.py::test_irq_without_index_raises`
was shown red against the re-injected guard removal (TypeError escaped
instead of `AsmError`), then green with the guard.

## Conventions for new Python code (C13 `hyperequiv`, C14 `hyperopt`, ...)

1. Stdlib-only runtime; anything else must be dev-only.
2. Type-annotate everything; new public bundles become `TypedDict`/dataclass.
3. Doctests on public functions; unit tests for laws; no test touches
   `third_party/`, docker, or iverilog unless it is explicitly an RTL
   gate (`make model`).
4. Red/green for every behavior fix (mutation-hook style divergences are
   the cheap way to build a red case — see `tools/pio_model/model.py`
   `MUTATIONS` and `tests/test_model.py::TestMutationsDiverge`).
5. `make py` green before commit; `make model`/`make audit` green when
   the model/audit code changed.

# vibe-pio top-level Makefile
#
# `sim`    — compile-and-run every sim/tb_*.sv (except tb_common.sv, the
#            shared include file) with iverilog -g2012, aggregate pass/fail,
#            exit nonzero if any TB fails. TBs are discovered by glob so
#            parallel work never needs to edit this file.
# `syn`    — yosys elaboration (hierarchy check) of every rtl/*.sv.
# `formal` — run every formal/*.sby task.
# `audit`  — SPEC-/CC- traceability audit (tools/trace_audit.py): runs the
#            script's hermetic self-test (incl. mutation checks), then the
#            repo audit; exits nonzero on dangling citations, duplicate
#            fact IDs, or index/body mismatches.
# `model`  — golden-model self-test (tools/pio_model/difftest.py):
#            assembler/pioasm bit-equality, the conformance trace
#            matrix (19 CF programs + the multi-SM corpus: parallel
#            SMs, pin arbitration, inter-SM IRQ, SM1..3 windows), a
#            fuzz batch (half multi-SM) and the mutation demo incl.
#            the two multi-SM bugs (model vs RTL through
#            sim/tb_trace_dump.sv; needs iverilog or the vibe-pio
#            container image).
# `equiv`  — C13 equivalence-oracle self-test (tools/hyperequiv.py):
#            hermetic fixture checks (packing, VCD decode red/green,
#            SPEC-16-2 exclusions, model pre-filter red/green) plus the
#            end-to-end cases — equivalent program pair PASS (sby bmc),
#            inequivalent pair FAIL via the pre-filter, inequivalent
#            pair FAIL via sby with the decoded counterexample report
#            (first differing observable, cycle, pin, disassembled PCs,
#            replayed in the golden model), and the timeout path.
#            Needs sby on PATH or the vibe-pio container image; budget
#            ~3 min (the sby runs dominate).
# `hyperopt` — C14 hyperoptimizer self-test (tools/hyperopt.py): the
#            per-rewrite regression cases (model trace-equal green,
#            compensation-removed red, the unsound delay tamper caught
#            by the pre-filter), search/Pareto units, plus two
#            end-to-end sby runs through the EXECCTRL-overlay miter
#            (SPEC-16-8): a wrap_fold output certified PASS, and the
#            delay tamper FAILed with a decoded counterexample.
#            Needs sby on PATH or the vibe-pio container image.
# `synth`  — C16 symbolic-program synthesis self-test
#            (tools/hypersynth.py): hermetic fixtures (SPEC-16-9 window
#            checkers red/green, VCD decode, canonicalization, .pio
#            round-trip) plus the end-to-end witness pipeline for both
#            targets — free-word cover synthesis (SYM=1), extraction,
#            canonicalization + disassembly, and the three re-verify
#            legs (C12 model replay, generated iverilog TB, bounded
#            formal conformance) — and the red UNSAT contradictory-spec
#            case. Needs sby on PATH or the vibe-pio container image;
#            budget ~15 min (the two cover searches dominate).
# `web`    — C17/C18 web gate (tools/webbuild.py): verilator
#            -Wall lint over rtl/*.sv (four documented idiom waivers),
#            the AOT wasm build (verilator --cc --assert -> em++,
#            build/web/pio_engine.js — the shipped game engine,
#            invariant subset compiled in), the three-way SPEC-16-7
#            trace gate (model <-> iverilog <-> verilator-wasm on the
#            conformance matrix + fuzz corpus), the C18 client gate
#            (web/engine-driver.js — the exact client core the browser
#            worker runs — checked against the pio_model oracle over
#            five sandbox legs: the uart demo, pin drives + pattern
#            generator, clkdiv!=1, join/aux overlays + RXF0 drains,
#            aux put/get; full gpio word series + reg-read rdata), and
#            the
#            red/green mutation demos for the shim defects and the
#            three client-side defect hooks (--defect=pin /
#            --defect=mirror / --defect=smaddr, the C24 window-stride
#            transcription caught by the arbitration leg).
#            Needs verilator+em++/node on PATH or the vibe-pio
#            container image; budget ~10 min (three wasm builds + the
#            iverilog corpus dominate).
# `py`     — Python quality gate (host-side, needs uv; see
#            docs/python-tooling.md): ruff format --check + ruff check +
#            ty type check + pytest (unit tests + doctests). The
#            RTL-facing scripts stay stdlib-only so make model/audit
#            also run inside the vibe-pio container (which has no uv).
# `js`     — JS quality gate (host-side, needs node+npm; see
#            docs/js-tooling.md): biome ci (format --check + strict lint
#            over web/ js+css+html; mockups/ stays free-form), the C19
#            golden-fixture drift check (tools/gen_pio_asm_golden.py
#            --check: pio_model asm/disasm output vs the committed
#            web/tests/pio-asm-golden.json — needs python3, stdlib only)
#            plus the bare node --test unit suite under web/tests/
#            (hermetic — the fake engine replaces the wasm build; it
#            also runs under the container's bare node), including the
#            headless-Chromium layout gate web/tests/layout.test.js
#            (real page geometry at 13"-laptop viewports; needs a
#            chromium on PATH or $PIO_BROWSER — docs/js-tooling.md).
#            Runtime JS
#            stays dependency-free: node_modules exists only for the
#            biome gate.

SIM_DIR     := sim
RTL_DIR     := rtl
FORMAL_DIR  := formal
BUILD_DIR   := build

# All top-level testbenches: glob-discovered; tb_common.sv is an include, not a TB.
TB_LIST := $(filter-out $(SIM_DIR)/tb_common.sv,$(wildcard $(SIM_DIR)/tb_*.sv))
RTL_SRC := $(wildcard $(RTL_DIR)/*.sv)

IVERILOG = iverilog -g2012 -I $(SIM_DIR)
VVP      = vvp

.PHONY: sim syn formal audit model equiv hyperopt synth web py js toolcheck clean $(TB_LIST)

toolcheck:
	@echo "=== toolchain versions ==="
	@iverilog -V 2>&1 | head -1
	@yosys -V
	@sby --version
	@z3 --version
	@boolector --version | tail -1
	@echo "btormc $$(btormc --version | tail -1)"
	@python3 --version
	@if command -v verilator >/dev/null; then verilator --version; \
		else echo "verilator: not on PATH (make web falls back to the vibe-pio container)"; fi
	@if command -v em++ >/dev/null; then em++ --version | head -1; \
		else echo "emsdk em++: not on PATH (make web falls back to the vibe-pio container)"; fi
	@if command -v node >/dev/null; then echo "node $$(node --version)"; \
		else echo "node: not on PATH (make web falls back to the vibe-pio container)"; fi
	@if command -v uv >/dev/null; then \
		echo "uv $$(uv --version | cut -d' ' -f2) (host-side Python tooling)"; \
		uv run --quiet ruff --version; \
		uv run --quiet ty --version; \
		uv run --quiet pytest --version | head -1; \
	else echo "uv: not found (make py unavailable; see docs/python-tooling.md)"; fi
	@if command -v npm >/dev/null; then \
		echo "npm $$(npm --version) (host-side JS tooling)"; \
		if [ -x node_modules/.bin/biome ]; then node_modules/.bin/biome --version; \
		else echo "biome: not installed (make js runs npm ci first)"; fi; \
	else echo "npm: not found (make js unavailable; see docs/js-tooling.md)"; fi

sim: $(TB_LIST)
	@if [ -z "$(TB_LIST)" ]; then \
		echo "sim: no testbenches found in $(SIM_DIR)/tb_*.sv"; \
		exit 1; \
	fi
	@echo "=== sim summary ==="
	@rc=0; \
	pass=0; fail=0; \
	for tb in $(TB_LIST); do \
		name=$$(basename $$tb .sv); \
		out="$(BUILD_DIR)/$$name.log"; \
		if grep -q "^TB STATUS : FAIL" $$out 2>/dev/null; then \
			echo "FAIL $$name"; fail=$$((fail+1)); rc=1; \
		elif grep -q "^TB STATUS : PASS" $$out 2>/dev/null; then \
			echo "PASS $$name"; pass=$$((pass+1)); \
		else \
			echo "ERROR $$name (no TB STATUS line; compile or run failed, see $$out)"; \
			fail=$$((fail+1)); rc=1; \
		fi; \
	done; \
	echo "=== $$pass passed, $$fail failed ==="; \
	exit $$rc

# Per-TB rule: compile then run, capturing output (vvp exit status alone is
# unreliable across simulators, so PASS/FAIL is judged on the TB STATUS line).
$(TB_LIST):
	@mkdir -p $(BUILD_DIR)
	@name=$$(basename $@ .sv); \
	out="$(BUILD_DIR)/$$name.log"; \
	echo "--- $$name: compiling+running"; \
		$(IVERILOG) -s $$name -o $(BUILD_DIR)/$$name.vvp $@ $(SIM_DIR)/tb_common.sv $(RTL_SRC) \
		&& $(VVP) $(BUILD_DIR)/$$name.vvp > $$out 2>&1; \
	rc=$$?; \
	if [ $$rc -ne 0 ] && [ ! -s $$out ]; then \
		echo "ERROR $$name: compile/run exited $$rc" | tee -a $$out; \
	fi; \
	grep -E "^(PASS|FAIL|ERROR) |^TB (STATUS|RESULT)" $$out || true; \
	exit 0

# Composite modules (pio_sm and up) instantiate their submodules, so the
# hierarchy check needs the whole rtl set in one yosys session.
syn:
	@if [ -z "$(RTL_SRC)" ]; then echo "syn: no rtl/*.sv sources yet"; else \
		echo "--- yosys hierarchy check: all rtl/*.sv"; \
		yosys -q -p "read_verilog -sv $(RTL_SRC); hierarchy -check; check" || exit 1; \
	fi

formal:
	@rc=0; \
	tasks="$(wildcard $(FORMAL_DIR)/*.sby)"; \
	if [ -z "$$tasks" ]; then echo "formal: no .sby tasks in $(FORMAL_DIR)/"; \
	else \
		for t in $$tasks; do \
			echo "--- sby: $$t"; \
			(cd $$(dirname $$t) && sby -f $$(basename $$t)) || rc=1; \
		done; \
	fi; \
	exit $$rc

audit:
	@python3 tools/trace_audit.py --self-test || exit 1
	@python3 tools/trace_audit.py

model:
	@python3 tools/pio_model/difftest.py --self-test

equiv:
	@python3 tools/hyperequiv.py --self-test

hyperopt:
	@python3 tools/hyperopt.py --self-test

synth:
	@python3 tools/hypersynth.py --self-test

web:
	@python3 tools/webbuild.py --self-test

py:
	uv run ruff format --check .
	uv run ruff check .
	uv run ty check
	uv run pytest

js:
	npm ci
	npx biome ci web
	python3 tools/gen_pio_asm_golden.py --check
	node --test web/tests/*.test.js

clean:
	rm -rf build sim_out formal/out formal/*_bmc formal/*_prove formal/*_cover

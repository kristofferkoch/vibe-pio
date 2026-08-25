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
# `model`  — C12 golden-model self-test (tools/pio_model/difftest.py):
#            assembler/pioasm bit-equality, the 20-program conformance
#            trace matrix, a fuzz batch and the mutation demo (model vs
#            RTL through sim/tb_trace_dump.sv; needs iverilog or the
#            vibe-pio container image).
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
# `py`     — Python quality gate (host-side, needs uv; see
#            docs/python-tooling.md): ruff format --check + ruff check +
#            ty type check + pytest (unit tests + doctests). The
#            RTL-facing scripts stay stdlib-only so make model/audit
#            also run inside the vibe-pio container (which has no uv).

SIM_DIR     := sim
RTL_DIR     := rtl
FORMAL_DIR  := formal
BUILD_DIR   := build

# All top-level testbenches: glob-discovered; tb_common.sv is an include, not a TB.
TB_LIST := $(filter-out $(SIM_DIR)/tb_common.sv,$(wildcard $(SIM_DIR)/tb_*.sv))
RTL_SRC := $(wildcard $(RTL_DIR)/*.sv)

IVERILOG = iverilog -g2012 -I $(SIM_DIR)
VVP      = vvp

.PHONY: sim syn formal audit model equiv py toolcheck clean $(TB_LIST)

toolcheck:
	@echo "=== toolchain versions ==="
	@iverilog -V 2>&1 | head -1
	@yosys -V
	@sby --version
	@z3 --version
	@boolector --version | tail -1
	@echo "btormc $$(btormc --version | tail -1)"
	@python3 --version
	@if command -v uv >/dev/null; then \
		echo "uv $$(uv --version | cut -d' ' -f2) (host-side Python tooling)"; \
		uv run --quiet ruff --version; \
		uv run --quiet ty --version; \
		uv run --quiet pytest --version | head -1; \
	else echo "uv: not found (make py unavailable; see docs/python-tooling.md)"; fi

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

py:
	uv run ruff format --check .
	uv run ruff check .
	uv run ty check
	uv run pytest

clean:
	rm -rf build sim_out formal/out formal/*_bmc formal/*_prove formal/*_cover

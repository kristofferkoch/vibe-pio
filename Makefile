# vibe-pio top-level Makefile
#
# `sim`    — compile-and-run every sim/tb_*.sv (except tb_common.sv, the
#            shared include file) with iverilog -g2012, aggregate pass/fail,
#            exit nonzero if any TB fails. TBs are discovered by glob so
#            parallel work never needs to edit this file.
# `syn`    — yosys elaboration (hierarchy check) of every rtl/*.sv.
# `formal` — run every formal/*.sby task.

SIM_DIR     := sim
RTL_DIR     := rtl
FORMAL_DIR  := formal
BUILD_DIR   := build

# All top-level testbenches: glob-discovered; tb_common.sv is an include, not a TB.
TB_LIST := $(filter-out $(SIM_DIR)/tb_common.sv,$(wildcard $(SIM_DIR)/tb_*.sv))
RTL_SRC := $(wildcard $(RTL_DIR)/*.sv)

IVERILOG = iverilog -g2012 -I $(SIM_DIR)
VVP      = vvp

.PHONY: sim syn formal toolcheck clean $(TB_LIST)

toolcheck:
	@echo "=== toolchain versions ==="
	@iverilog -V 2>&1 | head -1
	@yosys -V
	@sby --version
	@z3 --version
	@boolector --version | tail -1
	@echo "btormc $$(btormc --version | tail -1)"
	@python3 --version

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

clean:
	rm -rf build sim_out formal/out formal/*_bmc formal/*_prove formal/*_cover

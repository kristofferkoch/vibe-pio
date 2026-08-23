# vibe-pio top-level Makefile (skeleton; targets become real with KANBAN items)

SIM_SRC := $(wildcard rtl/*.v)
SIM_TOP ?= pio_block

.PHONY: sim syn formal toolcheck clean

toolcheck:
	@echo "=== toolchain versions ==="
	@iverilog -V 2>&1 | head -1
	@yosys -V
	@sby --version
	@z3 --version
	@boolector --version | tail -1
	@echo "btormc $$(btormc --version | tail -1)"
	@python3 --version

sim:
	@echo "TODO: iverilog simulation (see KANBAN 'Toolchain bootstrap')"

syn:
	@echo "TODO: yosys elaboration check"

formal:
	@echo "TODO: run sby tasks in formal/"

clean:
	rm -rf build sim_out formal/out

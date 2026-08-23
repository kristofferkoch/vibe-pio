# vibe-pio top-level Makefile (skeleton; targets become real with KANBAN items)

SIM_SRC := $(wildcard rtl/*.v)
SIM_TOP ?= pio_block

.PHONY: sim syn formal clean

sim:
	@echo "TODO: iverilog simulation (see KANBAN 'Toolchain bootstrap')"

syn:
	@echo "TODO: yosys elaboration check"

formal:
	@echo "TODO: run sby tasks in formal/"

clean:
	rm -rf build sim_out formal/out

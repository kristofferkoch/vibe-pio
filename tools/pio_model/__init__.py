"""tools/pio_model — clk-accurate golden model of one pio_block, all
four SMs live (SPEC-16-13; the miter keeps the SPEC-16-4 single-SM
scoping), plus the native assembler/disassembler and the SPEC-16-7
trace machinery used by the RTL differential harness (difftest.py).

Modules:
  encoding  — instruction-word split/encode/decode (SPEC-2 tables, the
              class-0x4 overload SPEC-14.2-1, reserved encodings SPEC-13-1)
  asm       — native .pio assembler (the pico-examples directive subset)
  disasm    — word -> pioasm-syntax text disassembler
  model     — the cycle-accurate block model, transcribed 1:1 from rtl/
              (divider CC-26, exec/shift/fifo, gpio mux, irq flags)
  tracefmt  — SPEC-16-7 trace emission + equivalence-aware comparison
  stim      — stimulus schedules (pio-stim v1, SM-indexed vocabulary)
              + the conformance schedules (19 CF programs mirroring
              sim/tb_conf_pioexamples.sv + the multi-SM corpus)
  difftest  — CLI: assembler/pioasm bit-equality, model-vs-RTL conformance
              matrix (incl. multi-SM), randomized differential fuzzing
              (half multi-SM), mutation demo (incl. multi-SM bugs)
"""

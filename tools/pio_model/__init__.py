"""tools/pio_model — C12: clk-accurate single-SM golden model of one
pio_block (SM0 live, SM1..3 held disabled per SPEC-16-4's single-SM
scoping), plus the native assembler/disassembler and the SPEC-16-7 trace
machinery used by the RTL differential harness (difftest.py).

Modules:
  encoding  — instruction-word split/encode/decode (SPEC-2 tables, the
              class-0x4 overload SPEC-14.2-1, reserved encodings SPEC-13-1)
  asm       — native .pio assembler (the pico-examples directive subset)
  disasm    — word -> pioasm-syntax text disassembler
  model     — the cycle-accurate block model, transcribed 1:1 from rtl/
              (divider CC-26, exec/shift/fifo, gpio mux, irq flags)
  tracefmt  — SPEC-16-7 trace emission + equivalence-aware comparison
  stim      — stimulus schedules (pio-stim v1) + the 19 conformance
              program schedules (configs mirror sim/tb_conf_pioexamples.sv)
  difftest  — CLI: assembler/pioasm bit-equality, model-vs-RTL conformance
              matrix, randomized differential fuzzing, mutation demo
"""

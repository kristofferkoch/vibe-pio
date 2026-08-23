# KANBAN

Planned work items **only**. When an item is completed, the finishing commit
deletes it from this file. Loose ideas must NOT be added here — put them in
`IDEAS.md` and promote them after a grilling session.

## Phase 0 — Reproducible toolchain

- [ ] Container (`container/Dockerfile`, podman/docker): lightweight image with
      iverilog (≥12), yosys, SymbiYosys (sby), an SMT solver (z3 and/or
      boolector), plus make and python3; pin versions, add a
      `make toolcheck` target that prints tool versions inside the container,
      and record usage in `docs/toolchain.md`.
- [ ] Verify `make sim` / `syn` / `formal` skeletons run inside the container.

## Phase 1 — Specification acquisition & cross-check (FIRST substantive task)

- [ ] Obtain the RP2350 datasheet PDF (raspberrypi.com,
      `rp2350-datasheet.pdf`) and the `pioasm` assembler sources
      (github.com/raspberrypi/pioasm); store version/commit identifiers in
      `docs/spec-sources.md` for reproducibility.
- [ ] Extract PIO facts from the datasheet §PIO into `docs/pio-spec.md`:
      instruction encodings for all 8 classes, delay/side-set encoding,
      FIFO depths and join modes, autopush/pull thresholds, IRQ semantics,
      clock divider behaviour, exec/wrap, GPIO mapping, input synchronizers,
      differences from RP2040 (3 PIO blocks, 36-instruction memory, etc.).
- [ ] Cross-check the extracted spec against `pioasm` sources (instruction
      encoding tables, assembler semantics) and note any discrepancies or
      datasheet ambiguities in `docs/pio-spec.md`.
- [ ] Decide verification semantics: cycle-boundary conventions for
      shift-out/shift-in, side-set vs delay ordering, stall behaviour per
      instruction (document as a "cycle contract" in `docs/cycle-contract.md`).

## Phase 2 — Architecture draft

- [ ] Draft module architecture in `DESIGN.md` from the verified spec:
      instruction memory per PIO block (shared by its 4 state machines),
      state machine pipeline (decoder/exec/shift/fifo/regs), IRQ flags,
      GPIO mux, config register interface. Rough is fine — architecture can
      be redeveloped later; the draft fixes vocabulary and interfaces.

## RTL (depends on Phase 1 & 2)

- [ ] `rtl/pio_sm_shift.v`: OSR/ISR shifters, shift counters, autopush/pull
      thresholds; standalone-formal bounds properties.
- [ ] `rtl/pio_sm_fifo.v`: 8-deep (configurable) RX/TX FIFOs, join modes,
      push/pull stall semantics; formal full/empty/bounds proofs.
- [ ] `rtl/pio_sm_decoder.v`: instruction decode for all 8 instruction
      classes with side-set/delay extraction; formal decode coverage
      (every encoding maps to a defined control bundle).
- [ ] `rtl/pio_sm_exec.v`: execute stage — JMP conditions, WAIT variants,
      MOV sources/destinations, SET, OUT/IN dispatch, delay/side-set
      post-processing, wrap.
- [ ] `rtl/pio_sm.v`: assemble SM; directed tests for each instruction.
- [ ] `rtl/pio_irq_flags.v`: IRQ set/rel/clear/nowait semantics and
      inter-SM relay.
- [ ] `rtl/pio_instr_mem.v`: instruction memory with symbolic-friendly
      read (no asynchronous loops); later to be replaced by anyconst formals.
- [ ] `rtl/pio_gpio_mux.v`: input synchronizers and output muxing.
- [ ] `rtl/pio_block.v`: top-level PIO block integrating the above.

## Testbenches (sim/)

- [ ] Smoke testbench running a hand-written blink program end-to-end.
- [ ] Per-instruction directed tests mirroring the RP2350 datasheet examples
      (e.g. ws2812, spi, uart snippets).

## Formal (formal/)

- [ ] Per-module SymbiYosys setups (BMC then k-induction) for shift, fifo,
      decoder, exec.
- [ ] Equivalence/performance contract: reference behavioural spec vs RTL
      for a fixed program.
- [ ] Symbolic program synthesis harness: free instruction memory +
      behavioural assertions; extract witness program from solver.

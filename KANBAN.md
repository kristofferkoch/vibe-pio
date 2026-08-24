# KANBAN

Planned work items **only**. When an item is completed, the finishing commit
deletes it from this file. Loose ideas must NOT be added here — put them in
`IDEAS.md` and promote them after a grilling session.

Card conventions (all RTL cards):

- RTL follows DESIGN.md "RTL conventions": `.sv` files, `clk`/`rst`,
  `_r`/`_n` suffixes, onehot `localparam` FSM states, one `always_ff` per
  register group, all state reset by `rst`, `logic` only, explicit widths.
- **Traceability rule**: every RTL comment and formal assertion cites the
  SPEC-/CC- IDs it implements/verifies. An assertion citing no fact is
  unsourced; a fact with no assertion is unverified.
- **Done-when (every card)**: `iverilog -g2012` compiles the module plus
  its testbench; `yosys read_verilog -sv` elaborates the module clean
  (hierarchy check); `make sim` runs the card's directed TB and passes;
  its `formal/*.sby` passes BMC and `prove` (k-induction) unless noted.
- Full port lists live in DESIGN.md §Module descriptions — not duplicated
  here.

## Implementation (was "RTL"; depends on Phase 1 & 2)

### C10 — `rtl/pio_block.sv` (block assembly)

- **Scope**: instantiate `u_imem` (C1), `u_sm0..u_sm3` (C9, no generate),
  `u_irq` (C6), `u_gpio` (C7); flat reg-bus slave with local block-reg
  decode (CTRL, FSTAT, FDEBUG, IRQ, IRQ_FORCE, INPUT_SYNC_BYPASS,
  DBG_PADOUT/OE, INSTR_MEM, RXFx_PUTGET) + per-SM decoded forwarding;
  datasheet reset defaults on every field.
- **Grounding**: SPEC-1-2, SPEC-1-3, SPEC-7-1..13 (block-level subset);
  CC-30, CC-33, CC-37 (block boundary ownership).
- **Deps**: C1, C6, C7, C9.
- **Acceptance**: directed TB: blink program end-to-end via reg bus
  (program imem, configure SM, observe gpio_out); FLEVEL/FSTAT readback
  after pushes/pulls; IRQ force + W1C over the bus. Formal (bmc, deep
  enough for a few ticks; prove optional — integration depth): reg write
  @e observed by SM tick ≥ e+1 (CC-33/CC-30); INSTR_MEM write visible to
  next fetch; flag path stays registered end-to-end (CC-37).

## Later-level backlog (coarse by design — detail at launch)

### Testbenches (sim/)

- [ ] Ingest official pico-examples PIO programs (ws2812, spi, uart, i2c,
      ...) as conformance tests with expected waveforms from the example
      documentation (SPEC-15-1..10 are the observations to hit; CC-24
      clocked_input, CC-31 spi tail are named targets). Depends: C10.
- [ ] UART TX loopback conformance test at a realistic clkdiv, checking
      bit timing against the divider model (CC-26/CC-2). Depends: C10.

### Formal (formal/)

- [ ] Traceability audit script: cross-check assertion-cited SPEC-/CC-
      IDs in `rtl/`+`formal/` against the fact/clause indexes; report
      unverified facts and unsourced assertions. Depends: C0 + any RTL.
- [ ] Equivalence/performance contract: reference behavioural spec vs
      RTL for a fixed program (miter or co-simulation in formal/).
      Depends: C10.
- [ ] Symbolic program synthesis harness: anyconst `pio_instr_mem` swap
      (reset disabled in harness), behavioural assertions on GPIO/FIFO
      ports of `pio_top`, extract witness program; run as BMC/cover, not
      k-induction. Depends: C10 (and `pio_top`, which itself remains a
      later-level item: 3 blocks + cross-block IRQ relay per CC-38 and
      DESIGN.md pio_top section).

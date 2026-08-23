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

### C2 — `rtl/pio_sm_shift.sv`

- **Scope**: OSR/ISR 32-bit shifters, two saturating 6-bit counters,
  single `shift_left` boolean direction, IN rotate/self-shift path,
  autopull/autopush *decision* outputs (threshold compare against
  start-of-tick counter; thresholds with 0⇒32 decoding). Pure datapath —
  control handshakes come from exec.
- **Grounding**: SPEC-5-1..10, SPEC-3.3-7/8/9, SPEC-2-18, SPEC-15-1,
  SPEC-3.6-14; CC-9, CC-11, CC-13, CC-17, CC-18, CC-4.
- **Deps**: none.
- **Acceptance**: directed TB: LSB/MSB shifts of each width 1..32
  (bitcount 0 ⇒ 32), counter saturation, reset values (ISR cnt 0, OSR
  cnt 32 — SPEC-5-3), rotate/self-shift of ISR. Formal (standalone, bmc +
  prove): `isr_cnt <= 32 && osr_cnt <= 32`; counters saturate (never
  wrap); shift-out amount ≤ bitcount per tick; threshold compare uses
  registered (start-of-tick) counters — CC-4.

### C3 — `rtl/pio_sm_fifo.sv`

- **Scope**: TX + RX 4-deep FIFOs with one shared RX storage array;
  FJOIN_TX / FJOIN_RX joins (8-deep); FJOIN_RX_PUT/GET aux modes
  (`aux_wr[idx,data]` / `aux_rd[idx]` port pair, mode input
  txrx|tx|rx|txput|txget|putget redirecting RX addressing); FJOIN change
  flushes; FDEBUG sticky flags (TXSTALL/RXSTALL/TXOVER/RXUNDER set-only
  outputs). SM-side push/pop/level/full/empty; system-side TX write / RX
  read at clk rate.
- **Grounding**: SPEC-6-1..9, SPEC-3.7-3..7, SPEC-3.5-8, SPEC-7-13;
  CC-19, CC-20, CC-21, CC-29, CC-30, CC-32.
- **Deps**: none.
- **Acceptance**: directed TB: fill/drain each mode, join depth checks,
  PUT/GET random-access, flush-on-mode-change, sticky-flag set/clear.
  Formal (bmc + prove): `level <= depth` per direction with mode-dependent
  depth 0/4/8 (SPEC-6-1..4); no overflow/underflow pop/push; sticky flags
  set-only until explicit clear; PUT/GET never assert stall (CC-21);
  system-write@e visible to SM side from e+1 (CC-30).

### C4 — `rtl/pio_sm_decoder.sv`

- **Scope**: pure combinational decode of the 16-bit word: field
  extraction (delay/side-set split per SIDE_EN/SIDESET_COUNT), onehot
  instruction-class strobes, JMP condition code, WAIT src/pol, IN/OUT
  src/dst + bitcount-0⇒32, MOV src/dst/op, SET dst, PUSH/PULL
  IfE/IfF/blk flags, IRQ Clr/Wait/idxmode/index; class-0x4 overload rule
  (arg2[4] ⇒ PUT/GET, else PUSH/PULL, reserved ⇒ illegal output);
  reserved encodings decoded to explicit no-op/illegal strobes.
- **Grounding**: SPEC-2-1..18, SPEC-3.7-1/2, SPEC-14.2-1, SPEC-4-1..9
  (delay/side-set field split), SPEC-13-1/2, SPEC-14.8-1.
- **Deps**: none.
- **Acceptance**: directed TB: decode of every master-encoding-table row
  (SPEC §2 table) plus all 8 class opcodes; delay/ss field split at
  SIDESET_COUNT 0..5 incl. SIDE_EN edge values. Formal: onehot of
  class strobes over free (anyconst) 16-bit input; decode is a pure
  function (assert against a reference truth table snippet in the
  property file); illegal output iff reserved encoding per SPEC-13-1.
  Stateless ⇒ BMC depth 1 + combinatorial `prove` suffices.

### C5 — `rtl/pio_sm_regs.sv`

- **Scope**: per-SM config field bank (CLKDIV INT/FRAC, PINCTRL,
  EXECCTRL, SHIFTCTRL — fields as register-level inputs, banked registers
  with datasheet reset defaults) plus the clk-rate clock divider: 8-bit
  phase accumulator + counter producing one-clk `sm_tick` strobe (tick
  cycle T+1 after terminal count at T), `clkdiv_restart` handling,
  INT=0 ⇒ 65536 (FRAC forced 0), SM enable gating.
- **Grounding**: SPEC-7-2, SPEC-7-3, SPEC-7-14..26, SPEC-7-27; CC-26,
  CC-27, CC-28, CC-25, CC-36 (phase not disturbed by force-tick input).
- **Deps**: none.
- **Acceptance**: directed TB: divisor 1 ⇒ tick every clk; INT/FRAC
  pattern average period; INT=0; restart resets phase/count; disabled SM
  produces no ticks. Formal (bmc + prove; divider proven standalone per
  DESIGN.md "k-induction tractability" so SM proofs assume the interface
  property): consecutive `sm_tick` ≥ INT clk cycles apart (CC-25/CC-26);
  `sm_tick` at most 1 clk wide; restart ⇒ phase==0 && count==0 next
  cycle (CC-27); phase/cnt bounds; two instances with equal config +
  simultaneous restart have identical tick histories (CC-27 lockstep).

### C6 — `rtl/pio_irq_flags.sv`

- **Scope**: 8-flag register; per-SM `irq_set`/`irq_clr` +
  `flag_idx`+`idx_mode` (this/PREV/REL/NEXT routing inputs fed from
  outside; module takes pre-resolved per-source set/clear vectors plus
  prev/next buses); bus `irq_w1c`, `irq_force`; `flags[7:0]` readback.
  Registered flags only — no combinational path from request to read.
- **Grounding**: SPEC-3.8-4..8, SPEC-14.3-1, SPEC-7-6; CC-37, CC-39
  (clear-wins), CC-16 (flag set visible next cycle).
- **Deps**: none.
- **Acceptance**: directed TB: set/clear from each writer class, W1C,
  force, simultaneous set+clear ⇒ clear wins. Formal (bmc + prove):
  flags are registered (no comb path — assert `flags` unchanged unless
  clk edge with a writer); set@cycle c readable from c+1 only (CC-37);
  set+clear same cycle ⇒ clear wins (CC-39); prev/next outputs equal
  flags (block-level relay handled by pio_top later).

### C7 — `rtl/pio_gpio_mux.sv`

- **Scope**: input path — per-pin 2-FF synchronizers + per-pin bypass
  mask, per-SM rotated/masked `in_bus[31:0]` (IN shift base), `jmp_pin`
  selection; output path — 32-bit level and OE registers resolving
  per-SM write bundles (side-set vs OUT/SET within SM, highest-SM-wins
  across SMs), OUT_STICKY re-assert registers, DBG_PADOUT/OE readback.
- **Grounding**: SPEC-10-1..8, SPEC-7-7, SPEC-7-8; CC-5 (sticky),
  CC-6, CC-7, CC-8, CC-23, CC-24.
- **Deps**: none.
- **Acceptance**: directed TB: pad toggle visible at k+2 (k+1 bypassed);
  rotation for several IN bases; priority experiments with 2+ writers.
  Formal (bmc + prove): sync-FF shift-register equivalence (pad@k ==
  seen@k+2, bypass@k == seen@k+1 — CC-23); output resolution matches a
  reference per-pin resolution function in the property file (CC-6/CC-7);
  OUT_STICKY re-assert during stalls (CC-5); registers reset to 0.

### C8 — `rtl/pio_sm_exec.sv`

- **Scope**: tick-rate control core: onehot FSM (`ST_FETCH`, `ST_EXEC`,
  delay, stall states), PC update + wrap-top/wrap-bottom logic, delay
  counter, side-set application, X/Y registers, JMP condition
  evaluation, WAIT variants (gpio/pin/jmppin/irq with wait/clear),
  MOV op (:op sources and op inversion), SET, OUT/IN dispatch to shifter,
  PUSH/PULL dispatch (block/noblock/ifempty/iffull), EXEC latch
  (shared forced-instruction register), force-tick OR and CC-36 deferral.
  Developed against the port contracts of C2/C3 (instantiated or stubbed
  per the property wrapper).
- **Grounding**: SPEC-3.1-1..11, SPEC-3.2-1..9, SPEC-3.3-x, SPEC-3.4-x,
  SPEC-3.5-1..13, SPEC-3.6-1..14, SPEC-3.8-1..10, SPEC-3.9-1..3,
  SPEC-4-1..9, SPEC-8-1..4, SPEC-9-1..7, SPEC-11-1, SPEC-14.5-1,
  SPEC-14.6-1, SPEC-14.7-1; CC-4..CC-22, CC-31, CC-34, CC-35, CC-36.
- **Deps**: C4 (decoder bundle), C2+C3 (interface contracts; full-system
  tests come in C9).
- **Acceptance**: directed TB with shifter/FIFO instances: each JMP
  condition, each WAIT variant incl. stall-release timing, MOV all
  src/dst/op combos, SET, delay counting, wrap, `irq wait` two-phase,
  `pull ifempty` guard-at-own-tick (CC-31 scenario). Formal (bmc +
  prove, divider abstracted as `sm_tick` min-gap assumption from C5):
  onehot FSM; stall invariants — while stalled: `pc` holds, delay holds,
  first condition-true tick is the completion tick (CC-14/CC-15/CC-16);
  delayed execution d+1 ticks after completion (CC-10); force-tick wins
  over coinciding `sm_tick`, divider phase untouched (CC-36); EXEC
  latch: executee runs on next tick, PC not advanced by it (CC-34).

### C9 — `rtl/pio_sm.sv` (assembly)

- **Scope**: instantiate `u_regs` (C5), `u_decoder` (C4), `u_exec` (C8),
  `u_shift` (C2), `u_fifo` (C3); wire per DESIGN.md pio_sm diagram;
  `SM_RESTART` clears only the SPEC-7-3 subset; per-SM reg decode inputs
  from block; outputs to block (pin writes, irq req, FIFO system ports,
  pc/flevel/exec_stalled readbacks).
- **Grounding**: SPEC-1-3, SPEC-1-5, SPEC-7-3, SPEC-11-1; CC-1..CC-36
  (integration of all module clauses).
- **Deps**: C2, C3, C4, C5, C8.
- **Acceptance**: directed TB per instruction class (datasheet snippets:
  one JMP/WAIT/IN/OUT/PUSH/PULL/MOV/IRQ/SET program each, divisor 1,
  cycle-by-cycle expected values); ws2812-side-set stall-persistence
  micro-test (CC-5/CC-22). Formal (bmc + prove, divider assumed):
  cross-module invariants — autopull refill never feeds a same-tick OUT
  (CC-12 fence), autopush pushes post-shift ISR (CC-9), stall freeze of
  shifter (CC-13 full-RX stall), onehot FSM inherited.

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

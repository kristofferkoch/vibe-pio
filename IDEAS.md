# IDEAS

Loose, undiscussed ideas from humans and LLMs. Anything here is **not**
agreed work. Items are promoted to `KANBAN.md` only after a grilling
session. Append freely; prune ruthlessly when promoted or rejected.

- Should we also model the RP2350's PIO "input synchronizer bypass" and
  the new-to-RP2350 features (e.g. GPIO-out override, DOORBELL IRQs)?
  Or target the RP2040 subset first for simplicity?
- Coverage-driven random program testing: generate random PIO programs +
  expected traces from a Python golden model, diff against RTL.
- Could the synthesis harness use `cover` statements to *mine* programs
  for common protocols (I2C, SPI modes, UART) rather than assertions only?
- Fpga target? (iCE40/ECP5 via yosys+nextpnr) as a real-world gate check.
- Export witness programs as .pio assembler source for pioasm compatibility.
- Property-based "differential" testing against the actual RP2350 silicon
  via a hardware-in-the-loop capture rig (long-term).
- Formal result cache: skip (or fast-path) `make formal` tasks whose
  inputs are unchanged — hash each task's [script]+[files] (RTL, fv,
  .sby) plus toolchain version, and reuse the previous PASS/FAIL
  verdict when the hash matches. Motivation: pio_sm_fifo's first
  correct-properties run burned 20+ min of z3 before the dead-memory
  prune made it a 2 s job; re-verifying untouched modules after every
  edit wastes the same CPU again. (C8 hit the same wall: the exec fv
  instantiated the real C3 FIFOs until a storage-free contract stub —
  sanctioned by the card's "instantiated or stubbed" wording — cut the
  run from ~25 min of z3 to seconds.)
- Pin the microsemantics of EXECCTRL.OUT_EN_SEL / INLINE_OUT_EN
  (SPEC-7-17, "one bit of OUT data as an auxiliary per-pin write
  enable") and implement them in pio_sm_exec/pio_gpio_mux: docs/ only
  carries the one-line register description, which is not enough to
  code against (which OUT variants, which pins, interaction with
  SIDE_PINDIR/OUT_STICKY). C8 left both fields unimplemented and
  unconnected; decide before C10 wires the block reg bus.
- Pin autopull semantics in FIFO aux modes: pioasm rejects autopush in
  txput/txget/putget (SPEC-3.7-6) but permits *autopull* alongside any
  aux config, and SPEC-6-4 says the TX FIFO stays "fully usable" there
  — yet C8's u_exec scopes the autopull machinery to
  {txrx,tx,txput,txget}, i.e. autopull is inert in putget. Surfaced by
  the C9 integration FV (the CC-11 stall guard had to exclude
  FM_PUTGET to match); unpinned by DS/docs either way, so kept as the
  C8 contract. Decide before the C10 block proof pins FIFO behaviours.
- Manchester loopback (tb_conf_pioexamples CF12): the rx decodes the
  first word exactly, then walks (word 2 decodes as 0xffff_f000).
  Falsified theory: synchroniser margin — CLKDIV INT=1/2/4 (divider
  verified by readback) produce byte-identical results, so the 2-clk
  sync is exonerated and the divergence is deterministic in the tick
  domain. The example runs on silicon at div 1, so this is a real,
  reproducible behavioural difference in our model, not a program bug —
  but it violates no pinned SPEC/CC clause (all FV + the other 15
  conformance programs pass). Bisect recipe: word0 (all zeros) hides
  where the walk starts — re-run with word0 = 0x80000000 (first bit
  still 0 for the arming assumption, tail bits visible) and tick-trace
  both SMs (pc0, pc1, line) through the first word boundary; first
  suspects are (a) the tx's 33rd `out x,1`/autopull refill costing a
  tick (a 13-tick bit), (b) our WAIT completing on an already-matching
  level one tick earlier than silicon, or (c) a 1-tick difference in
  JMP-PIN sample alignment. Each is individually unpinned by the docs.
- Sim-level latency checks (CC-23/CC-24) are shift-invariant: injecting
  "seen bus fed from sync-FF1" or "in_bus from the raw pad" into
  pio_gpio_mux leaves CF8 green, because the WAIT's edge detection and
  the IN's data capture shift together — the clocked_input protocol is
  latency-tolerant by design (the example's own "input clock < sys/6"
  margin note). Pinning the absolute sampling latency needs a formal
  property (the FV suites already carry CC-23 shift-register
  equivalence), not a directed sim.

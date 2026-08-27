# IDEAS

Loose, undiscussed ideas from humans and LLMs. Anything here is **not**
agreed work. Items are promoted to `KANBAN.md` only after a grilling
session. Append freely; prune ruthlessly when promoted or rejected.

- Should we also model the RP2350's PIO "input synchronizer bypass" and
  the new-to-RP2350 features (e.g. GPIO-out override, DOORBELL IRQs)?
  Or target the RP2040 subset first for simplicity?
- Fpga target? (iCE40/ECP5 via yosys+nextpnr) as a real-world gate check.
- Property-based "differential" testing against the actual RP2350 silicon
  via a hardware-in-the-loop capture rig (long-term).
- Formal result cache: skip (or fast-path) `make formal` tasks whose
  inputs are unchanged — hash each task's [script]+[files] (RTL, fv,
  .sby) plus toolchain version, and reuse the previous PASS/FAIL
  verdict when the hash matches. Motivation: pio_sm_fifo's first
  correct-properties run burned 20+ min of z3 before the dead-memory
  prune made it a 2 s job; re-verifying untouched modules after every
  edit wastes the same CPU again. (The exec fv hit the same wall: it
  instantiated the real FIFOs until a storage-free contract stub —
  sanctioned by the card's "instantiated or stubbed" wording — cut the
  run from ~25 min of z3 to seconds.)
- Pin the microsemantics of EXECCTRL.OUT_EN_SEL / INLINE_OUT_EN
  (SPEC-7-17, "one bit of OUT data as an auxiliary per-pin write
  enable") and implement them in pio_sm_exec/pio_gpio_mux: docs/ only
  carries the one-line register description, which is not enough to
  code against (which OUT variants, which pins, interaction with
  SIDE_PINDIR/OUT_STICKY). The RTL leaves both fields unimplemented
  and unconnected; decide before anything depends on them.
- Pin autopull semantics in FIFO aux modes: pioasm rejects autopush in
  txput/txget/putget (SPEC-3.7-6) but permits *autopull* alongside any
  aux config, and SPEC-6-4 says the TX FIFO stays "fully usable" there
  — yet `pio_sm_exec` scopes the autopull machinery to
  {txrx,tx,txput,txget}, i.e. autopull is inert in putget. Surfaced by
  the integration FV (the CC-11 stall guard had to exclude
  FM_PUTGET to match); unpinned by DS/docs either way, so kept as the
  current contract. Decide before a block-level proof pins FIFO
  behaviours.
- Sim-level latency checks (CC-23/CC-24) are shift-invariant: injecting
  "seen bus fed from sync-FF1" or "in_bus from the raw pad" into
  pio_gpio_mux leaves CF8 green, because the WAIT's edge detection and
  the IN's data capture shift together — the clocked_input protocol is
  latency-tolerant by design (the example's own "input clock < sys/6"
  margin note). Pinning the absolute sampling latency needs a formal
  property (the FV suites already carry CC-23 shift-register
  equivalence), not a directed sim.
- TIS-100-style competitive PIO game (grilled 2026-08-25 rounds 1–2;
  2026-08-26 round 3 pivoted the simulator into the browser — that
  engine track landed; the 2026-08-27 game-loop round 1 (sandbox)
  promoted the sandbox + multi-SM track, of which the sandbox itself
  has landed and the multi-SM cards (C22–C24) are on KANBAN with
  those owner decisions). Still open here, for the *level* grilling
  once the fun gate is re-read on the sandbox: each level = stimulus +
  a *receiver-style* conformance monitor (the SPEC-16-9 machinery,
  spec-eq mode) —
  acceptance is "the receiver got the right data", never
  golden-trace equality, with monitor profiles as a ladder of
  stricter parameterized tolerances over one receiver skeleton
  (profiles are the level's visible spec, versioned with the model);
  whether levels keep the 1-tick-1-cycle, clkdiv-abstracted
  rendering (sandbox exposes the real divider, levels need not);
  progression one SM → multi-SM parallel buses → DMA at most as
  late-game fixed-function pacing; score metric open (the
  hyperoptimizer's Pareto front is the natural fit), par/solvability
  proofs likewise (the equivalence/synthesis harnesses certify for
  free). Mock-up decisions live in
  `mockups/DESIGN-NOTES.md`.

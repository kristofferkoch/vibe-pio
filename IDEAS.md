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
- Sim-level latency checks (CC-23/CC-24) are shift-invariant: injecting
  "seen bus fed from sync-FF1" or "in_bus from the raw pad" into
  pio_gpio_mux leaves CF8 green, because the WAIT's edge detection and
  the IN's data capture shift together — the clocked_input protocol is
  latency-tolerant by design (the example's own "input clock < sys/6"
  margin note). Pinning the absolute sampling latency needs a formal
  property (the FV suites already carry CC-23 shift-register
  equivalence), not a directed sim.
- TIS-100-style competitive PIO game over SSH (grilled 2026-08-25,
  rounds 1–2). Each level = stimulus + a *receiver-style* conformance
  monitor (C15 machinery, spec-eq mode): a lenient behavioral sink —
  e.g. a naive UART that decodes bytes and shrugs at framing errors —
  so acceptance is "the receiver got the right data", never
  golden-trace equality. TIS-100's sneaky unit tests become a ladder
  of increasingly strict monitor *profiles* over one receiver skeleton
  (explicit tolerance parameters + nastier stimulus, never hand-tuned
  per level); profiles are the level's visible spec ("receiver
  datasheet" in-game manual page) and are versioned with the model.
  Sim is cycle-accurate at game scale: 1 tick = 1 cycle, clkdiv
  abstracted, timing windows in ticks (CC-style), no real-frequency
  anchoring. Progression: one SM first, multi-SM parallel buses later
  (cassette-emulator flavor), DMA at most as late-game fixed-function
  pacing — not modeled until then. The stored program IS the object
  code: 32×16-bit words + config overlay, canonical C12 disassembly
  as the only source form; no .defines/comments; labels are edit-time
  sugar that normalizes away (open: deterministic auto-labels derived
  from jump targets so canonical text stays readable without a stored
  symbol layer). Referee = tools/pio_model imported, never forked;
  monitor profiles and scores versioned with the model. Server =
  in-process SSH game daemon (pty per session, no shell — the
  "ssh coffee shop" model), one language (Python). Score metric
  deliberately open (C14's Pareto front is the natural fit when it
  lands); par/solvability proofs likewise (C14/C16 certify for free).
  Gate before any of it: a legible live SM view (pc/x/y/isr/osr,
  FIFO levels, decoded exec + delay countdown, pin waveform strip,
  single-step) — if that cannot be made fun, the game dies there.
  A web mock-up of that view exists (`mockups/sm-view.html`, served
  no-store via `mockups/serve.py`; decisions in
  `mockups/DESIGN-NOTES.md`): beyond-80×25 layout, semantic color
  grammar, config-as-margin-structure, no labels (jump arcs + address
  typography), VLIW-ish side/delay columns with a live ds-field
  allocator, modeless in-place row editing with trivial completions +
  strong tooltips, receiver monitor on-screen. The gate reads as
  passed; promotion to KANBAN still needs a grilling round.

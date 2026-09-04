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
  rendering (sandbox exposes the real divider, levels need not — the
  2026-09-04 level grilling answered it for chapters 0–1: abstracted);
  progression one SM → multi-SM parallel buses → DMA at most as
  late-game fixed-function pacing; score metric + par/solvability
  resolved 2026-09-04 by the level grilling — par = committed
  hyperopt Pareto fronts, solvability = per-level reference
  solutions, both gated in `make js`. The campaign's first chapters
  are KANBAN C34–C37 (the grilling's shape decisions on the cards);
  the chapter 2+ remainder is the learning-curve entry below.
  Mock-up decisions live in
  `mockups/DESIGN-NOTES.md`; the level curve in
  `mockups/LEVELS-NOTES.md`.
- Keyboard-only navigation (DOS/Win3.11 idiom) + the light era skin:
  **promoted to KANBAN C25/C26** after the 2026-08-29 grilling
  round 1. Owner decisions on the record: light skin (the dark-slate
  palette retires); CRT/scanline = none on the chrome — at most
  sparing *game-transition* effects much later, never WebGL UI sims;
  one master window (group frames inside, navy title bar — not a
  desktop of fake-floating windows); hue-true light-tuned semantic
  palette, not snapped to VGA-16; two bitmap fonts (MS Sans for
  chrome + a bitmap mono for code, final pick at mockup); and a
  standing headless keyboard-walk as the second sanctioned DOM-glue
  exception (after page geometry). Still open here, for later
  rounds: whether the level shell inherits the skin verbatim or gets
  its own dressing; zoom policy beyond 100%; transition effects once
  levels exist. Era canon for whoever picks this up: IBM SAA
  **CUA '89/'91**; MS Press **"The Windows Interface: An Application
  Design Guide" (1992)** — archive.org scan; **"The Windows
  Interface Guidelines for Software Design" (1995)**; the Win95 UI
  team's design briefing; SerenityOS's LibGUI.
- The C30 cursor chip behind the wrap steppers (found in the card's own
  browser session, 2026-08-30, left for a grilling): the chip's margin
  slot is bounded by the bracket (x < 9), the wrap steppers (x ≥ 15 on
  the two arc-end rows), and the .cur bar (x 43) — three tenants whose
  union leaves no x that clears all rows, so the chip (x 9, ~25px wide)
  rides under the steppers wherever a cursor sits on an arc-end row.
  The gated boot posture never sees this (all-zero memory is jmp 0;
  the four cursors park on row 00, whose tenants are bracket + bar
  only). But the demo preset rests there: WRAP_BOTTOM=0 parks the
  wrap-bot pair ON row 0, and the resting cluster (SM0 plus the three
  disabled-but-parked SMs, "0123") sits mostly behind the pair —
  measured live, only the first digit's left ~7px shows, 0.8px of it
  clipped. Open questions if promoted: do disabled SMs get gutter
  marks at all (their PC is a reset artifact — the cluster in the
  demo is three digits of "parked machines are parked")? Does the
  chip dodge, yield (hide on arc-end rows), or does the stepper pair
  move? The C22/C26 gates pin the stepper boxes exactly, so moving
  them is the expensive answer.
- The `?row=31` demo URL opens its editor and immediately loses it
  (found in C31's browser session, 2026-08-30; pre-existing — the
  shipped page does it too): `applyUrlParams` runs on the worker's
  'ready', `openRow` focuses the instruction cell, and the 'load'
  state replies that follow rebuild the listing
  (`buildProgram` → `host.replaceChildren(...nodes, RE)` re-seats the
  editor node) while the auto-scroll-to-reveal of a below-the-fold row
  races the focusout-commit path — the editor closes itself
  (`curRow` back to -1, no error). `?row=2` (above the fold) survives.
  Open questions if promoted: should the demo-URL row wait for the
  state replies to settle before opening (or re-focus after the
  rebuild), and is `replaceChildren` moving a focused RE the general
  hazard (any state reply while editing scrolls/rebuilds)?
- Level learning curve — chapters 0–1 promoted to KANBAN C34–C37 by
  the 2026-09-04 grilling (owner decisions on the cards; the notes in
  `mockups/LEVELS-NOTES.md` stay the design spec). Still open there,
  for the chapter 2+ grilling once the fun gate reads on 0–1: the
  monitor flip to receiver-style conformance (decoded-byte acceptance,
  SPEC-16-9 machinery — the C35 timing-profile ladder is the skeleton
  it parameterizes), the stall-as-curriculum level (pull on a dry TX),
  the designed fencepost on `jmp x--` (SPEC-3.1-4), autopull as
  reward, the ch.3 UART boss and whether its ch.4 sideset re-solve
  generalizes into a standing capstone type, Coffee-Time breather
  levels between chapters, sideset's garbling spectacle, wait and
  multi-SM, and whether later chapters keep the 1-tick-1-cycle
  clkdiv-abstracted rendering.

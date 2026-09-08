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
  has landed and the multi-SM cards (C22–C24) landed with those owner
  decisions). The *level* grilling ran 2026-09-04 (chapters 0–1,
  C34–C37), 2026-09-06 (chapter 2, C39–C41), and 2026-09-08
  (chapter 3, C44–C47): each level = stimulus
  + a *receiver-style* conformance monitor (the SPEC-16-9 machinery)
  — acceptance is "the receiver got the right data", never
  golden-trace equality, with monitor profiles as a ladder of
  stricter parameterized tolerances over one receiver skeleton
  (profiles are the level's visible spec, versioned with the model);
  the receiver flip itself is scheduled as C39 (RX judge) / C40
  (decode judge). Progression one SM → multi-SM parallel buses → DMA
  at most as late-game fixed-function pacing; score metric + par =
  committed hyperopt Pareto fronts, solvability = per-level reference
  solutions, both gated in `make js`. The chapter 4+ remainder is the
  learning-curve entry below. Mock-up decisions live in
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
  rounds: zoom policy beyond 100% — the rest has since resolved (the
  level shell inherits the skin verbatim, C34; transition effects
  resolved 2026-09-06 at the front-door grilling — none stands, the
  era-true content swap stays parked on the much-later pile). Era
  canon for whoever picks this up: IBM SAA
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
- A source-less `wait <pol>` reports a nonsense operand name (found in
  C32's browser session, 2026-09-04; pre-existing — pio-asm.js and
  edRowText are untouched by C32): committing or previewing `wait 1`
  (edRowText trims, so the live mid-typing state `wait 1 ` previews
  it too) fails with "unknown wait operand Cannot read properties of
  undefined (reading 'replace')" — encodeCore's wait path does
  `stripCommas(parts[1])` with parts[1] undefined, and the TypeError
  boundary that exists to convert badOperand's TypeError into an
  AsmError mislabels this unrelated TypeError as an operand problem.
  The strip's job (say why there is no word) is right; the words are
  gibberish to a learner. Open questions if promoted: guard the wait
  parser (a real "wait needs pol src index" AsmError), and is the
  TypeError-as-operand-error boundary too broad generally (any
  accidental TypeError inside encodeCore would wear the same mask)?
- Level learning curve — chapters 0–3 promoted (0–1 as KANBAN C34–C37
  by the 2026-09-04 grilling, 2 as C39–C41 by the 2026-09-06 grilling,
  3 as C44–C47 by the 2026-09-08 grilling; owner decisions on the
  cards, the notes in `mockups/LEVELS-NOTES.md` stay the design spec).
  The 2026-09-08 grilling resolved: the stall-as-curriculum level (L9
  — static feed, terminal dry-out, the investigate moment as a card),
  autopull as reward (L11 — config as given, not authored), and the
  ch.3 UART boss (L12 — designed for the ch.4 re-solve, decide
  generalization then). Still open there, for the chapter 4+
  grillings: whether the L12 sideset re-solve generalizes into a
  standing capstone type (one shipped instance in hand),
  Coffee-Time breather levels (deferred again 2026-09-08 — first
  candidate after ch4's boss), sideset's garbling spectacle, wait and
  multi-SM, and whether later chapters keep the 1-tick-1-cycle
  clkdiv-abstracted rendering.
- The campaign's front door — a landing page + the level-to-level
  transition — **promoted to KANBAN C42–C43** by the 2026-09-06
  grilling (owner decisions on the cards; the dated "The campaign's
  front door" section in mockups/DESIGN-NOTES.md is the standing
  spec). Every open question of the doodle resolved that day: locked
  rows dim-but-named (the C34 absence doctrine stays a level-page
  doctrine), no in-progress cell (three states), the solved-listing
  datum adopted (a solved reload replays YOUR solution; the map
  badges par-matched/beaten), chapter-complete as an era caption ✓,
  both sanctioned DOM-glue gates growing landing legs, the door
  shipping clean of lore (the bible session's first deadline moves to
  chapter 3's grilling), and serve.py/README repointed so the campaign
  is the front door at the URL. The lore surfacing the doodle guessed
  at (where fragments land on the map) stays parked with the lore
  entries below, gated on the bible session.
- The campaign's lore — hidden, TIS-100-style (owner one-liner
  2026-09-06, doodled as grilling input; pairs with the front-door
  entry above — the landing is where most of it would surface).
  TIS-100's craft, on the record: the story never touches the game
  UI — it lives in the shipped reference manual's margin notes (a
  dead relative's handwriting over the real ISA docs — the teaching
  artifact and the fiction's vehicle are the same document), the
  machine-as-artifact frame (inherited hardware, the boot self-test
  you are there to fix — the fiction EXCUSES the interface), and
  everything opt-in; no cutscenes, the UI never interrupts. What
  already exists here, for free: every boot program and reference
  solution is somebody's authored work (L2's name says it — Author's
  hand), the chapter titles already read as a recovery arc (First
  light → Reading the world → The feeder), and the level names are
  already a voice (Metronome, Listen, Echo, Fencepost) — the fiction
  only has to own them. The doodle, in leans: the frame is the
  board's previous owner, shelved mid-curriculum — the boots are
  their teaching programs, and the payoff is that the era skin turns
  diegetic: the chrome stops being style and becomes their 90s bench
  software (the title bar, the master window, the sandbox-as-a-
  standing-row all become the fiction's furniture); the vehicle is
  era artifacts, not narration — an in-fiction README.TXT / help
  file over real docs/pio-spec.md excerpts (this repo ships the
  manual TIS-100 only faked, and the stable SPEC-IDs make excerpt
  anchors free; the margin notes are the previous owner's, one
  escalating thread, never a sentence of tutorial); fragments gate
  on SOLVED, never par — par is the mastery collectible, lore is the
  completionist's (the front-door entry's collectible line gains a
  second track); and lore never sits on a level page's teaching face
  and never gates a run (the predict/payoff-freeze lessons stand —
  it lands on the map's chapter frames, in files, at most one line
  in a pass moment's tooltip). Open questions if promoted: the slice
  (resolved 2026-09-06: the door shipped clean — zero lore, per its
  grilling — so the bible session, before chapter 3's grilling, owns
  vehicle + voice, and each chapter's own grilling lands its
  fragments; writing them all now would fence chapters 3+ that are
  not grilled yet; further resolved 2026-09-08: the compact bible
  round ran with the chapter 3 grilling — ch3's slice is
  payload-bytes-only over the feed machinery, the README.TXT and
  slip vehicles stay parked for their own cards); the author's
  identity and the arc's end (named, with a one-line fate,
  TIS-100-minimal, vs anonymous — and does the endgame answer it or
  leave it; the 2026-09-08 round's first fragment is anonymous —
  presence, not identity, so the name question stays fully open);
  where fragments surface (desktop icons beside the
  landing window vs files inside it vs chapter-frame captions); how
  hidden is hidden (dim-and-visible vs opt-in file-open — lean
  opt-in, TIS-100's way); does the sandbox carry any (lean:
  mentioned, never used — tool users never hit a lore page); and
  the breather pairing — Coffee-Time levels as the natural find-spot
  for fragments, the parked "where the sandbox gets advertised" line
  gains a second tenant.
- The lore rides the payloads — the story arrives as decoded bits
  (owner riff 2026-09-06, extends the lore entry above; input for the
  same grillings — and it upgrades that entry's vehicle: the
  README.TXT stays as the fiction's furniture, but the story itself
  only arrives over the wire, through the protocols the campaign
  teaches). Two directions, both native to machinery that already
  exists: READ — a level whose stimulus is a frame stream and whose
  expected words ARE the fiction: text fragments as plain bytes (the
  exact RX judge already names the first divergent bit — a wrong bit
  is a garbled glyph, the near-miss grammar doing story work), images
  as word rows (a 32-bit word IS a 32-px raster line; the glimpse is
  the decode judge's own words re-projected as a 1-bit raster — the
  C38 never-parse-the-prose rule, a view, not a new judge); and the
  near-miss faces mean a FAILED run still glimpses the fragment
  half-arrived — readable in proportion to correctness, never gated
  on PASS. DRAW — the monitor task: the level feeds words into the
  RX FIFO (a new stimulus kind — today stimulus drives pins only; a
  fifo feed is a word list with timing, mirrored in pio_model and
  the driver under the C39 lockstep discipline), the program pulls
  and serializes them onto the wire that drives a MONITOR — an
  output face rendering the decoded bytes as pixels; wrong bit-times
  smear the image (the tier ladder's skew windows become visible
  ghosting — the 85% dial you can SEE), and what the monitor shows
  is a story scrap. The uncanny responder (the owner's "some
  uncanny response"): when the player transmits per the taught
  protocol, the level ANSWERS — reactive stimulus, not a fixed
  pattern (today's stimulus is armed fixed before load; a responder
  watches the player's output pins and scripts the reply — the one
  genuinely new engine machinery, and the expensive bit: it must be
  mirrored in pio_model or the goldens' oracle breaks). What makes
  it uncanny, in leans: it answers YOUR bytes, with one telling
  wrongness (a bit flipped, one lap late, the enable dropping
  mid-frame — the near-miss grammar again), and it is never
  explained; L7 Echo retro-reads as first contact — the player
  thought they were the echo; someone was echoing THEM. Placement
  leans: no landed-level retrofits (chapters 0–2 are shipped
  teaching surfaces; lore levels debut fresh — first carriers in
  chapter 3, where L10 already decodes bytes and L12 transmits
  them; decided 2026-09-08 at the chapter 3 grilling: the fragment
  rides L9/L10/L11's feeds as mundane-warm anonymous ASCII (the
  previous owner's register — feeds are curriculum artifacts), the
  boss keeps the demo's own "PIO!", and the decode face renders
  printable bytes as ASCII so the near-miss grammar does the story
  work below — the READ direction over the existing feed machinery,
  no fifo-feed); the responder is a chapter-5/endgame voice
  (Synchronization
  is where a dialogue lives); the fifo-feed and the responder card
  out only at those chapters' own grillings. Open questions if
  promoted: one voice or two (the previous owner's log arriving over
  the wire — or someone else answering: the story's engine, the
  boots were left FOR you but the wire answers TO you?); do images
  stay 1-bit word-rasters forever (era-true) or grow; does the
  sandbox ever get a monitor face (lean no — the bench stays a
  bench); and whether the responder ever addresses the player rather
  than their bytes (the fourth wall — lean never, TIS-100-minimal).
- The transcoder — the multi-SM capstone that receives a signal and
  displays it on the monitor (owner riff 3, 2026-09-06; extends the
  payload-lore entries above and lands on LEVELS-NOTES' chapter 5 /
  endgame, whose grilling decides it). The shape: the campaign's two
  halves meet in one level — SM0 receives the signal (the reading
  chapters: edge waits, in, push), SM1 drives the monitor (the
  feeder chapters: pull, out, the raster face from the DRAW
  direction), and the player builds the chain between them. Multi-SM
  is load-bearing the L3 way — a job, not a syntax demo: the
  deadlines are designed to collide (the C41 craft applied to time
  instead of counting — input edge jitter only wait can tolerate,
  against a pixel clock that never stalls; a single SM parked on the
  edge misses the pixel, and the monitor SHOWS the miss as
  missing/smeared pixels — the reason the machine has four SMs
  becomes visible, the SM bar earning its ch5 debut). The inter-SM
  channel, in leans: irq sync + a pin-pair wire between the machines
  (honest to real PIO — FIFOs are per-SM; the C22–C24 multi-SM
  machinery and the pio_model multi-SM oracle already exist, and the
  clocked-input example CC-23 is the receiving leg's precedent).
  Lore integration: the transcoder's output is where the deepest
  scrap lands — the signal only the whole machine can hear (one SM
  receives bits; the chain renders the message — whether the far end
  is the previous owner's last transmission or the other voice is
  exactly the two-voices question parked above). Placement: very
  advanced, the owner's words — chapter 5's boss at the earliest
  (after irq-multi-sm lands), the endgame more honestly; the monitor
  face debuts with chapter 3's DRAW carriers and is reused here, not
  built here. Open questions if promoted: par — the standing
  every-level-ships-par rule (C34) meets the multi-SM front
  (FRONT_CLASS over two listings is real hyperopt work; lean: the
  chain is over-determined enough that the front is small, but if it
  is not, a par-free boss needs the rule amended on the record);
  which signal (the slow external clock of the clocked-input
  example? Manchester? the choice is the grilling's); does the
  uncanny responder live at the far end of THIS level (its natural
  home — the signal answers back?); and is this the final level —
  the one the whole fiction arc was waiting for?
- The other voice is generated — a very tiny local LLM behind the
  responder (owner riff 4, 2026-09-06; the engine for the uncanny
  responder in the payloads entry above — the wire stays scripted,
  the voice is generated). What the owner asked: a very-very-tiny
  WebGL-run LLM, primed on the lore, answering mysteriously. The
  leans that make it fit this repo: TRAIN IT HERE — not a pretrained
  blob but a char-level micro-model (~1M params, a tools/ script
  under the make py/hyperopt discipline) over the lore corpus and
  the real pio-spec text — tiny IS the guardrail: a model that knows
  only the corpus cannot answer out of fiction, it babbles in
  register when asked anything else, which is "answering
  mysteriously" as an emergent property (and it speaks the machine's
  own language, trained on the spec); VOICE, NOT FACTS — the corpus
  is register and mood, the load-bearing lore beats stay scripted,
  so the shipped weights are public to dataminers by construction
  (a client-side binary; the TIS-100 spirit — hidden means
  unexplained, not encrypted) but spoil nothing and fence no future
  chapter; IT SPEAKS THROUGH THE WIRE — the model's output is
  serialized by the responder machinery into stimulus frames, and
  the player only ever reads it through the decode path (the
  terminal/monitor face is a lens over frames, not a chat box; your
  program must be running to hear the answer — you can only talk to
  the other voice THROUGH the PIO, which is the fiction's whole
  point); THE WIRE STAYS DETERMINISTIC — generation never gates a
  judge: each response's protocol-level facts (timing, the one
  telling wrongness) stay scripted and pio_model-mirrored per the
  entry above, and the model fills only the prose bytes inside the
  frames; LATENCY IS DIEGETIC — the answer arrives at teletype/
  300-baud rate, era-true, and hides whatever inference costs (at
  this scale a typed-array worker likely carries it — the owner's
  WebGL is the ceiling, not the floor, a WebGL2/WebGPU kernel being
  the escalation if the model grows; it is content-compute, not a
  WebGL UI sim, so the C26 ban is not touched — cite the
  distinction at the grilling); and the weights fetch rides the
  existing worker+wasm precedent (the page already pulls binaries;
  runtime JS stays dependency-free). Fixed-seed sampling is
  deterministic, so even the model can carry a drift golden
  (weights hash + prompt + seed → committed text, checked in make
  js). Open questions if promoted: where the dialogue lives
  (post-campaign terminal epilogue vs a chapter-5 level vs the
  transcoder's far end — the engine composes with all three); the
  training card itself (corpus curation is AUTHORING — whose voice,
  how much, and does the grilling write the corpus or only the
  rules for it); do the two sanctioned DOM-glue gates grow legs for
  the terminal face (geometry presumably yes; generation covered by
  the fixed-seed golden instead); and the fourth-wall question gains
  an engine — does it stay "never" now that the model could be
  pointed at the player's par (lean: still never — the corpus does
  not contain the word par).
- Manual slips — sinister context leaking through the dry register
  (owner riff 5, 2026-09-06; the TIS-100 device, named: the manual
  is dry technical prose until one word — "civilian control" —
  implies its complement, and the reader who notices feels the
  ground shift; the reader who doesn't loses nothing). Why it fits
  this campaign: it is the cheapest lore there is — pure authored
  prose on artifacts that already exist in the fiction (the
  README.TXT, the manual-over-spec excerpts, the About box), zero
  engine machinery, and it compounds: the slips form a pattern only
  when read together, and after the reveal every slip rereads loud
  (the second-read reward is the retention hook). The grammar of
  slips, in leans: the COMPLEMENT LEAK (a word whose necessary
  opposite is the fact — "civilian control" needs military control
  to exist; "suitable for civilian applications"); the ERRATUM
  CORRECTION (v1.1 fixes a phrase and the fix is worse than the
  original — "operator safety" corrected to "asset recovery"); the
  BOILERPLATE LEAK (compliance text referencing a facility, an
  authority, a disposal requirement); the era-canon DENIABLE SLIP
  (no sinister word at all — the in-fiction board carries the
  military temp-grade part-number suffix, per real 90s datasheet
  convention; why does a hobby bench have the M-grade part?); and
  this repo's native device, the FALSE CITATION — the in-fiction
  manual excerpt cites a SPEC-<section>-<n> that the real
  docs/pio-spec.md does not contain, a mechanically checkable ghost
  fact. The discipline that keeps them slips: deniable as era
  documentation noise on first read (awkward translated English,
  compliance boilerplate — the era provides the cover), and never
  on a level page's teaching face — the goal prose teaches, the
  artifacts carry atmosphere; margin notes (entry 1) are the
  previous owner's handwriting on the artifact, slips are the
  artifact's own printed text leaking — two channels, one page.
  This refines entry 4's voice-not-facts rule: AUTHORED static
  prose may carry facts as slips (deliberate, invisible, in plain
  sight — datamining them is just reading); the generated model's
  corpus stays register-only. Placement: superseded 2026-09-06 — the
  front-door grilling shipped the door clean, so the "first slip
  rides the front-door card" lean died there; first slips land only
  after the bible session, each chapter's grilling landing its slips
  alongside that chapter's fragments (the bible round ran
  2026-09-08; chapter 3 lands its fragment payload-only — NO slip
  ships with it, so the first slip candidate is chapter 4's
  grilling); landed goal prose is never
  retrofitted (the standing no-retrofits lean). Open questions if
  promoted: the
  sinister direction itself — WHAT do the slips foreshadow (military
  procurement of the board? a facility? the other voice's origin?)
  — the fiction decision the slips are breadcrumbs toward; density
  (one slip per chapter vs a scattered set with the landing page
  holding the first); whether slips get gate insurance (prose in
  static assets is one well-meaning edit from being "fixed" — pin
  the slip phrases the way the wave-contract tests pin verdict
  prose, cheap); and whether the endgame reveal makes the reread
  explicit or trusts the player to reread alone.
- The parallel-universe frame — the Foundation that grew (owner
  riff 6, 2026-09-06; answers entry 5's first open question with an
  owner lean: this is from a parallel universe where the raspberry
  pi foundation became something powerful and self corrupting). The
  arc shape, in leans: SELF-corrupting is the word — not conquered,
  not villainous; an educational mission (cheap computers for
  everyone) that curdled by its own success, and the telling is
  sediment, not story: the M-grade parts appearing in the education
  SKU, the errata correcting "operator safety" to "asset recovery",
  a name-change in a v1.1 masthead — each slip deniable, the pattern
  damning; the corruption is legible only in reread, which is why
  entry 5's register carries it. THE HARDWARE IS HONEST — the load-
  bearing rule: the silicon in their universe is identical to ours
  (same part, same spec — that is why the real docs/pio-spec.md
  stays the teaching doc and every lesson stays true); the
  divergence is INSTITUTIONAL, living entirely in the paperwork the
  slips ride. THE NAME IS FICTIONAL — the real Foundation is
  beloved and stays unnamed; the parallel universe is the firewall
  in both taste and care, and the counterpart gets its own name
  (a lean example, grilling's call: the Bramble Foundation — the
  thicket, not the fruit; same plant, and an institution of pis is
  exactly a bramble); the name-change itself can be a slip beat —
  early docs carry the old masthead, later errata the new one. What
  the frame gives the parked threads: the previous owner (entry 1)
  becomes a curriculum engineer inside the institution — the boot
  programs ARE curriculum, L2's Author's hand is literal, and the
  board was shelved mid-curriculum because the mission curdled
  under it (the player inherits the unfinished honest course);
  the other voice (entries 2/4) gains candidates — a former
  colleague on another bench, a former STUDENT (you are not the
  first; the boots were left FOR you, and the wire may answer TO
  the one who studied before you), or the institution's own still-
  answering machinery; the transcoder's far end (entry 3) gains a
  candidate: the deep signal the whole machine can hear is what the
  institution is still broadcasting. The era tension, recorded
  honestly: the chrome is 1990s, the chip is real-2020s silicon,
  the real Foundation is 2010s — the parallel universe must absorb
  all three (lean: their history diverged where the cheap
  educational-computer age arrived a generation early, and the
  Win3.11 bench is what their 90s looked like — legacy
  institutional tooling is also era-true cover). Open questions if
  promoted: the fiction bible — who writes the institutional
  timeline, and how much of it is ever SHOWN vs only implied (lean:
  the sediment principle — nothing is shown that a slip cannot
  carry); the previous owner's exact position and fate (entry 1's
  one-line-fate question); does the PLAYER exist in the fiction
  (who inherited the board, why are they running the course — the
  fourth-wall-adjacent question gains teeth); when the counterpart
  name first appears (a slip? the About box? never?); and whether
  the arc's endgame reveal is archival (the reread made explicit)
  or stays trust.
- The doctrine — coherent story, then show nothing (owner riff 7,
  2026-09-06; the synthesis the six entries above were waiting
  for). Two owner decisions on the record: THE TONAL ANCHOR is the
  end of the Cold War — dark mystery and fear, secret programs,
  secret underground military facilities, CONTRASTED with the "end
  of history" (Fukuyama's phrase) optimism we now know was naive —
  the campaign's register is that exact 1989–1995 window, which
  locks the era skin into the fiction: the cheerful light chrome is
  no longer vintage style but the period's own performed optimism
  (C26's decisions reread as the institution's canon, and the
  player's 2026 hindsight over the fiction's 1995 cheer is free
  dramatic irony); and THE SHOWING DISCIPLINE — write a fully
  coherent story first, then show nothing of it: no cutscenes, no
  reveal, no archive dump, no explicit reread — only leaks through
  the game (this resolves entry 5's last open question — trust, the
  explicit reveal is dead — and promotes entry 6's sediment lean to
  doctrine). Why coherence first: incoherent leaks produce random
  theories; coherent leaks make the player's reconstruction
  CONVERGE — that mind-racing is the product, and it only races
  toward dread if every slip triangulates to the same unseen whole
  (the iceberg doctrine, Dark Souls' environmental canon; the bible
  is the aquifer every channel leaks from). The leak channels,
  unified: slips in the prose (entry 5), the payload fragments and
  the wire's voice (entries 2/4), the artifacts' texture (entry 6's
  part numbers and mastheads) — and the surface never moves: no
  atmosphere arc, no darkening chrome, the optimism stays performed
  to the end (showing nothing includes showing no mood swing). The
  facilities go underground (entry 5's boilerplate leak gains its
  referent; entry 3's far end gains its image — the deep signal
  answers from somewhere buried). Open questions if promoted: bible
  custody — the owner holds the canon and each grilling surfaces
  the slice its chapter needs (lean: NOT committed; a repo-resident
  bible datamines the whole doctrine away, and the slips already
  pinned by tests are the public leaks by design); sequencing — the
  bible must exist before the first leak-bearing card (resolved for
  the front door 2026-09-06: it shipped clean, zero leaks — the
  masthead-and-one-"civilian" cap governs whatever lands later, not
  the door), so the bible session's first deadline is chapter 3's
  grilling — met 2026-09-08: the compact bible round ran with the
  chapter 3 grilling (owner-held canon per the custody lean; riffs
  5–9 the skeleton), and chapter 3 is the first leak-bearing
  chapter — payload bytes only; the taste line — how much Cold War facility
  trope the deniable register can hold before slips stop being
  deniable (lean: the fear lives in procurement language, never in
  threat language); and whether the performed optimism has one
  in-fiction author (the curriculum's voice IS the institution's
  cheer — the goal-prose register becomes canon the grilling writes
  to, new chapters only).
- The link — signals to and from a parallel reality, shifted (owner
  riff 8, 2026-09-06; the fiction's engine, composing with the
  entries above: the transcoder's far end (3), the uncanny
  responder's wrongness (2/4), the Bramble universe (6), under the
  doctrine (7)). The owner's decision: the story is trans-
  dimensional — signals cross to and from a parallel reality, and
  they arrive SHIFTED, systematically wrong; the PIO's dynamic
  adaptability is the in-fiction reason the link works at all
  (the owner's "hehe" — the real chip's headline virtue, a
  re-writable I/O state machine for ANY protocol, becomes the
  fiction's instrument: fixed peripherals cannot follow a shifted
  protocol; a PIO program can be re-written to follow the drift —
  so the campaign's authoring levels ARE the link-operator's job,
  retuning the receiver level by level). The deep resonance,
  recorded: the campaign already built the shift instrument as its
  difficulty system — the tier ladders' skew windows ([BIT_LO,
  BIT_HI]), the relaxed-but-never-exact tiers, the near-miss faces
  naming the run that ran wrong — in-fiction, a signal that passes
  RELAXED but never EXACT is evidence of the other side (the C40
  ladder rereads as tuning into the shift), and the responder's
  "one telling wrongness" gets its why: the wrongness IS the shift.
  A new leak channel with it: MECHANICAL leaks, not prose ones —
  the player who MEASURES the stimulus finds it wrong in a
  consistent direction (entry 5's slips leak in words; the shift
  leaks in bit-times) — and the doctrine extends: the shift is
  never explained in-game, only measurable (procurement language
  never threat language; measurement, never explanation; the reveal
  stays dead). Bible candidates, recorded as leans for the bible
  session, not decisions: the PIO architecture itself was RECEIVED
  (the chip is the decoded signal, productized as an educational
  computer — which is why the silicon is identical in both
  universes, giving entry 6's rule its why); the curriculum is
  link-operator training wearing a programming course; the
  underground facility's deep signal (entry 3) is the original
  contact; and the Bramble curdle was driven by what came through
  or what keeping it cost. Open questions if promoted: universe
  topology (how many realities, which one is home — is the game
  set IN the Bramble universe with our reality as the far end?
  lean: the far end is a recognizable cousin of ours); the shift's
  signature (one constant shift, or drifting? baud, bit order,
  polarity, phase — the choice binds to chapter-3 stimulus design,
  so the bible session owns it); whether any in-game instrument
  ever names the shift (a tier labeled for it? lean: never —
  tiers stay engineering words); and the risk line — how far the
  bible's science can reach while every leak stays deniable (the
  mind-races test, restated under load).
- The leak program — secrecy decays, so proliferate deniably (owner
  riff 9, 2026-09-08; composes with entries 5–8 — the sender's end
  of entry 8's wire, and the resolution of entry 6's era tension).
  The owner's statement: the PIO was a secret 80/90s project; it is
  hard to keep things secret over long periods; therefore the design
  and tech were DELIBERATELY leaked — plausibly deniably — for
  civilian parallel reconstruction; that is why it emerged in the
  Raspberry Pi. What it locks together: the era tension resolves —
  their 90s bench carries 2020s-class silicon because the chip was
  never a 2010s invention there; it is a Cold War program (entry 7's
  1989–1995 window reads as the program's own window, and entry 6's
  diverged-early lean supplies why their 80/90s could build it at
  all); the ~30-year gap to the real RP2040 (2021) is not friction
  but the evidence — deniable seeding takes decades to look like
  invention, "hard to keep things secret" is the bridge; and entry
  6's silicon-identity rule gains a mechanism alongside entry 8's
  RECEIVED lean — the design propagates looking like local
  invention, because deniable parallel reconstruction IS the
  propagation mechanism. What it retro-justifies: "civilian" as THE
  word the front-door cap names (C42's masthead-and-one-"civilian")
  — it is the program's own vocabulary; entry 5's "suitable for
  civilian applications" complement slip becomes load-bearing (the
  complement — a military program — is the fact the word needs to
  exist); and the M-grade part on the education SKU (entries 5/6)
  gains its why — the civilian line and the program share lineage,
  the wall between them was always thin, and the leak is where it
  thinned. The deep resonance, recorded: the institution's method is
  the campaign's own method — coherent deniable leaks aimed at
  convergent reconstruction (entry 7's iceberg doctrine is
  counterintelligence doctrine) — so the player reconstructing the
  fiction out of slips is doing, to the story, what the civilian
  sector did to the chip; the campaign is itself the program's
  latest leak channel, a recursion the bible holds and the game
  never shows. What deniability protects, on the taste firewall's
  record: "parallel reconstruction" means the civilians did honest
  work — the real RPi engineers genuinely invented it; the fiction
  claims lineage for the DESIGN, never deception by any real party,
  and the real Foundation stays beloved and unnamed (entry 6). Bible
  leans this riff adds: the education mission as the leak channel
  from the start ("cheap computers for everyone" as deniable
  proliferation — the cover that became real before it curdled, and
  entry 8's "what keeping it cost" gains its concrete cost:
  deniability maintained across decades); and the still-answering
  machinery (entry 6's other-voice candidate) as the program's
  residue — the protocol still running somewhere. Open questions if
  promoted: the leak's MOTIVE (insurance proliferation — the design
  survives its facility, Cold War logic? manufacturing scale —
  mil-grade parts need a civilian supply chain, the M-grade suffix
  read backwards? laundering continued work? or the link demanding
  wild receivers?); replace or compose with entry 8's RECEIVED lean
  (their chip received from the far side vs developed in secret and
  leaked outward — or the unified rule: the design arrives
  everywhere looking like local invention, which subsumes both);
  which end of the wire the real RPi is (entry 8's in-fiction
  arrival vs the fourth wall's sharper claim — the player holds the
  leaked artifact at their real desk, the real datasheet diegetic
  evidence; entry 8's topology question rides this one); does the
  leak cross the link, and does the shift apply to it (or is the
  design the one CLEAN crossing — entry 6's identical-silicon rule
  as the exception that proves the wire shifts everything except
  what was sent on purpose?); and the taste line — how far a claim
  on OUR universe can reach before the firewall is stressed (lean:
  it lives only in the bible and the player's own reread, never in
  a slip).

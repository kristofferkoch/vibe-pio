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

## Game track — level campaign, chapter 3 (C44–C47)

Scheduled 2026-09-08 by the chapter 3 grilling over
mockups/LEVELS-NOTES.md (the 2026-09-04 didactics exploration stays
the design spec; this grilling covered chapter 3 only — chapters 4+
stay in IDEAS/LEVELS-NOTES for their own grillings). The fun gate
read on chapters 0–2 as shipped: **clean, no riders.** Owner
decisions on the record:

- **The feed is static and the dry-out terminal.** L9's TX feed is
  the existing static feeds machinery (the demo's own P/I/O/!
  preload pattern — a word list enqueued at load): the program eats
  it, the last pull stalls forever, the L6 honest-machine story on
  the TX side. No timed-feed stimulus kind this chapter (that
  machinery stays parked with the lore DRAW direction); the chapter
  needs zero new engine machinery.
- **The investigate moment is a card, not narration.** L9's "why
  did it stop?" debuts the PRIMM Investigate verb as its own face —
  a post-stall commit riding the predict card's grammar
  (candidates, one commit) — while the existing stall narration
  (the chip, the banner, the tooltips) stays as the evidence it
  points at.
- **Autopull is given, not authored.** L11's sms overlay pre-sets
  it; the player's task is shedding the pull row — slots freed,
  loop shed. The threshold, notch and flow arrows arrive as
  drawings (config as structure, the sketch's own phrase); the C22
  gesture grammar stays a sandbox surface. The OSR panel's autopull
  furniture sub-gates at L9 the #xy way — `osr` alone ships the
  panel without the row that teaches two levels ahead.
- **L12 is designed for the ch4 re-solve, and only that.** Its par
  is the sideset-less champion and its wave admits a strictly
  better sideset family ch4 can tighten; whether re-solve
  generalizes into the standing chapter-capstone type is ch4's
  grilling to decide with one shipped instance in hand. The demo's
  fjoinTx stays C18 history — L12's honest feed fits the unjoined
  4-deep TX.
- **The breather defers again** — first candidate after ch4's
  boss, revisited at the ch4 grilling (sideset is the doodling
  primitive; the map's standing row already carries the sandbox
  advertisement).
- **The bible session ran as this grilling's compact round
  (2026-09-08)** — owner-held canon, NOT committed (the doctrine
  entry's custody lean; IDEAS riffs 5–9 the skeleton, riff 9
  arriving mid-session). Its ch3
  slice, on the record: the fed words carry the fiction's first
  payload fragment — plain ASCII bytes in the previous owner's
  mundane-warm register (practice-payload data that rereads as a
  person having been here; the "PIO!" register, but theirs),
  anonymous for now (presence, not identity — a name can still
  land later, the reverse cannot), riding L9/L10/L11's feeds;
  L12 keeps the demo's own "PIO!" (the boss re-derives the shipped
  demo; its bytes are the demo's). The exact bytes are
  owner-authored against that register and land with C44's
  goldens — deniable-as-demo-data is the fence. The decode face
  renders printable bytes as ASCII so a wrong bit is a garbled
  glyph (the payload entry's near-miss-as-glimpse rule: a failed
  run still glimpses the fragment half-arrived). No prose
  artifacts this chapter — no slip, no README.TXT; those vehicles
  wait for their own cards.
- **Chapter 3 registers as "The feeder"** — task-true like
  "Reading the world"; the fiction owns the titles without
  pressing on them (C44 grows the CHAPTERS table; validate()
  already rejects an untitled chapter).

Web cards: the JS discipline (docs/js-tooling.md), red/green TDD,
DOM glue verified by the browser session and `make web` — geometry and
keyboard only through the two sanctioned headless gates; the levels
gate stays engine-side. Par: the standing rule — every
level ships a hyperopt-derived front (FRONT_CLASS grows the feeder
classes; L9 rides the 'given' precedent, L6's), the champion must
equal the committed par. Full perturbation sets per level. The
goal prose follows the C41 doctrine — task verbs, the nudge never
the recipe. Dependency order: C44 → C45 → C46 → C47 (C44 = L9,
C45 = L10, C46 = L11, C47 = L12; runtime unlock order stays
numeric regardless: L8 → L9 → … → L12).

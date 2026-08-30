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

## Game track — COMPLETE (C21–C24)

Promoted from the IDEAS game entry after the 2026-08-27 game-loop
grilling; all four cards have landed — C21 (single-SM sandbox surface),
C22 (the DESIGN-NOTES drawn-config grammar), C23 (pio_model multi-SM
oracle), C24 (the four-machine playground). No cards remain; the next
game-track work (the level/menu shell, level stimulus) starts from
IDEAS.md after its own grilling.

## Web track — era chrome (C26) — COMPLETE

Promoted from the IDEAS keyboard + era-skin entries after the
2026-08-29 grilling round 1 (owner decisions: light skin, one master
window, hue-true light-tuned semantics, two bitmap fonts, standing
headless keyboard-walk gate, no CRT on the chrome). Web cards followed
the JS discipline (docs/js-tooling.md): Biome + `node --test` gated by
`make js`, runtime dependency-free, DOM glue verified by the browser
session and `make web`. Red/green TDD throughout: every regression
check shown red against the re-injected defect before it shipped, with
the demonstration recorded in the commit.
C25 — the keyboard surface — landed 2026-08-29: keys owned by focus,
the listing as a listbox, one Tab stop per arrow group and stepper
pair, Alt+letter mnemonics, the focus-tracking status line, and the
standing headless keyboard-walk gate (`web/tests/keyboard.test.js`,
the second sanctioned DOM-glue exception).
C26 — the era skin — landed 2026-08-29: the sandbox re-skinned as
SerenityOS's take on Win3.11 (one master window on the teal desktop,
silver chrome, navy title bar, 2px bevels, Pixelated MS Sans Serif
11px + Px437 IBM VGA9 16px, era tooltips over the data-tip narration);
the mockup round + DESIGN-NOTES.md "The era skin" is the spec. No
cards remain; the next web-track work (level/menu shell) starts from
IDEAS.md after its own grilling.

## Web track — pin-mapping legibility (C27–C29)

Scheduled 2026-08-30 by owner request straight from the gpio0-panel
review (the wave-header out/side/in tags and the pin strip; findings
from a live browser session plus a code read of sm-view.js /
engine-driver.js). Not via the IDEAS.md hop — the review plus the
owner's scheduling instruction stand in for the grilling. Owner
decisions from the review: the pin strip drawing the mapping is the
load-bearing fix (the tags name pin numbers; the strip shows nothing
until a program actually writes — a mid-run side-base move left only
a 13px digit as evidence); the lens pin becomes pickable at the wave
row itself; the row's numbers get named on the face and the side dash
annotated; the 13×13 stepper size stands (keyboard parity is the
compensating control — explicitly not a card). Dependency order:
C27 ∥ C28 ∥ C29, no cross-dependencies (C27 first by value). Web
cards: the JS discipline (docs/js-tooling.md), red/green TDD, DOM
glue verified by the browser session and `make web` — geometry and
keyboard only through the two sanctioned headless gates.

- C27 (the pin strip draws the mapping): the C22 drawn-config grammar
  gains its pin-side echo — the 32-cell strip draws the selected SM's
  OUT / SIDESET / IN extents (SPEC-7-26/21) as cyan-family marks
  under the pin numbers (hue-true on the light skin; overlapping
  mappings must stay legible — mock-up first), so a base/count
  stepper click shows where the wiring moved with no program
  running. Live vs stale: the owner corner and held level
  distinguish actively-driven (OE this clk) from was-driven (last
  writer, the mapping since moved away) — the moved-from pin must
  stop reading as currently driven. Same-clk conflict narration
  keeps its CC-7 wording. Done-when: `make js` passes; the layout
  gate pins the new marks' geometry at the gated viewports, red /
  green against a re-injected defect (extents drawn from a stale
  overlay; the stale class never applied); the browser session and
  `make web` re-verify; the demonstration is recorded in the commit.
- C28 (the lens lives on the wave): the wave row owns its pin — the
  `gpio<N>` label becomes a drawn lens-pin picker riding the row's
  spin grammar (C25: one Tab stop, −/+/←/→), so following a signal
  that moved (side-base remapped mid-run, the wave gone flat) no
  longer hunts the exec-title select; that select moves down to the
  row or mirrors it. Done-when: the keyboard walk covers the new stop
  (red/green against a re-injected defect); `make js` and the layout
  gate pass; the browser session and `make web` re-verify; the
  demonstration is recorded in the commit.
- C29 (the row says what it means): base·count named on the face —
  one letter each (`out b0·c32`-style) so the two numbers per tag
  stop being hover-only — and the `side · —` dash annotated in-face
  (no side-set allocated; the bits come from the program panel's ds
  pips) so it stops reading as a broken stepper pair; tooltips and
  status narrations updated to match. Done-when: `make js` passes;
  the layout gate pins the row's one-line fit at the 13" widths after
  the label growth (red/green — the 1520px yield may need revisiting);
  the browser session and `make web` re-verify; the demonstration is
  recorded in the commit.

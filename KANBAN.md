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

## Web track — pin-mapping legibility (C27–C29) — COMPLETE

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
C27 — the pin strip draws the mapping — landed 2026-08-30: the
three-lane marks (mock-up round in mockups/pin-strip.html + the
DESIGN-NOTES "The pin strip draws the mapping" section is the spec),
the was-driven gray, the layout gate's mark/stale checks.
C28 — the lens lives on the wave — landed 2026-08-30: the wave row's
gpio label is a drawn lens-pin picker riding the C25 spin grammar (one
Tab stop, −/+/←/→, wrapping 0..31; the DESIGN-NOTES "The lens lives on
the wave" section is the spec), the exec-title pin select moved down to
it (removed — the mode select stayed), and the stray Tab stops inside
the ds/thr spinboxes got their tabindex="-1" — the documented
one-stop-per-pair idiom the maptags already kept. The keyboard walk
covers the new stop red/green.
C29 — the row says what it means — landed 2026-08-30: the wave-header
tags name base·count on the face, one letter each (`out b0·c32`;
`side b0·c2`/`c1+opt` under SIDE_EN), so the two numbers per tag stop
being hover-only, and the none posture of the side count is annotated
in-face — `c—ds`, dim — pointing at the program panel's ds pips that
own the split (no side-set allocated; all five ds bits are delay).
Tooltips and the spins' status narrations use the same b/c letters;
the pin-strip wiring tips speak the same grammar. The layout gate pins
the face (all postures: boot dash, allocated, +opt, the widest
b31·c32 the steppers reach) and the row's one-line fit at the 13"
widths after the label growth — the 1520px yield stood as shipped
(measured: the widest posture holds 24.9px at 1280/1366 with the aux
hidden and at 1521+ with it shown; the pin demonstrably bites — with
the yield forced open at 1280 the row wraps to 44.9px and the check
fails in every posture). No cards remain; further web-track legibility
work starts from IDEAS.md after its own grilling.

## Web track — listing-gutter legibility (C30) — COMPLETE

Scheduled 2026-08-30 by owner request straight from the address-00
review (the program listing's address gutter; findings from a live
browser session plus a code read of sm-view.js / sm-view.css — the
same evidence path as the gpio0-panel round). Not via the IDEAS.md
hop — the review plus the owner's scheduling instruction stand in for
the grilling. Web card: the JS discipline (docs/js-tooling.md),
red/green TDD, DOM glue verified by the browser session and
`make web`.
C30 — the cursor marks leave the address cell — landed 2026-08-30:
the `.smcur` cluster out of the address cell's text flow, per the
owner decision — the coincident cluster is one boxed chip absolutely
positioned in the row's left margin (left 9, inside the row's 20px
band, riding the pin-ownership chip grammar), colored digits, the
`SM<k> PC` tooltip, and the address digits always clean. The layout
gate pins the boot posture red/green at both 13" viewports — all four
cursors on row 00, `.addr` does not overflow, the chip does not
intersect the address digits, and it clears the margin's tenants
(bracket, steppers, `.cur` bar). The session also surfaced the one
posture the slot cannot clear (the demo's wrap-bot pair parks on
row 0 and the resting cluster rides under it — no x clears every
tenant on that row); recorded in IDEAS.md for a grilling, not
silently expanded. No cards remain; further web-track legibility
work starts from IDEAS.md after its own grilling.

## Web track — the row editor's key contract (C31–C32)

Scheduled 2026-08-30 by owner request straight from the program-memory
editor review (findings from a code read of sm-view.js — the row
editor's three-way key dispatch at ED keydown, popupShow's visible-but-
empty linger, computeCands' token-index slot model, accept's universal
comma; same evidence path as the gpio0/address-00 rounds, no live
session). Not via the IDEAS.md hop — the review plus the owner's
scheduling instruction stand in for the grilling. Owner decisions on
the record: **Tab is the only accept key while the completion list is
open; Enter unconditionally commits the row** — one key, one meaning,
and the Escape-before-Enter dance the keyboard walk works around dies
(keyboard.test.js:270-273); and the fix is **two ordered cards** — the
key contract first, then the suggestion sense. Guideline canon for
both: WAI-ARIA APG combobox pattern (the open state must be perceivable;
Escape never destroys; arrows select while open), CodeMirror 6
autocompletion (the caret is the anchor — a completion result is valid
only while the caret stays in the construct that triggered it), and the
CUA era canon already on record in IDEAS.md (Enter = default action,
Esc = cancel) — C25's own phrase is "keys owned by focus", and the row
editor is the one surface where keys are owned by hidden state instead.
Web cards: the JS discipline (docs/js-tooling.md), red/green TDD, DOM
glue verified by the browser session and `make web` — geometry and
keyboard only through the two sanctioned headless gates. Dependency
order: C31 → C32 (both touch popupShow/computeCands).

C31 — the row editor's keys mean one thing — the open/closed state of
the completion list becomes visible and stable, and the keys follow it.
Split `#edpop`: the machine-code strip stays always-on; the completion
list is its own box that exists only when it has items (today
popupShow keeps the popup on screen with the candidate pane hidden, so
the same-looking screen flips ArrowDown between walk-the-menu and
commit-and-hop the moment computeCands returns empty). The list follows
the caret: recompute or close on `selectionchange` and click-in-text
(today only input/accept/openRow/Ctrl+Space recompute, so ←/→ or a
click into another operand or the opcode leaves the menu stale); Esc
closes the list and it stays closed for that slot — the caret leaving
the slot, a new row, or Ctrl+Space reopens. The key contract while the
list is open: Tab accepts, ↑/↓ walk it; while closed: Enter commits
and hops (Enter now commits in both states), ↑/↓ hop rows, second Esc
cancels the row; ←/→/Home/End always move the caret. The gutter pick
keeps its keys and its visible mode (the arc) — untouched. The status
line's row-editor narration follows the new contract. The keyboard
walk re-baselines red/green: the Escape-before-Enter choreography goes,
and the walk re-types the commit path through the new contract; the
browser session checks the split popup's geometry (layout gate extended
only if the split lands in a pinned region).

C32 — the suggestions match the slot under the caret — the candidate
model stops being a token index. Per-instruction slot models in
computeCands: wait offers its polarity first (gpio/pin/irq today sit in
the polarity slot), push/pull get their flag slots (SECOND has no
entries for them — the menu silently empties mid-instruction), irq's
set/wait/clear/rel/prev/next appear at their positions. accept()'s
separator comes per-instruction from the disassembler's canonical
spellings — pio-asm.js is the golden anchor, the same discipline as the
browser assembler port — replacing today's universal ", " after the
first operand (`push iffull,` / `irq wait,` — assembler-tolerated,
non-canonical). Suggestion suppression when the slot is already
complete (`set x, 3` offering 31 is noise, not help); with C31's Enter
rule a lingering list is no longer dangerous, but the surprise stays
until it goes.

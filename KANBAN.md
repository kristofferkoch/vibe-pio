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

## Web track — the row editor's key contract (C31–C32) — COMPLETE

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
C31 landed 2026-08-30; C32 landed 2026-09-04: the suggestions match
the slot under the caret — the candidate model stops being a token
index and becomes per-instruction slots in web/row-complete.js (the
extracted completion module: vocabularies derived from PioAsm's own
operand tables, accept separators from the disassembler's canonical
spellings, suppression when the slot is already complete; the
pre-C32 token-index model is its standing defect hook). wait offers
its polarity first (gpio/pin/irq/jmppin moved down to the source
slot), push/pull keep their flag slots (the menu no longer empties
mid-instruction), irq's set/wait/clear/rel/prev/next appear at their
positions, and `set x, 3` offering 31 is gone. No cards remain;
further row-editor work starts from IDEAS.md after its own grilling.

## Web track — state swaps never move boxes (C33) — COMPLETE

Scheduled 2026-08-30 by owner request, raised in the same planning
round as C31–C32 ("while we're planning: buttons change width because
they change text, like RUN/PAUSE — buttons need to be sized to their
possible max text" — the owner's wording is the decision; the code read
below is the evidence). Not via the IDEAS.md hop. Findings on record:
`brun` ('▶ RUN' ↔ '❚❚ PAUSE', sm-view.js run/pause) is an auto-width
flex child of the header `.ctrl` bar, so every run/pause toggle
reflows the bar — the speed select and CYCLE/INSN shift under the
pointer; `bcopy`'s ✓ flash likewise, and both swaps assign textContent,
which permanently wipes the `<u>` mnemonic underline — bcopy loses its
L marker after the first copy, brun loses its R indicator for as long
as it reads PAUSE (Alt+R itself keeps working through MNEMONICS; only
the visible indicator vanishes). Inspected and cleared: `savestate`
('on' ↔ 'failed') is the only other state-swapped text and sits
right-anchored at the footer line's end — no neighbor to shift; data
readouts (cyc, the word counts) are out of scope — their content is
the signal, not a state label. Technique on record: the two-label grid
stack — both labels live in the button, grid-area 1/1, the inactive
one visibility:hidden — sizing to the possible max with no tuned
min-widths and keeping the mnemonic markup in both states; the CUA
canon already on record in IDEAS.md prescribes stable command-button
geometry. Web card: the JS discipline (docs/js-tooling.md), red/green
TDD, DOM glue verified by the browser session and `make web`. Gate:
the layout test's never-reflow discipline ("hover and press never
reflow", layout.test.js:503; "drive marks never reflow the strip",
:827) gains the state-swap leg — brun's box and the `.ctrl` siblings'
x-positions identical across run()/pause(), bcopy's box stable across
the flash — run red against the shipped page first, green with the
stack. Dependency order: C33 ∥ C31/C32 (different region of the page).

C33 landed 2026-09-05: the labels swap, the boxes don't move — brun and
bcopy are two-label grid stacks (both faces authored markup in the
button, grid-area 1/1, the inactive face visibility:hidden), so each
button sizes to its possible max text and the run/pause toggle and the
✓ flash cannot re-flow the .ctrl bar; the swaps ride classes
(.on/.done), so the `<u>` mnemonics survive every state — brun's PAUSE
face underlines its own live key (Alt+P joined Alt+R in MNEMONICS;
letters stay unique), bcopy's ✓ face keeps its L. The layout gate's
state-swap leg pins it (layout.test.js): every header box identical
across run()/pause() and across the flash, and every MNEMONICS button
underlining its own Alt key in every state — run red against the
shipped page first (brun 67.6→75px on toggle, the bar's boxes moved),
green with the stack; verified live in the browser session. No cards
remain.

## Game track — level campaign, chapters 0–1 (C34–C37)

Scheduled 2026-09-04 by the level grilling over mockups/LEVELS-NOTES.md
(the 2026-09-04 didactics exploration, recorded from the IDEAS game and
learning-curve entries; that file stays the design spec). Owner
decisions on the record: the first card is a **vertical slice through
L0**, not a shell-first or referee-first build; **locked panels are
absent** (display:none) — the level page is its own geometry, never
ghosted placeholders, and absence covers the Tab order too; the
**listing keeps all 32 rows in every level** (row-count honesty resolved:
the machine is honest from cycle one, `·` rows dim); every level ships
a **reference solution + par** (words/cycles from tools/hyperopt.py,
committed per level), gated by a levels test in `make js` — each
reference solution green against its own monitor profile, perturbed
variants red; the **predict gate locks Run on first run of a
non-authored program only**; the level shell **inherits the era skin
verbatim** — one master window, plus a level band (name, goal,
monitor/profile status, pass state) as a group frame under the
toolbar; **chapter order output-first** (reading second, feeder
third); **par becomes visible in the band only after first solve**
(expertise reversal); the scrambler is **click-pair row swap** (click
A, click B, contents trade; keyboard per the C25 grammar), not drag.
Chapters 2+ stay in IDEAS/LEVELS-NOTES until the fun gate reads on
0–1. Web cards: the JS discipline (docs/js-tooling.md), red/green TDD,
DOM glue verified by the browser session and `make web` — geometry and
keyboard only through the two sanctioned headless gates. The levels
gate (web/tests/levels.test.js) is engine-side `node --test`, not a
DOM-glue exception — it drives level definitions against the engine
the way golden vectors anchor pio-asm. Dependency order: C34 → C35 →
C36 ∥ C37 (C36 first by value; level unlock order at runtime stays
L3 → L4 → L5 regardless).

C34 landed 2026-09-05: the L0 slice. The level definition format is a
classic-script JSON payload registering through PIO_LEVEL (one file per
level under web/levels/; the payload is strict JSON so
tools/gen_level_goldens.py runs each program through pio_model over the
driver's exact load timeline and commits the pin series — drift-checked
in `make js` like the assembler goldens); the runtime is web/levels.js
(the registry, the versioned square-wave monitor judge with its tier
ladder, the predict gate, the programState builder, the SURFACE
absence table; {defect:'judge'} and {defect:'gate'} are the standing
red hooks). The shell is the sandbox page under ?level=<id>: locked
panels absent from layout and Tab order both, the listing's columns
are curriculum (L0 = addr+instruction), the wrap arc draws but its
steppers never build, and the level band carries name/goal/verdict/
pass (+par after first solve). L0 First light proves it end to end —
`set pins,1` / `set pins,0`, wrap 1→0, one wave row pinned to gpio0,
the predict card asks the wrap question (three candidate waves; the
two wrong ones are exactly the perturbed goldens), Run stays locked
until a commit (first run only; re-runs and reloads never re-lock),
and acceptance is the square monitor's relaxed tier (reference golden
green, both-high/one-row/flat-low red, full series and last-128 window
alike). Gates: levels.test.js (11 checks), the layout gate's
reduced-geometry leg (L0 pinned at both 13" viewports — ran red against
the pre-C34 page: every locked panel still laid out), the keyboard
walk's L0 leg (no orphan stops — ran red: Tab reached bempty/bdemo/
smscells/pincells/speed), the browser session (predict by click and by
keys, PASS verdict, par reveal, solved reload) — which also caught and
fixed three glue bugs before commit (the predict card had no mouse
path; a solved reload lost the par reveal; the title bar narrated
SANDBOX on a level page). smView gained the CTRL enable bit so
disabled machines no longer render ghost PC chips (the demo's SM1–3
parked cursors were a lie; make web re-verified the driver, 32 client
checks + the three mutation demos).

C35 landed 2026-09-05: chapter 0 completes — the delay column and the
editor's leash. L1 Metronome (modify): the delay column debuts
(`delayCol`, the C34 CSS stub) and the timing monitor profile gets its
first real tier — the exact ladder (6..10 / 8..8 / 8..8) judges one
flash every 8 clk; the boot program is L0's un-slowed blink (running it
teaches "period 2 clk — outside (8..8 clk)"), and the one-cell
modification is a dedicated delay-cell editor (`#dlyedit` over the
row's delay track): click a row, or Enter/digit from the listing
cursor; type 0–31, Enter commits, Tab/Shift+Tab cross rows that have
instructions, Esc cancels, 99 is refused with the 5-bit reason on the
status line. The row editor never opens in L1 (L2's debut, per the
card). L2 Author's hand (make): the listing boots EMPTY (32 honest `·`
rows), the row editor opens in a level for the first time on the leash
— `RowComplete.analyze`'s new `opts.opcodes` whitelist (a filter over
the C32 slot-aware candidates: the mnemonic menu offers exactly `set`,
a locked mnemonic's operand slots stay silent, the jmp gutter-pick
pseudo-candidate is leashed too) — and `#edside` is absent from layout
and Tab order both (no side column until ch.4), so Tab crosses
ins→delay→next row. The level format grows `reference.listing`
(validator + generator): the reference solution ships separately from
the boot program, and the golden carries a `boot` case whenever they
differ — the levels gate asserts the boot reds (the task is real from
cycle one) alongside the reference green and the period-wrong /
opcode-locked perturbations red (L2's red set: L1's answer, and the
nop-can't-bring-the-pin-low attempt). Par committed per level (L1
2 words · 8 clk; L2 2 · 4; the hyperopt-derived front machinery is
C36's). Gates: levels.test.js (19 checks, engine-side — the leash
check ran red against the pre-C35 module: the menu offered all ten
mnemonics), the layout gate's L1 leg (the delay column debuts without
moving the L0 page — every box keeps its left edge and width, main's
clamp-fixed columns identical; ran red: no #dlyedit existed), the
keyboard walk's L1+L2 legs (delay-cell Tab-crossing; the leashed
editor debut — ran red: Enter found no delay cell, and the menu
offered all ten), the browser session (L1: run-red verdict, edit both
cells by mouse, PASS + par reveal, 99-refusal, solved reload; L2:
author the 1:3 wave through the leashed editor, PASS at 25% duty),
make web re-verified.

C36 landed 2026-09-05: jmp debuts with a job, and par reveals the
cost. L3 Two ways to loop (chapter 1): the boot ships L2's answer
transplanted after a once-preamble (`set pins, 1 [7]`) with the wrap
pinned over the whole listing (steppers still locked), so the wrap loop
drags the flash round — the boot reds legibly at period 13 and only a
jmp back edge that skips row 0 escapes it; the leash grows to set+jmp
(the gutter-pick candidate unlocked with it), and the cost lesson ships
as goldens — the naive port (keep [2], add `jmp 1`) reds at period 5
(jmp eats a cycle wrap does not) and `jmp 0` reds at 12 (the target is
the structure). Reference `jmp 1` + row 2 shaved to [1]; par 4 words ·
4 clk — the derived front champion, and against L2's par (2 words ·
4 clk, no back-edge clk) the player reads that wrap is free. L5 The
long blink: the same 1:3 wave ×16 — high 16 of 64, the 48-clk low
split [31]+[15] (one row cannot hold it); the row editor's delay cell
now refuses > [31] like L1's #dlyedit does (the assembler — pioasm-
faithful — would silently mask [48] to [16]; the refusal keeps the
edit open with the 5-bit reason on the status line), and the
both-halves-maxed perturbation teaches that the `·` row is a jmp 0
that costs a clk (period 65). The wave window became level geometry:
`waveWin` in the level format (validator bounds it against the tier),
driver `setWaveWin` (128..1024 clamped, default 128 — the sandbox
untouched) + the worker cmd + the view's WIN follow it; L5 runs a
512-sample window so the judge's stability window sees whole 64-clk
periods. Par machinery: fronts derived in tools/hyperopt.py —
FRONT_CLASS names each level's honest solution space (wrap loops over
set rows under the pinned WRAP_TOP; L3's prefix class keeps the
preamble row and closes the loop with the jmp), every distinct
(words, period) point is model-verified through the goldens' own load
timeline (full series and window both) against _square_judge — the
Python mirror of squareJudge with Math.round's half-up semantics —
and the committed par must equal the front champion (l0–l2's hand-set
pars were already front-exact). The drift gate: tests/test_hyperopt.py
(a tampered tree must red), `hyperopt.py --level-fronts`, and the
self-test's hermetic section (make hyperopt). The browser session
(L3: boot red, naive red, solve, PASS + par reveal, solved reload;
L5: [48] refused loudly, split, PASS + par) also caught a shell bug:
a level RESET re-posted the stale boot program — level pages never
take the autosave round-trip, so curState.words never followed edits —
buildAndPush now keeps the stored-program copy current (red: reset+run
showed the boot's period 13 under the solution listing; green: reset
restarts the edited program). Gates: levels.test.js (27 checks — the
l3/l5 legs ran red first: the level files did not exist), the walk's
L3/L5 legs (ran red without the level files — the page boots the
sandbox and Tab finds bempty/bdemo/…; the eddly refusal ran red with
the guard re-injected-out: the walk timed out on "the refused commit
keeps the cell open"), engine-driver's setWaveWin check (red: not a
function), make js 170 green, make web re-verified (the driver change
rides the client gate). make py was already red on HEAD before C36
(five pre-existing ruff findings plus one unformatted file, all in
files this card does not own — left as found; C36's own files are
clean, pytest 186 green).

C37 — the scrambler — comprehension by reordering (Parsons). L4: rows
shuffled, the task is to reorder them until the wave matches; the
mechanic is click-pair row swap — a listing gesture like the gutter
pick, not an editor mode: the row editor never opens, the vocabulary
is the given rows (keyboard: one Tab stop on the listing, arrows +
Enter to mark and swap, per the C25 grammar). levels.test.js: the
reference order green, a planted wrong order red; the walk covers
the swap keys.

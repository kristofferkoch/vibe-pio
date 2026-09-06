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

C37 landed 2026-09-05: the scrambler — comprehension by reordering.
L4 Out of order (chapter 1): the boot IS the canonical misconception —
the once-flash (`set pins, 1 [7]`) trapped inside the loop, red at
period 14 every time the flash comes round — and the way out reads the
jmp off the face: `jmp 1` names address 1, so the row at address 0 runs
once and the flash belongs there. The mechanic is the click-pair row
TRADE (a listing gesture like the gutter pick, never an editor mode:
the row editor and the delay cell both stay shut — the level format's
`scramble: true` flag gates them, and openRow refuses; the keyboard
rides the C25 grammar — Enter marks, arrows walk, Enter on another row
trades, Esc unmarks, letters author nothing; empty `·` rows are not
vocabulary). The second lesson ships as goldens: high-before-jmp reds
at duty 38 (the jmp's clk holds the row before it — closing the loop on
a low row is a real choice) and dead-rows never blinks again (rows
after the jmp never execute). Par machinery: FRONT_CLASS grows
"scramble" — the honest solution space is the permutations of the given
rows (analytic (period, duty) per order under the chapter-1 timing
rules, deduped, each point model-verified through the goldens' own load
timeline; the champion must equal the committed par 5 words · 8 clk).
Gates: levels.test.js (30 checks — the l4 legs ran red first:
MODULE_NOT_FOUND, the level file did not exist), the par drift gate
(ran red first: "l4: no FRONT_CLASS entry"; pytest now also red-flags a
tampered l4 par), the keyboard walk's L4 leg (ran red against the
pre-C37 page: the listing narrated the editor grammar and Enter would
have opened it; green with the trade — the walk drives the one-swap
solve under keys alone), the browser session (click-pair by mouse, the
marked row, PASS verdict, par reveal). Separation note: a concurrent
C38 WIP (the visual monitor face) landed uncommitted in the shared tree
mid-card and was interleaved in the same files; this commit carries
C37 only — the WIP was preserved untouched in the working tree.

## Web track — the visual monitor (C38) — COMPLETE

Scheduled 2026-09-06 by owner request after an inter-session review.
Provenance on record: the change arrived as a finished-but-uncommitted
working-tree diff from a concurrent worker session that was supposed to
be isolated in a worktree and never committed anywhere (verified: no
branch, no stash, no dangling commit — the tree diff was the only
copy); the owner's review-and-commit instruction stands in for the
grilling, the C27–C30 precedent. Findings on record: the band's numeric
verdict (period clk, duty %) asked the player to read numbers where the
lesson is shape. C38 makes the monitor's tolerances geometry — the
judge's every return carries a machine-readable code (additive; the
verdict prose stays pinned verbatim by the wave-contract tests), and
the band face maps it to a status word (ok green, bad red, dim pending)
beside two mini-waves at one shared px/clk so the eye compares like for
like: the tier itself as a golden template (targetGlyph — pure module
logic in levels.js: the profile's own numbers as a representative
accepted cycle plus the two acceptance windows the judge checks) next
to the last measured cycle; the numbers live on the tooltip/aria-label,
never parsed back out of the prose. The wave panel paints the same two
windows over the live trace at its last rising edge — paint only, the
panel's geometry never moves, the sandbox is untouched (LEVEL-only
paths). Gates: the levels gate's targetGlyph + code tests (shown red
against re-injected defects before landing — the duty-window endpoints
swapped: "l0: high 25 clk outside the duty window [102.4, 25.6]"; the
duty code field removed: "actual undefined, expected 'duty'"), the
layout gate's monitor leg at both 13" viewports (the head row must not
wrap, the glyphs keep their boxes, the verdict word does not overlap
them, the wave keeps its 64px floor), the standing walks (no new Tab
stops), make js 179 green, and the live browser session (L3's boot:
"period — outside" in red with both gold gates painted on the wave;
L4 solved: "square — PASS (exact)" in green, the live glyph redrawn,
par beside it).

## Game track — level campaign, chapter 2 (C39–C41) — COMPLETE

Scheduled 2026-09-06 by the chapter 2 grilling over
mockups/LEVELS-NOTES.md (the 2026-09-04 didactics exploration stays
the design spec; this grilling covered chapter 2 only — chapters 3+
stay in IDEAS/LEVELS-NOTES for their own grillings). The fun gate read
on chapters 0–1: **clean, as shipped** — no riders. Owner decisions on
the record:

- **The stimulus draws on the wave.** One row per driven input pin,
  above the lens row, at the shared px/clk on one time axis — the echo
  lesson IS the two traces side by side (the C38 like-for-like grammar
  extended to stimulus vs response). The pattern panel stays absent
  (the rows carry the face; the given is never player-editable).
- **L6 passes by RX judge.** The pushed RX words decode to the driven
  pattern's bits — a pure judge over RX contents, the same machinery
  L8's fencepost near-miss needs (one judge, two levels). The predict
  gate still locks the first run.
- **L7 is the gated echo.** Data + enable pins driven by the level:
  mirror data while enable is high, hold the output when it drops.
  `jmp pin` is the only way — the unconditional copy keeps echoing
  through disable and reds exactly at the freeze point (a job, not a
  syntax demo; the L3 precedent).
- **The monitor flips at L7.** The decode judge (SPEC-16-9 style:
  decoded bytes over the output wave, per-bit skew windows as the tier
  ladder, versioned) debuts there; the frame map's START/D0..D7/STOP
  land as the subgoal labels the notes planned.
- **Par keeps its honesty on the reading axes.** L7: words × echo
  latency (clks in→out — visible on the two rows as the trace offset);
  L8: words × clks/bit gathered. FRONT_CLASS grows echo/gather; the
  champion must equal the committed par (the C36 discipline unchanged,
  a new axis per class). Value judges (RX) are exact by design — a
  value has no tolerance; the tier ladder lives on timing judges
  (square/decode).
- **Full perturbation sets.** L6: never-push / in-count-wrong; L7:
  echo-during-disable + dropped-bit; L8: the fencepost both ways
  (SPEC-3.1-4's pre-decrement test named where the verdict shows it).
- **The breather waits.** No Coffee-Time level between ch1 and ch2 —
  the 0→2 ramp is still small steps; first candidate after ch3's L12,
  revisited at the ch3 grilling.

Web cards: the JS discipline (docs/js-tooling.md), red/green TDD, DOM
glue verified by the browser session and `make web` — geometry and
keyboard only through the two sanctioned headless gates; the levels
gate stays engine-side. Dependency order: C39 → C40 → C41 (runtime
unlock order stays numeric regardless: L5 → L6 → L7 → L8).

C39 landed 2026-09-06: the reading slice. The level format grows
`stimulus` — a list of pattern cfgs ({mode:'square'|'bits', pin,
period|bits}) mapped 1:1 onto the engine's pattern contract, validated
at registration (even square periods, 0/1 bit strings, one pattern per
pin), armed by the shell BEFORE the level load (the pattern phase
starts at the load's first rendered clk — exactly the _SandboxMirror
replay order), read-only forever (the pattern panel is absent on level
pages). The driver's single sandbox pattern became a LIST
(`setStimulus`; `setPattern` keeps the one-generator sandbox contract)
composing one pin per pattern, with the composed gpio_in recorded per
rendered clk (`allGpioIn`/`wave.stim` — op clks hold the last level,
the shim's sticky discipline) so the wave draws the given: one trace
row per driven input pin ABOVE the lens row, label `in <pin>`, at the
shared px/clk on one time axis. The goldens generator replays stimulus
through the mirror and records per case the driven pins' series plus
the PUSHED RX words (read out by an honest FLEVEL + drain-exactly-
the-level, the browser DRAIN's own bus traffic; pio_model the oracle).
The RX judge debuts (levels.js `rxJudge`, kind 'rx' v:1: expected
words, exact — no ladder; fewer words keeps watching, the verdict
names the first divergent bit — and the driver's `rxSeen` mirror
latches the pre-edge ISR at each push strobe, the judge's browser
input; exact for instruction pushes, the autopush same-cycle edge is
its documented limit). The predict word face: `predict.face:'isr'`
candidates render as bit-word rows (the ISR panel's bits grammar,
32 cells, stacked so they never wrap the predict row). L6 Listen:
prefilled `in pins, 1`/`push block` (wrap 0..1, IN_BASE 1), the
square period-4 given on gpio1, the ISR panel + the RX half of the
fifo row debuting (SURFACE split `txfifo`/`rxfifo` — #fiforow stays
while either half is unlocked; TX absent until L9), no editor
(predict→run), predict locks the first run, the fifth push stalls on
the full FIFO (the honest machine — acceptance is the first four
pushed words 0x80000000/0/0x80000000/0), par hand-set 2 words · 2 clk
(FRONT_CLASS 'given' — the level's own program is the only honest
one; the drift gate pins it, `_rx_judge` the Python mirror). Gates:
levels.test.js (7 new legs — the l6 legs ran red first: the level
file did not exist; the rx-judge divergence demo re-injected any-
words-pass; the stimulus-lockstep leg ran red on a one-clk phase
defect in setStimulus and on the pre-C39 driver), the layout gate's
L6 leg at both 13" viewports (ran red: the stimulus row was missing),
the keyboard walk's L6 leg (ran red against the sandbox page: orphan
stops bempty/bdemo/…; green with the reading surface — the ISR/rx
stops reachable, the word face committed by keys, no editor), pytest
189 green (a tampered l6 par red-flags), make js 189, make web
re-verified (the mirror refactor rides the client gate). The live
session also caught one shell bug before commit: svg carries no
`hidden` IDL reflection — the rx judge's empty glyph boxes would have
shown on the band (lvtarget/lvlive now toggleAttribute), and the
sandbox stayed untouched (no stimulus row, 128 window, pattern panel
present). make py's five pre-existing ruff findings (C36's note)
remain — none in this card's files.

C40 landed 2026-09-06: L7 Echo — `jmp pin` gets its job, the decode
judge debuts. The level drives gpio2 with a byte's UART frame (start 0,
0x33 LSB-first, stop 1 — 8 clk/bit, inside the enable square's high
window on gpio1) and the task is the gated echo onto gpio0. One reshape
vs the card, on the machine's own evidence (model-verified, recorded in
the level file): with opcodes set+in+out+jmp and no `mov`/`pull`, the
only pin→pin copy is the branchy pair — `jmp pin` (JMP_PIN = the DATA
pin) testing the bit, `set pins` driving its value, the delays holding
each bit-time (the gate the player writes is the RATE; the enable
square is drawn and narrated as the speaking window, never tested —
one JMP_PIN names one wire, and `out` reads an empty OSR: the in/out-
belief golden shows the line never rising). The reference is 3 words —
`jmp pin, 2` / `set pins, 0 [6]` / `set pins, 1 [5]`, wrap 1..0 — the
high path rides the `·` row's free jmp 0 home (the L5 lesson
recurring, budgeted into the [5]); par 3 words · 8 clk/bit. The decode
judge (levels.js `uartJudge`, kind 'uart' v:1): SPEC-16-9 run
semantics over the OUTPUT wave — a run of L clk is m=ceil(L/bitHi)
bit-times legal iff m*bitLo ≤ L, 8 data bits LSB-first, a high tail
completes the frame (a stop merged into idle costs nothing); expected
bytes = the driven data; the tiers are the [BIT_LO,BIT_HI] skew
windows (relaxed 6..10 / exact 8..8 / strict 8..8 — the relaxed tier
genuinely admits the racer's skew, the ladder is real); the near-miss
faces name the run ("D1 runs 18 clk — outside") and the bit ("byte 1
bit D0 — got 0, want 1"). The frame's window discipline is the LIVE
one: a finite frame leaves every fixed window, so the gate + the front
assert the sliding window passes at SOME position (the stop-completing
moment) and never passes a perturbation at ANY position. The band face
extends the C38 grammar to frames (targetGlyph grows the uart kind:
the byte's own frame at the window's centered bit-time, the two skew
windows after its first fall; the live glyph draws the last measured
frame with the divergent bit marked red); the frame map debuts as the
wave's subgoal labels (the uart lens at the frame's own 8 clk/bit);
the lens pins to gpio0 (steppers locked); par names its clock
("clk/bit"). The condition leash: the level format grows `conds`
(validated against the assembler's table; absent = none), row-
complete's `opts.conds` filters jmp's condition slot, and the
chapter-1 levels now offer no conditions at all (their jmps were
always unconditional — the menu had been teaching ahead). FRONT_CLASS
'echo' (hyperopt `_echo_front` + `_uart_judge` mirror): the steady-
bit-time echo family per r ∈ [bitLo..bitHi], each point model-verified
through the goldens' own load timeline + stimulus, the analytic r
pinned to the model's measured start-run. Perturbations: ungated-echo
(the racer — no bit-time gate, runs skew), dropped-bit (the 9/8 drift
— exact reds the run, relaxed decodes a different byte), in-out-
belief. Gates: levels.test.js (10 new legs — red first: MODULE_NOT_FOUND,
the level file did not exist; the conds leash ran red against the
unfiltered menu), the layout gate's L7 leg at both 13" viewports (ran
red: #framemap had no box under the hermetic drive), the keyboard
walk's L7 leg (ran red against the sandbox page: orphan stops bempty/
bdemo/…; green with the menu-driven `jmp pin` authored under keys, the
PASS face gated by feeding the shipped judge the golden series — the
walk's engine is the fake ABI), pytest 191 (a tampered l7 par
red-flags; the uart mirror's verdicts pinned; doctests), make js 199,
make web re-verified, make hyperopt. The live browser session verified
the whole face by mouse (authoring, PASS, par reveal, the readable
128-sample wave with both stimulus rows, the near-miss red naming bit
D0, solved reload, the sandbox untouched) and caught one shell bug
before commit: on a solved level the payoff freeze was first-solve-
only, so a re-run slid the wave window past the finite frame into
mid-frame fragments the judge honestly reds under the PASS chip — a
decode level's payoff is a moment, not a steady state, so levelPass
now freezes every uart run (square levels keep the shipped live
re-run).

C41 landed 2026-09-06: L8 Fencepost — `jmp x--` gets its slot, the
designed off-by-one ships. The world ticks on gpio1 (a 2-clk low pulse
then sixteen 1s, 18-clk periodic — the first pattern tuned so the
fencepost reads ON THE DECODED VALUE): the correct 8-bit gather pushes
11111110 (0xFE — the tick's 0 plus seven 1s), `set x, 8` pushes
11111111 (SPEC-3.1-4: the X=1 jump still fires — the extra 1 shifts
the 0 off the end; the verdict lands at bit 24, "got 1, want 0"), and
`set x, 6` leaves a 1 missing at bit 25 — both wrongs diverge at the
word's edge, never a mystery red (an earlier alternating-pattern draft
made the shift flip every bit — the model trial red it before it
shipped). The gather lap is exactly the pattern's period (set 1 +
in/jmp ×8 + push 1 = 18 clk), so every lap pushes the same word and
the fifth push stalls on the full FIFO (L6's honest machine). The X/Y
scratch panel debuts as its own surface key (`xy`: #xy) with the regs
section's visibility derived, the #fiforow precedent — under `xy`
alone the irq lamps and inspector stay absent (ch.5 / config, not
this task's teaching). The delay column stays shut (structure, not
delay); par names its clock — reading levels' period axis is now
clk/bit on the band (L6's face gains the honest unit too). The conds
leash grows the x-- slot (L8's menu offers exactly it). FRONT_CLASS
'gather' (hyperopt `_gather_front` + `_rx_judge`): the counting
gathers at every steady rate, the arm value read from the reference
listing (the _prefix_listings precedent), each distinct point
model-verified through the goldens' own load timeline + stimulus —
only the undelayed 2-clk/bit loop survives (any delay desynchronizes
the lap from the pattern's period and the exact judge reds the
drifted words); champion 4 words · 2 clk/bit == the committed par.
Perturbations: fencepost-too-many, fencepost-too-few, and
count-is-width (`in pins, 8` samples eight ADJACENT pins once — 0x01
at bit 24, "bit 31 — got 0, want 1"). Gates: levels.test.js (10 new
legs — ran red first: MODULE_NOT_FOUND, the level file did not exist),
the par drift gate (ran red first: "l8: no FRONT_CLASS entry"; pytest
also red-flags a tampered l8 par), the layout gate's L8 leg at both
13" viewports (ran red against the pre-C41 levels.js: the page failed
to register l8 and booted the sandbox), the keyboard walk's L8 leg
(ran red the same way — orphan stops bempty/bdemo/…; the clk/bit
par-name assertion also ran red against the pre-C41 sm-view), make js
208, make py 192 (the pre-existing ruff findings from C36's note are
gone — clean on HEAD now), make web re-verified, make hyperopt. The
live browser session (authoring by mouse, PASS, the bit-24 near-miss,
par reveal, solved reload, the sandbox untouched, X counting down
live) also caught one shell bug before commit, the C36 class: on a
level page the engine live-patches edited rows, so an authored-then-
run gather sampled a ROTATED stimulus window and a correct solution
reds (0xFB000000 where the golden says 0xFE000000) — the golden's
replay starts at the load, so lvRestartIfDirty now makes the first
run/step after an edit re-post the level's load (untouched re-runs
keep the shipped live behavior; red/green demonstrated live). The
walk fix it forced: the walks' face-feed technique now pauses and
settles before feeding the judge (a page-side sleep was a no-op —
Runtime.evaluate does not await promises; a Node-side settle is the
honest wait). No cards remain; chapter 3 (the feeder, L9+) starts
from IDEAS/LEVELS-NOTES at its own grilling.

## Game track — the campaign's front door (C42–C43)

Scheduled 2026-09-06 by the front-door grilling over the 2026-09-06
IDEAS doodle (the entry is pruned by this grilling; the dated "The
campaign's front door" section in mockups/DESIGN-NOTES.md is the
standing spec, and C42's mock-up round in mockups/landing.html
extends it with rendered decisions). The doodle's own slice bar is
met: chapters 0–2 complete (C34–C41), so the first map is three whole
chapters. Owner decisions on the record:

- **The map names its future — dim but named.** Every registered
  level row is visible and named; rows past the frontier dim
  (`--dimmer`). The C34 absence doctrine stays a level-page doctrine —
  a campaign map naming its future is content. Chapters with no
  shipped levels stay off the map (the registry is the source;
  LEVELS-NOTES prose does not ship ahead of its own grilling).
- **Three states, no in-progress cell.** ✓ solved (par on solved rows
  only — the expertise-reversal rule projected onto the map), ▸ the
  frontier, dim ahead. Unlocks numeric but soft: `?level=` always
  deep-links; the map links solved + frontier rows only. Campaign
  state derives from the existing per-level keys (furthest = max
  contiguous solved) — no new storage shape on the landing card.
- **The solved listing is the one new storage datum — adopted.**
  lvSession grows the solved listing at pass: a solved reload boots
  YOUR program (today it re-boots the level's boot listing), and the
  map shows your words·clk beside par with par-matched / par-beaten
  badges (the badge compares the judge's measured axis values — a
  clk/bit level compares clk/bit, C41's named-clock rule). The level
  page writes the datum (C43); the map reads it.
- **Chapter-complete is an era caption mark.** A ✓ in the chapter
  group-frame's caption — pure C25/C26 chrome, no new glyph grammar.
- **Two cards, C42 → C43.** The landing is shippable alone (its rows
  link to `?level=`); the transitions edit the level page — the NEXT
  button joins the C38/C40 band on pass, and solved reloads change
  what they boot.
- **Both sanctioned gates grow landing legs** — a keyboard-walk leg
  (the C25 listing-as-listbox grammar verbatim: arrows walk, Enter
  opens, the sandbox row reachable) and a layout-gate leg
  (master-window + listbox geometry at both 13" viewports), each red
  against the pre-card page first.
- **The door ships clean — zero lore.** Era furniture only: no
  sinister content, no fictional names, no About-box slip. The bible
  session (the IDEAS lore doctrine) gets its first deadline at
  chapter 3's grilling; whatever it permits lands later under its own
  cap (at most a masthead and one "civilian").
- **The campaign is the front door at the URL too.** serve.py serves
  web/index.html at `/` (redirect or direct serve — implementation
  pick), its docstring repointed; README gains a try-it line (it
  carries no URL today); sm-view.html keeps its URL unchanged for
  tool users.

Settled with the doodle (its leans, unopposed): the landing is its own
page — web/index.html sharing sm-view.css, classic-script,
dependency-free, NO engine boot (no worker, no wasm); chapter titles
become registry data in levels.js; the sandbox rides the map as a
standing row ("everything always"), advertised harder as chapters
complete; the transition is one affordance, not a system — NEXT on
pass is a plain location hop with no auto-advance (the payoff frame
holds until the player acts — C40's freeze lesson generalized; from
the last registered solved level it hops to the map), the doodle's
Alt+N is taken (`n` = binsn) so the letter lands at implementation
under C33's unique-letters rule, and exit-to-map is a toolbar button
(Alt+M, free); effects none (the C26 decision stands). Web cards: the
JS discipline (docs/js-tooling.md), red/green TDD, DOM glue verified
by the browser session and `make web` — geometry and keyboard only
through the two sanctioned headless gates. No engine work rides these
cards; the levels gate stays engine-side and untouched. Dependency
order: C42 → C43.

C42 landed 2026-09-06: the front door. The mock-up round
(mockups/landing.html over the shipped era stylesheet; its rendered
decisions appended to the DESIGN-NOTES section) picked the face first:
a content-hugging menu window (the first cut's fixed-height window drew
a dead silver slab — height:auto capped at the viewport, max-width
640, no toolbar), the map as ONE listbox with chapters as ARIA groups
in it, rows `44px 1fr auto` (mono number · name · right status), the
status faces riding the band's own grammar (green ✓+par, bold amber ▸,
--dimmer ahead), the sandbox as a standing row under a rule (not a
chapter), and the C25 cursor grammar verbatim with the cursor booting
on the frontier row. web/index.html is its own page (sm-view.css
shared via a dated C42 section; classic-script, dependency-free, NO
engine boot — levels.js + the nine level files are its only data).
levels.js grew the campaign as module logic: the CHAPTERS title table
(validate() now rejects a level whose chapter has no title, and the
gate pins that no title ships ahead of its first level), sessionKey
(the per-level localStorage spelling, repointed out of sm-view.js so
both pages share one constant), campaign(read) (numeric order — this
test file's own l5-before-l4 registration proves the derivation —
solved set, frontier = first unsolved so furthest = max contiguous,
chapters-with-levels only with their complete flags), and parText (the
named-clock par label, repointed out of lvRevealSolved — one string on
the band and the map both). serve.py's `/` became the front door and
README gained the try-it line (the Pages URL); the Pages artifact's
meta-refresh now points at web/index.html. The live session caught one
shell bug before commit: direct-serving the landing's bytes at `/`
strands its relative scripts at /levels.js (404, an empty map) — `/`
REDIRECTS to /web/index.html instead (the card's implementation pick;
the Pages artifact's own redirect is the same pattern), and the session
re-verified the whole payoff flow by real CDP mouse events over the
real wasm engine: / → the map → the frontier row opens L0 → predict by
click unlocks RUN → square — PASS (relaxed) → back on the map L0 wears
`✓ par 2 words · 2 clk/cycle`, the frontier and boot cursor move to
L1, the sandbox row advertises `1 of 9 cleared` (and the standing row
opens the untouched four-machine sandbox). Gates: levels.test.js (5
campaign legs — red first against the pre-C42 module:
PioLevels.sessionKey not a function, CHAPTERS undefined), the keyboard
walk's landing leg (red first: timed out waiting for the map — the
page did not exist; green: one Tab stop for the whole page, the
frontier boot cursor, Enter on solved/frontier/sandbox rows navigates,
Enter on a dim row stays put, session snapshot/restore around the
seed), the layout gate's landing legs at both 13" viewports in both
postures (red first: the page did not exist; green: menu-window
proportions, single-line captions/rows/status words, no internal map
scroll, and the fresh campaign's geometry identical to the seeded
one's), make js 218 green, make web re-verified (32 client checks +
the three mutation demos), the era tooltip verified live (hover
narrates the dim row's soft unlock).

C43 — the transitions. The NEXT pushbutton joins the level band on
pass (beside the chip and par; the letter per the unique-letters rule;
a location hop to the next level, or to the map from the campaign's
last registered solved level); exit-to-map (Alt+M) joins the toolbar
on level pages; the solved-listing datum — lvSession keeps the passing
program at pass, solved reloads boot it (the predict gate's
authored-programs rule stands — your own solution never re-locks),
and the map's solved rows gain your words·clk beside par + the
par-matched/beaten badges. No engine changes. Gates: the walk's
NEXT/exit legs (red first — the buttons do not exist), the layout
gate's band/toolbar legs (the new steady chrome and the pass-time band
posture pinned — the C33 never-reflow discipline extends to the band
gaining its pass-time member), the browser session (the payoff flow:
pass → NEXT → map → replay your own solution), `make js` / `make web`.

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

## Web track — era chrome (C26)

Promoted from the IDEAS keyboard + era-skin entries after the
2026-08-29 grilling round 1 (owner decisions: light skin, one master
window, hue-true light-tuned semantics, two bitmap fonts, standing
headless keyboard-walk gate, no CRT on the chrome). Web cards follow
the JS discipline (docs/js-tooling.md): Biome + `node --test` gated by
`make js`, runtime stays dependency-free, DOM glue verified by the
browser session and `make web`. Red/green TDD applies like everywhere
else: every regression check shown red against the re-injected defect
before it ships, with the demonstration recorded in the commit.
C25 — the keyboard surface — landed 2026-08-29: keys owned by focus,
the listing as a listbox, one Tab stop per arrow group and stepper
pair, Alt+letter mnemonics, the focus-tracking status line, and the
standing headless keyboard-walk gate (`web/tests/keyboard.test.js`,
the second sanctioned DOM-glue exception).

### C26 — the era skin: light silver, one master window

Re-skin the sandbox to SerenityOS's take on Win3.11. The C25
keyboard walk is standing, so it catches the re-skin's DOM changes
instead of being written twice.

- **One master window:** the viewport is the vibe-pio window —
  silver #C0C0C0 chrome, navy title bar with bold white caption,
  panels become group frames (etched/sunken), teal #008080 shows
  only as the desktop edge. Nothing decorative lies (no window
  buttons that do nothing).
- **Hue-true, light-tuned semantics:** amber/green/cyan/red keep
  their identities, hand-darkened for contrast on silver; not
  snapped to VGA-16. The footer legend is re-taught with the new
  values.
- **Two bitmap fonts:** "Pixelated MS Sans Serif" 11px for chrome +
  a bitmap mono (Cozette / Px437 IBM VGA9 / Tamzen — pick at mockup)
  for the listing, bitfields, FIFO words, waveform annotations.
  Integer sizes only.
- **Crispness mechanics:** font smoothing off, no border-radius, no
  gradients, no blur, no subpixel motion; 2px bevels (white TL /
  #808080 BR; pressed = bevel swapped, label nudged 1px); hard 2px
  black offset shadows on the candidate popup and tooltips (cream
  card); 1px dotted focus rect; disabled = #808080 text, visible not
  hidden; spacing on the dialog-unit grid (1 h-dlu = ¼ avg char
  width, 1 v-dlu = ⅛ char height); drawn geometry (the waveform)
  snapped to the pixel grid. **CRT/scanline: none** (owner
  2026-08-29 — at most sparing game-transition effects much later,
  never WebGL simulations of the UI itself).
- **Tooltips** (the `title=` narration) render as era tooltips with
  a focus path — one mechanism shared with C25's status line, not a
  duplicate.

Process: a static mockup round first (`mockups/` re-skin +
DESIGN-NOTES.md updated — the mockup is the spec, house discipline),
then `web/`. Done-when: `make js` + `make web` green with every
layout-gate baseline re-run against the new geometry — shown red
against the un-re-pinned baselines first (proving the gate measures
what it claims), then green with re-pinned values; the browser
session confirms the feel. `make sim` / `make model` untouched (no
engine surface).

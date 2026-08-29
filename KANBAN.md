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

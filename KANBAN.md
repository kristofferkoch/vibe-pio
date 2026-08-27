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

## Game track (C22, C24)

Promoted from the IDEAS game entry after the 2026-08-27 game-loop
grilling (round 1: sandbox). The sandbox card of that promotion and
the multi-SM oracle card (C23) have landed; the remaining cards
extend them. Owner decisions: **sandbox
first, SM0-only** — "all features unlocked" means the complete per-SM
surface (FIFO join/aux modes, real CLKDIV, shift/autopush/autopull
config, pin mapping in both directions, IRQ flags, RX drain); the
other three SMs are their own later cards. The **multi-SM gate
oracle is pio_model extended to multi-SM** — the Python referee
grows, no iverilog-oracle detour (C23 lands before any multi-SM
client work). Config UI is an **inspector-first hybrid**: a full
datasheet register-inspector panel guarantees 100 % field coverage
from day one, and the DESIGN-NOTES drawn grammar (shift arrows, join
ghosts, wrap steppers, pin tags) lands incrementally on top (C22).
**Real CLKDIV is exposed** even in sandbox (levels may still
abstract it per level). Input stimulus is **manual pin drives + hold
latches + a tiny pattern generator** (square / pasted bitstream on
one pin — deliberately short of level-stimulus machinery). The
receiver monitor is a **selectable lens** (off by default / square /
uart, target pin picked — a lens, never a judge, until levels).
**No game shell yet** — sm-view stays the entry page; the menu lands
with the first level card. Persistence is **localStorage autosave +
JSON export/import** of the stored-program format (32 words + config
overlay — the same JSON seeds level authoring) plus
copy-as-canonical-listing via pio-asm. Sandbox boots to **empty
memory** (all-zero = the jmp-0 park, the DESIGN-NOTES lesson), the
old uart_tx demo demoted to a loadable promotion default (kept at
kickoff). Dependency order: C22; C24 after the landed C23. Tooling/web
cards state their own done-when gates below; the RTL-card template
does not apply (the RTL is already multi-SM complete).

### C22 — drawn config (the DESIGN-NOTES grammar)

- The cyan structural config, on top of the sandbox overlay: shift
  direction + autopush/autopull flow arrows with threshold steppers
  over OSR/ISR; FIFO join ghosts (ticked upper TX slots, dimmed
  ghost RX panel); wrap steppers on the wrap arc; pin-mapping tags
  (out/side base·count) on the waveform. Every control is a real
  reg write through the sandbox overlay (the ds-allocator precedent)
  — nothing is display-only.
- Done when: `make js` units pin the field↔reg-write mapping;
  `make web` and the browser session verify the glue (DOM work is
  never unit-tested — the docs/js-tooling.md discipline).

### C24 — sandbox multi-SM (four machines, one playground)

- The shim's pre-edge sample extends per-SM (PioCycle grows the
  SM1..3 fields or becomes an array — the CC-40 sampling point
  unchanged); the view shows the shared listing with four PC
  cursors, per-SM register/FIFO columns, and pad ownership
  (highest-numbered SM wins, CC-7) on the pin strip; inspector and
  detail panes select the SM. Client-gate legs run multi-SM
  timelines against the C23-extended model.
- Done when: `make js` and the `make web` client gate are green on
  multi-SM timelines vs pio_model (load, parallel run, inter-SM
  IRQ, pin-arbitration legs) with red/green defect hooks; browser
  session; fun-gate re-read on four machines.

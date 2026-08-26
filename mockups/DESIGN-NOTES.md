# SM view — session design notes (2026-08-26)

Decisions behind `mockups/sm-view.html`, the interactive single-SM view
for the TIS-100-style PIO game (IDEAS.md, "SSH game" entry). The mock-up
is the design spec for whatever client ships (web or fat TUI); the
simulator inside it is throwaway — the real referee is `tools/pio_model`.

## Layout

- **Not 80×25.** One SM wants ~1440px in three columns: program listing
  (32 slots, always all visible — the memory budget is the constraint),
  exec + waveform + stimulus feed, registers/FIFO datapath. Fluid clamps
  down to ~960px; below that, scroll rather than clip.
- **One SM** for now (settled); the listing width leaves room for two
  side-by-side later.
- The **receiver monitor lives on the SM screen**: decoded bytes
  accumulate while you step (conformance acceptance, not golden traces).
  The waveform is annotated with protocol *meaning*
  (START/D0..D7/STOP/IDLE), not just logic levels.

## Color grammar (semantic, taught by the footer legend)

amber = control (PC, exec, delay countdown, jump arcs) ·
green = data (OSR bits, FIFO words, data bits) ·
cyan = config/wiring · red = stall/error · gray = idle.
Unused machinery dims (ISR, Y) — attention follows live state.

## Config is structure, not a numbers table

No config panel. Config is drawn, in cyan, where it acts:

- **wrap** — an arc in the listing margin (flashes when the PC wraps);
- **ds-field allocator** — five pips (opt-enable hatched, side bits,
  delay bits) with steppers; see below;
- **FIFO join** — the TX FIFO's upper slots carry a tick, and a dimmed
  ghost RX panel shows where they were borrowed from;
- **shift direction / autopull** — entry⇒exit flow arrows over the
  shift registers, threshold noted;
- **pin mapping** — `out gpio0·1` / `side gpio0·1+opt` tags on the
  waveform; clkdiv is a header chip.

## The ds field is VLIW-ish and shared

5 bits (bits 12:8) split between side-set and delay — the `.side_set`
directive, program-wide. Consequences in the UI:

- The listing has separate **side and delay columns** (and the row
  editor has separate cells; Tab crosses them).
- The allocator **re-decodes the same stored bits** the way the CPU
  would (a JS port of `split_sideset`) — changing it *garbles* the
  program live (delays re-split, sides invert, `out` gets side-driven;
  SPEC-4-7: side-set beats OUT same-cycle) instead of annotating
  conflicts. The only text is a red "garbled" tag when the allocation
  differs from the program's own. Lesson: you cannot store intent in
  the shared bits.

## No labels

Jump targets are bare addresses in the **address typography** (tan
italic, shared with the gutter — an address never reads as data) plus
**jump arcs in the margin**: mid-to-mid brackets with triangle
arrowheads at the destination, flashing when taken. The margin has the
wrap lane plus **four jump lanes** assigned by greedy interval packing
(overlapping spans get different lanes; a 5th overlapping arc reuses
lane 0). The deterministic-auto-label open question dissolves — there
is nothing to name.

## Modeless editing

The listing *is* the source (canonical C12 is 1-1 with the
assembler/disassembler). Every row — including empty slots — is
click-to-edit in place; the machine keeps running beside you (the
mock-up does not re-assemble; the real game's referee does).

- Three cells: instruction | side | delay. Enter/↓ hops rows,
  Tab/Shift-Tab cross cells (wrapping to the previous row's delay),
  Esc cancels, defocus commits and closes (except mid gutter-pick).
- **Completions are trivial, the tooltip is the content**: prefix
  filters over per-opcode operand tables lifted from `encoding.py`;
  the detail pane shows the *total* instruction description (sig →
  desc → params, current param highlighted) that stays anchored while
  operands are filled.
- **jmp targets are picked, not listed**: the gutter arms when the
  pick entry is merely displayed; conditions and pick coexist at the
  first operand (no condition = always jump). `mov`'s second operand
  offers ops (`~`, `::`) and sources together.

## Empty memory

`0x0000` = `jmp 0` (not nop; `nop` is 0xA042). All-zero reset per
`model.py`. `·` is display sugar for *never written*; typing `jmp 0`
displays as `jmp 0`. Running off the end bounces to slot 00; if 00 is
untouched the SM parks in a 1-cycle self-loop — a loud, visible
failure mode.

## Small hard-won implementation lessons

- Popups must be **portaled to `<body>`**: any scrollable ancestor
  forces `overflow-x:auto` and clips them.
- `[hidden]` loses to author `display` rules — keep a global
  `[hidden]{display:none!important}`.
- A page-wide parse error kills the page's own error trap; a fully
  static page is the check-engine light.
- Serve mock-ups `no-store` (mockups/serve.py) — a heuristically
  cached copy produced a false bug report mid-session.

## Open for the real implementation

Wire the view to `tools/pio_model` (referee never forked); re-assemble
on commit; `.side_set` and friends editable as config; level/monitor
profiles as the visible spec; score metric (C14 Pareto when it lands);
`.side_set` slider should re-run, not just re-decode, once assembly
exists.

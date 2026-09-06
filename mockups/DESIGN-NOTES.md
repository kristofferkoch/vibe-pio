# SM view — session design notes (2026-08-26)

Decisions behind `mockups/sm-view.html`, the interactive single-SM view
for the TIS-100-style PIO game (IDEAS.md, "SSH game" entry). The mock-up
is the design spec for whatever client ships (web or fat TUI); the
simulator inside it is throwaway — the real referee is `tools/pio_model`.

## The era skin (C26, 2026-08-29): SerenityOS's take on Win3.11

Re-skinned 2026-08-29 after the C26 grilling (owner decisions: light
skin, one master window, hue-true light-tuned semantics, two bitmap
fonts, no CRT). This section is the spec the shipped client implements;
`web/sm-view.css` is the same token sheet.

### One master window

The viewport is the vibe-pio window; teal `#008080` shows only as the
desktop edge around it. Anatomy, top to bottom: a navy `#000080` title
bar (bold white 11px caption, centered, Win3.11-style; the live CYCLE
readout sits at its right), a silver toolbar band (the transport and
load/store buttons), the three panel columns, and a silver status bar.
**Nothing decorative lies**: no control-menu box, no min/max/close
buttons — the bar carries only the caption and the real cycle counter.
Panels are group frames (a 1px etched groove: `#808080` TL / white BR);
anything textual that holds data is a sunken white well (listing, wave,
inputs, FIFO slots, frame-map cells); anything clickable is a raised
silver push button.

### Hue-true, light-tuned semantics

The five semantic hues keep their identities from the dark mock-up —
they are hand-darkened for silver, not snapped to the VGA-16 palette:

| token | value | role |
|---|---|---|
| `--amber` | `#8F5000` | control (PC, exec, delay, jump arcs) |
| `--green` | `#0D6E0D` | data (OSR bits, FIFO words, data bits) |
| `--cfg` | `#006A78` | config/wiring (distinct enough from the teal desktop, which lives only outside the window) |
| `--red` | `#A31414` | stall/error |
| `--dimmer` | `#808080` | idle/disabled — the era's exact gray, visible not hidden |
| `--addr` | `#6E4F1A` | addresses (tan italic, shared with the gutter) |
| `--navy` | `#000080` | title bar + **selection** (candidates, active radio) |
| `--sm0..3` | amber/green/cyan/dark-purple | per-SM identity |

Dark `--*-dim` variants carry borders and secondary text. The footer
legend swatches read the same variables, so the legend retunes itself.

### Two bitmap fonts, integer sizes only

- **"Pixelated MS Sans Serif" 11px** — all chrome: caption, panel
  titles, buttons, labels, notes, the footer (bold where emphasis is
  needed; the face ships a real bold).
- **Px437 IBM VGA9 16px** (int10h's IBM VGA 8x16 text-mode face) — the
  code/data font: the listing, the row editor, bitfields, FIFO words,
  scratch/level values, waveform annotations. 16px is its native cell —
  pixel-exact there, never scaled.
- Cozette was the other candidate and lost at mockup: its
  browser-shippable forms are a vector outline (antialiases — not
  era-crisp) or bitmap .otb/.bdf (no browser loads them). Tamzen went
  unbuilt for the same outline-vs-bitmap risk; the VGA face was picked
  because it is *the* era text-mode font and needed no compromise.
  Provenance and licenses:
  `web/fonts/README.md`; the files ship in-repo (the runtime stays
  dependency-free — no font CDN).
- **Integer sizes only**: chrome is 11px, mono is 16px, and that is the
  whole scale. Fractional px sizes (10.5px & co.) rendered soft and are
  gone.

### Crispness mechanics

- 2px bevels as inset box-shadows (white TL / `#808080` BR on raised
  controls; swapped on pressed/active and on stuck toggles, label
  nudged 1px via padding). Sunken wells are the same shadow reversed.
- **Hover and press never change metrics.** The first era cut bolded
  hovered buttons; the bold MS Sans face runs wider, auto-width
  controls grew under the pointer and re-flowed their rows — felt
  immediately by hand, now gated (the layout test sweeps the pointer
  over every control family and requires the boxes to hold exactly).
  The pressed nudge then leaked: `button:active`/`button.on`
  out-rank the drawn controls' single-class rules, so the same
  padding swap grew the auto-width toggles and paddles and crushed
  the fixed 13px steppers on press — also gated (the gate presses one
  representative per face family). Hover restyles are color-only
  where they exist at all (the cyan drawn controls keep their
  pre-era color hovers); plain buttons have none — the cursor and
  the tooltip carry affordance. The pressed bevel swap is the one
  sanctioned box-adjacent effect, and only on the push-button faces,
  where its padding keeps its sum so only the label nudges; the
  drawn mini-controls are press-neutral (bevel swap alone).
- No border-radius, no gradients, no blur, no glow text-shadows, no
  subpixel motion (all transitions removed — state changes are palette
  swaps; the `blink` keyframes stay, they are hard steps(2) toggles).
- The ds-allocator's "opt" pip keeps a repeating hard-stop 2px hatch —
  a dither, not a gradient; every stop is a solid pixel column.
- Focus is the era rect: `outline: 1px dotted #000`, offset inside the
  bevel. Disabled controls keep their bevel and paint `#808080` text —
  visible, never hidden.
- Popup + tooltip shadow is the hard kind: `2px 2px 0 #000`, no blur.
- Spacing sits on the dialog-unit grid: at the 11px chrome face,
  1 h-dlu ≈ ¼ avg char width and 1 v-dlu ≈ ⅛ char height both round to
  ~2px, so paddings/margins/gaps are even pixel counts.
- Era scrollbars: silver thumb with a raised bevel over a sunken white
  track (`::-webkit-scrollbar`; the gate's browser is Chromium).
- The waveform snaps where drawing can reach: `shape-rendering:
  crispEdges`, integer stroke widths, integer font sizes, integer grid
  constants (7px/cycle). The svg still stretches anisotropically into
  its flexed box — the annotations scale with it (a live scope, not a
  printed plot); snapping the box itself per-viewport is machinery, not
  skin.
- **CRT/scanline effects: none** (owner 2026-08-29). At most sparing
  game-transition effects much later; never WebGL simulations of the
  UI itself.

### Tooltips: one narration, two mouths

The narration (formerly `title=`) moved to `data-tip=` — native
tooltips can't be suppressed, and the skin renders its own: hover
waits ~350ms, then a **cream card** (`#FFFFE1`, 1px black border, hard
2px black offset shadow, chrome font) portals to `<body>` near the
pointer (the scrollable-ancestor lesson again). The **focus path is
the C25 status line**: the same `data-tip` string is what the status
line narrates when a group takes the keyboard — one mechanism, not a
duplicate store. Tooltips die on mousedown/keydown/scroll, era-style.


## The pin strip draws the mapping (C27, 2026-08-30)

Promoted from the gpio0-panel review (owner-scheduled with C28/C29 —
the review plus the scheduling instruction stood in for the grilling).
The strip's 32 cells carry the pin-side echo of the drawn config: three
cyan-family lanes under each pin number draw the selected SM's OUT /
SIDESET / IN extents (SPEC-7-26/21), so a base/count stepper click
shows where the wiring moved with no program running. Counts of 0 draw
all 32 pins (the 0-encodes-32 storage); ranges wrap past GPIO31; the
SIDESET extent counts data bits only — the opt-enable bit is not a pin
(SPEC-4-2). `mockups/pin-strip.html` is the mock-up round that picked
the grammar; three candidates ran:

- **Three stacked lanes** (shipped): each kind owns a lane — OUT solid
  `--cfg`, SIDESET `--cfg-dim`, IN the new light `--cfg-lit` tint —
  2px tall, 1px apart, near-full cell width. Overlapping mappings stack
  (OUT∩SIDESET and OUT∩IN both show, each in its lane), nothing
  collides with the level digit or the owner corner, and the fixed
  geometry is exactly what the layout gate pins.
- One band, three fixed slots (position-coded dashes): 3px shorter, but
  position-only coding — the marks stop reading as extents and become
  tick marks to memorize.
- A hatched SIDESET lane: a 2px dither is noise at that height, not the
  era's crisp pixel columns (the ds-allocator pip hatch works because
  its pips are taller).

Live vs stale (the review's mid-run corner): a pad the owner's current
wiring still reaches reads as driven — amber ring, amber ▲; a pad whose
wiring moved away keeps its hardware truth (OE stays latched, the level
holds, the owner corner stays) but the ring and ▲ turn gray and the
tooltip narrates the hold: "the wiring has moved away (no longer
driven)". The driver classifies (`getState().stale`): OE ∧ a known
owner ∧ the owner's OUT ∪ SIDESET ∪ SET extents no longer cover the
pin. The same-clk conflict narration keeps its CC-7 wording verbatim.

Follow-up from the owner's live session (2026-08-30): the ▲/D/◆ marks
ride the level digit's line — a mark row of its own had no line box
when empty, so the first mark anywhere stretched every cell 16px and
the strip jumped under the latch click (the C26 hover/press rule,
applied to drive state). And the program column is content-anchored
(`clamp(364px, 24vw, 392px)`, the row editor's need — the old 32vw
track carried dead width the wave never saw; the window cap retuned to
1726px so the cap still lands the wave at its 896px natural scale).

## The lens lives on the wave (C28, 2026-08-30)

Owner-scheduled with C27/C29 from the gpio0-panel review (same round as
the pin-strip card above). The wave row owns its pin: the `gpio<N>`
label is a drawn lens-pin picker riding the row's spin grammar — one
Tab stop, −/+/←/→, wrapping 0..31 — so following a signal that moved
(a side-base remapped mid-run, the wave gone flat) retargets the wave
where the wave lives. The exec-title pin select moved down with it
(removed, not mirrored — one owner per fact); the mode select stayed
where the decoded readout is.

- **View state, not wiring.** The lens pin writes no register — the
  driver replays the decode over the stored history on the pin change
  (`setLens`). So the picker rides its own `[data-lens]` gesture beside
  the `controlEdit` table (which is per-SM overlay writes only), with
  the same shared `[data-spin]` keys clicking its buttons. The value
  keeps the label's own ink, not the mapping tags' cyan: the steppers
  carry the drawn affordance, the number stays the wave's identity.
- **One Tab stop per spinbox, honestly.** The ds/thr stepper buttons
  had missed `tabindex="-1"` (the maptags, join segments and wrap
  steppers kept it) — stray stops the C25 walk's tolerant `tabUntil`
  absorbed and the one-stop-per-pair waiver text never got to check.
  The C28 walk pins the picker as the wave row's *first* stop, which is
  what exposed them; the pairs are single stops again.

## The campaign's front door (C42–C43, 2026-09-06): the landing + the transition

The 2026-09-06 grilling over the IDEAS front-door doodle (the entry is
pruned by promotion; this section is its durable home, and C42's
mock-up round in mockups/landing.html extends it with rendered
decisions the way the C26/C27 rounds did theirs).

The landing is its own page — `web/index.html` sharing sm-view.css, a
classic-script dependency-free static list with **no engine boot** (no
worker, no wasm; the C34 own-geometry precedent — a page is its own
geometry, not an absence-table hack hiding an entire app to draw a
menu). The face is the era master window wearing a CUA listbox:
chapter group frames (titles become registry data in levels.js —
"First light / Time and loops / Reading the world" live only in
LEVELS-NOTES prose today), one row per level (number, name, status),
and the sandbox as a standing row ("everything always" — the
contrast-is-the-motivator line, advertised harder as chapters
complete). Keyboard is the listing-as-listbox grammar verbatim (C25:
arrows walk, Enter opens).

Grilling decisions, on the record:

- **Dim but named.** Every registered level row is visible and named;
  rows past the frontier dim (`--dimmer`, the era's visible-not-hidden).
  The C34 absence doctrine is a level-page doctrine — a campaign map
  naming its future is content. Chapters with no shipped levels stay
  off the map entirely (the registry is the source; LEVELS-NOTES prose
  does not ship ahead of its own grilling).
- **Three states, no in-progress cell.** ✓ solved (par shown on
  solved rows only — the expertise-reversal rule projected onto the
  map), ▸ the frontier, dim ahead. Unlocks numeric but soft:
  `?level=` always deep-links (the ?row=31 spirit); the map links
  solved + frontier rows only. Campaign state derives from the
  existing per-level keys — furthest = max contiguous solved; no new
  storage shape on the landing card.
- **The solved listing is the one new storage datum.** lvSession grows
  the solved listing at pass; a solved reload boots YOUR program
  (today it re-boots the level's boot listing), and the map shows your
  words·clk beside par with par-matched / par-beaten badges (the badge
  compares the judge's measured axis values — a clk/bit level compares
  clk/bit, C41's named-clock rule).
- **Chapter-complete is an era caption mark.** A ✓ in the chapter
  group-frame's caption — pure C25/C26 chrome, no new glyph grammar
  (the C38 monitor glyphs stay the monitor's).
- **The transition is one affordance, not a system.** On pass, beside
  the chip and par, a NEXT pushbutton joins the band — a plain
  location hop (no SPA routing), no auto-advance (the payoff frame
  holds until the player acts — C40's freeze lesson generalized; from
  the campaign's last registered solved level it hops to the map).
  The doodle's Alt+N is taken (`n` = binsn); the letter lands at
  implementation under C33's unique-letters rule. Exit-to-map is a
  toolbar button (Alt+M, free) — today the URL bar is the only way
  out. Effects: none; the C26 decision stands.
- **The door ships clean — zero lore.** Era furniture only, no
  sinister content, no fictional names. The bible session (the IDEAS
  lore thread's doctrine) gets its first deadline at chapter 3's
  grilling; whatever it permits lands later under its own cap (at most
  a masthead and one "civilian").
- **The campaign is the front door at the URL.** serve.py serves
  web/index.html at `/` (redirect or direct serve — implementation
  pick), its docstring repointed; README gains a try-it line;
  sm-view.html keeps its URL unchanged for tool users.

Two cards, C42 → C43 (the landing is shippable alone — its rows link
to `?level=`). Both sanctioned DOM-glue gates grow landing legs (a
keyboard-walk leg and a layout-gate leg), each shown red against the
pre-card page first.

Rendered decisions (the mock-up round, mockups/landing.html — the
C26/C27 precedent; the mock-up loads the shipped era stylesheet and
hand-picks a mid-campaign state):

- **The window hugs its map.** A menu window, not the 1726px app:
  `height:auto` capped at the viewport, max-width 640, centered on the
  teal — the first cut's fixed 560px window drew a dead silver slab
  under the last row. No toolbar: the window carries titlebar, map,
  footer only (a toolless toolbar would be era furniture lying about
  commands). The titlebar caption counts what shipped — `· 3 chapters
  · 9 levels` derived from the registry, riding the `.tail` hide.
- **The map is ONE listbox; chapters are groups in it** (ARIA
  listbox→group→option, the listing's own shape): one Tab stop for the
  whole map, the cursor walks every row including the dim ones. The
  row grid is `44px 1fr auto` — mono level number (the addr column's
  color), sans name, right-aligned status; rows are 21px and never
  wrap.
- **The status faces ride the band's own grammar**: solved = green
  `✓ par W words · P clk/…` (the named-clock rule, so L6 reads
  clk/bit); frontier = bold amber `▸`; ahead = the whole row dimmed
  (`--dimmer`) with an empty status cell — dim-but-named means the
  name stays legible, only the row's power drops. Linked rows
  (solved, frontier, sandbox) underline the name on hover; Enter
  opens. The cursor is the C25 listing grammar verbatim: teal tint +
  the 2px amber bar, ↑/↓ clamp-walk, aria-activedescendant, and the
  cursor boots on the frontier row (Enter at first focus opens the
  next level).
- **The sandbox is a standing row, not a chapter**: after the last
  frame, a rule above, `—` for a number, bold name, and a status that
  advertises harder as the campaign advances (`6 levels cleared`) —
  "everything always" is the row's own name, not a frame's caption.

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

The listing *is* the source (the canonical disassembly is 1-1 with the
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
profiles as the visible spec; score metric (the hyperoptimizer's
Pareto front);
`.side_set` slider should re-run, not just re-decode, once assembly
exists.

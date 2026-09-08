# DESIGN

Design decisions and architecture for `ring/` — the WS2812-inspired
bidirectional daisy-chain protocol, the topology DSL that defines the
rig, the packet-level simulator that checks it, and the test PCB it
all feeds.

Provenance: the 2026-09-08 doodle session, captured. Nothing here is
grilled work — the leans are the leans as doodled, and §Open decisions
is the agenda for the first grilling. Cards live in `KANBAN.md` once
promoted; futures and riffs live in `IDEAS.md`. Toolchain discipline
follows the parent repo (`docs/python-tooling.md`): uv + ruff + ty +
pytest, doctests in every module, red/green TDD, runtime stdlib-only.

## The goal

Owner, 2026-09-08: sensors and user interfaces in a box, with minimal
wiring — small bus-powered modules daisy-chained on one cable, each
contributing its slot. A sensor speaks through the growing read; a UI
obeys through the shrinking write. The deployment context is a shared
ground inside one enclosure, so galvanic isolation is explicitly not
a goal (bus power + isolation means transformers — rejected); the
signal-integrity cluster in IDEAS stays bench experimentation, never
the product direction. The WS2812 promise, restated: one string of
wire through the box, every module taps it in order.

## What it is

A ring of Raspberry Pi Picos speaking a token-ring-flavored WS2812.
One self-clocked wire per hop, positional addressing — no node needs
an address — and full signal regeneration per hop, so the chain never
degrades and hops share no clock domain. The WS2812 chain's dangling
end is closed back into the master, and packets are given a *shape*:
a write shrinks as each node consumes its slot, a read grows as each
node appends one.

```
WRITE (shrinks):  M → [HDR][s1][s2][s3] → n1 → [HDR][s2][s3] → n2 → [HDR][s3] → n3 → [HDR] → M
READ  (grows):    M → [HDR] → n1 → [HDR][s1] → n2 → [HDR][s1][s2] → n3 → [HDR][s1][s2][s3] → M
```

One direction of physical travel, both directions of conversation:
every packet passes every node exactly once, so the master's receive
leg doubles as the completion signal.

Borrowed from WS2812, deliberately:

- single data wire per hop — no clock wire, no chip select, no
  address pins;
- positional addressing by order in the chain;
- per-hop decode/re-encode — unlike an SPI daisy chain, which needs
  a distributed SCLK and dies on chain-length skew;
- idle-gap packet delimiter, long gap = reset/abort (self-healing).

Added for bidirectionality: the return leg (ring closure at the
master), command framing, grow-on-read / shrink-on-write, per-slot
CRC.

## Relation to vibe-pio

`ring/` is a side track of the PIO engine model, and its long arc
bends back there: the same topology file that generates the PCB
netlist can wire a Verilog testbench instantiating the parent repo's
PIO RTL once per node, running the real RX/TX SM programs against the
model before board bring-up — identical firmware, sim first, silicon
second. The parent's IDEAS.md already carries the hardware-in-the-
loop capture rig as a long-term entry; this board is that rig's
natural shape. Near-term the subproject stands alone: protocol, DSL,
sim, board.

## The protocol

Topology: `master.DOUT → n1.DIN`, `n1.DOUT → n2.DIN`, …,
`nN.DOUT → master.DIN`. Every hop is point-to-point with exactly one
driver, so there are no collisions by construction and no bus
arbitration anywhere.

Transaction mechanics:

- **Write = consume-from-front** (the WS2812 rule, generalized). Each
  node strips the first slot after the header, applies it, forwards
  the remainder. The bare header arriving back at the master — SEQ
  token matching the request — is the completion signal.
- **Read = append-at-tail.** The header carries a slot count; a node
  forwards that many slots, appends its own, bumps the count.
  Append-at-tail is the cut-through-friendly variant; inserting
  behind the header would force buffering the whole remainder.
- **The ring measures itself.** A NULL read (nodes append empty
  slots) returns exactly N slots ⇒ chain length for free; no response
  before a master timeout ⇒ the ring is broken.
- **Blame-localizing integrity.** Per-slot CRC16 rather than one
  packet CRC: slot *i* arriving corrupt points at hop *i*, which on a
  test rig is exactly the diagnostic wanted. The master checks
  end-to-end by construction — it sees every slot.

Header sketch (fixed slot size S bytes, lean S = 8):

```
SOP | CMD | SEQ | SLOT_COUNT | slot × n
```

Packet end = idle gap on the wire; a long gap = reset/abort, nodes
drop partial packet state — the WS2812 reset latch, reused.

Latency: v1 is store-and-forward — total transaction time ≈ Σ over
hops of (bytes at that hop ÷ rate), i.e. quadratic in N for both the
shrinking write and the growing read. At 1–2 Mbps, 8-byte slots and
4–6 Picos this is nothing. Cut-through (constant per-hop delay, the
actual WS2812 trick) is the stretch goal — see IDEAS.

## Power, wake, and events

Owner-raised 2026-09-08 (captured; mechanics open to the grilling):

- **Wake grammar.** Traffic opens with a preamble tone long enough
  for a deep-sleeping node to wake and arm its RX — the budget is
  set by XOSC/PLL restart, order 1 ms (to be measured; IDEAS). Nodes
  sleep with RX-edge GPIO wake; the tone doubles as baseline
  re-centering for any AC-coupled bench link. Two preamble classes:
  a short sync while the chain is light-sleeping (PIO armed, core in
  WFI), and a long wake burst after the master has issued an
  explicit SLEEP command — deterministic beats adaptive.
- **Commit — the vsync equivalent.** The WS2812 master stroke is the
  reset latch: spatially serialized data, temporally simultaneous
  commit. Our counterpart: write slots *stage*, and an explicit
  COMMIT token applies them chain-wide. Skew is one hop's forward
  latency per node (tens of µs store-and-forward) — fine for UIs,
  honest about not being simultaneous; cut-through shrinks it. The
  idle gap stays reserved as reset/abort, never the commit: with
  attention traffic on the line, quiet no longer means "frame done".
- **Attention — interrupts from mid-chain.** The single-driver ring
  makes spontaneous origination electrically safe: every hop wire
  has exactly one driver, so any node may start transmitting. An
  ATTN packet's wake tone wakes the downstream sleepers by the same
  grammar that wakes them for the master — the grammar is
  symmetric. At the originator, the new frame queues behind whatever
  it is forwarding; frames serialize per hop, no collision by
  construction. ATTN packets grow like reads — each node with a
  pending event appends its slot, so coalescing is free — and the
  master's read sweep stays the reconciler. Alternative on the
  table: a 4th conductor as an open-drain IRQ bus (GND, 5 V, DATA,
  IRQ — fits the JST-SH 4-pin exactly): immediate master wake, one
  more wire, another shared-bus failure mode. Decision 9.

## Wire level

Wire-code axes (captured 2026-09-08): **run length** — the longest
stretch without a transition, which serves clock recovery — and
**running digital sum**, which serves anything with a capacitor,
transformer, or threshold in the path, are different properties; bit
stuffing fixes only the first. The WS2812 code is unbalanced in a
specific way: in-frame duty is data-dependent (32% for a 0, 64% for
a 1) and idle is parked low — the >50 µs reset latch is a deliberate
DC crater.

Options on the table (decision 1): WS2812-style pulse-width
(unbalanced, transition-rich), async bytes/NRZ (neither bounded;
needs a local baud clock), and **biphase mark** — S/PDIF's code — as
the DC-neutral WS2812: a transition at every bit boundary, a `1`
adds a mid-bit transition, and the RX classifies intervals exactly
the way WS2812 classifies pulse widths (T/2 = 1, T = 0), just on
both edges. Every `1` is balanced by construction, `0`s balance
pairwise, the running sum is bounded by ~one bit time, worst-case
toggle rate is 2× — free at µs bit periods. A balanced code also
idles in a legal 50%-duty tone instead of parked silence, and its
running average is always mid-eye, so a simple RC integrator gives
the receiver an auto-threshold that absorbs the inter-tile ground
offsets of a bus-powered chain.

Bit period ~1 µs lean either way. PIO does both directions
beautifully (RX is the pulse-width-measure pattern, the both-edges
variant for biphase). Per-hop rates may differ slightly — nothing is
end-to-end clocked. A series R at each driver is the whole
signal-integrity story for in-box cables. No differential PHY in v1.
Prior art and the cap-sizing arithmetic live in IDEAS.

## The test PCB

A row of Picos plus master; the per-hop furniture is where the
decisions live:

- **Series 33 Ω at each driver**; a test-point pair on every data
  net.
- **Bypass per node** (0 Ω jumper in v1): a dead node must not kill
  the ring, and an *unpowered* Pico actively clamps its input through
  the ESD diode to its dead 3V3 rail — so each node's DIN sits behind
  its own series R and the bypass shorts across the whole node,
  keeping the clamped input from loading the line.
- **Power:** one 5 V input; each Pico regulates locally via VSYS;
  common ground pour.
- **Flashing:** µUSB per Pico at the board edge, BOOTSEL — clunky,
  boring, reliable.
- 2-layer, 1 master + 4 nodes lean, fits a cheap ~100×80 mm board —
  the monolithic read; decision 7 leans the copy-paste tile instead,
  which shrinks this section to one tile's worth of furniture.

## The DSL — one topology file, three consumers

The DSL is not "a SKiDL alternative"; it is the single source of
truth for topology + hop attributes, consumed by the netlist
generator *and* the simulator (and later the RTL testbench):

```python
ring = Ring(name="ring4", slot=8, encoding="ws2812@1M", crc="crc16-per-slot")
ring.master("M0")
for i in range(1, 5):
    ring.node(f"P{i}", series_r=33, bypass="jumper")

ring.to_skidl()   # → KiCad netlist; place/route graphically in pcbnew
ring.to_sim()     # → same topology drives the packet-level simulator
```

- **No schematic, ever.** SKiDL already emits KiCad netlists that
  pcbnew imports directly; we ride its footprint/pin libraries rather
  than reimplementing them. `skidl` is a host-only dev dependency;
  the topology model and the simulator stay stdlib-only with
  doctests, so container-side flows keep working.
- **The simulator** is discrete-event at packet/byte granularity:
  node models implementing the shrink/grow rules, nets with fault
  injection (stuck-at, bit flip, overlong gap), and checks that *are*
  the protocol invariants — a read returns N slots in device order; a
  write's header returns having passed every node; a broken ring
  times out. Cheap to build, and it is what makes board bring-up
  boring.
- **The RTL tie-in (long arc):** as under §Relation to vibe-pio —
  the same topology, one pio core per node, the real SM programs.

## Non-goals (initial)

- No schematic capture — the netlist is generated; layout is manual
  and graphical in KiCad, not auto-routed.
- Not a general-purpose netlist framework — scoped to this rig and
  its sim.
- No differential PHY, no cut-through, no variable-length slots in
  v1 (parked in IDEAS / §Open decisions).

## Open decisions (first-grilling agenda)

1. **Encoding**: WS2812-style pulse-width vs async UART bytes vs NRZ
   (IDEAS) vs biphase mark (DC-neutral; see §Wire level). The doodle
   lean was pulse-width; the DC-neutral analysis (2026-09-08) argues
   biphase mark inherits every pulse-width virtue — same
   short-vs-long classifier — while adding balance, an idle tone,
   and auto-threshold receivers. Lean contested; the grilling's
   call.
2. **Slot size**: fixed 8 bytes vs length-prefixed — lean fixed.
3. **ACK bits in the returning header** (needs a per-node index: soft
   index from SOPs-counted-since-reset, or an explicit ENUM command)
   — lean defer; v1 infers delivery from the header return alone.
4. **Bypass**: 0 Ω jumpers vs powered FET bypass — lean jumpers now.
5. **v1 forwarding**: store-and-forward through RAM vs PIO
   cut-through — lean store-and-forward; cut-through is the later PIO
   party trick.
6. **Node count on board 1** — lean 1 master + 4 nodes: enough for
   multi-hop ordering bugs to show, small enough to route by hand.
7. **Form factor** — lean tiles (owner, 2026-09-08): the small module
   copied many times is the product — sensor/UI nodes deployed in
   boxes. The tile rationale as raised: the inter-tile cable is where
   experiments live when wanted (coil, twisted pair — plug-in, not
   footprint gymnastics); N is soft (add tiles, the NULL read already
   measures it); physical reordering equals readdressing, since
   addressing is positional. Architecturally the topology moves out
   of copper and into the cabling, which the DSL mirrors:
   `to_skidl()` emits one tile, and the ring lives in the same
   topology file the simulator reads. Cost: per-hop connectors become
   the reliability item — inside a box that is a feature (unplug a
   module to service it), not a bug. Open sub-question: master as a
   different board or just firmware on the head tile (IDEAS).
8. **Power** — lean bus-powered (owner, 2026-09-08): the chain cable
   carries GND + 5 V + signal, and galvanic isolation is explicitly
   out (bus + isolation means transformers — rejected with the goal).
   The two-diode coin-OR can still ride the tile as a bench
   convenience (bus 5 V into VBUS rides the module's own diode; coin
   via Schottky into VSYS) or be dropped for BOM simplicity — the
   grilling picks; the coin stays a demo, never the deployment plan.
9. **Interrupt transport** — in-band ATTN packets (wake grammar,
   zero extra conductors, latency = wake tone + round trip) vs an
   open-drain IRQ bus conductor (immediate master wake, one more
   wire, another shared-bus failure mode) vs both, IRQ for v1 with
   in-band as the firmware-only upgrade. No lean recorded.

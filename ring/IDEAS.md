# IDEAS

Loose, undiscussed ideas for `ring/`. Anything here is **not** agreed
work. Items are promoted to `KANBAN.md` only after a grilling session.
Append freely; prune ruthlessly when promoted or rejected — same
discipline as the parent repo's IDEAS.md.

- PIO cut-through forwarding — the party trick: forward bits as they
  decode, constant per-hop delay, the actual WS2812 trick, and a
  genuinely hard/fun PIO program. Store-and-forward ships first.
- ACK bits in the returning write header — each node sets its bit as
  the header passes. Needs a per-node index: soft index (count SOPs
  since reset — fragile after a glitch) or an explicit ENUM command
  that assigns positions by traffic order.
- Firmware SDK: C SDK vs MicroPython. Store-and-forward at packet
  granularity is Python-friendly (PIO asm from Python); cut-through
  almost certainly isn't.
- Powered FET bypass per node for headless rigs — route around an
  unpowered node without a human fitting a jumper.
- Differential / balanced hops for a board-to-board cable variant:
  RS-485 or LVDS with a proper PHY, or the PHY-less poor-man's version
  — two GPIOs driven complementarily into a twisted pair, receiver
  comparing the pair. DC balance starts to matter here (long runs of
  one polarity walk a capacitive or isolated link), which is also the
  NRZ question below. Balance also keeps phantom power on the pair
  available (the PoE / audio-phantom trick) — impossible without a
  DC-neutral code.
- Node self-description slot: a read whose slots carry type/version/
  uptime — the "who's out there" transaction, and the natural first
  thing for the sim and the board to disagree about.
- Protocol invariants as formal properties once the sim stabilizes —
  the sim's checks re-expressed for a model checker over the node
  models.
- Variable-length slots (length-prefixed) if fixed 8 B ever chafes.
- Blinkenlights: TX/RX activity LEDs per hop — a ring rig demos well.
- Flashing story beyond per-Pico USB: multi-drop SWD? BOOTSEL tricks?
  Boring may win, but record alternatives before layout — the choice
  changes the edge connector count.
- Half-duplex single wire with direction negotiation — explored in
  the doodle and set aside: messy next to a ring that already gives
  both directions with no arbitration. Resurrect only if the return
  leg ever costs a real pin budget.
- NRZ line code as a third encoding option (DESIGN open decision 1
  currently reads pulse-width vs async bytes): framed NRZ is what the
  async-byte option already is; edge-timed "pure" NRZ needs run-length
  discipline within a packet — and per-hop regeneration means the
  discipline is per hop, not end-to-end. Grill together with decision
  1, not after it.
- Tunable impedance on the board: series-R footprints that accept a
  value spread (or jumper-composed parallel legs) so a hop's source
  impedance can be swept without soldering-iron surgery; same trick
  for receiver-side termination footprints. Grill before the PCB card
  exists — it changes placement (series near the driver, termination
  near the receiver).
- Coil-of-wire tap: break one hop's data line through a 2-pin
  terminal (header or SMA) so a loop of hookup wire can be spliced in
  as the "cable" — inductance, reflections, crosstalk and EMI
  susceptibility become rig-measurable. Per-hop regeneration means
  one ugly hop degrades only itself, and the per-slot CRC blame is
  the instrument that names it.
- Tandem receive oversampling: two PIOs sampling the same line, a
  couple of clocks displaced, votes combined for better integrity. On
  one Pico both PIO blocks share sysclk, so the displacement is
  instruction-scheduling (two SMs sampling on adjacent cycles) — time
  diversity inside the bit; across two Picos with separate crystals
  it is true asynchronous phase diversity. Open question: where the
  vote lives (firmware merging two ISRs vs a voter SM/CPU consuming
  both). Pairs with the impedance/coil experiments as the "how ugly
  can the line get before the CRC blames the hop" measurement.
- Serial coupling caps on the lab hop (the coil tap's hop): AC-couple
  through series caps with receiver bias/restore resistors, a 0 Ω
  jumper reinstating the plain direct hop. Two honest caveats: caps
  are DC isolation only — ground-loop and baseline-wander experiments,
  not galvanic safety (that is the transformer's job below) — and the
  DC-balance question becomes load-bearing: idle-low pulse-width is
  DC-heavy by construction, so a cap-coupled hop wants a balanced
  variant of the code or a bounded run length (the NRZ/balanced-pair
  braid). And note the pour: on one PCB the grounds still meet at the
  pour unless the lab hop's return travels through the tap too — a
  2-wire lab hop makes the isolation experiment real, and that is
  already the balanced-pair variant.
- Signal transformers per hop for real galvanic isolation — owner's
  lean at doodle time: probably too costly for this rig's price
  range. Cheap candidates to weigh before accepting that lean:
  surplus Ethernet magnetics cans, 600:600 audio transformers, or the
  near-zero DIY variant — two windings of the coil tap's hookup wire
  on a shared ferrite ring, which makes the transformer a coil-tap
  experiment instead of a BOM line. Carries the caps' DC-balance
  requirement squared (no DC through the link at all) and really
  wants the balanced drive. Demoted 2026-09-08 when the goal firmed
  up: bus power won and isolation was explicitly rejected — bench
  experiment at best now.
- Coin-cell power realism (CR2032 into a tile's VSYS): the Pico's
  on-board buck-boost holds logic at 3.3 V across the cell's whole
  discharge, so the wire levels never sag — but the cell itself
  does: comfortable continuous drain is ~0.2–1 mA, and an always-on
  ring node wants several. Plausible only clocked down (tens of MHz,
  single core; µs-scale bit periods do not need 125 MHz, and the line
  rate can slow too). BOOTSEL flashing is unaffected — the bootrom
  sets its own 48 MHz. ~220 mAh means a demo, not a deployment.
- Bus power down the chain: 3–4 conductors per hop cable (GND, 5 V,
  signal), each tile passing power through — IR drop accumulates
  toward the far end, but at these currents that is millivolts of
  nothing. Grounds the ring: fine for flash-in-place and full clock,
  but while the bus is attached the isolation experiments are
  decorative (decision 8's interaction).
- Tile connector menu: 2× pin headers (cheapest, no latch), JST-SH
  4-pin (small, latching, qwiic-adjacent pinout to repurpose), or
  RJ11/RJ45 (latching, 4–8 conductors — and an RJ45 magjack tile
  turns the transformer experiment into a cable-change instead of a
  footprint). The pick decides how good the cable-as-lab story gets.
- Node personalities: the tile as core + payload — one ring core
  (Pico, PHY, connectors, power tap) with a payload area per variant:
  sensor tiles (temperature, pressure, light, current…), UI tiles
  (encoder + button + OLED, LED bar, buzzer). The core is what gets
  copy-pasted; the DSL names the personality so sim, netlist and box
  build share one vocabulary.
- Slot content conventions: a sensor's read slot reports its datum
  with a fixed per-personality layout (value, flags, maybe a
  sequence); a UI's write slot commands it (brightness, LED bitmap,
  display line). String-bearing displays would make variable-length
  slots stop being academic.
- Poll cadence and UI latency: encoder feel wants a poll cycle of a
  few ms; store-and-forward is quadratic in N, but at 1–2 Mbps a
  handful of nodes should sit comfortably under that — the sim's job
  to quantify before the box trusts it.
- Master as firmware, not a board: identical tiles, the head node
  running the master role with its USB as the box's console; the
  ring closes on the same cable. One SKU; the DSL marks the role.
- Box power budget: the head tile's USB (500 mA class) vs a 5 V
  barrel input — a few Picos at ~20 mA each plus sensors and LEDs
  fits USB for a small box; grows with the blinkenlights.
- DC-neutral prior art and arithmetic: AES3/S/PDIF is the existence
  proof — biphase code, cheap 1:1 transformer, self-clocking,
  regenerated per hop; 8b/10b is the industrial heavyweight nobody
  needs at µs bit periods. The cap-sizing why: a coupling network
  must have τ ≫ the longest unbalanced run — WS2812's parked idle
  (seconds between polls) forces τ into the tens of seconds
  (electrolytics, GΩ biasing), while biphase bounds the imbalance to
  ~one bit time, so 100 nF + 10 kΩ (τ = 1 ms) sits three orders of
  magnitude clear.
- Wake-latency budget (sets the preamble length): measure RP2040
  sleep-mode wake (GPIO IRQ fires with clocks off; PLL restart
  dominates) vs dormant (XOSC restart) on the actual tile; preamble
  = worst case + margin. Decide the per-node sleep ladder too —
  light sleep (PIO armed, core WFI) for poll cadence, deep sleep
  only after an explicit master SLEEP command, so the needed preamble
  class is always deterministic.
- ATTN mechanics detail: at the originating node the spontaneous
  frame queues behind the frame it is forwarding — store-and-forward
  serializes, and order shuffles at the originator (its own ATTN
  jumps ahead of the transit frame). Attention is not order-critical;
  the read sweep reconciles. Coalescing ATTN grows like a read: each
  pending node appends its event slot on the way past.

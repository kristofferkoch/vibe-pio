# PIO cycle contract

**Cycle-accurate semantics reference for the vibe-pio RTL and formal
assertions.** Companion to `docs/pio-spec.md` (the functional spec); this
document pins *which `clk` cycle* every effect lands in, under the
`sm_tick` strobe modeling decision of DESIGN.md ("RTL conventions").

Citation keys (same as `docs/pio-spec.md`):

- **DS §x.y** — RP2350 datasheet, Chapter 11 (`docs/pio-spec-datasheet.md`).
- **RDS §x.y** — RP2040 datasheet, Chapter 3 (`docs/xcheck-rp2040.md`).
- **pioasm** — pioasm sources (`docs/pio-spec-pioasm.md`).
- **sdk** — pico-sdk headers/driver (`docs/xcheck-picosdk.md`).
- **examples** — pico-examples (`docs/xcheck-picoexamples.md`).
- **SPEC §n** — `docs/pio-spec.md` §n.

Every statement below carries one of:

- **[SOURCED]** — directly stated by a cited source; only the phrasing is
  ours.
- **[INTERPRETATION]** — the sources leave the cycle placement
  underdetermined; we choose a semantics. Rejected alternatives are given.
- **[MODEL]** — a vibe-pio modeling convention forced by DESIGN.md (strobe
  divider, synchronous reset, registered memories), with no silicon
  counterpart claim. These are binding on the RTL all the same.

Formal assertions and RTL comments cite clauses as **CC-n** (index in
§10). Where a clause refines a spec §14 open question, that is noted.

---

## 1. Time model and the tick

**CC-1 [MODEL] (time base).** There is one clock, `clk` (the sysclk
domain), and one synchronous active-high `rst` (DESIGN.md). "Cycle"
unqualified means one `clk` cycle, numbered so that an event "at the end of
cycle T" means "registered by the `clk` edge separating cycle T from
T+1". An SM's state changes only at `clk` edges, and only in cycles where
that SM's `sm_tick` strobe is high (or, for forced instructions, the
force-tick of CC-34).

**CC-2 [MODEL] (tick cycle and SM cycle).** Each SM has a one-`clk`-wide
strobe `sm_tick`. The clk cycle in which `sm_tick` is high is the tick
cycle T. One instruction executes per tick; "SM cycle" (the datasheet's
"cycle", DS §11.2.2) is the interval from one tick to the next. With
divisor 1, tick cycles are consecutive clk cycles and SM cycles coincide
with clk cycles.

**CC-3 [MODEL] (effect landing).** All architectural effects of the
instruction executing in tick cycle T — pin/output-enable register writes,
ISR shift-in, OSR shift, shift counters, X/Y, FIFO data and level
counters, IRQ flags, PC, delay-counter load — are registered at the end of
cycle T and are observable to the pads, the system bus, and other SMs from
cycle T+1 onwards. Combinational reads *inside* cycle T (instruction
decode, source reads, FIFO emptiness tests, IRQ flag tests) see the state
as of the start of T.

*Rejected alternative:* driving pins combinationally during T. It would
make pad values a function of decode logic mid-cycle, add glitch surface
for formal proofs, and does not match the datasheet's picture of PIO
keeping 32-bit output-level/output-enable *registers* (DS §11.5.6). The
only silicon-visible commitment we make is at SM-cycle granularity
(§2); the sub-SM-cycle placement is a modeling choice.

---

## 2. Within-cycle ordering

Ordering is stated for tick cycle T of SM *s*. Because all effects land at
one edge (CC-3), "order" means (a) the read-sample point, and (b) write
priority among simultaneously landing effects.

**CC-4 [SOURCED] (read-before-write).** The executing instruction reads
all sources (OSR/ISR contents and counters, X, Y, FIFO head data and
levels, IRQ flags, synchronised input pins, JMP-pin, STATUS) as of the
start of T; nothing it writes this cycle is visible to its own reads this
cycle. (This is implied by DS §11.5.4.2's pseudocode, which tests
`osr count >= threshold` "at the start of the cycle", and by the
same-cycle-fill-and-OUT prohibition, DS §11.5.4.2 / RDS §3.5.4.2.)
Consequence: an OUT never consumes data pulled on the same tick (CC-12),
an IN never sees its own autopush, and a WAIT never observes an IRQ flag
set in the same clk cycle (CC-37).

**CC-5 [SOURCED] (side-set lands in the first SM cycle of the
instruction).** Side-set is applied in the tick cycle that begins the
instruction's execution — including when the instruction then stalls — and
is *not* re-applied or withdrawn on subsequent stall or delay ticks; the
output register holds the written value until some later write
(SPEC §4; DS §11.5.1 NOTE, §11.2.5 NOTE; confirmed for FIFO stalls by
examples §3.1.3: ws2812, spi_cpha0, uart_tx). Under CC-2/CC-3: the
side-set write registers at the end of the instruction's first tick cycle
and persists through stall and delay ticks. With `OUT_STICKY=1` the most
recent OUT/SET pin write is re-asserted on every clk cycle, including
stall and delay cycles, and applies to forced SET writes too (DS §11.7
EXECCTRL.OUT_STICKY; sdk N5).

**CC-6 [SOURCED] (side-set beats OUT/SET within an SM).** If side-set and
OUT/SET of the same SM write the same pin in the same tick cycle,
side-set wins on the overlapping pins, separately for level and direction
writes (SPEC §4; DS §11.5.6.1).

**CC-7 [SOURCED] (highest SM number wins across SMs).** If SMs of one
block write the same pin in the same clk cycle, the write from the
highest-numbered SM wins, per pin, separately for level and direction;
with no writer, the previous value holds (SPEC §10; DS §11.2.6,
§11.5.6.1).

**CC-8 [SOURCED+MODEL] (OUT/SET pin write cycle).** OUT PINS/PINDIRS and
SET PINS/PINDIRS/X/Y write in the tick cycle that executes them; the pad
value reflects the write from the following clk cycle (CC-3). At SM-cycle
granularity this is "the write is visible during the SM cycle after the
executing SM cycle's start", matching one-instruction-per-cycle examples
(squarewave_fast, examples §2 #29, one toggle per SM cycle).
*[MODEL]* portion: the exact clk offset (pads change one clk after the
tick) is our registration choice, not a silicon claim.

**CC-9 [SOURCED] (ISR shift-in lands in the executing tick).** IN shifts
its source bits into ISR and advances the ISR shift counter in the
executing tick cycle T; the shifted ISR and counter are visible from T+1
(SPEC §3.3; DS §11.4.4). An autopush triggered by that IN (CC-13) pushes
the **post-shift** ISR: autopush fires "on IN reaching
threshold", i.e. the value pushed is the ISR after this IN's shift, in the
same cycle (DS §11.4.4.2 "simultaneously pushes ISR to RX FIFO"); ISR and
counter are cleared at the same edge.

**CC-10 [SOURCED] (PC advance and delay load).** If the instruction
completes in tick T (not stalled), PC is updated per SPEC §8 (JMP target /
WRAP / +1 with wrap at 31→0) and the delay counter is loaded with the
instruction's delay field, both at the end of T. The next d ticks (if
d > 0) are delay ticks: no instruction executes, no pin/FIFO/IRQ effects
occur, and the delay counter decrements at each of those ticks' end. The
next instruction executes on the tick after the last delay tick, i.e.
d+1 ticks after T. Delay applies to JMP whether taken or not (SPEC §3.1;
DS §11.4.2), and delay cycles begin only after a stall clears (SPEC §4;
DS §11.4.3.2, §11.2.5). Wrap is free: it costs no tick beyond the normal
PC update (SPEC §8; DS §11.5.2; squarewave_wrap example).

---

## 3. Autopull / autopull stall boundary (spec §14.4)

Adopts the DS §11.5.4.2 pseudocode rule (dual-generation confirmed,
RDS §3.5.4.2 verbatim; xcheck-rp2040 §4). Resolves spec §14.4.

Let, at the start of an OUT tick T: `c` = OSR shift counter, `thr` =
PULL_THRESH (0 encodes 32), `txlevel` = TX FIFO level.

**CC-11 [SOURCED] (OUT-cycle rule).** With autopull enabled:

- If `c >= thr` at the *start* of T: the SM attempts a refill. If
  `txlevel > 0`, OSR is loaded from the TX FIFO head, the OSR counter is
  cleared, the FIFO pops, and the OUT **stalls in tick T** — no shift-out
  occurs in T; the OUT re-executes on the next tick with the fresh OSR.
  If `txlevel == 0`, the SM stalls with no refill; sticky
  `FDEBUG.TXSTALL` is set (DS §11.2.5, §11.5.4.2; sdk FDEBUG TXSTALL
  description).
- Else (`c < thr` at the start of T): the OUT shifts its bitcount bits
  out in T and `c += bitcount` (saturating at 32). If now `c >= thr` and
  `txlevel > 0`, the refill happens *simultaneously* with this last
  shift-out: OSR is loaded and the counter cleared at the end of T, and
  the next OUT (on a later tick) uses the fresh data. If `txlevel == 0`,
  no stall occurs; the refill is deferred to a later non-OUT tick
  (CC-12).

**CC-12 [SOURCED] (no same-cycle fill-and-OUT — the long-path note).** An
OSR emptied (or threshold-reached) by an OUT cannot be refilled *and*
shifted-out-again in the same cycle: "it cannot fill an empty OSR and
'OUT' it on the same cycle, due to the long logic path this would create"
(DS §11.5.4.2; RDS §3.5.4.2 verbatim). Formally: the OSR value read by an
OUT in tick T is the value registered at the end of some tick ≤ T−1. On
non-OUT ticks with autopull enabled and `c >= thr` and `txlevel > 0`, the
refill happens on that tick (it can occur at any time between two OUTs —
DS §11.5.4; SPEC §5). OUT is a data fence: it never outputs data that has
not completed its TX FIFO write (DS §11.5.4.2).

**CC-13 [SOURCED] (autopush/IN mirror).** The mirror-image rule for IN
with autopush: let `c` = ISR counter, `thr` = PUSH_THRESH at the start of
an IN tick T. The IN always shifts (IN never stalls *before* shifting);
if `c + bitcount >= thr` and the RX FIFO is not full, the post-shift ISR
is pushed to the RX FIFO in the same cycle, ISR and counter cleared
(both at end of T); if the RX FIFO is full, the IN **stalls** in T (no
shift, no push; the instruction re-executes next tick) and
`FDEBUG.RXSTALL` is sticky-set (DS §11.4.4.2, §11.2.5, §11.5.4.1; sdk
FDEBUG RXSTALL). Note the asymmetry with OUT, which is exactly the
pseudocode's: OUT stalls when the counter is *already* at threshold at
cycle start; IN stalls only when the *resulting* push cannot land.
MOV into ISR never triggers autopush, and MOV into OSR never triggers
autopull — the auto logic is evaluated only on IN/OUT ticks (SPEC §3.6;
examples §3.1.6).

---

## 4. Stall inventory

For every stalling situation: the SM holds PC, re-executes the
instruction on every tick until it completes; the delay counter is not
loaded and does not elapse during the stall; side-set already fired in
the first tick (CC-5) and persists; **the clock divider keeps running**
(`sm_tick` continues every divided cycle — the stall is evaluated per
tick, not per clk cycle; the datasheet's "the instruction re-executes the
next cycle" means the next SM cycle, DS §11.2.5) [SOURCED for all three
"keeps/does not keep" claims: DS §11.2.5; RDS §3.2.4].

**CC-14 [SOURCED] (stall invariant).** While SM s is stalled on
instruction I: PC holds; delay counter holds (0 if not yet loaded);
X/Y/ISR/OSR/counters hold except as explicitly stated below; `sm_tick`
keeps arriving; on each tick the stall condition is re-evaluated against
start-of-tick state (CC-4). If the condition reads true at tick T, I
completes at T: its effects and the delay load land at end of T (CC-10),
so the next instruction executes d+1 ticks after T, where d is I's delay
field. Resume latency is therefore: **the first tick on which the
condition holds is the completion tick** — zero extra ticks of latency.

**CC-15 [SOURCED] (WAIT gpio/pin/jmppin).** Condition = selected GPIO
synchroniser output (CC-22) == polarity, at start of tick. No state
changes during the stall. WAIT 1 IRQ additionally clears the flag in the
completing tick (DS §11.4.3.2).

**CC-16 [SOURCED] (WAIT irq / IRQ wait).** `irq wait` sets the flag in
its first tick (flag visible from the next cycle, CC-37) and then stalls
until the flag reads 0 at start of tick; delay begins after (SPEC §3.8;
DS §11.4.11). `irq clear` never stalls (Clr suppresses Wait).

**CC-17 [SOURCED] (OUT, empty OSR, no autopull).** OUT with the OSR
counter ≥ 32 (i.e. `!osre` false) and autopull disabled does **not**
stall: it shifts zeroes (the OSR "fills with zeroes as it empties",
DS §11.2.3). With autopull enabled, CC-11/CC-12 apply. (TXSTALL is set
only for blocking PULL or autopull-OUT stalls — sdk FDEBUG.)

**CC-18 [SOURCED] (IN, full ISR, no autopush).** IN never stalls on the
shifter itself; without autopush there is no FIFO interaction and IN
always completes in one tick (counter saturates at 32). With autopush,
CC-13 applies.

**CC-19 [SOURCED] (PUSH block, RX FIFO full).** Stalls on each tick
whose start-of-tick RX level == depth (4, or 8 when joined); completes on
the first tick with room, pushing the ISR value as of that tick (ISR
cannot change while the SM is stalled, so the value is stable). No
side-set re-fire; PC holds. Sticky RXSTALL is a *nonblocking*-PUSH
indicator only, not set by the blocking stall (sdk FDEBUG).

**CC-20 [SOURCED] (PULL block, TX FIFO empty).** Stalls on each tick
whose start-of-tick TX level == 0; completes on the first tick with
`txlevel > 0`, popping the head into OSR, OSR counter ← 0 (SPEC §3.5;
RDS §3.5.4.2 `if MOV or PULL: osr count = 0`). TXEMPTY visibility timing
to the system writer is CC-30.

**CC-21 [SOURCED] (MOV put/get).** MOV rxfifo[idx], isr (PUT) and
mov osr, rxfifo[idx] (GET) never stall: PUT overwrites the selected
storage register unconditionally (no fullness concept), GET reads
whatever the register holds (SPEC §3.7; DS §11.4.8/§11.4.9). They are
single-tick instructions with ordinary delay.

**CC-22 [SOURCED] (stalled delay/side-set interaction).** During every
stall of every kind above: side-set value persists on the pins (CC-5),
delay does not elapse (CC-10/CC-14), the divider advances (CC-1, CC-25).
This is the ws2812/spi_cpha0/uart_tx conformance target (examples §3.1.3).

---

## 5. Input path

**CC-23 [SOURCED] (2-FF synchroniser latency).** Each GPIO passes through
a 2-flip-flop synchroniser: a pad value present during clk cycle k is
captured by sync-FF1 at the end of k, by sync-FF2 at the end of k+1, and
is the value seen by SM input logic (IN PINS, WAIT gpio/pin/jmppin,
MOV x,pins, JMP PIN) from cycle k+2 onwards (DS §11.5.6.3 "two cycles of
latency"). With `INPUT_SYNC_BYPASS[i]=1` the pad value of cycle k is seen
from k+1 (one-cycle latency) at the user's risk.

**CC-24 [SOURCED] (IN sampling point).** An IN PINS (or WAIT/MOV/JMP-PIN
read) executing in tick cycle T samples the synchroniser outputs as of
the start of T, i.e. the pad state of cycle T−2 (T−1 with bypass). The
clocked_input example's "data is actually sampled one system clock cycle
after the rising edge" (examples §3.1.12) reconciles as follows: the WAIT
on the input clock pin completes on the first tick whose start-of-tick
sync output shows the edge (pad edge at clk cycle e ⇒ completable tick
cycles are ≥ e+2); the following IN tick T' ≥ (completion tick)+1 samples
pad state of T'−2. With the example's clkdiv and clk_input < clk_sys/6,
the data bit is guaranteed stable across that window — the <sys/6 bound
is the example's margin figure, not a PIO hardware limit. Conformance
test only; no contract clause beyond CC-23/CC-24.

**CC-25 [SOURCED] (divider guarantee to the input path).** Consecutive
`sm_tick` strobes of one SM are at least `INT` clk cycles apart (the
delta-sigma fractional divider alternates periods of `INT` and `INT+1`
clk cycles; DS §11.5.5). Therefore for any divisor with `INT ≥ 3`, the
pad state sampled by consecutive IN instructions (T−2 in one tick,
T'−2 ≥ T+INT−2 in the next) spans at least INT−1 ≥ 2 stable pad cycles
after synchroniser settle; divisor 1–2 with an unsynchronised fast
external input is exactly the case INPUT_SYNC_BYPASS exists for and
carries no stability guarantee (spi examples bypass on MISO — examples
§2 #24). *[INTERPRETATION]* the "at least INT apart" phrasing as a
*contract* (we will assert it): the datasheet gives the frequency
formula, not a min-gap clause, but the 16.8 delta-sigma structure
(RDS §3.5.5, identical text) admits only INT and INT+1 periods, so the
guarantee follows. Rejected: reading only the average frequency —
useless for cycle-level assertion.

---

## 6. Clock divider under the sm_tick-strobe model

**CC-26 [MODEL+SOURCED] (strobe placement).** Per SM: an 8-bit phase
accumulator `phase`, a one-bit stretch flag `stretch`, and a counter
`count`. While the SM is enabled, `count += 1` every clk cycle; the
current period's terminal compare is `INT + stretch` (with `INT=0`
interpreted as 65536, requiring FRAC=0 — and `stretch` forced
ineffective there, since FRAC=0 admits no fractional stretch). When
`count` reaches `INT + stretch`, the divider resets `count` to 0,
updates the delta-sigma state (`phase += FRAC`; `stretch ← carry of
phase`), and asserts `sm_tick` **for the following clk cycle** — i.e.
terminal count reached at the end of cycle T ⇒ tick cycle T+1 ⇒
instruction effects at end of T+1. Divisor 1 (INT=1, FRAC=0):
`sm_tick` every clk cycle. The INT/FRAC/65536/INT=0⇒FRAC=0 facts are
[SOURCED] (DS §11.5.5, §11.7 CLKDIV; sdk #14); the terminal-count-
then-tick cycle placement and the per-period (not per-clk)
accumulator-update order are [MODEL] — the datasheet specifies only the
resulting average frequency. *Rejected alternative:* asserting
`sm_tick` in the terminal-count cycle itself; it saves no logic and
makes CC-1's "state changes on tick cycles" phrasing awkward for
divisor 1. *Rejected alternative (v1 of this clause):* a per-clk
`phase += FRAC; count += 1 + carry` — it yields an average period of
INT/(1+FRAC/256), i.e. FRAC *speeds the SM up* and periods below INT,
contradicting both the sourced average SM clock = clk/(INT + FRAC/256)
and CC-25's min-gap; the fractional error must accumulate once per
*period* (periods ∈ {INT, INT+1}) for the delta-sigma to be exact.
Either tick placement is internally consistent; ours is binding on the
RTL.

**CC-27 [SOURCED] (CLKDIV_RESTART).** Writing `CTRL.CLKDIV_RESTART` for
SM s resets s's divider phase to 0 (`phase ← 0`, `count ← 0`); the SM's
next tick occurs the canonical period later. Free-running otherwise.
Simultaneous restarts of SMs with equal divisors put them in lockstep
(identical `sm_tick` cycles thereafter) — this is the documented
mechanism, extended cross-PIO by `NEXTPREV_CLKDIV_RESTART`
(DS §11.7 CTRL; DS §11.1.1; squarewave_div_sync example). *[MODEL]* a
restart while an instruction is mid-stall does not disturb the stall:
the divider restarts, the next tick re-evaluates the stall condition.

**CC-28 [MODEL] (divider independence).** The four SMs' dividers are
independent free-running accumulators; absent a common CLKDIV_RESTART
(and equal divisors), no phase relationship is guaranteed or asserted.
Cross-PIO synchronised operation additionally requires equal divisors
and simultaneous restart (DS §11.1.1) — [SOURCED]; the RTL models
PREV/NEXT restart as applying in the same clk cycle as the local one
[MODEL].

---

## 7. FIFO push/pull timing

**CC-29 [SOURCED+MODEL] (push capture / pull presentation).** A PUSH
executing in tick T writes the ISR value (as of start of T — unchanged by
the PUSH) into RX FIFO storage and increments the RX level counter at the
end of T; the word is readable by the system and visible in
FSTAT/FLEVEL from cycle T+1. A PULL executing in tick T presents the TX
FIFO head (as of start of T) into OSR, clears the OSR counter, pops and
decrements the TX level at the end of T; FLEVEL reflects the pop from
T+1. DREQ pacing (1 word/clk) is out of scope for the engine model
(SPEC §6). *[MODEL]* the one-clk-later bus visibility is the CC-3
registration rule applied to the FIFO level counters.

**CC-30 [SOURCED+MODEL] (emptiness visibility).** A stalled blocking PULL
(CC-20) tests TX emptiness against the start-of-tick level. A system
write to TXFx retiring at the end of clk cycle e therefore releases a
stalled PULL on the SM's first tick in a cycle ≥ e+1. *[MODEL]* the
e/e+1 boundary is our registration choice (the datasheet says only
"stalls while the TX FIFO is empty", DS §11.4.7.1); the invariant we
assert is the OUT data fence of CC-12 — data written at end of e can
never appear on pins via an OUT completing before e+1's tick chain
allows.

**CC-31 [SOURCED] (the spi `pull ifempty` + `jmp !osre` interleaving —
spec §15 item).** The spi_*_cs tail is:

```
loop: out pins, 1 side 0x0 [1]     ; T0   shift + delay
      in  pins, 1 side 0x1 [1]     ; ...
      jmp x--        side 0x1
      mov x, y       side 0x0
      jmp !osre      side 0x1      ; Tc: exits loop when OSR empty
      nop            side 0x0 [1]
      pull ifempty   side 0x2 [1]  ; Tp: refill only if OSR empty
```

`jmp !osre` tests the OSR counter at start of Tc. Between Tc and Tp no
other agent can change that counter (autopull is disabled in this
program; only this SM's own OUT/MOV/PULL move it), so the check at Tc and
the `ifempty` guard at Tp see the same state — **safe, no race window at
all** in this configuration: if the loop exited via `x--` with OSR still
non-empty, `pull ifempty` at Tp reads counter < thr and is a no-op,
preserving the remaining bits. The *racy* variant the comment guards
against: with autopull enabled, an autopull refill could land on a
non-OUT tick between Tc and Tp; a plain blocking `pull` would then
either stall needlessly or, per the autopull-PULL fence rule (SPEC §3.5
NOTE: with autopull, PULL is a no-op while the OSR is full), behave
unexpectedly. With `ifempty`, the PULL consumes a word **iff the OSR
counter ≥ thr at the start of its own tick Tp** — the guard is evaluated
at Tp, not inherited from Tc. Pinning (this is the §14.4 boundary applied
to PULL): *IfEmpty/IfFull conditions are evaluated against start-of-tick
counter state at the PULL/PUSH's own tick*, exactly like every other
read (CC-4) [INTERPRETATION only insofar as the datasheet never says
"start of cycle" for IfE/IfF — but CC-4's pseudocode precedent makes this
the only consistent reading; rejected: inheriting the condition from an
earlier instruction's observation].

**CC-32 [SOURCED] (nonblocking variants complete in one tick).**
`push noblock` on a full RX: no FIFO write, level unchanged, ISR cleared,
counter cleared, RXSTALL sticky-set — all at end of the executing tick;
no stall. `pull noblock` on an empty TX: OSR ← X, OSR counter ← 0
(RDS §3.5.4.2 `if MOV or PULL: osr count = 0`; SPEC §14.7), no stall,
no FIFO change (SPEC §3.5; examples §3.1.5 quadrature validates the
clear-every-iteration behaviour).

---

## 8. Instruction fetch visibility and EXEC'd / forced instructions

**CC-33 [INTERPRETATION] (program-memory write visibility — spec §15
item).** Instruction memory is a 1-write/4-read register file of 32
registers (DS §11.2.8). Semantics chosen: an INSTR_MEM write retiring at
the end of clk cycle e is observed by every instruction fetch in any tick
cycle ≥ e+1; a fetch in cycle ≤ e observes the old word. There is no
prefetch pipeline, no invalidation, and no coherency qualification: the
"fetch" is the read of the word at the PC performed during the tick
cycle itself (the SM has no architectural instruction register beyond
the EXEC latch of CC-34). A running SM therefore executes a patched word
on its *next* fetch of that address, exactly what hub75_data_rgb888's
self-modifying bit-plane patching relies on (examples §3.1.8). Rejected
alternatives: (a) write-through same-cycle visibility — would require a
bypass path and has no supporting source; (b) an N-cycle delay (N>1) —
would model a prefetch stage the register-file description rules out
(4-read ports serve all SMs "without stalling", DS §11.2.2).

**CC-34 [SOURCED+MODEL] (OUT EXEC / MOV EXEC cycle).** An `out exec, n`
executing in tick T: the OUT's own shift and PC update happen normally
at end of T, the OUT's delay field is **ignored**, and the shifted-out
16-bit word is latched into the SM's instruction latch at end of T. The
executee executes on the SM's **next tick** T' (= T+1 at divisor 1),
whatever T' is, with its own delay honoured; the executee's tick does
not advance PC (unless the executee is itself a JMP/MOV PC/OUT PC);
after the executee completes, execution resumes at the PC stored after
T. Only one OUT per cycle; the latch is shared with forced SMx_INSTR
writes, which overwrite a pending executee (DS §11.4.5, §11.2.2,
§11.5.7; SPEC §3.4, §11). *[MODEL]* the "next tick" is pinned to the
SM's next `sm_tick` (not next clk cycle) when the divider is > 1 — the
datasheet's "next cycle" is an SM cycle (DS §11.2.2 "one instruction per
cycle"). Rejected: next clk cycle — would bypass the divider, which only
SMx_INSTR writes do.

**CC-35 [SOURCED+MODEL] (forced instruction via SMx_INSTR).** A system
write to SMx_INSTR retiring at end of clk cycle e executes **immediately
in cycle e+1, bypassing the clock divider** (implemented as a one-cycle
force-tick that acts exactly like an `sm_tick` for the SM's state
logic): delay field ignored, PC not advanced unless the instruction
changes it (JMP/OUT PC/MOV PC). If the forced instruction stalls (e.g. a
WAIT), it is latched and re-executes on subsequent force-ticks —
modelling `EXEC_STALLED` — until it completes; a subsequent SMx_INSTR
write replaces the latched instruction (DS §11.7 SMx_INSTR, §11.5.7;
sdk #33; manchester_rx / logic_analyser arming idioms, examples §3.1.9).
Register writes (PINCTRL/EXECCTRL) take effect for the forced
instruction as currently programmed (sdk N5). *[MODEL]* the e+1 placement
and the force-tick mechanism; the datasheet says only "immediately".

**CC-36 [MODEL] (forced instruction vs divider interaction).** A
force-tick does not disturb the divider phase: `sm_tick` keeps its
free-running schedule; an `sm_tick` coinciding with a force-tick is
deferred to the next clk cycle (the forced instruction wins; the SM
executes at most one instruction per clk cycle). No source addresses
this collision; the choice keeps "one instruction per clk cycle" and
CC-26's phase continuity invariant.

---

## 9. IRQ flags

**CC-37 [INTERPRETATION] (set/clear cycle; same-cycle sibling
observation).** An IRQ instruction (or `irq wait`'s set, or WAIT 1 IRQ's
completing clear, or IRQ_FORCE / bus W1C) executing/retiring in cycle c
updates the flag register at the end of c; the new value is readable by
SMs and the bus from cycle c+1. A WAIT irq in SM b therefore **never**
observes a flag set by a sibling SM's IRQ in the same clk cycle:
same-cycle relay is rejected. Justification: DS §11.1.1's "an IRQ on one
SM is observable to all SMs the next cycle" with "no delay penalty" for
*cross*-PIO routing — i.e. next-cycle is the universal visibility rule
and cross-PIO adds nothing; and CC-3/CC-4 forbid combinational
SM-to-SM paths in our model. This is the clause that makes the nec
carrier WAIT 1 IRQ handshake (examples #15/#16) a clean two-tick
exchange: SM A `irq 7` in cycle c ⇒ SM B's `wait 1 irq 7` completes on
its first tick ≥ c+1, clearing the flag ⇒ A's `irq wait` (if used)
completes on its first tick ≥ clear+1. Rejected: same-cycle relay
within a block (would require a combinational bypass contradicted by
the "next cycle" text and by our registered-flag formal model).

**CC-38 [SOURCED] (cross-PIO flags).** PREV/NEXT-indexed flags of
neighbouring PIO blocks follow the identical next-cycle rule, modelled
as one extra register stage on the inter-block path — with equal
divisors and simultaneous restarts the one-cycle skew is exactly
absorbed between lockstep SMs (DS §11.1.1; SPEC §3.8).

**CC-39 [SOURCED] (flag writers and stickiness).** Writers to a flag:
any SM's IRQ instruction (set/clear), WAIT 1 IRQ's completing clear,
bus `IRQ` W1C, `IRQ_FORCE` set. No supersession/priority: last write in
a cycle wins; simultaneous writers in one clk cycle are resolved by
treating set and clear as a read-modify-write per bit at the same edge —
a set and a clear of the *same* flag in one cycle is [INTERPRETATION]:
resolved as clear-wins (matching the W1C register idiom); rejected
set-wins (no source; clear-wins is safer for `irq wait` release
protocols). Flags are not auto-cleared except by WAIT 1 IRQ.

---

## 10. Closed-loop SM→pin→SM timing

**CC-40 [SOURCED+MODEL] (closed-loop observation bound — spec §15
conformance angle).** Composing CC-3/CC-8 with CC-23: a pin level written
by SM A's instruction executing in tick cycle T (side-set, OUT/SET PINS)
registers at the end of T, is present on the pad during clk cycle T+1,
and is therefore first observable to *another* SM's input logic (WAIT
gpio/pin/jmppin completion, JMP PIN, IN PINS capture) on that SM's first
tick in a clk cycle ≥ T+3 — T+2 for a bypassed pin (CC-23). Each leg is
[SOURCED]; the composed bound is [MODEL] only in that we name it as one
clause. This is the contract the closed-loop conformance checks exercise
end-to-end (SM→pad→SM at clkdiv 1): the manchester_encoding loopback
(CF12) decodes the example's own three words exactly at 12 ticks per bit
with the receiver re-locking on every mid-bit transition through 29
wrap fall-throughs; differential_manchester (CF15) at 16 ticks per bit
locks on start-of-bit edges and samples the 3/4-bit eye; uart_rx (CF16)
locks on the start-bit edge and samples each bit centre. All three stay
green only if the output registration (CC-3/CC-8), the 2-FF sync
(CC-23), and the free wrap (CC-10 / SPEC-8-2) hold *together* — the
former "manchester rx tick divergence" was a testbench wrap-constant
defect, not an RTL one (see the CF12 body in
`sim/tb_conf_pioexamples.sv`), and is the red/green regression for this
clause.

---

## 11. Clause index

| Clause | One-line statement | Status |
|---|---|---|
| CC-1 | Single clk, synchronous rst; SM state changes only on sm_tick / force-tick edges | MODEL |
| CC-2 | Tick cycle T definition; SM cycle = inter-tick interval; divisor 1 ⇒ SM cycle == clk cycle | MODEL |
| CC-3 | All instruction effects register at end of T; visible from T+1 | MODEL |
| CC-4 | Reads sample start-of-tick state; no same-cycle self-readback | SOURCED |
| CC-5 | Side-set lands in the instruction's first tick, persists through stall/delay; OUT_STICKY re-asserts | SOURCED |
| CC-6 | Side-set beats OUT/SET on overlapping pins (same SM) | SOURCED |
| CC-7 | Highest-numbered SM wins cross-SM pin conflicts | SOURCED |
| CC-8 | OUT/SET pin writes land in the executing tick (clk-granular offset is a model choice) | SOURCED+MODEL |
| CC-9 | IN shift + counter land in the executing tick; autopush pushes the post-shift ISR | SOURCED |
| CC-10 | PC update + delay load at end of completing tick; next instruction d+1 ticks later; wrap free | SOURCED |
| CC-11 | OUT/autopull: stall-refill if counter ≥ thr at tick start, else shift (+ simultaneous refill) | SOURCED (§14.4) |
| CC-12 | No same-cycle fill-and-OUT (long-path note); OUT is a data fence; refill may occur on any non-OUT tick | SOURCED (§14.4) |
| CC-13 | IN/autopush: always shifts; stalls iff resulting push hits a full RX; MOV never triggers auto ops | SOURCED |
| CC-14 | Stall invariant: PC/delay hold, divider runs, resume on first condition-true tick, then d+1 to next instruction | SOURCED |
| CC-15 | WAIT gpio/pin/jmppin samples synchronised pin at start of tick; WAIT 1 IRQ clears on completion | SOURCED |
| CC-16 | IRQ wait: flag set in first tick (visible next cycle), stalls until flag reads 0 | SOURCED |
| CC-17 | OUT with exhausted OSR and no autopull shifts zeroes, never stalls | SOURCED |
| CC-18 | IN never stalls without autopush (counter saturates) | SOURCED |
| CC-19 | PUSH block stalls on start-of-tick RX-full; pushes ISR value at completion | SOURCED |
| CC-20 | PULL block stalls on start-of-tick TX-empty; pops head, OSR counter ← 0 | SOURCED |
| CC-21 | MOV put/get never stall; single tick | SOURCED |
| CC-22 | During all stalls: side-set persists, delay frozen, divider advancing | SOURCED |
| CC-23 | 2-FF sync: pad@k visible to SM logic from k+2 (k+1 bypassed) | SOURCED |
| CC-24 | IN/WAIT/MOV/JMP-PIN sample sync outputs at start of tick; clocked_input numbers reconciled | SOURCED |
| CC-25 | Divider min-gap = INT clk cycles; INT ≥ 3 gives synced-input stability; bypass exists for INT ≤ 2 | SOURCED+INTERP |
| CC-26 | Divider counts clks against INT(+stretch); phase += FRAC once per period (delta-sigma, periods INT or INT+1); sm_tick the cycle after terminal count; INT=0 ⇒ 65536 | MODEL+SOURCED |
| CC-27 | CLKDIV_RESTART resets phase/count to 0; equal divisors + simultaneous restart ⇒ lockstep | SOURCED+MODEL |
| CC-28 | Dividers independent across SMs absent restart; cross-PIO needs equal divisors | SOURCED+MODEL |
| CC-29 | PUSH captures ISR / PULL presents TXF head in the executing tick; levels update end of T | SOURCED+MODEL |
| CC-30 | FIFO write retiring at end of e releases a stalled PULL from ticks ≥ e+1; fence invariant | SOURCED+MODEL |
| CC-31 | IfEmpty/IfFull evaluated at the PULL/PUSH's own tick start; spi `pull ifempty`+`jmp !osre` safe because no inter-tick writer exists; guard not inherited | SOURCED+INTERP (§14.4/§15) |
| CC-32 | Nonblocking PUSH/PULL complete in one tick with documented side effects | SOURCED |
| CC-33 | INSTR_MEM write visible to fetches from next clk cycle; no prefetch/invalidation | INTERPRETATION (§15) |
| CC-34 | OUT/MOV EXEC: executee latched at end of T, runs on the SM's next tick; PC not advanced by it | SOURCED+MODEL |
| CC-35 | SMx_INSTR write executes in the following clk cycle, bypassing the divider; may latch-stall; overwrites EXEC latch | SOURCED+MODEL |
| CC-36 | Force-tick colliding with sm_tick: forced instruction wins, sm_tick deferred, phase preserved | MODEL |
| CC-37 | IRQ flags set/clear at end of executing cycle; visible next cycle; no same-cycle sibling relay | INTERPRETATION |
| CC-38 | Cross-PIO flags: same next-cycle rule, one extra register stage | SOURCED |
| CC-39 | Flag writers; simultaneous set+clear of one flag ⇒ clear wins | SOURCED+INTERP |
| CC-40 | Closed loop: SM A's tick-T pin write first observable to SM B's input logic on ticks ≥ T+3 (T+2 bypassed); CF12/CF15/CF16 loopbacks are the directed checks | SOURCED+MODEL |

Count: **40 clauses** — 25 SOURCED (or SOURCED-dominant), 3 INTERPRETATION
outright (CC-33, CC-37, and the CC-31 guard-evaluation pinning), 8 MODEL
or MODEL-dominant (CC-1, CC-2, CC-3, CC-26, CC-36; plus model components
of CC-8/CC-29/CC-30/CC-34/CC-35/CC-40), and hybrid clauses as marked.

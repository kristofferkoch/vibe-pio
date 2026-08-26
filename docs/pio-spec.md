# RP2350 PIO consolidated specification

**Authoritative reference for the vibe-pio RTL.** Consolidated from two
research inputs, both retained unchanged:

- `docs/pio-spec-datasheet.md` — extracted from the RP2350 datasheet PDF,
  Chapter 11 "PIO" (§11.1–§11.7). Cited below as **DS §x.y**.
- `docs/pio-spec-pioasm.md` — extracted from the pioasm assembler sources
  (`tools/pioasm/` in pico-sdk, local clone at `third_party/pioasm-sdk/`;
  provenance in `docs/spec-sources.md`). Cited below as **pioasm** with the
  source file/function.

Additionally cross-checked against three further sources (reports retained
unchanged under `docs/`, provenance in `docs/spec-sources.md`):

- `docs/xcheck-picosdk.md` — pico-sdk register headers + `hardware_pio`
  driver (cited as **sdk** with file). 35 confirmations, 4 corrections/
  extensions, 8 new facts.
- `docs/xcheck-rp2040.md` — RP2040 datasheet Chapter 3 (cited as **RDS
  §x.y**). Confirms shared content; adds one §12 difference and resolves
  several §14 open questions.
- `docs/xcheck-picoexamples.md` — pico-examples catalogue (cited as
  **examples**). 39 future conformance tests; observations summarised in §15.

Facts on which the sources agree are stated once with the joint citations.
Discrepancies and unresolved ambiguities are collected in §14 "Open
questions". Where a conflict was resolved by consulting the datasheet text
or the local pioasm clone, the resolution and method are stated there.

Bit numbering: bit 15 = MSB of the 16-bit instruction word; register bit
ranges are as in the datasheet.

## Fact ID scheme

Every load-bearing fact carries a stable ID of the form
`SPEC-<section>-<n>` — e.g. `SPEC-3.2-4` is the fourth fact in §3.2 —
assigned by a per-section counter, so IDs survive insertion of new facts in
other sections. Sub-sectioned chapters (§3, §14) use the sub-section number
in the ID (`SPEC-3.4-12`, `SPEC-14.4-1`). A new fact always takes the next
free number in its (sub-)section; IDs are never reused or renumbered.

Placement: IDs appear as inline tags `[SPEC-x.y-n]` at the start or end of
the fact's bullet, sentence, or clause. **Tables:** where each table row
states a distinct fact (encoding tables, condition/dst/src tables), each row
gets its own ID appended in the row's last cell; where a table's rows only
decompose a single fact stated in surrounding prose, the table inherits the
prose fact's ID and no per-row IDs are used. Every §15 observation and every
resolved §14 item is citeable.

The RTL counterpart for cycle-level timing clauses is
`docs/cycle-contract.md`, whose clauses are cited as `CC-<n>` (e.g. `CC-7`).

---

## 1. Block overview

- [SPEC-1-1] RP2350 contains **3 identical PIO blocks** (RP2040: 2) — 12 state machines
  total. Each block: 4 SMs, shared instruction memory, own IRQ flags, own
  GPIO window. (DS §11.1.1)
- [SPEC-1-2] **Instruction memory: 32 × 16-bit instructions per block**, shared by the
  4 SMs; 1-write (system, write-only via `INSTR_MEM0..31`) / 4-read register
  file so all SMs fetch without stalling. (DS §11.2.8, §11.2.2, §11.7;
  confirmed by pioasm `MAX_INSTRUCTIONS = 32`, `pio_types.h:270`.) See
  §14.1 for the 32-vs-36 question (resolved: 32).
- [SPEC-1-3] Each SM has (DS §11.1):
  - 32-bit shift registers ISR and OSR (either shift direction, any count);
  - 32-bit scratch registers X and Y;
  - 4×32-bit TX FIFO and 4×32-bit RX FIFO, joinable to 8 deep in one
    direction (DS §11.2.4.4);
  - fractional clock divider, 16.8 fixed point (§8 below).
- [SPEC-1-4] PIO maps to a 32-GPIO window; `GPIOBASE` (bit 4; values 0 or 16 only)
  relocates the window (RP2350 has 30 user GPIOs). (DS §11.1.1, §11.7)
- [SPEC-1-5] Execution model: fetch/decode/execute one instruction per SM clock tick;
  every instruction takes exactly one cycle **unless it stalls** (§9).
  (DS §11.2.2, §11.4.1)
- [SPEC-1-6] The datasheet calls this **nine instructions**: JMP, WAIT, IN, OUT, PUSH,
  PULL, MOV, IRQ, SET (DS §11.2.1); pioasm has 8 instruction *classes*
  (bits 15:13) because PUSH/PULL share class 0x4 with the two RP2350
  FIFO-aux MOV encodings (§4, §14.2).

## 2. Instruction word format

[SPEC-2-1] `inst = (type << 13) | ((delay|sideset) << 8) | (arg1 << 5) | (arg2 & 0x1f)`
(pioasm `instruction::encode`, `pio_assembler.cpp:261-296`; DS §11.4.1
Table 980).

| Bits  | Field |
|-------|-------|
| 15:13 | instruction class (JMP=000 … SET=111) [SPEC-2-2] |
| 12:8  | delay/side-set (§6) [SPEC-2-3] |
| 7:5   | arg1: condition / polarity+source / source / destination / modifier [SPEC-2-4] |
| 4:0   | arg2: address / bit count / immediate / IRQ index / FIFO-aux index [SPEC-2-5] |

[SPEC-2-6] Note (pioasm): the assembler internally keeps a 6th arg2 bit above the
16-bit word; the emitted word truncates to `arg2 & 0x1f`. For all
RP2040-compatible instructions arg2 is 5 bits; the FIFO-aux encodings pack
their index into the 5 bits (§4.5).

### Master encoding table (DS §11.4.1 Table 980; cross-checked pioasm)

| Instruction | b15:13 | b7:5 | b4:0 | pioasm encode |
|---|---|---|---|---|
| JMP    | 000 | cond[7:5] | addr[4:0] | `pio_assembler.cpp:358-368` [SPEC-2-7] |
| WAIT   | 001 | pol[7], src[6:5] | index[4:0] (IRQ: idxmode[4:3], idx[2:0]) | `:394-430` [SPEC-2-8] |
| IN     | 010 | src[7:5] | bitcount[4:0] (0 ⇒ 32) | `:370-384` [SPEC-2-9] |
| OUT    | 011 | dst[7:5] | bitcount[4:0] (0 ⇒ 32) | `:370-384` [SPEC-2-10] |
| PUSH   | 100 | 0, IfF[6], Blk[5] | 0[4:0] | `pio_types.h:430-454` [SPEC-2-11] |
| MOV put (RX FIFO aux) | 100 | 0,0,0 | 1[4], IdxI[3], 0[2], Index[1:0] | `:346-356` [SPEC-2-12] |
| PULL   | 100 | 1, IfE[6], Blk[5] | 0[4:0] | `pio_types.h:430-454` [SPEC-2-13] |
| MOV get (RX FIFO aux) | 100 | 1,0,0 | 1[4], IdxI[3], 0[2], Index[1:0] | `:346-356` [SPEC-2-14] |
| MOV    | 101 | dst[7:5] | op[4:3], src[2:0] | `:346-356` [SPEC-2-15] |
| IRQ    | 110 | 0[7], Clr[6], Wait[5] | idxmode[4:3], index[2:0] | `:432-437` [SPEC-2-16] |
| SET    | 111 | dst[7:5] | data[4:0] | `:386-392` [SPEC-2-17] |

[SPEC-2-18] **Bit count 32 encodes as 0** in IN/OUT arg2 — confirmed in both assembler
(`v & 0x1f`) and disassembler (`arg2 ? arg2 : 32`) (pioasm
`pio_disassembler.cpp:79,86`; DS §11.4.4/§11.4.5). RTL must decode 0 as 32.

## 3. Per-instruction semantics (incl. stall behaviour)

### 3.1 JMP — `000 | delay/ss | cond[7:5] | addr[4:0]`

[SPEC-3.1-1] Set PC to addr if condition true, else fall through (delay applies either
way). addr is absolute within the 32-word memory (DS §11.4.2); the SDK
relocates JMP targets when loading a program at an offset
(`pio.c:168`, sdk N1).

| cond | syntax | meaning |
|---|---|---|
| 000 | (always) | unconditional [SPEC-3.1-2] |
| 001 | `!x`   | X == 0 [SPEC-3.1-3] |
| 010 | `x--`  | X != 0 (pre-decrement test), X always decremented [SPEC-3.1-4] |
| 011 | `!y`   | Y == 0 [SPEC-3.1-5] |
| 100 | `y--`  | Y != 0, Y always decremented [SPEC-3.1-6] |
| 101 | `x != y` | X != Y [SPEC-3.1-7] |
| 110 | `pin`  | `EXECCTRL.JMP_PIN` pin high (independent of IN mapping) [SPEC-3.1-8] |
| 111 | `!osre` | OSR not empty (bits shifted out < `PULL_THRESH`) [SPEC-3.1-9] |

Sources agree (DS §11.4.2; pioasm `pio_types.h:60-69`,
`pio_disassembler.cpp:30-35`). [SPEC-3.1-10] `x--`/`y--` decrement on *every* execution of
the condition (taken or not? — see §14.5: datasheet says "always
decrement", pioasm notes tie it to condition evaluation; treat as:
decrement unconditionally, branch on pre-decrement value, per DS §11.4.2).
[SPEC-3.1-11] **Never stalls.**

### 3.2 WAIT — `001 | delay/ss | pol[7] | src[6:5] | index[4:0]`

[SPEC-3.2-1] Stall until condition met; delay cycles begin only after the wait completes
(DS §11.4.3.2, §11.2.5). pol=1 waits for 1, pol=0 waits for 0; bare
`wait <src>` defaults pol=1 (pioasm `parser.yy:263`).

| src | meaning | index |
|---|---|---|
| 00 | GPIO — absolute w.r.t. the SM's 32-pin **GPIOBASE window** (window base + index), NOT affected by IN mapping (sdk E1: `pio.c:add_program_at_offset` rewrites the WAIT index when GPIOBASE=16 — the datasheet's "absolute" means window-absolute, not chip-absolute) | 0–31 [SPEC-3.2-2] |
| 01 | PIN — (PINCTRL.IN_BASE + index) mod 32 | 0–31 [SPEC-3.2-3] |
| 10 | IRQ — flag per index decode below; if pol=1 flag is cleared by the SM when the wait completes | 0–7 + mode bits [SPEC-3.2-4] |
| 11 | JMPPIN (RP2350 new) — (EXECCTRL.JMP_PIN + index) mod 32 | 0–3 only; other encodings reserved (pioasm disassembler marks arg2[4:2] ≠ 0 reserved) [SPEC-3.2-5] |

[SPEC-3.2-6] **WAIT IRQ index decode:** the 5-bit index field's two MSBs (b4:3) are the
IdxMode, b2:0 the flag index — same rule as the IRQ instruction (DS
§11.4.3.2; see §14.3 for the datasheet's two slightly different split
descriptions, resolved to this rule). Modes: 00 this PIO, 01 PREV
(next-lower PIO, wrapping), 10 REL (add SM id mod 4 to the two LSBs), 11
NEXT (next-higher PIO, wrapping). [SPEC-3.2-7] pioasm encodes `rel` at bit 4 and
prev/next at bits [4:3]=01/11; `rel` combined with prev/next is rejected
(`parser.yy:272-273,302-303`). [SPEC-3.2-8] Datasheet caution: do not `WAIT 1 IRQ x` on
flags routed to the interrupt controller (race with the handler).

[SPEC-3.2-9] **Stall behaviour:** re-executes each cycle until satisfied; PC does not
advance; side-set fired once on the first cycle (§9).

### 3.3 IN — `010 | delay/ss | src[7:5] | bitcount[4:0]`

[SPEC-3.3-1] Shift bitcount (1–32, 0⇒32) bits of src into ISR in the direction given by
`SHIFTCTRL.IN_SHIFTDIR`; input shift counter += bitcount, saturating at 32
(DS §11.4.4).

| src | meaning |
|---|---|
| 000 PINS | IN-mapped pins (LSB = IN_BASE pin) [SPEC-3.3-2] |
| 001 X / 010 Y | scratch register [SPEC-3.3-3] |
| 011 NULL | zeros — **still shifts the ISR/counter** (datasheet fact; pioasm has no special handling — §14.6) [SPEC-3.3-4] |
| 100/101 | reserved [SPEC-3.3-5] |
| 110 ISR / 111 OSR | self/other shifter [SPEC-3.3-6] |

[SPEC-3.3-7] IN always uses the **LSBs** of the source data regardless of shift
direction (e.g. IN PINS always takes IN_BASE, IN_BASE+1, …; only the
end of ISR that data enters depends on IN_SHIFTDIR) (DS §11.4.4).

[SPEC-3.3-8] **IN ISR / IN OSR self/other-shifter notes** (examples §3.1.1–3.1.2):
shifting a register into itself **rotates** it — the bits shifted out one
end re-enter at the other end (`in isr, n` with right shift = right
rotation, per apa102_rgb555; direction follows IN_SHIFTDIR) and the ISR
shift counter still advances. Reading OSR as an IN source (`in osr, n`)
does **not** disturb the OSR shift counter — only the ISR counter advances
(examples advance OSR separately via `out null, n`). These rotate semantics
feed the cycle contract (§15).

[SPEC-3.3-9] **Autopush interaction:** if autopush enabled and input shift counter ≥
`PUSH_THRESH` (after adding bitcount), IN simultaneously pushes ISR to the
RX FIFO in the same cycle; ISR and counter cleared to 0. **Stalls** if RX
FIFO full (re-executes next cycle). (DS §11.4.4.2, §11.5.4)

### 3.4 OUT — `011 | delay/ss | dst[7:5] | bitcount[4:0]`

[SPEC-3.4-1] Shift bitcount (1–32, 0⇒32) bits out of OSR to dst; output shift counter +=
bitcount, saturating at 32. A 32-bit value is written to the destination:
the bitcount bits taken from the LSB end (right-shift) or MSB end
(left-shift) of OSR, remainder zero (DS §11.4.5).

| dst | meaning |
|---|---|
| 000 PINS | OUT pin mapping (OUT_BASE, OUT_COUNT pins, wrap after GPIO31) [SPEC-3.4-2] |
| 001 X / 010 Y | scratch [SPEC-3.4-3] |
| 011 NULL | discard (still shifts OSR/counter) [SPEC-3.4-4] |
| 100 PINDIRS | pin direction, OUT mapping [SPEC-3.4-5] |
| 101 PC | unconditional jump to shifted-out address [SPEC-3.4-6] |
| 110 ISR | writes ISR and sets ISR shift counter to bitcount [SPEC-3.4-7] |
| 111 EXEC | execute shifted-out word as an instruction (below) [SPEC-3.4-8] |

[SPEC-3.4-9] pioasm agrees on the table (`pio_types.h:72-83`); `out exec` = arg1 0x7
(`parser.yy:340`).

[SPEC-3.4-10] **OUT EXEC:** the OUT executes this cycle; the executee executes **next
cycle** via the SM's instruction latch; the delay field of the OUT itself is
ignored (executee may carry delay normally); any instruction type allowed;
only one OUT per cycle. OUT PC/MOV PC never stall beyond the OUT itself.
(DS §11.4.5, §11.2.2)

[SPEC-3.4-11] **Autopull interaction:** on an OUT cycle, if the OSR counter has already
reached `PULL_THRESH` at the start of the cycle, the SM refills OSR from TX
FIFO and **stalls this cycle** instead of shifting (also stalls if FIFO
empty); otherwise shifts out and, if the counter now reaches threshold,
refills simultaneously with the last shift-out (an OSR emptied by this OUT
cannot be refilled and re-OUTed in the same cycle). [SPEC-3.4-12] OUT is a data fence:
never outputs data not yet written to the FIFO. (DS §11.5.4.2 — see
§14.4 for the residual cycle-boundary ambiguity.)

### 3.5 PUSH / PULL — class 0x4, b7 distinguishes

- [SPEC-3.5-1] PUSH: `100 | delay/ss | 0 | IfF[6] | Blk[5] | 0[4:0]`
- [SPEC-3.5-2] PULL: `100 | delay/ss | 1 | IfE[6] | Blk[5] | 0[4:0]`

[SPEC-3.5-3] pioasm arg1 packing (`pio_types.h:430-454`): PUSH arg1 = Blk | (IfF<<1);
PULL arg1 = Blk | (IfE<<1) | 4 — matches DS bit positions (Blk=b5,
IfF/IfE=b6, direction=b7). pioasm defaults: Block=1, IfFull/IfEmpty=0.

[SPEC-3.5-4] **PUSH:** write ISR (32 bits) to RX FIFO, then clear ISR to zeros.
- [SPEC-3.5-5] IfFull=1: no-op unless input shift counter ≥ PUSH_THRESH.
- [SPEC-3.5-6] Block=1: **stall** while RX FIFO full.
- [SPEC-3.5-7] Block=0 with full FIFO: FIFO unchanged, ISR still cleared, sticky
  `FDEBUG.RXSTALL` set (data lost).
- [SPEC-3.5-8] **Undefined** when `FJOIN_RX_PUT` or `FJOIN_RX_GET` is set — use MOV
  put/get instead (DS §11.4.6.2 NOTE); pioasm enforces: PUSH rejected
  unless FIFO config is `rx`/`txrx` (`instr_push::pre_validate`,
  `pio_assembler.cpp:322-326`).

[SPEC-3.5-9] **PULL:** load 32-bit word from TX FIFO into OSR, output shift counter ← 0.
- [SPEC-3.5-10] IfEmpty=1: no-op unless output shift counter ≥ PULL_THRESH.
- [SPEC-3.5-11] Block=1: **stall** while TX FIFO empty.
- [SPEC-3.5-12] Block=0 with empty FIFO: behaves as `MOV OSR, X` (copies X to OSR; the
  OSR shift counter is cleared — confirmed by RDS §3.5.4.2 pseudocode
  `if MOV or PULL: osr count = 0`, §14.7).
- [SPEC-3.5-13] With autopull enabled, PULL is a no-op while the OSR is full (acts as a
  fence; `OUT NULL 32` explicitly discards OSR) (DS §11.4.7.2 NOTE).

### 3.6 MOV — `101 | delay/ss | dst[7:5] | op[4:3] | src[2:0]`

| val | dst | src |
|---|---|---|
| 0 | PINS (OUT mapping) | PINS (IN mapping, masked to `IN_COUNT` bits; bits above read 0, LSB = IN_BASE, wrap after 31) [SPEC-3.6-1] |
| 1 | X | X [SPEC-3.6-2] |
| 2 | Y | Y [SPEC-3.6-3] |
| 3 | PINDIRS (dst, RP2350 only; RP2040 reserved) | NULL (src) [SPEC-3.6-4] |
| 4 | EXEC | reserved (src) [SPEC-3.6-5] |
| 5 | PC | STATUS [SPEC-3.6-6] |
| 6 | ISR (resets ISR shift counter to 0) | ISR [SPEC-3.6-7] |
| 7 | OSR (resets OSR shift counter to 0) | OSR [SPEC-3.6-8] |

[SPEC-3.6-9] op: 00 none, 01 invert `~`, 02 bit-reverse `::` (bit n ← bit 31−n), 11
reserved (both sources agree; pioasm disassembler marks op 3 reserved).

- [SPEC-3.6-10] `nop` is the alias `mov y, y` — **not a distinct encoding** (pioasm
  `pio_types.h:480-482`).
- [SPEC-3.6-11] MOV PC = unconditional jump. MOV EXEC behaves like OUT EXEC: executee
  next cycle, MOV's own delay ignored, shared instruction latch.
- [SPEC-3.6-12] STATUS is all-ones/all-zeros per `EXECCTRL.STATUS_SEL` (bits 6:5):
  0 = TXLEVEL (TX FIFO level < N), 1 = RXLEVEL (RX FIFO level < N),
  2 = IRQ (indexed flag raised, RP2350); N = STATUS_N (bits 4:0);
  STATUS_N 0x08+n / 0x10+n select PREV/NEXT PIO flags (DS §11.7 Table 996;
  pioasm `.mov_status irq set N [prev/next]` encodes N_final = param*8 +
  irq, `pio_assembler.cpp:182-191`). For TXLEVEL/RXLEVEL, STATUS_N values
  greater than the current FIFO depth are **reserved/undefined** (sdk
  `regs/pio.h` STATUS_N field description — added to §13).
- [SPEC-3.6-13] MOV into OSR/ISR while autopull/autopush enabled: MOV into OSR is never
  overwritten by autopull (MOV updates the counter); other MOV-from/to-OSR
  under autopull is partially undefined (DMA race) (DS §11.5.4).
- [SPEC-3.6-14] **MOV into ISR never triggers autopush, and MOV into OSR never triggers
  autopull** — the auto-shift logic is evaluated only on IN/OUT instructions
  (examples §3.1.6: onewire `mov isr, pins` "avoids autopush";
  quadrature_encoder `mov isr,y` + `push noblock` relies on it). MOV never
  stalls (no FIFO interaction in the general class).

### 3.7 MOV put/get — RP2350 FIFO-aux encodings (class 0x4)

- [SPEC-3.7-1] PUT: `100 | delay/ss | 0 0 0 | 1[4] | IdxI[3] | 0[2] | Index[1:0]`
- [SPEC-3.7-2] GET: `100 | delay/ss | 1 0 0 | 1[4] | IdxI[3] | 0[2] | Index[1:0]`

Semantics (DS §11.4.8, §11.4.9):

- [SPEC-3.7-3] PUT writes ISR into the RX FIFO storage register selected by Index;
  GET reads the selected storage register into OSR (clearing the OSR shift
  counter, as any MOV-to-OSR).
- [SPEC-3.7-4] Index selection: IdxI=0 (pioasm encoding 0) → index taken from Y
  (bits [1:0]); IdxI=1 (pioasm `8 | idx`) → literal index 0–3. pioasm
  accepts literal 0–7 and masks `idx & 3` (`get_push_get_index`,
  `pio_assembler.cpp:310-320`); datasheet says non-zero index with IdxI=0
  (Y mode) is reserved/undefined.
- [SPEC-3.7-5] PUT requires `FJOIN_RX_PUT`, GET requires `FJOIN_RX_GET`; otherwise
  undefined. PUT mode: system reads the storage via `RXFx_PUTGET0..3`
  (status regs), SM writes. GET mode: system writes (control regs), SM
  reads. Both set: SM-only scratch, no system access. RX FIFO storage has
  one read and one write port, each owned by exactly one of (system, SM).
- [SPEC-3.7-6] Autopush must not be enabled with FJOIN_RX_PUT/GET (undefined) (DS
  §11.5.4.1 IMPORTANT; pioasm rejects autopush in txput/txget/putget
  configs, `pio_assembler.cpp:228-234`).
- [SPEC-3.7-7] pioasm validation: `mov rxfifo[idx], isr` only with src=ISR and config
  txput/putget; `mov osr, txfifo[idx]` only with dst=OSR and config
  txget/putget (`instr_mov::pre_validate`, `pio_assembler.cpp:328-344`).
  Disassembler: class 0x4 with arg2 bit 4 set is FIFO-aux; any other
  nonzero arg2 in class 0x4 is reserved (`pio_disassembler.cpp:89-118`) —
  see §14.2.

### 3.8 IRQ — `110 | delay/ss | 0[7] | Clr[6] | Wait[5] | idxmode[4:3] | index[2:0]`

[SPEC-3.8-1] Set (default) or clear (Clr=1) the flag selected by index. Clr=1 ⇒ Wait bit
has no effect, never stalls. [SPEC-3.8-2] Wait=1 (`irq N wait`): set the flag, then
**stall** until the flag is cleared again (by another SM or the system);
delay cycles only begin after the wait elapses. [SPEC-3.8-3] `irq N` (nowait, pioasm
modifier 0) never stalls. Modifier 3 (arg1 bit 2) reserved (pioasm
disassembler).

IdxMode (b4:3) — identical decode for the IRQ instruction's b4:3+b2:0 and
WAIT-IRQ's b4:3+b2:0 (§3.2):
- [SPEC-3.8-4] 00: 3-bit index into this PIO block's 8 flags.
- [SPEC-3.8-5] 01 PREV: flag of the next-lower-numbered PIO (wraps to highest).
- [SPEC-3.8-6] 10 REL: SM id (0–3) added to the flag index mod-4 on the two LSBs (bit 2
  unaffected) — lets 4 SMs share one program with distinct flags.
- [SPEC-3.8-7] 11 NEXT: flag of the next-higher-numbered PIO (wraps to PIO0).

[SPEC-3.8-8] Cross-PIO flags are visible to all SMs the next cycle, no delay penalty (DS
§11.1.1). [SPEC-3.8-9] Cross-PIO sync with divided clocks requires equal divisors and
simultaneous `CTRL.NEXTPREV_CLKDIV_RESTART`. [SPEC-3.8-10] pioasm syntax: `irq
set/nowait/wait/clear [prev|next|rel] N`; `rel`+`prev`/`next` rejected.

### 3.9 SET — `111 | delay/ss | dst[7:5] | data[4:0]`

[SPEC-3.9-1] Write 5-bit immediate. Dsts: 000 PINS, 001 X (data in 5 LSBs, rest zero),
010 Y (same), 100 PINDIRS; [SPEC-3.9-2] 011/101/110/111 reserved (both sources agree;
pioasm disassembler marks them reserved). [SPEC-3.9-3] SET pin mapping (SET_BASE) is
independent of OUT's. Never stalls.

## 4. Delay / side-set

[SPEC-4-1] Bits 12:8 of every instruction. Field = `delay | (sideset <<
(5 − sideset_bits_including_opt))` (pioasm `instruction::encode`); the top
`PINCTRL.SIDESET_COUNT` (0–5, **inclusive of the enable bit if present**)
MSBs are side-set, remaining LSBs are delay (DS §11.4.1, §11.5.1).

- [SPEC-4-2] `EXECCTRL.SIDE_EN` (bit 30): if 1, the MSB of the side-set field is a
  per-instruction **enable** bit — side-set occurs only when it is high;
  with enable=0 the entire 5-bit field is pure delay (pioasm: `opt`
  programs without `side N` force bit 4 to 0). Max data bits drop to 4.
- [SPEC-4-3] SIDESET_COUNT=5 ⇒ no delay bits; 0 ⇒ no side-set. Max side value
  2^N − 1; delay_max = 2^(5−bits_including_opt) − 1 (31 with no side-set).
- [SPEC-4-4] `EXECCTRL.SIDE_PINDIR` (bit 29): side-set writes pin **directions**
  instead of levels (pioasm `.side_set pindirs`).
- [SPEC-4-5] Side-set LSB maps to `PINCTRL.SIDESET_BASE`, higher bits to higher pins
  (wrap after GPIO31).
- [SPEC-4-6] **Side-set takes effect on the first cycle of the instruction even if it
  stalls** (DS §11.5.1 NOTE, §11.2.5 NOTE) — including FIFO-induced stalls,
  not only WAIT (examples §3.1.3: ws2812 "side-set still takes place when
  instruction stalls", spi_cpha0 stalls with SCK low, uart_tx holds the stop
  bit through a blocking PULL). Delay cycles are inserted
  **after** execution completes (for stalling instructions, after the stall
  clears) and before the next instruction.
- [SPEC-4-7] If side-set overlaps an OUT/SET by the same SM in the same cycle,
  **side-set wins** on the overlapping pins.
- [SPEC-4-8] pioasm: without `opt`, every instruction must specify `side`
  (`program::add_instruction`, `pio_assembler.cpp:46-50`).
- [SPEC-4-9] SIDESET_COUNT=0 ⇒ no side-set at all, regardless of SIDE_EN (RDS §3.5.1
  "if [SIDESET_COUNT is] set to 0, no side-set will take place"; the SDK's
  `sm_config_set_sideset` forbids `opt` with an inclusive count of 0 —
  sdk §29). §14.8 (resolved).

## 5. Shifters, counters, autopush/autopull

(DS §11.2.3, §11.2.4, §11.5.4.)

- [SPEC-5-1] OSR shifts data out (1–32 bits per OUT), fills with zeroes as it empties;
  reloaded from TX FIFO by PULL or autopull. ISR shifts data in; cleared to
  zeros on push/autopush.
- [SPEC-5-2] Directions independently configurable: `SHIFTCTRL.OUT_SHIFTDIR` (bit 19,
  reset 1 = right), `IN_SHIFTDIR` (bit 18, reset 1 = right; right-shift ⇒
  data enters at the MSB end).
- Two saturating 6-bit shift counters (0–32):
  - [SPEC-5-3] Reset / `CTRL.SM_RESTART`: ISR counter ← 0, OSR counter ← 32 ("full").
  - [SPEC-5-4] OUT: OSR counter += count (sat 32). IN: ISR counter += count (sat 32).
  - [SPEC-5-5] PULL / autopull: OSR counter ← 0. PUSH / autopush: ISR counter ← 0.
  - [SPEC-5-6] MOV to OSR/ISR: respective counter ← 0. `OUT ISR,n`: ISR counter ← n.
- [SPEC-5-7] Thresholds `SHIFTCTRL.PULL_THRESH` (bits 29:25), `PUSH_THRESH`
  (bits 24:20); 0 encodes 32; range 1–32.
- [SPEC-5-8] **Autopull** (bit 17): between OUTs, whenever OSR counter ≥ threshold and
  TX FIFO non-empty, OSR is refilled (can happen on any non-OUT cycle). On
  an OUT cycle the refill/stall rules are as in §3.4.
- [SPEC-5-9] **Autopush** (bit 16): on IN reaching threshold, push in the same cycle
  (stall if RX FIFO full), clear ISR and counter — one cycle unless
  stalled.
- [SPEC-5-10] Autopush incompatible with FJOIN_RX_PUT/GET (§3.7).

## 6. FIFOs and join modes

(DS §11.2.4.4, §11.5.3, §11.7; pioasm `pio_enums.h:12-19`.)

- [SPEC-6-1] Per SM: 4-deep 32-bit TX + 4-deep RX (`DBG_CFGINFO.FIFO_DEPTH` = 4).
- [SPEC-6-2] `SHIFTCTRL.FJOIN_RX` (bit 31): RX steals TX storage ⇒ 8-deep RX, TX
  disabled (FSTAT reports TX both full and empty). `FJOIN_TX` (bit 30):
  converse. Both set ⇒ both unavailable. Changing any FJOIN bit
  flushes/discards FIFO contents.
- [SPEC-6-3] `FJOIN_RX_PUT` (bit 15) / `FJOIN_RX_GET` (bit 14) — RP2350 new: RX
  storage becomes 4 random-access registers (§3.7). Setting either clears
  FJOIN_TX and FJOIN_RX. pioasm `.fifo` configs: `txrx | tx | rx | txput |
  txget | putget` (aux modes v1-only). [SPEC-6-4] **In TXPUT/TXGET/PUTGET aux modes the
  TX FIFO remains a normal, fully usable 4-deep TX FIFO** — unlike FJOIN_TX,
  the aux modes repurpose only the RX storage (sdk `H/pio.h:99-107`
  `pio_fifo_join` docs: "TX FIFO length=4 is used for transmit"; sdk N6).
- [SPEC-6-5] System interface: writing TXFx pushes (write-on-full dropped, sticky
  `FDEBUG.TXOVER`); reading RXFx pops (read-on-empty returns undefined
  data, sticky `FDEBUG.RXUNDER`).
- [SPEC-6-6] `FSTAT`: TXEMPTY/TXFULL/RXEMPTY/RXFULL per SM. `FLEVEL`: per-SM TX and RX
  levels.
- [SPEC-6-7] `FDEBUG` sticky flags: `TXSTALL` (stall on empty TX during
  blocking PULL or autopull-OUT), `TXOVER`, `RXUNDER`, `RXSTALL` (stall on
  full RX during blocking PUSH / autopush-IN, or nonblocking PUSH to full).
- [SPEC-6-8] DREQs: 1 word/clock DMA throughput; DREQ latency one cycle less than
  RP2040 (DS §11.1.1). [SPEC-6-9] DREQ numbering (sdk `regs/dreq.h`): PIO0 TX0..3/RX0..3
  = 0–7, PIO1 = 8–15, PIO2 = 16–23.

## 7. Registers (field-by-field)

(DS §11.7.) [SPEC-7-1] PIO0 base 0x50200000, PIO1 0x50300000, PIO2 0x50400000
(sdk `regs/addressmap.h`; sdk E3 closes the PIO2 offset the datasheet
table omits).

### Block-level

- [SPEC-7-2] `CTRL` (0x000):
  - 3:0 `SM_ENABLE`;
  - [SPEC-7-3] 7:4 `SM_RESTART` — clears shift counters, ISR contents, delay counter,
    WAIT-on-IRQ state, stalled forced instruction, sticky pin writes;
    **not** OSR, X/Y, the PC, or the enable state (sdk `H/pio.h`
    `pio_sm_restart` doc; the SDK resets the PC with a forced JMP via
    SMx_INSTR, `pio.c:423` — sdk N2);
  - [SPEC-7-4] 11:8 `CLKDIV_RESTART` — restart divider to phase 0 (free-running
    otherwise; simultaneous restarts with equal divisors ⇒ lockstep);
  - [SPEC-7-5] 19:16 `PREV_PIO_MASK`, 23:20 `NEXT_PIO_MASK`, 24
    `NEXTPREV_SM_ENABLE`, 25 `NEXTPREV_SM_DISABLE` (disable wins), 26
    `NEXTPREV_CLKDIV_RESTART` (all RP2350-new: apply the CTRL ops to
    neighbouring PIOs; neighbour links severed across secure/non-secure
    boundaries).
- [SPEC-7-6] `IRQ` (0x030): 8 SM IRQ flags, write-1-to-clear. `IRQ_FORCE` (0x034):
  write-1 sets flags (affects internal state, unlike INTF).
- [SPEC-7-7] `INPUT_SYNC_BYPASS` (0x038): per-GPIO, 1 = bypass 2-FF input
  synchroniser.
- [SPEC-7-8] `DBG_PADOUT` (0x03c) / `DBG_PADOE` (0x040): PIO's driven levels /
  output enables.
- [SPEC-7-9] `DBG_CFGINFO` (0x044): VERSION (31:28; 1 = RP2350), IMEM_SIZE (21:16) =
  32, SM_COUNT (11:8) = 4, FIFO_DEPTH (5:0) = 4.
- [SPEC-7-10] `INSTR_MEM0..31` (0x048+): 16-bit write-only instruction slots.
- [SPEC-7-11] `GPIOBASE` (0x168): bit 4 only, values 0 or 16.
- [SPEC-7-12] Interrupts: `INTR` — SM IRQ flags bits 15:8 (SM7=15 … SM0=8; RP2350
  exposes all 8), TXNFULL bits 7:4 (SM3=7 … SM0=4), RXNEMPTY bits 3:0
  (SM3=3 … SM0=0) (sdk `regs/pio.h` INTR fields, sdk E2); `IRQ0/IRQ1
  _INTE/_INTF/_INTS` at 0x170–0x178 / 0x17c–0x184 (enable/force/status;
  force does not affect internal state).
- [SPEC-7-13] `RXFx_PUTGET0..3` (0x128+): random system access to RX FIFO storage in
  PUT/GET modes (§3.7).
- [SPEC-7-28] `TXF0..3` (0x010..0x01c, WO): system TX FIFO push ports (write-on-full
  drops + sets TXOVER, §6). `RXF0..3` (0x020..0x02c, RO): system RX FIFO reads; a
  read pops (read-on-empty returns undefined + sets RXUNDER) (sdk `regs/pio.h`;
  DS §11.7).
- [SPEC-7-29] Status-register layouts, bit i of each nibble = SM i (sdk `regs/pio.h`):
  `FSTAT` (0x004, RO; reset 0x0f00_0f00): TXEMPTY 27:24, TXFULL 19:16, RXEMPTY 11:8,
  RXFULL 3:0. `FDEBUG` (0x008, W1C): TXSTALL 27:24, TXOVER 19:16, RXUNDER 11:8,
  RXSTALL 3:0. `FLEVEL` (0x00c, RO): TX0 3:0, RX0 7:4, TX1 11:8, RX1 15:12, TX2
  19:16, RX2 23:20, TX3 27:24, RX3 31:28 (nibble = live level, depth per §6).
- [SPEC-7-30] `RXFx_PUTGETy` address stride (sdk `regs/pio.h`): 0x128 + 0x10·x + 4·y
  (x = SM 0..3, y = storage register 0..3), ending at 0x164 before GPIOBASE.

### Per-SM (stride 0x18 from 0x0c8)

- [SPEC-7-14] `SMx_CLKDIV`: INT (31:16; 0 means 65536; if INT=0 FRAC must be 0), FRAC
  (15:8). SM clock = sysclk / (INT + FRAC/256); 16.8 fixed-point with
  first-order delta-sigma on FRAC (DS §11.5.5). Divisor range 1–65536 in
  1/256 steps; divisor 1 = every cycle. pioasm `.clock_div` accepts
  1 ≤ X < 65536 (`set_clock_div`, `pio_assembler.cpp:64-74`).
- `SMx_EXECCTRL`:
  - [SPEC-7-15] 31 `EXEC_STALLED` (RO): forced INSTR instruction stalled and latched;
  - [SPEC-7-16] 30 `SIDE_EN`, 29 `SIDE_PINDIR`, 28:24 `JMP_PIN`;
  - [SPEC-7-17] 23:19 `OUT_EN_SEL` + 18 `INLINE_OUT_EN`: one bit of OUT data as an
    auxiliary per-pin write enable;
  - [SPEC-7-18] 17 `OUT_STICKY`: continuously assert the most recent OUT/SET pin
    write;
  - [SPEC-7-19] 16:12 `WRAP_TOP`, 11:7 `WRAP_BOTTOM` (absolute addresses);
  - [SPEC-7-20] 6:5 `STATUS_SEL`, 4:0 `STATUS_N` (§3.6).
- [SPEC-7-21] `SMx_SHIFTCTRL` (bits): 31 FJOIN_RX, 30 FJOIN_TX, 29:25 PULL_THRESH,
  24:20 PUSH_THRESH, 19 OUT_SHIFTDIR, 18 IN_SHIFTDIR, 17 AUTOPULL,
  16 AUTOPUSH, 15 FJOIN_RX_PUT, 14 FJOIN_RX_GET, 4:0 IN_COUNT
  (RP2350-new; 0 = 32 / no masking).
- [SPEC-7-22] `SMx_ADDR` (0x0d4+): current PC, bits 4:0, RO.
- [SPEC-7-23] `SMx_INSTR` (0x0d8+): write = execute immediately (delay ignored,
  bypasses clock divider, PC not advanced unless the instruction changes
  it); may stall and is latched (EXEC_STALLED); shares the instruction
  latch with OUT/MOV EXEC (can overwrite an in-progress executee). [SPEC-7-24] Read =
  instruction currently addressed by PC.
  - [SPEC-7-25] A forced instruction executes with whatever PINCTRL/EXECCTRL is
    currently programmed — register writes take effect immediately, even
    while the SM is halted — and **OUT_STICKY applies to forced SET pin
    writes too**, re-asserting the most recent pin write on later cycles
    (sdk `pio_sm_set_pins*`/`pio_sm_set_pindirs*`, `pio.c:224-393`, which
    clear OUT_STICKY around the forced SET — sdk N5).
- [SPEC-7-26] `SMx_PINCTRL`: 31:29 SIDESET_COUNT (0–5, includes enable bit), 28:26
  SET_COUNT (0–5, reset 5), 25:20 OUT_COUNT (0–32), 19:15 IN_BASE, 14:10
  SIDESET_BASE, 9:5 SET_BASE, 4:0 OUT_BASE. All pin ranges wrap after
  GPIO31.

### Directives → registers (pioasm `program`, `pio_types.h:269-378`)

[SPEC-7-27] `.origin` load address; `.pio_version 0/1` (RP2040/RP2350 syntax gating);
`.wrap`/`.wrap_target` → WRAP_TOP/WRAP_BOTTOM (defaults: wrap = last
instruction, target = first); `.side_set N [opt] [pindirs]`; `.in P [,
right][, autopush @T]` → IN_BASE/IN_COUNT/IN_SHIFTDIR/PUSH_THRESH/AUTOPUSH
(v0 requires count 32; v1 allows 1–32); `.out …` → OUT_SIDE; `.set_count`;
`.fifo …` → FJOIN bits; `.mov_status`; `.clock_div`.

## 8. PC update and wrap

(DS §11.2.2, §11.5.2.) After executing an instruction:

1. [SPEC-8-1] JMP taken ⇒ PC ← target.
2. [SPEC-8-2] Else if PC == WRAP_TOP ⇒ PC ← WRAP_BOTTOM (free, 0-cycle jump).
3. [SPEC-8-3] Else PC ← PC + 1, or 0 when the current value is 31.

[SPEC-8-4] WRAP_TOP/BOTTOM are absolute instruction-memory addresses (adjust for
program load offset).

## 9. Stalling summary

(DS §11.2.5; confirmed by pioasm validation logic.)

Stall causes:
- [SPEC-9-1] WAIT condition not met.
- [SPEC-9-2] Blocking PULL with TX FIFO empty; blocking PUSH with RX FIFO full.
- [SPEC-9-3] IRQ with Wait=1, until the flag clears.
- [SPEC-9-4] OUT with autopull when the OSR counter had reached the threshold at the
  start of the cycle and refill is not possible (TX empty, or the
  same-cycle empty-OSR refill restriction) — §14.4.
- [SPEC-9-5] IN with autopush when the threshold is reached and the RX FIFO is full.

[SPEC-9-6] While stalled: PC does not advance; the instruction re-executes the next
cycle; delay cycles do not elapse during the stall; side-set fired once on
the first cycle. [SPEC-9-7] `irq` nowait, `irq clear`, JMP, MOV (general), SET never
stall.

## 10. GPIO mux, mapping, synchronizers

(DS §11.2.6, §11.5.6.)

- [SPEC-10-1] PIO keeps a 32-bit output-level and a 32-bit output-enable register for
  its GPIO window. Per-cycle writers per SM: OUT (≤32 bits at OUT_BASE,
  OUT_COUNT pins), SET (≤5 bits at SET_BASE), side-set (≤5 bits at
  SIDESET_BASE); applied to levels or directions per instruction /
  SIDE_PINDIR.
- [SPEC-10-2] **Priority (per GPIO, per cycle, separately for level and direction):**
  among the 4 SMs the **highest-numbered SM** wins; within one SM
  **side-set beats OUT/SET** on overlapping pins; otherwise previous value
  holds.
- [SPEC-10-3] Input mapping: IN data bus = GPIO inputs right-rotated by IN_BASE (LSB =
  IN_BASE pin, wrap after 31). `SHIFTCTRL.IN_COUNT` masks pins above the
  count to zero on IN PINS / WAIT PIN / MOV x,PINS (0 = 32 / unmasked).
  [SPEC-10-4] WAIT GPIO uses absolute numbers **within the SM's 32-pin GPIOBASE window**
  (window base 0 or 16 + index), not the rotated IN bus and not
  chip-absolute numbers (sdk E1: `pio.c:159-167` rewrites WAIT indices when
  GPIOBASE=16).
- [SPEC-10-5] 2-FF input synchronizer per GPIO (two cycles latency); per-GPIO bypass
  via `INPUT_SYNC_BYPASS` at the user's risk.
- [SPEC-10-6] pioasm evidence for the RP2350 input bank structure: absolute-GPIO
  references in one program must all fall in a single 32-pin bank
  (0–31 or 16–47) (`used_gpio_ranges`, `pio_assembler.cpp:404-420`).
  Sharpened by the SDK: the two legal windows are exactly 0–31 and 16–47 —
  use of pins 0–15 is incompatible with GPIOBASE=16 and of pins 32–47 with
  GPIOBASE=0 (`pio.c:is_gpio_compatible`, 107-113 — sdk N3); [SPEC-10-7] GPIOBASE may
  only be changed while no programs are loaded, values 0 or 16 only
  (`pio.c:pio_set_gpio_base_unsafe` — sdk N4).
- [SPEC-10-8] Constant-0/1 GPIO output override is a pads/QOI-level feature outside
  Chapter 11; PIO-side observation via DBG_PADOUT/DBG_PADOE.

## 11. Forced and EXEC'd instructions

(DS §11.2.2, §11.5.7.) [SPEC-11-1] Instruction sources besides memory: SMx_INSTR
writes (immediate, delay ignored, clock divider bypassed, PC not
advanced), OUT EXEC and MOV EXEC (executee runs the following cycle via
the shared internal instruction latch; the executee cycle does not advance
PC).

## 12. RP2350 vs RP2040 differences

(DS §11.1.1; pioasm `.pio_version` gating.)

New registers/controls:
- [SPEC-12-1] `DBG_CFGINFO.VERSION` = 1 (RP2040 reserved-0).
- [SPEC-12-2] `GPIOBASE` (>32 GPIOs per block).
- [SPEC-12-3] `CTRL.NEXT/PREV_PIO_MASK`, `NEXTPREV_SM_ENABLE/DISABLE/CLKDIV_RESTART`.
- [SPEC-12-4] `SMx_SHIFTCTRL.IN_COUNT` (mask unneeded IN-mapped pins).
- [SPEC-12-5] `IRQ0/1_INTE` expose all 8 SM IRQ flags (RP2040: lower 4 only).
- [SPEC-12-6] `RXFx_PUTGET0..3` + `FJOIN_RX_PUT`/`FJOIN_RX_GET`.

New instruction features:
- [SPEC-12-7] WAIT source 11 (JMPPIN), offset 0–3, independent of IN mapping.
- [SPEC-12-8] MOV destination PINDIRS (RP2040: not supported).
- [SPEC-12-9] MOV source STATUS can select SM IRQ flags (STATUS_SEL=2, with
  PREV/NEXT). **Field relocation:** on RP2040 `STATUS_SEL` is **1 bit at
  EXECCTRL bit 4** (TXLEVEL/RXLEVEL only) and `STATUS_N` is **bits 3:0**;
  RP2350 moves STATUS_SEL to bits 6:5 and widens STATUS_N to 4:0 (RDS §3.7
  Table 382 vs DS §11.7; xcheck-rp2040 §3.1). Do not carry RP2040-derived
  EXECCTRL bit constants over.
- [SPEC-12-10] IRQ/WAIT/STATUS cross-PIO indexing (PREV/NEXT IdxModes); cross-PIO IRQs
  visible next cycle, no penalty. (RP2040 uses only bit 4 as a single
  relative bit; RP2350 generalises bits 4:3 into the 2-bit IdxMode — RDS
  §3.4.9.)
- [SPEC-12-11] MOV put/get encodings in the class-0x4 space (RP2040 leaves bits 4:0
  fixed at 0 for PUSH/PULL with no alternative meaning defined — nonzero
  arg2 is **unassigned** there; "reserved" is a pioasm-side inference,
  `pio_disassembler.cpp:89-118`; xcheck-rp2040 §3.2).

[SPEC-12-12] Security: non-secure PIOs observe only non-secure GPIOs (secure GPIO reads
0); cross-PIO links severed across security boundaries.

[SPEC-12-13] General: 3 PIO blocks (was 2), improved GPIO I/O delay and skew, DREQ
latency reduced by one cycle.

## 13. RTL-decoder reservations (both sources)

[SPEC-13-1] Reserved/undefined encodings the RTL must treat explicitly: IN sources
100/101; SET dsts 011/101/110/111; MOV op 11; MOV src 100; IRQ modifier 3;
WAIT JMPPIN index > 3 (arg2[4:2] ≠ 0); PUSH/PULL arg2 ≠ 0 other than the
FIFO-aux forms; FIFO-aux with IdxI=0 and Index ≠ 0; STATUS_N > FIFO depth
for STATUS_SEL TXLEVEL/RXLEVEL (sdk `regs/pio.h`, N7).

[SPEC-13-2] Tool quirk (not a rule change): the SDK's `pio_encode_wait_jmppin`
asserts `offset <= 4`, one more than the documented 0–3 (sdk E4,
`H/pio_instr.h:332`). RTL keeps 0–3 valid / other encodings reserved per
the datasheet and pioasm; the SDK bound appears to be an off-by-one.

## 14. Open questions (cross-check results)

Each item lists both sources' claims and its resolution status. The
resolution of each item is the citeable fact.

### 14.1 Instruction memory size: 32 vs 36 — **RESOLVED: 32**

- Datasheet: 32 instructions everywhere (Figure 44, §11.2.2, §11.2.8,
  `INSTR_MEM0..31` in §11.7; PC wrap "0 when the current value is 31",
  §11.5.2; JMP address 5 bits).
- pioasm research doc claimed "RP2350 has 36 per block, but pioasm still
  limits to 32 for compatibility".
- [SPEC-14.1-1] **Resolution:** inspected the local clone
  (`third_party/pioasm-sdk/tools/pioasm/pio_types.h:270`): `MAX_INSTRUCTIONS
  = 32`, and grep of the pioasm sources finds **no mention of 36 anywhere**
  — the "36" was an unverified note in the researcher doc, not a pioasm
  claim. pioasm simply caps programs at 32. The datasheet (primary source)
  says 32 consistently. **32 is authoritative.** Repo documents (DESIGN.md,
  KANBAN.md) corrected accordingly in the same commit.

### 14.2 Overloaded class-0x4 opcode space — **RESOLVED (decode rule)**

- Datasheet: nine instructions, but the Table 980 has 11 rows; PUSH/PULL
  and MOV put/get share opcode 100 (DS §11.4.6–§11.4.9).
- pioasm: class 0x4 arg2 = 0 for PUSH/PULL; arg2 bit 4 = 1 marks FIFO-aux;
  bit 3 = literal-index-vs-Y; bits 1:0 index; b7 distinguishes PUT(0)/
  PULL(1) and PUT-aux(0)/GET-aux(1) (`get_push_get_index`,
  `pio_disassembler.cpp:89-118`).
- [SPEC-14.2-1] **Resolution:** decode rule for class 0x4: if arg2[4]=1 → FIFO-aux MOV
  (arg2[3]=IdxI, arg2[1:0]=Index; b7 = GET); else if arg2 ≠ 0 → reserved
  (RP2040) / undefined; else PUSH (b7=0) / PULL (b7=1), with b6 = IfF/IfE,
  b5 = Block. Both sources agree on this once the pioasm encoding is
  mapped onto the datasheet bit positions; the datasheet's "b4=1, b3=IdxI,
  b2=0" matches pioasm's `0x10 | (idx ? 8 | idx&3 : 0)`.

### 14.3 WAIT IRQ index field split — **RESOLVED (rule), wording ambiguity noted; RDS-supported**

- Datasheet §11.4.3.2 says the IRQ index is decoded "down from the two
  MSBs" of the 5-bit field; the WAIT encoding table shows Index as b4:0
  with Source at b6:5 — two slightly different presentations.
- pioasm encodes `wait irq` as arg2 = irq_index | (irq_type << 3), i.e.
  b4:3 = mode, b2:0 = index — identical to the IRQ instruction.
- RP2040 datasheet §3.4.3.2 states the shared-decode rule explicitly:
  "The flag index is decoded in the same way as the IRQ index field" (one
  MSB on RP2040, bits 4:3 as IdxMode on RP2350).
- [SPEC-14.3-1] **Resolution:** effective rule = b4:3 IdxMode, b2:0 flag index (same as
  IRQ instruction), confirmed by pioasm's encoder/disassembler and by both
  datasheet generations. The datasheet's "two MSBs of the 5-bit field" is
  the same rule in different words; no behavioural discrepancy.

### 14.4 Autopull OUT-cycle stall boundary — **OPEN (for cycle contract)**

- DS §11.2.5 lists the stall as "OUT with autopull when the OSR has
  reached its shift threshold" (ambiguous about before/after this OUT's
  shift).
- DS §11.5.4.2 pseudocode shows the OUT-cycle stall occurs when the
  threshold was already reached **at the start of the cycle** (refill
  instead of shift; else shift, then refill if threshold now reached).
- pioasm has no cycle-timing information.
- RP2040 datasheet §3.5.4.2 contains the **identical pseudocode
  verbatim**, including the "cannot fill an empty OSR and 'OUT' it on the
  same cycle, due to the long logic path this would create" rationale, and
  §3.2.4 the same ambiguous one-line summary — dual-generation
  confirmation of the §11.5.4.2 reading (xcheck-rp2040 §4). pico-examples
  additionally relies on the cycle-level ordering of `pull ifempty` +
  `jmp !osre` (spi_*_cs "time-of-check race" comment — §15).
- [SPEC-14.4-1] **Status:** adopt the §11.5.4.2 rule (stall only if threshold already
  reached at cycle start and refill impossible); no remaining textual
  ambiguity, but the precise cycle-boundary contract is to be pinned in
  `docs/cycle-contract.md` (Phase 1 KANBAN item). Still OPEN.

### 14.5 JMP `x--`/`y--` decrement condition — **RESOLVED (datasheet rule; RDS-reconfirmed)**

- Datasheet §11.4.2: "`X--`/`Y--` always decrement; branch decided on the
  pre-decrement value."
- pioasm research doc phrased it as "decrement occurs when the condition
  is true" / "on taken-condition evaluation".
- RP2040 datasheet §3.4.2.2 gives the clearest wording of any source:
  "The decrement is not conditional on the current value of the scratch
  register. The branch is conditioned on the initial value of the
  register, i.e. before the decrement took place."
- [SPEC-14.5-1] **Resolution:** the datasheet is primary and explicit: decrement always
  happens (taken or not); the branch tests the pre-decrement value. The
  two coincide whenever the instruction is executed; the difference only
  matters for a not-taken `x--` (X≠0 is the taken case; a not-taken `x--`
  means X==0, decrementing 0 wraps to 0xFFFFFFFF — datasheet says this
  happens). RTL: unconditional decrement, test pre-decrement value.
  pico-examples exercise this heavily (addition, blink, hub75,
  quadrature's "JMP Y-- to the next address is a pure decrement").

### 14.6 `in null` / `out null` shifting — **RESOLVED (datasheet), note kept**

[SPEC-14.6-1] Both sources: NULL is a plain source/destination encoding (0x3), no
special casing in pioasm; datasheet semantics mean the ISR/OSR and its
counter still shift (`OUT NULL 32` is the documented way to discard the
OSR). RTL must implement NULL as shift-but-discard.

### 14.7 Non-blocking PULL on empty FIFO and the OSR counter — **RESOLVED, now explicit (RDS §3.5.4.2)**

- Datasheet: non-blocking PULL on empty FIFO behaves as `MOV OSR, X`, and
  separately MOV-to-OSR clears the OSR shift counter; the datasheet does
  not explicitly restate the counter clear for this case.
- RP2040 datasheet §3.5.4.2's non-OUT-cycle pseudocode opens with
  `if MOV or PULL: osr count = 0` — *any* PULL (and any MOV writing OSR)
  clears the OSR counter. Upgraded from inference to confirmed
  (xcheck-rp2040 §4). The pwm example in pico-examples is built directly
  on the `MOV OSR,X` fallback.
- [SPEC-14.7-1] **Resolution:** the RTL clears the OSR shift counter. Confirmed.

### 14.8 SIDE_EN with SIDESET_COUNT edge values — **RESOLVED (RDS + SDK)**

- Datasheet does not specify the exact interaction of SIDE_EN=1 with
  SIDESET_COUNT=0 or 1, nor the bit-level layout beyond "MSBs of the
  5-bit field".
- pioasm confirms the layout (enable at bit 4 when `opt`; data shifted to
  the top; with enable=0 all 5 bits are delay) but cannot answer
  SIDESET_COUNT=0 with SIDE_EN=1 (nonsensical configuration).
- RP2040 datasheet §3.5.1: "every instruction … will perform a side-set,
  if SIDESET_COUNT is nonzero" and "if [set to] 0, no side-set will take
  place" — SIDESET_COUNT=0 means no side-set regardless of SIDE_EN. The
  SDK additionally forbids the combination outright
  (`sm_config_set_sideset`: `!optional || bit_count >= 1`).
- [SPEC-14.8-1] **Resolution:** RTL defines SIDESET_COUNT=0 as "no side-set" and ignores
  SIDE_EN — now datasheet-backed, not just a convention.

### 14.9 RP2040 carry-over text in DBG_PADOUT/DBG_PADOE — **noted, origin confirmed**

[SPEC-14.9-1] Datasheet notes for DBG_PADOUT/PADOE reference RP2040's 30 GPIOs for the
MSBs being 0; on RP2350 the window is 32 bits per GPIOBASE. The RP2040
datasheet (RDS §3.7 Tables 377/378) contains the identical sentence —
confirming the RP2350 note is carry-over text. The RP2350 SDK header
reproduces it too (sdk §10 of xcheck-picosdk). RP2350 rule: 32-bit
window, bits above the configured bank read 0.

### 14.10 STATUS_N encoding width — minor, resolved

[SPEC-14.10-1] DS Table 996 gives STATUS_N encodings 0x08+n / 0x10+n for PREV/NEXT IRQ
status; pioasm `.mov_status irq` encodes N_final = param*8 + irq
(`pio_assembler.cpp:182-191`). Consistent; documented in §3.6.

## 15. Conformance-test observations (pico-examples)

From `docs/xcheck-picoexamples.md` — constructs the examples rely on that
are under-specified in the datasheet/pioasm and therefore feed the future
`docs/cycle-contract.md`. No contradictions with §§1–13 were found.

- [SPEC-15-1] **IN ISR / IN OSR rotate semantics** (§3.3 note added): `in isr, n`
  rotates ISR (direction per IN_SHIFTDIR) and the ISR counter still
  advances; `in osr, n` leaves the OSR shift counter untouched.
- [SPEC-15-2] **MOV into ISR/OSR never triggers autopush/autopull** (§3.6 note added):
  onewire `mov isr, pins` "avoids autopush"; quadrature_encoder
  `mov isr,y` + `push noblock`.
- [SPEC-15-3] **Side-set during FIFO stalls** (§4 note added): ws2812, spi_cpha0,
  uart_tx all stall (autopull-OUT / blocking PULL) while side-set holds
  the line — confirms side-set-on-first-cycle for FIFO-induced stalls,
  not only WAIT.
- [SPEC-15-4] **`pull ifempty` + `jmp !osre` cycle race** (spi_*_cs): the examples use
  IfEmpty as a time-of-check fence; whether a `pull ifempty` consumes a
  word when the counter has reached threshold even though OSR was just
  refilled by autopull is exactly the §14.4 boundary — pin in the cycle
  contract.
- [SPEC-15-5] **Non-blocking PUSH still clears ISR and resets the counter every
  iteration** (quadrature_encoder "drain then read one more" protocol) —
  validates §3.5 Block=0 semantics; data loss is expected/benign.
- [SPEC-15-6] **Instruction-memory patch visibility** (hub75_data_rgb888 patches
  INSTR_MEM while the SM runs; i2c injects instructions via OUT EXEC):
  when is a patched word observed by a running SM (expected: next fetch,
  no invalidation — 1-write/4-read register file)? Cheap to pin in the
  cycle contract.
- [SPEC-15-7] **Forced-instruction delay bits** (§7/§11): manchester_rx ORs delay bits
  into a forced WAIT via SMx_INSTR even though forced instructions ignore
  the delay field — cosmetic on silicon; worth a test to confirm the RTL
  ignores them. Forced WAIT while SM_ENABLE=0 is the documented "arming"
  idiom (logic_analyser), depending on the EXEC_STALLED latch.
- [SPEC-15-8] **Input-synchroniser sampling skew** (clocked_input): data sampled one
  sysclk after the edge, recommend input clk < sys/6; the only concrete
  numbers for SM-clock-vs-sysclk skew — relevant to modelling
  INPUT_SYNC_BYPASS (spi examples bypass on MISO).
- [SPEC-15-9] **Narrow FIFO accesses** (i2c halfword, st7789 byte, uart_rx byte
  reads): IO-fabric/DREQ behaviour outside Chapter 11 — out of scope for
  the RTL except that FIFO read/write widths must not block on the full
  32-bit word.
- [SPEC-15-10] **RP2350 coverage caveat:** none of the examples exercise RP2350-only
  instruction features (MOV put/get, WAIT JMPPIN, MOV PINDIRS dst,
  IN_COUNT, PREV/NEXT IRQ); §12 conformance must come from pio-sdk tests
  and datasheet pseudocode.

## 16. Trace-equivalence contract (C11 miter + trace exchange)

Provenance: vibe-pio methodology decisions ratified at the C11 promotion
(grilling session 2026-08-25) — these are contract facts about *this
model's* equivalence methodology, not datasheet facts. Consumers:
`formal/pio_equiv_fv.sv` (the lockstep miter, C11), `tools/pio_model/`
(C12 model trace emission / RTL trace-dump TBs) and `tools/hyperequiv.py`
(C13 oracle + divergence reports).

- [SPEC-16-1] **Per-clk observables.** Two configurations under comparison are
  observably equivalent only if `gpio_out[31:0]`, `gpio_oe[31:0]` and
  `intr[15:0]` (the SPEC-7-12 composition) agree in every clk cycle from
  reset release onward. The miter asserts these three equalities
  unconditionally — divergence at any clk is a failure, no windowing.
- [SPEC-16-2] **CPU-visible read observables.** `reg_rdata` is a combinational
  function of `reg_addr` and block state (the pio_block read mux), so
  equivalence requires equal `reg_rdata` at every address in every clk.
  Read strobes contribute only side effects (RXF pop SPEC-7-28, the
  PUTGET window SPEC-7-13) and the harness issues identical reads on both
  instances, so the pop streams — hence RX data order — are compared.
  **Exclusions** (instruction-stream artifacts a rewrite may legitimately
  rearrange): SMx_INSTR (= imem[pc], SPEC-7-24 — the program text itself
  differs by hypothesis) and SMx_ADDR (= pc, SPEC-7-22); SMx_EXECCTRL is
  compared with bit 31 masked (the EXEC_STALLED RO overlay, SPEC-7-15 —
  SM-internal readiness timing, not an architectural effect).
- [SPEC-16-3] **Bounded-by-default equivalence.** A pair is equivalent at
  horizon N iff no observable divergence (SPEC-16-1/2) occurs within N
  clk of the init protocol (SPEC-16-4) under the free-phase rules
  (SPEC-16-5). N is a parameter of the check (sby BMC depth; default
  40–64 clk = ticks at the reset CLKDIV of INT=1). k-induction over the
  twin — unbounded equivalence — is explicitly out of scope for v1.
- [SPEC-16-4] **Init protocol.** Both instances share clk/rst with the CC-1
  reset protocol; program A/B are written word-serially into
  INSTR_MEM0.. (SPEC-7-10) by a deterministic prologue sequencer; config
  writes are broadcast identically; SM0 is enabled via CTRL (SPEC-7-2).
  v1 scoping: SM1..3 stay disabled (single-SM equivalence — the card's
  sanctioned scoping for solver tractability).
- [SPEC-16-5] **Free-phase rules.** After the prologue the reg bus is free but
  broadcast identically to both instances, confined to bus *traffic*:
  TXF0 (SPEC-7-28), FDEBUG W1C (SPEC-7-29), IRQ/IRQ_FORCE (SPEC-7-6)
  and INPUT_SYNC_BYPASS (SPEC-7-7). All config mutation is excluded —
  the INSTR_MEM window per CC-33 (program text is fixed at load — the
  equivalence claim quantifies over the loaded pair only), CTRL per
  SPEC-16-4 (SM1..3 stay disabled), and the SMx config / SMx_INSTR
  force / PUTGET windows per SPEC-16-6 (mid-run config rewrites are the
  C14 config-overlay extension point; v1 claims instruction-stream
  equivalence under fixed config). `gpio_in` and the IRQ neighbour
  views / imported requests are free but identical across instances.
- [SPEC-16-6] **v1 scope and extension points.** The two configurations are
  identical except instruction-memory contents (instruction-stream
  rewrites). Config overlays (rewrites that also touch config registers,
  e.g. side-set fusion changing EXECCTRL/PINCTRL) and spec-conformance
  predicates (timing-relaxed comparison) are the declared extension
  points consumed by C14/C15.
- [SPEC-16-7] **Trace exchange format v1.** Line-oriented ASCII; `#` starts a
  comment; the first non-comment line is the header `pio-trace v1`.
  Records are whitespace-separated with lowercase fixed-width hex
  payloads: the per-clk observable line `<clk> G <gpio_out:8hex>
  <gpio_oe:8hex> <intr:4hex>`, then for each reg read completing in that
  clk a line `<clk> R <reg_addr:3hex> <reg_rdata:8hex>`. `<clk>` is
  decimal, 0 = the first clk with rst de-asserted; exactly one G line
  per clk, no gaps. Two configurations are trace-equivalent iff their
  traces under identical stimulus are line-identical after dropping R
  lines at SPEC-16-2-excluded addresses and masking bit 31 of
  SMx_EXECCTRL reads. Emitted by the C12 model and by RTL trace-dump
  TBs; consumed by the C13 differ.
- [SPEC-16-8] **EXECCTRL config overlay (landed C14).** The miter's prologue
  writes SM0_EXECCTRL per instance (`SM0_EXECCTRL_A`/`_B` parameters), so
  a compared pair may intentionally differ in EXECCTRL — the wrap
  rewrites change WRAP_TOP/WRAP_BOTTOM (SPEC-7-19/20) while preserving
  timing by folding the replaced JMP's 1+delay ticks into the preceding
  instruction's delay field. The CPU-visible readback compare for
  SMx_EXECCTRL masks exactly the bits 30:0 the pair intentionally
  differs on (miter localparam `EC_CMP_MASK`; bit 31 stays masked per
  SPEC-7-15) — the C12 trace comparison takes the same mask
  (`tracefmt.normalize`'s `ec_mask`). The behavioural observables
  (SPEC-16-1) still compare unconditionally, so an overlay that changes
  behaviour fails the equivalence claim. PINCTRL/SHIFTCTRL overlays
  (side-set fusion, autopull rewrites) remain future extension
  (SPEC-16-6).

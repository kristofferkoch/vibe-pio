# RP2350 PIO consolidated specification

**Authoritative reference for the vibe-pio RTL.** Consolidated from two
research inputs, both retained unchanged:

- `docs/pio-spec-datasheet.md` — extracted from the RP2350 datasheet PDF,
  Chapter 11 "PIO" (§11.1–§11.7). Cited below as **DS §x.y**.
- `docs/pio-spec-pioasm.md` — extracted from the pioasm assembler sources
  (`tools/pioasm/` in pico-sdk, local clone at `third_party/pioasm-sdk/`;
  provenance in `docs/spec-sources.md`). Cited below as **pioasm** with the
  source file/function.

Facts on which the two sources agree are stated once with both citations.
Discrepancies and unresolved ambiguities are collected in §14 "Open
questions". Where a conflict was resolved by consulting the datasheet text
or the local pioasm clone, the resolution and method are stated there.

Bit numbering: bit 15 = MSB of the 16-bit instruction word; register bit
ranges are as in the datasheet.

---

## 1. Block overview

- RP2350 contains **3 identical PIO blocks** (RP2040: 2) — 12 state machines
  total. Each block: 4 SMs, shared instruction memory, own IRQ flags, own
  GPIO window. (DS §11.1.1)
- **Instruction memory: 32 × 16-bit instructions per block**, shared by the
  4 SMs; 1-write (system, write-only via `INSTR_MEM0..31`) / 4-read register
  file so all SMs fetch without stalling. (DS §11.2.8, §11.2.2, §11.7;
  confirmed by pioasm `MAX_INSTRUCTIONS = 32`, `pio_types.h:270`.) See
  §14.1 for the 32-vs-36 question (resolved: 32).
- Each SM has (DS §11.1):
  - 32-bit shift registers ISR and OSR (either shift direction, any count);
  - 32-bit scratch registers X and Y;
  - 4×32-bit TX FIFO and 4×32-bit RX FIFO, joinable to 8 deep in one
    direction (DS §11.2.4.4);
  - fractional clock divider, 16.8 fixed point (§8 below).
- PIO maps to a 32-GPIO window; `GPIOBASE` (bit 4; values 0 or 16 only)
  relocates the window (RP2350 has 30 user GPIOs). (DS §11.1.1, §11.7)
- Execution model: fetch/decode/execute one instruction per SM clock tick;
  every instruction takes exactly one cycle **unless it stalls** (§9).
  (DS §11.2.2, §11.4.1)
- The datasheet calls this **nine instructions**: JMP, WAIT, IN, OUT, PUSH,
  PULL, MOV, IRQ, SET (DS §11.2.1); pioasm has 8 instruction *classes*
  (bits 15:13) because PUSH/PULL share class 0x4 with the two RP2350
  FIFO-aux MOV encodings (§4, §14.2).

## 2. Instruction word format

`inst = (type << 13) | ((delay|sideset) << 8) | (arg1 << 5) | (arg2 & 0x1f)`
(pioasm `instruction::encode`, `pio_assembler.cpp:261-296`; DS §11.4.1
Table 980).

| Bits  | Field |
|-------|-------|
| 15:13 | instruction class (JMP=000 … SET=111) |
| 12:8  | delay/side-set (§6) |
| 7:5   | arg1: condition / polarity+source / source / destination / modifier |
| 4:0   | arg2: address / bit count / immediate / IRQ index / FIFO-aux index |

Note (pioasm): the assembler internally keeps a 6th arg2 bit above the
16-bit word; the emitted word truncates to `arg2 & 0x1f`. For all
RP2040-compatible instructions arg2 is 5 bits; the FIFO-aux encodings pack
their index into the 5 bits (§4.5).

### Master encoding table (DS §11.4.1 Table 980; cross-checked pioasm)

| Instruction | b15:13 | b7:5 | b4:0 | pioasm encode |
|---|---|---|---|---|
| JMP    | 000 | cond[7:5] | addr[4:0] | `pio_assembler.cpp:358-368` |
| WAIT   | 001 | pol[7], src[6:5] | index[4:0] (IRQ: idxmode[4:3], idx[2:0]) | `:394-430` |
| IN     | 010 | src[7:5] | bitcount[4:0] (0 ⇒ 32) | `:370-384` |
| OUT    | 011 | dst[7:5] | bitcount[4:0] (0 ⇒ 32) | `:370-384` |
| PUSH   | 100 | 0, IfF[6], Blk[5] | 0[4:0] | `pio_types.h:430-454` |
| MOV put (RX FIFO aux) | 100 | 0,0,0 | 1[4], IdxI[3], 0[2], Index[1:0] | `:346-356` |
| PULL   | 100 | 1, IfE[6], Blk[5] | 0[4:0] | `pio_types.h:430-454` |
| MOV get (RX FIFO aux) | 100 | 1,0,0 | 1[4], IdxI[3], 0[2], Index[1:0] | `:346-356` |
| MOV    | 101 | dst[7:5] | op[4:3], src[2:0] | `:346-356` |
| IRQ    | 110 | 0[7], Clr[6], Wait[5] | idxmode[4:3], index[2:0] | `:432-437` |
| SET    | 111 | dst[7:5] | data[4:0] | `:386-392` |

**Bit count 32 encodes as 0** in IN/OUT arg2 — confirmed in both assembler
(`v & 0x1f`) and disassembler (`arg2 ? arg2 : 32`) (pioasm
`pio_disassembler.cpp:79,86`; DS §11.4.4/§11.4.5). RTL must decode 0 as 32.

## 3. Per-instruction semantics (incl. stall behaviour)

### 3.1 JMP — `000 | delay/ss | cond[7:5] | addr[4:0]`

Set PC to addr if condition true, else fall through (delay applies either
way). addr is absolute within the 32-word memory (DS §11.4.2).

| cond | syntax | meaning |
|---|---|---|
| 000 | (always) | unconditional |
| 001 | `!x`   | X == 0 |
| 010 | `x--`  | X != 0 (pre-decrement test), X always decremented |
| 011 | `!y`   | Y == 0 |
| 100 | `y--`  | Y != 0, Y always decremented |
| 101 | `x != y` | X != Y |
| 110 | `pin`  | `EXECCTRL.JMP_PIN` pin high (independent of IN mapping) |
| 111 | `!osre` | OSR not empty (bits shifted out < `PULL_THRESH`) |

Sources agree (DS §11.4.2; pioasm `pio_types.h:60-69`,
`pio_disassembler.cpp:30-35`). `x--`/`y--` decrement on *every* execution of
the condition (taken or not? — see §14.5: datasheet says "always
decrement", pioasm notes tie it to condition evaluation; treat as:
decrement unconditionally, branch on pre-decrement value, per DS §11.4.2).
**Never stalls.**

### 3.2 WAIT — `001 | delay/ss | pol[7] | src[6:5] | index[4:0]`

Stall until condition met; delay cycles begin only after the wait completes
(DS §11.4.3.2, §11.2.5). pol=1 waits for 1, pol=0 waits for 0; bare
`wait <src>` defaults pol=1 (pioasm `parser.yy:263`).

| src | meaning | index |
|---|---|---|
| 00 | GPIO — absolute GPIO number, NOT affected by IN mapping | 0–31 (v0) / 0–47 (v1) |
| 01 | PIN — (PINCTRL.IN_BASE + index) mod 32 | 0–31 |
| 10 | IRQ — flag per index decode below; if pol=1 flag is cleared by the SM when the wait completes | 0–7 + mode bits |
| 11 | JMPPIN (RP2350 new) — (EXECCTRL.JMP_PIN + index) mod 32 | 0–3 only; other encodings reserved (pioasm disassembler marks arg2[4:2] ≠ 0 reserved) |

**WAIT IRQ index decode:** the 5-bit index field's two MSBs (b4:3) are the
IdxMode, b2:0 the flag index — same rule as the IRQ instruction (DS
§11.4.3.2; see §14.3 for the datasheet's two slightly different split
descriptions, resolved to this rule). Modes: 00 this PIO, 01 PREV
(next-lower PIO, wrapping), 10 REL (add SM id mod 4 to the two LSBs), 11
NEXT (next-higher PIO, wrapping). pioasm encodes `rel` at bit 4 and
prev/next at bits [4:3]=01/11; `rel` combined with prev/next is rejected
(`parser.yy:272-273,302-303`). Datasheet caution: do not `WAIT 1 IRQ x` on
flags routed to the interrupt controller (race with the handler).

**Stall behaviour:** re-executes each cycle until satisfied; PC does not
advance; side-set fired once on the first cycle (§9).

### 3.3 IN — `010 | delay/ss | src[7:5] | bitcount[4:0]`

Shift bitcount (1–32, 0⇒32) bits of src into ISR in the direction given by
`SHIFTCTRL.IN_SHIFTDIR`; input shift counter += bitcount, saturating at 32
(DS §11.4.4).

| src | meaning |
|---|---|
| 000 PINS | IN-mapped pins (LSB = IN_BASE pin) |
| 001 X / 010 Y | scratch register |
| 011 NULL | zeros — **still shifts the ISR/counter** (datasheet fact; pioasm has no special handling — §14.6) |
| 100/101 | reserved |
| 110 ISR / 111 OSR | self/other shifter |

IN always uses the **LSBs** of the source data regardless of shift
direction (e.g. IN PINS always takes IN_BASE, IN_BASE+1, …; only the
end of ISR that data enters depends on IN_SHIFTDIR) (DS §11.4.4).

**Autopush interaction:** if autopush enabled and input shift counter ≥
`PUSH_THRESH` (after adding bitcount), IN simultaneously pushes ISR to the
RX FIFO in the same cycle; ISR and counter cleared to 0. **Stalls** if RX
FIFO full (re-executes next cycle). (DS §11.4.4.2, §11.5.4)

### 3.4 OUT — `011 | delay/ss | dst[7:5] | bitcount[4:0]`

Shift bitcount (1–32, 0⇒32) bits out of OSR to dst; output shift counter +=
bitcount, saturating at 32. A 32-bit value is written to the destination:
the bitcount bits taken from the LSB end (right-shift) or MSB end
(left-shift) of OSR, remainder zero (DS §11.4.5).

| dst | meaning |
|---|---|
| 000 PINS | OUT pin mapping (OUT_BASE, OUT_COUNT pins, wrap after GPIO31) |
| 001 X / 010 Y | scratch |
| 011 NULL | discard (still shifts OSR/counter) |
| 100 PINDIRS | pin direction, OUT mapping |
| 101 PC | unconditional jump to shifted-out address |
| 110 ISR | writes ISR and sets ISR shift counter to bitcount |
| 111 EXEC | execute shifted-out word as an instruction (below) |

pioasm agrees on the table (`pio_types.h:72-83`); `out exec` = arg1 0x7
(`parser.yy:340`).

**OUT EXEC:** the OUT executes this cycle; the executee executes **next
cycle** via the SM's instruction latch; the delay field of the OUT itself is
ignored (executee may carry delay normally); any instruction type allowed;
only one OUT per cycle. OUT PC/MOV PC never stall beyond the OUT itself.
(DS §11.4.5, §11.2.2)

**Autopull interaction:** on an OUT cycle, if the OSR counter has already
reached `PULL_THRESH` at the start of the cycle, the SM refills OSR from TX
FIFO and **stalls this cycle** instead of shifting (also stalls if FIFO
empty); otherwise shifts out and, if the counter now reaches threshold,
refills simultaneously with the last shift-out (an OSR emptied by this OUT
cannot be refilled and re-OUTed in the same cycle). OUT is a data fence:
never outputs data not yet written to the FIFO. (DS §11.5.4.2 — see
§14.4 for the residual cycle-boundary ambiguity.)

### 3.5 PUSH / PULL — class 0x4, b7 distinguishes

- PUSH: `100 | delay/ss | 0 | IfF[6] | Blk[5] | 0[4:0]`
- PULL: `100 | delay/ss | 1 | IfE[6] | Blk[5] | 0[4:0]`

pioasm arg1 packing (`pio_types.h:430-454`): PUSH arg1 = Blk | (IfF<<1);
PULL arg1 = Blk | (IfE<<1) | 4 — matches DS bit positions (Blk=b5,
IfF/IfE=b6, direction=b7). pioasm defaults: Block=1, IfFull/IfEmpty=0.

**PUSH:** write ISR (32 bits) to RX FIFO, then clear ISR to zeros.
- IfFull=1: no-op unless input shift counter ≥ PUSH_THRESH.
- Block=1: **stall** while RX FIFO full.
- Block=0 with full FIFO: FIFO unchanged, ISR still cleared, sticky
  `FDEBUG.RXSTALL` set (data lost).
- **Undefined** when `FJOIN_RX_PUT` or `FJOIN_RX_GET` is set — use MOV
  put/get instead (DS §11.4.6.2 NOTE); pioasm enforces: PUSH rejected
  unless FIFO config is `rx`/`txrx` (`instr_push::pre_validate`,
  `pio_assembler.cpp:322-326`).

**PULL:** load 32-bit word from TX FIFO into OSR, output shift counter ← 0.
- IfEmpty=1: no-op unless output shift counter ≥ PULL_THRESH.
- Block=1: **stall** while TX FIFO empty.
- Block=0 with empty FIFO: behaves as `MOV OSR, X` (copies X to OSR; the
  OSR counter clear follows from MOV-to-OSR semantics — §14.7).
- With autopull enabled, PULL is a no-op while the OSR is full (acts as a
  fence; `OUT NULL 32` explicitly discards OSR) (DS §11.4.7.2 NOTE).

### 3.6 MOV — `101 | delay/ss | dst[7:5] | op[4:3] | src[2:0]`

| val | dst | src |
|---|---|---|
| 0 | PINS (OUT mapping) | PINS (IN mapping, masked to `IN_COUNT` bits; bits above read 0, LSB = IN_BASE, wrap after 31) |
| 1 | X | X |
| 2 | Y | Y |
| 3 | PINDIRS (dst, RP2350 only; RP2040 reserved) | NULL (src) |
| 4 | EXEC | reserved (src) |
| 5 | PC | STATUS |
| 6 | ISR (resets ISR shift counter to 0) | ISR |
| 7 | OSR (resets OSR shift counter to 0) | OSR |

op: 00 none, 01 invert `~`, 02 bit-reverse `::` (bit n ← bit 31−n), 11
reserved (both sources agree; pioasm disassembler marks op 3 reserved).

- `nop` is the alias `mov y, y` — **not a distinct encoding** (pioasm
  `pio_types.h:480-482`).
- MOV PC = unconditional jump. MOV EXEC behaves like OUT EXEC: executee
  next cycle, MOV's own delay ignored, shared instruction latch.
- STATUS is all-ones/all-zeros per `EXECCTRL.STATUS_SEL` (bits 6:5):
  0 = TXLEVEL (TX FIFO level < N), 1 = RXLEVEL (RX FIFO level < N),
  2 = IRQ (indexed flag raised, RP2350); N = STATUS_N (bits 4:0);
  STATUS_N 0x08+n / 0x10+n select PREV/NEXT PIO flags (DS §11.7 Table 996;
  pioasm `.mov_status irq set N [prev/next]` encodes N_final = param*8 +
  irq, `pio_assembler.cpp:182-191`).
- MOV into OSR/ISR while autopull/autopush enabled: MOV into OSR is never
  overwritten by autopull (MOV updates the counter); other MOV-from/to-OSR
  under autopull is partially undefined (DMA race) (DS §11.5.4).
- MOV never stalls (no FIFO interaction in the general class).

### 3.7 MOV put/get — RP2350 FIFO-aux encodings (class 0x4)

- PUT: `100 | delay/ss | 0 0 0 | 1[4] | IdxI[3] | 0[2] | Index[1:0]`
- GET: `100 | delay/ss | 1 0 0 | 1[4] | IdxI[3] | 0[2] | Index[1:0]`

Semantics (DS §11.4.8, §11.4.9):

- PUT writes ISR into the RX FIFO storage register selected by Index;
  GET reads the selected storage register into OSR (clearing the OSR shift
  counter, as any MOV-to-OSR).
- Index selection: IdxI=0 (pioasm encoding 0) → index taken from Y
  (bits [1:0]); IdxI=1 (pioasm `8 | idx`) → literal index 0–3. pioasm
  accepts literal 0–7 and masks `idx & 3` (`get_push_get_index`,
  `pio_assembler.cpp:310-320`); datasheet says non-zero index with IdxI=0
  (Y mode) is reserved/undefined.
- PUT requires `FJOIN_RX_PUT`, GET requires `FJOIN_RX_GET`; otherwise
  undefined. PUT mode: system reads the storage via `RXFx_PUTGET0..3`
  (status regs), SM writes. GET mode: system writes (control regs), SM
  reads. Both set: SM-only scratch, no system access. RX FIFO storage has
  one read and one write port, each owned by exactly one of (system, SM).
- Autopush must not be enabled with FJOIN_RX_PUT/GET (undefined) (DS
  §11.5.4.1 IMPORTANT; pioasm rejects autopush in txput/txget/putget
  configs, `pio_assembler.cpp:228-234`).
- pioasm validation: `mov rxfifo[idx], isr` only with src=ISR and config
  txput/putget; `mov osr, txfifo[idx]` only with dst=OSR and config
  txget/putget (`instr_mov::pre_validate`, `pio_assembler.cpp:328-344`).
  Disassembler: class 0x4 with arg2 bit 4 set is FIFO-aux; any other
  nonzero arg2 in class 0x4 is reserved (`pio_disassembler.cpp:89-118`) —
  see §14.2.

### 3.8 IRQ — `110 | delay/ss | 0[7] | Clr[6] | Wait[5] | idxmode[4:3] | index[2:0]`

Set (default) or clear (Clr=1) the flag selected by index. Clr=1 ⇒ Wait bit
has no effect, never stalls. Wait=1 (`irq N wait`): set the flag, then
**stall** until the flag is cleared again (by another SM or the system);
delay cycles only begin after the wait elapses. `irq N` (nowait, pioasm
modifier 0) never stalls. Modifier 3 (arg1 bit 2) reserved (pioasm
disassembler).

IdxMode (b4:3) — identical decode for the IRQ instruction's b4:3+b2:0 and
WAIT-IRQ's b4:3+b2:0 (§3.2):
- 00: 3-bit index into this PIO block's 8 flags.
- 01 PREV: flag of the next-lower-numbered PIO (wraps to highest).
- 10 REL: SM id (0–3) added to the flag index mod-4 on the two LSBs (bit 2
  unaffected) — lets 4 SMs share one program with distinct flags.
- 11 NEXT: flag of the next-higher-numbered PIO (wraps to PIO0).

Cross-PIO flags are visible to all SMs the next cycle, no delay penalty (DS
§11.1.1). Cross-PIO sync with divided clocks requires equal divisors and
simultaneous `CTRL.NEXTPREV_CLKDIV_RESTART`. pioasm syntax: `irq
set/nowait/wait/clear [prev|next|rel] N`; `rel`+`prev`/`next` rejected.

### 3.9 SET — `111 | delay/ss | dst[7:5] | data[4:0]`

Write 5-bit immediate. Dsts: 000 PINS, 001 X (data in 5 LSBs, rest zero),
010 Y (same), 100 PINDIRS; 011/101/110/111 reserved (both sources agree;
pioasm disassembler marks them reserved). SET pin mapping (SET_BASE) is
independent of OUT's. Never stalls.

## 4. Delay / side-set

Bits 12:8 of every instruction. Field = `delay | (sideset <<
(5 − sideset_bits_including_opt))` (pioasm `instruction::encode`); the top
`PINCTRL.SIDESET_COUNT` (0–5, **inclusive of the enable bit if present**)
MSBs are side-set, remaining LSBs are delay (DS §11.4.1, §11.5.1).

- `EXECCTRL.SIDE_EN` (bit 30): if 1, the MSB of the side-set field is a
  per-instruction **enable** bit — side-set occurs only when it is high;
  with enable=0 the entire 5-bit field is pure delay (pioasm: `opt`
  programs without `side N` force bit 4 to 0). Max data bits drop to 4.
- SIDESET_COUNT=5 ⇒ no delay bits; 0 ⇒ no side-set. Max side value
  2^N − 1; delay_max = 2^(5−bits_including_opt) − 1 (31 with no side-set).
- `EXECCTRL.SIDE_PINDIR` (bit 29): side-set writes pin **directions**
  instead of levels (pioasm `.side_set pindirs`).
- Side-set LSB maps to `PINCTRL.SIDESET_BASE`, higher bits to higher pins
  (wrap after GPIO31).
- **Side-set takes effect on the first cycle of the instruction even if it
  stalls** (DS §11.5.1 NOTE, §11.2.5 NOTE). Delay cycles are inserted
  **after** execution completes (for stalling instructions, after the stall
  clears) and before the next instruction.
- If side-set overlaps an OUT/SET by the same SM in the same cycle,
  **side-set wins** on the overlapping pins.
- pioasm: without `opt`, every instruction must specify `side`
  (`program::add_instruction`, `pio_assembler.cpp:46-50`).
- SIDE_EN=1 with SIDESET_COUNT=0/1 interaction not fully pinned down by
  either source — §14.8.

## 5. Shifters, counters, autopush/autopull

(DS §11.2.3, §11.2.4, §11.5.4.)

- OSR shifts data out (1–32 bits per OUT), fills with zeroes as it empties;
  reloaded from TX FIFO by PULL or autopull. ISR shifts data in; cleared to
  zeros on push/autopush.
- Directions independently configurable: `SHIFTCTRL.OUT_SHIFTDIR` (bit 19,
  reset 1 = right), `IN_SHIFTDIR` (bit 18, reset 1 = right; right-shift ⇒
  data enters at the MSB end).
- Two saturating 6-bit shift counters (0–32):
  - Reset / `CTRL.SM_RESTART`: ISR counter ← 0, OSR counter ← 32 ("full").
  - OUT: OSR counter += count (sat 32). IN: ISR counter += count (sat 32).
  - PULL / autopull: OSR counter ← 0. PUSH / autopush: ISR counter ← 0.
  - MOV to OSR/ISR: respective counter ← 0. `OUT ISR,n`: ISR counter ← n.
- Thresholds `SHIFTCTRL.PULL_THRESH` (bits 29:25), `PUSH_THRESH`
  (bits 24:20); 0 encodes 32; range 1–32.
- **Autopull** (bit 17): between OUTs, whenever OSR counter ≥ threshold and
  TX FIFO non-empty, OSR is refilled (can happen on any non-OUT cycle). On
  an OUT cycle the refill/stall rules are as in §3.4.
- **Autopush** (bit 16): on IN reaching threshold, push in the same cycle
  (stall if RX FIFO full), clear ISR and counter — one cycle unless
  stalled.
- Autopush incompatible with FJOIN_RX_PUT/GET (§3.7).

## 6. FIFOs and join modes

(DS §11.2.4.4, §11.5.3, §11.7; pioasm `pio_enums.h:12-19`.)

- Per SM: 4-deep 32-bit TX + 4-deep RX (`DBG_CFGINFO.FIFO_DEPTH` = 4).
- `SHIFTCTRL.FJOIN_RX` (bit 31): RX steals TX storage ⇒ 8-deep RX, TX
  disabled (FSTAT reports TX both full and empty). `FJOIN_TX` (bit 30):
  converse. Both set ⇒ both unavailable. Changing any FJOIN bit
  flushes/discards FIFO contents.
- `FJOIN_RX_PUT` (bit 15) / `FJOIN_RX_GET` (bit 14) — RP2350 new: RX
  storage becomes 4 random-access registers (§3.7). Setting either clears
  FJOIN_TX and FJOIN_RX. pioasm `.fifo` configs: `txrx | tx | rx | txput |
  txget | putget` (aux modes v1-only).
- System interface: writing TXFx pushes (write-on-full dropped, sticky
  `FDEBUG.TXOVER`); reading RXFx pops (read-on-empty returns undefined
  data, sticky `FDEBUG.RXUNDER`).
- `FSTAT`: TXEMPTY/TXFULL/RXEMPTY/RXFULL per SM. `FLEVEL`: per-SM TX and RX
  levels. `FDEBUG` sticky flags: `TXSTALL` (stall on empty TX during
  blocking PULL or autopull-OUT), `TXOVER`, `RXUNDER`, `RXSTALL` (stall on
  full RX during blocking PUSH / autopush-IN, or nonblocking PUSH to full).
- DREQs: 1 word/clock DMA throughput; DREQ latency one cycle less than
  RP2040 (DS §11.1.1).

## 7. Registers (field-by-field)

(DS §11.7.) PIO0 base 0x50200000, PIO1 0x50300000, PIO2 exists (datasheet
table lists the first two).

### Block-level

- `CTRL` (0x000):
  - 3:0 `SM_ENABLE`;
  - 7:4 `SM_RESTART` — clears shift counters, ISR contents, delay counter,
    WAIT-on-IRQ state, stalled forced instruction, sticky pin writes;
    **not** OSR or X/Y;
  - 11:8 `CLKDIV_RESTART` — restart divider to phase 0 (free-running
    otherwise; simultaneous restarts with equal divisors ⇒ lockstep);
  - 19:16 `PREV_PIO_MASK`, 23:20 `NEXT_PIO_MASK`, 24
    `NEXTPREV_SM_ENABLE`, 25 `NEXTPREV_SM_DISABLE` (disable wins), 26
    `NEXTPREV_CLKDIV_RESTART` (all RP2350-new: apply the CTRL ops to
    neighbouring PIOs; neighbour links severed across secure/non-secure
    boundaries).
- `IRQ` (0x030): 8 SM IRQ flags, write-1-to-clear. `IRQ_FORCE` (0x034):
  write-1 sets flags (affects internal state, unlike INTF).
- `INPUT_SYNC_BYPASS` (0x038): per-GPIO, 1 = bypass 2-FF input
  synchroniser.
- `DBG_PADOUT` (0x03c) / `DBG_PADOE` (0x040): PIO's driven levels /
  output enables.
- `DBG_CFGINFO` (0x044): VERSION (31:28; 1 = RP2350), IMEM_SIZE (21:16) =
  32, SM_COUNT (11:8) = 4, FIFO_DEPTH (5:0) = 4.
- `INSTR_MEM0..31` (0x048+): 16-bit write-only instruction slots.
- `GPIOBASE` (0x168): bit 4 only, values 0 or 16.
- Interrupts: `INTR` (SM IRQ flags bits 15:8 — RP2350 exposes all 8 — plus
  SMx_TXNFULL/RXNEMPTY bits 7:0); `IRQ0/IRQ1 _INTE/_INTF/_INTS`
  (enable/force/status; force does not affect internal state).
- `RXFx_PUTGET0..3` (0x128+): random system access to RX FIFO storage in
  PUT/GET modes (§3.7).

### Per-SM (stride 0x18 from 0x0c8)

- `SMx_CLKDIV`: INT (31:16; 0 means 65536; if INT=0 FRAC must be 0), FRAC
  (15:8). SM clock = sysclk / (INT + FRAC/256); 16.8 fixed-point with
  first-order delta-sigma on FRAC (DS §11.5.5). Divisor range 1–65536 in
  1/256 steps; divisor 1 = every cycle. pioasm `.clock_div` accepts
  1 ≤ X < 65536 (`set_clock_div`, `pio_assembler.cpp:64-74`).
- `SMx_EXECCTRL`:
  - 31 `EXEC_STALLED` (RO): forced INSTR instruction stalled and latched;
  - 30 `SIDE_EN`, 29 `SIDE_PINDIR`, 28:24 `JMP_PIN`;
  - 23:19 `OUT_EN_SEL` + 18 `INLINE_OUT_EN`: one bit of OUT data as an
    auxiliary per-pin write enable;
  - 17 `OUT_STICKY`: continuously assert the most recent OUT/SET pin
    write;
  - 16:12 `WRAP_TOP`, 11:7 `WRAP_BOTTOM` (absolute addresses);
  - 6:5 `STATUS_SEL`, 4:0 `STATUS_N` (§3.6).
- `SMx_SHIFTCTRL` (bits): 31 FJOIN_RX, 30 FJOIN_TX, 29:25 PULL_THRESH,
  24:20 PUSH_THRESH, 19 OUT_SHIFTDIR, 18 IN_SHIFTDIR, 17 AUTOPULL,
  16 AUTOPUSH, 15 FJOIN_RX_PUT, 14 FJOIN_RX_GET, 4:0 IN_COUNT
  (RP2350-new; 0 = 32 / no masking).
- `SMx_ADDR` (0x0d4+): current PC, bits 4:0, RO.
- `SMx_INSTR` (0x0d8+): write = execute immediately (delay ignored,
  bypasses clock divider, PC not advanced unless the instruction changes
  it); may stall and is latched (EXEC_STALLED); shares the instruction
  latch with OUT/MOV EXEC (can overwrite an in-progress executee). Read =
  instruction currently addressed by PC.
- `SMx_PINCTRL`: 31:29 SIDESET_COUNT (0–5, includes enable bit), 28:26
  SET_COUNT (0–5, reset 5), 25:20 OUT_COUNT (0–32), 19:15 IN_BASE, 14:10
  SIDESET_BASE, 9:5 SET_BASE, 4:0 OUT_BASE. All pin ranges wrap after
  GPIO31.

### Directives → registers (pioasm `program`, `pio_types.h:269-378`)

`.origin` load address; `.pio_version 0/1` (RP2040/RP2350 syntax gating);
`.wrap`/`.wrap_target` → WRAP_TOP/WRAP_BOTTOM (defaults: wrap = last
instruction, target = first); `.side_set N [opt] [pindirs]`; `.in P [,
right][, autopush @T]` → IN_BASE/IN_COUNT/IN_SHIFTDIR/PUSH_THRESH/AUTOPUSH
(v0 requires count 32; v1 allows 1–32); `.out …` → OUT_SIDE; `.set_count`;
`.fifo …` → FJOIN bits; `.mov_status`; `.clock_div`.

## 8. PC update and wrap

(DS §11.2.2, §11.5.2.) After executing an instruction:

1. JMP taken ⇒ PC ← target.
2. Else if PC == WRAP_TOP ⇒ PC ← WRAP_BOTTOM (free, 0-cycle jump).
3. Else PC ← PC + 1, or 0 when the current value is 31.

WRAP_TOP/BOTTOM are absolute instruction-memory addresses (adjust for
program load offset).

## 9. Stalling summary

(DS §11.2.5; confirmed by pioasm validation logic.)

Stall causes:
- WAIT condition not met.
- Blocking PULL with TX FIFO empty; blocking PUSH with RX FIFO full.
- IRQ with Wait=1, until the flag clears.
- OUT with autopull when the OSR counter had reached the threshold at the
  start of the cycle and refill is not possible (TX empty, or the
  same-cycle empty-OSR refill restriction) — §14.4.
- IN with autopush when the threshold is reached and the RX FIFO is full.

While stalled: PC does not advance; the instruction re-executes the next
cycle; delay cycles do not elapse during the stall; side-set fired once on
the first cycle. `irq` nowait, `irq clear`, JMP, MOV (general), SET never
stall.

## 10. GPIO mux, mapping, synchronizers

(DS §11.2.6, §11.5.6.)

- PIO keeps a 32-bit output-level and a 32-bit output-enable register for
  its GPIO window. Per-cycle writers per SM: OUT (≤32 bits at OUT_BASE,
  OUT_COUNT pins), SET (≤5 bits at SET_BASE), side-set (≤5 bits at
  SIDESET_BASE); applied to levels or directions per instruction /
  SIDE_PINDIR.
- **Priority (per GPIO, per cycle, separately for level and direction):**
  among the 4 SMs the **highest-numbered SM** wins; within one SM
  **side-set beats OUT/SET** on overlapping pins; otherwise previous value
  holds.
- Input mapping: IN data bus = GPIO inputs right-rotated by IN_BASE (LSB =
  IN_BASE pin, wrap after 31). `SHIFTCTRL.IN_COUNT` masks pins above the
  count to zero on IN PINS / WAIT PIN / MOV x,PINS (0 = 32 / unmasked).
  WAIT GPIO uses absolute numbers, not the rotated bus.
- 2-FF input synchronizer per GPIO (two cycles latency); per-GPIO bypass
  via `INPUT_SYNC_BYPASS` at the user's risk.
- pioasm evidence for the RP2350 input bank structure: absolute-GPIO
  references in one program must all fall in a single 32-pin bank
  (0–31 or 16–47) (`used_gpio_ranges`, `pio_assembler.cpp:404-420`).
- Constant-0/1 GPIO output override is a pads/QOI-level feature outside
  Chapter 11; PIO-side observation via DBG_PADOUT/DBG_PADOE.

## 11. Forced and EXEC'd instructions

(DS §11.2.2, §11.5.7.) Instruction sources besides memory: SMx_INSTR
writes (immediate, delay ignored, clock divider bypassed, PC not
advanced), OUT EXEC and MOV EXEC (executee runs the following cycle via
the shared internal instruction latch; the executee cycle does not advance
PC).

## 12. RP2350 vs RP2040 differences

(DS §11.1.1; pioasm `.pio_version` gating.)

New registers/controls:
- `DBG_CFGINFO.VERSION` = 1 (RP2040 reserved-0).
- `GPIOBASE` (>32 GPIOs per block).
- `CTRL.NEXT/PREV_PIO_MASK`, `NEXTPREV_SM_ENABLE/DISABLE/CLKDIV_RESTART`.
- `SMx_SHIFTCTRL.IN_COUNT` (mask unneeded IN-mapped pins).
- `IRQ0/1_INTE` expose all 8 SM IRQ flags (RP2040: lower 4 only).
- `RXFx_PUTGET0..3` + `FJOIN_RX_PUT`/`FJOIN_RX_GET`.

New instruction features:
- WAIT source 11 (JMPPIN), offset 0–3, independent of IN mapping.
- MOV destination PINDIRS (RP2040: not supported).
- MOV source STATUS can select SM IRQ flags (STATUS_SEL=2, with
  PREV/NEXT).
- IRQ/WAIT/STATUS cross-PIO indexing (PREV/NEXT IdxModes); cross-PIO IRQs
  visible next cycle, no penalty.
- MOV put/get encodings in the class-0x4 space (RP2040 treats nonzero
  arg2 there as undefined/reserved).

Security: non-secure PIOs observe only non-secure GPIOs (secure GPIO reads
0); cross-PIO links severed across security boundaries.

General: 3 PIO blocks (was 2), improved GPIO I/O delay and skew, DREQ
latency reduced by one cycle.

## 13. RTL-decoder reservations (both sources)

Reserved/undefined encodings the RTL must treat explicitly: IN sources
100/101; SET dsts 011/101/110/111; MOV op 11; MOV src 100; IRQ modifier 3;
WAIT JMPPIN index > 3 (arg2[4:2] ≠ 0); PUSH/PULL arg2 ≠ 0 other than the
FIFO-aux forms; FIFO-aux with IdxI=0 and Index ≠ 0.

## 14. Open questions (cross-check results)

Each item lists both sources' claims and its resolution status.

### 14.1 Instruction memory size: 32 vs 36 — **RESOLVED: 32**

- Datasheet: 32 instructions everywhere (Figure 44, §11.2.2, §11.2.8,
  `INSTR_MEM0..31` in §11.7; PC wrap "0 when the current value is 31",
  §11.5.2; JMP address 5 bits).
- pioasm research doc claimed "RP2350 has 36 per block, but pioasm still
  limits to 32 for compatibility".
- **Resolution:** inspected the local clone
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
- **Resolution:** decode rule for class 0x4: if arg2[4]=1 → FIFO-aux MOV
  (arg2[3]=IdxI, arg2[1:0]=Index; b7 = GET); else if arg2 ≠ 0 → reserved
  (RP2040) / undefined; else PUSH (b7=0) / PULL (b7=1), with b6 = IfF/IfE,
  b5 = Block. Both sources agree on this once the pioasm encoding is
  mapped onto the datasheet bit positions; the datasheet's "b4=1, b3=IdxI,
  b2=0" matches pioasm's `0x10 | (idx ? 8 | idx&3 : 0)`.

### 14.3 WAIT IRQ index field split — **RESOLVED (rule), wording ambiguity noted**

- Datasheet §11.4.3.2 says the IRQ index is decoded "down from the two
  MSBs" of the 5-bit field; the WAIT encoding table shows Index as b4:0
  with Source at b6:5 — two slightly different presentations.
- pioasm encodes `wait irq` as arg2 = irq_index | (irq_type << 3), i.e.
  b4:3 = mode, b2:0 = index — identical to the IRQ instruction.
- **Resolution:** effective rule = b4:3 IdxMode, b2:0 flag index (same as
  IRQ instruction), confirmed by pioasm's encoder and disassembler. The
  datasheet's "two MSBs of the 5-bit field" is the same rule in different
  words; no behavioural discrepancy.

### 14.4 Autopull OUT-cycle stall boundary — **OPEN (for cycle contract)**

- DS §11.2.5 lists the stall as "OUT with autopull when the OSR has
  reached its shift threshold" (ambiguous about before/after this OUT's
  shift).
- DS §11.5.4.2 pseudocode shows the OUT-cycle stall occurs when the
  threshold was already reached **at the start of the cycle** (refill
  instead of shift; else shift, then refill if threshold now reached).
- pioasm has no cycle-timing information.
- **Status:** adopt the §11.5.4.2 rule (stall only if threshold already
  reached at cycle start and refill impossible); the precise
  cycle-boundary contract is to be pinned in `docs/cycle-contract.md`
  (Phase 1 KANBAN item).

### 14.5 JMP `x--`/`y--` decrement condition — **RESOLVED (datasheet rule)**

- Datasheet §11.4.2: "`X--`/`Y--` always decrement; branch decided on the
  pre-decrement value."
- pioasm research doc phrased it as "decrement occurs when the condition
  is true" / "on taken-condition evaluation".
- **Resolution:** the datasheet is primary and explicit: decrement always
  happens (taken or not); the branch tests the pre-decrement value. The
  two coincide whenever the instruction is executed; the difference only
  matters for a not-taken `x--` (X≠0 is the taken case; a not-taken `x--`
  means X==0, decrementing 0 wraps to 0xFFFFFFFF — datasheet says this
  happens). RTL: unconditional decrement, test pre-decrement value.

### 14.6 `in null` / `out null` shifting — **RESOLVED (datasheet), note kept**

Both sources: NULL is a plain source/destination encoding (0x3), no
special casing in pioasm; datasheet semantics mean the ISR/OSR and its
counter still shift (`OUT NULL 32` is the documented way to discard the
OSR). RTL must implement NULL as shift-but-discard.

### 14.7 Non-blocking PULL on empty FIFO and the OSR counter — **RESOLVED by implication**

- Datasheet: non-blocking PULL on empty FIFO behaves as `MOV OSR, X`, and
  separately MOV-to-OSR clears the OSR shift counter; the datasheet does
  not explicitly restate the counter clear for this case.
- **Resolution:** the RTL should clear the OSR shift counter (MOV OSR
  semantics apply). Flagged as an inference, not verbatim datasheet text.

### 14.8 SIDE_EN with SIDESET_COUNT edge values — **OPEN**

- Datasheet does not specify the exact interaction of SIDE_EN=1 with
  SIDESET_COUNT=0 or 1, nor the bit-level layout beyond "MSBs of the
  5-bit field".
- pioasm confirms the layout (enable at bit 4 when `opt`; data shifted to
  the top; with enable=0 all 5 bits are delay) but cannot answer
  SIDESET_COUNT=0 with SIDE_EN=1 (nonsensical configuration).
- **Status:** RTL should define SIDESET_COUNT=0 as "no side-set" and
  ignore SIDE_EN; to be confirmed against silicon or the cycle contract.

### 14.9 RP2040 carry-over text in DBG_PADOUT/DBG_PADOE — noted

Datasheet notes for DBG_PADOUT/PADOE reference RP2040's 30 GPIOs for the
MSBs being 0; on RP2350 the window is 32 bits per GPIOBASE. Treat as
carry-over text; RP2350 rule: 32-bit window, bits above the configured
bank read 0.

### 14.10 STATUS_N encoding width — minor, resolved

DS Table 996 gives STATUS_N encodings 0x08+n / 0x10+n for PREV/NEXT IRQ
status; pioasm `.mov_status irq` encodes N_final = param*8 + irq
(`pio_assembler.cpp:182-191`). Consistent; documented in §3.6.

# RP2350 PIO specification — extracted from the datasheet

Reference material for RTL designers. Primary source: RP2350 datasheet,
Chapter 11 "PIO" (§11.1–§11.7). Provenance of the PDF is recorded in
`docs/spec-sources.md`. Section references below ("§11.x") are datasheet
sections; register references are from §11.7.

---

## 1. Block overview (§11.1, §11.2.8)

- RP2350 contains **3 identical PIO blocks** (up from 2 on RP2040) — 12 state
  machines total (§11.1.1).
- Each block has **4 state machines** executing from a **shared instruction
  memory of 32 instructions** (16 bits each). Memory is a 1-write, 4-read
  register file so all 4 SMs can fetch simultaneously without stalling;
  the system has write-only access (§11.2.8, Figure 44, §11.2.2).
  Note: the KANBAN mentions a "36-instruction memory" — the datasheet
  consistently says 32 (Figure 44, §11.2.2, INSTR_MEM0..31 in §11.7);
  `DBG_CFGINFO.IMEM_SIZE` (bits 21:16) reports it at runtime (§11.7).
- Each state machine has (§11.1):
  - Two 32-bit shift registers (ISR, OSR), either direction, any shift count.
  - Two 32-bit scratch registers X, Y.
  - 4×32-bit FIFO in each direction (TX/RX), joinable to 8×32 one direction.
  - Fractional clock divider, 16 integer + 8 fractional bits.
- PIO maps to up to 32 GPIOs per block (RP2350 has 30 user GPIOs);
  `GPIOBASE` (bit 4, values 0 or 16 only) relocates the 32-GPIO window
  (§11.1.1, §11.7).
- Execution model: fetch, decode, execute one instruction per system clock
  cycle; instructions take exactly 1 cycle unless they stall (§11.2.2).

## 2. Instruction encoding (§11.4.1, Table 980)

Instructions are 16 bits. Top 3 bits select the major opcode; bits 12:8 are
the shared Delay/side-set field.

| Instruction | b15:13 | b12 | b7 | b6 | b5 | b4:0 (or as noted) |
|---|---|---|---|---|---|---|
| JMP         | 000 | delay/ss | Condition b7:5 | Address b4:0 |
| WAIT        | 001 | delay/ss | Pol b7 | Source b6:5 | Index b4:0 |
| IN          | 010 | delay/ss | Source b7:5 | Bit count b4:0 |
| OUT         | 011 | delay/ss | Destination b7:5 | Bit count b4:0 |
| PUSH        | 100 | delay/ss | 0 b7 | IfF b6 | Blk b5 | 0 b4:0 |
| MOV (to RX, "put") | 100 | delay/ss | 0 b7 | 0 b6 | 0 b5 | 1 b4 | IdxI b3 | 0 b2 | Index b1:0 |
| PULL        | 100 | delay/ss | 1 b7 | IfE b6 | Blk b5 | 0 b4:0 |
| MOV (from RX, "get") | 100 | delay/ss | 1 b7 | 0 b6 | 0 b5 | 1 b4 | IdxI b3 | 0 b2 | Index b1:0 |
| MOV         | 101 | delay/ss | Destination b7:5 | Op b4:3 | Source b2:0 |
| IRQ         | 110 | delay/ss | 0 b7 | Clr b6 | Wait b5 | IdxMode b4:3 | Index b2:0 |
| SET         | 111 | delay/ss | Destination b7:5 | Data b4:0 |

The datasheet calls this **nine instructions** (JMP, WAIT, IN, OUT, PUSH,
PULL, MOV, IRQ, SET — §11.2.1); the two RX-FIFO MOV variants are RP2350-new
encodings sharing the 100 opcode space with PUSH/PULL (§11.4.8, §11.4.9).

All instructions execute in one cycle (§11.4.1).

## 3. Instruction semantics

### 3.1 JMP (§11.4.2)

- Encoding: `000 | delay/ss[12:8] | cond[7:5] | addr[4:0]`.
- Set PC to Address if Condition true, else no-op. Delay takes effect on
  both taken and not-taken jumps, after condition evaluation and PC update.
- Conditions (b7:5):
  - 000 always; 001 `!X` (X==0); 010 `X--` (X!=0 pre-decrement); 011 `!Y`;
    100 `Y--`; 101 `X != Y`; 110 `PIN`; 111 `!OSRE` (OSR not empty).
- `X--`/`Y--` always decrement; branch decided on the pre-decrement value.
- `JMP PIN` uses `EXECCTRL.JMP_PIN` (bits 28:24), independent of IN mapping;
  branch taken if the pin is high.
- `!OSRE` compares bits-shifted-out since last PULL against
  `SHIFTCTRL.PULL_THRESH` (same threshold as autopull).
- Address is absolute within the 32-word instruction memory.

### 3.2 WAIT (§11.4.3)

- Encoding: `001 | delay/ss | pol[7] | source[6:5] | index[4:0]`.
- Stall until condition met; delay cycles begin only after the wait
  completes (§11.4.3.2, §11.2.5).
- Polarity: 1 = wait for 1; 0 = wait for 0.
- Sources:
  - 00 GPIO: absolute GPIO index, unaffected by IN mapping.
  - 01 PIN: IN mapping applied first; pin = (PINCTRL.IN_BASE + Index) mod 32.
  - 10 IRQ: PIO IRQ flag selected by Index (with IdxMode-like decode, below).
  - 11 JMPPIN (RP2350 new): pin = (PINCTRL.JMP_PIN + Index) mod 32, Index
    must be 0–3; other values reserved.
- WAIT on IRQ: the flag index decodes like the IRQ instruction's index field
  (two MSBs of the 5-bit field are IdxMode): 00 = this PIO, 01 PREV
  (next-lower PIO, wrapping), 10 REL (add SM id mod 4 to the two LSBs), 11
  NEXT (next-higher PIO, wrapping). If polarity is 1, the flag is cleared by
  the SM when the wait completes.
- Caution (datasheet): do not use `WAIT 1 IRQ x` on flags routed to the
  interrupt controller (race with the handler).

### 3.3 IN (§11.4.4)

- Encoding: `010 | delay/ss | source[7:5] | bitcount[4:0]`.
- Shift Bit count (1–32, 32 encoded as 00000) bits of Source into ISR;
  direction per `SHIFTCTRL.IN_SHIFTDIR`; ISR shift counter increments by
  Bit count, saturating at 32.
- Sources: 000 PINS, 001 X, 010 Y, 011 NULL (zeros), 100/101 reserved,
  110 ISR, 111 OSR.
- IN always uses the LSBs of the source data (e.g. IN PINS uses pins
  IN_BASE, IN_BASE+1, ... regardless of shift direction; the bit order of
  the input data does not depend on shift direction).
- With autopush enabled and threshold reached, IN simultaneously pushes ISR
  to RX FIFO (one cycle total); stalls if RX FIFO full. Autopush clears ISR
  to zero and clears the input shift count (§11.4.4.2, §11.5.4).

### 3.4 OUT (§11.4.5)

- Encoding: `011 | delay/ss | destination[7:5] | bitcount[4:0]`.
- Shift Bit count (1–32, 32 encoded as 00000) bits out of OSR to
  Destination; OSR shift counter += count, saturating at 32.
- Destinations: 000 PINS, 001 X, 010 Y, 011 NULL, 100 PINDIRS, 101 PC,
  110 ISR (also sets ISR shift counter to Bit count), 111 EXEC.
- A 32-bit value is written to the destination: lower Bit count bits from
  OSR (LSBs if right-shift, MSBs if left-shift), remainder zero.
- PINS/PINDIRS use the OUT pin mapping (§11.5.6).
- With autopull enabled and threshold reached: OSR refilled from TX FIFO,
  output shift count cleared; stalls if TX FIFO empty (§11.5.4.2).
- OUT EXEC: the OUT executes this cycle; the shifted-out instruction
  executes next cycle; delay on the OUT itself is ignored (executee may
  delay normally). No restriction on executee type; only one OUT per cycle.
- OUT PC = unconditional jump to the shifted-out address.

### 3.5 PUSH / PULL (§11.4.6, §11.4.7)

- PUSH encoding: `100 | delay/ss | 0 | IfF b6 | Blk b5 | 0 b4:0`.
- PULL encoding: `100 | delay/ss | 1 | IfE b6 | Blk b5 | 0 b4:0`.
- PUSH: write ISR to RX FIFO (one 32-bit word), clear ISR to zeros.
  - IfFull=1: no-op unless input shift count >= PUSH_THRESH.
  - Block=1: stall if RX FIFO full. Block=0 on a full FIFO: FIFO unchanged,
    ISR still cleared, `FDEBUG.RXSTALL` set (data lost).
  - Undefined when `FJOIN_RX_PUT` or `FJOIN_RX_GET` is set (use MOV
    put/get instead) (§11.4.6.2 NOTE).
- PULL: load 32-bit word from TX FIFO into OSR.
  - IfEmpty=1: no-op unless output shift count >= PULL_THRESH.
  - Block=1: stall if TX FIFO empty. Block=0 on empty FIFO: behaves as
    `MOV OSR, X` (copies scratch X to OSR).
  - With autopull enabled, a PULL is a no-op when the OSR is full (acts as
    a fence; `OUT NULL, 32` explicitly discards OSR) (§11.4.7.2 NOTE).
- pioasm defaults: Block=1, IfFull/IfEmpty=0.

### 3.6 MOV (general) (§11.4.10)

- Encoding: `101 | delay/ss | dest[7:5] | op[4:3] | src[2:0]`.
- Destination: 000 PINS (OUT mapping), 001 X, 010 Y, 011 PINDIRS (OUT
  mapping; not supported on PIO v0/RP2040), 100 EXEC, 101 PC, 110 ISR
  (resets ISR shift counter to 0), 111 OSR (resets OSR shift counter to 0).
- Op: 00 none, 01 bitwise invert, 10 bit-reverse (bit n ← bit 31−n), 11
  reserved.
- Source: 000 PINS (IN mapping), 001 X, 010 Y, 011 NULL, 100 reserved,
  101 STATUS, 110 ISR, 111 OSR.
- MOV PC = unconditional jump. MOV EXEC behaves as OUT EXEC (executee next
  cycle, delay on the MOV ignored).
- STATUS is all-ones or all-zeros per `EXECCTRL.STATUS_SEL` (bits 6:5):
  0 TXLEVEL (TX FIFO level < N), 1 RXLEVEL (RX FIFO level < N), 2 IRQ
  (indexed flag raised); N = `STATUS_N` (bits 4:0); STATUS_N 0x08+n and
  0x10+n select PREV/NEXT PIO IRQ flags (§11.7 Table 996).
- `MOV dst, PINS` reads pins via IN mapping masked to `SHIFTCTRL.IN_COUNT`
  bits (LSB = IN_BASE pin, wrapping after 31; bits above the mask read 0).
- MOV OSR/ISR clears the respective shift counter (§11.2.4.2).

### 3.7 MOV (to RX) / MOV (from RX) — RP2350 new "put/get" (§11.4.8, §11.4.9)

- PUT encoding: `100 | delay/ss | 0 0 0 1 | IdxI b3 | 0 | Index b1:0`.
- GET encoding: `100 | delay/ss | 1 0 0 1 | IdxI b3 | 0 | Index b1:0`.
- PUT writes ISR into RX FIFO storage register selected by Index b1:0
  (IdxI=1) or Y b1:0 (IdxI=0; non-zero Index encodings then reserved/
  undefined). GET reads the selected RX FIFO storage register into OSR
  (clearing the OSR shift counter as a MOV-to-OSR).
- Both require `FJOIN_RX_PUT` / `FJOIN_RX_GET` respectively, else undefined.
- PUT only: system reads the registers via `RXFx_PUTGET0..3` (status
  registers). GET only: system writes them (control registers). Both set:
  SM-only random read/write scratch, system access disabled.
- RX FIFO storage has a single read and single write port, each owned by
  exactly one of (system, SM) at a time.
- Autopush must not be enabled when FJOIN_RX_PUT/GET is set (undefined)
  (§11.5.4.1 IMPORTANT).

### 3.8 IRQ (§11.4.11)

- Encoding: `110 | delay/ss | 0 b7 | Clr b6 | Wait b5 | IdxMode b4:3 |
  Index b2:0`.
- Set (or clear, if Clr=1) the IRQ flag selected by Index. If Clr=1 the
  Wait bit has no effect. If Wait=1, halt until the raised flag is cleared
  again (delay cycles only begin after the wait elapses).
- IdxMode (applies to the 5-bit index field; on the IRQ instruction Index
  is b2:0 and b4:3 is the mode):
  - 00: 3 LSBs index this PIO block's flags.
  - 01 PREV: flag of the next-lower-numbered PIO (wraps to highest).
  - 10 REL: SM id (0–3) added to the flag index via mod-4 addition on the
    two LSBs; bit 2 unaffected. Lets 4 SMs running the same program use
    distinct flags.
  - 11 NEXT: flag of the next-higher-numbered PIO (wraps to PIO0).
- Cross-PIO flags have no delay penalty: an IRQ on one SM is observable to
  all SMs the next cycle (§11.1.1). Cross-PIO sync with divided clocks
  requires equal divisors and simultaneous `CTRL.NEXTPREV_CLKDIV_RESTART`.
- pioasm syntax: `irq set/nowait/wait/clear`, `prev|next`, `rel`.

### 3.9 SET (§11.4.12)

- Encoding: `111 | delay/ss | dest[7:5] | data[4:0]`.
- Destinations: 000 PINS, 001 X (5 LSBs = Data, rest zero), 010 Y (same),
  100 PINDIRS; 011/101/110/111 reserved.
- Writes a 5-bit immediate; SET pin mapping is independent of OUT's.

## 4. Delay / side-set (§11.4.1, §11.5.1)

- Bits 12:8 of every instruction form the Delay/side-set field. The top
  `PINCTRL.SIDESET_COUNT` MSBs (0–5, inclusive of an enable bit if present)
  are side-set; the remaining LSBs (5 − SIDESET_COUNT) encode 0–31 delay
  cycles inserted after the instruction, before the next one executes.
- `EXECCTRL.SIDE_EN` (bit 30): if 1, the MSB of the side-set field is an
  enable — side-set occurs only when it is high; max side-set width drops
  to 4. SIDESET_COUNT is inclusive of the enable bit. SIDESET_COUNT=5 → no
  delay bits; 0 → no side-set.
- `EXECCTRL.SIDE_PINDIR` (bit 29): side-set writes pin directions instead
  of levels.
- Side-set LSB maps to `PINCTRL.SIDESET_BASE`, higher bits to higher pins.
- Side-set takes effect on the first cycle of the instruction even if it
  stalls (§11.5.1 NOTE, §11.2.5 NOTE).
- If side-set overlaps an OUT/SET by the same SM on the same cycle,
  side-set wins in the overlap.

## 5. Shifters, counters, autopush/autopull (§11.2.3, §11.2.4, §11.5.4)

- OSR: shifts data out (1–32 bits per OUT), fills with zeroes as it
  empties, reloaded from TX FIFO by PULL or autopull.
- ISR: shifts data in (1–32 bits per IN), cleared to zeros on push.
- Shift directions independently configurable: `SHIFTCTRL.OUT_SHIFTDIR`
  (bit 19, reset 1 = right), `SHIFTCTRL.IN_SHIFTDIR` (bit 18, reset 1 =
  right; data enters from left).
- Two saturating 6-bit shift counters track total bits shifted (0–32):
  - Reset / `CTRL.SM_RESTART`: ISR counter ← 0, OSR counter ← 32.
  - OUT += count (saturate 32); IN += count (saturate 32).
  - PULL or autopull: OSR counter ← 0. PUSH or autopush: ISR counter ← 0.
  - MOV OSR,… / MOV ISR,…: respective counter ← 0. OUT ISR,n: ISR
    counter ← n.
- Thresholds: `SHIFTCTRL.PULL_THRESH` (bits 29:25) and
  `SHIFTCTRL.PUSH_THRESH` (bits 24:20); 0 encodes 32; range 1–32.
- Autopull (`SHIFTCTRL.AUTOPULL`, bit 17): on non-OUT cycles, if OSR
  counter >= threshold and TX FIFO non-empty, refill OSR (can happen at any
  time between two OUTs). On OUT cycles: if counter >= threshold → refill
  if FIFO non-empty and stall this cycle; else shift out, then refill if
  threshold now reached (refill simultaneous with the last shift-out;
  cannot fill an empty OSR and OUT it in the same cycle). An OUT is a data
  fence: never outputs data not written to the FIFO.
- Autopush (`SHIFTCTRL.AUTOPUSH`, bit 16): on IN, if ISR counter >=
  threshold → push (stall if RX FIFO full), clear ISR and counter; single
  cycle unless stalled.
- MOV from/to OSR while autopull enabled is partially undefined (race with
  DMA); MOV into OSR is never overwritten because MOV updates the counter.

## 6. FIFOs (§11.2.4.4, §11.5.3, §11.7)

- Per SM: 4-word-deep 32-bit TX FIFO and 4-word RX FIFO (depth readable
  from `DBG_CFGINFO.FIFO_DEPTH`, bits 5:0).
- `SHIFTCTRL.FJOIN_RX` (bit 31): RX steals TX storage → 8-deep RX, TX
  disabled (reads both full and empty in FSTAT). `FJOIN_TX` (bit 30): the
  converse. Setting both makes both unavailable. Changing any FJOIN bit
  flushes/discards FIFO contents.
- `FJOIN_RX_PUT` (bit 15) / `FJOIN_RX_GET` (bit 14): RP2350-new; repurpose
  RX FIFO storage as 4 random-access registers (see §3.7). Setting either
  clears FJOIN_TX and FJOIN_RX.
- System interface: TXFx writes push (write-on-full dropped, sticky
  `FDEBUG.TXOVER`); RXFx reads pop (read-on-empty returns undefined data,
  sticky `FDEBUG.RXUNDER`).
- Status: `FSTAT` (TXEMPTY/TXFULL/RXEMPTY/RXFULL per SM);
  `FLEVEL` per-SM TX/RX levels; `FDEBUG` sticky TXSTALL (stall on empty TX
  during blocking PULL or autopull OUT), TXOVER, RXUNDER, RXSTALL (stall on
  full RX during blocking PUSH/autopush IN, or nonblocking PUSH to full).
- DREQs support 1 word/clock DMA throughput (DREQ latency reduced by one
  cycle vs RP2040, §11.1.1).

## 7. Registers (§11.7)

PIO0 base 0x50200000, PIO1 0x50300000 (PIO2 also exists; datasheet table
lists the first two). Key block-level registers:

- `CTRL` (0x000): bits 3:0 SM_ENABLE; 7:4 SM_RESTART (clears shift
  counters, ISR contents, delay counter, WAIT-on-IRQ state, stalled forced
  instr, sticky pin writes — not OSR or X/Y); 11:8 CLKDIV_RESTART (restart
  divider phase 0; free-running otherwise, so simultaneous restarts with
  equal divisors give lockstep clocks); 19:16 PREV_PIO_MASK, 23:20
  NEXT_PIO_MASK, 24 NEXTPREV_SM_ENABLE, 25 NEXTPREV_SM_DISABLE (disable
  wins), 26 NEXTPREV_CLKDIV_RESTART (RP2350-new, apply CTRL ops to
  neighbouring PIO; neighbour links severed across secure/non-secure
  boundaries).
- `IRQ` (0x030): 8 SM IRQ flags, write-1-to-clear. `IRQ_FORCE` (0x034):
  write-1 sets flags (affects internal state, unlike INTF).
- `INPUT_SYNC_BYPASS` (0x038): per-GPIO, 1 = bypass the 2-FF input
  synchroniser.
- `DBG_PADOUT` (0x03c), `DBG_PADOE` (0x040): sample PIO's driven levels /
  output enables. `DBG_CFGINFO` (0x044): VERSION (31:28; 1 = RP2350),
  IMEM_SIZE (21:16), SM_COUNT (11:8), FIFO_DEPTH (5:0).
- `INSTR_MEM0..31` (0x048+): 16-bit write-only instruction slots.
- `GPIOBASE` (0x168): bit 4 only, values 0 or 16.
- Interrupts: `INTR` (SM7..SM0 IRQ flags at bits 15:8 — RP2350 exposes all
  eight — plus SMx_TXNFULL/RXNEMPTY at bits 7:0), `IRQ0/IRQ1` `_INTE/_INTF/
  _INTS` (mask/force/status).

Per-SM registers (stride 0x18 from 0x0c8):

- `SMx_CLKDIV`: INT (31:16, 0 means 65536; if INT=0, FRAC must be 0), FRAC
  (15:8). Frequency = sysclk / (INT + FRAC/256); 16.8 fixed point with
  first-order delta-sigma on FRAC (§11.5.5). Divisor range 1–65536 in
  1/256 steps; divisor 1 → clock enable every cycle.
- `SMx_EXECCTRL`:
  - 31 EXEC_STALLED (RO): forced INSTR instruction stalled and latched.
  - 30 SIDE_EN, 29 SIDE_PINDIR, 28:24 JMP_PIN.
  - 23:19 OUT_EN_SEL + 18 INLINE_OUT_EN: use one bit of OUT data as an
    auxiliary per-pin write enable.
  - 17 OUT_STICKY: continuously assert the most recent OUT/SET pin write.
  - 16:12 WRAP_TOP, 11:7 WRAP_BOTTOM (absolute addresses; PC update logic
    below).
  - 6:5 STATUS_SEL, 4:0 STATUS_N (see §3.6).
- `SMx_SHIFTCTRL`: see §5 and §6 for all field bits.
- `SMx_ADDR` (0x0d4+): current PC (bits 4:0, RO).
- `SMx_INSTR` (0x0d8+): write = execute immediately (delay ignored,
  bypasses clock divider, PC not advanced unless the instruction changes
  it); read = instruction currently addressed by PC. A written instruction
  may stall and is latched (EXEC_STALLED); it shares the instruction latch
  with OUT/MOV EXEC (caution: can overwrite an in-progress executee).
- `SMx_PINCTRL`: 31:29 SIDESET_COUNT (0–5, includes enable bit); 28:26
  SET_COUNT (0–5, reset 5); 25:20 OUT_COUNT (0–32); 19:15 IN_BASE; 14:10
  SIDESET_BASE; 9:5 SET_BASE; 4:0 OUT_BASE. All pin ranges wrap after
  GPIO31.
- `RXFx_PUTGET0..3` (0x128+): random system access to RX FIFO storage in
  PUT/GET modes (see §3.7).

## 8. Wrapping and PC update (§11.2.2, §11.5.2)

After executing an instruction, PC updates as:

1. If the instruction is JMP and the condition is true, PC ← target.
2. Else if PC == EXECCTRL.WRAP_TOP, PC ← EXECCTRL.WRAP_BOTTOM.
3. Else PC ← PC + 1, or 0 when the current value is 31.

WRAP_TOP/WRAP_BOTTOM are absolute instruction-memory addresses (adjust for
program load offset). Wrap is a free (0-cycle) jump.

## 9. Stalling (§11.2.5)

Stall causes:
- WAIT condition not met.
- Blocking PULL with empty TX FIFO; blocking PUSH with full RX FIFO.
- IRQ WAIT set and waiting for the flag to clear.
- OUT with autopull enabled when OSR has reached its threshold and (TX
  FIFO empty, or the empty-OSR same-cycle refill restriction).
- IN with autopush when ISR reaches threshold and RX FIFO is full.

While stalled the PC does not advance; the instruction re-executes next
cycle; delay cycles do not count during the stall; side-set still fires on
the first cycle.

## 10. GPIO interaction (§11.2.6, §11.5.6)

- PIO keeps a 32-bit output-level register and a 32-bit output-enable
  register for its GPIO window. Writers per cycle per SM: OUT (up to 32
  bits at OUT_BASE, OUT_COUNT pins, wrap after 31), SET (up to 5 bits at
  SET_BASE), side-set (up to 5 bits at SIDESET_BASE); each applied to
  levels or directions per the instruction/SIDE_PINDIR.
- **Priority (per GPIO, per cycle, separately for level and direction):**
  among the 4 SMs, the write from the **highest-numbered SM** wins; within
  one SM, **side-set beats OUT/SET** in overlapping pins; if nobody writes,
  the previous value holds (§11.2.6, §11.5.6.1).
- Input mapping: the IN data bus is the GPIO inputs right-rotated by
  IN_BASE (LSB = IN_BASE pin, wrapping after 31; padded with zeroes to 32
  bits). WAIT GPIO uses absolute numbers, not the rotated bus.
- `SHIFTCTRL.IN_COUNT` (bits 4:0, RP2350-new) masks pins above the count
  to zero on IN PINS / WAIT PIN / MOV x,PINS (0 encodes 32/no masking).
- Input synchronisers: 2-FF per GPIO, two cycles of latency; bypass per
  GPIO via INPUT_SYNC_BYPASS at the user's risk (§11.5.6.3).
- GPIO-out override (driving constant 0/1 from software instead of PIO) is
  a pads/QOI-level feature, not described in Chapter 11; PIO-side
  observation is via DBG_PADOUT/DBG_PADOE.

## 11. Forced and EXEC'd instructions (§11.2.2, §11.5.7)

- Sources besides instruction memory: SMx_INSTR writes (immediate, ignores
  delay and clock divider, PC not advanced), MOV EXEC, OUT EXEC (executee
  runs the following cycle via a shared internal instruction latch; the
  executee cycle does not advance PC).

## 12. RP2350 vs RP2040 differences (§11.1.1)

New registers/controls:
- `DBG_CFGINFO.VERSION` reads 1 (RP2040 reserved-0).
- `GPIOBASE` — >32 GPIOs per block (values 0/16).
- `CTRL.NEXT/PREV_PIO_MASK` + `NEXTPREV_SM_ENABLE/DISABLE/CLKDIV_RESTART`
  — apply CTRL ops to neighbouring PIO blocks simultaneously.
- `SMx_SHIFTCTRL.IN_COUNT` — masks unneeded IN-mapped pins to zero (for
  MOV x, PINS).
- `IRQ0/1_INTE` expose all 8 SM IRQ flags (RP2040: lower 4 only).
- `RXFx_PUTGET0..3` + `FJOIN_RX_PUT`/`FJOIN_RX_GET` — random-access RX
  FIFO storage (status/control registers or SM-private scratch).

New instruction features:
- WAIT source 11 (JMPPIN) with 0–3 offset, independent of IN mapping.
- MOV destination PINDIRS.
- MOV source STATUS can select SM IRQ flags (STATUS_SEL=2).
- IRQ/WAIT/MOV STATUS cross-PIO indexing (PREV/NEXT IdxModes); cross-PIO
  IRQs visible next cycle, no penalty.
- MOV put/get encodings for FJOIN_RX_PUT/GET modes.

Security: Non-secure PIOs observe only Non-secure GPIOs (secure GPIO reads
0); cross-PIO links severed across security boundaries.

General: 3 PIO blocks (was 2), improved GPIO I/O delay and skew, DMA DREQ
latency reduced by one cycle.

## 13. Ambiguities / notes for the RTL designer

- KANBAN.md says "36-instruction memory"; the datasheet says 32 everywhere
  (Figure 44, §11.2.2, INSTR_MEM0–31). Treat 32 as authoritative for the
  RTL parameter, keep it generic via the IMEM_SIZE concept.
- The datasheet's overview claims "nine instructions" (§11.2.1) while the
  encoding table has 11 rows (PUSH, PULL, MOV×3, plus the rest); the 100
  opcode space is overloaded — decode must treat b7:5 (and b4/b3 for
  put/get) as sub-opcode.
- WAIT IRQ index decoding is described twice with slightly different field
  splits (§11.4.3.2 says "decoding down from the two MSBs" of the 5-bit
  field, while the WAIT encoding table shows Index as b4:0 with Source
  b6:5); the effective rule matches the IRQ instruction: b4:3 = IdxMode,
  b2:0 = flag index.
- Autopull stall subtlety: §11.2.5 lists the OUT-autopull stall as "OSR
  has reached its shift threshold", but §11.5.4.2's pseudocode shows the
  OUT-cycle stall occurs whenever the threshold was already reached at the
  start of the cycle (i.e. even before this OUT shifts) — the cycle
  contract in `docs/cycle-contract.md` must pin this down.
- The datasheet does not specify bit positions for the delay/side-set
  split beyond "MSBs of the 5-bit field", nor the exact interaction of
  SIDE_EN=1 with SIDESET_COUNT=0; pioasm cross-check should confirm.
- Non-blocking PULL on empty FIFO = MOV OSR, X (which also clears the OSR
  shift counter); the datasheet doesn't explicitly say the counter clears
  here, but MOV OSR semantics imply it.
- DBG_PADOUT/DBG_PADOE notes reference RP2040's 30 GPIOs for the MSBs
  being 0 — carry-over text; on RP2350 the window is 32 bits per GPIOBASE.


# RP2040 cross-check of the RP2350 PIO spec

Delta-check of `docs/pio-spec.md` against the RP2040 datasheet PIO chapter
(Chapter 3). Purpose: (a) facts identical in both generations are safer to
build an RP2350 model on; (b) verify §12's RP2350-vs-RP2040 difference list;
(c) look for RP2040 prose that resolves §14 open questions.

## 1. Provenance

| Field | Value |
|---|---|
| URL | https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf |
| Downloaded | 2026-08-23 |
| Size | 5,301,205 bytes |
| SHA-256 | `be56fbb75ba0ae9e26558a73c93ac3e75c2ad4e6878d3b6703de2a76d886ea8c` |

Text extracted with `pdftotext -layout`. Sections used (RP2040 datasheet
numbering, PDF pages in the running headers):

- §3.1 Overview; §3.2.1–§3.2.7 Programmer's Model (pp. 311–318)
- §3.3 pioasm directives/syntax (pp. 318–321)
- §3.4.1–§3.4.10 Instruction Set, Tables 366 ff. (pp. 321–330)
- §3.5.1–§3.5.7 Functional Details (pp. 330–343)
- §3.7 List of Registers, Tables 367–393 (pp. 367–382)

Below, "RDS §x.y" = RP2040 datasheet section; "DS §x.y" = RP2350 datasheet
section as cited in `docs/pio-spec.md`.

## 2. Confirmed-identical areas (safer facts)

Everything in this section matches `docs/pio-spec.md` verbatim or in
substance; RP2350 inherited it unchanged.

1. **Instruction encodings** (RDS §3.4.1 Table 366 vs DS §11.4.1 Table 980):
   9 instructions, 16-bit words, same class bits 15:13, Delay/side-set
   12:8, Condition/Pol+Source/Source/Destination/Op in 7:5, arg2 in 4:0.
   PUSH `100|0|IfF|Blk|00000`, PULL `100|1|IfE|Blk|00000`. Bit count 32
   encoded as 00000 (RDS §3.4.4.2/§3.4.5.2). No FIFO-aux rows in the RP2040
   table (see §3 below).
2. **JMP semantics** (RDS §3.4.2): conditions table identical; JMP PIN uses
   EXECCTRL_JMP_PIN independent of input mapping; `!OSRE` uses
   PULL_THRESH; delay applies whether or not the branch is taken.
3. **WAIT semantics** (RDS §3.4.3): GPIO absolute / PIN = IN_BASE + index
   mod 32 / IRQ; pol=1 on IRQ clears the flag when the wait completes;
   caution about racing the interrupt controller is word-for-word the same.
   Source 11 is **Reserved** on RP2040 (JMPPIN is RP2350-new, as §12 says).
4. **IN/OUT semantics** (RDS §3.4.4, §3.4.5): sources/destinations tables
   identical (IN src 100/101 reserved; OUT dst set identical incl. ISR/PC/
   EXEC); IN always uses the LSBs of the source; OUT writes a 32-bit value
   zero-extended; OUT EXEC/OUT PC rules identical; `in null` prose identical.
5. **PUSH/PULL semantics** (RDS §3.4.6, §3.4.7): IfFull/IfEmpty/Block
   identical; nonblocking PUSH to a full RX sets FDEBUG.RXSTALL, ISR still
   cleared; nonblocking PULL on empty TX = `MOV OSR, X`; autopull makes PULL
   a no-op/barrier while OSR full, `OUT NULL 32` to discard (NOTE box is
   verbatim the same).
6. **MOV semantics** (RDS §3.4.8): dst/src/op tables identical (dst 011
   reserved on RP2040; src 100 reserved; op 11 reserved); MOV to ISR/OSR
   resets the respective counter; MOV PINS reads the IN-mapped bus "without
   masking" (RP2350 adds IN_COUNT masking — listed in §12); MOV EXEC/PC
   identical; STATUS all-ones/zeros.
7. **IRQ semantics** (RDS §3.4.9): set/clear/Wait; Clr suppresses Wait; Wait
   stalls until the flag lowers; delay begins after the wait. Index decode:
   "3 LSBs specify an IRQ index 0-7 … if the MSB is set, the state machine
   ID (0…3) is added … modulo-4 addition on the two LSBs … Bit 2 is
   unaffected." RP2040 uses only the MSB (bit 4) as the relative bit; RP2350
   generalises bits 4:3 into IdxMode (00/01/10/11). Same addition rule.
8. **SET semantics** (RDS §3.4.10): dsts and reserved codes identical; X/Y
   get 5 LSBs, rest zero; SET mapping independent of OUT's.
9. **Shift counters** (RDS §3.2.3.3, §3.5.4): pair of saturating 6-bit
   counters 0–32; reset/SM_RESTART: ISR cnt ← 0, OSR cnt ← 32; PULL/PUSH and
   MOV-to-OSR/ISR clear; OUT ISR,n sets ISR cnt ← n.
10. **Stalling summary** (RDS §3.2.4): the five stall causes and the "PC does
    not advance, delay cycles do not begin until the stall clears, side-set
    on the first cycle" NOTE match `docs/pio-spec.md` §9 exactly.
11. **Side-set** (RDS §3.5.1, §3.5.6): SIDESET_COUNT = MSBs of the 5-bit
    field, inclusive of the enable bit when SIDE_EN; LSB of side-set data →
    SIDESET_BASE; side-set wins over a simultaneous OUT/SET by the same SM;
    stall does not suppress side-set.
12. **FIFO join** (RDS §3.5.3): FJOIN_RX/FJOIN_TX, 8-deep one direction,
    other direction disabled (reads both full and empty in FSTAT), both set
    ⇒ both unavailable, changing FJOIN discards contents.
13. **Autopush/autopull** (RDS §3.5.4.1/§3.5.4.2): the pseudocode blocks in
    `docs/pio-spec.md` §3.3/§3.4 appear **verbatim** in the RP2040
    datasheet, including "it cannot fill an empty OSR and 'OUT' it on the
    same cycle, due to the long logic path this would create", the data-
    fence sentence, and the MOV-from/to-OSR-under-autopull undefined/DMA-race
    note.
14. **Clock divider** (RDS §3.5.5): 16.8 fixed point, INT=0 means 65536 and
    forces FRAC=0, divisor 1 = full speed, first-order delta-sigma; CLKDIV
    register reset INT=1.
15. **GPIO mux priority** (RDS §3.2.5, §3.5.6.1): per GPIO, level and
    direction separately, "applies the write from the highest-numbered state
    machine"; within one SM, side-set takes precedence in the overlap; no
    write ⇒ previous value holds. Also matches: input bus = right-rotate by
    IN_BASE, padded with zeroes above the GPIO count (30 on RP2040); WAIT
    GPIO uses absolute numbers; 2-FF synchroniser, per-GPIO
    INPUT_SYNC_BYPASS.
16. **PC update / wrap** (RDS §3.5.2): three-step logic identical (JMP taken
    ⇒ target; else WRAP_TOP ⇒ WRAP_BOTTOM; else increment, 0 after 31);
    WRAP_* absolute addresses; wrap is a free 0-cycle jump.
17. **Forced/EXEC'd instructions** (RDS §3.5.7): INSTR write executes
    immediately, delay ignored, clock divider bypassed, PC not advanced
    unless the instruction changes it; may stall and is latched
    (EXEC_STALLED); the stalled INSTR write shares the latch with OUT/MOV
    EXEC and can overwrite an in-progress executee (CAUTION box identical).
18. **Registers** (RDS §3.7, Tables 367–393): offset map 0x000–0x140 is a
    strict prefix of the RP2350 map (RP2350 adds 0x128+ PUTGET regs and
    0x168 GPIOBASE; INTR/IRQ* interrupts are at identical offsets).
    Identical field-by-field: CTRL (3:0 SM_ENABLE, 7:4 SM_RESTART with the
    same cleared/not-cleared list, 11:8 CLKDIV_RESTART; 31:12 reserved);
    FSTAT/FDEBUG/FLEVEL bit positions and reset values; TXF write-on-full →
    TXOVER; RXF read-on-empty → RXUNDER, data undefined; IRQ (W1C, 8 flags);
    IRQ_FORCE affects internal state, INTF does not; INPUT_SYNC_BYPASS;
    DBG_PADOUT/DBG_PADOE (RP2040: 30 GPIOs, top 2 bits hardwired 0 — this is
    the origin of the carry-over text noted in §14.9); DBG_CFGINFO with
    IMEM_SIZE/SM_COUNT/FIFO_DEPTH (but no VERSION field — 31:22 reserved);
    INSTR_MEM0..31 write-only; SMx_CLKDIV; SMx_EXECCTRL (31 EXEC_STALLED,
    30 SIDE_EN, 29 SIDE_PINDIR, 28:24 JMP_PIN, 23:19 OUT_EN_SEL, 18
    INLINE_OUT_EN, 17 OUT_STICKY, 16:12 WRAP_TOP, 11:7 WRAP_BOTTOM) —
    **except STATUS_SEL/STATUS_N, see §3**; SMx_SHIFTCTRL (31 FJOIN_RX,
    30 FJOIN_TX, 29:25 PULL_THRESH, 24:20 PUSH_THRESH, 19 OUT_SHIFTDIR,
    18 IN_SHIFTDIR, 17 AUTOPULL, 16 AUTOPUSH; **15:0 Reserved** on RP2040,
    confirming FJOIN_RX_PUT/FJOIN_RX_GET and IN_COUNT are RP2350-new);
    SMx_ADDR bits 4:0; SMx_INSTR read/write semantics; SMx_PINCTRL all
    fields at identical positions with identical resets (SET_COUNT reset 5).
19. **Instruction memory**: 32 slots, 1-write/4-read register file
    (RDS §3.2.2 code comment "32-slot instruction memory", §3.2.7).

## 3. Corrections / additions to the §12 difference list

The §12 list is essentially correct. One genuine omission and two wording
refinements found:

1. **MISSED — EXECCTRL.STATUS_SEL/STATUS_N moved and widened.** On RP2040,
   EXECCTRL bits 6:5 are *Reserved*; STATUS_SEL is **bit 4 (1 bit)** with
   only TXLEVEL/RXLEVEL, and STATUS_N is **bits 3:0** (RDS §3.7 Table 382).
   On RP2350 STATUS_SEL is bits 6:5 (adding the IRQ mode) and STATUS_N is
   bits 4:0 (needed for the 0x08+n/0x10+n PREV/NEXT encodings, DS §11.7
   Table 996). §12 mentions the STATUS-irq *feature* but not the field
   relocation — a register-layout difference the RTL must not carry over
   from any RP2040-derived constants.
2. **Wording — class-0x4 nonzero arg2.** §12 says RP2040 "treats nonzero
   arg2 there as undefined/reserved". The RP2040 datasheet (Table 366,
   §3.4.6.1, §3.4.7.1) simply shows bits 4:0 as fixed 0 for PUSH/PULL and
   never defines an alternative meaning; "reserved" is an inference from the
   encoding table, not an explicit RP2040 statement. The pioasm-side
   evidence (`pio_disassembler.cpp:89-118`) remains the authority for this
   claim; recommend §12 phrase it as "unassigned in RP2040".
3. **Confirmed as correctly listed (no change needed):** WAIT JMPPIN
   (RP2040 source 11 = Reserved, RDS §3.4.3.2); MOV dst PINDIRS (RP2040 dst
   011 = Reserved, RDS §3.4.8.2); MOV PINS unmasked vs IN_COUNT-masked
   ("without masking" appears verbatim in RDS §3.4.8.2); IRQ0/1_INTE lower-4
   flags only (RDS §3.2.6 "the lower 4", INTR Table 387 bits 11:8 with
   31:12 reserved); no VERSION field in DBG_CFGINFO (31:22 reserved, Table
   379); no GPIOBASE/NEXTPREV CTRL fields (CTRL 31:12 reserved, Table 368);
   2 PIO blocks at 0x50200000/0x50300000 (RDS §3.7 Table 367).

No other deltas found: every other register field, encoding, and behaviour
described in `docs/pio-spec.md` §§1–11 that exists on RP2040 is identical.

## 4. RP2040 prose bearing on §14 open questions

- **§14.4 (autopull OUT-cycle stall boundary) — NOT resolved, but
  strengthened.** RDS §3.5.4.2 contains the identical pseudocode (stall
  branch taken only when `osr count >= threshold` at cycle start, refill
  possibly alongside the last shift-out, "cannot fill an empty OSR and
  'OUT' it on the same cycle, due to the long logic path this would
  create"), and RDS §3.2.4 has the same slightly ambiguous one-line stall
  summary as DS §11.2.5. Two generations of the same pseudocode make the
  §11.5.4.2-rule reading (adopted in `docs/pio-spec.md` §3.4) the correct
  one; the residual cycle-contract wording still needs pinning in
  `docs/cycle-contract.md`, but there is no remaining textual ambiguity.
- **§14.5 (JMP x--/y--) — confirmed, with the clearest wording of any
  source** (RDS §3.4.2.2): "JMP X-- and JMP Y-- always decrement scratch
  register X or Y, respectively. The decrement is not conditional on the
  current value of the scratch register. The branch is conditioned on the
  initial value of the register, i.e. before the decrement took place: if
  the register is initially nonzero, the branch is taken." This is
  unambiguous and exactly matches the resolution already recorded.
- **§14.7 (nonblocking PULL on empty FIFO, OSR counter) — clarified.**
  RDS §3.5.4.2's non-OUT-cycle pseudocode opens with `if MOV or PULL:
  osr count = 0`, i.e. *any* PULL (and any MOV writing OSR) clears the OSR
  counter; combined with RDS §3.4.7.2 "A nonblocking PULL on an empty FIFO
  has the same effect as MOV OSR, X", the counter-clear on the nonblocking
  empty-FIFO PULL is now supported by explicit RP2040 text rather than
  inference. The `docs/pio-spec.md` §14.7 resolution stands; it can be
  upgraded from "resolved by implication" to "confirmed (RDS §3.5.4.2)".
- **§14.8 (SIDE_EN with SIDESET_COUNT=0) — clarified by RP2040 wording.**
  RDS §3.5.1: "If there is no enable bit, **every instruction on that state
  machine will perform a side-set, if SIDESET_COUNT is nonzero**", and
  "If [SIDESET_COUNT is] set to 0, **no side-set will take place**."
  Together these make SIDESET_COUNT=0 mean "no side-set" regardless of
  SIDE_EN, which is exactly the RTL rule §14.8 proposed. Still an RP2040
  quote (RP2350 text is no more explicit), but it converts the rule from an
  RTL convention into datasheet-backed behaviour.
- **§14.3 (WAIT-IRQ index split) — supported.** RDS §3.4.3.2: "The flag
  index is decoded in the same way as the IRQ index field: if the MSB is
  set, the state machine ID (0…3) is added to the IRQ index, by way of
  modulo-4 addition on the two LSBs." RP2040 uses one MSB (bit 4) where
  RP2350 uses bits 4:3 as IdxMode; the shared-decode rule between the IRQ
  and WAIT instructions — the crux of the §14.3 resolution — is explicit in
  both generations.
- **§14.9 (DBG_PADOUT/PADOE carry-over) — origin confirmed.** RDS §3.7
  Tables 377/378: "On RP2040 there are 30 GPIOs, so the two most significant
  bits are hardwired to 0." The RP2350 notes are indeed carry-over text;
  §14.9's treatment (32-bit window, bits above the bank read 0) is
  consistent.
- **§14.1/§14.2/§14.6/§14.10 — unaffected.** RP2040 contributes nothing new
  (32-slot memory confirmed again in RDS §3.2.2/§3.2.7; no class-0x4
  overload; NULL prose identical; no STATUS_N encodings beyond 0/1).

## 5. Bottom line

- The RP2350 spec's shared (non-RP2350-new) content is a faithful extension
  of the RP2040 chapter; no contradictions found.
- §12 needs one addition (STATUS_SEL 1-bit at EXECCTRL bit 4 with STATUS_N
  3:0 on RP2040 vs 6:5 / 4:0 on RP2350) and one softening ("reserved" →
  "unassigned" for RP2040 class-0x4 arg2 ≠ 0).
- §14.7 and §14.8 are now datasheet-resolvable with RP2040 quotes; §14.4 is
  not contradicted and its pseudocode rule is dual-generation confirmed;
  §14.5 is reconfirmed with clearer wording.

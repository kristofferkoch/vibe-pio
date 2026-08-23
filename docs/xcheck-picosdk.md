# Cross-check: pico-sdk C SDK vs `docs/pio-spec.md`

## (a) Provenance

| Field | Value |
|---|---|
| Repo | https://github.com/raspberrypi/pico-sdk |
| Commit (clone HEAD) | `98a542c1a62fb549ffb5d66a3e5892b06276b670` ("SDK 2.3.0 Release", 2026-07-03) |
| Cloned | 2026-08-23, sparse (blobless, `--depth 1`), paths `src/rp2350/hardware_regs/include/hardware/regs/` and `src/rp2_common/hardware_pio/` |
| Local checkout | `third_party/pico-sdk/` (git-ignored). Same commit as the earlier `third_party/pioasm-sdk/` clone — the two cross-checks are mutually consistent in vintage. |
| Files mined | `regs/pio.h` (auto-generated RP2350 PIO register defs), `regs/addressmap.h`, `regs/dreq.h`, `hardware_pio/pio.c`, `hardware_pio/include/hardware/pio.h`, `hardware_pio/include/hardware/pio_instructions.h` |

Citations below: `pio.h` = `third_party/pico-sdk/src/rp2350/hardware_regs/include/hardware/regs/pio.h`;
`pio.c`, `H/pio.h`, `H/pio_instr.h` under `third_party/pico-sdk/src/rp2_common/hardware_pio/`.

## (b) Confirmations (spec facts independently confirmed)

Counts: **35 confirmations**.

### Register map (`regs/pio.h` vs spec §7) — every field checked

1. `CTRL` 0x000: SM_ENABLE 3:0 (RW), SM_RESTART 7:4, CLKDIV_RESTART 11:8 (both SC);
   PREV_PIO_MASK 19:16, NEXT_PIO_MASK 23:20, NEXTPREV_SM_ENABLE 24,
   NEXTPREV_SM_DISABLE 25, NEXTPREV_CLKDIV_RESTART 26 (all SC). Register mask
   0x07ff0fff — all other bits reserved. Matches spec §7 exactly.
2. NEXTPREV_SM_DISABLE wins over ENABLE ("If both … set, the disable takes
   precedence") — spec §7 "(disable wins)" confirmed.
3. Cross-PIO severing: "Neighbouring PIO blocks are disconnected (status signals
   tied to 0 and control signals ignored) if one block is accessible to
   NonSecure code, and one is not" — spec §12 security note confirmed.
4. `FSTAT` 0x004: TXEMPTY 27:24, TXFULL 19:16, RXEMPTY 11:8, RXFULL 3:0; reset
   0x0f000f00. Matches §6.
5. `FDEBUG` 0x008: TXSTALL 27:24 ("stalled on empty TX FIFO during a blocking
   PULL, or an OUT with autopull enabled"), TXOVER 19:16 ("write-on-full … does
   not alter the state or contents of the FIFO"), RXUNDER 11:8 ("read-on-empty …
   data returned … is undefined"), RXSTALL 3:0 ("also set when a nonblocking
   PUSH to a full FIFO took place"). All four match spec §6.
6. `FLEVEL` 0x00c: interleaved 4-bit TXn/RXn fields (RX3:31 … TX0:3:0). Matches §6.
7. `TXF0..3` 0x010–0x01c (WF), `RXF0..3` 0x020–0x02c (RF) with push/pop and
   error-sticky semantics as in §6.
8. `IRQ` 0x030 (WC, 8 flags) and `IRQ_FORCE` 0x034: "writing here affects PIO
   internal state. INTF just asserts the processor-facing IRQ signal … not
   visible to the state machines" — spec §7 confirmed verbatim in substance.
9. `INPUT_SYNC_BYPASS` 0x038, per-GPIO, 2-FF synchronizer description. Matches §10.
10. `DBG_PADOUT` 0x03c / `DBG_PADOE` 0x040 (RO). The generated header still says
    "On RP2040 there are 30 GPIOs, so the two most significant bits are hardwired
    to 0" — independent confirmation that this is carry-over text, exactly as
    spec §14.9 resolved.
11. `DBG_CFGINFO` 0x044: VERSION 31:28 (reset 1, enum V0/V1), IMEM_SIZE 21:16,
    SM_COUNT 11:8, FIFO_DEPTH 5:0. Matches §7; VERSION=1 for RP2350 confirmed.
12. `INSTR_MEM0..31` 0x048–0x0c4, 16-bit WO — **32** slots, no more
    (confirms §14.1 resolution).
13. Per-SM register stride 0x18 from SM0_CLKDIV 0x0c8; SM1 0x0e0, SM2 0x0f8,
    SM3 0x110. Matches §7 ("stride 0x18 from 0x0c8").
14. `SMx_CLKDIV`: INT 31:16 (reset 1; "Value of 0 is interpreted as 65536. If
    INT is 0, FRAC must also be 0"), FRAC 15:8; formula
    sysclk/(int + frac/256). Matches §7 including the INT=0 constraint.
15. `SMx_EXECCTRL` reset 0x0001f000: EXEC_STALLED 31 (RO), SIDE_EN 30,
    SIDE_PINDIR 29, JMP_PIN 28:24 ("Unaffected by input mapping"), OUT_EN_SEL
    23:19, INLINE_OUT_EN 18, OUT_STICKY 17, WRAP_TOP 16:12 (reset 0x1f),
    WRAP_BOTTOM 11:7 (reset 0), STATUS_SEL 6:5, STATUS_N 4:0. Every bit
    position matches §7.
16. STATUS_SEL enum values TXLEVEL=0 / RXLEVEL=1 / IRQ=2 with "All-ones if
    … otherwise all-zeroes" — confirms §3.6, and STATUS_N encodings
    0x00 / 0x08 (next lower) / 0x10 (next higher) confirm §3.6 and §14.10.
    The header adds: "values of STATUS_N greater than the current FIFO depth
    are reserved, and have undefined behaviour" (TXLEVEL/RXLEVEL only).
17. `SMx_SHIFTCTRL` reset 0x000c0000 (= both SHIFTDIR bits set): FJOIN_RX 31,
    FJOIN_TX 30, PULL_THRESH 29:25, PUSH_THRESH 24:20, OUT_SHIFTDIR 19,
    IN_SHIFTDIR 18 (reset 1 = right), AUTOPULL 17, AUTOPUSH 16, FJOIN_RX_PUT 15,
    FJOIN_RX_GET 14, IN_COUNT 4:0. Register mask 0xffffc01f — **bits 13:5 are
    reserved** on RP2350 too. Matches §7 exactly.
18. FJOIN_RX description: "RX FIFO steals the TX FIFO's storage … TX FIFO is
    disabled as a result (always reads as both full and empty). FIFOs are
    flushed when this bit is changed" — §6 confirmed (also for FJOIN_TX).
19. FJOIN_RX_PUT/GET descriptions match §3.7/§6: put = SM random-write +
    processor random-read via `RXFx_PUTGETy`; get = SM random-read +
    processor write; both set = SM-only, "completely inaccessible to the
    processor"; "Setting this bit will clear the FJOIN_TX and FJOIN_RX bits."
20. IN_COUNT description confirms §10: masks pins above the count on
    "IN PINS, WAIT PIN or MOV x, PINS"; 0 encodes 32 / no masking; reset 0.
21. `SMx_ADDR` 0x0d4+ (RO, bits 4:0); `SMx_INSTR` 0x0d8+: "Read to see the
    instruction currently addressed by … program counter. Write to execute an
    instruction immediately (including jumps) and then resume execution."
    Matches §7/§11.
22. `SMx_PINCTRL` reset 0x14000000 (= SET_COUNT 5): SIDESET_COUNT 31:29,
    SET_COUNT 28:26 (reset 5), OUT_COUNT 25:20 ("0 to 32 inclusive"),
    IN_BASE 19:15, SIDESET_BASE 14:10, SET_BASE 9:5, OUT_BASE 4:0; modulo-32
    pin mapping text. Matches §7.
23. `RXFx_PUTGET0..3` at 0x128–0x164 (SM0 first) — spec offset "0x128+" confirmed.
24. `GPIOBASE` 0x168, bit 4 only. Matches §7.
25. `INTR` 0x16c: SM IRQ flags 15:8 (SM7=15 … SM0=8, all 8 exposed — RP2350),
    SMx_TXNFULL 7:4, SMx_RXNEMPTY 3:0. Confirms §7 (see extension E2 for
    precise sub-layout).
26. `IRQ0/IRQ1 _INTE/_INTF/_INTS` at 0x170–0x178 / 0x17c–0x184. Matches §7.

### Driver / encoder behaviour

27. `pio_instructions.h` instruction encodings: class bits (JMP 0x0000, WAIT
    0x2000, IN 0x4000, OUT 0x6000, PUSH 0x8000, PULL 0x8080, MOV 0xa000,
    IRQ 0xc000, SET 0xe000); WAIT polarity in arg1 bit 7 (`| polarity?4:0`
    pre-shift ⇒ bit 7); JMP condition codes 0–7 exactly per §3.1; IN/OUT assert
    `arg2 && arg2 <= 32` (0⇒32 encoding confirmed, §2); PUSH arg1 =
    block | if_full<<1, PULL = 0x80 | if_empty<<1 | block (§3.5 bit positions);
    IRQ set/wait/clear = arg1 0/1/2 (§3.8); `rel` encoded as 0x10 in arg2 —
    bit 4 — matching the b4:3 IdxMode / b2:0 index split of §3.8/§14.3;
    MOV op none/`~`(1)/`::`(2) in bits 4:3; NOP = `mov y,y` (§3.6).
28. `pio_encode_sideset`: `value << (13 - bit_count)` (top data bit at bit 12);
    `pio_encode_sideset_opt`: `0x1000 | value << (12 - bit_count)` — the
    per-instruction enable is the MSB of the side-set field (bit 12), and max
    data bits drop to 4 when `opt`. Confirms §4.
29. `sm_config_set_sideset` (`H/pio.h`): bit_count ≤ 5 and **`!optional ||
    bit_count >= 1`** — the SDK forbids SIDE_EN with an (inclusive) count of 0,
    supporting the §14.8 resolution (treat SIDESET_COUNT=0 as no side-set).
    COUNT is inclusive of the enable bit ("Note that the value of
    PINCTRL_SIDESET_COUNT is inclusive of this enable bit", `pio.h` SIDE_EN).
30. `sm_config_set_in_pin_count` (`H/pio.h`): v0 requires exactly 32; v1
    accepts 1–32 with 0 encoding 32 — confirms §7/§12.
31. Default SM config (`pio_get_default_sm_config`): clkdiv 1/0, wrap 0..31,
    both shifts right, thresholds 32, no autopush/pull, FIFO join none — all
    match the SHIFTCTRL/EXECCTRL reset values.
32. `pio_sm_restart` doc (`H/pio.h` ~line 1145): clears in/out shift counters,
    ISR contents, delay counter, waiting-on-IRQ state, stalled forced
    instruction, OUT_STICKY pin writes; **not** affected: enable state, PC,
    OSR, X, Y. Matches §7 (and extends it — see N2).
33. `pio_sm_exec` docs: "This instruction is executed instead of the next
    instruction in the normal control flow … Subsequent calls … replace the
    previous executed instruction if it is still running" — confirms §11
    (forced INSTR shares/overwrites the latch) and the EXEC_STALLED
    read-back semantics (`pio_sm_is_exec_stalled` reads EXECCTRL bit 31).
34. `pio_sm_drain_tx_fifo` (`pio.c`): with autopull enabled it forces
    `OUT NULL 32`, otherwise a non-blocking PULL — confirms §3.5 note
    ("with autopull, PULL is a no-op while the OSR is full; OUT NULL 32
    discards the OSR").
35. `pio_fifo_join` enum + `sm_config_set_fifo_join` (`H/pio.h`): NONE=0,
    TX=1, RX=2; v1 adds TXGET=4, TXPUT=8, PUTGET=12, mapped as
    `(join & 3) << FJOIN_TX` | `(join >> 2) << FJOIN_RX_GET` — i.e. TXPUT sets
    only FJOIN_RX_PUT, TXGET only FJOIN_RX_GET, PUTGET both. Confirms the §6
    join-mode semantics and the pioasm `.fifo` config set.

## (c) Corrections / extensions (SDK vs spec)

Counts: **4**.

- **E1 — WAIT GPIO index is relative to GPIOBASE, not chip-absolute** (spec
  §3.2 says "absolute GPIO number"). `pio.c:add_program_at_offset` (lines
  159–167) rewrites WAIT instructions when GPIOBASE=16: "wait GPIO will
  include only the 5 lower bits of the GPIO number, so if the GPIO base is 16
  we need to flip bit 4 …", XORing the encoded instruction with the GPIO base.
  So on RP2350 the WAIT GPIO index selects a pin **within the SM's 32-pin
  GPIOBASE window**; "absolute" in the datasheet means absolute w.r.t. the
  window (contrasted with the IN-mapped bus), not w.r.t. the chip. RTL should
  decode `window_base + index` with window_base = GPIOBASE*… (0 or 16).
  Spec §3.2/§10 wording should be qualified.
- **E2 — INTR/IRQn_INTE bit allocation**: spec §7 says "SM IRQ flags bits 15:8
  … plus SMx_TXNFULL/RXNEMPTY bits 7:0". The header pins it down further:
  TXNFULL = bits 7:4 (SM3=7 … SM0=4), RXNEMPTY = bits 3:0 (SM3=3 … SM0=0).
  (`pio.h` INTR fields; `H/pio.h` `pio_interrupt_source_t`.)
- **E3 — PIO2 base address**: spec §7 says "PIO2 exists (datasheet table lists
  the first two)". `regs/addressmap.h` gives `PIO2_BASE = 0x50400000`
  (PIO0 0x50200000, PIO1 0x50300000). Closes the spec's open offset.
- **E4 — WAIT JMPPIN offset bound (minor discrepancy, spec favoured)**: spec
  §3.2/§13 says JMPPIN index 0–3 only, arg2[4:2]≠0 reserved (per datasheet and
  pioasm). `pio_encode_wait_jmppin` (`H/pio_instr.h` line 332) asserts
  `offset <= 4` — one more than the documented 0–3. Offset 4 sets index bit 2,
  which both other sources call reserved; this looks like an off-by-one in the
  SDK's assert (or an intentionally permissive bound). RTL should keep 0–3
  valid / other encodings reserved per the datasheet; note the SDK divergence
  in the spec's reservations section.

## (d) New facts worth merging (semantics implied by driver code)

Counts: **8**.

- **N1 — Program-load JMP relocation**: `pio.c:168` — when adding a program at
  an offset, every JMP instruction is relocated (`instr + offset`); all other
  instruction classes are copied verbatim (except the WAIT-GPIO fixup of E1).
  Confirms JMP addresses are absolute in instruction memory (§3.1) and shows
  the intended load protocol.
- **N2 — SM_RESTART also preserves PC and enable state**: `H/pio.h`
  `pio_sm_restart` doc lists "the state machine's enable/running state, its
  program counter, the contents of its output shift register, and its X and Y
  scratch registers" as unaffected; the datasheet-derived §7 list only called
  out OSR and X/Y. The intended idiom to reset PC is a forced JMP via
  SMx_INSTR (`pio.c:423` does exactly `pio_sm_exec(pio, sm,
  pio_encode_jmp(initial_pc))` after `pio_sm_restart`).
- **N3 — GPIO-range compatibility is 16-pin-bank granular**:
  `pio.c:is_gpio_compatible` (lines 107–113): a program's `used_gpio_ranges`
  bit 0 (pins 0–15) is incompatible with GPIOBASE=16, and bit 2 (pins 32–47)
  is incompatible with GPIOBASE=0. Matches and sharpens the pioasm
  single-32-pin-bank rule quoted in spec §10: the two legal windows are
  0–31 and 16–47.
- **N4 — GPIOBASE may only be changed while no programs are loaded**:
  `pio.c:pio_set_gpio_base_unsafe` (line 88) refuses when
  `_used_instruction_space != 0`; and only values 0 or 16 are legal (line 86).
  (Software-side policy, but a useful constraint for a model of the system
  interface.)
- **N5 — Forced SET writes honour OUT_STICKY and current PINCTRL**: the
  `pio_sm_set_pins*` / `pio_sm_set_pindirs*` family (`pio.c:224–393`)
  initialize pins by temporarily programming PINCTRL SET_COUNT/SET_BASE and
  forcing `SET PINS/PINDIRS` instructions through SMx_INSTR — after
  explicitly clearing OUT_STICKY for the duration. Two implications for
  hardware semantics: (i) a forced instruction executes with whatever
  PINCTRL/EXECCTRL is currently programmed (register writes take effect
  immediately, even while the SM is halted); (ii) OUT_STICKY applies to forced
  SET pin writes too, and OUT_STICKY re-asserts the *most recent* pin write on
  later cycles (restoring EXECCTRL re-asserts the saved state).
- **N6 — Aux FIFO modes keep the TX FIFO fully usable**: the
  `pio_fifo_join` doc comments (`H/pio.h:99–107`) state that in TXGET, TXPUT
  and PUTGET modes the "TX FIFO length=4 is used for transmit" — i.e. unlike
  FJOIN_TX, the aux modes do not sacrifice the TX FIFO; only the RX side
  becomes random-access storage. Spec §6 states RX storage is repurposed but
  never says explicitly that TX remains a normal 4-deep FIFO in these modes.
- **N7 — STATUS_N > FIFO depth is reserved for TXLEVEL/RXLEVEL**
  (`pio.h` STATUS_N field description): "values of STATUS_N greater than the
  current FIFO depth are reserved, and have undefined behaviour" (TXLEVEL/
  RXLEVEL selections only). Not in the datasheet-derived spec text; add to
  RTL reserved-encodings list (§13).
- **N8 — DREQ assignment (system-integration fact)**: `regs/dreq.h`
  DREQ_PIO0_TX0..RX3 = 0–7, PIO1 = 8–15, PIO2 = 16–23 (TX0–3 then RX0–3 per
  block). Useful for the bus/DMA model; spec §6 mentions DREQ pacing but no
  numbering.

## Summary

| Category | Count |
|---|---|
| Confirmations | 35 |
| Corrections / extensions | 4 (E1–E4) |
| New facts | 8 (N1–N8) |

No outright contradiction of the spec was found. The most interesting items:
**E1** (WAIT GPIO index is relative to GPIOBASE — the spec's "absolute GPIO
number" must be read as window-absolute), **E4** (SDK permits WAIT JMPPIN
offset 4 where datasheet+pioasm say 0–3), **N5** (forced SET semantics under
OUT_STICKY / live PINCTRL), and **N6** (TX FIFO stays usable in put/get aux
modes).

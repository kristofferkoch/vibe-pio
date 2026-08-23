# PIO specification notes extracted from `pioasm`

Reference for RTL designers, extracted from the official Raspberry Pi PIO
assembler sources. Provenance: see `docs/spec-sources.md` (pioasm section).
All source citations are relative to `tools/pioasm/` in
`third_party/pioasm-sdk/`.

Primary sources:

- `pio_types.h` — all instruction-class, condition, source/dest opcode enums.
- `pio_assembler.cpp` — `instruction::encode()` (16-bit word assembly),
  per-instruction `raw_encode()`, `.side_set`/delay arithmetic, program
  limits and directive validation.
- `pio_disassembler.cpp` — independent decode-side view of the encoding
  (useful cross-check; marks encodings the hardware treats as reserved).
- `parser.yy` — assembler syntax, PIO-version gating (v0 = RP2040, v1 = RP2350).
- `pio_enums.h` — FIFO join/aux configurations (v1/RP2350 additions).

Bit numbering below uses bit 15 = MSB of the 16-bit instruction word.

## 1. Top-level instruction word format

From `instruction::encode()` (`pio_assembler.cpp:261-296`):

```
inst = (type << 13) | ((delay | sideset) << 8) | (arg1 << 5) | (arg2 & 0x1f)
```

| Bits    | Field                          |
|---------|--------------------------------|
| 15..13  | instruction class (see §2)     |
| 12..8   | delay/side-set (see §9)        |
| 7..5    | arg1 (opcode / dest / source)  |
| 4..0    | arg2 (address / bit count / immediate) |

Note in the encoder comment (`pio_assembler.cpp:294`): *"we store the 6th bit
of arg2 above the 16 bits of instruction"* — i.e. the compiler-internal value
keeps `arg2[5]` at bit 16 of an `uint` so that PUSH/PULL-aux (FIFO index,
RP2350) encodings fit; the emitted 16-bit word truncates to `arg2 & 0x1f`.
For all RP2040-compatible instructions arg2 is 5 bits.

`.word <n>` emits a raw 16-bit value verbatim (`instr_word::encode`,
`pio_assembler.cpp:302-308`).

## 2. Instruction classes (bits 15..13)

`enum inst_type` (`pio_types.h:48-57`):

| Value | Class | arg1 (7..5) meaning | arg2 (4..0) meaning |
|-------|-------|--------------------|--------------------|
| 0x0   | JMP   | condition          | target address (0-31) |
| 0x1   | WAIT  | polarity<<2 \| source | index (irq/pin/gpio/jmppin offset) |
| 0x2   | IN   | source             | bit count (1-32, 32 encodes as 0) |
| 0x3   | OUT  | destination        | bit count (1-32, 32 encodes as 0) |
| 0x4   | PUSH/PULL | flags (see §7) | 0, or FIFO-aux index (RP2350, §7.1) |
| 0x5   | MOV  | destination        | source \| op<<3 |
| 0x6   | IRQ  | modifier           | irq index \| rel/prev/next bits |
| 0x7   | SET  | destination        | immediate data (0-31) |

## 3. JMP (class 0x0)

`enum condition` (`pio_types.h:60-69`); target must be within the program
(`instr_jmp::raw_encode`, `pio_assembler.cpp:358-368`):

| arg1 | pioasm syntax | Meaning |
|------|---------------|---------|
| 0x0  | (always)      | unconditional |
| 0x1  | !x            | X == 0 |
| 0x2  | x--           | X != 0, then decrement X |
| 0x3  | !y            | Y == 0 |
| 0x4  | y--           | Y != 0, then decrement Y |
| 0x5  | x != y        | X != Y |
| 0x6  | pin           | JMP pin (mapped input pin) high |
| 0x7  | !osre         | OSR not empty (output shift register not empty) |

Disassembler confirms the same order and mnemonics
(`pio_disassembler.cpp:30-35`), including that `x--`/`y--` *decrement on
taken-ness evaluation* — the decrement happens when the condition is
evaluated (X!=0), matching datasheet "post-decrement" semantics.

## 4. WAIT (class 0x1)

`instr_wait::raw_encode` (`pio_assembler.cpp:394-430`), `wait_source`
(`pio_types.h:131-142`):

```
arg1 = (polarity << 2) | source
arg2 = index | (irq_type << 3)     /* irq_type only for source==irq */
```

| arg1 source | Syntax          | arg2 meaning                            | Range check |
|-------------|-----------------|-----------------------------------------|-------------|
| 0x0         | wait gpio N     | absolute GPIO number                    | 0-31 (v0), 0-47 (v1) |
| 0x1         | wait pin N      | pin index relative to SM in-pin base    | 0-31 |
| 0x2         | wait irq N [rel/prev/next] | IRQ flag index, arg2[4]=rel, arg2[3]=prev(1)/next(3) | N 0-7 |
| 0x3         | wait jmppin [0-3] | pin indexed by JMP pin mapping + offset | offset 0-3; v1 only |

Polarity (arg1 bit 2): 0 = wait for 0, 1 = wait for 1. Bare
`wait <source>` defaults to polarity 1 (`parser.yy:263`).

Disassembler cross-check (`pio_disassembler.cpp:37-70`):
- `irq` arg2 bit 3 selects prev/next, bit 4 selects `rel`; `rel` is only
  printed when bits [4:3] == 0b10 (i.e. `rel` alone, not `prev rel`).
- `jmppin` with any of arg2 bits [4:2] set is decoded as **reserved**.
- GPIO range restriction (v1): an absolute GPIO number mixes pins <16 and
  >32 in the same program is rejected (`used_gpio_ranges` bitmap,
  `pio_assembler.cpp:404-420`) — 1 bit of bitmap per 16-pin range, implying
  the hardware pin mux selects a contiguous 32-pin bank per PIO block on
  RP2350.

## 5. IN / OUT / SET sources and destinations

`enum in_out_set` (`pio_types.h:72-83`) — shared encodings, not all valid
per class:

| Value | IN source | OUT dest | SET dest |
|-------|-----------|----------|----------|
| 0x0   | pins      | pins     | pins     |
| 0x1   | x         | x        | x        |
| 0x2   | y         | y        | y        |
| 0x3   | null      | null     | (invalid) |
| 0x4   | (invalid) | pindirs  | pindirs  |
| 0x5   | status    | pc       | (invalid) |
| 0x6   | isr       | isr      | (invalid) |
| 0x7   | osr       | exec     | (invalid) |

Notes:
- IN/OUT bit count: 1-32; **32 encodes as arg2 = 0** (both assembler
  `v & 0x1f`, `pio_assembler.cpp:370-384`, and disassembler
  `arg2 ? arg2 : 32`, `pio_disassembler.cpp:79,86`). RTL must decode 0 as 32.
- SET immediate: 0-31 (`pio_assembler.cpp:386-392`). Disassembler marks SET
  arg1 values 3,5,6,7 as reserved (`pio_disassembler.cpp:174-183`).
- `in null` and `out null` discard data but **still shift the ISR/OSR**
  (implied by the shifting semantics; `null` is a destination, not a no-op).
- `out pc` = jump to the value shifted out; `out exec` = execute shifted-out
  word as an instruction (RP2350-datasheet feature; pioasm encodes
  `EXEC = 0x7`, `parser.yy:340`).
- `in status` samples the MOV-status condition source configured via
  `.mov_status` (§10).

## 6. MOV (class 0x5)

`enum mov` (`pio_types.h:92-105`), `mov_op` (`pio_types.h:125-129`),
`instr_mov::raw_encode` (`pio_assembler.cpp:346-356`):

```
arg1 = dest (3 bits)
arg2 = source (3 bits) | (op << 3)
```

| Value | Dest      | Source   |
|-------|-----------|----------|
| 0x0   | pins      | pins     |
| 0x1   | x         | x        |
| 0x2   | y         | y        |
| 0x3   | pindirs (dest, v1) / null (source) | null |
| 0x4   | exec      | (invalid source) |
| 0x5   | pc        | status   |
| 0x6   | isr       | isr      |
| 0x7   | osr       | osr      |

`mov_op`: 0 = none, 1 = invert (`~`), 2 = bit-reverse (`::`); 3 is decoded
as **reserved** by the disassembler (`pio_disassembler.cpp:126`).

- `nop` is an alias for `mov y, y` (`instr_nop`, `pio_types.h:480-482`) —
  important for RTL: NOP is not a distinct encoding.
- `mov exec` writes the value to the instruction-input path (executes it);
  `mov pc` = jump; `mov pins` writes GPIO output values; `mov pindirs`
  writes pin direction (v1 only, `parser.yy:350`).
- `mov status` as source reads the configured status flag.

### 6.1 RP2350 FIFO-aux MOV (txput/txget/putget)

`enum mov` values 0x8/0x9 (`fifo_y`, `fifo_index`) are *assembler-only*
notations — they do not encode into the MOV class. Instead
(`instr_mov::raw_encode`, `pio_assembler.cpp:346-356`, and
`get_push_get_index`, `pio_assembler.cpp:310-320`):

- `mov rxfifo[idx], isr` (push into TX-put FIFO) encodes as a **PUSH-type
  word (class 0x4)** with arg1 = 0, arg2 = 0x10 | (idx ? 8 | (idx & 3) : 0).
- `mov osr, txfifo[idx]` (pull from RX-get FIFO) encodes as a **PULL-type
  word** with arg1 = 0x4, arg2 = 0x10 | index encoding as above.
  Index `y` uses encoding 0; literal index i (0-7) uses 8 | (i & 3).

Validation (`instr_mov::pre_validate`, `pio_assembler.cpp:328-344`):
`mov rxfifo[]` requires source `isr` and FIFO config `txput`/`putget`;
`mov ,txfifo[]` requires dest `osr` and config `txget`/`putget`.

Disassembler mirror: class 0x4 with arg2 bit 4 set and arg1[1:0]==0 is a
FIFO-aux mov; anything else with arg2 != 0 is reserved
(`pio_disassembler.cpp:89-118`).

## 7. PUSH / PULL (class 0x4)

`instr_push`/`instr_pull` (`pio_types.h:430-454`):

| arg1 bit | PUSH meaning  | PULL meaning |
|----------|---------------|--------------|
| 0 (bit 0)| 0 = block     | 0 = block    |
|          | 1 = noblock   | 1 = noblock  |
| 1 (bit 1)| iffull        | ifempty      |
| 2 (bit 2)| 0             | 1 (distinguishes PULL) |

So: PUSH arg1 = block | (iffull << 1); PULL arg1 = block | (ifempty << 1) | 4.
`block` stalls the SM until the FIFO has space (push) / data (pull) — this is
the assembler-level confirmation of the datasheet stall semantics.
`instr_push::pre_validate` (`pio_assembler.cpp:322-326`): PUSH requires FIFO
config `rx` or `txrx` (push goes to RX FIFO); with txput/putget configs PUSH
is rejected in favour of `mov rxfifo[], isr`.

## 8. IRQ (class 0x6)

`enum irq` (`pio_types.h:85-89`), `instr_irq::raw_encode`
(`pio_assembler.cpp:432-437`):

```
arg1 = modifier: 0 = set/nowait, 1 = set + wait, 2 = clear  (3 reserved)
arg2 = irq_index (3 bits) | (irq_type << 3)
       irq_type: 0 = plain, 1 = prev, 2 = rel, 3 = next
```

- `irq N` (nowait): set flag N without stalling (0-cycle, no stall).
- `irq N wait` (`set_wait`): set flag N **and stall until it is cleared**
  (by another SM or the system).
- `irq N clear`: clear flag N, never stalls.
- `rel` (arg2 bit 4): N is added to the SM's own index (SM0+i) — 3-bit wrap.
- `prev`/`next` (arg2 bits [4:3] = 0b01/0b11, v1 only): set the flag of the
  previous/next PIO block's SM with the same index (inter-block relay).
  `rel` combined with `prev`/`next` is rejected (`parser.yy:272-273,302-303`).
- Disassembler treats arg1 bit 2 set (modifier 3) as reserved
  (`pio_disassembler.cpp:146-147`).

## 9. Delay / side-set (bits 12..8)

From `program::finalize()` (`pio_assembler.cpp:209-227`) and
`instruction::encode()` (`pio_assembler.cpp:261-296`):

- `.side_set <bits>` (optionally followed by `opt` and/or `pindirs`): with
  N side-set data bits, `sideset_max = 2^N - 1`.
- If `opt` (the default is `sideset_opt = true`, `pio_types.h:314` — note
  `opt` is the assembler default only when `.side_set` is given as
  `.side_set N opt`): bits++ to account for the enable/presence bit, giving
  `sideset_bits_including_opt = N + 1`.
- Total side-set field (including the opt enable bit) may not exceed 5;
  hence max N = 4 with opt, 5 without.
- `delay_max = 2^(5 - bits_including_opt) - 1`; with no `.side_set`,
  delay_max = 31.
- Encoding: the 5-bit field [12:8] = delay | sideset. Sideset value is
  shifted left by `5 - sideset_bits_including_opt`; if the program uses opt
  AND the instruction specifies `side N`, bit 4 (0x10) of the field is
  forced to 1 (enable). If no `side` is given on an opt program, bit 4 = 0
  and the whole field is pure delay — the hardware must then treat the
  side-set field bits as additional delay bits.
- If `.side_set` is declared **without** `opt`, every instruction must
  specify `side` (`program::add_instruction`,
  `pio_assembler.cpp:46-50`).
- Disassembly (`pio_disassembler.cpp:189-197`): side value is extracted as
  `(delay & (opt ? 0xf : 0x1f)) >> (5 - bits_including_opt)` and only shown
  when not-opt or enable-bit set; the remaining low bits are delay.

Config implication: `.side_set` maps to `SMx_EXECCTRL_SIDESET_BASE/BITS/OPT/ENABLE`
registers; `.side_set pindirs` means the side-set drives pin *direction*
rather than value.

## 10. Program directives → hardware config registers

From `program` (`pio_types.h:269-378`), `finalize()`, and `write_output()`
(`pio_assembler.cpp:181-235, 453-535`):

| Directive | Config implied (datasheet register) |
|-----------|-------------------------------------|
| `.origin N` | load address in instruction memory |
| `.pio_version 0/1` | 0 = RP2040, 1 = RP2350 (`set_pio_version`, `pio_assembler.cpp:57-62`) — gates v1-only syntax |
| `.wrap` / `.wrap_target` | `SMx_EXECCTRL_WRAP_TOP/WRAP_BOTTOM`. Default wrap = last instruction, wrap_target = first (`pio_assembler.cpp:489-499`). `.wrap` records `instructions.size()-1` at the point it appears; `.wrap_target` records the index of the *next* instruction |
| `.side_set N [opt] [pindirs]` | side-set count/base/opt/enable in EXECCTRL (§9) |
| `.in P [, right] [, autopush @ T]` | IN pin base/count (`PINCTRL_IN_BASE`, `IN_COUNT` on v1), `SHIFTCTRL_IN_SHIFTDIR` (right), `PUSH_THRESH`, `AUTOPUSH`. v0 requires count 32; v1 allows 1-32 (RX FIFO width) |
| `.out P [, right] [, autopull @ T]` | `OUT_SHIFTDIR`, `PULL_THRESH`, `AUTOPULL` |
| `.set_count N` (0-5) | SET pin count — SET drives at most 5 pins |
| `.fifo txrx\|tx\|rx\|txput\|txget\|putget` | `SMx_SHIFTCTRL_FJOIN_RX/TX` plus v1 FJOIN_RX_PUT/GET aux modes (`pio_enums.h:12-19`). txput/txget/putget are v1-only |
| `.mov_status txfifo < N / rxfifo < N / irq set N [prev/next]` | `SMx EXECCTRL_STATUS_SEL/STATUS_N`. irq form encodes N_final = param*8 + irq (`pio_assembler.cpp:182-191`); FIFO form N 0-31 |
| `.clock_div X` (1 <= X < 65536) | `SMx CLKDIV_INT/FRAC`, 8.8 fixed point (`set_clock_div`, `pio_assembler.cpp:64-74`) |

Assembler-level constraints that reflect hardware facts:

- Max program size: 32 instructions (`MAX_INSTRUCTIONS = 32`,
  `pio_types.h:270`) — RP2350 has 36 per block, but pioasm still limits to
  32 for compatibility; RTL targeting RP2350 should support 36 and treat 32
  as an assembler limitation, not a hardware one. **Datasheet
  cross-check point.**
- Autopush is incompatible with txput/txget/putget FIFO configs
  (`pio_assembler.cpp:228-234`) — in aux modes the RX FIFO is used for
  `mov rxfifo[]`, so autopush has nowhere to write.
- `used_gpio_ranges`: absolute-GPIO references must all fall in one 32-pin
  bank (pins 0-31 or 16-47) per program — evidence for the RP2350 PIO
  input-bank structure.

## 11. Hardware-behaviour notes found in sources

The pioasm sources contain few prose comments about runtime behaviour (it
is an assembler); the behavioural facts above are inferred from validation
logic:

- **Stalls**: PUSH/PULL `block` stalls on FIFO full/empty; `irq wait`
  stalls until the flag clears; WAIT stalls on the GPIO/pin/IRQ condition;
  OUT with autopull-refill stalls when OSR empty and TX FIFO empty
  (implicit — `pull ... block` semantics). `irq` (nowait) and `irq clear`
  never stall. Nothing in pioasm documents cycle timing beyond this; the
  cycle contract must come from the datasheet.
- **Exec**: two mechanisms — `out exec` (executes the shifted-out word as
  an instruction, consuming a cycle per the datasheet) and `mov exec, src`
  (encodes as `mov` dest 0x4). Both imply the RTL needs an instruction
  bypass path into the decoder.
- **FIFO-index MOV aliasing onto class 0x4** (§6.1) is the subtlest
  encoding fact: the 5-bit arg2 of PUSH/PULL is *not* always zero on
  RP2350 — bit 4 marks FIFO-aux, bit 3 literal-index-vs-y, bits 1:0 the
  index. RP2040 RTL treats any nonzero arg2 here as undefined/reserved.

## 12. Datasheet cross-check notes / potential discrepancies

1. **Delay/side-set split with `opt`**: datasheet says the enable bit is
   the MSB of the delay/side-set field; pioasm confirms field layout
   `delay | (sideset << (5 - bits))` with enable at bit 4 when opt is on.
   With opt ON and enable bit 0, the side-set data bits are *unavailable*
   and the full 5 bits are delay (see §9).
2. **32-bit shift encodes as 0** — both directions confirmed in assembler
   and disassembler; easy to miss in RTL decode.
3. **arg2 bit 5 (PUSH/PULL FIFO index)**: only visible in the compiler's
   internal `uint` (bit 16); the 16-bit word only keeps 3 index bits
   (8 | idx[1:0] / y). Datasheet calls these "MOV RXFIFO[TX]" variants.
4. **JMP `x--`/`y--`**: decrement occurs when the condition is *true*
   (X != 0) — the disassembler prints `x--` for cond 0x2 whose datasheet
   name is "X-- post-decrement and jump if not zero". RTL must decrement
   exactly on taken-condition evaluation.
5. **WAIT jmppin**: v1-only; offset 0-3; any arg2 bits [4:2] nonzero is a
   reserved encoding.
6. **in null / out null**: `null` as IN source discards but (per
   datasheet) still shifts ISR — pioasm encodes it as source 0x3 with no
   special handling, so the shift behaviour is purely a datasheet fact
   (flagged for the RTL cycle contract).
7. **`in status` (arg1 0x5)** and `mov ..., status` (source 0x5) read the
   `.mov_status`-configured status: TX FIFO level < N, RX FIFO level < N,
   or IRQ flag N set (with prev/next inter-block variants on v1).

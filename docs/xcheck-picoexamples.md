# Cross-check: PIO spec vs raspberrypi/pico-examples

This document cross-verifies `docs/pio-spec.md` against the PIO programs in
**raspberrypi/pico-examples**, and catalogues the programs as future
conformance tests for the vibe-pio RTL.

## 1. Provenance

- Repository: https://github.com/raspberrypi/pico-examples
- Clone location: `third_party/pico-examples/` (gitignored, shallow clone)
- Commit: **c81c855ffdedc825975a40ba357723a71358ddf0**
- Commit date: 2026-07-03 (cloned/verified 2026-08-23)
- Scope: all 26 `.pio` files (36 assembled programs) plus the PIO-using
  examples without a `.pio` file (`pio/logic_analyser`, `pio/uart_dma`,
  `pio/squarewave/squarewave_div_sync`, `adc/dma_capture`,
  `pio/i2c/i2c_bus_scan`, `dma/channel_irq`).
- All programs declare `.pio_version 0` where the directive is present —
  none of the examples exercise RP2350-only PIO features (MOV put/get,
  WAIT JMPPIN, MOV PINDIRS dst, IN_COUNT, cross-PIO IRQ). The RP2350-specific
  bits exercised are the SDK-level ones: 3 PIO blocks, `NUM_PIOS`,
  `*_mask64` pin APIs, divider phase restart across SMs
  (`squarewave_div_sync`).

## 2. Inventory (future conformance tests)

Legend: ss = side-set bits (incl. enable bit if `opt`); FIFO join as per
`.fifo`/`sm_config_set_fifo_join`; shift = (dir R/L, auto, thresh).

| # | Example / program | File | Instructions used | Config footprint | Demonstrated behaviour (from comments/README) |
|---|---|---|---|---|---|
| 1 | `resistor_dac_5bit` | `adc/dma_capture/resistor_dac.pio` | OUT PINS 5 (single instr + default wrap) | out pins 5; shift R, autopull @5; JOIN_TX; fractional clkdiv | 5-bit resistor-DAC sawtooth for ADC capture at `sample_rate_hz` |
| 2 | `pio_serialiser` | `dma/channel_irq/pio_serialiser.pio` | OUT PINS 1, `.wrap_target/.wrap` | out pins 1; JOIN_TX; clkdiv; shift R auto @32 | Serialise 32-bit FIFO words LSB-first; DMA-to-PIO with IRQ on completion |
| 3 | `addition` | `pio/addition/addition.pio` | PULL; MOV X,~OSR; MOV Y,OSR; JMP (always/`x--`/`!x`/`y--`); MOV ISR,~X; PUSH | explicit push/pull, autopush/autopull **disabled**; default config | Add two FIFO words via `x + y == ~(~x - y)`; tests `~` MOV op and pre-decrement JMP loops |
| 4 | `apa102_mini` | `pio/apa102/apa102.pio` | OUT PINS 1 side 0; NOP side 1; `.side_set 1` | out 1 pin; sideset 1; shift L, autopull @32; JOIN_TX; clkdiv = sys/2·baud | TX-only SPI (CLK = side-set, DIN = OUT); MSB-first, 1 bit / 2 cycles |
| 5 | `apa102_rgb555` | same | PULL; SET X,n; IN OSR 5; OUT NULL 5; IN NULL 3; JMP x--; IN Y 8; MOV ISR,::ISR; OUT NULL 1; SET X,31; SET PINS 0/1; MOV PINS,ISR [6]; IN ISR 1 [6] | no sideset; `public` labels; two-entry public interface | Unpack two RGB555 pixels per FIFO word; IN ISR used as **right-rotation**; `::` bit-reverse for MSB-first wire order; manual bit-bang with delay 6 |
| 6 | `clocked_input` | `pio/clocked_input/clocked_input.pio` | WAIT 0 PIN 1; WAIT 1 PIN 1; IN PINS 1 | in pins base+0 data, base+1 clock; shift **L**, autopush @8; JOIN_RX | Externally-clocked sampling (SPI mode 0/3); note: "data actually sampled one **system clock** cycle after the rising edge", recommend input_clk < clk_sys/6 (input synchroniser latency) |
| 7 | `differential_manchester_tx` | `pio/differential_manchester/differential_manchester.pio` | OUT X 1; JMP !x with side 1 [6]; NOP; JMP side 0 [6]; JMP [7]; `.side_set 1 opt` | sideset 1 **opt**; shift R auto @32; JOIN_TX; clkdiv; forced `pull block` via `pio_sm_exec` before enable | 1 bit / 16 cycles; transition at bit start ('0') or start+middle ('1'); `opt` sideset so delay-only instructions exist; blocking PULL pre-executed to hold line state |
| 8 | `differential_manchester_rx` | same | WAIT 1 PIN 0 [11]; JMP PIN; IN X 1; IN Y 1 [1] | IN base = JMP_PIN = RX pin; shift R auto @32; JOIN_RX; forced SET X,1 / SET Y,0 | Samples at 3/4-bit "eye"; X/Y preloaded as constant 1/0 sources for IN |
| 9 | `hello` | `pio/hello_pio/hello.pio` | PULL; OUT PINS 1; JMP loop | out pins 1; default everything else | Minimal FIFO→pin; blocking PULL stalls on empty FIFO |
| 10 | `hub75_row` | `pio/hub75/hub75.pio` | OUT PINS 5 [7] side 0x2; OUT X 27 [7] side 0x3; JMP x-- side 0x0; `.side_set 2` | out 5 row pins; sideset 2 (LATCH, OEn); shift R auto @32; `hub75_wait_tx_stall` polls FDEBUG.TXSTALL | Row select + LATCH pulse + OEn PWM width = X+1; sticky TXSTALL used as "done" flag |
| 11 | `hub75_data_rgb888` | same | PULL side 0 (patched at runtime to OUT NULL n); IN OSR 1; OUT NULL 8; OUT NULL 32; IN NULL 26; MOV PINS,::ISR side 1 | out 6 pins; sideset 1 (clock); out shift R auto @24; **in shift L, no autopush**; JOIN_TX; entry via forced JMP; **self-modifying code** (`instr_mem` patched per bit-plane) | Bit-plane pixel shift; OUT NULL as discard; IN NULL 26 for pin reordering; runtime instruction patching of shift0/shift1 |
| 12 | `i2c` | `pio/i2c/i2c.pio` | JMP y--; IRQ WAIT 0 rel; SET X,7; OUT PINDIRS 1 [7]; NOP side 1 [2]; WAIT 1 PIN 1 [4]; IN PINS 1 [7]; JMP x-- side 0 [7]; JMP PIN side 0 [2]; OUT X 6; OUT Y 1; JMP !x; OUT NULL 32; OUT EXEC 16; JMP x--; `.side_set 1 opt pindirs` | out/set pin = SDA; in base SDA; sideset = SCL; JMP_PIN = SDA; out shift L auto @16 (**halfword** FIFO writes); in shift L auto @8; clkdiv; OE **inverted in pads** (`gpio_set_oeover INVERT`) | Full I2C master: clock stretching via WAIT PIN, open-drain via OUT PINDIRS + inverted OE, NAK handling with `irq wait 0 rel`, and **OUT EXEC** streaming start/stop instructions from the FIFO (Instr field, n+1 words) |
| 13 | `set_scl_sda` | same | SET PINDIRS 0/1 side 0/1 [7]; `.side_set 1 opt` | instruction table only (never run as program) | Software picks one of 4 instructions and feeds it through the i2c OUT EXEC mechanism |
| 14 | `nec_receive` | `pio/ir_nec/nec_receive_library/nec_receive.pio` | SET X,n; WAIT 0 PIN 0; JMP PIN; JMP X--; MOV ISR,NULL; WAIT 1 PIN 0; JMP; NOP [n]; IN PINS 1; `.define` constants | in base = JMP_PIN; shift R autopush @32; JOIN_RX; clkdiv for 10 ticks/562.5 µs | NEC IR decode: burst/sync detection with `jmp pin` early-exit; `MOV ISR,NULL` to reset ISR between frames |
| 15 | `nec_carrier_burst` | `pio/ir_nec/nec_transmit_library/nec_carrier_burst.pio` | SET X; WAIT 1 IRQ 7; SET PINS 1; SET PINS 0 [1]; JMP X-- | set pins 1; `.define public TICKS_PER_LOOP` for timing | 25% duty carrier gated by **WAIT 1 IRQ** (waits, then flag auto-cleared by the waiting SM — cross-SM handshake with program 16) |
| 16 | `nec_carrier_control` | `pio/ir_nec/nec_transmit_library/nec_carrier_control.pio` | PULL; SET X; IRQ 7 (nowait); JMP X--; NOP [15]; IRQ 7 [1]; OUT X 1; JMP !X; NOP [3]; JMP !OSRE | shift R, **no autopull**, pull_thresh = bits_per_frame; JOIN_TX; clkdiv | PPM data via nowait IRQs to the carrier SM; `jmp !osre` loop termination on shift counter; **IRQ with delay field** |
| 17 | `manchester_tx` | `pio/manchester_encoding/manchester_encoding.pio` | NOP side 0 [5]; JMP side 1 [3]; NOP side 1 [5]; NOP side 0 [3]; OUT X 1; JMP !x; `.side_set 1 opt` | sideset 1 opt; shift R auto @32; JOIN_TX; entry at public `start` | 1 bit / 12 cycles, '0' = high-low, '1' = low-high |
| 18 | `manchester_rx` | same | WAIT 0/1 PIN 0; IN Y/X 1 [8]; JMP PIN; `.wrap` between sections | in base = JMP_PIN; shift R auto @32; JOIN_RX; forced SET X,1 / SET Y,0; forced `wait 1 pin 0` (with delay bits set!) before enable | 1 bit / 12 cycles decode; preloaded X/Y constants; SM parked in a WAIT via forced instruction before SM_ENABLE |
| 19 | `onewire` | `pio/onewire/onewire_library/onewire_library.pio` | SET X,n side 1 [15]; JMP x-- side 1 [15]; MOV ISR,PINS side 0; PUSH side 0; OUT X 1 side 0; JMP !x side 1 [5]; IN PINS 1 side 0 [4]; IN NULL 1 side 0 [8]; `.side_set 1 pindirs` (no opt) | in/sideset = data pin; shift R autopush AND autopull @bits_per_word; clkdiv = 1 µs/cycle; runtime-generated `jmp reset_bus side 0` encoded in C via `pio_encode_jmp|pio_encode_sideset` | 1-Wire master: open-drain via sideset **pindirs**, manual PUSH (`mov isr,pins` explicitly "avoids autopush" for the presence pulse), autopull bit stream, cycle-annotated timing (16/7 cycles etc.) |
| 20 | `blink` | `pio/pio_blink/blink.pio` | PULL block; OUT Y 32; MOV X,Y; SET PINS 1/0; JMP x-- ×2; `.wrap_target/.wrap` | set pins 1; default config | 32-bit-delay blink; `pull block`/`out y,32` (bitcount 32 ⇒ arg2 0) |
| 21 | `pwm` | `pio/pwm/pwm.pio` | PULL noblock side 0; MOV X,OSR; MOV Y,ISR; JMP x!=y; JMP side 1; NOP; JMP y--; `.side_set 1 opt` | sideset 1 opt; period preloaded into ISR by software | **Non-blocking PULL falling back to MOV OSR,X** (comment: "Pull from FIFO to OSR if available, else copy X to OSR"); MOV Y,ISR reads ISR without pushing; equal-length branch paths |
| 22 | `quadrature_encoder` | `pio/quadrature_encoder/quadrature_encoder.pio` | JMP table (16 entries, `.origin 0`); MOV ISR,Y; PUSH noblock; OUT ISR 2; IN PINS 2; MOV OSR,ISR; MOV PC,ISR; MOV Y,~Y; JMP Y-- (to next addr = pure decrement) | `.origin 0` (computed jump); in base = JMP_PIN; shift L, **no autopush**; JOIN_NONE; clkdiv | **Computed jump via MOV PC,ISR** into a 16-entry table; `PUSH noblock` + RX-FIFO-drain read protocol; `JMP Y--,<next addr>` as pure decrement; `MOV OSR,ISR` as state save; ISR-as-accumulator |
| 23 | `quadrature_encoder_substep` | `pio/quadrature_encoder_substep/quadrature_encoder_substep.pio` | IN X 32; IN Y 32; OUT ISR 2; IN PINS 2; MOV OSR,~ISR; MOV PC,OSR; JMP Y--; SET X,1; MOV X,::X; JMP X--; MOV PC,**~STATUS**; MOV Y,~Y; SET X,0; jump table with per-entry delays [0..4] | `.origin 0`; shift L autopush @32; out shift R no autopull; **STATUS_SEL/N written directly** (`execctrl = … | 0x12`); clkdiv 1.0; forced SET/MOV for init | Status-driven flow control: `MOV PC,~STATUS` branches to address 0x1f (push) when FIFO has room (STATUS all-ones), else to `JMP update_state [1]` at 0x1f? — inverts STATUS into the PC; constant 13-cycle loop via per-branch delays; `MOV X,::X` to build 2^31 direction marker |
| 24 | `spi_cpha0` | `pio/spi/spi.pio` | OUT PINS 1 side 0 [1]; IN PINS 1 side 1 [1]; `.side_set 1` | out=MOSI, in=MISO, sideset=SCK; shift L autopull @n_bits, autopush @n_bits; clkdiv; **input sync bypass on MISO**; CPOL via pad out-invert | 2-instruction full-duplex SPI; comment: "sideset proceeds even if instruction stalls, so we stall with SCK low" |
| 25 | `spi_cpha1` | same | OUT X 1 side 0; MOV PINS,X side 1 [1]; IN PINS 1 side 0 | as above | Data via `mov pins` on the OUT mapping (comment explicitly: "mov pins uses OUT mapping"); leading-edge transition |
| 26 | `spi_cpha0_cs` / `spi_cpha1_cs` | same | OUT PINS 1 side 0x0 [1]; IN PINS 1 side 0x1; JMP x-- side 0x1; MOV X,Y side 0x0; JMP !osre side 0x1; NOP side 0x0 [1]; PULL ifempty side 0x2 [1]; `.side_set 2` | sideset 2 (SCK, CSn); X,Y preloaded via forced SET to n−2; entry at public label; wrap includes the pull | Auto chip-select: CSn deasserts when FIFO bottoms out (`jmp !osre`); **`pull ifempty` "to avoid time-of-check race"**; front/back porch delays |
| 27 | `squarewave` | `pio/squarewave/squarewave.pio` | SET PINDIRS 1; SET PINS 1 [1]; SET PINS 0; JMP again | set pins 1 | Baseline square wave with explicit JMP |
| 28 | `squarewave_wrap` | `pio/squarewave/squarewave_wrap.pio` | SET PINDIRS 1; SET PINS 1 [1]; SET PINS 0 [1]; `.wrap_target/.wrap` | set pins 1; wrap configured manually in `squarewave.c` (raw API path) | Wrap as "a free (0-cycle) unconditional jump" |
| 29 | `squarewave_fast` | `pio/squarewave/squarewave_fast.pio` | SET PINDIRS 1; SET PINS 1; SET PINS 0; wrap | set pins 1 | One toggle/cycle (max SM output rate) |
| 30 | `squarewave_div_sync` (C only) | `pio/squarewave/squarewave_div_sync.c` | reuses `squarewave` | clkdiv **65535** (max); SMs on multiple PIO blocks; `pio_clkdiv_restart_sm_multi_mask` / `pio_enable_sm_multi_mask_in_sync` | CLKDIV_RESTART phase alignment across SMs of 2–3 PIO blocks; period ≈ 1748 µs; verifies 3 PIOs (`NUM_PIOS`, claims last-PIO-first) |
| 31 | `st7789_lcd` | `pio/st7789_lcd/st7789_lcd.pio` | OUT PINS 1 side 0; NOP side 1; wrap; `.side_set 1` | sideset = clock, out = data; JOIN_TX; shift L autopull @8 (byte via **narrow store replication**); `st7789_lcd_wait_idle` polls FDEBUG.TXSTALL | 62.5 Mbps serial LCD; TXSTALL as idle indicator; byte writes to TX FIFO |
| 32 | `uart_rx_mini` | `pio/uart_rx/uart_rx.pio` | WAIT 0 PIN 0; SET X,7 [10]; IN PINS 1; JMP x-- [6] | in pin = RX; shift R autopush @8; JOIN_RX; clkdiv = sys/8·baud | Minimal 8n1 RX; start-bit wait, 8 cycles/bit |
| 33 | `uart_rx` | same | + JMP PIN; IRQ 4 rel; WAIT 1 PIN 0; PUSH (blocking, no autopush) | in base = JMP_PIN; shift R **no autopush**; JOIN_RX | Framing-error/break handling with **sticky `irq 4 rel` flag** and idle wait; byte read from top byte of FIFO (right-shift ⇒ data left-justified: entry at MSB end) |
| 34 | `uart_tx` | `pio/uart_tx/uart_tx.pio` | PULL side 1 [7]; SET X,7 side 0 [7]; OUT PINS 1; JMP x-- [6]; `.side_set 1 opt` | OUT and side-set **both mapped to the TX pin**; shift R no autopull; JOIN_TX | Start/stop via side-set, data via OUT on the same pin — exercises side-set vs OUT same-cycle priority ("side-set wins", spec §4/§10); stall with line idle via PULL side 1 |
| 35 | `ws2812` | `pio/ws2812/ws2812.pio` | OUT X 1 side 0 [T3−1]; JMP !x side 1 [T1−1]; JMP side 1 [T2−1]; NOP side 0 [T2−1]; `.side_set 1`; `.define public` T1..T3 | sideset = data pin; shift L autopull @24/32; JOIN_TX; clkdiv from cycles_per_bit | WS2812 timing; comment: "**Side-set still takes place when instruction stalls**" (autopull stall on `out x`) |
| 36 | `ws2812_parallel` | same | OUT X 32; MOV PINS,!NULL [T1−1]; MOV PINS,X [T2−1]; MOV PINS,NULL [T3−2]; wrap | out pins = pin_count wide; shift R auto @32; JOIN_TX | Parallel LEDs; **MOV PINS,!NULL / MOV PINS,NULL** as all-ones/all-zeros wide writes |
| 37 | `logic_analyser` (C only) | `pio/logic_analyser/logic_analyser.c` | single `IN PINS n` built with `pio_encode_in`, wrap set via `sm_config_set_wrap` | shift R autopush @32−(32%n); JOIN_RX; DMA on RX DREQ; armed by forced `pio_encode_wait_gpio(level, pin)`; `pio_sm_restart` to clear ISR counter + FIFO between runs | Triggered logic capture; **non-divisor autopush thresholds** (e.g. 30 for 3 pins, left-justified data); forced WAIT GPIO as arm; SM_RESTART semantics |
| 38 | `uart_dma` (C only) | `pio/uart_dma/uart_dma.c` | reuses uart_rx/uart_tx programs | DMA + PIO IRQ at 921600 baud | Full-duplex DMA loopback conformance workload |
| 39 | `i2c_bus_scan` (C only) | `pio/i2c/i2c_bus_scan.c` | reuses `i2c` program | as #12 | I2C bus scan via OUT EXEC instruction records |

### Encodings spot-check

Verified against the spec §2 encoding table (hand-decoded; consistent with
pioasm rules in the spec):

- `out pins, 1` → `0x6001`; `set pins, 1` → `0xE001`; `set x, 7` → `0xE427`.
- `nop` = `mov y, y` → `0xA042` (spec §3.6 alias) — appears in apa102,
  spi, pwm, manchester, ws2812, i2c.
- `pull noblock` = class 4, b7=1, IfE=0, Blk=0 → arg1 `0x05` (pwm);
  `pull ifempty` → IfE=1, Blk=1 → arg1 `0x07` (spi_*_cs); `pull` default
  Block=1 → arg1 `0x05`? — per pioasm defaults Block=1/IfEmpty=0 → arg1 = 1
  (b5 only). Spec §3.5 bit positions (Blk=b5, IfE=b6) match all uses.
- `irq wait 0 rel` → arg2 = `0x10|(2<<3)|0` = mode REL at b4:3=10 (i2c);
  `wait 1 irq 7` → pol=1, src=10 (nec_carrier_burst) — matches §3.2.
- `mov pc, ~status` → class 5, dst=PC(5), op=invert(1), src=STATUS(5)
  (quadrature_encoder_substep) — matches §3.6.
- `out exec, 16` → arg1=7, arg2=16 (i2c) — matches §3.4/§14.2-adjacent
  OUT EXEC semantics.
- Delay/side-set packing: e.g. `out pins, 1 side 0 [1]` with `.side_set 1`
  → b12:8 = `(1<<4) | 0<<?` … per §4 field = `delay | (side << (5-1))` =
  `1 | (0<<4)` = 0x01 (spi_cpha0). Consistent.

## 3. Discrepancies / extensions vs docs/pio-spec.md

No outright contradictions were found. The findings below are gaps,
confirmations of spec open questions, and constructs the spec describes but
does not emphasise.

### 3.1 Spec gaps / under-specified constructs

1. **IN ISR / IN OSR as a rotate** (apa102_rgb555: `in isr, 1 [6]` with the
   comment "in isr, n rotates ISR by n bits (right rotation only)"). Spec
   §3.3 lists ISR/OSR as IN sources but never states that shifting a
   register into itself *rotates* it (the shifted-in bits re-enter at the
   other end), nor how this interacts with IN_SHIFTDIR and the autopush
   counter (the shift counter still increments — apa102 keeps autopush
   disabled). Conformance test must pin: `in isr,1` with right shift
   rotates; with left shift rotates the other way; counter still advances.
2. **`in osr, 5` into ISR without disturbing OSR's counter** (apa102_rgb555,
   hub75_data_rgb888). Spec §3.3 says IN PINS/etc. shift the *ISR* counter;
   it does not explicitly state that reading OSR as an IN source leaves the
   **OSR** shift counter untouched (examples rely on this: OSR is then
   advanced separately with `out null, 5`). Worth an explicit line.
3. **Side-set asserted during autopull/autopush stalls** — ws2812
   ("Side-set still takes place when instruction stalls"), spi_cpha0
   ("sideset proceeds even if instruction stalls, so we stall with SCK
   low"), uart_tx (stall with stop bit via `pull side 1`). This *confirms*
   spec §4/§9, including for FIFO-induced stalls (not only WAIT); the RTL
   test suite should include stall+side-set cases on OUT with autopull.
4. **`pull ifempty` as a race-avoidance fence** (spi_*_cs comment: "Note
   ifempty to avoid time-of-check race"). The examples rely on the
   conditional-PULL semantics of §3.5 combined with `jmp !osre` in the
   preceding loop; the *cycle-level* ordering (does `pull ifempty` consume
   a word when the counter has reached threshold even if OSR was just
   refilled by autopull?) is exactly the §14.4 open question. Flag for
   `docs/cycle-contract.md`.
5. **Non-blocking PUSH and the "drain then read one more" protocol**
   (quadrature_encoder: `push noblock` in a free-running loop; the C code
   reads `level+1` entries to get a fresh sample). Confirms RXSTALL-not-set
   / data-dropped behaviour of §3.5 implicitly, but adds the requirement
   that non-blocking PUSH **clears ISR and resets the ISR counter** every
   loop iteration (data loss is expected/benign). Spec states it (§3.5
   Block=0: "ISR still cleared") — examples validate it.
6. **`mov isr, pins` / `mov isr, y` vs autopush** (onewire comment:
   "read all pins to ISR (avoids autopush)"; quadrature_encoder: `mov
   isr,y` then `push noblock`). Implies **MOV into ISR does not trigger
   autopush** even when autopush is enabled, and (per §3.6) MOV ISR resets
   the ISR counter. Spec §3.6 covers the counter reset but never says
   autopush is not evaluated on MOV — add an explicit "MOV never interacts
   with FIFOs/autopush" line to §3.6.
7. **MOV PINS,!NULL / MOV PINS,NULL as wide constant writes**
   (ws2812_parallel). Spec's MOV table lists NULL as a source but doesn't
   note this idiom; encoding-wise it is just src=3 with invert. No change
   needed, useful test vector.
8. **Runtime instruction patching and self-modifying programs**
   (hub75_data_rgb888: `instr_mem` rewritten by software while the SM runs;
   i2c: arbitrary instructions injected through OUT EXEC). Spec §7 covers
   INSTR_MEM as write-only system register, but the *interaction with a
   running SM* (when is a patched instruction word observed — next fetch,
   no invalidation needed since 1-write/4-read register file) is not
   stated. Cheap to pin in the cycle contract.
9. **Forced-instruction init idioms** — every RX/TX program with
   preconditions uses `pio_sm_exec` while disabled: `set x/y`, `mov
   osr,y`, `pull block`, `wait 1 pin 0` (manchester_rx even ORs delay bits
   into the forced WAIT). Spec §7/§11 cover SMx_INSTR (delay ignored!
   manchester_rx's `| pio_encode_delay(2)` on a forced instruction is
   cosmetic — a silicon-vs-spec nuance worth a test) and PC-not-advanced.
   Note the forced `wait` in logic_analyser is executed **before**
   SM_ENABLE is set, and arming depends on it latching (EXEC_STALLED);
   spec §7 mentions the latch but not that ENABLE=0 + forced WAIT is the
   documented arming idiom.
10. **STATUS used as branch via `mov pc, ~status`** (quadrature_encoder_
    substep). Confirms §3.6 STATUS semantics under direct `execctrl`
    programming. **Example-side inconsistency worth noting:** the C comment
    says "set up status to be rx_fifo < 1" but writes `0x12`
    (STATUS_SEL bits 6:5 = 0 = TXLEVEL, STATUS_N = 0x12 = 18). Per spec
    §7 field layout the programmed selection is TXLEVEL < 18, which for a
    TX FIFO unused at reset (level 0 < 18) is constantly true — the
    program works because TX is never used, but the comment does not match
    the encoding. Not a spec gap; do not emulate the comment.
11. **FIFO narrow (halfword/byte) accesses** — i2c ("TX FIFO should be
    accessed with halfword writes, to ensure the data is immediately
    available in the OSR" — i.e. a 16-bit autopull threshold with 16-bit
    FIFO writes avoids write-retirement latency), st7789 (byte writes +
    narrow store replication), uart_rx (byte read from `&rxf + 3`). These
    are IO-fabric/DREQ behaviours outside PIO Chapter 11; the spec rightly
    omits them — record as out-of-scope for the RTL except FIFO read/write
    widths must not block on the full 32-bit word.
12. **Timing assumptions tied to input synchroniser latency** —
    clocked_input: "data is actually sampled one system clock cycle after
    the rising edge" and clk < sys/6 recommendation. The spec's 2-FF
    synchroniser (§10, two cycles latency) is consistent, but examples
    give the only concrete numbers for SM-clock-vs-sysclk sampling skew —
    useful for the cycle contract and for modelling `INPUT_SYNC_BYPASS`
    (spi examples bypass it on MISO to shave latency).

### 3.2 Spec statements confirmed by the examples (no change needed)

- Delay-after-stall, side-set-first-cycle (§4): ws2812, spi, uart_tx
  comments quoted above.
- MOV-to-OSR clears the OSR shift counter (§3.6): i2c comment — "costs 2
  instructions: 1 for inversion, and one to cope with the side effect of
  the MOV on TX shift counter".
- Non-blocking PULL on empty FIFO = `MOV OSR,X` (§3.5/§14.7): pwm program
  is built directly on this documented fallback.
- `jmp x--`/`jmp y--` pre-decrement semantics (§3.1/§14.5): addition,
  blink, hub75, quadrature (including the "JMP Y-- to next address is a
  pure decrement" note — decrement happens even though the branch target
  is the fall-through address).
- OUT NULL / IN NULL shift-but-discard (§14.6): hub75 (`out null,32`
  "Discard remainder"), apa102 (`in null,3`), onewire (`in null,1`),
  nec_receive (`mov isr,null`).
- Bit-reverse `::` (§3.6): apa102, hub75, quadrature_encoder_substep.
- IRQ modes: `wait`+auto-clear (nec_carrier_burst WAIT 1 IRQ; uart_rx
  `irq 4 rel` sticky flag), `nowait` signalling (nec_carrier_control),
  `irq wait rel` halt-for-attention (i2c do_nack).
- Wrap as 0-cycle jump (§8): squarewave_wrap vs squarewave vs
  squarewave_fast trio; also hub75/nec/onewire wrap placement mid-program
  (wrap_target ≠ program start).
- FIFO joins (§6): JOIN_TX in all TX-only programs, JOIN_RX in all
  RX-only ones; FSTAT/FDEBUG TXSTALL as completion flag (hub75, st7789).
- Clock divider range: squarewave_div_sync uses the maximum integer
  divisor 65535 (spec §7 range 1–65536).
- `out pindirs` / `set pindirs` / `.side_set pindirs` (§3.4/§3.9/§4):
  i2c, set_scl_sda, onewire, squarewave (`set pindirs,1` as init).
- `.side_set 1 opt` mixed delay/side-set packing (§4): uart_tx,
  differential_manchester_tx, manchester_tx, pwm — instructions both with
  and without `side N` in one program.
- `.origin 0` + computed `mov pc` (§8 note "adjust for program load
  offset"): quadrature encoders pin the reason for `.origin`.

### 3.3 RP2350 coverage note

The examples exercise **none** of the RP2350-only instruction features
(MOV put/get, WAIT JMPPIN, MOV PINDIRS *destination* — only
OUT/SET/side-set PINDIRS appear, which are RP2040 features — IN_COUNT,
PREV/NEXT IRQ). Conformance coverage for §12 must come from other sources
(pio-sdk tests, datasheet pseudocode). The only RP2350-specific behaviour
used is SDK/SDK-register level: 3 PIO blocks and cross-block
CLKDIV_RESTART/enable-in-sync (squarewave_div_sync), which maps to
`CTRL.CLKDIV_RESTART` + `NEXTPREV_CLKDIV_RESTART` (§7).

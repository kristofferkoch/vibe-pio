# Specification sources

Provenance record for the specifications used to build this project.
(Covers the datasheet, the pioasm assembler sources, and the three
cross-check inputs merged into `docs/pio-spec.md`.)

## RP2350 datasheet

| Field    | Value |
|----------|-------|
| URL      | https://datasheets.raspberrypi.com/rp2350/rp2350-datasheet.pdf |
| Downloaded | 2026-08-23 |
| Size     | 7,968,417 bytes |
| SHA-256  | `2877d0f270fb6d6a57943bee58aaad536aa027bea1e5b1c4ce2541a3230d4be8` |

PIO content is extracted into `docs/pio-spec-datasheet.md` (primary source:
datasheet Chapter 11, "PIO", datasheet pages ~875–960).

## pioasm (official PIO assembler)

| Field    | Value |
|----------|-------|
| Historical standalone URL | https://github.com/raspberrypi/pioasm (now returns 404; repo retired) |
| Current source location | https://github.com/raspberrypi/pico-sdk, subdirectory `tools/pioasm` |
| Cloned (sparse, `tools/pioasm` only) | 2026-08-23 |
| pico-sdk commit (clone HEAD) | `98a542c1a62fb549ffb5d66a3e5892b06276b670` (2026-07-03) |
| Last commit touching `tools/pioasm` | `fb53c3802096668606399aba8137ca48398a5401` (2026-06-26, "set _GTHREAD_USE_COND_INIT_FUNC on GCC for pioasm to work around 15.1 bug (#3032)") |
| Local checkout | `third_party/pioasm-sdk/` (git-ignored; not committed to this repo) |

Note: the former standalone `raspberrypi/pioasm` repository no longer exists
on GitHub (404 as of 2026-08-23); pre-built binaries are distributed via
`raspberrypi/pico-sdk-tools` (build scripts only, no pioasm sources). The
canonical sources are the vendored copy inside pico-sdk at `tools/pioasm`,
which is what was extracted here.

PIO content extracted into `docs/pio-spec-pioasm.md` (source files:
`pio_assembler.cpp`, `pio_types.h`, `pio_enums.h`, `pio_disassembler.cpp`,
`parser.yy` under `tools/pioasm/`).

## Cross-check inputs (merged into docs/pio-spec.md 2026-08-23)

### pico-sdk (C SDK register headers + hardware_pio driver)

| Field | Value |
|-------|-------|
| URL | https://github.com/raspberrypi/pico-sdk |
| Commit (clone HEAD) | `98a542c1a62fb549ffb5d66a3e5892b06276b670` ("SDK 2.3.0 Release", 2026-07-03) |
| Cloned | 2026-08-23, sparse (blobless, `--depth 1`), paths `src/rp2350/hardware_regs/...` and `src/rp2_common/hardware_pio/` |
| Local checkout | `third_party/pico-sdk/` (git-ignored). Same commit as `third_party/pioasm-sdk/` — mutually consistent vintage |

Report: `docs/xcheck-picosdk.md` (35 confirmations, 4 corrections/extensions
E1–E4, 8 new facts N1–N8; cited in the spec as "sdk").

### pico-examples

| Field | Value |
|-------|-------|
| URL | https://github.com/raspberrypi/pico-examples |
| Commit | `c81c855ffdedc825975a40ba357723a71358ddf0` (2026-07-03; cloned/verified 2026-08-23) |
| Scope | all 26 `.pio` files (36 assembled programs) + PIO-using C examples |
| Local checkout | `third_party/pico-examples/` (git-ignored, shallow clone) |

Report: `docs/xcheck-picoexamples.md` (39-entry conformance-test
catalogue; observations merged into spec §15; cited as "examples").

### RP2040 datasheet

| Field | Value |
|-------|-------|
| URL | https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf |
| Downloaded | 2026-08-23 |
| Size | 5,301,205 bytes |
| SHA-256 | `be56fbb75ba0ae9e26558a73c93ac3e75c2ad4e6878d3b6703de2a76d886ea8c` |

Report: `docs/xcheck-rp2040.md` (delta-check vs Chapter 3; cited in the
spec as "RDS §x.y"). One §12 addition (STATUS_SEL field relocation) and
several §14 resolutions merged.

# Specification sources

Provenance record for the specifications used to build this project.
(This file covers the datasheet and the pioasm assembler sources.)

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

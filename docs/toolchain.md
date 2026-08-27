# Toolchain

All project tools run inside a pinned, lightweight container defined by
`container/Dockerfile`, so simulation and formal results are reproducible
regardless of the host distribution.

## Image contents

Base: `debian:trixie-slim` (Debian 13).

| Tool | Version | Source / pin |
|---|---|---|
| iverilog / vvp | 12.0 (stable) | Debian package `iverilog` 12.0-2+b1 |
| yosys | 0.68 (git sha1 38e001a6f) | built from source, tag `v0.68`, commit `38e001a6ff74ca434bf4cc02c053f53619160ab0` (with the `abc` submodule) |
| sby (SymbiYosys) | v0.68 | built from source, master commit `b1a1e98cba941ec8433f8dc27f416cd7bb7f14be` |
| z3 | 4.13.3 | Debian package `z3` 4.13.3-1 |
| boolector | 3.2.4 | built from source, tag `3.2.4`, commit `393cdfba3735d334bb4e6525500b8a0280dd41e6` (with CaDiCaL + btor2tools) |
| btormc | 3.2.4 | from the boolector build above |
| make | 4.4.1 | Debian package |
| python3 | 3.13.5 | Debian package (plus `python3-click` for sby, `python-is-python3` for emsdk) |
| git / curl / wget | 2.47.3 / distro | Debian packages |
| verilator | 5.032 | Debian package `verilator` 5.032-1+b2 (the wasm backend and the third lint tool; fixed by the trixie release) |
| emsdk | 6.0.8 | `emsdk` repo tag `6.0.8`, commit `e5bd3d0874e302a18f13c5b41f5bacf9a40c8e59` — commit-verified at build like every git-sourced tool; installs the pinned SDK under `/opt/emsdk` (the AOT wasm link of the Verilated model) |
| node | from emsdk | the SDK's bundled node, symlinked to `/usr/local/bin/node` (the headless gate runner `web/node_gate.js`; a host node works too — `make web` prefers native tools and falls back to the container) |

The container deliberately has **no uv/venv**: every Python script under
`tools/` and `sim/` is stdlib-only and runs on its `python3`. The dev
tooling (ruff, ty, pytest via uv) lives on the host and is gated by
`make py` — see `docs/python-tooling.md`.

Image size (docker): ~3.25 GB disk usage (the emsdk layer — clang,
binaryen, the sysroot and the bundled node — accounts for ~2.7 GB of
it; `make web` links against it, so it stays).

Every git-pinned component is verified at build time: the Dockerfile
`test`s that `git rev-parse HEAD` equals the pinned commit before building,
so a moved upstream tag fails the build instead of silently changing the
toolchain.

## Why yosys and boolector are built from source

- **Debian's `yosys` package (0.52) is built without the ilang frontend**
  (`read_ilang`/`write_ilang` are missing). SymbiYosys passes designs
  between yosys invocations as ilang, so the distro package makes every
  `sby` run fail with `No such command: read_ilang`. We therefore build
  yosys from source. Note that yosys >= 0.68 renamed the ilang commands
  to `read_rtlil`/`write_rtlil`, which is why sby is pinned to a master
  commit rather than the older release tag `yosys-0.47`.
- **Debian's `boolector` package is 1.5.118 (from 2012)** and lacks the
  `btormc` binary that sby's `btor btormc` engine needs. Boolector 3.2.4
  is built from source instead.

The build toolchain (compilers, cmake, headers) is installed and purged
within a single `RUN` layer, so it never bloats the final image.

## Build

```sh
# podman (preferred)
podman build -t vibe-pio:latest container/

# docker
docker build -t vibe-pio:latest container/
```

Build time is dominated by the yosys/boolector compiles (~10 minutes on a
typical laptop).

## Run

Interactive shell with the repo bind-mounted (podman):

```sh
podman run --rm -it -v "$PWD:/work:Z" vibe-pio:latest
```

docker equivalent:

```sh
docker run --rm -it -v "$PWD:/work" vibe-pio:latest
```

One-off command (e.g. a make target), podman and docker respectively:

```sh
podman run --rm -v "$PWD:/work:Z" vibe-pio:latest make toolcheck
docker run --rm -v "$PWD:/work"     vibe-pio:latest make toolcheck
```

The `:Z` relabel flag is podman-specific (SELinux); harmless to omit on
docker.

## make toolcheck

`make toolcheck` (in the repo Makefile) prints the version of every tool;
run it inside the container as above. Expected output with the current
pins:

```
=== toolchain versions ===
Icarus Verilog version 12.0 (stable) ()
Yosys 0.68 (git sha1 38e001a6f, Release, GNU /usr/bin/c++ 14.2.0)
SBY v0.68
Z3 version 4.13.3 - 64 bit
3.2.4
btormc 3.2.4
Python 3.13.5
Verilator 5.032 2025-01-01 rev (Debian 5.032-1+b2)
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.8 (...)
node v24.19.0
```

## Verification performed

- `make toolcheck` runs inside the container with the repo bind-mounted.
- A minimal SymbiYosys BMC proof (4-bit counter, depth 10) passes with all
  three engine configurations: `smtbmc z3`, `smtbmc boolector`, and
  `btor btormc` (each `DONE (PASS, rc=0)`).

## Caveats

- sby is pinned to a *master* commit (not a release tag) because the
  newest sby release (`yosys-0.47`) predates the yosys 0.68 command
  rename. Re-pin to a release tag once SymbiYosys publishes one that
  emits `read_rtlil`.
- yosys 0.68 is built via its new CMake flow (`cmake -B build ...`), not
  the historical GNU-make flow; keep that in mind when bumping versions.
- The container has no `iverilog` newer than 12.0 (Debian trixie). That
  satisfies the >= 12 requirement; revisit if a newer iverilog is needed.

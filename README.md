# vibe-pio

A cycle-accurate, formally verifiable Verilog implementation of the Raspberry
Pi RP2350 PIO (Programmable I/O) engine. The model is developed with open-source
tools only — Icarus Verilog for simulation, Yosys for synthesis checks, and
SymbiYosys (sby) for formal verification.

## Why

The end goal goes beyond a hardware replacement block: because the model is
formal-verification friendly, PIO *instruction memory can be treated as
symbolic state*. By asserting desired external behaviour (waveforms, protocol
timing) and letting an SMT solver search the symbolic program space, we can
**synthesize PIO programs from behavioural specifications** — program
extraction by construction.

## Repo layout

```
rtl/       RTL source (SystemVerilog subset supported by iverilog/yosys)
sim/       Classic (non-UVM) testbenches and simulation helpers
formal/    SymbiYosys properties and proof scripts
tools/     Python golden model + assembler/disassembler (C12) and the
           SPEC-/CC- traceability audit
docs/      Reference material, notes extracted from the datasheet
container/ Toolchain image definition (podman/docker)
```

See `DESIGN.md` for architecture decisions, `KANBAN.md` for planned work,
and `IDEAS.md` for loose, undiscussed ideas.

## Toolchain

All tools run inside a pinned, lightweight container (podman or docker) so
the project is reproducible; see `container/` and `docs/toolchain.md`.

- `iverilog` / `vvp` — simulation
- `yosys` — elaboration / synthesis sanity checks
- `sby` (SymbiYosys) with `z3`, `boolector`, or `yices` — formal proofs

Specification sources: the RP2350 datasheet PDF and the `pioasm` assembler
sources, cross-checked against each other; identifiers pinned in
`docs/spec-sources.md`.

Coding standard: always blocks written as `always_ff`/`always_comb` where the
tools support it (iverilog with `-g2012`, yosys with `read_verilog -sv`),
avoiding constructs outside the common iverilog/yosys/SymbiYosys subset.

## Workflow conventions (for agents and humans)

- `KANBAN.md` contains **planned items only**. When an item is done, its
  commit removes it from the board.
- Loose ideas — from human or LLM — go to `IDEAS.md`. Ideas are promoted into
  `KANBAN.md` only after a dedicated discussion ("grilling") session.
- Every commit must record **which model and harness performed the work**,
  as a `Agent:` trailer in the commit message, e.g.
  `Agent: ZCode (builtin:zai-coding-plan/GLM-5.3)`. For purely human work,
  omit the trailer — the git author already identifies the human.

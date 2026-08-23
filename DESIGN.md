# DESIGN

Design decisions and architecture for the vibe-pio PIO engine model.

**Status: skeleton.** Sections below define the intended structure; content
will be filled in as KANBAN items land. Anything marked *(open)* is a
decision still to be grilled before implementation.

## Goals

1. Functionally faithful model of the RP2350 PIO subsystem:
   - PIO block(s): instruction memory, interrupt/IRQ flags, GPIO mapping.
   - State machines (4 per block): the full instruction set (JMP, WAIT, IN,
     OUT, PUSH, PULL, MOV, IRQ, SET), side-set, delay, autopush/autopull,
     FIFO join, shift counters, exec machinery, input synchronizers.
2. Written in the SystemVerilog subset accepted by both iverilog (`-g2012`)
   and yosys (`read_verilog -sv`): `always_ff`, `always_comb`, packed
   structs/enums only if both tools accept them, no interfaces, no classes.
3. Classic directed testbenches plus SymbiYosys formal properties.
4. Ultimately: symbolic instruction memory, so an SMT solver can solve for
   programs satisfying behavioural assertions.

## Non-goals (initial)

- Cycle-exact transistor-level fidelity (e.g. analog/scratch-pad details).
- Register-block bus (APB/AXI) integration; the model starts at the PIO
  engine level with a generic config/bus interface, refined later.
- FPGA-optimized timing closure; correctness first.

## Planned module hierarchy *(draft — to be firmed up in the Phase 2
architecture task from the verified spec; open to revision)*

Structure mirrors the hardware: the RP2350 has 3 PIO blocks, each with its
own instruction memory shared by its 4 state machines (not one global
memory).

```
pio_top
└── pio_block  (x3)
    ├── pio_instr_mem     # 36 x 32-bit instruction memory, shared by 4 SMs,
    │                     # symbolic-capable for program synthesis
    ├── pio_irq_flags     # IRQ flag set/clear logic, force & interrupt routing
    ├── pio_gpio_mux      # input sync, output muxing from SMs / side-set
    └── pio_sm  (x4)
        ├── pio_sm_decoder  # instruction decode
        ├── pio_sm_exec     # execute stage, delay/side-set handling
        ├── pio_sm_shift    # ISR/OSR shifters, autopush/pull, shift counters
        ├── pio_sm_fifo     # RX/TX FIFOs (join modes), push/pull
        └── pio_sm_regs     # clock divider, pin mapping, wrap, exec
```

## Formal strategy

- Per-module safety properties (onehot FSM states, FIFO bounds, shift
  counter bounds) proven with `sby` BMC + k-induction (`prove`).
- A reference behaviour spec (golden model in properties or a reference
  implementation) against which the RTL is proven equivalent — likely via
  a `miter` or assertion-based co-simulation in `formal/`.
- Symbolic program synthesis harness: `pio_instr_mem` contents become free
  (anyconst/anyseq) signals; behavioural constraints (e.g. "SCK toggles
  every cycle", "MISO sampled on rising edge") are asserted on the GPIO
  interface; solver output is a witness PIO program.

## Verification tools

| Tool | Use |
|--------|-----|
| iverilog + vvp | directed/random testbenches (`sim/`) |
| yosys | elaboration & synthesis sanity (`syn` target) |
| sby + SMT solver | BMC, induction, equivalence, synthesis harness (`formal/`) |

## Key reference

- RP2350 datasheet, §PIO (programmable I/O). Facts to be transcribed into
  `docs/` as they become load-bearing (instruction encoding, FIFO depths,
  interrupt semantics, clock divider behaviour, differences from RP2040).

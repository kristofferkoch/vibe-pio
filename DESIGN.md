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

## RTL conventions

Decided:

- Single edge-triggered clock named `clk`; single synchronous, active-high
  reset named `rst` (asserted and released synchronous to `clk`).
- Active-low signals carry the suffix `_n` (e.g. `fifo_empty_n` would be
  avoided — prefer positive `fifo_empty`; `_n` is reserved for genuinely
  active-low interfaces like an external `irq_n`).
- Register module-internal signals carry the suffix `_r` (e.g. `osr_r`,
  `pc_r`). Combinational signals and module ports carry no suffix;
  combinational outputs of `always_comb` may use `_c` if disambiguation
  helps, but default is no suffix.
- SystemVerilog subset: files use `.sv` extension; `logic` everywhere (no
  `reg`/`wire` declarations); `always_ff` for state, `always_comb` for
  logic, no `always @*`/`always @(posedge ...)`.
- Non-blocking assignments (`<=`) in `always_ff`, blocking (`=`) in
  `always_comb`; never mix in one block.
- Constants: `localparam`/`parameter` names in UPPER_SNAKE_CASE; widths
  always explicit (e.g. `logic [4:0]`, sized from a localparam like
  `PC_W`), never bare numbers in port/Signal declarations.
- Module and instance naming: modules already prefixed `pio_`; instances
  lowercase `u_`-prefixed (e.g. `u_decoder`).
- Formal-friendliness: every stateful element reset by `rst` (helps
  k-induction); no reliance on X-propagation; memories use synchronous
  read with registered output to keep yosys memory inference clean and
  the symbolic-instruction-memory swap trivial.

Decided (confirmed by owner):

- The SM clock divider is modeled as `clk`-rate logic producing a
  one-cycle `sm_tick` strobe per SM; all SM state advances only on
  `sm_tick` (side-set/delay counting included). Alternative: a gated
  clock — rejected because gated clocks hurt formal verification.
- FSM states encoded as `localparam` one-hot values with explicit names
  (e.g. `ST_FETCH`, `ST_EXEC`), no inferred state encoding, so formal
  onehotness assertions are meaningful.
- Handshake/stall vocabulary: `stall` (SM stalled this cycle), `fifo_rd`,
  `fifo_wr`, `push`/`pull` — matching datasheet vocabulary where possible
  so assertions read like spec facts.
- LSB/MSB shift directions expressed as a boolean `shift_left` derived
  from config, not duplicated `if` trees.
- One `always_ff` per logical register group (PC+regs, shifters, FIFO)
  rather than one giant block, to keep induction proofs modular.
- No `generate` loops around the 4 SMs — instantiate 4 named instances
  (`u_sm0..u_sm3`) so waveforms and solver traces stay readable.

## Planned module hierarchy *(draft — to be firmed up in the Phase 2
architecture task from the verified spec; open to revision)*

Structure mirrors the hardware: the RP2350 has 3 PIO blocks, each with its
own instruction memory shared by its 4 state machines (not one global
memory).

```
pio_top
└── pio_block  (x3)
    ├── pio_instr_mem     # 32 x 16-bit instruction memory (datasheet §11.2.8,
    │                     # see docs/pio-spec.md §14.1), shared by 4 SMs,
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

# KANBAN

Planned work items **only**. When an item is completed, the finishing commit
deletes it from this file. Loose ideas must NOT be added here — put them in
`IDEAS.md` and promote them after a grilling session.

Card conventions (all RTL cards):

- RTL follows DESIGN.md "RTL conventions": `.sv` files, `clk`/`rst`,
  `_r`/`_n` suffixes, onehot `localparam` FSM states, one `always_ff` per
  register group, all state reset by `rst`, `logic` only, explicit widths.
- **Traceability rule**: every RTL comment and formal assertion cites the
  SPEC-/CC- IDs it implements/verifies. An assertion citing no fact is
  unsourced; a fact with no assertion is unverified.
- **Done-when (every card)**: `iverilog -g2012` compiles the module plus
  its testbench; `yosys read_verilog -sv` elaborates the module clean
  (hierarchy check); `make sim` runs the card's directed TB and passes;
  its `formal/*.sby` passes BMC and `prove` (k-induction) unless noted.
- Full port lists live in DESIGN.md §Module descriptions — not duplicated
  here.

## Later-level backlog (coarse by design — detail at launch)

### Testbenches (sim/)

- [ ] UART TX loopback conformance test at a realistic clkdiv, checking
      bit timing against the divider model (CC-26/CC-2). Depends: C10.
- [ ] Manchester rx tick divergence: root-cause, rectify, and put the
      closed-loop SM->pin->SM timing angle under test. CF12
      (tb_conf_pioexamples) decodes word 0 exactly then walks (word 2 =
      0xffff_f000); divider-invariant (CLKDIV 1/2/4 byte-identical,
      readback-verified) so a deterministic tick-domain divergence in
      our RTL — the example runs on silicon at div 1 and no pinned
      SPEC/CC clause is violated. Bisect: stimulus word0 = 0x8000_0000
      (first bit still 0 for the arming assumption) so the walk is
      visible inside word 0, then tick-trace pc0/pc1/line through the
      first word boundary. Suspects (each unpinned by the docs): the
      tx's 33rd `out x,1` autopull refill costing a tick (a 13-tick
      bit), WAIT completing on an already-matching level a tick early,
      JMP-PIN sample alignment. Acceptance: CF12 restored to the full
      3-word loopback green at clkdiv 1 with red/green against the
      found defect; whichever corner it lands on gets a CC- clause plus
      FV or directed coverage; same-angle edge-locked receivers under
      test too: differential_manchester rx+tx loopback, uart_rx
      (start-bit edge lock + bit-centre sampling; coordinate with the
      UART card above), nec_receive optional. Depends: conformance TB
      (6aa72b3, landed).

### Formal (formal/)

- [ ] Traceability audit script: cross-check assertion-cited SPEC-/CC-
      IDs in `rtl/`+`formal/` against the fact/clause indexes; report
      unverified facts and unsourced assertions. Depends: C0 + any RTL.
- [ ] Equivalence/performance contract: reference behavioural spec vs
      RTL for a fixed program (miter or co-simulation in formal/).
      Depends: C10.
- [ ] Symbolic program synthesis harness: anyconst `pio_instr_mem` swap
      (reset disabled in harness), behavioural assertions on GPIO/FIFO
      ports of `pio_top`, extract witness program; run as BMC/cover, not
      k-induction. Depends: C10 (and `pio_top`, which itself remains a
      later-level item: 3 blocks + cross-block IRQ relay per CC-38 and
      DESIGN.md pio_top section).

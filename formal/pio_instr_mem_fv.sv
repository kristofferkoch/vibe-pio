// Formal properties for pio_instr_mem (KANBAN C1).
//
// Wrapper instantiates the DUT and checks, per CC-33 / SPEC-1-2 /
// SPEC-14.1-1 / SPEC-7-10:
//   P1..P4  combinational read identity + last-written value: for the
//           anyconst observed address `a', any port whose rd_addr equals
//           a returns the last word written to a (or 0 after reset).
//   P5      CC-33 write-retire visibility: wr_en@e with (wr_addr,wr_data)
//           ⇒ any read at wr_addr in e+1 returns wr_data.
//   P6      old-word visibility during e: a read colliding with the write
//           in cycle e itself still returns the pre-write word (CC-33:
//           "a fetch in cycle <= e observes the old word").
//   P7      stability: with rst and a write to `a' both absent in the
//           previous cycle, the observed word is stable (write strobe
//           absent ⇒ array stable; only the addressed word ever changes).
//   P8      reset: one clk after rst asserts (and while held), reads
//           return 0 (reset contents all-zero words).
// Structural note (checked by inspection / yosys hierarchy): the module
// has no read enables and no architectural state beyond the 32 words
// (mem_r) — satisfying the C1 "no state beyond the 32 words" clause.
//
// Style note (owner convention): yosys does not support SVA concurrent
// assertions / `disable iff`; properties are immediate assertions inside
// `always @(posedge clk)` guards, with explicit previous-cycle registers
// instead of `$past`/`|=>` (equivalent one-cycle-sampled checks). This
// file is formal-only (never compiled by iverilog), so the RTL
// convention against `always @(...)` does not apply.
//
// k-induction tractability: the only DUT state is mem_r (fully reset)
// plus the bookkeeping registers below, so the induction state space is
// canonical — DESIGN.md §k-induction tractability.

module pio_instr_mem_fv (
    input  logic        clk,
    input  logic        rst,
    input  logic        wr_en,
    input  logic [4:0]  wr_addr,
    input  logic [15:0] wr_data,
    input  logic [4:0]  rd_addr1,
    input  logic [4:0]  rd_addr2,
    input  logic [4:0]  rd_addr3
);

  localparam int AW = 5;
  localparam int DW = 16;

  logic [15:0] rd_data0, rd_data1, rd_data2, rd_data3;

  // Anyconst observed address: prove reads return the last-written word
  // at an arbitrary address (SPEC-1-2: 32x16 1W/4R file; SPEC-14.1-1:
  // 32 is authoritative). Read port 0 is tied to `a' in this harness so
  // the invariant mem[a] == exp_r is checked EVERY step — without this,
  // k-induction can skip `a' on all free ports and the invariant is not
  // inductive. Ports 1..3 stay free inputs.
  (* anyconst *) logic [AW-1:0] a;
  logic [AW-1:0] rd_addr0;
  always_comb rd_addr0 = a;

  pio_instr_mem u_dut (
      .clk      (clk),
      .rst      (rst),
      .wr_en    (wr_en),
      .wr_addr  (wr_addr),
      .wr_data  (wr_data),
      .rd_addr0 (rd_addr0),
      .rd_addr1 (rd_addr1),
      .rd_addr2 (rd_addr2),
      .rd_addr3 (rd_addr3),
      .rd_data0 (rd_data0),
      .rd_data1 (rd_data1),
      .rd_data2 (rd_data2),
      .rd_data3 (rd_data3)
  );

  // Expected content of word `a': 0 after reset (DESIGN.md reset
  // content, SPEC-7-10 write-only slots), else the last wr_data written
  // to `a' (write retires end of e — CC-33).
  logic [DW-1:0] exp_r = '0;  // init: canonical post-reset value
  always_ff @(posedge clk) begin
    if (rst)                        exp_r <= '0;
    else if (wr_en && wr_addr == a) exp_r <= wr_data;  // CC-33 retire
  end

  // Previous-cycle bookkeeping (explicit $past replacement — owner
  // convention for this repo's yosys).
  // Initial values make the bookkeeping sound from step 0 (yosys
  // honours FF `init` in smtbmc); the $initstate assume below pins the
  // DUT side (CC-1 reset protocol).
  logic          p_rst_r  = 1'b1;   // rst in the previous clk cycle
  logic          p_wr_en_r = 1'b0;  // wr_en in the previous clk cycle
  logic [AW-1:0] p_wr_addr_r = '0;
  logic [DW-1:0] p_wr_data_r = '0;
  logic [DW-1:0] p_exp_r   = '0;    // exp_r in the previous clk cycle
  always_ff @(posedge clk) begin
    p_rst_r     <= rst;
    p_wr_en_r   <= wr_en;
    p_wr_addr_r <= wr_addr;
    p_wr_data_r <= wr_data;
    p_exp_r     <= exp_r;
  end

  // Reset protocol (CC-1: synchronous rst asserted at time 0): without
  // this, the synchronously-reset FFs (DUT mem_r and bookkeeping) are
  // unconstrained in the initial state and the properties have no
  // meaning until one reset edge has retired.
  always @(posedge clk) begin
    if ($initstate) assume (rst);
  end

  // P1..P4: each combinational read port returns the last-written value
  // at its address (combinational identity; CC-33, SPEC-1-2).
  // All checks skip $initstate (DUT mem_r is free before the first
  // reset edge; the assume above pins rst in that state).
  always @(posedge clk) begin
    if (!$initstate) begin
    if (rd_addr0 == a) a_p1 : assert (rd_data0 == exp_r);
    if (rd_addr1 == a) a_p2 : assert (rd_data1 == exp_r);
    if (rd_addr2 == a) a_p3 : assert (rd_data2 == exp_r);
    if (rd_addr3 == a) a_p4 : assert (rd_data3 == exp_r);
    // P5: CC-33 — write retiring end of e visible to reads from e+1 on
    // every port; only the addressed word changes. Guard excludes a
    // write coinciding with rst (rst wins in the DUT and in exp_r).
    if (p_wr_en_r && !p_rst_r && rd_addr0 == p_wr_addr_r)
      a_p5a : assert (rd_data0 == p_wr_data_r);
    if (p_wr_en_r && !p_rst_r && rd_addr1 == p_wr_addr_r)
      a_p5b : assert (rd_data1 == p_wr_data_r);
    if (p_wr_en_r && !p_rst_r && rd_addr2 == p_wr_addr_r)
      a_p5c : assert (rd_data2 == p_wr_data_r);
    if (p_wr_en_r && !p_rst_r && rd_addr3 == p_wr_addr_r)
      a_p5d : assert (rd_data3 == p_wr_data_r);
    // P6: CC-33 — a read colliding with the write in cycle e itself sees
    // the OLD word (exp_r not yet updated at the sampled edge).
    if (wr_en && wr_addr == a) begin
      if (rd_addr0 == a) a_p6a : assert (rd_data0 == exp_r);
      if (rd_addr1 == a) a_p6b : assert (rd_data1 == exp_r);
      if (rd_addr2 == a) a_p6c : assert (rd_data2 == exp_r);
      if (rd_addr3 == a) a_p6d : assert (rd_data3 == exp_r);
    end
    // P7: no write to `a' and no rst in the previous cycle ⇒ the
    // observed word is stable (SPEC-7-10 slots change only on writes;
    // rst excluded because it clears every word).
    if (!p_rst_r && !(p_wr_en_r && p_wr_addr_r == a))
      a_p7 : assert (exp_r == p_exp_r);
    // P8: reset contents — one clk after rst asserts (and while held),
    // reads return 0 (KANBAN C1: all-zero words).
    if (p_rst_r && rd_addr0 == a) a_p8 : assert (rd_data0 == '0);

    // Covers: each port observably returns a written (non-reset) word.
    if (rd_addr0 == a && rd_data0 != '0) c_port0 : cover (1'b1);
    if (rd_addr1 == a && rd_data1 != '0) c_port1 : cover (1'b1);
    if (rd_addr2 == a && rd_data2 != '0) c_port2 : cover (1'b1);
    if (rd_addr3 == a && rd_data3 != '0) c_port3 : cover (1'b1);
    // Cover: CC-33 write-then-next-cycle-read-back on one port.
    if (p_wr_en_r && rd_addr0 == p_wr_addr_r && rd_data0 == p_wr_data_r
        && p_wr_data_r != '0) c_cc33 : cover (1'b1);
    end
  end

endmodule

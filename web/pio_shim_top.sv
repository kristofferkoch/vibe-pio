// pio_shim_top — wasm-engine top (KANBAN C17): pio_block plus the
// compiled-in invariant subset. The formal proofs live in formal/*_fv.sv
// (yosys dialect, SVA/assume, never compiled by iverilog or here); the
// browser build carries the port-observable slice that holds
// unconditionally in live play, stated as immediate assertions in the
// iverilog/yosys/verilator-common subset (AGENTS.md) so Verilator
// --assert compiles them into the shipped binary — the engine
// self-checks while the game runs.
//
//   i1  CC-33 — the SMx_INSTR readback mux (imem[pc], SPEC-7-24) equals
//       a shadow of the bus-written instruction memory at that SM's pc:
//       the write path and all four fetch read ports stay coherent. The
//       readback mux is free-running (SPEC-16-2), so the equality is
//       asserted whenever the address selects SMx_INSTR, strobe or not
//       (the pio_block_fv_ap p1 idiom). Formal parent: a1 in
//       formal/pio_block_fv.sv (fv_a, same shadow, read-gated).
//   i2  SPEC-7-2 — dbg_sm_en equals a shadow of CTRL.SM_ENABLE writes
//       (the enable storage path; fv_a's a_en is the SMs-never-enabled
//       corner of the same fact).
//   i3  reset contract — after the first rst edge the observables sit at
//       their reset composition (gpio_out/oe 0, intr 16'h00f0: flags 0,
//       TXNFULL 1 with all TX FIFOs empty, SPEC-7-12/29) — the
//       all-state-reset convention made output-visible.
//
// The two PIO_DEFECT_* macros are the red-injection hooks for the C17
// mutation demo (AGENTS.md TDD discipline) — never defined in a real
// build:
//   PIO_DEFECT_INVARIANT — imem word-0 writes are dropped from the
//       shadow: the DUT itself is untouched, so only the compiled-in
//       assertion can catch it (proves the self-check path fires);
//   PIO_DEFECT_SAMPLE_LATE lives in pio_shim.cpp (C++ side).
//
// The dbg_sm0..3_* ports (C18, grown to four SMs by C24) are
// pio_block's per-SM live-state view for the browser client — read by
// pio_shim.cpp's PioCycle sample, not asserted here (their content is
// certified by the model-cross-checked client gate, not an invariant).

module pio_shim_top (
    input  logic clk,
    input  logic rst,

    input  logic [8:0]  reg_addr,
    input  logic [31:0] reg_wdata,
    input  logic        reg_write,
    input  logic        reg_read,
    output logic [31:0] reg_rdata,

    input  logic [31:0] gpio_in,
    output logic [31:0] gpio_out,
    output logic [31:0] gpio_oe,

    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr,
    output logic [7:0]  irq_prev_o,
    output logic [7:0]  irq_next_o,
    output logic [7:0]  prev_exp_set,
    output logic [7:0]  prev_exp_clr,
    output logic [7:0]  next_exp_set,
    output logic [7:0]  next_exp_clr,
    output logic [15:0] intr,

    output logic [3:0]     dbg_sm_en,    // snapshot: enable bank (SPEC-7-2)
    output logic [3:0][4:0] dbg_sm_pc,   // snapshot: fetch addrs (CC-33)
    output logic [3:0]     dbg_force,    // snapshot: force ticks (CC-35)
    // snapshot: per-SM this-clk pad write masks (CC-7 inputs — the C24
    // ownership lens), split into scalar ports for the C++ sample.
    output logic [31:0]    dbg_sm0_wr_mask,
    output logic [31:0]    dbg_sm1_wr_mask,
    output logic [31:0]    dbg_sm2_wr_mask,
    output logic [31:0]    dbg_sm3_wr_mask,

    // Per-SM live-state view (C18 client, grown to four SMs by C24) —
    // pio_block's dbg_sm0..3_* bundles, wired straight through to the
    // shim's per-clk PioCycle sample.
    output logic [3:0]  dbg_sm0_state,
    output logic [4:0]  dbg_sm0_delay,
    output logic [31:0] dbg_sm0_x,
    output logic [31:0] dbg_sm0_y,
    output logic [31:0] dbg_sm0_osr,
    output logic [31:0] dbg_sm0_isr,
    output logic [5:0]  dbg_sm0_osr_cnt,
    output logic [5:0]  dbg_sm0_isr_cnt,
    output logic [3:0]  dbg_sm0_tx_level,
    output logic [3:0]  dbg_sm0_rx_level,
    output logic        dbg_sm0_tx_empty,
    output logic        dbg_sm0_tx_full,
    output logic        dbg_sm0_tick,
    output logic        dbg_sm0_exec,
    output logic        dbg_sm0_complete,
    output logic        dbg_sm0_pc_wr,
    output logic        dbg_sm0_tx_pop,
    output logic        dbg_sm0_rx_push,
    output logic [3:0]  dbg_sm1_state,
    output logic [4:0]  dbg_sm1_delay,
    output logic [31:0] dbg_sm1_x,
    output logic [31:0] dbg_sm1_y,
    output logic [31:0] dbg_sm1_osr,
    output logic [31:0] dbg_sm1_isr,
    output logic [5:0]  dbg_sm1_osr_cnt,
    output logic [5:0]  dbg_sm1_isr_cnt,
    output logic [3:0]  dbg_sm1_tx_level,
    output logic [3:0]  dbg_sm1_rx_level,
    output logic        dbg_sm1_tx_empty,
    output logic        dbg_sm1_tx_full,
    output logic        dbg_sm1_tick,
    output logic        dbg_sm1_exec,
    output logic        dbg_sm1_complete,
    output logic        dbg_sm1_pc_wr,
    output logic        dbg_sm1_tx_pop,
    output logic        dbg_sm1_rx_push,
    output logic [3:0]  dbg_sm2_state,
    output logic [4:0]  dbg_sm2_delay,
    output logic [31:0] dbg_sm2_x,
    output logic [31:0] dbg_sm2_y,
    output logic [31:0] dbg_sm2_osr,
    output logic [31:0] dbg_sm2_isr,
    output logic [5:0]  dbg_sm2_osr_cnt,
    output logic [5:0]  dbg_sm2_isr_cnt,
    output logic [3:0]  dbg_sm2_tx_level,
    output logic [3:0]  dbg_sm2_rx_level,
    output logic        dbg_sm2_tx_empty,
    output logic        dbg_sm2_tx_full,
    output logic        dbg_sm2_tick,
    output logic        dbg_sm2_exec,
    output logic        dbg_sm2_complete,
    output logic        dbg_sm2_pc_wr,
    output logic        dbg_sm2_tx_pop,
    output logic        dbg_sm2_rx_push,
    output logic [3:0]  dbg_sm3_state,
    output logic [4:0]  dbg_sm3_delay,
    output logic [31:0] dbg_sm3_x,
    output logic [31:0] dbg_sm3_y,
    output logic [31:0] dbg_sm3_osr,
    output logic [31:0] dbg_sm3_isr,
    output logic [5:0]  dbg_sm3_osr_cnt,
    output logic [5:0]  dbg_sm3_isr_cnt,
    output logic [3:0]  dbg_sm3_tx_level,
    output logic [3:0]  dbg_sm3_rx_level,
    output logic        dbg_sm3_tx_empty,
    output logic        dbg_sm3_tx_full,
    output logic        dbg_sm3_tick,
    output logic        dbg_sm3_exec,
    output logic        dbg_sm3_complete,
    output logic        dbg_sm3_pc_wr,
    output logic        dbg_sm3_tx_pop,
    output logic        dbg_sm3_rx_push
);

  pio_block u_dut (
      .clk            (clk),
      .rst            (rst),
      .reg_addr       (reg_addr),
      .reg_wdata      (reg_wdata),
      .reg_write      (reg_write),
      .reg_read       (reg_read),
      .reg_rdata      (reg_rdata),
      .gpio_in        (gpio_in),
      .gpio_out       (gpio_out),
      .gpio_oe        (gpio_oe),
      .irq_prev_r     (irq_prev_r),
      .irq_next_r     (irq_next_r),
      .nb_set         (nb_set),
      .nb_clr         (nb_clr),
      .irq_prev_o     (irq_prev_o),
      .irq_next_o     (irq_next_o),
      .prev_exp_set   (prev_exp_set),
      .prev_exp_clr   (prev_exp_clr),
      .next_exp_set   (next_exp_set),
      .next_exp_clr   (next_exp_clr),
      .intr           (intr),
      .dbg_sm_en      (dbg_sm_en),
      .dbg_sm_pc      (dbg_sm_pc),
      .dbg_force      (dbg_force),
      .dbg_sm_wr_mask (gm_wr_mask_c),
      .dbg_sm0_state    (dbg_sm0_state),
      .dbg_sm0_delay    (dbg_sm0_delay),
      .dbg_sm0_x        (dbg_sm0_x),
      .dbg_sm0_y        (dbg_sm0_y),
      .dbg_sm0_osr      (dbg_sm0_osr),
      .dbg_sm0_isr      (dbg_sm0_isr),
      .dbg_sm0_osr_cnt  (dbg_sm0_osr_cnt),
      .dbg_sm0_isr_cnt  (dbg_sm0_isr_cnt),
      .dbg_sm0_tx_level (dbg_sm0_tx_level),
      .dbg_sm0_rx_level (dbg_sm0_rx_level),
      .dbg_sm0_tx_empty (dbg_sm0_tx_empty),
      .dbg_sm0_tx_full  (dbg_sm0_tx_full),
      .dbg_sm0_tick     (dbg_sm0_tick),
      .dbg_sm0_exec     (dbg_sm0_exec),
      .dbg_sm0_complete (dbg_sm0_complete),
      .dbg_sm0_pc_wr    (dbg_sm0_pc_wr),
      .dbg_sm0_tx_pop   (dbg_sm0_tx_pop),
      .dbg_sm0_rx_push  (dbg_sm0_rx_push),
      .dbg_sm1_state    (dbg_sm1_state),
      .dbg_sm1_delay    (dbg_sm1_delay),
      .dbg_sm1_x        (dbg_sm1_x),
      .dbg_sm1_y        (dbg_sm1_y),
      .dbg_sm1_osr      (dbg_sm1_osr),
      .dbg_sm1_isr      (dbg_sm1_isr),
      .dbg_sm1_osr_cnt  (dbg_sm1_osr_cnt),
      .dbg_sm1_isr_cnt  (dbg_sm1_isr_cnt),
      .dbg_sm1_tx_level (dbg_sm1_tx_level),
      .dbg_sm1_rx_level (dbg_sm1_rx_level),
      .dbg_sm1_tx_empty (dbg_sm1_tx_empty),
      .dbg_sm1_tx_full  (dbg_sm1_tx_full),
      .dbg_sm1_tick     (dbg_sm1_tick),
      .dbg_sm1_exec     (dbg_sm1_exec),
      .dbg_sm1_complete (dbg_sm1_complete),
      .dbg_sm1_pc_wr    (dbg_sm1_pc_wr),
      .dbg_sm1_tx_pop   (dbg_sm1_tx_pop),
      .dbg_sm1_rx_push  (dbg_sm1_rx_push),
      .dbg_sm2_state    (dbg_sm2_state),
      .dbg_sm2_delay    (dbg_sm2_delay),
      .dbg_sm2_x        (dbg_sm2_x),
      .dbg_sm2_y        (dbg_sm2_y),
      .dbg_sm2_osr      (dbg_sm2_osr),
      .dbg_sm2_isr      (dbg_sm2_isr),
      .dbg_sm2_osr_cnt  (dbg_sm2_osr_cnt),
      .dbg_sm2_isr_cnt  (dbg_sm2_isr_cnt),
      .dbg_sm2_tx_level (dbg_sm2_tx_level),
      .dbg_sm2_rx_level (dbg_sm2_rx_level),
      .dbg_sm2_tx_empty (dbg_sm2_tx_empty),
      .dbg_sm2_tx_full  (dbg_sm2_tx_full),
      .dbg_sm2_tick     (dbg_sm2_tick),
      .dbg_sm2_exec     (dbg_sm2_exec),
      .dbg_sm2_complete (dbg_sm2_complete),
      .dbg_sm2_pc_wr    (dbg_sm2_pc_wr),
      .dbg_sm2_tx_pop   (dbg_sm2_tx_pop),
      .dbg_sm2_rx_push  (dbg_sm2_rx_push),
      .dbg_sm3_state    (dbg_sm3_state),
      .dbg_sm3_delay    (dbg_sm3_delay),
      .dbg_sm3_x        (dbg_sm3_x),
      .dbg_sm3_y        (dbg_sm3_y),
      .dbg_sm3_osr      (dbg_sm3_osr),
      .dbg_sm3_isr      (dbg_sm3_isr),
      .dbg_sm3_osr_cnt  (dbg_sm3_osr_cnt),
      .dbg_sm3_isr_cnt  (dbg_sm3_isr_cnt),
      .dbg_sm3_tx_level (dbg_sm3_tx_level),
      .dbg_sm3_rx_level (dbg_sm3_rx_level),
      .dbg_sm3_tx_empty (dbg_sm3_tx_empty),
      .dbg_sm3_tx_full  (dbg_sm3_tx_full),
      .dbg_sm3_tick     (dbg_sm3_tick),
      .dbg_sm3_exec     (dbg_sm3_exec),
      .dbg_sm3_complete (dbg_sm3_complete),
      .dbg_sm3_pc_wr    (dbg_sm3_pc_wr),
      .dbg_sm3_tx_pop   (dbg_sm3_tx_pop),
      .dbg_sm3_rx_push  (dbg_sm3_rx_push)
  );

  logic [3:0][31:0] gm_wr_mask_c;  // pio_block per-SM pad writes (CC-7)
  assign dbg_sm0_wr_mask = gm_wr_mask_c[0];
  assign dbg_sm1_wr_mask = gm_wr_mask_c[1];
  assign dbg_sm2_wr_mask = gm_wr_mask_c[2];
  assign dbg_sm3_wr_mask = gm_wr_mask_c[3];

  // -----------------------------------------------------------------------
  // Shadow state (the fv_a reference-model idiom): one always_ff, every
  // register reset by rst.
  // -----------------------------------------------------------------------
  logic [15:0] sh_imem [0:31];  // bus-written instruction memory (SPEC-7-10)
  logic [3:0]  sh_en;           // CTRL.SM_ENABLE storage (SPEC-7-2)
  logic        started_r;       // >= 1 clk seen (i3 only asserts post-edge)
  // i3 may only judge observables once at least one rst edge of the
  // CURRENT reset has retired: on the second-and-later engine resets the
  // pads still carry the previous run's driven levels at the first rst
  // edge (SPEC-10-1 clears them at that edge — found by the C21 client
  // gate's multi-leg run: uart_demo parks gpio_out=1, pin_echo's load
  // tripped the invariant on pre-reset values).
  logic        rst_seen_r;

  always_ff @(posedge clk) begin
    if (rst) begin
      for (int i = 0; i < 32; i++) sh_imem[i] <= 16'd0;
      sh_en      <= 4'd0;
      started_r  <= 1'b1;
      rst_seen_r <= 1'b1;
    end else begin
      rst_seen_r <= 1'b0;
`ifdef PIO_DEFECT_INVARIANT
      // red-injection: word 0 drops out of the shadow (demo leg 2)
      if (reg_write && (reg_addr[8:2] >= 7'd19) && (reg_addr[8:2] <= 7'd49))
`else
      if (reg_write && (reg_addr[8:2] >= 7'd18) && (reg_addr[8:2] <= 7'd49))
`endif
        sh_imem[5'(reg_addr[8:2] - 7'd18)] <= reg_wdata[15:0];
      if (reg_write && (reg_addr[8:2] == 7'd0)) sh_en <= reg_wdata[3:0];
    end
  end

  // -----------------------------------------------------------------------
  // The invariant subset — immediate assertions, owner convention.
  // -----------------------------------------------------------------------
  always_ff @(posedge clk) begin
    if (!rst) begin
      // i1 (CC-33): SMx_INSTR word indexes 54/60/66/72 = SM base 50 +
      // 6*i + 4 (SPEC-7-24). Values are pre-edge sampled (NBA
      // semantics), so readback, shadow and pc are one coherent
      // start-of-cycle view.
      case (reg_addr[8:2])
        7'd54: assert (reg_rdata[15:0] == sh_imem[dbg_sm_pc[0]]) else $error("i1 CC-33 SM0");
        7'd60: assert (reg_rdata[15:0] == sh_imem[dbg_sm_pc[1]]) else $error("i1 CC-33 SM1");
        7'd66: assert (reg_rdata[15:0] == sh_imem[dbg_sm_pc[2]]) else $error("i1 CC-33 SM2");
        7'd72: assert (reg_rdata[15:0] == sh_imem[dbg_sm_pc[3]]) else $error("i1 CC-33 SM3");
        default: ;
      endcase
      // i2 (SPEC-7-2)
      assert (dbg_sm_en == sh_en) else $error("i2 SPEC-7-2 SM_ENABLE");
    end else if (started_r && rst_seen_r) begin
      // i3 (reset contract): from the second rst edge on, every
      // pre-edge observable is a reset value (the first edge retired
      // the previous run's pads — CC-1/SPEC-10-1).
      assert ((gpio_out == 32'd0) && (gpio_oe == 32'd0) && (intr == 16'h00f0))
        else $error("i3 reset observables");
    end
  end

endmodule

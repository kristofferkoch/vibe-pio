// tb_pio_sm_fifo.sv — directed TB for rtl/pio_sm_fifo.sv (KANBAN C3).
//
// Coverage (per the C3 acceptance):
//   1. Reset: levels 0, flags 0, default txrx mode active.
//   2. txrx fill/drain: 4 system TX writes (order preserved on SM
//      pops), 5th write dropped + TXOVER sticky + W1C clear (SPEC-6-5).
//   3. rx fill/drain: 4 SM pushes, system reads in order, read-on-empty
//      sets RXUNDER; rx_stall_req sticky; W1C (SPEC-6-5/6-7).
//   4. FJOIN_RX join: flush-on-change, 8-deep RX, TX disabled reports
//      both full and empty (SPEC-6-2).
//   5. FJOIN_TX join: 8-deep TX, RX disabled (SPEC-6-2).
//   6. txput: aux PUT random access, system reads via sys_aux_rd;
//      SM push in aux mode is a level-preserving no-op (SPEC-3.5-8 RTL
//      choice); TX queue still works (SPEC-6-4).
//   7. txget: system aux writes, SM GET reads (SPEC-7-13).
//   8. putget: SM-only scratch — aux PUT+GET, system aux write ignored.
//   9. Flush-on-mode-change between aux modes (SPEC-6-2/6-3).
//  10. CC-30: system TX write retiring at end of e is visible
//      (tx_empty deasserted) from e+1.
//
// Timing: inputs are driven at negedge, sampled after the retiring
// posedge; SM queue ops are issued with sm_tick high for that clk.

`include "tb_common.sv"

module tb_pio_sm_fifo;

  localparam logic [2:0] MODE_TXRX   = 3'd0;
  localparam logic [2:0] MODE_TX     = 3'd1;
  localparam logic [2:0] MODE_RX     = 3'd2;
  localparam logic [2:0] MODE_TXPUT  = 3'd3;
  localparam logic [2:0] MODE_TXGET  = 3'd4;
  localparam logic [2:0] MODE_PUTGET = 3'd5;

  logic clk;
  logic rst;
  tb_clk_rst u_cr (.clk(clk));

  logic        sm_tick;
  logic [2:0]  fifo_mode;
  logic        rx_push;
  logic [31:0] rx_push_data;
  logic        tx_pop;
  logic [31:0] tx_head_data;
  logic        aux_put;
  logic [1:0]  aux_put_idx;
  logic [31:0] aux_put_data;
  logic        aux_get;
  logic [1:0]  aux_get_idx;
  logic [31:0] aux_get_data;
  logic [3:0]  rx_level, tx_level;
  logic        rx_full, rx_empty, tx_full, tx_empty;
  logic        tx_stall_req, rx_stall_req;
  logic        fdbg_tx_stall, fdbg_rx_stall, fdbg_tx_over, fdbg_rx_under;
  logic [3:0]  fdbg_clr;
  logic        sys_tx_wr;
  logic [31:0] sys_tx_wdata;
  logic        sys_rx_rd;
  logic [31:0] sys_rx_rdata;
  logic        sys_aux_wr;
  logic [1:0]  sys_aux_addr;
  logic [31:0] sys_aux_wdata;
  logic        sys_aux_rd;
  logic [31:0] sys_aux_rdata;

  pio_sm_fifo u_dut (
      .clk (clk), .rst (rst),
      .fifo_mode (fifo_mode),
      .sm_tick (sm_tick),
      .rx_push (rx_push), .rx_push_data (rx_push_data),
      .tx_pop (tx_pop), .tx_head_data (tx_head_data),
      .aux_put (aux_put), .aux_put_idx (aux_put_idx),
      .aux_put_data (aux_put_data),
      .aux_get (aux_get), .aux_get_idx (aux_get_idx),
      .aux_get_data (aux_get_data),
      .rx_level (rx_level), .tx_level (tx_level),
      .rx_full (rx_full), .rx_empty (rx_empty),
      .tx_full (tx_full), .tx_empty (tx_empty),
      .tx_stall_req (tx_stall_req), .rx_stall_req (rx_stall_req),
      .fdbg_tx_stall (fdbg_tx_stall), .fdbg_rx_stall (fdbg_rx_stall),
      .fdbg_tx_over (fdbg_tx_over), .fdbg_rx_under (fdbg_rx_under),
      .fdbg_clr (fdbg_clr),
      .sys_tx_wr (sys_tx_wr), .sys_tx_wdata (sys_tx_wdata),
      .sys_rx_rd (sys_rx_rd), .sys_rx_rdata (sys_rx_rdata),
      .sys_aux_wr (sys_aux_wr), .sys_aux_addr (sys_aux_addr),
      .sys_aux_wdata (sys_aux_wdata),
      .sys_aux_rd (sys_aux_rd), .sys_aux_rdata (sys_aux_rdata)
  );

  // Idle stimulus (everything low between test steps).
  task idle_inputs;
    begin
      sm_tick = 1'b0; rx_push = 1'b0; rx_push_data = '0; tx_pop = 1'b0;
      aux_put = 1'b0; aux_put_idx = '0; aux_put_data = '0;
      aux_get = 1'b0; aux_get_idx = '0;
      tx_stall_req = 1'b0; rx_stall_req = 1'b0; fdbg_clr = '0;
      sys_tx_wr = 1'b0; sys_tx_wdata = '0; sys_rx_rd = 1'b0;
      sys_aux_wr = 1'b0; sys_aux_addr = '0; sys_aux_wdata = '0;
      sys_aux_rd = 1'b0;
    end
  endtask

  // One SM tick with optional queue ops (drive at negedge, retire at
  // posedge, then one idle negedge).
  task sm_op(input logic push, input logic [31:0] pdata,
             input logic pop);
    begin
      @(negedge clk);
      sm_tick = 1'b1; rx_push = push; rx_push_data = pdata; tx_pop = pop;
      @(posedge clk);
      @(negedge clk);
      sm_tick = 1'b0; rx_push = 1'b0; tx_pop = 1'b0;
    end
  endtask

  // One system-side clk-cycle operation.
  task sys_op(input logic twr, input logic [31:0] tdata,
              input logic rrd,
              input logic awr, input logic [1:0] aaddr,
              input logic [31:0] adata, input logic ard);
    begin
      @(negedge clk);
      sys_tx_wr = twr; sys_tx_wdata = tdata; sys_rx_rd = rrd;
      sys_aux_wr = awr; sys_aux_addr = aaddr; sys_aux_wdata = adata;
      sys_aux_rd = ard;
      @(posedge clk);
      @(negedge clk);
      sys_tx_wr = 1'b0; sys_rx_rd = 1'b0; sys_aux_wr = 1'b0;
      sys_aux_rd = 1'b0;
    end
  endtask

  initial begin
    idle_inputs;
    fifo_mode = MODE_TXRX;
    `DO_RESET(4)

    // -- 1. Reset state ------------------------------------------------
    `check32(tx_level, 0) `check32(rx_level, 0)
    `check1(tx_empty, 1)  `check1(rx_empty, 1)
    `check1(tx_full, 0)   `check1(rx_full, 0)
    `check1(fdbg_tx_stall, 0) `check1(fdbg_rx_stall, 0)
    `check1(fdbg_tx_over, 0)  `check1(fdbg_rx_under, 0)

    // -- 2. txrx: TX fill/drain, TXOVER (SPEC-6-5) ----------------------
    sys_op(1, 32'hA0, 0, 0, '0, '0, 0);
    sys_op(1, 32'hA1, 0, 0, '0, '0, 0);
    sys_op(1, 32'hA2, 0, 0, '0, '0, 0);
    sys_op(1, 32'hA3, 0, 0, '0, '0, 0);
    `check32(tx_level, 4) `check1(tx_full, 1)
    // CC-30: write retiring at end of e visible from e+1 — level 1 here.
    sys_op(0, '0, 0, 0, '0, '0, 0);  // spacer to re-test below
    sys_op(1, 32'hA4, 0, 0, '0, '0, 0);   // dropped: full
    `check32(tx_level, 4)
    `check1(fdbg_tx_over, 1)
    @(negedge clk); fdbg_clr = 4'b0010; @(posedge clk); @(negedge clk);
    fdbg_clr = '0;
    `check1(fdbg_tx_over, 0)
    // Drain in order; check head before each pop tick (CC-29/CC-4).
    `check32(tx_head_data, 32'hA0) sm_op(0, '0, 1);
    `check32(tx_level, 3)
    `check32(tx_head_data, 32'hA1) sm_op(0, '0, 1);
    `check32(tx_head_data, 32'hA2) sm_op(0, '0, 1);
    `check32(tx_head_data, 32'hA3) sm_op(0, '0, 1);
    `check32(tx_level, 0) `check1(tx_empty, 1) `check1(tx_full, 0)

    // CC-30 explicit: stalled-pull view — write at e, empty gone at e+1.
    sys_op(1, 32'hB0, 0, 0, '0, '0, 0);
    `check1(tx_empty, 0)  // sampled one clk after the write retired
    `check32(tx_head_data, 32'hB0)
    sm_op(0, '0, 1);
    `check32(tx_level, 0)

    // -- 3. txrx: RX fill/drain, RXUNDER, rx_stall (SPEC-6-5/6-7) -------
    sm_op(1, 32'hC0, 0); sm_op(1, 32'hC1, 0);
    sm_op(1, 32'hC2, 0); sm_op(1, 32'hC3, 0);
    `check32(rx_level, 4) `check1(rx_full, 1)
    sm_op(1, 32'hC4, 0);                  // full: dropped, level holds
    `check32(rx_level, 4)
    sys_op(0, '0, 1, 0, '0, '0, 0);       // pop C0
    `check32(rx_level, 3)
    sys_op(0, '0, 1, 0, '0, '0, 0);
    `check32(rx_level, 2)
    `check32(sys_rx_rdata, 32'hC2)        // head-of-queue now C2
    sys_op(0, '0, 1, 0, '0, '0, 0);
    sys_op(0, '0, 1, 0, '0, '0, 0);
    `check32(rx_level, 0) `check1(rx_empty, 1)
    sys_op(0, '0, 1, 0, '0, '0, 0);       // read on empty
    `check1(fdbg_rx_under, 1)
    @(negedge clk); fdbg_clr = 4'b0001; @(posedge clk); @(negedge clk);
    fdbg_clr = '0;
    `check1(fdbg_rx_under, 0)
    // rx_stall_req from exec (blocking push on full — CC-19/CC-32).
    sm_op(0, '0, 0);  // idle tick
    @(negedge clk); sm_tick = 1'b1; rx_stall_req = 1'b1;
    @(posedge clk); @(negedge clk); sm_tick = 1'b0; rx_stall_req = 1'b0;
    `check1(fdbg_rx_stall, 1)
    @(negedge clk); fdbg_clr = 4'b0100; @(posedge clk); @(negedge clk);
    fdbg_clr = '0;
    `check1(fdbg_rx_stall, 0)
    // tx_stall_req (CC-20).
    @(negedge clk); sm_tick = 1'b1; tx_stall_req = 1'b1;
    @(posedge clk); @(negedge clk); sm_tick = 1'b0; tx_stall_req = 1'b0;
    `check1(fdbg_tx_stall, 1)
    @(negedge clk); fdbg_clr = 4'b1000; @(posedge clk); @(negedge clk);
    fdbg_clr = '0;
    `check1(fdbg_tx_stall, 0)

    // -- 4. FJOIN_RX join (SPEC-6-2) ------------------------------------
    // Leave something in RX first, then check the change flushes.
    sm_op(1, 32'hD0, 0);
    `check32(rx_level, 1)
    @(negedge clk); fifo_mode = MODE_RX; @(posedge clk); @(negedge clk);
    `check32(rx_level, 0) `check32(tx_level, 0)
    `check1(tx_full, 1) `check1(tx_empty, 1)   // stolen TX: both (SPEC-6-2)
    `check1(rx_empty, 1) `check1(rx_full, 0)
    for (int i = 0; i < 8; i++) sm_op(1, 32'hE0 + i, 0);
    `check32(rx_level, 8) `check1(rx_full, 1)
    for (int i = 0; i < 8; i++) begin
      `check32(sys_rx_rdata, 32'hE0 + i)
      sys_op(0, '0, 1, 0, '0, '0, 0);
    end
    `check32(rx_level, 0)
    // TX is dead in this mode: system write dropped, TXOVER.
    sys_op(1, 32'hFF, 0, 0, '0, '0, 0);
    `check32(tx_level, 0) `check1(fdbg_tx_over, 1)
    @(negedge clk); fdbg_clr = 4'b0010; @(posedge clk); @(negedge clk);
    fdbg_clr = '0;

    // -- 5. FJOIN_TX join (SPEC-6-2) ------------------------------------
    @(negedge clk); fifo_mode = MODE_TX; @(posedge clk); @(negedge clk);
    `check1(rx_full, 1) `check1(rx_empty, 1)   // stolen RX: both
    sm_op(1, 32'hDEAD, 0);                     // push no-op (dead RX)
    `check32(rx_level, 0)
    for (int i = 0; i < 8; i++) sys_op(1, 32'hF0 + i, 0, 0, '0, '0, 0);
    `check32(tx_level, 8) `check1(tx_full, 1)
    for (int i = 0; i < 8; i++) begin
      `check32(tx_head_data, 32'hF0 + i)
      sm_op(0, '0, 1);
    end
    `check32(tx_level, 0)

    // -- 6. txput (SPEC-6-3/6-4, SPEC-3.7-3) ----------------------------
    @(negedge clk); fifo_mode = MODE_TXPUT; @(posedge clk); @(negedge clk);
    `check32(rx_level, 0)
    // SM push is a no-op in aux mode (SPEC-3.5-8 RTL choice).
    sm_op(1, 32'hBAD1, 0);
    `check32(rx_level, 0)
    // PUT into each register (random order, overwrite included).
    sm_op(0, '0, 0);  // (formatting no-op tick)
    @(negedge clk); sm_tick = 1'b1; aux_put = 1'b1; aux_put_idx = 2'd2;
    aux_put_data = 32'h1234; @(posedge clk); @(negedge clk);
    sm_tick = 1'b0; aux_put = 1'b0; aux_put_idx = 2'd0; aux_put_data = '0;
    sm_tick = 1'b1; aux_put = 1'b1; aux_put_idx = 2'd0;
    aux_put_data = 32'h5678; @(posedge clk); @(negedge clk);
    sm_tick = 1'b0; aux_put = 1'b0; aux_put_idx = 2'd0; aux_put_data = '0;
    sm_tick = 1'b1; aux_put = 1'b1; aux_put_idx = 2'd2;
    aux_put_data = 32'h9ABC;   // overwrite idx 2
    @(posedge clk); @(negedge clk);
    sm_tick = 1'b0; aux_put = 1'b0; aux_put_idx = 2'd0; aux_put_data = '0;
    // System reads via RXFx_PUTGET (SPEC-7-13).
    sys_op(0, '0, 0, 0, '0, '0, 0);  // settle
    `check32(u_dut.rx_mem[0], 32'h5678)
    `check32(u_dut.rx_mem[2], 32'h9ABC)
    // TX queue still normal in aux mode (SPEC-6-4).
    sys_op(1, 32'h77, 0, 0, '0, '0, 0);
    `check32(tx_level, 1)
    `check32(tx_head_data, 32'h77)
    sm_op(0, '0, 1);
    `check32(tx_level, 0)

    // -- 7. txget (SPEC-7-13, SPEC-3.7-3) -------------------------------
    @(negedge clk); fifo_mode = MODE_TXGET; @(posedge clk); @(negedge clk);
    sys_op(0, '0, 0, 1, 2'd1, 32'h1111, 0);
    sys_op(0, '0, 0, 1, 2'd3, 32'h2222, 0);
    // GET: combinational register read, never stalls (CC-21).
    `check32(u_dut.rx_mem[1], 32'h1111)
    `check32(u_dut.rx_mem[3], 32'h2222)
    @(negedge clk); aux_get = 1'b1; aux_get_idx = 2'd3; #1;
    `check32(aux_get_data, 32'h2222)
    aux_get_idx = 2'd1; #1;
    `check32(aux_get_data, 32'h1111)
    @(negedge clk); aux_get = 1'b0; aux_get_idx = 2'd0;
    // GET never moves levels (CC-21).
    `check32(rx_level, 0) `check32(tx_level, 0)

    // -- 8. putget (SM-only scratch, SPEC-3.7-5) ------------------------
    @(negedge clk); fifo_mode = MODE_PUTGET; @(posedge clk); @(negedge clk);
    @(negedge clk); sm_tick = 1'b1; aux_put = 1'b1; aux_put_idx = 2'd1;
    aux_put_data = 32'hCAF0; @(posedge clk); @(negedge clk);
    sm_tick = 1'b0; aux_put = 1'b0; aux_put_idx = 2'd0; aux_put_data = '0;
    // System aux write has no owner in putget — ignored.
    sys_op(0, '0, 0, 1, 2'd1, 32'h0BAD, 0);
    `check32(u_dut.rx_mem[1], 32'hCAF0)
    @(negedge clk); aux_get = 1'b1; aux_get_idx = 2'd1; #1;
    `check32(aux_get_data, 32'hCAF0)
    aux_get = 1'b0; aux_get_idx = 2'd0;
    // TX still usable (SPEC-6-4).
    sys_op(1, 32'h99, 0, 0, '0, '0, 0);
    `check32(tx_level, 1)
    sm_op(0, '0, 1);
    `check32(tx_level, 0)

    // -- 9. Aux-mode change flushes queue state (SPEC-6-2/6-3) ----------
    @(negedge clk); fifo_mode = MODE_TXRX; @(posedge clk); @(negedge clk);
    sm_op(1, 32'h5151, 0);
    `check32(rx_level, 1)
    @(negedge clk); fifo_mode = MODE_TXPUT; @(posedge clk); @(negedge clk);
    `check32(rx_level, 0)

    `TB_FINISH
  end

endmodule

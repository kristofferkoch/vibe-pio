// Formal properties for pio_sm_fifo (KANBAN C3).
//
// Wrapper instantiates the DUT and checks (bmc + prove):
//   P1  level bounds, mode-dependent (SPEC-6-1..4): tx_level <=
//       tx_depth(fifo_mode), rx_level <= rx_depth(fifo_mode) with the
//       0/4/8 depth decode.
//   P2  no overflow/underflow state change (C3 acceptance): a push on a
//       full RX / a system write on a full TX does not raise the level;
//       a pop on an empty TX / a system read on an empty RX does not
//       drop it. Encoded as: level moves only by accepted ops, ±1.
//   P3  sticky flags are set-only until their W1C bit (SPEC-6-7).
//   P4  PUT/GET never change levels (CC-21 — never stall, single tick).
//   P5  CC-30: a system TX write retiring at end of cycle e raises
//       tx_level by exactly 1 at e+1 and tx_empty is deasserted from
//       e+1 whenever the write was accepted (room at e).
//   P6  mode change flushes: if fifo_mode != mode at cycle e, both
//       levels are 0 at e+1 (SPEC-6-2).
//   P7  reset state: levels 0, flags 0 (SPEC-6-1 family / SPEC-6-7).
//
// Assumptions (upstream contracts):
//   - fifo_mode is one of the six defined encodings (regs decode, C5);
//   - exec only pops a non-empty TX queue on a completing tick
//     (CC-20/CC-29) — checked here as an assumption so the "pop on
//     empty is a no-op" gate stays an internal safety net.
//
// Style note: immediate assertions with explicit previous-cycle
// registers (owner convention); formal-only file.

module pio_sm_fifo_fv (
    input  logic        clk,
    input  logic        rst,
    input  logic [2:0]  fifo_mode,
    input  logic        sm_tick,
    input  logic        rx_push,
    input  logic [31:0] rx_push_data,
    input  logic        tx_pop,
    input  logic        aux_put,
    input  logic [1:0]  aux_put_idx,
    input  logic [31:0] aux_put_data,
    input  logic        aux_get,
    input  logic [1:0]  aux_get_idx,
    input  logic        tx_stall_req,
    input  logic        rx_stall_req,
    input  logic [3:0]  fdbg_clr,
    input  logic        sys_tx_wr,
    input  logic [31:0] sys_tx_wdata,
    input  logic        sys_rx_rd,
    input  logic        sys_aux_wr,
    input  logic [1:0]  sys_aux_addr,
    input  logic [31:0] sys_aux_wdata,
    input  logic        sys_aux_rd
);

  localparam logic [2:0] MODE_TXRX   = 3'd0;
  localparam logic [2:0] MODE_TX     = 3'd1;
  localparam logic [2:0] MODE_RX     = 3'd2;
  localparam logic [2:0] MODE_TXPUT  = 3'd3;
  localparam logic [2:0] MODE_TXGET  = 3'd4;
  localparam logic [2:0] MODE_PUTGET = 3'd5;

  logic [3:0]  rx_level, tx_level;
  logic        rx_full, rx_empty, tx_full, tx_empty;
  logic        fdbg_tx_stall, fdbg_rx_stall, fdbg_tx_over, fdbg_rx_under;

  // Data outputs are left dangling ON PURPOSE: every property here is
  // data-independent (levels, flags, visibility timing), and with no
  // read fanout `prep`'s opt_clean prunes the two 8x32 storage arrays
  // (~512 state bits) from the SMT model — without this, even BMC at
  // depth 16 sits in z3 for tens of minutes on memory state no
  // assertion reads. Data-path ordering/value checks live in the
  // directed TB (tb_pio_sm_fifo).
  pio_sm_fifo u_dut (
      .clk (clk), .rst (rst), .fifo_mode (fifo_mode),
      .sm_tick (sm_tick),
      .rx_push (rx_push), .rx_push_data (rx_push_data),
      .tx_pop (tx_pop), .tx_head_data (),
      .aux_put (aux_put), .aux_put_idx (aux_put_idx),
      .aux_put_data (aux_put_data),
      .aux_get (aux_get), .aux_get_idx (aux_get_idx),
      .aux_get_data (),
      .rx_level (rx_level), .tx_level (tx_level),
      .rx_full (rx_full), .rx_empty (rx_empty),
      .tx_full (tx_full), .tx_empty (tx_empty),
      .tx_stall_req (tx_stall_req), .rx_stall_req (rx_stall_req),
      .fdbg_tx_stall (fdbg_tx_stall), .fdbg_rx_stall (fdbg_rx_stall),
      .fdbg_tx_over (fdbg_tx_over), .fdbg_rx_under (fdbg_rx_under),
      .fdbg_clr (fdbg_clr),
      .sys_tx_wr (sys_tx_wr), .sys_tx_wdata (sys_tx_wdata),
      .sys_rx_rd (sys_rx_rd), .sys_rx_rdata (),
      .sys_aux_wr (sys_aux_wr), .sys_aux_addr (sys_aux_addr),
      .sys_aux_wdata (sys_aux_wdata),
      .sys_aux_rd (sys_aux_rd), .sys_aux_rdata ()
  );

  // Reset protocol (CC-1).
  always @(posedge clk) begin
    if ($initstate) assume (rst);
  end

  // Upstream contracts.
  always @(posedge clk) begin
    assume (fifo_mode == MODE_TXRX || fifo_mode == MODE_TX
         || fifo_mode == MODE_RX  || fifo_mode == MODE_TXPUT
         || fifo_mode == MODE_TXGET || fifo_mode == MODE_PUTGET);
    // CC-20/CC-29: exec pops only a non-empty, live TX queue.
    assume (!(sm_tick && tx_pop && (tx_empty || tx_level == 0)));
    // CC-19: exec holds a blocking push while RX is full; the
    // nonblocking push-to-full (dropped, CC-32) is allowed.
  end

  // Previous-cycle bookkeeping.
  logic        p_rst_r = 1'b1;
  logic        p_sm_tick_r = 1'b0;
  logic        p_rx_push_r = 1'b0;
  logic        p_tx_pop_r = 1'b0;
  logic        p_aux_put_r = 1'b0;
  logic        p_aux_get_r = 1'b0;
  logic        p_sys_tx_wr_r = 1'b0;
  logic        p_sys_rx_rd_r = 1'b0;
  logic [2:0]  p_mode_r = MODE_TXRX;
  logic [3:0]  p_tx_level_r = '0;
  logic [3:0]  p_rx_level_r = '0;
  logic        p_fdbg_tx_stall_r = 1'b0;
  logic        p_fdbg_rx_stall_r = 1'b0;
  logic        p_fdbg_tx_over_r  = 1'b0;
  logic        p_fdbg_rx_under_r = 1'b0;
  logic [3:0]  p_fdbg_clr_r = '0;
  // Flush applied at the last clock edge: reset, or the DUT's
  // mode-change flush (fifo_mode != mode_r during the previous cycle —
  // p_mode_r mirrors mode_r, so this reads at the previous cycle).
  logic        p_flush_r = 1'b1;
  always_ff @(posedge clk) begin
    p_flush_r <= rst || (fifo_mode != p_mode_r);
    p_rst_r          <= rst;
    p_sm_tick_r      <= sm_tick;
    p_rx_push_r      <= rx_push;
    p_tx_pop_r       <= tx_pop;
    p_aux_put_r      <= aux_put;
    p_aux_get_r      <= aux_get;
    p_sys_tx_wr_r    <= sys_tx_wr;
    p_sys_rx_rd_r    <= sys_rx_rd;
    // Mirror the DUT's mode_r exactly (reset default TXRX) so the
    // no-flush guard below matches the DUT's own flush decision, also
    // when fifo_mode was already non-default during reset.
    p_mode_r         <= rst ? MODE_TXRX : fifo_mode;
    p_tx_level_r     <= tx_level;
    p_rx_level_r     <= rx_level;
    p_fdbg_tx_stall_r <= fdbg_tx_stall;
    p_fdbg_rx_stall_r <= fdbg_rx_stall;
    p_fdbg_tx_over_r  <= fdbg_tx_over;
    p_fdbg_rx_under_r <= fdbg_rx_under;
    p_fdbg_clr_r     <= fdbg_clr;
  end

  // Reference depth decode (SPEC-6-1..4).
  function automatic logic [3:0] ref_tx_depth(input logic [2:0] m);
    ref_tx_depth = (m == MODE_TX) ? 4'd8
                 : (m == MODE_RX) ? 4'd0 : 4'd4;
  endfunction

  function automatic logic [3:0] ref_rx_depth(input logic [2:0] m);
    ref_rx_depth = (m == MODE_RX) ? 4'd8
                 : (m == MODE_TX || m == MODE_TXPUT
                    || m == MODE_TXGET || m == MODE_PUTGET) ? 4'd0 : 4'd4;
  endfunction

  // Reference accepted-op decode (must mirror the DUT gating; the
  // properties below then constrain the level transitions). The strobe
  // arguments are the *previous-cycle* input values — the DUT's gating
  // during the cycle whose edge produced the levels now visible.
  function automatic logic ref_tx_wr(input logic [2:0] m, input logic [3:0] lvl,
                                     input logic wr);
    ref_tx_wr = wr && (ref_tx_depth(m) != 0)
                && (lvl < ref_tx_depth(m));   // SPEC-6-5
  endfunction

  function automatic logic ref_tx_rd(input logic [2:0] m, input logic [3:0] lvl,
                                     input logic tick, input logic pop);
    ref_tx_rd = tick && pop && (ref_tx_depth(m) != 0) && (lvl != 0);
  endfunction

  function automatic logic ref_rx_wr(input logic [2:0] m, input logic [3:0] lvl,
                                     input logic tick, input logic push);
    ref_rx_wr = tick && push && (ref_rx_depth(m) != 0)
                && (lvl < ref_rx_depth(m));   // SPEC-3.5-4
  endfunction

  function automatic logic ref_rx_rd(input logic [2:0] m, input logic [3:0] lvl,
                                     input logic rd);
    ref_rx_rd = rd && (ref_rx_depth(m) != 0) && (lvl != 0);
  endfunction

  logic p_tx_wr_ref, p_tx_rd_ref, p_rx_wr_ref, p_rx_rd_ref;
  always_comb begin
    p_tx_wr_ref = ref_tx_wr(p_mode_r, p_tx_level_r, p_sys_tx_wr_r);
    p_tx_rd_ref = ref_tx_rd(p_mode_r, p_tx_level_r, p_sm_tick_r, p_tx_pop_r);
    p_rx_wr_ref = ref_rx_wr(p_mode_r, p_rx_level_r, p_sm_tick_r, p_rx_push_r);
    p_rx_rd_ref = ref_rx_rd(p_mode_r, p_rx_level_r, p_sys_rx_rd_r);
  end

  always @(posedge clk) begin
    if (!$initstate) begin
      // P1: level bounds (SPEC-6-1..4) against the *registered* mode —
      // the mode whose depths the current levels were accumulated
      // under (a mode input change flushes only at the edge).
      a_p1_tx : assert (tx_level <= ref_tx_depth(p_mode_r));
      a_p1_rx : assert (rx_level <= ref_rx_depth(p_mode_r));

      if (!p_rst_r && !p_flush_r) begin
        // P2: levels move only by the accepted ops, ±1 each (no
        // overflow / underflow state change).
        a_p2_tx : assert (tx_level == p_tx_level_r
                          + 4'(p_tx_wr_ref) - 4'(p_tx_rd_ref));
        a_p2_rx : assert (rx_level == p_rx_level_r
                          + 4'(p_rx_wr_ref) - 4'(p_rx_rd_ref));

        // P5 (CC-30): accepted system TX write at e ⇒ level +1 and
        // non-empty from e+1. The output-view half additionally needs
        // a stable mode (a same-cycle mode change republishes
        // tx_empty under the new depth before the flush lands).
        if (p_tx_wr_ref && !p_tx_rd_ref) begin
          a_p5_lvl  : assert (tx_level == p_tx_level_r + 4'd1);
          if (fifo_mode == p_mode_r)
            a_p5_nemp : assert (!tx_empty);
        end

        // P4 (CC-21): PUT/GET ticks leave levels untouched even if
        // queue ops coincide — aux terms are absent from P2 by
        // construction; make that explicit:
        if (p_aux_put_r || p_aux_get_r) begin
          if (!p_rx_wr_ref && !p_rx_rd_ref)
            a_p4_rx : assert (rx_level == p_rx_level_r);
          if (!p_tx_wr_ref && !p_tx_rd_ref)
            a_p4_tx : assert (tx_level == p_tx_level_r);
        end
      end

      // P6: a mode change at the last edge flushed both queues
      // (SPEC-6-2). p_flush_r also covers the reset edge (levels 0
      // there per P7).
      if (!p_rst_r && p_flush_r) begin
        a_p6 : assert (tx_level == 4'd0 && rx_level == 4'd0);
      end

      // P3: sticky set-only until W1C (SPEC-6-7).
      if (!p_rst_r) begin
        if (!p_fdbg_clr_r[3])
          a_p3_ts : assert (fdbg_tx_stall >= p_fdbg_tx_stall_r);
        if (!p_fdbg_clr_r[2])
          a_p3_rs : assert (fdbg_rx_stall >= p_fdbg_rx_stall_r);
        if (!p_fdbg_clr_r[1])
          a_p3_to : assert (fdbg_tx_over  >= p_fdbg_tx_over_r);
        if (!p_fdbg_clr_r[0])
          a_p3_ru : assert (fdbg_rx_under >= p_fdbg_rx_under_r);
      end

      // P7: post-reset state (SPEC-6-1/6-7).
      if (p_rst_r) begin
        a_p7 : assert (tx_level == 4'd0 && rx_level == 4'd0
                       && !fdbg_tx_stall && !fdbg_rx_stall
                       && !fdbg_tx_over && !fdbg_rx_under);
      end

      // Covers: every mode exercised, full/empty corners, aux traffic.
      if (fifo_mode == MODE_RX)  c_join_rx : cover (rx_level == 4'd8);
      if (fifo_mode == MODE_TX)  c_join_tx : cover (tx_level == 4'd8);
      if (fifo_mode == MODE_TXRX) begin
        c_tx_full : cover (tx_level == 4'd4);
        c_rx_full : cover (rx_level == 4'd4);
      end
      if (fifo_mode == MODE_TXPUT && sm_tick && aux_put)
        c_put : cover (1'b1);
      if (fifo_mode == MODE_TXGET && sm_tick && aux_get)
        c_get : cover (1'b1);
      if (fdbg_tx_over || fdbg_rx_under) c_dbg : cover (1'b1);
      if (fifo_mode != MODE_TXRX && !rst) c_mode_chg : cover (1'b1);
    end
  end

endmodule

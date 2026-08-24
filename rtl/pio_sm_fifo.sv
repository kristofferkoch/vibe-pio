// pio_sm_fifo — per-SM TX/RX FIFOs with join and the RP2350 aux modes
// (KANBAN C3).
//
// Structure (DESIGN.md §pio_sm_fifo):
//   - 4-deep TX queue + RX storage as one 8-entry array with a
//     mode-selected address source (queue head/tail vs 2-bit index),
//   - FJOIN_TX / FJOIN_RX joins give one direction all 8 words and
//     disable the other (SPEC-6-2),
//   - FJOIN_RX_PUT / FJOIN_RX_GET aux modes turn the RX storage into 4
//     random-access registers while the TX FIFO stays a normal 4-deep
//     queue (SPEC-6-3, SPEC-6-4, SPEC-3.7-3..7),
//   - FDEBUG sticky flags TXSTALL/RXSTALL/TXOVER/RXUNDER, set-only
//     until an explicit clear (SPEC-6-7),
//   - any mode (FJOIN-bit) change flushes both queues (SPEC-6-2).
//
// Division of labour: exec (C8) samples `rx_full`/`tx_empty` at
// start-of-tick (CC-4) for the blocking PUSH/PULL stall decisions
// (CC-19/CC-20) and drives `rx_push`/`tx_pop` only on the completing
// tick; the stall-flag *causes* (including the nonblocking
// push-to-full case, CC-32) come back in as `tx_stall_req` /
// `rx_stall_req` strobes so this module only owns the stickiness.
// System-side ports run at clk rate; a system TX write retiring at end
// of e is visible to the SM side from e+1 because levels are registered
// (CC-30). PUT/GET never assert a stall and never change levels — they
// are pure register accesses, single-tick by construction (CC-21).
//
// Deviation note (as ratified for pio_instr_mem): the two 8x32 arrays
// are flop-based with combinational read (head / index addressed), so
// the SM sees the head word in the executing tick itself (CC-29) and
// the system sees read data in the read cycle.

module pio_sm_fifo (
    input  logic        clk,
    input  logic        rst,

    // FIFO mode, pre-decoded from SHIFTCTRL.FJOIN_* by the regs side
    // (C5). Setting either aux bit clears FJOIN_TX/FJOIN_RX encode-side
    // (SPEC-6-3); this module assumes exactly that consistency.
    input  logic [2:0]  fifo_mode,

    // SM side — queue ops, tick-qualified (ignored off-tick).
    input  logic        sm_tick,
    // PUSH / autopush: append rx_push_data to the RX queue (SPEC-3.5-4,
    // CC-29). Ignored (level-preserving no-op) when the RX side is not
    // a queue (join-stolen or aux — the SPEC-3.5-8 undefined case, RTL
    // chooses no-op) or full (exec holds blocking pushes; a nonblocking
    // push to full is dropped with RXSTALL, CC-32, flagged via
    // rx_stall_req from exec).
    input  logic        rx_push,
    input  logic [31:0] rx_push_data,
    // PULL / autopull: pop the TX head. `tx_head_data` is the
    // start-of-tick head (CC-4/CC-29); the pop lands end-of-tick.
    input  logic        tx_pop,
    output logic [31:0] tx_head_data,

    // SM side — aux random access (PUT/GET), tick-qualified (CC-21).
    // Index comes pre-resolved from the decoder/exec (literal or Y[1:0],
    // SPEC-3.7-4). Never stalls, never changes levels.
    input  logic        aux_put,
    input  logic [1:0]  aux_put_idx,
    input  logic [31:0] aux_put_data,
    input  logic        aux_get,
    input  logic [1:0]  aux_get_idx,
    output logic [31:0] aux_get_data,

    // Status — combinational over registered levels (start-of-tick
    // values, CC-4). A disabled direction reports both full and empty
    // (SPEC-6-2: FSTAT on a stolen FIFO).
    output logic [3:0]  rx_level,
    output logic [3:0]  tx_level,
    output logic        rx_full,
    output logic        rx_empty,
    output logic        tx_full,
    output logic        tx_empty,

    // FDEBUG sticky flags (SPEC-6-7): set-only until fdbg_clr bit.
    // Stall causes are exec's judgement (blocking PULL/autopull-OUT on
    // empty TX; blocking PUSH/autopush-IN or nonblocking PUSH on full
    // RX — CC-19/CC-20/CC-32); TXOVER/RXUNDER are detected here from
    // the system ports (SPEC-6-5).
    input  logic        tx_stall_req,
    input  logic        rx_stall_req,
    output logic        fdbg_tx_stall,
    output logic        fdbg_rx_stall,
    output logic        fdbg_tx_over,
    output logic        fdbg_rx_under,
    input  logic [3:0]  fdbg_clr,   // W1C {tx_stall, rx_stall, tx_over, rx_under}

    // System side — clk-rate queue ports (SPEC-6-5). Write-on-full
    // dropped (+TXOVER); read-on-empty returns storage garbage and sets
    // RXUNDER.
    input  logic        sys_tx_wr,
    input  logic [31:0] sys_tx_wdata,
    input  logic        sys_rx_rd,
    output logic [31:0] sys_rx_rdata,

    // System side — RXFx_PUTGET0..3 random access (SPEC-7-13): reads in
    // PUT mode, writes in GET mode, no system access in PUTGET mode
    // (SPEC-3.7-5 port-ownership rule).
    input  logic        sys_aux_wr,
    input  logic [1:0]  sys_aux_addr,
    input  logic [31:0] sys_aux_wdata,
    input  logic        sys_aux_rd,
    output logic [31:0] sys_aux_rdata
);

  // pioasm `.fifo` configurations (SPEC-6-2/6-3).
  localparam logic [2:0] MODE_TXRX   = 3'd0;  // 4-deep TX + 4-deep RX
  localparam logic [2:0] MODE_TX     = 3'd1;  // FJOIN_TX: 8-deep TX, no RX
  localparam logic [2:0] MODE_RX     = 3'd2;  // FJOIN_RX: 8-deep RX, no TX
  localparam logic [2:0] MODE_TXPUT  = 3'd3;  // aux: TX + PUT registers
  localparam logic [2:0] MODE_TXGET  = 3'd4;  // aux: TX + GET registers
  localparam logic [2:0] MODE_PUTGET = 3'd5;  // aux: TX + SM-only scratch

  localparam int DEPTH = 8;   // joined depth (SPEC-6-1/6-2)
  localparam int LW    = 4;   // level counter width (0..8)

  // Mode classification (combinational).
  logic tx_join_c, rx_join_c, aux_put_c, aux_get_c;
  always_comb begin
    tx_join_c = (fifo_mode == MODE_TX);    // SPEC-6-2
    rx_join_c = (fifo_mode == MODE_RX);    // SPEC-6-2
    aux_put_c = (fifo_mode == MODE_TXPUT) || (fifo_mode == MODE_PUTGET);
    aux_get_c = (fifo_mode == MODE_TXGET) || (fifo_mode == MODE_PUTGET);
  end

  // Mode-dependent depths (SPEC-6-1..4): a stolen direction has depth 0
  // (reports both full and empty); aux modes keep the normal 4-deep TX
  // (SPEC-6-4) and have no RX queue.
  logic [LW-1:0] tx_depth_c, rx_depth_c;
  always_comb begin
    tx_depth_c = tx_join_c ? LW'(DEPTH)
              : (fifo_mode == MODE_RX) ? LW'(0)
              : LW'(4);                                        // SPEC-6-1/6-2/6-4
    rx_depth_c = rx_join_c ? LW'(DEPTH)
              : (fifo_mode == MODE_TX) ? LW'(0)
              : (aux_put_c || aux_get_c) ? LW'(0)
              : LW'(4);                                        // SPEC-6-1..4
  end

  // Registered state.
  logic [2:0]      mode_r;                    // last sampled fifo_mode
  logic [31:0]     tx_mem [0:DEPTH-1];
  logic [31:0]     rx_mem [0:DEPTH-1];
  logic [2:0]      tx_head_r, tx_tail_r;      // 3-bit pointers roam the 8
  logic [2:0]      rx_head_r, rx_tail_r;      // slots; depth is level-limited
  logic [LW-1:0]   tx_level_r, rx_level_r;
  logic            fdbg_tx_stall_r, fdbg_rx_stall_r;
  logic            fdbg_tx_over_r, fdbg_rx_under_r;

  // Flush on any mode change (SPEC-6-2: changing an FJOIN bit
  // discards contents — pointers/levels; storage words are dead).
  logic flush_c;
  assign flush_c = (fifo_mode != mode_r);

  // -----------------------------------------------------------------------
  // Accepted-op decoding. The three RX write sources (SM queue push, SM
  // aux PUT, system aux write) are gated by *mutually exclusive* mode
  // classes, so the single RX array write port never has two owners
  // even if upstream pulses disagree with the mode (SPEC-3.7-5).
  // -----------------------------------------------------------------------
  logic rx_queue_wr_c, rx_queue_rd_c, tx_wr_c, tx_rd_c;
  always_comb begin
    // SM push: only a live RX queue with room (SPEC-3.5-4; no-op in
    // aux/stolen modes — SPEC-3.5-8 RTL choice; full drops are exec's
    // nonblocking case, flagged separately).
    rx_queue_wr_c = sm_tick && rx_push
                    && (rx_depth_c != 0) && (rx_level_r < rx_depth_c);
    // System RX read: pop when non-empty (SPEC-6-5).
    rx_queue_rd_c = sys_rx_rd && (rx_depth_c != 0) && (rx_level_r != 0);
    // System TX write: accepted with room (SPEC-6-5; on-full/on-dead
    // dropped + TXOVER below).
    tx_wr_c = sys_tx_wr && (tx_depth_c != 0) && (tx_level_r < tx_depth_c);
    // SM pop: only a live TX queue with data (CC-29/CC-20 — exec never
    // pops an empty TX, the gate is belt-and-braces).
    tx_rd_c = sm_tick && tx_pop && (tx_depth_c != 0) && (tx_level_r != 0);
  end

  // Aux enables: mode-gated only (never stall, never touch levels —
  // CC-21). System aux access is read-only in PUT mode, write-only in
  // GET mode, none in PUTGET (SPEC-3.7-5).
  logic aux_put_en_c, sys_aux_wr_en_c;
  always_comb begin
    aux_put_en_c    = sm_tick && aux_put && aux_put_c;   // SPEC-3.7-3
    sys_aux_wr_en_c = sys_aux_wr && aux_get_c
                      && (fifo_mode == MODE_TXGET);      // SPEC-3.7-5
  end

  // -----------------------------------------------------------------------
  // Combinational readbacks (flop-array reads; CC-29 head presentation,
  // CC-21 register reads).
  // -----------------------------------------------------------------------
  assign tx_head_data = tx_mem[tx_head_r];               // CC-29
  assign sys_rx_rdata = rx_mem[rx_head_r];               // SPEC-6-5
  assign aux_get_data = rx_mem[aux_get_idx];             // SPEC-3.7-3
  assign sys_aux_rdata = rx_mem[sys_aux_addr];           // SPEC-7-13

  assign rx_level = rx_level_r;
  assign tx_level = tx_level_r;
  assign tx_full  = (tx_depth_c == 0) || (tx_level_r >= tx_depth_c);  // SPEC-6-2
  assign tx_empty = (tx_depth_c == 0) || (tx_level_r == 0);
  assign rx_full  = (rx_depth_c == 0) || (rx_level_r >= rx_depth_c);
  assign rx_empty = (rx_depth_c == 0) || (rx_level_r == 0);

  // -----------------------------------------------------------------------
  // TX queue: storage + pointers + level, one always_ff group.
  // -----------------------------------------------------------------------
  always_ff @(posedge clk) begin
    if (rst) begin
      tx_head_r  <= '0;
      tx_tail_r  <= '0;
      tx_level_r <= '0;
      for (int i = 0; i < DEPTH; i++) tx_mem[i] <= '0;
    end else if (flush_c) begin
      tx_head_r  <= '0;   // SPEC-6-2 flush
      tx_tail_r  <= '0;
      tx_level_r <= '0;
    end else begin
      if (tx_wr_c) begin
        tx_mem[tx_tail_r] <= sys_tx_wdata;  // SPEC-6-5
        tx_tail_r <= tx_tail_r + 3'd1;
      end
      if (tx_rd_c) begin
        tx_head_r <= tx_head_r + 3'd1;      // CC-29 pop lands end-of-tick
      end
      tx_level_r <= tx_level_r + LW'(tx_wr_c) - LW'(tx_rd_c);
    end
  end

  // -----------------------------------------------------------------------
  // RX storage: queue addressing (queue modes) or 2-bit index addressing
  // (aux modes) — one array, mode-selected address (DESIGN.md §pio_sm_fifo).
  // -----------------------------------------------------------------------
  always_ff @(posedge clk) begin
    if (rst) begin
      rx_head_r  <= '0;
      rx_tail_r  <= '0;
      rx_level_r <= '0;
      for (int i = 0; i < DEPTH; i++) rx_mem[i] <= '0;
    end else if (flush_c) begin
      rx_head_r  <= '0;   // SPEC-6-2 flush (queue state only)
      rx_tail_r  <= '0;
      rx_level_r <= '0;
    end else begin
      // Single write port, exclusive owners by mode (SPEC-3.7-5):
      if (rx_queue_wr_c) begin
        rx_mem[rx_tail_r] <= rx_push_data;  // SPEC-3.5-4, CC-29
        rx_tail_r <= rx_tail_r + 3'd1;
      end else if (aux_put_en_c) begin
        rx_mem[{1'b0, aux_put_idx}] <= aux_put_data;  // SPEC-3.7-3, CC-21
      end else if (sys_aux_wr_en_c) begin
        rx_mem[{1'b0, sys_aux_addr}] <= sys_aux_wdata;  // SPEC-7-13
      end
      if (rx_queue_rd_c) begin
        rx_head_r <= rx_head_r + 3'd1;      // SPEC-6-5
      end
      // Aux accesses never move levels (CC-21).
      rx_level_r <= rx_level_r + LW'(rx_queue_wr_c) - LW'(rx_queue_rd_c);
    end
  end

  // Mode sampler (flush edge detect).
  always_ff @(posedge clk) begin
    if (rst) mode_r <= MODE_TXRX;  // reset default (SPEC-7-26 family)
    else     mode_r <= fifo_mode;
  end

  // -----------------------------------------------------------------------
  // FDEBUG sticky flags (SPEC-6-7): set-only until their W1C bit.
  // TXOVER/RXUNDER are local detections (SPEC-6-5); the stall flags are
  // exec's strobes (CC-19/CC-20/CC-32), merely latched here.
  // -----------------------------------------------------------------------
  logic tx_over_set_c, rx_under_set_c;
  always_comb begin
    tx_over_set_c  = sys_tx_wr && !tx_wr_c;    // write dropped (full/dead)
    rx_under_set_c = sys_rx_rd && !rx_queue_rd_c;  // read on empty
  end

  always_ff @(posedge clk) begin
    if (rst) begin
      fdbg_tx_stall_r <= 1'b0;
      fdbg_rx_stall_r <= 1'b0;
      fdbg_tx_over_r  <= 1'b0;
      fdbg_rx_under_r <= 1'b0;
    end else begin
      if (fdbg_clr[3])      fdbg_tx_stall_r <= 1'b0;
      else if (tx_stall_req && sm_tick) fdbg_tx_stall_r <= 1'b1;  // SPEC-6-7
      if (fdbg_clr[2])      fdbg_rx_stall_r <= 1'b0;
      else if (rx_stall_req && sm_tick) fdbg_rx_stall_r <= 1'b1;
      if (fdbg_clr[1])      fdbg_tx_over_r <= 1'b0;
      else if (tx_over_set_c) fdbg_tx_over_r <= 1'b1;
      if (fdbg_clr[0])      fdbg_rx_under_r <= 1'b0;
      else if (rx_under_set_c) fdbg_rx_under_r <= 1'b1;
    end
  end

  assign fdbg_tx_stall = fdbg_tx_stall_r;
  assign fdbg_rx_stall = fdbg_rx_stall_r;
  assign fdbg_tx_over  = fdbg_tx_over_r;
  assign fdbg_rx_under = fdbg_rx_under_r;

endmodule

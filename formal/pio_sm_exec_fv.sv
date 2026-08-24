// Formal properties for pio_sm_exec (KANBAN C8).
//
// Wrapper instantiates the pio_sm-shaped mini-assembly: u_exec (C8) +
// u_dec (C4) + u_shift (C2) + a storage-free FIFO contract stub in
// place of u_fifo (C3) — the card's "instantiated or stubbed" option;
// no exec property reads FIFO storage data, and the real memories
// make z3 case-split for tens of minutes. The divider is abstracted per the C8 acceptance: a free
// `tick_req` with a CC-25 min-gap assumption feeds a pending-hold tick
// model that mirrors C5's structure (terminal-count-then-tick and the
// CC-36 force-tick deferral), so `sm_tick` delivered to the assembly is
// divider-shaped without instantiating C5's 17-bit counter.
//
// Checked (bmc + prove):
//   P1  FSM state is onehot (the four ST_* localparams).
//   P2  Stall/hold invariants (CC-14): pc changes only on completing
//       executions; the delay counter changes only on completing
//       executions, delay ticks, or SM_RESTART.
//   P3  First-condition-true tick is the completion tick (CC-14/15/16):
//       in ST_STALL, a release condition true at an executing tick
//       completes it; a stalled re-execution had the condition false.
//   P4  CC-10: after an sm-sourced completion with loaded delay d, the
//       next sm-sourced instruction's first tick is exactly d+1 sm_ticks
//       later (delay ticks counted; forced interleave and the restart
//       clear-tick invalidate the window).
//   P5  CC-35/CC-36: a force write is followed by a force-tick the next
//       clk; an EXEC_STALLED instruction keeps force-ticking; the tick
//       model never delivers sm_tick together with force_tick; a
//       deferred tick is held through the force-tick and delivered the
//       clk after it drops (divider phase untouched).
//   P6  CC-34: an OUT EXEC completion latches out_data[15:0] into
//       instr_cur and the next sm-sourced first tick executes exactly
//       that word (unless a force write replaced it, SPEC-7-23); a
//       latch-sourced (executee) completion leaves pc unchanged unless
//       the instruction explicitly writes pc.
//
// Assumptions (documented proof scoping):
//   A1  rst asserted in the initial state (CC-1 protocol).
//   A2  tick_req pulses are >= 2 clk apart (CC-25 min-gap, INT >= 2
//       chosen so one dead clk exists between delivered ticks).
//   A3  the imem word is stable while ST_STALL holds (CC-33: no imem
//       writes to a stalled SM's PC within the proof window; the
//       word is otherwise free, including across delay/fetch ticks).
//   A4  fifo_mode is one of the six defined encodings (C3 contract).
//   A5  FIFO system-side ports idle: the sys ports belong to the block
//       bus (C3 is proven independently); exec's properties never read
//       them. Keeps the solver out of free-memory case splits.
//
// Style note (owner convention): immediate assertions inside
// `always @(posedge clk)` with explicit previous-cycle registers;
// formal-only file (never compiled by iverilog).

// FIFO contract stub (KANBAN C8: "instantiated or stubbed per the
// property wrapper"). pio_sm_fifo is proven independently (C3); the
// exec properties read only levels/emptiness, never FIFO storage data
// (data terminates in OSR/X/Y, which no exec assertion inspects), so
// the 2x8x32 storage is elided — the z3 case-split killer. Level and
// pointer arithmetic implement C3's contract: mode-dependent depths
// (SPEC-6-1..4), a dead direction reports both full and empty
// (SPEC-6-2), aux accesses never move levels (CC-21), mode changes
// flush (SPEC-6-2), system ports idle (assumption A5).
module pio_sm_fifo_stub (
    input  logic        clk,
    input  logic        rst,
    input  logic [2:0]  fifo_mode,
    input  logic        sm_tick,
    input  logic        rx_push,
    input  logic [31:0] rx_push_data,
    input  logic        tx_pop,
    output logic [31:0] tx_head_data,
    input  logic        aux_put,
    input  logic [1:0]  aux_put_idx,
    input  logic [31:0] aux_put_data,
    input  logic        aux_get,
    input  logic [1:0]  aux_get_idx,
    output logic [31:0] aux_get_data,
    output logic [3:0]  rx_level,
    output logic [3:0]  tx_level,
    output logic        rx_full,
    output logic        rx_empty,
    output logic        tx_full,
    output logic        tx_empty,
    input  logic        tx_stall_req,
    input  logic        rx_stall_req,
    output logic        fdbg_tx_stall,
    output logic        fdbg_rx_stall,
    output logic        fdbg_tx_over,
    output logic        fdbg_rx_under,
    input  logic [3:0]  fdbg_clr,
    input  logic        sys_tx_wr,
    input  logic [31:0] sys_tx_wdata,
    input  logic        sys_rx_rd,
    output logic [31:0] sys_rx_rdata,
    input  logic        sys_aux_wr,
    input  logic [1:0]  sys_aux_addr,
    input  logic [31:0] sys_aux_wdata,
    input  logic        sys_aux_rd,
    output logic [31:0] sys_aux_rdata
);
  localparam logic [2:0] FM_TXRX = 3'd0, FM_TX = 3'd1, FM_RX = 3'd2,
                         FM_TXPUT = 3'd3, FM_TXGET = 3'd4, FM_PUTGET = 3'd5;

  logic [3:0] tx_level_r, rx_level_r;
  logic [2:0] mode_r;
  logic [3:0] tx_depth_c, rx_depth_c;

  always_comb begin
    tx_depth_c = (fifo_mode == FM_TX) ? 4'd8
              : (fifo_mode == FM_RX) ? 4'd0
              : 4'd4;                                   // SPEC-6-1/2/4
    rx_depth_c = (fifo_mode == FM_RX) ? 4'd8
              : (fifo_mode == FM_TX) ? 4'd0
              : ((fifo_mode == FM_TXPUT) || (fifo_mode == FM_TXGET)
                 || (fifo_mode == FM_PUTGET)) ? 4'd0
              : 4'd4;                                   // SPEC-6-1..4
  end

  logic tx_dec_c, rx_inc_c;
  assign tx_dec_c = sm_tick && tx_pop && (tx_depth_c != 0)
                  && (tx_level_r != 0);                 // CC-29
  assign rx_inc_c = sm_tick && rx_push && (rx_depth_c != 0)
                  && (rx_level_r < rx_depth_c);         // CC-29

  always_ff @(posedge clk) begin
    if (rst) begin
      tx_level_r <= 4'd0;
      rx_level_r <= 4'd0;
      mode_r     <= FM_TXRX;
    end else if (fifo_mode != mode_r) begin
      tx_level_r <= 4'd0;   // SPEC-6-2 flush
      rx_level_r <= 4'd0;
      mode_r     <= fifo_mode;
    end else begin
      tx_level_r <= tx_level_r - {3'd0, tx_dec_c};
      rx_level_r <= rx_level_r + {3'd0, rx_inc_c};
    end
  end

  assign tx_level = tx_level_r;
  assign rx_level = rx_level_r;
  assign tx_full  = (tx_depth_c == 0) || (tx_level_r >= tx_depth_c);  // SPEC-6-2
  assign tx_empty = (tx_depth_c == 0) || (tx_level_r == 0);
  assign rx_full  = (rx_depth_c == 0) || (rx_level_r >= rx_depth_c);
  assign rx_empty = (rx_depth_c == 0) || (rx_level_r == 0);

  // Storage-free data outputs: free values (no assertion reads them).
  assign tx_head_data = 32'hA5A5_0000;
  assign aux_get_data = 32'h5A5A_0000;
  assign sys_rx_rdata = 32'd0;
  assign sys_aux_rdata = 32'd0;
  assign fdbg_tx_stall = 1'b0;
  assign fdbg_rx_stall = 1'b0;
  assign fdbg_tx_over  = 1'b0;
  assign fdbg_rx_under = 1'b0;
endmodule

module pio_sm_exec_fv (
    input  logic        clk,
    input  logic        rst,
    input  logic        sm_restart,
    input  logic        force_we,
    input  logic [15:0] force_instr,
    input  logic [15:0] instr_mem_word,  // imem word at pc (CC-33)
    input  logic [1:0]  sm_id,
    input  logic [4:0]  cfg_wrap_top, cfg_wrap_bottom, cfg_jmp_pin,
    input  logic [1:0]  cfg_status_sel,
    input  logic [4:0]  cfg_status_n,
    input  logic        cfg_autopull, cfg_autopush,
    input  logic [4:0]  cfg_pull_thresh, cfg_push_thresh,
    input  logic        cfg_side_pindir,
    input  logic [4:0]  cfg_sideset_base, cfg_out_base, cfg_set_base,
    input  logic [5:0]  cfg_out_count,
    input  logic [2:0]  cfg_set_count,
    input  logic        cfg_side_en,
    input  logic [2:0]  cfg_sideset_count,
    input  logic [31:0] gpio_seen,
    input  logic [31:0] in_bus,
    input  logic [7:0]  irq_flags, irq_prev, irq_next,
    input  logic [2:0]  fifo_mode,
    input  logic        sys_tx_wr,
    input  logic [31:0] sys_tx_wdata,
    input  logic        sys_rx_rd,
    input  logic        sys_aux_wr,
    input  logic [1:0]  sys_aux_addr,
    input  logic [31:0] sys_aux_wdata,
    input  logic        sys_aux_rd,
    input  logic [3:0]  fdbg_clr,
    input  logic        tick_req          // divider abstraction (CC-25/26)
);

  localparam logic [3:0] ST_FETCH  = 4'b0001;
  localparam logic [3:0] ST_EXEC   = 4'b0010;
  localparam logic [3:0] ST_STALL  = 4'b0100;
  localparam logic [3:0] ST_DELAY  = 4'b1000;

  // -----------------------------------------------------------------------
  // Divider abstraction: pending-hold tick model (CC-26 placement,
  // CC-36 deferral — the structural mirror of C5's divider output).
  // -----------------------------------------------------------------------
  logic force_tick_w, exec_stalled_w, sm_tick_g;
  logic tick_pend_r;
  always_ff @(posedge clk) begin
    if (rst)                          tick_pend_r <= 1'b0;
    else if (sm_tick_g)               tick_pend_r <= 1'b0;
    else if (tick_req && !sm_tick_g)  tick_pend_r <= 1'b1;
  end
  assign sm_tick_g = tick_pend_r && !force_tick_w;

  // -----------------------------------------------------------------------
  // Mini-assembly (pio_sm wiring, DESIGN.md).
  // -----------------------------------------------------------------------
  logic [15:0] instr_cur_w;
  logic [4:0]  pc;

  logic [4:0]  dec_delay;
  logic        dec_ss_valid;
  logic [4:0]  dec_ss_val;
  logic [2:0]  dec_ss_bits;
  logic        dec_is_jmp, dec_is_wait, dec_is_in, dec_is_out, dec_is_push;
  logic        dec_is_pull, dec_is_put, dec_is_get, dec_is_mov, dec_is_irq;
  logic        dec_is_set, dec_illegal;
  logic [2:0]  dec_jmp_cond;
  logic [4:0]  dec_jmp_addr;
  logic        dec_wait_pol;
  logic [1:0]  dec_wait_src;
  logic [4:0]  dec_wait_index;
  logic [2:0]  dec_in_src;
  logic [5:0]  dec_in_count;
  logic [2:0]  dec_out_dst;
  logic [5:0]  dec_out_count;
  logic        dec_push_iff, dec_push_blk, dec_pull_ife, dec_pull_blk;
  logic        dec_aux_idxi;
  logic [1:0]  dec_aux_index;
  logic [2:0]  dec_mov_dst, dec_mov_src;
  logic [1:0]  dec_mov_op;
  logic        dec_irq_clr, dec_irq_wait;
  logic [1:0]  dec_irq_idxmode;
  logic [2:0]  dec_irq_index;
  logic [2:0]  dec_set_dst;
  logic [4:0]  dec_set_data;

  pio_sm_decoder u_dec (
      .instr (instr_cur_w),
      .side_en (cfg_side_en), .sideset_count (cfg_sideset_count),
      .delay (dec_delay),
      .ss_valid (dec_ss_valid), .ss_val (dec_ss_val), .ss_bits (dec_ss_bits),
      .is_jmp (dec_is_jmp), .is_wait (dec_is_wait), .is_in (dec_is_in),
      .is_out (dec_is_out), .is_push (dec_is_push), .is_pull (dec_is_pull),
      .is_put (dec_is_put), .is_get (dec_is_get), .is_mov (dec_is_mov),
      .is_irq (dec_is_irq), .is_set (dec_is_set), .illegal (dec_illegal),
      .jmp_cond (dec_jmp_cond), .jmp_addr (dec_jmp_addr),
      .wait_pol (dec_wait_pol), .wait_src (dec_wait_src),
      .wait_index (dec_wait_index),
      .in_src (dec_in_src), .in_count (dec_in_count),
      .out_dst (dec_out_dst), .out_count (dec_out_count),
      .push_iff (dec_push_iff), .push_blk (dec_push_blk),
      .pull_ife (dec_pull_ife), .pull_blk (dec_pull_blk),
      .aux_idxi (dec_aux_idxi), .aux_index (dec_aux_index),
      .mov_dst (dec_mov_dst), .mov_src (dec_mov_src), .mov_op (dec_mov_op),
      .irq_clr (dec_irq_clr), .irq_wait (dec_irq_wait),
      .irq_idxmode (dec_irq_idxmode), .irq_index (dec_irq_index),
      .set_dst (dec_set_dst), .set_data (dec_set_data)
  );

  logic        out_en_w, osr_wr_en_w, in_en_w, in_src_isr_w, isr_wr_en_w;
  logic [31:0] osr_wr_data_w, in_data_w, isr_wr_data_w;
  logic [5:0]  osr_wr_cnt_w, isr_wr_cnt_w;
  logic [31:0] osr_w, isr_w, out_data_w, autopush_data_w;
  logic [5:0]  osr_cnt_w, isr_cnt_w;
  logic        autopull_ge_thr_w, autopull_post_thr_w, autopush_req_w;

  pio_sm_shift u_shift (
      .clk (clk), .rst (rst), .sm_tick (sm_tick_g),
      .in_shift_left (1'b0), .out_shift_left (1'b0),
      .autopull_en (cfg_autopull), .autopush_en (cfg_autopush),
      .pull_thresh (cfg_pull_thresh), .push_thresh (cfg_push_thresh),
      .out_count (dec_out_count), .in_count (dec_in_count),
      .out_en (out_en_w),
      .osr_wr_en (osr_wr_en_w), .osr_wr_data (osr_wr_data_w),
      .osr_wr_cnt (osr_wr_cnt_w),
      .in_en (in_en_w), .in_data (in_data_w), .in_src_isr (in_src_isr_w),
      .isr_wr_en (isr_wr_en_w), .isr_wr_data (isr_wr_data_w),
      .isr_wr_cnt (isr_wr_cnt_w),
      .osr (osr_w), .isr (isr_w), .osr_cnt (osr_cnt_w), .isr_cnt (isr_cnt_w),
      .out_data (out_data_w),
      .autopull_ge_thr (autopull_ge_thr_w),
      .autopull_post_thr (autopull_post_thr_w),
      .autopush_req (autopush_req_w), .autopush_data (autopush_data_w)
  );

  logic        rx_push_w, tx_pop_w;
  logic [31:0] rx_push_data_w;
  logic        aux_put_w, aux_get_w;
  logic [1:0]  aux_put_idx_w, aux_get_idx_w;
  logic [31:0] aux_put_data_w;
  logic        tx_stall_req_w, rx_stall_req_w;
  logic [31:0] tx_head_data_w, aux_get_data_w;
  logic [3:0]  rx_level_w, tx_level_w;
  logic        rx_full_w, rx_empty_w, tx_full_w, tx_empty_w;
  logic [31:0] sys_rx_rdata_w, sys_aux_rdata_w;
  logic        fdbg_tx_stall_w, fdbg_rx_stall_w, fdbg_tx_over_w, fdbg_rx_under_w;

  pio_sm_fifo_stub u_fifo ( // storage-free contract stub (see above)
      .clk (clk), .rst (rst), .fifo_mode (fifo_mode),
      .sm_tick (sm_tick_g),
      .rx_push (rx_push_w), .rx_push_data (rx_push_data_w),
      .tx_pop (tx_pop_w), .tx_head_data (tx_head_data_w),
      .aux_put (aux_put_w), .aux_put_idx (aux_put_idx_w),
      .aux_put_data (aux_put_data_w),
      .aux_get (aux_get_w), .aux_get_idx (aux_get_idx_w),
      .aux_get_data (aux_get_data_w),
      .rx_level (rx_level_w), .tx_level (tx_level_w),
      .rx_full (rx_full_w), .rx_empty (rx_empty_w),
      .tx_full (tx_full_w), .tx_empty (tx_empty_w),
      .tx_stall_req (tx_stall_req_w), .rx_stall_req (rx_stall_req_w),
      .fdbg_tx_stall (fdbg_tx_stall_w), .fdbg_rx_stall (fdbg_rx_stall_w),
      .fdbg_tx_over (fdbg_tx_over_w), .fdbg_rx_under (fdbg_rx_under_w),
      .fdbg_clr (fdbg_clr),
      .sys_tx_wr (sys_tx_wr), .sys_tx_wdata (sys_tx_wdata),
      .sys_rx_rd (sys_rx_rd), .sys_rx_rdata (sys_rx_rdata_w),
      .sys_aux_wr (sys_aux_wr), .sys_aux_addr (sys_aux_addr),
      .sys_aux_wdata (sys_aux_wdata),
      .sys_aux_rd (sys_aux_rd), .sys_aux_rdata (sys_aux_rdata_w)
  );

  logic        gpio_out_we_w, gpio_out_pindir_w;
  logic [4:0]  gpio_out_base_w;
  logic [5:0]  gpio_out_count_w;
  logic [31:0] gpio_out_data_w;
  logic        gpio_set_we_w, gpio_set_pindir_w;
  logic [4:0]  gpio_set_base_w;
  logic [2:0]  gpio_set_num_w;
  logic [4:0]  gpio_set_data_w;
  logic        gpio_ss_we_w, gpio_ss_pindir_w;
  logic [4:0]  gpio_ss_base_w;
  logic [2:0]  gpio_ss_num_w;
  logic [4:0]  gpio_ss_data_w;
  logic        irq_set_req_w, irq_clr_req_w;
  logic [2:0]  irq_flag_idx_w;
  logic [1:0]  irq_idx_mode_w;
  logic [3:0]  dbg_state_w;
  logic [4:0]  dbg_delay_w;
  logic        dbg_exec_w, dbg_complete_w, dbg_first_w, dbg_latch_src_w;
  logic        dbg_forced_w, dbg_pc_wr_w, dbg_rel_cond_w, dbg_restart_pend_w;
  logic        dbg_latch_vld_w, dbg_latch_force_w;
  logic [15:0] dbg_latch_word_w;

  pio_sm_exec u_exec (
      .clk (clk), .rst (rst),
      .sm_tick (sm_tick_g), .sm_restart (sm_restart),
      .force_tick (force_tick_w),
      .instr_mem (instr_mem_word), .instr_cur (instr_cur_w),
      .force_we (force_we), .force_instr (force_instr),
      .pc (pc), .exec_stalled (exec_stalled_w),
      .delay (dec_delay),
      .ss_valid (dec_ss_valid), .ss_val (dec_ss_val), .ss_bits (dec_ss_bits),
      .is_jmp (dec_is_jmp), .is_wait (dec_is_wait), .is_in (dec_is_in),
      .is_out (dec_is_out), .is_push (dec_is_push), .is_pull (dec_is_pull),
      .is_put (dec_is_put), .is_get (dec_is_get), .is_mov (dec_is_mov),
      .is_irq (dec_is_irq), .is_set (dec_is_set), .illegal (dec_illegal),
      .jmp_cond (dec_jmp_cond), .jmp_addr (dec_jmp_addr),
      .wait_pol (dec_wait_pol), .wait_src (dec_wait_src),
      .wait_index (dec_wait_index),
      .in_src (dec_in_src),
      .out_dst (dec_out_dst), .out_count (dec_out_count),
      .push_iff (dec_push_iff), .push_blk (dec_push_blk),
      .pull_ife (dec_pull_ife), .pull_blk (dec_pull_blk),
      .aux_idxi (dec_aux_idxi), .aux_index (dec_aux_index),
      .mov_dst (dec_mov_dst), .mov_src (dec_mov_src), .mov_op (dec_mov_op),
      .irq_clr (dec_irq_clr), .irq_wait (dec_irq_wait),
      .irq_idxmode (dec_irq_idxmode), .irq_index (dec_irq_index),
      .set_dst (dec_set_dst), .set_data (dec_set_data),
      .sm_id (sm_id),
      .cfg_wrap_top (cfg_wrap_top), .cfg_wrap_bottom (cfg_wrap_bottom),
      .cfg_jmp_pin (cfg_jmp_pin),
      .cfg_status_sel (cfg_status_sel), .cfg_status_n (cfg_status_n),
      .cfg_autopull (cfg_autopull), .cfg_autopush (cfg_autopush),
      .cfg_pull_thresh (cfg_pull_thresh),
      .cfg_push_thresh (cfg_push_thresh),
      .cfg_side_pindir (cfg_side_pindir),
      .cfg_sideset_base (cfg_sideset_base),
      .cfg_out_base (cfg_out_base), .cfg_out_count (cfg_out_count),
      .cfg_set_base (cfg_set_base), .cfg_set_count (cfg_set_count),
      .out_en (out_en_w),
      .osr_wr_en (osr_wr_en_w), .osr_wr_data (osr_wr_data_w),
      .osr_wr_cnt (osr_wr_cnt_w),
      .in_en (in_en_w), .in_data (in_data_w), .in_src_isr (in_src_isr_w),
      .isr_wr_en (isr_wr_en_w), .isr_wr_data (isr_wr_data_w),
      .isr_wr_cnt (isr_wr_cnt_w),
      .osr (osr_w), .isr (isr_w), .osr_cnt (osr_cnt_w), .isr_cnt (isr_cnt_w),
      .out_data (out_data_w),
      .autopull_ge_thr (autopull_ge_thr_w),
      .autopull_post_thr (autopull_post_thr_w),
      .autopush_req (autopush_req_w), .autopush_data (autopush_data_w),
      .fifo_mode (fifo_mode),
      .rx_push (rx_push_w), .rx_push_data (rx_push_data_w),
      .tx_pop (tx_pop_w),
      .aux_put (aux_put_w), .aux_put_idx (aux_put_idx_w),
      .aux_put_data (aux_put_data_w),
      .aux_get (aux_get_w), .aux_get_idx (aux_get_idx_w),
      .tx_stall_req (tx_stall_req_w), .rx_stall_req (rx_stall_req_w),
      .tx_head_data (tx_head_data_w),
      .rx_level (rx_level_w), .tx_level (tx_level_w),
      .rx_full (rx_full_w), .rx_empty (rx_empty_w),
      .tx_full (tx_full_w), .tx_empty (tx_empty_w),
      .aux_get_data (aux_get_data_w),
      .gpio_seen (gpio_seen), .in_bus (in_bus),
      .gpio_out_we (gpio_out_we_w), .gpio_out_pindir (gpio_out_pindir_w),
      .gpio_out_base (gpio_out_base_w), .gpio_out_count (gpio_out_count_w),
      .gpio_out_data (gpio_out_data_w),
      .gpio_set_we (gpio_set_we_w), .gpio_set_pindir (gpio_set_pindir_w),
      .gpio_set_base (gpio_set_base_w), .gpio_set_num (gpio_set_num_w),
      .gpio_set_data (gpio_set_data_w),
      .gpio_ss_we (gpio_ss_we_w), .gpio_ss_pindir (gpio_ss_pindir_w),
      .gpio_ss_base (gpio_ss_base_w), .gpio_ss_num (gpio_ss_num_w),
      .gpio_ss_data (gpio_ss_data_w),
      .irq_flags (irq_flags), .irq_prev (irq_prev), .irq_next (irq_next),
      .irq_set_req (irq_set_req_w), .irq_clr_req (irq_clr_req_w),
      .irq_flag_idx (irq_flag_idx_w), .irq_idx_mode (irq_idx_mode_w),
      .dbg_state (dbg_state_w), .dbg_delay (dbg_delay_w),
      .dbg_exec (dbg_exec_w), .dbg_complete (dbg_complete_w),
      .dbg_first (dbg_first_w), .dbg_latch_src (dbg_latch_src_w),
      .dbg_forced (dbg_forced_w), .dbg_pc_wr (dbg_pc_wr_w),
      .dbg_rel_cond (dbg_rel_cond_w), .dbg_restart_pend (dbg_restart_pend_w),
      .dbg_latch_vld (dbg_latch_vld_w), .dbg_latch_force (dbg_latch_force_w),
      .dbg_latch_word (dbg_latch_word_w)
  );

  // -----------------------------------------------------------------------
  // Previous-cycle bookkeeping (explicit $past replacement).
  // -----------------------------------------------------------------------
  logic        p_rst_r = 1'b1;
  logic [4:0]  p_pc_r = 5'd0;
  logic [4:0]  p_delay_r = 5'd0;
  logic [3:0]  p_state_r = ST_FETCH;
  logic        p_exec_r = 1'b0, p_complete_r = 1'b0, p_forced_r = 1'b0;
  logic        p_latch_src_r = 1'b0, p_pc_wr_r = 1'b0;
  logic        p_sm_restart_r = 1'b0, p_force_we_r = 1'b0;
  logic        p_force_tick_r = 1'b0, p_tick_pend_r = 1'b0;
  logic        p_sm_tick_r = 1'b0;
  logic        p_was_delay_tick_r = 1'b0;
  logic        p_out_exec_cpl_r = 1'b0;    // prev clk: sm OUT-EXEC completion
  logic        p_was_just_latched_r = 1'b0;
  logic [15:0] p_out_word_r = 16'd0;       // prev clk: latched executee word
  always_ff @(posedge clk) begin
    p_rst_r              <= rst;
    p_pc_r               <= pc;
    p_delay_r            <= dbg_delay_w;
    p_state_r            <= dbg_state_w;
    p_exec_r             <= dbg_exec_w;
    p_complete_r         <= dbg_complete_w;
    p_forced_r           <= dbg_forced_w;
    p_latch_src_r        <= dbg_latch_src_w;
    p_pc_wr_r            <= dbg_pc_wr_w;
    p_sm_restart_r       <= sm_restart;
    p_force_we_r         <= force_we;
    p_force_tick_r       <= force_tick_w;
    p_tick_pend_r        <= tick_pend_r;
    p_sm_tick_r          <= sm_tick_g;
    p_was_delay_tick_r   <= sm_tick_g && (dbg_state_w == ST_DELAY);
    p_out_exec_cpl_r     <= dbg_exec_w && dbg_complete_w && !dbg_forced_w
                          && dec_is_out && (dec_out_dst == 3'd7)
                          && !dec_illegal;
    p_was_just_latched_r <= dbg_exec_w && dbg_complete_w
                          && ((dec_is_out && (dec_out_dst == 3'd7))
                           || (dec_is_mov && (dec_mov_dst == 3'd4)))
                          && !dec_illegal;
    p_out_word_r         <= out_data_w[15:0];
  end

  // Clks since the last tick_req (for the A2 min-gap assumption).
  logic [1:0] since_req_r = 2'd3;
  always_ff @(posedge clk) begin
    if (tick_req)     since_req_r <= 2'd0;
    else if (since_req_r != 2'd3) since_req_r <= since_req_r + 2'd1;
  end

  // -----------------------------------------------------------------------
  // P4 tracking: expected tick-gap to the next sm-sourced first tick
  // (CC-10), and the pending OUT-EXEC executee word (CC-34).
  // -----------------------------------------------------------------------
  logic        gap_vld_r = 1'b0;
  logic [5:0]  gap_exp_r = 6'd0;
  logic [5:0]  gap_ctr_r = 6'd0;
  logic        cur_just_latched_c;
  assign cur_just_latched_c = dbg_exec_w && dbg_complete_w
                          && ((dec_is_out && (dec_out_dst == 3'd7))
                           || (dec_is_mov && (dec_mov_dst == 3'd4)))
                          && !dec_illegal;

  always_ff @(posedge clk) begin
    if (rst || sm_restart || force_we
        || (dbg_forced_w && cur_just_latched_c)) begin
      // SM_RESTART and the force write both act on the DUT (G3/G4) on
      // their own edge, so the window must clear on the same edge
      // (current pulses); this branch outranks the set.
      gap_vld_r      <= 1'b0;
      gap_ctr_r      <= 6'd0;
    end else begin
      // CC-10 gap bookkeeping. The loaded delay is dec_delay except for
      // EXEC-latching completions, whose own delay is ignored
      // (SPEC-3.4-10) — loaded value 0.
      if (!p_rst_r && dbg_exec_w && dbg_complete_w && !dbg_forced_w) begin
        gap_exp_r <= cur_just_latched_c ? 6'd1
                   : {1'b0, dec_delay} + 6'd1;
        gap_ctr_r <= 6'd0;
        gap_vld_r <= 1'b1;
      end else if (dbg_forced_w && dbg_complete_w
                   && (cur_just_latched_c || dbg_pc_wr_w)) begin
        // A forced EXEC latch or pc write preempts a pending delay /
        // in-progress instruction (CC-35 [MODEL]) — outside the CC-10
        // schedule, so the window no longer applies.
        gap_vld_r <= 1'b0;
      end else if (sm_tick_g) begin
        gap_ctr_r <= gap_ctr_r + 6'd1;
        // The window closes at the tracked first tick (a completion
        // re-opens it via the branch above, resetting the count).
        if (dbg_restart_pend_w || (dbg_exec_w && dbg_first_w))
          gap_vld_r <= 1'b0;
      end
    end
  end

  // -----------------------------------------------------------------------
  // Assumptions.
  // -----------------------------------------------------------------------
  always @(posedge clk) begin
    if ($initstate) assume (rst);                     // A1 (CC-1)

    // A2: divider min-gap (CC-25, abstracted).
    if (tick_req) assume (since_req_r >= 2'd2);

    // A3: no imem patch under a stalled SM (CC-33 scoping).
    if (p_state_r == ST_STALL) assume (instr_mem_word == p_imem_r);

    // A4: defined fifo encodings (C3 contract).
    assume (fifo_mode <= 3'd5);

    // A5: FIFO system side idle (proof scoping, see header).
    assume (!sys_tx_wr);
    assume (!sys_rx_rd);
    assume (!sys_aux_wr);
    assume (!sys_aux_rd);
  end
  logic [15:0] p_imem_r = 16'd0;
  always_ff @(posedge clk) begin
    p_imem_r <= instr_mem_word;
  end

  // -----------------------------------------------------------------------
  // Assertions.
  // -----------------------------------------------------------------------
  always @(posedge clk) begin
    // !p_rst_r: previous-cycle evidence must postdate the reset edge —
    // at $initstate the DUT registers are still free (rst asserts in
    // the initial state; the first edge cleans them).
    if (!$initstate && !rst && !p_rst_r) begin
      // P1: onehot FSM (DESIGN.md conventions).
      a_p1_onehot : assert (dbg_state_w == ST_FETCH || dbg_state_w == ST_EXEC
                            || dbg_state_w == ST_STALL
                            || dbg_state_w == ST_DELAY);

      // P2: pc and delay hold except at their defining ticks (CC-14).
      a_p2_pc : assert (pc == p_pc_r || (p_exec_r && p_complete_r));
      if (!(p_exec_r && p_complete_r) && !p_was_delay_tick_r
          && !p_sm_restart_r)
        a_p2_delay : assert (dbg_delay_w == p_delay_r);

      // P3: first condition-true tick completes (CC-14/15/16).
      if (dbg_state_w == ST_STALL && dbg_exec_w && dbg_rel_cond_w)
        a_p3_complete : assert (dbg_complete_w);
      if (dbg_state_w == ST_STALL && dbg_exec_w && !dbg_complete_w)
        a_p3_false : assert (!dbg_rel_cond_w);

      // P4: next instruction exactly d+1 sm_ticks after completion
      // (CC-10). gap_ctr_r counts sm_ticks since the completion, not
      // including the current one; the first tick is thus #ctr+1.
      if (dbg_exec_w && dbg_first_w && !dbg_forced_w && gap_vld_r)
        a_p4_gap : assert (gap_ctr_r + 6'd1 == gap_exp_r);
      // P4 inductive link: while a window is open, ticks-so-far plus
      // the DUT's remaining delay counter equals the loaded d+1 minus
      // the executing tick. 1-step inductive, so k-induction can close
      // a_p4_gap for any d at modest depth.
      if (gap_vld_r && !(dbg_exec_w && dbg_first_w && !dbg_forced_w))
        a_p4_inv : assert (gap_ctr_r + {1'b0, dbg_delay_w}
                           == gap_exp_r - 6'd1);
      // Construction link (k-induction): the window closes at the
      // tracked instruction's first tick, so while it is open the FSM
      // cannot be mid-stall (a stalled instruction already first-ticked).
      if (gap_vld_r)
        a_p4_inv2 : assert (dbg_state_w != ST_STALL);
      // Delay counting lives entirely inside ST_DELAY (CC-10): loads
      // enter it, decrements stay in it (never past zero — G1 exits at
      // one), every exit path clears. Biconditional, so k-induction
      // cannot spin up a zero-delay ST_DELAY (underflow) state.
      a_p4_inv3a : assert (dbg_state_w != ST_DELAY
                           || dbg_delay_w != 5'd0);
      a_p4_inv3b : assert (dbg_state_w == ST_DELAY
                           || dbg_delay_w == 5'd0);

      // P5: forced-instruction tick discipline (CC-35/CC-36); G4 gives
      // the force write priority over a simultaneous SM_RESTART.
      if (p_force_we_r && !p_rst_r)
        a_p5_force_next : assert (force_tick_w);
      if (exec_stalled_w)
        a_p5_stalled_ticks : assert (force_tick_w);
      // A forced word in the latch is never quiescent: force_we sets
      // force_pend, and only the word's completion (or SM_RESTART,
      // which drops it) clears the tick source (CC-35).
      if (dbg_latch_force_w)
        a_p5_forced_live : assert (force_tick_w);
      a_p5_no_coincide : assert (!(sm_tick_g && force_tick_w));
      if (p_force_tick_r && p_tick_pend_r)
        a_p5_pend_holds : assert (tick_pend_r);   // phase untouched
      if (p_force_tick_r && p_tick_pend_r && !force_tick_w)
        a_p5_delivered : assert (sm_tick_g);      // deferred tick fires

      // P6: EXEC latch (CC-34). Direct, 1-step-inductive forms:
      //   word — an OUT-EXEC completion latches out_data[15:0]
      //     (G4's compl/just-latched branch; a same-edge force write
      //     would have replaced it, SPEC-7-23 — excluded by the guard);
      //   state — such a completion enters ST_EXEC (G1), i.e. the
      //     executee is pending;
      //   runs — the next sm tick in ST_EXEC executes the latch word
      //     as a first tick (inv3 below supplies the live latch);
      //   pc_hold — a latch-sourced completion leaves pc alone unless
      //     the instruction explicitly writes it.
      if (p_out_exec_cpl_r && !p_force_we_r)
        a_p6_word : assert (dbg_latch_word_w == p_out_word_r);
      if (p_out_exec_cpl_r)
        a_p6_state : assert (dbg_state_w == ST_EXEC);
      if (sm_tick_g && !dbg_restart_pend_w && dbg_state_w == ST_EXEC)
        a_p6_runs : assert (dbg_exec_w && dbg_first_w
                            && dbg_latch_src_w);  // restart clear-tick excepted
      // ST_EXEC claims a pending latch word (G1 exits it otherwise).
      if (dbg_state_w == ST_EXEC)
        a_p6_inv3 : assert (dbg_latch_vld_w);
      if (p_exec_r && p_complete_r && p_latch_src_r && !p_forced_r)
        a_p6_pc_hold : assert (pc == p_pc_r || p_pc_wr_r);  // CC-34/CC-35
    end
  end

  // -----------------------------------------------------------------------
  // Covers (sanity that the interesting behaviours are reachable).
  // -----------------------------------------------------------------------
  always @(posedge clk) begin
    if (!$initstate && !rst) begin
      if (dbg_exec_w && dbg_first_w && !dbg_forced_w && dbg_latch_src_w)
        c_executee_runs : cover (1'b1);            // CC-34
      if (p_state_r == ST_DELAY && dbg_state_w == ST_FETCH)
        c_delay_elapsed : cover (1'b1);            // CC-10
      if (dbg_state_w == ST_STALL && dec_is_irq && dec_irq_wait)
        c_irq_wait_stall : cover (1'b1);           // CC-16
      if (exec_stalled_w && force_tick_w)
        c_forced_stall : cover (1'b1);             // CC-35
      if (p_pc_r == cfg_wrap_top && pc == cfg_wrap_bottom)
        c_wrap : cover (1'b1);                     // SPEC-8-2
      if (p_force_tick_r && p_tick_pend_r && sm_tick_g)
        c_deferred_tick : cover (1'b1);            // CC-36
    end
  end

endmodule

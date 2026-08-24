// tb_pio_sm_exec — directed TB for rtl/pio_sm_exec.sv (KANBAN C8).
//
// Mini-assembly in the pio_sm shape (DESIGN.md): u_dec (C4) decodes
// u_exec's selected word; u_shift (C2) and u_fifo (C3) are driven by
// u_exec; the TB plays the divider (sm_tick with CC-36 force-tick
// deferral), the imem (async read at pc, CC-33), the gpio mux inputs,
// and a mini irq-flag register (CC-37 next-cycle visibility, CC-39
// clear-wins, THIS/REL routing; prev/next read buses driven directly).
//
// Coverage (per the C8 acceptance):
//   1.  Reset defaults; every JMP condition incl. x--/y-- wrap
//       (SPEC-3.1-2..11, SPEC-14.5-1).
//   2.  Delay counting: next instruction d+1 ticks after completion
//       (CC-10); no side-set on delay ticks (CC-5).
//   3.  Wrap at WRAP_TOP and 31→0 (SPEC-8-2/3).
//   4.  Every WAIT variant: gpio/pin/jmppin both polarities, irq pol 0/1
//       with the completing clear, and the stall-release timing — the
//       first condition-true tick completes (SPEC-3.2-1..9, CC-15).
//   5.  irq nowait / irq clear / irq wait two-phase (SPEC-3.8-1..3,
//       CC-16, CC-37); REL and PREV routing (SPEC-3.8-4..7).
//   6.  MOV: sources pins/x/y/null/isr/osr/status(×3 sel), dsts
//       x/y/isr/osr/pc/pins/pindirs, ops none/~/:: (SPEC-3.6-1..14).
//   7.  SET dsts incl. pin bundles (SPEC-3.9-1..3).
//   8.  OUT dsts incl. zero-shift on an exhausted OSR (SPEC-3.4-1..12,
//       CC-17); IN sources incl. rotate + osr-counter-untouched
//       (SPEC-3.3-1..8).
//   9.  Autopull OUT rules: post-thr simultaneous refill / empty-TX
//       stall + TXSTALL / refill-stall fence (CC-11, CC-12); background
//       refill on a non-OUT tick (CC-12); autopush IN incl. full-RX
//       stall (CC-13, CC-9).
//   10.  PUSH/PULL block/noblock/iffull/ifempty (SPEC-3.5-1..13,
//       CC-19, CC-20, CC-32) and the CC-31 `pull ifempty`
//       guard-at-own-tick scenario.
//   11.  FIFO-aux PUT/GET incl. Y indexing and mode gating
//       (SPEC-3.7-1..7, CC-21).
//   12.  OUT/MOV EXEC: executee on the next tick, PC not advanced,
//       OUT's own delay ignored, executee delay honoured, executee may
//       stall (SPEC-3.4-10, SPEC-3.6-11, SPEC-11-1, CC-34).
//   13.  Forced instructions: SMx_INSTR executes the following clk
//       bypassing the divider; delay ignored; stalled forced latched
//       (EXEC_STALLED) and re-executed; replacement; forced write beats
//       a pending executee; CC-36 collision + deferral
//       (SPEC-7-15/23/25, SPEC-11-1, CC-35, CC-36).
//   14.  SM_RESTART clears exactly the SPEC-7-3 subset ([MODEL]: the
//       ISR/counter clear consumes the next sm_tick).
//   15.  Illegal encodings are no-ops (SPEC-13-1).
//   16.  T39: regressions for the bugs the formal proof found during
//       C8 (AGENTS.md formal-to-sim rule) — restart/force coincidences
//       with completions, delay ticks, and the EXEC latch, each
//       annotated with the fv assertion that uncovered it.
//
// Timing: stimulus is driven on negedge clk; the tick task asserts
// sm_tick for exactly one clk cycle and returns just after the retiring
// posedge, so post-tick state is sampled directly. Register contents
// are set up through instructions only (no DUT pokes).

`include "tb_common.sv"

module tb_pio_sm_exec;

  logic clk;
  logic rst;
  tb_clk_rst u_cr (.clk(clk));

  localparam logic [2:0] JC_ALWAYS = 3'd0, JC_NOTX = 3'd1, JC_XDEC = 3'd2,
                         JC_NOTY   = 3'd3, JC_YDEC = 3'd4, JC_XNEY = 3'd5,
                         JC_PIN    = 3'd6, JC_NOTOSRE = 3'd7;
  localparam logic [1:0] WSRC_GPIO = 2'd0, WSRC_PIN = 2'd1,
                         WSRC_IRQ  = 2'd2, WSRC_JMPPIN = 2'd3;
  localparam logic [1:0] IDX_THIS = 2'd0, IDX_PREV = 2'd1,
                         IDX_REL  = 2'd2, IDX_NEXT = 2'd3;
  localparam logic [1:0] SM_ID = 2'd2;      // exec sm_id under test

  localparam logic [3:0] ST_FETCH = 4'b0001, ST_EXEC = 4'b0010,
                         ST_STALL = 4'b0100, ST_DELAY = 4'b1000;

  // ---------------------------------------------------------------------
  // Encoders (SPEC-2-1..18 master table).
  // ---------------------------------------------------------------------
  function automatic logic [15:0] E_JMP(input logic [2:0] cond,
                                        input logic [4:0] addr,
                                        input logic [4:0] dly);
    E_JMP = {3'b000, dly, cond, addr};
  endfunction
  function automatic logic [15:0] E_WAIT(input logic pol,
                                         input logic [1:0] src,
                                         input logic [4:0] idx,
                                         input logic [4:0] dly);
    E_WAIT = {3'b001, dly, pol, src, idx};
  endfunction
  function automatic logic [15:0] E_IN(input logic [2:0] src,
                                       input logic [4:0] bc,
                                       input logic [4:0] dly);
    E_IN = {3'b010, dly, src, bc};
  endfunction
  function automatic logic [15:0] E_OUT(input logic [2:0] dst,
                                        input logic [4:0] bc,
                                        input logic [4:0] dly);
    E_OUT = {3'b011, dly, dst, bc};
  endfunction
  function automatic logic [15:0] E_PUSH(input logic iffull, input logic blk,
                                         input logic [4:0] dly);
    E_PUSH = {3'b100, dly, 1'b0, iffull, blk, 5'd0};
  endfunction
  function automatic logic [15:0] E_PULL(input logic ife, input logic blk,
                                         input logic [4:0] dly);
    E_PULL = {3'b100, dly, 1'b1, ife, blk, 5'd0};
  endfunction
  function automatic logic [15:0] E_PUT(input logic idxi,
                                        input logic [1:0] idx);
    E_PUT = {3'b100, 5'd0, 3'b000, 1'b1, idxi, 1'b0, idx};
  endfunction
  function automatic logic [15:0] E_GET(input logic idxi,
                                        input logic [1:0] idx);
    E_GET = {3'b100, 5'd0, 3'b100, 1'b1, idxi, 1'b0, idx};
  endfunction
  function automatic logic [15:0] E_MOV(input logic [2:0] dst,
                                        input logic [1:0] op,
                                        input logic [2:0] src,
                                        input logic [4:0] dly);
    E_MOV = {3'b101, dly, dst, op, src};
  endfunction
  function automatic logic [15:0] E_IRQ(input logic clr, input logic waitb,
                                        input logic [1:0] mode,
                                        input logic [2:0] idx,
                                        input logic [4:0] dly);
    E_IRQ = {3'b110, dly, 1'b0, clr, waitb, mode, idx};
  endfunction
  function automatic logic [15:0] E_SET(input logic [2:0] dst,
                                        input logic [4:0] data,
                                        input logic [4:0] dly);
    E_SET = {3'b111, dly, dst, data};
  endfunction
  localparam logic [15:0] E_NOP = 16'b101_00000_010_00_010;  // mov y,y (SPEC-3.6-10)

  // ---------------------------------------------------------------------
  // TB environment: imem, config, gpio/irq, fifo system side.
  // ---------------------------------------------------------------------
  logic        sm_tick;
  logic        sm_restart;
  logic        force_we;
  logic [15:0] force_instr;

  logic [15:0] imem [0:31];
  logic [15:0] instr_mem;
  logic [4:0]  pc;
  assign instr_mem = imem[pc];

  logic        cfg_side_en;
  logic [2:0]  cfg_sideset_count;
  logic [4:0]  cfg_wrap_top, cfg_wrap_bottom;
  logic [4:0]  cfg_jmp_pin;
  logic [1:0]  cfg_status_sel;
  logic [4:0]  cfg_status_n;
  logic        cfg_autopull, cfg_autopush;
  logic [4:0]  cfg_pull_thresh, cfg_push_thresh;
  logic        cfg_side_pindir;
  logic [4:0]  cfg_sideset_base, cfg_out_base, cfg_set_base;
  logic [5:0]  cfg_out_count;
  logic [2:0]  cfg_set_count;

  logic [31:0] gpio_seen;
  logic [31:0] in_bus;
  logic [7:0]  irq_prev, irq_next;

  logic        sys_tx_wr;
  logic [31:0] sys_tx_wdata;
  logic        sys_rx_rd;
  logic        sys_aux_wr, sys_aux_rd;
  logic [1:0]  sys_aux_addr;
  logic [31:0] sys_aux_wdata;
  logic [3:0]  fdbg_clr;

  // ---------------------------------------------------------------------
  // DUT nets.
  // ---------------------------------------------------------------------
  logic        force_tick_w, exec_stalled_w;
  logic [15:0] instr_cur_w;

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

  logic        out_en_w, osr_wr_en_w, in_en_w, in_src_isr_w, isr_wr_en_w;
  logic [31:0] osr_wr_data_w, in_data_w, isr_wr_data_w;
  logic [5:0]  osr_wr_cnt_w, isr_wr_cnt_w;
  logic [31:0] osr_w, isr_w, out_data_w, autopush_data_w;
  logic [5:0]  osr_cnt_w, isr_cnt_w;
  logic        autopull_ge_thr_w, autopull_post_thr_w, autopush_req_w;

  logic [2:0]  fifo_mode;
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

  logic [31:0] osr_keep;   // SM_RESTART OSR-preservation reference

  // ---------------------------------------------------------------------
  // Mini flag register (C6 stand-in): THIS/REL routing, next-cycle
  // visibility (CC-37), clear-wins (CC-39); PREV/NEXT requests are
  // exported (invisible locally). External writers model sibling SMs /
  // the bus.
  // ---------------------------------------------------------------------
  logic        ext_set_req, ext_clr_req;
  logic [2:0]  ext_idx;
  logic [7:0]  flags_r;
  logic [2:0]  req_idx_c;
  logic        req_local_c;
  always_comb begin
    req_idx_c   = (irq_idx_mode_w == IDX_REL)
                ? {irq_flag_idx_w[2], irq_flag_idx_w[1:0] + SM_ID}
                : irq_flag_idx_w;
    req_local_c = (irq_idx_mode_w == IDX_THIS) || (irq_idx_mode_w == IDX_REL);
  end
  always_ff @(posedge clk) begin
    if (rst) flags_r <= 8'd0;
    else begin
      if (irq_set_req_w && req_local_c) flags_r[req_idx_c] <= 1'b1;
      if (ext_set_req)                  flags_r[ext_idx]   <= 1'b1;
      if ((irq_clr_req_w && req_local_c) || (ext_clr_req && ext_idx == req_idx_c))
        flags_r[req_idx_c] <= 1'b0;   // CC-39 clear wins
      if (ext_clr_req)                  flags_r[ext_idx]   <= 1'b0;
    end
  end

  // ---------------------------------------------------------------------
  // Bundle monitors (single always block; mon_clr resets them).
  // ---------------------------------------------------------------------
  logic        mon_clr;
  integer      ss_fires_q;
  logic        out_we_q, out_pindir_q;
  logic [31:0] out_data_q;
  logic        set_we_q, set_pindir_q;
  logic [4:0]  set_data_q;
  logic        irq_set_q, irq_clr_q;
  logic [2:0]  irq_set_idx_q, irq_clr_idx_q;
  logic        tx_stall_q, rx_stall_q;
  logic        rx_push_q;
  logic [31:0] rx_push_data_q;
  always @(posedge clk) begin
    if (rst || mon_clr) begin
      ss_fires_q    <= 0;
      out_we_q      <= 1'b0; out_pindir_q <= 1'b0; out_data_q <= 32'd0;
      set_we_q      <= 1'b0; set_pindir_q <= 1'b0; set_data_q <= 5'd0;
      irq_set_q     <= 1'b0; irq_clr_q    <= 1'b0;
      irq_set_idx_q <= 3'd0; irq_clr_idx_q <= 3'd0;
      tx_stall_q    <= 1'b0; rx_stall_q   <= 1'b0;
      rx_push_q     <= 1'b0; rx_push_data_q <= 32'd0;
    end else begin
      if (gpio_ss_we_w) ss_fires_q <= ss_fires_q + 1;
      if (gpio_out_we_w) begin
        out_we_q <= 1'b1; out_pindir_q <= gpio_out_pindir_w;
        out_data_q <= gpio_out_data_w;
      end
      if (gpio_set_we_w) begin
        set_we_q <= 1'b1; set_pindir_q <= gpio_set_pindir_w;
        set_data_q <= gpio_set_data_w;
      end
      if (irq_set_req_w) begin
        irq_set_q <= 1'b1; irq_set_idx_q <= irq_flag_idx_w;
      end
      if (irq_clr_req_w) begin
        irq_clr_q <= 1'b1; irq_clr_idx_q <= irq_flag_idx_w;
      end
      if (tx_stall_req_w) tx_stall_q <= 1'b1;
      if (rx_stall_req_w) rx_stall_q <= 1'b1;
      if (rx_push_w) begin
        rx_push_q <= 1'b1; rx_push_data_q <= rx_push_data_w;
      end
    end
  end

  // ---------------------------------------------------------------------
  // Instances.
  // ---------------------------------------------------------------------
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

  pio_sm_shift u_shift (
      .clk (clk), .rst (rst), .sm_tick (sm_tick),
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

  pio_sm_fifo u_fifo (
      .clk (clk), .rst (rst), .fifo_mode (fifo_mode),
      .sm_tick (sm_tick),
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

  pio_sm_exec u_exec (
      .clk (clk), .rst (rst),
      .sm_tick (sm_tick), .sm_restart (sm_restart),
      .force_tick (force_tick_w),
      .instr_mem (instr_mem), .instr_cur (instr_cur_w),
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
      .sm_id (SM_ID),
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
      .irq_flags (flags_r), .irq_prev (irq_prev), .irq_next (irq_next),
      .irq_set_req (irq_set_req_w), .irq_clr_req (irq_clr_req_w),
      .irq_flag_idx (irq_flag_idx_w), .irq_idx_mode (irq_idx_mode_w),
      .dbg_state (dbg_state_w), .dbg_delay (dbg_delay_w),
      .dbg_exec (dbg_exec_w), .dbg_complete (dbg_complete_w),
      .dbg_first (dbg_first_w), .dbg_latch_src (dbg_latch_src_w),
      .dbg_forced (dbg_forced_w), .dbg_pc_wr (dbg_pc_wr_w),
      .dbg_rel_cond (dbg_rel_cond_w), .dbg_restart_pend (dbg_restart_pend_w)
  );

  // ---------------------------------------------------------------------
  // Helpers.
  // ---------------------------------------------------------------------
  // One SM tick; honors CC-36 (defers past force_ticks like C5 would).
  task automatic tick;
    begin
      @(negedge clk);
      while (force_tick_w === 1'b1) @(negedge clk);
      sm_tick = 1'b1;
      @(negedge clk);
      sm_tick = 1'b0;
    end
  endtask

  task automatic mon_clear;
    begin
      @(negedge clk);
      mon_clr = 1'b1;
      @(negedge clk);
      mon_clr = 1'b0;
    end
  endtask

  // Forced instruction: latched at the next posedge, executed on the
  // following clk (CC-35); waits out any stall it enters.
  task automatic force_run(input logic [15:0] w);
    begin
      @(negedge clk);
      force_we    = 1'b1;
      force_instr = w;
      @(negedge clk);
      force_we    = 1'b0;
      while (force_tick_w === 1'b1) @(negedge clk);
    end
  endtask

  // SDK-style PC relocation: forced JMP (sdk N2).
  task automatic goto_pc(input logic [4:0] a);
    begin
      force_run(E_JMP(JC_ALWAYS, a, 5'd0));
    end
  endtask

  task automatic restart_pulse;
    begin
      @(negedge clk);
      sm_restart = 1'b1;
      @(negedge clk);
      sm_restart = 1'b0;
    end
  endtask

  // One SM tick whose retiring posedge coincides with an SM_RESTART
  // pulse — the G1/G3/G4 priority-pairing corner class.
  task automatic tick_with_restart;
    begin
      @(negedge clk);
      while (force_tick_w === 1'b1) @(negedge clk);
      sm_tick    = 1'b1;
      sm_restart = 1'b1;
      @(negedge clk);
      sm_tick    = 1'b0;
      sm_restart = 1'b0;
    end
  endtask

  task automatic sys_tx_write(input logic [31:0] d);
    begin
      @(negedge clk);
      sys_tx_wr    = 1'b1;
      sys_tx_wdata = d;
      @(negedge clk);
      sys_tx_wr    = 1'b0;
    end
  endtask

  task automatic sys_rx_read;
    begin
      @(negedge clk);
      sys_rx_rd = 1'b1;
      @(negedge clk);
      sys_rx_rd = 1'b0;
    end
  endtask

  task automatic sys_aux_write(input logic [1:0] a, input logic [31:0] d);
    begin
      @(negedge clk);
      sys_aux_wr = 1'b1; sys_aux_addr = a; sys_aux_wdata = d;
      @(negedge clk);
      sys_aux_wr = 1'b0;
    end
  endtask

  task automatic ext_flag_set(input logic [2:0] i);
    begin
      @(negedge clk);
      ext_set_req = 1'b1; ext_idx = i;
      @(negedge clk);
      ext_set_req = 1'b0;
    end
  endtask

  task automatic ext_flag_clr(input logic [2:0] i);
    begin
      @(negedge clk);
      ext_clr_req = 1'b1; ext_idx = i;
      @(negedge clk);
      ext_clr_req = 1'b0;
    end
  endtask

  task automatic sec(input string s);
    begin
      $display("--- %0s", s);
    end
  endtask

  // ---------------------------------------------------------------------
  // Stimulus.
  // ---------------------------------------------------------------------
  initial begin
    sm_tick         = 1'b0;
    sm_restart      = 1'b0;
    force_we        = 1'b0;
    force_instr     = 16'd0;
    mon_clr         = 1'b0;
    ext_set_req     = 1'b0;
    ext_clr_req     = 1'b0;
    ext_idx         = 3'd0;
    gpio_seen       = 32'd0;
    in_bus          = 32'd0;
    irq_prev        = 8'd0;
    irq_next        = 8'd0;
    sys_tx_wr       = 1'b0;
    sys_tx_wdata    = 32'd0;
    sys_rx_rd       = 1'b0;
    sys_aux_wr      = 1'b0;
    sys_aux_rd      = 1'b0;
    sys_aux_addr    = 2'd0;
    sys_aux_wdata   = 32'd0;
    fdbg_clr        = 4'd0;
    fifo_mode       = 3'd0;
    cfg_side_en     = 1'b0;
    cfg_sideset_count = 3'd0;
    cfg_wrap_top    = 5'd31;
    cfg_wrap_bottom = 5'd0;
    cfg_jmp_pin     = 5'd0;
    cfg_status_sel  = 2'd3;
    cfg_status_n    = 5'd31;
    cfg_autopull    = 1'b0;
    cfg_autopush    = 1'b0;
    cfg_pull_thresh = 5'd0;    // 0 encodes 32 (SPEC-5-7)
    cfg_push_thresh = 5'd0;
    cfg_side_pindir = 1'b0;
    cfg_sideset_base = 5'd0;
    cfg_out_base    = 5'd0;
    cfg_out_count   = 6'd0;    // 0 = 32 pins (SPEC-7-26)
    cfg_set_base    = 5'd0;
    cfg_set_count   = 3'd5;
    for (int i = 0; i < 32; i++) imem[i] = E_NOP;
    osr_keep = 32'd0;

    `DO_RESET(4)

    // ------------------------------------------------------------------
    sec("T0: reset defaults");
    `check32(pc, 32'd0)
    `check32(u_exec.x_r, 32'd0)
    `check32(u_exec.y_r, 32'd0)
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(dbg_delay_w, 32'd0)
    `check1(exec_stalled_w, 1'b0)

    // ------------------------------------------------------------------
    sec("T1: jmp always (SPEC-3.1-2, SPEC-8-1)");
    imem[0] = E_JMP(JC_ALWAYS, 5'd7, 5'd0);
    tick;
    `check32(pc, 32'd7)

    sec("T2: jmp !x (SPEC-3.1-3)");
    imem[7] = E_JMP(JC_NOTX, 5'd9, 5'd0);   // x==0 → taken
    tick;
    `check32(pc, 32'd9)
    imem[9] = E_SET(3'd1, 5'd1, 5'd0);      // set x,1
    tick;
    `check32(u_exec.x_r, 32'd1)
    imem[10] = E_JMP(JC_NOTX, 5'd20, 5'd0); // x!=0 → not taken
    tick;
    `check32(pc, 32'd11)

    sec("T3: jmp x-- (SPEC-3.1-4, SPEC-14.5-1)");
    imem[11] = E_JMP(JC_XDEC, 5'd13, 5'd0); // x==1 → taken, x→0
    tick;
    `check32(pc, 32'd13)
    `check32(u_exec.x_r, 32'd0)
    imem[13] = E_JMP(JC_XDEC, 5'd15, 5'd0); // x==0 → not taken, wraps
    tick;
    `check32(pc, 32'd14)
    `check32(u_exec.x_r, 32'hFFFF_FFFF)

    sec("T4: jmp !y / y-- (SPEC-3.1-5/6)");
    imem[14] = E_SET(3'd2, 5'd3, 5'd0);     // set y,3
    tick;
    `check32(u_exec.y_r, 32'd3)
    imem[15] = E_JMP(JC_YDEC, 5'd17, 5'd0); // y==3 → taken, y→2
    tick;
    `check32(pc, 32'd17)
    `check32(u_exec.y_r, 32'd2)
    imem[17] = E_JMP(JC_NOTY, 5'd18, 5'd0); // y==2 → not taken
    tick;
    `check32(pc, 32'd18)

    sec("T5: jmp x != y (SPEC-3.1-7)");
    imem[18] = E_JMP(JC_XNEY, 5'd19, 5'd0); // x=FFFFFFFF ≠ y=2 → taken
    tick;
    `check32(pc, 32'd19)
    imem[19] = E_MOV(3'd1, 2'd0, 3'd2, 5'd0);  // mov x, y
    tick;
    `check32(u_exec.x_r, 32'd2)
    imem[20] = E_JMP(JC_XNEY, 5'd22, 5'd0); // x==y → not taken
    tick;
    `check32(pc, 32'd21)

    sec("T6: jmp pin (SPEC-3.1-8)");
    cfg_jmp_pin = 5'd3;
    imem[21] = E_JMP(JC_PIN, 5'd23, 5'd0);  // gpio_seen[3]==0 → not taken
    tick;
    `check32(pc, 32'd22)
    gpio_seen[3] = 1'b1;
    imem[22] = E_JMP(JC_PIN, 5'd23, 5'd0);  // taken
    tick;
    `check32(pc, 32'd23)
    gpio_seen[3] = 1'b0;

    sec("T7: jmp !osre (SPEC-3.1-9)");
    imem[23] = E_JMP(JC_NOTOSRE, 5'd25, 5'd0); // cnt 32 ≥ thr → not taken
    tick;
    `check32(pc, 32'd24)
    sys_tx_write(32'hA5A5_00FF);
    imem[24] = E_PULL(1'b0, 1'b1, 5'd0);    // blocking pull (CC-20)
    tick;
    `check32(osr_w, 32'hA5A5_00FF)
    `check32(osr_cnt_w, 32'd0)
    imem[25] = E_JMP(JC_NOTOSRE, 5'd27, 5'd0); // cnt 0 < 32 → taken
    tick;
    `check32(pc, 32'd27)

    // ------------------------------------------------------------------
    sec("T8: delay counting, d+1 ticks to next instruction (CC-10)");
    mon_clear;
    imem[27] = E_SET(3'd1, 5'd5, 5'd3);     // set x,5 [3]
    tick;
    `check32(u_exec.x_r, 32'd5)
    `check32(dbg_delay_w, 32'd3)
    `check_eq(dbg_state_w, ST_DELAY)
    imem[28] = E_SET(3'd2, 5'd9, 5'd0);     // marker: set y,9
    tick;                                    // delay 3→2
    `check32(dbg_delay_w, 32'd2)
    `check32(u_exec.y_r, 32'd2)   // still the T4 value
    tick;                                    // delay 2→1
    tick;                                    // delay 1→0 → ST_FETCH
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(u_exec.y_r, 32'd2)
    tick;                                    // marker executes: 4th tick
    `check32(u_exec.y_r, 32'd9)
    `check32(pc, 32'd29)
    `check32(ss_fires_q, 32'd0)

    // ------------------------------------------------------------------
    sec("T9: wrap (SPEC-8-2/3; free per CC-10)");
    cfg_wrap_top    = 5'd5;
    cfg_wrap_bottom = 5'd2;
    goto_pc(5'd5);
    tick;                                     // nop at 5 → wrap to 2
    `check32(pc, 32'd2)
    goto_pc(5'd31);
    tick;                                     // nop at 31 → 0
    `check32(pc, 32'd0)
    cfg_wrap_top    = 5'd31;
    cfg_wrap_bottom = 5'd0;

    // ------------------------------------------------------------------
    sec("T10: wait gpio — release timing, one side-set (CC-15, CC-5)");
    cfg_sideset_count = 3'd1;                 // 1 side-set bit, no opt
    mon_clear;
    gpio_seen[4] = 1'b0;
    imem[0] = {3'b001, 5'b1_0000, 1'b1, WSRC_GPIO, 5'd4};  // wait 1 gpio 4 side 1
    tick;                                     // first tick: stalls, side-set fires
    `check_eq(dbg_state_w, ST_STALL)
    `check32(pc, 32'd0)
    `check32(ss_fires_q, 32'd1)
    tick;
    tick;
    `check_eq(dbg_state_w, ST_STALL)
    `check32(ss_fires_q, 32'd1)               // fired once (SPEC-3.2-9)
    gpio_seen[4] = 1'b1;
    tick;                                     // first condition-true tick completes
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(pc, 32'd1)
    `check32(ss_fires_q, 32'd1)               // CC-5
    cfg_sideset_count = 3'd0;
    gpio_seen[4] = 1'b0;

    sec("T11: wait gpio pol 0 (SPEC-3.2-1)");
    gpio_seen[6] = 1'b1;
    imem[1] = E_WAIT(1'b0, WSRC_GPIO, 5'd6, 5'd0);
    tick;
    `check_eq(dbg_state_w, ST_STALL)
    gpio_seen[6] = 1'b0;
    tick;
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(pc, 32'd2)

    sec("T12: wait pin via in_bus (SPEC-3.2-3, SPEC-10-3)");
    in_bus[2] = 1'b0;
    imem[2] = E_WAIT(1'b1, WSRC_PIN, 5'd2, 5'd0);
    tick;
    `check_eq(dbg_state_w, ST_STALL)
    in_bus[2] = 1'b1;
    tick;
    `check_eq(dbg_state_w, ST_FETCH)
    in_bus[2] = 1'b0;

    sec("T13: wait jmppin (SPEC-3.2-5, SPEC-12-7)");
    cfg_jmp_pin = 5'd6;                       // pin (6 + index) mod 32
    gpio_seen[7] = 1'b0;
    imem[3] = E_WAIT(1'b1, WSRC_JMPPIN, 5'd1, 5'd0);
    tick;
    `check_eq(dbg_state_w, ST_STALL)
    gpio_seen[7] = 1'b1;
    tick;
    `check_eq(dbg_state_w, ST_FETCH)
    gpio_seen[7] = 1'b0;

    sec("T14: wait 1 irq — completes and clears (SPEC-3.2-4, CC-15)");
    mon_clear;
    imem[4] = E_WAIT(1'b1, WSRC_IRQ, {IDX_THIS, 3'd2}, 5'd0);
    tick;                                     // flag 2 clear → stalled
    `check_eq(dbg_state_w, ST_STALL)
    ext_flag_set(3'd2);                       // visible next cycle (CC-37)
    tick;                                     // completes, clears the flag
    `check_eq(dbg_state_w, ST_FETCH)
    `check1(irq_clr_q, 1'b1)
    `check32(irq_clr_idx_q, 32'd2)
    `check1(flags_r[2], 1'b0)

    sec("T15: wait 0 irq (SPEC-3.2-1/4)");
    mon_clear;
    imem[5] = E_WAIT(1'b0, WSRC_IRQ, {IDX_THIS, 3'd3}, 5'd0);
    ext_flag_set(3'd3);
    tick;                                     // flag set → stalled
    `check_eq(dbg_state_w, ST_STALL)
    ext_flag_clr(3'd3);
    tick;
    `check_eq(dbg_state_w, ST_FETCH)
    `check1(irq_clr_q, 1'b0)                  // pol 0 never clears

    sec("T16: irq nowait sets, never stalls (SPEC-3.8-1/3)");
    mon_clear;
    imem[6] = E_IRQ(1'b0, 1'b0, IDX_THIS, 3'd5, 5'd0);
    tick;
    `check_eq(dbg_state_w, ST_FETCH)
    `check1(irq_set_q, 1'b1)
    `check32(irq_set_idx_q, 32'd5)
    `check1(flags_r[5], 1'b1)

    sec("T17: irq wait two-phase (SPEC-3.8-2, CC-16, CC-37)");
    mon_clear;
    imem[7] = E_IRQ(1'b0, 1'b1, IDX_THIS, 3'd6, 5'd0);
    tick;                                     // phase 1: sets, always stalls
    `check_eq(dbg_state_w, ST_STALL)
    `check1(irq_set_q, 1'b1)
    `check1(flags_r[6], 1'b1)
    tick;                                     // flag reads 1 → stalled
    `check_eq(dbg_state_w, ST_STALL)
    ext_flag_clr(3'd6);                       // another agent clears
    tick;                                     // reads 0 at tick start → completes
    `check_eq(dbg_state_w, ST_FETCH)
    `check1(flags_r[6], 1'b0)

    sec("T18: irq clear never stalls (SPEC-3.8-1)");
    ext_flag_set(3'd7);
    imem[8] = E_IRQ(1'b1, 1'b0, IDX_THIS, 3'd7, 5'd0); // irq clear
    tick;
    `check_eq(dbg_state_w, ST_FETCH)
    `check1(flags_r[7], 1'b0)

    sec("T19: irq REL routing (SPEC-3.8-6)");
    imem[9] = E_IRQ(1'b0, 1'b0, IDX_REL, 3'd1, 5'd0);  // flag 1+2=3
    tick;
    `check1(flags_r[3], 1'b1)
    `check1(flags_r[1], 1'b0)

    sec("T20: wait irq prev (SPEC-3.8-5, SPEC-3.2-6)");
    irq_prev[4] = 1'b1;
    imem[10] = E_WAIT(1'b1, WSRC_IRQ, {IDX_PREV, 3'd4}, 5'd0);
    tick;                                     // prev flag high → completes
    `check_eq(dbg_state_w, ST_FETCH)
    irq_prev[4] = 1'b0;

    // ------------------------------------------------------------------
    sec("T21: MOV sources and ops (SPEC-3.6-1..14)");
    imem[11] = E_OUT(3'd2, 5'd8, 5'd0);       // out y,8: y ← 0xFF (OSR LSB)
    tick;
    `check32(u_exec.y_r, 32'h0000_00FF)
    in_bus = 32'h1234_0000;
    imem[12] = E_IN(3'd0, 5'd0, 5'd0);        // in pins,32: isr ← 0x12340000
    tick;
    `check32(isr_w, 32'h1234_0000)
    in_bus = 32'h0000_BEEF;
    imem[13] = E_MOV(3'd1, 2'd0, 3'd2, 5'd0); // mov x, y
    tick;
    `check32(u_exec.x_r, 32'h0000_00FF)
    imem[14] = E_MOV(3'd1, 2'd1, 3'd2, 5'd0); // mov x, ~y
    tick;
    `check32(u_exec.x_r, 32'hFFFF_FF00)
    imem[15] = E_MOV(3'd1, 2'd2, 3'd2, 5'd0); // mov x, ::y
    tick;
    `check32(u_exec.x_r, 32'hFF00_0000)
    imem[16] = E_MOV(3'd1, 2'd0, 3'd3, 5'd0); // mov x, null
    tick;
    `check32(u_exec.x_r, 32'd0)
    imem[17] = E_MOV(3'd1, 2'd0, 3'd0, 5'd0); // mov x, pins
    tick;
    `check32(u_exec.x_r, 32'h0000_BEEF)
    in_bus = 32'd0;
    imem[18] = E_MOV(3'd1, 2'd0, 3'd6, 5'd0); // mov x, isr
    tick;
    `check32(u_exec.x_r, 32'h1234_0000)
    imem[19] = E_MOV(3'd1, 2'd0, 3'd7, 5'd0); // mov x, osr (0x00A5A500)
    tick;
    `check32(u_exec.x_r, 32'h00A5_A500)

    sec("T22: MOV status (SPEC-3.6-12, SPEC-14.10-1)");
    cfg_status_sel = 2'd0;                    // TXLEVEL
    cfg_status_n  = 5'd2;
    imem[20] = E_MOV(3'd1, 2'd0, 3'd5, 5'd0); // tx_level 0 < 2 → ones
    tick;
    `check32(u_exec.x_r, 32'hFFFF_FFFF)
    sys_tx_write(32'h1111_1111);
    sys_tx_write(32'h2222_2222);              // tx_level 2
    imem[21] = E_MOV(3'd1, 2'd0, 3'd5, 5'd0); // 2 < 2 false → zeros
    tick;
    `check32(u_exec.x_r, 32'd0)
    cfg_status_sel = 2'd2;                    // IRQ; flag 3 set in T19
    cfg_status_n  = 5'd3;
    imem[22] = E_MOV(3'd1, 2'd0, 3'd5, 5'd0);
    tick;
    `check32(u_exec.x_r, 32'hFFFF_FFFF)
    ext_flag_clr(3'd3);
    imem[23] = E_MOV(3'd1, 2'd0, 3'd5, 5'd0);
    tick;
    `check32(u_exec.x_r, 32'd0)
    cfg_status_sel = 2'd3;                    // reserved selector → zeros
    cfg_status_n  = 5'd31;
    imem[24] = E_MOV(3'd1, 2'd0, 3'd5, 5'd0);
    tick;
    `check32(u_exec.x_r, 32'd0)

    sec("T23: MOV destinations (SPEC-3.6-1..11, SPEC-5-6)");
    imem[25] = E_OUT(3'd2, 5'd0, 5'd0);       // out y,32: y ← 0x00A5A500
    tick;
    `check32(u_exec.y_r, 32'h00A5_A500)
    imem[26] = E_MOV(3'd6, 2'd0, 3'd2, 5'd0); // mov isr, y: counter ← 0
    tick;
    `check32(isr_w, 32'h00A5_A500)
    `check32(isr_cnt_w, 32'd0)                // SPEC-5-6
    imem[27] = E_MOV(3'd7, 2'd0, 3'd2, 5'd0); // mov osr, y
    tick;
    `check32(osr_w, 32'h00A5_A500)
    `check32(osr_cnt_w, 32'd0)
    imem[28] = E_MOV(3'd5, 2'd0, 3'd1, 5'd0); // mov pc, x — x==0 → pc 0
    tick;
    `check32(pc, 32'd0)
    mon_clear;
    cfg_out_base = 5'd4;
    cfg_out_count = 6'd8;
    imem[0] = E_MOV(3'd0, 2'd0, 3'd2, 5'd0);  // mov pins, y (OUT mapping)
    imem[1] = E_MOV(3'd3, 2'd0, 3'd2, 5'd0);  // mov pindirs, y
    tick;
    `check1(out_we_q, 1'b1)
    `check1(out_pindir_q, 1'b0)
    `check32(out_data_q, 32'h00A5_A500)
    tick;
    `check1(out_we_q, 1'b1)
    `check1(out_pindir_q, 1'b1)

    sec("T24: SET dsts and pin bundle (SPEC-3.9-1..3, CC-8)");
    mon_clear;
    cfg_set_base = 5'd8;
    cfg_set_count = 3'd3;
    imem[2] = E_SET(3'd0, 5'b00101, 5'd0);    // set pins, 0x05
    tick;
    `check1(set_we_q, 1'b1)
    `check1(set_pindir_q, 1'b0)
    `check32(set_data_q, 32'd5)
    imem[3] = E_SET(3'd4, 5'b00011, 5'd0);    // set pindirs, 3
    tick;
    `check1(set_we_q, 1'b1)
    `check1(set_pindir_q, 1'b1)
    imem[4] = E_SET(3'd1, 5'd17, 5'd0);       // set x,17 (zero-extended)
    tick;
    `check32(u_exec.x_r, 32'd17)
    imem[5] = E_SET(3'd2, 5'd23, 5'd0);       // set y,23
    tick;
    `check32(u_exec.y_r, 32'd23)
    imem[6] = E_SET(3'd3, 5'd1, 5'd0);        // reserved dst → no-op
    mon_clear;
    tick;
    `check1(set_we_q, 1'b0)
    `check_eq(dbg_state_w, ST_FETCH)

    sec("T25: OUT destinations (SPEC-3.4-1..12, CC-17)");
    imem[7] = E_PULL(1'b0, 1'b1, 5'd0);       // drain T22's status words
    tick;
    imem[8] = E_PULL(1'b0, 1'b1, 5'd0);
    tick;
    sys_tx_write(32'h7654_3210);
    imem[9] = E_PULL(1'b0, 1'b1, 5'd0);
    tick;
    `check32(osr_w, 32'h7654_3210)
    `check32(osr_cnt_w, 32'd0)
    mon_clear;
    imem[10] = E_OUT(3'd1, 5'd8, 5'd0);       // out x,8 → 0x10
    tick;
    `check32(u_exec.x_r, 32'h10)
    `check32(osr_cnt_w, 32'd8)
    imem[11] = E_OUT(3'd0, 5'd4, 5'd0);       // out pins,4 → 0x2
    tick;
    `check1(out_we_q, 1'b1)
    `check32(out_data_q, 32'd2)
    imem[12] = E_OUT(3'd4, 5'd4, 5'd0);       // out pindirs,4
    tick;
    `check1(out_pindir_q, 1'b1)
    imem[13] = E_OUT(3'd6, 5'd6, 5'd0);       // out isr,6 → 0x14, cnt 6
    tick;
    `check32(isr_w, 32'h14)
    `check32(isr_cnt_w, 32'd6)                // SPEC-3.4-7
    imem[14] = E_OUT(3'd3, 5'd4, 5'd0);       // out null,4 (SPEC-14.6-1)
    tick;
    `check32(osr_cnt_w, 32'd26)
    imem[15] = E_OUT(3'd3, 5'd0, 5'd0);       // out null,32 → counter 32
    tick;
    `check32(osr_cnt_w, 32'd32)
    imem[16] = E_OUT(3'd3, 5'd8, 5'd0);       // CC-17: no autopull → no
    tick;                                     // stall, shifts zeroes
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(osr_cnt_w, 32'd32)               // saturated (SPEC-5-4)
    imem[17] = E_OUT(3'd5, 5'd5, 5'd0);       // out pc,5: OSR zero → pc 0
    tick;
    `check32(pc, 32'd0)

    sec("T26: IN sources (SPEC-3.3-1..8)");
    in_bus = 32'h0000_003C;
    imem[0] = E_IN(3'd0, 5'd6, 5'd0);         // in pins,6 → MSB end
    tick;
    `check32(isr_w, 32'hF000_0000)
    `check32(isr_cnt_w, 32'd12)               // counter was 6 (out isr,6)
    imem[1] = E_IN(3'd1, 5'd8, 5'd0);         // in x,8 (x==0x10)
    tick;
    `check32(isr_w, 32'h10F0_0000)
    `check32(isr_cnt_w, 32'd20)
    imem[2] = E_IN(3'd3, 5'd4, 5'd0);         // in null,4 — still shifts
    tick;
    `check32(isr_cnt_w, 32'd24)               // SPEC-3.3-4
    in_bus = 32'h0000_00FF;
    imem[3] = E_IN(3'd0, 5'd0, 5'd0);         // in pins,32: replace
    tick;
    `check32(isr_w, 32'h0000_00FF)
    imem[4] = E_IN(3'd6, 5'd8, 5'd0);         // in isr,8: rotate right 8
    tick;
    `check32(isr_w, 32'hFF00_0000)            // SPEC-3.3-8
    imem[5] = E_IN(3'd7, 5'd8, 5'd0);         // in osr,8
    tick;
    `check32(osr_cnt_w, 32'd32)               // OSR counter undisturbed
    in_bus = 32'd0;

    // ------------------------------------------------------------------
    sec("T27: autopull OUT rules (CC-11, CC-12)");
    cfg_autopull    = 1'b1;
    cfg_pull_thresh = 5'd8;
    sys_tx_write(32'h1111_1111);
    sys_tx_write(32'h2222_2222);
    imem[6] = E_PULL(1'b0, 1'b1, 5'd0);
    tick;
    `check32(osr_w, 32'h1111_1111)
    `check32(tx_level_w, 32'd1)
    imem[7] = E_OUT(3'd3, 5'd4, 5'd0);        // cnt 4 < 8 → plain shift
    tick;
    `check32(osr_cnt_w, 32'd4)
    imem[8] = E_OUT(3'd3, 5'd4, 5'd0);        // cnt → 8: shift + refill
    tick;
    `check32(osr_w, 32'h2222_2222)            // CC-11 else-branch
    `check32(osr_cnt_w, 32'd0)
    `check32(tx_level_w, 32'd0)
    `check_eq(dbg_state_w, ST_FETCH)          // no stall
    imem[9] = E_OUT(3'd3, 5'd8, 5'd0);        // post-thr but TX empty:
    tick;                                     // deferred, no stall (CC-12)
    `check32(osr_cnt_w, 32'd8)
    `check_eq(dbg_state_w, ST_FETCH)
    imem[10] = E_OUT(3'd3, 5'd8, 5'd0);       // cnt ≥ thr at start, TX empty
    mon_clear;                                 // → stall + TXSTALL (CC-11)
    tick;
    `check_eq(dbg_state_w, ST_STALL)
    `check32(osr_cnt_w, 32'd8)                // no shift on the stall tick
    `check1(tx_stall_q, 1'b1)
    sys_tx_write(32'h3333_3333);              // releases from next tick
    tick;                                     // CC-11 first branch: refill
    `check32(osr_w, 32'h3333_3333)            // + one-tick stall (CC-12 fence)
    `check32(osr_cnt_w, 32'd0)
    `check_eq(dbg_state_w, ST_STALL)
    tick;                                     // re-executes: shifts fresh OSR
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(osr_cnt_w, 32'd8)

    sec("T28: background autopull on a non-OUT tick (CC-12)");
    imem[11] = E_NOP;                         // TX empty: refill deferred
    tick;
    `check32(osr_w, 32'h0033_3333)            // T27's final shift of the
    `check32(osr_cnt_w, 32'd8)                // fresh OSR
    sys_tx_write(32'h4444_4444);
    imem[12] = E_NOP;                         // refill on the nop tick
    tick;
    `check32(osr_w, 32'h4444_4444)
    `check32(osr_cnt_w, 32'd0)
    `check32(tx_level_w, 32'd0)
    cfg_autopull    = 1'b0;
    cfg_pull_thresh = 5'd0;

    sec("T29: autopush IN rules (CC-13, CC-9)");
    cfg_autopush    = 1'b1;
    cfg_push_thresh = 5'd8;
    in_bus = 32'h0000_00AB;
    for (int i = 0; i < 4; i++) begin
      imem[13 + i] = E_IN(3'd0, 5'd8, 5'd0);  // push post-shift ISR
      tick;
    end
    `check32(rx_level_w, 32'd4)               // RX full
    in_bus = 32'h0000_00CD;
    mon_clear;
    imem[17] = E_IN(3'd0, 5'd8, 5'd0);        // autopush into full RX
    tick;
    `check_eq(dbg_state_w, ST_STALL)          // stalls, no shift (CC-13)
    `check1(rx_stall_q, 1'b1)
    `check32(isr_cnt_w, 32'd0)
    sys_rx_read;
    tick;                                     // completes: shift+push+clear
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(rx_level_w, 32'd4)
    `check32(isr_cnt_w, 32'd0)
    `check1(rx_push_q, 1'b1)
    `check32(rx_push_data_q, 32'hCD00_0000)   // post-shift ISR (CC-9)
    cfg_autopush    = 1'b0;
    cfg_push_thresh = 5'd0;
    in_bus = 32'd0;

    sec("T30: PUSH block / noblock / iffull (SPEC-3.5-4..8, CC-19, CC-32)");
    repeat (4) sys_rx_read;
    `check32(rx_level_w, 32'd0)
    in_bus = 32'h0000_0077;
    imem[18] = E_IN(3'd0, 5'd8, 5'd0);
    tick;
    `check32(isr_w, 32'h7700_0000)
    mon_clear;
    imem[19] = E_PUSH(1'b0, 1'b1, 5'd0);      // push block with room
    tick;
    `check32(rx_level_w, 32'd1)
    `check32(isr_w, 32'd0)                    // ISR cleared (SPEC-3.5-4)
    `check32(rx_push_data_q, 32'h7700_0000)
    // Fill RX to 4 (addresses advance with the PC).
    for (int i = 0; i < 3; i++) begin
      imem[20 + 2 * i] = E_IN(3'd0, 5'd8, 5'd0);
      tick;
      imem[21 + 2 * i] = E_PUSH(1'b0, 1'b1, 5'd0);
      tick;
    end
    `check32(rx_level_w, 32'd4)
    in_bus = 32'h0000_00CA;
    imem[26] = E_IN(3'd0, 5'd8, 5'd0);
    tick;
    `check32(isr_w, 32'hCA00_0000)
    imem[27] = E_PUSH(1'b0, 1'b1, 5'd0);      // blocking, RX full -> stall
    mon_clear;
    tick;
    `check_eq(dbg_state_w, ST_STALL)
    `check32(rx_level_w, 32'd4)
    `check1(rx_stall_q, 1'b0)                 // CC-19: blocking stall is silent
    tick;
    `check_eq(dbg_state_w, ST_STALL)          // CC-14: re-evaluated per tick
    sys_rx_read;
    tick;                                     // first tick with room completes
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(rx_level_w, 32'd4)
    `check1(rx_push_q, 1'b1)
    `check32(rx_push_data_q, 32'hCA00_0000)   // held ISR pushed (CC-19)
    in_bus = 32'h0000_0012;
    imem[28] = E_IN(3'd0, 5'd8, 5'd0);
    tick;
    mon_clear;
    imem[29] = E_PUSH(1'b0, 1'b0, 5'd0);      // noblock to full RX (CC-32)
    tick;
    `check_eq(dbg_state_w, ST_FETCH)          // completes in one tick
    `check1(rx_stall_q, 1'b1)
    `check32(rx_level_w, 32'd4)               // level unchanged
    `check32(isr_w, 32'd0)                    // ISR still cleared
    sys_rx_read;                              // room again
    in_bus = 32'h0000_0055;
    imem[30] = E_IN(3'd0, 5'd4, 5'd0);        // cnt 4 < 32
    tick;
    `check32(isr_w, 32'h5000_0000)
    imem[31] = E_PUSH(1'b1, 1'b0, 5'd0);      // iffull guard fails -> no-op
    tick;
    `check32(isr_w, 32'h5000_0000)            // ISR not cleared
    `check32(rx_level_w, 32'd3)               // nothing pushed
    in_bus = 32'd0;

    sec("T31: PULL block / noblock / ifempty + CC-31 (SPEC-3.5-9..13, CC-20, CC-32, CC-31)");
    repeat (3) sys_rx_read;
    `check32(rx_level_w, 32'd0)
    imem[0] = E_PULL(1'b0, 1'b1, 5'd0);       // TX empty -> stall + TXSTALL
    mon_clear;
    tick;
    `check_eq(dbg_state_w, ST_STALL)
    `check1(tx_stall_q, 1'b1)
    tick;
    `check_eq(dbg_state_w, ST_STALL)
    sys_tx_write(32'hAAAA_0001);              // visible from next tick (CC-30)
    tick;                                     // completes, pops head (CC-20)
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(osr_w, 32'hAAAA_0001)
    `check32(tx_level_w, 32'd0)
    imem[1] = E_OUT(3'd1, 5'd0, 5'd0);        // out x,32: x <- 0xAAAA0001
    tick;
    `check32(u_exec.x_r, 32'hAAAA_0001)
    imem[2] = E_PULL(1'b0, 1'b0, 5'd0);       // noblock, TX empty:
    tick;                                     // MOV OSR,X fallback (CC-32)
    `check32(osr_w, 32'hAAAA_0001)
    `check32(osr_cnt_w, 32'd0)                // SPEC-14.7-1
    // CC-31 scenario (autopull disabled, as in spi_*_cs):
    cfg_pull_thresh = 5'd8;
    sys_tx_write(32'hCCCC_0002);
    imem[3] = E_OUT(3'd3, 5'd8, 5'd0);        // cnt 0->8, no refill
    tick;
    `check32(osr_cnt_w, 32'd8)
    imem[4] = E_PULL(1'b1, 1'b0, 5'd0);       // ifempty: guard passes at its
    tick;                                     // own tick -> consumes
    `check32(osr_w, 32'hCCCC_0002)
    `check32(tx_level_w, 32'd0)
    sys_tx_write(32'hDDDD_0003);
    imem[5] = E_OUT(3'd3, 5'd4, 5'd0);        // cnt 0->4 (< 8)
    tick;
    imem[6] = E_PULL(1'b1, 1'b0, 5'd0);       // guard fails -> no-op
    tick;
    `check32(osr_w, 32'h0CCC_C000)            // OSR preserved mid-stream
    `check32(tx_level_w, 32'd1)
    cfg_pull_thresh = 5'd0;

    // ------------------------------------------------------------------
    sec("T32: PUT/GET aux modes (SPEC-3.7-1..7, CC-21)");
    fifo_mode = 3'd3;                         // TXPUT (flushes queues)
    imem[7] = E_PUT(1'b1, 2'd2);              // literal index 2
    tick;
    `check32(u_fifo.rx_mem[2], 32'h5000_0000)
    imem[8] = E_SET(3'd2, 5'd1, 5'd0);        // y <- 1 for the Y-index mode
    tick;
    imem[9] = E_PUT(1'b0, 2'd0);              // index from Y[1:0] = 1
    tick;
    `check32(u_fifo.rx_mem[1], 32'h5000_0000)
    fifo_mode = 3'd4;                         // TXGET
    sys_aux_write(2'd1, 32'hCAFE_0001);
    imem[10] = E_GET(1'b1, 2'd1);
    tick;
    `check32(osr_w, 32'hCAFE_0001)
    `check32(osr_cnt_w, 32'd0)                // counter cleared (SPEC-3.7-3)
    fifo_mode = 3'd3;                         // GET without FJOIN_RX_GET: no-op
    imem[11] = E_GET(1'b1, 2'd1);
    tick;
    `check32(osr_w, 32'hCAFE_0001)            // OSR untouched
    fifo_mode = 3'd0;                         // TXRX (flush); PUT gated off
    imem[12] = E_PUT(1'b1, 2'd3);
    tick;
    `check_eq(dbg_state_w, ST_FETCH)          // never stalls (CC-21)
    `check32(rx_level_w, 32'd0)

    // ------------------------------------------------------------------
    sec("T33: OUT EXEC (SPEC-3.4-10, SPEC-11-1, CC-34)");
    sys_tx_write(32'h0000_E03F);              // executee: set x,31
    imem[13] = E_PULL(1'b0, 1'b1, 5'd0);
    tick;
    `check32(osr_w, 32'h0000_E03F)
    imem[14] = E_OUT(3'd7, 5'd16, 5'd2);      // out exec,16 -- delay ignored
    tick;                                     // OUT completes: pc 14->15
    `check32(pc, 32'd15)
    `check32(dbg_delay_w, 32'd0)
    `check32(instr_cur_w, 32'h0000_E03F)      // executee latched (CC-34)
    tick;                                     // executee runs on the next tick
    `check32(u_exec.x_r, 32'd31)
    `check32(pc, 32'd15)                      // not advanced by the executee
    imem[15] = E_NOP;
    tick;                                     // resumes at the stored PC
    `check32(pc, 32'd16)

    sec("T34: MOV EXEC, executee delay and stall (SPEC-3.6-11, CC-34)");
    sys_tx_write({16'h0000, E_SET(3'd2, 5'd7, 5'd2)});  // executee: set y,7 [2]
    imem[16] = E_PULL(1'b0, 1'b1, 5'd0);
    tick;
    imem[17] = E_OUT(3'd2, 5'd0, 5'd0);       // out y,32: y <- 0xE127
    tick;
    `check32(u_exec.y_r, 32'h0000_E247)
    imem[18] = E_MOV(3'd4, 2'd0, 3'd2, 5'd0); // mov exec, y
    tick;                                     // mov completes: pc 18->19
    `check32(pc, 32'd19)
    tick;                                     // executee: set y,7 [2]
    `check32(u_exec.y_r, 32'd7)
    `check32(dbg_delay_w, 32'd2)              // executee delay honoured
    `check32(pc, 32'd19)
    tick;                                     // delay ticks
    tick;
    imem[19] = E_NOP;
    tick;
    `check32(pc, 32'd20)
    // Executee that stalls: the latch holds it, PC frozen, resumes after.
    sys_tx_write({16'h0000, E_WAIT(1'b1, WSRC_GPIO, 5'd4, 5'd0)});  // wait 1 gpio 4
    imem[20] = E_PULL(1'b0, 1'b1, 5'd0);
    tick;
    imem[21] = E_OUT(3'd2, 5'd0, 5'd0);       // y <- 0x2044
    tick;
    imem[22] = E_MOV(3'd4, 2'd0, 3'd2, 5'd0); // mov exec, y
    tick;                                     // pc 22->23
    `check32(pc, 32'd23)
    tick;                                     // executee stalls (gpio 4 low)
    `check_eq(dbg_state_w, ST_STALL)
    tick;
    `check_eq(dbg_state_w, ST_STALL)          // re-executes from the latch
    gpio_seen[4] = 1'b1;
    tick;                                     // first true tick completes
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(pc, 32'd23)
    gpio_seen[4] = 1'b0;
    imem[23] = E_NOP;
    tick;
    `check32(pc, 32'd24)

    // ------------------------------------------------------------------
    sec("T35: forced instructions (SPEC-7-23/25, SPEC-11-1, CC-35)");
    imem[24] = E_NOP;
    force_run(E_SET(3'd1, 5'd9, 5'd0));       // executes on the next clk
    `check32(u_exec.x_r, 32'd9)
    `check32(pc, 32'd24)                      // PC not advanced (SPEC-7-23)
    force_run(E_JMP(JC_ALWAYS, 5'd3, 5'd0));  // forced JMP moves PC
    `check32(pc, 32'd3)
    imem[3] = E_NOP;
    force_run(E_SET(3'd2, 5'd6, 5'd3));       // forced delay field ignored
    `check32(u_exec.y_r, 32'd6)
    `check32(dbg_delay_w, 32'd0)
    `check_eq(dbg_state_w, ST_FETCH)
    tick;                                     // next sm_tick executes imem
    `check32(pc, 32'd4)
    imem[4] = E_NOP;
    // Stalled forced WAIT: latched, re-executed, EXEC_STALLED (CC-35).
    gpio_seen[4] = 1'b0;
    @(negedge clk);
    force_we = 1'b1; force_instr = E_WAIT(1'b1, WSRC_GPIO, 5'd4, 5'd0);
    @(negedge clk);
    force_we = 1'b0;
    @(negedge clk);                           // first force-tick: stalls
    `check1(exec_stalled_w, 1'b1)             // SPEC-7-15
    @(negedge clk);                           // re-executed every clk
    `check1(exec_stalled_w, 1'b1)
    `check32(pc, 32'd4)
    gpio_seen[4] = 1'b1;
    @(negedge clk);                           // condition true -> completes
    `check1(exec_stalled_w, 1'b0)
    `check32(pc, 32'd4)
    gpio_seen[4] = 1'b0;
    // Replacement of a stalled forced instruction (SPEC-7-23).
    @(negedge clk);
    force_we = 1'b1; force_instr = E_WAIT(1'b1, WSRC_GPIO, 5'd5, 5'd0);
    @(negedge clk);
    force_we = 1'b0;
    @(negedge clk);                           // stalls on gpio 5
    `check1(exec_stalled_w, 1'b1)
    force_run(E_SET(3'd1, 5'd11, 5'd0));      // replaces the stalled word
    `check1(exec_stalled_w, 1'b0)
    `check32(u_exec.x_r, 32'd11)
    // Forced write overwrites a pending executee (SPEC-7-23).
    imem[4] = E_MOV(3'd4, 2'd0, 3'd2, 5'd0);  // mov exec, y -- y==7, i.e.
    tick;                                     // executee would be `jmp 7`
    `check32(pc, 32'd5)
    force_run(E_SET(3'd1, 5'd22, 5'd0));      // forced write wins the latch
    `check32(u_exec.x_r, 32'd22)
    imem[5] = E_NOP;
    tick;                                     // resumes at pc 5
    `check32(pc, 32'd6)                       // executee (jmp 7) never ran

    sec("T36: CC-36 force-tick vs sm_tick");
    imem[6] = E_NOP;
    @(negedge clk);
    force_we = 1'b1; force_instr = E_SET(3'd1, 5'd19, 5'd0);
    @(negedge clk);
    force_we = 1'b0;
    sm_tick = 1'b1;                           // coincides with the force-tick
    @(negedge clk);
    sm_tick = 1'b0;
    `check32(u_exec.x_r, 32'd19)              // the forced instruction won
    `check32(pc, 32'd6)                       // the imem instruction dropped
    tick;                                     // deferred tick delivered
    `check32(pc, 32'd7)

    // ------------------------------------------------------------------
    sec("T37: SM_RESTART clears the SPEC-7-3 subset ([MODEL] clear tick)");
    in_bus = 32'h0000_0077;
    imem[7] = E_IN(3'd0, 5'd8, 5'd0);
    tick;
    `check32(isr_w, 32'h7750_0000)            // shifted onto T30's leftover
    imem[8] = E_SET(3'd1, 5'd5, 5'd3);        // set x,5 [3]
    tick;
    `check32(dbg_delay_w, 32'd3)
    `check_eq(dbg_state_w, ST_DELAY)
    imem[9] = E_SET(3'd2, 5'd8, 5'd0);        // marker
    osr_keep = osr_w;
    restart_pulse;
    `check32(dbg_delay_w, 32'd0)              // SPEC-7-3: delay cleared
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(pc, 32'd9)                       // PC preserved (sdk N2)
    `check32(u_exec.x_r, 32'd5)               // X preserved
    `check32(isr_w, 32'h7750_0000)            // clear not yet applied
    tick;                                     // consumed by the clear
    `check32(isr_w, 32'd0)                    // SPEC-7-3: ISR cleared
    `check32(isr_cnt_w, 32'd0)                // SPEC-5-3: counters 0/32
    `check32(osr_cnt_w, 32'd32)
    `check32(osr_w, osr_keep)                 // OSR contents preserved
    `check32(u_exec.y_r, 32'd6)               // marker not yet executed
    tick;
    `check32(u_exec.y_r, 32'd8)               // marker runs now
    `check32(pc, 32'd10)
    // Stalled forced instruction dropped (SPEC-7-3).
    gpio_seen[4] = 1'b0;
    @(negedge clk);
    force_we = 1'b1; force_instr = E_WAIT(1'b1, WSRC_GPIO, 5'd4, 5'd0);
    @(negedge clk);
    force_we = 1'b0;
    @(negedge clk);
    `check1(exec_stalled_w, 1'b1)
    restart_pulse;
    `check1(exec_stalled_w, 1'b0)
    `check1(force_tick_w, 1'b0)
    `check32(pc, 32'd10)                      // PC still preserved
    tick;                                     // consumes the pending clear
    `check32(pc, 32'd10)

    // ------------------------------------------------------------------
    sec("T38: illegal encodings are no-ops (SPEC-13-1)");
    imem[10] = {3'b111, 5'd0, 3'd3, 5'd9};    // set dst 011 (reserved)
    mon_clear;
    tick;
    `check_eq(dbg_state_w, ST_FETCH)
    `check1(set_we_q, 1'b0)
    `check32(pc, 32'd11)
    imem[11] = {3'b101, 5'd0, 3'd1, 2'b11, 3'd2};  // mov op 11 (reserved)
    tick;
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(u_exec.x_r, 32'd5)               // x untouched

    // ------------------------------------------------------------------
    // T39: regressions for bugs the formal proof found (AGENTS.md
    // formal-to-sim rule). Each was a real RTL defect uncovered by a
    // pio_sm_exec_fv assertion during C8; these directed cases keep
    // them visible to `make sim` alone.
    // ------------------------------------------------------------------
    sec("T39a: restart on a completing tick — delay still loads and counts (CC-10; fv a_p4_inv)");
    imem[12] = E_SET(3'd1, 5'd7, 5'd3);     // set x,7 [3]
    tick_with_restart;                       // completion + restart pulse
    `check32(u_exec.x_r, 32'd7)
    `check32(dbg_delay_w, 32'd3)             // G3 load beats the clear
    `check_eq(dbg_state_w, ST_DELAY)
    `check1(dbg_restart_pend_w, 1'b1)        // pulse queues the clear tick
    imem[13] = E_SET(3'd2, 5'd14, 5'd0);     // marker
    tick;                                    // consumed by the clear
    `check32(dbg_delay_w, 32'd3)             // no decrement on a consumed tick
    `check_eq(dbg_state_w, ST_DELAY)
    tick; tick; tick;                        // delay 3->0, exits ST_DELAY
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(u_exec.y_r, 32'd8)              // marker not yet (T37 value)
    tick;                                    // marker: 4 ticks after completion
    `check32(u_exec.y_r, 32'd14)
    `check32(pc, 32'd14)

    sec("T39b: forced JMP mid-delay drops the remainder (CC-35 [MODEL]; fv a_p4_inv)");
    imem[14] = E_SET(3'd1, 5'd9, 5'd3);      // set x,9 [3]
    tick;
    `check_eq(dbg_state_w, ST_DELAY)
    force_run(E_JMP(JC_ALWAYS, 5'd16, 5'd0));  // pc-writer mid-delay
    `check32(dbg_delay_w, 32'd0)             // dropped, not frozen at 3
    `check_eq(dbg_state_w, ST_FETCH)
    `check32(pc, 32'd16)
    imem[16] = E_SET(3'd2, 5'd15, 5'd0);     // marker at the target
    tick;                                    // executes next tick — no phantom delay
    `check32(u_exec.y_r, 32'd15)
    `check32(pc, 32'd17)

    sec("T39c: restart on an OUT-EXEC completion — executee survives (SPEC-7-3; fv a_p6_word)");
    sys_tx_write({16'h0000, E_SET(3'd1, 5'd21, 5'd0)});  // executee: set x,21
    imem[17] = E_PULL(1'b0, 1'b1, 5'd0);
    tick;
    imem[18] = E_OUT(3'd7, 5'd16, 5'd0);     // out exec,16
    tick_with_restart;                       // restart lands on the completion
    `check1(u_exec.latch_vld_r, 1'b1)        // executee not discarded
    `check32(u_exec.latch_r, 32'h0000_E035)  // E_SET(1,21,0)
    `check_eq(dbg_state_w, ST_EXEC)
    tick;                                    // consumed by the clear
    `check32(u_exec.x_r, 32'd9)              // executee not yet run
    tick;                                    // executee runs
    `check32(u_exec.x_r, 32'd21)
    `check32(pc, 32'd19)                     // pc not advanced by it (CC-34)

    sec("T39d: forced completion over a pending executee exits ST_EXEC (fv a_p6_inv3)");
    imem[19] = E_SET(3'd2, 5'd3, 5'd0);      // y <- 3: executee would be jmp 3
    tick;
    imem[20] = E_MOV(3'd4, 2'd0, 3'd2, 5'd0);  // mov exec, y
    tick;
    `check_eq(dbg_state_w, ST_EXEC)
    force_run(E_SET(3'd1, 5'd26, 5'd0));     // forced write wins, completes
    `check32(u_exec.x_r, 32'd26)
    `check_eq(dbg_state_w, ST_FETCH)         // not a hollow ST_EXEC
    `check1(u_exec.latch_vld_r, 1'b0)
    imem[21] = E_NOP;
    tick;                                    // resumes by fetching imem@pc
    `check32(pc, 32'd22)                     // the jmp-3 executee never ran

    sec("T39e: restart drops a stalled forced word — flag cleared with it (fv a_p5_forced_live)");
    gpio_seen[4] = 1'b0;
    @(negedge clk);
    force_we = 1'b1; force_instr = E_WAIT(1'b1, WSRC_GPIO, 5'd4, 5'd0);
    @(negedge clk);
    force_we = 1'b0;
    @(negedge clk);                          // stalls: EXEC_STALLED
    `check1(exec_stalled_w, 1'b1)
    `check1(u_exec.latch_force_r, 1'b1)
    restart_pulse;
    `check1(exec_stalled_w, 1'b0)
    `check1(force_tick_w, 1'b0)
    `check1(u_exec.latch_force_r, 1'b0)      // no dangling forced flag
    `check1(u_exec.latch_vld_r, 1'b0)
    tick;                                    // consume the queued clear

    sec("T39f: restart pulse during the clear-consume tick (fv a_p4_inv3a)");
    imem[22] = E_SET(3'd1, 5'd5, 5'd3);      // set x,5 [3]
    tick_with_restart;                       // loads delay 3, ST_DELAY, pend
    imem[23] = E_SET(3'd2, 5'd16, 5'd0);     // marker
    tick_with_restart;                       // consumed tick + second pulse
    `check32(dbg_delay_w, 32'd0)             // cleared, and ST_DELAY exits
    `check_eq(dbg_state_w, ST_FETCH)
    tick;                                    // consumed again (second pulse)
    tick;                                    // marker runs immediately
    `check32(u_exec.y_r, 32'd16)
    `check32(pc, 32'd24)

    sec("T39g: restart during a plain delay tick (fv a_p4_inv3a)");
    imem[24] = E_SET(3'd1, 5'd6, 5'd4);      // set x,6 [4]
    tick;                                    // ST_DELAY, delay 4
    tick_with_restart;                       // delay tick + restart
    `check32(dbg_delay_w, 32'd0)
    `check_eq(dbg_state_w, ST_FETCH)
    imem[25] = E_SET(3'd2, 5'd17, 5'd0);     // marker
    tick;                                    // consumed (the pulse queued)
    tick;                                    // marker
    `check32(u_exec.y_r, 32'd17)
    `check32(pc, 32'd26)

    sec("T39h: force write beats a simultaneous restart (SPEC-7-23; fv a_p5_force_next)");
    @(negedge clk);
    force_we = 1'b1; force_instr = E_SET(3'd1, 5'd27, 5'd0);
    sm_restart = 1'b1;
    @(negedge clk);
    force_we = 1'b0; sm_restart = 1'b0;
    @(negedge clk);                          // force-tick: it executes anyway
    `check32(u_exec.x_r, 32'd27)

    `TB_FINISH
  end

endmodule

// tb_pio_irq_flags.sv — directed TB for rtl/pio_irq_flags.sv (KANBAN C6).
//
// Coverage (per the C6 acceptance):
//   1. Reset: flags == 0; prev/next relay outputs equal flags.
//   2. SM set, mode THIS: flag visible the *next* cycle only (CC-37) —
//      checked during the requesting cycle (pre-edge) and after the
//      landing edge (post-edge).
//   3. SM clear, mode THIS.
//   4. REL decode (SPEC-3.8-6): SM id mod-4 on the two LSBs, bit 2
//      unaffected — SM1 idx 3 → flag 0, SM2 idx 3 → flag 1; SM3 idx 1
//      wraps (1+3) mod 4 = 0.
//   5. PREV/NEXT export (SPEC-3.8-5/7): mode PREV set never touches
//      local flags, drives prev_exp_set onehot; feeding that bus back
//      through nb_set sets the flag next cycle. Same for NEXT.
//   6. Bus W1C (SPEC-7-6) and IRQ_FORCE (SPEC-7-6).
//   7. Simultaneous set+clear of one flag ⇒ clear wins (CC-39):
//      two SMs set vs clear, force + W1C, nb_set + nb_clr.
//   8. Quiet-cycle hold: no writer ⇒ flags unchanged.
//
// Timing convention: requests are driven at negedge (settled before the
// posedge that ends the requesting cycle). `PRE samples flags during
// the requesting cycle (before the landing edge — CC-37 old value);
// `POST samples the registered value one edge later (new value).

`include "tb_common.sv"

module tb_pio_irq_flags;

  logic clk;
  logic rst;
  tb_clk_rst u_cr (.clk(clk));

  logic [3:0][2:0] sm_flag_idx;
  logic [3:0][1:0] sm_idx_mode;
  logic [3:0]      sm_irq_set, sm_irq_clr;
  logic [7:0]      irq_w1c, irq_force;
  logic [7:0]      nb_set, nb_clr;
  logic [7:0]      flags, irq_prev_o, irq_next_o;
  logic [7:0]      prev_exp_set, prev_exp_clr, next_exp_set, next_exp_clr;

  pio_irq_flags u_dut (
      .clk (clk), .rst (rst),
      .sm_flag_idx (sm_flag_idx), .sm_idx_mode (sm_idx_mode),
      .sm_irq_set (sm_irq_set), .sm_irq_clr (sm_irq_clr),
      .irq_w1c (irq_w1c), .irq_force (irq_force),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .flags (flags),
      .irq_prev_o (irq_prev_o), .irq_next_o (irq_next_o),
      .prev_exp_set (prev_exp_set), .prev_exp_clr (prev_exp_clr),
      .next_exp_set (next_exp_set), .next_exp_clr (next_exp_clr)
  );

  // Drive idle values (call at negedge).
  task drive_idle;
    begin
      sm_flag_idx = '0; sm_idx_mode = '0;
      sm_irq_set = '0; sm_irq_clr = '0;
      irq_w1c = '0; irq_force = '0;
      nb_set = '0; nb_clr = '0;
    end
  endtask

  // One request cycle: drive (caller has just set request signals at
  // this negedge), read flags mid-cycle (PRE), advance past the landing
  // edge, go idle, advance once more, read flags (POST = value during
  // the cycle after the request).
  task req_cycle(output logic [7:0] pre, output logic [7:0] post);
    begin
      #1 pre = flags;              // during the requesting cycle (CC-37)
      @(posedge clk);              // request lands at this edge
      @(negedge clk);
      drive_idle;
      #1 post = flags;             // during the next cycle
      @(posedge clk);
    end
  endtask

  logic [7:0] pre, post;

  initial begin
    drive_idle;
    `DO_RESET(4)

    // 1. Reset state.
    `check32(flags, 8'h00)
    `check32(irq_prev_o, 8'h00)
    `check32(irq_next_o, 8'h00)

    // 2. SM0 sets flag 3 (mode THIS).
    @(negedge clk);
    sm_idx_mode[0] = 2'd0; sm_flag_idx[0] = 3'd3; sm_irq_set[0] = 1'b1;
    req_cycle(pre, post);
    `check32(pre,  8'h00)  // CC-37: not visible in the requesting cycle
    `check32(post, 8'h08)  // CC-37: visible the cycle after
    `check32(irq_prev_o, 8'h08)
    `check32(irq_next_o, 8'h08)

    // 3. SM1 clears flag 3 (mode THIS).
    @(negedge clk);
    sm_idx_mode[1] = 2'd0; sm_flag_idx[1] = 3'd3; sm_irq_clr[1] = 1'b1;
    req_cycle(pre, post);
    `check32(pre,  8'h08)
    `check32(post, 8'h00)

    // 4. REL decode (SPEC-3.8-6): SM id mod-4 on the two LSBs, bit 2
    // unaffected — SM1 idx 3 → flag {0, (3+1) mod 4 = 0} = 0;
    // SM2 idx 3 → flag {0, (3+2) mod 4 = 1} = 1.
    @(negedge clk);
    sm_idx_mode[2] = 2'd2; sm_flag_idx[2] = 3'd3; sm_irq_set[2] = 1'b1;
    sm_idx_mode[1] = 2'd2; sm_flag_idx[1] = 3'd3; sm_irq_set[1] = 1'b1;
    req_cycle(pre, post);
    `check32(pre,  8'h00)
    `check32(post, 8'h03)  // flags 0 and 1

    // 4b. REL wrap: SM3 idx 1 → {0, (1+3) mod 4 = 0} = flag 0 (already
    // set — exercises the wrap without side effects).
    @(negedge clk);
    sm_idx_mode[3] = 2'd2; sm_flag_idx[3] = 3'd1; sm_irq_set[3] = 1'b1;
    req_cycle(pre, post);
    `check32(post, 8'h03)

    // 6a. Bus W1C clears flag 0 (SPEC-7-6).
    @(negedge clk);
    irq_w1c = 8'h01;
    req_cycle(pre, post);
    `check32(pre,  8'h03)
    `check32(post, 8'h02)

    // 5. PREV export (SPEC-3.8-5): SM0 mode PREV set idx 4 — local flags
    // untouched, onehot on prev_exp_set.
    @(negedge clk);
    sm_idx_mode[0] = 2'd1; sm_flag_idx[0] = 3'd4; sm_irq_set[0] = 1'b1;
    #1;
    `check32(prev_exp_set, 8'h10)
    `check32(next_exp_set, 8'h00)
    req_cycle(pre, post);
    `check32(post, 8'h02)  // PREV is export-only: local flags unchanged
    // Neighbour import: drive the exported bus into nb_set (pio_top's
    // relay wiring, minus its extra register stage — CC-38 is top's).
    @(negedge clk);
    nb_set = 8'h10;
    req_cycle(pre, post);
    `check32(post, 8'h12)

    // 5b. NEXT export + import clear (SPEC-3.8-7).
    @(negedge clk);
    sm_idx_mode[0] = 2'd3; sm_flag_idx[0] = 3'd4; sm_irq_clr[0] = 1'b1;
    #1;
    `check32(next_exp_clr, 8'h10)
    req_cycle(pre, post);
    `check32(post, 8'h12)
    @(negedge clk);
    nb_clr = 8'h10;
    req_cycle(pre, post);
    `check32(post, 8'h02)

    // 6b. IRQ_FORCE sets all flags (SPEC-7-6).
    @(negedge clk);
    irq_force = 8'hff;
    req_cycle(pre, post);
    `check32(post, 8'hff)

    // 7. Simultaneous set+clear ⇒ clear wins (CC-39).
    // 7a. On a cleared flag 2: SM0 sets 2 while SM1 clears 2.
    @(negedge clk);
    irq_w1c = 8'h04;  // precondition: clear flag 2
    req_cycle(pre, post);
    `check32(post, 8'hfb)
    @(negedge clk);
    sm_idx_mode[0] = 2'd0; sm_flag_idx[0] = 3'd2; sm_irq_set[0] = 1'b1;
    sm_idx_mode[1] = 2'd0; sm_flag_idx[1] = 3'd2; sm_irq_clr[1] = 1'b1;
    req_cycle(pre, post);
    `check32(post, 8'hfb)  // clear won
    // 7b. On a set flag 1: same-cycle re-set + clear.
    @(negedge clk);
    sm_idx_mode[0] = 2'd0; sm_flag_idx[0] = 3'd1; sm_irq_set[0] = 1'b1;
    sm_idx_mode[1] = 2'd0; sm_flag_idx[1] = 3'd1; sm_irq_clr[1] = 1'b1;
    req_cycle(pre, post);
    `check32(post, 8'hf9)  // flag 1 cleared despite the set
    // 7c. force + W1C on flag 6 same cycle.
    @(negedge clk);
    irq_force = 8'h40;
    irq_w1c   = 8'h40;
    req_cycle(pre, post);
    `check32(post, 8'hb9)  // flag 6 stays 0
    // 7d. nb_set + nb_clr on flag 0 same cycle.
    @(negedge clk);
    nb_set = 8'h01;
    nb_clr = 8'h01;
    req_cycle(pre, post);
    `check32(post, 8'hb8)

    // 8. Quiet-cycle hold: no writer ⇒ unchanged for several cycles.
    `check32(flags, 8'hb8)
    @(posedge clk); #1;
    `check32(flags, 8'hb8)
    @(posedge clk); #1;
    `check32(flags, 8'hb8)

    `TB_FINISH
  end

endmodule

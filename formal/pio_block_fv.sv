// Formal properties for pio_block (KANBAN C10) — the block-assembly
// integration proof. Three wrappers in this file, one per sby task
// (tops selected by prep):
//
//   pio_block_fv_a  (bmc_static + cover_static) — SMs held disabled
//   =================  (no CTRL writes ever, so pc is pinned at its reset
//   0 and the SM datapaths never move). Free bus reads probe every
//   readback; writes are free within {INSTR_MEM, IRQ, IRQ_FORCE,
//   INPUT_SYNC_BYPASS}. Shadow models check:
//     a1  CC-33 — an INSTR_MEM0 write retiring at end of e shows in the
//         SMx_INSTR readback (= imem[pc] = the fetch word) exactly from
//         e+1, with the old word during e (same-cycle invisibility).
//     a2  CC-37/CC-39 — the IRQ readback equals a reference flag
//         register updated by IRQ_FORCE sets, IRQ W1C, and the imported
//         nb_set/nb_clr requests, clear-wins at one edge, next-cycle
//         visibility only (no combinational leak from any writer).
//     a3  INPUT_SYNC_BYPASS RW storage equivalence.
//     a4  Reset-default pins stay put with SMs disabled: CTRL 0, FSTAT
//         0x0f00_0f00, FLEVEL 0, DBG_CFGINFO 0x1020_0404 (SPEC-7-2/9/29)
//         — the "no hidden state change while halted" contract.
//
//   pio_block_fv_ap (prove_static — k-induction)
//   ================  the CC-33 imem equivalence as an inductive proof.
//   Read-gated assertions are vacuity-hostile to k-induction (an
//   all-writes adversary window starves them), so this harness pins
//   every non-write cycle to a read of SM0_INSTR (a3' below) and
//   forbids back-to-back writes (a4') — together these force the
//   equality to be asserted in every 2-step induction window, closing
//   the arbitrary-start-state gap. The supporting invariants kill the
//   pc movers in arbitrary states: i1 SM_ENABLE stays 0 (CTRL writes
//   excluded), i2 every force_tick stays 0 (SMx_INSTR writes excluded;
//   force_tick==0 for one step clears both force latches — CC-35), so
//   i3 every pc stays 0 (no tick, no force; SM_RESTART never touches
//   the pc, SPEC-7-3). Asserted unconditionally:
//     p1  imem[pc0] == sh_w0 on every non-write cycle (the fetch word
//         itself, via the free-running readback mux).
//
//   pio_block_fv_b (bmc_pull + cover_pull)
//   ================  the CC-30 fence on a live SM. An init sequencer
//   programs `pull block; push block` (wrap 1->0) and enables SM0; the
//   free phase may only write TXF0 and read FSTAT/FLEVEL/SM0_ADDR.
//   Checks:
//     b1  before the TXF0 write: SM0 stalled at the PULL — SM0_ADDR
//         reads 0, FSTAT shows TX0 empty + RX0 empty.
//     b2  a TXF0 write retiring at end of e releases the stalled PULL
//         on the SM's first tick >= e+1 (CC-30): within a generous
//         bound after the write, RX0 is non-empty (the PUSH landed) and
//         TX0 is empty again (the word was consumed). Reads before the
//         write never see RX0 non-empty (the never-before-e+1 half).
//
//   Prove scope note (card: "prove optional — integration depth"):
//   fv_b's live SM needs the full C5/C8/C3 invariant set for induction;
//   those live in the per-module proofs, so fv_b runs as BMC+cover only.
//   fv_a's flag/ISB shadows are BMC-only for the same reason (SM-internal
//   force latches are invisible at its boundary; fv_ap exports them).
//
// Style: immediate assertions in always @(posedge clk) (owner
// convention); formal-only file (never compiled by iverilog).

// ===========================================================================
// fv_a — static (SMs never enabled): shadow equivalences + reset pins.
// ===========================================================================
module pio_block_fv_a (
    input  logic        clk,
    input  logic        rst,
    input  logic [8:0]  reg_addr,
    input  logic [31:0] reg_wdata,
    input  logic        reg_write,
    input  logic        reg_read,
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr
);
  logic [31:0]   reg_rdata;
  logic [31:0]   gpio_out, gpio_oe;
  logic [7:0]    irq_prev_o, irq_next_o;
  logic [7:0]    prev_exp_set, prev_exp_clr, next_exp_set, next_exp_clr;
  logic [15:0]   intr;
  logic [3:0]    dbg_sm_en, dbg_force;
  logic [3:0][4:0] dbg_sm_pc;

  pio_block u_dut (
      .clk (clk), .rst (rst),
      .reg_addr (reg_addr), .reg_wdata (reg_wdata),
      .reg_write (reg_write), .reg_read (reg_read), .reg_rdata (reg_rdata),
      .gpio_in (gpio_in), .gpio_out (gpio_out), .gpio_oe (gpio_oe),
      .irq_prev_r (irq_prev_r), .irq_next_r (irq_next_r),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .irq_prev_o (irq_prev_o), .irq_next_o (irq_next_o),
      .prev_exp_set (prev_exp_set), .prev_exp_clr (prev_exp_clr),
      .next_exp_set (next_exp_set), .next_exp_clr (next_exp_clr),
      .intr (intr),
      .dbg_sm_en (dbg_sm_en), .dbg_sm_pc (dbg_sm_pc), .dbg_force (dbg_force)
  );

  wire [6:0] w = reg_addr[8:2];

  // Reference models (C8 harness idiom: initializers pin the $initstate
  // values; the rst branch mirrors the DUT reset).
  logic [15:0] sh_w0    = 16'd0;   // imem word 0 (pc pinned 0)
  logic [7:0]  sh_flags = 8'd0;    // CC-37/CC-39 reference flag register
  logic [31:0] sh_isb   = 32'd0;

  always @(posedge clk) begin
    if (rst) begin
      sh_w0    <= 16'd0;
      sh_flags <= 8'd0;
      sh_isb   <= 32'd0;
    end else begin
      if (reg_write && (w == 7'd18)) sh_w0 <= reg_wdata[15:0];  // SPEC-7-10
      // CC-39: per-bit RMW at one edge, clear wins over set.
      sh_flags <= ((sh_flags
                    | ((reg_write && (w == 7'd13)) ? reg_wdata[7:0] : 8'd0)
                    | nb_set)
                   & ~(((reg_write && (w == 7'd12)) ? reg_wdata[7:0] : 8'd0)
                       | nb_clr));
      if (reg_write && (w == 7'd14)) sh_isb <= reg_wdata;       // SPEC-7-7
    end
  end

  always @(posedge clk) begin
    if ($initstate) assume (rst);                                // A1
    // A2: writes only to the shadowed registers — no CTRL (SMs stay
    // disabled), no TXF/PUTGET/config (FIFO levels stay at reset).
    if (reg_write)
      assume ((w >= 7'd18 && w <= 7'd49) || (w == 7'd12)
              || (w == 7'd13) || (w == 7'd14));

    if (!$initstate && !rst) begin
      // Integration invariants (reachability-checked here; fv_ap proves
      // them inductively).
      a_en  : assert (dbg_sm_en == 4'd0);    // SPEC-7-2 never enabled
      a_pc0 : assert (dbg_sm_pc[0] == 5'd0); // pc pinned (SPEC-7-3 note)
      a_pc1 : assert (dbg_sm_pc[1] == 5'd0);
      a_pc2 : assert (dbg_sm_pc[2] == 5'd0);
      a_pc3 : assert (dbg_sm_pc[3] == 5'd0);
      a_for : assert (dbg_force == 4'd0);    // CC-35 latches empty

      // a1 (CC-33): fetch-word readback == newest word 0, from e+1.
      if (reg_read && (w == 7'd54)) a_i0 : assert (reg_rdata[15:0] == sh_w0);
      if (reg_read && (w == 7'd60)) a_i1 : assert (reg_rdata[15:0] == sh_w0);
      if (reg_read && (w == 7'd66)) a_i2 : assert (reg_rdata[15:0] == sh_w0);
      if (reg_read && (w == 7'd72)) a_i3 : assert (reg_rdata[15:0] == sh_w0);
      // a2 (CC-37/CC-39): flag readback == reference register.
      if (reg_read && (w == 7'd12)) a_fl : assert (reg_rdata[7:0] == sh_flags);
      // a3: ISB storage.
      if (reg_read && (w == 7'd14)) a_sb : assert (reg_rdata == sh_isb);
      // a4: reset pins hold while everything is halted.
      if (reg_read && (w == 7'd0))  a_ct : assert (reg_rdata == 32'd0);
      if (reg_read && (w == 7'd1))  a_fs : assert (reg_rdata == 32'h0f00_0f00);
      if (reg_read && (w == 7'd3))  a_flv: assert (reg_rdata == 32'd0);
      if (reg_read && (w == 7'd17)) a_ci : assert (reg_rdata == 32'h1020_0404);

      // Covers (cover_static task): each interesting window is reached.
      if (reg_read && (w == 7'd54) && (sh_w0 != 16'd0))
        c_readback_after_write : cover (1'b1);                   // a1 hot
      if ((sh_flags != 8'd0) && reg_read && (w == 7'd12))
        c_flag_readback : cover (1'b1);                          // a2 hot
      // CC-39 hot: a W1C touching a bit forced in the previous cycle
      // (a same-cycle read of IRQ + write of IRQ_FORCE is impossible on
      // the shared address bus, hence the previous-cycle tracking).
      if (p_force_r != 8'd0 && reg_write && (w == 7'd12)
          && ((p_force_r & reg_wdata[7:0]) != 8'd0))
        c_w1c_vs_force : cover (1'b1);
    end
  end

  logic [7:0] p_force_r = 8'd0;
  always @(posedge clk)
    p_force_r <= (!rst && reg_write && (w == 7'd13)) ? reg_wdata[7:0] : 8'd0;
endmodule

// ===========================================================================
// fv_ap — k-induction prove of the CC-33 imem equivalence (pinned reads).
// ===========================================================================
module pio_block_fv_ap (
    input  logic        clk,
    input  logic        rst,
    input  logic [8:0]  reg_addr,
    input  logic [31:0] reg_wdata,
    input  logic        reg_write,
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr
);
  logic        reg_read;
  logic [31:0] reg_rdata;
  logic [31:0] gpio_out, gpio_oe;
  logic [7:0]  irq_prev_o, irq_next_o;
  logic [7:0]  prev_exp_set, prev_exp_clr, next_exp_set, next_exp_clr;
  logic [15:0] intr;
  logic [3:0]  dbg_sm_en, dbg_force;
  logic [3:0][4:0] dbg_sm_pc;

  pio_block u_dut (
      .clk (clk), .rst (rst),
      .reg_addr (reg_addr), .reg_wdata (reg_wdata),
      .reg_write (reg_write), .reg_read (reg_read), .reg_rdata (reg_rdata),
      .gpio_in (gpio_in), .gpio_out (gpio_out), .gpio_oe (gpio_oe),
      .irq_prev_r (irq_prev_r), .irq_next_r (irq_next_r),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .irq_prev_o (irq_prev_o), .irq_next_o (irq_next_o),
      .prev_exp_set (prev_exp_set), .prev_exp_clr (prev_exp_clr),
      .next_exp_set (next_exp_set), .next_exp_clr (next_exp_clr),
      .intr (intr),
      .dbg_sm_en (dbg_sm_en), .dbg_sm_pc (dbg_sm_pc), .dbg_force (dbg_force)
  );

  wire [6:0] w = reg_addr[8:2];

  // A3': every non-write cycle is a read of SM0_INSTR — the readback mux
  // then continuously exposes the fetch word imem[pc0].
  always_comb begin
    reg_read = !reg_write;
    // reg_addr is an input; pin its idle value by assumption instead:
  end

  logic        p_wr_r = 1'b0;      // previous-cycle write (A4')
  logic [15:0] sh_w0  = 16'd0;

  always @(posedge clk) begin
    if ($initstate) assume (rst);                                 // A1
    // A2: writes only to INSTR_MEM (the property under proof).
    if (reg_write) assume ((w >= 7'd18) && (w <= 7'd49));
    // A3': idle cycles read SM0_INSTR (word index 54).
    if (!reg_write) assume ((reg_addr[1:0] == 2'b00) && (w == 7'd54));
    // A4': no two consecutive write cycles — every 2-step induction
    // window contains an idle (asserting) cycle.
    if (!$initstate) assume (!(reg_write && p_wr_r));

    if (!$initstate && !rst) begin
      // Supporting invariants (inductive under A1/A2):
      i1 : assert (dbg_sm_en == 4'd0);      // CTRL never written
      i2 : assert (dbg_force == 4'd0);      // force latches empty (CC-35)
      i3 : assert (dbg_sm_pc[0] == 5'd0);   // pc frozen at reset (i1+i2)
      // p1 (CC-33): the fetch word at pc0 equals the reference word 0 —
      // same write strobes, same edge; visible on every idle cycle.
      if (!reg_write) p1 : assert (reg_rdata[15:0] == sh_w0);
    end

    p_wr_r <= reg_write && !rst;
    if (rst)                          sh_w0 <= 16'd0;
    else if (reg_write && (w == 7'd18)) sh_w0 <= reg_wdata[15:0];
  end
endmodule

// ===========================================================================
// fv_b — live SM0: the CC-30 TXF-releases-stalled-PULL fence.
// ===========================================================================
module pio_block_fv_b (
    input  logic        clk,
    input  logic        rst,
    input  logic [31:0] reg_wdata_free,   // anyseq: free-phase wdata
    input  logic        reg_write_free,   // anyseq: free-phase write strobe
    input  logic [6:0]  raddr_free,       // anyseq: free-phase read index
    input  logic        reg_read_free,    // anyseq: free-phase read strobe
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr
);
  logic [8:0]  reg_addr;
  logic [31:0] reg_wdata;
  logic        reg_write, reg_read;
  logic [31:0] reg_rdata;
  logic [31:0] gpio_out, gpio_oe;
  logic [7:0]  irq_prev_o, irq_next_o;
  logic [7:0]  prev_exp_set, prev_exp_clr, next_exp_set, next_exp_clr;
  logic [15:0] intr;
  logic [3:0]  dbg_sm_en, dbg_force;
  logic [3:0][4:0] dbg_sm_pc;

  localparam int FS_TXEMPTY = 24, FS_RXEMPTY = 8;   // FSTAT nibble LSBs

  // ------------------------------------------------------------------
  // Init sequencer: program pull block / push block (wrap 1->0), enable
  // SM0; then hand the bus to the free stimulus (writes: TXF0 only;
  // reads: FSTAT / FLEVEL / SM0_ADDR). Counter advances at posedge.
  // ------------------------------------------------------------------
  localparam int SEQ_STEPS = 4;
  logic [2:0] seq_r = 3'd0;
  logic       free_c;

  always_ff @(posedge clk) begin
    if (rst)            seq_r <= 3'd0;
    else if (seq_r < 3'(SEQ_STEPS)) seq_r <= seq_r + 3'd1;
  end
  assign free_c = (seq_r == 3'(SEQ_STEPS));

  always_comb begin
    reg_write = 1'b0;
    reg_read  = 1'b0;
    reg_addr  = 9'd0;
    reg_wdata = 32'd0;
    case (seq_r)
      3'd0: begin reg_addr = 9'h048; reg_wdata = 32'h80a0; reg_write = 1'b1; end // pull block (bit 7 = pull!)
      3'd1: begin reg_addr = 9'h04c; reg_wdata = 32'h8020; reg_write = 1'b1; end // push block
      3'd2: begin reg_addr = 9'h0cc; reg_wdata = 32'h0000_1000; reg_write = 1'b1; end // wrap 1->0
      3'd3: begin reg_addr = 9'h000; reg_wdata = 32'h1; reg_write = 1'b1; end    // SM0 on
      default: begin                                                            // free
        reg_write = reg_write_free;
        reg_read  = reg_read_free;
        reg_addr  = {2'b0, raddr_free, 2'b00};
        reg_wdata = reg_wdata_free;
      end
    endcase
  end

  pio_block u_dut (
      .clk (clk), .rst (rst),
      .reg_addr (reg_addr), .reg_wdata (reg_wdata),
      .reg_write (reg_write), .reg_read (reg_read), .reg_rdata (reg_rdata),
      .gpio_in (gpio_in), .gpio_out (gpio_out), .gpio_oe (gpio_oe),
      .irq_prev_r (irq_prev_r), .irq_next_r (irq_next_r),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .irq_prev_o (irq_prev_o), .irq_next_o (irq_next_o),
      .prev_exp_set (prev_exp_set), .prev_exp_clr (prev_exp_clr),
      .next_exp_set (next_exp_set), .next_exp_clr (next_exp_clr),
      .intr (intr),
      .dbg_sm_en (dbg_sm_en), .dbg_sm_pc (dbg_sm_pc), .dbg_force (dbg_force)
  );

  // ------------------------------------------------------------------
  // Monitors: first TXF0 write (CC-30's cycle e) + settle countdown.
  // ------------------------------------------------------------------
  logic       tx_seen_r = 1'b0;
  logic [3:0] timer_r   = 4'd0;

  always @(posedge clk) begin
    if (rst) begin
      tx_seen_r <= 1'b0;
      timer_r   <= 4'd0;
    end else if (free_c && reg_write && !tx_seen_r && (reg_addr[8:2] == 7'd4)) begin
      tx_seen_r <= 1'b1;                       // e: write retires this edge
      timer_r   <= 4'd8;                       // generous release bound
    end else if (timer_r != 4'd0) begin
      timer_r <= timer_r - 4'd1;
    end
  end

  always @(posedge clk) begin
    if ($initstate) assume (rst);                                 // A1
    if (free_c) begin
      // A5: free writes target TXF0 only, and only before the first one
      // has been absorbed (single-shot stimulus keeps the levels model-free).
      if (reg_write) assume (reg_addr[8:2] == 7'd4);
      assume (!(tx_seen_r && reg_write));
      // A6: free reads stay within the observed status set.
      if (reg_read) assume ((reg_addr[8:2] == 7'd1)   // FSTAT
                            || (reg_addr[8:2] == 7'd3) // FLEVEL
                            || (reg_addr[8:2] == 7'd53)); // SM0_ADDR
    end

    if (!$initstate && !rst && free_c) begin
      // b1: stalled at the PULL before the TXF0 write (CC-20/CC-30).
      if (!tx_seen_r && reg_read) begin
        if (reg_addr[8:2] == 7'd53)
          b1_pc : assert (reg_rdata[4:0] == 5'd0);                // SM0_ADDR
        if (reg_addr[8:2] == 7'd1) begin
          b1_tx : assert (reg_rdata[FS_TXEMPTY] == 1'b1);         // TX0 empty
          b1_rx : assert (reg_rdata[FS_RXEMPTY] == 1'b1);         // RX0 empty
        end
      end
      // b2: CC-30 release — first tick >= e+1 completes the PULL and the
      // next tick PUSHes, well inside the settle window; TX0 drained.
      if (tx_seen_r && (timer_r == 4'd0) && reg_read) begin
        if (reg_addr[8:2] == 7'd1) begin
          b2_rx : assert (reg_rdata[FS_RXEMPTY] == 1'b0);         // PUSH in
          b2_tx : assert (reg_rdata[FS_TXEMPTY] == 1'b1);         // popped
        end
        if (reg_addr[8:2] == 7'd3) begin
          b2_lv : assert (reg_rdata[7:4] != 4'd0);                // RX0 >= 1
          b2_lt : assert (reg_rdata[3:0] == 4'd0);                // TX0 == 0
        end
      end
      // Covers (cover_pull task).
      if (!tx_seen_r && reg_read && (reg_addr[8:2] == 7'd1))
        c_b1_read : cover (1'b1);
      if (tx_seen_r && (timer_r == 4'd0) && reg_read && (reg_addr[8:2] == 7'd1))
        c_b2_read : cover (1'b1);
      if (reg_write && (reg_addr[8:2] == 7'd4))
        c_txf_write : cover (1'b1);
    end
  end

endmodule

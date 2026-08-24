// tb_pio_block — directed TB for rtl/pio_block.sv (KANBAN C10): block
// assembly with configuration arriving exclusively through the flat reg
// bus (SPEC-7-x), one clk-cycle retire (DESIGN.md §Interface decisions),
// and the block boundary owned by this card: the imem write port (CC-33),
// the FIFO system ports (CC-29/CC-30) and the flag path (CC-37).
//
// The TB plays only the bus master and the pads: it drives reg_addr/
// reg_wdata/reg_write/reg_read and gpio_in, and observes reg_rdata,
// gpio_out/gpio_oe, the INTR composition and the flag relay outputs.
// Everything else (4 SMs, imem, IRQ flags, GPIO mux) is in the DUT.
//
// Coverage (C10 acceptance):
//   T1  Reset defaults of every mapped register (SPEC-7-26 reset values,
//       FSTAT 0x0f00_0f00, DBG_CFGINFO) + unmapped read 0 + INTR=0xf0.
//   T2  Blink program end-to-end via the reg bus: program imem, configure
//       PINCTRL/EXECCTRL, enable via CTRL, observe gpio_out (SPEC-7-2,
//       SPEC-7-25 config visibility); disable freezes the pins.
//   T3  pull block/push block loop on SM1: FSTAT/FLEVEL readbacks after
//       pushes/pulls, RXF readback+pop, TXF write releasing the stalled
//       PULL on the first tick >= e+1 (CC-30).
//   T4  TX fill to TXFULL on a halted SM (sys side independent of enable),
//       TXOVER on write-on-full, RXUNDER on read-on-empty, FDEBUG W1C
//       (SPEC-6-5..7); INTR TXNFULL composition (SPEC-7-12).
//   T5  IRQ force + W1C over the bus (SPEC-7-6, CC-37 next-cycle
//       visibility, CC-39 clear-wins); SM-driven `irq set` from SM3;
//       relay outputs mirror the flag register.
//   T6  SMx_INSTR forced instructions on a halted SM (SPEC-7-23..25,
//       CC-35): forced SET moves the pins, forced JMP moves the PC,
//       SMx_INSTR readback = imem[pc] (SPEC-7-24), forced blocking PULL
//       latches EXEC_STALLED (SPEC-7-15) and is released by a TXF write
//       (CC-30) or dropped by CTRL.SM_RESTART (SPEC-7-3).
//   T7  RXFx_PUTGET over the bus (SPEC-7-13, SPEC-3.7-5): system writes
//       only in GET mode, FJOIN change flushes the storage.
//   T8  Input path end-to-end: `in pins, 32` + push, RXF readback equals
//       the pad word through the 2-FF sync (CC-23) and through the
//       bypass (SPEC-7-7).
//
// Red/green note (AGENTS.md): T2 is the regression for the imem write
// index decode — against `wr_addr = reg_addr[6:2]` (missing the -0x48
// word-offset) the program lands in words 18/19, the SM reads reset
// zeros and the blink never starts (first failing check: the
// wait-for-high timeout after enabling SM0).

`include "tb_common.sv"

module tb_pio_block;

  logic clk;
  logic rst;
  tb_clk_rst u_cr (.clk(clk));

  // ---------------------------------------------------------------------
  // Instruction encoders (SPEC-2-1..18 master table; same set as tb_pio_sm).
  // ---------------------------------------------------------------------
  localparam logic [2:0] JC_ALWAYS = 3'd0;
  localparam logic [2:0] INS_PINS  = 3'd0;
  localparam logic [2:0] SETD_PINS = 3'd0;
  localparam logic [2:0] OUTD_ISR  = 3'd6;    // SPEC-3.4-2..8
  localparam logic [1:0] IDX_THIS  = 2'd0;

  function automatic logic [15:0] E_JMP(input logic [2:0] cond,
                                        input logic [4:0] addr,
                                        input logic [4:0] dly);
    E_JMP = {3'b000, dly, cond, addr};
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

  // ---------------------------------------------------------------------
  // Register map (SPEC-7-x; sdk regs/pio.h RP2350 word addresses).
  // ---------------------------------------------------------------------
  localparam logic [8:0] A_CTRL     = 9'h000;  // SPEC-7-2
  localparam logic [8:0] A_FSTAT    = 9'h004;  // SPEC-6-6
  localparam logic [8:0] A_FDEBUG   = 9'h008;  // SPEC-6-7
  localparam logic [8:0] A_FLEVEL   = 9'h00c;  // SPEC-6-6
  localparam logic [8:0] A_IRQ      = 9'h030;  // SPEC-7-6
  localparam logic [8:0] A_IRQF     = 9'h034;  // SPEC-7-6
  localparam logic [8:0] A_ISB      = 9'h038;  // SPEC-7-7
  localparam logic [8:0] A_PADOUT   = 9'h03c;  // SPEC-7-8
  localparam logic [8:0] A_PADOE    = 9'h040;  // SPEC-7-8
  localparam logic [8:0] A_CFGINFO  = 9'h044;  // SPEC-7-9

  function automatic logic [8:0] A_TXF(input int i);    // SPEC-7-28
    A_TXF = 9'h010 + 9'(4*i);
  endfunction
  function automatic logic [8:0] A_RXF(input int i);    // SPEC-7-28
    A_RXF = 9'h020 + 9'(4*i);
  endfunction
  function automatic logic [8:0] A_IMEM(input int i);   // SPEC-7-10
    A_IMEM = 9'h048 + 9'(4*i);
  endfunction
  function automatic logic [8:0] A_SM(input int i, input int r); // 0x0c8+ stride 0x18
    A_SM = 9'h0c8 + 9'(8'h18*i) + 9'(4*r);   // r: 0 CLKDIV .. 5 PINCTRL
  endfunction
  function automatic logic [8:0] A_PUTGET(input int x, input int y); // SPEC-7-13
    A_PUTGET = 9'h128 + 9'(8'h10*x) + 9'(4*y);
  endfunction

  // FSTAT / FDEBUG nibble LSBs (sdk regs/pio.h; SPEC-7-29).
  localparam int FS_TXFULL  = 16, FS_TXEMPTY = 24, FS_RXFULL  = 0, FS_RXEMPTY = 8;
  localparam int FD_TXSTALL = 24, FD_TXOVER  = 16, FD_RXUNDER = 8, FD_RXSTALL = 0;

  // ---------------------------------------------------------------------
  // Bus + pads stimulus, DUT outputs.
  // ---------------------------------------------------------------------
  logic [8:0]  reg_addr;
  logic [31:0] reg_wdata;
  logic        reg_write, reg_read;
  logic [31:0] reg_rdata_w;
  logic [31:0] gpio_in;
  logic [31:0] gpio_out_w, gpio_oe_w;
  logic [7:0]  irq_prev_r, irq_next_r, nb_set, nb_clr;
  logic [7:0]  irq_prev_o_w, irq_next_o_w;
  logic [7:0]  prev_exp_set_w, prev_exp_clr_w, next_exp_set_w, next_exp_clr_w;
  logic [15:0] intr_w;

  pio_block u_dut (
      .clk            (clk),
      .rst            (rst),
      .reg_addr       (reg_addr),
      .reg_wdata      (reg_wdata),
      .reg_write      (reg_write),
      .reg_read       (reg_read),
      .reg_rdata      (reg_rdata_w),
      .gpio_in        (gpio_in),
      .gpio_out       (gpio_out_w),
      .gpio_oe        (gpio_oe_w),
      .irq_prev_r     (irq_prev_r),
      .irq_next_r     (irq_next_r),
      .nb_set         (nb_set),
      .nb_clr         (nb_clr),
      .irq_prev_o     (irq_prev_o_w),
      .irq_next_o     (irq_next_o_w),
      .prev_exp_set   (prev_exp_set_w),
      .prev_exp_clr   (prev_exp_clr_w),
      .next_exp_set   (next_exp_set_w),
      .next_exp_clr   (next_exp_clr_w),
      .intr           (intr_w)
  );

  integer clk_count = 0;
  always @(posedge clk) clk_count = clk_count + 1;

  // ---------------------------------------------------------------------
  // Bus master tasks. Drive at negedge, retire at the posedge between
  // the two negedges (CC-3); reg_rdata is combinational, so sample it
  // mid-cycle (#1 after the negedge) — no settling race.
  // ---------------------------------------------------------------------
  task automatic bus_wr(input logic [8:0] a, input logic [31:0] d);
    begin
      @(negedge clk);
      reg_addr  = a;
      reg_wdata = d;
      reg_write = 1'b1;
      @(negedge clk);
      reg_write = 1'b0;   // write retired at the posedge in between
    end
  endtask

  task automatic bus_rd(input logic [8:0] a, output logic [31:0] v);
    begin
      @(negedge clk);
      reg_addr = a;
      reg_read = 1'b1;
      #1;
      v = reg_rdata_w;    // combinational mux, stable through the cycle
      @(negedge clk);
      reg_read = 1'b0;    // RXF reads pop at the posedge in between (SPEC-6-5)
    end
  endtask

  // check-read shorthand.
  task automatic rd_check(input logic [8:0] a, input logic [31:0] exp);
    logic [31:0] v;
    begin
      bus_rd(a, v);
      `check32(v, exp)
    end
  endtask

  // Poll a register until it equals exp, max_clks bus reads. ok=0 on
  // timeout (caller reports with its own check).
  task automatic poll_eq(input logic [8:0] a, input logic [31:0] exp,
                         input int max_clks, output logic ok);
    logic [31:0] v;
    int k;
    begin
      ok = 1'b0;
      v  = 32'hxxxx_xxxx;
      for (k = 0; k < max_clks && !ok; k++) begin
        bus_rd(a, v);
        if (v === exp) ok = 1'b1;
      end
    end
  endtask

  // Wait for gpio_out[pin] == val, sampling after each posedge settle.
  task automatic wait_gpio(input int pin, input logic val,
                           input int max_clks, output logic ok);
    int k;
    begin
      ok = 1'b0;
      for (k = 0; k < max_clks && !ok; k++) begin
        @(posedge clk);
        #1;
        if (gpio_out_w[pin] === val) ok = 1'b1;
      end
    end
  endtask

  // Drain RXF0: pop until empty, checking every word equals exp (the
  // T8 loop has no blocking stage, so the SM queues up to depth 4
  // copies of the same pattern before its push stalls).
  task automatic drain_rx0(input logic [31:0] exp);
    logic [31:0] v;
    int k;
    begin
      for (k = 0; k < 6; k++) begin
        bus_rd(A_FSTAT, v);
        if (v[FS_RXEMPTY + 0] === 1'b1) k = 100;   // done
        else begin
          rd_check(A_RXF(0), exp);
        end
      end
    end
  endtask

  // ---------------------------------------------------------------------
  // Stimulus.
  // ---------------------------------------------------------------------
  logic        ok;
  logic [31:0] rv;
  int          t_hi1, t_lo, t_hi2;
  logic        was;

  initial begin
    reg_addr   = 9'd0;
    reg_wdata  = 32'd0;
    reg_write  = 1'b0;
    reg_read   = 1'b0;
    gpio_in    = 32'd0;
    irq_prev_r = 8'd0;
    irq_next_r = 8'd0;
    nb_set     = 8'd0;
    nb_clr     = 8'd0;
    `DO_RESET(4)
    `WAIT_CLKS(2)

    // ------------------------------------------------------------------
    // T1: reset defaults of the whole map (SPEC-7-26, SPEC-7-9, SPEC-7-6).
    // ------------------------------------------------------------------
    $display("--- T1: reset defaults");
    rd_check(A_CTRL, 32'h0);
    rd_check(A_FSTAT, 32'h0f00_0f00);          // all FIFOs empty
    rd_check(A_FDEBUG, 32'h0);
    rd_check(A_FLEVEL, 32'h0);
    rd_check(A_IRQ, 32'h0);
    rd_check(A_IRQF, 32'h0);                   // WO strobe reads 0
    rd_check(A_ISB, 32'h0);
    rd_check(A_PADOUT, 32'h0);
    rd_check(A_PADOE, 32'h0);
    rd_check(A_CFGINFO, 32'h1020_0404);        // SPEC-7-9: v1, 32, 4, 4
    rd_check(A_IMEM(0), 32'h0);                // WO + reset-zero words
    for (int i = 0; i < 4; i++) begin
      rd_check(A_SM(i, 3), 32'h0);             // SMx_ADDR
      rd_check(A_SM(i, 4), 32'h0);             // SMx_INSTR = imem[pc]
      rd_check(A_SM(i, 0), 32'h0001_0000);     // CLKDIV INT=1 (SPEC-7-14)
      rd_check(A_SM(i, 1), 32'h0000_1fff);     // EXECCTRL (SPEC-7-19)
      rd_check(A_SM(i, 2), 32'h000c_0000);     // SHIFTDIR right (SPEC-7-21)
      rd_check(A_SM(i, 5), 32'h1400_0000);     // SET_COUNT=5 (SPEC-7-26)
    end
    rd_check(9'h168, 32'h0);                   // GPIOBASE undecoded (pio_top)
    rd_check(9'h1ff, 32'h0);                   // beyond the map reads 0
    `check32(intr_w, 8'hf0)                    // SPEC-7-12: TXNFULL at reset

    // ------------------------------------------------------------------
    // T2: blink end-to-end on SM0 (card acceptance).
    // ------------------------------------------------------------------
    $display("--- T2: blink via reg bus, SM0");
    bus_wr(A_IMEM(0), 32'(E_SET(SETD_PINS, 5'd1, 5'd3)));  // set pins,1 [3]
    bus_wr(A_IMEM(1), 32'(E_SET(SETD_PINS, 5'd0, 5'd3)));  // set pins,0 [3]
    bus_wr(A_SM(0, 5), 32'h0400_0000);        // PINCTRL: SET_COUNT=1
    bus_wr(A_SM(0, 1), 32'h0000_1000);        // EXECCTRL: wrap 1 -> 0
    bus_wr(A_CTRL, 32'h1);                    // SM_ENABLE[0] (SPEC-7-2)
    wait_gpio(0, 1'b1, 24, ok);
    `check1(ok, 1'b1)                          // red/green anchor: imem decode
    t_hi1 = clk_count;
    #1;
    `check32(gpio_out_w, 32'h0000_0001)        // only pin 0 (SET_COUNT=1)
    `check32(gpio_oe_w, 32'h0)                 // no pindirs written
    wait_gpio(0, 1'b0, 8, ok);
    `check1(ok, 1'b1)
    t_lo = clk_count;
    wait_gpio(0, 1'b1, 8, ok);
    `check1(ok, 1'b1)
    t_hi2 = clk_count;
    `check32(t_lo - t_hi1, 32'd4)              // 1 exec + 3 delay clks
    `check32(t_hi2 - t_hi1, 32'd8)             // 2-instruction loop period
    // Disable: pin levels hold (SPEC-10-2 no-writer hold).
    bus_wr(A_CTRL, 32'h0);
    was = gpio_out_w[0];
    `WAIT_CLKS(10)
    #1;
    `check1(gpio_out_w[0], was)

    // ------------------------------------------------------------------
    // T3: pull/push loop on SM1 — FSTAT/FLEVEL/RXF over the bus (CC-30).
    // ------------------------------------------------------------------
    $display("--- T3: FIFO loop via reg bus, SM1");
    // pull block; out isr,32 (route the pulled word to the ISR — PUSH
    // pushes the ISR, SPEC-3.5); push block; wrap 2 -> 0.
    bus_wr(A_IMEM(0), 32'(E_PULL(1'b0, 1'b1, 5'd0)));      // pull block
    bus_wr(A_IMEM(1), 32'(E_OUT(OUTD_ISR, 5'd0, 5'd0)));   // out isr, 32
    bus_wr(A_IMEM(2), 32'(E_PUSH(1'b0, 1'b1, 5'd0)));      // push block
    bus_wr(A_SM(1, 1), 32'h0000_2000);        // wrap 2 -> 0
    bus_wr(A_CTRL, 32'h2);                    // SM1 on, SM0 stays off
    `WAIT_CLKS(4)                             // SM1 stalls at the PULL
    rd_check(A_SM(1, 3), 32'h0);              // SM1_ADDR pinned at 0
    bus_rd(A_FSTAT, rv);
    `check1(rv[FS_TXEMPTY + 1], 1'b1)         // TX1 empty
    bus_rd(A_FLEVEL, rv);
    `check32(rv[11:8], 32'd0);                // TX1 level 0
    bus_wr(A_TXF(1), 32'hdead_beef);          // retires end of cycle e
    poll_eq(A_SM(1, 3), 32'h1, 8, ok);        // PULL done on 1st tick >= e+1
    `check1(ok, 1'b1)
    poll_eq(A_FSTAT, 32'h0f00_0f00 & ~(32'h1 << (FS_RXEMPTY + 1)), 8, ok);
    `check1(ok, 1'b1)                         // RX1 non-empty (SPEC-6-6)
    bus_rd(A_FLEVEL, rv);
    `check32(rv[15:12], 32'd1);               // RX1 level 1
    `check32(rv[11:8], 32'd0);                // TX1 drained by the PULL
    rd_check(A_RXF(1), 32'hdead_beef);        // RXF1 readback, pops (SPEC-6-5)
    bus_rd(A_FLEVEL, rv);
    `check32(rv[15:12], 32'd0);               // popped
    `WAIT_CLKS(4)
    rd_check(A_SM(1, 3), 32'h0);              // wrapped, stalled again

    // ------------------------------------------------------------------
    // T4: TX fill / sticky flags on halted SM2 (sys side runs clk-rate).
    // ------------------------------------------------------------------
    $display("--- T4: TXFULL/TXOVER/RXUNDER + FDEBUG W1C, SM2 halted");
    bus_wr(A_CTRL, 32'h0);                    // all SMs halted
    for (int k = 0; k < 4; k++)
      bus_wr(A_TXF(2), 32'h2000_0000 + 32'(k));
    bus_rd(A_FLEVEL, rv);
    `check32(rv[19:16], 32'd4);               // TX2 full (depth 4, SPEC-6-1)
    bus_rd(A_FSTAT, rv);
    `check1(rv[FS_TXFULL + 2], 1'b1)
    `check1(rv[FS_TXEMPTY + 2], 1'b0)
    bus_wr(A_TXF(2), 32'hbad0_bad0);          // dropped on full (SPEC-6-5)
    bus_rd(A_FLEVEL, rv);
    `check32(rv[19:16], 32'd4);               // level unchanged
    bus_rd(A_FDEBUG, rv);
    `check1(rv[FD_TXOVER + 2], 1'b1)          // TXOVER2 sticky (SPEC-6-7)
    bus_rd(A_RXF(2), rv);                     // read on empty: undefined data
    bus_rd(A_FDEBUG, rv);
    `check1(rv[FD_RXUNDER + 2], 1'b1)         // RXUNDER2 sticky
    `check32(intr_w, 8'hf0 & ~8'h40)          // TXNFULL2 deasserted (SPEC-7-12)
    bus_wr(A_FDEBUG, (32'h1 << (FD_TXOVER + 2)) | (32'h1 << (FD_RXUNDER + 2)));
    // W1C cleared both; TXSTALL1 stays set (SM1 still latched at its
    // T3 blocking-PULL stall — sticky until cleared, SPEC-6-7).
    rd_check(A_FDEBUG, 32'h1 << (FD_TXSTALL + 1));

    // ------------------------------------------------------------------
    // T5: IRQ force + W1C over the bus; SM-driven irq set (SPEC-7-6).
    // ------------------------------------------------------------------
    $display("--- T5: IRQ force, W1C, SM3 irq set");
    bus_wr(A_IRQF, 32'h0000_00a5);            // force sets at end of cycle
    rd_check(A_IRQ, 32'ha5);                  // visible next cycle (CC-37)
    bus_wr(A_IRQ, 32'h05);                    // W1C bits 0,2
    rd_check(A_IRQ, 32'ha0);                  // CC-39 clear wins
    `check32(irq_prev_o_w, 8'ha0)             // relay = flag register (CC-38)
    `check32(irq_next_o_w, 8'ha0)
    bus_wr(A_IMEM(0), 32'(E_IRQ(1'b0, 1'b0, IDX_THIS, 3'd3, 5'd0)));
    bus_wr(A_SM(3, 1), 32'h0);                // wrap 0 -> 0
    bus_wr(A_CTRL, 32'h8);                    // SM3 on
    poll_eq(A_IRQ, 32'ha8, 8, ok);            // SM3 sets flag 3 every tick
    `check1(ok, 1'b1)
    `check32(intr_w[15:8], 8'ha8)             // SPEC-7-12 flag byte
    bus_wr(A_CTRL, 32'h0);                    // halt SM3
    `WAIT_CLKS(2)
    bus_wr(A_IRQ, 32'ha8);                    // W1C all
    rd_check(A_IRQ, 32'h0);

    // ------------------------------------------------------------------
    // T6: forced instructions via SMx_INSTR on halted SM0 (SPEC-7-23..25).
    // ------------------------------------------------------------------
    $display("--- T6: SMx_INSTR force, EXEC_STALLED, SM_RESTART");
    bus_wr(A_SM(0, 5), 32'h0400_0000);        // SET_COUNT=1 still in force
    bus_wr(A_SM(0, 4), 32'(E_SET(SETD_PINS, 5'd1, 5'd0))); // forced set pins,1
    wait_gpio(0, 1'b1, 8, ok);                // executes despite SM_ENABLE=0
    `check1(ok, 1'b1)                         // SPEC-7-25 halted-SM force
    bus_wr(A_SM(0, 4), 32'(E_JMP(JC_ALWAYS, 5'd0, 5'd0)));  // forced jmp 0
    poll_eq(A_SM(0, 3), 32'h0, 4, ok);        // PC forced (SDK N2 idiom)
    `check1(ok, 1'b1)
    // SPEC-7-24: readback is imem[pc] — imem[0] now holds T5's irq word.
    rd_check(A_SM(0, 4), 32'(E_IRQ(1'b0, 1'b0, IDX_THIS, 3'd3, 5'd0)));
    bus_wr(A_SM(0, 4), 32'(E_PULL(1'b0, 1'b1, 5'd0)));      // forced pull block
    poll_eq(A_SM(0, 1), 32'h8000_0000 | 32'h0000_1000, 8, ok); // EXEC_STALLED
    `check1(ok, 1'b1)                         // SPEC-7-15: stalled+latched
    bus_wr(A_TXF(0), 32'hcafe_babe);          // CC-30: releases the force
    poll_eq(A_SM(0, 1), 32'h0000_1000, 8, ok);
    `check1(ok, 1'b1)
    bus_wr(A_SM(0, 4), 32'(E_PULL(1'b0, 1'b1, 5'd0)));      // stall again
    poll_eq(A_SM(0, 1), 32'h8000_0000 | 32'h0000_1000, 8, ok);
    `check1(ok, 1'b1)
    bus_wr(A_CTRL, 32'h10);                   // SM_RESTART[0] (SPEC-7-3)
    poll_eq(A_SM(0, 1), 32'h0000_1000, 8, ok);// drops stalled forced instr
    `check1(ok, 1'b1)

    // ------------------------------------------------------------------
    // T7: RXFx_PUTGET bus access (SPEC-7-13, SPEC-3.7-5, SPEC-6-2/3).
    // ------------------------------------------------------------------
    $display("--- T7: RXFx_PUTGET, SM2");
    bus_wr(A_SM(2, 2), 32'h000c_0000 | 32'h4000);   // FJOIN_RX_GET -> TXGET
    bus_wr(A_PUTGET(2, 1), 32'h1122_3344);    // system write live in GET mode
    rd_check(A_PUTGET(2, 1), 32'h1122_3344);
    bus_wr(A_PUTGET(2, 3), 32'h5566_7788);
    rd_check(A_PUTGET(2, 3), 32'h5566_7788);
    rd_check(A_PUTGET(2, 1), 32'h1122_3344);  // random access
    bus_wr(A_SM(2, 2), 32'h000c_0000 | 32'h8000);   // FJOIN_RX_PUT -> flush
    // Queue state flushes (SPEC-6-2) but the aux storage words persist
    // (C3 semantics: "queue state only").
    rd_check(A_PUTGET(2, 1), 32'h1122_3344);
    bus_wr(A_PUTGET(2, 2), 32'ha5a5_a5a5);    // writes blocked outside GET
    rd_check(A_PUTGET(2, 2), 32'h0);          // SPEC-3.7-5
    bus_wr(A_SM(2, 2), 32'h000c_0000);        // restore reset SHIFTCTRL

    // ------------------------------------------------------------------
    // T8: input path e2e — in pins,32 + push, through sync and bypass.
    // ------------------------------------------------------------------
    $display("--- T8: in pins -> RXF0, sync and bypass");
    bus_wr(A_IMEM(0), 32'(E_IN(INS_PINS, 5'd0, 5'd0)));    // in pins, 32
    bus_wr(A_IMEM(1), 32'(E_PUSH(1'b0, 1'b1, 5'd0)));      // push block
    bus_wr(A_SM(0, 1), 32'h0000_1000);        // wrap 1 -> 0
    bus_wr(A_ISB, 32'h0);                     // full 2-FF sync (SPEC-7-7)
    gpio_in = 32'ha5a5_00ff;
    `WAIT_CLKS(4)                             // sync settled (CC-23: k+2)
    bus_wr(A_CTRL, 32'h1);                    // SM0 on
    poll_eq(A_FSTAT, 32'h0f00_0f00 & ~(32'h1 << FS_RXEMPTY), 8, ok);
    `check1(ok, 1'b1)                         // RX0 non-empty
    bus_wr(A_CTRL, 32'h0);
    drain_rx0(32'ha5a5_00ff);                 // captured through 2-FF sync
    // SM_RESTART drops the stalled push the halt froze (otherwise the
    // re-enable would first push the stale/stale-zeroed ISR — SPEC-7-3),
    // and a forced jmp 0 (SDK N2 idiom) resyncs pc so the next push is
    // preceded by a fresh `in pins`.
    bus_wr(A_CTRL, 32'h10);
    bus_wr(A_SM(0, 4), 32'(E_JMP(JC_ALWAYS, 5'd0, 5'd0)));
    bus_wr(A_ISB, 32'hffff_ffff);             // bypass: 1 clk (SPEC-7-7)
    gpio_in = 32'h0000_ffff;
    `WAIT_CLKS(3)
    bus_wr(A_CTRL, 32'h1);
    poll_eq(A_FSTAT, 32'h0f00_0f00 & ~(32'h1 << FS_RXEMPTY), 8, ok);
    `check1(ok, 1'b1)
    bus_wr(A_CTRL, 32'h0);
    drain_rx0(32'h0000_ffff);
    rd_check(A_ISB, 32'hffff_ffff);           // RW storage readback

    `TB_FINISH
  end

endmodule

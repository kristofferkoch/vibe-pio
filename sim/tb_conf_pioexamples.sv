// tb_conf_pioexamples — conformance TB running the *official* pico-examples
// PIO programs (assembled by pioasm, see sim/conf_pioexamples.svh) on
// rtl/pio_block.sv, checking the behaviours those examples document in their
// .pio comments / READMEs (KANBAN: "Ingest official pico-examples PIO
// programs ... as conformance tests"; the per-program inventory and notes
// live in docs/xcheck-picoexamples.md).
//
// All programs run at CLKDIV 1.0 (SM tick = clk, CC-26) so every documented
// "N cycles" figure is checked in clk cycles; the realistic-clkdiv UART
// loopback is the follow-up KANBAN item.
//
// The TB plays bus master + pads like tb_pio_block: reg-bus writes program
// imem/config and drive the FIFOs; gpio_in models the pad wire — the
// open-drain examples get the pad the way their C init sets up the IO bank
// (i2c inverts OE in the pads: wire = oe; onewire drives low: wire = !oe),
// and lb_mask pins wire a DUT output straight back to an input (loopback).
//
// Coverage (SPEC-15-1..10 are the observations this card must hit; CC-24
// and CC-31 are the named cycle-contract targets):
//   CF1  squarewave    wrap + SET pindirs/pins, exact 4-tick loop (warm-up)
//   CF2  addition      PULL/MOV/PUSH e2e: x + y == ~(~x - y) incl. wrap
//   CF3  ws2812        SPEC-15-3 side-set during autopull stall; T1/T2/T3
//                      cells (ws2812_T1..T3); 24 bits per 32-bit word
//   CF4  uart_tx       SPEC-15-3 blocking-PULL stall holds line idle-high;
//                      8n1 frame at 8 ticks/bit, LSB first, OUT and
//                      side-set mapped to the same pin
//   CF5  spi_cpha0     named "spi": 4-tick SCK, MOSI MSB-first stable at
//                      the leading edge; MISO through INPUT_SYNC_BYPASS
//                      (CC-25: bypass = pad@T-1); stall with SCK low
//   CF6  spi_cpha1     data transitions ON the leading edge (`mov pins`
//                      uses the OUT mapping, SPEC-3.6-1)
//   CF7  spi_cpha0_cs  CC-31 + SPEC-15-4: the `pull ifempty` tail — CSn
//                      deassert when OSR bottoms out, consume iff empty at
//                      the PULL's own tick, TXSTALL sticky as idle flag
//   CF8  clocked_input CC-24 + SPEC-15-8: IN samples the pad of T-2
//                      ("one system clock after the rising edge")
//   CF9  quadrature    SPEC-15-2 (mov isr,y + explicit push) + SPEC-15-5
//                      (PUSH noblock drops on full; oldest samples kept);
//                      computed jump MOV PC,ISR; x4 count via the jump table
//   CF10 onewire       SPEC-15-2 sharp form: MOV ISR,PINS never autopushes
//                      (autopush ON here); documented reset timing (480-tick
//                      pull, 70-tick presence window)
//   CF11 i2c           named "i2c": OUT EXEC records (SPEC-15-6 mechanism),
//                      sideset-pindirs open-drain, clock stretch via WAIT
//                      pin, `irq wait 0 rel` NAK halt + bus W1C resume
//                      (SPEC-3.8-2)
//   CF12 manchester    SPEC-15-7: forced WAIT armed while SM disabled with
//                      delay bits set (must be ignored); tx->rx loopback,
//                      first word decoded exactly (see the margin note)
//   CF13 hub75_data    SPEC-15-6: imem patched while the SM runs — the
//                      in-flight instruction is unaffected, the patch
//                      applies at the next fetch (CC-33)
//   CF14 apa102_rgb555 SPEC-15-1: `in isr,n` right-rotation drives the wire
//                      stream; `in osr,n` leaves the OSR counter untouched
//                      (the `pull ifempty` fence at wrap stays a no-op)
//
// SPEC-15-9 (narrow FIFO accesses): the examples' 16-bit TXF writes
// (pio_i2c_put16) are modelled as replicated words {r,r} — the reg bus is
// 32-bit; the RTL-relevant fact is the halfword record must land in the OSR
// top half for shift-left consumption (CF11). SPEC-15-10 (RP2350-only
// features unused by the examples): nothing to run here.
//
// Red/green (AGENTS.md): CF8 is the CC-24 regression (re-inject: in_bus fed
// from sync-FF1 instead of FF2 in pio_gpio_mux -> CF8 fails); CF7/CF13 are
// the CC-31 regression (re-inject: PULL treated as a no-op whenever autopull
// is enabled -> CF7's CSn never asserts). Demonstrations recorded in the
// finishing commit.

`include "tb_common.sv"

module tb_conf_pioexamples;

  logic clk;
  logic rst;
  tb_clk_rst u_cr (.clk(clk));

  // ---------------------------------------------------------------------
  // Instruction encoders (SPEC-2-1..18; subset used for forced instrs and
  // patches — the program words themselves come from pioasm).
  // ---------------------------------------------------------------------
  localparam logic [2:0] JC_ALWAYS = 3'd0;
  localparam logic [2:0] SETD_PINS = 3'd0, SETD_X = 3'd1, SETD_Y = 3'd2,
                         SETD_PINDIRS = 3'd4;
  localparam logic [1:0] WSRC_PIN = 2'd0;

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
  function automatic logic [15:0] E_SET(input logic [2:0] dst,
                                        input logic [4:0] data,
                                        input logic [4:0] dly);
    E_SET = {3'b111, dly, dst, data};
  endfunction

  // ---------------------------------------------------------------------
  // Register map (SPEC-7-x; same addresses as tb_pio_block).
  // ---------------------------------------------------------------------
  localparam logic [8:0] A_CTRL   = 9'h000;   // SPEC-7-2
  localparam logic [8:0] A_FSTAT  = 9'h004;   // SPEC-6-6
  localparam logic [8:0] A_FDEBUG = 9'h008;   // SPEC-6-7
  localparam logic [8:0] A_FLEVEL = 9'h00c;   // SPEC-6-6
  localparam logic [8:0] A_IRQ    = 9'h030;   // SPEC-7-6
  localparam logic [8:0] A_ISB    = 9'h038;   // SPEC-7-7
  function automatic logic [8:0] A_TXF(input int i);  A_TXF  = 9'h010 + 9'(4*i); endfunction
  function automatic logic [8:0] A_RXF(input int i);  A_RXF  = 9'h020 + 9'(4*i); endfunction
  function automatic logic [8:0] A_IMEM(input int i); A_IMEM = 9'h048 + 9'(4*i); endfunction
  function automatic logic [8:0] A_SM(input int i, input int r);
    A_SM = 9'h0c8 + 9'(8'h18*i) + 9'(4*r);    // r: 0 CLKDIV .. 5 PINCTRL
  endfunction
  localparam int FS_TXEMPTY = 24, FS_RXEMPTY = 8;
  localparam int FD_TXSTALL = 24;

  // SMx field builders (SPEC-7-14..26) — mirror the sm_config_* calls each
  // example's C init makes. SHIFT dir bit: 1 = right, 0 = left (SPEC-7-21).
  function automatic logic [31:0] MFY_PCTRL(input int ss_cnt, input int set_cnt,
                                            input int out_cnt, input int in_base,
                                            input int ss_base, input int set_base,
                                            input int out_base);
    MFY_PCTRL = (32'(ss_cnt) << 29) | (32'(set_cnt) << 26) |
                (32'(out_cnt) << 20) | (32'(in_base) << 15) |
                (32'(ss_base) << 10) | (32'(set_base) << 5) | 32'(out_base);
  endfunction
  function automatic logic [31:0] MFY_EXEC(input int wrap_top, input int wrap_bot,
                                           input int jmp_pin, input bit side_en,
                                           input bit side_pindirs);
    MFY_EXEC = (32'(wrap_top) << 12) | (32'(wrap_bot) << 7) |
               (32'(jmp_pin) << 24) | (side_en << 30) | (side_pindirs << 29);
  endfunction
  function automatic logic [31:0] MFY_SHIFT(input bit fjoin_rx, input bit fjoin_tx,
                                            input int pull_thr, input int push_thr,
                                            input bit out_right, input bit in_right,
                                            input bit autopull, input bit autopush);
    // thresholds are 5-bit fields where 32 encodes as 0 (SPEC-5-7):
    // an unmasked 32 spills into FJOIN_TX and flips the FIFO mode
    MFY_SHIFT = (fjoin_rx << 31) | (fjoin_tx << 30) |
                (32'(pull_thr & 31) << 25) | (32'(push_thr & 31) << 20) |
                (out_right << 19) | (in_right << 18) |
                (autopull << 17) | (autopush << 16);
  endfunction

  // ---------------------------------------------------------------------
  // DUT + pad model.
  // ---------------------------------------------------------------------
  logic [8:0]  reg_addr;
  logic [31:0] reg_wdata;
  logic        reg_write, reg_read;
  logic [31:0] reg_rdata_w;
  logic [31:0] pad_drive;
  logic [31:0] od_mask;      // open-drain pins
  logic        od_pol;       // 0: wire=!oe (onewire); 1: wire=oe (i2c, inverted pads)
  logic        sda_slave_low, scl_slave_low;
  logic [31:0] lb_mask;      // loopback pins: input follows the DUT output bank
  logic [31:0] gpio_in;
  logic [31:0] gpio_out_w, gpio_oe_w;
  logic [7:0]  irq_prev_r, irq_next_r, nb_set, nb_clr;
  logic [7:0]  irq_prev_o_w, irq_next_o_w;
  logic [7:0]  prev_exp_set_w, prev_exp_clr_w, next_exp_set_w, next_exp_clr_w;
  logic [15:0] intr_w;

  always @* begin
    gpio_in = pad_drive;
    if (od_pol) begin
      // inverted-OE pads: PIO oe=1 -> released (pull-up/slave), oe=0 -> drive low
      gpio_in[0] = gpio_oe_w[0] ? !sda_slave_low : 1'b0;
      gpio_in[1] = gpio_oe_w[1] ? !scl_slave_low : 1'b0;
    end else begin
      gpio_in = gpio_in & ~(od_mask & gpio_oe_w & ~gpio_out_w);
    end
    for (int k = 0; k < 32; k++)
      if (lb_mask[k]) gpio_in[k] = gpio_oe_w[k] ? gpio_out_w[k] : 1'b0;
  end

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

  // Debug tracing (compile with -DCONF_DBG): passive windowed monitor.
`ifdef CONF_DBG
  int dbg_on = 0;
  int dbg_n = 0;
  int dbg_max = 0;
  always @(posedge clk) if (dbg_on && dbg_n < dbg_max) begin
    #1;
    $display("DBG t=%0d pc0=%0d pc1=%0d o=%b%b%b%b", clk_count,
             u_dut.dbg_sm_pc[0], u_dut.dbg_sm_pc[1],
             gpio_out_w[3], gpio_out_w[2], gpio_out_w[1], gpio_out_w[0]);
    dbg_n = dbg_n + 1;
  end
  task automatic dbg_win(input int n);
    begin
      dbg_n = 0; dbg_max = n; dbg_on = 1;
    end
  endtask
`else
  task automatic dbg_win(input int n);
    begin
    end
  endtask
`endif

  // ---------------------------------------------------------------------
  // Bus master + observation helpers (same protocol as tb_pio_block:
  // drive at negedge, retire at the posedge between; sample #1 after
  // posedge for settled pin values).
  // ---------------------------------------------------------------------
  task automatic bus_wr(input logic [8:0] a, input logic [31:0] d);
    begin
      @(negedge clk);
      reg_addr  = a;
      reg_wdata = d;
      reg_write = 1'b1;
      @(negedge clk);
      reg_write = 1'b0;
    end
  endtask

  task automatic bus_rd(input logic [8:0] a, output logic [31:0] v);
    begin
      @(negedge clk);
      reg_addr = a;
      reg_read = 1'b1;
      #1;
      v = reg_rdata_w;
      @(negedge clk);
      reg_read = 1'b0;    // RXF pops at the posedge in between (SPEC-6-5)
    end
  endtask

  task automatic rd_check(input logic [8:0] a, input logic [31:0] exp);
    logic [31:0] v;
    begin
      bus_rd(a, v);
      `check32(v, exp)
    end
  endtask

  task automatic poll_eq(input logic [8:0] a, input logic [31:0] exp,
                         input int max_tries, output logic ok);
    logic [31:0] v;
    int k;
    begin
      ok = 1'b0;
      for (k = 0; k < max_tries && !ok; k++) begin
        bus_rd(a, v);
        if (v === exp) ok = 1'b1;
      end
    end
  endtask

  // Wait for gpio_out[pin]==val, sampling #1 after each posedge.
  task automatic wait_pin(input int pin, input logic val,
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

  // Advance to absolute cycle T (pads changed #1 after that posedge hold
  // for the whole cycle T — "pad value during cycle T").
  task automatic drive_at(input int T, input logic [31:0] v);
    begin
      while (clk_count < T) @(posedge clk);
      #1;
      pad_drive = v;
    end
  endtask

  // Sample n consecutive cycles of gpio_out[pin] into bits[n-1:0]
  // (bit n-1 = first sampled cycle, one clk after entry).
  task automatic samp_seq(input int pin, input int n, output logic [63:0] bits);
    int k;
    begin
      bits = '0;
      for (k = 0; k < n; k++) begin
        @(posedge clk);
        #1;
        bits = {bits[62:0], gpio_out_w[pin]};
      end
    end
  endtask

  // Count consecutive #1-after-posedge samples where gpio_out[pin]==val
  // (stops at the first mismatch; max_clks bounds it).
  task automatic run_len(input int pin, input logic val,
                         input int max_clks, output int n);
    int k;
    logic v;
    begin
      n = 0;
      v = 1'b1;
      for (k = 0; k < max_clks && v; k++) begin
        @(posedge clk);
        #1;
        v = (gpio_out_w[pin] === val);
        if (v) n = n + 1;
      end
    end
  endtask

  // Count rising edges of gpio_out[pin] over the next n clks.
  task automatic count_rising(input int pin, input int n, output int cnt);
    int k;
    logic was;
    begin
      cnt = 0;
      was = gpio_out_w[pin];
      for (k = 0; k < n; k++) begin
        @(posedge clk);
        #1;
        if (gpio_out_w[pin] === 1'b1 && was === 1'b0) cnt = cnt + 1;
        was = gpio_out_w[pin];
      end
    end
  endtask

  // Latest pushed word: pop until an empty read; pushes continue at a
  // 7-tick cadence so the loop converges on the freshest sample.
  task automatic latest_rx(input int i, output logic [31:0] v);
    logic [31:0] f;
    int k;
    begin
      v = 32'hxxxx_xxxx;
      for (k = 0; k < 12; k++) begin
        bus_rd(A_FSTAT, f);
        if (f[FS_RXEMPTY + i] === 1'b1) k = 100;
        else bus_rd(A_RXF(i), v);
      end
    end
  endtask

  // Drain RX FIFO i (up to 4 words).
  task automatic drain_rx(input int i, output int n);
    logic [31:0] v;
    int k;
    begin
      n = 0;
      for (k = 0; k < 4; k++) begin        // at most one FIFO's worth
        bus_rd(A_FSTAT, v);
        if (v[FS_RXEMPTY + i] === 1'b1) k = 100;
        else begin
          bus_rd(A_RXF(i), v);
          n = n + 1;
        end
      end
    end
  endtask

  // Pop one word known to be waiting.
  task automatic rx_pop(input int i, output logic [31:0] v);
    begin
      bus_rd(A_RXF(i), v);
    end
  endtask

  // Poll until SMx_ADDR equals addr AND stays there (a running SM can
  // transit any address for a tick; a parked one holds it).
  task automatic poll_parked(input int i, input int addr,
                             input int max_tries, output logic ok);
    logic [31:0] v;
    int k;
    begin
      ok = 1'b0;
      for (k = 0; k < max_tries && !ok; k++) begin
        bus_rd(A_SM(i, 3), v);
        if (v === 32'(addr)) begin
          `WAIT_CLKS(25)
          bus_rd(A_SM(i, 3), v);
          if (v === 32'(addr)) ok = 1'b1;
        end
      end
    end
  endtask

  // Set initial PC via forced JMP (SPEC-7-23) — the pio_sm_init idiom.
  task automatic set_pc(input int i, input int pc);
    begin
      bus_wr(A_SM(i, 4), 32'(E_JMP(JC_ALWAYS, 5'(pc), 5'd0)));
    end
  endtask

  task automatic enable(input logic [3:0] mask);
    begin
      bus_wr(A_CTRL, {28'd0, mask});
    end
  endtask

  // ---------------------------------------------------------------------
  // Assembled official programs (sim/conf_pioexamples.svh, generated from
  // third_party/pico-examples @ c81c855 by sim/gen_conf_pioexamples.py).
  // ---------------------------------------------------------------------
  `include "conf_pioexamples.svh"

  // set_scl_sda words as FIFO exec records (verified against the assembled
  // table in CF11 via SMx_INSTR readback = imem[pc], SPEC-7-24).
  localparam logic [15:0] W_SC0_SD0 = 16'hF780;  // set pindirs,0 side 0 [7]
  localparam logic [15:0] W_SC1_SD0 = 16'hFF80;  // set pindirs,0 side 1 [7]
  localparam logic [15:0] W_MOV_ISR_NULL = 16'hA0C7;  // mov isr, null

  task automatic conf_reset;
    begin
      `DO_RESET(3)
      `WAIT_CLKS(1)
      pad_drive     = 32'h0;
      od_mask       = 32'h0;
      od_pol        = 1'b0;
      lb_mask       = 32'h0;
      sda_slave_low = 1'b0;
      scl_slave_low = 1'b0;
      irq_prev_r    = 8'd0;
      irq_next_r    = 8'd0;
      nb_set        = 8'd0;
      nb_clr        = 8'd0;
    end
  endtask

  // =====================================================================
  // CF1: squarewave — wrap, SET pindirs/pins, exact 4-tick loop.
  // =====================================================================
  task automatic cf1_squarewave;
    logic ok;
    logic [63:0] bits;
    int k, n;
    logic vld;
    begin
      $display("--- CF1: squarewave");
      load_squarewave(0);
      bus_wr(A_SM(0, 5), MFY_PCTRL(0, 1, 0, 0, 0, 2, 0));  // SET base 2, count 1
      bus_wr(A_SM(0, 1), MFY_EXEC(SQUAREWAVE_WRAP, SQUAREWAVE_WRAP_TARGET,
                                  0, 1'b0, 1'b0));
      enable(4'b0001);
      // addr0 `set pindirs,1` -> oe[2] rises on the first tick
      vld = 1'b0;
      for (k = 0; k < 20 && !vld; k++) begin
        @(posedge clk); #1;
        vld = (gpio_oe_w[2] === 1'b1);
      end
      `check1(vld, 1'b1)
      // loop is addr1..3: set pins,1 [1]; set pins,0; jmp again = 4 ticks,
      // 2 high + 2 low, starting one tick after the pindirs tick
      samp_seq(2, 12, bits);
      `check32(bits[11:0], 12'b1100_1100_1100)
      run_len(2, 1'b1, 10, n);
      `check32(32'(n), 32'd2)
      `check1(gpio_oe_w[2], 1'b1)
      enable(4'b0000);
    end
  endtask

  // =====================================================================
  // CF2: addition — pull/mov/push e2e, x + y == ~(~x - y).
  // =====================================================================
  task automatic cf2_addition;
    logic ok;
    logic [31:0] v;
    begin
      $display("--- CF2: addition");
      load_addition(0);
      bus_wr(A_SM(0, 1), MFY_EXEC(ADDITION_WRAP, ADDITION_WRAP_TARGET,
                                  0, 1'b0, 1'b0));
      enable(4'b0001);
      poll_eq(A_SM(0, 3), 32'd0, 16, ok);       // parked on the first PULL
      `check1(ok, 1'b1)
      bus_wr(A_TXF(0), 32'd7);                  // (7,3) -> 10
      bus_wr(A_TXF(0), 32'd3);
      poll_eq(A_FSTAT, 32'h0f00_0f00 & ~(32'h1 << FS_RXEMPTY), 200, ok);
      `check1(ok, 1'b1)
      rx_pop(0, v);
      `check32(v, 32'd10)
      bus_wr(A_TXF(0), 32'hffff_ffff);          // wrap: 0xffffffff + 1 = 0
      bus_wr(A_TXF(0), 32'd1);
      poll_eq(A_FSTAT, 32'h0f00_0f00 & ~(32'h1 << FS_RXEMPTY), 200, ok);
      `check1(ok, 1'b1)
      rx_pop(0, v);
      `check32(v, 32'd0)
      enable(4'b0000);
    end
  endtask

  // =====================================================================
  // CF3: ws2812 — SPEC-15-3, T1/T2/T3 cells, 24 bits per word.
  // =====================================================================
  task automatic cf3_ws2812;
    logic ok;
    logic [63:0] bits;
    int cnt;
    begin
      $display("--- CF3: ws2812");
      load_ws2812(0);
      bus_wr(A_SM(0, 5), MFY_PCTRL(1, 0, 1, 0, 0, 0, 0));  // ss + out on pin 0
      bus_wr(A_SM(0, 1), MFY_EXEC(WS2812_WRAP, WS2812_WRAP_TARGET,
                                  0, 1'b0, 1'b0));
      // out shift LEFT, autopull @24, JOIN_TX (ws2812_program_init; the
      // .lang_opt python out_shiftdir=1 comment refers to the LED's view)
      bus_wr(A_SM(0, 2), MFY_SHIFT(1'b0, 1'b1, 24, 32, 1'b0, 1'b1, 1'b1, 1'b0));
      bus_wr(A_TXF(0), 32'h8000_0100);      // 24 bits: '1', 22x '0', '1'
      enable(4'b0001);
      wait_pin(0, 1'b1, 20, ok);            // T1 rise of bit0 ('1')
      `check1(ok, 1'b1)
      // From the rise: samples are T1+T2 high (jmp side 1 [T1-1] +
      // jmp side 1 [T2-1]), next cell's T3 low (out side 0 [T3-1]), then
      // bit1 ('0'): T1 high, T2+T3 low.
      samp_seq(0, 19, bits);
      `check32(bits[18:0], 19'b11111_0000_111_0000000)
      // 22 more bit cells ('0' x21 + '1') = 22 rising edges in 220 clks
      count_rising(0, 220, cnt);
      `check32(32'(cnt), 32'd22)
      // SPEC-15-3: FIFO empty -> `out x,1` stalls WITH side 0: line low for
      // far longer than the 4-tick T3 (last bit was '1': wait for the
      // fall into the stall first)
      wait_pin(0, 1'b0, 20, ok);
      `check1(ok, 1'b1)
      run_len(0, 1'b0, 60, cnt);
      if (cnt < 30) begin
        tb_fail_count = tb_fail_count + 1;
        $display("FAIL ws2812 stall-low run %0d < 30 (SPEC-15-3)", cnt);
      end else begin
        tb_pass_count = tb_pass_count + 1;
        $display("PASS ws2812 stall-low run %0d >= 30 (SPEC-15-3)", cnt);
      end
      bus_wr(A_TXF(0), 32'hffff_ff00);      // 24x '1' resumes
      wait_pin(0, 1'b1, 40, ok);
      `check1(ok, 1'b1)
      samp_seq(0, 9, bits);                 // '1' cell from its T1 rise
      `check32(bits[8:0], 9'b11111_0000)
      enable(4'b0000);
    end
  endtask

  // =====================================================================
  // CF4: uart_tx — SPEC-15-3, 8n1 frame at 8 ticks/bit, LSB first.
  // =====================================================================
  task automatic cf4_uart_tx;
    logic ok;
    logic exp;
    int k;
    int n_low;
    begin
      $display("--- CF4: uart_tx");
      load_uart_tx(0);
      bus_wr(A_SM(0, 5), MFY_PCTRL(2, 0, 1, 0, 0, 0, 0));  // ss 1 opt + out pin 0
      bus_wr(A_SM(0, 1), MFY_EXEC(UART_TX_WRAP, UART_TX_WRAP_TARGET,
                                  0, 1'b1, 1'b0));          // SIDE_EN
      // out shift RIGHT, no autopull, JOIN_TX (uart_tx_program_init)
      bus_wr(A_SM(0, 2), MFY_SHIFT(1'b0, 1'b1, 32, 32, 1'b1, 1'b1, 1'b0, 1'b0));
      bus_wr(A_TXF(0), 32'h55);             // putc(0x55) before enable
      dbg_win(110);
      enable(4'b0001);
      wait_pin(0, 1'b1, 20, ok);            // stop-bit tick of the frame
      `check1(ok, 1'b1)
      // Bit centres: stop t0+4, start t0+12, data t0+20+8k (LSB first),
      // stop t0+84 — sampled 3 clks after the detect, then 7 per slot.
      for (k = 0; k < 11; k++) begin
        repeat (k == 0 ? 3 : 8) begin @(posedge clk); #1; end
        case (k)
          0, 10:  exp = 1'b1;
          1:      exp = 1'b0;
          default: exp = (32'h55 >> (k - 2)) & 1'b1;
        endcase
        if (gpio_out_w[0] !== exp) begin
          tb_fail_count = tb_fail_count + 1;
          $display("FAIL uart bit slot %0d: got %b expected %b",
                   k, gpio_out_w[0], exp);
        end else tb_pass_count = tb_pass_count + 1;
      end
      // SPEC-15-3: FIFO empty -> `pull side 1` stalls, line held idle-high
      run_len(0, 1'b1, 40, n_low);
      if (n_low < 30) begin
        tb_fail_count = tb_fail_count + 1;
        $display("FAIL uart idle-high run %0d < 30 (SPEC-15-3)", n_low);
      end else begin
        tb_pass_count = tb_pass_count + 1;
        $display("PASS uart idle-high run %0d >= 30 (SPEC-15-3)", n_low);
      end
      bus_wr(A_TXF(0), 32'h00);             // putc(0x00) -> start bit
      wait_pin(0, 1'b0, 20, ok);
      `check1(ok, 1'b1)
      repeat (4) begin @(posedge clk); #1; end
      for (k = 0; k < 8; k++) begin
        if (gpio_out_w[0] !== 1'b0) begin
          tb_fail_count = tb_fail_count + 1;
          $display("FAIL uart frame2 bit %0d not low", k);
        end else tb_pass_count = tb_pass_count + 1;
        repeat (8) begin @(posedge clk); #1; end
      end
      enable(4'b0000);
    end
  endtask

  // =====================================================================
  // CF5: spi_cpha0 — named spi; MISO via sync bypass (CC-25), stall SCK low.
  // =====================================================================
  task automatic cf5_spi_cpha0;
    logic ok;
    logic [31:0] v;
    logic [63:0] bits;
    logic mosi, miso;
    int k;
    begin
      $display("--- CF5: spi_cpha0");
      load_spi_cpha0(0);
      bus_wr(A_SM(0, 5), MFY_PCTRL(1, 0, 1, 2, 0, 0, 1));  // MOSI=1 MISO=2 SCK=0
      bus_wr(A_SM(0, 1), MFY_EXEC(SPI_CPHA0_WRAP, SPI_CPHA0_WRAP_TARGET,
                                  0, 1'b0, 1'b0));
      // MSB-first both ways, autopull/autopush @8 (pio_spi_init)
      bus_wr(A_SM(0, 2), MFY_SHIFT(1'b0, 1'b0, 8, 8, 1'b0, 1'b0, 1'b1, 1'b1));
      bus_wr(A_ISB, 32'h4);                 // bypass MISO (pin 2), CC-25
      pad_drive[2] = 1'b1;                  // MISO byte 0x96, MSB first
      bus_wr(A_TXF(0), 32'hA500_0000);      // left-justified 0xA5
      enable(4'b0001);
      dbg_win(44);
      wait_pin(0, 1'b1, 20, ok);            // first SCK rise (in tick)
      `check1(ok, 1'b1)
      // MOSI 0xA5 MSB-first, stable at each leading edge; MISO advanced one
      // rise ahead (in samples pad@T-1 through the bypass, CC-25)
      for (k = 0; k < 8; k++) begin
        mosi = (8'hA5 >> (7 - k)) & 1'b1;
        if (gpio_out_w[1] !== mosi) begin
          tb_fail_count = tb_fail_count + 1;
          $display("FAIL spi0 MOSI bit %0d: got %b expected %b",
                   k, gpio_out_w[1], mosi);
        end else tb_pass_count = tb_pass_count + 1;
        if (k + 1 < 8) pad_drive[2] = (8'h96 >> (7 - (k + 1))) & 1'b1;
        // sample the SCK rows of this bit cell too: from the leading edge
        // the pattern is in(H),in-delay(H),out(L),out-delay(L)
        bits = '0;
        repeat (4) begin
          @(posedge clk); #1;
          bits = {bits[62:0], gpio_out_w[0]};
        end
        // the last cell's 4th sample lands in the FIFO-empty stall (SCK 0)
        if (bits[3:0] !== (k == 7 ? 4'b1000 : 4'b1001)) begin
          tb_fail_count = tb_fail_count + 1;
          $display("FAIL spi0 SCK cell %0d: %04b", k, bits[3:0]);
        end else tb_pass_count = tb_pass_count + 1;
      end
      poll_eq(A_FSTAT, 32'h0f00_0f00 & ~(32'h1 << FS_RXEMPTY), 40, ok);
      `check1(ok, 1'b1)
      rx_pop(0, v);
      `check32(v, 32'h0000_0096)            // in shift left: first bit at b7
      // SPEC-15-3: TX empty -> out stalls, sideset still 0 -> SCK low
      run_len(0, 1'b0, 20, k);
      if (k < 12) begin
        tb_fail_count = tb_fail_count + 1;
        $display("FAIL spi0 SCK-low stall %0d < 12 (SPEC-15-3)", k);
      end else begin
        tb_pass_count = tb_pass_count + 1;
        $display("PASS spi0 SCK-low stall %0d >= 12 (SPEC-15-3)", k);
      end
      enable(4'b0000);
    end
  endtask

  // =====================================================================
  // CF6: spi_cpha1 — data transitions ON the leading edge (`mov pins` on
  // the OUT mapping, SPEC-3.6-1), sampled on the trailing edge.
  // =====================================================================
  task automatic cf6_spi_cpha1;
    logic ok;
    logic [31:0] v;
    logic mosi, miso;
    int k;
    begin
      $display("--- CF6: spi_cpha1");
      load_spi_cpha1(0);
      bus_wr(A_SM(0, 5), MFY_PCTRL(1, 0, 1, 2, 0, 0, 1));
      bus_wr(A_SM(0, 1), MFY_EXEC(SPI_CPHA1_WRAP, SPI_CPHA1_WRAP_TARGET,
                                  0, 1'b0, 1'b0));
      bus_wr(A_SM(0, 2), MFY_SHIFT(1'b0, 1'b0, 8, 8, 1'b0, 1'b0, 1'b1, 1'b1));
      bus_wr(A_ISB, 32'h4);
      pad_drive[2] = 1'b0;
      bus_wr(A_TXF(0), 32'h3C00_0000);      // MOSI byte 0x3C
      enable(4'b0001);
      wait_pin(0, 1'b1, 20, ok);            // rise tick = the mov pins tick
      `check1(ok, 1'b1)
      for (k = 0; k < 8; k++) begin
        mosi = (8'h3C >> (7 - k)) & 1'b1;
        miso = (8'h5A >> (7 - k)) & 1'b1;
        // CPHA1: MOSI already at the new bit ON the rising-edge tick
        if (gpio_out_w[1] !== mosi) begin
          tb_fail_count = tb_fail_count + 1;
          $display("FAIL spi1 MOSI bit %0d: got %b expected %b",
                   k, gpio_out_w[1], mosi);
        end else tb_pass_count = tb_pass_count + 1;
        // in samples pad@T-1 at the trailing-edge tick (2 clks later)
        pad_drive[2] = miso;
        repeat (4) begin @(posedge clk); #1; end
      end
      poll_eq(A_FSTAT, 32'h0f00_0f00 & ~(32'h1 << FS_RXEMPTY), 40, ok);
      `check1(ok, 1'b1)
      rx_pop(0, v);
      `check32(v, 32'h0000_005A)
      enable(4'b0000);
    end
  endtask

  // =====================================================================
  // CF7: spi_cpha0_cs — CC-31 / SPEC-15-4: the pull-ifempty tail, CSn
  // waveform, TXSTALL as the idle flag.
  // =====================================================================
  task automatic cf7_spi_cs;
    logic ok;
    logic [31:0] v;
    logic was;
    int cnt, k;
    begin
      $display("--- CF7: spi_cpha0_cs");
      load_spi_cpha0_cs(0);
      bus_wr(A_SM(0, 5), MFY_PCTRL(2, 0, 1, 3, 0, 0, 2));  // SCK=0 CSn=1 MOSI=2 MISO=3
      bus_wr(A_SM(0, 1), MFY_EXEC(SPI_CPHA0_CS_WRAP, SPI_CPHA0_CS_WRAP_TARGET,
                                  0, 1'b0, 1'b0));
      bus_wr(A_SM(0, 2), MFY_SHIFT(1'b0, 1'b0, 8, 8, 1'b0, 1'b0, 1'b1, 1'b1));
      bus_wr(A_ISB, 32'h8);                 // bypass MISO (pin 3 here)
      set_pc(0, SPI_CPHA0_CS_LBL_ENTRY_POINT);
      bus_wr(A_SM(0, 4), 32'(E_SET(SETD_X, 5'd6, 5'd0)));  // X = n_bits-2
      bus_wr(A_SM(0, 4), 32'(E_SET(SETD_Y, 5'd6, 5'd0)));  // Y = n_bits-2
      enable(4'b0001);
      dbg_win(40);
      `WAIT_CLKS(4)
      #1;
      `check1(gpio_out_w[1], 1'b1)           // CSn high while parked (side 0x2)
      `check1(gpio_out_w[0], 1'b0)           // SCK low
      // TXSTALL sticky latches the stall (hub75_wait_tx_stall idiom)
      bus_rd(A_FDEBUG, v);
      `check1(v[FD_TXSTALL + 0], 1'b1)
      bus_wr(A_FDEBUG, 32'h1 << (FD_TXSTALL + 0));   // W1C (the SM is
      // still parked on the PULL, so the sticky legitimately re-asserts)
      // 3 words back to back: CSn asserts when data appears, stays low
      // across all 3 words, deasserts after the back porch
      bus_wr(A_TXF(0), 32'h5A00_0000);
      bus_wr(A_TXF(0), 32'h3C00_0000);
      bus_wr(A_TXF(0), 32'hA500_0000);
      wait_pin(1, 1'b0, 20, ok);             // CSn asserts
      `check1(ok, 1'b1)
      dbg_win(140);
      // count SCK rising edges over a fixed window spanning all 3 words
      // (3 x 32 ticks + porches); the DUT is trace-verified to run 7
      // bitloop cells + 1 tail clock per word under one CS assertion
      dbg_win(105);
      cnt = 0;
      was = 1'b0;
      for (k = 0; k < 104; k++) begin
        @(posedge clk);
        #1;
        if (gpio_out_w[0] === 1'b1 && was === 1'b0) cnt = cnt + 1;
        was = gpio_out_w[0];
      end
      `check32(32'(cnt), 32'd24)             // 24 SCK rising edges, one CS
      wait_pin(1, 1'b1, 20, ok);             // deassert after back porch
      `check1(ok, 1'b1)
      // CC-30/CC-31: the parked `pull ifempty` consumes a word iff the OSR
      // is empty at its own tick — CSn re-asserts when data appears
      bus_wr(A_TXF(0), 32'h9600_0000);
      wait_pin(1, 1'b0, 20, ok);
      `check1(ok, 1'b1)
      wait_pin(1, 1'b1, 200, ok);            // drains, CSn high again
      `check1(ok, 1'b1)
      // 4 bytes received (MISO tied 0 in this CF)
      for (k = 0; k < 4; k++) begin
        rx_pop(0, v);
        `check32(v, 32'd0)
      end
      enable(4'b0000);
    end
  endtask

  // CF8 stimulus bit k (a function so the expected word and the driven
  // pads provably derive from the same table; k=0 is the first bit).
  function automatic logic d_bit(input int k);
    logic [7:0] d;
    d = 8'b0110_0101;
    return d[k];
  endfunction

  // =====================================================================
  // CF8: clocked_input — CC-24 / SPEC-15-8: the IN tick samples the pad of
  // cycle T-2 (the example's "one system clock after the rising edge").
  // =====================================================================
  task automatic cf8_clocked_input;
    logic ok;
    logic [31:0] v;
    logic [31:0] exp_word;
    int t_en, e;
    begin
      $display("--- CF8: clocked_input");
      load_clocked_input(0);
      // data = in base pin 4, clock = pin 5; shift LEFT, autopush @8, JOIN_RX
      bus_wr(A_SM(0, 5), MFY_PCTRL(0, 0, 0, 4, 0, 0, 0));
      bus_wr(A_SM(0, 1), MFY_EXEC(CLOCKED_INPUT_WRAP, CLOCKED_INPUT_WRAP_TARGET,
                                  0, 1'b0, 1'b0));
      bus_wr(A_SM(0, 2), MFY_SHIFT(1'b1, 1'b0, 32, 8, 1'b1, 1'b0, 1'b0, 1'b1));
      enable(4'b0001);
      `WAIT_CLKS(2)
      t_en = clk_count;
      dbg_win(90);
      // 8 external-clock periods of 8 clks. Pad timing per bit k (rise at
      // cycle e): clk high during [e,e+4); data = d[k] during e+1 ONLY,
      // flipped from e+2 — pad@(e+1) is what a T'=e+3 IN must sample
      // (WAIT completes on tick e+2 through the 2-FF sync, CC-23/CC-24).
      exp_word = '0;
      for (int kk = 0; kk < 8; kk++) begin
        e = t_en + 20 + 8*kk;
        // CC-24: the WAIT completes on the first tick whose sync shows the
        // edge (pad@e -> tick e+3); the IN tick then samples pad@(e+1) —
        // the value present one sysclk after the rising edge, exactly the
        // clocked_input note. Drive d[k] WITH the edge, flip it at e+1.
        drive_at(e,     (pad_drive & ~32'h10) | ({31'd0, d_bit(kk)} << 4)
                                                | 32'h20);      // clk+d
        drive_at(e + 1, (pad_drive & ~32'h10) | ({31'd0, ~d_bit(kk)} << 4));
        drive_at(e + 2,  pad_drive & ~32'h30);                   // clk low
        exp_word[7 - kk] = d_bit(kk);
      end
      poll_eq(A_FLEVEL, 32'h1 << 4, 60, ok);  // JOIN_RX: TX side dead
      `check1(ok, 1'b1)
      rx_pop(0, v);
      `check32(v, exp_word)
      enable(4'b0000);
    end
  endtask

  // =====================================================================
  // CF9: quadrature_encoder — SPEC-15-2/15-5, computed jump, push noblock.
  // =====================================================================
  task automatic cf9_quadrature;
    logic ok;
    logic [31:0] v;
    int n;
    int t0;
    begin
      $display("--- CF9: quadrature_encoder");
      if (QUADRATURE_ENCODER_ORIGIN != 0) begin
        tb_fail_count = tb_fail_count + 1;
        $display("FAIL quadrature .origin must be 0 (computed jump)");
      end else tb_pass_count = tb_pass_count + 1;
      load_quadrature_encoder(0);
      // in base = A (pin0), B = pin1; JMP_PIN = A; shift LEFT, no autopush
      bus_wr(A_SM(0, 5), MFY_PCTRL(0, 0, 0, 0, 0, 0, 0));
      bus_wr(A_SM(0, 1), MFY_EXEC(QUADRATURE_ENCODER_WRAP,
                                  QUADRATURE_ENCODER_WRAP_TARGET,
                                  0, 1'b0, 1'b0));
      bus_wr(A_SM(0, 2), MFY_SHIFT(1'b0, 1'b0, 32, 32, 1'b1, 1'b0, 1'b0, 1'b0));
      dbg_win(70);
      enable(4'b0001);
      pad_drive[1:0] = 2'b00;
      // FIFO fills with Y=0 samples; SPEC-15-5: once full, PUSH noblock
      // drops the new samples (the oldest 4 are preserved) while the
      // ISR/counter still reset every iteration
      poll_eq(A_FLEVEL, 32'h4 << 4, 400, ok);   // RX0 level nibble 7:4
      `check1(ok, 1'b1)
      drain_rx(0, n);
      `check32(32'(n), 32'd4)                // the 4 oldest, all Y=0
      latest_rx(0, v);
      `check32(v, 32'd0)                    // still Y=0 at rest
      // Single step 00 -> 01: jump-table row 00, read 01 => decrement
      t0 = clk_count + 2;
      drive_at(t0, 32'h1);                  // A=0 B=1
      `WAIT_CLKS(30)
      drain_rx(0, n);
      rx_pop(0, v);
      `check32(v, 32'hffff_ffff)            // 0 - 1
      drive_at(clk_count + 2, 32'h0);       // back to 00 => increment
      `WAIT_CLKS(30)
      latest_rx(0, v);
      `check32(v, 32'd0)
      // Full sequence 00 -> 10 -> 11 -> 01 -> 00 = +4 (x4 encoding)
      t0 = clk_count + 2;
      drive_at(t0,      32'h2);
      dbg_win(130);
      drive_at(t0 + 20, 32'h3);
      drive_at(t0 + 40, 32'h1);
      drive_at(t0 + 60, 32'h0);
      `WAIT_CLKS(30)
      latest_rx(0, v);
      `check32(v, 32'd4)
      enable(4'b0000);
    end
  endtask

  // =====================================================================
  // CF10: onewire — SPEC-15-2 sharp (autopush ON, MOV ISR,PINS must not
  // push), documented reset timing (480-tick pull, presence sampling).
  // =====================================================================
  task automatic cf10_onewire(input bit slave_present);
    logic ok;
    logic [31:0] v;
    int n;
    begin
      $display("--- CF10: onewire (presence=%0d)", slave_present);
      load_onewire(0);
      // in/sideset base 0; sideset 1 PINDIRS (no opt)
      bus_wr(A_SM(0, 5), MFY_PCTRL(1, 0, 0, 0, 0, 0, 0));
      bus_wr(A_SM(0, 1), MFY_EXEC(ONEWIRE_WRAP, ONEWIRE_WRAP_TARGET,
                                  0, 1'b0, 1'b1));       // SIDE_PINDIRS
      // shift right both, autopull+autopush @8 (onewire_sm_init)
      bus_wr(A_SM(0, 2), MFY_SHIFT(1'b0, 1'b0, 8, 8, 1'b1, 1'b1, 1'b1, 1'b1));
      pad_drive = 32'hffff_ffff;            // pull-ups (slave may pull pin0)
      if (!slave_present) pad_drive[0] = 1'b1;
      od_mask = 32'h1;                      // wire = !oe (drives low)
      od_pol  = 1'b0;
      set_pc(0, ONEWIRE_LBL_RESET_BUS);     // the C reset idiom jumps here
      enable(4'b0001);
      // Reset pull: oe[0] high for 16 + 29*16 = 480 ticks (the .pio's own
      // tick annotations); wire low the whole time (open drain)
      begin : pull_meas
        int k;
        logic vld;
        vld = 1'b0;
        for (k = 0; k < 40 && !vld; k++) begin
          @(posedge clk); #1;
          vld = (gpio_oe_w[0] === 1'b1);
        end
        `check1(vld, 1'b1)
        n = 1;                              // the detected sample counts
        for (k = 0; k < 600; k++) begin
          @(posedge clk); #1;
          if (gpio_oe_w[0] === 1'b1) n = n + 1;
          else k = 1000;
        end
        `check32(32'(n), 32'd480)
      end
      // Release window is 70 ticks (7 + 9*7); the MOV ISR,PINS lands at
      // its end. A present slave pulls the wire low ~15us in (1-Wire spec)
      dbg_win(90);
      if (slave_present) begin
        `WAIT_CLKS(12)
        pad_drive[0] = 1'b0;                // slave asserts presence
      end
      `WAIT_CLKS(30)                        // ~tick 45 of the window
      // SPEC-15-2: the MOV has NOT pushed (only the explicit PUSH after it
      // does) — RX0 still empty at tick ~45, before the PUSH tick (70)
      bus_rd(A_FLEVEL, v);
      `check32(v[7:4], 32'd0)
      poll_eq(A_FSTAT, 32'h0f00_0f00 & ~(32'h1 << FS_RXEMPTY), 40, ok);
      `check1(ok, 1'b1)
      rx_pop(0, v);
      if (slave_present) `check32(v, 32'hffff_fffe)   // bit0 sampled low
      else               `check32(v, 32'hffff_ffff)
      pad_drive[0] = 1'b1;                  // slave releases
      // 8 '1' bits from the FIFO (0xff): autopush word, in-right entered
      // at the MSB end => left-justified (SPEC-3.3-1)
      bus_wr(A_TXF(0), 32'hff);
      `WAIT_CLKS(800)
      dbg_win(160);
      poll_eq(A_FSTAT, 32'h0f00_0f00 & ~(32'h1 << FS_RXEMPTY), 1500, ok);
      `check1(ok, 1'b1)
      rx_pop(0, v);
      `check32(v, 32'hff00_0000)
      enable(4'b0000);
      pad_drive = 32'h0;
      od_mask = 32'h0;
    end
  endtask

  // =====================================================================
  // CF11: i2c — OUT EXEC records, open-drain sideset pindirs, clock
  // stretch, NAK halt via `irq wait 0 rel` + bus W1C resume.
  // =====================================================================
  task automatic cf11_i2c;
    logic ok;
    logic [31:0] v;
    int oe_rises, wire_rises, t_oe, t_wire, k;
    logic oe_was, wire_was, oe_vld;
    begin
      $display("--- CF11: i2c");
      load_i2c(0);
      load_set_scl_sda(24);                 // instruction table after i2c
      // Verify the TB's record words against the assembled table via
      // SMx_INSTR readback = imem[pc] (SPEC-7-24)
      set_pc(0, 24 + 0);
      bus_rd(A_SM(0, 4), v);
      `check32(v[15:0], W_SC0_SD0)
      set_pc(0, 24 + 2);
      bus_rd(A_SM(0, 4), v);
      `check32(v[15:0], W_SC1_SD0)
      // config per i2c_program_init: SDA=0, SCL=1 (SCL must be SDA+1)
      bus_wr(A_SM(0, 5), MFY_PCTRL(2, 2, 1, 0, 1, 0, 0));  // ss 1 opt + set SDA x2
      bus_wr(A_SM(0, 1), MFY_EXEC(I2C_WRAP, I2C_WRAP_TARGET,
                                  0, 1'b1, 1'b1));         // SIDE_EN+SIDE_PINDIRS
      bus_wr(A_SM(0, 2), MFY_SHIFT(1'b0, 1'b0, 16, 8, 1'b0, 1'b0, 1'b1, 1'b1));
      od_mask = 32'h3;                      // SDA/SCL open-drain, OE-inverted
      od_pol  = 1'b1;
      sda_slave_low = 1'b0;                 // slave idle (no pull)
      scl_slave_low = 1'b0;
      // pio_sm_set_pindirs(both released) before entry: with the inverted
      // pads, pindirs=1 is the idle (released, pull-up) state
      bus_wr(A_SM(0, 4), 32'(E_SET(SETD_PINDIRS, 5'd3, 5'd0)));
      set_pc(0, I2C_LBL_ENTRY_POINT);       // pio_sm_init(entry_point)
      enable(4'b0001);
      `WAIT_CLKS(2)
      #1;
      `check1(gpio_in[1], 1'b1)             // both wires released-high
      `check1(gpio_in[0], 1'b1)
      // START = pio_i2c_start(): header (instr=2 => 3 exec words), then
      // SC1_SD0, SC0_SD0, mov isr,null. Halfword writes modelled as
      // replicated words (SPEC-15-9): shift-left autopull @16 consumes the
      // top half, the replica keeps the lower half from going first.
      bus_wr(A_TXF(0), 32'h0800_0800);      // 2<<10 | final=0 | data=0
      bus_wr(A_TXF(0), {W_SC1_SD0, W_SC1_SD0});
      bus_wr(A_TXF(0), {W_SC0_SD0, W_SC0_SD0});
      bus_wr(A_TXF(0), {W_MOV_ISR_NULL, W_MOV_ISR_NULL});
      // START condition on the wires: SDA falls while SCL high, then SCL
      // (oe[0] drop = driven low in the inverted-OE model)
      begin : start_wave
        logic saw_sda, saw_scl;
        int kk;
        saw_sda = 1'b0; saw_scl = 1'b0;
        for (kk = 0; kk < 200 && !saw_scl; kk++) begin
          @(posedge clk); #1;
          if (!saw_sda && gpio_oe_w[0] === 1'b0) saw_sda = 1'b1;
          if (saw_sda && gpio_oe_w[1] === 1'b0) saw_scl = 1'b1;
        end
        `check1(saw_sda, 1'b1)
        `check1(saw_scl, 1'b1)
      end
      // One written byte 0xA5, Final=1 (record 16'h034A), slave ACKs;
      // slave stretches SCL on the 3rd clock for ~20 clks.
      bus_wr(A_TXF(0), 32'h034A_034A);
      dbg_win(160);
      oe_rises = 0; wire_rises = 0;
      oe_was = gpio_oe_w[1]; wire_was = gpio_in[1];
      t_oe = 0; t_wire = 0;
      k = 0;
      while (wire_rises < 9 && k < 4000) begin
        @(posedge clk); #1;
        if (gpio_oe_w[1] === 1'b1 && oe_was === 1'b0) begin
          oe_rises = oe_rises + 1;
          if (oe_rises == 3) begin
            scl_slave_low = 1'b1;           // stretch: clamp before the
            t_oe = clk_count;               // level propagates (2-FF)
            repeat (20) begin @(posedge clk); #1; end;
            scl_slave_low = 1'b0;           // slave releases the clock
          end
          if (oe_rises == 8) sda_slave_low = 1'b1;   // ACK: pull SDA low
        end
        if (gpio_in[1] === 1'b1 && wire_was === 1'b0) begin
          wire_rises = wire_rises + 1;
          if (wire_rises == 3) t_wire = clk_count;
        end
        oe_was = gpio_oe_w[1];
        wire_was = gpio_in[1];
        k = k + 1;
      end
      `check32(32'(oe_rises), 32'd9)        // 8 data clocks + ACK clock
      `check32(32'(wire_rises), 32'd9)      // all 9 reached the wire
      // The stretched clock: the 3rd wire rise lands >=18 clks after the
      // master's 3rd oe rise (the wait 1 pin,1 stalled through the stretch)
      if (t_oe > 0 && t_wire > 0 && (t_wire - t_oe) >= 18) begin
        tb_pass_count = tb_pass_count + 1;
        $display("PASS i2c clock stretch delay %0d clks", t_wire - t_oe);
      end else begin
        tb_fail_count = tb_fail_count + 1;
        $display("FAIL i2c clock stretch: oe@%0d wire@%0d", t_oe, t_wire);
      end
      // SM returns to entry and parks on `out x,6` with the FIFO empty;
      // every record word consumed
      poll_parked(0, I2C_LBL_ENTRY_POINT, 200, ok);
      `check1(ok, 1'b1)
      bus_rd(A_FLEVEL, v);
      `check32(v[3:0], 32'd0)
      // NAK byte (Final=0, slave leaves SDA high): jmp pin -> do_nack ->
      // `irq wait 0 rel` sets flag 0 and parks the SM (SPEC-3.8-2)
      sda_slave_low = 1'b0;                 // slave does NOT pull (NAK)
      dbg_win(340);
      bus_wr(A_TXF(0), 32'h006F_006F);      // data 0x37, final=0, SDA released
      poll_eq(A_IRQ, 32'h1, 2000, ok);
      if (!ok) begin
        bus_rd(A_IRQ, v);
        $display("DBGI irq=%08b pc=%0d", v, u_dut.dbg_sm_pc[0]);
      end
      `check1(ok, 1'b1)
      poll_eq(A_SM(0, 3), 32'd1, 40, ok);   // parked on the irq instruction
      `check1(ok, 1'b1)
      bus_wr(A_IRQ, 32'h1);                 // CPU clears the flag (W1C)
      // resumed: falls through do_byte (y was 0) and stalls again on the
      // empty FIFO at the bitloop's first `out pindirs` (pc 3) — the
      // driver's real recovery is pio_i2c_resume_after_error's forced JMP
      poll_eq(A_SM(0, 3), 32'd3, 40, ok);
      `check1(ok, 1'b1)
      enable(4'b0000);
      od_mask = 32'h0;
      od_pol  = 1'b0;
      pad_drive = 32'h0;
    end
  endtask

  // =====================================================================
  // CF12: manchester loopback — SPEC-15-7 forced-WAIT arming with delay
  // bits (ignored), tx->rx round trip of the example's own words.
  // =====================================================================
  task automatic cf12_manchester;
    logic ok;
    logic [31:0] v;
    begin
      $display("--- CF12: manchester_tx -> manchester_rx loopback");
      load_manchester_tx(0);
      load_manchester_rx(8);
      // tx (SM0): sideset 1 opt on pin0, out right autopull @32, JOIN_TX,
      // entry at 'start' (manchester_tx_program_init)
      bus_wr(A_SM(0, 5), MFY_PCTRL(2, 1, 0, 0, 0, 0, 0));
      bus_wr(A_SM(0, 1), MFY_EXEC(MANCHESTER_TX_WRAP, MANCHESTER_TX_LBL_START,
                                  0, 1'b1, 1'b0));
      bus_wr(A_SM(0, 2), MFY_SHIFT(1'b0, 1'b1, 32, 32, 1'b1, 1'b1, 1'b1, 1'b0));
      // rx (SM1): in base = JMP_PIN = pin0, in right autopush @32, JOIN_RX
      bus_wr(A_SM(1, 5), MFY_PCTRL(0, 0, 0, 0, 0, 0, 0));
      bus_wr(A_SM(1, 1), MFY_EXEC(8 + MANCHESTER_RX_WRAP,
                                  8 + MANCHESTER_RX_WRAP_TARGET,
                                  0, 1'b0, 1'b0));
      bus_wr(A_SM(1, 2), MFY_SHIFT(1'b1, 1'b0, 32, 32, 1'b1, 1'b1, 1'b0, 1'b1));
      set_pc(1, 8);                          // rx program at offset 8 (a
      // later force would overwrite the armed-instruction latch, SPEC-7-23)
      // rx arming per manchester_rx_program_init: forced set x,1 / set y,0,
      // then a forced `wait 1 pin 0` WITH delay bits set — SPEC-15-7: the
      // forced instruction must ignore them (they are cosmetic on silicon)
      bus_wr(A_SM(1, 4), 32'(E_SET(SETD_X, 5'd1, 5'd0)));
      bus_wr(A_SM(1, 4), 32'(E_SET(SETD_Y, 5'd0, 5'd0)));
      bus_wr(A_SM(1, 4), 32'(E_WAIT(1'b1, WSRC_PIN, 5'd0, 5'd2)));
      bus_rd(A_SM(1, 1), v);
      `check1(v[31], 1'b1)                  // EXEC_STALLED latched (SPEC-7-15)
      lb_mask = 32'h1;                      // wire pin0 from the tx output
      // tx pin init: forced `set pindirs,1` + `set pins,0` (C init), words
      // queued while disabled, then enable both SMs
      bus_wr(A_SM(0, 4), 32'(E_SET(SETD_PINDIRS, 5'd1, 5'd0)));
      bus_wr(A_SM(0, 4), 32'(E_SET(SETD_PINS, 5'd0, 5'd0)));
      bus_wr(A_TXF(0), 32'd0);              // the example's own three words
      bus_wr(A_TXF(0), 32'h0ff0_a55a);
      bus_wr(A_TXF(0), 32'h1234_5678);
      set_pc(0, MANCHESTER_TX_LBL_START);
      enable(4'b0011);
      dbg_win(950);
      // rx pushes the same words: tx emits LSB-first (out right) and rx
      // enters each decoded bit at the MSB end (in right), so bit k of
      // the received word is the k-th transmitted bit (SPEC-3.3-1) — the
      // example's own loopback workload. The first word round-trips
      // exactly; past the first word boundary the decode walks (word 2
      // reads 0xffff_f000). NOTE: this is divider-INVARIANT — CLKDIV
      // INT=1/2/4 produce byte-identical results — so it is a
      // deterministic tick-domain divergence, not a synchroniser-margin
      // effect (the earlier sync-margin theory here and in IDEAS.md was
      // falsified by that experiment). Root cause open; IDEAS.md has the
      // analysis and the bisection recipe.
      poll_eq(A_FLEVEL, 32'h1 << 12, 1500, ok);  // RX1 level 1 (TX1 dead)
      `check1(ok, 1'b1)
      rx_pop(1, v);
      `check32(v, 32'd0)
      enable(4'b0000);
      lb_mask = 32'h0;
    end
  endtask

  // =====================================================================
  // CF13: hub75_data_rgb888 — SPEC-15-6 imem patch while running.
  // =====================================================================
  task automatic cf13_hub75;
    logic ok;
    logic [31:0] v;
    logic [31:0] pins1;
    begin
      $display("--- CF13: hub75_data_rgb888 imem patch");
      load_hub75_data_rgb888(0);
      // out 6 pins at 0 (R0..B1), sideset clock at 6; out right autopull
      // @24, in left no autopush, JOIN_TX (hub75_data_rgb888 init)
      bus_wr(A_SM(0, 5), MFY_PCTRL(1, 0, 6, 0, 6, 0, 0));
      bus_wr(A_SM(0, 1), MFY_EXEC(HUB75_DATA_RGB888_WRAP,
                                  HUB75_DATA_RGB888_WRAP_TARGET,
                                  0, 1'b0, 1'b0));
      bus_wr(A_SM(0, 2), MFY_SHIFT(1'b0, 1'b1, 24, 32, 1'b1, 1'b0, 1'b1, 1'b0));
      enable(4'b0001);
      // Clean pass 1 (two pixel words): drives the RGB pins at word15's
      // `mov pins,::isr`, then parks on word0's PULL (FIFO empty)
      bus_wr(A_TXF(0), 32'h0402_01);        // osr bits 0/9/18 set
      bus_wr(A_TXF(0), 32'h0);
      poll_parked(0, 0, 400, ok);           // parked at word0's pull
      `check1(ok, 1'b1)
      #1;
      pins1 = gpio_out_w & 32'h3f;
      if (pins1 === 32'd0) begin
        tb_fail_count = tb_fail_count + 1;
        $display("FAIL hub75 pass1 did not drive the RGB pins");
      end else tb_pass_count = tb_pass_count + 1;
      // Park on word7's PULL (feed one word), then patch word7 and word15
      // to `jmp 0 side 1` while that PULL is in flight (stalled):
      // SPEC-15-6/CC-33 — the in-flight instruction completes as a PULL;
      // the patches apply at the next fetch of those words.
      bus_wr(A_TXF(0), 32'h0402_01);
      poll_parked(0, 7, 400, ok);           // parked at word7's pull
      `check1(ok, 1'b1)
      bus_wr(A_IMEM(7),  32'h1000);         // jmp 0 side 1
      bus_wr(A_IMEM(15), 32'h1000);         // jmp 0 side 1 (no more mov pins)
      bus_wr(A_TXF(0), 32'h0);              // completes the stalled PULL
      // Pass 2 runs 8..14, hits the patched word15 -> jumps to word0,
      // pulls nothing more (FIFO dry) and parks; the RGB pins keep the
      // pass-1 value because `mov pins,::isr` never executes again
      poll_parked(0, 0, 400, ok);
      `check1(ok, 1'b1)
      `WAIT_CLKS(2)
      #1;
      `check32(gpio_out_w & 32'h3f, pins1)  // SPEC-15-6: no retroactivity
      bus_rd(A_FLEVEL, v);
      `check32(v[3:0], 32'd0)               // the stalled PULL did consume
      enable(4'b0000);
    end
  endtask

  // =====================================================================
  // CF14: apa102_rgb555 — SPEC-15-1 (in isr rotate / in osr counter).
  // =====================================================================
  task automatic cf14_apa102;
    logic ok;
    logic [31:0] din, din2;
    begin
      $display("--- CF14: apa102_rgb555 (in isr rotate, in osr counter)");
      load_apa102_rgb555(0);
      // set base = CLK (pin1, set count 1), out base = DIN (pin0, count 1:
      // mov pins uses the OUT mapping, SPEC-3.6-1); OSR/ISR shift RIGHT
      // per the program header; autopull @16 (the `pull ifempty` fence)
      bus_wr(A_SM(0, 5), MFY_PCTRL(0, 1, 1, 0, 0, 1, 0));
      bus_wr(A_SM(0, 1), MFY_EXEC(APA102_RGB555_WRAP, APA102_RGB555_WRAP_TARGET,
                                  0, 1'b0, 1'b0));
      bus_wr(A_SM(0, 2), MFY_SHIFT(1'b0, 1'b0, 16, 32, 1'b1, 1'b1, 1'b1, 1'b0));
      enable(4'b0001);
      // Pixel word 0x040201 (osr[0], osr[9] set), Y=0. `set x,2` gives
      // THREE colour-loop iterations (one per 5-bit channel: e1 = osr[4:0]
      // = 00001, e2 = osr[9:5] = 10000, e3 = osr[14:10] = 00000), each
      // `in null,3` padding to a byte; composing in-right (entry at the
      // MSB end) then `in y,8` (y=0) and `mov isr,::isr` leaves
      // ISR0 = 0x8008_0000 (bits 31, 19 — the :: of the built {b12,b0}).
      // bit_run drives isr[0] and rotates right once per cell: a bit at
      // position p reaches b0 after exactly p rotations, so DIN[k] = 1 at
      // k = 19 and k = 31 — the SPEC-15-1 rotate contract on the wire
      // (stream self-symmetric: 0x8008_0000).
      bus_wr(A_TXF(0), 32'h0402_01);        // pass 1 pixel pattern
      bus_wr(A_TXF(0), 32'h0);               // pass 2: all-zero pixel
      din  = 32'd0;
      din2 = 32'd0;
      for (int k = 0; k < 64; k++) begin
        // walk true rising edges: wait out the high phase first
        if (k > 0) begin
          wait_pin(1, 1'b0, 40, ok);
          `check1(ok, 1'b1)
        end
        wait_pin(1, 1'b1, 40, ok);          // CLK rises; DIN = isr[0]
        `check1(ok, 1'b1)
        #1;
        if (k < 32) din[k] = gpio_out_w[0];
        else         din2[k-32] = gpio_out_w[0];
      end
      `check32(din, 32'h8008_0000)          // bits 19 and 31 of the stream
      // SPEC-15-1 second half: `in osr,5` must NOT advance the OSR counter
      // (only the `out null` instructions do). Pass 1's outs total 48, so
      // the autopull refills the OSR from word 2 at the `out null,32`
      // crossing; the wrap `pull ifempty` then finds the counter below
      // 16 and is a guarded no-op (CC-31) — pass 2 runs IMMEDIATELY and
      // drives 32 all-zero cells. Had `in osr` wrongly advanced the
      // counter, the refill would have landed mid-colour-loop instead and
      // the wrap pull would block on the now-empty FIFO: pass 2 would
      // never run (the walk above would have timed out on it).
      `check32(din2, 32'h0)                 // pass 2: the all-zero word
      enable(4'b0000);
    end
  endtask

  // =====================================================================
  // Stimulus.
  // =====================================================================
  initial begin
    reg_addr   = 9'd0;
    reg_wdata  = 32'd0;
    reg_write  = 1'b0;
    reg_read   = 1'b0;
    pad_drive  = 32'd0;
    od_mask    = 32'd0;
    od_pol     = 1'b0;
    lb_mask    = 32'h0;
    irq_prev_r = 8'd0;
    irq_next_r = 8'd0;
    nb_set     = 8'd0;
    nb_clr     = 8'd0;

    conf_reset();

    cf1_squarewave();
    conf_reset();
    cf2_addition();
    conf_reset();
    cf3_ws2812();
    conf_reset();
    cf4_uart_tx();
    conf_reset();
    cf5_spi_cpha0();
    conf_reset();
    cf6_spi_cpha1();
    conf_reset();
    cf7_spi_cs();
    conf_reset();
    cf8_clocked_input();
    conf_reset();
    cf9_quadrature();

    conf_reset();
    cf10_onewire(1'b1);
    conf_reset();
    cf10_onewire(1'b0);

    conf_reset();
    cf11_i2c();

    conf_reset();
    cf12_manchester();

    conf_reset();
    cf13_hub75();

    conf_reset();
    cf14_apa102();

    `TB_FINISH
  end

endmodule

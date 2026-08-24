// tb_pio_gpio_mux — directed TB for pio_gpio_mux (KANBAN C7).
//
// Timing convention (as tb_pio_irq_flags): inputs are driven at negedge
// (settled before the active edge), effects land at the following posedge,
// and checks read the settled state at the next negedge (`LAND).
//
// Covers the card's acceptance scenarios:
//   - pad toggle visible at k+2 (k+1 bypassed) — CC-23;
//   - rotation for several IN bases + IN_COUNT masking — SPEC-10-3;
//   - jmp_pin selection — SPEC-7-16;
//   - priority experiments with 2+ writers — CC-6 (side-set beats
//     OUT/SET within an SM), CC-7 (highest SM wins), hold with no writer;
//   - OUT_STICKY re-assert with no writers (stall model) — CC-5,
//     SPEC-7-18;
//   - reset defaults — SPEC-10-1.

`include "tb_common.sv"

// Land a driven value at the next posedge, then settle to negedge for
// checking.
`define LAND @(posedge clk); @(negedge clk);

module tb_pio_gpio_mux;
  logic clk, rst;
  tb_clk_rst u_cr (.clk(clk));

  logic [31:0] gpio_in, sync_bypass;
  logic [3:0][4:0] in_base, in_count, jmp_pin_idx;
  logic [3:0] out_we, out_pindir, set_we, set_pindir;
  logic [3:0] ss_we, ss_pindir, sticky_en;
  logic [3:0][4:0] out_base;
  logic [3:0][5:0] out_count;
  logic [3:0][31:0] out_data;
  logic [3:0][4:0] set_base, ss_base;
  logic [3:0][2:0] set_num, ss_num;
  logic [3:0][4:0] set_data, ss_data;

  logic [31:0] gpio_out, gpio_oe, dbg_padout, dbg_padoe;
  logic [3:0][31:0] in_bus;
  logic [3:0] jmp_pin;
  logic [31:0] gpio_seen;

  pio_gpio_mux u_dut (
      .clk(clk), .rst(rst),
      .gpio_in(gpio_in), .sync_bypass(sync_bypass),
      .in_base(in_base), .in_count(in_count), .jmp_pin_idx(jmp_pin_idx),
      .out_we(out_we), .out_pindir(out_pindir),
      .out_base(out_base), .out_count(out_count), .out_data(out_data),
      .set_we(set_we), .set_pindir(set_pindir),
      .set_base(set_base), .set_num(set_num), .set_data(set_data),
      .ss_we(ss_we), .ss_pindir(ss_pindir),
      .ss_base(ss_base), .ss_num(ss_num), .ss_data(ss_data),
      .sticky_en(sticky_en),
      .gpio_out(gpio_out), .gpio_oe(gpio_oe),
      .dbg_padout(dbg_padout), .dbg_padoe(dbg_padoe),
      .in_bus(in_bus), .jmp_pin(jmp_pin), .gpio_seen(gpio_seen)
  );

  // Defaults: quiescent.
  task clear_inputs;
    begin
      gpio_in = '0; sync_bypass = '0;
      in_base = '0; in_count = '0; jmp_pin_idx = '0;
      out_we = '0; out_pindir = '0; out_base = '0; out_count = '0; out_data = '0;
      set_we = '0; set_pindir = '0; set_base = '0; set_num = '0; set_data = '0;
      ss_we = '0; ss_pindir = '0; ss_base = '0; ss_num = '0; ss_data = '0;
      sticky_en = '0;
    end
  endtask

  initial begin
    clear_inputs();
    `DO_RESET(4)

    // ---------------------------------------------------------------
    // T1: reset defaults — outputs 0 (SPEC-10-1).
    // ---------------------------------------------------------------
    `check32(gpio_out, 32'd0)
    `check32(gpio_oe, 32'd0)
    `check32(gpio_seen, 32'd0)
    `check32(in_bus[0], 32'd0)

    // ---------------------------------------------------------------
    // T2: pad stable during cycle k is captured by sync1 at edge E1
    // (end of k) and by sync2 at E2 — visible on the seen bus from E2;
    // a bypassed pin is visible from E1 (CC-23).
    // ---------------------------------------------------------------
    @(negedge clk);
    gpio_in = 32'hA5A5_A5A5;
    `LAND  // E1
    `check32(gpio_seen, 32'd0)            // sync2 still old
    `LAND  // E2
    `check32(gpio_seen, 32'hA5A5_A5A5)    // CC-23: k+2 visibility
    gpio_in = '0;

    // Bypass: pin 0 bypassed — pad of cycle k seen from E1 (CC-23).
    sync_bypass = 32'h0000_0001;
    gpio_in = 32'h0000_0001;
    `LAND  // E1
    gpio_in = '0;
    `check1(gpio_seen[0], 1'b1)           // bypass: one edge
    `check1(gpio_seen[1], 1'b0)           // non-bypassed pin: still old
    `LAND  // E2
    sync_bypass = '0;
    #1 `check1(gpio_seen[0], 1'b1)       // now via sync2 as well

    // ---------------------------------------------------------------
    // T3: in_bus rotation for several bases + IN_COUNT mask (SPEC-10-3).
    // ---------------------------------------------------------------
    gpio_in = 32'h0000_00FF;
    `LAND
    `LAND
    gpio_in = '0;
    `check32(gpio_seen, 32'h0000_00FF)

    in_count[0] = 5'd0;                   // 0 = unmasked
    in_base[0] = 5'd4;
    #1 `check32(in_bus[0], 32'hF000_000F) // ror by 4: FF wraps to 28..31,0..3
    in_base[0] = 5'd28;
    #1 `check32(in_bus[0], 32'h0000_0FF0) // ror by 28: FF lands at 4..11
    in_base[0] = 5'd0;
    #1 `check32(in_bus[0], 32'h0000_00FF)
    in_count[0] = 5'd4;                   // keep only bits 3:0
    #1 `check32(in_bus[0], 32'h0000_000F)
    in_count[0] = 5'd31;
    #1 `check32(in_bus[0], 32'h0000_00FF) // mask keeps bits 0..30
    in_count[0] = 5'd0;
    in_base[0] = 5'd0;

    // ---------------------------------------------------------------
    // T4: jmp_pin selection (SPEC-7-16).
    // ---------------------------------------------------------------
    jmp_pin_idx[1] = 5'd3;
    #1 `check1(jmp_pin[1], 1'b1)
    jmp_pin_idx[1] = 5'd8;
    #1 `check1(jmp_pin[1], 1'b0)
    jmp_pin_idx[1] = 5'd0;

    // ---------------------------------------------------------------
    // T5: OUT PINS write lands at the executing tick's edge (CC-8),
    // holds with no writer (SPEC-10-2).
    // ---------------------------------------------------------------
    @(negedge clk);
    out_we[0] = 1'b1; out_base[0] = 5'd3; out_count[0] = 6'd4;
    out_data[0] = 32'h0000_000B;
    `LAND
    out_we[0] = 1'b0;
    `check32(gpio_out, 32'h0000_0058)     // pins 3..6 = 1011
    `LAND
    `check32(gpio_out, 32'h0000_0058)     // hold, no writer

    // OUT with count 0 = 32 pins (SPEC-7-26).
    @(negedge clk);
    out_we[0] = 1'b1; out_base[0] = 5'd1; out_count[0] = 6'd0;
    out_data[0] = 32'h8000_0001;
    `LAND
    out_we[0] = 1'b0; out_count[0] = 6'd4;
    `check32(gpio_out, 32'h0000_0003)     // rol by 1: bit0->1, bit31->0

    // OUT PINDIRS writes the OE register (SPEC-10-1).
    @(negedge clk);
    out_we[0] = 1'b1; out_pindir[0] = 1'b1;
    out_base[0] = 5'd0; out_count[0] = 6'd2; out_data[0] = 32'h3;
    `LAND
    out_we[0] = 1'b0; out_pindir[0] = 1'b0;
    `check32(gpio_oe, 32'h0000_0003)
    `check32(gpio_out, 32'h0000_0003)     // level untouched
    `check32(dbg_padout, 32'h0000_0003)   // SPEC-7-8 readback
    `check32(dbg_padoe, 32'h0000_0003)

    // ---------------------------------------------------------------
    // T6: side-set beats OUT within one SM on overlapping pins (CC-6).
    // Pre-state: gpio_out = 3, gpio_oe = 3.
    // ---------------------------------------------------------------
    @(negedge clk);
    out_we[0] = 1'b1; out_base[0] = 5'd0; out_count[0] = 6'd4;
    out_data[0] = 32'h0000_000F;          // OUT wants pins 0..3 = 1111
    ss_we[0] = 1'b1; ss_base[0] = 5'd2; ss_num[0] = 3'd2;
    ss_data[0] = 5'h0;                    // side-set wants pins 2..3 = 00
    `LAND
    out_we[0] = 1'b0; ss_we[0] = 1'b0;
    `check32(gpio_out, 32'h0000_0003)     // side-set won on 2..3 (CC-6)

    // Side-set alone (CC-5: fires in the first tick, persists).
    @(negedge clk);
    ss_we[0] = 1'b1; ss_base[0] = 5'd10; ss_num[0] = 3'd3;
    ss_data[0] = 5'h5;
    `LAND
    ss_we[0] = 1'b0;
    `check32(gpio_out, 32'h0000_1403)     // pins 10..12 = 101 over prior 0x3
    `LAND
    `check32(gpio_out, 32'h0000_1403)     // persists without re-assert

    // ---------------------------------------------------------------
    // T7: highest SM wins across SMs (CC-7).
    // ---------------------------------------------------------------
    @(negedge clk);
    out_we[0] = 1'b1; out_base[0] = 5'd0; out_count[0] = 6'd32;
    out_data[0] = 32'hFFFF_FFFF;
    out_we[2] = 1'b1; out_base[2] = 5'd0; out_count[2] = 6'd32;
    out_data[2] = 32'h0000_0000;
    `LAND
    out_we[0] = 1'b0; out_we[2] = 1'b0;
    `check32(gpio_out, 32'h0000_0000)     // SM2 wins over SM0, all 32 pins

    @(negedge clk);
    out_we[3] = 1'b1; out_base[3] = 5'd0; out_count[3] = 6'd4;
    out_data[3] = 32'h0000_000A;
    out_we[2] = 1'b1; out_base[2] = 5'd0; out_count[2] = 6'd4;
    out_data[2] = 32'h0000_0005;
    `LAND
    out_we[2] = 1'b0; out_we[3] = 1'b0;
    `check32(gpio_out, 32'h0000_000A)     // SM3 beats SM2

    // Level and direction resolve independently (SPEC-10-2).
    @(negedge clk);
    out_we[2] = 1'b1; out_pindir[2] = 1'b1;
    out_base[2] = 5'd0; out_count[2] = 6'd4; out_data[2] = 32'hF;
    `LAND
    out_we[2] = 1'b0; out_pindir[2] = 1'b0;
    `check32(gpio_oe, 32'h0000_000F)
    `check32(gpio_out, 32'h0000_000A)     // SM2 dir write, no level writer

    // ---------------------------------------------------------------
    // T8: OUT_STICKY re-asserts the last OUT/SET pin write (CC-5,
    // SPEC-7-18). Model of a stall: no writers at all for several clks.
    // ---------------------------------------------------------------
    @(negedge clk);
    out_we[1] = 1'b1; out_base[1] = 5'd0; out_count[1] = 6'd4;
    out_data[1] = 32'h0000_0005;
    `LAND
    out_we[1] = 1'b0;
    `check32(gpio_out, 32'h0000_0005)
    sticky_en[1] = 1'b1;
    // Higher SM overwrites pins 0..3 for one cycle; sticky SM1 re-asserts
    // from the next cycle (SM3 wins same-cycle, CC-7).
    @(negedge clk);
    out_we[3] = 1'b1; out_base[3] = 5'd0; out_count[3] = 6'd4;
    out_data[3] = 32'h0000_000A;
    `LAND
    out_we[3] = 1'b0;
    `check32(gpio_out, 32'h0000_000A)     // SM3 write beats sticky (CC-7)
    repeat (4) @(posedge clk); @(negedge clk);  // "stall" cycles: no writers
    `check32(gpio_out, 32'h0000_0005)     // CC-5: sticky re-asserts 0101

    // Sticky off: value now just holds.
    sticky_en[1] = 1'b0;
    `LAND
    `check32(gpio_out, 32'h0000_0005)

    // Sticky records a direction target too (SPEC-10-1).
    @(negedge clk);
    set_we[1] = 1'b1; set_pindir[1] = 1'b1;
    set_base[1] = 5'd4; set_num[1] = 3'd2; set_data[1] = 5'h3;
    `LAND
    set_we[1] = 1'b0;
    `check32(gpio_oe, 32'h0000_003F)
    sticky_en[1] = 1'b1;
    @(negedge clk);
    out_we[3] = 1'b1; out_pindir[3] = 1'b1;
    out_base[3] = 5'd4; out_count[3] = 6'd2; out_data[3] = 32'h0;
    `LAND
    out_we[3] = 1'b0;
    `check32(gpio_oe, 32'h0000_000F)      // SM3 write beat sticky same-cycle
    `LAND
    `check32(gpio_oe, 32'h0000_003F)      // SM1 sticky dir re-assert
    sticky_en[1] = 1'b0;

    // SET with num 0 is no pin write (SPEC-7-26).
    @(negedge clk);
    set_we[1] = 1'b1; set_num[1] = 3'd0;
    `LAND
    set_we[1] = 1'b0;
    `check32(gpio_oe, 32'h0000_003F)

    `TB_FINISH
  end
endmodule

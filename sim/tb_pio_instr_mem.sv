// tb_pio_instr_mem.sv — directed TB for rtl/pio_instr_mem.sv (KANBAN C1).
//
// Coverage (per the C1 acceptance):
//   1. Reset contents: all 32 words read back as 0 on all 4 ports.
//   2. Write then read on all 4 ports (one word per port, distinct
//      addresses presented simultaneously).
//   3. CC-33 visibility: a write retiring at end of cycle e is visible
//      to reads in e+1, and a read colliding with the write in e sees
//      the OLD word.
//   4. Stability: with wr_en deasserted the array holds its contents.
//
// Grounding: CC-1 (`DO_RESET), CC-33, SPEC-1-2 (32x16, 1W/4R),
// SPEC-14.1-1 (32 words authoritative), SPEC-7-10 (INSTR_MEM slots).

`include "tb_common.sv"

module tb_pio_instr_mem;

  localparam int AW = 5;
  localparam int DW = 16;

  logic clk;
  logic rst;
  tb_clk_rst u_cr (.clk(clk));

  logic        wr_en;
  logic [AW-1:0]  wr_addr;
  logic [DW-1:0]  wr_data;
  logic [AW-1:0]  rd_addr0, rd_addr1, rd_addr2, rd_addr3;
  logic [DW-1:0]  rd_data0, rd_data1, rd_data2, rd_data3;

  pio_instr_mem u_dut (
      .clk      (clk),
      .rst      (rst),
      .wr_en    (wr_en),
      .wr_addr  (wr_addr),
      .wr_data  (wr_data),
      .rd_addr0 (rd_addr0),
      .rd_addr1 (rd_addr1),
      .rd_addr2 (rd_addr2),
      .rd_addr3 (rd_addr3),
      .rd_data0 (rd_data0),
      .rd_data1 (rd_data1),
      .rd_data2 (rd_data2),
      .rd_data3 (rd_data3)
  );

  task automatic do_write(input logic [AW-1:0] a, input logic [DW-1:0] d);
    begin
      wr_en   = 1'b1;
      wr_addr = a;
      wr_data = d;
      @(negedge clk);        // stimulus stable around the posedge
      @(posedge clk);        // write retires at this edge (CC-33)
      @(negedge clk);
      wr_en   = 1'b0;
    end
  endtask

  initial begin
    wr_en    = 1'b0;
    wr_addr  = '0;
    wr_data  = '0;
    rd_addr0 = '0;
    rd_addr1 = '0;
    rd_addr2 = '0;
    rd_addr3 = '0;

    // CC-1: synchronous reset.
    `DO_RESET_DEFAULT

    // -------------------------------------------------------------
    // 1. Reset contents: all words 0 on all ports (KANBAN C1 reset
    //    value; SPEC-7-10 write-only slots).
    // -------------------------------------------------------------
    for (int i = 0; i < 32; i++) begin
      rd_addr0 = AW'(i);
      rd_addr1 = AW'(i);
      #1;
      `check32(rd_data0, 32'd0)
      `check32(rd_data1, 32'd0)
      `check32(rd_data2, 32'd0)
      `check32(rd_data3, 32'd0)
    end

    // -------------------------------------------------------------
    // 2. Write one word per port region, then read all 4 ports at
    //    distinct addresses simultaneously (SPEC-1-2: 1W/4R file).
    // -------------------------------------------------------------
    do_write(5'd0,  16'h0000);  // stays 0
    do_write(5'd7,  16'hA001);
    do_write(5'd13, 16'hB442);
    do_write(5'd21, 16'hC883);
    do_write(5'd31, 16'hD5C4);

    rd_addr0 = 5'd7;
    rd_addr1 = 5'd13;
    rd_addr2 = 5'd21;
    rd_addr3 = 5'd31;
    #1;
    `check32(rd_data0, 32'hA001)
    `check32(rd_data1, 32'hB442)
    `check32(rd_data2, 32'hC883)
    `check32(rd_data3, 32'hD5C4)

    // All ports read the same written word (shared file, SPEC-1-2).
    rd_addr0 = 5'd13;
    rd_addr1 = 5'd13;
    rd_addr2 = 5'd13;
    rd_addr3 = 5'd13;
    #1;
    `check32(rd_data0, 32'hB442)
    `check32(rd_data1, 32'hB442)
    `check32(rd_data2, 32'hB442)
    `check32(rd_data3, 32'hB442)

    // -------------------------------------------------------------
    // 3. CC-33: write retiring at end of cycle e.
    //    - read in e (same cycle as the write) sees the OLD word;
    //    - read in e+1 sees the NEW word.
    // -------------------------------------------------------------
    rd_addr0 = 5'd21;          // will collide with the write below
    rd_addr1 = 5'd21;
    rd_addr2 = 5'd21;
    rd_addr3 = 5'd21;
    @(posedge clk);            // anchor: start of cycle e
    #1;
    wr_en    = 1'b1;           // cycle e: patch word 21 (C883 -> E96F)
    wr_addr  = 5'd21;
    wr_data  = 16'hE96F;
    @(negedge clk);            // mid-cycle e: comb read settled
    `check32(rd_data0, 32'hC883)  // old word during e (CC-33)
    `check32(rd_data1, 32'hC883)
    `check32(rd_data2, 32'hC883)
    `check32(rd_data3, 32'hC883)
    @(posedge clk);            // write retires end of e
    @(negedge clk);            // cycle e+1
    wr_en = 1'b0;
    #1;
    `check32(rd_data0, 32'hE96F)  // new word from e+1 (CC-33)
    `check32(rd_data1, 32'hE96F)
    `check32(rd_data2, 32'hE96F)
    `check32(rd_data3, 32'hE96F)

    // -------------------------------------------------------------
    // 4. Stability: wr_en absent for several cycles ⇒ contents hold
    //    (SPEC-7-10: slots change only on writes).
    // -------------------------------------------------------------
    `WAIT_CLKS(5)
    #1;
    `check32(rd_data0, 32'hE96F)
    rd_addr0 = 5'd7;
    #1;
    `check32(rd_data0, 32'hA001)

    // -------------------------------------------------------------
    // 5. Re-assert reset (CC-1): contents clear to all-zero again.
    // -------------------------------------------------------------
    `DO_RESET(2)
    #1;
    `check32(rd_data0, 32'd0)
    rd_addr0 = 5'd31;
    #1;
    `check32(rd_data0, 32'd0)

    tb_finish;
  end

endmodule

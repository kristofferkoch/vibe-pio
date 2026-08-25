// conf_pioexamples.svh — AUTO-GENERATED, DO NOT EDIT
//
// Assembled PIO programs from the official raspberrypi/pico-examples
// repo (commit c81c855ffdedc825975a40ba357723a71358ddf0), to be run on
// pio_block by sim/tb_conf_picoexamples.sv. Regenerate with
// sim/gen_conf_pioexamples.py (see its header for the full recipe);
// pioasm 2.3.0, third_party/pioasm-sdk @ 98a542c).
//
// Addresses (wrap bounds, public labels) are relative to the program
// start; pass the load offset as `base` to the loader task.

// --------------------------------------------------------------------------
// squarewave — pio/squarewave/squarewave.pio (4 instructions)
// wrap_target=0 wrap=3 origin=-1
localparam int SQUAREWAVE_N          = 4;
localparam int SQUAREWAVE_ORIGIN     = -1;
localparam int SQUAREWAVE_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int SQUAREWAVE_WRAP       = 3;  // .wrap (relative)
task automatic load_squarewave(input int base);
  bus_wr(A_IMEM(base+0), 32'hE081);  // set    pindirs, 1
  bus_wr(A_IMEM(base+1), 32'hE101);  // set    pins, 1                [1]
  bus_wr(A_IMEM(base+2), 32'hE000);  // set    pins, 0
  bus_wr(A_IMEM(base+3), (32'h0001 & 32'hffff_e0) | ((5'(base) + 5'd1) & 5'h1f));  // jmp    1 (jmp +base)
endtask

// --------------------------------------------------------------------------
// addition — pio/addition/addition.pio (9 instructions)
// wrap_target=0 wrap=8 origin=-1
localparam int ADDITION_N          = 9;
localparam int ADDITION_ORIGIN     = -1;
localparam int ADDITION_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int ADDITION_WRAP       = 8;  // .wrap (relative)
task automatic load_addition(input int base);
  bus_wr(A_IMEM(base+0), 32'h80A0);  // pull   block
  bus_wr(A_IMEM(base+1), 32'hA02F);  // mov    x, ~osr
  bus_wr(A_IMEM(base+2), 32'h80A0);  // pull   block
  bus_wr(A_IMEM(base+3), 32'hA047);  // mov    y, osr
  bus_wr(A_IMEM(base+4), (32'h0006 & 32'hffff_e0) | ((5'(base) + 5'd6) & 5'h1f));  // jmp    6 (jmp +base)
  bus_wr(A_IMEM(base+5), (32'h0046 & 32'hffff_e0) | ((5'(base) + 5'd6) & 5'h1f));  // jmp    x--, 6 (jmp +base)
  bus_wr(A_IMEM(base+6), (32'h0085 & 32'hffff_e0) | ((5'(base) + 5'd5) & 5'h1f));  // jmp    y--, 5 (jmp +base)
  bus_wr(A_IMEM(base+7), 32'hA0C9);  // mov    isr, ~x
  bus_wr(A_IMEM(base+8), 32'h8020);  // push   block
endtask

// --------------------------------------------------------------------------
// ws2812 — pio/ws2812/ws2812.pio (4 instructions)
// wrap_target=0 wrap=3 origin=-1 sideset(size=1, opt=0, pindirs=0)
localparam int WS2812_N          = 4;
localparam int WS2812_ORIGIN     = -1;
localparam int WS2812_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int WS2812_WRAP       = 3;  // .wrap (relative)
localparam int WS2812_SS_SIZE     = 1;  // .side_set bit count (incl. opt bit)
localparam int WS2812_SS_OPT      = 0;  // no opt bit: every instr side-sets
localparam int WS2812_SS_PINDIRS  = 0;
localparam int WS2812_T1 = 3;  // .define public T1
localparam int WS2812_T2 = 3;  // .define public T2
localparam int WS2812_T3 = 4;  // .define public T3
task automatic load_ws2812(input int base);
  bus_wr(A_IMEM(base+0), 32'h6321);  // out    x, 1            side 0 [3]
  bus_wr(A_IMEM(base+1), (32'h1223 & 32'hffff_e0) | ((5'(base) + 5'd3) & 5'h1f));  // jmp    !x, 3           side 1 [2] (jmp +base)
  bus_wr(A_IMEM(base+2), (32'h1200 & 32'hffff_e0) | ((5'(base) + 5'd0) & 5'h1f));  // jmp    0               side 1 [2] (jmp +base)
  bus_wr(A_IMEM(base+3), 32'hA242);  // nop                    side 0 [2]
endtask

// --------------------------------------------------------------------------
// uart_tx — pio/uart_tx/uart_tx.pio (4 instructions)
// wrap_target=0 wrap=3 origin=-1 sideset(size=2, opt=1, pindirs=0)
localparam int UART_TX_N          = 4;
localparam int UART_TX_ORIGIN     = -1;
localparam int UART_TX_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int UART_TX_WRAP       = 3;  // .wrap (relative)
localparam int UART_TX_SS_SIZE     = 2;  // .side_set bit count (incl. opt bit)
localparam int UART_TX_SS_OPT      = 1;
localparam int UART_TX_SS_PINDIRS  = 0;
task automatic load_uart_tx(input int base);
  bus_wr(A_IMEM(base+0), 32'h9FA0);  // pull   block           side 1 [7]
  bus_wr(A_IMEM(base+1), 32'hF727);  // set    x, 7            side 0 [7]
  bus_wr(A_IMEM(base+2), 32'h6001);  // out    pins, 1
  bus_wr(A_IMEM(base+3), (32'h0642 & 32'hffff_e0) | ((5'(base) + 5'd2) & 5'h1f));  // jmp    x--, 2                 [6] (jmp +base)
endtask

// --------------------------------------------------------------------------
// spi_cpha0 — pio/spi/spi.pio (2 instructions)
// wrap_target=0 wrap=1 origin=-1 sideset(size=1, opt=0, pindirs=0)
localparam int SPI_CPHA0_N          = 2;
localparam int SPI_CPHA0_ORIGIN     = -1;
localparam int SPI_CPHA0_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int SPI_CPHA0_WRAP       = 1;  // .wrap (relative)
localparam int SPI_CPHA0_SS_SIZE     = 1;  // .side_set bit count (incl. opt bit)
localparam int SPI_CPHA0_SS_OPT      = 0;  // no opt bit: every instr side-sets
localparam int SPI_CPHA0_SS_PINDIRS  = 0;
task automatic load_spi_cpha0(input int base);
  bus_wr(A_IMEM(base+0), 32'h6101);  // out    pins, 1         side 0 [1]
  bus_wr(A_IMEM(base+1), 32'h5101);  // in     pins, 1         side 1 [1]
endtask

// --------------------------------------------------------------------------
// spi_cpha1 — pio/spi/spi.pio (3 instructions)
// wrap_target=0 wrap=2 origin=-1 sideset(size=1, opt=0, pindirs=0)
localparam int SPI_CPHA1_N          = 3;
localparam int SPI_CPHA1_ORIGIN     = -1;
localparam int SPI_CPHA1_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int SPI_CPHA1_WRAP       = 2;  // .wrap (relative)
localparam int SPI_CPHA1_SS_SIZE     = 1;  // .side_set bit count (incl. opt bit)
localparam int SPI_CPHA1_SS_OPT      = 0;  // no opt bit: every instr side-sets
localparam int SPI_CPHA1_SS_PINDIRS  = 0;
task automatic load_spi_cpha1(input int base);
  bus_wr(A_IMEM(base+0), 32'h6021);  // out    x, 1            side 0
  bus_wr(A_IMEM(base+1), 32'hB101);  // mov    pins, x         side 1 [1]
  bus_wr(A_IMEM(base+2), 32'h4001);  // in     pins, 1         side 0
endtask

// --------------------------------------------------------------------------
// spi_cpha0_cs — pio/spi/spi.pio (9 instructions)
// wrap_target=0 wrap=8 origin=-1 sideset(size=2, opt=0, pindirs=0)
localparam int SPI_CPHA0_CS_N          = 9;
localparam int SPI_CPHA0_CS_ORIGIN     = -1;
localparam int SPI_CPHA0_CS_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int SPI_CPHA0_CS_WRAP       = 8;  // .wrap (relative)
localparam int SPI_CPHA0_CS_SS_SIZE     = 2;  // .side_set bit count (incl. opt bit)
localparam int SPI_CPHA0_CS_SS_OPT      = 0;  // no opt bit: every instr side-sets
localparam int SPI_CPHA0_CS_SS_PINDIRS  = 0;
localparam int SPI_CPHA0_CS_LBL_ENTRY_POINT = 8;  // public entry_point
task automatic load_spi_cpha0_cs(input int base);
  bus_wr(A_IMEM(base+0), 32'h6101);  // out    pins, 1         side 0 [1]
  bus_wr(A_IMEM(base+1), 32'h4801);  // in     pins, 1         side 1
  bus_wr(A_IMEM(base+2), (32'h0840 & 32'hffff_e0) | ((5'(base) + 5'd0) & 5'h1f));  // jmp    x--, 0          side 1 (jmp +base)
  bus_wr(A_IMEM(base+3), 32'h6001);  // out    pins, 1         side 0
  bus_wr(A_IMEM(base+4), 32'hA022);  // mov    x, y            side 0
  bus_wr(A_IMEM(base+5), 32'h4801);  // in     pins, 1         side 1
  bus_wr(A_IMEM(base+6), (32'h08e0 & 32'hffff_e0) | ((5'(base) + 5'd0) & 5'h1f));  // jmp    !osre, 0        side 1 (jmp +base)
  bus_wr(A_IMEM(base+7), 32'hA142);  // nop                    side 0 [1]
  bus_wr(A_IMEM(base+8), 32'h91E0);  // pull   ifempty block   side 2 [1]
endtask

// --------------------------------------------------------------------------
// clocked_input — pio/clocked_input/clocked_input.pio (3 instructions)
// wrap_target=0 wrap=2 origin=-1
localparam int CLOCKED_INPUT_N          = 3;
localparam int CLOCKED_INPUT_ORIGIN     = -1;
localparam int CLOCKED_INPUT_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int CLOCKED_INPUT_WRAP       = 2;  // .wrap (relative)
task automatic load_clocked_input(input int base);
  bus_wr(A_IMEM(base+0), 32'h2021);  // wait   0 pin, 1
  bus_wr(A_IMEM(base+1), 32'h20A1);  // wait   1 pin, 1
  bus_wr(A_IMEM(base+2), 32'h4001);  // in     pins, 1
endtask

// --------------------------------------------------------------------------
// quadrature_encoder — pio/quadrature_encoder/quadrature_encoder.pio (24 instructions)
// wrap_target=15 wrap=23 origin=0
localparam int QUADRATURE_ENCODER_N          = 24;
localparam int QUADRATURE_ENCODER_ORIGIN     = 0;
localparam int QUADRATURE_ENCODER_WRAP_TARGET= 15;  // .wrap_target (relative)
localparam int QUADRATURE_ENCODER_WRAP       = 23;  // .wrap (relative)
task automatic load_quadrature_encoder(input int base);
  bus_wr(A_IMEM(base+0), (32'h000f & 32'hffff_e0) | ((5'(base) + 5'd15) & 5'h1f));  // jmp    15 (jmp +base)
  bus_wr(A_IMEM(base+1), (32'h000e & 32'hffff_e0) | ((5'(base) + 5'd14) & 5'h1f));  // jmp    14 (jmp +base)
  bus_wr(A_IMEM(base+2), (32'h0015 & 32'hffff_e0) | ((5'(base) + 5'd21) & 5'h1f));  // jmp    21 (jmp +base)
  bus_wr(A_IMEM(base+3), (32'h000f & 32'hffff_e0) | ((5'(base) + 5'd15) & 5'h1f));  // jmp    15 (jmp +base)
  bus_wr(A_IMEM(base+4), (32'h0015 & 32'hffff_e0) | ((5'(base) + 5'd21) & 5'h1f));  // jmp    21 (jmp +base)
  bus_wr(A_IMEM(base+5), (32'h000f & 32'hffff_e0) | ((5'(base) + 5'd15) & 5'h1f));  // jmp    15 (jmp +base)
  bus_wr(A_IMEM(base+6), (32'h000f & 32'hffff_e0) | ((5'(base) + 5'd15) & 5'h1f));  // jmp    15 (jmp +base)
  bus_wr(A_IMEM(base+7), (32'h000e & 32'hffff_e0) | ((5'(base) + 5'd14) & 5'h1f));  // jmp    14 (jmp +base)
  bus_wr(A_IMEM(base+8), (32'h000e & 32'hffff_e0) | ((5'(base) + 5'd14) & 5'h1f));  // jmp    14 (jmp +base)
  bus_wr(A_IMEM(base+9), (32'h000f & 32'hffff_e0) | ((5'(base) + 5'd15) & 5'h1f));  // jmp    15 (jmp +base)
  bus_wr(A_IMEM(base+10), (32'h000f & 32'hffff_e0) | ((5'(base) + 5'd15) & 5'h1f));  // jmp    15 (jmp +base)
  bus_wr(A_IMEM(base+11), (32'h0015 & 32'hffff_e0) | ((5'(base) + 5'd21) & 5'h1f));  // jmp    21 (jmp +base)
  bus_wr(A_IMEM(base+12), (32'h000f & 32'hffff_e0) | ((5'(base) + 5'd15) & 5'h1f));  // jmp    15 (jmp +base)
  bus_wr(A_IMEM(base+13), (32'h0015 & 32'hffff_e0) | ((5'(base) + 5'd21) & 5'h1f));  // jmp    21 (jmp +base)
  bus_wr(A_IMEM(base+14), (32'h008f & 32'hffff_e0) | ((5'(base) + 5'd15) & 5'h1f));  // jmp    y--, 15 (jmp +base)
  bus_wr(A_IMEM(base+15), 32'hA0C2);  // mov    isr, y
  bus_wr(A_IMEM(base+16), 32'h8000);  // push   noblock
  bus_wr(A_IMEM(base+17), 32'h60C2);  // out    isr, 2
  bus_wr(A_IMEM(base+18), 32'h4002);  // in     pins, 2
  bus_wr(A_IMEM(base+19), 32'hA0E6);  // mov    osr, isr
  bus_wr(A_IMEM(base+20), 32'hA0A6);  // mov    pc, isr
  bus_wr(A_IMEM(base+21), 32'hA04A);  // mov    y, ~y
  bus_wr(A_IMEM(base+22), (32'h0097 & 32'hffff_e0) | ((5'(base) + 5'd23) & 5'h1f));  // jmp    y--, 23 (jmp +base)
  bus_wr(A_IMEM(base+23), 32'hA04A);  // mov    y, ~y
endtask

// --------------------------------------------------------------------------
// onewire — pio/onewire/onewire_library/onewire_library.pio (17 instructions)
// wrap_target=8 wrap=16 origin=-1 sideset(size=1, opt=0, pindirs=1)
localparam int ONEWIRE_N          = 17;
localparam int ONEWIRE_ORIGIN     = -1;
localparam int ONEWIRE_WRAP_TARGET= 8;  // .wrap_target (relative)
localparam int ONEWIRE_WRAP       = 16;  // .wrap (relative)
localparam int ONEWIRE_SS_SIZE     = 1;  // .side_set bit count (incl. opt bit)
localparam int ONEWIRE_SS_OPT      = 0;  // no opt bit: every instr side-sets
localparam int ONEWIRE_SS_PINDIRS  = 1;
localparam int ONEWIRE_LBL_FETCH_BIT = 8;  // public fetch_bit
localparam int ONEWIRE_LBL_RESET_BUS = 0;  // public reset_bus
task automatic load_onewire(input int base);
  bus_wr(A_IMEM(base+0), 32'hFF3C);  // set    x, 28           side 1 [15]
  bus_wr(A_IMEM(base+1), (32'h1f41 & 32'hffff_e0) | ((5'(base) + 5'd1) & 5'h1f));  // jmp    x--, 1          side 1 [15] (jmp +base)
  bus_wr(A_IMEM(base+2), 32'hE628);  // set    x, 8            side 0 [6]
  bus_wr(A_IMEM(base+3), (32'h0643 & 32'hffff_e0) | ((5'(base) + 5'd3) & 5'h1f));  // jmp    x--, 3          side 0 [6] (jmp +base)
  bus_wr(A_IMEM(base+4), 32'hA0C0);  // mov    isr, pins       side 0
  bus_wr(A_IMEM(base+5), 32'h8020);  // push   block           side 0
  bus_wr(A_IMEM(base+6), 32'hE738);  // set    x, 24           side 0 [7]
  bus_wr(A_IMEM(base+7), (32'h0f47 & 32'hffff_e0) | ((5'(base) + 5'd7) & 5'h1f));  // jmp    x--, 7          side 0 [15] (jmp +base)
  bus_wr(A_IMEM(base+8), 32'h6021);  // out    x, 1            side 0
  bus_wr(A_IMEM(base+9), (32'h152e & 32'hffff_e0) | ((5'(base) + 5'd14) & 5'h1f));  // jmp    !x, 14          side 1 [5] (jmp +base)
  bus_wr(A_IMEM(base+10), 32'hE822);  // set    x, 2            side 0 [8]
  bus_wr(A_IMEM(base+11), 32'h4401);  // in     pins, 1         side 0 [4]
  bus_wr(A_IMEM(base+12), (32'h0f4c & 32'hffff_e0) | ((5'(base) + 5'd12) & 5'h1f));  // jmp    x--, 12         side 0 [15] (jmp +base)
  bus_wr(A_IMEM(base+13), (32'h0008 & 32'hffff_e0) | ((5'(base) + 5'd8) & 5'h1f));  // jmp    8               side 0 (jmp +base)
  bus_wr(A_IMEM(base+14), 32'hF522);  // set    x, 2            side 1 [5]
  bus_wr(A_IMEM(base+15), (32'h1f4f & 32'hffff_e0) | ((5'(base) + 5'd15) & 5'h1f));  // jmp    x--, 15         side 1 [15] (jmp +base)
  bus_wr(A_IMEM(base+16), 32'h4861);  // in     null, 1         side 0 [8]
endtask

// --------------------------------------------------------------------------
// i2c — pio/i2c/i2c.pio (18 instructions)
// wrap_target=12 wrap=17 origin=-1 sideset(size=2, opt=1, pindirs=1)
localparam int I2C_N          = 18;
localparam int I2C_ORIGIN     = -1;
localparam int I2C_WRAP_TARGET= 12;  // .wrap_target (relative)
localparam int I2C_WRAP       = 17;  // .wrap (relative)
localparam int I2C_SS_SIZE     = 2;  // .side_set bit count (incl. opt bit)
localparam int I2C_SS_OPT      = 1;
localparam int I2C_SS_PINDIRS  = 1;
localparam int I2C_LBL_ENTRY_POINT = 12;  // public entry_point
task automatic load_i2c(input int base);
  bus_wr(A_IMEM(base+0), (32'h008c & 32'hffff_e0) | ((5'(base) + 5'd12) & 5'h1f));  // jmp    y--, 12 (jmp +base)
  bus_wr(A_IMEM(base+1), 32'hC030);  // irq    wait 0 rel
  bus_wr(A_IMEM(base+2), 32'hE027);  // set    x, 7
  bus_wr(A_IMEM(base+3), 32'h6781);  // out    pindirs, 1             [7]
  bus_wr(A_IMEM(base+4), 32'hBA42);  // nop                    side 1 [2]
  bus_wr(A_IMEM(base+5), 32'h24A1);  // wait   1 pin, 1               [4]
  bus_wr(A_IMEM(base+6), 32'h4701);  // in     pins, 1                [7]
  bus_wr(A_IMEM(base+7), (32'h1743 & 32'hffff_e0) | ((5'(base) + 5'd3) & 5'h1f));  // jmp    x--, 3          side 0 [7] (jmp +base)
  bus_wr(A_IMEM(base+8), 32'h6781);  // out    pindirs, 1             [7]
  bus_wr(A_IMEM(base+9), 32'hBF42);  // nop                    side 1 [7]
  bus_wr(A_IMEM(base+10), 32'h27A1);  // wait   1 pin, 1               [7]
  bus_wr(A_IMEM(base+11), (32'h12c0 & 32'hffff_e0) | ((5'(base) + 5'd0) & 5'h1f));  // jmp    pin, 0          side 0 [2] (jmp +base)
  bus_wr(A_IMEM(base+12), 32'h6026);  // out    x, 6
  bus_wr(A_IMEM(base+13), 32'h6041);  // out    y, 1
  bus_wr(A_IMEM(base+14), (32'h0022 & 32'hffff_e0) | ((5'(base) + 5'd2) & 5'h1f));  // jmp    !x, 2 (jmp +base)
  bus_wr(A_IMEM(base+15), 32'h6060);  // out    null, 32
  bus_wr(A_IMEM(base+16), 32'h60F0);  // out    exec, 16
  bus_wr(A_IMEM(base+17), (32'h0050 & 32'hffff_e0) | ((5'(base) + 5'd16) & 5'h1f));  // jmp    x--, 16 (jmp +base)
endtask

// --------------------------------------------------------------------------
// set_scl_sda — pio/i2c/i2c.pio (4 instructions)
// wrap_target=0 wrap=3 origin=-1 sideset(size=2, opt=1, pindirs=0)
localparam int SET_SCL_SDA_N          = 4;
localparam int SET_SCL_SDA_ORIGIN     = -1;
localparam int SET_SCL_SDA_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int SET_SCL_SDA_WRAP       = 3;  // .wrap (relative)
localparam int SET_SCL_SDA_SS_SIZE     = 2;  // .side_set bit count (incl. opt bit)
localparam int SET_SCL_SDA_SS_OPT      = 1;
localparam int SET_SCL_SDA_SS_PINDIRS  = 0;
task automatic load_set_scl_sda(input int base);
  bus_wr(A_IMEM(base+0), 32'hF780);  // set    pindirs, 0      side 0 [7]
  bus_wr(A_IMEM(base+1), 32'hF781);  // set    pindirs, 1      side 0 [7]
  bus_wr(A_IMEM(base+2), 32'hFF80);  // set    pindirs, 0      side 1 [7]
  bus_wr(A_IMEM(base+3), 32'hFF81);  // set    pindirs, 1      side 1 [7]
endtask

// --------------------------------------------------------------------------
// manchester_tx — pio/manchester_encoding/manchester_encoding.pio (6 instructions)
// wrap_target=0 wrap=5 origin=-1 sideset(size=2, opt=1, pindirs=0)
localparam int MANCHESTER_TX_N          = 6;
localparam int MANCHESTER_TX_ORIGIN     = -1;
localparam int MANCHESTER_TX_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int MANCHESTER_TX_WRAP       = 5;  // .wrap (relative)
localparam int MANCHESTER_TX_SS_SIZE     = 2;  // .side_set bit count (incl. opt bit)
localparam int MANCHESTER_TX_SS_OPT      = 1;
localparam int MANCHESTER_TX_SS_PINDIRS  = 0;
localparam int MANCHESTER_TX_LBL_START = 4;  // public start
task automatic load_manchester_tx(input int base);
  bus_wr(A_IMEM(base+0), 32'hB542);  // nop                    side 0 [5]
  bus_wr(A_IMEM(base+1), (32'h1b04 & 32'hffff_e0) | ((5'(base) + 5'd4) & 5'h1f));  // jmp    4               side 1 [3] (jmp +base)
  bus_wr(A_IMEM(base+2), 32'hBD42);  // nop                    side 1 [5]
  bus_wr(A_IMEM(base+3), 32'hB342);  // nop                    side 0 [3]
  bus_wr(A_IMEM(base+4), 32'h6021);  // out    x, 1
  bus_wr(A_IMEM(base+5), (32'h0022 & 32'hffff_e0) | ((5'(base) + 5'd2) & 5'h1f));  // jmp    !x, 2 (jmp +base)
endtask

// --------------------------------------------------------------------------
// manchester_rx — pio/manchester_encoding/manchester_encoding.pio (6 instructions)
// wrap_target=3 wrap=5 origin=-1
localparam int MANCHESTER_RX_N          = 6;
localparam int MANCHESTER_RX_ORIGIN     = -1;
localparam int MANCHESTER_RX_WRAP_TARGET= 3;  // .wrap_target (relative)
localparam int MANCHESTER_RX_WRAP       = 5;  // .wrap (relative)
task automatic load_manchester_rx(input int base);
  bus_wr(A_IMEM(base+0), 32'h2020);  // wait   0 pin, 0
  bus_wr(A_IMEM(base+1), 32'h4841);  // in     y, 1                   [8]
  bus_wr(A_IMEM(base+2), (32'h00c0 & 32'hffff_e0) | ((5'(base) + 5'd0) & 5'h1f));  // jmp    pin, 0 (jmp +base)
  bus_wr(A_IMEM(base+3), 32'h20A0);  // wait   1 pin, 0
  bus_wr(A_IMEM(base+4), 32'h4821);  // in     x, 1                   [8]
  bus_wr(A_IMEM(base+5), (32'h00c0 & 32'hffff_e0) | ((5'(base) + 5'd0) & 5'h1f));  // jmp    pin, 0 (jmp +base)
endtask

// --------------------------------------------------------------------------
// differential_manchester_tx — pio/differential_manchester/differential_manchester.pio (10 instructions)
// wrap_target=0 wrap=9 origin=-1 sideset(size=2, opt=1, pindirs=0)
localparam int DIFFERENTIAL_MANCHESTER_TX_N          = 10;
localparam int DIFFERENTIAL_MANCHESTER_TX_ORIGIN     = -1;
localparam int DIFFERENTIAL_MANCHESTER_TX_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int DIFFERENTIAL_MANCHESTER_TX_WRAP       = 9;  // .wrap (relative)
localparam int DIFFERENTIAL_MANCHESTER_TX_SS_SIZE     = 2;  // .side_set bit count (incl. opt bit)
localparam int DIFFERENTIAL_MANCHESTER_TX_SS_OPT      = 1;
localparam int DIFFERENTIAL_MANCHESTER_TX_SS_PINDIRS  = 0;
localparam int DIFFERENTIAL_MANCHESTER_TX_LBL_START = 0;  // public start
task automatic load_differential_manchester_tx(input int base);
  bus_wr(A_IMEM(base+0), 32'h6021);  // out    x, 1
  bus_wr(A_IMEM(base+1), (32'h1e24 & 32'hffff_e0) | ((5'(base) + 5'd4) & 5'h1f));  // jmp    !x, 4           side 1 [6] (jmp +base)
  bus_wr(A_IMEM(base+2), 32'hA042);  // nop
  bus_wr(A_IMEM(base+3), (32'h1600 & 32'hffff_e0) | ((5'(base) + 5'd0) & 5'h1f));  // jmp    0               side 0 [6] (jmp +base)
  bus_wr(A_IMEM(base+4), (32'h0705 & 32'hffff_e0) | ((5'(base) + 5'd5) & 5'h1f));  // jmp    5                      [7] (jmp +base)
  bus_wr(A_IMEM(base+5), 32'h6021);  // out    x, 1
  bus_wr(A_IMEM(base+6), (32'h1629 & 32'hffff_e0) | ((5'(base) + 5'd9) & 5'h1f));  // jmp    !x, 9           side 0 [6] (jmp +base)
  bus_wr(A_IMEM(base+7), 32'hA042);  // nop
  bus_wr(A_IMEM(base+8), (32'h1e05 & 32'hffff_e0) | ((5'(base) + 5'd5) & 5'h1f));  // jmp    5               side 1 [6] (jmp +base)
  bus_wr(A_IMEM(base+9), (32'h0700 & 32'hffff_e0) | ((5'(base) + 5'd0) & 5'h1f));  // jmp    0                      [7] (jmp +base)
endtask

// --------------------------------------------------------------------------
// differential_manchester_rx — pio/differential_manchester/differential_manchester.pio (10 instructions)
// wrap_target=5 wrap=9 origin=-1
localparam int DIFFERENTIAL_MANCHESTER_RX_N          = 10;
localparam int DIFFERENTIAL_MANCHESTER_RX_ORIGIN     = -1;
localparam int DIFFERENTIAL_MANCHESTER_RX_WRAP_TARGET= 5;  // .wrap_target (relative)
localparam int DIFFERENTIAL_MANCHESTER_RX_WRAP       = 9;  // .wrap (relative)
localparam int DIFFERENTIAL_MANCHESTER_RX_LBL_START = 0;  // public start
task automatic load_differential_manchester_rx(input int base);
  bus_wr(A_IMEM(base+0), 32'h2BA0);  // wait   1 pin, 0               [11]
  bus_wr(A_IMEM(base+1), (32'h00c4 & 32'hffff_e0) | ((5'(base) + 5'd4) & 5'h1f));  // jmp    pin, 4 (jmp +base)
  bus_wr(A_IMEM(base+2), 32'h4021);  // in     x, 1
  bus_wr(A_IMEM(base+3), (32'h0000 & 32'hffff_e0) | ((5'(base) + 5'd0) & 5'h1f));  // jmp    0 (jmp +base)
  bus_wr(A_IMEM(base+4), 32'h4141);  // in     y, 1                   [1]
  bus_wr(A_IMEM(base+5), 32'h2B20);  // wait   0 pin, 0               [11]
  bus_wr(A_IMEM(base+6), (32'h00c9 & 32'hffff_e0) | ((5'(base) + 5'd9) & 5'h1f));  // jmp    pin, 9 (jmp +base)
  bus_wr(A_IMEM(base+7), 32'h4041);  // in     y, 1
  bus_wr(A_IMEM(base+8), (32'h0000 & 32'hffff_e0) | ((5'(base) + 5'd0) & 5'h1f));  // jmp    0 (jmp +base)
  bus_wr(A_IMEM(base+9), 32'h4121);  // in     x, 1                   [1]
endtask

// --------------------------------------------------------------------------
// uart_rx — pio/uart_rx/uart_rx.pio (9 instructions)
// wrap_target=0 wrap=8 origin=-1
localparam int UART_RX_N          = 9;
localparam int UART_RX_ORIGIN     = -1;
localparam int UART_RX_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int UART_RX_WRAP       = 8;  // .wrap (relative)
task automatic load_uart_rx(input int base);
  bus_wr(A_IMEM(base+0), 32'h2020);  // wait   0 pin, 0
  bus_wr(A_IMEM(base+1), 32'hEA27);  // set    x, 7                   [10]
  bus_wr(A_IMEM(base+2), 32'h4001);  // in     pins, 1
  bus_wr(A_IMEM(base+3), (32'h0642 & 32'hffff_e0) | ((5'(base) + 5'd2) & 5'h1f));  // jmp    x--, 2                 [6] (jmp +base)
  bus_wr(A_IMEM(base+4), (32'h00c8 & 32'hffff_e0) | ((5'(base) + 5'd8) & 5'h1f));  // jmp    pin, 8 (jmp +base)
  bus_wr(A_IMEM(base+5), 32'hC014);  // irq    nowait 4 rel
  bus_wr(A_IMEM(base+6), 32'h20A0);  // wait   1 pin, 0
  bus_wr(A_IMEM(base+7), (32'h0000 & 32'hffff_e0) | ((5'(base) + 5'd0) & 5'h1f));  // jmp    0 (jmp +base)
  bus_wr(A_IMEM(base+8), 32'h8020);  // push   block
endtask

// --------------------------------------------------------------------------
// hub75_data_rgb888 — pio/hub75/hub75.pio (16 instructions)
// wrap_target=0 wrap=15 origin=-1 sideset(size=1, opt=0, pindirs=0)
localparam int HUB75_DATA_RGB888_N          = 16;
localparam int HUB75_DATA_RGB888_ORIGIN     = -1;
localparam int HUB75_DATA_RGB888_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int HUB75_DATA_RGB888_WRAP       = 15;  // .wrap (relative)
localparam int HUB75_DATA_RGB888_SS_SIZE     = 1;  // .side_set bit count (incl. opt bit)
localparam int HUB75_DATA_RGB888_SS_OPT      = 0;  // no opt bit: every instr side-sets
localparam int HUB75_DATA_RGB888_SS_PINDIRS  = 0;
localparam int HUB75_DATA_RGB888_LBL_ENTRY_POINT = 0;  // public entry_point
localparam int HUB75_DATA_RGB888_LBL_SHIFT0 = 0;  // public shift0
localparam int HUB75_DATA_RGB888_LBL_SHIFT1 = 7;  // public shift1
task automatic load_hub75_data_rgb888(input int base);
  bus_wr(A_IMEM(base+0), 32'h80A0);  // pull   block           side 0
  bus_wr(A_IMEM(base+1), 32'h40E1);  // in     osr, 1          side 0
  bus_wr(A_IMEM(base+2), 32'h6068);  // out    null, 8         side 0
  bus_wr(A_IMEM(base+3), 32'h40E1);  // in     osr, 1          side 0
  bus_wr(A_IMEM(base+4), 32'h6068);  // out    null, 8         side 0
  bus_wr(A_IMEM(base+5), 32'h40E1);  // in     osr, 1          side 0
  bus_wr(A_IMEM(base+6), 32'h6060);  // out    null, 32        side 0
  bus_wr(A_IMEM(base+7), 32'h80A0);  // pull   block           side 0
  bus_wr(A_IMEM(base+8), 32'h50E1);  // in     osr, 1          side 1
  bus_wr(A_IMEM(base+9), 32'h7068);  // out    null, 8         side 1
  bus_wr(A_IMEM(base+10), 32'h50E1);  // in     osr, 1          side 1
  bus_wr(A_IMEM(base+11), 32'h7068);  // out    null, 8         side 1
  bus_wr(A_IMEM(base+12), 32'h50E1);  // in     osr, 1          side 1
  bus_wr(A_IMEM(base+13), 32'h7060);  // out    null, 32        side 1
  bus_wr(A_IMEM(base+14), 32'h507A);  // in     null, 26        side 1
  bus_wr(A_IMEM(base+15), 32'hB016);  // mov    pins, ::isr     side 1
endtask

// --------------------------------------------------------------------------
// apa102_rgb555 — pio/apa102/apa102.pio (15 instructions)
// wrap_target=0 wrap=14 origin=-1
localparam int APA102_RGB555_N          = 15;
localparam int APA102_RGB555_ORIGIN     = -1;
localparam int APA102_RGB555_WRAP_TARGET= 0;  // .wrap_target (relative)
localparam int APA102_RGB555_WRAP       = 14;  // .wrap (relative)
localparam int APA102_RGB555_LBL_BIT_RUN = 9;  // public bit_run
localparam int APA102_RGB555_LBL_PIXEL_OUT = 0;  // public pixel_out
task automatic load_apa102_rgb555(input int base);
  bus_wr(A_IMEM(base+0), 32'h80E0);  // pull   ifempty block
  bus_wr(A_IMEM(base+1), 32'hE022);  // set    x, 2
  bus_wr(A_IMEM(base+2), 32'h40E5);  // in     osr, 5
  bus_wr(A_IMEM(base+3), 32'h6065);  // out    null, 5
  bus_wr(A_IMEM(base+4), 32'h4063);  // in     null, 3
  bus_wr(A_IMEM(base+5), (32'h0042 & 32'hffff_e0) | ((5'(base) + 5'd2) & 5'h1f));  // jmp    x--, 2 (jmp +base)
  bus_wr(A_IMEM(base+6), 32'h4048);  // in     y, 8
  bus_wr(A_IMEM(base+7), 32'hA0D6);  // mov    isr, ::isr
  bus_wr(A_IMEM(base+8), 32'h6061);  // out    null, 1
  bus_wr(A_IMEM(base+9), 32'hE03F);  // set    x, 31
  bus_wr(A_IMEM(base+10), 32'hE000);  // set    pins, 0
  bus_wr(A_IMEM(base+11), 32'hA606);  // mov    pins, isr              [6]
  bus_wr(A_IMEM(base+12), 32'hE001);  // set    pins, 1
  bus_wr(A_IMEM(base+13), 32'h46C1);  // in     isr, 1                 [6]
  bus_wr(A_IMEM(base+14), (32'h004a & 32'hffff_e0) | ((5'(base) + 5'd10) & 5'h1f));  // jmp    x--, 10 (jmp +base)
endtask


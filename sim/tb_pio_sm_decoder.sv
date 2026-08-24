// tb_pio_sm_decoder.sv — directed TB for rtl/pio_sm_decoder.sv (KANBAN C4).
//
// Coverage (per the C4 acceptance):
//   1. One row per master-encoding-table entry (SPEC §2 table): a
//      representative word for JMP, WAIT (each src), IN, OUT, PUSH,
//      MOV put, PULL, MOV get, MOV, IRQ, SET — fields + strobes.
//   2. All 8 class opcodes: exactly one class strobe high (SPEC-2-2).
//   3. Delay/side-set split at SIDESET_COUNT 0..5, both SIDE_EN values,
//      including the enable-bit edge values (SPEC-4-1..3, SPEC-4-9,
//      SPEC-14.8-1).
//   4. Bitcount 0 ⇒ 32 on IN/OUT (SPEC-2-18).
//   5. Reserved encodings ⇒ illegal (SPEC-13-1): IN src 100/101, SET
//      dsts 011/101/110/111, MOV op 11, MOV src 100, IRQ modifier 3,
//      WAIT JMPPIN index>3, class-0x4 nonzero arg2, FIFO-aux b2=1,
//      FIFO-aux IdxI=0 with Index≠0.
//   6. Class-0x4 overload rule (SPEC-14.2-1) across the four forms.
//
// Grounding: SPEC-2-1..18, SPEC-3.1-2..9, SPEC-3.2-2..5, SPEC-3.3-2..6,
// SPEC-3.4-2..8, SPEC-3.5-1..3, SPEC-3.6-1..9, SPEC-3.7-1..4,
// SPEC-3.8-1..7, SPEC-3.9-1/2, SPEC-4-1..9, SPEC-13-1, SPEC-14.2-1,
// SPEC-14.8-1, SPEC-14.3-1.

`include "tb_common.sv"

module tb_pio_sm_decoder;

  // No clk/rst: the DUT is pure combinational (DESIGN.md §pio_sm_decoder).

  logic [15:0] instr;
  logic        side_en;
  logic [2:0]  sideset_count;

  logic [4:0]  delay, ss_val;
  logic        ss_valid;
  logic [2:0]  ss_bits;
  logic        is_jmp, is_wait, is_in, is_out, is_push, is_pull;
  logic        is_put, is_get, is_mov, is_irq, is_set, illegal;
  logic [2:0]  jmp_cond, in_src, out_dst, mov_dst, mov_src, set_dst;
  logic [4:0]  jmp_addr, wait_index, set_data;
  logic        wait_pol, push_iff, push_blk, pull_ife, pull_blk, aux_idxi;
  logic [1:0]  wait_src, mov_op, irq_idxmode, aux_index;
  logic [5:0]  in_count, out_count;
  logic        irq_clr, irq_wait;
  logic [2:0]  irq_index;

  pio_sm_decoder u_dut (
      .instr (instr), .side_en (side_en), .sideset_count (sideset_count),
      .delay (delay), .ss_valid (ss_valid), .ss_val (ss_val),
      .ss_bits (ss_bits),
      .is_jmp (is_jmp), .is_wait (is_wait), .is_in (is_in),
      .is_out (is_out), .is_push (is_push), .is_pull (is_pull),
      .is_put (is_put), .is_get (is_get), .is_mov (is_mov),
      .is_irq (is_irq), .is_set (is_set), .illegal (illegal),
      .jmp_cond (jmp_cond), .jmp_addr (jmp_addr),
      .wait_pol (wait_pol), .wait_src (wait_src), .wait_index (wait_index),
      .in_src (in_src), .in_count (in_count),
      .out_dst (out_dst), .out_count (out_count),
      .push_iff (push_iff), .push_blk (push_blk),
      .pull_ife (pull_ife), .pull_blk (pull_blk),
      .aux_idxi (aux_idxi), .aux_index (aux_index),
      .mov_dst (mov_dst), .mov_src (mov_src), .mov_op (mov_op),
      .irq_clr (irq_clr), .irq_wait (irq_wait),
      .irq_idxmode (irq_idxmode), .irq_index (irq_index),
      .set_dst (set_dst), .set_data (set_data)
  );

  // Encoding helper (SPEC-2-1).
  function automatic logic [15:0] enc(input logic [2:0]  cls,
                                      input logic [4:0]  dss,
                                      input logic [2:0]  a1,
                                      input logic [4:0]  a2);
    enc = {cls, dss, a1, a2};
  endfunction

  // Exactly-one-strobe check (SPEC-2-2 onehot classes).
  task check_onehot(input logic e_jmp, e_wait, e_in, e_out, e_push,
                    e_pull, e_put, e_get, e_mov, e_irq, e_set, e_ill);
    begin
      `check1(is_jmp,  e_jmp)
      `check1(is_wait, e_wait)
      `check1(is_in,   e_in)
      `check1(is_out,  e_out)
      `check1(is_push, e_push)
      `check1(is_pull, e_pull)
      `check1(is_put,  e_put)
      `check1(is_get,  e_get)
      `check1(is_mov,  e_mov)
      `check1(is_irq,  e_irq)
      `check1(is_set,  e_set)
      `check1(illegal, e_ill)
    end
  endtask

  initial begin
    instr = 16'h0000;
    side_en = 1'b0;
    sideset_count = 3'd0;
    #1;

    // -------------------------------------------------------------
    // 1. Master-encoding-table rows (SPEC-2-7..17). Plain delay
    //    config (SIDESET_COUNT=0 ⇒ field is pure delay, SPEC-4-9).
    // -------------------------------------------------------------
    // JMP y-- , addr 0x15, delay 7 (SPEC-3.1-6).
    instr = enc(3'b000, 5'd7, 3'b100, 5'h15); #1;
    check_onehot(1,0,0,0,0,0,0,0,0,0,0,0);
    `check32(jmp_cond, 3'b100)
    `check32(jmp_addr, 5'h15)
    `check32(delay, 5'd7)
    `check1(ss_valid, 1'b0)

    // WAIT 1 pin, index 12 (SPEC-3.2-3).
    instr = enc(3'b001, 5'd0, 3'b1_01, 5'd12); #1;
    // arg1 = {pol=1, src=01}
    check_onehot(0,1,0,0,0,0,0,0,0,0,0,0);
    `check1(wait_pol, 1'b1)
    `check32(wait_src, 2'b01)
    `check32(wait_index, 5'd12)

    // WAIT 0 gpio, index 3 (SPEC-3.2-2).
    instr = enc(3'b001, 5'd0, 3'b000, 5'd3); #1;
    `check1(wait_pol, 1'b0)
    `check32(wait_src, 2'b00)

    // WAIT 1 irq rel 5 (SPEC-3.2-4/6: b4:3 mode, b2:0 index).
    instr = enc(3'b001, 5'd0, 3'b010, 5'b10_101); #1;
    check_onehot(0,1,0,0,0,0,0,0,0,0,0,0);
    `check32(wait_src, 2'b10)
    `check32(wait_index[4:3], 2'b10)
    `check32(wait_index[2:0], 3'd5)

    // WAIT 1 jmppin offset 2 (SPEC-3.2-5).
    instr = enc(3'b001, 5'd0, 3'b011, 5'd2); #1;
    check_onehot(0,1,0,0,0,0,0,0,0,0,0,0);
    `check32(wait_src, 2'b11)
    `check1(illegal, 1'b0)

    // IN osr, 12 (SPEC-3.3-6).
    instr = enc(3'b010, 5'd0, 3'b111, 5'd12); #1;
    check_onehot(0,0,1,0,0,0,0,0,0,0,0,0);
    `check32(in_src, 3'b111)
    `check32(in_count, 6'd12)

    // OUT x, 5 (SPEC-3.4-3).
    instr = enc(3'b011, 5'd0, 3'b001, 5'd5); #1;
    check_onehot(0,0,0,1,0,0,0,0,0,0,0,0);
    `check32(out_dst, 3'b001)
    `check32(out_count, 6'd5)

    // PUSH iffull noblock (SPEC-3.5-1: IfF=b6, Blk=b5).
    instr = enc(3'b100, 5'd0, 3'b010, 5'd0); #1;
    check_onehot(0,0,0,0,1,0,0,0,0,0,0,0);
    `check1(push_iff, 1'b1)
    `check1(push_blk, 1'b0)

    // MOV put: arg2 = 1[4] | IdxI[3] | 0[2] | Index[1:0] (SPEC-3.7-1/4).
    instr = enc(3'b100, 5'd0, 3'b000, 5'b1_1_0_10); #1;
    check_onehot(0,0,0,0,0,0,1,0,0,0,0,0);
    `check1(aux_idxi, 1'b1)
    `check32(aux_index, 2'd2)

    // MOV put with Y index: IdxI=0, Index=0 (SPEC-3.7-4).
    instr = enc(3'b100, 5'd0, 3'b000, 5'b1_0_0_00); #1;
    check_onehot(0,0,0,0,0,0,1,0,0,0,0,0);
    `check1(illegal, 1'b0)

    // PULL ifempty block (SPEC-3.5-2: IfE=b6, Blk=b5).
    instr = enc(3'b100, 5'd0, 3'b111, 5'd0); #1;
    check_onehot(0,0,0,0,0,1,0,0,0,0,0,0);
    `check1(pull_ife, 1'b1)
    `check1(pull_blk, 1'b1)

    // MOV get index 1 literal (SPEC-3.7-2).
    instr = enc(3'b100, 5'd0, 3'b100, 5'b1_1_0_01); #1;
    check_onehot(0,0,0,0,0,0,0,1,0,0,0,0);
    `check1(aux_idxi, 1'b1)
    `check32(aux_index, 2'd1)

    // MOV osr, !isr (SPEC-2-15: op[4:3], src[2:0]; SPEC-3.6-9 op 01).
    instr = enc(3'b101, 5'd3, 3'b111, 5'b01_110); #1;
    check_onehot(0,0,0,0,0,0,0,0,1,0,0,0);
    `check32(mov_dst, 3'b111)
    `check32(mov_src, 3'b110)
    `check32(mov_op, 2'b01)
    `check32(delay, 5'd3)

    // IRQ set nowait, idxmode REL, index 2 (SPEC-3.8-1/6).
    instr = enc(3'b110, 5'd0, 3'b000, 5'b10_010); #1;
    check_onehot(0,0,0,0,0,0,0,0,0,1,0,0);
    `check1(irq_clr, 1'b0)
    `check1(irq_wait, 1'b0)
    `check32(irq_idxmode, 2'b10)
    `check32(irq_index, 3'd2)

    // IRQ clear prev 7 (SPEC-3.8-1/5).
    instr = enc(3'b110, 5'd0, 3'b010, 5'b01_111); #1;
    `check1(irq_clr, 1'b1)
    `check1(irq_wait, 1'b0)
    `check32(irq_idxmode, 2'b01)

    // SET x, 0x1f (SPEC-3.9-1).
    instr = enc(3'b111, 5'd0, 3'b001, 5'h1f); #1;
    check_onehot(0,0,0,0,0,0,0,0,0,0,1,0);
    `check32(set_dst, 3'b001)
    `check32(set_data, 5'h1f)

    // -------------------------------------------------------------
    // 2. All 8 class opcodes (SPEC-2-2): one strobe per class value.
    // -------------------------------------------------------------
    for (int c = 0; c < 8; c++) begin
      // Neutral arg1/arg2 per class to keep every word legal.
      case (c)
        0: instr = enc(3'(c), 5'd0, 3'b000, 5'd0);   // jmp 0
        1: instr = enc(3'(c), 5'd0, 3'b010, 5'd1);   // wait 1 gpio 1
        2: instr = enc(3'(c), 5'd0, 3'b000, 5'd1);   // in pins, 1
        3: instr = enc(3'(c), 5'd0, 3'b000, 5'd1);   // out pins, 1
        4: instr = enc(3'(c), 5'd0, 3'b001, 5'd0);   // push block
        5: instr = enc(3'(c), 5'd0, 3'b000, 5'b01_000); // mov x, x (op none)
        6: instr = enc(3'(c), 5'd0, 3'b000, 5'd0);   // irq 0
        7: instr = enc(3'(c), 5'd0, 3'b000, 5'd0);   // set pins, 0
      endcase
      #1;
      case (c)
        0: check_onehot(1,0,0,0,0,0,0,0,0,0,0,0);
        1: check_onehot(0,1,0,0,0,0,0,0,0,0,0,0);
        2: check_onehot(0,0,1,0,0,0,0,0,0,0,0,0);
        3: check_onehot(0,0,0,1,0,0,0,0,0,0,0,0);
        4: check_onehot(0,0,0,0,1,0,0,0,0,0,0,0);
        5: check_onehot(0,0,0,0,0,0,0,0,1,0,0,0);
        6: check_onehot(0,0,0,0,0,0,0,0,0,1,0,0);
        7: check_onehot(0,0,0,0,0,0,0,0,0,0,1,0);
      endcase
      `check1(illegal, 1'b0)
    end

    // -------------------------------------------------------------
    // 3. Delay / side-set split: SIDESET_COUNT 0..5 × SIDE_EN 0/1
    //    (SPEC-4-1..3, SPEC-4-9, SPEC-14.8-1).
    // -------------------------------------------------------------
    for (int sc = 0; sc <= 5; sc++) begin
      for (int se = 0; se < 2; se++) begin
        logic [4:0] f;
        side_en = logic'(se);
        sideset_count = 3'(sc);
        // Walk the whole 5-bit field exhaustively.
        for (int fv = 0; fv < 32; fv++) begin
          logic [2:0]  total, vbits;
          logic [4:0]  exp_delay, exp_ssfield, exp_ssval;
          logic        exp_valid;
          f = 5'(fv);
          instr = enc(3'b000, f, 3'b000, 5'd0);  // any class; field only
          #1;
          total = 3'(sc);
          vbits = se ? (total - 3'd1) : total;
          exp_delay = (sc == 0) ? f : (f & (5'd31 >> total));
          exp_ssfield = f >> (3'd5 - total);
          exp_valid = (sc != 0)
                      && (!se || exp_ssfield[total - 3'd1]);
          exp_ssval = exp_valid ? (exp_ssfield & (5'd31 >> (3'd5 - vbits)))
                                : 5'd0;
          `check32(delay, exp_delay)   // SPEC-4-1
          `check1(ss_valid, exp_valid) // SPEC-4-2/4-9/14.8-1
          `check32(ss_val, exp_ssval)  // SPEC-4-3
          `check32(ss_bits, exp_valid ? vbits : 3'd0)
        end
      end
    end

    // Spot-check documented splits (SPEC-4-2/4-3):
    // count=2, no opt, field=ss=3, delay=1 ⇒ value 3 on 2 pins.
    side_en = 1'b0; sideset_count = 3'd2;
    instr = enc(3'b000, 5'b11_001, 3'b000, 5'd0); #1;
    `check1(ss_valid, 1'b1)
    `check32(ss_val, 5'd3)
    `check32(delay, 5'd1)
    // count=3 with opt, enable bit 0 ⇒ no side-set this instruction;
    //    delay = the 2 delay bits below the 3-bit side-set field
    //    (SPEC-4-2/4-3).
    side_en = 1'b1; sideset_count = 3'd3;
    instr = enc(3'b000, 5'b011_11, 3'b000, 5'd0); #1;
    `check1(ss_valid, 1'b0)
    `check32(delay, 5'd3)
    // count=5, no opt ⇒ no delay bits (SPEC-4-3).
    side_en = 1'b0; sideset_count = 3'd5;
    instr = enc(3'b000, 5'b10101, 3'b000, 5'd0); #1;
    `check1(ss_valid, 1'b1)
    `check32(ss_val, 5'd21)
    `check32(delay, 5'd0)

    // -------------------------------------------------------------
    // 4. Bitcount 0 ⇒ 32 (SPEC-2-18).
    // -------------------------------------------------------------
    side_en = 1'b0; sideset_count = 3'd0;
    instr = enc(3'b010, 5'd0, 3'b000, 5'd0); #1;
    `check32(in_count, 6'd32)
    instr = enc(3'b011, 5'd0, 3'b000, 5'd0); #1;
    `check32(out_count, 6'd32)
    instr = enc(3'b010, 5'd0, 3'b000, 5'd31); #1;
    `check32(in_count, 6'd31)

    // -------------------------------------------------------------
    // 5. Reserved encodings ⇒ illegal (SPEC-13-1).
    // -------------------------------------------------------------
    // IN sources 100/101 (SPEC-3.3-5).
    instr = enc(3'b010, 5'd0, 3'b100, 5'd1); #1;
    check_onehot(0,0,1,0,0,0,0,0,0,0,0,1);
    instr = enc(3'b010, 5'd0, 3'b101, 5'd1); #1;
    `check1(illegal, 1'b1)

    // SET dsts 011/101/110/111 (SPEC-3.9-2).
    instr = enc(3'b111, 5'd0, 3'b011, 5'd0); #1;
    check_onehot(0,0,0,0,0,0,0,0,0,0,1,1);
    instr = enc(3'b111, 5'd0, 3'b101, 5'd0); #1; `check1(illegal, 1'b1)
    instr = enc(3'b111, 5'd0, 3'b110, 5'd0); #1; `check1(illegal, 1'b1)
    instr = enc(3'b111, 5'd0, 3'b111, 5'd0); #1; `check1(illegal, 1'b1)

    // MOV op 11 and src 100 (SPEC-3.6-5/9).
    instr = enc(3'b101, 5'd0, 3'b000, 5'b11_000); #1;
    check_onehot(0,0,0,0,0,0,0,0,1,0,0,1);
    instr = enc(3'b101, 5'd0, 3'b000, 5'b00_100); #1;
    `check1(illegal, 1'b1)

    // IRQ modifier 3 (SPEC-3.8-3).
    instr = enc(3'b110, 5'd0, 3'b011, 5'd0); #1;
    check_onehot(0,0,0,0,0,0,0,0,0,1,0,1);

    // WAIT JMPPIN index > 3 (SPEC-13-1, SPEC-3.2-5).
    instr = enc(3'b001, 5'd0, 3'b011, 5'd4); #1;
    check_onehot(0,1,0,0,0,0,0,0,0,0,0,1);
    instr = enc(3'b001, 5'd0, 3'b011, 5'd31); #1;
    `check1(illegal, 1'b1)

    // Class-0x4 nonzero arg2 without the aux bit (SPEC-14.2-1): the
    // PUSH/PULL strobe still decodes, illegal marks it reserved.
    instr = enc(3'b100, 5'd0, 3'b001, 5'd1); #1;
    check_onehot(0,0,0,0,1,0,0,0,0,0,0,1);
    instr = enc(3'b100, 5'd0, 3'b101, 5'd31); #1;
    `check1(illegal, 1'b1)

    // FIFO-aux b2 = 1 (fixed-0 field, SPEC-2-12/14).
    instr = enc(3'b100, 5'd0, 3'b000, 5'b1_0_1_01); #1;
    `check1(is_put, 1'b1)
    `check1(illegal, 1'b1)
    // FIFO-aux IdxI=0 with Index ≠ 0 (SPEC-13-1; Y-index needs Index=0).
    instr = enc(3'b100, 5'd0, 3'b000, 5'b1_0_0_10); #1;
    `check1(illegal, 1'b1)
    // GET flavour reserved the same way.
    instr = enc(3'b100, 5'd0, 3'b100, 5'b1_0_0_11); #1;
    `check1(is_get, 1'b1)
    `check1(illegal, 1'b1)

    // -------------------------------------------------------------
    // 6. Class-0x4 overload summary (SPEC-14.2-1): four legal forms.
    // -------------------------------------------------------------
    instr = enc(3'b100, 5'd0, 3'b000, 5'd0); #1;  // push
    check_onehot(0,0,0,0,1,0,0,0,0,0,0,0);
    instr = enc(3'b100, 5'd0, 3'b100, 5'd0); #1;  // pull
    check_onehot(0,0,0,0,0,1,0,0,0,0,0,0);
    instr = enc(3'b100, 5'd0, 3'b000, 5'b1_1_0_00); #1;  // put idx 0
    check_onehot(0,0,0,0,0,0,1,0,0,0,0,0);
    instr = enc(3'b100, 5'd0, 3'b100, 5'b1_0_0_00); #1;  // get via Y
    check_onehot(0,0,0,0,0,0,0,1,0,0,0,0);

    `TB_FINISH
  end

endmodule

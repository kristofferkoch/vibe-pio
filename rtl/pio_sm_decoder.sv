// pio_sm_decoder — pure combinational decode of the 16-bit PIO
// instruction word (KANBAN C4).
//
// Splits the word per the master encoding table (SPEC-2-1..18) into:
//   - delay / side-set fields under EXECCTRL.SIDE_EN +
//     PINCTRL.SIDESET_COUNT (SPEC-4-1..3, SPEC-4-9, SPEC-14.8-1),
//   - onehot instruction-class strobes, with the class-0x4 overload
//     resolved per SPEC-14.2-1 (arg2[4] ⇒ FIFO-aux MOV PUT/GET, else
//     PUSH/PULL, nonzero arg2 ⇒ reserved),
//   - per-class operands: JMP condition (SPEC-3.1-2..9), WAIT src/pol
//     (SPEC-3.2-2..5), IN/OUT src/dst + bitcount 0⇒32 (SPEC-2-18),
//     MOV src/dst/op (SPEC-3.6-x), SET dst/data (SPEC-3.9-x),
//     PUSH/PULL IfF/IfE/Blk (SPEC-3.5-1..3), IRQ Clr/Wait/idxmode/index
//     (SPEC-3.8-x),
//   - an `illegal` strobe for the reserved encodings of SPEC-13-1.
//
// Stateless by construction (no clk/rst): the decode is a pure function
// of the word and the two side-set config inputs. Side-set config is fed
// from C5's register bank; everything else is imem output (C1) or the
// EXEC latch word (C8).

module pio_sm_decoder (
    // Instruction word: imem read at pc, or the forced-instruction latch.
    input  logic [15:0] instr,

    // Side-set config (EXECCTRL.SIDE_EN bit 30, PINCTRL.SIDESET_COUNT
    // bits 25:23 — values 0..5, inclusive of the enable bit when
    // SIDE_EN=1; SPEC-4-1..3).
    input  logic        side_en,
    input  logic [2:0]  sideset_count,

    // -----------------------------------------------------------------
    // Delay / side-set split (SPEC-4-1..9, SPEC-14.8-1).
    // -----------------------------------------------------------------
    output logic [4:0]  delay,     // delay cycles (SPEC-4-3 max 2^(5-bits)-1)
    output logic        ss_valid,  // side-set occurs this instruction
    output logic [4:0]  ss_val,    // side-set value (ss_bits LSBs valid)
    output logic [2:0]  ss_bits,   // number of side-set value bits (0..5)

    // -----------------------------------------------------------------
    // Onehot instruction-class strobes (SPEC-2-7..17). Exactly one is
    // high; `illegal` marks a reserved encoding (SPEC-13-1) — the class
    // strobe still shows the would-be operation.
    // -----------------------------------------------------------------
    output logic        is_jmp,
    output logic        is_wait,
    output logic        is_in,
    output logic        is_out,
    output logic        is_push,
    output logic        is_pull,
    output logic        is_put,    // MOV rxfifo[idx], isr (SPEC-3.7-1)
    output logic        is_get,    // MOV osr, rxfifo[idx]  (SPEC-3.7-2)
    output logic        is_mov,
    output logic        is_irq,
    output logic        is_set,
    output logic        illegal,   // reserved encoding (SPEC-13-1)

    // -----------------------------------------------------------------
    // Per-class operands.
    // -----------------------------------------------------------------
    output logic [2:0]  jmp_cond,   // SPEC-3.1-2..9
    output logic [4:0]  jmp_addr,

    output logic        wait_pol,   // SPEC-3.2-1
    output logic [1:0]  wait_src,   // SPEC-3.2-2..5
    output logic [4:0]  wait_index,

    output logic [2:0]  in_src,     // SPEC-3.3-2..6
    output logic [5:0]  in_count,   // SPEC-2-18: bitcount 0 ⇒ 32

    output logic [2:0]  out_dst,    // SPEC-3.4-2..8
    output logic [5:0]  out_count,  // SPEC-2-18

    output logic        push_iff,   // SPEC-3.5-1/5
    output logic        push_blk,   // SPEC-3.5-6
    output logic        pull_ife,   // SPEC-3.5-2/10
    output logic        pull_blk,   // SPEC-3.5-11

    output logic        aux_idxi,   // SPEC-3.7-4: 1 = literal index
    output logic [1:0]  aux_index,  // SPEC-3.7-3

    output logic [2:0]  mov_dst,    // SPEC-3.6-1..8
    output logic [2:0]  mov_src,
    output logic [1:0]  mov_op,     // SPEC-3.6-9

    output logic        irq_clr,    // SPEC-3.8-1
    output logic        irq_wait,   // SPEC-3.8-2
    output logic [1:0]  irq_idxmode,// SPEC-3.8-4..7
    output logic [2:0]  irq_index,

    output logic [2:0]  set_dst,    // SPEC-3.9-1/2
    output logic [4:0]  set_data
);

  localparam int IW = 16;

  // -----------------------------------------------------------------------
  // Field extraction (SPEC-2-1..5).
  // -----------------------------------------------------------------------
  logic [2:0]  class_c;
  logic [4:0]  ds_field_c;   // bits 12:8, delay|sideset (SPEC-2-3)
  logic [2:0]  arg1_c;       // bits 7:5 (SPEC-2-4)
  logic [4:0]  arg2_c;       // bits 4:0 (SPEC-2-5)

  assign class_c   = instr[15:13];
  assign ds_field_c = instr[12:8];
  assign arg1_c    = instr[7:5];
  assign arg2_c    = instr[4:0];

  // -----------------------------------------------------------------------
  // Delay / side-set split (SPEC-4-1..3, SPEC-4-9, SPEC-14.8-1).
  //
  // The top `sideset_count` bits of the 5-bit field are side-set
  // (inclusive of the enable bit when SIDE_EN=1); the remaining LSBs are
  // delay. SIDESET_COUNT=0 ⇒ no side-set at all, regardless of SIDE_EN
  // (SPEC-4-9, SPEC-14.8-1) — the mask below then keeps all 5 delay bits.
  // -----------------------------------------------------------------------
  logic [2:0] ss_total_c;   // side-set field width incl. enable bit
  logic [2:0] ss_vbits_c;   // value bits below the enable bit
  logic [4:0] ss_field_c;   // extracted side-set field (top-aligned out)
  logic       ss_en_bit_c;  // per-instruction enable (SPEC-4-2)
  logic [4:0] delay_mask_c;

  always_comb begin
    ss_total_c = sideset_count;
    // SPEC-4-2: with SIDE_EN the field MSB is the enable bit.
    ss_vbits_c  = side_en ? (ss_total_c - 3'd1) : ss_total_c;
    // SPEC-4-1: field = delay | (sideset << (5 - bits_incl_opt)).
    ss_field_c  = ds_field_c >> (3'd5 - ss_total_c);
    delay_mask_c = 5'd31 >> ss_total_c;
    // Enable-bit select guarded for ss_total_c == 0 (SPEC-4-9): the
    // subtract wraps to 7, an out-of-range (discarded) bit index.
    ss_en_bit_c = (ss_total_c != 3'd0) ? ss_field_c[ss_total_c - 3'd1]
                                       : 1'b0;
  end

  assign delay    = ds_field_c & delay_mask_c;
  assign ss_valid = (ss_total_c != 3'd0) && (!side_en || ss_en_bit_c);
  assign ss_val   = ss_valid ? (ss_field_c & (5'd31 >> (3'd5 - ss_vbits_c)))
                             : 5'd0;
  assign ss_bits  = ss_valid ? ss_vbits_c : 3'd0;

  // -----------------------------------------------------------------------
  // Bitcount decode: 0 ⇒ 32 (SPEC-2-18).
  // -----------------------------------------------------------------------
  always_comb begin
    in_count  = (arg2_c == 5'd0) ? 6'd32 : 6'(arg2_c);
    out_count = (arg2_c == 5'd0) ? 6'd32 : 6'(arg2_c);
  end

  // -----------------------------------------------------------------------
  // Plain field assignments per class.
  // -----------------------------------------------------------------------
  assign jmp_cond    = arg1_c;
  assign jmp_addr    = arg2_c;

  assign wait_pol    = instr[7];      // SPEC-3.2-1
  assign wait_src    = instr[6:5];    // SPEC-3.2-2..5
  assign wait_index  = arg2_c;

  assign in_src      = arg1_c;
  assign out_dst     = arg1_c;

  assign push_iff    = instr[6];      // SPEC-3.5-1
  assign push_blk    = instr[5];
  assign pull_ife    = instr[6];      // SPEC-3.5-2
  assign pull_blk    = instr[5];

  assign aux_idxi    = instr[3];      // SPEC-3.7-4 / SPEC-14.2-1
  assign aux_index   = instr[1:0];

  assign mov_dst     = arg1_c;
  assign mov_src     = instr[2:0];    // SPEC-2-15
  assign mov_op      = instr[4:3];

  assign irq_clr     = instr[6];      // SPEC-3.8-1
  assign irq_wait    = instr[5];      // SPEC-3.8-2
  assign irq_idxmode = instr[4:3];    // SPEC-14.3-1 / SPEC-3.2-6
  assign irq_index   = instr[2:0];

  assign set_dst     = arg1_c;
  assign set_data    = arg2_c;

  // -----------------------------------------------------------------------
  // Class strobes + reserved-encoding decode.
  //
  // SPEC-13-1 reserved list, per class:
  //   WAIT: JMPPIN (src=11) with index[4:2] ≠ 0;
  //   IN:   sources 100/101 (SPEC-3.3-5);
  //   0x4:  arg2[4]=0 and arg2 ≠ 0 (SPEC-14.2-1); FIFO-aux with a
  //         nonzero b2 (fixed-0 field, SPEC-2-12/14) or with IdxI=0 and
  //         Index ≠ 0 (index comes from Y then, SPEC-3.7-4);
  //   MOV:  op 11 (SPEC-3.6-9 has none), src 100 (SPEC-3.6-5);
  //   IRQ:  modifier 3 = {Clr,Wait} == 11 (SPEC-3.8-3);
  //   SET:  dsts 011/101/110/111 (SPEC-3.9-2).
  // -----------------------------------------------------------------------
  always_comb begin
    is_jmp   = 1'b0;
    is_wait  = 1'b0;
    is_in    = 1'b0;
    is_out   = 1'b0;
    is_push  = 1'b0;
    is_pull  = 1'b0;
    is_put   = 1'b0;
    is_get   = 1'b0;
    is_mov   = 1'b0;
    is_irq   = 1'b0;
    is_set   = 1'b0;
    illegal  = 1'b0;

    case (class_c)
      3'b000: is_jmp  = 1'b1;                            // SPEC-2-7
      3'b001: begin                                      // SPEC-2-8
        is_wait = 1'b1;
        if (wait_src == 2'b11 && instr[4:2] != 3'b000)   // SPEC-13-1
          illegal = 1'b1;
      end
      3'b010: begin                                      // SPEC-2-9
        is_in = 1'b1;
        if (in_src == 3'b100 || in_src == 3'b101)        // SPEC-13-1
          illegal = 1'b1;
      end
      3'b011: is_out = 1'b1;                             // SPEC-2-10
      3'b100: begin                                      // SPEC-14.2-1
        if (arg2_c[4]) begin
          // FIFO-aux MOV: b7 distinguishes GET(1)/PUT(0) (SPEC-3.7-1/2).
          if (instr[7]) is_get = 1'b1;
          else           is_put = 1'b1;
          if (instr[2]                                        // SPEC-2-12/14
              || (!instr[3] && instr[1:0] != 2'b00))           // SPEC-13-1
            illegal = 1'b1;
        end else begin
          // PUSH (b7=0) / PULL (b7=1); the strobe still decodes for a
          // reserved nonzero arg2 — `illegal` marks it (SPEC-13-1,
          // SPEC-14.2-1), consistent with the other classes.
          if (instr[7]) is_pull = 1'b1;                  // SPEC-2-13
          else           is_push = 1'b1;                 // SPEC-2-11
          if (arg2_c != 5'd0)
            illegal = 1'b1;                              // SPEC-13-1
        end
      end
      3'b101: begin                                      // SPEC-2-15
        is_mov = 1'b1;
        if (mov_op == 2'b11 || mov_src == 3'b100)        // SPEC-13-1
          illegal = 1'b1;
      end
      3'b110: begin                                      // SPEC-2-16
        is_irq = 1'b1;
        if (instr[6:5] == 2'b11)                         // SPEC-3.8-3
          illegal = 1'b1;
      end
      default: begin                                     // SPEC-2-17
        is_set = 1'b1;
        if (set_dst == 3'b011 || set_dst == 3'b101
            || set_dst == 3'b110 || set_dst == 3'b111)   // SPEC-13-1
          illegal = 1'b1;
      end
    endcase
  end

endmodule

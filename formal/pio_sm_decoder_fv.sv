// Formal properties for pio_sm_decoder (KANBAN C4).
//
// The DUT is stateless, so every property is a combinational check over a
// free (anyconst) 16-bit instruction word and free side-set config:
//   P1  onehot: exactly one of the 12 strobes (11 instruction forms +
//       illegal) is high (SPEC-2-2 class space; SPEC-14.2-1 0x4 overload).
//   P2  decode is a pure function: outputs equal a reference truth-table
//       model (independent recomputation of the SPEC-2/SPEC-4 split).
//   P3  illegal iff a reserved encoding per the SPEC-13-1 list.
//   P4  bitcount 0 ⇒ 32 on IN and OUT (SPEC-2-18).
//   P5  delay/side-set split: delay + ss fit the 5-bit field and masks
//       per SPEC-4-1..3/4-9/14.8-1 (covered by P2's reference, spelled
//       out as width bounds: delay fits 5-ss_total bits, ss_val fits
//       ss_bits bits).
//
// Style note (owner convention): immediate assertions in
// `always @(posedge clk)`; formal-only file (never compiled by iverilog).
// With no DUT state, BMC depth 1 plus a shallow prove (k-induction over
// the only registers — the anyconst inputs) is sufficient.

module pio_sm_decoder_fv (
    input logic clk
);

  (* anyconst *) logic [15:0] instr;
  (* anyconst *) logic        side_en;
  (* anyconst *) logic [2:0]  sideset_count;

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

  // Config contract: SIDESET_COUNT is 0..5 (SPEC-4-3).
  always @(posedge clk) begin
    assume (sideset_count <= 3'd5);
  end

  // -----------------------------------------------------------------------
  // Reference truth-table model — an independent transcription of
  // SPEC-2-1..18 / SPEC-4-1..9 / SPEC-13-1 / SPEC-14.2-1.
  // -----------------------------------------------------------------------

  // SPEC-13-1 reserved-encoding predicate.
  function automatic logic ref_illegal(input logic [15:0] w);
    logic [2:0] cls;
    logic [2:0] a1;
    logic [4:0] a2;
    begin
      cls = w[15:13];
      a1  = w[7:5];
      a2  = w[4:0];
      case (cls)
        3'b001:   ref_illegal = (w[6:5] == 2'b11) && (w[4:2] != 3'b000);
        3'b010:   ref_illegal = (a1 == 3'b100) || (a1 == 3'b101);
        3'b100:   ref_illegal = a2[4]
                                ? (w[2] || (!w[3] && w[1:0] != 2'b00))
                                : (a2 != 5'd0);
        3'b101:   ref_illegal = (w[4:3] == 2'b11) || (w[2:0] == 3'b100);
        3'b110:   ref_illegal = (w[6:5] == 2'b11);
        3'b111:   ref_illegal = (a1 == 3'b011) || (a1 == 3'b101)
                                || (a1 == 3'b110) || (a1 == 3'b111);
        default:  ref_illegal = 1'b0;  // JMP / OUT: none reserved
      endcase
    end
  endfunction

  // Reference class strobes (SPEC-2-7..17, SPEC-14.2-1).
  function automatic logic ref_is(input logic [15:0] w,
                                  input logic [3:0]  which);
    // which: 0 jmp, 1 wait, 2 in, 3 out, 4 push, 5 pull, 6 put,
    //        7 get, 8 mov, 9 irq, 10 set
    logic [2:0] cls;
    begin
      cls = w[15:13];
      ref_is = 1'b0;
      case (cls)
        3'b000: ref_is = (which == 4'd0);
        3'b001: ref_is = (which == 4'd1);
        3'b010: ref_is = (which == 4'd2);
        3'b011: ref_is = (which == 4'd3);
        3'b100: begin
          if (w[4]) ref_is = w[7] ? (which == 4'd7) : (which == 4'd6);
          else      ref_is = w[7] ? (which == 4'd5) : (which == 4'd4);
        end
        3'b101: ref_is = (which == 4'd8);
        3'b110: ref_is = (which == 4'd9);
        3'b111: ref_is = (which == 4'd10);
      endcase
    end
  endfunction

  // Reference delay/side-set split (SPEC-4-1..3, SPEC-4-9, SPEC-14.8-1).
  function automatic logic [4:0] ref_delay(input logic [15:0] w,
                                           input logic        se,
                                           input logic [2:0]  sc);
    logic [4:0] f;
    begin
      f = w[12:8];
      ref_delay = f & (5'd31 >> sc);  // sc==0 keeps all 5 bits (SPEC-4-9)
    end
  endfunction

  function automatic logic ref_ss_valid(input logic [15:0] w,
                                        input logic        se,
                                        input logic [2:0]  sc);
    logic [4:0] f;
    logic [4:0] ssf;
    begin
      f   = w[12:8];
      ssf = f >> (3'd5 - sc);
      ref_ss_valid = (sc != 3'd0) && (!se || ssf[sc - 3'd1]);
    end
  endfunction

  function automatic logic [4:0] ref_ss_val(input logic [15:0] w,
                                            input logic        se,
                                            input logic [2:0]  sc);
    logic [4:0] f;
    logic [4:0] ssf;
    logic [2:0] vbits;
    begin
      f     = w[12:8];
      ssf   = f >> (3'd5 - sc);
      vbits = se ? (sc - 3'd1) : sc;
      ref_ss_val = ref_ss_valid(w, se, sc)
                   ? (ssf & (5'd31 >> (3'd5 - vbits))) : 5'd0;
    end
  endfunction

  // -----------------------------------------------------------------------
  // Properties.
  // -----------------------------------------------------------------------
  logic [10:0] class_strobes;
  assign class_strobes = {is_set, is_irq, is_get, is_put, is_pull,
                          is_push, is_out, is_in, is_wait, is_jmp, is_mov};

  always @(posedge clk) begin
    // P1: exactly one class strobe (SPEC-2-2, SPEC-14.2-1). `illegal`
    // is a separate flag and deliberately coexists with the would-be
    // class strobe of a reserved encoding (SPEC-13-1).
    a_p1_onehot : assert ($onehot(class_strobes));
    a_p1_exact  : assert (|class_strobes);
    a_p1_ill_cls : assert (!illegal || |class_strobes);

    // P2: decode equals the reference truth table (SPEC-2-1..18).
    a_p2_jmp   : assert (is_jmp  == ref_is(instr, 4'd0));
    a_p2_wait  : assert (is_wait == ref_is(instr, 4'd1));
    a_p2_in    : assert (is_in   == ref_is(instr, 4'd2));
    a_p2_out   : assert (is_out  == ref_is(instr, 4'd3));
    a_p2_push  : assert (is_push == ref_is(instr, 4'd4));
    a_p2_pull  : assert (is_pull == ref_is(instr, 4'd5));
    a_p2_put   : assert (is_put  == ref_is(instr, 4'd6));
    a_p2_get   : assert (is_get  == ref_is(instr, 4'd7));
    a_p2_mov   : assert (is_mov  == ref_is(instr, 4'd8));
    a_p2_irq   : assert (is_irq  == ref_is(instr, 4'd9));
    a_p2_set   : assert (is_set  == ref_is(instr, 4'd10));
    a_p2_flds  : assert (jmp_cond   == instr[7:5]      // SPEC-2-4
                       && jmp_addr  == instr[4:0]      // SPEC-2-7
                       && wait_pol  == instr[7]        // SPEC-3.2-1
                       && wait_src  == instr[6:5]      // SPEC-3.2-2..5
                       && wait_index == instr[4:0]
                       && in_src    == instr[7:5]      // SPEC-2-9
                       && out_dst   == instr[7:5]      // SPEC-2-10
                       && mov_dst   == instr[7:5]      // SPEC-2-15
                       && mov_src   == instr[2:0]
                       && mov_op    == instr[4:3]
                       && set_dst   == instr[7:5]      // SPEC-2-17
                       && set_data  == instr[4:0]
                       && push_iff  == instr[6]        // SPEC-3.5-1
                       && push_blk  == instr[5]
                       && pull_ife  == instr[6]        // SPEC-3.5-2
                       && pull_blk  == instr[5]
                       && aux_idxi  == instr[3]        // SPEC-14.2-1
                       && aux_index == instr[1:0]
                       && irq_clr   == instr[6]        // SPEC-3.8-1
                       && irq_wait  == instr[5]        // SPEC-3.8-2
                       && irq_idxmode == instr[4:3]    // SPEC-14.3-1
                       && irq_index == instr[2:0]);

    // P2 delay/ss split vs the independent reference (SPEC-4-1..9).
    a_p2_delay    : assert (delay == ref_delay(instr, side_en, sideset_count));
    a_p2_ss_valid : assert (ss_valid == ref_ss_valid(instr, side_en,
                                                     sideset_count));
    a_p2_ss_val   : assert (ss_val == ref_ss_val(instr, side_en,
                                                 sideset_count));

    // P3: illegal iff reserved (SPEC-13-1).
    a_p3 : assert (illegal == ref_illegal(instr));

    // P4: bitcount 0 ⇒ 32 (SPEC-2-18).
    a_p4_in  : assert (in_count  == ((instr[4:0] == 5'd0) ? 6'd32
                                                           : 6'(instr[4:0])));
    a_p4_out : assert (out_count == ((instr[4:0] == 5'd0) ? 6'd32
                                                           : 6'(instr[4:0])));

    // P5: width bounds (SPEC-4-3): delay fits below the side-set field,
    // ss_val fits ss_bits bits.
    a_p5_delay : assert ((delay >> (3'd5 - sideset_count)) == 5'd0);
    if (ss_valid)
      a_p5_ssval : assert (((ss_val >> ss_bits) == 5'd0));

    // Covers: each strobe and the illegal path reachable.
    if (is_jmp)  c_jmp  : cover (1'b1);
    if (is_wait) c_wait : cover (1'b1);
    if (is_in)   c_in   : cover (1'b1);
    if (is_out)  c_out  : cover (1'b1);
    if (is_push) c_push : cover (1'b1);
    if (is_pull) c_pull : cover (1'b1);
    if (is_put)  c_put  : cover (1'b1);
    if (is_get)  c_get  : cover (1'b1);
    if (is_mov)  c_mov  : cover (1'b1);
    if (is_irq)  c_irq  : cover (1'b1);
    if (is_set)  c_set  : cover (1'b1);
    if (illegal) c_ill  : cover (1'b1);
    if (ss_valid) c_ss  : cover (1'b1);
  end

endmodule

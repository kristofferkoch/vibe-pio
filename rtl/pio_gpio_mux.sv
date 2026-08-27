// pio_gpio_mux — block GPIO window: input synchronizers + per-SM input
// mapping, and output level/OE registers with priority resolution
// (KANBAN C7).
//
// Structure (DESIGN.md §pio_gpio_mux):
//   Input path — per-pin 2-FF synchronisers with a per-pin bypass mask
//   (SPEC-10-5, SPEC-7-7); the muxed "seen" bus feeds per-SM rotated and
//   IN_COUNT-masked `in_bus` (SPEC-10-3), per-SM `jmp_pin` selection, and
//   is exported as `gpio_seen` for WAIT GPIO (SPEC-10-4 absolute window
//   indices — the index math is the caller's, this module just windows).
//
//   Output path — one 32-bit level and one 32-bit OE register for the
//   block's pin window (SPEC-10-1). Per clk cycle, per pin, separately for
//   level and direction: within one SM side-set beats OUT/SET (CC-6);
//   across SMs the highest-numbered SM wins (CC-7); with no writer the
//   previous value holds. OUT/SET writes land in the executing tick
//   (CC-8), i.e. the registers are clk-rate single-edge state (CC-3).
//   OUT_STICKY (SPEC-7-18) re-asserts the most recent OUT/SET pin write on
//   every clk cycle, including stall and delay cycles and forced SET
//   writes (CC-5, SPEC-7-25); the sticky record lives here so the pin
//   registers have a single owner.
//
// Bundles: the caller (pio_sm exec, C8) drives the OUT/SET/side-set write
// bundles only on the executing tick cycle; count/base/data come from the
// SM's PINCTRL/EXECCTRL decode. OUT_COUNT==0 means 32 pins; SET_COUNT /
// SIDESET_COUNT == 0 means no pin write (SPEC-7-26).

module pio_gpio_mux (
    input  logic clk,
    input  logic rst,

    // Pad input window and per-pin synchroniser bypass (SPEC-7-7).
    input  logic [31:0] gpio_in,
    input  logic [31:0] sync_bypass,

    // Per-SM input mapping config (SPEC-10-3): rotate base and IN_COUNT
    // mask (0 = 32 / unmasked), plus JMP_PIN index (SPEC-7-16).
    input  logic [3:0][4:0] in_base,
    input  logic [3:0][4:0] in_count,
    input  logic [3:0][4:0] jmp_pin_idx,

    // Per-SM OUT write bundle (OUT PINS / OUT PINDIRS). pindir=1 targets
    // the OE register, pindir=0 the level register (SPEC-10-1).
    input  logic [3:0]      out_we,
    input  logic [3:0]      out_pindir,
    input  logic [3:0][4:0] out_base,
    input  logic [3:0][5:0] out_count,   // 0 = 32 (SPEC-7-26)
    input  logic [3:0][31:0] out_data,

    // Per-SM SET write bundle (SET PINS / SET PINDIRS; SET X never asserts
    // set_we). num==0 => no pin write (SPEC-7-26).
    input  logic [3:0]      set_we,
    input  logic [3:0]      set_pindir,
    input  logic [3:0][4:0] set_base,
    input  logic [3:0][2:0] set_num,
    input  logic [3:0][4:0] set_data,

    // Per-SM side-set bundle (applied every executing tick, CC-5).
    input  logic [3:0]      ss_we,
    input  logic [3:0]      ss_pindir,
    input  logic [3:0][4:0] ss_base,
    input  logic [3:0][2:0] ss_num,
    input  logic [3:0][4:0] ss_data,

    // Per-SM EXECCTRL.OUT_STICKY (SPEC-7-18).
    input  logic [3:0] sticky_en,

    // Output level / OE registers (SPEC-10-1) and their DBG_PADOUT/OE
    // readback (SPEC-7-8).
    output logic [31:0] gpio_out,
    output logic [31:0] gpio_oe,
    output logic [31:0] dbg_padout,
    output logic [31:0] dbg_padoe,

    // Per-SM input bus (SPEC-10-3) and JMP_PIN sample (start-of-tick
    // sampling is the caller's; these are the synchroniser outputs, CC-24).
    output logic [3:0][31:0] in_bus,
    output logic [3:0]       jmp_pin,
    // Muxed synchroniser outputs, for WAIT GPIO (SPEC-10-4).
    output logic [31:0]      gpio_seen,

    // Sticky-record readback (SPEC-7-18): the OUT_STICKY state is
    // internal, but unlike the sync FFs it holds unboundedly, so its
    // correctness is not observable through the pins within a bounded
    // window. Exposed like DBG_PADOUT/OE so formal properties stay
    // input/output equations (k-induction-friendly); pio_block leaves
    // these dangling.
    output logic [3:0][31:0] dbg_sticky_mask,
    output logic [3:0][31:0] dbg_sticky_lvl,
    output logic [3:0][31:0] dbg_sticky_dir,
    output logic [3:0]       dbg_sticky_isdir,

    // Per-SM this-clk pad write mask (C24 pad-ownership view): the pins
    // SM i writes this clk, level or direction, OUT/SET or side-set —
    // the same per-SM resolution inputs the CC-7 loop consumes, exported
    // so the browser client can attribute pad ownership (last writer,
    // highest-numbered SM on same-clk conflicts — CC-7's per-pin order).
    // pio_top leaves these dangling.
    output logic [3:0][31:0] dbg_wr_mask
);

  // -----------------------------------------------------------------------
  // Input path (CC-23).
  // -----------------------------------------------------------------------
  logic [31:0] sync1_r, sync2_r;

  always_ff @(posedge clk) begin
    if (rst) begin
      sync1_r <= '0;  // registers reset to 0 (DESIGN.md reset/formal)
      sync2_r <= '0;
    end else begin
      sync1_r <= gpio_in;
      sync2_r <= sync1_r;
    end
  end

  // Per-pin bypass mux (SPEC-10-5, SPEC-7-7): bypassed pins see sync1
  // (k+1 latency), synced pins see sync2 (k+2) — CC-23.
  always_comb begin
    for (int p = 0; p < 32; p++)
      gpio_seen[p] = sync_bypass[p] ? sync1_r[p] : sync2_r[p];
  end

  // Right-rotate by base: in_bus[j] = gpio_seen[(j + base) % 32] —
  // LSB = IN_BASE pin, wrap after 31 (SPEC-10-3).
  function automatic logic [31:0] ror32(input logic [31:0] v,
                                        input logic [4:0] s);
    ror32 = 32'({v, v} >> s);
  endfunction

  // Left-rotate by base: result[j] = v[(j - base) mod 32] — writer
  // placement puts data bit k on pin (base + k) % 32 with wrap
  // (SPEC-10-1); the input path's right-rotation above is the inverse
  // mapping.
  function automatic logic [31:0] rol32(input logic [31:0] v,
                                        input logic [4:0] s);
    rol32 = 32'({v, v} >> (6'd32 - {1'b0, s}));
  endfunction

  // IN_COUNT mask: pins above the count read 0; 0 = 32 / unmasked
  // (SPEC-10-3, SPEC-7-21).
  function automatic logic [31:0] count_mask(input logic [4:0] n);
    count_mask = (n == 5'd0) ? 32'hFFFF_FFFF : (32'hFFFF_FFFF >> (6'd32 - {1'b0, n}));
  endfunction

  always_comb begin
    for (int i = 0; i < 4; i++) begin
      in_bus[i] = ror32(gpio_seen, in_base[i]) & count_mask(in_count[i]);
      jmp_pin[i] = gpio_seen[jmp_pin_idx[i]];  // SPEC-7-16 JMP_PIN index
    end
  end

  // -----------------------------------------------------------------------
  // Output path (CC-6, CC-7, CC-8).
  // -----------------------------------------------------------------------
  // Per-SM resolved combinational writers: {mask, data} against the level
  // register (lvl) and the OE register (dir).
  logic [3:0][31:0] os_lvl_mask, os_lvl_data;
  logic [3:0][31:0] os_dir_mask, os_dir_data;
  logic [3:0][31:0] ss_lvl_mask, ss_lvl_data;
  logic [3:0][31:0] ss_dir_mask, ss_dir_data;

  // Place n data bits (n==0 => 32) of d at base with wrap (SPEC-10-1).
  function automatic logic [31:0] place_mask(input logic [4:0] base,
                                             input logic [5:0] n);
    // n==0 means 32 pins (SPEC-7-26); n>31 is outside PINCTRL's 0–32
    // range but is folded to the full window so the behaviour is total.
    place_mask = (n == 6'd0 || n > 6'd31) ? 32'hFFFF_FFFF
                             : rol32(32'hFFFF_FFFF >> (6'd32 - n), base);
  endfunction

  always_comb begin
    for (int i = 0; i < 4; i++) begin
      os_lvl_mask[i] = '0; os_lvl_data[i] = '0;
      os_dir_mask[i] = '0; os_dir_data[i] = '0;
      ss_lvl_mask[i] = '0; ss_lvl_data[i] = '0;
      ss_dir_mask[i] = '0; ss_dir_data[i] = '0;

      // OUT/SET write: one instruction per tick, so the bundles are
      // mutually exclusive per SM; combined into one "os" writer
      // (SPEC-10-1). OUT_COUNT==0 => 32 pins; SET num==0 => no write.
      if (out_we[i]) begin  // CC-8: lands in the executing tick
        if (out_pindir[i]) begin
          os_dir_mask[i] = place_mask(out_base[i], out_count[i]);
          os_dir_data[i] = rol32(out_data[i], out_base[i]) & os_dir_mask[i];
        end else begin
          os_lvl_mask[i] = place_mask(out_base[i], out_count[i]);
          os_lvl_data[i] = rol32(out_data[i], out_base[i]) & os_lvl_mask[i];
        end
      end else if (set_we[i] && set_num[i] != 3'd0) begin  // SPEC-7-26: SET_COUNT 0 = no write
        if (set_pindir[i]) begin
          os_dir_mask[i] = place_mask(set_base[i], {3'b0, set_num[i]});
          os_dir_data[i] = rol32({27'd0, set_data[i]}, set_base[i]) & os_dir_mask[i];
        end else begin
          os_lvl_mask[i] = place_mask(set_base[i], {3'b0, set_num[i]});
          os_lvl_data[i] = rol32({27'd0, set_data[i]}, set_base[i]) & os_lvl_mask[i];
        end
      end

      // Side-set writer (CC-5: fires in the instruction's first tick).
      if (ss_we[i] && ss_num[i] != 3'd0) begin  // SIDESET_COUNT 0 = none
        if (ss_pindir[i]) begin
          ss_dir_mask[i] = place_mask(ss_base[i], {3'b0, ss_num[i]});
          ss_dir_data[i] = rol32({27'd0, ss_data[i]}, ss_base[i]) & ss_dir_mask[i];
        end else begin
          ss_lvl_mask[i] = place_mask(ss_base[i], {3'b0, ss_num[i]});
          ss_lvl_data[i] = rol32({27'd0, ss_data[i]}, ss_base[i]) & ss_lvl_mask[i];
        end
      end
    end
  end

  // OUT_STICKY record (SPEC-7-18): the most recent OUT/SET pin write —
  // mask plus level/OE payloads and an is_dir qualifier (a write targets
  // level or direction, never both). Re-asserted on every clk cycle while
  // sticky_en (CC-5), also covering forced SET writes (SPEC-7-25: the
  // bundle is driven the same way).
  logic [3:0][31:0] sticky_mask_r, sticky_lvl_r, sticky_dir_data_r;
  logic [3:0]       sticky_is_dir_r;

  always_ff @(posedge clk) begin
    if (rst) begin
      sticky_mask_r    <= '0;
      sticky_lvl_r     <= '0;
      sticky_dir_data_r <= '0;
      sticky_is_dir_r  <= '0;
    end else begin
      for (int i = 0; i < 4; i++) begin
        if (out_we[i] || (set_we[i] && set_num[i] != 3'd0)) begin
          sticky_mask_r[i]    <= os_lvl_mask[i] | os_dir_mask[i];
          sticky_is_dir_r[i]  <= out_we[i] ? out_pindir[i] : set_pindir[i];
          if (out_we[i] ? out_pindir[i] : set_pindir[i])
            sticky_dir_data_r[i] <= os_dir_data[i];
          else
            sticky_lvl_r[i] <= os_lvl_data[i];
        end
      end
    end
  end

  // Per-pin priority resolution (CC-6 within SM: sticky/os applied first,
  // side-set last; CC-7 across SMs: ascending i, higher SM overrides;
  // no writer => hold — SPEC-10-2).
  logic [31:0] lvl_next_c, oe_next_c;
  logic [31:0] gpio_lvl_r, gpio_oe_r;

  always_comb begin
    lvl_next_c = gpio_lvl_r;
    oe_next_c  = gpio_oe_r;
    for (int i = 0; i < 4; i++) begin
      if (sticky_en[i] && !sticky_is_dir_r[i]) begin  // CC-5 re-assert
        lvl_next_c = (lvl_next_c & ~sticky_mask_r[i]) | sticky_lvl_r[i];
      end
      if (sticky_en[i] && sticky_is_dir_r[i]) begin
        oe_next_c = (oe_next_c & ~sticky_mask_r[i]) | sticky_dir_data_r[i];
      end
      // OUT/SET writer.
      lvl_next_c = (lvl_next_c & ~os_lvl_mask[i]) | os_lvl_data[i];
      oe_next_c  = (oe_next_c & ~os_dir_mask[i]) | os_dir_data[i];
      // Side-set beats OUT/SET and sticky on overlapping pins (CC-6).
      lvl_next_c = (lvl_next_c & ~ss_lvl_mask[i]) | ss_lvl_data[i];
      oe_next_c  = (oe_next_c & ~ss_dir_mask[i]) | ss_dir_data[i];
    end
  end

  always_ff @(posedge clk) begin
    if (rst) begin
      gpio_lvl_r <= '0;  // SPEC-10-1 registers reset to 0
      gpio_oe_r  <= '0;
    end else begin
      gpio_lvl_r <= lvl_next_c;
      gpio_oe_r  <= oe_next_c;
    end
  end

  assign gpio_out   = gpio_lvl_r;
  assign gpio_oe    = gpio_oe_r;
  assign dbg_padout = gpio_lvl_r;  // SPEC-7-8 readback
  assign dbg_padoe  = gpio_oe_r;

  assign dbg_sticky_mask   = sticky_mask_r;
  assign dbg_sticky_lvl    = sticky_lvl_r;
  assign dbg_sticky_dir    = sticky_dir_data_r;
  assign dbg_sticky_isdir  = sticky_is_dir_r;

  // C24 pad-ownership view: the per-SM write masks the CC-7 loop below
  // consumes, one hot pin set per SM.
  always_comb begin
    for (int i = 0; i < 4; i++)
      dbg_wr_mask[i] = os_lvl_mask[i] | os_dir_mask[i] | ss_lvl_mask[i] | ss_dir_mask[i];
  end

endmodule

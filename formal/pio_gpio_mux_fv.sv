// Formal properties for pio_gpio_mux (KANBAN C7).
//
// Wrapper instantiates the DUT and checks (bmc + prove). Assertions
// sample post-edge state (Q@k, and p_*@k = inputs of edge k), so every
// property is an equation over inputs, outputs and the DUT's own
// registered state read back through its ports — k-induction-friendly
// (the sticky records are exposed as dbg_sticky_* exactly for this;
// hidden held state cannot be pinned by induction through pins alone).
//
//   P1  reset defaults: seen bus, output level/OE registers and sticky
//       records are 0 after reset (SPEC-10-1, SPEC-7-18).
//   P2  sync shift-register equivalence (CC-23): gpio_seen equals the
//       per-pin bypass mux over a reference 2-FF chain of gpio_in —
//       pad@k captured at k+1, seen from k+2 (k+1 bypassed). Absolute
//       latency is pinned by the directed TB (T2); this pins the DUT
//       registers to the reference chain.
//   P3  output resolution (CC-6/CC-7/SPEC-10-2): gpio_out/gpio_oe equal a
//       reference per-pin resolution over the previous cycle's write
//       bundles, the previous register values and the previous sticky
//       record — per pin, separately for level/direction: sticky/os
//       writers in ascending SM order, side-set last within an SM
//       (CC-6), highest SM wins (CC-7), hold with no writer; the sticky
//       term re-asserts the record (CC-5, SPEC-7-18).
//   P4  OUT_STICKY record (SPEC-7-18): dbg_sticky_* equals the previous
//       cycle's OUT/SET write placement — SET num 0 writes nothing
//       (SPEC-7-26) — and holds otherwise.
//   P5  DBG_PADOUT/OE readback equals the output registers (SPEC-7-8).
//
// Style note: the reference model is procedural always_comb code, not
// functions — yosys classifies functions called with unrolled constant
// arguments as constant functions and rejects their references to module
// state.
//
// Assumption: reset asserted in the initial state (CC-1 protocol).

module pio_gpio_mux_fv (
    input  logic clk,
    input  logic rst,
    input  logic [31:0] gpio_in,
    input  logic [31:0] sync_bypass,
    input  logic [3:0][4:0] in_base,
    input  logic [3:0][4:0] in_count,
    input  logic [3:0][4:0] jmp_pin_idx,
    input  logic [3:0] out_we,
    input  logic [3:0] out_pindir,
    input  logic [3:0][4:0] out_base,
    input  logic [3:0][5:0] out_count,
    input  logic [3:0][31:0] out_data,
    input  logic [3:0] set_we,
    input  logic [3:0] set_pindir,
    input  logic [3:0][4:0] set_base,
    input  logic [3:0][2:0] set_num,
    input  logic [3:0][4:0] set_data,
    input  logic [3:0] ss_we,
    input  logic [3:0] ss_pindir,
    input  logic [3:0][4:0] ss_base,
    input  logic [3:0][2:0] ss_num,
    input  logic [3:0][4:0] ss_data,
    input  logic [3:0] sticky_en
);

  logic [31:0] gpio_out, gpio_oe, dbg_padout, dbg_padoe, gpio_seen;
  logic [3:0][31:0] in_bus;
  logic [3:0] jmp_pin;
  logic [3:0][31:0] dbg_sticky_mask, dbg_sticky_lvl, dbg_sticky_dir;
  logic [3:0] dbg_sticky_isdir;

  pio_gpio_mux u_dut (
      .clk (clk), .rst (rst),
      .gpio_in (gpio_in), .sync_bypass (sync_bypass),
      .in_base (in_base), .in_count (in_count), .jmp_pin_idx (jmp_pin_idx),
      .out_we (out_we), .out_pindir (out_pindir),
      .out_base (out_base), .out_count (out_count), .out_data (out_data),
      .set_we (set_we), .set_pindir (set_pindir),
      .set_base (set_base), .set_num (set_num), .set_data (set_data),
      .ss_we (ss_we), .ss_pindir (ss_pindir),
      .ss_base (ss_base), .ss_num (ss_num), .ss_data (ss_data),
      .sticky_en (sticky_en),
      .gpio_out (gpio_out), .gpio_oe (gpio_oe),
      .dbg_padout (dbg_padout), .dbg_padoe (dbg_padoe),
      .in_bus (in_bus), .jmp_pin (jmp_pin), .gpio_seen (gpio_seen),
      .dbg_sticky_mask (dbg_sticky_mask), .dbg_sticky_lvl (dbg_sticky_lvl),
      .dbg_sticky_dir (dbg_sticky_dir), .dbg_sticky_isdir (dbg_sticky_isdir)
  );

  // A1: reset protocol (CC-1).
  always @(posedge clk) begin
    if ($initstate) assume (rst);
  end

  // -----------------------------------------------------------------------
  // Previous-cycle registers (explicit $past replacement): inputs of the
  // edge that produced the outputs under check.
  // -----------------------------------------------------------------------
  logic            p_rst_r = 1'b1;
  logic [3:0]      p_out_we_r = '0;
  logic [3:0]      p_out_pindir_r = '0;
  logic [3:0][4:0] p_out_base_r = '0;
  logic [3:0][5:0] p_out_count_r = '0;
  logic [3:0][31:0] p_out_data_r = '0;
  logic [3:0]      p_set_we_r = '0;
  logic [3:0]      p_set_pindir_r = '0;
  logic [3:0][4:0] p_set_base_r = '0;
  logic [3:0][2:0] p_set_num_r = '0;
  logic [3:0][4:0] p_set_data_r = '0;
  logic [3:0]      p_ss_we_r = '0;
  logic [3:0]      p_ss_pindir_r = '0;
  logic [3:0][4:0] p_ss_base_r = '0;
  logic [3:0][2:0] p_ss_num_r = '0;
  logic [3:0][4:0] p_ss_data_r = '0;
  logic [3:0]      p_sticky_en_r = '0;
  logic [31:0]     p_lvl_r = '0;
  logic [31:0]     p_oe_r = '0;
  // The sticky record as it stood entering the producing edge (SPEC-7-18).
  logic [3:0][31:0] p_st_mask_r = '0;
  logic [3:0][31:0] p_st_lvl_r = '0;
  logic [3:0][31:0] p_st_dir_r = '0;
  logic [3:0]       p_st_isdir_r = '0;

  always_ff @(posedge clk) begin
    p_rst_r         <= rst;
    p_out_we_r      <= out_we;
    p_out_pindir_r  <= out_pindir;
    p_out_base_r    <= out_base;
    p_out_count_r   <= out_count;
    p_out_data_r    <= out_data;
    p_set_we_r      <= set_we;
    p_set_pindir_r  <= set_pindir;
    p_set_base_r    <= set_base;
    p_set_num_r     <= set_num;
    p_set_data_r    <= set_data;
    p_ss_we_r       <= ss_we;
    p_ss_pindir_r   <= ss_pindir;
    p_ss_base_r     <= ss_base;
    p_ss_num_r      <= ss_num;
    p_ss_data_r     <= ss_data;
    p_sticky_en_r   <= sticky_en;
    p_lvl_r         <= gpio_out;
    p_oe_r          <= gpio_oe;
    p_st_mask_r     <= dbg_sticky_mask;
    p_st_lvl_r      <= dbg_sticky_lvl;
    p_st_dir_r      <= dbg_sticky_dir;
    p_st_isdir_r    <= dbg_sticky_isdir;
  end

  // -----------------------------------------------------------------------
  // P2 reference: the 2-FF synchroniser chain of gpio_in (CC-23). Pure
  // input-delay state — flushed within two steps, so the equivalence is
  // inductive.
  // -----------------------------------------------------------------------
  logic [31:0] m_sync1_r, m_sync2_r, ref_seen_c;

  always_ff @(posedge clk) begin
    if (rst) begin
      m_sync1_r <= '0;
      m_sync2_r <= '0;
    end else begin
      m_sync1_r <= gpio_in;
      m_sync2_r <= m_sync1_r;
    end
  end

  always_comb begin
    for (int p = 0; p < 32; p++)  // CC-23: bypassed pins read stage 1
      ref_seen_c[p] = sync_bypass[p] ? m_sync1_r[p] : m_sync2_r[p];
  end

  // -----------------------------------------------------------------------
  // Reference resolution and placement. Pin p is hit by (base, n) when
  // its forward distance to base, mod 32, is < n; OUT with count 0 (or
  // >31, outside PINCTRL's 0–32 range) hits all 32 pins, SET/side-set
  // num 0 hits none (SPEC-7-26). Forward distance (p + 32 - base) is in
  // [1,63], so truncating to 5 bits is the mod-32 distance.
  // -----------------------------------------------------------------------
  logic [31:0] ref_lvl_c, ref_dir_c;
  logic [4:0]  base;
  logic [5:0]  n;
  logic [31:0] data;
  logic [4:0]  dist;
  logic        hit;

  // P4 next-value reference for the sticky record (SPEC-7-18).
  logic [3:0][31:0] st_mask_n, st_lvl_n, st_dir_n;
  logic [3:0]       st_isdir_n, st_wr_n;

  always_comb begin
    // Defaults for the shared placement temps (yosys latch check).
    base = 5'd0; n = 6'd0; data = '0; dist = 5'd0; hit = 1'b0;

    // --- P3: per-pin resolution over the previous cycle's bundles
    // (CC-6/CC-7/SPEC-10-2), sticky term via the record that entered the
    // producing edge (CC-5, SPEC-7-18). ---
    ref_lvl_c = p_lvl_r;
    ref_dir_c = p_oe_r;
    for (int i = 0; i < 4; i++) begin
      if (p_sticky_en_r[i] && !p_st_isdir_r[i])
        ref_lvl_c = (ref_lvl_c & ~p_st_mask_r[i]) | p_st_lvl_r[i];
      if (p_sticky_en_r[i] && p_st_isdir_r[i])
        ref_dir_c = (ref_dir_c & ~p_st_mask_r[i]) | p_st_dir_r[i];

      // OUT writer (CC-8).
      if (p_out_we_r[i] && !p_out_pindir_r[i]) begin
        base = p_out_base_r[i]; n = p_out_count_r[i]; data = p_out_data_r[i];
        for (int p = 0; p < 32; p++) begin
          dist = 5'(32'(p) + 32'd32 - {27'd0, base});
          hit  = (n == 6'd0 || n > 6'd31) || ({1'b0, dist} < n);
          if (hit) ref_lvl_c[p] = data[{1'b0, dist}];
        end
      end
      if (p_out_we_r[i] && p_out_pindir_r[i]) begin
        base = p_out_base_r[i]; n = p_out_count_r[i]; data = p_out_data_r[i];
        for (int p = 0; p < 32; p++) begin
          dist = 5'(32'(p) + 32'd32 - {27'd0, base});
          hit  = (n == 6'd0 || n > 6'd31) || ({1'b0, dist} < n);
          if (hit) ref_dir_c[p] = data[{1'b0, dist}];
        end
      end
      // SET writer (SPEC-7-26: num 0 writes nothing).
      if (!p_out_we_r[i] && p_set_we_r[i] && !p_set_pindir_r[i]
          && p_set_num_r[i] != 3'd0) begin
        base = p_set_base_r[i]; n = {3'b0, p_set_num_r[i]};
        data = {27'd0, p_set_data_r[i]};
        for (int p = 0; p < 32; p++) begin
          dist = 5'(32'(p) + 32'd32 - {27'd0, base});
          if ({1'b0, dist} < n) ref_lvl_c[p] = data[{1'b0, dist}];
        end
      end
      if (!p_out_we_r[i] && p_set_we_r[i] && p_set_pindir_r[i]
          && p_set_num_r[i] != 3'd0) begin
        base = p_set_base_r[i]; n = {3'b0, p_set_num_r[i]};
        data = {27'd0, p_set_data_r[i]};
        for (int p = 0; p < 32; p++) begin
          dist = 5'(32'(p) + 32'd32 - {27'd0, base});
          if ({1'b0, dist} < n) ref_dir_c[p] = data[{1'b0, dist}];
        end
      end
      // Side-set beats OUT/SET and sticky within the SM (CC-6).
      if (p_ss_we_r[i] && !p_ss_pindir_r[i] && p_ss_num_r[i] != 3'd0) begin
        base = p_ss_base_r[i]; n = {3'b0, p_ss_num_r[i]};
        data = {27'd0, p_ss_data_r[i]};
        for (int p = 0; p < 32; p++) begin
          dist = 5'(32'(p) + 32'd32 - {27'd0, base});
          if ({1'b0, dist} < n) ref_lvl_c[p] = data[{1'b0, dist}];
        end
      end
      if (p_ss_we_r[i] && p_ss_pindir_r[i] && p_ss_num_r[i] != 3'd0) begin
        base = p_ss_base_r[i]; n = {3'b0, p_ss_num_r[i]};
        data = {27'd0, p_ss_data_r[i]};
        for (int p = 0; p < 32; p++) begin
          dist = 5'(32'(p) + 32'd32 - {27'd0, base});
          if ({1'b0, dist} < n) ref_dir_c[p] = data[{1'b0, dist}];
        end
      end
    end

    // --- P4: expected next sticky record over the current cycle's write
    // (same placement as the writers above) — payload registers update
    // only the targeted copy, everything else holds (SPEC-7-18; num-0
    // SET writes nothing, SPEC-7-26). ---
    for (int i = 0; i < 4; i++) begin
      // A write replaces the whole record (mask and targeted payload,
      // non-hit payload bits read 0); without a write everything holds
      // (SPEC-7-18 "most recent").
      st_wr_n[i] = p_out_we_r[i] || (p_set_we_r[i] && p_set_num_r[i] != 3'd0);
      st_isdir_n[i] = st_wr_n[i]
                      ? (p_out_we_r[i] ? p_out_pindir_r[i] : p_set_pindir_r[i])
                      : p_st_isdir_r[i];
      st_mask_n[i] = st_wr_n[i] ? '0 : p_st_mask_r[i];
      st_lvl_n[i]  = (st_wr_n[i] && !st_isdir_n[i]) ? '0 : p_st_lvl_r[i];
      st_dir_n[i]  = (st_wr_n[i] &&  st_isdir_n[i]) ? '0 : p_st_dir_r[i];
      if (st_wr_n[i]) begin
        if (p_out_we_r[i]) begin
          base = p_out_base_r[i]; n = p_out_count_r[i]; data = p_out_data_r[i];
        end else begin
          base = p_set_base_r[i]; n = {3'b0, p_set_num_r[i]};
          data = {27'd0, p_set_data_r[i]};
        end
        for (int p = 0; p < 32; p++) begin
          dist = 5'(32'(p) + 32'd32 - {27'd0, base});
          hit  = (n == 6'd0 || n > 6'd31) || ({1'b0, dist} < n);
          if (hit) begin
            st_mask_n[i][p] = 1'b1;
            if (st_isdir_n[i]) st_dir_n[i][p] = data[{1'b0, dist}];
            else               st_lvl_n[i][p] = data[{1'b0, dist}];
          end
        end
      end
    end
  end

  always @(posedge clk) begin
    if (!$initstate) begin
      // P5: DBG readback (SPEC-7-8).
      a_p5 : assert (dbg_padout == gpio_out && dbg_padoe == gpio_oe);

      // P1: reset defaults (SPEC-10-1, SPEC-7-18).
      if (p_rst_r) begin
        a_p1_seen : assert (gpio_seen == 32'd0);
        a_p1_out  : assert (gpio_out == 32'd0 && gpio_oe == 32'd0);
        a_p1_st   : assert (dbg_sticky_mask == '0 && dbg_sticky_lvl == '0
                            && dbg_sticky_dir == '0 && dbg_sticky_isdir == '0);
      end

      if (!p_rst_r) begin
        // P2: sync shift-register equivalence (CC-23).
        a_p2_seen : assert (gpio_seen == ref_seen_c);

        // P3: output resolution matches the reference per-pin resolution
        // (CC-6/CC-7/SPEC-10-2; CC-5 sticky term).
        a_p3_lvl : assert (gpio_out == ref_lvl_c);
        a_p3_dir : assert (gpio_oe  == ref_dir_c);

        // P4: sticky record equals the expected capture/hold next-state
        // (SPEC-7-18; SPEC-7-26 num-0 exclusion folds into st_wr_n).
        a_p4_mask  : assert (dbg_sticky_mask  == st_mask_n);
        a_p4_lvl   : assert (dbg_sticky_lvl   == st_lvl_n);
        a_p4_dir   : assert (dbg_sticky_dir   == st_dir_n);
        a_p4_isdir : assert (dbg_sticky_isdir == st_isdir_n);
      end

      // Covers.
      if (gpio_out == 32'hFFFF_FFFF) c_all_lvl : cover (1'b1);
      if (gpio_out != p_lvl_r) c_write : cover (1'b1);
      if (p_ss_we_r[0] && p_out_we_r[0]) c_ss_vs_out : cover (1'b1);
      if (p_out_we_r[0] && p_out_we_r[3]) c_sm_conflict : cover (1'b1);
      if (p_sticky_en_r[0] && !p_out_we_r[0] && !p_set_we_r[0]) c_sticky : cover (1'b1);
    end
  end

endmodule

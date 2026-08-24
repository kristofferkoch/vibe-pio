// pio_sm_regs — per-SM config field bank + clk-rate clock divider
// (KANBAN C5).
//
// Two jobs (DESIGN.md §pio_sm_regs):
//   1. Banked config registers CLKDIV / EXECCTRL / SHIFTCTRL / PINCTRL
//      ([SPEC-7-14..26]) as register-level write ports with datasheet
//      reset defaults, decoded field outputs. Writes take effect
//      immediately ([SPEC-7-25]): new fields are visible to consumers
//      the cycle after the write retires, and to the divider from the
//      next clk edge.
//   2. The SM clock divider: an 8-bit fractional phase accumulator plus
//      a period counter producing the one-clk `sm_tick` strobe, with
//      `clkdiv_restart` (CC-27), SM enable gating, INT=0 ⇒ 65536 with
//      FRAC forced 0 ([SPEC-7-14]), and force-tick deferral (CC-36).
//
// Divider model note: CC-26 (as amended) defines the exact first-order
// delta-sigma — the fractional error accumulates once per *period*: at
// each terminal count, phase += FRAC; carry ⇒ the next period is INT+1
// instead of INT (stretch). CC-26's original v1 wording ("phase += FRAC;
// count += 1 + carry" per clk) was rejected there: it yields an average
// period of INT/(1+FRAC/256) — FRAC *speeds the SM up* and admits
// periods below INT — contradicting both the sourced average SM clock =
// clk/(INT + FRAC/256) ([SPEC-7-14]) and CC-25's min-gap guarantee
// ("alternates periods of INT and INT+1"). This implementation satisfies
// CC-25 (periods ∈ {INT, INT+1}, so consecutive ticks are ≥ INT clk
// apart), the sourced frequency formula, and CC-26's placement (tick
// strobe the cycle after terminal count, INT=0 ⇒ 65536/FRAC 0, restart
// clears phase+count, free-running through stalls).

module pio_sm_regs (
    input  logic        clk,
    input  logic        rst,

    // Register-level write ports (from the block reg decode, clk-rate
    // one-cycle strobes; a write retires at the clk edge — CC-33's
    // boundary at block level).
    input  logic        clkdiv_we,
    input  logic [31:0] clkdiv_wdata,   // SMx_CLKDIV layout [SPEC-7-14]
    input  logic        execctrl_we,
    input  logic [31:0] execctrl_wdata, // SMx_EXECCTRL layout [SPEC-7-16..20]
    input  logic        shiftctrl_we,
    input  logic [31:0] shiftctrl_wdata,// SMx_SHIFTCTRL layout [SPEC-7-21]
    input  logic        pinctrl_we,
    input  logic [31:0] pinctrl_wdata,  // SMx_PINCTRL layout [SPEC-7-26]

    // Control (from CTRL, [SPEC-7-2]).
    input  logic        sm_en,           // SM_ENABLE bit
    input  logic        clkdiv_restart,  // CTRL.CLKDIV_RESTART pulse (CC-27)
    input  logic        force_tick,      // forced-instruction tick (CC-36)

    // Tick strobe: one clk wide, asserted the cycle after terminal
    // count (CC-26). Deferred one clk when coinciding with force_tick
    // (CC-36). Never asserted while the SM is disabled.
    output logic        sm_tick,
    // Readbacks for formal / exec (C8): a terminal count is pending
    // (sm_tick would fire absent force_tick / disable), and the latched
    // length in clk cycles of the period ending at that pending tick.
    output logic        tick_pending,
    output logic [16:0] sm_tick_period,
    // Divider state readback (formal: CC-27 restart check, bounds,
    // lockstep closure).
    output logic [7:0]  dbg_phase,
    output logic [16:0] dbg_count,
    output logic        dbg_stretch,

    // Decoded CLKDIV fields (raw register contents; the divider
    // interprets INT=0 as 65536 / FRAC as 0 internally, SPEC-7-14).
    output logic [15:0] clkdiv_int,      // [31:16]
    output logic [7:0]  clkdiv_frac,     // [15:8]

    // Raw register readbacks for the block reg bus (C10: SMx_CLKDIV/
    // EXECCTRL/SHIFTCTRL/PINCTRL are RW — the datasheet map is
    // byte-faithful). pio_sm re-exports them; single owner stays here.
    output logic [31:0] clkdiv_q,
    output logic [31:0] execctrl_q,
    output logic [31:0] shiftctrl_q,
    output logic [31:0] pinctrl_q,

    // Decoded EXECCTRL fields.
    output logic        side_en,         // [30]      SPEC-7-16
    output logic        side_pindir,     // [29]      SPEC-7-16
    output logic [4:0]  jmp_pin,         // [28:24]   SPEC-7-16
    output logic [4:0]  out_en_sel,      // [23:19]   SPEC-7-17
    output logic        inline_out_en,   // [18]      SPEC-7-17
    output logic        out_sticky,      // [17]      SPEC-7-18
    output logic [4:0]  wrap_top,        // [16:12]   SPEC-7-19
    output logic [4:0]  wrap_bottom,     // [11:7]    SPEC-7-19
    output logic [1:0]  status_sel,      // [6:5]     SPEC-7-20
    output logic [4:0]  status_n,        // [4:0]     SPEC-7-20

    // Decoded SHIFTCTRL fields.
    output logic        fjoin_rx,        // [31]      SPEC-7-21
    output logic        fjoin_tx,        // [30]      SPEC-7-21
    output logic [4:0]  pull_thresh,     // [29:25]   SPEC-7-21
    output logic [4:0]  push_thresh,     // [24:20]   SPEC-7-21
    // SHIFTDIR: 1 = right (reset default) — exported as the DESIGN.md
    // `shift_left` boolean (0 = right).
    output logic        out_shift_left,  // ~[19]
    output logic        in_shift_left,   // ~[18]
    output logic        autopull,        // [17]      SPEC-7-21
    output logic        autopush,        // [16]      SPEC-7-21
    output logic        fjoin_rx_put,    // [15]      SPEC-7-21
    output logic        fjoin_rx_get,    // [14]      SPEC-7-21
    output logic [4:0]  in_mask_count,   // [4:0] IN_COUNT, SPEC-7-21

    // Decoded PINCTRL fields.
    output logic [2:0]  sideset_count,   // [31:29]   SPEC-7-26
    output logic [2:0]  set_count,       // [28:26]   SPEC-7-26
    output logic [5:0]  out_count,       // [25:20]   SPEC-7-26
    output logic [4:0]  in_base,         // [19:15]   SPEC-7-26
    output logic [4:0]  sideset_base,    // [14:10]   SPEC-7-26
    output logic [4:0]  set_base,        // [9:5]     SPEC-7-26
    output logic [4:0]  out_base         // [4:0]     SPEC-7-26
);

  // -----------------------------------------------------------------------
  // Config banks — raw 32-bit registers with datasheet reset defaults,
  // one always_ff per register group (DESIGN.md conventions).
  // -----------------------------------------------------------------------
  localparam logic [31:0] CLKDIV_RESET    = 32'h0001_0000; // INT=1 FRAC=0 (div 1)
  localparam logic [31:0] EXECCTRL_RESET  = 32'h0000_1fff; // WRAP_TOP=1, WRAP_BOTTOM=31, STATUS_N=31
  localparam logic [31:0] SHIFTCTRL_RESET = 32'h000c_0000; // OUT/IN SHIFTDIR=1 (right)
  localparam logic [31:0] PINCTRL_RESET   = 32'h1400_0000; // SET_COUNT=5

  logic [31:0] clkdiv_r;
  logic [31:0] execctrl_r;
  logic [31:0] shiftctrl_r;
  logic [31:0] pinctrl_r;

  always_ff @(posedge clk) begin
    if (rst)                      clkdiv_r <= CLKDIV_RESET;
    else if (clkdiv_we)           clkdiv_r <= clkdiv_wdata;
  end

  always_ff @(posedge clk) begin
    if (rst)                      execctrl_r <= EXECCTRL_RESET;
    else if (execctrl_we)         execctrl_r <= execctrl_wdata;
  end

  always_ff @(posedge clk) begin
    if (rst)                      shiftctrl_r <= SHIFTCTRL_RESET;
    else if (shiftctrl_we)        shiftctrl_r <= shiftctrl_wdata;
  end

  always_ff @(posedge clk) begin
    if (rst)                      pinctrl_r <= PINCTRL_RESET;
    else if (pinctrl_we)          pinctrl_r <= pinctrl_wdata;
  end

  // Field decode (SPEC-7-14..26 bit positions).
  assign clkdiv_q       = clkdiv_r;
  assign execctrl_q     = execctrl_r;
  assign shiftctrl_q    = shiftctrl_r;
  assign pinctrl_q      = pinctrl_r;
  assign clkdiv_int     = clkdiv_r[31:16];
  assign clkdiv_frac    = clkdiv_r[15:8];

  assign side_en        = execctrl_r[30];
  assign side_pindir    = execctrl_r[29];
  assign jmp_pin        = execctrl_r[28:24];
  assign out_en_sel     = execctrl_r[23:19];
  assign inline_out_en  = execctrl_r[18];
  assign out_sticky     = execctrl_r[17];
  assign wrap_top       = execctrl_r[16:12];
  assign wrap_bottom    = execctrl_r[11:7];
  assign status_sel     = execctrl_r[6:5];
  assign status_n       = execctrl_r[4:0];

  assign fjoin_rx       = shiftctrl_r[31];
  assign fjoin_tx       = shiftctrl_r[30];
  assign pull_thresh    = shiftctrl_r[29:25];
  assign push_thresh    = shiftctrl_r[24:20];
  assign out_shift_left = ~shiftctrl_r[19];  // SHIFTDIR 1 = right
  assign in_shift_left  = ~shiftctrl_r[18];  // SHIFTDIR 1 = right
  assign autopull       = shiftctrl_r[17];
  assign autopush       = shiftctrl_r[16];
  assign fjoin_rx_put   = shiftctrl_r[15];
  assign fjoin_rx_get   = shiftctrl_r[14];
  assign in_mask_count  = shiftctrl_r[4:0];

  assign sideset_count  = pinctrl_r[31:29];
  assign set_count      = pinctrl_r[28:26];
  assign out_count      = pinctrl_r[25:20];
  assign in_base        = pinctrl_r[19:15];
  assign sideset_base   = pinctrl_r[14:10];
  assign set_base       = pinctrl_r[9:5];
  assign out_base       = pinctrl_r[4:0];

  // -----------------------------------------------------------------------
  // Clock divider (clk-rate logic; CC-26 placement, CC-25 gap, CC-27
  // restart, CC-28 independence — one instance per SM by construction).
  //
  // State:
  //   phase_r    8-bit fractional accumulator, += FRAC at each terminal
  //              count (delta-sigma; see model note above).
  //   stretch_r  carry from the last terminal ⇒ current period is
  //              INT+1 instead of INT (CC-25: periods alternate
  //              INT / INT+1).
  //   count_r    clks into the current period (0..65535).
  //   pending_r  terminal count reached at the end of the previous clk
  //              ⇒ sm_tick this clk cycle (CC-26).
  //   latch_r    length of the period ending at the pending tick (the
  //              actual count_r+1, ≥ target even if INT was written
  //              smaller mid-period) — formal readback.
  // -----------------------------------------------------------------------
  logic [7:0]  phase_r;
  logic        stretch_r;
  logic [16:0] count_r;
  logic        pending_r;
  logic [16:0] latch_r;

  // INT=0 ⇒ 65536, FRAC forced 0 (SPEC-7-14).
  logic [16:0] int_eff_c;
  logic [7:0]  frac_eff_c;
  always_comb begin
    int_eff_c  = (clkdiv_int == '0) ? 17'd65536 : {1'b0, clkdiv_int};
    frac_eff_c = (clkdiv_int == '0) ? 8'd0      : clkdiv_frac;
  end

  logic [16:0] target_c;      // current period length INT(+1)
  logic        terminal_c;    // count reaches target this clk (CC-26)
  logic [7:0]  phase_next_c;  // phase after this terminal's += FRAC
  logic        phase_carry_c; // delta-sigma carry ⇒ next period INT+1
  always_comb begin
    // A leftover stretch=1 (set under INT≠0) is ignored while INT=0:
    // FRAC is forced 0 there, so a fractional stretch is meaningless
    // (SPEC-7-14) and the period must be exactly 65536.
    target_c      = int_eff_c + {16'd0, stretch_r & (clkdiv_int != '0)};
    terminal_c    = sm_en && (count_r >= target_c - 17'd1);
    {phase_carry_c, phase_next_c} = {1'b0, phase_r} + {1'b0, frac_eff_c};
  end

  // CC-36: force_tick coinciding with a pending sm_tick defers the tick
  // to the next clk cycle; the divider phase/schedule is untouched.
  assign sm_tick        = sm_en && pending_r && !force_tick;
  assign tick_pending   = pending_r;
  assign sm_tick_period = latch_r;
  assign dbg_phase      = phase_r;
  assign dbg_count      = count_r;
  assign dbg_stretch    = stretch_r;

  always_ff @(posedge clk) begin
    if (rst) begin
      phase_r    <= '0;
      stretch_r  <= 1'b0;
      count_r    <= '0;
      pending_r  <= 1'b0;
      latch_r    <= '0;
    end else if (clkdiv_restart) begin
      // CC-27: restart resets phase and count to 0 (cancelling a
      // pending tick); the next tick comes the canonical period later.
      phase_r    <= '0;
      stretch_r  <= 1'b0;
      count_r    <= '0;
      pending_r  <= 1'b0;
      latch_r    <= '0;
    end else if (sm_en) begin
      // Free-running while enabled (CC-28); frozen while disabled
      // (SPEC-7-2: SM_ENABLE gates the SM clock).
      if (terminal_c) begin
        count_r   <= '0;
        pending_r <= 1'b1;
        latch_r   <= count_r + 17'd1;              // actual period length
        phase_r   <= phase_next_c;                 // delta-sigma accumulate
        stretch_r <= phase_carry_c;                // next period INT+1?
      end else begin
        count_r <= count_r + 17'd1;
        // Hold pending only to defer a force-tick collision (CC-36);
        // otherwise the strobe retires this cycle.
        if (!(force_tick && pending_r))
          pending_r <= 1'b0;
      end
    end
  end

endmodule

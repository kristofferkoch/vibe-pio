// pio_mon_uart_tx — C15 spec-conformance monitor: UART-TX frame checker
// over one gpio_out pin (SPEC-16-9).
//
// Frame semantics (run-based, SPEC-16-9): the line is observed as maximal
// constant-level runs between edges. A run of L clk must equal m
// bit-times with m*BIT_LO <= L <= m*BIT_HI (the timing window; CC-26 —
// the delta-sigma divider alternates INT/INT+1 clk periods, so a
// fractional divisor legitimately lands slots anywhere in
// [k*INT, k*(INT+1)], an exact window means FRAC = 0; CC-25 is the same
// fact's lower bound). The concatenated run values must form start (0),
// DBITS data bits, the optional parity bit (even/odd over the data
// bits) and stop (1). A high tail completes the frame once it has
// outlasted (stop_pos - pos + 1) * BIT_LO clk, so a stop merged into
// the idle-high (SPEC-15-3) costs nothing.
//
// Duration measurement: gpio_out is sampled on clk; a level written at
// the end of tick T is pad-visible from T+1 (CC-40, composing CC-3/CC-8
// with CC-23) and registered sampling preserves run lengths — only
// absolute alignment shifts (SPEC-16-9).
//
// [MODEL] decode takes the fewest bits, m = ceil(L / BIT_HI) —
// acceptance-equivalent to the exists-m test, unambiguous when the
// parameter windows are disjoint (every repo parameterization is
// exact). A stop merged into a preceding ones-run is checked only in
// the run's aggregate window. A line stuck at the frame's complement
// past RMAX*BIT_HI + 1 clk raises the timing error immediately
// (bounded detection).
//
// Status contract (SPEC-16-9): a violation sets the sticky class flag
// (err_timing: run window / timeout, i.e. baud-class; err_frame:
// structure / stop / parity) and halts the monitor until rst — one
// deterministic, bounded-latency error per run, so the verdict is
// usable as the spec-eq comparison predicate (SPEC-16-10).
//
// Verification IP, not design: no assertions here — wrappers (sim TBs,
// formal/pio_mon_fv.sv) check the exported status. dbg_* ports expose
// the internal state so formal properties stay port-level equations
// (the pio_sm dbg idiom). Same subset as the rest of rtl/ (iverilog
// -g2012 + yosys read_verilog -sv both compile this file).

module pio_mon_uart_tx #(
    parameter int unsigned DBITS      = 8,     // data bits per frame
    parameter bit          PARITY     = 1'b0,  // parity bit after data
    parameter bit          PARITY_ODD = 1'b0,  // 0 = even, 1 = odd
    parameter int unsigned BIT_LO     = 8,     // min clk per bit-time (CC-26)
    parameter int unsigned BIT_HI     = 8      // max clk per bit-time (CC-26)
) (
    input  logic              clk,
    input  logic              rst,
    input  logic              rx,        // the TX line = gpio_out[pin]
    output logic              err,       // violation seen (sticky, halted)
    output logic              err_timing,// class: run window / timeout
    output logic              err_frame, // class: structure / stop / parity
    output logic              frame_done,// one-clk strobe per accepted frame
    output logic [15:0]       frames,    // accepted frame count
    output logic [DBITS-1:0]  data,      // last frame's payload, LSB first
    // dbg readback (SPEC-16-9): state / run length / bit position.
    output logic [2:0]        dbg_state,
    output logic [15:0]       dbg_len,
    output logic [5:0]        dbg_pos
);

  // Bit positions inside a frame: 0 = start, 1..DBITS = data,
  // DBITS+1 = parity (when enabled), STOP_POS = stop.
  localparam int unsigned STOP_POS = 1 + DBITS + (PARITY ? 1 : 0);
  // Longest edge-terminated run covers start..parity = STOP_POS bits;
  // the stop/idle tail is unbounded and completes instead of timing out.
  localparam int unsigned RMAX  = STOP_POS;
  localparam int unsigned LCAP  = RMAX * BIT_HI + 1;  // saturation + timeout
  localparam int unsigned W_L   = $clog2(LCAP + 1);
  localparam int unsigned W_POS = $clog2(STOP_POS + 2);

  // Onehot FSM states (DESIGN.md RTL conventions).
  localparam logic [2:0] ST_IDLE = 3'b001;
  localparam logic [2:0] ST_RUN  = 3'b010;
  localparam logic [2:0] ST_HALT = 3'b100;

  logic [2:0]       state_r;
  logic             lvl_r;       // current run's level
  logic [W_L-1:0]   L_r;         // run length in clk (through last clk)
  logic [W_POS-1:0] pos_r;       // next frame position to fill
  logic             ones_r;      // parity of data ones so far
  logic             par_bit_r;   // parity bit value (captured from its run)
  logic [DBITS-1:0] data_r;
  logic [15:0]      frames_r;
  logic             err_timing_r, err_frame_r, frame_done_r;
  logic             rx_q;

  assign err        = (state_r == ST_HALT);      // sticky by construction
  assign err_timing = err_timing_r;
  assign err_frame  = err_frame_r;
  assign frame_done = frame_done_r;
  assign frames     = frames_r;
  assign data       = data_r;
  assign dbg_state  = state_r;
  assign dbg_len    = 16'(L_r);
  assign dbg_pos    = 6'(pos_r);

  // ------------------------------------------------------------------
  // Run decode (SPEC-16-9), purely combinational:
  //   m0     = ceil(L / BIT_HI) — fewest bits the run could be
  //   legal  = m0 <= RMAX && L >= m0*BIT_LO   (the exists-m test)
  //   k      = stop_pos + 1 - pos             (remaining bits incl. stop)
  //   done   = high tail outlasted k*BIT_LO, or an edge-terminated run
  //            decoding exactly past the stop with the stop driven high
  // ------------------------------------------------------------------
  logic [W_POS+1:0] m0_c, pos2_c, k_c, mbits_c;
  logic             legal_c, complete_c, edge_c, cont_c, done_c, proc_c;
  logic             cover_par_c, par_now_c, ones_new_c, par_ok_c;
  logic             ov_odd_c;
  int               ov_lo_c, ov_hi_c;

  always_comb begin
    m0_c = W_POS'(RMAX) + 2'(1);
    for (int unsigned mi = RMAX; mi >= 1; mi--)
      if (L_r <= W_L'(mi * BIT_HI)) m0_c = W_POS'(mi);
    legal_c = (m0_c <= W_POS'(RMAX)) && (L_r >= W_L'(m0_c * BIT_LO));

    pos2_c = W_POS'(pos_r) + m0_c;
    k_c    = W_POS'(STOP_POS + 1) - W_POS'(pos_r);
    // The +1 counts the clk currently being sampled (SPEC-16-9).
    complete_c = (lvl_r == 1'b1)
              && ((32'(L_r) + 32'd1) >= 32'(k_c) * 32'(BIT_LO));

    cont_c = (state_r == ST_RUN) && (rx == lvl_r);
    edge_c = (state_r == ST_RUN) && (rx != lvl_r);
    done_c = (cont_c && complete_c)
          || (edge_c && legal_c && (pos2_c == W_POS'(STOP_POS + 1))
              && (lvl_r == 1'b1));
    mbits_c = cont_c ? k_c : m0_c;
    // A run whose payload lands in the frame (edge-continue, below the
    // stop slot) or completes it (done).
    proc_c = done_c || (edge_c && legal_c && (pos2_c < W_POS'(STOP_POS + 1)));

    // Data-bit overlap of the processed run (positions 0-based, data
    // occupies 1..DBITS) — ov_odd_c is the overlap count's parity,
    // feeding the ones parity (SPEC-16-9).
    ov_lo_c  = (32'(pos_r) > 32'd1) ? 32'(pos_r) : 32'd1;
    ov_hi_c  = (32'(pos_r) + 32'(mbits_c) - 32'd1 < 32'(DBITS))
               ? (32'(pos_r) + 32'(mbits_c) - 32'd1) : 32'(DBITS);
    ov_odd_c = (ov_hi_c >= ov_lo_c) && (((ov_hi_c - ov_lo_c) & 32'd1) == 32'd0);

    cover_par_c = PARITY && (32'(pos_r) <= 32'(DBITS) + 32'd1)
               && (32'(DBITS) + 32'd1 < 32'(pos_r) + 32'(mbits_c));
    par_now_c   = cover_par_c ? lvl_r : par_bit_r;
    ones_new_c  = ones_r ^ (ov_odd_c && lvl_r);
    par_ok_c    = !PARITY || (par_now_c == (ones_new_c ^ PARITY_ODD));
  end

  always_ff @(posedge clk) begin
    if (rst) begin
      state_r      <= ST_IDLE;
      lvl_r        <= 1'b0;
      L_r          <= '0;
      pos_r        <= '0;
      ones_r       <= 1'b0;
      par_bit_r    <= 1'b0;
      data_r       <= '0;
      frames_r     <= '0;
      err_timing_r <= 1'b0;
      err_frame_r  <= 1'b0;
      frame_done_r <= 1'b0;
      rx_q         <= 1'b0;
    end else begin
      frame_done_r <= 1'b0;
      rx_q         <= rx;

      case (state_r)
        ST_IDLE: begin
          // A falling edge delimits the start bit (SPEC-16-9).
          if (rx_q && !rx) begin
            state_r <= ST_RUN;
            lvl_r   <= 1'b0;
            L_r     <= W_L'(1);
            pos_r   <= '0;
            ones_r  <= 1'b0;
          end
        end

        ST_RUN: begin
          if (proc_c) begin
            // Fill the processed run's payload: data bits and, when the
            // run covers it, the parity bit value.
            if (cover_par_c) par_bit_r <= lvl_r;
            for (int b = 0; b < 40; b++) begin
              if (32'(b) < 32'(mbits_c)
                  && (32'(pos_r) + 32'(b) >= 32'd1)
                  && (32'(pos_r) + 32'(b) <= 32'(DBITS))) begin
                data_r[pos_r + W_POS'(b) - W_POS'(1)] <= lvl_r;
              end
            end
            ones_r <= ones_new_c;
          end

          if (done_c) begin
            if (!par_ok_c) begin
              err_frame_r <= 1'b1;   // parity class (SPEC-16-9)
              state_r     <= ST_HALT;
            end else begin
              frame_done_r <= 1'b1;
              frames_r     <= frames_r + 16'd1;
              state_r      <= ST_IDLE;
            end
          end else if (edge_c) begin
            // The run of L_r clks just ended (SPEC-16-9 window check).
            if (!legal_c) begin
              err_timing_r <= 1'b1;
              state_r      <= ST_HALT;
            end else if (pos2_c >= W_POS'(STOP_POS + 1)) begin
              err_frame_r  <= 1'b1;  // decodes at/past stop with lvl_r == 0
              state_r      <= ST_HALT;
            end else begin
              pos_r <= W_POS'(pos2_c);
              lvl_r <= rx;
              L_r   <= W_L'(1);
            end
          end else begin
            // Run continues; saturation at LCAP bounds the stuck-line
            // timeout (SPEC-16-9 bounded detection).
            if (L_r >= W_L'(LCAP - 1)) begin
              err_timing_r <= 1'b1;
              state_r      <= ST_HALT;
            end else begin
              L_r <= L_r + W_L'(1);
            end
          end
        end

        ST_HALT: begin
          // Quiet: the error is sticky until rst (SPEC-16-9).
        end

        default: state_r <= ST_HALT;
      endcase
    end
  end

endmodule

// pio_mon_square — C15 spec-conformance monitor: square-wave period
// checker over one gpio_out pin (SPEC-16-9).
//
// Semantics: every interval between consecutive edges (each half-period,
// independently — asymmetric duty is admissible as long as each half
// fits) must lie in [HALF_LO, HALF_HI] clk. The interval spanning
// monitor start is not measured (no reference edge before it); a
// missing edge past HALF_HI + 1 clk raises the long-interval error
// immediately (bounded detection — no wait for an edge that never
// comes). A shorter-than-HALF_LO interval (glitch / too-fast toggle)
// raises the short-interval error at the edge itself.
//
// Timing-window sizing (SPEC-16-9): CC-26's delta-sigma divider
// alternates INT and INT+1 clk periods, so half-periods anywhere in
// [INT, INT+1] are legitimate at divisor INT.FRAC/256 (an exact window
// means FRAC = 0); CC-25 is the same fact's lower bound. Durations are
// measured on the registered gpio_out sample — a level written at the
// end of tick T is pad-visible from T+1 (CC-40, composing CC-3/CC-8
// with CC-23) and registered sampling preserves interval lengths.
//
// Status contract (SPEC-16-9): a violation sets the sticky class flag
// (err_lo: interval short; err_hi: interval long / missing edge) and
// halts the monitor until rst — one deterministic, bounded-latency
// error per run, so the verdict is usable as the spec-eq comparison
// predicate (SPEC-16-10).
//
// Verification IP, not design: no assertions here — wrappers (sim TBs,
// formal/pio_mon_fv.sv) check the exported status; dbg_* ports keep
// formal properties port-level equations (the pio_sm dbg idiom).

module pio_mon_square #(
    parameter int unsigned HALF_LO = 2,   // min clk per half-period (CC-26)
    parameter int unsigned HALF_HI = 2    // max clk per half-period (CC-26)
) (
    input  logic        clk,
    input  logic        rst,
    input  logic        sig,       // the observed pin = gpio_out[pin]
    output logic        err,       // violation seen (sticky, halted)
    output logic        err_lo,    // class: interval < HALF_LO
    output logic        err_hi,    // class: interval > HALF_HI (or timeout)
    output logic        edge_t,    // one-clk strobe per accepted edge
    output logic [15:0] edges,     // accepted edge count
    // dbg readback (SPEC-16-9): state / current interval length.
    output logic [2:0]  dbg_state,
    output logic [15:0] dbg_len
);

  localparam int unsigned LCAP = HALF_HI + 1;        // saturation + timeout
  localparam int unsigned W_L  = $clog2(LCAP + 1);

  // Onehot FSM states (DESIGN.md RTL conventions).
  localparam logic [2:0] ST_IDLE = 3'b001;
  localparam logic [2:0] ST_RUN  = 3'b010;
  localparam logic [2:0] ST_HALT = 3'b100;

  logic [W_L-1:0] L_r;        // interval length in clk (through last clk)
  logic           lvl_r;      // current half-period's level
  logic [2:0]     state_r;
  logic [15:0]    edges_r;
  logic           err_lo_r, err_hi_r, edge_t_r;
  logic           sig_q;

  assign err       = (state_r == ST_HALT);   // sticky by construction
  assign err_lo    = err_lo_r;
  assign err_hi    = err_hi_r;
  assign edge_t    = edge_t_r;
  assign edges     = edges_r;
  assign dbg_state = state_r;
  assign dbg_len   = 16'(L_r);

  always_ff @(posedge clk) begin
    if (rst) begin
      state_r  <= ST_IDLE;
      L_r      <= '0;
      lvl_r    <= 1'b0;
      edges_r  <= '0;
      err_lo_r <= 1'b0;
      err_hi_r <= 1'b0;
      edge_t_r <= 1'b0;
      sig_q    <= 1'b0;
    end else begin
      edge_t_r <= 1'b0;
      sig_q    <= sig;

      case (state_r)
        ST_IDLE: begin
          // First observed edge anchors measurement (SPEC-16-9: the
          // interval spanning monitor start is not measured).
          if (sig != sig_q) begin
            state_r <= ST_RUN;
            lvl_r   <= sig;
            L_r     <= W_L'(1);
          end
        end

        ST_RUN: begin
          if (sig == lvl_r) begin
            // Half-period continues; saturation at LCAP bounds the
            // missing-edge timeout (SPEC-16-9 bounded detection).
            if (L_r >= W_L'(LCAP - 1)) begin
              err_hi_r <= 1'b1;
              state_r  <= ST_HALT;
            end else begin
              L_r <= L_r + W_L'(1);
            end
          end else begin
            // Edge: the interval of L_r clks just ended — window check.
            if (L_r < W_L'(HALF_LO)) begin
              err_lo_r <= 1'b1;
              state_r  <= ST_HALT;
            end else begin
              edges_r  <= edges_r + 16'd1;
              edge_t_r <= 1'b1;
              lvl_r    <= sig;
              L_r      <= W_L'(1);
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

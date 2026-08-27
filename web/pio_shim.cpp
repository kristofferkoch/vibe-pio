// pio_shim — C++ harness around the Verilated pio_shim_top (KANBAN C17).
// One cycle engine, two faces:
//
//   gate face  pio_stim_trace(): replays a pio-stim v1 image and returns
//              the SPEC-16-7 trace — the wasm leg of the three-way gate
//              (tools/webbuild.py), run headless under node
//              (web/node_gate.js).
//   game face  pio_reg_write / pio_reg_read / pio_step / pio_snapshot /
//              pio_last_cycle: the C18 client API — load program +
//              config overlay (they are just reg-bus writes,
//              SPEC-7-10/14..26), tick with pin in, state out; every
//              cycle-closing entry point also fills the pre-edge
//              PioCycle sample (pio_last_cycle) the view renders from.
//
// Timeline contract (mirrors sim/tb_trace_dump.sv, which mirrors the
// golden model's step()):
//   - CC-1 reset: 4 clks of rst, deasserted just after the 4th posedge;
//     clk 0 is the cycle that follows, so clk-0 observables are reset
//     values.
//   - per clk k: inputs (post-loopback gpio_in, bus op, neighbour IRQ
//     vectors) are driven with clk low and settled with eval() — the
//     TB's negedge + #1 sample point; the observables are sampled there;
//     the posedge that closes the cycle retires every effect (CC-3).
//   - loopback fold (tb_conf_pioexamples lb_mask idiom): gpio_in[p] =
//     gpio_oe[p] ? gpio_out[p] : 0 for masked pins, from the registered
//     outputs — the trace face folds it here, the model folds the same
//     function.
//
// PIO_DEFECT_SAMPLE_LATE is the red-injection hook for the C17 mutation
// demo (never defined in a real build): the observables are sampled
// after the retiring posedge instead of before — the classic shim bug
// the trace diff must catch (one-clk-late G lines, R lines see the
// post-pop state).

#include "Vpio_shim_top.h"

#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

Vpio_shim_top *top = nullptr;
uint64_t clk_count = 0;  // clks since reset release

void idle_inputs() {
    top->reg_addr = 0;
    top->reg_wdata = 0;
    top->reg_write = 0;
    top->reg_read = 0;
    top->gpio_in = 0;
    top->irq_prev_r = 0;
    top->irq_next_r = 0;
    top->nb_set = 0;
    top->nb_clr = 0;
    top->clk = 0;
    top->rst = 0;
}

void ensure_dut() {
    if (top == nullptr) {
        top = new Vpio_shim_top;
        clk_count = 0;
        idle_inputs();
        top->eval();
    }
}

// One cycle-closing posedge (CC-3), then comb re-settled with clk low.
void posedge() {
    top->clk = 1;
    top->eval();
    top->clk = 0;
    top->eval();
    clk_count++;
}

// CC-1 reset protocol (tb_trace_dump: 4 clks, deassert just after edge 4).
void engine_reset() {
    ensure_dut();
    idle_inputs();
    top->rst = 1;
    for (int i = 0; i < 4; i++) posedge();
    top->rst = 0;
    top->eval();
    clk_count = 0;
}

// pio-stim v1 image -> words ($readmemh-style whitespace-separated hex,
// '#'/'//' comments tolerated; word 0 = N, then 6 words per cycle).
std::vector<uint32_t> parse_stim(const char *text) {
    std::vector<uint32_t> words;
    const char *p = text;
    while (*p != '\0') {
        if (*p == '#' || (p[0] == '/' && p[1] == '/')) {
            while (*p != '\0' && *p != '\n') p++;
            continue;
        }
        if (isspace(static_cast<unsigned char>(*p))) {
            p++;
            continue;
        }
        uint32_t w = 0;
        int n = 0;
        while (isxdigit(static_cast<unsigned char>(*p))) {
            w = (w << 4) | (uint32_t)(isdigit(static_cast<unsigned char>(*p)) ? *p - '0'
                                                                              : (*p | 0x20) - 'a' + 10);
            p++;
            n++;
        }
        if (n > 0) words.push_back(w);
        else p++;  // stray character: skip
    }
    return words;
}

std::string replay_stim(const std::vector<uint32_t> &w) {
    std::string out = "pio-trace v1\n";
    if (w.empty() || w[0] == 0 || w[0] > 8192 || w.size() < 1 + 6 * (size_t)w[0])
        return out + "!bad stim\n";
    engine_reset();
    char line[80];
    const uint32_t n = w[0];
    for (uint32_t k = 0; k < n; k++) {
        const size_t b = 1 + 6 * (size_t)k;
        const uint32_t stim_gpio = w[b + 0];
        const uint32_t lb = w[b + 1];
        const uint32_t op = w[b + 2] >> 9;
        const uint32_t addr = w[b + 2] & 0x1ff;
        const uint32_t wd = w[b + 3];
        // loopback fold from the registered outputs (idle-stable)
        uint32_t gin = stim_gpio;
        for (int p = 0; p < 32; p++)
            if ((lb >> p) & 1u)
                gin = (gin & ~(1u << p))
                      | (((top->gpio_oe >> p) & 1u) ? ((top->gpio_out >> p) & 1u) << p : 0u);
        top->gpio_in = gin;
        top->reg_addr = (uint16_t)addr;
        top->reg_wdata = wd;
        top->reg_write = (op == 1) ? 1 : 0;  // SPEC-7-x strobes, one clk
        top->reg_read = (op == 2) ? 1 : 0;
        top->nb_set = (uint8_t)((w[b + 4] >> 8) & 0xff);
        top->nb_clr = (uint8_t)(w[b + 4] & 0xff);
        top->irq_prev_r = (uint8_t)((w[b + 5] >> 8) & 0xff);
        top->irq_next_r = (uint8_t)(w[b + 5] & 0xff);
        top->eval();  // settle — the negedge sample point

#ifdef PIO_DEFECT_SAMPLE_LATE
        posedge();  // defect: sample after the retiring edge
#endif
        snprintf(line, sizeof(line), "%llu G %08x %08x %04x\n", (unsigned long long)k,
                 (uint32_t)top->gpio_out, (uint32_t)top->gpio_oe, (uint32_t)top->intr);
        out += line;
        if (op == 2) {
            snprintf(line, sizeof(line), "%llu R %03x %08x\n", (unsigned long long)k, addr,
                     (uint32_t)top->reg_rdata);
            out += line;
        }
#ifndef PIO_DEFECT_SAMPLE_LATE
        posedge();  // cycle-closing edge
#endif
        // bus strobes retire with the edge; present idle levels again
        top->reg_write = 0;
        top->reg_read = 0;
        top->eval();
    }
    return out;
}

}  // namespace

// ---------------------------------------------------------------------------
// Game-facing snapshots (little-endian; offsets noted for the JS reader).
//
// PioSnapshot is the post-edge state (start of the next cycle) — "the
// machine now". PioCycle is the PRE-edge observable view of one clk —
// the negedge sample point the trace face uses (CC-40: pin levels land
// on the pad from T+1), i.e. exactly what the C18 view renders for a
// cycle: the pins, the SM state that the closing edge will act on, and
// the per-clk strobes (sm_tick/exec/complete/pc_wr/tx_pop/rx_push +
// tx_empty/tx_full flags packed into `strobes`).
// ---------------------------------------------------------------------------
struct PioSnapshot {
    uint64_t clk;      // 0:  clks since reset release
    uint32_t gpio_out;  // 8
    uint32_t gpio_oe;   // 12
    uint32_t intr;      // 16
    uint32_t sm_en;     // 20: dbg_sm_en (SPEC-7-2)
    uint32_t sm_pc[4];  // 24..39: dbg_sm_pc (fetch addrs, CC-33)
    uint32_t sm_force;  // 40: dbg_force (CC-35)
    uint32_t state;     // 44: SM0 onehot FSM (ST_*)
    uint32_t delay;     // 48: SM0 delay countdown (CC-10)
    uint32_t x, y;      // 52, 56: SM0 scratch (G2)
    uint32_t osr, isr;  // 60, 64: SM0 shifters (SPEC-5-1)
    uint32_t osr_cnt;   // 68
    uint32_t isr_cnt;   // 72
    uint32_t tx_level;  // 76: FLEVEL TX nibble (SPEC-6-6)
    uint32_t rx_level;  // 80
};  // size 84

struct PioCycle {
    uint64_t clk;       // 0:  the clk this sample belongs to
    uint32_t gpio_out;  // 8
    uint32_t gpio_oe;   // 12
    uint32_t intr;      // 16
    uint32_t pc;        // 20: SM0 fetch addr (CC-33)
    uint32_t state;     // 24: SM0 onehot FSM (ST_FETCH/EXEC/STALL/DELAY)
    uint32_t delay;     // 28: SM0 delay countdown (CC-10)
    uint32_t x, y;      // 32, 36
    uint32_t osr, isr;  // 40, 44
    uint32_t osr_cnt;   // 48
    uint32_t isr_cnt;   // 52
    uint32_t tx_level;  // 56
    uint32_t rx_level;  // 60
    uint32_t strobes;   // 64: b0 sm_tick · b1 exec · b2 complete ·
                        //     b3 pc_wr · b4 tx_pop · b5 rx_push ·
                        //     b6 tx_empty · b7 tx_full
};  // size 72

namespace {
PioCycle g_cycle;  // the last clk's pre-edge sample (pio_last_cycle)

void sample_cycle() {
    g_cycle.clk       = clk_count;
    g_cycle.gpio_out  = top->gpio_out;
    g_cycle.gpio_oe   = top->gpio_oe;
    g_cycle.intr      = top->intr;
    g_cycle.pc        = (top->dbg_sm_pc >> 0) & 0x1f;
    g_cycle.state     = top->dbg_sm0_state;
    g_cycle.delay     = top->dbg_sm0_delay;
    g_cycle.x         = top->dbg_sm0_x;
    g_cycle.y         = top->dbg_sm0_y;
    g_cycle.osr       = top->dbg_sm0_osr;
    g_cycle.isr       = top->dbg_sm0_isr;
    g_cycle.osr_cnt   = top->dbg_sm0_osr_cnt;
    g_cycle.isr_cnt   = top->dbg_sm0_isr_cnt;
    g_cycle.tx_level  = top->dbg_sm0_tx_level;
    g_cycle.rx_level  = top->dbg_sm0_rx_level;
    g_cycle.strobes   = (uint32_t)(top->dbg_sm0_tick & 1u)
                      | ((uint32_t)(top->dbg_sm0_exec & 1u) << 1)
                      | ((uint32_t)(top->dbg_sm0_complete & 1u) << 2)
                      | ((uint32_t)(top->dbg_sm0_pc_wr & 1u) << 3)
                      | ((uint32_t)(top->dbg_sm0_tx_pop & 1u) << 4)
                      | ((uint32_t)(top->dbg_sm0_rx_push & 1u) << 5)
                      | ((uint32_t)(top->dbg_sm0_tx_empty & 1u) << 6)
                      | ((uint32_t)(top->dbg_sm0_tx_full & 1u) << 7);
}
}  // namespace

extern "C" {

// Gate face: replay one pio-stim image, return its SPEC-16-7 trace.
// The returned pointer stays valid until the next call (static buffer).
const char *pio_stim_trace(const char *stim_text) {
    ensure_dut();
    static std::string buf;
    buf = replay_stim(parse_stim(stim_text));
    return buf.c_str();
}

// Game face --------------------------------------------------------------

void pio_engine_reset() { engine_reset(); }

// One full reg-bus write cycle (SPEC-7-x: strobe one clk, retires at the
// closing edge — visible to consumers from the next cycle, CC-33/CC-30).
void pio_reg_write(uint32_t addr, uint32_t data) {
    ensure_dut();
    top->reg_addr = (uint16_t)(addr & 0x1ff);
    top->reg_wdata = data;
    top->reg_write = 1;
    top->eval();
    sample_cycle();  // this bus cycle's pre-edge view (a rendered clk)
    posedge();
    top->reg_write = 0;
    top->eval();
}

// One full reg-bus read cycle; returns the sampled (pre-edge) rdata.
// Side effects retire at the closing edge (RXF pop SPEC-7-28, the
// PUTGET window SPEC-7-13) — same discipline as the trace's R line.
uint32_t pio_reg_read(uint32_t addr) {
    ensure_dut();
    top->reg_addr = (uint16_t)(addr & 0x1ff);
    top->reg_read = 1;
    top->eval();
    sample_cycle();
    const uint32_t rdata = top->reg_rdata;
    posedge();
    top->reg_read = 0;
    top->eval();
    return rdata;
}

// One clk with the bus idle: drive raw pad levels + neighbour IRQ views,
// settle, sample this cycle's pad outputs, retire the edge. Loopback
// wiring is the caller's business (the trace face folds lb_mask itself).
uint32_t pio_step(uint32_t gpio_in, uint32_t irq_prev, uint32_t irq_next) {
    ensure_dut();
    top->gpio_in = gpio_in;
    top->irq_prev_r = (uint8_t)irq_prev;
    top->irq_next_r = (uint8_t)irq_next;
    top->eval();
    sample_cycle();  // the negedge-point view the view renders
    const uint32_t gpio_out = top->gpio_out;
    posedge();
    return gpio_out;
}

// The pre-edge sample of the clk that just ran (pio_step / reg op).
const PioCycle *pio_last_cycle() {
    ensure_dut();
    return &g_cycle;
}

// Post-edge state snapshot (start of the next cycle).
const PioSnapshot *pio_snapshot() {
    ensure_dut();
    static PioSnapshot snap;
    snap.clk = clk_count;
    snap.gpio_out = top->gpio_out;
    snap.gpio_oe = top->gpio_oe;
    snap.intr = top->intr;
    snap.sm_en = top->dbg_sm_en;
    for (int i = 0; i < 4; i++) snap.sm_pc[i] = (top->dbg_sm_pc >> (5 * i)) & 0x1f;
    snap.sm_force = top->dbg_force;
    snap.state    = top->dbg_sm0_state;
    snap.delay    = top->dbg_sm0_delay;
    snap.x        = top->dbg_sm0_x;
    snap.y        = top->dbg_sm0_y;
    snap.osr      = top->dbg_sm0_osr;
    snap.isr      = top->dbg_sm0_isr;
    snap.osr_cnt  = top->dbg_sm0_osr_cnt;
    snap.isr_cnt  = top->dbg_sm0_isr_cnt;
    snap.tx_level = top->dbg_sm0_tx_level;
    snap.rx_level = top->dbg_sm0_rx_level;
    return &snap;
}

}  // extern "C"

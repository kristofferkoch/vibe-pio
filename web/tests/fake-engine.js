// fake-engine.js — the hermetic stand-in for the C17 wasm engine
// (KANBAN C20 unit suite).
//
// Implements exactly the ABI web/engine-driver.js touches (pio_shim.cpp):
// HEAPU8 + the _pio_* exports, with the little-endian PioCycle struct at
// offset 0 of a plain ArrayBuffer. The shim's semantics the driver relies
// on are modeled: every reg write retires one rendered clk (the struct is
// re-sampled after it), FLEVEL reads the TX level, and TXF0 writes push
// the 8-deep joined FIFO (SPEC-6-2), marking S_TX_FULL when saturated.
//
// The PIO *core* is not modeled — that is the point. Tests script the
// observable per-clk effects (gpio_out, pc, state, strobes, ...) via
// `script()`; the driver's own logic (load timeline, decode, monitor,
// mirror, phases) is what gets checked. Divergences from the real engine
// are caught by make web's three-way gate, never here.
//
// Strobe bits mirror engine-driver.js / pio_shim.cpp.
const S_TICK = 1,
  S_EXEC = 2,
  S_COMPLETE = 4,
  S_PC_WR = 8,
  S_TX_POP = 16,
  S_RX_PUSH = 32,
  S_TX_EMPTY = 64,
  S_TX_FULL = 128;

// struct field offsets in bytes (pio_shim.cpp) — the same table
// engine-driver.js decodes with; keeping it here once more is the
// fixture's own pin of that contract.
const F = [
  ['clk', 0],
  ['gpio_out', 8],
  ['gpio_oe', 12],
  ['intr', 16],
  ['pc', 20],
  ['state', 24],
  ['delay', 28],
  ['x', 32],
  ['y', 36],
  ['osr', 40],
  ['isr', 44],
  ['osr_cnt', 48],
  ['isr_cnt', 52],
  ['tx_level', 56],
  ['rx_level', 60],
  ['strobes', 64],
];
const CYC_SIZE = 72;

function createFake() {
  const buf = new ArrayBuffer(4096);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const cyc = {
    clk: 0,
    gpio_out: 1,
    gpio_oe: 0,
    intr: 0,
    pc: 0,
    state: 0,
    delay: 0,
    x: 0,
    y: 0,
    osr: 0,
    isr: 0,
    osr_cnt: 0,
    isr_cnt: 0,
    tx_level: 0,
    rx_level: 0,
    strobes: 0,
  };
  const txFifo = [];
  let script_ = [];
  const writes = []; // {addr, data} in retirement order (data >>> 0)
  let steps = 0; // _pio_step calls (the idle clk / run clks)

  const hiWord = (c) => Math.floor(c / 2 ** 32);

  function flush() {
    // A scripted S_TX_POP actually pops the FIFO model, so tx_level
    // (what the driver's mirror must agree with) stays consistent.
    if (cyc.strobes & S_TX_POP) txFifo.shift();
    if (txFifo.length === 0) cyc.strobes |= S_TX_EMPTY;
    else cyc.strobes &= ~S_TX_EMPTY;
    if (txFifo.length >= 8) cyc.strobes |= S_TX_FULL;
    cyc.tx_level = txFifo.length;
    cyc.clk += 1;
    dv.setUint32(0, (cyc.clk % 2 ** 32) >>> 0, true);
    dv.setUint32(4, hiWord(cyc.clk) >>> 0, true);
    for (const [k, off] of F.slice(1)) {
      dv.setUint32(off, cyc[k] >>> 0, true);
    }
  }

  function tick(effect) {
    cyc.strobes = 0; // strobes are per-clk unless the effect sets them
    if (effect) Object.assign(cyc, effect);
    flush();
  }

  return {
    HEAPU8: u8,
    S: { S_TICK, S_EXEC, S_COMPLETE, S_PC_WR, S_TX_POP, S_RX_PUSH, S_TX_EMPTY, S_TX_FULL },
    CYC_SIZE,
    // ---- engine ABI (what engine-driver.js calls) ----
    _pio_last_cycle: () => 0,
    _pio_engine_reset: () => {},
    _pio_reg_write: (addr, data) => {
      const d = data >>> 0;
      writes.push({ addr: addr >>> 0, data: d });
      if (addr === 0x010 && txFifo.length < 8) txFifo.push(d & 0xff);
      tick();
    },
    _pio_reg_read: (addr) => (addr === 0x00c ? txFifo.length : 0),
    _pio_step: () => {
      steps += 1;
      tick(script_.shift());
    },
    // ---- test-side helpers ----
    script: (effects) => {
      script_ = script_.concat(effects);
    },
    writes,
    stepsCount: () => steps,
    txFifo: () => txFifo.slice(),
  };
}

module.exports = { createFake };

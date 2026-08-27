// fake-engine.js — the hermetic stand-in for the C17 wasm engine
// (KANBAN C20 unit suite; grown with the C21 sandbox surface).
//
// Implements exactly the ABI web/engine-driver.js touches (pio_shim.cpp):
// HEAPU8 + the _pio_* exports, with the little-endian PioCycle struct at
// offset 0 of a plain ArrayBuffer. The shim's semantics the driver relies
// on are modeled: every reg write/read retires one rendered clk (the
// struct is re-sampled after it), FLEVEL composes the TX nibble | RX
// nibble<<4 (SPEC-7-29), TXF0 writes push the 8-deep joined FIFO
// (SPEC-6-2), marking S_TX_FULL when saturated, RXF0 reads pop the
// scripted RX word queue (a scripted S_RX_PUSH effect grows the level),
// and _pio_step records the gpio_in the driver composed per clk (the
// C21 drive/pattern checks).
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
  const rxFifo = []; // scripted words; a scripted S_RX_PUSH effect grows rx_level
  let rxLevel = 0;
  let shiftModeBits = 0; // FJOIN_RX|FJOIN_TX|PUT|GET of the last SHIFTCTRL write
  let script_ = [];
  const writes = []; // {addr, data} in retirement order (data >>> 0)
  const gpioLog = []; // gpio_in the driver composed per _pio_step clk
  let steps = 0; // _pio_step calls (the idle clk / run clks)

  const hiWord = (c) => Math.floor(c / 2 ** 32);

  function flush() {
    // A scripted S_TX_POP actually pops the FIFO model, so tx_level
    // (what the driver's mirror must agree with) stays consistent; a
    // scripted S_RX_PUSH grows the RX level the same way.
    if (cyc.strobes & S_TX_POP) txFifo.shift();
    if (cyc.strobes & S_RX_PUSH) rxLevel = Math.min(rxLevel + 1, 8);
    if (txFifo.length === 0) cyc.strobes |= S_TX_EMPTY;
    else cyc.strobes &= ~S_TX_EMPTY;
    if (txFifo.length >= 8) cyc.strobes |= S_TX_FULL;
    else cyc.strobes &= ~S_TX_FULL;
    cyc.tx_level = txFifo.length;
    cyc.rx_level = rxLevel;
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
      if (addr === 0x0d0) {
        // SPEC-6-2: a fifo-mode-changing SHIFTCTRL write flushes both
        // FIFOs (the engine retires the discard on the following clk;
        // the fake folds it into the write's own post-edge sample)
        const mode = d & 0xc000c000;
        if (mode !== shiftModeBits) {
          shiftModeBits = mode;
          txFifo.length = 0;
          rxFifo.length = 0;
          rxLevel = 0;
        }
      }
      tick();
    },
    _pio_reg_read: (addr) => {
      // rdata is the pre-edge view (RXF0: the head word before the pop
      // retires); the struct then advances one clk like pio_reg_write
      let v = 0;
      if (addr === 0x00c)
        v = txFifo.length | (rxLevel << 4); // FLEVEL
      else if (addr === 0x020) {
        // RXF0 pop: a scripted word, or 0 on the empty FIFO (the model
        // returns undefined + RXUNDER; the driver never drains empty by
        // contract — the fake keeps 0 so a violation still shows up as a
        // wrong rdata, not a crash).
        rxLevel = Math.max(0, rxLevel - 1);
        v = rxFifo.length ? rxFifo.shift() : 0;
      }
      cyc.strobes = 0;
      flush();
      return v;
    },
    _pio_step: (gpio_in) => {
      steps += 1;
      gpioLog.push(gpio_in >>> 0);
      tick(script_.shift());
    },
    // ---- test-side helpers ----
    script: (effects) => {
      script_ = script_.concat(effects);
    },
    rxFeed: (words) => {
      rxFifo.push(...words);
    },
    writes,
    gpioLog,
    stepsCount: () => steps,
    txFifo: () => txFifo.slice(),
  };
}

module.exports = { createFake };

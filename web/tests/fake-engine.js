// fake-engine.js — the hermetic stand-in for the C17 wasm engine
// (KANBAN C20 unit suite; grown with the C21 sandbox surface and the
// C24 per-SM PioCycle).
//
// Implements exactly the ABI web/engine-driver.js touches (pio_shim.cpp):
// HEAPU8 + the _pio_* exports, with the little-endian PioCycle struct at
// offset 0 of a plain ArrayBuffer — per-SM arrays since C24 (pc[4] ..
// strobes[4], wr_mask[4]; the same SM-major layout the shim packs). The
// shim's semantics the driver relies on are modeled: every reg
// write/read retires one rendered clk (the struct is re-sampled after
// it), FLEVEL composes all four TX/RX nibble pairs (SPEC-7-29), TXFx
// writes push SM x's 8-deep joined FIFO (SPEC-6-2) marking that SM's
// S_TX_FULL when saturated, RXFx reads pop SM x's scripted RX word
// queue (a scripted S_RX_PUSH effect grows that SM's level), a
// fifo-mode-changing SMx_SHIFTCTRL write flushes that SM's FIFOs
// (SPEC-6-2), and _pio_step records the gpio_in the driver composed
// per clk (the C21 drive/pattern checks).
//
// The PIO *core* is not modeled — that is the point. Tests script the
// observable per-clk effects (gpio_out, per-SM pc/state/strobes/
// wr_mask, ...) via `script()`; the driver's own logic (load timeline,
// decode, monitor, mirrors, phases, ownership) is what gets checked.
// Divergences from the real engine are caught by make web's three-way
// gate, never here.
//
// Strobe bits mirror engine-driver.js / pio_shim.cpp, per SM.
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
// fixture's own pin of that contract. Per-SM fields are stored under
// flat keys `field{i}` at CYC.field + 4*i.
const F = [
  ['clk', 0],
  ['gpio_out', 8],
  ['gpio_oe', 12],
  ['intr', 16],
];
const SMF = [
  ['pc', 20],
  ['state', 36],
  ['delay', 52],
  ['x', 68],
  ['y', 84],
  ['osr', 100],
  ['isr', 116],
  ['osr_cnt', 132],
  ['isr_cnt', 148],
  ['tx_level', 164],
  ['rx_level', 180],
  ['strobes', 196],
  ['wr_mask', 212],
];
const CYC_SIZE = 228;
const SM_WIN = 0x18; // per-SM config window stride (SPEC-7-x)
const REG_SM0 = 0x0c8;

// flat key of SM i's field f (e.g. pc2, strobes0)
const key = (f, i) => `${f}${i}`;

function createFake() {
  const buf = new ArrayBuffer(4096);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const cyc = { clk: 0, gpio_out: 1, gpio_oe: 0, intr: 0 };
  for (let i = 0; i < 4; i++) for (const [f] of SMF) cyc[key(f, i)] = 0;
  const txFifo = [[], [], [], []];
  const rxFifo = [[], [], [], []]; // scripted words per SM; a scripted S_RX_PUSH effect grows rx_level
  const rxLevel = [0, 0, 0, 0];
  const shiftModeBits = [0, 0, 0, 0]; // FJOIN_RX|FJOIN_TX|PUT|GET of the last SMx SHIFTCTRL write
  let script_ = [];
  const writes = []; // {addr, data} in retirement order (data >>> 0)
  const gpioLog = []; // gpio_in the driver composed per _pio_step clk
  let steps = 0; // _pio_step calls (the idle clk / run clks)

  const hiWord = (c) => Math.floor(c / 2 ** 32);

  function flush() {
    // A scripted S_TX_POP actually pops the FIFO model, so tx_level
    // (what the driver's mirror must agree with) stays consistent; a
    // scripted S_RX_PUSH grows that SM's RX level the same way. The
    // per-SM tx_empty/tx_full flag bits ride the SM's strobe byte.
    for (let i = 0; i < 4; i++) {
      const s = cyc[key('strobes', i)];
      if (s & S_TX_POP) txFifo[i].shift();
      if (s & S_RX_PUSH) rxLevel[i] = Math.min(rxLevel[i] + 1, 8);
      let ns = s & ~(S_TX_EMPTY | S_TX_FULL);
      if (txFifo[i].length === 0) ns |= S_TX_EMPTY;
      if (txFifo[i].length >= 8) ns |= S_TX_FULL;
      cyc[key('strobes', i)] = ns;
      cyc[key('tx_level', i)] = txFifo[i].length;
      cyc[key('rx_level', i)] = rxLevel[i];
    }
    cyc.clk += 1;
    dv.setUint32(0, (cyc.clk % 2 ** 32) >>> 0, true);
    dv.setUint32(4, hiWord(cyc.clk) >>> 0, true);
    for (const [k, off] of F) dv.setUint32(off, cyc[k] >>> 0, true);
    for (let i = 0; i < 4; i++)
      for (const [f, off] of SMF) dv.setUint32(off + 4 * i, cyc[key(f, i)] >>> 0, true);
  }

  function tick(effect) {
    for (let i = 0; i < 4; i++) cyc[key('strobes', i)] = 0; // per-clk unless set
    if (effect) Object.assign(cyc, effect);
    flush();
  }

  // which SM's config window an address falls in (-1: block-scope)
  function smWinOf(addr) {
    const off = (addr - REG_SM0) | 0;
    if (off < 0 || off >= 4 * SM_WIN) return -1;
    return Math.floor(off / SM_WIN);
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
      const txf = addr - 0x010;
      if (txf >= 0 && txf < 16 && (txf & 3) === 0) {
        const i = txf >> 2;
        if (txFifo[i].length < 8) txFifo[i].push(d & 0xff);
      }
      const sm = smWinOf(addr >>> 0);
      if (sm >= 0 && (addr - REG_SM0) % SM_WIN === 8) {
        // SPEC-6-2: a fifo-mode-changing SMx_SHIFTCTRL write flushes
        // that SM's FIFOs (the engine retires the discard on the
        // following clk; the fake folds it into the write's own
        // post-edge sample)
        const mode = d & 0xc000c000;
        if (mode !== shiftModeBits[sm]) {
          shiftModeBits[sm] = mode;
          txFifo[sm].length = 0;
          rxFifo[sm].length = 0;
          rxLevel[sm] = 0;
        }
      }
      tick();
    },
    _pio_reg_read: (addr) => {
      // rdata is the pre-edge view (RXFx: the head word before the pop
      // retires); the struct then advances one clk like pio_reg_write
      let v = 0;
      if (addr === 0x00c) {
        // FLEVEL: TXi at 8i, RXi at 8i+4 (SPEC-7-29)
        for (let i = 0; i < 4; i++)
          v |= (txFifo[i].length << (8 * i)) | (rxLevel[i] << (8 * i + 4));
      } else {
        const rxf = addr - 0x020;
        if (rxf >= 0 && rxf < 16 && (rxf & 3) === 0) {
          const i = rxf >> 2;
          // RXFx pop: a scripted word, or 0 on the empty FIFO (the model
          // returns undefined + RXUNDER; the driver never drains empty by
          // contract — the fake keeps 0 so a violation still shows up as a
          // wrong rdata, not a crash).
          rxLevel[i] = Math.max(0, rxLevel[i] - 1);
          v = rxFifo[i].length ? rxFifo[i].shift() : 0;
        }
      }
      for (let i = 0; i < 4; i++) cyc[key('strobes', i)] = 0;
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
    rxFeed: (words, sm = 0) => {
      rxFifo[sm].push(...words);
    },
    writes,
    gpioLog,
    stepsCount: () => steps,
    txFifo: (sm = 0) => txFifo[sm].slice(),
  };
}

module.exports = { createFake };

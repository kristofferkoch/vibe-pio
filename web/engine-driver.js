// engine-driver.js — the C18 client core, grown into the C21 sandbox
// driver (KANBAN C18/C19/C21).
//
// Pure logic, no DOM and no Worker API: the same instance runs inside
// web/engine-worker.js (the browser client) and under node
// (web/node_client_gate.js) — the CI gate therefore checks exactly what
// the view renders. The engine itself is the verified RTL (the C17
// wasm build); this driver never re-implements PIO semantics, it only
//
//   - drives the game face (pio_reg_write / pio_reg_read / pio_step) —
//     loading a sandbox state + config overlay is just reg-bus writes
//     (SPEC-7-10/14..26), one retired clk each, every cycle rendered;
//     post-load overlay edits land the same way (the feed discipline,
//     the SPEC-6-2 settle clk queued after a FJOIN-changing write);
//   - decodes the pre-edge PioCycle sample (pio_shim.cpp: the negedge
//     sample point — CC-40 pin landing, start-of-clk SM state);
//   - keeps the TX/RX mirrors (display bookkeeping only: TX = the words
//     this client wrote minus the engine's tx_pop strobes; RX = one
//     count per rx_push strobe minus the queued RXF0 drains, the words
//     themselves learned only by draining — level bars always show the
//     engine's tx_level/rx_level);
//   - composes the per-clk gpio_in (drive latches + the pattern
//     generator; reg-op clks hold the last level — the shim's sticky
//     input discipline) and runs the monitor lens over the stored gpio
//     history (off / square / uart on a picked pin, replayed when the
//     pin changes) plus the per-cycle waveform tags;
//   - serializes the stored-program format (words + config overlay —
//     the JSON that seeds level authoring; feeds/lens/drives are
//     session state and stay out).
//
// Red-injection hooks for the mutation demos (never enabled in a real
// run; web/node_client_gate.js and web/tests/sandbox.test.js turn them
// on via create()'s `defects` argument):
//   {pin: true}     — sample gpio_out bit (lensPin+1) instead of the
//                     lens pin: the pin series diverges from the oracle;
//   {mirror: true}  — the TX mirror never pops: it disagrees with the
//                     engine's tx_level;
//   {rx: true}      — the RX mirror never counts pushes: the
//                     pushes−drains == rx_level invariant breaks;
//   {lens: true}    — the uart lens samples each data cell one cell
//                     late; the square lens miscounts its period;
//   {pattern: true} — the pattern generator runs one clk of phase
//                     ahead: the composed gpio series diverges;
//   {overlay: true} — the SHIFTCTRL composer transcribes PULL_THRESH
//                     at 24:20 instead of 29:25: the overlay→reg-write
//                     mapping diverges from the datasheet.

/* global PioEngine */
((global) => {
  'use strict';

  // ---- register map (SPEC-7-x; mirrors tools/pio_model/stim.py) ----
  const REG = {
    CTRL: 0x000,
    FSTAT: 0x004,
    FDEBUG: 0x008,
    FLEVEL: 0x00c,
    TXF0: 0x010,
    RXF0: 0x020,
    IRQ: 0x030,
    IRQ_FORCE: 0x034,
    ISB: 0x038,
    PADOUT: 0x03c,
    PADOE: 0x040,
    CFGINFO: 0x044,
    IMEM0: 0x048, // + 4*i (SPEC-7-10)
    SM0: 0x0c8, // + CLKDIV 0 / EXECCTRL 4 / SHIFTCTRL 8 / ADDR 12 / INSTR 16 / PINCTRL 20
    PUTGET0: 0x128, // + 4*y (SPEC-7-13)
  };

  // u_exec onehot FSM (rtl/pio_sm_exec.sv)
  const ST = { FETCH: 1, EXEC: 2, STALL: 4, DELAY: 8 };

  // PioCycle strobe bits (pio_shim.cpp)
  const S_TICK = 1,
    S_EXEC = 2,
    S_COMPLETE = 4,
    S_PC_WR = 8,
    S_TX_POP = 16,
    S_RX_PUSH = 32,
    S_TX_EMPTY = 64,
    S_TX_FULL = 128;

  // PioCycle struct offsets in bytes (pio_shim.cpp — little-endian).
  const CYC = {
    clk: 0,
    gpio_out: 8,
    gpio_oe: 12,
    intr: 16,
    pc: 20,
    state: 24,
    delay: 28,
    x: 32,
    y: 36,
    osr: 40,
    isr: 44,
    osr_cnt: 48,
    isr_cnt: 52,
    tx_level: 56,
    rx_level: 60,
    strobes: 64,
  };
  const CYC_SIZE = 72;

  // ---------------- sandbox state: the config overlay ----------------
  // Field tables (group → field → [hi, lo, max]); bit fields are
  // boolean, multi-bit fields numeric. Compose/decompose are total over
  // the given object (missing fields read 0/false — the stim.py builder
  // convention); the stored states carry every field so their words are
  // the datasheet's, and the reset defaults below are the hardware
  // reset words (model.py CLKDIV/EXECCTRL/SHIFTCTRL/PINCTRL_RESET).
  const CLKDIV_RESET = 0x00010000; // INT=1 FRAC=0 (SPEC-7-14)

  const OVERLAY_GROUPS = {
    clkdiv: { addr: () => REG.SM0 + 0, fields: { intg: [31, 16, 65535], frac: [15, 8, 255] } },
    execctrl: {
      addr: () => REG.SM0 + 4,
      fields: {
        sideEn: [30, 30, 'b'],
        sidePindirs: [29, 29, 'b'],
        jmpPin: [28, 24, 31],
        outEnSel: [23, 19, 31],
        inlineOutEn: [18, 18, 'b'],
        outSticky: [17, 17, 'b'],
        wrapTop: [16, 12, 31],
        wrapBot: [11, 7, 31],
        statusSel: [6, 5, 3],
        statusN: [4, 0, 31],
      },
    },
    shiftctrl: {
      addr: () => REG.SM0 + 8,
      fields: {
        fjoinRx: [31, 31, 'b'],
        fjoinTx: [30, 30, 'b'],
        pullThr: [29, 25, 'thr'],
        pushThr: [24, 20, 'thr'],
        outRight: [19, 19, 'b'],
        inRight: [18, 18, 'b'],
        autopull: [17, 17, 'b'],
        autopush: [16, 16, 'b'],
        fjoinRxPut: [15, 15, 'b'],
        fjoinRxGet: [14, 14, 'b'],
        inCount: [4, 0, 31],
      },
    },
    pinctrl: {
      addr: () => REG.SM0 + 20,
      fields: {
        ssCnt: [31, 29, 5],
        setCnt: [28, 26, 5],
        outCnt: [25, 20, 32],
        inBase: [19, 15, 31],
        ssBase: [14, 10, 31],
        setBase: [9, 5, 31],
        outBase: [4, 0, 31],
      },
    },
  };

  function composeOverlay(group, fields, defects) {
    const spec = OVERLAY_GROUPS[group];
    let w = 0;
    for (const [name, [hi, lo, max]] of Object.entries(spec.fields)) {
      const v = fields[name]; // missing reads 0/false (the stim builders)
      if (v === undefined || v === null || v === false || v === 0) continue;
      let bit = lo;
      // defect hook: PULL_THRESH transcribed at 24:20 (the plausible
      // copy-paste from PUSH_THRESH one field over)
      if (defects?.overlay && group === 'shiftctrl' && name === 'pullThr') bit = 20;
      const width = max === 'b' ? 1 : (1 << (hi - lo + 1)) - 1;
      w |= ((max === 'b' ? 1 : Number(v) & width) << bit) >>> 0;
    }
    return w >>> 0;
  }

  function decomposeOverlay(group, word) {
    const out = {};
    for (const [name, [hi, lo, max]] of Object.entries(OVERLAY_GROUPS[group].fields)) {
      if (max === 'b') out[name] = ((word >>> lo) & 1) === 1;
      else if (max === 'thr')
        out[name] = (word >>> lo) & 31 || 32; // 0 encodes 32
      else out[name] = (word >>> lo) & ((1 << (hi - lo + 1)) - 1);
    }
    return out;
  }

  function newState() {
    // the reset-overlay state: all-zero memory (the jmp-0 park), every
    // config field at its hardware reset value
    return {
      words: new Array(32).fill(0),
      clkdiv: { intg: 1, frac: 0 },
      pinctrl: { ssCnt: 0, setCnt: 5, outCnt: 0, inBase: 0, ssBase: 0, setBase: 0, outBase: 0 },
      execctrl: {
        sideEn: false,
        sidePindirs: false,
        jmpPin: 0,
        outEnSel: 0,
        inlineOutEn: false,
        outSticky: false,
        wrapTop: 1,
        wrapBot: 31,
        statusSel: 3,
        statusN: 31,
      },
      shiftctrl: {
        fjoinRx: false,
        fjoinTx: false,
        pullThr: 32,
        pushThr: 32,
        outRight: true,
        inRight: true,
        autopull: false,
        autopush: false,
        fjoinRxPut: false,
        fjoinRxGet: false,
        inCount: 0,
      },
      feeds: [],
      entry: null,
      lens: null, // {mode:'off'|'uart'|'square', pin} — session preset
    };
  }

  // The demoted level-02 uart_tx fixture as a sandbox state (the C18
  // LEVEL): every field explicit so the composed words are bit-for-bit
  // the C18 load timeline words.
  //   0: 0x9FA0  pull block side 1 [7]
  //   1: 0xF727  set x, 7 side 0 [7]
  //   2: 0x6001  out pins, 1
  //   3: 0x0642  jmp x--, 2 [6]
  function demoUartTx() {
    const st = newState();
    st.words = [0x9fa0, 0xf727, 0x6001, 0x0642].concat(new Array(28).fill(0));
    st.pinctrl = { ssCnt: 2, setCnt: 0, outCnt: 1, inBase: 0, ssBase: 0, setBase: 0, outBase: 0 };
    st.execctrl = {
      sideEn: true,
      sidePindirs: false,
      jmpPin: 0,
      outEnSel: 0,
      inlineOutEn: false,
      outSticky: false,
      wrapTop: 3,
      wrapBot: 0,
      statusSel: 0,
      statusN: 0,
    };
    st.shiftctrl = { ...st.shiftctrl, fjoinTx: true };
    st.feeds = [0x50, 0x49, 0x4f, 0x21]; // 'P','I','O','!'
    st.lens = { mode: 'uart', pin: 0 };
    return st;
  }

  function parseState(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('state: not an object');
    const words = obj.words;
    if (!Array.isArray(words) || words.length !== 32)
      throw new Error('state.words: expected 32 slots');
    const st = newState();
    for (let i = 0; i < 32; i++) {
      const w = words[i];
      if (!Number.isInteger(w) || w < 0 || w > 0xffff)
        throw new Error(`state.words[${i}]: not a 16-bit word`);
      st.words[i] = w;
    }
    for (const group of ['clkdiv', 'pinctrl', 'execctrl', 'shiftctrl']) {
      const src = obj[group] || {};
      for (const [name, [, , max]] of Object.entries(OVERLAY_GROUPS[group].fields)) {
        let v = src[name];
        if (v === undefined) v = newState()[group][name]; // absent → reset default
        if (max === 'b') {
          if (typeof v !== 'boolean') throw new Error(`${group}.${name}: not a boolean`);
          st[group][name] = v;
        } else {
          v = Number(v);
          const hiV = max === 'thr' ? 32 : max;
          const loV = name === 'intg' || name === 'frac' ? 0 : max === 'thr' ? 1 : 0;
          if (!Number.isInteger(v) || v < loV || v > hiV)
            throw new Error(`${group}.${name}: out of range (${loV}..${hiV})`);
          st[group][name] = v;
        }
      }
    }
    if (obj.feeds !== undefined) {
      if (!Array.isArray(obj.feeds)) throw new Error('state.feeds: not an array');
      st.feeds = obj.feeds.map((f) => {
        if (!Number.isInteger(f) || f < 0 || f > 0xffffffff)
          throw new Error('state.feeds: not a word');
        return f;
      });
    }
    if (obj.entry !== undefined && obj.entry !== null) {
      if (!Number.isInteger(obj.entry) || obj.entry < 0 || obj.entry > 31)
        throw new Error('state.entry: not a pc');
      st.entry = obj.entry;
    }
    if (obj.lens !== undefined && obj.lens !== null) {
      const { mode, pin } = obj.lens;
      if (!['off', 'uart', 'square'].includes(mode)) throw new Error('state.lens.mode');
      if (!Number.isInteger(pin) || pin < 0 || pin > 31) throw new Error('state.lens.pin');
      st.lens = { mode, pin };
    }
    return st;
  }

  function create(M, defects) {
    const DEFECT_PIN = !!defects?.pin;
    const DEFECT_MIRROR = !!defects?.mirror;
    const DEFECT_RX = !!defects?.rx;
    const DEFECT_LENS = !!defects?.lens;
    const DEFECT_PATTERN = !!defects?.pattern;
    const DEFECT_OVERLAY = !!defects?.overlay;
    const cyclePtr = M._pio_last_cycle();
    const dv = new DataView(M.HEAPU8.buffer, cyclePtr, CYC_SIZE);

    function readCycle() {
      return {
        clk: dv.getUint32(CYC.clk, true) + dv.getUint32(CYC.clk + 4, true) * 4294967296,
        gpioOut: dv.getUint32(CYC.gpio_out, true),
        gpioOe: dv.getUint32(CYC.gpio_oe, true),
        intr: dv.getUint32(CYC.intr, true),
        pc: dv.getUint32(CYC.pc, true),
        state: dv.getUint32(CYC.state, true),
        delay: dv.getUint32(CYC.delay, true),
        x: dv.getUint32(CYC.x, true),
        y: dv.getUint32(CYC.y, true),
        osr: dv.getUint32(CYC.osr, true),
        isr: dv.getUint32(CYC.isr, true),
        osrCnt: dv.getUint32(CYC.osr_cnt, true),
        isrCnt: dv.getUint32(CYC.isr_cnt, true),
        txLevel: dv.getUint32(CYC.tx_level, true),
        rxLevel: dv.getUint32(CYC.rx_level, true),
        strobes: dv.getUint32(CYC.strobes, true),
      };
    }

    // ---------------- state ----------------
    let gpioWords = []; // raw gpio_out word per rendered clk (the history)
    let pins = []; // lens-pin bit per cycle (the waveform truth)
    let tags = []; // lens-derived meaning per cycle
    let txWords = []; // TX FIFO contents mirror (display bookkeeping)
    let pendingOps = []; // queued reg-bus ops, one rendered clk each
    let memWords = new Array(32).fill(0); // imem image this client wrote
    let last = null; // decoded PioCycle of the most recent clk
    let flashes = {};
    let refused = 0;
    // the config overlay (the driver's mirror of what it last wrote)
    let ov = {
      clkdiv: { ...newState().clkdiv },
      pinctrl: { ...newState().pinctrl },
      execctrl: { ...newState().execctrl },
      shiftctrl: { ...newState().shiftctrl },
    };
    // stimulus wiring: per-pin drive latches + the pattern generator
    const drives = new Array(32).fill(null); // null | 0 | 1 (mutated in place)
    let pattern = { mode: 'off', pin: 0, period: 16, bits: [0], startIdx: 0 }; // reassigned by setPattern
    // the monitor lens
    let lens = { mode: 'off', pin: 0 };
    // the RX mirror: one count per rx_push strobe, minus the drains
    let rxPushes = 0;
    let rxDrains = 0;
    let rxWords = []; // drained words (the only way contents are learned)
    let readLog = []; // recent queued-read results {addr, rdata}
    let mon = monInit();
    let sq = sqInit();

    function monInit() {
      return { armed: false, start: 0, bits: [], frameOff: null, stopTail: -1, decoded: '' };
    }
    function sqInit() {
      return { prev: 0, lastRise: null, period: null, dutyPct: null, edges: 0, highInCycle: 0 };
    }

    function lensBitOf(word) {
      return (word >>> (DEFECT_PIN ? (lens.pin + 1) & 31 : lens.pin)) & 1;
    }

    // Receiver-style uart lens over engine pin samples: arms on the
    // idle→0 falling edge, tags cycles by frame position, decodes at the
    // stop-bit center (mockups/sm-view.html monitor, C15 flavor). The
    // frame is DECIDED at the stop center (off 76) — the lens disarms
    // there (a back-to-back frame's next falling edge lands at off 80
    // and must be caught), with stopTail keeping the tag warm through
    // the stop bit's tail cycles.
    function monitorCycle(pin, k) {
      // k=0 has no prior level: the reset-0 pad startup is not a
      // falling edge — the lens only arms on a seen 1→0 transition.
      const prev = k > 0 ? pins[k - 1] : 0;
      if (!mon.armed) {
        if (k <= mon.stopTail) return 'STOP';
        if (prev === 1 && pin === 0) {
          mon.armed = true;
          mon.start = k;
          mon.bits = [];
        }
        return 'IDLE';
      }
      const off = k - mon.start;
      mon.frameOff = off;
      // data cells sampled at their centers; the defect samples one
      // cell late (the bits rotate → a different char decodes)
      const cellOff = DEFECT_LENS ? 4 : 0;
      if (off >= 12 && off < 76 && (off - 12 + cellOff) % 8 === 0 && mon.bits.length < 8)
        mon.bits.push(pin);
      if (off < 8) return 'START';
      if (off < 72) return `D${(off - 8) >> 3}`;
      if (off === 76) {
        // stop-bit center: 9.5 bit times
        let ch = 0;
        mon.bits.forEach((b, i) => {
          ch |= b << i;
        });
        if (pin === 1 && mon.bits.length === 8) mon.decoded += String.fromCharCode(ch);
        mon.armed = false;
        mon.frameOff = null;
        mon.stopTail = mon.start + 79;
      }
      return 'STOP';
    }

    // Square lens: rising-edge tracker. The verdict is the last
    // completed period (clks between the last two rising edges) and its
    // duty cycle — a lens, never a judge.
    function squareCycle(pin, k) {
      if (pin === 1 && sq.prev === 0) {
        if (sq.lastRise !== null) {
          const p = k - sq.lastRise;
          sq.period = DEFECT_LENS ? p + 1 : p;
          sq.dutyPct = Math.round((100 * sq.highInCycle) / p);
        }
        sq.lastRise = k;
        sq.edges++;
        sq.highInCycle = 1;
      } else if (pin === 1) sq.highInCycle++;
      sq.prev = pin;
      return '';
    }

    function lensStep(k) {
      const pin = pins[k];
      if (lens.mode === 'uart') return monitorCycle(pin, k);
      if (lens.mode === 'square') return squareCycle(pin, k);
      return '';
    }

    // Re-derive pins/tags from the stored gpio history after a lens
    // change (the decode replays; the engine timeline never rewinds).
    function rebuildLensSeries() {
      pins = gpioWords.map(lensBitOf);
      mon = monInit();
      sq = sqInit();
      tags = new Array(pins.length).fill('');
      for (let k = 0; k < pins.length; k++) tags[k] = lensStep(k);
    }

    function record(cycle) {
      gpioWords.push(cycle.gpioOut);
      pins.push(lensBitOf(cycle.gpioOut));
      tags.push(lensStep(pins.length - 1));
      if (cycle.strobes & S_TX_POP && !DEFECT_MIRROR) txWords.shift(); // defect: never pops
      if (cycle.strobes & S_RX_PUSH && !DEFECT_RX) rxPushes++; // defect: never counts
      flashes = {
        pull: !!(cycle.strobes & S_TX_POP),
        push: !!(cycle.strobes & S_RX_PUSH),
        jmp: !!(cycle.strobes & S_PC_WR),
        wrap:
          !!(cycle.strobes & S_COMPLETE) &&
          !(cycle.strobes & S_PC_WR) &&
          cycle.pc === ov.execctrl.wrapTop,
        execInsn: !!(cycle.strobes & S_EXEC),
      };
      // Latch the executing pc at record time, not lazily at read time:
      // a batch that spans EXEC->DELAY (worker {cmd:'run',cycles:N}, the
      // ?t= URL pre-run) must still display the delaying instruction —
      // found by the C20 unit suite (displayedPc latches... red/green).
      if (cycle.strobes & S_EXEC) lastExecPc = cycle.pc;
      last = cycle;
    }

    // ---- stimulus composition (gpio_in for plain steps) --------------
    function patLevel() {
      const idx = pins.length - pattern.startIdx + (DEFECT_PATTERN ? 1 : 0); // defect: 1 clk ahead
      if (pattern.mode === 'square')
        return (Math.floor(idx / (pattern.period >> 1)) & 1) === 1 ? 1 : 0;
      if (pattern.mode === 'bits') {
        const b = pattern.bits;
        return b[Math.max(0, Math.min(idx, b.length - 1))];
      }
      return 0;
    }
    function composedGpio() {
      let g = 0;
      for (let p = 0; p < 32; p++) if (drives[p] === 1) g |= 1 << p;
      if (pattern.mode !== 'off') g = (g & ~(1 << pattern.pin)) | (patLevel() << pattern.pin);
      return g >>> 0;
    }

    function doWrite(addr, data, fjoinFlush) {
      M._pio_reg_write(addr, data | 0);
      if (fjoinFlush) {
        // SPEC-6-2: the FJOIN change flushes both FIFOs (the engine
        // retires the discard on the following clk) — the mirrors reset
        // with it or they disagree with tx_level/rx_level forever after
        txWords = [];
        rxPushes = 0;
        rxDrains = 0; // rxWords (the drained log) is history and stays
      }
      record(readCycle());
    }
    function doRead(addr) {
      const v = M._pio_reg_read(addr);
      record(readCycle());
      readLog.push({ addr, rdata: v >>> 0 });
      if (readLog.length > 16) readLog.shift();
      if (addr === REG.RXF0) {
        rxWords.push(v >>> 0);
        rxDrains++;
      }
      return v;
    }
    function doStep() {
      M._pio_step(composedGpio(), 0, 0); // irq neighbours idle (SM0-only, C24 later)
      record(readCycle());
    }

    // One rendered clk: a queued reg op if any, else a plain step.
    function step() {
      if (pendingOps.length) {
        const op = pendingOps.shift();
        if (op === null)
          doStep(); // the idle clk (a step, not a write)
        else if (op.rd !== undefined) doRead(op.rd);
        else doWrite(op.addr, op.data, op.fjoinFlush);
        return;
      }
      doStep();
    }

    function clearRunState() {
      gpioWords = [];
      pins = [];
      tags = [];
      txWords = [];
      pendingOps = [];
      mon = monInit();
      sq = sqInit();
      rxPushes = 0;
      rxDrains = 0;
      rxWords = [];
      readLog = [];
      refused = 0;
      flashes = {};
      last = null;
    }

    // The load timeline mirrors tools/pio_model stim._sched_basic
    // exactly (the CI gate compares the resulting pin series against
    // pio_model): nonzero imem words, PINCTRL, EXECCTRL, SHIFTCTRL, one
    // idle clk so a FJOIN-changing SHIFTCTRL write flushes before the
    // feeds land (SPEC-6-2), CLKDIV while it differs from the reset
    // word, the optional entry force (SM0_INSTR jmp — the set_pc
    // idiom), seed feeds, enable. Every load clk is a rendered clk —
    // run(N) counts only clks after load.
    function load(state) {
      const st = parseState(state);
      M._pio_engine_reset();
      clearRunState();
      ov = {
        clkdiv: { ...st.clkdiv },
        pinctrl: { ...st.pinctrl },
        execctrl: { ...st.execctrl },
        shiftctrl: { ...st.shiftctrl },
      };
      memWords = st.words.slice();
      memWords.forEach((w, i) => {
        if (w) pendingOps.push({ addr: REG.IMEM0 + 4 * i, data: w });
      });
      pendingOps.push({ addr: REG.SM0 + 20, data: compose('pinctrl') });
      pendingOps.push({ addr: REG.SM0 + 4, data: compose('execctrl') });
      pendingOps.push({ addr: REG.SM0 + 8, data: compose('shiftctrl') });
      pendingOps.push(null); // the idle clk (SPEC-6-2)
      const cd = compose('clkdiv');
      if (cd !== CLKDIV_RESET) pendingOps.push({ addr: REG.SM0 + 0, data: cd });
      if (st.entry !== null) pendingOps.push({ addr: REG.SM0 + 16, data: st.entry & 31 });
      for (const f of st.feeds) pendingOps.push({ addr: REG.TXF0, data: f });
      pendingOps.push({ addr: REG.CTRL, data: 1 }); // SM0 enable (SPEC-7-2)
      lens = st.lens ? { ...st.lens } : { mode: 'off', pin: 0 };
      rebuildLensSeries();
      while (pendingOps.length) step();
      txWords = st.feeds.slice();
    }

    function compose(group) {
      return composeOverlay(group, ov[group], { overlay: DEFECT_OVERLAY });
    }

    function run(n) {
      for (let i = 0; i < n; i++) step();
    }
    function flushOps() {
      while (pendingOps.length) step();
    }

    // Enqueue bytes into the TX FIFO as queued reg writes; refuse at the
    // first word that would overflow (tx_full from the last true sample —
    // nothing else writes between cycles, so the cached flag is exact).
    function enqueue(bytes) {
      refused = 0;
      for (const b of bytes) {
        if (last && last.strobes & S_TX_FULL) {
          refused++;
          break;
        }
        pendingOps.push({ addr: REG.TXF0, data: b & 0xff });
        txWords.push(b & 0xff);
      }
      return refused;
    }

    // The inspector's TXF0 row: a full 32-bit word, the same mirror
    // discipline (the feed bar's enqueue is the byte flavor).
    function enqueueWord(word) {
      refused = 0;
      if (last && last.strobes & S_TX_FULL) {
        refused = 1;
        return 0;
      }
      pendingOps.push({ addr: REG.TXF0, data: word >>> 0 });
      txWords.push(word >>> 0);
      return 1;
    }

    // The fifo-mode decode (pio_sm.sv / model.fifo_mode, SPEC-6-2/3):
    // any change of THIS value (not just the two join bits) flushes the
    // FIFOs and wants the settle clk behind the SHIFTCTRL write.
    function fifoModeOf(sc) {
      if (sc.fjoinRxPut) return sc.fjoinRxGet ? 'putget' : 'txput';
      if (sc.fjoinRxGet) return 'txget';
      if (sc.fjoinTx) return 'tx';
      if (sc.fjoinRx) return 'rx';
      return 'txrx';
    }

    // A config-field edit: update the overlay mirror and queue the
    // composed reg write (one rendered clk, SPEC-7-x). A fifo-mode-
    // changing SHIFTCTRL edit flushes the FIFOs (SPEC-6-2): the write
    // carries the mirror reset and the settle clk follows so a feeding
    // write cannot land on the flush edge.
    function setOverlayField(group, field, value) {
      const spec = OVERLAY_GROUPS[group].fields[field];
      if (!spec) throw new Error(`overlay: no field ${group}.${field}`);
      const max = spec[2];
      if (max === 'b') {
        if (typeof value !== 'boolean') throw new Error(`${group}.${field}: not a boolean`);
      } else {
        value = Number(value);
        const hiV = max === 'thr' ? 32 : max;
        const loV = max === 'thr' ? 1 : 0;
        if (!Number.isInteger(value) || value < loV || value > hiV)
          throw new Error(`${group}.${field}: out of range (${loV}..${hiV})`);
      }
      const modeBefore = fifoModeOf(ov.shiftctrl);
      ov[group][field] = value;
      pendingOps.push({ addr: OVERLAY_GROUPS[group].addr(), data: compose(group) });
      if (group === 'shiftctrl' && modeBefore !== fifoModeOf(ov.shiftctrl)) {
        pendingOps[pendingOps.length - 1].fjoinFlush = true;
        pendingOps.push(null);
      }
    }

    // Hold-latch a manual pin drive (null releases the pin). The level
    // composes into gpio_in on every subsequent step clk; reg-op clks
    // hold the last level (the shim's sticky input discipline).
    function setDrive(pin, level) {
      if (!Number.isInteger(pin) || pin < 0 || pin > 31) throw new Error('drive: bad pin');
      if (level !== null && level !== 0 && level !== 1) throw new Error('drive: level 0|1|null');
      drives[pin] = level;
    }

    // The deterministic pattern generator: square (period clks, even,
    // half low / half high) or a pasted bitstream (plays once per clk,
    // holds its final bit), on one pin — it owns the pin over the drive
    // latch. Output is a pure function of clks since arming.
    function setPattern(cfg) {
      const mode = cfg?.mode || 'off';
      if (!['off', 'square', 'bits'].includes(mode)) throw new Error('pattern: bad mode');
      pattern = {
        mode,
        pin: pattern.pin,
        period: pattern.period,
        bits: pattern.bits,
        startIdx: pins.length,
      };
      if (mode === 'square') {
        let p = Math.max(2, Math.round(Number(cfg.period) || 16));
        if (p & 1) p++; // even periods only (half low / half high)
        pattern.period = p;
        pattern.pin = clampPin(cfg.pin);
      } else if (mode === 'bits') {
        const bits = (cfg.bits || []).map((b) => (b ? 1 : 0));
        if (!bits.length) bits.push(0);
        pattern.bits = bits;
        pattern.pin = clampPin(cfg.pin);
      }
    }
    function clampPin(pin) {
      const p = Number(pin);
      if (!Number.isInteger(p) || p < 0 || p > 31) throw new Error('pattern: bad pin');
      return p;
    }

    // The monitor lens: off by default; uart/square on the picked pin.
    // Changing mode or pin replays the decode over the stored history.
    function setLens(cfg) {
      const mode = cfg?.mode || 'off';
      if (!['off', 'uart', 'square'].includes(mode)) throw new Error('lens: bad mode');
      lens = { mode, pin: clampPin(cfg?.pin ?? lens.pin) };
      rebuildLensSeries();
    }

    // Queue RXF0 reads (the RX drain): one rendered clk each, the words
    // learned only by draining (the R-line discipline). Never queues
    // past the mirrored level — read-on-empty is the model's RXUNDER.
    function drainRx(n) {
      const avail = Math.max(0, rxPushes - rxDrains);
      const k = Math.max(0, Math.min(Math.floor(n) || 0, avail));
      for (let i = 0; i < k; i++) pendingOps.push({ rd: REG.RXF0 });
      return k;
    }

    // A queued read, flushed to its result (each op a rendered clk).
    function readRegNow(addr) {
      pendingOps.push({ rd: addr });
      flushOps();
      for (let i = readLog.length - 1; i >= 0; i--)
        if (readLog[i].addr === addr >>> 0) return readLog[i].rdata;
      return 0;
    }

    // A generic reg write, flushed (the inspector's non-overlay rows:
    // CTRL pulses, IRQ W1C/force, INPUT_SYNC_BYPASS, FDEBUG W1C, the
    // SM0_INSTR force — config regs go through setOverlayField so the
    // overlay mirror stays the truth, TXF0 through enqueue so the TX
    // mirror stays exact).
    function writeRegNow(addr, data) {
      pendingOps.push({ addr: addr >>> 0, data: data | 0 });
      flushOps();
    }

    // The C19 re-assemble-on-edit commit path: patch the live imem image
    // (SPEC-7-10, one rendered clk per changed word — writing imem of a
    // running SM is legal; the SM fetches the new bits on its next
    // instruction boundary). words is the full 32-slot image; only
    // slots that differ from what this client last wrote are queued,
    // and 0 clears a slot back to untouched-memory (jmp 0).
    function setProgram(words) {
      for (let i = 0; i < 32; i++) {
        const w = words[i] | 0;
        if (w !== memWords[i]) {
          pendingOps.push({ addr: REG.IMEM0 + 4 * i, data: w });
          memWords[i] = w;
        }
      }
    }

    // "⏭ INSN": step until the displayed instruction changes (or the SM
    // stalls) — the mock-up's do/while over true engine samples.
    function stepInsn() {
      const p0 = displayedPc();
      let n = 0;
      do {
        step();
        n++;
      } while (displayedPc() === p0 && phaseOf() !== 'STALL' && n < 200);
    }

    // pc of the most recent S_EXEC clk — latched eagerly in record() so
    // unobserved batches still display the delaying instruction
    let lastExecPc = 0;
    function displayedPc() {
      if (!last) return 0;
      return last.state === ST.DELAY ? lastExecPc : last.pc;
    }
    function phaseOf() {
      if (!last) return 'OFF';
      if (last.state === ST.STALL) return 'STALL';
      if (last.state === ST.DELAY) return 'DELAY';
      if (last.state === ST.FETCH || last.state === ST.EXEC)
        return last.strobes & S_TICK ? 'EXEC' : 'OFF';
      return 'OFF';
    }

    // FIFO depths implied by the join/aux overlay (SPEC-6-2/3/4).
    function fifoDepths() {
      const sc = ov.shiftctrl;
      if (sc.fjoinRxPut || sc.fjoinRxGet) return { tx: 4, rx: 0 };
      if (sc.fjoinRx && sc.fjoinTx) return { tx: 0, rx: 0 };
      if (sc.fjoinRx) return { tx: 0, rx: 8 };
      if (sc.fjoinTx) return { tx: 8, rx: 0 };
      return { tx: 4, rx: 4 };
    }

    // The stored-program format: words + the config overlay (feeds,
    // lens, drives are session state — the same JSON seeds level
    // authoring, and levels do not carry a FIFO's worth of stimulus).
    function serialize() {
      return {
        v: 1,
        words: memWords.slice(),
        clkdiv: { ...ov.clkdiv },
        pinctrl: { ...ov.pinctrl },
        execctrl: { ...ov.execctrl },
        shiftctrl: { ...ov.shiftctrl },
      };
    }

    const WAVE_WIN = 128;
    function getState() {
      const n = pins.length;
      const from = Math.max(0, n - WAVE_WIN);
      const depths = fifoDepths();
      return {
        cycle: last ? last.clk : 0,
        pin: n ? pins[n - 1] : 0,
        pc: last ? last.pc : 0,
        displayPc: displayedPc(),
        phase: phaseOf(),
        delay: last ? last.delay : 0,
        x: last ? last.x : 0,
        y: last ? last.y : 0,
        osr: last ? last.osr : 0,
        isr: last ? last.isr : 0,
        osrCnt: last ? last.osrCnt : 0,
        isrCnt: last ? last.isrCnt : 0,
        gpioOut: last ? last.gpioOut : 0,
        gpioOe: last ? last.gpioOe : 0,
        intr: last ? last.intr : 0,
        txLevel: last ? last.txLevel : 0,
        txEmpty: last ? !!(last.strobes & S_TX_EMPTY) : true,
        txFull: last ? !!(last.strobes & S_TX_FULL) : false,
        txWords: txWords.slice(),
        rxLevel: last ? last.rxLevel : 0,
        rxWords: rxWords.slice(),
        rxMirror: {
          pushes: rxPushes,
          drains: rxDrains,
          ok: rxPushes - rxDrains === (last ? last.rxLevel : 0),
        },
        fifoDepths: depths,
        monitor: {
          decoded: mon.decoded,
          frameOff: mon.armed ? mon.frameOff : null,
          square:
            lens.mode === 'square'
              ? { period: sq.period, dutyPct: sq.dutyPct, edges: sq.edges }
              : null,
        },
        wave: { pins: pins.slice(from), tags: tags.slice(from), startCycle: from },
        flashes,
        refused,
        lens: { ...lens },
        overlay: {
          clkdiv: { ...ov.clkdiv },
          pinctrl: { ...ov.pinctrl },
          execctrl: { ...ov.execctrl },
          shiftctrl: { ...ov.shiftctrl },
        },
        drives: drives.slice(),
        pattern: { ...pattern, bits: pattern.bits.slice() },
        readLog: readLog.slice(),
      };
    }

    return {
      load,
      step,
      run,
      flushOps,
      stepInsn,
      enqueue,
      enqueueWord,
      setOverlayField,
      setDrive,
      setPattern,
      setLens,
      drainRx,
      readRegNow,
      writeRegNow,
      setProgram,
      serialize,
      getState,
      // a reg read is a rendered clk too (the trace's R-line discipline)
      readFlevel: () => readRegNow(REG.FLEVEL),
      allPins: () => pins.slice(),
      allGpio: () => gpioWords.slice(),
      REG,
      ST,
    };
  }

  const EMPTY = newState();
  const DEMO_UART_TX = demoUartTx();
  const api = {
    create,
    newState,
    parseState,
    composeOverlay,
    decomposeOverlay,
    // the inspector's field table (bit ranges + max/kind for its inputs)
    OVERLAY_GROUP_FIELDS: (group) => Object.entries(OVERLAY_GROUPS[group].fields),
    EMPTY,
    DEMO_UART_TX,
    REG,
    ST,
    CYC,
  };
  global.VibeDriver = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(this);

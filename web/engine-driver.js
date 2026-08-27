// engine-driver.js — the C18 client core, grown into the C21 sandbox
// driver and the C24 multi-SM sandbox (KANBAN C18/C19/C21/C22/C24).
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
//     sample point — CC-40 pin landing, start-of-clk SM state) — per
//     SM since C24: all four machines' phase/scratch/shifters/FIFO
//     levels/strobes plus the per-SM pad write masks (the CC-7
//     ownership lens);
//   - keeps the TX/RX mirrors per SM (display bookkeeping only: TX =
//     the words this client wrote minus the engine's tx_pop strobes;
//     RX = one count per rx_push strobe minus the queued RXFx drains,
//     the words themselves learned only by draining — level bars
//     always show the engine's tx_level/rx_level);
//   - composes the per-clk gpio_in (drive latches + the pattern
//     generator; reg-op clks hold the last level — the shim's sticky
//     input discipline) and runs the monitor lens over the stored gpio
//     history (off / square / uart on a picked pin, replayed when the
//     pin changes) plus the per-cycle waveform tags;
//   - tracks pad ownership: the last SM to write each pin, ties broken
//     by the CC-7 scan order (ascending — the highest-numbered SM's
//     write lands last), exactly the resolution the RTL performs;
//   - serializes the stored-program format (words + the per-SM config
//     overlay — the JSON that seeds level authoring; feeds/lens/drives
//     are session state and stay out);
//   - maps the C22 drawn-config grammar (DESIGN-NOTES: shift-direction
//     arrows, autopull/autopush toggles + threshold steppers, the FIFO
//     join cycle, wrap steppers, pin-mapping base·count steppers) onto
//     overlay edits of ONE SM — every drawn control is a real reg write
//     to that SM's window, nothing is display-only. controlEdit is the
//     pure gesture→edits table; setOverlayFields lands a multi-field
//     edit as ONE composed write per group (the atomic join edit must
//     not pay two SPEC-6-2 settle clks).
//
// The stored-program format v2 (C24): { v:2, words, sms:[4] } with one
// {en, clkdiv, pinctrl, execctrl, shiftctrl} overlay per SM (feeds and
// entry are per-SM session presets like v1's). v1 objects (flat
// top-level groups) still parse — they are the SM0-authored scope, so
// SM1..3 load disabled: the legacy programs predate the playground.
//
// Red-injection hooks for the mutation demos (never enabled in a real
// run; web/node_client_gate.js and the unit suites turn them on via
// create()'s `defects` argument):
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
//                     mapping diverges from the datasheet;
//   {cfgctrl: true} — the drawn fifo-join cycle swaps its bits onto
//                     FJOIN_RX (bit 31) where the grammar says FJOIN_TX
//                     (bit 30): the C22 field↔reg-write mapping
//                     diverges (the drawn-config red case);
//   {smaddr: true}  — the SM config-window stride is transcribed as
//                     0x14 instead of 0x18: SM1..3 overlay writes land
//                     in the previous SM's window (the C24 multi-SM
//                     red case);
//   {owner: true}   — the pad-ownership scan runs descending: the
//                     lowest-numbered SM wins, inverting CC-7.

/* global PioEngine */
((global) => {
  'use strict';

  // ---- register map (SPEC-7-x; mirrors tools/pio_model/stim.py) ----
  const REG = {
    CTRL: 0x000,
    FSTAT: 0x004,
    FDEBUG: 0x008,
    FLEVEL: 0x00c,
    TXF0: 0x010, // + 4*sm (SPEC-7-28)
    RXF0: 0x020, // + 4*sm
    IRQ: 0x030,
    IRQ_FORCE: 0x034,
    ISB: 0x038,
    PADOUT: 0x03c,
    PADOE: 0x040,
    CFGINFO: 0x044,
    IMEM0: 0x048, // + 4*i (SPEC-7-10)
    SM0: 0x0c8, // SM window: stride 0x18 (SPEC-7 per-SM map), CLKDIV 0 / EXECCTRL 4 / SHIFTCTRL 8 / ADDR 12 / INSTR 16 / PINCTRL 20
    PUTGET0: 0x128, // + 0x10*sm + 4*y (SPEC-7-13)
  };
  const SMS = 4;
  const SM_WIN = 0x18; // per-SM config window stride (SPEC-7-x)

  // u_exec onehot FSM (rtl/pio_sm_exec.sv)
  const ST = { FETCH: 1, EXEC: 2, STALL: 4, DELAY: 8 };

  // PioCycle strobe bits, per SM (pio_shim.cpp)
  const S_TICK = 1,
    S_EXEC = 2,
    S_COMPLETE = 4,
    S_PC_WR = 8,
    S_TX_POP = 16,
    S_RX_PUSH = 32,
    S_TX_EMPTY = 64,
    S_TX_FULL = 128;

  // PioCycle struct offsets in bytes (pio_shim.cpp — little-endian).
  // The SM fields are per-SM arrays: field `pc` holds SM i at
  // CYC.pc + 4*i (SM-major layout, one uint32 per SM per field).
  const CYC = {
    clk: 0,
    gpio_out: 8,
    gpio_oe: 12,
    intr: 16,
    pc: 20,
    state: 36,
    delay: 52,
    x: 68,
    y: 84,
    osr: 100,
    isr: 116,
    osr_cnt: 132,
    isr_cnt: 148,
    tx_level: 164,
    rx_level: 180,
    strobes: 196,
    wr_mask: 212,
  };
  const CYC_SIZE = 228;

  // ---------------- sandbox state: the config overlay ----------------
  // Field tables (group → field → [hi, lo, max]); bit fields are
  // boolean, multi-bit fields numeric. Compose/decompose are total over
  // the given object (missing fields read 0/false — the stim.py builder
  // convention); the stored states carry every field so their words are
  // the datasheet's, and the reset defaults below are the hardware
  // reset words (model.py CLKDIV/EXECCTRL/SHIFTCTRL/PINCTRL_RESET).
  const CLKDIV_RESET = 0x00010000; // INT=1 FRAC=0 (SPEC-7-14)

  // SM-window word offsets per group (SPEC-7-14..26).
  const OVERLAY_GROUPS = {
    clkdiv: { off: 0, fields: { intg: [31, 16, 65535], frac: [15, 8, 255] } },
    execctrl: {
      off: 4,
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
      off: 8,
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
      off: 20,
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

  // Byte address of SM `sm`'s `group` register (SPEC-7 per-SM map).
  // The smaddr defect transcribes the stride as 0x14 (the two-word gap
  // to the next window's CLKDIV forgotten) — SM1..3 writes land in the
  // previous SM's window.
  function overlayAddr(sm, group, defects) {
    const stride = defects?.smaddr ? 0x14 : SM_WIN;
    return REG.SM0 + stride * (sm & 3) + OVERLAY_GROUPS[group].off;
  }

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

  // ---------------- C22: the drawn-config control table ----------------
  // The DESIGN-NOTES grammar as overlay edits — every drawn control is a
  // real reg write through the selected SM's overlay, nothing
  // display-only. Gestures: 'inc'/'dec' step a stepper through its legal
  // stored values and WRAP AROUND (the wrap-stepper idiom); 'toggle'
  // flips a drawn boolean. Kinds: 'toggle' a single boolean field;
  // 'range' a 0..max field; 'thr' a threshold stored 1..32 (compose
  // encodes 32 as 0, SPEC-5-7); 'c32' a count stored 0..31 where 0
  // displays/means 32 (OUT_COUNT/IN_COUNT, SPEC-7-26/21); 'join' the
  // FIFO-join cycle.
  const CFG_CONTROLS = {
    'osr-dir': { kind: 'toggle', group: 'shiftctrl', field: 'outRight' }, // SPEC-7-21
    'isr-dir': { kind: 'toggle', group: 'shiftctrl', field: 'inRight' }, // SPEC-7-21
    autopull: { kind: 'toggle', group: 'shiftctrl', field: 'autopull' }, // SPEC-5-8
    autopush: { kind: 'toggle', group: 'shiftctrl', field: 'autopush' }, // SPEC-5-9
    'pull-thr': { kind: 'thr', group: 'shiftctrl', field: 'pullThr' }, // SPEC-5-7
    'push-thr': { kind: 'thr', group: 'shiftctrl', field: 'pushThr' }, // SPEC-5-7
    'fifo-join': { kind: 'join' }, // SPEC-6-2/3
    'wrap-top': { kind: 'range', group: 'execctrl', field: 'wrapTop', max: 31 }, // SPEC-7-19
    'wrap-bot': { kind: 'range', group: 'execctrl', field: 'wrapBot', max: 31 }, // SPEC-7-19
    'out-base': { kind: 'range', group: 'pinctrl', field: 'outBase', max: 31 }, // SPEC-7-26
    'out-cnt': { kind: 'c32', group: 'pinctrl', field: 'outCnt' }, // SPEC-7-26
    'side-base': { kind: 'range', group: 'pinctrl', field: 'ssBase', max: 31 }, // SPEC-7-26
    'in-base': { kind: 'range', group: 'pinctrl', field: 'inBase', max: 31 }, // SPEC-7-26
    'in-cnt': { kind: 'c32', group: 'shiftctrl', field: 'inCount' }, // SPEC-7-21
  };

  // The FIFO-join cycle (SPEC-6-2/3): split → join TX → join RX → split,
  // walked by 'inc' ('dec' walks backwards). Any aux mode (FJOIN_RX_PUT/
  // GET, inspector-set) is one cycle from split — the drawn grammar owns
  // join, and the aux bits clear in the same single write.
  function cfgJoinEdits(sc, gesture, defects) {
    const edits = [];
    const setBit = (field, v) => {
      if (sc[field] !== v) edits.push(['shiftctrl', field, v]);
    };
    if (sc.fjoinRxPut || sc.fjoinRxGet) {
      setBit('fjoinRxPut', false);
      setBit('fjoinRxGet', false);
      setBit('fjoinTx', false);
      setBit('fjoinRx', false);
      return edits;
    }
    const dir = gesture === 'dec' ? 2 : 1; // +1 / −1 mod 3
    const cur = sc.fjoinTx ? 1 : sc.fjoinRx ? 2 : 0;
    const nxt = (cur + dir) % 3;
    let tx = nxt === 1,
      rx = nxt === 2;
    if (defects?.cfgctrl) [tx, rx] = [rx, tx]; // defect: the TX/RX bits swap
    setBit('fjoinTx', tx);
    setBit('fjoinRx', rx);
    return edits;
  }

  // Pure: the drawn gesture → overlay edits ([[group, field, value]]).
  // The view applies the same table to its stored-program copy, and the
  // units pin the field↔reg-write mapping against composed words.
  function controlEdit(ov, id, gesture, defects) {
    const c = CFG_CONTROLS[id];
    if (!c) throw new Error(`control: unknown ${id}`);
    if (c.kind === 'join') {
      if (gesture !== 'inc' && gesture !== 'dec') throw new Error(`control: ${id} wants inc/dec`);
      return cfgJoinEdits(ov.shiftctrl, gesture, defects);
    }
    if (c.kind === 'toggle') {
      if (gesture !== 'toggle') throw new Error(`control: ${id} wants toggle`);
      return [[c.group, c.field, !ov[c.group][c.field]]];
    }
    if (gesture !== 'inc' && gesture !== 'dec') throw new Error(`control: ${id} wants inc/dec`);
    const v = ov[c.group][c.field];
    let next;
    if (c.kind === 'thr') next = gesture === 'inc' ? (v % 32) + 1 : v === 1 ? 32 : v - 1;
    else if (c.kind === 'c32')
      next = gesture === 'inc' ? (v === 31 ? 0 : v + 1) : v === 0 ? 31 : v - 1;
    else next = gesture === 'inc' ? (v + 1) % (c.max + 1) : v === 0 ? c.max : v - 1;
    return [[c.group, c.field, next]];
  }

  // One SM's stored overlay: every field explicit so the composed words
  // are the hardware reset words (feeds/entry are session presets).
  function newSm() {
    return {
      en: true,
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
    };
  }

  function newState() {
    // the reset-overlay state: all-zero memory (the jmp-0 park), every
    // SM's config at its hardware reset value, all four enabled — the
    // fresh playground boots with four cursors orbiting slot 00
    return {
      v: 2,
      words: new Array(32).fill(0),
      sms: [newSm(), newSm(), newSm(), newSm()],
      lens: null, // {mode:'off'|'uart'|'square', pin} — session preset
    };
  }

  // The demoted level-02 uart_tx fixture as a sandbox state (the C18
  // LEVEL; SM0-authored scope — SM1..3 stay disabled so the demo keeps
  // the C18 timeline bit-for-bit). Every field explicit so the composed
  // words are bit-for-bit the C18 load timeline words.
  //   0: 0x9FA0  pull block side 1 [7]
  //   1: 0xF727  set x, 7 side 0 [7]
  //   2: 0x6001  out pins, 1
  //   3: 0x0642  jmp x--, 2 [6]
  function demoUartTx() {
    const st = newState();
    st.words = [0x9fa0, 0xf727, 0x6001, 0x0642].concat(new Array(28).fill(0));
    const sm0 = st.sms[0];
    sm0.pinctrl = { ssCnt: 2, setCnt: 0, outCnt: 1, inBase: 0, ssBase: 0, setBase: 0, outBase: 0 };
    sm0.execctrl = {
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
    sm0.shiftctrl = { ...sm0.shiftctrl, fjoinTx: true };
    sm0.feeds = [0x50, 0x49, 0x4f, 0x21]; // 'P','I','O','!'
    for (let i = 1; i < SMS; i++) st.sms[i].en = false;
    st.lens = { mode: 'uart', pin: 0 };
    return st;
  }

  // Overlay fields of one stored SM: validate + merge over the reset
  // defaults (absent fields read their reset value).
  function parseSmOverlay(dst, src) {
    for (const group of ['clkdiv', 'pinctrl', 'execctrl', 'shiftctrl']) {
      const gs = src?.[group] || {};
      for (const [name, [, , max]] of Object.entries(OVERLAY_GROUPS[group].fields)) {
        let v = gs[name];
        if (v === undefined) continue; // absent → reset default
        if (max === 'b') {
          if (typeof v !== 'boolean') throw new Error(`sms.${group}.${name}: not a boolean`);
          dst[group][name] = v;
        } else {
          v = Number(v);
          const hiV = max === 'thr' ? 32 : max;
          const loV = name === 'intg' || name === 'frac' ? 0 : max === 'thr' ? 1 : 0;
          if (!Number.isInteger(v) || v < loV || v > hiV)
            throw new Error(`${group}.${name}: out of range (${loV}..${hiV})`);
          dst[group][name] = v;
        }
      }
    }
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
    if (Array.isArray(obj.sms)) {
      // v2: the four-machine stored program
      if (obj.sms.length !== SMS) throw new Error(`state.sms: expected ${SMS} SMs`);
      for (let i = 0; i < SMS; i++) {
        const sm = obj.sms[i];
        if (sm === null || sm === undefined) continue; // absent → defaults
        if (typeof sm !== 'object') throw new Error('state.sms: not an object');
        parseSmOverlay(st.sms[i], sm);
        if (sm.en !== undefined) {
          if (typeof sm.en !== 'boolean') throw new Error('sms.en: not a boolean');
          st.sms[i].en = sm.en;
        }
        if (sm.feeds !== undefined) {
          if (!Array.isArray(sm.feeds)) throw new Error('sms.feeds: not an array');
          st.sms[i].feeds = sm.feeds.map((f) => {
            if (!Number.isInteger(f) || f < 0 || f > 0xffffffff)
              throw new Error('sms.feeds: not a word');
            return f;
          });
        }
        if (sm.entry !== undefined && sm.entry !== null) {
          if (!Number.isInteger(sm.entry) || sm.entry < 0 || sm.entry > 31)
            throw new Error('sms.entry: not a pc');
          st.sms[i].entry = sm.entry;
        }
      }
    } else {
      // v1 legacy: the flat SM0-authored scope — SM1..3 stay disabled
      parseSmOverlay(st.sms[0], obj);
      for (let i = 1; i < SMS; i++) st.sms[i].en = false;
      if (obj.feeds !== undefined) {
        if (!Array.isArray(obj.feeds)) throw new Error('state.feeds: not an array');
        st.sms[0].feeds = obj.feeds.map((f) => {
          if (!Number.isInteger(f) || f < 0 || f > 0xffffffff)
            throw new Error('state.feeds: not a word');
          return f;
        });
      }
      if (obj.entry !== undefined && obj.entry !== null) {
        if (!Number.isInteger(obj.entry) || obj.entry < 0 || obj.entry > 31)
          throw new Error('state.entry: not a pc');
        st.sms[0].entry = obj.entry;
      }
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
    const DEFECT_CFGCTRL = !!defects?.cfgctrl;
    const DEFECT_SMADDR = !!defects?.smaddr;
    const DEFECT_OWNER = !!defects?.owner;
    const cyclePtr = M._pio_last_cycle();
    const dv = new DataView(M.HEAPU8.buffer, cyclePtr, CYC_SIZE);
    const ADR = { smaddr: DEFECT_SMADDR }; // the stride defect's view

    function readCycle() {
      const sm = (i) => ({
        pc: dv.getUint32(CYC.pc + 4 * i, true),
        state: dv.getUint32(CYC.state + 4 * i, true),
        delay: dv.getUint32(CYC.delay + 4 * i, true),
        x: dv.getUint32(CYC.x + 4 * i, true),
        y: dv.getUint32(CYC.y + 4 * i, true),
        osr: dv.getUint32(CYC.osr + 4 * i, true),
        isr: dv.getUint32(CYC.isr + 4 * i, true),
        osrCnt: dv.getUint32(CYC.osr_cnt + 4 * i, true),
        isrCnt: dv.getUint32(CYC.isr_cnt + 4 * i, true),
        txLevel: dv.getUint32(CYC.tx_level + 4 * i, true),
        rxLevel: dv.getUint32(CYC.rx_level + 4 * i, true),
        strobes: dv.getUint32(CYC.strobes + 4 * i, true),
        wrMask: dv.getUint32(CYC.wr_mask + 4 * i, true),
      });
      return {
        clk: dv.getUint32(CYC.clk, true) + dv.getUint32(CYC.clk + 4, true) * 4294967296,
        gpioOut: dv.getUint32(CYC.gpio_out, true),
        gpioOe: dv.getUint32(CYC.gpio_oe, true),
        intr: dv.getUint32(CYC.intr, true),
        sms: [sm(0), sm(1), sm(2), sm(3)],
      };
    }

    // ---------------- state ----------------
    let gpioWords = []; // raw gpio_out word per rendered clk (the history)
    let pins = []; // lens-pin bit per cycle (the waveform truth)
    let tags = []; // lens-derived meaning per cycle
    let pendingOps = []; // queued reg-bus ops, one rendered clk each
    let memWords = new Array(32).fill(0); // imem image this client wrote
    let last = null; // decoded PioCycle of the most recent clk
    let refused = 0;
    let selSm = 0; // the selected SM (detail panes, stepInsn)
    // the per-SM overlay mirrors (the driver's copy of what it wrote)
    let ovs = [0, 1, 2, 3].map(() => {
      const s = newSm();
      return {
        clkdiv: { ...s.clkdiv },
        pinctrl: { ...s.pinctrl },
        execctrl: { ...s.execctrl },
        shiftctrl: { ...s.shiftctrl },
      };
    });
    // stimulus wiring: per-pin drive latches + the pattern generator
    const drives = new Array(32).fill(null); // null | 0 | 1 (mutated in place)
    let pattern = { mode: 'off', pin: 0, period: 16, bits: [0], startIdx: 0 }; // reassigned by setPattern
    // the monitor lens
    let lens = { mode: 'off', pin: 0 };
    // the per-SM TX/RX mirrors (display bookkeeping; the engine's
    // tx_level/rx_level are always the truth)
    let txWords = [[], [], [], []];
    let rxPushes = [0, 0, 0, 0];
    let rxDrains = [0, 0, 0, 0];
    let rxWords = [[], [], [], []]; // drained words (the only way contents are learned)
    let lastExecPc = [0, 0, 0, 0]; // latched at record time (the C20 lesson)
    let flashes = [{}, {}, {}, {}];
    // pad ownership: the last SM to write each pin (CC-7 scan order)
    let pinOwner = new Array(32).fill(-1);
    let readLog = []; // recent queued-read results {addr, rdata}
    // the enable mask last loaded (serialize carries it so a round
    // trip reloads the same machines)
    let serializedEn = [true, true, true, true];
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

    // Which SM a reg address belongs to, where the driver can tell: the
    // SM config window and the TXF/RXF/PUTGET strides. Addresses outside
    // any per-SM window return -1 (block-scope).
    function smOfAddr(addr) {
      const off = addr >>> 0;
      if (off >= REG.TXF0 && off < REG.TXF0 + 4 * SMS) return (off - REG.TXF0) >> 2;
      if (off >= REG.RXF0 && off < REG.RXF0 + 4 * SMS) return (off - REG.RXF0) >> 2;
      if (off >= REG.PUTGET0) return Math.floor((off - REG.PUTGET0) / 0x10) & 3;
      const stride = ADR.smaddr ? 0x14 : SM_WIN;
      for (let i = 0; i < SMS; i++) {
        const base = REG.SM0 + stride * i;
        if (off >= base && off < base + 24) return i;
      }
      return -1;
    }

    function record(cycle) {
      gpioWords.push(cycle.gpioOut);
      pins.push(lensBitOf(cycle.gpioOut));
      tags.push(lensStep(pins.length - 1));
      // pad ownership: ascending scan, last write wins — the highest
      // SM lands last, exactly the RTL's per-pin CC-7 order. The defect
      // scans descending (lowest wins).
      const order = DEFECT_OWNER ? [3, 2, 1, 0] : [0, 1, 2, 3];
      for (const i of order) {
        const m = cycle.sms[i].wrMask;
        if (!m) continue;
        for (let p = 0; p < 32; p++) if ((m >>> p) & 1) pinOwner[p] = i;
      }
      for (let i = 0; i < SMS; i++) {
        const s = cycle.sms[i];
        if (s.strobes & S_TX_POP && !DEFECT_MIRROR) txWords[i].shift(); // defect: never pops
        if (s.strobes & S_RX_PUSH && !DEFECT_RX) rxPushes[i]++; // defect: never counts
        flashes[i] = {
          pull: !!(s.strobes & S_TX_POP),
          push: !!(s.strobes & S_RX_PUSH),
          jmp: !!(s.strobes & S_PC_WR),
          wrap:
            !!(s.strobes & S_COMPLETE) &&
            !(s.strobes & S_PC_WR) &&
            s.pc === ovs[i].execctrl.wrapTop,
          execInsn: !!(s.strobes & S_EXEC),
        };
        // Latch the executing pc at record time, not lazily at read
        // time: a batch that spans EXEC->DELAY (worker {cmd:'run',cycles:N},
        // the ?t= URL pre-run) must still display the delaying
        // instruction — found by the C20 unit suite (displayedPc
        // latches... red/green).
        if (s.strobes & S_EXEC) lastExecPc[i] = s.pc;
      }
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
        // SPEC-6-2: the FJOIN change flushes that SM's FIFOs (the
        // engine retires the discard on the following clk) — the
        // mirrors reset with it or they disagree with tx_level/rx_level
        // forever after
        const i = smOfAddr(addr);
        if (i >= 0) {
          txWords[i] = [];
          rxPushes[i] = 0;
          rxDrains[i] = 0; // rxWords (the drained log) is history and stays
        }
      }
      record(readCycle());
    }
    function doRead(addr) {
      const v = M._pio_reg_read(addr);
      record(readCycle());
      readLog.push({ addr, rdata: v >>> 0 });
      if (readLog.length > 16) readLog.shift();
      if (addr >= REG.RXF0 && addr < REG.RXF0 + 4 * SMS) {
        const i = (addr - REG.RXF0) >> 2;
        rxWords[i].push(v >>> 0);
        rxDrains[i]++;
      }
      return v;
    }
    function doStep() {
      // irq_prev/next are the NEIGHBOUR BLOCKS' relay views (pio_top's,
      // CC-38) — inter-SM IRQ inside this block runs on the shared flag
      // register, so the sandbox steps with both idles.
      M._pio_step(composedGpio(), 0, 0);
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
      txWords = [[], [], [], []];
      pendingOps = [];
      mon = monInit();
      sq = sqInit();
      rxPushes = [0, 0, 0, 0];
      rxDrains = [0, 0, 0, 0];
      rxWords = [[], [], [], []];
      lastExecPc = [0, 0, 0, 0];
      flashes = [{}, {}, {}, {}];
      pinOwner = new Array(32).fill(-1);
      readLog = [];
      refused = 0;
      last = null;
    }

    // The load timeline mirrors tools/pio_model stim._sched_basic
    // exactly, grown per SM (the CI gate compares the resulting pin
    // series against pio_model): nonzero imem words, then per SM
    // PINCTRL, EXECCTRL, SHIFTCTRL, one idle clk so any FJOIN-changing
    // SHIFTCTRL write flushes before the feeds land (SPEC-6-2), CLKDIV
    // per SM while it differs from the reset word, the per-SM entry
    // force (SMx_INSTR jmp — the set_pc idiom), per-SM seed feeds
    // (TXFx), and one CTRL write enabling the enabled SMs. Every load
    // clk is a rendered clk — run(N) counts only clks after load.
    function load(state) {
      const st = parseState(state);
      M._pio_engine_reset();
      clearRunState();
      ovs = st.sms.map((s) => ({
        clkdiv: { ...s.clkdiv },
        pinctrl: { ...s.pinctrl },
        execctrl: { ...s.execctrl },
        shiftctrl: { ...s.shiftctrl },
      }));
      memWords = st.words.slice();
      memWords.forEach((w, i) => {
        if (w) pendingOps.push({ addr: REG.IMEM0 + 4 * i, data: w });
      });
      for (let i = 0; i < SMS; i++) {
        pendingOps.push({ addr: overlayAddr(i, 'pinctrl', ADR), data: compose(i, 'pinctrl') });
        pendingOps.push({ addr: overlayAddr(i, 'execctrl', ADR), data: compose(i, 'execctrl') });
        pendingOps.push({ addr: overlayAddr(i, 'shiftctrl', ADR), data: compose(i, 'shiftctrl') });
      }
      pendingOps.push(null); // the idle clk (SPEC-6-2)
      for (let i = 0; i < SMS; i++) {
        const cd = compose(i, 'clkdiv');
        if (cd !== CLKDIV_RESET) pendingOps.push({ addr: overlayAddr(i, 'clkdiv', ADR), data: cd });
      }
      for (let i = 0; i < SMS; i++)
        if (st.sms[i].entry !== null)
          pendingOps.push({
            addr: overlayAddr(i, 'execctrl', ADR) + 12,
            data: st.sms[i].entry & 31,
          }); // SMx_INSTR (window +16): jmp entry (set_pc idiom)
      for (let i = 0; i < SMS; i++)
        for (const f of st.sms[i].feeds) pendingOps.push({ addr: REG.TXF0 + 4 * i, data: f });
      let mask = 0;
      for (let i = 0; i < SMS; i++) if (st.sms[i].en) mask |= 1 << i;
      serializedEn = [0, 1, 2, 3].map((i) => !!((mask >> i) & 1));
      pendingOps.push({ addr: REG.CTRL, data: mask }); // SPEC-7-2
      lens = st.lens ? { ...st.lens } : { mode: 'off', pin: 0 };
      rebuildLensSeries();
      while (pendingOps.length) step();
      txWords = st.sms.map((s) => s.feeds.slice());
    }

    function compose(sm, group) {
      return composeOverlay(group, ovs[sm][group], { overlay: DEFECT_OVERLAY });
    }

    function run(n) {
      for (let i = 0; i < n; i++) step();
    }
    function flushOps() {
      while (pendingOps.length) step();
    }

    // The selected SM (the detail panes', stepInsn's SM).
    function select(sm) {
      const s = Number(sm);
      if (!Number.isInteger(s) || s < 0 || s >= SMS) throw new Error('select: bad SM');
      selSm = s;
    }

    // Enqueue bytes into SM `sm`'s TX FIFO as queued reg writes; refuse
    // at the first word that would overflow (tx_full from the last true
    // sample — nothing else writes between cycles, so the cached flag
    // is exact).
    function enqueue(bytes, sm = 0) {
      refused = 0;
      for (const b of bytes) {
        if (last && last.sms[sm].strobes & S_TX_FULL) {
          refused++;
          break;
        }
        pendingOps.push({ addr: REG.TXF0 + 4 * sm, data: b & 0xff });
        txWords[sm].push(b & 0xff);
      }
      return refused;
    }

    // The inspector's TXFx row: a full 32-bit word, the same mirror
    // discipline (the feed bar's enqueue is the byte flavor).
    function enqueueWord(word, sm = 0) {
      refused = 0;
      if (last && last.sms[sm].strobes & S_TX_FULL) {
        refused = 1;
        return 0;
      }
      pendingOps.push({ addr: REG.TXF0 + 4 * sm, data: word >>> 0 });
      txWords[sm].push(word >>> 0);
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

    // A config-field edit of SM `sm`: update the overlay mirror and
    // queue the composed reg write (one rendered clk, SPEC-7-x). A
    // fifo-mode-changing SHIFTCTRL edit flushes the FIFOs (SPEC-6-2):
    // the write carries the mirror reset and the settle clk follows so
    // a feeding write cannot land on the flush edge.
    function validateOverlayValue(group, field, value) {
      const spec = OVERLAY_GROUPS[group].fields[field];
      if (!spec) throw new Error(`overlay: no field ${group}.${field}`);
      const max = spec[2];
      if (max === 'b') {
        if (typeof value !== 'boolean') throw new Error(`${group}.${field}: not a boolean`);
        return;
      }
      const v = Number(value);
      const hiV = max === 'thr' ? 32 : max;
      const loV = max === 'thr' ? 1 : 0;
      if (!Number.isInteger(v) || v < loV || v > hiV)
        throw new Error(`${group}.${field}: out of range (${loV}..${hiV})`);
    }

    function setOverlayField(sm, group, field, value) {
      validateOverlayValue(group, field, value);
      const modeBefore = fifoModeOf(ovs[sm].shiftctrl);
      ovs[sm][group][field] = value;
      pendingOps.push({ addr: overlayAddr(sm, group, ADR), data: compose(sm, group) });
      if (group === 'shiftctrl' && modeBefore !== fifoModeOf(ovs[sm].shiftctrl)) {
        pendingOps[pendingOps.length - 1].fjoinFlush = true;
        pendingOps.push(null);
      }
    }

    // A multi-field config edit of SM `sm` (the C22 drawn controls):
    // validate every edit first, then apply all and queue ONE composed
    // write per touched group — an atomic join edit must not pay two
    // SHIFTCTRL writes or two SPEC-6-2 settle clks.
    function setOverlayFields(sm, edits) {
      if (!Array.isArray(edits) || edits.length === 0) throw new Error('overlay edits: none');
      for (const [group] of edits) {
        if (!OVERLAY_GROUPS[group]) throw new Error(`overlay: no group ${group}`);
      }
      for (const [group, field, value] of edits) validateOverlayValue(group, field, value);
      const modeBefore = fifoModeOf(ovs[sm].shiftctrl);
      for (const [group, field, value] of edits) ovs[sm][group][field] = value;
      let shiftOp = null;
      for (const group of [...new Set(edits.map(([g]) => g))]) {
        const op = { addr: overlayAddr(sm, group, ADR), data: compose(sm, group) };
        if (group === 'shiftctrl') shiftOp = op;
        pendingOps.push(op);
      }
      if (shiftOp && modeBefore !== fifoModeOf(ovs[sm].shiftctrl)) {
        shiftOp.fjoinFlush = true;
        pendingOps.push(null);
      }
    }

    // The drawn-control entry point (the worker's {cmd:'control'}): the
    // shared controlEdit table decides the edits, setOverlayFields lands
    // them on SM `sm`. The defect hook re-injects the FJOIN TX/RX swap
    // here.
    function applyControl(sm, id, gesture) {
      setOverlayFields(sm, controlEdit(ovs[sm], id, gesture, { cfgctrl: DEFECT_CFGCTRL }));
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

    // Queue RXFx reads of SM `sm` (the RX drain): one rendered clk
    // each, the words learned only by draining (the R-line
    // discipline). Never queues past the mirrored level — read-on-empty
    // is the model's RXUNDER.
    function drainRx(n, sm = 0) {
      const avail = Math.max(0, rxPushes[sm] - rxDrains[sm]);
      const k = Math.max(0, Math.min(Math.floor(n) || 0, avail));
      for (let i = 0; i < k; i++) pendingOps.push({ rd: REG.RXF0 + 4 * sm });
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
    // SMx_INSTR force — config regs go through setOverlayField so the
    // overlay mirror stays the truth, TXFx through enqueue so the TX
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

    // pc of SM i's most recent S_EXEC clk — latched eagerly in record()
    // so unobserved batches still display the delaying instruction
    function displayedPcOf(i) {
      if (!last) return 0;
      return last.sms[i].state === ST.DELAY ? lastExecPc[i] : last.sms[i].pc;
    }
    function phaseOf(s) {
      if (!s) return 'OFF';
      if (s.state === ST.STALL) return 'STALL';
      if (s.state === ST.DELAY) return 'DELAY';
      if (s.state === ST.FETCH || s.state === ST.EXEC) return s.strobes & S_TICK ? 'EXEC' : 'OFF';
      return 'OFF';
    }

    // "⏭ INSN": step until the SELECTED SM's displayed instruction
    // changes (or that SM stalls) — the mock-up's do/while over true
    // engine samples.
    function stepInsn() {
      const p0 = displayedPcOf(selSm);
      let n = 0;
      do {
        step();
        n++;
      } while (displayedPcOf(selSm) === p0 && phaseOf(last?.sms[selSm]) !== 'STALL' && n < 200);
    }

    // FIFO depths implied by one SM's join/aux overlay (SPEC-6-2/3/4).
    function fifoDepthsOf(sc) {
      if (sc.fjoinRxPut || sc.fjoinRxGet) return { tx: 4, rx: 0 };
      if (sc.fjoinRx && sc.fjoinTx) return { tx: 0, rx: 0 };
      if (sc.fjoinRx) return { tx: 0, rx: 8 };
      if (sc.fjoinTx) return { tx: 8, rx: 0 };
      return { tx: 4, rx: 4 };
    }

    // One SM's decoded view (the getState sms[] element).
    function smView(i) {
      const s = last ? last.sms[i] : null;
      return {
        pc: s ? s.pc : 0,
        displayPc: displayedPcOf(i),
        phase: phaseOf(s),
        delay: s ? s.delay : 0,
        x: s ? s.x : 0,
        y: s ? s.y : 0,
        osr: s ? s.osr : 0,
        isr: s ? s.isr : 0,
        osrCnt: s ? s.osrCnt : 0,
        isrCnt: s ? s.isrCnt : 0,
        txLevel: s ? s.txLevel : 0,
        txEmpty: s ? !!(s.strobes & S_TX_EMPTY) : true,
        txFull: s ? !!(s.strobes & S_TX_FULL) : false,
        txWords: txWords[i].slice(),
        rxLevel: s ? s.rxLevel : 0,
        rxWords: rxWords[i].slice(),
        rxMirror: {
          pushes: rxPushes[i],
          drains: rxDrains[i],
          ok: rxPushes[i] - rxDrains[i] === (s ? s.rxLevel : 0),
        },
        fifoDepths: fifoDepthsOf(ovs[i].shiftctrl),
        flashes: flashes[i],
        overlay: {
          clkdiv: { ...ovs[i].clkdiv },
          pinctrl: { ...ovs[i].pinctrl },
          execctrl: { ...ovs[i].execctrl },
          shiftctrl: { ...ovs[i].shiftctrl },
        },
      };
    }

    // The stored-program format: words + the per-SM config overlay
    // (feeds, entry, lens, drives are session state — the same JSON
    // seeds level authoring, and levels do not carry a FIFO's worth of
    // stimulus). The per-SM enable rides along so a round trip reloads
    // the same machines.
    function serialize() {
      return {
        v: 2,
        words: memWords.slice(),
        sms: ovs.map((ov, i) => ({
          clkdiv: { ...ov.clkdiv },
          pinctrl: { ...ov.pinctrl },
          execctrl: { ...ov.execctrl },
          shiftctrl: { ...ov.shiftctrl },
          en: serializedEn[i],
        })),
      };
    }

    const WAVE_WIN = 128;
    function getState() {
      const sel = smView(selSm);
      return {
        cycle: last ? last.clk : 0,
        pin: pins.length ? pins[pins.length - 1] : 0,
        sm: selSm,
        sms: [smView(0), smView(1), smView(2), smView(3)],
        owners: pinOwner.slice(),
        // selected-SM aliases (the detail panes' view — the C21 shape)
        pc: sel.pc,
        displayPc: sel.displayPc,
        phase: sel.phase,
        delay: sel.delay,
        x: sel.x,
        y: sel.y,
        osr: sel.osr,
        isr: sel.isr,
        osrCnt: sel.osrCnt,
        isrCnt: sel.isrCnt,
        gpioOut: last ? last.gpioOut : 0,
        gpioOe: last ? last.gpioOe : 0,
        intr: last ? last.intr : 0x00f0,
        txLevel: sel.txLevel,
        txEmpty: sel.txEmpty,
        txFull: sel.txFull,
        txWords: sel.txWords,
        rxLevel: sel.rxLevel,
        rxWords: sel.rxWords,
        rxMirror: sel.rxMirror,
        fifoDepths: sel.fifoDepths,
        monitor: {
          decoded: mon.decoded,
          frameOff: mon.armed ? mon.frameOff : null,
          square:
            lens.mode === 'square'
              ? { period: sq.period, dutyPct: sq.dutyPct, edges: sq.edges }
              : null,
        },
        wave: {
          pins: pins.slice(-WAVE_WIN),
          tags: tags.slice(-WAVE_WIN),
          startCycle: Math.max(0, pins.length - WAVE_WIN),
        },
        flashes: sel.flashes,
        refused,
        lens: { ...lens },
        overlay: sel.overlay,
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
      select,
      stepInsn,
      enqueue,
      enqueueWord,
      setOverlayField,
      setOverlayFields,
      applyControl,
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
    // the C22 drawn-config grammar: gesture → overlay edits (pure)
    CFG_CONTROLS,
    controlEdit,
    // the inspector's field table (bit ranges + max/kind for its inputs)
    OVERLAY_GROUP_FIELDS: (group) => Object.entries(OVERLAY_GROUPS[group].fields),
    // the per-SM window address of one overlay group (SPEC-7 per-SM map)
    overlayAddr,
    EMPTY,
    DEMO_UART_TX,
    REG,
    ST,
    CYC,
    SMS,
  };
  global.VibeDriver = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(this);

// sandbox.test.js — the C21 sandbox unit suite (KANBAN C21; the load
// timeline and mirrors grew per-SM with C24 — the multi-SM surface
// itself has its own suite in multi-sm.test.js).
//
// The C18 level fixture is retired: the driver loads sandbox state
// objects (words + config overlay) and grows the full register surface —
// the overlay→reg-write mapping (bit-exact with stim.py's builders, the
// oracle the make web legs run against), per-pin drive latches + the
// deterministic pattern generator (composed into gpio_in on step clks;
// reg-op clks hold the last level, the shim's sticky-input discipline),
// the RX drain with its contents/count mirror, the selectable monitor
// lens (off/square/uart on a picked pin, replayed over the stored gpio
// history when the pin changes), the stored-program JSON round-trip, and
// the four C21 red-injection hooks (rx / lens / pattern / overlay) whose
// red/green demonstration runs in-process here (the C20 mutation idiom)
// and end-to-end in make web for the two C18 hooks.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFake } = require('./fake-engine.js');
const VibeDriver = require('../engine-driver.js');

const { REG } = VibeDriver;
const S = createFake().S; // strobe bits (the fake mirrors the shim's)

function freshDriver(defects) {
  const M = createFake();
  const drv = VibeDriver.create(M, defects);
  return { M, drv };
}

// One 8N1 frame as scripted per-clk gpio_out effects on a chosen bit,
// with an idle-high prefix (the fake's reset gpio_out=1 is idle-high on
// bit0 only — the lens on another pin needs the line seen high before
// the start bit's falling edge can arm it).
function frameEffectsOn(pin, byte, idleCells = 4) {
  const cells = [];
  for (let i = 0; i < idleCells; i++) cells.push(1);
  cells.push(0);
  for (let i = 0; i < 8; i++) cells.push((byte >> i) & 1);
  cells.push(1);
  const seq = [];
  for (const c of cells) for (let k = 0; k < 8; k++) seq.push({ gpio_out: c << pin });
  return seq;
}

// A square wave of N clks/cycle on a chosen bit (8 low, 8 high, ...).
function squareEffectsOn(pin, cycles) {
  const seq = [];
  for (let i = 0; i < cycles * 16; i++)
    seq.push({ gpio_out: ((Math.floor(i / 8) % 2) << pin) >>> 0 });
  return seq;
}

// ---- the overlay composes datasheet-bit-exact words (stim.py mirror) --
test('overlay compose is bit-exact with the stim.py builders', () => {
  // pctrl(ss_cnt=5, set_cnt=3, out_cnt=2, in_base=17, ss_base=9,
  //       set_base=6, out_base=1) == 0xac28a4c1 (the stim doctest)
  assert.equal(
    VibeDriver.composeOverlay('pinctrl', {
      ssCnt: 5,
      setCnt: 3,
      outCnt: 2,
      inBase: 17,
      ssBase: 9,
      setBase: 6,
      outBase: 1,
    }),
    0xac28a4c1,
  );
  // execctrl(31, 7) == 0x1f380 (everything else 0/false)
  assert.equal(
    VibeDriver.composeOverlay('execctrl', {
      wrapTop: 31,
      wrapBot: 7,
    }),
    0x1f380,
  );
  // clkdiv(135, 162) == 0x87a200 (the stim doctest)
  assert.equal(VibeDriver.composeOverlay('clkdiv', { intg: 135, frac: 162 }), 0x87a200);
  // fjoin_tx | fjoin_rx_put | pull_thr 8 (bit 30 | bit 15 | 8<<25)
  assert.equal(
    VibeDriver.composeOverlay('shiftctrl', { fjoinTx: true, fjoinRxPut: true, pullThr: 8 }),
    0x50008000,
  );
  // thresholds are 1..32 with 32 encoding as 0 (SPEC-5-7)
  assert.equal(VibeDriver.composeOverlay('shiftctrl', { pullThr: 32 }), 0);
  // IN_COUNT stays raw (SPEC-7-21: 0 = 32 / no masking)
  assert.equal(VibeDriver.composeOverlay('shiftctrl', { inCount: 7 }), 7);
});

test('EMPTY composes to the reset words; DEMO_UART_TX to the C18 words', () => {
  const e = VibeDriver.EMPTY.sms[0];
  // reset values (model.py CLKDIV/EXECCTRL/SHIFTCTRL/PINCTRL_RESET)
  assert.equal(VibeDriver.composeOverlay('clkdiv', e.clkdiv), 0x00010000);
  assert.equal(VibeDriver.composeOverlay('execctrl', e.execctrl), 0x00001fff);
  assert.equal(VibeDriver.composeOverlay('shiftctrl', e.shiftctrl), 0x000c0000);
  assert.equal(VibeDriver.composeOverlay('pinctrl', e.pinctrl), 0x14000000);
  // the demoted level-02 fixture stays bit-for-bit the C18 overlay
  const d = VibeDriver.DEMO_UART_TX.sms[0];
  assert.equal(VibeDriver.composeOverlay('pinctrl', d.pinctrl), 0x40100000);
  assert.equal(VibeDriver.composeOverlay('execctrl', d.execctrl), 0x40003000);
  // fjoinTx over the right/right reset defaults = stim.shiftctrl(fjoin_tx)
  // exactly (the C18 driver literal 0x40080000 omitted IN_SHIFTDIR — no
  // IN in uart_tx, so the old pin series is unchanged)
  assert.equal(VibeDriver.composeOverlay('shiftctrl', d.shiftctrl), 0x400c0000);
  assert.deepEqual(VibeDriver.DEMO_UART_TX.words.slice(0, 4), [0x9fa0, 0xf727, 0x6001, 0x0642]);
  assert.ok(VibeDriver.DEMO_UART_TX.words.slice(4).every((w) => w === 0));
  assert.deepEqual(VibeDriver.DEMO_UART_TX.sms[0].feeds, [0x50, 0x49, 0x4f, 0x21]); // 'PIO!'
  assert.deepEqual(VibeDriver.DEMO_UART_TX.lens, { mode: 'uart', pin: 0 });
});

// ---- load(state): the sandbox timelines -------------------------------
test('load(EMPTY): per-SM config writes + settle clk + enable 0xF', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  // only nonzero imem words are written (all-zero memory is the reset
  // state — the jmp-0 park, now on four cursors); CLKDIV is skipped
  // while it equals the reset word (the _sched_basic rule the web
  // mirror follows); every SM's PINCTRL/EXECCTRL/SHIFTCTRL land (the
  // C24 per-SM overlay), then the one SPEC-6-2 settle clk, then CTRL
  // enables all four machines
  const exp = [];
  for (let i = 0; i < 4; i++) {
    const base = REG.SM0 + 0x18 * i;
    exp.push(
      { addr: base + 20, data: 0x14000000 }, // PINCTRL (SET_COUNT=5, SPEC-7-26)
      { addr: base + 4, data: 0x00001fff }, // EXECCTRL (reset overlay)
      { addr: base + 8, data: 0x000c0000 }, // SHIFTCTRL (reset overlay)
    );
  }
  exp.push({ addr: REG.CTRL, data: 0xf }); // all four SMs (SPEC-7-2)
  assert.deepEqual(M.writes, exp);
  assert.equal(M.stepsCount(), 1); // the SPEC-6-2 settle clk
  assert.equal(drv.allPins().length, 14); // every load clk is rendered
});

test('load(DEMO_UART_TX) drives the exact C18 reg-bus timeline', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.DEMO_UART_TX);
  const exp = [
    { addr: 0x048, data: 0x9fa0 },
    { addr: 0x04c, data: 0xf727 },
    { addr: 0x050, data: 0x6001 },
    { addr: 0x054, data: 0x0642 },
    { addr: REG.SM0 + 20, data: 0x40100000 }, // PINCTRL
    { addr: REG.SM0 + 4, data: 0x40003000 }, // EXECCTRL
    { addr: REG.SM0 + 8, data: 0x400c0000 }, // SHIFTCTRL (join TX, SPEC-6-2)
  ];
  for (let i = 1; i < 4; i++) {
    const base = REG.SM0 + 0x18 * i;
    exp.push(
      { addr: base + 20, data: 0x14000000 },
      { addr: base + 4, data: 0x00001fff },
      { addr: base + 8, data: 0x000c0000 },
    );
  }
  exp.push(
    { addr: REG.TXF0, data: 0x50 },
    { addr: REG.TXF0, data: 0x49 },
    { addr: REG.TXF0, data: 0x4f },
    { addr: REG.TXF0, data: 0x21 },
    { addr: REG.CTRL, data: 1 }, // the demo's SM0-authored scope
  );
  assert.deepEqual(M.writes, exp);
  assert.equal(M.stepsCount(), 1);
  assert.equal(drv.allPins().length, 22);
  assert.deepEqual(drv.getState().txWords, [0x50, 0x49, 0x4f, 0x21]);
  // the demo presets its lens (uart on the tx pin)
  assert.deepEqual(drv.getState().lens, { mode: 'uart', pin: 0 });
});

test('load writes CLKDIV and the entry-point force when the state sets them', () => {
  const { M, drv } = freshDriver();
  const st = VibeDriver.newState();
  st.sms[0].clkdiv = { intg: 2, frac: 128 };
  st.sms[0].entry = 2;
  st.words[0] = 0xa042; // one nop: the only imem write
  drv.load(st);
  const exp = [{ addr: REG.IMEM0, data: 0xa042 }];
  for (let i = 0; i < 4; i++) {
    const base = REG.SM0 + 0x18 * i;
    exp.push(
      { addr: base + 20, data: 0x14000000 },
      { addr: base + 4, data: 0x00001fff },
      { addr: base + 8, data: 0x000c0000 },
    );
  }
  exp.push(
    { addr: REG.SM0 + 0, data: 0x00028000 }, // CLKDIV INT=2 FRAC=128 (SPEC-7-14)
    { addr: REG.SM0 + 16, data: 0x0002 }, // SM0_INSTR: jmp 2 (set_pc idiom)
    { addr: REG.CTRL, data: 0xf },
  );
  assert.deepEqual(M.writes, exp);
});

// ---- overlay edits: queued reg writes, the feed discipline -----------
test('setOverlayField queues the composed write (feed discipline)', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  const n0 = M.writes.length;
  drv.setOverlayField(0, 'shiftctrl', 'autopull', true);
  drv.setOverlayField(0, 'shiftctrl', 'pullThr', 8);
  drv.setOverlayField(0, 'clkdiv', 'intg', 3);
  drv.setOverlayField(0, 'pinctrl', 'ssCnt', 2);
  drv.setOverlayField(0, 'execctrl', 'wrapTop', 5);
  drv.run(5);
  assert.deepEqual(M.writes.slice(n0), [
    { addr: REG.SM0 + 8, data: 0x000e0000 }, // autopull over the right/right base
    { addr: REG.SM0 + 8, data: 0x100e0000 }, // + pull_thr 8<<25 (SPEC-5-7)
    { addr: REG.SM0 + 0, data: 0x00030000 }, // CLKDIV INT=3
    { addr: REG.SM0 + 20, data: 0x54000000 }, // PINCTRL ssCnt 2 | setCnt 5
    { addr: REG.SM0 + 4, data: 0x00005fff }, // EXECCTRL wrapTop 5
  ]);
  // the driver's overlay mirror carries the edits (the inspector's truth)
  assert.equal(drv.getState().overlay.shiftctrl.autopull, true);
  assert.equal(drv.getState().overlay.shiftctrl.pullThr, 8);
  assert.equal(drv.getState().overlay.clkdiv.intg, 3);
});

test('a FJOIN-changing overlay edit queues the SPEC-6-2 settle clk', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.DEMO_UART_TX);
  const n0 = M.writes.length;
  const steps0 = M.stepsCount();
  drv.setOverlayField(0, 'shiftctrl', 'fjoinTx', false); // join change → flush
  drv.run(2); // the write clk + the settle clk
  assert.deepEqual(M.writes.slice(n0), [
    { addr: REG.SM0 + 8, data: 0x000c0000 }, // join off, both SHIFTDIR right
  ]);
  assert.equal(M.stepsCount(), steps0 + 1); // the settle clk is a step
  // a non-join edit adds no settle clk
  drv.setOverlayField(0, 'shiftctrl', 'autopull', true);
  drv.run(1);
  assert.equal(M.stepsCount(), steps0 + 1);
});

test('a fifo-mode-changing edit flushes the FIFO mirrors (SPEC-6-2)', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.DEMO_UART_TX); // 4 feeds sit in the joined TX FIFO
  M.script([{ strobes0: S.S_RX_PUSH }, { strobes0: S.S_RX_PUSH }]);
  drv.run(2);
  drv.setOverlayField(0, 'shiftctrl', 'fjoinTx', false); // mode change → flush
  drv.run(2); // the write + settle retire
  const st = drv.getState();
  assert.deepEqual(st.txWords, []); // the TX mirror emptied with the FIFO
  assert.equal(st.rxMirror.ok, true); // rx counts reset to the flush
  assert.equal(st.rxMirror.pushes, 0);
  // an aux-mode edit is a mode change too (FM_TXRX -> FM_TXPUT)
  const { M: M2, drv: drv2 } = freshDriver();
  drv2.load(VibeDriver.EMPTY);
  drv2.setOverlayField(0, 'shiftctrl', 'fjoinRxPut', true);
  const n0 = M2.writes.length;
  const steps0 = M2.stepsCount();
  drv2.run(2);
  assert.equal(M2.writes.length, n0 + 1); // the SHIFTCTRL write
  assert.equal(M2.stepsCount(), steps0 + 1); // + the settle clk
});

// ---- enqueueWord: the inspector's TXF0 row (the mirror discipline) ----
test('enqueueWord queues one 32-bit feed and keeps the mirror exact', () => {
  const { drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  assert.equal(drv.enqueueWord(0xdeadbeef), 1);
  drv.run(1);
  const st = drv.getState();
  assert.deepEqual(st.txWords, [0xdeadbeef]);
  assert.equal(st.txLevel, 1);
  assert.equal(st.txWords.length, st.txLevel);
});

// ---- pin drives + the pattern generator -------------------------------
test('drive latches compose gpio_in on step clks; op clks hold it sticky', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  drv.setDrive(3, 1);
  drv.run(2);
  drv.setDrive(3, 0);
  drv.setDrive(5, 1);
  drv.setOverlayField(0, 'clkdiv', 'intg', 2); // queues a write clk between steps
  drv.run(3); // write clk (no _pio_step: gpio_in holds), then two steps
  assert.deepEqual(M.gpioLog.slice(-4), [8, 8, 0x20, 0x20]);
  assert.ok(M.gpioLog.length >= 4);
  // releasing the latch drops the pin from the composition
  drv.setDrive(5, null);
  drv.run(1);
  assert.equal(M.gpioLog[M.gpioLog.length - 1], 0);
});

test('pattern square: deterministic half-period levels from its start clk', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  const start = M.gpioLog.length;
  drv.setPattern({ mode: 'square', pin: 2, period: 16 });
  drv.run(40);
  const tail = M.gpioLog.slice(start);
  assert.equal(tail.length, 40);
  for (let i = 0; i < 40; i++) {
    assert.equal(tail[i], ((Math.floor(i / 8) % 2) << 2) >>> 0, `clk ${i}`);
  }
});

test('pattern bits: a pasted bitstream plays once and holds its final bit', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  const start = M.gpioLog.length;
  drv.setPattern({ mode: 'bits', pin: 1, bits: [1, 0, 1, 1] });
  drv.run(7);
  assert.deepEqual(M.gpioLog.slice(start), [2, 0, 2, 2, 2, 2, 2]);
});

test('the pattern generator owns its pin over the drive latch', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  drv.setDrive(4, 1);
  const start = M.gpioLog.length;
  drv.setPattern({ mode: 'square', pin: 4, period: 4 });
  drv.run(8);
  const tail = M.gpioLog.slice(start);
  for (let i = 0; i < 8; i++) {
    assert.equal(tail[i], ((Math.floor(i / 2) % 2) << 4) >>> 0, `clk ${i}`);
  }
});

test('pattern determinism: the same script replays the same gpio series', () => {
  const runOnce = () => {
    const { M, drv } = freshDriver();
    drv.load(VibeDriver.EMPTY);
    drv.setDrive(6, 1);
    drv.setPattern({ mode: 'square', pin: 2, period: 16 });
    drv.run(24);
    return M.gpioLog.slice();
  };
  assert.deepEqual(runOnce(), runOnce());
});

// ---- RX drain: queued reads + the contents/count mirror ---------------
test('drainRx queues one rendered clk per read and mirrors the rdata', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  M.rxFeed([0x111, 0x222]);
  M.script([{ strobes0: S.S_RX_PUSH }, { strobes0: S.S_RX_PUSH }]);
  drv.run(2); // the two pushes land
  const pins0 = drv.allPins().length;
  const queued = drv.drainRx(2);
  assert.equal(queued, 2);
  drv.run(2); // the two read clks (the R-line discipline)
  assert.equal(drv.allPins().length, pins0 + 2);
  const st = drv.getState();
  assert.deepEqual(st.rxWords, [0x111, 0x222]);
  assert.equal(st.rxLevel, 0); // engine empty again
  assert.equal(st.rxMirror.pushes, 2);
  assert.equal(st.rxMirror.drains, 2);
  assert.ok(st.rxMirror.ok); // pushes − drains == engine rx_level
});

test('drainRx refuses to queue past the mirrored level (no RXUNDER)', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  M.script([{ strobes0: S.S_RX_PUSH }]);
  drv.run(1);
  assert.equal(drv.drainRx(3), 1); // only the pushed word is queued
});

// ---- the lens: off by default, uart/square on a picked pin ------------
test('the lens is off by default and decodes nothing', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  M.script(frameEffectsOn(0, 0x41));
  drv.run(80);
  const st = drv.getState();
  assert.equal(st.lens.mode, 'off');
  assert.equal(st.monitor.decoded, '');
  assert.ok(st.wave.tags.every((t) => t === ''));
});

test('the uart lens decodes the picked pin', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  drv.setLens({ mode: 'uart', pin: 4 });
  const fx = frameEffectsOn(4, 0x41); // 4 idle cells + the frame: 112 clks
  M.script(fx);
  drv.run(fx.length);
  assert.equal(drv.getState().monitor.decoded, 'A');
});

test('the square lens reports period and duty of the observed wave', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  drv.setLens({ mode: 'square', pin: 2 });
  M.script(squareEffectsOn(2, 5));
  drv.run(80);
  const sq = drv.getState().monitor.square;
  assert.equal(sq.period, 16);
  assert.equal(sq.dutyPct, 50);
  // the series is 14 idle-low load clks (bit2 of the reset word is 0)
  // then the square: rising edges at clks 22/38/54/70/86 — five complete
  // periods inside the 94 rendered clks
  assert.equal(sq.edges, 5);
});

test('changing the lens pin replays the decode over the stored history', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  drv.setLens({ mode: 'uart', pin: 0 });
  // two frames at once: bit0 carries 'A', bit4 carries 'B'
  const both = frameEffectsOn(0, 0x41).map((e, i) => ({
    gpio_out: e.gpio_out | frameEffectsOn(4, 0x42)[i].gpio_out,
  }));
  M.script(both);
  drv.run(both.length);
  assert.equal(drv.getState().monitor.decoded, 'A');
  drv.setLens({ mode: 'uart', pin: 4 });
  const st = drv.getState();
  assert.equal(st.monitor.decoded, 'B'); // replayed, not re-run
  assert.equal(st.wave.pins.length, 14 + both.length);
  // the replayed pin4 series: frame armed at clk 46 (14 load clks + the 4
  // idle cells = 32 clks), start cell low at clk 47, D1 of 'B' at 63
  assert.equal(st.wave.startCycle, 0);
  assert.equal(st.wave.pins[47], 0);
  assert.equal(st.wave.pins[63], 1);
});

// ---- IRQ flags + INTR readback ----------------------------------------
test('getState exposes the composed INTR and the rx level', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  M.script([{ intr: 0x0150, strobes0: S.S_RX_PUSH }]);
  drv.run(1);
  const st = drv.getState();
  assert.equal(st.intr, 0x0150); // the SPEC-7-12 composition, per-clk
  assert.equal(st.rxLevel, 1); // the push landed in the fake's FIFO
});

// ---- the stored-program format ----------------------------------------
test('serialize/parse round-trips words + the per-SM config overlay', () => {
  const { drv } = freshDriver();
  drv.load(VibeDriver.DEMO_UART_TX);
  drv.setOverlayField(0, 'clkdiv', 'frac', 96);
  const words = new Array(32).fill(0);
  words[0] = 0x9fa0;
  words[1] = 0xf727;
  words[2] = 0x6001;
  words[3] = 0x0642;
  words[7] = 0xa042; // an edit beyond the demo
  drv.setProgram(words);
  const json = JSON.parse(JSON.stringify(drv.serialize()));
  const st = VibeDriver.parseState(json);
  assert.deepEqual(st.words, words);
  assert.equal(st.sms[0].clkdiv.frac, 96);
  assert.equal(st.sms[0].clkdiv.intg, 1);
  assert.deepEqual(st.sms[0].pinctrl, VibeDriver.DEMO_UART_TX.sms[0].pinctrl);
  assert.deepEqual(st.sms[0].execctrl, VibeDriver.DEMO_UART_TX.sms[0].execctrl);
  assert.deepEqual(st.sms[0].shiftctrl, VibeDriver.DEMO_UART_TX.sms[0].shiftctrl);
  // the demo's SM0-only enable rides the round trip
  assert.deepEqual(
    st.sms.map((s) => s.en),
    [true, false, false, false],
  );
  // feeds/lens/drives are session state, not the stored program
  assert.equal(json.feeds, undefined);
  assert.equal(json.lens, undefined);
  assert.deepEqual(st.sms[0].feeds, []);
});

test('parseState rejects malformed stored programs', () => {
  assert.throws(() => VibeDriver.parseState({ v: 2, words: 'nope' }));
  assert.throws(() =>
    VibeDriver.parseState({ v: 2, words: new Array(32).fill(0), sms: [{ pinctrl: { ssCnt: 8 } }] }),
  );
  assert.throws(() =>
    VibeDriver.parseState({ v: 2, words: new Array(32).fill(0), sms: [{}, {}, {}, 5] }),
  );
});

// a v1 stored program (the C21 flat SM0 scope) still parses — SM1..3
// load disabled, the authored scope
test('parseState accepts the v1 flat format as the SM0-authored scope', () => {
  const v1 = {
    v: 1,
    words: [0xa042].concat(new Array(31).fill(0)),
    clkdiv: { intg: 2, frac: 0 },
    shiftctrl: { autopull: true },
    feeds: [0x55],
    entry: 3,
  };
  const st = VibeDriver.parseState(v1);
  assert.equal(st.sms[0].clkdiv.intg, 2);
  assert.equal(st.sms[0].shiftctrl.autopull, true);
  assert.deepEqual(st.sms[0].feeds, [0x55]);
  assert.equal(st.sms[0].entry, 3);
  assert.deepEqual(
    st.sms.map((s) => s.en),
    [true, false, false, false],
  );
});

// ---- the C21 defect hooks: red/green in process ------------------------
test('defect=rx: the mirror-vs-engine invariant is green clean, red defective', () => {
  const run = (defects) => {
    const { M, drv } = freshDriver(defects);
    drv.load(VibeDriver.EMPTY);
    M.rxFeed([0x55]);
    M.script([{ strobes0: S.S_RX_PUSH }]);
    drv.run(1);
    return drv.getState().rxMirror;
  };
  assert.equal(run().ok, true); // green leg
  assert.equal(run({ rx: true }).ok, false); // red leg: pushes never counted
});

test('defect=lens: the uart decode is green clean, red defective', () => {
  const run = (defects) => {
    const { M, drv } = freshDriver(defects);
    drv.load(VibeDriver.EMPTY);
    drv.setLens({ mode: 'uart', pin: 0 });
    const fx = frameEffectsOn(0, 0x41);
    M.script(fx);
    drv.run(fx.length);
    return drv.getState().monitor.decoded;
  };
  assert.equal(run(), 'A'); // green leg
  assert.notEqual(run({ lens: true }), 'A'); // red leg: next-cell sampling
});

test('defect=lens: the square verdict is green clean, red defective', () => {
  const run = (defects) => {
    const { M, drv } = freshDriver(defects);
    drv.load(VibeDriver.EMPTY);
    drv.setLens({ mode: 'square', pin: 2 });
    M.script(squareEffectsOn(2, 4));
    drv.run(64);
    return drv.getState().monitor.square.period;
  };
  assert.equal(run(), 16); // green leg
  assert.equal(run({ lens: true }), 17); // red leg: miscounted period
});

test('defect=pattern: the gpio series is green clean, red defective', () => {
  const run = (defects) => {
    const { M, drv } = freshDriver(defects);
    drv.load(VibeDriver.EMPTY);
    const start = M.gpioLog.length;
    drv.setPattern({ mode: 'square', pin: 2, period: 16 });
    drv.run(24);
    return M.gpioLog.slice(start);
  };
  const clean = run();
  for (let i = 0; i < 24; i++) {
    assert.equal(clean[i], ((Math.floor(i / 8) % 2) << 2) >>> 0, `clk ${i}`); // green
  }
  const defective = run({ pattern: true });
  const i = clean.findIndex((g, k) => g !== defective[k]);
  assert.ok(i >= 0, 'defect=pattern never diverged'); // red leg
  assert.equal(i, 7); // one-clk phase error bites at the half boundary
});

test('defect=overlay: the shiftctrl mapping is green clean, red defective', () => {
  const run = (defects) => {
    const { M, drv } = freshDriver(defects);
    drv.load(VibeDriver.EMPTY);
    const n0 = M.writes.length;
    drv.setOverlayField(0, 'shiftctrl', 'pullThr', 8);
    drv.run(1);
    return M.writes[n0].data;
  };
  // green leg: PULL_THRESH at 29:25 over the right/right reset base
  assert.equal(run(), 0x000c0000 | (8 << 25));
  // red: the same value transcribed at 24:20 (SPEC-5-7 vs the defect)
  assert.equal(run({ overlay: true }), 0x000c0000 | (8 << 20));
});

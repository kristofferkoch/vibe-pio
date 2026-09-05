// engine-driver.test.js — the C20 hermetic unit suite for the C18 client
// core (KANBAN C20; grown per-SM by C24).
//
// web/engine-driver.js is the exact module the browser worker runs and
// the CI gate (make web --client) checks against the pio_model oracle.
// This suite needs neither the wasm build nor the model: a scripted fake
// engine (fake-engine.js) stands in for the C17 ABI, and the driver's
// own logic is what gets checked — the load timeline (the reg-bus
// sequence webbuild.py's client-gate legs mirror clk for clk; the C21
// sandbox surface has its own suite in sandbox.test.js, the C24
// multi-SM surface in multi-sm.test.js), the PioCycle decode, the
// receiver monitor, the TX contents mirror, the phase/displayedPc
// derivation, and the two red-injection hooks (--defect=pin /
// --defect=mirror) whose red/green demonstration the make web gate
// runs as subprocesses; here the same demonstration runs in-process
// (the TestMutationsDiverge idiom from tests/test_model.py).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFake } = require('./fake-engine.js');
const VibeDriver = require('../engine-driver.js');

const { REG, ST, DEMO_UART_TX } = VibeDriver;
const S = createFake().S; // strobe bits (the fake mirrors the shim's)

function freshDriver(defects) {
  const M = createFake();
  const drv = VibeDriver.create(M, defects);
  return { M, drv };
}

// One 8N1 frame as scripted per-clk gpio_out effects: a start cell of
// 0s, eight data cells (LSB first), a stop cell of 1s — 80 clks. gpioFor
// maps the logical line level to the gpio_out word, so defect tests can
// put bit0 and bit1 in disagreement.
function frameEffects(byte, gpioFor) {
  const g = gpioFor || ((pin) => (pin ? 1 : 0));
  const cells = [0];
  for (let i = 0; i < 8; i++) cells.push((byte >> i) & 1);
  cells.push(1);
  const seq = [];
  for (const c of cells) for (let k = 0; k < 8; k++) seq.push({ gpio_out: g(c) });
  return seq;
}

// The C24 multi-SM load tail: SM1..3's reset-overlay config writes
// (stride 0x18, SPEC-7 per-SM map — PINCTRL/EXECCTRL/SHIFTCTRL each).
const SM_RESET_TAIL = [];
for (let i = 1; i < 4; i++) {
  const base = REG.SM0 + 0x18 * i;
  SM_RESET_TAIL.push(
    { addr: base + 20, data: 0x14000000 },
    { addr: base + 4, data: 0x00001fff },
    { addr: base + 8, data: 0x000c0000 },
  );
}

// ---- the level fixture is pinned (webbuild._client_level_sched's mirror)
test('DEMO_UART_TX pins the canonical C12 uart_tx listing', () => {
  // the retired LEVEL fixture, as a sandbox state (sandbox.test.js pins
  // its overlay words bit-exact against the C18 timeline)
  assert.deepEqual(DEMO_UART_TX.words.slice(0, 4), [0x9fa0, 0xf727, 0x6001, 0x0642]);
  assert.deepEqual(DEMO_UART_TX.sms[0].feeds, [0x50, 0x49, 0x4f, 0x21]); // 'PIO!'
});

// ---- load(): the reg-bus timeline, one rendered clk per op ----------
test('load drives the exact level-02 reg-bus timeline', () => {
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  // pinctrlFor(1,true): SIDESET_COUNT 2<<29 | OUT_CNT 1<<20 | OUT_BASE 0
  // execctrlFor(1,true): SIDE_EN 1<<30 | wrap top 3<<12 | wrap bot 0<<7
  // (SPEC-7-2/10/14..26; SHIFTCTRL bit-for-bit stim.shiftctrl(fjoin_tx));
  // SM1..3 carry their reset overlays (C24) and stay disabled (the demo
  // is the SM0-authored scope)
  assert.deepEqual(M.writes, [
    { addr: 0x048, data: 0x9fa0 },
    { addr: 0x04c, data: 0xf727 },
    { addr: 0x050, data: 0x6001 },
    { addr: 0x054, data: 0x0642 },
    { addr: 0x0dc, data: 0x40100000 }, // SM0+20 PINCTRL
    { addr: 0x0cc, data: 0x40003000 }, // SM0+4 EXECCTRL
    { addr: 0x0d0, data: 0x400c0000 }, // SM0+8 SHIFTCTRL (join TX, SPEC-6-2)
    ...SM_RESET_TAIL,
    { addr: 0x010, data: 0x50 },
    { addr: 0x010, data: 0x49 },
    { addr: 0x010, data: 0x4f },
    { addr: 0x010, data: 0x21 },
    { addr: 0x000, data: 1 }, // CTRL: SM0 enable (SPEC-7-2)
  ]);
  // 21 write clks + the SPEC-6-2 idle clk, all rendered: pins is the
  // full timeline the gate compares against the model.
  assert.equal(drv.allPins().length, 22);
  assert.equal(M.stepsCount(), 1);
  assert.equal(drv.getState().cycle, 22);
  assert.deepEqual(drv.getState().txWords, [0x50, 0x49, 0x4f, 0x21]);
  assert.equal(drv.getState().txLevel, 4);
});

// ---- readCycle: the struct decode, including the 64-bit clk ----------
test('readCycle decodes every PioCycle field, clk across 2^32', () => {
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  // one scripted cycle with every field non-default; clk is assigned
  // pre-increment so the sampled value lands at 0x1_0000_0004. The SM
  // fields are per-SM since C24 — the selected SM (0) carries the
  // values and SM2 carries a differing cursor.
  M.script([
    {
      clk: 0x100000003,
      gpio_out: 2,
      pc0: 3,
      state0: ST.DELAY,
      delay0: 5,
      x0: 0x12345678,
      y0: 0x9abcdef0,
      osr0: 0xdeadbeef,
      isr0: 0xcafebabe,
      osr_cnt0: 31,
      isr_cnt0: 7,
      pc2: 11,
      state2: ST.EXEC,
    },
  ]);
  drv.step();
  const st = drv.getState();
  assert.equal(st.cycle, 0x100000004); // 64-bit clk: low + high*2^32
  assert.equal(st.pin, 0); // gpio_out bit 0 (0b10 -> 0)
  assert.equal(st.pc, 3);
  assert.equal(st.phase, 'DELAY'); // state onehot -> phase name
  assert.equal(st.delay, 5);
  assert.equal(st.x, 0x12345678);
  assert.equal(st.y, 0x9abcdef0);
  assert.equal(st.osr, 0xdeadbeef);
  assert.equal(st.isr, 0xcafebabe);
  assert.equal(st.osrCnt, 31);
  assert.equal(st.isrCnt, 7);
  // the per-SM view: SM2's cursor decodes from its own struct slots
  assert.equal(st.sms[2].pc, 11);
  assert.equal(st.sms[2].phase, 'OFF'); // no S_TICK scripted
});

// ---- displayedPc: the executing instruction stays displayed in DELAY -
test('displayedPc latches the exec pc through DELAY, drops at STALL', () => {
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  M.script([
    { pc0: 2, state0: ST.EXEC, strobes0: S.S_EXEC | S.S_TICK },
    { pc0: 3, state0: ST.DELAY, delay0: 3 },
    { pc0: 3, state0: ST.STALL },
  ]);
  drv.run(2);
  let st = drv.getState();
  assert.equal(st.phase, 'DELAY');
  assert.equal(st.displayPc, 2); // the delayed instruction, not pc 3
  assert.equal(st.pc, 3);
  drv.step();
  st = drv.getState();
  assert.equal(st.phase, 'STALL');
  assert.equal(st.displayPc, 3);
});

// ---- monitor: receiver decode over scripted true pin samples ---------
test('monitor decodes a scripted 8N1 frame and tags the wave', () => {
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  drv.setLens({ mode: 'uart', pin: 0 }); // the demo lens, explicit
  M.script(frameEffects(0x41)); // 'A'
  drv.run(80);
  const st = drv.getState();
  assert.equal(st.monitor.decoded, 'A');
  const t = st.wave.tags;
  const k0 = 22; // frame arms right after the 22 load clks
  assert.equal(t[k0 - 1], 'IDLE');
  assert.equal(t[k0], 'IDLE'); // the arming clk itself still reads IDLE
  assert.equal(t[k0 + 1], 'START'); // off 1..7 of the start cell
  assert.equal(t[k0 + 8], 'D0');
  assert.equal(t[k0 + 68], 'D7');
  assert.equal(t[k0 + 76], 'STOP'); // decided at the stop-bit center
  assert.equal(t[k0 + 79], 'STOP'); // stopTail keeps the tag warm
  // disarm: past the stop tail the line is idle again
  drv.run(2);
  assert.equal(drv.getState().wave.tags[k0 + 80], 'IDLE');
  assert.equal(drv.getState().monitor.frameOff, null);
  // the wave window is the trailing 128 samples
  drv.run(40);
  const w = drv.getState().wave;
  assert.equal(w.pins.length, 128);
  assert.equal(w.startCycle, drv.allPins().length - 128);
});

// ---- C36: the wave window is level geometry (a slow wave judges slowly) --
test('setWaveWin widens the window the state carries (L5 judges 64-clk periods)', () => {
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  drv.setLens({ mode: 'uart', pin: 0 });
  M.script(frameEffects(0x41)); // 80 clks of true pin samples
  drv.run(200);
  // the sandbox default stays 128 (C34/C35 shipped that geometry)
  assert.equal(drv.getState().wave.pins.length, 128);
  // a level page widens the window BEFORE the wave fills: the judge's
  // stability window must see whole periods of the slow wave
  drv.setWaveWin(512);
  M.script(frameEffects(0x41).concat(frameEffects(0x41)));
  drv.run(420); // 642 samples of history now — the window is full
  const w2 = drv.getState().wave;
  assert.equal(w2.pins.length, 512);
  assert.equal(w2.startCycle, drv.allPins().length - 512);
  // the full history stays reachable (allPins is the client gate's truth)
  assert.ok(drv.allPins().length >= 512);
  drv.run(400); // 1042 samples — enough to see the cap bite
  // out-of-range asks clamp, never tear: the 128 floor stands, the cap holds
  drv.setWaveWin(8);
  assert.equal(drv.getState().wave.pins.length, 128);
  drv.setWaveWin(99999);
  assert.equal(drv.getState().wave.pins.length, 1024);
  drv.setWaveWin(512); // back to the level's window
  assert.equal(drv.getState().wave.pins.length, 512);
});

// ---- back-to-back frames: the off-80 re-arm corner -------------------
test('monitor re-arms on a back-to-back frame', () => {
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  drv.setLens({ mode: 'uart', pin: 0 });
  const fx = frameEffects(0x55).concat(frameEffects(0xaa)); // 160 clks
  M.script(fx);
  drv.run(160);
  const st = drv.getState();
  assert.equal(st.monitor.decoded, 'U\xaa'); // 0x55 'U', 0xaa
});

// ---- TX mirror: display bookkeeping against the engine level ---------
test('tx mirror follows pops and agrees with the engine level', () => {
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  M.script([{ strobes0: S.S_TX_POP }, { strobes0: S.S_TX_POP }]);
  drv.run(2);
  const st = drv.getState();
  assert.equal(st.txLevel, 2);
  assert.deepEqual(st.txWords, [0x4f, 0x21]); // 'O','!' remain
  assert.equal(st.txWords.length, st.txLevel); // the gate's mirror check
});

test('enqueue refuses at the engine tx_full and keeps the mirror exact', () => {
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX); // 4 of 8 deep
  const refused = drv.enqueue([1, 2, 3, 4]);
  assert.equal(refused, 0);
  drv.run(4); // the queued TXF writes retire
  assert.equal(drv.getState().txLevel, 8);
  assert.ok(drv.getState().txFull); // last sample carries S_TX_FULL
  const refused2 = drv.enqueue([9]);
  assert.equal(refused2, 1); // refused at the first overflowing word
  drv.run(2); // nothing new was queued
  assert.equal(drv.getState().txLevel, 8);
  const st = drv.getState();
  assert.deepEqual(st.txWords, M.txFifo()); // mirror == engine contents
});

// ---- readFlevel: a reg read is a rendered clk, timeline aligned -------
test('readFlevel flushes one pending op first, then reads', () => {
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  drv.enqueue([0x55]);
  const pinsBefore = drv.allPins().length;
  const v = drv.readFlevel();
  assert.equal(v, 5); // 4 seeds + the just-flushed 0x55
  const w = M.writes[M.writes.length - 1];
  assert.deepEqual(w, { addr: REG.TXF0, data: 0x55 });
  // the flushed write AND the read each render a clk (the R-line
  // discipline): two samples for one aligned readFlevel
  assert.equal(drv.allPins().length, pinsBefore + 2);
  // an aligned read with an empty queue reads without a flush
  const v2 = drv.readFlevel();
  assert.equal(v2, 5);
  assert.equal(M.writes.length, 22); // no new write
  assert.equal(drv.allPins().length, pinsBefore + 3);
});

// ---- the ds split rides the overlay fields (SPEC-7-16/26) ------------
test('ds-allocator edits queue PINCTRL/EXECCTRL through the overlay', () => {
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  // the slider's ssCnt/sideEn are the overlay's pinctrl.ssCnt +
  // execctrl.sideEn — 2 side bits, no opt enable bit
  drv.setOverlayField(0, 'pinctrl', 'ssCnt', 2);
  drv.setOverlayField(0, 'execctrl', 'sideEn', false);
  drv.run(2);
  assert.deepEqual(M.writes.slice(21), [
    { addr: 0x0dc, data: 0x40100000 }, // (2<<29)|(1<<20): ssCnt 2, out 1
    { addr: 0x0cc, data: 0x3000 }, // wrap 3<<12, SIDE_EN 0
  ]);
  assert.equal(drv.getState().overlay.pinctrl.ssCnt, 2);
  assert.equal(drv.getState().overlay.execctrl.sideEn, false);
});

// ---- stepInsn: "⏭ INSN" stops at the instruction boundary -----------
test('stepInsn advances to the next displayed instruction', () => {
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  M.script([
    { pc0: 0, state0: ST.FETCH, strobes0: S.S_TICK },
    { pc0: 0, state0: ST.EXEC, strobes0: S.S_EXEC | S.S_TICK },
    { pc0: 1, state0: ST.FETCH, strobes0: S.S_TICK },
  ]);
  const before = drv.allPins().length;
  drv.stepInsn();
  assert.equal(drv.allPins().length - before, 3); // stopped at pc 1
  assert.equal(drv.getState().displayPc, 1);
  // a stalled SM: the early-exit fires after one clk
  const { M: M2, drv: drv2 } = freshDriver();
  drv2.load(DEMO_UART_TX);
  M2.script([
    { pc0: 0, state0: ST.STALL },
    { pc0: 0, state0: ST.STALL },
  ]);
  const before2 = drv2.allPins().length;
  drv2.stepInsn();
  assert.equal(drv2.allPins().length - before2, 1);
});

// ---- flashes: strobe-derived, one clk granularity --------------------
test('flashes derive from the cycle strobes', () => {
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  M.script([{ strobes0: S.S_TX_POP, pc0: 3 }]);
  drv.step();
  assert.equal(drv.getState().flashes.pull, true);
  M.script([{ strobes0: S.S_PC_WR, pc0: 2 }]);
  drv.step();
  assert.equal(drv.getState().flashes.jmp, true);
  M.script([{ strobes0: S.S_COMPLETE, pc0: 3 }]);
  drv.step();
  assert.equal(drv.getState().flashes.wrap, true); // complete at wrapLast
  M.script([{ strobes0: S.S_COMPLETE | S.S_PC_WR, pc0: 3 }]);
  drv.step();
  assert.equal(drv.getState().flashes.wrap, false); // a jmp is not a wrap
});

// ---- setProgram: the C19 re-assemble-on-edit commit path --------------
test('setProgram writes only changed imem slots as queued reg ops', () => {
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  assert.equal(M.writes.length, 21);
  // the same words as loaded: nothing to write, no clks consumed
  const same = new Array(32).fill(0);
  [0x9fa0, 0xf727, 0x6001, 0x0642].forEach((w, i) => {
    same[i] = w;
  });
  drv.setProgram(same);
  assert.equal(M.writes.length, 21);
  // one changed slot (SPEC-7-10: IMEM0 + 4*i) — one rendered clk
  same[3] = 0xa042; // nop instead of the jmp
  drv.setProgram(same);
  drv.run(1);
  assert.deepEqual(M.writes.slice(21), [{ addr: 0x054, data: 0xa042 }]);
  // clearing a slot writes 0 (jmp 0 — untouched-memory reset state)
  same[3] = 0;
  drv.setProgram(same);
  drv.run(1);
  assert.deepEqual(M.writes.slice(22), [{ addr: 0x054, data: 0 }]);
});

// ---- the defect hooks: red/green in process (the C20 demo) -----------
// The make web gate runs these as subprocesses and expects FAIL; here
// the same oracle checks are demonstrated directly: the clean driver is
// green against the expected series, the defective one makes the very
// same check go red (the TestMutationsDiverge idiom).
test('defect=pin: the bit0 oracle check is green clean, red defective', () => {
  // bit0 and bit1 disagree: 0-cells drive 0b10, 1-cells drive 0b11
  const g = (pin) => (pin ? 3 : 2);
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  drv.setLens({ mode: 'uart', pin: 0 });
  M.script(frameEffects(0x41, g));
  drv.run(80);
  const clean = drv.allPins();
  const cleanState = drv.getState();

  const { M: M2, drv: bad } = freshDriver({ pin: true });
  bad.load(DEMO_UART_TX);
  bad.setLens({ mode: 'uart', pin: 0 });
  M2.script(frameEffects(0x41, g));
  bad.run(80);
  const defective = bad.allPins();

  // the oracle: gpio_out bit0 per clk (SPEC-16-7 G records) — the
  // load clks idle high, then the frame cells.
  const oracle = new Array(22).fill(1);
  for (const e of frameEffects(0x41)) oracle.push(e.gpio_out & 1);
  assert.deepEqual(clean, oracle); // green leg
  const i = clean.findIndex((_p, k) => defective[k] !== oracle[k]);
  assert.ok(i >= 0, 'defect=pin never diverged from the oracle'); // red leg
  assert.equal(cleanState.monitor.decoded, 'A'); // clean still decodes
  assert.equal(bad.getState().monitor.decoded, ''); // bit1: no frame
});

test('defect=mirror: the mirror-vs-engine check is green clean, red defective', () => {
  const pops = [{ strobes0: S.S_TX_POP }, { strobes0: S.S_TX_POP }];
  const { M, drv } = freshDriver();
  drv.load(DEMO_UART_TX);
  M.script(pops);
  drv.run(2);
  const clean = drv.getState();
  assert.equal(clean.txWords.length, clean.txLevel); // green leg

  const { M: M2, drv: bad } = freshDriver({ mirror: true });
  bad.load(DEMO_UART_TX);
  M2.script(pops);
  bad.run(2);
  const defective = bad.getState();
  // red leg: the very same agreement check fails — the mirror never pops
  assert.notEqual(defective.txWords.length, defective.txLevel);
});

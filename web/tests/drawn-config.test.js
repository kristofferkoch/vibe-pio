// drawn-config.test.js — the C22 drawn-config unit suite (KANBAN C22).
//
// The DESIGN-NOTES grammar (shift-direction arrows, autopull/autopush
// toggles + threshold steppers, the FIFO join ghosts' cycling chip, wrap
// steppers on the arc, pin-mapping base·count steppers on the waveform)
// is pinned at its unit-testable core: the field↔reg-write mapping.
// Every drawn control maps to real overlay edits — nothing is
// display-only — and the edits land as ONE composed reg write per group
// through setOverlayFields (the atomic join edit must not pay two
// SPEC-6-2 settle clks). The DOM glue itself is verified by the browser
// session + make web, never here (docs/js-tooling.md).
//
// The cfgctrl defect hook's red/green demonstration runs in-process:
// green composes FJOIN_TX (bit 30) for the split→tx cycle, the
// re-injected defect swaps it onto FJOIN_RX (bit 31).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFake } = require('./fake-engine.js');
const VibeDriver = require('../engine-driver.js');

const { REG } = VibeDriver;

function freshDriver(defects) {
  const M = createFake();
  const drv = VibeDriver.create(M, defects);
  return { M, drv };
}

const resetOverlay = () => ({
  clkdiv: { ...VibeDriver.EMPTY.clkdiv },
  pinctrl: { ...VibeDriver.EMPTY.pinctrl },
  execctrl: { ...VibeDriver.EMPTY.execctrl },
  shiftctrl: { ...VibeDriver.EMPTY.shiftctrl },
});

// ---- every drawn control names its fields; nothing display-only -------
test('CFG_CONTROLS covers the DESIGN-NOTES grammar and nothing else', () => {
  const ids = Object.keys(VibeDriver.CFG_CONTROLS).sort();
  assert.deepEqual(ids, [
    'autopull',
    'autopush',
    'fifo-join',
    'in-base',
    'in-cnt',
    'isr-dir',
    'osr-dir',
    'out-base',
    'out-cnt',
    'pull-thr',
    'push-thr',
    'side-base',
    'wrap-bot',
    'wrap-top',
  ]);
});

// ---- toggles: the flow arrows + the autopull/autopush flags ------------
test('toggle gestures flip exactly the drawn boolean (SPEC-7-21/5-8/5-9)', () => {
  const ov = resetOverlay();
  const cases = [
    ['osr-dir', 'shiftctrl', 'outRight', false],
    ['isr-dir', 'shiftctrl', 'inRight', false],
    ['autopull', 'shiftctrl', 'autopull', true],
    ['autopush', 'shiftctrl', 'autopush', true],
  ];
  for (const [id, group, field, flippedTo] of cases) {
    const edits = VibeDriver.controlEdit(ov, id, 'toggle');
    assert.deepEqual(edits, [[group, field, flippedTo]], `${id}`);
    // a second toggle flips back
    const ov2 = resetOverlay();
    ov2[group][field] = flippedTo;
    assert.deepEqual(VibeDriver.controlEdit(ov2, id, 'toggle'), [[group, field, !flippedTo]]);
  }
});

// ---- steppers: they wrap (the wrap-stepper idiom), counts store 0=32 --
test('steppers cycle their range and wrap (SPEC-7-19/26, SPEC-5-7)', () => {
  const ov = resetOverlay();
  // WRAP_TOP/WRAP_BOTTOM: 0..31, wrapping
  ov.execctrl.wrapTop = 31;
  assert.deepEqual(VibeDriver.controlEdit(ov, 'wrap-top', 'inc'), [['execctrl', 'wrapTop', 0]]);
  ov.execctrl.wrapBot = 0;
  assert.deepEqual(VibeDriver.controlEdit(ov, 'wrap-bot', 'dec'), [['execctrl', 'wrapBot', 31]]);
  // pin bases: 0..31, wrapping
  ov.pinctrl.outBase = 31;
  assert.deepEqual(VibeDriver.controlEdit(ov, 'out-base', 'inc'), [['pinctrl', 'outBase', 0]]);
  // thresholds: display 1..32, stored 0 encodes 32 (SPEC-5-7)
  ov.shiftctrl.pullThr = 32;
  assert.deepEqual(VibeDriver.controlEdit(ov, 'pull-thr', 'inc'), [['shiftctrl', 'pullThr', 1]]);
  ov.shiftctrl.pushThr = 1;
  assert.deepEqual(VibeDriver.controlEdit(ov, 'push-thr', 'dec'), [['shiftctrl', 'pushThr', 32]]);
  // OUT_COUNT / IN_COUNT: same 0=32 encoding (SPEC-7-26/21)
  ov.pinctrl.outCnt = 31;
  assert.deepEqual(VibeDriver.controlEdit(ov, 'out-cnt', 'inc'), [['pinctrl', 'outCnt', 0]]);
  ov.pinctrl.outCnt = 0; // displayed 32
  assert.deepEqual(VibeDriver.controlEdit(ov, 'out-cnt', 'dec'), [['pinctrl', 'outCnt', 31]]);
  ov.shiftctrl.inCount = 0; // displayed 32
  assert.deepEqual(VibeDriver.controlEdit(ov, 'in-cnt', 'dec'), [['shiftctrl', 'inCount', 31]]);
});

test('controlEdit rejects unknown ids and gestures', () => {
  const ov = resetOverlay();
  assert.throws(() => VibeDriver.controlEdit(ov, 'nope', 'inc'));
  assert.throws(() => VibeDriver.controlEdit(ov, 'wrap-top', 'cycle'));
});

// ---- the FIFO join cycle (SPEC-6-2/3): one atomic edit set ------------
test('fifo-join cycles split → tx → rx → split, clearing aux bits', () => {
  const ov = resetOverlay();
  // split → join TX
  assert.deepEqual(VibeDriver.controlEdit(ov, 'fifo-join', 'inc'), [
    ['shiftctrl', 'fjoinTx', true],
  ]);
  // join TX → join RX (both bits move in ONE edit set)
  ov.shiftctrl.fjoinTx = true;
  assert.deepEqual(VibeDriver.controlEdit(ov, 'fifo-join', 'inc'), [
    ['shiftctrl', 'fjoinTx', false],
    ['shiftctrl', 'fjoinRx', true],
  ]);
  // join RX → split
  ov.shiftctrl.fjoinTx = false;
  ov.shiftctrl.fjoinRx = true;
  assert.deepEqual(VibeDriver.controlEdit(ov, 'fifo-join', 'inc'), [
    ['shiftctrl', 'fjoinRx', false],
  ]);
  // dec walks the cycle backwards: split → join RX
  const ovSplit = resetOverlay();
  assert.deepEqual(VibeDriver.controlEdit(ovSplit, 'fifo-join', 'dec'), [
    ['shiftctrl', 'fjoinRx', true],
  ]);
  // any aux mode (SPEC-6-3) is one cycle from split: the drawn grammar
  // owns join; the set bits clear in the same single write (minimal
  // edits — only fields that actually change)
  for (const [aux, expect] of [
    [{ fjoinRxPut: true }, [['shiftctrl', 'fjoinRxPut', false]]],
    [{ fjoinRxGet: true }, [['shiftctrl', 'fjoinRxGet', false]]],
    [
      { fjoinRxPut: true, fjoinRxGet: true },
      [
        ['shiftctrl', 'fjoinRxPut', false],
        ['shiftctrl', 'fjoinRxGet', false],
      ],
    ],
  ]) {
    const ovAux = resetOverlay();
    Object.assign(ovAux.shiftctrl, aux);
    assert.deepEqual(VibeDriver.controlEdit(ovAux, 'fifo-join', 'inc'), expect);
  }
});

// ---- setOverlayFields: atomic — one composed write per group ----------
test('setOverlayFields composes ONE write per touched group', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  const n0 = M.writes.length;
  drv.setOverlayFields([
    ['shiftctrl', 'fjoinTx', false],
    ['shiftctrl', 'fjoinRx', true],
  ]);
  drv.run(2); // the write clk + the SPEC-6-2 settle clk
  // one SHIFTCTRL write: join RX over the right/right reset base
  assert.deepEqual(M.writes.slice(n0), [{ addr: REG.SM0 + 8, data: 0x800c0000 }]);
  // a same-group pair in the pinctrl range too
  drv.setOverlayFields([
    ['pinctrl', 'outBase', 2],
    ['pinctrl', 'outCnt', 4],
  ]);
  drv.run(1);
  assert.deepEqual(M.writes.slice(-1), [
    { addr: REG.SM0 + 20, data: 0x14400002 }, // setCnt 5 | outCnt 4<<20 | outBase 2
  ]);
});

test('the atomic join edit pays ONE flush + settle clk (SPEC-6-2)', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  const steps0 = M.stepsCount();
  const n0 = M.writes.length;
  drv.setOverlayFields([
    ['shiftctrl', 'fjoinTx', false],
    ['shiftctrl', 'fjoinRx', true],
    ['shiftctrl', 'fjoinRxPut', false],
  ]);
  drv.run(2); // the write clk + the settle clk — no second flush
  assert.equal(M.stepsCount(), steps0 + 1);
  assert.equal(
    M.writes.slice(n0).filter((w) => w.addr === REG.SM0 + 8).length,
    1, // the load-time SHIFTCTRL write is not counted
  );
});

test('setOverlayFields validates before mutating (atomic throw)', () => {
  const { drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  assert.throws(() =>
    drv.setOverlayFields([
      ['pinctrl', 'outBase', 3],
      ['pinctrl', 'outCnt', 33], // out of range — nothing lands
    ]),
  );
  assert.equal(drv.getState().overlay.pinctrl.outBase, 0);
  assert.equal(drv.getState().overlay.pinctrl.outCnt, 0);
});

// ---- applyControl: the view/worker entry point ------------------------
test('applyControl lands the drawn gesture as the composed reg write', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  const n0 = M.writes.length;
  drv.applyControl('wrap-top', 'inc'); // 1 → 2 over the EMPTY reset wrap
  drv.applyControl('osr-dir', 'toggle'); // OUT_SHIFTDIR right → left
  drv.applyControl('pull-thr', 'inc'); // thr 32 → 1 (stored 1)
  drv.run(3);
  assert.deepEqual(M.writes.slice(n0), [
    { addr: REG.SM0 + 4, data: 0x00002fff }, // WRAP_TOP 2 (SPEC-7-19)
    { addr: REG.SM0 + 8, data: 0x00040000 }, // OUT_SHIFTDIR left, thr still 32-encoded-0
    { addr: REG.SM0 + 8, data: 0x02040000 }, // + PULL_THRESH 1<<25 (SPEC-5-7)
  ]);
});

// ---- the cfgctrl defect hook: red/green in process --------------------
test('defect=cfgctrl: the join cycle is green clean, red defective', () => {
  const run = (defects) => {
    const { M, drv } = freshDriver(defects);
    drv.load(VibeDriver.EMPTY);
    const n0 = M.writes.length;
    drv.applyControl('fifo-join', 'inc');
    drv.run(1);
    return M.writes[n0].data;
  };
  // green: split → tx composes FJOIN_TX (bit 30) over the reset word
  assert.equal(run(), 0x400c0000);
  // red: the re-injected defect swaps the cycle onto FJOIN_RX (bit 31)
  assert.equal(run({ cfgctrl: true }), 0x800c0000);
});

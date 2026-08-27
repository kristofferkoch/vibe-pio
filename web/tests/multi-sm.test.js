// multi-sm.test.js — the C24 multi-SM sandbox unit suite (KANBAN C24).
//
// The driver's four-machine surface, pinned against the scripted fake
// engine: the per-SM load timeline (config windows at the 0x18 stride,
// per-SM entry forces, per-SM TXF feeds, the CTRL enable mask), the
// per-SM overlays and their addresses, per-SM FIFO mirrors and drains,
// the selected-SM aliases (select + stepInsn), the pad-ownership
// tracking (last writer, CC-7 scan order), and the two C24
// red-injection hooks (smaddr / owner) whose red/green demonstration
// also runs end-to-end in make web for smaddr (the pin-arbitration leg).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFake } = require('./fake-engine.js');
const VibeDriver = require('../engine-driver.js');

const { REG, ST } = VibeDriver;
const S = createFake().S; // strobe bits (the fake mirrors the shim's)

function freshDriver(defects) {
  const M = createFake();
  const drv = VibeDriver.create(M, defects);
  return { M, drv };
}

// a state with four distinct SM configs: SM0/1 square on their own pins,
// SM2 divided, SM3 disabled — the per-SM load writes must land in the
// right windows (SPEC-7 per-SM map, stride 0x18)
function multiState() {
  const st = VibeDriver.newState();
  st.words = [0xe081, 0x0000].concat(new Array(30).fill(0)); // set pins,1 [1] / jmp 0
  for (let i = 0; i < 3; i++) {
    st.sms[i].pinctrl.setCnt = 1;
    st.sms[i].pinctrl.setBase = i;
    st.sms[i].execctrl.wrapTop = 1;
    st.sms[i].execctrl.wrapBot = 0;
    st.sms[i].execctrl.statusSel = 0;
    st.sms[i].execctrl.statusN = 0;
  }
  st.sms[2].clkdiv = { intg: 2, frac: 0 };
  st.sms[1].entry = 1; // SM1 jumps in at slot 1 (the jmp 0)
  st.sms[0].feeds = [0x11];
  st.sms[2].feeds = [0x22];
  st.sms[3].en = false;
  return st;
}

// ---- the per-SM load timeline ------------------------------------------
test('load writes every SM window at the 0x18 stride and enables the mask', () => {
  const { M, drv } = freshDriver();
  const st = multiState();
  drv.load(st);
  const exp = [{ addr: REG.IMEM0, data: 0xe081 }]; // the 0 word is skipped
  // SM0..2 carry their authored overlay; SM3 the reset overlay
  const ovw = (sm) => {
    const base = REG.SM0 + 0x18 * sm;
    const word = (group) =>
      VibeDriver.composeOverlay(group, sm < 3 ? st.sms[sm][group] : st.sms[3][group]);
    return [
      { addr: base + 20, data: word('pinctrl') },
      { addr: base + 4, data: word('execctrl') },
      { addr: base + 8, data: word('shiftctrl') },
    ];
  };
  exp.push(...ovw(0), ...ovw(1), ...ovw(2), ...ovw(3));
  exp.push({ addr: REG.SM0 + 0x18 * 2, data: 0x00020000 }); // SM2 CLKDIV INT=2
  exp.push({ addr: REG.SM0 + 0x18 * 1 + 16, data: 0x0001 }); // SM1_INSTR: jmp 1
  exp.push(
    { addr: REG.TXF0, data: 0x11 }, // SM0 feed
    { addr: REG.TXF0 + 8, data: 0x22 }, // SM2 feed
    { addr: REG.CTRL, data: 0b0111 }, // SM0..2 enabled, SM3 off
  );
  assert.deepEqual(M.writes, exp);
  // the per-SM TX mirrors carry their own feeds
  const s = drv.getState();
  assert.deepEqual(s.sms[0].txWords, [0x11]);
  assert.deepEqual(s.sms[2].txWords, [0x22]);
  assert.deepEqual(s.sms[1].txWords, []);
});

// ---- per-SM overlay edits land in the edited SM's window --------------
test('setOverlayField routes through the SM window stride', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  const n0 = M.writes.length;
  drv.setOverlayField(2, 'pinctrl', 'outBase', 5);
  drv.setOverlayField(3, 'shiftctrl', 'autopull', true);
  drv.run(2);
  assert.deepEqual(M.writes.slice(n0), [
    { addr: REG.SM0 + 0x18 * 2 + 20, data: 0x14000005 }, // SM2 PINCTRL
    { addr: REG.SM0 + 0x18 * 3 + 8, data: 0x000c0000 | 0x20000 }, // SM3 SHIFTCTRL autopull
  ]);
  // the mirrors track their own SM (getState's selected alias is SM0's)
  assert.equal(drv.getState().overlay.pinctrl.outBase, 0);
  drv.select(2);
  assert.equal(drv.getState().overlay.pinctrl.outBase, 5);
  assert.equal(drv.getState().sm, 2);
});

test('a fifo-mode-changing edit flushes only that SMs mirrors (SPEC-6-2)', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  // two pushes land in SM1's RX (scripted), two in SM3's
  M.script([
    { strobes1: S.S_RX_PUSH },
    { strobes1: S.S_RX_PUSH },
    { strobes3: S.S_RX_PUSH },
    { strobes3: S.S_RX_PUSH },
  ]);
  drv.run(4);
  drv.setOverlayField(1, 'shiftctrl', 'fjoinRx', true); // SM1 join → flush
  drv.run(2); // write + settle
  const s = drv.getState();
  assert.deepEqual(s.sms[1].rxMirror, { pushes: 0, drains: 0, ok: true }); // flushed
  assert.equal(s.sms[3].rxMirror.pushes, 2); // untouched
  assert.ok(s.sms[3].rxMirror.ok);
});

// ---- per-SM feeds + drains ---------------------------------------------
test('enqueue and drainRx address the SMs own FIFOs', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  drv.enqueue([1, 2], 1); // SM1 TXF1
  assert.equal(drv.enqueueWord(0x33, 3), 1); // SM3 TXF3
  drv.run(3);
  M.rxFeed([0x111], 2);
  M.script([{ strobes2: S.S_RX_PUSH }]);
  drv.run(1);
  assert.equal(drv.drainRx(1, 2), 1); // RXF2 read queued
  drv.run(1);
  const s = drv.getState();
  assert.deepEqual(s.sms[1].txWords, [1, 2]);
  assert.deepEqual(s.sms[3].txWords, [0x33]);
  assert.deepEqual(s.sms[2].rxWords, [0x111]); // drained from RXF2
  const txfWrites = M.writes.filter((w) => w.addr >= REG.TXF0 && w.addr < REG.TXF0 + 16);
  assert.deepEqual(txfWrites, [
    { addr: REG.TXF0 + 4, data: 1 },
    { addr: REG.TXF0 + 4, data: 2 },
    { addr: REG.TXF0 + 12, data: 0x33 },
  ]);
});

// ---- the selected SM: aliases + stepInsn --------------------------------
test('select switches the detail-pane aliases; stepInsn follows it', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  M.script([
    { pc3: 4, state3: ST.EXEC, strobes3: S.S_EXEC | S.S_TICK },
    { pc3: 5, state3: ST.FETCH, strobes3: S.S_TICK },
  ]);
  drv.run(1);
  drv.select(3);
  const s = drv.getState();
  assert.equal(s.pc, 4);
  assert.equal(s.phase, 'EXEC');
  assert.equal(s.sms[3].pc, s.pc); // the alias is the selected SM's view
  assert.equal(s.sms[0].pc, 0);
  const before = drv.allPins().length;
  drv.stepInsn(); // steps until SM3's displayed instruction changes
  assert.equal(drv.allPins().length - before, 1);
  assert.equal(drv.getState().displayPc, 5);
});

// ---- pad ownership: last writer, CC-7 scan order ------------------------
test('ownership tracks the last SM to write each pin (CC-7 tiebreak)', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  // clk 1: SM0 writes pins 0..1, SM2 writes pin 1 (conflict) + pin 7;
  // clk 2: SM1 writes pin 0 (takes it back)
  M.script([{ wr_mask0: 0b0000_0011, wr_mask2: 0b1000_0010 }, { wr_mask1: 0b0000_0001 }]);
  drv.run(2);
  const own = drv.getState().owners;
  assert.equal(own[0], 1); // SM1 last
  assert.equal(own[1], 2); // same-clk conflict: the highest SM won
  assert.equal(own[2], -1); // never written
  assert.equal(own[7], 2);
});

// ---- the stored-program format: v2 round-trip per SM --------------------
test('serialize/parse round-trips the four overlays independently', () => {
  const { drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  drv.setOverlayField(1, 'clkdiv', 'intg', 4);
  drv.setOverlayField(2, 'pinctrl', 'setBase', 9);
  drv.setOverlayField(3, 'execctrl', 'wrapTop', 7);
  const json = JSON.parse(JSON.stringify(drv.serialize()));
  const st = VibeDriver.parseState(json);
  assert.equal(st.sms[1].clkdiv.intg, 4);
  assert.equal(st.sms[2].pinctrl.setBase, 9);
  assert.equal(st.sms[3].execctrl.wrapTop, 7);
  assert.equal(st.sms[0].clkdiv.intg, 1); // untouched
  assert.deepEqual(
    st.sms.map((s) => s.en),
    [true, true, true, true],
  );
});

// ---- the C24 defect hooks: red/green in process -------------------------
test('defect=smaddr: SM1..3 overlay writes are green clean, red misaddressed', () => {
  const run = (defects) => {
    const { M, drv } = freshDriver(defects);
    drv.load(VibeDriver.EMPTY);
    const n0 = M.writes.length;
    drv.setOverlayField(2, 'pinctrl', 'outBase', 5);
    drv.run(1);
    return M.writes[n0].addr;
  };
  // green: SM2's PINCTRL at SM0 + 2*0x18 + 20 (SPEC-7 per-SM map)
  assert.equal(run(), REG.SM0 + 0x18 * 2 + 20);
  // red: the 0x14 stride transcription lands inside SM1's window
  assert.equal(run({ smaddr: true }), REG.SM0 + 0x14 * 2 + 20);
  assert.notEqual(run(), run({ smaddr: true }));
});

test('defect=owner: the ownership scan is green clean, red inverted', () => {
  const run = (defects) => {
    const { M, drv } = freshDriver(defects);
    drv.load(VibeDriver.EMPTY);
    // a same-clk conflict on pin 1: SM0 and SM2 both write it
    M.script([{ wr_mask0: 0b10, wr_mask2: 0b10 }]);
    drv.run(1);
    return drv.getState().owners[1];
  };
  assert.equal(run(), 2); // green: highest-numbered SM wins (CC-7)
  assert.equal(run({ owner: true }), 0); // red: the scan inverted
});

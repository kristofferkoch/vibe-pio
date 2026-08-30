// pin-map.test.js — the C27 pin-mapping surface (KANBAN C27): the
// selected SM's OUT / SIDESET / IN extents as the pin strip draws them
// (pinExtents, SPEC-7-26/21) and the was-driven classification of pads
// whose wiring has moved away (the live-vs-stale distinction the owner
// corner + held level render).
//
// pinExtents is pure over one SM's overlay; the was-driven mask ships in
// getState() next to `owners` (it is the same ownership lens grown one
// question: not just WHO wrote last, but whether that SM's current write
// extents can still reach the pad).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFake } = require('./fake-engine.js');
const VibeDriver = require('../engine-driver.js');

function freshDriver(defects) {
  const M = createFake();
  const drv = VibeDriver.create(M, defects);
  return { M, drv };
}

// ---- pinExtents: the OUT / SIDESET / IN (and SET) ranges ---------------
test('pinExtents draws the ranges, wrapping past GPIO31 (SPEC-7-26)', () => {
  const ov = VibeDriver.newState().sms[0];
  // the reset posture: OUT_COUNT/IN_COUNT 0 encode 32 (SPEC-7-26/21),
  // no side-set (SIDESET_COUNT 0 — SPEC-4-9), SET at its reset 5 from 0
  let e = VibeDriver.pinExtents(ov);
  assert.equal(e.out, 0xffffffff);
  assert.equal(e.in, 0xffffffff);
  assert.equal(e.side, 0);
  assert.equal(e.set, 0x1f);
  // a partial OUT range wrapping the memory edge: base 30, count 4
  ov.pinctrl.outBase = 30;
  ov.pinctrl.outCnt = 4;
  e = VibeDriver.pinExtents(ov);
  assert.equal(e.out, 0xc0000003); // pins 30, 31, 0, 1
});

test('the SIDESET extent covers the data bits only — the opt bit is not a pin (SPEC-4-2/5)', () => {
  const ov = VibeDriver.newState().sms[0];
  // ssCnt 2 + SIDE_EN: one data bit at SIDESET_BASE, the MSB is enable
  ov.pinctrl.ssCnt = 2;
  ov.execctrl.sideEn = true;
  ov.pinctrl.ssBase = 4;
  assert.equal(VibeDriver.pinExtents(ov).side, 1 << 4);
  // ssCnt 3 without opt: three data bits, wrapping like every range
  ov.pinctrl.ssCnt = 3;
  ov.execctrl.sideEn = false;
  ov.pinctrl.ssBase = 30;
  assert.equal(VibeDriver.pinExtents(ov).side, 0xc0000001);
});

test('the IN extent is IN_BASE + SHIFTCTRL.IN_COUNT (SPEC-7-21)', () => {
  const ov = VibeDriver.newState().sms[0];
  ov.pinctrl.inBase = 10;
  ov.shiftctrl.inCount = 5;
  assert.equal(VibeDriver.pinExtents(ov).in, 0x7c00); // pins 10..14
});

// ---- getState().pinMap: the SELECTED SM's extents ----------------------
test('pinMap is the selected SM’s trio — the strip follows the machine bar', () => {
  const { drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  drv.setOverlayField(2, 'pinctrl', 'outBase', 5);
  drv.setOverlayField(2, 'pinctrl', 'outCnt', 1);
  drv.setOverlayField(2, 'pinctrl', 'setCnt', 0);
  drv.flushOps();
  drv.select(2);
  assert.equal(drv.getState().pinMap.out, 1 << 5);
  drv.select(0);
  assert.equal(drv.getState().pinMap.out, 0xffffffff); // SM0 untouched
});

// ---- was-driven: OE held, the owner's wiring moved away ----------------
test('a pad the owner can still reach is live; moving the wiring away reads stale', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  // SM0 writes pin 4 (side/out/set write — the pad latches OE and level)
  M.script([{ gpio_oe: 1 << 4, wr_mask0: 1 << 4 }]);
  drv.run(1);
  const s0 = drv.getState();
  assert.equal(s0.owners[4], 0);
  assert.equal((s0.stale >>> 4) & 1, 0); // OUT_COUNT 0 = all 32: still live
  // move every write mapping of SM0 off pin 4: OUT to {5}, SET gone
  // (SIDESET_COUNT is already 0)
  drv.setOverlayField(0, 'pinctrl', 'outBase', 5);
  drv.setOverlayField(0, 'pinctrl', 'outCnt', 1);
  drv.setOverlayField(0, 'pinctrl', 'setCnt', 0);
  drv.flushOps();
  assert.equal((drv.getState().stale >>> 4) & 1, 1); // was driven
  // one stepper click back: the wiring reaches the pad again
  drv.setOverlayField(0, 'pinctrl', 'outBase', 4);
  drv.flushOps();
  assert.equal((drv.getState().stale >>> 4) & 1, 0);
});

test('staleness judges the OWNER’s extents, not another SM’s (CC-7 owner lens)', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  // SM2 owns pin 9; SM0's default OUT covers everything
  M.script([{ gpio_oe: 1 << 9, wr_mask2: 1 << 9 }]);
  drv.run(1);
  drv.setOverlayField(2, 'pinctrl', 'outBase', 0);
  drv.setOverlayField(2, 'pinctrl', 'outCnt', 1);
  drv.setOverlayField(2, 'pinctrl', 'setCnt', 0);
  drv.flushOps();
  assert.equal((drv.getState().stale >>> 9) & 1, 1); // SM0 covering it is not the question
});

test('an OE pad with no recorded writer is never classified stale', () => {
  const { M, drv } = freshDriver();
  drv.load(VibeDriver.EMPTY);
  M.script([{ gpio_oe: 1 << 3 }]); // oe without a write: no owner to judge
  drv.run(1);
  assert.equal(drv.getState().owners[3], -1);
  assert.equal((drv.getState().stale >>> 3) & 1, 0);
});

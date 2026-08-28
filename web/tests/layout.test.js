// layout.test.js — the browser-level layout gate (headless Chromium via
// CDP, zero dependencies — see browser.js). The node --test suite is
// hermetic DOM-free units; this file is deliberately NOT that: it loads
// the real sm-view.html and asserts the geometry a user actually gets,
// pinning the two layout-defect classes the project has already hit by
// hand:
//
//   * the right-column fit: every panel above the inspector must sit
//     inside the viewport on a 13" laptop (1280×800) without scrolling
//     the column — the design gives the spare pixels to the inspector
//     (it scrolls internally), never to pushing the RX FIFO below the
//     fold;
//   * the C22 spill: adjacent panels must not overlap (a content-free
//     minimum once spilled the join-deep FIFO row over the panels below
//     and made the drawn controls unclickable), and every drawn control
//     must actually be under the pointer (elementFromPoint).
//   * the column priority (the layout reprioritization): the register
//     column is not the exec waveform's leftover — at the reference
//     viewports it gets its measured floor (its drawn control rows
//     render single-line, the inspector shows real room, never a
//     sliver), the exec echo is two lines, and the out datapath
//     (tx fifo → pull → osr) lives in the exec column, where the old
//     blank execbody wall used to be. On a desktop the app caps with
//     the center at the waveform's natural scale, not with the register
//     column at its old 330px ceiling.
//
// Hermetic: the static server stubs build/web/pio_engine.js, so no wasm
// build is needed — the view's geometry is complete at script load
// (render(V.state) runs before the worker ever answers). The boot veil
// is absolutely positioned (layout-invisible) but would defeat the
// hit-test, so each check removes it, exactly as the real 'ready'
// handler does.

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const browser = require('./browser.js');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 0; // ephemeral

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

let server;
let baseUrl;
let b;
let page;
// the worker's importScripts of the engine is held open forever: the
// hermetic scenario is "engine never arrives" — no wasm build, but also
// no worker 'werr' (whose handler replaces the footer's innerHTML and
// pulls layout-bearing chrome out from under a mid-flight render()) and
// no 'ready', so every load() measures the same stable pre-boot page
const pendingEngines = [];

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/build/web/pio_engine.js') {
      pendingEngines.push(res);
      return;
    }
    const file = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store', // the serve.py lesson: no heuristic caching
    });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  b = await browser.launch();
  page = await b.newPage();
});

after(async () => {
  if (b) await b.close();
  for (const res of pendingEngines.splice(0)) res.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
});

const pageUrl = () => `${baseUrl}/web/sm-view.html`;

// the join-tx posture: the TX FIFO borrows RX storage (SPEC-6-2) and
// renders 8 slots; join-rx mirrors it — the doubled column must cap at
// its split height (it scrolls within itself) either way
const JOIN_TX = { fifoDepths: { tx: 8, rx: 0 }, txWords: [], txLevel: 0, rxLevel: 0 };
const JOIN_RX = { fifoDepths: { tx: 0, rx: 8 }, txWords: [], txLevel: 0, rxLevel: 0 };

async function load(state, width, height) {
  await page.setViewport(width, height);
  await page.goto(pageUrl());
  if (state) await page.evaluate(`render(Object.assign({}, V.state, ${JSON.stringify(state)}))`);
  await page.evaluate("document.getElementById('boot')?.remove()");
}

const GEO = `(() => {
  const regs = document.querySelector('#regs').getBoundingClientRect();
  const exec = document.querySelector('main > section.panel:nth-of-type(2)');
  const execRect = exec.getBoundingClientRect();
  const row = (d) => {
    const b = d.getBoundingClientRect();
    return {
      id: d.id || d.className,
      top: b.top,
      bottom: b.bottom,
      h: b.height,
      sh: d.scrollHeight,
      ch: d.clientHeight,
      sw: d.scrollWidth,
      cw: d.clientWidth,
    };
  };
  const rows = [...document.querySelectorAll('#regs > div')].map(row);
  const execRows = [...exec.querySelectorAll(':scope > div')].map(row);
  const h = (sel) => document.querySelector(sel).getBoundingClientRect().height;
  const rectOf = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { w: b.width, bottom: b.bottom, inExec: !!e.closest('#exec') };
  };
  const irns = [...document.querySelectorAll('#inspbody .irn')].map((e) => {
    const b = e.getBoundingClientRect();
    return { l: b.left, w: b.width };
  });
  const chips = [...document.querySelectorAll('#inspbody .ifield')].map((e) =>
    Math.round(e.getBoundingClientRect().height),
  );
  return {
    iw: innerWidth,
    ih: innerHeight,
    clip: regs.bottom, // #regs is overflow-y:auto — its bottom edge clips
    execClip: execRect.bottom, // .panel is overflow:hidden — same idea here
    regsW: regs.width, // the register column's share (the priority check)
    centerW: execRect.width,
    waveH: h('#wavesvg'),
    fifo: rectOf('#fifo'),
    rxfifo: rectOf('#rxfifo'),
    insp: { irns, chips },
    room: {
      // the drawn control rows whose single-line render is what "room on
      // the right side" means concretely (wrapped values are 36–63px)
      irqlamps: h('#irqlamps'),
      osrnote: h('#osr .shiftnote'),
      isrnote: h('#isr .shiftnote'),
      insptitle: h('#inspector .ptitle'),
    },
    rows,
    execRows,
    chrome: { header: h('header'), smsbar: h('#smsbar'), pinstrip: h('#pinstrip'), footer: h('footer') },
  };
})()`;

function assertFits(geo, width, height, stateName) {
  assert.strictEqual(geo.iw, width, `viewport override failed: ${geo.iw} != ${width}`);
  assert.strictEqual(geo.ih, height, `viewport override failed: ${geo.ih} != ${height}`);
  // The test is against the column's clip edge, not the viewport: a row
  // ending between the clip edge and the viewport bottom renders under
  // the footer — invisible just the same. (The rx fifo's own named
  // check lives with the fifo twins in assertExec — it left this
  // column for the exec column's twin row.)
  for (const r of geo.rows) {
    if (r.id === 'inspector') continue; // the flexible row: scrolls internally by design
    assert(
      r.bottom <= geo.clip + 0.5,
      `#${r.id} below the fold at ${width}×${height} (${stateName}): bottom ${r.bottom.toFixed(1)} > column edge ${geo.clip.toFixed(1)}`,
    );
    // A panel squeezed below its content "fits" any viewport while its
    // overflow paints over the panels below (the C22 spill) — so fit is
    // only honest if the box actually contains its content.
    assert(
      r.sh <= r.ch + 1,
      `#${r.id} is squeezed at ${width}×${height} (${stateName}): content ${r.sh}px in a ${r.ch}px box — its overflow spills over the next panel`,
    );
    // #regs is the rightmost column: horizontal spill paints past the app
    assert(
      r.sw <= r.cw + 1,
      `#${r.id} overflows horizontally at ${width}×${height} (${stateName}): content ${r.sw}px in a ${r.cw}px box`,
    );
  }
}

function assertNoSpill(geo) {
  for (let i = 1; i < geo.rows.length; i++) {
    const prev = geo.rows[i - 1];
    const cur = geo.rows[i];
    assert(
      cur.top >= prev.bottom - 0.51,
      `#${cur.id} spills over #${prev.id}: top ${cur.top.toFixed(1)} < bottom ${prev.bottom.toFixed(1)} (the C22 spill class)`,
    );
  }
}

// the column priority: the register column is wide enough that its drawn
// control rows render on one line and the inspector shows real content,
// not the exec column's leftover. Bounds are the measured single-line /
// min-visible values of the rebalanced split (+ slack); the wrapped
// values they fail against are 36–63px and 28px.
function assertRoomy(geo, width, stateName) {
  assert(
    geo.regsW >= 350,
    `register column squeezed at ${width} (${stateName}): ${geo.regsW.toFixed(0)}px — the exec pane is hogging the row (floor 350)`,
  );
  for (const [name, h, bound] of [
    ['irq lamps', geo.room.irqlamps, 26],
    ['osr shift note', geo.room.osrnote, 26],
    ['isr shift note', geo.room.isrnote, 26],
    ['inspector title', geo.room.insptitle, 26],
  ]) {
    assert(
      h <= bound,
      `${name} wraps at ${width} (${stateName}): ${h.toFixed(1)}px tall — the register column has no room for its controls on one line`,
    );
  }
  const insp = geo.rows.find((r) => r.id === 'inspector');
  assert(
    insp && insp.h >= 200,
    `register inspector is a sliver at ${width} (${stateName}): ${insp.h.toFixed(1)}px visible (floor 200 — the datapath panels must live in the exec column, not stacked over it)`,
  );
  // the ledger: every register's name sits in the same aligned column,
  // and the field chips share one height — ragged name columns and
  // mixed chip heights are the "jumbled" failure
  const { irns, chips } = geo.insp;
  assert(
    irns.length >= 10,
    `inspector ledger lost its registers at ${width} (${stateName}): ${irns.length} names`,
  );
  const l0 = irns[0].l;
  const w0 = irns[0].w;
  for (const r of irns) {
    assert(
      Math.abs(r.l - l0) <= 2,
      `inspector register names are not column-aligned at ${width} (${stateName})`,
    );
    assert(
      Math.abs(r.w - w0) <= 2,
      `inspector register names are not equal width at ${width} (${stateName})`,
    );
  }
  const hmin = Math.min(...chips);
  const hmax = Math.max(...chips);
  assert(
    chips.length >= 10 && hmax - hmin <= 2,
    `inspector field chips are ragged at ${width} (${stateName}): heights ${hmin}..${hmax}px across ${chips.length} chips — one chip grid, one height`,
  );
}

// pass 2 of the reprioritization: the exec column's blank body wall is
// gone — its echo is two lines — and the out datapath took that space.
// Pass 3: the fifo twins share the exec column too, side by side at
// equal width, and the inspector reads as a ledger.
function assertExec(geo, width, height, stateName) {
  for (const id of ['fifo', 'pullconn', 'osr']) {
    assert(
      geo.execRows.some((r) => r.id === id) || (id === 'fifo' && geo.fifo?.inExec),
      `#${id} is not in the exec column at ${width} (${stateName}) — the out datapath belongs where the exec body wall was`,
    );
  }
  // the named check, stated plainly: both fifos on-screen, same side,
  // same width
  for (const [name, f] of [
    ['tx fifo', geo.fifo],
    ['rx fifo', geo.rxfifo],
  ]) {
    assert(
      f?.inExec === true,
      `${name} is not in the exec column at ${width} (${stateName}) — the fifos belong side by side in the middle pane`,
    );
    assert(
      (f?.bottom ?? Infinity) <= geo.execClip + 0.5,
      `${name} below the fold at ${width}×${height} (${stateName}): bottom ${f?.bottom.toFixed(1)} > panel edge ${geo.execClip.toFixed(1)}`,
    );
  }
  assert(
    Math.abs((geo.fifo?.w ?? NaN) - (geo.rxfifo?.w ?? NaN)) <= 2,
    `tx/rx fifo widths differ at ${width} (${stateName}): ${geo.fifo?.w.toFixed(0)}px vs ${geo.rxfifo?.w.toFixed(0)}px — the twin row must split evenly`,
  );
  const title = geo.execRows[0];
  assert(
    title && title.h <= 44,
    `exec echo title line is ${title ? title.h.toFixed(1) : 'absent'}px tall at ${width} (${stateName}) (bound 44 — two lines, not a body wall)`,
  );
  const slim = geo.execRows.find((r) => r.id === 'execslim');
  assert(
    slim && slim.h <= 44,
    `exec echo second line is ${slim ? slim.h.toFixed(1) : 'absent'}px tall at ${width} (${stateName}) (bound 44 — two lines, not a body wall)`,
  );
  assert(
    geo.waveH >= 100,
    `waveform collapsed to ${geo.waveH.toFixed(1)}px at ${width}×${height} (${stateName})`,
  );
  // the same honesty the #regs rows get, now for the exec column's
  // residents: nothing squeezed (the C22 class), nothing spilling past
  // the panel's clip edge or its neighbors. Zero-height rows are
  // display-none (the uart lens's frame map) — no layout, no claims.
  const live = geo.execRows.filter((r) => r.h > 0);
  for (const r of live) {
    assert(
      r.bottom <= geo.execClip + 0.5,
      `exec column row ${r.id} below the fold at ${width}×${height} (${stateName}): bottom ${r.bottom.toFixed(1)} > panel edge ${geo.execClip.toFixed(1)}`,
    );
    assert(
      r.sh <= r.ch + 1,
      `exec column row ${r.id} is squeezed at ${width}×${height} (${stateName}): content ${r.sh}px in a ${r.ch}px box`,
    );
    assert(
      r.sw <= r.cw + 1,
      `exec column row ${r.id} overflows horizontally at ${width}×${height} (${stateName}): content ${r.sw}px in a ${r.cw}px box`,
    );
  }
  for (let i = 1; i < live.length; i++) {
    const prev = live[i - 1];
    const cur = live[i];
    assert(
      cur.top >= prev.bottom - 0.51,
      `exec column row ${cur.id} spills over ${prev.id}: top ${cur.top.toFixed(1)} < bottom ${prev.bottom.toFixed(1)} (the C22 spill class)`,
    );
  }
}

// every drawn control in the fixed rows must be topmost at its center —
// the C22 failure mode was drawn controls buried under a spilled panel
const HIT_SCAN = `(() => {
  const bad = [];
  for (const el of document.querySelectorAll(
    '#regs > div:not(#inspector) button, main > section.panel:nth-of-type(2) > div button',
  )) {
    const b = el.getBoundingClientRect();
    const name = el.id || el.textContent.trim().slice(0, 12);
    if (b.width < 2 || b.height < 2) { bad.push(name + ': collapsed'); continue; }
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    if (!hit || !(hit === el || el.contains(hit))) bad.push(name + ': covered by ' + (hit ? hit.id || hit.className : 'nothing'));
  }
  return bad;
})()`;

// The reference machine is a 13" laptop: 1280×800 logical (the report
// that opened this gate) and 1366×768 (the other common 13" panel).
const VIEWPORTS = [
  [1280, 800],
  [1366, 768],
];

for (const [width, height] of VIEWPORTS) {
  for (const [stateName, state] of [
    ['split', null],
    ['join tx', JOIN_TX],
    ['join rx', JOIN_RX],
  ]) {
    test(`columns fit ${width}×${height} (${stateName}): fifos paired on-screen`, async () => {
      await load(state, width, height);
      const geo = await page.evaluate(GEO);
      assertFits(geo, width, height, stateName);
      assertNoSpill(geo);
      assertRoomy(geo, width, stateName);
      assertExec(geo, width, height, stateName);
      const covered = await page.evaluate(HIT_SCAN);
      assert.deepStrictEqual(
        covered,
        [],
        `buried/collapsed controls at ${width}×${height} (${stateName})`,
      );
    });
  }
}

// the desktop cap: the app stops growing with the center at the
// waveform's natural scale (128 cycles × 7px = 896px) and the register
// column at its 430px comfort ceiling — not with the register column at
// the old 330px clamp while the exec pane absorbs the surplus
test(`desktop cap 1920×1080: center at natural scale, register column at its ceiling`, async () => {
  await load(null, 1920, 1080);
  const geo = await page.evaluate(GEO);
  assertFits(geo, 1920, 1080, 'split');
  assert(
    geo.regsW >= 424,
    `register column below its ceiling at 1920: ${geo.regsW.toFixed(0)}px (want the 430px clamp)`,
  );
  assert(
    geo.centerW <= 904,
    `exec column above the waveform's natural scale at 1920: ${geo.centerW.toFixed(0)}px (cap 904)`,
  );
});

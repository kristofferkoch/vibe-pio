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
  const rows = [...document.querySelectorAll('#regs > div')].map((d) => {
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
  });
  const h = (sel) => document.querySelector(sel).getBoundingClientRect().height;
  return {
    iw: innerWidth,
    ih: innerHeight,
    clip: regs.bottom, // #regs is overflow-y:auto — its bottom edge clips
    rows,
    chrome: { header: h('header'), smsbar: h('#smsbar'), pinstrip: h('#pinstrip'), footer: h('footer') },
  };
})()`;

function assertFits(geo, width, height, stateName) {
  assert.strictEqual(geo.iw, width, `viewport override failed: ${geo.iw} != ${width}`);
  assert.strictEqual(geo.ih, height, `viewport override failed: ${geo.ih} != ${height}`);
  // the named check first — the user-visible symptom, stated plainly.
  // The test is against the column's clip edge, not the viewport: a row
  // ending between the clip edge and the viewport bottom renders under
  // the footer — invisible just the same.
  const rx = geo.rows.find((r) => r.id === 'rxfifo');
  assert(
    rx && rx.bottom <= geo.clip + 0.5,
    `rx fifo below the fold at ${width}×${height} (${stateName}): bottom ${rx.bottom.toFixed(1)} > column edge ${geo.clip.toFixed(1)}\n` +
      geo.rows
        .map((r) => `  #${r.id}: ${r.top.toFixed(1)}..${r.bottom.toFixed(1)} (h=${r.h.toFixed(1)})`)
        .join('\n'),
  );
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

// every drawn control in the fixed rows must be topmost at its center —
// the C22 failure mode was drawn controls buried under a spilled panel
const HIT_SCAN = `(() => {
  const bad = [];
  for (const el of document.querySelectorAll('#regs > div:not(#inspector) button')) {
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
    test(`right column fits ${width}×${height} (${stateName}): rx fifo on-screen`, async () => {
      await load(state, width, height);
      const geo = await page.evaluate(GEO);
      assertFits(geo, width, height, stateName);
      assertNoSpill(geo);
      const covered = await page.evaluate(HIT_SCAN);
      assert.deepStrictEqual(
        covered,
        [],
        `buried/collapsed controls at ${width}×${height} (${stateName})`,
      );
    });
  }
}

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
//   * hover and press never reflow (the C26 era skin): the first cut
//     bolded hovered buttons and the bitmap bold face ran wider —
//     controls grew under the pointer and re-flowed their rows; the
//     pressed nudge then leaked through specificity onto the drawn
//     mini-controls. Hover restyles are color-only; the padding swap
//     belongs to the push-button faces alone.
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
  // C26: the geometry is font-dependent (the two bitmap webfonts) —
  // measure only once they are settled, or early frames measure the
  // fallback faces
  await page.evaluate('document.fonts.ready.then(() => {})');
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
  // the field grid: each chip's value input must end flush at the
  // chip's right edge — name/bits/value on three aligned columns.
  // Inputs that stop wherever the name happened to end are the jumble.
  // (Checkboxes are toggles, not value fields — they sit at the start
  // of the value column by design.)
  const chipAlign = [...document.querySelectorAll('#inspbody .ifield')]
    .map((chip) => {
      const inp = chip.querySelector('input[type="number"], input[type="text"]');
      if (!inp) return null;
      return Math.round(chip.getBoundingClientRect().right - inp.getBoundingClientRect().right);
    })
    .filter((d) => d !== null);
  const inputW = [
    ...document.querySelectorAll('#inspbody .ifield input[type="number"]'),
  ].map((e) => Math.round(e.getBoundingClientRect().width));
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
    insp: { irns, chips, chipAlign, inputW },
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
  // the field grid: name/bits/value on three aligned columns, the value
  // input ending flush at every chip's right edge at one width
  const { chipAlign, inputW } = geo.insp;
  assert(
    chipAlign.length >= 8,
    `inspector lost its field inputs at ${width} (${stateName}): ${chipAlign.length} chips with inputs`,
  );
  assert(
    Math.min(...chipAlign) >= -2 && Math.max(...chipAlign) - Math.min(...chipAlign) <= 2,
    `inspector field values are not grid-aligned at ${width} (${stateName}): inputs end ${Math.min(...chipAlign)}..${Math.max(...chipAlign)}px short of their chip edges — name/bits/value must sit on three fixed columns`,
  );
  assert(
    inputW.length >= 8 && Math.max(...inputW) - Math.min(...inputW) <= 2,
    `inspector value inputs are not one width at ${width} (${stateName}): ${Math.min(...inputW)}..${Math.max(...inputW)}px`,
  );
}

// pass 2 of the reprioritization: the exec column's blank body wall is
// gone — its echo is two lines — and the out datapath took that space.
// Pass 3: the fifo twins share the exec column too, side by side at
// equal width, and the inspector reads as a ledger. Pass 4: the isr
// joins the exec column above the twins — the shift registers sandwich
// the fifo pair (osr below like isr above) — leaving the right column
// to scratch, irq and the inspector ledger.
function assertExec(geo, width, height, stateName) {
  for (const id of ['fifo', 'pullconn', 'osr']) {
    assert(
      geo.execRows.some((r) => r.id === id) || (id === 'fifo' && geo.fifo?.inExec),
      `#${id} is not in the exec column at ${width} (${stateName}) — the out datapath belongs where the exec body wall was`,
    );
  }
  const isr = geo.execRows.find((r) => r.id === 'isr');
  assert(
    isr && isr.top < (geo.fifo?.bottom ?? 0),
    `#isr is not above the fifo twins in the exec column at ${width} (${stateName}) — the shift registers sandwich the fifo pair`,
  );
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
    geo.waveH >= 64,
    `waveform collapsed to ${geo.waveH.toFixed(1)}px at ${width}×${height} (${stateName}) — the shift registers sandwiching the fifo pair buy their room from the wave, but it keeps a floor`,
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
  // C26 re-pin: the cap is not just a ceiling — the wave must REACH its
  // natural scale (128 cycles × 7px = 896px, the integer grid the drawn
  // geometry snaps to). The era window's 2px bevel padding used to eat
  // 6px of it (measured 890): the wave rendered perpetually sub-scale.
  assert(
    geo.centerW >= 892,
    `exec column short of the waveform's natural scale at 1920: ${geo.centerW.toFixed(0)}px (want 896 — the window chrome must not tax the drawn grid)`,
  );
  // the pin strip must show all 32 pins at the cap: the narrated legend
  // that used to lead the strip measured 828px (scrollWidth 2043 in a
  // 1798px box), so the top-numbered pins sat scrolled away on every
  // window — the legend shows the marks now, not the sentence
  const strip = await page.evaluate(`(() => {
    const s = document.querySelector('#pinstrip');
    return { sw: s.scrollWidth, cw: s.clientWidth, cells: s.querySelectorAll('.pcell').length };
  })()`);
  assert.strictEqual(strip.cells, 32, 'pin strip lost cells');
  assert(
    strip.sw <= strip.cw + 1,
    `pin strip overflows at the cap: content ${strip.sw}px in a ${strip.cw}px box — the legend is squeezing pins behind the scroll`,
  );
});

// hover and press must never reflow: the C26 era skin first shipped a
// bold hover face (Pixelated MS Sans bold runs wider — auto-width
// buttons grew under the pointer and re-flowed their rows), then a
// pressed nudge whose padding swap leaked onto the drawn mini-controls
// (button:active/button.on out-rank the single-class rules, so the
// autopull toggle and inspector paddles grew on press/on and the fixed
// 13px steppers had their glyphs crushed). The pin: sweep the pointer
// across every interactive control family requiring the boxes to hold
// exactly, then press one representative per button face. Hover
// restyles are color-only; the pressed bevel swap keeps its padding sum
// on the push-button faces and does not reach the drawn ones at all.
const HOVER_SEL =
  'header button, #smsbar .smcell, .cstep, .ctgl, .segjoin button, .tstep, .wstep, .ipulse, #rxmeta button';
const HOVER_RECTS = `[...document.querySelectorAll('${HOVER_SEL}')].map((e) => {
  const b = e.getBoundingClientRect();
  return [e.id || e.textContent.trim().slice(0, 12), +b.left.toFixed(1), +b.top.toFixed(1), +b.width.toFixed(1), +b.height.toFixed(1)];
})`;

// one representative per face family; releases mutate machine state
// (toggles flip, steppers step), so each iteration recaptures the
// reference boxes — the assertions are about box stability under the
// pointer/press, never about the page being frozen
const PRESS_SELS = [
  '#bstep', // the base push face (its own padding swap keeps its sum)
  '#bempty', // the header mini face
  '#aptgl', // .ctgl — the auto-width leak
  '#spin-pullthr button[data-g="inc"]', // .cstep — the fixed-box crush
  '#spin-outbase button[data-g="inc"]', // .tstep
  '.wstep', // the wrap steppers
  '#segsplit', // .segjoin button
  '.ipulse', // inspector paddles — the other auto-width leak
  '#bdrain', // #rxmeta face
];

test('hover and press never reflow: controls keep their boxes under the pointer', async () => {
  await load(null, 1280, 800);
  const before = await page.evaluate(HOVER_RECTS);
  assert.ok(
    before.length >= 15,
    `hover scan lost its targets: ${before.length} controls matched ${HOVER_SEL}`,
  );
  const centers = await page.evaluate(
    `[...document.querySelectorAll('${HOVER_SEL}')].map((e) => { const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })`,
  );
  for (const [x, y] of centers) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await new Promise((r) => setTimeout(r, 30));
    const after = await page.evaluate(HOVER_RECTS);
    assert.deepStrictEqual(
      after,
      before,
      `hovering at ${Math.round(x)},${Math.round(y)} re-flowed the page — a hover restyle changed metrics (font-weight/border/padding); hover is color-only in the era skin`,
    );
  }
  for (const sel of PRESS_SELS) {
    const center = await page.evaluate(
      `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`,
    );
    assert.ok(center, `press scan: ${sel} not found on the page`);
    const ref = await page.evaluate(HOVER_RECTS);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center[0], y: center[1] });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(
      await page.evaluate(HOVER_RECTS),
      ref,
      `hovering ${sel} re-flowed the page`,
    );
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: center[0],
      y: center[1],
      button: 'left',
      clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(
      await page.evaluate(HOVER_RECTS),
      ref,
      `pressing ${sel} re-flowed the page — the :active/:on padding swap leaked onto this face; the label nudge belongs to the push-button faces only`,
    );
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: center[0],
      y: center[1],
      button: 'left',
      clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 30));
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
});

// the wrap arc's steppers in the degenerate WRAP_TOP == WRAP_BOTTOM state
// (a fresh SM stepped to 0/0): the WRAP_TOP pair used to land 11px above
// the listing's scroll origin — clipped out of a scroll container, so
// the one gesture that re-stretches the arc was unreachable. The pins:
// nothing above the content origin, no pair overlapping another, and
// everything on-screen topmost under the pointer. The drawn state is
// reached the way the sandbox reaches it — overlay fields, then the
// program rebuild (the same path a real stepper write takes).
const WRAP_SCAN = `(() => {
  Object.assign(curState.sms[0].execctrl, { wrapTop: 0, wrapBot: 0 });
  OV = overlayOf(0);
  buildProgram();
  const host = document.querySelector('#progrows');
  const hb = host.getBoundingClientRect();
  const steps = [...host.querySelectorAll('.wstep')];
  const bad = [];
  if (steps.length !== 4) bad.push('expected 4 wrap steppers, found ' + steps.length);
  const name = (b) => b.dataset.ctl + '/' + b.dataset.g;
  const rects = steps.map((b) => b.getBoundingClientRect());
  for (const [i, r] of rects.entries()) {
    if (r.top < hb.top - 0.5)
      bad.push(
        'stepper ' + name(steps[i]) + ' clipped above the listing scroll origin (' +
          (r.top - hb.top).toFixed(1) + 'px) — unreachable in a scroll container',
      );
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !(hit === steps[i] || steps[i].contains(hit)))
      bad.push('stepper ' + name(steps[i]) + ' covered by ' + (hit ? hit.id || hit.className : 'nothing'));
  }
  for (let i = 1; i < rects.length; i++)
    for (let j = 0; j < i; j++) {
      const a = rects[i], b = rects[j];
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
        bad.push('steppers ' + name(steps[j]) + ' and ' + name(steps[i]) + ' overlap');
    }
  return bad;
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`wrap 0/0: all four arc steppers stay reachable ${width}×${height}`, async () => {
    await load(null, width, height);
    const bad = await page.evaluate(WRAP_SCAN);
    assert.deepStrictEqual(
      bad,
      [],
      `broken wrap steppers at ${width}×${height} (wrap-top inc is the arc's only stretch gesture)`,
    );
  });
}

// the wrap arc in the RESET posture: WRAP_TOP=1 < WRAP_BOTTOM=31 — the
// hardware-reset window (EXECCTRL_RESET) wraps the memory edge, its loop
// running rows 31→0→1. The arc's height formula only understood
// WRAP_BOTTOM ≤ WRAP_TOP, so the reset window drew as a zero-height
// sliver pinned at row 31 while its WRAP_TOP steppers sat at row 1 — on
// the reference 13" listing the pair and the sliver can never share the
// screen (596px apart in a ~560px viewport), and wrap-top inc (the
// stretch gesture at the only visible end) can never gain extent:
// WRAP_TOP cannot pass WRAP_BOTTOM=31. The pins: the window draws with
// real extent (its 3 reset rows), a bracket is on-screen beside the
// visible steppers without scrolling, the stretch gesture — the same
// controlEdit write a click rides — grows the drawn window, and all
// four steppers stay inside the listing's scrollable extent.
const WRAP_RESET_SCAN = `(() => {
  const reset = () => {
    Object.assign(curState.sms[0].execctrl, { wrapTop: 1, wrapBot: 31 });
    OV = overlayOf(0);
    buildProgram();
  };
  reset();
  const host = document.querySelector('#progrows');
  const hb = host.getBoundingClientRect();
  const segs = () =>
    [...host.querySelectorAll('.wraparc, #wraparc')].map((s) => s.getBoundingClientRect());
  const extent = (rs) => rs.reduce((t, r) => t + r.height, 0);
  const bad = [];
  const px = extent(segs());
  if (px < 20)
    bad.push(
      'reset wrap window draws ' + px.toFixed(1) + 'px of bracket — the 31→0→1 window (3 rows) has no extent (the height formula only knew WRAP_BOTTOM ≤ WRAP_TOP)',
    );
  if (!segs().some((r) => r.bottom > hb.top && r.top < hb.bottom))
    bad.push(
      'no wrap bracket in the listing viewport — the reset window drew only below the fold, so its visible steppers point at nothing and no gesture there can stretch it',
    );
  // the stretch gesture, applied the way sendCtl applies it
  for (const [g, f, v] of VD.controlEdit(OV, 'wrap-top', 'inc'))
    curState.sms[0][g][f] = v;
  OV = overlayOf(0);
  buildProgram();
  const px2 = extent(segs());
  if (px2 <= px)
    bad.push(
      'wrap-top inc did not stretch the drawn window (' +
        px.toFixed(1) + 'px → ' + px2.toFixed(1) + 'px) — from 1/31 the visible end can never pass WRAP_BOTTOM',
    );
  reset();
  const steps = [...host.querySelectorAll('.wstep')];
  if (steps.length !== 4) bad.push('expected 4 wrap steppers, found ' + steps.length);
  const name = (b) => b.dataset.ctl + '/' + b.dataset.g;
  const rects = steps.map((b) => b.getBoundingClientRect());
  const origin = host.scrollHeight + hb.top;
  for (const [i, r] of rects.entries()) {
    if (r.top < hb.top - 0.5)
      bad.push(
        'stepper ' + name(steps[i]) + ' clipped above the listing scroll origin (' +
        (r.top - hb.top).toFixed(1) + 'px) — unreachable in a scroll container',
      );
    if (r.bottom > origin + 0.5)
      bad.push(
        'stepper ' + name(steps[i]) + ' beyond the listing content end (' +
        (r.bottom - origin).toFixed(1) + 'px past the last row) — unreachable in a scroll container',
      );
  }
  for (let i = 1; i < rects.length; i++)
    for (let j = 0; j < i; j++) {
      const a = rects[i], b = rects[j];
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
        bad.push('steppers ' + name(steps[j]) + ' and ' + name(steps[i]) + ' overlap');
    }
  return bad;
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`wrap reset 1/31: the window draws, shows, and stretches ${width}×${height}`, async () => {
    await load(null, width, height);
    const bad = await page.evaluate(WRAP_RESET_SCAN);
    assert.deepStrictEqual(
      bad,
      [],
      `broken reset-posture wrap window at ${width}×${height} (wrap-top inc must stretch the drawn window)`,
    );
  });
}

// C27: the pin strip draws the mapping. The three cyan-family lanes
// under each pin number carry the selected SM's OUT / SIDESET / IN
// extents (SPEC-7-26/21), so a base/count stepper click shows where the
// wiring moved with no program running. The pins: every cell carries the
// three-lane band between its number and its level at the fixed lane
// metrics, the filled lanes match the overlay exactly (overlap scenario:
// OUT 0·3, SIDESET 2·2, IN 1·4 — OUT∩SIDESET on 2, OUT∩IN on 1..2), and
// one side-base stepper gesture — applied the way sendCtl applies it —
// moves the SIDESET mark the same clk. The drawn state is reached the
// way the sandbox reaches it: overlay fields, then the render (the same
// path a real stepper write takes).
const PINMAP_SCAN = `(() => {
  const bad = [];
  const author = (pinctrl, shift) => {
    Object.assign(curState.sms[0].pinctrl, pinctrl);
    if (shift) Object.assign(curState.sms[0].shiftctrl, shift);
    OV = overlayOf(0);
    render(V.state);
  };
  author({ outBase: 0, outCnt: 3, ssBase: 2, ssCnt: 2, setCnt: 0, inBase: 1 }, { inCount: 4 });
  const exp = { out: new Set([0, 1, 2]), side: new Set([2, 3]), in: new Set([1, 2, 3, 4]) };
  const filled = (el) => getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)';
  const cells = [...document.querySelectorAll('#pincells .pcell')];
  if (cells.length !== 32) bad.push('expected 32 pin cells, found ' + cells.length);
  for (const c of cells) {
    const p = +c.dataset.pin;
    const band = c.querySelector('.pmap');
    if (!band) {
      bad.push('pin ' + p + ' has no wiring band');
      continue;
    }
    const lanes = [...band.querySelectorAll('i')];
    if (lanes.length !== 3) {
      bad.push('pin ' + p + ' band has ' + lanes.length + ' lanes, expected 3 (out/side/in)');
      continue;
    }
    const nb = c.querySelector('.pn').getBoundingClientRect();
    const lb = c.querySelector('.pl').getBoundingClientRect();
    const bb = band.getBoundingClientRect();
    if (bb.top < nb.bottom - 0.5 || bb.bottom > lb.top + 0.5)
      bad.push('pin ' + p + ': the wiring band is not under the pin number');
    if (bb.width < 24)
      bad.push('pin ' + p + ': wiring band only ' + bb.width.toFixed(1) + 'px wide');
    const rects = lanes.map((l) => l.getBoundingClientRect());
    const laneKinds = ['out', 'side', 'in']; // DOM order: the mo/ms/mi lanes
    for (const [k, name] of laneKinds.entries()) {
      const r = rects[k];
      if (Math.abs(r.height - 2) > 0.5)
        bad.push('pin ' + p + ': the ' + name + ' lane is ' + r.height.toFixed(1) + 'px tall (fixed 2px)');
      if (filled(lanes[k]) !== exp[name].has(p))
        bad.push(
          'pin ' + p + ': the ' + name + ' lane is ' +
          (filled(lanes[k]) ? 'drawn' : 'missing') +
          ' — the marks do not match the overlay',
        );
    }
    if (!(rects[0].bottom <= rects[1].top + 0.5 && rects[1].bottom <= rects[2].top + 0.5))
      bad.push('pin ' + p + ': lanes collide — the three kinds must stack, not overlap');
  }
  for (const [g, f, v] of VD.controlEdit(OV, 'side-base', 'inc'))
    curState.sms[0][g][f] = v;
  OV = overlayOf(0);
  render(V.state);
  const sideNow = (p) => filled(document.querySelectorAll('#pc' + p + ' .pmap i')[1]);
  if (sideNow(2) || !sideNow(3) || !sideNow(4))
    bad.push(
      'side-base inc (2 to 3) did not move the SIDESET mark — the strip is drawing a stale overlay',
    );
  return bad;
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`pin strip draws the wiring marks ${width}×${height}: lanes + the stepper move`, async () => {
    await load(null, width, height);
    const bad = await page.evaluate(PINMAP_SCAN);
    assert.deepStrictEqual(
      bad,
      [],
      `broken wiring marks at ${width}×${height} (a base stepper click must show where the wiring moved)`,
    );
  });
}

// C27: live vs stale. A pad the owner's current wiring still reaches is
// actively driven (amber); a pad whose wiring has moved away holds its
// last level and must stop reading as currently driven — the stale
// class, the gray ring and the gray ▲. The scenario is the mid-run
// side-base move from the gpio0-panel review: pin 0 in-mapping, pin 1
// moved-from, both OE with the same owner.
const STALE_SCAN = `(() => {
  const bad = [];
  const owners = new Array(32).fill(-1);
  owners[0] = 0;
  owners[1] = 0;
  render(Object.assign({}, V.state, { gpioOe: 0b11, gpioOut: 0b11, owners, stale: 0b10 }));
  const live = document.querySelector('#pc0');
  const was = document.querySelector('#pc1');
  if (!live || !was) return ['the pin cells went missing'];
  if (live.classList.contains('stale'))
    bad.push('the live pad (in the owner wiring) carries the stale class');
  if (!was.classList.contains('stale'))
    bad.push('the was-driven pad never got the stale class — the moved-from pin still reads as driven');
  if (!was.classList.contains('oe') || !live.classList.contains('oe'))
    bad.push('the OE truth was lost rendering the distinction');
  if (getComputedStyle(was.querySelector('.pm')).color === getComputedStyle(live.querySelector('.pm')).color)
    bad.push('the was-driven pad keeps the live mark color — a hold must read gray, not driven');
  if (!was.dataset.tip.includes('wiring has moved away'))
    bad.push('the was-driven pad does not narrate the move (the tooltip keeps the driven story)');
  return bad;
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`was-driven pads read stale, live pads read driven ${width}×${height}`, async () => {
    await load(null, width, height);
    const bad = await page.evaluate(STALE_SCAN);
    assert.deepStrictEqual(
      bad,
      [],
      `broken live-vs-stale distinction at ${width}×${height} (the moved-from pin must stop reading as currently driven)`,
    );
  });
}

// C27 follow-up (the owner's two reports from the live session): a drive
// latch click grew the whole strip — the empty mark row (.pm) had no line
// box, so the first ▲/D/◆ anywhere stretched EVERY cell (measured: a
// cell went 35px to 51px) and the strip jumped under the pointer. The
// marks ride the level line instead, whose 16px line box always exists:
// appearing marks must not move a single cell box, and the strip must
// hold its height — state changes are not allowed to re-flow the chrome
// (the C26 hover/press rule, now for drive state).
test('drive marks never reflow the strip: ▲/D/◆ ride the level line', async () => {
  await load(null, 1280, 800);
  const boxes = `(() => {
    const strip = document.querySelector('#pinstrip').getBoundingClientRect();
    const cells = [...document.querySelectorAll('#pincells .pcell')].map((c) => {
      const b = c.getBoundingClientRect();
      return [c.dataset.pin, +b.left.toFixed(1), +b.top.toFixed(1), +b.width.toFixed(1), +b.height.toFixed(1)];
    });
    return { strip: +strip.height.toFixed(1), cells };
  })()`;
  const before = await page.evaluate(boxes);
  const drives = new Array(32).fill(null);
  drives[31] = 1; // a held latch on a bare cell — the D mark appears
  await page.evaluate(`render(Object.assign({}, V.state, { drives: ${JSON.stringify(drives)} }))`);
  const afterD = await page.evaluate(boxes);
  assert.deepStrictEqual(
    afterD,
    before,
    'a drive latch (the D mark) re-flowed the pin strip — the mark row must not change any cell box',
  );
  await page.evaluate(`render(Object.assign({}, V.state, { gpioOe: 1 << 31, gpioOut: 1 << 31 }))`);
  const afterOE = await page.evaluate(boxes);
  assert.deepStrictEqual(
    afterOE,
    before,
    'the engine-output mark (▲) re-flowed the pin strip — the mark row must not change any cell box',
  );
});

// The program column is content-anchored: the widest in-flow resident is
// the row editor (measured 364px); the old 32vw track gave it 461px at
// 1440 — dead width the wave never saw. The pins: the column lands
// within the editor's need + scrollbar slack, and the editor row itself
// is never squeezed (its content fits its box — the honesty rule).
test('the program column is content-anchored: editor fits, no dead width', async () => {
  await load(null, 1280, 800);
  const m = await page.evaluate(`(() => {
    openRow(1); // the editor overlays the listing (left 78 / right 8 anchors)
    const prog = document.getElementById('program').getBoundingClientRect().width;
    const listing = document.getElementById('progrows').clientWidth;
    const ed = document.getElementById('rowedit').getBoundingClientRect();
    const reins = document.querySelector('#rowedit .reins');
    return { prog: +prog.toFixed(1), listing, edW: +ed.width.toFixed(1),
             reinsW: +reins.getBoundingClientRect().width.toFixed(1) };
  })()`);
  assert.ok(m.edW > 0, 'the row editor row is not on the page (open a row first)');
  assert.strictEqual(
    Math.round(m.edW),
    m.listing - 86,
    'the editor is not anchored to the listing box (left 78 / right 8)',
  );
  assert(
    m.reinsW >= 148,
    `the instruction cell is squeezed to ${m.reinsW}px — the widest canonical rows (out pindirs, 31 ≈ 128px) still need typing room (floor 148)`,
  );
  assert(
    m.prog >= 362 && m.prog <= 394,
    `program column is not content-anchored at 1280: ${m.prog}px — the widest in-flow residents need ~364px; anything beyond is dead width the wave never sees`,
  );
});

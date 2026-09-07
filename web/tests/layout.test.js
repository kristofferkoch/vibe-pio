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
//   * state swaps never move boxes (C33): brun's RUN/PAUSE toggle and
//     bcopy's ✓ flash used to assign textContent — the auto-width
//     buttons re-flowed the .ctrl bar on every swap and the <u>
//     mnemonics were wiped for good. Both are two-label grid stacks
//     now: the box holds its possible max text and the underline
//     survives every state.
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

// C33: state swaps never move boxes. brun ('▶ RUN' ↔ '❚❚ PAUSE') is an
// auto-width flex child of the header .ctrl bar, so every run/pause
// toggle re-flowed the bar — the speed select and CYCLE/INSN shifted
// under the pointer — and bcopy's ✓ flash did the same to everything
// after it. Both swaps assigned textContent, which also permanently
// wiped the <u> mnemonic markup: bcopy lost its L after the first copy,
// brun its R for as long as it read PAUSE (the Alt keys themselves kept
// working; only the visible indicator died). The pins: every header
// box identical across run()/pause() and across the copy flash (the
// never-reflow rule, now for label state instead of hover/press), and
// every MNEMONICS button still underlining a letter that is its own Alt
// key in every state — the swap may hide a label, never the markup.
const HDR_BOXES = `[...document.querySelectorAll('header button, header select, header .ctrl')].map((e) => {
  const b = e.getBoundingClientRect();
  return [e.id || e.tagName + '.' + e.className, +b.left.toFixed(1), +b.top.toFixed(1), +b.width.toFixed(1), +b.height.toFixed(1)];
})`;
const MNEM_SCAN = `(() => {
  const bad = [];
  for (const [k, id] of Object.entries(MNEMONICS)) {
    const btn = document.getElementById(id);
    const us = [...btn.querySelectorAll('u')].filter((u) => getComputedStyle(u).visibility !== 'hidden');
    if (!us.length) {
      bad.push(id + ' shows no mnemonic underline in this state');
      continue;
    }
    for (const u of us) {
      if (MNEMONICS[u.textContent.trim().toLowerCase()] !== id)
        bad.push(id + ' underlines ' + u.textContent + ' — a letter that is not its Alt key');
    }
  }
  return bad;
})()`;

test('state swaps never reflow: run/pause and the copy flash keep their boxes', async () => {
  await load(null, 1280, 800);
  // run() needs the engine-ready flag the hermetic page never gets —
  // raise it by hand; the transport posts go unanswered (the worker is
  // parked in importScripts), which is exactly the silence run/pause
  // manage. The copy flash needs a clipboard that resolves.
  await page.evaluate('V.ready = true');
  await page.evaluate(
    "Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() } })",
  );
  const idle = await page.evaluate(HDR_BOXES);
  const mnemIdle = await page.evaluate(MNEM_SCAN);
  await page.evaluate('run()');
  assert.deepStrictEqual(
    await page.evaluate(HDR_BOXES),
    idle,
    'the run/pause toggle re-flowed the header — brun must be sized to its possible max text, not its current label',
  );
  assert.deepStrictEqual(
    await page.evaluate(MNEM_SCAN),
    mnemIdle,
    'the PAUSE face lost the mnemonic underline — the swap hides a label, never the markup',
  );
  await page.evaluate('pause()');
  assert.deepStrictEqual(await page.evaluate(HDR_BOXES), idle, 'pausing re-flowed the header');
  assert.deepStrictEqual(
    await page.evaluate(MNEM_SCAN),
    mnemIdle,
    'the RUN face lost its mnemonic underline on the way back — the textContent wipe is permanent',
  );
  await page.evaluate("$('bcopy').click()");
  await new Promise((r) => setTimeout(r, 150));
  assert.deepStrictEqual(
    await page.evaluate(HDR_BOXES),
    idle,
    'the copy flash (✓ LISTING) re-flowed the header — same rule, same fix: the possible max text',
  );
  assert.deepStrictEqual(
    await page.evaluate(MNEM_SCAN),
    mnemIdle,
    'the copy flash wiped the L underline — Alt+L keeps working with no indicator',
  );
  // the flash settles back on its own (setTimeout 900): the box and the
  // underline must survive the round trip
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepStrictEqual(await page.evaluate(HDR_BOXES), idle, 'the flash did not settle back');
  assert.deepStrictEqual(
    await page.evaluate(MNEM_SCAN),
    mnemIdle,
    'the flash round trip left bcopy with no mnemonic underline',
  );
});

// The owner's live-session report: the machines-bar cell ("SM0 02 EXEC")
// changed size whenever a running machine's phase swapped, and the bar
// re-flowed on every rendered clk. The phase chip is auto-width past its
// old 34px min (measured border-box: EXEC 37px, DELAY 45px, STALL 42px,
// OFF 34px), the cells sit left-anchored in the flex row, and four
// machines flip phases independently — EXEC↔DELAY is the default rhythm
// of a running program. The exec pane's phase row moves with it: the
// name is auto-width (EXEC 33px, "DELAY 31" 59px) and the group is
// right-anchored, so the sub text — which re-writes every delay tick —
// dragged the progress bar along. The C33 max-label rule, for live
// phase text: every box (cells, chips, the bar's own, name, progress
// bar, sub) is identical across all four phases, across the running
// mix, and across the delay countdown's digit changes.
const PHASE_BOXES = `(() => {
  const box = (e) => {
    const b = e.getBoundingClientRect();
    return [+b.left.toFixed(1), +b.top.toFixed(1), +b.width.toFixed(1), +b.height.toFixed(1)];
  };
  const bar = document.querySelector('#smscells');
  return {
    bar: box(bar),
    cells: [...bar.querySelectorAll('.smcell')].map(box),
    chips: [...bar.querySelectorAll('.smph')].map(box),
    name: box(document.getElementById('phasename')),
    pbar: box(document.getElementById('phasebar')),
    sub: box(document.getElementById('phasesub')),
  };
})()`;

test('phase swaps never reflow: the machines bar and the exec phase row hold their boxes', async () => {
  await load(null, 1280, 800);
  // phases: the four chips' phases; phase/delay: the selected SM's face
  // (the exec row follows it)
  const posture = async (phases, phase, delay) => {
    await page.evaluate(
      `render(Object.assign({}, V.state, {
        phase: ${JSON.stringify(phase)}, delay: ${delay},
        sms: ${JSON.stringify(phases)}.map((ph) => ({ displayPc: 2, phase: ph })),
      }))`,
    );
    return page.evaluate(PHASE_BOXES);
  };
  const base = await posture(['EXEC', 'EXEC', 'EXEC', 'EXEC'], 'EXEC', 0);
  assert.strictEqual(base.cells.length, 4, 'the machines bar lost its four cells');
  for (const [name, phases, phase, delay] of [
    ['all DELAY', ['DELAY', 'DELAY', 'DELAY', 'DELAY'], 'DELAY', 5],
    ['all STALL', ['STALL', 'STALL', 'STALL', 'STALL'], 'STALL', 0],
    ['all OFF', ['OFF', 'OFF', 'OFF', 'OFF'], 'OFF', 0],
    ['the running mix', ['EXEC', 'DELAY', 'STALL', 'OFF'], 'DELAY', 31],
    ['the delay countdown tick', ['DELAY', 'DELAY', 'DELAY', 'DELAY'], 'DELAY', 1],
  ]) {
    assert.deepStrictEqual(
      await posture(phases, phase, delay),
      base,
      `the ${name} posture re-flowed the machines bar or the exec phase row — every phase face holds its possible max label (C33), never its current one`,
    );
  }
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

// the arc's steppers say ▲/▼, and the glyph must point the way that
// stepper's write moves its end DOWN THE LISTING — row numbers grow
// downward, so inc (a later row) slides an end down wherever the pair
// sits, dec slides it up. The first cut tied ▲ to inc at both ends,
// which inverts all four arrows on screen. The pin is behavioral, not
// textual: each button's write is applied exactly the way sendCtl
// applies it, the bracket edge the pair hugs is measured before and
// after (pixels, not the inc/dec name — the mapping is what's under
// test), and the glyph must match the measured motion. The 5/2 posture
// keeps every one of the four gestures a plain single-bracket slide.
// Also pinned: each pair reads [▲][▼] (up on the left) — the drawn
// order the CSS comment documents.
const WRAP_ARROW_SCAN = `(() => {
  const set52 = () => {
    Object.assign(curState.sms[0].execctrl, { wrapTop: 5, wrapBot: 2 });
    OV = overlayOf(0);
    buildProgram();
  };
  set52();
  const bad = [];
  const segs = () =>
    [...document.querySelectorAll('#progrows .wraparc')].map((s) => s.getBoundingClientRect());
  const steps = [...document.querySelectorAll('#progrows .wstep')];
  if (steps.length !== 4) return ['expected 4 wrap steppers, found ' + steps.length];
  for (const b of steps) {
    set52();
    const ctl = b.dataset.ctl,
      g = b.dataset.g;
    const before = segs();
    if (before.length !== 1) return ['expected one wrap bracket at 5/2, found ' + before.length];
    // the edge the pair hugs: WRAP_TOP the after-insn end (bracket
    // bottom — rows grow downward), WRAP_BOTTOM the return row (top)
    const edge0 = ctl === 'wrap-top' ? before[0].bottom : before[0].top;
    for (const [grp, fld, v] of VD.controlEdit(OV, ctl, g)) curState.sms[0][grp][fld] = v;
    OV = overlayOf(0);
    buildProgram();
    const after = segs();
    if (after.length !== 1)
      return [ctl + '/' + g + ' left the single-bracket posture — pick a 5/2-safe gesture'];
    const dy = (ctl === 'wrap-top' ? after[0].bottom : after[0].top) - edge0;
    const want = dy > 0 ? '▼' : dy < 0 ? '▲' : '';
    if (b.textContent !== want)
      bad.push(
        ctl + '/' + g + ' is ' + b.textContent + ' but its write moves the end ' +
          (dy > 0 ? 'down' : 'up') + ' the listing (' + dy.toFixed(0) + 'px) — the glyph must point the way the end moves',
      );
  }
  set52();
  for (const box of document.querySelectorAll('#progrows .wspin')) {
    const glyphs = [...box.querySelectorAll('.wstep')].map((x) => x.textContent).join('');
    if (glyphs !== '▲▼')
      bad.push('a wrap pair reads [' + glyphs.split('').join('][') + '] — both pairs read [▲][▼] (up on the left)');
  }
  return bad;
})()`;

test('wrap arc steppers: every ▲/▼ points the way its write moves the end', async () => {
  await load(null, 1280, 800);
  const bad = await page.evaluate(WRAP_ARROW_SCAN);
  assert.deepStrictEqual(
    bad,
    [],
    'wrap stepper arrows point the wrong way (rows grow downward: inc slides an end down, dec up — at both ends)',
  );
});

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

// C29: the row says what it means. The wave-header tags name base·count
// on the face — one letter each, `out b0·c32` — so the two numbers per
// tag stop being hover-only, and the side count's dash is annotated
// in-face (c—ds: no side-set allocated, all five ds bits are delay, the
// split owned by the program panel's pips) so it stops reading as a
// broken stepper pair. The pins: the letters are on the face in every
// posture (boot — the dash posture is the shipped default — the
// allocated side-count forms, and the widest face the steppers can
// reach, b31·c32), the tooltips and status narrations use the same
// letters, and the row still fits on one line at the 13" widths after
// the label growth — .ptitle wraps when the tags stop fitting, and a
// wrapped header row costs the wave a second line.
const WAVE_ROW_SCAN = `(() => {
  const bad = [];
  const author = (pc, sideEn) => {
    Object.assign(curState.sms[0].pinctrl, {
      outBase: 0, outCnt: 0, ssBase: 0, ssCnt: 0, setCnt: 5, inBase: 0,
    });
    Object.assign(curState.sms[0].shiftctrl, { inCount: 0 });
    Object.assign(curState.sms[0].execctrl, { sideEn: sideEn === true });
    if (pc) Object.assign(curState.sms[0].pinctrl, pc);
    OV = overlayOf(0);
    buildProgram();
    render(V.state);
  };
  const reads = (id) => document.getElementById(id).textContent.trim();
  const isNamed = (id, letter) => {
    const t = reads(id);
    const n = t.slice(1);
    return t[0] === letter && n !== '' && !Number.isNaN(+n) && +n >= 0;
  };
  const row = document.querySelector('.wavetitle');
  const oneLine = (where) => {
    const h = row.getBoundingClientRect().height;
    if (h > 26)
      bad.push(
        where + ': the wave title row wrapped to ' + h.toFixed(1) +
        'px (one line is ~25px) — the named tags must still fit the 13" row',
      );
    if (row.scrollWidth > row.clientWidth + 1)
      bad.push(where + ': the wave title row overflows horizontally');
  };
  const checkFace = (where) => {
    for (const [id, letter] of [
      ['outbase', 'b'], ['outcnt', 'c'], ['sidebase', 'b'], ['inbase', 'b'], ['incnt', 'c'],
    ])
      if (!isNamed(id, letter))
        bad.push(where + ': #' + id + ' reads "' + reads(id) + '" — the face must name it (' + letter + '<N>)');
    return reads('sidecnt');
  };
  // boot: the dash posture is the shipped default view
  author();
  let side = checkFace('boot');
  if (side !== 'c—ds')
    bad.push('boot: #sidecnt reads "' + side + '" (want c—ds — the dash annotated in-face: no side-set, the ds bits are delay)');
  oneLine('boot');
  // the allocated side count names itself; only the none posture dashes
  author({ ssCnt: 2 });
  side = checkFace('side 2b');
  if (side !== 'c2') bad.push('side ssCnt=2: #sidecnt reads "' + side + '" (want c2)');
  author({ ssCnt: 2 }, true);
  side = checkFace('side 1b+opt');
  if (side !== 'c1+opt') bad.push('side ssCnt=2+opt: #sidecnt reads "' + side + '" (want c1+opt)');
  oneLine('side allocated');
  // the widest face the steppers can reach (b31·c32 everywhere, the dash
  // posture) must still fit the 13" row
  author({ outBase: 31, ssBase: 31, inBase: 31 });
  checkFace('widest');
  oneLine('widest');
  // the tooltips quote the letters; the status narrations name theirs
  const tags = [...document.querySelectorAll('.wavetitle .maptag')];
  const tip = (i, needle, what) => {
    if (!tags[i] || !tags[i].dataset.tip.includes(needle))
      bad.push('the ' + what + ' tag tooltip does not say "' + needle + '" — the letters must be named where they are drawn');
  };
  tip(0, 'b = OUT_BASE', 'out');
  tip(0, 'c = OUT_COUNT', 'out');
  tip(1, 'b = SIDESET_BASE', 'side');
  tip(1, 'c—ds', 'side');
  tip(2, 'b = IN_BASE', 'in');
  tip(2, 'c = IN_COUNT', 'in');
  for (const [id, letter] of [
    ['spin-outbase', 'b'], ['spin-outcnt', 'c'], ['spin-sidebase', 'b'],
    ['spin-inbase', 'b'], ['spin-incnt', 'c'],
  ])
    if (!(document.getElementById(id).dataset.status || '').startsWith(letter + ':'))
      bad.push('#' + id + ' status narration does not name its number (' + letter + ': …)');
  return bad;
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`the wave row says what it means ${width}×${height}: named base·count on one line`, async () => {
    await load(null, width, height);
    const bad = await page.evaluate(WAVE_ROW_SCAN);
    assert.deepStrictEqual(
      bad,
      [],
      `unnamed wave-row numbers at ${width}×${height} (base·count must be on the face, the side dash annotated, one line at 13")`,
    );
  });
}

// C30: the cursor marks leave the address cell. C24's four per-SM PC
// marks rendered inline in the 30px address cell, and the boot posture
// parks all four SMs at PC 0 — row 00's gutter read "0123 00", the
// cluster overflowed the cell (measured live: scrollWidth 36 vs
// clientWidth 30) and spilled into the margin lane. The marks now live
// in the row's left margin as one boxed chip riding the pin-ownership
// chip grammar: the address digits render clean, and the chip's slot is
// bounded by the margin's other tenants — the wrap bracket, the wrap
// steppers, the selected machine's .cur bar. The posture is the shipped
// boot (newState): all four SMs at PC 00, WRAP 1/31 — bracket rows 0–1,
// steppers rows 1 and 31, so a chip that escapes its row's band hits a
// stepper and the check names it.
const SMCUR_SCAN = `(() => {
  const bad = [];
  render(Object.assign({}, V.state, {
    displayPc: 0,
    sms: [0, 1, 2, 3].map(() => ({ displayPc: 0, phase: 'EXEC' })),
  }));
  const row = document.querySelector('#pr0');
  const addr = row.querySelector('.addr');
  const chip = row.querySelector('.smcur');
  if (!chip || chip.children.length !== 4)
    bad.push(
      'expected the four per-SM marks on row 00, found ' + (chip ? chip.children.length : 'no cluster'),
    );
  if (addr.querySelector('.smcur, .smk'))
    bad.push('the mark cluster still renders inside the address cell — the digits must render clean');
  if (addr.scrollWidth > addr.clientWidth + 1)
    bad.push(
      'the address cell overflows: content ' + addr.scrollWidth + 'px in a ' + addr.clientWidth +
      'px box — the boot posture (all four SMs at PC 0) parks the mark cluster in the 30px cell',
    );
  if (chip) {
    const cb = chip.getBoundingClientRect();
    const ab = addr.getBoundingClientRect();
    if (cb.left < ab.right && ab.left < cb.right && cb.top < ab.bottom && ab.top < cb.bottom)
      bad.push('the mark chip intersects the address digits');
    const rb = row.getBoundingClientRect();
    if (cb.top < rb.top - 0.5 || cb.bottom > rb.bottom + 0.5)
      bad.push(
        'the mark chip escapes its row band (' +
          (cb.top - rb.top).toFixed(1) + '..' + (cb.bottom - rb.bottom).toFixed(1) +
        'px) — it would collide with the tenants of neighboring rows',
      );
    const tenants = [
      ...[...document.querySelectorAll('.wraparc')].map((e, i) => ['wrap bracket ' + i, e.getBoundingClientRect()]),
      ...[...document.querySelectorAll('.wstep')].map((e) => [
        'wrap stepper ' + e.dataset.ctl + '/' + e.dataset.g,
        e.getBoundingClientRect(),
      ]),
    ];
    const cs = getComputedStyle(row, '::before'); // the .cur bar is a pseudo
    if (cs.content !== 'none') {
      const l = parseFloat(cs.left), t = parseFloat(cs.top);
      tenants.push([
        'cur bar',
        { left: rb.left + l, right: rb.left + l + parseFloat(cs.width),
          top: rb.top + t, bottom: rb.top + t + parseFloat(cs.height) },
      ]);
    }
    for (const [name, b] of tenants)
      if (cb.left < b.right && b.left < cb.right && cb.top < b.bottom && b.top < cb.bottom)
        bad.push('the mark chip collides with the ' + name);
  }
  return bad;
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`the cursor marks leave the address cell ${width}×${height}: clean digits, chip clear of the margin`, async () => {
    await load(null, width, height);
    const bad = await page.evaluate(SMCUR_SCAN);
    assert.deepStrictEqual(
      bad,
      [],
      `address gutter broken at ${width}×${height} (boot: all four cursors on row 00 — the digits render clean, the chip clears the margin's tenants)`,
    );
  });
}

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

// C34 — the reduced-geometry leg: the level page (sm-view.html?level=l0)
// is the sandbox MINUS what the level hasn't taught, and panel gating is
// ABSENCE, never ghosted placeholders: every locked panel leaves layout
// entirely (no box, no hit surface), the listing keeps all 32 rows in
// the narrow column (row-count honesty), and the level band under the
// toolbar fits its two rows without wrapping. The pinned boxes are the
// L0 page's own geometry — C35's delay-column unlock must never move
// what is already on screen here.
const L0_ABSENT = [
  '#clkdivtag',
  '#bempty',
  '#bdemo',
  '#bexport',
  '#bimport',
  '#bcopy',
  '#speed',
  '#binsn',
  '#smsbar',
  '#pinstrip',
  '#regs',
  '#dsalloc',
  '#progfoot',
  '#exectitle',
  '#execslim',
  '#isr',
  '#fiforow',
  '#pullconn',
  '#osr',
  '#framemap',
  '.maptag',
  '#wavewinaux',
  '#spin-lenspin',
  '#mon',
  '#feed',
  '#pattern',
];
const L0_SCAN = `(() => {
  const bad = [];
  const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
  const gone = (sel) => {
    const el = document.querySelector(sel);
    return !el || el.offsetParent === null;
  };
  for (const sel of ${JSON.stringify(L0_ABSENT)}) {
    if (document.querySelectorAll(sel).length && !gone(sel))
      bad.push(sel + ' is still laid out — a locked panel is absence, not a ghost');
  }
  // present with real geometry: the band, the pinned transport, the listing
  const band = box('#lvband');
  if (!band || band.height < 20) bad.push('the level band has no box');
  const head = document.getElementById('lvhead');
  if (head && head.scrollHeight > head.clientHeight + 1)
    bad.push('the band head wraps (scrollHeight ' + head.scrollHeight + ' in ' + head.clientHeight + ')');
  const pred = document.getElementById('lvpred');
  if (pred && pred.scrollHeight > pred.clientHeight + 1)
    bad.push('the predict row wraps (scrollHeight ' + pred.scrollHeight + ' in ' + pred.clientHeight + ')');
  if (document.querySelectorAll('#progrows .prow').length !== 32)
    bad.push('the listing lost rows — 32 rows in every level (row-count honesty)');
  if (document.querySelectorAll('#progrows .prow .cdly:not([style*="display: none"])').length &&
      !gone('#progrows .prow .cdly'))
    bad.push('the delay column is visible — L0 has not taught delay');
  if (document.querySelectorAll('.wstep').length)
    bad.push('the wrap steppers are built — L0 asks the wrap question, it does not edit EXECCTRL');
  const wave = box('#wavesvg');
  if (!wave || wave.height < 64) bad.push('the wave lost its 64px floor');
  if (!wave || wave.width < 420) bad.push('the wave is squeezed under 420px');
  const pin = (sel) => {
    const b = box(sel);
    return b && [b.left, b.top, b.width, b.height].map((v) => Math.round(v));
  };
  return {
    bad,
    boxes: {
      lvband: pin('#lvband'), program: pin('#program'), wavesvg: pin('#wavesvg'),
      progrows: pin('#progrows'), brun: pin('#brun'), breset: pin('#breset'),
      lvcands: pin('#lvcands'), titlebar: pin('#titlebar'), header: pin('header'),
    },
  };
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`the L0 page is its own geometry: absence, the band, the honest listing ${width}×${height}`, async () => {
    await page.setViewport(width, height);
    await page.goto(`${pageUrl()}?level=l0`);
    await page.evaluate('document.fonts.ready.then(() => {})');
    await page.evaluate("document.getElementById('boot')?.remove()");
    const { bad, boxes } = await page.evaluate(L0_SCAN);
    assert.deepStrictEqual(
      bad,
      [],
      `L0 geometry broken at ${width}×${height} — panel gating is absence (layout AND Tab order)`,
    );
    // L0's page pinned: the band/transport/listing/wave boxes at the two
    // 13" reference viewports are the baseline a later unlock (C35's delay
    // column) must hold — "never moves what's already on screen"
    assert.ok(
      boxes.lvband && boxes.lvband[3] >= 40 && boxes.lvband[3] <= 90,
      `the band left its two-row box at ${width}×${height}: ${JSON.stringify(boxes.lvband)}`,
    );
    assert.ok(
      boxes.wavesvg && boxes.wavesvg[2] > 600,
      `the wave is not the level page's center of gravity at ${width}×${height}`,
    );
    // the honest listing: all 32 rows exist (the DOM check above) and the
    // listing runs to the program panel's floor — the rest scrolls inside
    const prog = await page.evaluate(`(() => {
      const p = document.querySelector('#program').getBoundingClientRect();
      const r = document.querySelector('#progrows').getBoundingClientRect();
      return { floorGap: +(p.bottom - r.bottom).toFixed(1), h: Math.round(r.height) };
    })()`);
    assert.ok(
      prog.floorGap <= 1.5 && prog.h > 450,
      `the listing must fill the program column at ${width}×${height} (${prog.h}px, ${prog.floorGap}px above the floor)`,
    );
  });
}

// C35 — the delay-column unlock: the L1 page is the L0 page plus one
// 38px track inside the listing's grid. The C34 comment above made this
// the recorded discipline: the unlock must never move what is already on
// screen — the program column is clamp-fixed by the level grid, so the
// track comes out of the instruction cell, and every pinned box (band,
// transport, program, wave, title) stays bit-identical to the L0 page's.
// The delay-cell editor (L1's one-cell modification surface) is absent
// from layout at rest and, once open, sits exactly over the row's delay
// track.
const L1_SCAN = `(() => {
  const bad = [];
  const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
  const gone = (sel) => {
    const el = document.querySelector(sel);
    return !el || el.offsetParent === null;
  };
  for (const sel of ${JSON.stringify(L0_ABSENT)}) {
    if (document.querySelectorAll(sel).length && !gone(sel))
      bad.push(sel + ' is still laid out — a locked panel is absence, not a ghost');
  }
  const band = box('#lvband');
  if (!band || band.height < 20) bad.push('the level band has no box');
  if (document.querySelectorAll('#progrows .prow').length !== 32)
    bad.push('the listing lost rows — 32 rows in every level (row-count honesty)');
  if (document.querySelectorAll('.wstep').length)
    bad.push('the wrap steppers are built — L1 asks for timing, not EXECCTRL edits');
  // the delay column is PRESENT this time: the taught cell has a box, the
  // header names it, and the editor overlay is out of layout at rest
  const cdly = document.querySelector('#pr0 .cdly');
  if (!cdly || cdly.offsetParent === null || cdly.getBoundingClientRect().width < 4)
    bad.push('the delay column is missing — L1 taught it');
  const head = document.querySelectorAll('#program .phead > span')[3];
  if (!head || head.offsetParent === null) bad.push('the delay header is missing');
  const de = document.getElementById('dlyedit');
  if (!de) bad.push('the delay-cell editor does not exist');
  else if (de.offsetParent !== null) bad.push('the delay-cell editor is laid out at rest');
  const wave = box('#wavesvg');
  if (!wave || wave.height < 64) bad.push('the wave lost its 64px floor');
  if (!wave || wave.width < 420) bad.push('the wave is squeezed under 420px');
  const pin = (sel) => {
    const b = box(sel);
    return b && [b.left, b.top, b.width, b.height].map((v) => Math.round(v));
  };
  return {
    bad,
    boxes: {
      lvband: pin('#lvband'), program: pin('#program'), wavesvg: pin('#wavesvg'),
      progrows: pin('#progrows'), brun: pin('#brun'), breset: pin('#breset'),
      titlebar: pin('#titlebar'), header: pin('header'),
    },
  };
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`the L1 page: the delay column debuts without moving the L0 page ${width}×${height}`, async () => {
    await page.setViewport(width, height);
    // the baseline first: L0's pinned boxes, measured in this very session
    await page.goto(`${pageUrl()}?level=l0`);
    await page.evaluate('document.fonts.ready.then(() => {})');
    await page.evaluate("document.getElementById('boot')?.remove()");
    const l0 = await page.evaluate(L0_SCAN);
    const l0cols = await page.evaluate(
      'getComputedStyle(document.querySelector("main")).gridTemplateColumns',
    );

    await page.goto(`${pageUrl()}?level=l1`);
    await page.evaluate('document.fonts.ready.then(() => {})');
    await page.evaluate("document.getElementById('boot')?.remove()");
    const { bad, boxes } = await page.evaluate(L1_SCAN);
    assert.deepStrictEqual(
      bad,
      [],
      `L1 geometry broken at ${width}×${height} — the delay column debuts as a column, the rest holds`,
    );
    // the never-move discipline: the unlock takes its 38px out of the
    // instruction cell, never out of the page — every box keeps its
    // left edge and width bit-identical (main's clamp-fixed columns),
    // and the chrome above the band holds its full box. The boxes below
    // the band may shift UP with the band's own content (L1 carries no
    // predict row, so the band is one row shorter) — shrinking with
    // content is not moving.
    const above = new Set(['titlebar', 'header']);
    for (const key of Object.keys(boxes)) {
      const want = above.has(key) ? l0.boxes[key] : [l0.boxes[key][0], l0.boxes[key][2]];
      assert.deepStrictEqual(
        above.has(key) ? boxes[key] : [boxes[key][0], boxes[key][2]],
        want,
        `${key} moved when the delay column unlocked at ${width}×${height}`,
      );
    }
    assert.deepStrictEqual(
      await page.evaluate('getComputedStyle(document.querySelector("main")).gridTemplateColumns'),
      l0cols,
      'the level grid columns changed with the unlock',
    );

    // the delay-cell editor, once open, sits over the row's delay track
    const cell = await page.evaluate(`(() => {
      openDly(0);
      const de = document.getElementById('dlyedit').getBoundingClientRect();
      const cd = document.querySelector('#pr0 .cdly').getBoundingClientRect();
      const r = { de: [de.left, de.top, de.width, de.height].map(Math.round),
                  cd: [cd.left, cd.top, cd.width, cd.height].map(Math.round) };
      cancelDly();
      return r;
    })()`);
    assert.ok(
      Math.abs(cell.de[0] + cell.de[2] - (cell.cd[0] + cell.cd[2])) <= 2 &&
        Math.abs(cell.de[1] - cell.cd[1]) <= 2,
      `the open delay cell must sit on the delay track: ${JSON.stringify(cell)}`,
    );
  });
}

// C38 — the visual monitor: the band's numeric verdict (period clk,
// duty %) becomes a pair of mini-waves — the golden tier template
// (#lvtarget) beside the last measured cycle (#lvlive) — and the wave
// panel gains translucent gold acceptance gates over the live trace.
// Geometry contract: both glyphs ride the band's head row without
// wrapping it (the standing L0 wrap check above stays the gate for
// every level page), the target draws at build time and the live glyph
// at least its placeholder, and the gates are paint inside the existing
// #wavesvg box — the wave panel must not grow.
const L3_MON_SCAN = `(() => {
  const bad = [];
  const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
  const head = document.getElementById('lvhead');
  if (head && head.scrollHeight > head.clientHeight + 1)
    bad.push('the band head wraps (scrollHeight ' + head.scrollHeight + ' in ' + head.clientHeight + ')');
  for (const sel of ['#lvtarget', '#lvlive']) {
    const b = box(sel);
    if (!b) bad.push(sel + ' is missing — the monitor draws its waves');
    else if (b.height < 8 || b.width < 4) bad.push(sel + ' has no box to draw into');
  }
  const mon = box('.lvmon');
  const tgt = box('#lvtarget');
  const ver = box('#lvverdict');
  if (mon && tgt && (tgt.left < mon.left || tgt.right > mon.right + 1))
    bad.push('the golden template left the monitor span');
  if (tgt && ver && ver.left < tgt.right - 1)
    bad.push('the verdict word overlaps the golden glyphs');
  // the gates ride the wave svg without moving it
  const wave = box('#wavesvg');
  if (!wave || wave.height < 64) bad.push('the wave lost its 64px floor');
  const band = box('#lvband');
  return { bad, band: band && [band.left, band.top, band.width, band.height].map(Math.round) };
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`the visual monitor: golden glyphs on the band head, gates in the wave ${width}×${height}`, async () => {
    await page.setViewport(width, height);
    await page.goto(`${pageUrl()}?level=l3`);
    await page.evaluate('document.fonts.ready.then(() => {})');
    await page.evaluate("document.getElementById('boot')?.remove()");
    const { bad, band } = await page.evaluate(L3_MON_SCAN);
    assert.deepStrictEqual(bad, [], `the monitor glyphs broke the band at ${width}×${height}`);
    // l3 carries no predict row — one head row, still inside the band box
    assert.ok(
      band && band[3] >= 20 && band[3] <= 90,
      `the band left its box at ${width}×${height}: ${JSON.stringify(band)}`,
    );
  });
}

// C39 — the reading slice: the stimulus draws on the wave. The L6 page
// carries the given as geometry — one trace row per driven input pin,
// ABOVE the lens row, on the same time axis (the same px/clk — the
// echo lesson is the two traces side by side), and the reading debut:
// the ISR panel + the RX half of the fifo row (TX is the feeder's,
// L9). The predict card is the word face: three 32-bit candidates that
// must never wrap the predict row. The rx judge has no glyphs — the
// band face is the verdict word alone.
const L6_ABSENT = [
  '#clkdivtag',
  '#bempty',
  '#bdemo',
  '#bexport',
  '#bimport',
  '#bcopy',
  '#speed',
  '#binsn',
  '#smsbar',
  '#pinstrip',
  '#regs',
  '#dsalloc',
  '#progfoot',
  '#exectitle',
  '#execslim',
  '#fifo', // the TX half: absent until the feeder chapter (L9)
  '#pullconn',
  '#osr',
  '#framemap',
  '.maptag',
  '#wavewinaux',
  '#spin-lenspin',
  '#mon',
  '#feed',
  '#pattern',
];
const L6_SCAN = `(() => {
  const bad = [];
  const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
  const gone = (sel) => {
    const el = document.querySelector(sel);
    return !el || el.offsetParent === null;
  };
  for (const sel of ${JSON.stringify(L6_ABSENT)}) {
    if (document.querySelectorAll(sel).length && !gone(sel))
      bad.push(sel + ' is still laid out — a locked panel is absence, not a ghost');
  }
  // the reading debut: the ISR panel and the RX half of the fifo row
  // have real boxes (the row stays; only its TX half is absent)
  for (const sel of ['#isr', '#rxfifo', '#fiforow']) {
    const b = box(sel);
    if (!b || b.width < 80 || b.height < 20) bad.push(sel + ' has no box — the reading leg debuts it');
  }
  // the stimulus row: exactly one driven input, drawn INSIDE the wave's
  // svg in the band ABOVE the lens trace (top half of the panel)
  const stim = document.querySelectorAll('#wavesvg .stimrow');
  if (stim.length !== 1) bad.push('the stimulus row is missing — the given draws on the wave');
  else {
    const sb = stim[0].getBoundingClientRect();
    const wv = box('#wavesvg');
    if (!wv || sb.height < 4) bad.push('the stimulus row has no geometry');
    else if (sb.bottom > wv.top + wv.height / 2)
      bad.push('the stimulus row is not above the lens trace');
  }
  // the word face: every candidate is one 32-bit word, and the predict
  // row never wraps under them
  const words = document.querySelectorAll('#lvcands .lcand-bits');
  if (words.length !== 3) bad.push('the predict card lost its word candidates');
  for (const w of words)
    if (w.querySelectorAll('.bit').length !== 32)
      bad.push('a predict candidate is not one 32-bit word');
  const pred = document.getElementById('lvpred');
  if (pred && pred.scrollHeight > pred.clientHeight + 1)
    bad.push('the predict row wraps (scrollHeight ' + pred.scrollHeight + ' in ' + pred.clientHeight + ')');
  // the rx judge has no glyph pair — hidden, never empty boxes (svg
  // has no offsetParent; a display:none box reads as zero-size)
  for (const sel of ['#lvtarget', '#lvlive']) {
    const b = box(sel);
    if (!b || b.width > 0 || b.height > 0)
      bad.push(sel + ' shows on an rx level — the value judge has no windows');
  }
  // the standing level checks: 32 honest rows, the wave's floor, no
  // wrap steppers, the head row never wraps
  if (document.querySelectorAll('#progrows .prow').length !== 32)
    bad.push('the listing lost rows — 32 rows in every level');
  if (document.querySelectorAll('.wstep').length) bad.push('the wrap steppers are built');
  const wave = box('#wavesvg');
  if (!wave || wave.height < 64) bad.push('the wave lost its 64px floor');
  if (!wave || wave.width < 420) bad.push('the wave is squeezed under 420px');
  const head = document.getElementById('lvhead');
  if (head && head.scrollHeight > head.clientHeight + 1)
    bad.push('the band head wraps (scrollHeight ' + head.scrollHeight + ' in ' + head.clientHeight + ')');
  return { bad };
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`the L6 page: the stimulus draws on the wave, the reading leg debuts ${width}×${height}`, async () => {
    await page.setViewport(width, height);
    await page.goto(`${pageUrl()}?level=l6`);
    await page.evaluate('document.fonts.ready.then(() => {})');
    await page.evaluate("document.getElementById('boot')?.remove()");
    // the hermetic page never runs (the engine is held open), so the
    // wave's own renderer is driven with a synthetic window — the
    // shipped renderWave, the level's own stimulus cfg shape, exactly
    // the state a real run produces
    await page.evaluate(
      `renderWave({...V.state, cycle: 127, wave: {` +
        `pins: new Array(128).fill(0), tags: new Array(128).fill(""), startCycle: 0,` +
        `stim: [{pin: 1, bits: (${JSON.stringify('0011'.repeat(32))}).split('').map(Number)}]}})`,
    );
    const { bad } = await page.evaluate(L6_SCAN);
    assert.deepStrictEqual(
      bad,
      [],
      `L6 geometry broken at ${width}×${height} — the given must draw on the wave`,
    );
  });
}

// C40 — the echo page: the decode judge's face. TWO stimulus rows draw
// above the lens (the enable square narrating the speaking window, the
// data pin carrying the frame — the echo lesson is the three traces on
// one time axis), the frame map debuts as its own panel (the uart lens
// rides the page), and the band carries the byte glyphs — the golden
// frame template beside the last measured one (the C38 grammar grown
// from cycles to frames; the divergent bit marked red on a data red).
const L7_ABSENT = [
  '#clkdivtag',
  '#bempty',
  '#bdemo',
  '#bexport',
  '#bimport',
  '#bcopy',
  '#speed',
  '#binsn',
  '#smsbar',
  '#pinstrip',
  '#regs',
  '#dsalloc',
  '#progfoot',
  '#exectitle',
  '#execslim',
  '#fifo', // the TX half: absent until the feeder chapter (L9)
  '#pullconn',
  '#osr',
  '.maptag',
  '#wavewinaux',
  '#spin-lenspin', // the lens pins to the output — the steppers stay locked
  '#feed',
  '#pattern',
];
const L7_SCAN = `(() => {
  const bad = [];
  const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
  const gone = (sel) => {
    const el = document.querySelector(sel);
    return !el || el.offsetParent === null;
  };
  for (const sel of ${JSON.stringify(L7_ABSENT)}) {
    if (document.querySelectorAll(sel).length && !gone(sel))
      bad.push(sel + ' is still laid out — a locked panel is absence, not a ghost');
  }
  // the reading leg stays (L6's knowledge is monotone)
  for (const sel of ['#isr', '#rxfifo', '#fiforow']) {
    const b = box(sel);
    if (!b || b.width < 80 || b.height < 20) bad.push(sel + ' has no box — the reading leg stays');
  }
  // the frame map debuts: the uart lens rides the page, so the panel
  // and its ten cells lay out (START/D0..D7/STOP — the subgoal labels)
  const fm = box('#framemap');
  if (!fm || fm.width < 80 || fm.height < 20) bad.push('#framemap has no box — the frame map debuts');
  if (document.querySelectorAll('#fmcells .fmcell').length !== 10)
    bad.push('the frame map lost its ten frame cells');
  // TWO stimulus rows: the enable square and the data frame, both above
  // the lens trace (top half of the wave's band)
  const stim = document.querySelectorAll('#wavesvg .stimrow');
  if (stim.length !== 2) bad.push('two stimulus rows must draw — enable and data');
  else {
    const wv = box('#wavesvg');
    for (const r of stim) {
      const sb = r.getBoundingClientRect();
      if (!wv || sb.height < 4 || sb.bottom > wv.top + wv.height / 2)
        bad.push('a stimulus row is not above the lens trace');
    }
  }
  // the byte glyphs: the golden frame template beside the last measured
  // frame — real boxes on the band, unlike the rx judge's empty pair
  for (const sel of ['#lvtarget', '#lvlive']) {
    const b = box(sel);
    if (!b || b.width <= 0 || b.height <= 0) bad.push(sel + ' has no box — the decode judge draws glyphs');
  }
  // the standing level checks: 32 honest rows, the wave's floor, no
  // wrap steppers, the head row never wraps
  if (document.querySelectorAll('#progrows .prow').length !== 32)
    bad.push('the listing lost rows — 32 rows in every level');
  if (document.querySelectorAll('.wstep').length) bad.push('the wrap steppers are built');
  const wave = box('#wavesvg');
  if (!wave || wave.height < 64) bad.push('the wave lost its 64px floor');
  if (!wave || wave.width < 420) bad.push('the wave is squeezed under 420px');
  const head = document.getElementById('lvhead');
  if (head && head.scrollHeight > head.clientHeight + 1)
    bad.push('the band head wraps (scrollHeight ' + head.scrollHeight + ' in ' + head.clientHeight + ')');
  return { bad };
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`the L7 page: two stimulus rows, the frame map debuts, the byte glyphs hold the band ${width}×${height}`, async () => {
    await page.setViewport(width, height);
    await page.goto(`${pageUrl()}?level=l7`);
    await page.evaluate('document.fonts.ready.then(() => {})');
    await page.evaluate("document.getElementById('boot')?.remove()");
    // the hermetic page never runs; drive the shipped renderers with a
    // synthetic window in the level's own shape — the uart lens the
    // level boots with, two stimulus rows and a quiet line, exactly the
    // state a real run produces
    await page.evaluate(
      `V.state.lens = {mode: 'uart', pin: 0};` +
        `renderWave({...V.state, cycle: 127, wave: {` +
        `pins: new Array(128).fill(1), tags: new Array(128).fill(""), startCycle: 0,` +
        `stim: [` +
        `{pin: 1, bits: (${JSON.stringify('10'.repeat(64))}).split('').map(Number)},` +
        `{pin: 2, bits: (${JSON.stringify('0011'.repeat(32))}).split('').map(Number)}]}});` +
        `renderMonitor(V.state); renderFrameMap(V.state);`,
    );
    const { bad } = await page.evaluate(L7_SCAN);
    assert.deepStrictEqual(
      bad,
      [],
      `L7 geometry broken at ${width}×${height} — the decode judge's face must fit`,
    );
  });
}

// C41 — the fencepost page: the stepper's debut. The X/Y scratch panel
// arrives as its own surface key (#xy): the regs SECTION shows while
// only the scratch is unlocked — the irq lamps are chapter 5's and the
// inspector is config, neither is this level's teaching (the fifo-row
// derivation precedent). The reading leg stays (isr/rxfifo), one
// stimulus row draws the tick pattern, and the delay column stays
// SHUT — structure, not delay, is the lesson.
const L8_ABSENT = [
  '#clkdivtag',
  '#bempty',
  '#bdemo',
  '#bexport',
  '#bimport',
  '#bcopy',
  '#speed',
  '#binsn',
  '#smsbar',
  '#pinstrip',
  '#irqpanel', // xy alone: the regs section shows the scratch ONLY
  '#inspector',
  '#dsalloc',
  '#progfoot',
  '#exectitle',
  '#execslim',
  '#fifo', // the TX half: absent until the feeder chapter (L9)
  '#pullconn',
  '#osr',
  '#framemap', // the rx judge has no frame to label
  '.maptag',
  '#wavewinaux',
  '#spin-lenspin',
  '#mon',
  '#feed',
  '#pattern',
];
const L8_SCAN = `(() => {
  const bad = [];
  const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
  const gone = (sel) => {
    const el = document.querySelector(sel);
    return !el || el.offsetParent === null;
  };
  for (const sel of ${JSON.stringify(L8_ABSENT)}) {
    if (document.querySelectorAll(sel).length && !gone(sel))
      bad.push(sel + ' is still laid out — a locked panel is absence, not a ghost');
  }
  // the scratch debut: the regs section shows and the X/Y panel inside
  // it has a real box — the stepper is visible while it counts
  const xy = box('#xy');
  if (!xy || xy.width < 80 || xy.height < 20) bad.push('#xy has no box — the stepper debuts');
  const regsSec = box('#regs');
  if (!regsSec || regsSec.width < 80) bad.push('#regs has no box — the section follows its child');
  // the reading leg stays (L6's knowledge is monotone)
  for (const sel of ['#isr', '#rxfifo', '#fiforow']) {
    const b = box(sel);
    if (!b || b.width < 80 || b.height < 20) bad.push(sel + ' has no box — the reading leg stays');
  }
  // the delay column stays SHUT: the lesson is structure, not delay —
  // the listing's delay cells leave layout with the column
  const prog = document.getElementById('program');
  if (!prog || prog.classList.contains('col-delay'))
    bad.push('the delay column is built — the fencepost is not a delay lesson');
  // the stimulus row: exactly one driven input (the tick pattern),
  // drawn INSIDE the wave's svg in the band ABOVE the lens trace
  const stim = document.querySelectorAll('#wavesvg .stimrow');
  if (stim.length !== 1) bad.push('the stimulus row is missing — the given draws on the wave');
  else {
    const sb = stim[0].getBoundingClientRect();
    const wv = box('#wavesvg');
    if (!wv || sb.height < 4) bad.push('the stimulus row has no geometry');
    else if (sb.bottom > wv.top + wv.height / 2)
      bad.push('the stimulus row is not above the lens trace');
  }
  // the rx judge has no glyph pair — hidden, never empty boxes
  for (const sel of ['#lvtarget', '#lvlive']) {
    const b = box(sel);
    if (!b || b.width > 0 || b.height > 0)
      bad.push(sel + ' shows on an rx level — the value judge has no windows');
  }
  // the standing level checks: 32 honest rows, the wave's floor, no
  // wrap steppers, the head row never wraps
  if (document.querySelectorAll('#progrows .prow').length !== 32)
    bad.push('the listing lost rows — 32 rows in every level');
  if (document.querySelectorAll('.wstep').length) bad.push('the wrap steppers are built');
  const wave = box('#wavesvg');
  if (!wave || wave.height < 64) bad.push('the wave lost its 64px floor');
  if (!wave || wave.width < 420) bad.push('the wave is squeezed under 420px');
  const head = document.getElementById('lvhead');
  if (head && head.scrollHeight > head.clientHeight + 1)
    bad.push('the band head wraps (scrollHeight ' + head.scrollHeight + ' in ' + head.clientHeight + ')');
  return { bad };
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`the L8 page: the scratch debuts inside the regs section, one stimulus row ${width}×${height}`, async () => {
    await page.setViewport(width, height);
    await page.goto(`${pageUrl()}?level=l8`);
    await page.evaluate('document.fonts.ready.then(() => {})');
    await page.evaluate("document.getElementById('boot')?.remove()");
    // the hermetic page never runs (the engine is held open), so the
    // wave's own renderer is driven with a synthetic window — the
    // shipped renderWave, the level's own stimulus cfg shape, exactly
    // the state a real run produces (one driven row: the tick pattern)
    await page.evaluate(
      `renderWave({...V.state, cycle: 127, wave: {` +
        `pins: new Array(128).fill(0), tags: new Array(128).fill(""), startCycle: 0,` +
        `stim: [{pin: 1, bits: (${JSON.stringify('001111111111111111'.repeat(8))}).split('').map(Number)}]}})`,
    );
    const { bad } = await page.evaluate(L8_SCAN);
    assert.deepStrictEqual(
      bad,
      [],
      `L8 geometry broken at ${width}×${height} — the stepper's debut must fit`,
    );
  });
}

// C42 — the landing leg: the campaign map (web/index.html) is its own
// page — a content-hugging menu window (mockups/landing.html picked
// these: no toolbar, no engine boot, max-width 640) sharing the era
// chrome. Pinned at both 13" viewports, in BOTH postures (a fresh
// campaign and the seeded mid-campaign one, snapshot/restore around
// it): the window inside the viewport, the title bar one line, every
// chapter caption and every row single-line, the status word clear of
// the name, the map not scrolling internally (10 rows fit a menu), and
// the three row states drawn as content (solved par text present, the
// ▸ on the frontier, dim ahead). Ran red first: the page did not exist.
const LANDING_SCAN = `(() => {
  const bad = [];
  const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
  const win = box('#win');
  if (!win || win.width < 300 || win.width > 660) bad.push('the menu window left its 640 cap');
  if (!win || win.bottom > innerHeight - 4) bad.push('the window overflows the viewport');
  if (!win || Math.abs((win.left + win.right) / 2 - innerWidth / 2) > 2)
    bad.push('the window is not centered on the desktop');
  const title = document.getElementById('titlebar');
  if (title && title.scrollHeight > title.clientHeight + 1) bad.push('the title bar wraps');
  const map = document.getElementById('map');
  if (!map || map.scrollHeight > map.clientHeight + 1)
    bad.push('the map scrolls internally — 10 rows fit a menu at 13"');
  if (document.querySelectorAll('#map .mrow').length !== 10)
    bad.push('the map lost rows (9 levels + the sandbox standing row)');
  if (document.querySelectorAll('#map .chgroup').length !== 3)
    bad.push('a chapter frame is missing (three shipped chapters)');
  for (const cap of document.querySelectorAll('.chcap'))
    if (cap.scrollHeight > cap.clientHeight + 1) bad.push('a chapter caption wraps');
  for (const row of document.querySelectorAll('#map .mrow')) {
    if (row.scrollHeight > row.clientHeight + 1) bad.push('a row wraps: ' + row.id);
    const name = row.querySelector('.name').getBoundingClientRect();
    const st = row.querySelector('.st').getBoundingClientRect();
    if (name.right > st.left + 0.5 && st.width > 0)
      bad.push('the status word overlaps the name: ' + row.id);
  }
  const pin = (sel) => {
    const b = box(sel);
    return b && [b.left, b.top, b.width, b.height].map((v) => Math.round(v));
  };
  return {
    bad,
    boxes: { win: pin('#win'), map: pin('#map'), titlebar: pin('#titlebar') },
    states: [...document.querySelectorAll('#map .mrow')].map((r) => r.id + ':' + r.className),
    tips: [...document.querySelectorAll('#map .mrow')].map((r) => r.dataset.tip),
    sts: Object.fromEntries(
      [...document.querySelectorAll('#map .mrow')].map((r) => [r.id, r.querySelector('.st').textContent]),
    ),
  };
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`the landing page: a menu window with a single-line map ${width}×${height}`, async () => {
    await page.setViewport(width, height);
    // seed the mid-campaign posture on the origin (chapters 0–1 solved,
    // frontier L6 — the mock-up round's own state), snapshot/restore
    await page.goto(`${baseUrl}/web/index.html`);
    const snapshot = await page.evaluate(`(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith('vibe-pio-level-')) out[k] = localStorage.getItem(k);
      }
      return out;
    })()`);
    try {
      await page.evaluate(`(() => {
        localStorage.clear();
        for (const id of ['l1', 'l2', 'l3', 'l4'])
          localStorage.setItem('vibe-pio-level-' + id, JSON.stringify({ solved: true }));
        // C43: two of the solved sessions carry the solve datum the
        // level page writes at pass — the map's you-face renders theirs
        localStorage.setItem('vibe-pio-level-l0', JSON.stringify({
          solved: true,
          solve: { listing: ['set pins, 1', 'set pins, 0'], words: 2, axis: 2 },
        }));
        localStorage.setItem('vibe-pio-level-l5', JSON.stringify({
          solved: true,
          solve: {
            listing: ['set pins, 1 [15]', 'set pins, 0 [31]', 'set pins, 0 [15]'],
            words: 3, axis: 64,
          },
        }));
        return true;
      })()`);
      await page.goto(`${baseUrl}/web/index.html`);
      await page.evaluate('document.fonts.ready.then(() => {})');
      const { bad, boxes, states, tips, sts } = await page.evaluate(LANDING_SCAN);
      assert.deepStrictEqual(
        bad,
        [],
        `landing geometry broken at ${width}×${height} (seeded posture)`,
      );
      // the seeded posture's content: solved rows carry par, the
      // frontier its ▸, ahead rows are dim-but-named with no mark
      const by = Object.fromEntries(states.map((s) => s.split(':', 2)));
      assert.match(by['row-l5'], /solved/, 'a solved row wears its state');
      assert.match(by['row-l6'], /frontier/, 'the frontier row wears its state');
      assert.match(by['row-l7'], /ahead(?!.*link)/, 'an ahead row is dim and not linked');
      assert.match(by['row-sandbox'], /standing link/, 'the sandbox standing row is linked');
      assert.match(
        tips.find((t) => t?.startsWith('L5')),
        /par 3 words · 64 clk\/cycle/,
        "a solved row's narration carries its named-clock par",
      );
      assert.match(
        tips.find((t) => t?.startsWith('L7')),
        /deep-links/,
        'an ahead row narrates the soft unlock',
      );
      // C43: the datum's face — your axes beside par with the badge,
      // single-line like every status word (the row-wrap check above
      // already gates it); datum-less solved rows keep par alone
      assert.match(
        sts['row-l5'],
        /✓ par 3 words · 64 clk\/cycle · you 3·64 \(= par\)/,
        'a matched solve wears your axes and the = par badge',
      );
      assert.match(sts['row-l0'], /you 2·2 \(= par\)/, 'the l0 datum renders too');
      assert.ok(!sts['row-l1'].includes('you '), 'a datum-less solved row shows par alone');
      // the window keeps menu proportions, not app proportions
      assert.ok(
        boxes.win && boxes.win[2] >= 500 && boxes.win[2] <= 660,
        `the window is not a centered menu at ${width}×${height}: ${JSON.stringify(boxes.win)}`,
      );

      // the fresh posture: nothing solved — no par anywhere, no ✓, the
      // frontier is L0, and the geometry does not move
      await page.evaluate(`(() => {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k.startsWith('vibe-pio-level-')) localStorage.removeItem(k);
        }
        return true;
      })()`);
      await page.goto(`${baseUrl}/web/index.html`);
      await page.evaluate('document.fonts.ready.then(() => {})');
      const fresh = await page.evaluate(LANDING_SCAN);
      assert.deepStrictEqual(
        fresh.bad,
        [],
        `landing geometry broken at ${width}×${height} (fresh)`,
      );
      assert.deepStrictEqual(
        fresh.boxes,
        boxes,
        `the fresh campaign must not move the window at ${width}×${height}`,
      );
      assert.ok(
        fresh.tips.every((t) => !t?.includes('par ')),
        'par shows on solved rows only — a fresh campaign has none',
      );
      assert.ok(
        fresh.states.some((s) => s.startsWith('row-l0:')),
        'the rows derive from the registry',
      );
    } finally {
      await page.goto(`${baseUrl}/web/index.html`);
      await page.evaluate(`((snap) => {
        const keep = Object.keys(localStorage).filter((k) => k.startsWith('vibe-pio-level-'));
        for (const k of keep) localStorage.removeItem(k);
        for (const [k, v] of Object.entries(snap)) localStorage.setItem(k, v);
      })(${JSON.stringify(snapshot)})`);
    }
  });
}

// C43 — the transitions: the level page grows its exits, and the band
// gains its pass-time member without moving anything. The toolbar
// carries the MAP button (Alt+M — level-page chrome only; the sandbox
// keeps its URL, no door it does not offer). The band's pass-time
// members (the chip, par, NEXT) ride C33's possible-max rule as a ROW:
// visibility, not display — their boxes are reserved from clk one, so
// the reveal at pass is a class flip that moves neither the steady
// members (name, goal, monitor) nor anything below the band. Ran red
// first: neither button existed and the pass-time members laid out
// only after the solve.
const C43_TOOLBAR_SCAN = `(() => {
  const bad = [];
  const hdr = document.querySelector('header');
  if (hdr.scrollHeight > hdr.clientHeight + 1) bad.push('the toolbar wraps');
  const m = document.getElementById('bmap');
  if (!m) bad.push('#bmap does not exist');
  else {
    const laidOut = m.offsetParent !== null;
    if (!LEVEL) {
      if (laidOut) bad.push('the sandbox shows a MAP exit it does not offer');
    } else if (!laidOut) bad.push('the MAP exit is missing on a level page');
    else {
      const b = m.getBoundingClientRect();
      if (b.width < 24 || b.height < 12) bad.push('the MAP exit has no box');
      const ctrl = document.querySelector('header .ctrl');
      if (ctrl && b.right > ctrl.getBoundingClientRect().left + 0.5)
        bad.push('the MAP exit is not left of the run controls');
    }
  }
  return { bad };
})()`;

const C43_BAND_SCAN = `(() => {
  const bad = [];
  const box = (e) => {
    const b = e.getBoundingClientRect();
    return [b.left, b.top, b.width, b.height].map((v) => +v.toFixed(1));
  };
  const head = document.getElementById('lvhead');
  if (!head) {
    bad.push('the head row is missing');
    return { bad };
  }
  if (head.scrollHeight > head.clientHeight + 1) bad.push('the head row wraps');
  if (head.scrollWidth > head.clientWidth + 1) bad.push('the head row overflows');
  const band = document.getElementById('lvband');
  if (band.scrollHeight > band.clientHeight + 1) bad.push('the band scrolls');
  // the pass-time members hold RESERVED boxes from clk one, invisible
  // until the solve — the reveal is a visibility flip, never a reflow
  const vis = {};
  for (const id of ['lvpass', 'lvpar', 'lvnext']) {
    const el = document.getElementById(id);
    if (!el) {
      bad.push(id + ' does not exist');
      continue;
    }
    const b = el.getBoundingClientRect();
    if (b.width < 4 || b.height < 8) bad.push(id + ' reserves no box');
    vis[id] = getComputedStyle(el).visibility;
  }
  return {
    bad,
    vis,
    steady: {
      lvname: box(document.getElementById('lvname')),
      lvgoal: box(document.getElementById('lvgoal')),
      lvmon: box(document.getElementById('lvmon')),
      head: box(head),
      band: box(band),
      main: box(document.querySelector('main')),
    },
  };
})()`;

for (const [width, height] of VIEWPORTS) {
  test(`the C43 toolbar: the MAP exit is level-page chrome, absent in the sandbox ${width}×${height}`, async () => {
    await page.setViewport(width, height);
    await page.goto(`${pageUrl()}?level=l0`);
    await page.evaluate('document.fonts.ready.then(() => {})');
    await page.evaluate("document.getElementById('boot')?.remove()");
    assert.deepStrictEqual(
      await page.evaluate(C43_TOOLBAR_SCAN),
      { bad: [] },
      `the toolbar broke at ${width}×${height} on a level page`,
    );
    // the sandbox: absence — out of layout and the Tab order both
    await page.goto(pageUrl());
    await page.evaluate('document.fonts.ready.then(() => {})');
    await page.evaluate("document.getElementById('boot')?.remove()");
    assert.deepStrictEqual(
      await page.evaluate(C43_TOOLBAR_SCAN),
      { bad: [] },
      `the toolbar broke at ${width}×${height} on the sandbox page`,
    );
  });

  test(`the C43 band: the pass-time members reveal without a reflow ${width}×${height}`, async () => {
    await page.setViewport(width, height);
    // L3 carries no predict row, so the reveal cannot change the band's
    // height at all — the purest posture for the never-reflow check
    await page.goto(`${pageUrl()}?level=l3`);
    await page.evaluate('document.fonts.ready.then(() => {})');
    await page.evaluate("document.getElementById('boot')?.remove()");
    const fresh = await page.evaluate(C43_BAND_SCAN);
    assert.deepStrictEqual(fresh.bad, [], `the band broke at ${width}×${height} (fresh)`);
    assert.deepStrictEqual(
      fresh.vis,
      { lvpass: 'hidden', lvpar: 'hidden', lvnext: 'hidden' },
      'pre-pass the pass-time members are invisible (reserved, not shown)',
    );
    // the page's own reveal path — the exact moment the band gains its
    // pass-time member: every steady box must be bit-identical after
    await page.evaluate('lvRevealSolved()');
    const solved = await page.evaluate(C43_BAND_SCAN);
    assert.deepStrictEqual(solved.bad, [], `the band broke at ${width}×${height} (solved)`);
    assert.deepStrictEqual(
      solved.vis,
      { lvpass: 'visible', lvpar: 'visible', lvnext: 'visible' },
      'the reveal shows all three pass-time members',
    );
    assert.deepStrictEqual(
      solved.steady,
      fresh.steady,
      `the band re-flowed when it gained its pass-time member at ${width}×${height}`,
    );
    assert.ok(
      await page.evaluate(
        'document.activeElement === document.body || document.activeElement === null',
      ),
      'the reveal must not steal or drop focus',
    );
  });
}

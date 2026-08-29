// keyboard.test.js — the C25 keyboard-walk gate (headless Chromium via
// CDP, zero dependencies — the layout harness's browser plumbing). The
// second sanctioned DOM-glue exception after page geometry: it drives the
// real shipped page with KEYBOARD EVENTS ONLY — not one mouse event, not
// one element.click() — through the DOS/Win3.11 core loop a mouseless
// user lives in:
//
//   Tab into the machines bar and the pin strip, walk the arrows, latch
//   a pin; Tab into the listing (a listbox), walk the row cursor, type
//   an instruction (the editor opens under the keys alone), commit it;
//   walk the gutter pick; spin a drawn stepper through its wrap; take
//   the Alt+letter mnemonic. The engine is the suite's fake ABI behind
//   the REAL worker transport (fake-engine-module.js served at the
//   engine URL), so every keystroke's effect — the drive latch, the
//   threshold wrap — is the engine truth the view renders, not a stub.
//
// Red against the shipped pre-C25 page: nothing in the listing was
// focusable, so Tab could never reach it and the row editor could not
// open at all without a mouse.

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
};

let server;
let baseUrl;
let b;
let page;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // the keyboard walk's engine: the fake ABI behind the real worker
    if (url.pathname === '/build/web/pio_engine.js') {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      res.end(fs.readFileSync(path.join(ROOT, 'web', 'tests', 'fake-engine-module.js')));
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
      'cache-control': 'no-store',
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
  if (server) await new Promise((resolve) => server.close(resolve));
});

// ---- keyboard-only input (CDP Input.dispatchKeyEvent — no mouse) --------

// non-printing keys: rawKeyDown + keyUp (focus traversal, arrows, Enter…)
const KEYS = {
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
};

function codeOf(ch) {
  if (/[a-z]/.test(ch))
    return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0) };
  if (/[A-Z]/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0) };
  if (/[0-9]/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: 48 + +ch };
  const PUNCT = {
    ' ': { key: ' ', code: 'Space', keyCode: 32 },
    ',': { key: ',', code: 'Comma', keyCode: 188 },
    '-': { key: '-', code: 'Minus', keyCode: 189 },
    '.': { key: '.', code: 'Period', keyCode: 190 },
    '[': { key: '[', code: 'BracketLeft', keyCode: 219 },
    ']': { key: ']', code: 'BracketRight', keyCode: 221 },
    '!': { key: '!', code: 'Digit1', keyCode: 49 },
    '=': { key: '=', code: 'Equal', keyCode: 187 },
    '+': { key: '+', code: 'Equal', keyCode: 187 },
  };
  const p = PUNCT[ch];
  if (p) return p;
  throw new Error(`keyboard gate: no CDP key descriptor for ${JSON.stringify(ch)}`);
}

// a KEYS name, or any single character ('1' latches, 'z' releases,
// '+' spins — the keys the groups own)
async function press(name, mods = {}) {
  const d = KEYS[name] || codeOf(name);
  assert.ok(d, `unknown key ${name}`);
  // CDP: the DOM event's modifier state rides the bitmask (alt 1, ctrl 2,
  // meta 4, shift 8) — the boolean params alone do not set e.altKey
  const mask =
    (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
  await page.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    ...d,
    windowsVirtualKeyCode: d.keyCode,
    nativeVirtualKeyCode: d.keyCode,
    ...mods,
    ...(mask ? { modifiers: mask } : {}),
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    ...d,
    windowsVirtualKeyCode: d.keyCode,
    nativeVirtualKeyCode: d.keyCode,
    ...mods,
    ...(mask ? { modifiers: mask } : {}),
  });
}

// type a printable string: keyDown carries text, so the editor receives
// the characters exactly as a keyboard would deliver them
async function type(text) {
  for (const ch of text) {
    const d = codeOf(ch);
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...d,
      text: ch,
      unmodifiedText: ch,
      windowsVirtualKeyCode: d.keyCode,
      nativeVirtualKeyCode: d.keyCode,
    });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...d });
  }
}

async function value(expr) {
  return page.evaluate(expr);
}

async function until(expr, what, timeout = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(expr)) return;
    if (Date.now() - t0 > timeout)
      throw new Error(`keyboard gate: timed out waiting for ${what || expr}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

// Tab forward until a check on the active element holds — keyboard-only
// navigation the way the user does it, robust to stop additions upstream
async function tabUntil(check, what, max = 60) {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate(check)) return i;
    await press('Tab');
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`keyboard gate: Tab never reached ${what} (${max} stops)`);
}

const activeId =
  'document.activeElement && (document.activeElement.id || document.activeElement.tagName)';

test('the keyboard walk: tab in, walk, type, commit, pick, spin, latch', async () => {
  await page.setViewport(1280, 800);
  await page.goto(`${baseUrl}/web/sm-view.html`);
  await until('V.ready === true', 'the engine (fake ABI behind the real worker) to boot');

  // ---- machines: the first arrow group; ←/→ selects --------------------
  const toMachines = await tabUntil(`${activeId} === 'smscells'`, 'the machines bar');
  assert.ok(
    toMachines < 20,
    `the machines bar is buried deep in the tab order (${toMachines} stops)`,
  );
  await page.evaluate("document.getElementById('statusline').textContent = ''");
  await press('ArrowRight');
  await until('curSm === 1', '←/→ to select SM1');
  assert.strictEqual(
    await value("$('execsm').textContent"),
    'SM1',
    'the exec pane follows the machines walk',
  );

  // ---- pin strip: arrows walk the cursor, 1/0/Z latch, Space cycles ----
  await press('Tab');
  assert.strictEqual(
    await value(activeId),
    'pincells',
    'the pin strip is the next stop after the machines',
  );
  assert.ok(
    (await value("$('statusline').textContent")).includes('pins'),
    'the status line narrates the pin strip when it takes focus',
  );
  for (let i = 0; i < 3; i++) await press('ArrowRight');
  assert.ok(
    await value(`document.querySelector('.pcell[data-pin="3"]').classList.contains('kc')`),
    '←/→ moves the pin cursor to pin 3',
  );
  await press('1');
  await until('V.state.drives[3] === 1', 'the 1 key to latch pin 3 high');
  assert.ok(
    await value(`document.querySelector('.pcell[data-pin="3"]').classList.contains('dh')`),
    'a held-high latch shows its mark',
  );
  await press('Space');
  await until('V.state.drives[3] === 0', 'Space cycles the latch to 0');
  await press('z');
  await until('V.state.drives[3] === null', 'Z releases the latch');

  // ---- the listing: a listbox — rows, then the editor under keys alone -
  const toListing = await tabUntil(`${activeId} === 'progrows'`, 'the listing');
  assert.ok(
    toListing <= 4,
    `the listing must sit within a Tab breath of the pin strip (took ${toListing})`,
  );
  await press('ArrowDown');
  await press('ArrowDown');
  assert.strictEqual(
    await value("document.getElementById('progrows').getAttribute('aria-activedescendant')"),
    'pr2',
    '↑/↓ moves the row cursor (two downs from the top)',
  );
  assert.ok(
    await value(`document.getElementById('pr2').classList.contains('kc')`),
    'the amber row cursor marks the walked row',
  );

  await type('set x, 3');
  assert.strictEqual(
    await value('RE.hidden'),
    false,
    'typing opens the row editor — no mouse anywhere',
  );
  assert.strictEqual(
    await value('document.activeElement.id'),
    'edittxt',
    'the editor takes focus on the instruction cell',
  );
  assert.strictEqual(
    await value('ED.value'),
    'set x, 3',
    'the typed characters landed in the instruction cell',
  );
  assert.ok(
    (await value("$('edcode').textContent")).includes('0x'),
    'the live preview assembled the row',
  );
  await press('Escape'); // dismiss the completion popup (31 is a count candidate)
  await press('Enter'); // commit + hop to the next row, the editor's own model
  await press('Escape'); // close row 4's fresh popup
  await press('Escape'); // cancel the empty row — focus returns to the listing
  assert.strictEqual(await value('ROWS[2]'), 'set x, 3', 'the commit landed in the listing');
  assert.ok(await value('BUILT[2] !== 0'), 'the committed row assembled into the live image');
  assert.ok(
    (await value("document.getElementById('pr2').textContent")).includes('set x, 3'),
    'the listing shows the committed instruction',
  );
  assert.strictEqual(
    await value(activeId),
    'progrows',
    'the editor hands focus back to the listing',
  );

  // ---- the gutter pick walk: candidate → pick mode → arrows → Enter ----
  await press('Enter'); // open the row editor on the cursor row
  await type('jmp ');
  for (let i = 0; i < 7; i++) await press('ArrowDown'); // walk to ↦ pick row
  await press('Enter');
  assert.ok(
    await value("HOST.classList.contains('picking')"),
    'the pick candidate enters gutter-pick mode',
  );
  for (let i = 0; i < 3; i++) await press('ArrowDown');
  assert.ok(
    await value(`document.getElementById('pr6').classList.contains('pkw')`),
    'the pick walk highlights the previewed row',
  );
  assert.ok(
    await value("!!document.querySelector('.jparc.prev')"),
    'the pick walk previews the jump arc',
  );
  await press('Enter');
  assert.strictEqual(await value('ED.value'), 'jmp 6', 'Enter inserts the walked address');
  assert.ok(
    !(await value("HOST.classList.contains('picking')")),
    'the pick stands down after the insert',
  );
  assert.ok(
    !(await value("!!document.querySelector('.jparc.prev')")),
    'the preview arc goes with it',
  );
  await press('Escape');
  await press('Escape');

  // ---- fifo join: a radio group on the arrows --------------------------
  const toJoin = await tabUntil(`${activeId} === 'segjoin'`, 'the fifo join radio group');
  assert.ok(
    toJoin <= 12,
    `the join radio group is out of reach (${toJoin} stops) — the segments must form one Tab stop`,
  );
  await press('ArrowRight');
  await until('V.state.fifoDepths.tx === 8', '←/→ to apply join-tx');
  assert.strictEqual(
    await value("document.getElementById('segtx').getAttribute('aria-pressed')"),
    'true',
    'the applied mode reads as pressed',
  );
  await press('ArrowRight');
  await until('V.state.fifoDepths.tx === 0', '←/→ on to join-rx');
  await press('ArrowLeft');
  await until('V.state.fifoDepths.tx === 8', '←/→ back to join-tx');

  // ---- a drawn stepper: one spinbox stop, −/+/arrows, wrapping ---------
  const toSpin = await tabUntil(`${activeId} === 'spin-pullthr'`, 'the pull-threshold spinbox');
  assert.ok(
    toSpin <= 12,
    `the threshold spinbox is out of reach (${toSpin} stops) — the stepper pair must be one Tab stop`,
  );
  await press('+'); // 32 wraps to 1 — the wrap is the C22 control's own
  await until('OV.shiftctrl.pullThr === 1', 'the + key to spin the threshold through its wrap');
  assert.strictEqual(
    await value("$('apthr').textContent"),
    '1',
    'the drawn control shows the spun value',
  );
  await press('+');
  await until('OV.shiftctrl.pullThr === 2', 'the threshold to 2');
  await press('ArrowLeft');
  await until('OV.shiftctrl.pullThr === 1', '← steps back down');

  // ---- the Alt+letter mnemonic on a header button ----------------------
  await press('e', { alt: true }); // Alt+E — reload empty memory
  await until('BUILT.every((w) => !w)', 'Alt+E to reload empty memory');
  assert.ok(
    !(await value("/ERROR/.test(document.querySelector('footer').textContent)")),
    'the page walked through the whole loop without an engine error',
  );
});

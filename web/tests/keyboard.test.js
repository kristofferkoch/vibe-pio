// keyboard.test.js — the C25 keyboard-walk gate (headless Chromium via
// CDP, zero dependencies — the layout harness's browser plumbing). The
// second sanctioned DOM-glue exception after page geometry: it drives the
// real shipped page with KEYBOARD EVENTS ONLY — not one mouse event, not
// one element.click() — through the DOS/Win3.11 core loop a mouseless
// user lives in:
//
//   Tab into the machines bar and the pin strip, walk the arrows, latch
//   a pin; Tab into the listing (a listbox), walk the row cursor, type
//   an instruction (the editor opens under the keys alone), exercise
//   the completion-list contract (C31 the list is its own box; C32 the
//   suggestions match the slot under the caret — wait's polarity first,
//   push's flags mid-instruction, irq's keywords at their positions,
//   complete slots quiet), commit it; walk the gutter pick; spin a
//   drawn stepper through its wrap; take the Alt+letter mnemonic. The
//   engine is the suite's fake ABI behind
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
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
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

  // ---- C31: the list is its own box, and the keys follow its state -----
  // C32: 'set x, 3' — the count slot holds a complete value, so the list
  // is quiet (31 for a typed 3 was noise, not help)
  assert.strictEqual(
    await value("$('edpop').hidden"),
    true,
    "a complete slot offers nothing — the strip is the editor's other box",
  );
  assert.ok(
    (await value("$('statusline').textContent")).includes('Tab crosses cells'),
    'the status line narrates the closed-list contract',
  );
  // ← moves the caret into the slot's leading space: the partial empties
  // and all four counts appear — the menu recomputes under the caret
  // (selectionchange is async, so the walk waits like a user would)
  await press('ArrowLeft');
  await until(
    "!$('edpop').hidden && $('edcands').children.length === 4",
    'the list to follow the caret (the four counts over the empty slot)',
  );
  assert.ok(
    (await value("$('statusline').textContent")).includes('Tab accepts'),
    'the status line narrates the open-list key contract',
  );
  // Esc closes the list for this slot — and only the list: the machine
  // strip is its own always-on box and must survive
  await press('Escape');
  assert.strictEqual(await value("$('edpop').hidden"), true, 'Esc closes the list');
  assert.ok(
    await value("$('edcode').getBoundingClientRect().height > 0"),
    'the machine-code strip is its own box — Esc on the list leaves it up',
  );
  // Home leaves the slot (caret to the opcode): the Esc close was spent,
  // and the list reopens over the opcode menu
  await press('Home');
  await until(
    "!$('edpop').hidden && $('edcands').children.length === 10",
    'the caret leaving the Esc-closed slot to reopen the list (the opcodes)',
  );
  // End returns to the count slot: its value is complete, so the list
  // stays quiet (pre-C32 it re-offered 31 — the C32 suppression)
  await press('End');
  await until("$('edpop').hidden", 'the complete count slot to stay quiet');
  // Enter commits in BOTH states — the Escape-before-Enter dance is gone
  await press('Enter');
  assert.strictEqual(
    await value('ROWS[2]'),
    'set x, 3',
    'Enter commits the row while the list is open — one key, one meaning',
  );
  assert.ok(await value('BUILT[2] !== 0'), 'the committed row assembled into the live image');
  assert.strictEqual(await value('RE.style.top'), '60px', 'the commit hops to the next row');
  assert.strictEqual(
    await value('document.activeElement.id'),
    'edittxt',
    'the fresh row takes focus on its instruction cell',
  );
  assert.ok(
    await value("!$('edpop').hidden"),
    'a new row reopens the list (the empty row offers the opcodes)',
  );
  await press('Escape'); // close the fresh row's list — it stays closed for its slot
  await press('Escape'); // cancel the empty row — focus returns to the listing
  assert.ok(
    (await value("document.getElementById('pr2').textContent")).includes('set x, 3'),
    'the listing shows the committed instruction',
  );
  assert.strictEqual(
    await value(activeId),
    'progrows',
    'the editor hands focus back to the listing',
  );

  // ---- the gutter pick walk: Tab accepts; pick mode keeps its keys -----
  await press('Enter'); // open the row editor on the cursor row
  await type('jmp ');
  for (let i = 0; i < 7; i++) await press('ArrowDown'); // walk to ↦ pick row
  await press('Tab'); // C31: Tab is the only accept key while the list is open
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
  await press('Escape'); // the target is complete — no candidates, so Esc cancels the row

  // ---- C32: the suggestions match the slot under the caret -------------
  // wait's first slot is the polarity — gpio/pin/irq moved down to the
  // source slot that follows it
  await type('w'); // type-ahead opens the editor on the cursor row
  await until(
    "!$('edpop').hidden && $('edcands').children.length === 1",
    'the opcode menu to complete the typed w',
  );
  await press('Tab'); // C31: Tab is the only accept key
  assert.strictEqual(await value('ED.value'), 'wait ', 'accept lands in the polarity slot');
  await until("$('edcands').children.length === 2", 'wait offers its polarity (0/1) first');
  await type('1 ');
  await until("$('edcands').children.length === 4", 'the source slot offers gpio/pin/irq/jmppin');
  await press('Tab'); // accept 'gpio' — the first entry
  await type('5');
  assert.strictEqual(
    await value('ED.value'),
    'wait 1 gpio 5',
    'the accepts composed the canonical spelling (spaces, no comma)',
  );
  assert.strictEqual(await value("$('edpop').hidden"), true, 'the complete wait goes quiet');
  await press('Enter'); // commits the row — the editor hops to the next
  assert.strictEqual(await value('ROWS[3]'), 'wait 1 gpio 5', 'the canonical wait committed');

  // push's flags have slots — the menu no longer empties mid-instruction
  await type('push ');
  await until(
    "!$('edpop').hidden && $('edcands').children.length === 3",
    'push offers both flags at its first slot',
  );
  await type('iffull ');
  await until(
    "$('edcands').children.length === 2",
    'the block flag slot follows iffull — the menu no longer empties mid-instruction',
  );
  await press('Tab'); // accept 'block'
  assert.strictEqual(
    await value('ED.value'),
    'push iffull block',
    'Tab composes the canonical flags (no comma after iffull)',
  );
  assert.strictEqual(await value("$('edpop').hidden"), true, 'the complete push goes quiet');
  await press('Enter');
  assert.strictEqual(await value('ROWS[4]'), 'push iffull block', 'the canonical push committed');

  // irq's keywords appear at their positions: set/wait/clear first, the
  // typed index, then rel/prev/next
  await type('irq ');
  await until(
    "!$('edpop').hidden && $('edcands').children.length === 3",
    'the mode slot offers set/wait/clear',
  );
  await type('wait 3 ');
  await until(
    "$('edcands').children.length === 3",
    'rel/prev/next appear after the index — not back at the mode slot',
  );
  await press('Escape'); // close the list — Esc never destroys the row
  assert.strictEqual(await value('RE.hidden'), false, 'Esc closed the list only');
  await press('Enter'); // Enter commits in both states
  assert.strictEqual(await value('ROWS[5]'), 'irq wait 3', 'the irq row committed');
  assert.strictEqual(await value('RE.style.top'), '120px', 'the commit hops to row 6');
  await press('Escape'); // close row 6's fresh list
  await press('Escape'); // cancel the empty row — focus returns to the listing

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

  // ---- C28: the wave row owns its pin — the lens-pin picker ------------
  // The gpio<N> label is a drawn stepper pair riding the row's spin
  // grammar (one Tab stop, −/+/←/→, wrapping 0..31): following a signal
  // that moved — a side-base remap mid-run, the wave gone flat —
  // retargets the wave where the wave lives, not up in the exec title
  // (the pin select moved down to this row; the mode select stayed).
  await press('Tab');
  assert.strictEqual(
    await value(activeId),
    'spin-lenspin',
    "the lens-pin picker is the wave title row's first stop (next after the pull-threshold spinbox)",
  );
  assert.ok(
    (await value("$('statusline').textContent")).includes('lens pin'),
    'the status line narrates the picker when it takes focus',
  );
  await press('+');
  await until('V.state.lens.pin === 1', 'the + key to retarget the wave/lens to pin 1');
  assert.strictEqual(
    await value("$('lenspinval').textContent"),
    '1',
    'the drawn picker shows the retargeted pin',
  );
  await press('ArrowLeft');
  await until('V.state.lens.pin === 0', '← steps the pin back down');
  await press('ArrowLeft');
  await until('V.state.lens.pin === 31', '← wraps down past pin 0 to 31');
  await press('ArrowRight');
  await until('V.state.lens.pin === 0', '→ wraps back up past 31');

  // ---- the Alt+letter mnemonic on a header button ----------------------
  await press('e', { alt: true }); // Alt+E — reload empty memory
  await until('BUILT.every((w) => !w)', 'Alt+E to reload empty memory');
  assert.ok(
    !(await value("/ERROR/.test(document.querySelector('footer').textContent)")),
    'the page walked through the whole loop without an engine error',
  );
});

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

// C34 — the level shell's walk: the L0 page (sm-view.html?level=l0) is
// the sandbox minus what the level hasn't taught, and ABSENCE covers the
// Tab order too: locked panels leave layout and focusability both, so
// the walk must find no orphan stops — every Tab lands on the level's
// own surface (reset, the locked transport, the predict group, the
// listing). The predict gate is operated by keys alone (the C25 radio
// grammar: ←/→ pick, Enter commits), Run stays dead until the
// prediction is in, and the row editor never opens (the opcode
// whitelist is empty in L0).
test('the L0 walk: absence covers Tab order, predict unlocks Run by keys', async () => {
  await page.setViewport(1280, 800);
  await page.goto(`${baseUrl}/web/sm-view.html?level=l0`);
  await until('V.ready === true', 'the level page engine to boot');

  // ---- no orphan stops: the whole Tab cycle stays on the level surface --
  // locked transport buttons are not focusable either (disabled) — the
  // pre-prediction cycle is exactly reset → predict → listing
  const stops = [];
  for (let i = 0; i < 12; i++) {
    await press('Tab');
    stops.push(await value(activeId));
  }
  const seen = new Set(stops);
  const allowed = new Set(['breset', 'lvcands', 'progrows', 'BODY']);
  for (const s of stops)
    assert.ok(
      allowed.has(s),
      `orphan stop ${JSON.stringify(s)} — a locked panel left a focusable behind (${stops.join(', ')})`,
    );
  for (const need of ['breset', 'lvcands', 'progrows'])
    assert.ok(seen.has(need), `${need} must be a Tab stop on the level page`);

  // ---- the gate: the transport is dead until a prediction is committed --
  await page.evaluate('document.activeElement && document.activeElement.blur()');
  await press('r'); // the R accelerator — body focus, run()
  assert.strictEqual(
    await value("$('brun').classList.contains('on')"),
    false,
    'R must not run the machine behind the predict gate',
  );
  assert.strictEqual(await value("$('brun').disabled"), true, 'RUN is locked at boot');
  assert.strictEqual(await value("$('bstep').disabled"), true, 'CYCLE is locked with it');

  // ---- predict by keys: ←/→ + Enter (the C25 radio grammar) ------------
  await tabUntil(`${activeId} === 'lvcands'`, 'the predict group');
  assert.ok(
    (await value("$('statusline').textContent")).includes('predict'),
    'the status line narrates the predict group when it takes focus',
  );
  await press('ArrowRight'); // onto the second candidate
  assert.ok(
    await value(`document.querySelectorAll('#lvcands .lcand')[1].classList.contains('kc')`),
    '←/→ moves the predict cursor',
  );
  await press('Enter');
  await until('PioLevels.gateOpen(LEVEL, lvSession) === true', 'Enter to commit the prediction');
  assert.ok(
    await value(`document.querySelectorAll('#lvcands .lcand')[1].classList.contains('picked')`),
    'the committed candidate is marked picked',
  );
  await until("$('brun').disabled === false", 'the committed prediction to unlock RUN');

  // ---- the unlocked machine runs under the keys -------------------------
  await page.evaluate('document.activeElement && document.activeElement.blur()');
  await press('r');
  await until("$('brun').classList.contains('on') === true", 'R to start the machine');
  await press('r'); // toggle back to pause — the walk leaves a paused page
  await until("$('brun').classList.contains('on') === false", 'R to pause again');

  // ---- the listing is walkable, the editor never opens ------------------
  await tabUntil(`${activeId} === 'progrows'`, 'the listing');
  await press('ArrowDown');
  await press('ArrowDown');
  assert.strictEqual(
    await value("document.getElementById('progrows').getAttribute('aria-activedescendant')"),
    'pr2',
    '↑/↓ walks the row cursor on the level listing too',
  );
  await press('Enter');
  await type('set x, 3');
  assert.strictEqual(
    await value('RE.hidden'),
    true,
    'the row editor must not open in L0 — the opcode whitelist is empty',
  );
});

// C35 — the L1 walk: the delay cell IS the editor. The row editor never
// opens (authoring is L2's debut); Enter on the listing opens the row's
// delay cell instead, digits type ahead into it, Tab commits and crosses
// rows (the C25/C31 cell-crossing contract at one-cell grain), Esc
// cancels, and the committed [n] lands on the row's face.
test('the L1 walk: the delay cell is the whole editor, Tab crosses rows', async () => {
  await page.setViewport(1280, 800);
  await page.goto(`${baseUrl}/web/sm-view.html?level=l1`);
  await until('V.ready === true', 'the level page engine to boot');

  // ---- no orphan stops; no predict group (L1 never locks the gate) ------
  const stops = [];
  for (let i = 0; i < 10; i++) {
    await press('Tab');
    stops.push(await value(activeId));
  }
  const allowed = new Set(['brun', 'bstep', 'breset', 'progrows', 'BODY']);
  for (const s of stops)
    assert.ok(
      allowed.has(s),
      `orphan stop ${JSON.stringify(s)} — a locked panel left a focusable behind (${stops.join(', ')})`,
    );

  // ---- Enter opens the DELAY cell, not the row editor --------------------
  await tabUntil(`${activeId} === 'progrows'`, 'the listing');
  await press('Enter');
  await until(`${activeId} === 'dlycell'`, 'Enter to open the delay cell');
  assert.strictEqual(await value('RE.hidden'), true, 'the row editor stays shut in L1');

  // ---- digits type ahead; Tab commits and crosses to the next row -------
  await type('3');
  await press('Tab');
  await until(`${activeId} === 'dlycell'`, "Tab to cross into row 1's delay cell");
  assert.ok(
    (await value("document.querySelector('#pr0 .cdly').textContent")).includes('[3]'),
    "the committed delay is on the row's face",
  );
  await type('3');
  await press('Enter'); // commits; focus returns to the listing
  await until(`${activeId} === 'progrows'`, 'Enter to commit the cell');
  assert.ok(
    (await value("document.querySelector('#pr1 .cdly').textContent")).includes('[3]'),
    'row 1 carries its delay too',
  );

  // ---- Esc cancels: the row keeps what it had ---------------------------
  await press('Enter'); // kc still 1 — the cursor kept the editor's anchor
  await until(`${activeId} === 'dlycell'`, 'reopen the delay cell');
  await type('7');
  await press('Escape');
  await until(`${activeId} === 'progrows'`, 'Esc to cancel the cell');
  assert.ok(
    (await value("document.querySelector('#pr1 .cdly').textContent")).includes('[3]'),
    'a cancelled edit writes nothing',
  );

  // ---- Shift+Tab crosses up ----------------------------------------------
  await press('Enter');
  await until(`${activeId} === 'dlycell'`, "row 1's delay cell again");
  await press('Tab', { shift: true });
  await until(`${activeId} === 'dlycell'`, 'Shift+Tab to cross back up');
  assert.strictEqual(await value('kc'), 0, 'the crossing landed on row 0');
  await press('Escape');
  assert.strictEqual(await value("$('dlyedit').hidden"), true, 'the cell closes');
});

// C35 — the L2 walk: the row editor debuts in levels, ON THE LEASH. The
// empty listing authors from scratch under keys alone: type-ahead opens
// the editor, the mnemonic menu offers exactly the unlocked set (set —
// a locked mnemonic typed mid-word offers nothing), the side cell is
// absent from the Tab order (no side column until chapter 4), and Tab
// crosses from the instruction cell into the delay cell, then onward to
// the next row — the C25/C31 contract.
test('the L2 walk: the editor debuts leashed — set only, Tab crosses into the delay cell', async () => {
  await page.setViewport(1280, 800);
  await page.goto(`${baseUrl}/web/sm-view.html?level=l2`);
  await until('V.ready === true', 'the level page engine to boot');

  // ---- the listing boots empty and honest --------------------------------
  assert.strictEqual(
    await value("document.querySelectorAll('#progrows .prow.empty').length"),
    32,
    'from scratch: 32 honest · rows',
  );

  // ---- Enter opens the editor; the menu shows the leash ------------------
  await tabUntil(`${activeId} === 'progrows'`, 'the listing');
  await press('Enter');
  await until(`${activeId} === 'edittxt'`, 'Enter to open the row editor');
  assert.strictEqual(await value('RE.hidden'), false, 'the row editor opens in L2');
  const offered = await value(
    "[...document.querySelectorAll('#edcands .ecand')].map((e) => e.firstChild.textContent)",
  );
  assert.deepStrictEqual(offered, ['set'], 'the mnemonic menu offers exactly the unlocked set');

  // ---- author row 0: set pins, 1 (no delay) ------------------------------
  await type('set pins, 1');
  await press('Tab'); // the list is closed at a complete row: Tab crosses cells
  await until(`${activeId} === 'eddly'`, 'Tab to cross into the delay cell');
  await press('Tab'); // DLY's Tab hops to the next row's instruction cell
  await until(`${activeId} === 'edittxt'`, 'Tab to cross into row 1');

  // ---- author row 1: set pins, 0 [2] -------------------------------------
  await type('set pins, 0');
  await press('Tab');
  await until(`${activeId} === 'eddly'`, 'the delay cell of row 1');
  await type('2');
  await press('Enter'); // commits row 1 and hops to row 2 (list open on it)
  await until(`${activeId} === 'edittxt'`, 'Enter to commit and hop rows');
  await press('Escape'); // C31: the first Esc closes the completion list…
  await until("$('edpop').hidden === true", 'the list to close');
  await press('Escape'); // …the second stands the editor down
  await until(`${activeId} === 'progrows'`, 'Esc to stand down');
  assert.ok(
    (await value("document.querySelector('#pr0 .ins').textContent")).includes('set pins, 1'),
    'row 0 says what was typed',
  );
  assert.ok(
    (await value("document.querySelector('#pr1 .cdly').textContent")).includes('[2]'),
    'row 1 carries its delay',
  );

  // ---- the side cell is absent: no side column until chapter 4 -----------
  assert.strictEqual(
    await value("$('edside').offsetParent === null"),
    true,
    'the side cell leaves layout and Tab order both',
  );

  // ---- a locked mnemonic offers nothing ----------------------------------
  await press('Enter'); // the cursor sits on row 2 (the editor's anchor)
  await until(`${activeId} === 'edittxt'`, 'row 2 opens for authoring');
  await type('nop');
  await until("ED.value === 'nop'", 'the typed mnemonic to land');
  assert.strictEqual(
    await value("$('edpop').hidden"),
    true,
    'the locked mnemonic is never suggested — the menu stays shut',
  );
  await press('Escape');
});

// C36 — the L3 walk: jmp debuts on the leash. The boot ships L2's answer
// after the once-preamble; the player's move is the back edge. The menu
// grows to the chapter-1 vocabulary (jmp before set — the C32 order), the
// gutter-pick candidate appears at the empty target slot (typing digits
// dismisses it), and the committed jmp rides the row's face. The delay
// shave — the cost lesson's other half — edits through the row editor's
// own delay cell (Backspace, not a mouse).
test('the L3 walk: jmp debuts — the back edge authored under keys alone', async () => {
  await page.setViewport(1280, 800);
  await page.goto(`${baseUrl}/web/sm-view.html?level=l3`);
  await until('V.ready === true', 'the level page engine to boot');

  // ---- no orphan stops; the surface is chapter 0's plus nothing --------
  const stops = [];
  for (let i = 0; i < 10; i++) {
    await press('Tab');
    stops.push(await value(activeId));
  }
  const allowed = new Set(['brun', 'bstep', 'breset', 'progrows', 'BODY']);
  for (const s of stops)
    assert.ok(
      allowed.has(s),
      `orphan stop ${JSON.stringify(s)} — a locked panel left a focusable behind (${stops.join(', ')})`,
    );

  // ---- the boot's three rows are on their faces ------------------------
  assert.ok(
    (await value("document.querySelector('#pr0 .ins').textContent")).includes('set pins, 1'),
    'the preamble row is given',
  );
  assert.ok(
    (await value("document.querySelector('#pr0 .cdly').textContent")).includes('[7]'),
    'the preamble carries its once-flash delay',
  );

  // ---- row 3: the back edge. The menu offers the chapter-1 set --------
  await tabUntil(`${activeId} === 'progrows'`, 'the listing');
  await press('ArrowDown');
  await press('ArrowDown');
  await press('ArrowDown');
  await until('kc === 3', 'the cursor on row 3');
  await press('Enter');
  await until(`${activeId} === 'edittxt'`, 'Enter to open the row editor');
  const offered = await value(
    "[...document.querySelectorAll('#edcands .ecand')].map((e) => e.firstChild.textContent)",
  );
  assert.deepStrictEqual(offered, ['jmp', 'set'], 'the leash grows: jmp joins set');

  // ---- the empty target slot offers the gutter pick --------------------
  await type('jmp ');
  const pick = await value(
    "[...document.querySelectorAll('#edcands .ecand')].map((e) => e.firstChild.textContent)",
  );
  assert.ok(pick.includes('↦ pick row'), 'the gutter-pick candidate at the empty target slot');
  await type('1'); // a digit dismisses the pick and is the target
  await press('Enter'); // commits row 3, hops to row 4
  await until(`${activeId} === 'edittxt'`, 'Enter to commit and hop rows');
  await press('Escape'); // the fresh row's list closes…
  await until("$('edpop').hidden === true", 'the list to close');
  await press('Escape'); // …the second stands the editor down
  await until(`${activeId} === 'progrows'`, 'Esc to stand down');
  assert.ok(
    (await value("document.querySelector('#pr3 .ins').textContent")).includes('jmp 1'),
    'row 3 says jmp 1',
  );

  // ---- row 2: shave the delay — the jmp's cycle comes out of the wave --
  await press('ArrowUp'); // the cursor stood on row 4 (the hop's landing)
  await press('ArrowUp');
  await until('kc === 2', 'the cursor on row 2');
  await press('Enter');
  await until(`${activeId} === 'edittxt'`, 'row 2 opens for the delay edit');
  await press('Tab');
  await until(`${activeId} === 'eddly'`, 'Tab to cross into the delay cell');
  await press('Backspace');
  await type('1');
  await press('Enter'); // commits row 2, hops to row 3
  await until(`${activeId} === 'edittxt'`, 'Enter to commit and hop rows');
  await press('Escape');
  await until("$('edpop').hidden === true", 'the list to close');
  await press('Escape');
  await until(`${activeId} === 'progrows'`, 'Esc to stand down');
  assert.ok(
    (await value("document.querySelector('#pr2 .cdly').textContent")).includes('[1]'),
    "row 2's delay is now [1] — the jmp's clk paid for",
  );
});

// C36 — the L5 walk: the long blink authored under keys alone. The 1:3
// wave at 1/16 speed: high 16 of 64, and the 48-clk low split across two
// rows — no single delay cell can hold it. The ceiling is legible: a
// [48] commit does not assemble, the unbuilt bar says why, and the fix
// lands back on the row's face.
test('the L5 walk: the [31] ceiling refuses loudly, the split passes', async () => {
  await page.setViewport(1280, 800);
  await page.goto(`${baseUrl}/web/sm-view.html?level=l5`);
  await until('V.ready === true', 'the level page engine to boot');

  // ---- the listing boots empty and honest ------------------------------
  assert.strictEqual(
    await value("document.querySelectorAll('#progrows .prow.empty').length"),
    32,
    'from scratch: 32 honest · rows',
  );

  // ---- author rows 0 and 1 --------------------------------------------
  await tabUntil(`${activeId} === 'progrows'`, 'the listing');
  await press('Enter');
  await until(`${activeId} === 'edittxt'`, 'the editor opens on row 0');
  const offered = await value(
    "[...document.querySelectorAll('#edcands .ecand')].map((e) => e.firstChild.textContent)",
  );
  assert.deepStrictEqual(offered, ['jmp', 'set'], 'the chapter-1 vocabulary stays unlocked');
  await type('set pins, 1');
  await press('Tab');
  await until(`${activeId} === 'eddly'`, 'the delay cell of row 0');
  await type('15');
  await press('Enter'); // commit row 0, hop to row 1
  await until(`${activeId} === 'edittxt'`, 'Enter to commit and hop rows');
  await type('set pins, 0');
  await press('Tab');
  await until(`${activeId} === 'eddly'`, 'the delay cell of row 1');
  await type('31');
  await press('Enter'); // commit row 1, hop to row 2
  await until(`${activeId} === 'edittxt'`, 'row 2 opens');
  await type('set pins, 0');
  await press('Tab');
  await until(`${activeId} === 'eddly'`, 'the delay cell of row 2');

  // ---- the ceiling: 48 does not fit the 5-bit field ---------------------
  await type('48');
  await press('Enter'); // the refusal: the edit stays open, never lands
  await until(`${activeId} === 'eddly'`, 'the refused commit keeps the cell open');
  const why = String(await value('RE.dataset.status'));
  assert.match(why, /48 won't fit/, 'the refusal names the value');
  assert.match(why, /0\.\.31/, 'the refusal names the 5-bit budget');

  // ---- the fix: 16 clk of low in this row, not 49 ----------------------
  await press('Backspace');
  await press('Backspace');
  await type('15');
  await press('Enter'); // commit, hop to row 3
  await until(`${activeId} === 'edittxt'`, 'Enter to commit the fix');
  await press('Escape');
  await until("$('edpop').hidden === true", 'the list to close');
  await press('Escape');
  await until(`${activeId} === 'progrows'`, 'Esc to stand down');
  assert.strictEqual(await value("$('unbuilt').hidden"), true, 'the split assembles clean');
  assert.ok(
    (await value("document.querySelector('#pr2 .cdly').textContent")).includes('[15]'),
    'row 2 carries its delay',
  );
});

// C37 — the L4 walk: the scrambler. Rows shuffled; the task is reordering,
// and the listing gesture is the row TRADE: Enter marks a row, the arrows
// walk, Enter on another row trades their contents — the row editor never
// opens and letters author nothing (the given rows are the whole
// vocabulary). The walk also drives the level's own solve: the trapped
// flash (row 2) trades out of the loop with row 0's blink row, the one
// deliberate move the wave asks for.
test('the L4 walk: the scrambler — mark and trade rows, the editor never opens', async () => {
  await page.setViewport(1280, 800);
  await page.goto(`${baseUrl}/web/sm-view.html?level=l4`);
  await until('V.ready === true', 'the level page engine to boot');

  // ---- no orphan stops; the surface is chapter 1's, nothing added -------
  const stops = [];
  for (let i = 0; i < 10; i++) {
    await press('Tab');
    stops.push(await value(activeId));
  }
  const allowed = new Set(['brun', 'bstep', 'breset', 'progrows', 'BODY']);
  for (const s of stops)
    assert.ok(
      allowed.has(s),
      `orphan stop ${JSON.stringify(s)} — a locked panel left a focusable behind (${stops.join(', ')})`,
    );

  // ---- the shuffled boot is on the faces: the flash trapped mid-loop ----
  assert.ok(
    (await value("document.querySelector('#pr0 .ins').textContent")).includes('set pins, 1'),
    'a blink row sits at address 0',
  );
  assert.ok(
    (await value("document.querySelector('#pr2 .cdly').textContent")).includes('[7]'),
    'the once-flash is trapped INSIDE the loop (row 2)',
  );
  assert.ok(
    (await value("$('progrows').dataset.status")).includes('trade'),
    'the listing narrates the trade grammar, not the editor',
  );

  // ---- Enter marks; the editor never opens; letters author nothing ------
  await tabUntil(`${activeId} === 'progrows'`, 'the listing');
  await press('Enter');
  await until('swRow === 0', 'Enter to mark row 0');
  assert.ok(
    await value("document.querySelector('#pr0').classList.contains('swm')"),
    'the marked row carries the mark',
  );
  assert.strictEqual(
    await value('RE.hidden'),
    true,
    'the row editor must not open in the scrambler',
  );
  await type('set x, 3');
  assert.strictEqual(
    await value('RE.hidden'),
    true,
    'type-ahead never opens the editor — the vocabulary is the given rows',
  );
  await press('Enter'); // Enter on the marked row unmarks
  await until('swRow === -1', 'Enter on the marked row to unmark');
  await press('Escape'); // Esc on no mark: nothing stands down (the editor stays shut)
  assert.strictEqual(await value('RE.hidden'), true, 'Esc with no mark changes nothing');

  // ---- the solve: mark row 0, walk to the trapped flash, trade ----------
  await press('Enter');
  await until('swRow === 0', 'row 0 marked for the trade');
  await press('ArrowDown');
  await press('ArrowDown');
  await until('kc === 2', 'the cursor on the trapped flash');
  await press('Enter'); // the trade
  await until('swRow === -1', 'the trade spends the mark');
  assert.strictEqual(
    await value('ROWS[0]'),
    'set pins, 1 [7]',
    'the flash now runs once, at address 0',
  );
  assert.strictEqual(
    await value('ROWS[2]'),
    'set pins, 1 [1]',
    'the blink row traded into the loop',
  );
  assert.ok(
    await value('BUILT.slice(0, 5).every((w) => w)'),
    'the trade reordered five rows, never dropped one',
  );
  assert.ok(
    !(await value("/ERROR/.test(document.querySelector('footer').textContent)")),
    'the traded program assembled and loaded without an engine error',
  );

  // ---- an empty row is not vocabulary: Enter marks nothing there --------
  for (let i = 0; i < 7; i++) await press('ArrowDown');
  await until('kc === 9', 'the cursor on an empty row');
  await press('Enter');
  assert.strictEqual(await value('swRow'), -1, 'a `·` row cannot be marked — it is not vocabulary');

  // ---- a mark meeting a `·` row stands down (never a dead gesture) ------
  for (let i = 0; i < 5; i++) await press('ArrowUp');
  await until('kc === 4', 'the cursor on the jmp row');
  await press('Enter');
  await until('swRow === 4', 'the jmp row marked');
  await press('ArrowDown');
  await press('ArrowDown');
  await until('kc === 6', 'the cursor on an empty row, mark standing');
  await press('Enter'); // a trade with a `·` row cannot happen
  await until('swRow === -1', 'the mark stands down instead of hanging');
  assert.ok(
    (await value("document.querySelector('#pr4').classList.contains('swm')")) === false,
    'the row the mark stood on loses it',
  );
});

// C39 — the L6 walk: the reading slice. The level surface grows the
// reading leg — the ISR panel and the RX half of the fifo row are now
// Tab stops (their controls, the drain buttons), while the TX half,
// the pull connector and the OSR stay absent (absence covers Tab order
// too). The predict card is the word face — the same C25 radio grammar
// over bit-word candidates — and predict→run means the editor never
// opens: letters author nothing, the given program is the whole
// machine.
test('the L6 walk: the reading debut is keyboard-reachable, the word face commits, no editor', async () => {
  await page.setViewport(1280, 800);
  await page.goto(`${baseUrl}/web/sm-view.html?level=l6`);
  await until('V.ready === true', 'the level page engine to boot');

  // ---- no orphan stops: the cycle covers the reading surface ---------
  const stops = [];
  for (let i = 0; i < 16; i++) {
    await press('Tab');
    stops.push(await value(activeId));
  }
  const allowed = new Set([
    'breset',
    'lvcands',
    'progrows',
    'BODY',
    'isrviz',
    'aptg2',
    'spin-pushthr', // the ISR panel's controls
    'bdrain',
    'bdrainall', // the rx half's drains
  ]);
  for (const s of stops)
    assert.ok(
      allowed.has(s),
      `orphan stop ${JSON.stringify(s)} — a locked panel left a focusable behind (${stops.join(', ')})`,
    );
  for (const need of ['breset', 'lvcands', 'progrows', 'bdrain', 'isrviz'])
    assert.ok(new Set(stops).has(need), `${need} must be a Tab stop on the L6 page`);

  // ---- the gate: the transport is dead until the prediction commits --
  await page.evaluate('document.activeElement && document.activeElement.blur()');
  await press('r');
  assert.strictEqual(
    await value("$('brun').classList.contains('on')"),
    false,
    'R must not run the machine behind the predict gate',
  );

  // ---- the word face by keys: ←/→ + Enter (the radio grammar) --------
  await tabUntil(`${activeId} === 'lvcands'`, 'the predict group');
  assert.ok(
    (await value("$('statusline').textContent")).includes('predict'),
    'the status line narrates the predict group when it takes focus',
  );
  assert.strictEqual(
    await value("document.querySelectorAll('#lvcands .lcand-bits .bit').length"),
    96,
    'three candidates of one 32-bit word each (the bits grammar, labeled ISR)',
  );
  await press('ArrowRight'); // onto the second candidate
  assert.ok(
    await value(`document.querySelectorAll('#lvcands .lcand')[1].classList.contains('kc')`),
    '←/→ moves the predict cursor over the word candidates',
  );
  await press('Enter');
  await until('PioLevels.gateOpen(LEVEL, lvSession) === true', 'Enter to commit the prediction');
  await until("$('brun').disabled === false", 'the committed prediction to unlock RUN');

  // ---- the unlocked machine runs; the given draws on the wave --------
  await page.evaluate('document.activeElement && document.activeElement.blur()');
  await press('r');
  await until("$('brun').classList.contains('on') === true", 'R to start the machine');
  await until(
    "document.querySelectorAll('#wavesvg .stimrow').length === 1",
    'the stimulus row to draw',
  );
  await press('r'); // pause — the walk leaves a paused page
  await until("$('brun').classList.contains('on') === false", 'R to pause again');

  // ---- the drain buttons are live stops (keys operate the surface) ---
  await tabUntil(`${activeId} === 'bdrain'`, 'the drain button');
  await press('Enter');
  assert.ok(
    !(await value("/ERROR/.test(document.querySelector('footer').textContent)")),
    'the drain on an empty mirror is a no-op, never an engine error',
  );

  // ---- predict→run: the row editor never opens -----------------------
  await tabUntil(`${activeId} === 'progrows'`, 'the listing');
  await press('ArrowDown');
  await press('Enter');
  await type('set x, 3');
  assert.strictEqual(
    await value('RE.hidden'),
    true,
    'the row editor must not open in L6 — the given program is the whole machine',
  );
  assert.ok(
    !(await value("/ERROR/.test(document.querySelector('footer').textContent)")),
    'the page walked the whole loop without an engine error',
  );
});

// C40 — the L7 walk: the echo authored under keys alone. The condition
// menu debuts `jmp pin` (the pin condition unlocks here — the chapter-1
// jmps were unconditional, their menus offered no condition at all), the
// delays carry the bit-time gate (each set row holds its bit a whole
// 8-clk bit-time), and the honest solve is 3 words — the high path rides
// the `·` row home. The run pays it off: the frame map rides the wave
// under the uart lens, the decode judge passes, and par names its own
// clock (clk/bit).
test('the L7 walk: jmp pin debuts in the menu, the 3-word echo solves', async () => {
  await page.setViewport(1280, 800);
  await page.goto(`${baseUrl}/web/sm-view.html?level=l7`);
  await until('V.ready === true', 'the level page engine to boot');

  // ---- no orphan stops: L6's reading surface, no predict card --------
  const stops = [];
  for (let i = 0; i < 12; i++) {
    await press('Tab');
    stops.push(await value(activeId));
  }
  const allowed = new Set([
    'brun',
    'bstep',
    'breset',
    'progrows',
    'BODY',
    'isrviz',
    'aptg2',
    'spin-pushthr',
    'bdrain',
    'bdrainall',
  ]);
  for (const s of stops)
    assert.ok(
      allowed.has(s),
      `orphan stop ${JSON.stringify(s)} — a locked panel left a focusable behind (${stops.join(', ')})`,
    );

  // ---- the listing boots empty; the menu offers the echo vocabulary ---
  assert.strictEqual(
    await value("document.querySelectorAll('#progrows .prow.empty').length"),
    32,
    'from scratch: 32 honest · rows',
  );
  await tabUntil(`${activeId} === 'progrows'`, 'the listing');
  await press('Enter');
  await until(`${activeId} === 'edittxt'`, 'the editor opens on row 0');
  assert.deepStrictEqual(
    (
      await value(
        "[...document.querySelectorAll('#edcands .ecand')].map((e) => e.firstChild.textContent)",
      )
    ).filter((t) => !t.startsWith('↦')),
    ['jmp', 'in', 'out', 'set'],
    'the reading vocabulary: the chapter-1 set grows in and out',
  );

  // ---- row 0: the condition menu offers exactly `pin` ------------------
  await type('jmp ');
  const offered = await value(
    "[...document.querySelectorAll('#edcands .ecand')].map((e) => e.firstChild.textContent)",
  );
  assert.ok(offered.includes('pin'), 'the pin condition debuts at the condition slot');
  assert.ok(offered.includes('↦ pick row'), 'the gutter pick stays (no condition = always)');
  await press('Tab'); // accept `pin` — the canonical ', ' separator lands
  await until("ED.value === 'jmp pin, '", 'Tab to accept the pin condition');
  await type('2');
  await press('Enter'); // commit row 0, hop to row 1
  await until(`${activeId} === 'edittxt'`, 'Enter to commit and hop rows');
  assert.ok(
    (await value("document.querySelector('#pr0 .ins').textContent")).includes('jmp pin, 2'),
    'row 0 carries the first conditional',
  );

  // ---- rows 1-2: the level holds, one bit-time each --------------------
  await type('set pins, 0');
  await press('Tab');
  await until(`${activeId} === 'eddly'`, 'the delay cell of row 1');
  await type('6');
  await press('Enter');
  await until(`${activeId} === 'edittxt'`, 'row 2 opens');
  await type('set pins, 1');
  await press('Tab');
  await until(`${activeId} === 'eddly'`, 'the delay cell of row 2');
  await type('5');
  await press('Enter');
  await until(`${activeId} === 'edittxt'`, 'Enter to commit row 2');
  await press('Escape');
  await until("$('edpop').hidden === true", 'the list to close');
  await press('Escape');
  await until(`${activeId} === 'progrows'`, 'Esc to stand down');
  assert.strictEqual(await value("$('unbuilt').hidden"), true, 'the echo assembles clean');

  // ---- the run: the stimulus draws, the frame map rides ----------------
  // (the walk's engine is the fake ABI — no PIO core, so no live frame;
  // the judge itself is engine-side-gated by levels.test.js over these
  // very goldens. The face is gated here the layout leg's way: feed the
  // shipped judge the committed golden series through the page's own
  // levelJudge and watch the band answer.)
  await page.evaluate("$('speed').value = '8'"); // ×16 — the walk's run moves briskly
  await page.evaluate('document.activeElement && document.activeElement.blur()');
  await press('r');
  await until("$('brun').classList.contains('on') === true", 'R to start the machine');
  await until(
    "document.querySelectorAll('#wavesvg .stimrow').length === 2",
    'the two stimulus rows to draw (enable and data)',
  );
  // the frame map rides under the uart lens the level boots with
  assert.strictEqual(await value("$('framemap').hidden"), false, 'the frame map lays out');
  assert.strictEqual(
    await value("document.querySelectorAll('#fmcells .fmcell').length"),
    10,
    'START/D0..D7/STOP — the subgoal labels',
  );
  // the PASS face over the golden series: the verdict word, the par
  // reveal naming its own clock, the pause on the payoff frame. Pause
  // FIRST (the L6 walk's discipline): while the run ticks, every live
  // state reply re-judges the fake engine's empty wave and would
  // overwrite the fed verdict mid-assert — C41's auto-reload made the
  // reply stream long enough to lose that race reliably
  await press('r');
  await until(
    "$('brun').classList.contains('on') === false",
    'R to pause before feeding the judge',
  );
  // a settle beat on the NODE side (Runtime.evaluate does not await
  // promises, so a page-side sleep is a no-op): the last in-flight
  // state reply lands well inside it — after it, the fed verdict is
  // the page's last word and the assert reads a stable face
  await new Promise((r) => setTimeout(r, 350));
  const L7G = JSON.parse(fs.readFileSync(path.join(__dirname, 'levels-golden.json'), 'utf8'));
  const series = L7G.levels.l7.cases.find((c) => c.name === 'reference').series;
  await page.evaluate(
    `levelJudge({...V.state, wave: {` +
      `pins: (${JSON.stringify(series)}).split('').map(Number),` +
      `tags: [], startCycle: 0, stim: []}})`,
  );
  await until("$('lvpass').hidden === false", 'the decode judge to pass the golden echo');
  assert.match(
    await value("$('lvverdict').textContent"),
    /frame — PASS/,
    'the pass word names the frame receiver',
  );
  assert.ok(
    (await value("$('lvpar').textContent")).includes('clk/bit'),
    'par names its own clock — bit-times, not cycles',
  );
  assert.ok(
    !(await value("/ERROR/.test(document.querySelector('footer').textContent)")),
    'the page walked the whole loop without an engine error',
  );
});

// C41 — the L8 walk: the gather authored under keys alone. The x--
// condition debuts in the menu (the fencepost's own slot — the
// chapter-1 jmps were unconditional, L7's tested the world, this one
// counts), set arms the stepper with a plain 5-bit immediate, and the
// honest solve is 4 words: set x, 7 — one LESS than the bit count,
// because jmp x-- tests the value BEFORE it decrements (SPEC-3.1-4).
// The run pays it off: the tick pattern draws on the stimulus row, the
// X/Y panel is on the page (the stepper's debut — no new Tab stop, a
// display), and the rx judge passes the four gathered words.
test('the L8 walk: jmp x-- debuts in the menu, the 4-word gather solves', async () => {
  await page.setViewport(1280, 800);
  await page.goto(`${baseUrl}/web/sm-view.html?level=l8`);
  await until('V.ready === true', 'the level page engine to boot');

  // ---- no orphan stops: L7's make surface, the stepper adds no stop --
  const stops = [];
  for (let i = 0; i < 12; i++) {
    await press('Tab');
    stops.push(await value(activeId));
  }
  const allowed = new Set([
    'brun',
    'bstep',
    'breset',
    'progrows',
    'BODY',
    'isrviz',
    'aptg2',
    'spin-pushthr',
    'bdrain',
    'bdrainall',
  ]);
  for (const s of stops)
    assert.ok(
      allowed.has(s),
      `orphan stop ${JSON.stringify(s)} — a locked panel left a focusable behind (${stops.join(', ')})`,
    );

  // ---- the listing boots empty; the menu offers the gather vocabulary -
  assert.strictEqual(
    await value("document.querySelectorAll('#progrows .prow.empty').length"),
    32,
    'from scratch: 32 honest · rows',
  );
  await tabUntil(`${activeId} === 'progrows'`, 'the listing');
  await press('Enter');
  await until(`${activeId} === 'edittxt'`, 'the editor opens on row 0');
  assert.deepStrictEqual(
    (
      await value(
        "[...document.querySelectorAll('#edcands .ecand')].map((e) => e.firstChild.textContent)",
      )
    ).filter((t) => !t.startsWith('↦')),
    ['jmp', 'in', 'push', 'set'],
    'the gather vocabulary: the reading leg grows push',
  );

  // ---- row 0: the stepper arms with a 5-bit immediate ------------------
  await type('set x, 7');
  await press('Enter'); // commit row 0, hop to row 1
  await until(`${activeId} === 'edittxt'`, 'Enter to commit and hop rows');

  // ---- row 1: one bit per lap ------------------------------------------
  await type('in pins, 1');
  await press('Enter');
  await until(`${activeId} === 'edittxt'`, 'row 2 opens');

  // ---- row 2: the condition menu offers exactly `x--` ------------------
  await type('jmp ');
  const offered = await value(
    "[...document.querySelectorAll('#edcands .ecand')].map((e) => e.firstChild.textContent)",
  );
  assert.ok(offered.includes('x--'), 'the decrement condition debuts at the condition slot');
  assert.ok(offered.includes('↦ pick row'), 'the gutter pick stays (no condition = always)');
  assert.ok(!offered.includes('pin'), "L7's pin condition is not this task's");
  await press('Tab'); // accept `x--` — the canonical ', ' separator lands
  await until("ED.value === 'jmp x--, '", 'Tab to accept the x-- condition');
  await type('1'); // the back edge targets the in row
  await press('Enter');
  await until(`${activeId} === 'edittxt'`, 'row 3 opens');

  // ---- row 3: the hand-off ------------------------------------------------
  await type('push block');
  await press('Enter');
  await until(`${activeId} === 'edittxt'`, 'Enter to commit row 3');
  await press('Escape');
  await until("$('edpop').hidden === true", 'the list to close');
  await press('Escape');
  await until(`${activeId} === 'progrows'`, 'Esc to stand down');
  assert.strictEqual(await value("$('unbuilt').hidden"), true, 'the gather assembles clean');

  // ---- the run: the tick pattern draws, the stepper's page holds ---------
  // (the walk's engine is the fake ABI — no PIO core, so no live gather;
  // the judge itself is engine-side-gated by levels.test.js over these
  // very goldens. The face is gated the layout leg's way: feed the
  // shipped judge the committed golden words through the page's own
  // levelJudge and watch the band answer.)
  await page.evaluate("$('speed').value = '8'"); // ×16 — the walk's run moves briskly
  await page.evaluate('document.activeElement && document.activeElement.blur()');
  await press('r');
  await until("$('brun').classList.contains('on') === true", 'R to start the machine');
  await until(
    "document.querySelectorAll('#wavesvg .stimrow').length === 1",
    'the stimulus row to draw (the tick pattern)',
  );
  // the stepper's debut: the X/Y panel lays out beside the gather
  const xyBox = await value(
    "(function(){ const b = document.querySelector('#xy')?.getBoundingClientRect(); return b && b.width > 80; })()",
  );
  assert.ok(xyBox, '#xy has a box — the stepper is on the page');
  // the delay column stays shut: the lesson is structure, not delay
  assert.strictEqual(
    await value("document.getElementById('program').classList.contains('col-delay')"),
    false,
    'the delay column stays shut on L8',
  );
  // the PASS face over the golden words: the verdict word, the par
  // reveal naming its own clock (clks/bit — the loop's steady rate).
  // Pause first (the L7 leg's race): the run's live replies re-judge
  // the fake engine's empty rxSeen and would overwrite the fed verdict
  await press('r');
  await until(
    "$('brun').classList.contains('on') === false",
    'R to pause before feeding the judge',
  );
  // a settle beat on the NODE side (Runtime.evaluate does not await
  // promises, so a page-side sleep is a no-op): the last in-flight
  // state reply lands well inside it — after it, the fed verdict is
  // the page's last word and the assert reads a stable face
  await new Promise((r) => setTimeout(r, 350));
  const L8G = JSON.parse(fs.readFileSync(path.join(__dirname, 'levels-golden.json'), 'utf8'));
  const rx = L8G.levels.l8.cases.find((c) => c.name === 'reference').rx;
  await page.evaluate(
    `levelJudge({...V.state, sms: [{...V.state.sms[0], rxSeen: (${JSON.stringify(rx)})}]})`,
  );
  await until("$('lvpass').hidden === false", 'the rx judge to pass the golden gather');
  assert.match(
    await value("$('lvverdict').textContent"),
    /rx — PASS/,
    'the pass word names the rx receiver',
  );
  assert.ok(
    (await value("$('lvpar').textContent")).includes('clk/bit'),
    'par names its own clock — clks/bit, the reading levels' + "' own axis",
  );
  assert.ok(
    !(await value("/ERROR/.test(document.querySelector('footer').textContent)")),
    'the page walked the whole loop without an engine error',
  );
});

// ---- the C42 landing leg ------------------------------------------------
// The campaign map (web/index.html) is its own page: no engine boot, so
// this walk needs no fake engine — it drives the map's C25
// listing-as-listbox grammar verbatim (one Tab stop, ↑/↓ clamp-walk,
// Enter opens) over a SEEDED campaign (chapters 0–1 solved, frontier
// L6 — the mock-up round's own posture). The level keys are snapshotted
// before and restored after: the earlier walks' own sessions must not
// leak in, and this seed must not leak out into any later leg.
test('the landing walk: one stop for the map, arrows walk, Enter opens, the sandbox reachable', async () => {
  await page.setViewport(1280, 800);
  // seed on the origin first (a page must be open for localStorage)
  await page.goto(`${baseUrl}/web/index.html`);
  const snapshot = await page.evaluate(`(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith('vibe-pio-level-')) out[k] = localStorage.getItem(k);
    }
    localStorage.clear();
    return out;
  })()`);
  const seed = await page.evaluate(`(() => {
    for (const id of ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'])
      localStorage.setItem('vibe-pio-level-' + id, JSON.stringify({ solved: true }));
    return true;
  })()`);
  assert.ok(seed);
  try {
    await page.goto(`${baseUrl}/web/index.html`);
    await until("document.getElementById('map')?.children.length > 0", 'the map to build');

    // one Tab stop for the whole page: the listbox host, and nothing
    // else focusable in the DOM
    const stops = await page.evaluate(
      `document.querySelectorAll('a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])').length`,
    );
    assert.strictEqual(stops, 1, "the map is the page's only Tab stop");
    await press('Tab');
    assert.strictEqual(await value(activeId), 'map', 'Tab lands on the map host');

    // the cursor boots on the frontier row (Enter at first focus opens
    // the next level) and the status line narrates it
    assert.strictEqual(
      await value("document.getElementById('map').getAttribute('aria-activedescendant')"),
      'row-l6',
      'the cursor boots on the frontier row',
    );
    assert.ok(
      await value("document.getElementById('row-l6').classList.contains('kc')"),
      'the amber cursor marks the frontier row',
    );
    assert.match(
      await value("document.getElementById('statusline').textContent"),
      /the next level/,
      'the status line narrates the frontier',
    );

    // ↑ walks into the solved chapter: par on the face, Enter replays
    await press('ArrowUp');
    assert.strictEqual(
      await value("document.getElementById('map').getAttribute('aria-activedescendant')"),
      'row-l5',
      '↑ moves the cursor off the frontier',
    );
    await press('Enter');
    await until(
      `location.pathname.endsWith('sm-view.html') && location.search === '?level=l5'`,
      'Enter on a solved row to open the level',
    );

    // back to the map (the seed persists on the origin)
    await page.goto(`${baseUrl}/web/index.html`);
    await until("document.getElementById('map')?.children.length > 0", 'the map to rebuild');
    await press('Tab');

    // a dim row names the future but does not open: walk to L7 (one
    // down from the booted frontier), Enter, and the page stays put
    await press('ArrowDown');
    assert.strictEqual(
      await value("document.getElementById('map').getAttribute('aria-activedescendant')"),
      'row-l7',
      'the cursor walks a dim row',
    );
    assert.ok(
      await value("document.getElementById('row-l7').classList.contains('ahead')"),
      'L7 past the frontier is dim-but-named',
    );
    await press('Enter');
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(
      await value("location.pathname.endsWith('index.html')"),
      'Enter on a dim row never navigates',
    );

    // the standing row: clamp-walk to the end, the sandbox answers
    for (let i = 0; i < 12; i++) await press('ArrowDown');
    assert.strictEqual(
      await value("document.getElementById('map').getAttribute('aria-activedescendant')"),
      'row-sandbox',
      'the walk clamps on the sandbox standing row',
    );
    assert.match(
      await value("document.getElementById('statusline').textContent"),
      /the sandbox/,
      'the sandbox row narrates itself',
    );
    await press('Enter');
    await until(
      `location.pathname.endsWith('sm-view.html') && location.search === ''`,
      'Enter on the sandbox row to open the sandbox',
    );
  } finally {
    // restore the walks' own sessions whatever happened above
    await page.evaluate(`((snap) => {
      const keep = Object.keys(localStorage).filter((k) => k.startsWith('vibe-pio-level-'));
      for (const k of keep) localStorage.removeItem(k);
      for (const [k, v] of Object.entries(snap)) localStorage.setItem(k, v);
    })(${JSON.stringify(snapshot)})`);
  }
});

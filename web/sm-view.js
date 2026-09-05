// sm-view.js — the C21 sandbox SM view client logic (KANBAN
// C18/C19/C21/C22; C24 grows it to the four-machine playground; C25
// adds the keyboard surface: keys owned by focus — the accelerators on
// body focus only, the listing as a listbox, every arrow group one Tab
// stop with an internal cursor, Alt+letter mnemonics, the focus-tracking
// status line; C32's completion slot model lives in row-complete.js —
// the row editor's suggestions are module logic, not DOM glue).
//
// Every machine value rendered here (pins, the four PC cursors, phases,
// X/Y, OSR/ISR, counters, FIFO levels, IRQ flags, pad ownership) comes
// from the wasm engine's per-clk state snapshot, posted by the Web
// Worker (engine-worker.js / engine-driver.js — the CI-gated core).
// What stays local is presentation: the canonical listing display (C19:
// derived by disassembling the loaded words through pio-asm.js under the
// CURRENT ds-field allocation — per-SM since C24, so the listing
// re-decodes under the SELECTED machine's split — and committed edits
// re-assemble under it — the new build is patched into the live engine
// one rendered clk per changed word), the machine selector (the detail
// panes — exec, registers, inspector, drawn config, feed/drain — all
// follow one selected SM), the register inspector (the datasheet map —
// every field readable and settable; settable
// config fields go through the driver's overlay as queued reg writes to
// the selected SM's window), the pin I/O strip (drive latches + the
// pattern generator + engine output ownership — the colored corner is
// the last SM to write the pin, CC-7), the RX drain panel, the monitor
// lens (the mode select in the exec title; the pin picked by the wave
// row's own drawn stepper pair — C28), and the persistence glue
// (localStorage autosave + JSON
// export/import of the stored-program format; the serializer itself is
// pure driver code, CI-checked).
'use strict';

const $ = (id) => document.getElementById(id); // declared first: the transport
// wiring below uses it at top level

// ================= the sandbox state (the view's copy) ==================
// Boot: localStorage autosave if present, else EMPTY (all-zero memory —
// the jmp-0 park on four cursors). The old level-02 uart_tx is the
// loadable demo.
const SAVE_KEY = 'vibe-pio-sandbox';
const VD = VibeDriver;

// ---- the level shell (C34) ----------------------------------------------
// ?level=<id> turns the sandbox into a level: the definition registered
// from web/levels/<id>.js (the HTML's loader script runs it before this
// file), the surface gates by ABSENCE (locked panels leave layout AND
// Tab order — the walk finds no orphan stops), the program boots from
// the level (never the autosave), the lens pins to the profile's pin,
// and the monitor becomes the judge. LEVEL is null in the sandbox and
// every hook below no-ops there. Module logic (the judge, the gate, the
// surface table) lives in levels.js; this file is the glue.
const LEVEL = PioLevels.active();
let LVSURF = null; // the level's unlocked key set (null = sandbox: all)
const lvUnlock = (key) => !LEVEL || (LVSURF ? LVSURF.has(key) : true);

// per-level session: the predict commit and the solve persist (a
// reload never re-punishes; re-runs never re-lock)
const lvKey = (id) => `vibe-pio-level-${id}`;
let lvSession = {};
function lvLoad(id) {
  if (!LEVEL) return {};
  try {
    return JSON.parse(localStorage.getItem(lvKey(id))) || {};
  } catch {
    return {};
  }
}
function lvSave() {
  if (!LEVEL) return;
  try {
    localStorage.setItem(lvKey(LEVEL.id), JSON.stringify(lvSession));
  } catch {
    /* private mode: the session lives for this page only */
  }
}

function savedState() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return VD.parseState(JSON.parse(raw));
  } catch (e) {
    console.warn('autosave unreadable — booting empty', e);
    return null;
  }
}

// A level boots from its own definition — words assembled from the
// canonical listing under the level's own side-set context, overlay
// merged over the hardware reset (parseState does the validating).
let curState = LEVEL ? PioLevels.programState(LEVEL) : savedState() || VD.newState(); // the view's stored-program copy

// Absence first: the gated panels leave the page (and the Tab order)
// before the first build/render, so the boot-measured geometry is the
// level's own.
if (LEVEL) {
  LVSURF = PioLevels.applySurface(document, LEVEL);
  $('savestate').textContent = 'off';
  // the listing's status narrates the level's own gestures: C35's L1
  // edits the delay cell (Enter or a digit), L2+ edits rows (the row
  // editor is authoring's debut), L0 only walks
  $('progrows').dataset.status = LEVEL.opcodes.length
    ? 'listing: ↑/↓ rows · Enter or a letter edits the row'
    : lvUnlock('delayCol')
      ? 'listing: ↑/↓ rows · Enter or a digit edits the [delay] cell — the instruction stays as given'
      : 'listing: ↑/↓ rows — authoring arrives in a later level';
  // the chrome names the level, not the sandbox (nothing on the page
  // may claim features the level has not taught)
  document.title = `vibe-pio // levels — ${LEVEL.id.toUpperCase()} ${LEVEL.name}`;
  document.querySelector('#titlebar .caption').innerHTML =
    `vibe-pio — level <b>${LEVEL.id.toUpperCase()} · ${esc(LEVEL.name)}</b>` +
    `<span class="tail"> · chapter ${LEVEL.chapter}</span>`;
  document.querySelector('#program .ptitle .aux').innerHTML =
    'canonical C12 · <b id="usedct">0/32</b> used';
  // the lens is pinned by the profile: the pin NUMBER stays on the wave
  // row's face (C29 legibility), the steppers leave with the Tab stop
  $('wavelabel').childNodes[0].nodeValue = `gpio ${LEVEL.profile.pin} `;
}

// The selected machine: the detail panes' SM. curSm/1..3 switch it; the
// wrap arc, ds allocator, pin-mapping tags and listing decode context
// all follow (each SM owns its config overlay).
let curSm = 0;
function selectSm(i) {
  if (i === curSm) return;
  curSm = i;
  // the local overlay mirror switches instantly; the worker's state
  // reply confirms (and the split-change check re-decodes the listing)
  const prev = OV;
  OV = overlayOf(curSm);
  syncAsmContext();
  const splitKey = (ov) => `${ov.pinctrl.ssCnt}/${ov.execctrl.sideEn}`;
  if (splitKey(prev) !== splitKey(OV)) rebuildListing();
  else buildProgram();
  renderSms(V.state);
  render(V.state);
  post({ cmd: 'select', sm: curSm });
}
const overlayOf = (i) => {
  const sm = curState.sms[i];
  return {
    clkdiv: { ...sm.clkdiv },
    pinctrl: { ...sm.pinctrl },
    execctrl: { ...sm.execctrl },
    shiftctrl: { ...sm.shiftctrl },
  };
};

// The authored .side_set context the listing assembles/disassembles
// under: it FOLLOWS the selected SM's overlay split (PINCTRL.SIDESET_COUNT
// + EXECCTRL.SIDE_EN — the ds slider and the inspector edit the same
// fields), so committed rows and that machine's re-decode always agree.
const ASM_PROG = PioAsm.createProgram('sandbox');
let BUILT = curState.words.slice(); // the image the engine runs (C19 patch target)
let lensPin = 0; // wave + lens target (the lens selector moves it)

// ds-field allocation, derived from the selected SM's overlay (SPEC-4-1..3)
const ssCntOf = (ov) => ov.pinctrl.ssCnt;
const sideEnOf = (ov) => ov.execctrl.sideEn;
const allocOf = (ov) => {
  const cnt = ssCntOf(ov);
  return { sideBits: Math.max(0, cnt - (sideEnOf(ov) ? 1 : 0)), opt: sideEnOf(ov) && cnt > 0 };
};
const dsTotal = () => {
  const a = allocOf(OV);
  return a.sideBits + (a.opt ? 1 : 0);
};
const maxDelay = () => (1 << (5 - dsTotal())) - 1;

// the overlay mirror (kept in step with every worker 'state' reply —
// the driver's ov of the SELECTED SM is the truth; this local copy
// renders between clks)
let OV = overlayOf(curSm);

function wordsToRows(words) {
  const a = allocOf(OV);
  const ssCnt = a.sideBits + (a.opt ? 1 : 0);
  // a 0 word is untouched memory (the jmp-0 park) — rendered as empty.
  // A word whose ds bits alias under the CURRENT split (e.g. a delay
  // budget authored under fewer side bits) has no canonical listing —
  // the marker row shows the raw bits and re-assembles to them (the
  // stored words are the truth; the listing is a view).
  return words.map((w) => {
    if (!w) return '';
    try {
      return PioAsm.disassemble(w, a.opt && a.sideBits > 0, ssCnt);
    } catch {
      return `«${w.toString(16).padStart(4, '0').toUpperCase()}»`;
    }
  });
}
const RAW_ROW = /^«([0-9A-F]{4})»$/;
function syncAsmContext() {
  const a = allocOf(OV);
  ASM_PROG.sidesetBits = a.sideBits;
  ASM_PROG.sidesetOpt = a.opt;
}

// C36: the wave's sample count is level geometry — L5's 64 clk/cycle
// renders a 512-sample window (the sandbox and the early levels keep 128)
let WIN = (LEVEL && LEVEL.waveWin) || 128;

let PROG = BUILT.map((w, i) => ({ w, ...parseRow(wordsToRows(BUILT)[i]) }));

function splitSideset(ds, side_en, sideset_count) {
  const total = sideset_count & 7;
  const vbits = side_en ? total - 1 : total;
  const ss_field = total ? ds >> (5 - total) : 0;
  const delay_mask = 0x1f >> total;
  const en_bit = total ? (ss_field >> (total - 1)) & 1 : 0;
  const ss_valid = total !== 0 && (!side_en || en_bit !== 0);
  const ss_val = ss_valid && vbits ? ss_field & (0x1f >> (5 - vbits)) : 0;
  return [ds & delay_mask, ss_valid, ss_val];
}
// per-instruction effective {delay, side} under the CURRENT allocation
let EFF = [];
function rebuildEff() {
  const a = allocOf(OV);
  const ssCnt = a.sideBits + (a.opt ? 1 : 0);
  EFF = PROG.map((p) => {
    const [dly, valid, val] = splitSideset((p.w >> 8) & 0x1f, a.opt && a.sideBits > 0, ssCnt);
    return { delay: dly, side: valid ? val : null };
  });
}

// ================= worker transport =================
const worker = new Worker('engine-worker.js');
const V = {
  state: {
    cycle: 0,
    pin: 0,
    sm: 0,
    sms: [],
    owners: new Array(32).fill(-1),
    stale: 0, // C27: was-driven pads (OE held, the owner's wiring moved away)
    pc: 0,
    displayPc: 0,
    phase: 'OFF',
    delay: 0,
    x: 0,
    y: 0,
    osr: 0,
    isr: 0,
    osrCnt: 0,
    isrCnt: 0,
    gpioOut: 0,
    gpioOe: 0,
    intr: 0x00f0,
    txLevel: 0,
    txEmpty: true,
    txFull: false,
    txWords: [],
    rxLevel: 0,
    rxWords: [],
    rxMirror: { pushes: 0, drains: 0, ok: true },
    fifoDepths: { tx: 4, rx: 4 },
    monitor: { decoded: '', frameOff: null, square: null },
    wave: { pins: [], tags: [], startCycle: 0 },
    flashes: {},
    refused: 0,
    lens: { mode: 'off', pin: 0 },
    overlay: OV,
    drives: new Array(32).fill(null),
    pattern: { mode: 'off', pin: 0, period: 16, bits: [0] },
    readLog: [],
  },
  ready: false,
  inflight: false,
  lastFlashClk: -1,
};
const engineUrl = new URL('../build/web/pio_engine.js', location.href).href;
worker.postMessage({ cmd: 'init', engineUrl });
worker.onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'werr') {
    // worker-side failure surfaced to the view
    const f = document.querySelector('footer');
    if (f)
      f.innerHTML = `<span style="color:var(--red)">ENGINE WORKER ERROR: ${m.message || 'unknown'}</span>`;
    return;
  }
  if (m.cmd === 'ready') {
    V.ready = true;
    const b = $('boot');
    if (b) b.remove();
    enableCtrls(true);
    // C36: a slow-wave level widens the window BEFORE the first sample —
    // the wave and the judge see the level's own geometry from clk one
    if (LEVEL?.waveWin) post({ cmd: 'wavewin', n: LEVEL.waveWin });
    post({ cmd: 'load', state: curState });
    applyUrlParams();
    return;
  }
  if (m.cmd === 'state') {
    V.inflight = false;
    const prev = OV;
    V.state = m.state;
    curSm = m.state.sm; // the worker's selection is the truth
    OV = m.state.overlay;
    lensPin = m.state.lens.pin;
    syncAsmContext();
    // the listing re-decodes when the ds split moves; the wrap arc is
    // live config and follows WRAP_TOP/BOTTOM (both in buildProgram)
    const splitKey = (ov) => `${ov.pinctrl.ssCnt}/${ov.execctrl.sideEn}`;
    const wrapKey = (ov) => `${ov.execctrl.wrapTop}/${ov.execctrl.wrapBot}`;
    if (splitKey(prev) !== splitKey(OV)) rebuildListing();
    else if (wrapKey(prev) !== wrapKey(OV)) buildProgram();
    if (m.refused > 0) refuseFlash();
    if (m.json && !LEVEL) autosave(m.json);
    if (m.raddr !== undefined) noteRead(m.raddr, m.rdata);
    render(m.state);
  }
};
worker.onerror = (ev) => {
  const f = document.querySelector('footer');
  if (f)
    f.innerHTML = `<span style="color:var(--red)">ENGINE WORKER ERROR: ${ev.message || 'load failed'}</span>`;
};

function post(cmd) {
  if (V.ready) worker.postMessage(cmd);
}

// ---- transport ----
let timer = null;

// ---- the level band + the predict gate (C34; glue over levels.js) -----
// The band's faces: name/goal/verdict/pass/par in row 1, the predict
// card in row 2 (three candidate waves drawn from the level's bits —
// the same mini-wave grammar the row renderer draws). The predict group
// rides the C25 radio grammar: one Tab stop, ←/→ pick, Enter commits.
function thumbPath(bits) {
  // one square-wave sketch: 4px/clk, high y=2, low y=14
  const yOf = (b) => (b ? 2 : 14);
  let d = '';
  let i = 0;
  while (i < bits.length) {
    let j = i + 1;
    while (j < bits.length && bits[j] === bits[i]) j++;
    if (i) d += `M${i * 4} ${yOf(bits[i - 1])} L${i * 4} ${yOf(bits[i])} `;
    d += `M${i * 4} ${yOf(bits[i])} L${j * 4} ${yOf(bits[i])} `;
    i = j;
  }
  return d;
}
let lvPick = 0;
let lvRanOnce = false; // 'awaiting run' until the machine has actually run
function lvApplyPick() {
  document.querySelectorAll('#lvcands .lcand').forEach((c, i) => {
    c.classList.toggle('kc', i === lvPick);
    c.setAttribute('aria-selected', String(i === lvPick));
  });
  $('lvcands').setAttribute('aria-activedescendant', `lcv${lvPick}`);
}
function buildLevelBand() {
  lvSession = lvLoad(LEVEL.id);
  $('lvname').textContent = `${LEVEL.id.replace(/^l/, 'L').toUpperCase()} · ${LEVEL.name}`;
  $('lvgoal').textContent = LEVEL.goal;
  $('lvband').hidden = false;
  if (LEVEL.predict) {
    $('lvask').textContent = LEVEL.predict.ask;
    const host = $('lvcands');
    host.innerHTML = LEVEL.predict.candidates
      .map(
        (c, i) =>
          `<div class="lcand" id="lcv${i}" role="option" aria-selected="false" data-i="${i}" data-tip="${c.label}">` +
          `<svg viewBox="0 0 ${c.bits.length * 4} 16" width="${c.bits.length * 2}" height="16" preserveAspectRatio="none" aria-hidden="true">` +
          `<path d="${thumbPath([...c.bits].map(Number))}" stroke="var(--txt)" stroke-width="2" fill="none"/></svg>` +
          `<span>${c.label}</span></div>`,
      )
      .join('');
    lvPick = Math.max(
      0,
      LEVEL.predict.candidates.findIndex((c) => c.id === lvSession.pick),
    );
    lvApplyPick();
    if (lvSession.predicted) {
      $('lvcands').classList.add('done');
      document.querySelectorAll('#lvcands .lcand').forEach((c, i) => {
        c.classList.toggle('picked', i === lvPick);
      });
    }
    wireGroup(host, (e) => {
      const move = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (move) {
        e.preventDefault();
        lvPick =
          (lvPick + move + LEVEL.predict.candidates.length) % LEVEL.predict.candidates.length;
        lvApplyPick();
      } else if ((e.key === ' ' || e.key === 'Enter') && !lvSession.predicted) {
        e.preventDefault();
        lvCommit();
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault(); // committed: the group stays a stop, the keys go quiet
      }
    });
    // the mouse path: a click picks AND commits (a click on a prediction
    // card is a commitment gesture; after the commit the card is done)
    host.addEventListener('click', (e) => {
      const c = e.target.closest('.lcand');
      if (!c || lvSession.predicted) return;
      lvPick = +c.dataset.i;
      lvApplyPick();
      lvCommit();
    });
  } else {
    $('lvpred').hidden = true;
  }
  // a solved level opens solved: par on the face, the predict card gone
  if (lvSession.solved) lvRevealSolved();
  lvGateApply();
}
function lvCommit() {
  lvSession.predicted = true;
  lvSession.pick = LEVEL.predict.candidates[lvPick].id;
  lvSave();
  $('lvcands').classList.add('done');
  document.querySelectorAll('#lvcands .lcand').forEach((c, i) => {
    c.classList.toggle('picked', i === lvPick);
  });
  $('lvcands').dataset.status = 'prediction committed — R runs · the truth is on the wave';
  lvGateApply();
}
function lvGateApply() {
  if (!LEVEL) return;
  const open = PioLevels.gateOpen(LEVEL, lvSession);
  // disabled until the engine is ready AND the gate is open — either
  // alone is not enough (the boot veil must not leave a live button)
  for (const id of ['brun', 'bstep', 'binsn']) $(id).disabled = !V.ready || !open;
  $('lvpred').classList.toggle('locked', !open);
}
function lvDeny() {
  // the era beep: the locked predict row flashes — the machine is
  // behind the gate, and the gate says where to look
  const p = $('lvpred');
  p.classList.remove('deny');
  void p.offsetWidth;
  p.classList.add('deny');
}
function lvGateCheck() {
  if (!LEVEL || PioLevels.gateOpen(LEVEL, lvSession)) return true;
  lvDeny();
  return false;
}
// the judge: same verdict the engine-side gate replays over the pio_model
// goldens — the band shows it live over the wave window
function levelJudge(st) {
  if (!st.wave.pins.length || (!lvRanOnce && st.wave.pins.every((b) => b === 0))) {
    $('lvverdict').textContent = 'awaiting run';
    $('lvverdict').classList.remove('ok');
    return;
  }
  const v = PioLevels.judge(st.wave.pins, LEVEL.profile);
  $('lvverdict').textContent = v.pass ? `${v.verdict} — PASS (${LEVEL.profile.tier})` : v.verdict;
  $('lvverdict').classList.toggle('ok', v.pass);
  if (v.pass) levelPass();
}
function lvRevealSolved() {
  $('lvpass').hidden = false;
  $('lvpar').textContent =
    `par ${LEVEL.reference.par.words} words · ${LEVEL.reference.par.period} clk/cycle`;
  $('lvpar').hidden = false;
  $('lvpred').hidden = true; // the gate's job is done — never punish re-runs
}
function levelPass() {
  if (lvSession.solved) return;
  lvSession.solved = true;
  lvSave();
  lvRevealSolved();
  pause(); // freeze on the payoff frame
}

function run() {
  if (!V.ready) return;
  if (!lvGateCheck()) return;
  if (timer) {
    pause();
    return;
  }
  lvRanOnce = true;
  timer = setInterval(runTick, +$('speed').value);
  // C33: the PAUSE face rides .on — both faces are authored twin labels,
  // so the box (and the bar behind it) never moves on the swap
  $('brun').classList.add('on');
}
function runTick() {
  // one clk per interval, pipelined
  if (V.inflight) return; // a cycle is still in flight
  V.inflight = true;
  post({ cmd: 'run', cycles: 1 });
}
function pause() {
  clearInterval(timer);
  timer = null;
  V.inflight = false;
  $('brun').classList.remove('on');
}
function enableCtrls(on) {
  for (const id of ['breset', 'brun', 'bstep', 'binsn']) $(id).disabled = !on;
  if (LEVEL) lvGateApply();
}
$('brun').onclick = run;
$('breset').onclick = () => {
  pause();
  asmErr = null;
  rebuildListing(); // back to the stored program's listing
  // a level resets to itself — its program is the stored program
  post({ cmd: 'reset', state: curState });
};
$('bstep').onclick = () => {
  pause();
  if (!lvGateCheck()) return;
  lvRanOnce = true;
  post({ cmd: 'step' });
};
$('binsn').onclick = () => {
  pause();
  if (!lvGateCheck()) return;
  lvRanOnce = true;
  post({ cmd: 'stepInsn' });
};
$('speed').onchange = () => {
  if (timer) {
    clearInterval(timer);
    timer = setInterval(runTick, +$('speed').value);
  }
};

function enqueue(str) {
  const bytes = [...str].map((c) => c.charCodeAt(0) & 0xff);
  post({ cmd: 'enqueue', bytes, sm: curSm });
}
$('bfeed').onclick = () => enqueue($('feedtxt').value);
$('bfeed55').onclick = () => enqueue('\u0055');
$('feedtxt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enqueue(e.target.value);
});
function refuseFlash() {
  const f = $('fifometa');
  f.classList.remove('fifofull');
  void f.offsetWidth;
  f.classList.add('fifofull');
}

// ---- keyboard ownership (C25) -------------------------------------------
// Keys belong to whatever has focus: text surfaces type, interactive
// groups (the [data-rovi] arrow groups, spinboxes and the listing) own
// their keys, and the accelerators fire only on body focus. The groups'
// items are rebuilt every rendered clk, so each group is ONE Tab stop
// with an internal cursor (the aria-activedescendant pattern) that
// survives the rebuilds — per-item tabindex would drop focus on every
// frame the engine renders.
function textSurface(el) {
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}

// Alt+letter mnemonics on the header buttons — hand-rolled because
// accesskey collides with browser chrome. The letters are unique per the
// 3.11 handbook's rule and underlined in the labels; the glyph-only
// reset button has none (its keyboard path is the 0 accelerator).
// brun carries one per face (C33's twin labels): R on RUN, P on PAUSE —
// both live whatever the button currently shows, so the underline never
// names a dead key.
const MNEMONICS = {
  e: 'bempty',
  d: 'bdemo',
  j: 'bexport',
  i: 'bimport',
  l: 'bcopy',
  r: 'brun',
  p: 'brun',
  c: 'bstep',
  n: 'binsn',
};
document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || !e.key || e.key.length !== 1) return;
  const id = MNEMONICS[e.key.toLowerCase()];
  if (!id || textSurface(e.target)) return;
  e.preventDefault();
  $(id).click();
});

// every stepper pair ([data-spin]) is one spinbox stop: −/← dec,
// +/→ inc — the same wrapping clicks the pair's own buttons perform
document.addEventListener('keydown', (e) => {
  const g = e.target.closest ? e.target.closest('[data-spin]') : null;
  if (!g || textSurface(e.target)) return;
  const dir =
    e.key === '-' || e.key === 'ArrowLeft'
      ? 'dec'
      : e.key === '+' || e.key === 'ArrowRight'
        ? 'inc'
        : null;
  if (!dir) return;
  e.preventDefault();
  g.querySelector(`[data-g="${dir}"]`)?.click();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !POP.hidden) {
    popupHide();
    pickEnd();
    return;
  }
  const t = e.target;
  // text surfaces type; groups and buttons own their keys (Space must
  // activate a focused button, not step the machine); the accelerators
  // fire only on body focus. (t can be document for synthetic events —
  // not an owner, but not a body focus either.)
  if (t === document || textSurface(t) || t.closest('[data-rovi]') || t.tagName === 'BUTTON')
    return;
  if (!V.ready) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!lvGateCheck()) return;
    lvRanOnce = true;
    pause();
    post({ cmd: 'step' });
  } else if (e.key === 'r' || e.key === 'R') run();
  else if (e.key === 'i' || e.key === 'I') $('binsn').onclick();
  else if (e.key === '0') $('breset').onclick();
  else if (!LEVEL && ['1', '2', '3', '4'].includes(e.key)) selectSm(+e.key - 1);
});

// a click that lands on no interactive owner releases the keyboard back
// to the accelerators (body focus) — mouse users keep SPACE/R without
// having to Tab anywhere
document.addEventListener('click', (e) => {
  const t = e.target;
  if (
    textSurface(t) ||
    t.closest('[data-rovi], button, a, select, input, textarea, label, [tabindex]')
  )
    return;
  if (document.activeElement && document.activeElement !== document.body)
    document.activeElement.blur();
});

// ---- the status line: the focused owner's key map + its narration ------
// The data-tip narration (C26's era tooltips) never shows on focus —
// this is its keyboard home: the same string, narrated in the footer.
const BODY_KEYS =
  'keys: SPACE cycle · I insn · R run · 0 reset · 1–4 machine · Alt+letter header · Tab walks every group';
function updateStatus() {
  const el = document.activeElement;
  if (!el || el === document.body) {
    $('statusline').textContent = BODY_KEYS;
    return;
  }
  const group = el.closest('[data-status]');
  const own =
    el.tagName === 'BUTTON' ? 'Enter/Space activates' : el.tagName === 'SELECT' ? '↑/↓ choose' : '';
  const keys = el.dataset?.status || own || group?.dataset?.status || '';
  const tip = el.dataset?.tip || el.closest('[data-tip]')?.dataset.tip || '';
  const line = [keys, tip].filter(Boolean).join(' — ');
  $('statusline').textContent = line || BODY_KEYS;
}
document.addEventListener('focusin', updateStatus);
document.addEventListener('focusout', () => setTimeout(updateStatus, 0));

// ---- the era tooltip: the data-tip narration's mouse path --------------
// One narration store with the status line above (C26): hover waits a
// beat, then the cream card portals to <body> (the scrollable-ancestor
// clipping lesson) near the pointer, hard 2px black offset shadow. It
// dies on mousedown/keydown/scroll, era-style. DOM glue — verified by
// the browser session, never unit tests.
const TIP = $('tip');
let tipTimer = null;
function tipHide() {
  TIP.hidden = true;
  clearTimeout(tipTimer);
}
function tipShow(host, x, y) {
  if (!host?.dataset.tip) {
    TIP.hidden = true;
    return;
  }
  TIP.textContent = host.dataset.tip;
  TIP.hidden = false;
  const w = TIP.offsetWidth;
  const h = TIP.offsetHeight;
  let tx = x + 12;
  let ty = y + 18;
  if (tx + w > innerWidth - 4) tx = Math.max(4, innerWidth - w - 4);
  if (ty + h > innerHeight - 4) ty = Math.max(4, y - h - 6);
  TIP.style.left = `${tx}px`;
  TIP.style.top = `${ty}px`;
}
document.addEventListener('mouseover', (e) => {
  if (!e.target.closest) return;
  const host = e.target.closest('[data-tip]');
  if (!host) {
    tipHide();
    return;
  }
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => tipShow(host, e.clientX, e.clientY), 350);
});
document.addEventListener('mousedown', tipHide);
document.addEventListener('keydown', tipHide);
addEventListener('scroll', tipHide, true);
// the import button is a real button now — it clicks through to the
// hidden file input (a button can't nest the input; the label trick is
// gone with the C25 keyboard work)
$('bimport').onclick = () => $('impfile').click();

// ---- the arrow groups: one Tab stop each, an internal cursor -----------
// The cursor is view state rendered as a class by the render passes
// (which rebuild these hosts every clk) — never a focused node.
function wireGroup(host, onKey) {
  host.addEventListener('keydown', (e) => {
    if (textSurface(e.target)) return; // inner inputs keep native keys
    onKey(e);
  });
}

// pin strip: ←/→ walks the cursor; 1/0/Z latch; Space cycles Z→1→0
let pinCursor = 0;
function applyPinCursor() {
  document.querySelectorAll('#pincells .pcell').forEach((c) => {
    c.classList.toggle('kc', +c.dataset.pin === pinCursor);
  });
  $('pincells')?.setAttribute('aria-activedescendant', `pc${pinCursor}`);
}
wireGroup($('pincells'), (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    pinCursor = Math.max(0, Math.min(31, pinCursor + (e.key === 'ArrowRight' ? 1 : -1)));
    applyPinCursor();
    document.querySelector(`.pcell[data-pin="${pinCursor}"]`)?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === '1' || e.key === '0' || e.key === 'z' || e.key === 'Z') {
    e.preventDefault();
    post({ cmd: 'drive', pin: pinCursor, level: e.key === '1' ? 1 : e.key === '0' ? 0 : null });
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    const cur = V.state.drives[pinCursor];
    const next = cur === null ? 1 : cur === 1 ? 0 : null; // Z → 1 → 0 → Z
    post({ cmd: 'drive', pin: pinCursor, level: next });
  }
});

// machines bar: ←/→ selects (wrapping the four); 1–4 jump straight there
wireGroup($('smscells'), (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    selectSm((curSm + (e.key === 'ArrowRight' ? 1 : 3)) % 4);
  } else if (['1', '2', '3', '4'].includes(e.key)) {
    e.preventDefault();
    selectSm(+e.key - 1);
  }
});

// irq lamps: ←/→ picks a flag, Space/Enter fires its W1C write
let lampCursor = 0;
function applyLampCursor() {
  document.querySelectorAll('#irqlamps .ilamp[data-flag]').forEach((l) => {
    l.classList.toggle('kc', +l.dataset.flag === lampCursor);
  });
  $('irqlamps')?.setAttribute('aria-activedescendant', `lf${lampCursor}`);
}
wireGroup($('irqlamps'), (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    lampCursor = Math.max(0, Math.min(7, lampCursor + (e.key === 'ArrowRight' ? 1 : -1)));
    applyLampCursor();
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    post({ cmd: 'regwrite', addr: VD.REG.IRQ, data: 1 << lampCursor });
  }
});

// fifo join: a radio group — ←/→ moves the cursor AND applies it (the
// classic radio behavior), Space/Enter re-applies
const JOIN_SEGS = ['split', 'join-tx', 'join-rx'];
let joinCursor = 0;
wireGroup($('segjoin'), (e) => {
  const move = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (move) {
    e.preventDefault();
    joinCursor = (joinCursor + move + 3) % 3;
    sendCtl('fifo-mode', JOIN_SEGS[joinCursor]);
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    sendCtl('fifo-mode', JOIN_SEGS[joinCursor]);
  }
});

// ---- the sandbox loads: empty boot / demo / persistence ----------------
function loadState(st) {
  pause();
  curState = VD.parseState(st);
  BUILT = curState.words.slice();
  asmErr = null;
  rebuildListing(); // ROWS re-derive from the loaded words
  post({ cmd: 'load', state: curState });
  requestAutosave();
}
$('bempty').onclick = () => loadState(VD.EMPTY);
$('bdemo').onclick = () => loadState(VD.DEMO_UART_TX);

function requestAutosave() {
  post({ cmd: 'serialize' });
}
function autosave(json) {
  // the serializer is pure driver code; this glue just stores it
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(json));
    curState = VD.parseState(json); // the authoritative stored program
    $('savestate').textContent = 'on';
  } catch {
    $('savestate').textContent = 'failed';
  }
}
$('bexport').onclick = () => {
  requestAutosave();
  const blob = new Blob([JSON.stringify(curState, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'vibe-pio-program.json';
  a.click();
  URL.revokeObjectURL(a.href);
};
$('impfile').onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  f.text().then((txt) => {
    try {
      loadState(VD.parseState(JSON.parse(txt)));
    } catch (err) {
      alert(`not a stored-program JSON: ${err.message}`);
    }
  });
  e.target.value = '';
};
$('bcopy').onclick = () => {
  const lines = ['.program sandbox'];
  const a = allocOf(OV);
  if (a.sideBits) lines.push(`.side_set ${a.sideBits}${a.opt ? ' opt' : ''}`);
  for (let i = 0; i < 32; i++) if (BUILT[i]) lines.push(`    ${wordsToRows(BUILT)[i]}`);
  const txt = `${lines.join('\n')}\n`;
  navigator.clipboard?.writeText(txt).then(
    () => {
      // C33: the ✓ face rides .done — the authored twin labels keep the
      // box and the L underline alive across the flash
      $('bcopy').classList.add('done');
      setTimeout(() => $('bcopy').classList.remove('done'), 900);
    },
    () => {},
  );
};

// ---- overlay edits (the inspector + the ds slider ride these) ----------
function ovEdit(group, field, value) {
  curState.sms[curSm][group][field] = value; // the view's stored-program copy
  post({ cmd: 'overlay', sm: curSm, group, field, value });
  requestAutosave();
}

// ---- the C22 drawn controls (DESIGN-NOTES grammar) ---------------------
// Every drawn gesture rides the driver's shared controlEdit table (the
// same pure mapping make js pins) and lands as one atomic overlay write
// per group through the worker — nothing is display-only. The edits
// target the SELECTED SM's overlay.
function sendCtl(id, gesture) {
  if (!V.ready) return;
  for (const [g, f, v] of VD.controlEdit(OV, id, gesture)) curState.sms[curSm][g][f] = v;
  post({ cmd: 'control', sm: curSm, id, gesture });
  requestAutosave();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ctl]');
  if (b) sendCtl(b.dataset.ctl, b.dataset.g);
});

// ================= rendering (all machine values from state) ==========
const ROWS = [];
function rebuildListing() {
  // the listing re-decodes under the current allocation (SPEC-4-1..3)
  const rows = wordsToRows(BUILT);
  ROWS.splice(0, ROWS.length, ...rows);
  PROG = BUILT.map((w, i) => ({ w, ...parseRow(rows[i]) }));
  buildProgram();
}

function buildProgram() {
  rebuildEff();
  const host = $('progrows');
  const nodes = [];
  for (let i = 0; i < 32; i++) {
    const r = document.createElement('div');
    r.setAttribute('role', 'option');
    if (!ROWS[i]) {
      r.className = 'prow empty';
      r.id = `pr${i}`;
      r.dataset.tip =
        '0x0000 · jmp 0 — untouched memory (all-zero reset); if executed, control jumps to slot 00';
      r.innerHTML = `<span class="smcur"></span><span class="addr">${i.toString().padStart(2, '0')}</span><span class="ins">·</span><span></span><span></span><span class="chips"></span>`;
      nodes.push(r);
      continue;
    }
    const p = parseRow(ROWS[i]);
    const eff = EFF[i];
    const side = eff.side,
      dly = eff.delay;
    const sideHtml =
      side == null
        ? `<span data-tip="${allocOf(OV).opt ? 'opt enable bit is 0 — no side applied' : 'no side-set allocated (ds is all delay)'}">—</span>`
        : `<span>side <b>${side}</b></span>`;
    const dlyHtml = dly ? `<span>[${dly}]</span>` : `<span data-tip="delay 0">—</span>`;
    r.dataset.tip = `0x${PROG[i].w.toString(16).padStart(4, '0').toUpperCase()} · ${ROWS[i]}`;
    r.className = 'prow';
    r.id = `pr${i}`;
    const tgtHtml =
      p.tgt != null ? `${p.args ? ', ' : ''}<span class="pcaddr">${p.tgt}</span>` : '';
    r.innerHTML =
      `<span class="smcur"></span><span class="addr">${i.toString().padStart(2, '0')}</span>` +
      `<span class="ins"><span class="op">${esc(p.op)}</span> <span>${esc(p.args)}${tgtHtml}</span></span>` +
      `<span class="cside">${sideHtml}</span><span class="cdly">${dlyHtml}</span>` +
      `<span class="chips"></span>`;
    nodes.push(r);
  }
  // the wrap arc is LIVE config: EXECCTRL.WRAP_TOP/BOTTOM (SPEC-7-19).
  // The window draws as brackets over the rows its loop covers: normally
  // one mid-row-to-mid-row bracket [wrapBot..wrapTop]; a one-row loop is
  // a tick inside that row; and when the window wraps the memory edge
  // (wrapTop < wrapBot — the 1/31 hardware-reset posture, whose loop runs
  // 31→0→1) it is the two brackets the loop actually covers,
  // [wrapBot..31] and [0..wrapTop]. The old single-arc height
  // max(0, top−bot) collapsed that posture onto row 31 — below the fold,
  // far from the wrap-top steppers at row 1, and no gesture at the
  // visible end could ever stretch it (wrapTop cannot pass wrapBot=31).
  const wrapTop = OV.execctrl.wrapTop,
    wrapBot = OV.execctrl.wrapBot;
  const arcTitle = `config · WRAP: after insn ${wrapTop} the PC returns to ${wrapBot} instead of falling through — the steppers at the arc's ends are real EXECCTRL writes`;
  const wrapSeg = (lo, hi) => {
    const s = document.createElement('div');
    s.className = 'wraparc';
    s.dataset.tip = arcTitle;
    s.style.top = `${lo === hi ? lo * 20 + 3 : lo * 20 + 10}px`;
    s.style.height = `${lo === hi ? 14 : (hi - lo) * 20}px`;
    nodes.push(s);
  };
  if (wrapTop >= wrapBot) wrapSeg(wrapBot, wrapTop);
  else {
    wrapSeg(wrapBot, 31); // the run up to the memory edge
    wrapSeg(0, wrapTop); // the fall-through's rows, back at the top
  }
  const ah = document.createElement('div');
  ah.id = 'wraparrow';
  ah.dataset.tip = arcTitle;
  ah.style.top = `${wrapBot * 20 + 6}px`;
  nodes.push(ah);
  // wrap steppers on the arc (C22): WRAP_TOP at the arc's top end,
  // WRAP_BOTTOM beside the return arrow. The glyphs are the direction
  // the end moves — ▲ the end rises (inc), ▼ it falls (dec) — so both
  // pairs read [▲][▼] and mean it the same way. The pairs sit right of
  // the margin's arrow lane (x ≥ 15) so the arrowhead stays visible,
  // and each hugs its end vertically. When the ends coincide (a fresh
  // SM stepped to 0/0) the window is the one-row tick and the pairs
  // bracket that row — never the clipped-above-the-scroll-origin state
  // the layout gate caught (wrap-top inc is the arc's stretch gesture at
  // the top end; from the 1/31 reset posture it stretches [0..wrapTop]).
  // C25: each pair rides in one .wspin spinbox stop (one Tab stop, keys
  // −/← and +/→) at the same 12+2+12 footprint the buttons drew.
  const wrapSpin = (field, y, label, id) => {
    const box = document.createElement('div');
    box.className = 'wspin';
    box.id = id;
    box.tabIndex = 0;
    box.dataset.spin = '';
    box.dataset.rovi = '';
    box.dataset.status = '−/+ or ←/→ step · wraps';
    box.style.top = `${y}px`;
    for (const g of ['inc', 'dec']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `wstep ${g}`;
      b.tabIndex = -1;
      b.dataset.ctl = field;
      b.dataset.g = g;
      b.textContent = g === 'inc' ? '▲' : '▼';
      b.dataset.tip = `config · ${field === 'wrap-top' ? 'WRAP_TOP' : 'WRAP_BOTTOM'}: ${label(g)} — cycles 0..31, a real EXECCTRL write`;
      box.appendChild(b);
    }
    nodes.push(box);
  };
  const tY = wrapTop * 20 + 7, // flush under the after-insn boundary
    bY =
      wrapTop === wrapBot
        ? wrapBot > 0
          ? wrapBot * 20 - 13 // bracket the wrapped row: handle above
          : (wrapBot + 1) * 20 + 3 // row 0 has no row above — handle below
        : wrapBot * 20 + 3; // inside the return row, beside the arrow
  // C34: the steppers are config edits — a level shows the wrap ARC (it
  // is the lesson) but edits nothing until the surface unlocks them
  if (lvUnlock('wrapSteppers')) {
    wrapSpin(
      'wrap-top',
      tY,
      (g) =>
        `${g === 'inc' ? 'raise' : 'lower'} the top end — after-insn ${wrapTop} → ${(wrapTop + (g === 'inc' ? 1 : 31)) & 31}`,
      'spin-wraptop',
    );
    wrapSpin(
      'wrap-bot',
      bY,
      (g) =>
        `${g === 'inc' ? 'raise' : 'lower'} the return row — target ${wrapBot} → ${(wrapBot + (g === 'inc' ? 1 : 31)) & 31}`,
      'spin-wrapbot',
    );
  }
  const arcs = [];
  for (let i = 0; i < 32; i++) {
    if (!ROWS[i]) continue;
    const p = parseRow(ROWS[i]);
    if (p.op !== 'jmp' || p.tgt == null || p.tgt === i + 1 || p.tgt === i || p.tgt > 31) continue;
    arcs.push({ i, tgt: p.tgt, lo: Math.min(i, p.tgt), hi: Math.max(i, p.tgt) });
  }
  const LANES = 4,
    laneX = (l) => 11 + l * 6,
    used = Array.from({ length: LANES }, () => []);
  for (const a of arcs) {
    a.lane = used.findIndex((sp) => sp.every(([lo, hi]) => a.hi < lo || a.lo > hi));
    if (a.lane < 0) a.lane = 0;
    used[a.lane].push([a.lo, a.hi]);
  }
  for (const a of arcs) {
    const x = laneX(a.lane);
    const el = document.createElement('div');
    el.className = 'jparc';
    el.id = `jp${a.i}`;
    el.dataset.tip = `jmp: ${a.i.toString().padStart(2, '0')} ↷ ${a.tgt.toString().padStart(2, '0')}`;
    el.style.left = `${x}px`;
    el.style.top = `${a.lo * 20 + 10}px`;
    el.style.height = `${(a.hi - a.lo) * 20}px`;
    nodes.push(el);
    const t = document.createElement('div');
    t.className = 'jparr';
    t.dataset.tip = el.dataset.tip;
    t.style.left = `${x + 7}px`;
    t.style.top = `${a.tgt * 20 + 6}px`;
    nodes.push(t);
  }
  // the static editor overlays ride along through every rebuild (C35:
  // the delay cell with them) — replaceChildren would otherwise eat them
  host.replaceChildren(...nodes, RE, DED);
  const usedN = ROWS.filter(Boolean).length;
  $('usedct').textContent = `${usedN}/32`;
  $('wordsct').textContent = usedN;
  $('freect').textContent = 32 - usedN;
  updateUnbuilt();
  applyRowCursor();
  renderAlloc();
  renderInspector();
}
function updateUnbuilt() {
  const u = $('unbuilt');
  if (!u) return;
  u.hidden = !asmErr;
  if (asmErr)
    u.dataset.tip = `edits do not assemble — ${asmErr} — the machine runs the last good build`;
}
function renderAlloc() {
  const h = $('dspips');
  h.innerHTML = '';
  const a = allocOf(OV);
  const total = a.sideBits + (a.opt ? 1 : 0);
  for (let k = 0; k < 5; k++) {
    const d = document.createElement('div');
    d.className = `pip${k < total ? (k === 0 && a.opt ? ' en' : ' s') : ' d'}`;
    d.dataset.tip =
      k < total
        ? k === 0 && a.opt
          ? 'opt-enable bit — per-instruction side on/off'
          : 'side data bit → gpio'
        : `delay bit (max delay ${maxDelay()})`;
    h.appendChild(d);
  }
  $('ssminus').disabled = !a.sideBits;
  $('ssplus').disabled = a.sideBits >= 5;
  $('ssopt').disabled = !a.sideBits;
  $('ssopt').checked = a.opt && !!a.sideBits;
  $('dsinfo').innerHTML =
    `side ${a.sideBits}b${a.opt ? '+opt' : ''} · delay [0..${maxDelay()}] · PINCTRL.SIDESET_COUNT=${ssCntOf(OV)}`;
  // the side tag's count slot — the shared ds budget, owned by the pips
  // (the tag's steppers write SIDESET_BASE only); C29: the face names it
  // like its siblings (c<N>, +opt under SIDE_EN) and annotates the none
  // posture in-face — c—ds: no side-set, the five ds bits are all delay
  $('sidecnt').innerHTML = ssCntOf(OV)
    ? `c${Math.max(0, ssCntOf(OV) - (sideEnOf(OV) ? 1 : 0))}${sideEnOf(OV) ? '+opt' : ''}`
    : 'c—<i class="dsnote">ds</i>';
}
function flashWrap() {
  // every bracket of the window flashes (the edge-wrapped posture has two)
  document.querySelectorAll('.wraparc').forEach((a) => {
    a.classList.add('flash');
    setTimeout(() => a.classList.remove('flash'), 240);
  });
}
function flashPull() {
  const c = $('pullconn');
  if (!c) return;
  c.classList.add('flash');
  setTimeout(() => c.classList.remove('flash'), 240);
}
function flashJmp() {
  document.querySelectorAll('.jparc').forEach((a) => {
    a.classList.add('flash');
    setTimeout(() => a.classList.remove('flash'), 240);
  });
}
function flashPush() {
  const c = $('rxfifo');
  if (!c) return;
  c.classList.add('flash');
  setTimeout(() => c.classList.remove('flash'), 240);
}

function hex32(v) {
  return `0x${(v >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
}
function ascii(v) {
  const c = v & 0xff;
  return c >= 0x20 && c < 0x7f ? `'${String.fromCharCode(c)}'` : '';
}

function buildBits(host) {
  host.innerHTML = '';
  for (let i = 0; i < 32; i++) {
    const b = document.createElement('div');
    b.className = 'bit z';
    b.id = `${host.id}b${i}`;
    b.textContent = '0';
    host.appendChild(b);
  }
}
function renderBits(host, val, spent) {
  for (let i = 0; i < 32; i++) {
    const b = $(`${host.id}b${i}`),
      bit = (val >>> (31 - i)) & 1;
    b.textContent = bit;
    b.className = `bit${bit ? '' : ' z'}${31 - i < spent ? ' spent' : ''}`;
  }
}

function renderProgram(st) {
  // four PC cursors on the shared listing: the SMs at a row render as one
  // boxed chip in the row's left margin (C30 — out of the address cell,
  // which stays digits-only); the selected SM keeps the full .cur row
  // treatment (chips, the editor's anchor). Only ENABLED machines carry
  // cursors — a disabled SM parks at its reset pc forever and its chip
  // would be a ghost (the single-SM levels and the demo scope read
  // exactly the machines that exist)
  const here = st.sms
    ? st.sms.map((s, k) => ({ k, pc: s.displayPc, en: s.en !== false })).filter((s) => s.en)
    : [{ k: 0, pc: st.displayPc }];
  for (let i = 0; i < 32; i++) {
    const r = $(`pr${i}`);
    if (!r) continue;
    r.classList.toggle('cur', i === st.displayPc);
    const marks = r.querySelector('.smcur');
    if (marks)
      marks.innerHTML = here
        .filter((s) => s.pc === i)
        .map(
          (s) =>
            `<i class="smk${s.k === curSm ? ' on' : ''}" style="--smc:${SM_COLOR[s.k]}" data-tip="SM${s.k} PC">${s.k}</i>`,
        )
        .join('');
    const chips = r.querySelector('.chips');
    chips.innerHTML = '';
    if (i === st.displayPc) {
      if (st.phase === 'DELAY') {
        const c = document.createElement('span');
        c.className = 'chip dly';
        c.textContent = `delay ⟳${st.delay}`;
        chips.appendChild(c);
      } else if (st.phase === 'STALL') {
        const c = document.createElement('span');
        c.className = 'chip stall';
        c.textContent = 'stall · tx empty';
        chips.appendChild(c);
      }
    }
  }
}

// ---- the machines bar: one chip per SM, PC + phase + FIFO columns ------
const SM_COLOR = ['var(--sm0)', 'var(--sm1)', 'var(--sm2)', 'var(--sm3)'];
function renderSms(st) {
  const host = $('smscells');
  if (!host) return;
  let h = '';
  for (let i = 0; i < 4; i++) {
    const s = st.sms[i] || {};
    const ph = s.phase || 'OFF';
    const phCls = ph === 'EXEC' ? 'x' : ph === 'DELAY' ? 'd' : ph === 'STALL' ? 'w' : '';
    h +=
      `<div class="smcell${i === curSm ? ' sel' : ''}" id="sm${i}" role="option" aria-selected="${i === curSm}" data-sm="${i}" style="--smc:${SM_COLOR[i]}"` +
      ` data-tip="SM${i} — click selects the machine the detail panes follow (key ${i + 1}) · PC ${s.displayPc ?? 0} · ${ph} · tx ${s.txLevel ?? 0}/${s.fifoDepths?.tx ?? 4} · rx ${s.rxLevel ?? 0}/${s.fifoDepths?.rx ?? 4}">` +
      `<span class="smn">SM${i}</span><span class="smpc">${(s.displayPc ?? 0).toString().padStart(2, '0')}</span>` +
      `<span class="smph ${phCls}">${ph}</span>` +
      `<span class="smfifo">tx<b>${s.txLevel ?? 0}</b><i>/${s.fifoDepths?.tx ?? 4}</i> rx<b>${s.rxLevel ?? 0}</b><i>/${s.fifoDepths?.rx ?? 4}</i></span>` +
      `</div>`;
  }
  host.innerHTML = h;
}
$('smscells').addEventListener('click', (e) => {
  const c = e.target.closest('.smcell');
  if (c) selectSm(+c.dataset.sm);
});

function renderExec(st) {
  const disp = st.displayPc,
    p = PROG[disp],
    e = EFF[disp] || { delay: 0, side: null };
  $('execsm').textContent = `SM${curSm}`;
  $('execsm').style.color = SM_COLOR[curSm];
  $('execins').innerHTML = p
    ? `<span class="op">${p.op}</span> <span>${p.args}</span>` +
      (e.side != null ? ` <span class="pf">side ${e.side}</span>` : '') +
      (e.delay ? ` <span class="pf">[${e.delay}]</span>` : '')
    : `<span class="pf">· unwritten — jmp ${st.pc}</span>`;
  const f = $('execfields');
  f.innerHTML = p
    ? `0x${p.w.toString(16).padStart(4, '0').toUpperCase()} · ${ROWS[disp] || 'decodes as jmp 0'}`
    : 'unwritten memory · 0x0000 decodes as jmp 0';
  const n = $('phasename'),
    sub = $('phasesub'),
    fill = $('phasefill');
  if (st.phase === 'EXEC') {
    n.textContent = 'EXEC';
    n.className = 'st';
    fill.style.width = '0%';
    sub.textContent = 'instruction runs this cycle';
  } else if (st.phase === 'DELAY') {
    n.textContent = `DELAY ${st.delay}`;
    n.className = 'dl';
    fill.style.width = `${100 * (1 - st.delay / (e.delay || 1))}%`;
    sub.textContent = `${st.delay} cycles until PC → ${st.pc.toString().padStart(2, '0')}`;
  } else if (st.phase === 'STALL') {
    n.textContent = 'STALL';
    n.className = 'wa';
    fill.style.width = '0%';
    sub.textContent = 'blocked — check FIFOs / wait condition';
  } else {
    n.textContent = '—';
    n.className = '';
    fill.style.width = '0%';
    sub.textContent = 'divider / disabled';
  }
  $('cyc').textContent = st.cycle;
}

function renderRegs(st) {
  $('xval').innerHTML = `${hex32(st.x)} <small>= ${st.x >>> 0}</small>`;
  $('yval').innerHTML = `${hex32(st.y)} <small>= ${st.y >>> 0}</small>`;
  renderBits($('osrbits'), st.osr, st.osrCnt);
  renderBits($('isrbits'), st.isr, st.isrCnt);
  $('osrfill').style.width = `${(100 * st.osrCnt) / 32}%`;
  $('osrcnt').textContent = st.osrCnt;
  $('osre').classList.toggle('lit', st.osrCnt >= (OV.shiftctrl.pullThr || 32));
  $('isrfill').style.width = `${(100 * st.isrCnt) / 32}%`;
  $('isrcnt').textContent = st.isrCnt;
  const sc = OV.shiftctrl;
  // the C22 drawn controls render from the overlay mirror (their writes
  // retire on the next rendered clk, like every overlay edit)
  $('aptgl').classList.toggle('on', sc.autopull);
  $('apthr').textContent = sc.pullThr;
  $('osrnotch').style.left = `${(100 * sc.pullThr) / 32}%`;
  $('aptg2').classList.toggle('on', sc.autopush);
  $('apthr2').textContent = sc.pushThr;
  $('isrnotch').style.left = `${(100 * sc.pushThr) / 32}%`;
  $('osrarr').className = `sv-arrow${sc.outRight ? '' : ' l'}`;
  $('israrr').className = `sv-arrow${sc.inRight ? '' : ' l'}`;
  $('osrdir').textContent = sc.outRight ? 'pins · lsb-first' : 'pins · msb-first';
  $('isrdir').textContent = sc.inRight ? 'pins · lsb-first' : 'pins · msb-first';
  $('isrnote').textContent = st.isrCnt ? `${st.isrCnt} shifted in` : 'idle';

  const depth = st.fifoDepths.tx;
  const slots = $('fslots');
  slots.innerHTML = '';
  for (let i = 0; i < depth; i++) {
    const d = document.createElement('div');
    const full = i < st.txWords.length;
    const borrowed = i >= 4 && depth === 8;
    d.className = `fslot${full ? ' full' : ''}${i === 0 ? ' next' : ''}${borrowed ? ' borrowed' : ''}`;
    if (borrowed) d.dataset.tip = 'config · storage borrowed from RX via FIFO JOIN TX — the tick';
    d.innerHTML = `<span class="idx">${i}${borrowed ? '<i class="tick">✓</i>' : ''}</span><span class="hexv">${full ? hex32(st.txWords[i]) : '········'}</span><span class="chv">${full ? ascii(st.txWords[i]) : ''}</span>`;
    slots.appendChild(d);
  }
  // the FIFO-mode segmented control: the active segment is the drawn
  // truth (an aux mode lights none — those are inspector-set). It is
  // also the radio group's checked state, and the keyboard cursor
  // follows the applied mode (the walk only leads it transiently).
  let joinActive = null;
  if (!sc.fjoinRxPut && !sc.fjoinRxGet)
    joinActive = sc.fjoinTx ? 'tx' : sc.fjoinRx ? 'rx' : 'split';
  joinCursor = joinActive ? { split: 0, tx: 1, rx: 2 }[joinActive] : joinCursor;
  for (const [k, id] of [
    ['split', 'segsplit'],
    ['tx', 'segtx'],
    ['rx', 'segrx'],
  ]) {
    const seg = $(id);
    if (seg) {
      seg.classList.toggle('on', k === joinActive);
      seg.setAttribute('aria-pressed', k === joinActive ? 'true' : 'false');
    }
  }
  // depth lives in the LEVEL line (fifometa/rxmeta); the panel titles
  // stay single-line so the right column keeps its 13"-viewport fit
  $('txdepth2').textContent = depth;
  $('fifolvl').textContent = st.txLevel;
  $('fifolvlfill').style.height = `${depth ? (100 * st.txLevel) / depth : 0}%`;
  $('fifostall').classList.toggle('show', st.phase === 'STALL');
  $('txnote').textContent =
    depth === 0
      ? 'TX disabled by the join mode (FSTAT: both empty and full)'
      : `TX FIFO ${depth} deep — overflow is refused`;

  // RX panel: the level is engine truth; contents appear only by draining
  const rdepth = st.fifoDepths.rx;
  $('rxdepth2').textContent = rdepth;
  $('rxlvl').textContent = st.rxLevel;
  $('rxlvlfill').style.height = `${rdepth ? (100 * st.rxLevel) / rdepth : 0}%`;
  // join ghosts (SPEC-6-2/4): the panel whose storage was borrowed dims
  // behind a chip that says where it went (a ghost, not a control — the
  // join chip above is the write)
  const txGone = depth === 0,
    rxGone = rdepth === 0;
  $('fifo').classList.toggle('ghost', txGone);
  $('rxfifo').classList.toggle('ghost', rxGone);
  const txGhost = $('txghost'),
    rxGhost = $('rxghost');
  txGhost.hidden = !txGone;
  txGhost.textContent = sc.fjoinRx && sc.fjoinTx ? 'joined off' : 'joined → rx';
  rxGhost.hidden = !rxGone;
  rxGhost.textContent = sc.fjoinTx ? 'joined → tx' : 'aux storage';
  // the pull connector ghosts with the TX panel it feeds
  $('pullconn').classList.toggle('ghost', txGone);
  $('bdrainall').disabled = st.rxMirror.pushes - st.rxMirror.drains <= 0;
  const log = $('rxlog');
  if (st.rxWords.length) {
    log.innerHTML = st.rxWords
      .slice(-16)
      .reverse()
      .map((w) => `<span class="rxw">${hex32(w)} <i>${ascii(w)}</i></span>`)
      .join('');
  } else {
    log.innerHTML = '<span class="note">drained words appear here</span>';
  }

  // IRQ flags + the INTR readback (SPEC-7-12)
  $('intrhex').textContent = `0x${(st.intr & 0xffff).toString(16).padStart(4, '0').toUpperCase()}`;
  const lamps = $('irqlamps');
  const flags = (st.intr >> 8) & 0xff;
  let lh = '';
  for (let i = 0; i < 8; i++)
    lh += `<span id="lf${i}" role="option" aria-selected="${i === lampCursor}" class="ilamp${(flags >> i) & 1 ? ' on' : ''}" data-tip="IRQ flag ${i} — ${(flags >> i) & 1 ? 'SET' : 'clear'} · click = W1C via IRQ" data-flag="${i}">f${i}</span>`;
  lh += `<span class="ilamp sub${(st.intr >> 4) & 1 ? ' on' : ''}" data-tip="TXNFULL SM0">tx¬full</span>`;
  lh += `<span class="ilamp sub${st.intr & 1 ? ' on' : ''}" data-tip="RXNEMPTY SM0">rx¬empty</span>`;
  lamps.innerHTML = lh;
  applyLampCursor();

  // header chips + the C29-named pin-mapping tag numbers (the steppers
  // write; the b/c letters live in the HTML around the steppers' values)
  const cd = OV.clkdiv;
  const div = (cd.intg || 65536) + cd.frac / 256;
  $('clkdivtag').textContent = `clkdiv ÷${div.toFixed(2)}`;
  const pc2 = OV.pinctrl;
  $('outbase').textContent = `b${pc2.outBase}`;
  $('outcnt').textContent = `c${pc2.outCnt || 32}`;
  $('sidebase').textContent = `b${pc2.ssBase}`;
  $('inbase').textContent = `b${pc2.inBase}`;
  $('incnt').textContent = `c${sc.inCount || 32}`;
}

// ---- pin strip: drive latches, pattern source, engine outputs ---------
// C27: the strip is the pin-side echo of the drawn config — three
// cyan-family lanes under each pin number carry the SELECTED SM's OUT /
// SIDESET / IN extents (SPEC-7-26/21; VD.pinExtents over the same OV the
// wave-header tags render from), so a base/count stepper click shows
// where the wiring moved with no program running. A gray ring + gray ▲
// names a was-driven pad: still OE and holding its last level, but the
// owner's current write extents no longer reach it (the driver's stale
// mask — the moved-from pin stops reading as currently driven).
function renderPins(st) {
  const host = $('pincells');
  const drives = st.drives;
  const owners = st.owners || new Array(32).fill(-1);
  const stale = st.stale || 0;
  const map = VD.pinExtents(OV);
  const pc = OV.pinctrl;
  const sideData = Math.max(0, pc.ssCnt - (OV.execctrl.sideEn ? 1 : 0)); // SPEC-4-2
  const patPin = st.pattern.mode !== 'off' ? st.pattern.pin : -1;
  let h = '';
  for (let p = 0; p < 32; p++) {
    const oe = (st.gpioOe >> p) & 1;
    const lvl = (st.gpioOut >> p) & 1;
    const drv = drives[p];
    const own = owners[p];
    const was = (stale >>> p) & 1;
    const wires = [];
    if ((map.out >>> p) & 1) wires.push(`out b${pc.outBase}·c${pc.outCnt || 32}`);
    if ((map.side >>> p) & 1) wires.push(`side b${pc.ssBase}·c${sideData}`);
    if ((map.in >>> p) & 1) wires.push(`in b${pc.inBase}·c${OV.shiftctrl.inCount || 32}`);
    const cls = [
      'pcell',
      oe ? 'oe' : '',
      was ? 'stale' : '',
      drv === 1 ? 'dh' : drv === 0 ? 'dl' : '',
      lvl ? 'hi' : '',
      p === patPin ? 'pat' : '',
      p === lensPin ? 'sel' : '',
      own >= 0 ? `ow s${own}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const tips = [
      `pin ${p}`,
      oe
        ? was
          ? `pad HELD at level ${lvl} — SM${own}'s last write; the wiring has moved away (no longer driven)`
          : `engine OUTPUT — level ${lvl}`
        : 'engine input',
      wires.length ? `SM${curSm} wiring: ${wires.join(' · ')}` : `not in SM${curSm}'s wiring`,
      drv === null ? 'drive latch released (Z)' : `drive latch HELD at ${drv}`,
      patPin === p ? `pattern source (${st.pattern.mode})` : '',
      p === lensPin ? 'lens/wave target' : '',
      own >= 0
        ? `pad owned by SM${own} — the last SM to write it (same-clk conflicts: the highest-numbered SM wins)`
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const lanes = `<span class="pmap"><i class="${(map.out >>> p) & 1 ? 'mo' : ''}"></i><i class="${(map.side >>> p) & 1 ? 'ms' : ''}"></i><i class="${(map.in >>> p) & 1 ? 'mi' : ''}"></i></span>`;
    // the marks ride the LEVEL line — its 16px line box exists on every
    // cell (the digit), so a ▲/D/◆ appearing never reflows the strip (a
    // mark row of its own had no line box when empty: the first mark
    // anywhere stretched every cell 16px, the C26 hover/press lesson
    // now applied to drive state)
    const marks = `${oe ? '▲' : drv !== null ? 'D' : ''}${patPin === p ? '◆' : ''}`;
    h += `<div class="${cls}" id="pc${p}" role="option" aria-selected="${p === pinCursor}" data-pin="${p}" data-tip="${tips}"><span class="pn">${p}</span>${lanes}<span class="pl">${lvl}<i class="pm">${marks}</i></span>${own >= 0 ? `<span class="po">${own}</span>` : ''}</div>`;
  }
  host.innerHTML = h;
  applyPinCursor();
}
$('pincells').addEventListener('click', (e) => {
  const c = e.target.closest('.pcell');
  if (!c) return;
  const pin = +c.dataset.pin;
  const cur = V.state.drives[pin];
  const next = cur === null ? 1 : cur === 1 ? 0 : null; // Z → 1 → 0 → Z
  post({ cmd: 'drive', pin, level: next });
});

// ---- pattern generator controls ----------------------------------------
function patternUi() {
  const mode = $('patmode').value;
  $('patperwrap').hidden = mode !== 'square';
  $('patbitswrap').hidden = mode !== 'bits';
}
function sendPattern() {
  const mode = $('patmode').value;
  const cfg = { mode, pin: +$('patpin').value };
  if (mode === 'square') cfg.period = +$('patperiod').value || 16;
  if (mode === 'bits')
    cfg.bits = [...$('patbits').value]
      .map((ch) => (ch === '1' ? 1 : 0))
      .filter((b) => b !== undefined);
  post({ cmd: 'pattern', cfg });
}
$('patmode').onchange = () => {
  patternUi();
  sendPattern();
};
$('patperiod').onchange = sendPattern;
$('patbits').onchange = sendPattern;
$('patpin').onchange = sendPattern;

// ---- lens selector ------------------------------------------------------
// C28: the wave row owns its pin — the gpio label's drawn steppers. The
// lens is view state, not an overlay field (no reg write lands; the
// decode replays over the stored history), so the picker rides its own
// [data-lens] gesture beside the sendCtl table — the keys come from the
// shared [data-spin] grammar, which clicks these buttons like any pair.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-lens]');
  if (!b || !V.ready) return;
  const dir = b.dataset.g === 'inc' ? 1 : -1;
  post({ cmd: 'lens', mode: V.state.lens.mode, pin: (lensPin + dir + 32) & 31 });
});
function lensUi() {
  $('lensmode').value = V.state.lens.mode;
}
$('lensmode').onchange = () => post({ cmd: 'lens', mode: $('lensmode').value, pin: lensPin });

function renderMonitor(st) {
  const mon = st.monitor;
  const mode = st.lens.mode;
  if (mode === 'uart') {
    $('monbuf').textContent = mon.decoded ? `'${mon.decoded}'` : '—';
    const n = [...mon.decoded].length;
    $('moncnt').textContent = n ? `· ${n} bytes ✓` : '';
  } else if (mode === 'square' && mon.square && mon.square.period) {
    $('monbuf').textContent = `${mon.square.period} clk/cycle`;
    $('moncnt').textContent = `· ${mon.square.dutyPct}% duty · ${mon.square.edges} edges`;
  } else {
    $('monbuf').textContent = '—';
    $('moncnt').textContent = '';
  }
  // the frame-map + its legend entries exist only under the uart lens —
  // the sandbox chrome stays protocol-neutral otherwise
  const uart = mode === 'uart';
  $('framemap').hidden = !uart;
  for (const id of ['leg-ctrl', 'leg-data']) $(id).hidden = !uart;
}

// ---- waveform (svg): true engine pin samples, lens-derived tags --------
const CW = 7,
  HI = 16,
  LO = 62,
  TAGY = 86,
  RULY = 104,
  H = 112;
function classOf(tag) {
  if (tag.startsWith('D')) return 'data';
  if (tag === 'IDLE') return 'idle';
  return 'ctrl';
}
// trace strokes ride lighter variants than the text tokens: 2px of hue
// carries less than a glyph does, and data-green must not collapse into
// idle-gray on the white well (C26 era skin, DESIGN-NOTES "wave")
const colOf = { data: 'var(--wave-data)', ctrl: 'var(--wave-ctrl)', idle: 'var(--wave-idle)' };
function renderWave(st) {
  const svg = $('wavesvg');
  const w = st.wave;
  const n = Math.min(w.pins.length, WIN);
  const W = WIN * CW;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', '100%');
  let s = '';
  const c0 = w.startCycle; // engine clk of first shown sample
  for (let k = 0; k <= WIN; k += 8) {
    const x = k * CW;
    s += `<line x1="${x}" y1="8" x2="${x}" y2="${LO + 6}" stroke="var(--line)" stroke-width="1"/>`;
    if ((c0 + k) % 16 === 0 && k < WIN && Math.abs(x - n * CW) > 56)
      s += `<text x="${x + 3}" y="${RULY}" fill="var(--dimmer)" font-size="16" font-family="var(--mono)">${c0 + k}</text>`;
  }
  $('lenspinval').textContent = lensPin;
  $('lensmodetxt').textContent = `· ${st.lens.mode === 'off' ? 'raw' : st.lens.mode} lens`;
  if (!n) {
    svg.innerHTML = s;
    return;
  }
  const pins = w.pins.slice(-n),
    tags = w.tags.slice(-n);
  const yOf = (p) => (p ? HI : LO);
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && pins[j] === pins[i]) j++;
    const y = yOf(pins[i]);
    const col = colOf[classOf(tags[i])];
    const x0 = i * CW,
      x1 = j * CW;
    if (i > 0)
      s += `<path d="M${x0} ${yOf(pins[i - 1])} L${x0} ${y}" stroke="${col}" stroke-width="2"/>`;
    s += `<path d="M${x0} ${y} L${x1} ${y}" stroke="${col}" stroke-width="2"/>`;
    i = j;
  }
  i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && tags[j] === tags[i]) j++;
    if (j - i >= 3 && tags[i]) {
      const col = colOf[classOf(tags[i])];
      s += `<text x="${((i + j) * CW) / 2}" y="${TAGY}" fill="${col}" font-size="16" font-family="var(--mono)" text-anchor="middle" opacity=".85">${tags[i]}</text>`;
    }
    i = j;
  }
  s += `<line x1="${n * CW - 1}" y1="6" x2="${n * CW - 1}" y2="${LO + 6}" stroke="var(--amber)" stroke-width="1" opacity=".8"/>`;
  s += `<text x="${n * CW - 5}" y="${RULY}" fill="var(--amber)" font-size="16" font-family="var(--mono)" text-anchor="end">${st.cycle}</text>`;
  svg.innerHTML = s;
}

function renderFrameMap(st) {
  const cells = ['START', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'STOP'];
  const tags = st.wave.tags;
  const last = tags.length ? tags[tags.length - 1] : null;
  let now = null;
  if (last === 'START') now = 0;
  else if (last === 'STOP') now = 9;
  else if (last?.startsWith('D')) now = 1 + +last.slice(1);
  const host = $('fmcells');
  host.innerHTML = cells
    .map(
      (c, i) =>
        `<div class="fmcell${i === now ? ' now' : now != null && i < now ? ' past' : ''}">${c}</div>`,
    )
    .join('');
}

// ---- the register inspector (the datasheet map) -------------------------
// Settable config fields ride the overlay; action rows (CTRL pulses, IRQ
// W1C/force, FDEBUG W1C, SM0_INSTR force) are generic reg writes; RO rows
// render live from the cycle sample or via a queued READ (a real clk).
function inspFieldRow(group, field, spec, val) {
  const [hi, lo, max] = spec;
  const id = `insp-${group}-${field}`;
  const bits = hi === lo ? `${hi}` : `${hi}:${lo}`;
  const tip = `${group}.${field} — bits ${bits}`;
  let ctrl;
  if (max === 'b') {
    ctrl = `<input type="checkbox" id="${id}" ${val ? 'checked' : ''} />`;
  } else if (max === 'thr') {
    ctrl = `<input type="number" id="${id}" value="${val}" min="1" max="32" />`;
  } else {
    ctrl = `<input type="number" id="${id}" value="${val}" min="0" max="${max}" />`;
  }
  return `<div class="ifield" data-tip="${tip}"><span class="ifn">${field}</span><span class="ifb">${bits}</span>${ctrl}</div>`;
}
function renderInspector() {
  const st = V.state;
  const host = $('inspbody');
  // a focused input owns its value until commit — skip the DOM rebuild
  // that render would otherwise do under it every clk
  if (host?.contains(document.activeElement)) return;
  // the full map is ~100 nodes; while free-running, refresh it only
  // every 8th clk (the lighter FIFO/pin/wave panels stay per-clk)
  if (timer && st.cycle % 8 !== 0) return;
  const regs = VD.REG;
  // live RO values
  const txEmpty = st.txEmpty ? 1 : 0,
    txFull = st.txFull ? 1 : 0;
  const rxEmpty = st.rxLevel === 0 ? 1 : 0,
    rxFull = st.fifoDepths.rx && st.rxLevel >= st.fifoDepths.rx ? 1 : 0;
  const fstatLive = `txe ${txEmpty} txf ${txFull} rxe ${rxEmpty} rxf ${rxFull}`;
  let h = '';
  h += `<div class="igroup">block</div>`;
  h += `<div class="ireg" data-tip="CTRL: SM_ENABLE per machine + the SM_RESTART / CLKDIV_RESTART pulses (the selected machine's bits)">
    <div class="irhead"><span class="irn">CTRL</span><span class="ira">0x000</span></div>
    <div class="ifields">
      ${[0, 1, 2, 3]
        .map(
          (i) =>
            `<div class="ifield" data-tip="SM_ENABLE bit${i} — SM${i} on/off"><span class="ifn">SM${i}_EN</span><span class="ifb">${i}</span><input type="checkbox" id="insp-ctrl-smen${i}" /></div>`,
        )
        .join('')}
      <button type="button" class="ipulse" data-wr="${regs.CTRL}" data-val="${1 << (4 + curSm)}" data-tip="SM_RESTART bit${4 + curSm}: clears SM${curSm}'s shift counters, ISR, delay, WAIT state — one clk">SM${curSm}_RESTART</button>
      <button type="button" class="ipulse" data-wr="${regs.CTRL}" data-val="${1 << (8 + curSm)}" data-tip="CLKDIV_RESTART bit${8 + curSm}: SM${curSm}'s divider back to phase 0">SM${curSm}_DIVRST</button>
    </div></div>`;
  h += `<div class="ireg" data-tip="FSTAT — live from the cycle sample">
    <div class="irhead"><span class="irn">FSTAT</span><span class="ira">0x004</span><span class="iro">${fstatLive}</span>
    <button type="button" class="ipulse" data-rd="${regs.FSTAT}">READ</button></div></div>`;
  h += `<div class="ireg" data-tip="FDEBUG — sticky flags, W1C; READ costs one rendered clk">
    <div class="irhead"><span class="irn">FDEBUG</span><span class="ira">0x008</span><span class="iro" id="insp-fdebug">—</span>
    <button type="button" class="ipulse" data-rd="${regs.FDEBUG}">READ</button></div>
    <div class="ifields btns">
    <button type="button" class="ipulse" data-wr="${regs.FDEBUG}" data-val="${1 << 24}" data-tip="W1C TXSTALL">clr TXSTALL</button>
    <button type="button" class="ipulse" data-wr="${regs.FDEBUG}" data-val="${1 << 16}" data-tip="W1C TXOVER">clr TXOVER</button>
    <button type="button" class="ipulse" data-wr="${regs.FDEBUG}" data-val="${1 << 8}" data-tip="W1C RXUNDER">clr RXUNDER</button>
    <button type="button" class="ipulse" data-wr="${regs.FDEBUG}" data-val="${1}" data-tip="W1C RXSTALL">clr RXSTALL</button></div></div>`;
  h += `<div class="ireg" data-tip="FLEVEL — live TX/RX nibbles">
    <div class="irhead"><span class="irn">FLEVEL</span><span class="ira">0x00c</span><span class="iro">tx ${st.txLevel} rx ${st.rxLevel}</span>
    <button type="button" class="ipulse" data-rd="${regs.FLEVEL}">READ</button></div></div>`;
  h += `<div class="ireg" data-tip="TXF${curSm} — write pushes one 32-bit word into SM${curSm}'s TX FIFO (refused at full)">
    <div class="irhead"><span class="irn">TXF${curSm}</span><span class="ira">${hex32(regs.TXF0 + 4 * curSm)}</span></div>
    <div class="ifields"><div class="ifield hex"><span class="ifn">word</span><span class="ifb">31:0</span><input type="text" id="insp-txf0" class="ihex" placeholder="0x…" maxlength="10" /></div>
    <button type="button" id="insp-txf0go">FEED</button></div></div>`;
  h += `<div class="ireg" data-tip="RXF${curSm} — read pops one word of SM${curSm}'s RX FIFO (the RX drain)">
    <div class="irhead"><span class="irn">RXF${curSm}</span><span class="ira">${hex32(regs.RXF0 + 4 * curSm)}</span><span class="iro">level ${st.rxLevel}</span>
    <button type="button" id="insp-rxf0">DRAIN</button></div></div>`;
  h += `<div class="ireg" data-tip="IRQ — 8 SM flags, W1C (the lamps above)">
    <div class="irhead"><span class="irn">IRQ</span><span class="ira">0x030</span><span class="iro">w1c — clear one flag</span></div>
    <div class="ifields btns">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<button type="button" class="ipulse" data-wr="${regs.IRQ}" data-val="${1 << i}" data-tip="clear flag ${i}">clr f${i}</button>`).join('')}</div></div>`;
  h += `<div class="ireg" data-tip="IRQ_FORCE — set flag i without side effects on pads">
    <div class="irhead"><span class="irn">IRQ_FORCE</span><span class="ira">0x034</span><span class="iro">set one flag</span></div>
    <div class="ifields btns">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<button type="button" class="ipulse" data-wr="${regs.IRQ_FORCE}" data-val="${1 << i}" data-tip="force flag ${i}">set f${i}</button>`).join('')}</div></div>`;
  h += `<div class="ireg" data-tip="INPUT_SYNC_BYPASS — per-GPIO: 1 bypasses the 2-FF input synchroniser">
    <div class="irhead"><span class="irn">ISB</span><span class="ira">0x038</span><span class="iro" id="insp-isb">—</span></div>
    <div class="ifields"><div class="ifield hex"><span class="ifn">mask</span><span class="ifb">31:0</span><input type="text" id="insp-isbval" class="ihex" value="0x00000000" maxlength="10" /></div>
    <button type="button" id="insp-isbgo">WRITE</button>
    <button type="button" class="ipulse" data-rd="${regs.ISB}">READ</button></div></div>`;
  h += `<div class="ireg" data-tip="DBG_PADOUT — the driven levels, live">
    <div class="irhead"><span class="irn">PADOUT</span><span class="ira">0x03c</span><span class="iro">${hex32(st.gpioOut)}</span></div></div>`;
  h += `<div class="ireg" data-tip="DBG_PADOE — the output enables, live">
    <div class="irhead"><span class="irn">PADOE</span><span class="ira">0x040</span><span class="iro">${hex32(st.gpioOe)}</span></div></div>`;
  h += `<div class="ireg" data-tip="DBG_CFGINFO — constant">
    <div class="irhead"><span class="irn">CFGINFO</span><span class="ira">0x044</span><span class="iro">0x10200404 · imem 32 · sm 4 · fifo 4</span></div></div>`;

  h += `<div class="igroup">SM${curSm} — the config overlay (settable; edits land as queued reg writes · the window follows the selected machine)</div>`;
  const groups = [
    ['clkdiv', 'CLKDIV', `SM${curSm}_CLKDIV`],
    ['pinctrl', 'PINCTRL', `SM${curSm}_PINCTRL`],
    ['execctrl', 'EXECCTRL', `SM${curSm}_EXECCTRL`],
    ['shiftctrl', 'SHIFTCTRL', `SM${curSm}_SHIFTCTRL`],
  ];
  for (const [group, label, regName] of groups) {
    const fields = VD.OVERLAY_GROUP_FIELDS(group);
    let fh = '';
    for (const [field, spec] of fields) fh += inspFieldRow(group, field, spec, OV[group][field]);
    h += `<div class="ireg" data-tip="${regName} @ ${hex32(VD.overlayAddr(curSm, group))} — compose ${hex32(VD.composeOverlay(group, OV[group]))}">
      <div class="irhead"><span class="irn">${label}</span><span class="ira">${group === 'clkdiv' ? '+0' : group === 'pinctrl' ? '+20' : group === 'execctrl' ? '+4' : '+8'}</span>
      <span class="iro">${hex32(VD.composeOverlay(group, OV[group]))}</span></div>
      <div class="ifields">${fh}</div></div>`;
  }
  h += `<div class="ireg" data-tip="SM${curSm}_ADDR — the live PC">
    <div class="irhead"><span class="irn">ADDR</span><span class="ira">+12</span><span class="iro">${st.pc}</span></div></div>`;
  h += `<div class="ireg" data-tip="SM${curSm}_INSTR — read: imem[pc]; write: FORCE-execute a word on SM${curSm} (delay ignored, bypasses the divider)">
    <div class="irhead"><span class="irn">INSTR</span><span class="ira">+16</span><span class="iro">0x${(BUILT[st.pc] || 0).toString(16).padStart(4, '0').toUpperCase()}</span></div>
    <div class="ifields"><div class="ifield hex"><span class="ifn">force</span><span class="ifb">15:0</span><input type="text" id="insp-force" class="ihex" placeholder="0x…" maxlength="6" /></div>
    <button type="button" id="insp-forcego">FORCE</button></div></div>`;
  h += `<div class="ireg" data-tip="RXF${curSm}_PUTGET0..3 — SM${curSm}'s aux-mode storage window (readable in txput, writable in txget)">
    <div class="irhead"><span class="irn">PUTGET</span><span class="ira">${hex32(regs.PUTGET0 + 0x10 * curSm)}</span><span class="iro" id="insp-putget">—</span></div>
    <div class="ifields btns">${[0, 1, 2, 3].map((y) => `<button type="button" class="ipulse" data-rd="${regs.PUTGET0 + 0x10 * curSm + 4 * y}">PG${y}</button>`).join('')}</div></div>`;
  h += `<div class="ireg"><span class="iro" id="insp-lastread">every READ/WRITE here retires one rendered clk</span></div>`;
  host.innerHTML = h;
  // wire the overlay field inputs (event delegation is awkward with
  // per-field ids — one listener each, set on rebuild)
  for (const [group] of groups) {
    for (const [field, spec] of VD.OVERLAY_GROUP_FIELDS(group)) {
      const el = $(`insp-${group}-${field}`);
      if (!el) continue;
      el.onchange = () => {
        const max = spec[2];
        const v = max === 'b' ? el.checked : Number(el.value);
        if (
          max !== 'b' &&
          (!Number.isInteger(v) || v < (max === 'thr' ? 1 : 0) || v > (max === 'thr' ? 32 : max))
        ) {
          el.value = OV[group][field];
          return;
        }
        ovEdit(group, field, v);
      };
    }
  }
  for (let i = 0; i < 4; i++) {
    const el = $(`insp-ctrl-smen${i}`);
    if (!el) continue;
    el.onchange = () => {
      // CTRL.SM_ENABLE is a whole-mask write (SPEC-7-2): rebuild it from
      // the checkboxes' checked set
      let mask = 0;
      for (let k = 0; k < 4; k++) {
        const c = $(`insp-ctrl-smen${k}`);
        if (c?.checked) mask |= 1 << k;
      }
      post({ cmd: 'regwrite', addr: regs.CTRL, data: mask });
    };
  }
  $('insp-txf0go').onclick = () => {
    const v = parseHexWord($('insp-txf0').value);
    if (Number.isInteger(v)) post({ cmd: 'enqueueword', word: v >>> 0, sm: curSm });
  };
  $('insp-rxf0').onclick = () => post({ cmd: 'drain', n: 1, sm: curSm });
  $('insp-isbgo').onclick = () => {
    const v = parseHexWord($('insp-isbval').value);
    if (Number.isInteger(v)) post({ cmd: 'regwrite', addr: regs.ISB, data: v >>> 0 });
  };
  $('insp-forcego').onclick = () => {
    const v = parseHexWord($('insp-force').value);
    if (Number.isInteger(v))
      post({ cmd: 'regwrite', addr: VD.overlayAddr(curSm, 'execctrl') + 12, data: v & 0xffff });
  };
}
// inspector action buttons (delegated): generic reads/writes
$('inspbody').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.rd !== undefined) {
    post({ cmd: 'regread', addr: +b.dataset.rd });
    return;
  }
  if (b.dataset.wr !== undefined) {
    post({ cmd: 'regwrite', addr: +b.dataset.wr, data: +b.dataset.val });
  }
});
// hex word entry (0x prefix optional — everything here is hex)
function parseHexWord(text) {
  const t = String(text).trim().replace(/^0x/i, '');
  return /^[0-9a-f]+$/i.test(t) ? Number.parseInt(t, 16) : Number.NaN;
}

// the regread replies land on the RO displays (each read was a real clk)
function noteRead(addr, rdata) {
  const map = { 8: 'insp-fdebug', 56: 'insp-isb' };
  const el = $(map[addr]);
  if (el) el.textContent = hex32(rdata);
  const last = $('insp-lastread');
  if (last)
    last.textContent = `last read 0x${addr.toString(16).padStart(3, '0')} = ${hex32(rdata)}`;
}

function render(st) {
  lensUi();
  renderSms(st);
  renderProgram(st);
  renderExec(st);
  renderFrameMap(st);
  renderRegs(st);
  renderWave(st);
  renderMonitor(st);
  renderPins(st);
  renderInspector();
  const fl = st.flashes || {};
  if (st.cycle !== V.lastFlashClk) {
    // one flash per clk, not per message
    if (fl.pull) flashPull();
    if (fl.push) flashPush();
    if (fl.jmp) flashJmp();
    if (fl.wrap) flashWrap();
    V.lastFlashClk = st.cycle;
  }
  if (LEVEL) levelJudge(st); // the profile is the judge until the level passes
}

// ================= modeless row editor (C19 discipline; the
// listing now re-decodes under the live overlay allocation) =============
const ED = $('edittxt'),
  HL = $('edithl'),
  POP = $('edpop'),
  STRIP = $('edcode'), // C31: the machine-code strip — its own always-on box
  RE = $('rowedit'),
  HOST = $('progrows');
const SIDE = $('edside'),
  DLY = $('eddly');
// C35: L1's one-cell modification surface — the delay-cell editor
const DED = $('dlyedit'),
  DCELL = $('dlycell');
let curRow = -1;
let asmErr = null; // row error of the last failed re-assembly (C19)

// ---- the listing as a listbox (C25) -------------------------------------
// The amber row cursor is view state (the group's remembered position);
// the PC row (.cur) is machine truth. They can coincide; they don't move
// together.
let kc = 0; // the row the listing's cursor sits on
function applyRowCursor() {
  for (let i = 0; i < 32; i++) $(`pr${i}`)?.classList.toggle('kc', i === kc);
  HOST.setAttribute('aria-activedescendant', `pr${kc}`);
}
function refocusListing() {
  // called BEFORE the editor hides: once the focused element is hidden,
  // Chromium resets the focus to body at its next rendering update and
  // stomps any focus() that raced it — transferring first sticks. When
  // focus already went elsewhere (a click-away commit) it stays there.
  if (RE.contains(document.activeElement)) HOST.focus();
}

// ---- the gutter pick walk (C25) -----------------------------------------
// Pick mode previews the jump edge on the walked row: an amber arc from
// the edited row plus a highlight; Enter inserts the address, Esc (or
// any stand-down) takes the preview with it. The 'picking' class alone
// is NOT the walk's state — the popup sets it as a gutter hint whenever
// a ↦ pick candidate is on show — so the live walk carries its own flag.
let pkRow = -1;
let pickLive = false;
function pickPreviewOff() {
  pkRow = -1;
  HOST.querySelectorAll('.jparc.prev, .jparr.prev').forEach((n) => {
    n.remove();
  });
  HOST.querySelectorAll('.pkw').forEach((n) => {
    n.classList.remove('pkw');
  });
}
function drawPickPreview() {
  HOST.querySelectorAll('.jparc.prev, .jparr.prev').forEach((n) => {
    n.remove();
  });
  if (pkRow < 0 || curRow < 0) return;
  const lo = Math.min(curRow, pkRow),
    hi = Math.max(curRow, pkRow);
  const arc = document.createElement('div');
  arc.className = 'jparc prev';
  arc.style.left = '35px'; // one lane past the committed arcs (LANES 4)
  arc.style.top = `${lo * 20 + 10}px`;
  arc.style.height = `${(hi - lo) * 20}px`;
  const arr = document.createElement('div');
  arr.className = 'jparr prev';
  arr.style.left = '42px';
  arr.style.top = `${pkRow * 20 + 6}px`;
  HOST.append(arc, arr);
}
function pickWalk(delta) {
  pkRow = Math.max(0, Math.min(31, pkRow + delta));
  HOST.querySelectorAll('.pkw').forEach((n) => {
    n.classList.remove('pkw');
  });
  $(`pr${pkRow}`)?.classList.add('pkw');
  drawPickPreview();
  $(`pr${pkRow}`)?.scrollIntoView({ block: 'nearest' });
}
function pickBegin() {
  pickLive = true;
  HOST.classList.add('picking');
  pkRow = Math.max(0, curRow);
  HOST.querySelectorAll('.pkw').forEach((n) => {
    n.classList.remove('pkw');
  });
  $(`pr${pkRow}`)?.classList.add('pkw');
  drawPickPreview();
}
function pickEnd() {
  if (!pickLive) return;
  pickLive = false;
  HOST.classList.remove('picking');
  pickPreviewOff();
}

function reassemble() {
  const words = new Array(32).fill(0);
  for (let i = 0; i < 32; i++) {
    if (!ROWS[i]) continue;
    const raw = ROWS[i].match(RAW_ROW);
    if (raw) {
      words[i] = Number.parseInt(raw[1], 16); // the aliased-bits marker row
      continue;
    }
    try {
      words[i] = PioAsm.assembleInstruction(ROWS[i], ASM_PROG, {}, `row ${i}`);
    } catch (e) {
      return { err: `${e.message}` };
    }
  }
  return { words };
}
function buildAndPush() {
  const r = reassemble();
  asmErr = r.err || null;
  if (!asmErr) {
    BUILT = r.words;
    // C36: the stored-program copy follows the build. A level page never
    // takes the autosave round-trip (levels ignore the sandbox's shared
    // state), so without this a level RESET would re-post the stale boot
    // words while the listing kept the edits — the machine and the page
    // would disagree. Reset restarts the EDITED program, never un-edits it.
    curState.words = BUILT.slice();
    const rows = wordsToRows(BUILT);
    PROG = BUILT.map((w, i) => ({ w, ...parseRow(rows[i]) }));
    post({ cmd: 'program', words: BUILT });
    requestAutosave();
  }
  updateUnbuilt();
}

const ISA = {
  // C32: the completion vocabularies live in the slot model
  // (row-complete.js, derived from PioAsm's own tables); this table is
  // the signature-help face — kind, sig, the params rows the detail pane
  // highlights (the slot model names the row), and the description.
  jmp: {
    sig: 'jmp [cond] <target>',
    kind: 'control',
    params: [
      ['cond', 'always · !x · x-- · !y · y-- · x != y · pin · !osre'],
      ['target', 'address 0–31 or a label'],
    ],
    desc: 'Jump if the condition holds. x--/y-- test BEFORE decrementing.',
  },
  wait: {
    sig: 'wait <pol> gpio|pin|irq|jmppin <index>',
    kind: 'control',
    params: [
      ['pol', '0 wait for low · 1 wait for high'],
      ['gpio', 'absolute GPIO number'],
      ['pin', 'pin relative to IN_BASE'],
      ['irq', 'flag; IRQ waits may use rel/prev/next'],
      ['jmppin', 'the EXECCTRL JMP_PIN input pin'],
    ],
    desc: 'Stall the SM until the source matches the polarity.',
  },
  in: {
    sig: 'in <src>, <count>',
    kind: 'data in',
    params: [
      ['src', 'pins · x · y · null · isr · osr'],
      ['count', '1–32 bits (0 means 32) shifted into ISR'],
    ],
    desc: 'Shift count bits from src into the ISR (right unless configured).',
  },
  out: {
    sig: 'out <dst>, <count>',
    kind: 'data out',
    params: [
      ['dst', 'pins · x · y · null · pindirs · pc · isr · exec'],
      ['count', '1–32 bits (0 means 32) shifted out of OSR'],
    ],
    desc: 'Shift count bits from the OSR to dst. pc = jump; exec = self-modifying.',
  },
  push: {
    sig: 'push [iffull] [block|noblock]',
    kind: 'fifo',
    params: [
      ['iffull', 'only if ISR reached its threshold'],
      ['block', 'stall until RX has room (default)'],
    ],
    desc: 'Write ISR to the RX FIFO and clear the shift counter.',
  },
  pull: {
    sig: 'pull [ifempty] [block|noblock]',
    kind: 'fifo',
    params: [
      ['ifempty', 'only if OSR is empty'],
      ['block', 'stall until TX has data (default)'],
    ],
    desc: 'Load OSR from the TX FIFO and clear the shift counter.',
  },
  mov: {
    sig: 'mov <dst>, [<op>] <src>',
    kind: 'transfer',
    params: [
      ['dst', 'pins · x · y · pindirs · exec · pc · isr · osr'],
      ['op', '~ invert · :: bit-reverse'],
      ['src', 'pins · x · y · null · status · isr · osr'],
    ],
    desc: 'Copy src to dst, optionally inverted or bit-reversed.',
  },
  irq: {
    sig: 'irq [set|wait|clear] <n> [rel|prev|next]',
    kind: 'sync',
    params: [
      ['mode', 'set — the default · wait — stall until it clears · clear — deassert'],
      ['n', 'flag 0–7'],
      ['rel', 'rel · prev · next — index relative to this SM'],
    ],
    desc: 'Signal other SMs; wait blocks until the flag clears.',
  },
  set: {
    sig: 'set <dst>, <data>',
    kind: 'immediate',
    params: [
      ['dst', 'pins · x · y · pindirs'],
      ['data', '5-bit immediate 0–31'],
    ],
    desc: 'Write a 5-bit constant to the destination.',
  },
  nop: {
    sig: 'nop',
    kind: 'control',
    params: [],
    desc: 'mov y, y — one free cycle.',
  },
};
const ARG_NOTES = {
  pins: 'mapped pins (LSB = base pin)',
  x: 'scratch X',
  y: 'scratch Y',
  null: 'discard',
  pindirs: 'pin direction register',
  pc: 'program counter',
  isr: 'in shift register',
  osr: 'out shift register (autopull reloads it)',
  exec: 'execute these bits as an instruction',
  status: 'the FIFO-status line fed to input muxes',
  rxfifo: 'RX FIFO storage (aux mov)',
  iffull: 'gate on ISR threshold',
  ifempty: 'gate on OSR empty',
  block: 'stall until possible',
  noblock: 'never stall — fall through',
  wait: 'wait irq mode/stall',
  clear: 'deassert the flag',
  rel: 'index relative to this SM',
  prev: "previous SM's flags",
  next: "next SM's flags",
  '!x': 'jump if X == 0',
  'x--': 'jump if X != 0, then decrement',
  '!y': 'jump if Y == 0',
  'y--': 'jump if Y != 0, then decrement',
  'x != y': 'jump if X != Y',
  pin: 'jump on JMP_PIN input',
  '!osre': 'jump if OSR shift counter < threshold',
  gpio: 'absolute GPIO number',
  pin2: 'pin relative to IN base',
  irq: 'IRQ flag',
  jmppin: 'the EXECCTRL JMP_PIN input pin',
};
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}
function parseRow(t) {
  let s = t.trim().replace(/\s+/g, ' ');
  let side = null,
    delay = 0,
    tgt = null;
  const mD = s.match(/\[(\d+)\]$/);
  if (mD) {
    delay = +mD[1];
    s = s.slice(0, mD.index).trim();
  }
  const mS = s.match(/\bside (\d+)$/);
  if (mS) {
    side = +mS[1];
    s = s.slice(0, mS.index).trim();
  }
  if (/^jmp\b/.test(s)) {
    const mJ = s.match(/,\s*(\d+)$/); // jmp <cond>, <target>
    if (mJ) {
      tgt = +mJ[1];
      s = s.slice(0, mJ.index).trim();
    } else {
      // jmp <target> — always-jump
      const mA = s.match(/^jmp\s+(\d+)$/);
      if (mA) {
        tgt = +mA[1];
        s = 'jmp';
      }
    }
  }
  const sp = s.indexOf(' ');
  return { op: sp < 0 ? s : s.slice(0, sp), args: sp < 0 ? '' : s.slice(sp + 1), side, delay, tgt };
}
function hlLine(l) {
  // one line of canonical source
  let body = esc(l)
    .replace(
      /^(\s*)(\.\w+)(.*)$/,
      (_m, a, d, r) => `${a}<span class="cfgtx on">${d}</span><span class="d">${r}</span>`,
    )
    .replace(/^(\s*)(\w+:)/, (_m, a, lb) => `${a}<span class="lbldef">${lb}</span>`)
    .replace(
      /^(\s*)(jmp|wait|in|out|push|pull|mov|irq|set|nop)\b/,
      (_m, a, op) => `${a}<span style="color:var(--amber)">${op}</span>`,
    );
  if (/^\s*jmp\b/.test(l))
    // dest address in the address font
    body = body.replace(/(\s)(\d+)(?=\s*(\[|$))/, `$1<span class="pcaddr">$2</span>`);
  return body.replace(/(\bside \d)|(\[\d+\])/g, (m) => `<span class="d">${m}</span>`);
}
function renderED() {
  HL.innerHTML = hlLine(ED.value) || ' ';
  renderEdCode();
}
// The row text exactly as commitRow will compose it (ins + side + [dly])
// — the preview assembles this, so it can never disagree with the commit.
function edRowText() {
  const ins = ED.value.trim().replace(/\s+/g, ' ');
  const sv = SIDE.value.trim(),
    dv = DLY.value.trim();
  const side = /^\d+$/.test(sv) ? ` side ${sv}` : '';
  const dly = /^\d+$/.test(dv) ? ` [${dv}]` : '';
  return (ins + side + dly).trim();
}
// The live machine-code preview: the editing row assembles under the
// CURRENT ds allocation, so the word — or the reason there is none — is
// visible before the commit, not only as the row tooltip afterwards.
function renderEdCode() {
  if (curRow < 0) {
    STRIP.innerHTML = '';
    STRIP.hidden = true;
    return;
  }
  const text = edRowText();
  let html;
  if (!text) {
    html = '<span class="dim">empty — commit clears the slot to 0x0000 · jmp 0</span>';
  } else {
    try {
      const w = PioAsm.assembleInstruction(text, ASM_PROG, {}, 'editor preview');
      const hex = `0x${w.toString(16).padStart(4, '0').toUpperCase()}`;
      const bin = w
        .toString(2)
        .padStart(16, '0')
        .replace(/(\d{4})(?=\d)/g, '$1 ');
      html = `<span class="ok">→ ${hex} · ${bin}</span>`;
    } catch (e) {
      html = `<span class="bad">✗ ${esc(String(e.message))}</span>`;
    }
  }
  STRIP.innerHTML = html;
  RE.dataset.tip = html.replace(/<[^>]+>/g, '');
  placeStrip();
}
// The strip anchors to the editor row (never the caret) and is on for
// the editor's whole life — any cell, any completion-list state (C31).
function placeStrip() {
  if (RE.hidden) {
    STRIP.hidden = true;
    return;
  }
  STRIP.hidden = false;
  const reb = RE.getBoundingClientRect();
  const h = STRIP.offsetHeight;
  let y = reb.bottom + 2;
  if (y + h > innerHeight - 8) y = reb.top - h - 2;
  STRIP.style.left = `${reb.left + scrollX}px`;
  STRIP.style.top = `${Math.max(8, y) + scrollY}px`;
}
function openRow(i, focus, seed) {
  // C34: levels scope the editor to their opcode whitelist — an empty
  // whitelist (L0: chapter 0 has no authoring) never opens the editor
  if (LEVEL && !LEVEL.opcodes.length) return;
  if (curRow >= 0 && !commitRow()) return; // the delay refusal keeps the editor put
  curRow = Math.max(0, Math.min(31, i));
  kc = curRow; // the listing cursor follows its editor anchor
  applyRowCursor();
  RE.hidden = false;
  RE.style.top = `${curRow * 20}px`;
  const p = parseRow(ROWS[curRow] || '');
  ED.value = ROWS[curRow]
    ? `${p.op}${p.args ? ` ${p.args}` : ''}${p.tgt != null ? (p.args ? ', ' : ' ') + p.tgt : ''}`
    : '';
  if (seed !== undefined) ED.value = seed; // type-ahead opened the editor
  SIDE.value = p.side ?? '';
  DLY.value = p.delay || '';
  const f = { ins: ED, side: SIDE, dly: DLY }[focus || 'ins'];
  f.focus();
  f.setSelectionRange(f.value.length, f.value.length);
  renderED();
  edSel = 0;
  popupShow(true); // a new row reopens the list (C31)
}
// C36: the delay cell refuses what the 5-bit field cannot hold — L5's
// ceiling must be legible on the authoring path too (#dlyedit already
// refuses for the delay-only levels). Without this the assembler would
// silently mask [48] to [16]: truthful on the re-decoded face, but a
// surprise with no reason. The edit stays open until it fits or cancels,
// the same contract #dlyedit keeps.
let edDlyTimer = 0;
function edDlyRefused() {
  const t = DLY.value.trim();
  return /^\d+$/.test(t) && +t > maxDelay() ? +t : null;
}
function edDlyDeny(n) {
  RE.dataset.status = `delay ${n} won't fit — the field is 0..${maxDelay()}`;
  updateStatus();
  DLY.classList.remove('deny');
  void DLY.offsetWidth;
  DLY.classList.add('deny');
  clearTimeout(edDlyTimer);
  edDlyTimer = setTimeout(() => {
    DLY.classList.remove('deny');
    RE.dataset.status = POP.hidden ? ROWED_KEYS_CLOSED : ROWED_KEYS_OPEN;
    updateStatus();
  }, 1600);
}
function commitRow() {
  if (curRow < 0) return true;
  const bad = edDlyRefused();
  if (bad !== null) {
    edDlyDeny(bad);
    return false; // the caller keeps the editor where it is
  }
  ROWS[curRow] = edRowText(); // the preview showed exactly this assembly
  kc = curRow;
  curRow = -1;
  refocusListing(); // while the editor still holds focus
  RE.hidden = true;
  STRIP.hidden = true;
  popupHide();
  pickEnd();
  buildAndPush(); // C19: re-assemble; on success patch the engine image
  buildProgram();
  render(V.state);
  return true;
}
function cancelRow() {
  curRow = -1;
  refocusListing(); // while the editor still holds focus
  RE.hidden = true;
  STRIP.hidden = true;
  popupHide();
  pickEnd();
}
function hopRow(delta, focus) {
  const n = Math.max(0, Math.min(31, curRow + delta));
  if (!commitRow()) return; // the delay refusal keeps the editor open
  openRow(n, focus);
}
function insertAtCaret(txt) {
  const { partial } = lineCtx();
  const s = ED.selectionStart;
  ED.value = ED.value.slice(0, s - partial.length) + txt + ED.value.slice(s);
  const np = s - partial.length + txt.length;
  ED.setSelectionRange(np, np);
  renderED();
}
HOST.addEventListener('click', (e) => {
  if (HOST.classList.contains('picking')) {
    // gutter pick: click an address
    const a = e.target.closest('.addr');
    if (a && /^\d+$/.test(a.textContent)) {
      insertAtCaret(a.textContent);
      pickEnd();
      HOST.classList.remove('picking'); // the hint goes too
      ED.focus();
    } else {
      pickEnd();
      HOST.classList.remove('picking'); // clicked elsewhere: stand down
    }
    return;
  }
  if (e.target.closest('#rowedit')) return;
  if (e.target.closest('#dlyedit')) return;
  const r = e.target.closest('.prow');
  // C35: in a delayCol-without-opcodes level the click edits the delay
  // cell (the row's one editable cell); openRow would no-op its empty
  // whitelist and leave the click dead
  if (r) {
    if (dlyLive()) openDly(+r.id.slice(2));
    else openRow(+r.id.slice(2));
  }
});
// the listbox keys (C25): the arrows move the row cursor, Enter opens
// the row on the instruction cell, and typing opens it with the char
// inserted. The editor's own cells have their own model (below). C35:
// in a delayCol-without-opcodes level the same gestures address the
// delay cell — Enter opens it, digits type ahead into it, letters are
// not authoring and do nothing.
HOST.addEventListener('keydown', (e) => {
  if (e.target !== HOST) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    kc = Math.max(0, Math.min(31, kc + (e.key === 'ArrowDown' ? 1 : -1)));
    applyRowCursor();
    $(`pr${kc}`)?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (dlyLive()) openDly(kc);
    else openRow(kc, 'ins');
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (dlyLive() && /\d/.test(e.key)) {
      e.preventDefault();
      openDly(kc, e.key); // the digit the delay cell opened under
    } else if (!dlyLive()) {
      e.preventDefault();
      openRow(kc, 'ins', e.key); // the char the row editor opened under
    }
  }
});
let edSel = 0,
  edCands = [];
// C31: the completion list is its own box that exists only while it has
// items for the caret's slot. Esc's close is remembered against the SLOT
// alone (which blank in the signature the caret sits in) — leaving the
// slot, a new row, or Ctrl+Space reopens; typing inside the slot keeps
// it closed. edSeen is the context the list was last computed for, so
// same-context caret moves leave the box untouched. C32: the slot is the
// completion model's identity (row-complete.js — 'push.blk', 'wait.pol'),
// not a token index: push's block flag sits at token 1 or 2 depending on
// whether iffull was given.
let edSupp = null; // the slot Esc closed the list on (null: nothing suppressed)
let edSlot = ''; // the slot the list on show was computed for
let edSeen = ''; // `slot|partial` of the last popupShow
// the row editor's key map follows the list's state — the status line
// narrates whichever is current (the HTML default is the closed map)
const ROWED_KEYS_OPEN =
  'row editor: list open — Tab accepts · ↑/↓ walk it · Enter commits the row · Esc closes the list';
const ROWED_KEYS_CLOSED = RE.dataset.status; // the HTML default is the closed map
function lineCtx() {
  // the caret's token context — the completion module's tokenizer (C32:
  // the same split drives the slot model; one source, no drift)
  return RowComplete.splitCtx(ED.value.slice(0, ED.selectionStart));
}
// C32: the suggestions come from the completion slot model
// (row-complete.js — per-instruction slots over the canonical
// signatures the disassembler spells, PioAsm-anchored, unit-tested; a
// slot whose token is already complete offers nothing). The view adds
// presentation: kinds, the detail notes, and the jmp target's
// gutter-pick gesture (a listing click/walk, not text — typing digits
// dismisses it, as ever).
function edModel() {
  // C35: the leash — in a level, the completion menu is scoped to the
  // level's unlocked opcode set (a filter over the slot model's
  // candidates); the sandbox's menu stays whole
  const a = RowComplete.analyze(
    ED.value.slice(0, ED.selectionStart),
    LEVEL ? { opcodes: LEVEL.opcodes } : undefined,
  );
  const cands = a.cands.map((c) =>
    a.slot === ''
      ? { t: c.t, kind: ISA[c.t].kind, detail: ISA[c.t], sep: c.sep }
      : {
          t: c.t,
          kind: c.param === 'cond' ? 'cond' : 'operand',
          detail: c.note || ARG_NOTES[c.t] || (/^\d+$/.test(c.t) ? 'number' : ''),
          sep: c.sep,
          param: c.param,
        },
  );
  if (
    (a.slot === 'jmp.cond' || a.slot === 'jmp.target') &&
    !/\d/.test(a.partial) &&
    (!LEVEL || LEVEL.opcodes.includes('jmp'))
  )
    cands.push({
      t: '↦ pick row',
      kind: 'pick',
      detail:
        a.slot === 'jmp.cond'
          ? 'No condition = always jump. Click an address in the gutter — the arc shows the edge. Or type a condition first.'
          : 'Click an address in the gutter — the jump arc shows the edge. Or type 0–31; typing digits dismisses this.',
    });
  return { slot: a.slot, partial: a.partial, cands };
}
function detailHTML(c) {
  const { toks } = lineCtx();
  const op = ISA[toks[0]];
  if (op && c.kind !== 'pick' && c.detail && !c.detail.sig) {
    const note = c.detail || '';
    // C32: the slot model names the params row the caret's slot is
    const hl = c.param || c.t;
    const rows = op.params
      .map(
        (p) =>
          `<tr class="${p[0] === hl ? 'curp' : ''}"><td class="k">${esc(p[0])}</td><td>${esc(p[1])}</td></tr>`,
      )
      .join('');
    return (
      `<div class="sig"><b>${esc(toks[0])}</b> ${esc(op.sig.split(' ').slice(1).join(' '))}</div>` +
      (note ? `<div style="color:var(--amber)">${esc(c.t)} — ${esc(note)}</div>` : '') +
      `<div>${esc(op.desc)}</div>` +
      (rows ? `<table>${rows}</table>` : '')
    );
  }
  if (c.detail?.sig) {
    const v = c.detail;
    return (
      `<div class="sig"><b>${esc(v.sig.split(' ')[0])}</b> ${esc(v.sig.split(' ').slice(1).join(' '))}</div>` +
      `<div>${esc(v.desc)}</div>` +
      (v.params.length
        ? `<table>${v.params.map(([k, d]) => `<tr><td class="k">${esc(k)}</td><td>${esc(d)}</td></tr>`).join('')}</table>`
        : '')
    );
  }
  return (
    `<div class="sig">${esc(c.t)}</div><div>${esc(c.detail || '')}</div>` +
    `<div class="spec">operand of ${toks[0] || '?'}</div>`
  );
}
function popupShow(force) {
  if (force) edSupp = null; // the explicit reopen: Ctrl+Space, a fresh row
  const m = edModel();
  edCands = m.cands;
  edSlot = m.slot;
  edSeen = `${m.slot}|${m.partial.toLowerCase()}`;
  if (edSupp !== null && edSlot !== edSupp) edSupp = null; // the close was spent on leaving
  if (!edCands.length || edSupp === edSlot) {
    popupHide();
    return;
  }
  edSel = Math.min(edSel, edCands.length - 1);
  const wantPick = edCands.some((c) => c.kind === 'pick');
  if (pickLive && !wantPick) pickEnd(); // typed past the pick — stand down
  if (!pickLive) HOST.classList.toggle('picking', wantPick); // the hint
  $('edcands').innerHTML = edCands
    .map(
      (c, i) =>
        `<div class="ecand${i === edSel ? ' sel' : ''}" data-i="${i}">${esc(c.t)}${c.kind ? `<span class="kind">${esc(c.kind)}</span>` : ''}</div>`,
    )
    .join('');
  $('eddetail').innerHTML = detailHTML(edCands[edSel]);
  POP.hidden = false;
  const mir = document.createElement('div');
  const cs = getComputedStyle(ED);
  for (const k of ['font', 'letterSpacing', 'whiteSpace', 'padding']) mir.style[k] = cs[k];
  mir.style.position = 'absolute';
  mir.style.visibility = 'hidden';
  mir.style.width = 'auto';
  mir.textContent = ED.value.slice(0, ED.selectionStart);
  const sp = document.createElement('span');
  sp.textContent = '​';
  mir.appendChild(sp);
  RE.appendChild(mir);
  const reb = RE.getBoundingClientRect();
  const x0 = reb.left + sp.offsetLeft - ED.scrollLeft;
  const w = POP.offsetWidth,
    h = POP.offsetHeight;
  const x = Math.max(8, Math.min(x0 - w * 0.15, innerWidth - w - 8));
  // stacked under the machine strip — its box is always up (C31)
  let y = STRIP.getBoundingClientRect().bottom + 2;
  if (y + h > innerHeight - 8) y = reb.top - h - 2;
  POP.style.left = `${x + scrollX}px`;
  POP.style.top = `${Math.max(8, y) + scrollY}px`;
  mir.remove();
  RE.dataset.status = ROWED_KEYS_OPEN;
  updateStatus();
}
function popupHide() {
  POP.hidden = true;
  if (!pickLive) HOST.classList.remove('picking');
  RE.dataset.status = ROWED_KEYS_CLOSED;
  updateStatus();
}
function accept(c) {
  if (c.kind === 'pick') {
    pickBegin();
    popupHide();
    ED.focus();
    return;
  }
  const { partial } = lineCtx();
  const s = ED.selectionStart;
  const before = ED.value.slice(0, s - partial.length);
  const after = ED.value.slice(s);
  // C32: the separator comes from the slot model — the canonical
  // spelling the disassembler emits (', ' only where it has a comma),
  // not a universal ', ' after the first operand
  ED.value = before + c.t + c.sep + after;
  const np = (before + c.t + c.sep).length;
  ED.setSelectionRange(np, np);
  renderED();
  edSel = 0;
  popupShow();
  ED.focus();
}
ED.addEventListener('input', () => {
  renderED();
  edSel = 0;
  popupShow();
});
ED.addEventListener('scroll', () => {
  HL.scrollLeft = ED.scrollLeft;
});
SIDE.addEventListener('input', renderEdCode);
DLY.addEventListener('input', renderEdCode);
ED.addEventListener('blur', () => popupHide());
// C31: the list follows the caret. A move that changes the token context
// (another slot, or a different partial inside this one) recomputes it;
// same-context moves leave the box untouched. selectionchange covers the
// keyboard path; the click handler nails the mouse path regardless.
function caretMoved() {
  if (curRow < 0 || pickLive || document.activeElement !== ED) return;
  const a = RowComplete.analyze(ED.value.slice(0, ED.selectionStart));
  if (`${a.slot}|${a.partial.toLowerCase()}` !== edSeen) {
    edSel = 0;
    popupShow();
  }
}
document.addEventListener('selectionchange', caretMoved);
ED.addEventListener('click', caretMoved);
ED.addEventListener('focus', () => {
  // the caret is back — so is its list (skipped mid-openRow, before the
  // strip is placed: openRow's own popupShow presents)
  if (curRow >= 0 && !pickLive && !STRIP.hidden) popupShow();
});
RE.addEventListener('focusout', (e) => {
  if (HOST.classList.contains('picking')) return;
  if (e.relatedTarget && RE.contains(e.relatedTarget)) return;
  setTimeout(() => {
    if (document.activeElement && RE.contains(document.activeElement)) return;
    commitRow();
  }, 0);
});
HOST.addEventListener('scroll', () => {
  popupHide(); // the caret anchor went stale
  placeStrip(); // the strip follows its editor row
});
addEventListener('resize', () => {
  popupHide();
  placeStrip();
});
SIDE.addEventListener('focus', () => HOST.classList.remove('picking'));
DLY.addEventListener('focus', () => HOST.classList.remove('picking'));
ED.addEventListener('keydown', (e) => {
  if (pickLive) {
    // gutter pick (C25): the arrows walk the previewed edge, Enter
    // inserts the walked address, Esc stands down — still editing
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      pickWalk(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      pickWalk(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      insertAtCaret(String(pkRow));
      pickEnd();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      pickEnd(); // stand down — still editing
    }
    return;
  }
  if (e.key === ' ' && e.ctrlKey) {
    e.preventDefault();
    popupShow(true); // C31: the explicit reopen
    return;
  }
  if (!POP.hidden && edCands.length) {
    // C31: while the list is open it owns the vertical keys and Tab;
    // Enter commits in BOTH states — one key, one meaning
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      edSel = (edSel + 1) % edCands.length;
      popupShow();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      edSel = (edSel - 1 + edCands.length) % edCands.length;
      popupShow();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      accept(edCands[edSel]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      hopRow(1); // commits the row — no Escape-before-Enter dance
    } else if (e.key === 'Escape') {
      e.preventDefault();
      popupHide();
      edSupp = edSlot; // and it stays closed for this slot
    }
    return;
  }
  if (e.key === 'Enter' || e.key === 'ArrowDown') {
    e.preventDefault();
    hopRow(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    hopRow(-1);
  } else if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    hopRow(-1, 'dly');
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelRow();
  }
});
function rowCellKeys(e) {
  if (e.key === 'Enter' || e.key === 'ArrowDown') {
    e.preventDefault();
    hopRow(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    hopRow(-1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelRow();
  }
}
SIDE.addEventListener('keydown', rowCellKeys);
DLY.addEventListener('keydown', (e) => {
  rowCellKeys(e);
  if (!e.defaultPrevented && e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    hopRow(1);
  }
});
$('edcands').addEventListener('mousedown', (e) => {
  const c = e.target.closest('.ecand');
  if (c) {
    e.preventDefault();
    accept(edCands[+c.dataset.i]);
  }
});

// ---- C35: the delay cell — L1's one-cell modification ---------------------
// The fade's first rung after the worked example: a level that has taught
// the delay column but not authoring (opcodes still empty — the row
// editor is L2's debut) edits exactly one cell, the row's [n] delay. The
// instruction stays as given; the delay cell is the whole editor. The
// sandbox never routes here (its row editor owns delay edits) and neither
// does L2+ (the row editor's own delay cell does) — this surface exists
// for delayCol-without-opcodes levels alone.
let dlyRow = -1;
let dlyStatusTimer = 0;
const dlyLive = () => !!LEVEL && !LEVEL.opcodes.length && lvUnlock('delayCol');
function openDly(i, seed) {
  if (!dlyLive() || !ROWS[i]) return; // only a row that exists has a delay
  dlyRow = i;
  kc = dlyRow; // the listing cursor follows the cell being edited
  applyRowCursor();
  DED.hidden = false;
  DED.style.top = `${dlyRow * 20}px`;
  DCELL.value = seed !== undefined ? String(seed) : String(parseRow(ROWS[dlyRow]).delay || '');
  DCELL.focus();
  DCELL.setSelectionRange(DCELL.value.length, DCELL.value.length);
}
// the row with its delay replaced — parseRow splits the canonical parts,
// the cell re-composes them (the same compose edRowText performs)
function dlyRowText(n) {
  const p = parseRow(ROWS[dlyRow]);
  const ins = `${p.op}${p.args ? ` ${p.args}` : ''}${
    p.tgt != null ? `${p.args ? ', ' : ' '}${p.tgt}` : ''
  }${p.side != null ? ` side ${p.side}` : ''}`;
  return n ? `${ins} [${n}]` : ins;
}
function dlyDeny(n) {
  // the 5-bit ceiling is legible, not silent — L5 teaches the budget
  // formally; here it just refuses, with the reason on the status line
  DED.dataset.status = `delay ${n} won't fit — the field is 0..${maxDelay()}`;
  updateStatus();
  DED.classList.remove('deny');
  void DED.offsetWidth;
  DED.classList.add('deny');
  clearTimeout(dlyStatusTimer);
  dlyStatusTimer = setTimeout(() => {
    DED.dataset.status = 'delay cell: type 0–31 · Enter commits · Tab crosses rows · Esc cancels';
    updateStatus();
  }, 1600);
}
function commitDly() {
  if (dlyRow < 0) return;
  const t = DCELL.value.trim();
  if (/^\d+$/.test(t) && +t > maxDelay()) {
    dlyDeny(+t);
    DCELL.focus();
    return; // out of range: the edit stays open until it fits or cancels
  }
  const n = /^\d+$/.test(t) ? +t : 0;
  ROWS[dlyRow] = dlyRowText(n);
  kc = dlyRow;
  dlyRow = -1;
  dlyRefocus();
  DED.hidden = true;
  buildAndPush(); // re-assemble; on success patch the engine image (C19)
  buildProgram();
  render(V.state);
}
function cancelDly() {
  dlyRow = -1;
  dlyRefocus();
  DED.hidden = true;
}
// the row editor's own refocus rule: transfer focus BEFORE hiding, or
// Chromium's next rendering update stomps it back to body
function dlyRefocus() {
  if (DED.contains(document.activeElement)) HOST.focus();
}
function hopDly(delta) {
  const from = dlyRow;
  commitDly();
  // the crossing lands on the next row that HAS an instruction — an
  // empty slot has no delay to edit
  for (let n = from + delta; n >= 0 && n < 32; n += delta) if (ROWS[n]) return openDly(n);
}
DCELL.addEventListener('input', () => {
  DCELL.value = DCELL.value.replace(/\D/g, '').slice(0, 2);
});
DCELL.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'ArrowDown') {
    e.preventDefault();
    hopDly(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    hopDly(-1);
  } else if (e.key === 'Tab') {
    e.preventDefault();
    hopDly(e.shiftKey ? -1 : 1); // Tab crosses rows (the C25/C31 contract)
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelDly();
  }
});
DED.addEventListener('focusout', (e) => {
  if (e.relatedTarget && DED.contains(e.relatedTarget)) return;
  setTimeout(() => {
    if (document.activeElement && DED.contains(document.activeElement)) return;
    commitDly(); // a click-away commits, exactly like the row editor
  }, 0);
});

// ---- ds allocator: REAL PINCTRL/EXECCTRL writes through the overlay ----
function allocChanged() {
  buildProgram();
  render(V.state);
  requestAutosave();
}
$('ssminus').onclick = () => {
  const a = allocOf(OV);
  if (a.sideBits > 0) {
    const nb = a.sideBits - 1;
    ovEdit('pinctrl', 'ssCnt', nb + (a.opt ? 1 : 0));
    if (!nb) ovEdit('execctrl', 'sideEn', false);
    allocChanged();
  }
};
$('ssplus').onclick = () => {
  const a = allocOf(OV);
  if (a.sideBits < 5) {
    ovEdit('pinctrl', 'ssCnt', a.sideBits + 1 + (a.opt ? 1 : 0));
    allocChanged();
  }
};
$('ssopt').onchange = (e) => {
  const a = allocOf(OV);
  ovEdit('execctrl', 'sideEn', e.target.checked && !!a.sideBits);
  allocChanged();
};

// ---- RX drain buttons + IRQ lamp W1C ------------------------------------
$('bdrain').onclick = () => post({ cmd: 'drain', n: 1, sm: curSm });
$('bdrainall').onclick = () => {
  const s = V.state.sms[curSm];
  const avail = s ? s.rxMirror.pushes - s.rxMirror.drains : 0;
  if (avail > 0) post({ cmd: 'drain', n: avail, sm: curSm });
};
$('irqlamps').addEventListener('click', (e) => {
  const l = e.target.closest('.ilamp[data-flag]');
  if (l) post({ cmd: 'regwrite', addr: VD.REG.IRQ, data: 1 << +l.dataset.flag });
});

// ---- the select options (pins 0..31) ------------------------------------
{
  const sel = $('patpin');
  for (let p = 0; p < 32; p++) sel.add(new Option(`${p}`, String(p)));
}
$('patpin').value = '0';

// ---- boot ----------------------------------------------------------------
addEventListener('error', (e) => {
  const f = document.querySelector('footer');
  if (f)
    f.insertAdjacentHTML(
      'afterbegin',
      `<span style="color:var(--red)">PAGE ERROR: ${e.message} @${e.lineno}</span>`,
    );
});
enableCtrls(false);
ROWS.splice(0, ROWS.length, ...wordsToRows(BUILT));
PROG = BUILT.map((w, i) => ({ w, ...parseRow(ROWS[i]) }));
syncAsmContext();
buildProgram();
buildBits($('osrbits'));
buildBits($('isrbits'));
patternUi();
if (LEVEL) buildLevelBand();
render(V.state);
updateStatus(); // the status line opens on the body key map

function applyUrlParams() {
  // a level page ignores the sandbox's shareable states — the level IS
  // the state (the boot loaded its program already)
  if (LEVEL) return;
  // shareable states: ?demo=1 loads the uart demo, ?t=N pre-runs N cycles
  // (one worker batch), ?run=1 autoplays, ?ss=N&opt=0 preset the ds-field
  // allocation (the overlay fields); editor demo states (?row/?complete/
  // ?pick) stay view-local as in the mock-up.
  const q = new URLSearchParams(location.search);
  if (q.get('demo')) {
    loadState(VD.DEMO_UART_TX);
  } else if (q.has('ss')) {
    const sb = Math.min(5, Math.max(0, Math.round(+q.get('ss')) || 0));
    const opt = q.get('opt') !== '0' && !!sb;
    ovEdit('pinctrl', 'ssCnt', sb + (opt ? 1 : 0));
    ovEdit('execctrl', 'sideEn', opt);
    rebuildListing();
  }
  const t = Math.min(+q.get('t') || 0, 200000);
  if (t > 0) post({ cmd: 'run', cycles: t });
  if (q.get('run')) run();
  if (q.get('row') != null) {
    openRow(Math.max(0, Math.min(31, Math.round(+q.get('row')) || 0)));
  } else if (q.get('complete') || q.get('pick')) {
    openRow(4);
    if (q.get('complete')) ED.value = q.get('complete');
    if (q.get('pick')) {
      ED.value = 'jmp x--,';
      pickBegin();
      popupHide();
    }
    renderED();
    if (!q.get('pick')) {
      edSel = 0;
      popupShow();
    }
    ED.focus();
  }
}

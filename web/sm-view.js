// sm-view.js — the C21 sandbox SM view client logic (KANBAN C18/C19/C21).
//
// Every machine value rendered here (pins, PC, phase, X/Y, OSR/ISR,
// counters, FIFO levels, IRQ flags) comes from the wasm engine's
// per-clk state snapshot, posted by the Web Worker (engine-worker.js /
// engine-driver.js — the CI-gated core). What stays local is
// presentation: the canonical listing display (C19: derived by
// disassembling the loaded words through pio-asm.js under the CURRENT
// ds-field allocation, and committed edits re-assemble under it — the
// new build is patched into the live engine one rendered clk per
// changed word), the register inspector (the datasheet map — every
// field readable and settable, tooltips citing SPEC-7-x; settable
// config fields go through the driver's overlay as queued reg writes),
// the pin I/O strip (drive latches + the pattern generator + engine
// output ownership), the RX drain panel, the monitor lens selector,
// and the persistence glue (localStorage autosave + JSON export/import
// of the stored-program format; the serializer itself is pure driver
// code, CI-checked).
'use strict';

const $ = (id) => document.getElementById(id); // declared first: the transport
// wiring below uses it at top level

// ================= the sandbox state (the view's copy) ==================
// Boot: localStorage autosave if present, else EMPTY (all-zero memory —
// the jmp-0 park). The old level-02 uart_tx is the loadable demo.
const SAVE_KEY = 'vibe-pio-sandbox';
const VD = VibeDriver;

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

let curState = savedState() || VD.newState(); // the view's stored-program copy

// The authored .side_set context the listing assembles/disassembles
// under: it FOLLOWS the current overlay split (PINCTRL.SIDESET_COUNT +
// EXECCTRL.SIDE_EN — the ds slider and the inspector edit the same
// fields), so committed rows and the machine's re-decode always agree.
const ASM_PROG = PioAsm.createProgram('sandbox');
let BUILT = curState.words.slice(); // the image the engine runs (C19 patch target)
let lensPin = 0; // wave + lens target (the lens selector moves it)

// ds-field allocation, derived from the overlay (SPEC-4-1..3)
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
// the driver's ov is the truth; this local copy renders between clks)
let OV = {
  clkdiv: { ...curState.clkdiv },
  pinctrl: { ...curState.pinctrl },
  execctrl: { ...curState.execctrl },
  shiftctrl: { ...curState.shiftctrl },
};

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

const WIN = 128;

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
    post({ cmd: 'load', state: curState });
    applyUrlParams();
    return;
  }
  if (m.cmd === 'state') {
    V.inflight = false;
    const prev = OV;
    V.state = m.state;
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
    if (m.json) autosave(m.json);
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
function run() {
  if (!V.ready) return;
  if (timer) {
    pause();
    return;
  }
  timer = setInterval(runTick, +$('speed').value);
  $('brun').textContent = '❚❚ PAUSE';
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
  $('brun').textContent = '▶ RUN';
  $('brun').classList.remove('on');
}
function enableCtrls(on) {
  for (const id of ['breset', 'brun', 'bstep', 'binsn']) $(id).disabled = !on;
}
$('brun').onclick = run;
$('breset').onclick = () => {
  pause();
  asmErr = null;
  rebuildListing(); // back to the stored program's listing
  post({ cmd: 'reset', state: curState }); // reload the stored program
};
$('bstep').onclick = () => {
  pause();
  post({ cmd: 'step' });
};
$('binsn').onclick = () => {
  pause();
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
  post({ cmd: 'enqueue', bytes });
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !POP.hidden) {
    popupHide();
    HOST.classList.remove('picking');
    return;
  }
  const t = e.target;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
  if (!V.ready) return;
  if (e.code === 'Space') {
    e.preventDefault();
    pause();
    post({ cmd: 'step' });
  } else if (e.key === 'r' || e.key === 'R') run();
  else if (e.key === 'i' || e.key === 'I') $('binsn').onclick();
  else if (e.key === '0') $('breset').onclick();
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
      $('bcopy').textContent = '✓ LISTING';
      setTimeout(() => ($('bcopy').textContent = '⧉ LISTING'), 900);
    },
    () => {},
  );
};

// ---- overlay edits (the inspector + the ds slider ride these) ----------
function ovEdit(group, field, value) {
  curState[group][field] = value; // the view's stored-program copy
  post({ cmd: 'overlay', group, field, value });
  requestAutosave();
}

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
    if (!ROWS[i]) {
      r.className = 'prow empty';
      r.id = `pr${i}`;
      r.title =
        '0x0000 · jmp 0 — untouched memory (all-zero reset); if executed, control jumps to slot 00';
      r.innerHTML = `<span class="addr">${i.toString().padStart(2, '0')}</span><span class="ins">·</span><span></span><span></span><span class="chips"></span>`;
      nodes.push(r);
      continue;
    }
    const p = parseRow(ROWS[i]);
    const eff = EFF[i];
    const side = eff.side,
      dly = eff.delay;
    const sideHtml =
      side == null
        ? `<span title="${allocOf(OV).opt ? 'opt enable bit is 0 — no side applied' : 'no side-set allocated (ds is all delay)'}">—</span>`
        : `<span>side <b>${side}</b></span>`;
    const dlyHtml = dly ? `<span>[${dly}]</span>` : `<span title="delay 0">—</span>`;
    r.title = `0x${PROG[i].w.toString(16).padStart(4, '0').toUpperCase()} · ${ROWS[i]}`;
    r.className = 'prow';
    r.id = `pr${i}`;
    const tgtHtml =
      p.tgt != null ? `${p.args ? ', ' : ''}<span class="pcaddr">${p.tgt}</span>` : '';
    r.innerHTML =
      `<span class="addr">${i.toString().padStart(2, '0')}</span>` +
      `<span class="ins"><span class="op">${esc(p.op)}</span> <span>${esc(p.args)}${tgtHtml}</span></span>` +
      `<span class="cside">${sideHtml}</span><span class="cdly">${dlyHtml}</span>` +
      `<span class="chips"></span>`;
    nodes.push(r);
  }
  // the wrap arc is LIVE config: EXECCTRL.WRAP_TOP/BOTTOM (SPEC-7-19)
  const wrapTop = OV.execctrl.wrapTop,
    wrapBot = OV.execctrl.wrapBot;
  const arc = document.createElement('div');
  arc.id = 'wraparc';
  arc.title = `config · WRAP (SPEC-7-19): after insn ${wrapTop} the PC returns to ${wrapBot} instead of falling through — set it in the inspector`;
  arc.style.top = `${wrapBot * 20 + 10}px`;
  arc.style.height = `${Math.max(0, wrapTop - wrapBot) * 20}px`;
  nodes.push(arc);
  const ah = document.createElement('div');
  ah.id = 'wraparrow';
  ah.title = arc.title;
  ah.style.top = `${wrapBot * 20 + 6}px`;
  nodes.push(ah);
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
    el.title = `jmp: ${a.i.toString().padStart(2, '0')} ↷ ${a.tgt.toString().padStart(2, '0')}`;
    el.style.left = `${x}px`;
    el.style.top = `${a.lo * 20 + 10}px`;
    el.style.height = `${(a.hi - a.lo) * 20}px`;
    nodes.push(el);
    const t = document.createElement('div');
    t.className = 'jparr';
    t.title = el.title;
    t.style.left = `${x + 7}px`;
    t.style.top = `${a.tgt * 20 + 6}px`;
    nodes.push(t);
  }
  host.replaceChildren(...nodes, RE);
  const usedN = ROWS.filter(Boolean).length;
  $('usedct').textContent = `${usedN}/32`;
  $('wordsct').textContent = usedN;
  $('freect').textContent = 32 - usedN;
  updateUnbuilt();
  renderAlloc();
  renderInspector();
}
function updateUnbuilt() {
  const u = $('unbuilt');
  if (!u) return;
  u.hidden = !asmErr;
  if (asmErr) u.title = `edits do not assemble — ${asmErr} — the machine runs the last good build`;
}
function renderAlloc() {
  const h = $('dspips');
  h.innerHTML = '';
  const a = allocOf(OV);
  const total = a.sideBits + (a.opt ? 1 : 0);
  for (let k = 0; k < 5; k++) {
    const d = document.createElement('div');
    d.className = `pip${k < total ? (k === 0 && a.opt ? ' en' : ' s') : ' d'}`;
    d.title =
      k < total
        ? k === 0 && a.opt
          ? 'opt-enable bit — per-instruction side on/off (SPEC-4-2)'
          : 'side data bit → gpio'
        : `delay bit (max delay ${maxDelay()})`;
    h.appendChild(d);
  }
  $('ssminus').disabled = !a.sideBits;
  $('ssplus').disabled = a.sideBits >= 5;
  $('ssopt').disabled = !a.sideBits;
  $('ssopt').checked = a.opt && !!a.sideBits;
  $('dsinfo').innerHTML =
    `side ${a.sideBits}b${a.opt ? '+opt' : ''} · delay [0..${maxDelay()}] · PINCTRL.SIDESET_COUNT=${ssCntOf(OV)} (SPEC-7-26)`;
  const st = $('sidetag');
  const sc = OV.pinctrl;
  st.textContent = sc.ssCnt
    ? `side gpio${sc.ssBase}·${Math.max(0, sc.ssCnt - (sideEnOf(OV) ? 1 : 0))}${sideEnOf(OV) ? '+opt' : ''}`
    : 'side —';
}
function flashWrap() {
  const a = $('wraparc');
  if (!a) return;
  a.classList.add('flash');
  setTimeout(() => a.classList.remove('flash'), 240);
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
  const disp = st.displayPc;
  for (let i = 0; i < 32; i++) {
    const r = $(`pr${i}`);
    if (!r) continue;
    const cur = i === disp;
    r.classList.toggle('cur', cur);
    const chips = r.querySelector('.chips');
    chips.innerHTML = '';
    if (cur) {
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

function renderExec(st) {
  const disp = st.displayPc,
    p = PROG[disp],
    e = EFF[disp] || { delay: 0, side: null };
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
  $('autopulltag').textContent = sc.autopull ? `autopull — thr ${sc.pullThr}` : 'autopull — off';
  $('autopushtag').textContent = sc.autopush ? `autopush — thr ${sc.pushThr}` : 'autopush — off';
  $('osrdir').textContent = sc.outRight ? 'out → pins →' : '← pins ← out';
  $('isrdir').textContent = sc.inRight ? 'pins → in' : 'in ← pins';
  $('isrnote').textContent = st.isrCnt ? `${st.isrCnt} shifted in` : 'idle';

  const depth = st.fifoDepths.tx;
  const slots = $('fslots');
  slots.innerHTML = '';
  for (let i = 0; i < depth; i++) {
    const d = document.createElement('div');
    const full = i < st.txWords.length;
    d.className = `fslot${full ? ' full' : ''}${i === 0 ? ' next' : ''}${i >= 4 ? ' borrowed' : ''}`;
    if (i >= 4 && depth === 8)
      d.title = 'config · storage borrowed from RX via FIFO JOIN TX (SPEC-6-2)';
    d.innerHTML = `<span class="idx">${i}</span><span class="hexv">${full ? hex32(st.txWords[i]) : '········'}</span><span class="chv">${full ? ascii(st.txWords[i]) : ''}</span>`;
    slots.appendChild(d);
  }
  const joinChip = $('joinchip');
  const mode = sc.fjoinRxPut
    ? sc.fjoinRxGet
      ? 'putget'
      : 'txput'
    : sc.fjoinRxGet
      ? 'txget'
      : sc.fjoinTx
        ? 'join TX'
        : sc.fjoinRx
          ? 'join RX'
          : 'split';
  joinChip.textContent = mode;
  joinChip.classList.toggle('on', mode !== 'split');
  $('txdepth').textContent = depth;
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
  $('rxdepth').textContent = rdepth;
  $('rxdepth2').textContent = rdepth;
  $('rxlvl').textContent = st.rxLevel;
  $('rxlvlfill').style.height = `${rdepth ? (100 * st.rxLevel) / rdepth : 0}%`;
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
    lh += `<span class="ilamp${(flags >> i) & 1 ? ' on' : ''}" title="IRQ flag ${i} — ${(flags >> i) & 1 ? 'SET' : 'clear'} · click = W1C via IRQ (SPEC-7-6)" data-flag="${i}">f${i}</span>`;
  lh += `<span class="ilamp sub${(st.intr >> 4) & 1 ? ' on' : ''}" title="TXNFULL SM0 (SPEC-7-12)">tx¬full</span>`;
  lh += `<span class="ilamp sub${st.intr & 1 ? ' on' : ''}" title="RXNEMPTY SM0 (SPEC-7-12)">rx¬empty</span>`;
  lamps.innerHTML = lh;

  // header chips
  const cd = OV.clkdiv;
  const div = (cd.intg || 65536) + cd.frac / 256;
  $('clkdivtag').textContent = `clkdiv ÷${div.toFixed(2)}`;
  const pc2 = OV.pinctrl;
  $('outmaptag').textContent = `out gpio${pc2.outBase}·${pc2.outCnt || 32}`;
  $('inmaptag').textContent = `in gpio${pc2.inBase}·${OV.shiftctrl.inCount || 32}`;
}

// ---- pin strip: drive latches, pattern source, engine outputs ---------
function renderPins(st) {
  const host = $('pincells');
  const drives = st.drives;
  const patPin = st.pattern.mode !== 'off' ? st.pattern.pin : -1;
  let h = '';
  for (let p = 0; p < 32; p++) {
    const oe = (st.gpioOe >> p) & 1;
    const lvl = (st.gpioOut >> p) & 1;
    const drv = drives[p];
    const cls = [
      'pcell',
      oe ? 'oe' : '',
      drv === 1 ? 'dh' : drv === 0 ? 'dl' : '',
      lvl ? 'hi' : '',
      p === patPin ? 'pat' : '',
      p === lensPin ? 'sel' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const tips = [
      `pin ${p}`,
      oe ? `engine OUTPUT — level ${lvl}` : 'engine input',
      drv === null ? 'drive latch released (Z)' : `drive latch HELD at ${drv}`,
      patPin === p ? `pattern source (${st.pattern.mode})` : '',
      p === lensPin ? 'lens/wave target' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    h += `<div class="${cls}" data-pin="${p}" title="${tips}"><span class="pn">${p}</span><span class="pl">${lvl}</span><span class="pm">${oe ? '▲' : drv !== null ? 'D' : ''}${patPin === p ? '◆' : ''}</span></div>`;
  }
  host.innerHTML = h;
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
function lensUi() {
  $('lensmode').value = V.state.lens.mode;
  $('lenspin').value = String(lensPin);
}
$('lensmode').onchange = () => post({ cmd: 'lens', mode: $('lensmode').value, pin: lensPin });
$('lenspin').onchange = () =>
  post({ cmd: 'lens', mode: $('lensmode').value, pin: +$('lenspin').value });

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
  $('framemap').style.visibility = mode === 'uart' ? 'visible' : 'hidden';
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
const colOf = { data: 'var(--green)', ctrl: 'var(--amber)', idle: 'var(--dim)' };
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
      s += `<text x="${x + 3}" y="${RULY}" fill="var(--dimmer)" font-size="9" font-family="var(--mono)">${c0 + k}</text>`;
  }
  $('wavelabel').textContent =
    `gpio${lensPin} · ${st.lens.mode === 'off' ? 'raw' : st.lens.mode} lens`;
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
    s += `<path d="M${x0} ${y} L${x1} ${y}" stroke="${col}" stroke-width="2.4"/>`;
    i = j;
  }
  i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && tags[j] === tags[i]) j++;
    if (j - i >= 3 && tags[i]) {
      const col = colOf[classOf(tags[i])];
      s += `<text x="${((i + j) * CW) / 2}" y="${TAGY}" fill="${col}" font-size="9" font-family="var(--mono)" text-anchor="middle" opacity=".85">${tags[i]}</text>`;
    }
    i = j;
  }
  s += `<line x1="${n * CW - 1}" y1="6" x2="${n * CW - 1}" y2="${LO + 6}" stroke="var(--amber)" stroke-width="1" opacity=".8"/>`;
  s += `<text x="${n * CW - 5}" y="${RULY}" fill="var(--amber)" font-size="9" font-family="var(--mono)" text-anchor="end">${st.cycle}</text>`;
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

// ---- the register inspector (datasheet map, SPEC-7-x tooltips) ---------
// Settable config fields ride the overlay; action rows (CTRL pulses, IRQ
// W1C/force, FDEBUG W1C, SM0_INSTR force) are generic reg writes; RO rows
// render live from the cycle sample or via a queued READ (a real clk).
function inspFieldRow(group, field, spec, val) {
  const [hi, lo, max] = spec;
  const id = `insp-${group}-${field}`;
  const bits = hi === lo ? `${hi}` : `${hi}:${lo}`;
  const tip = `${group}.${field} — bits ${bits} (SPEC-7-${group === 'clkdiv' ? 14 : group === 'pinctrl' ? 26 : group === 'execctrl' ? (field.startsWith('wrap') ? '19' : '16') : '21'})`;
  let ctrl;
  if (max === 'b') {
    ctrl = `<input type="checkbox" id="${id}" ${val ? 'checked' : ''} />`;
  } else if (max === 'thr') {
    ctrl = `<input type="number" id="${id}" value="${val}" min="1" max="32" />`;
  } else {
    ctrl = `<input type="number" id="${id}" value="${val}" min="0" max="${max}" />`;
  }
  return `<div class="ifield" title="${tip}"><span class="ifn">${field}</span><span class="ifb">${bits}</span>${ctrl}</div>`;
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
  h += `<div class="ireg" title="CTRL (SPEC-7-2..5): SM_ENABLE + the SM_RESTART / CLKDIV_RESTART pulses">
    <span class="irn">CTRL</span><span class="ira">0x000</span>
    <div class="ifields">
      <div class="ifield" title="SM_ENABLE bit0 (SPEC-7-2) — SM0 on/off"><span class="ifn">SM_EN</span><span class="ifb">0</span><input type="checkbox" id="insp-ctrl-smen" /></div>
      <button type="button" class="ipulse" data-wr="${regs.CTRL}" data-val="${1 << 4}" title="SM_RESTART bit4 (SPEC-7-3): clears shift counters, ISR, delay, WAIT state — one clk">SM_RESTART</button>
      <button type="button" class="ipulse" data-wr="${regs.CTRL}" data-val="${1 << 8}" title="CLKDIV_RESTART bit8 (SPEC-7-4): divider back to phase 0">CLKDIV_RESTART</button>
    </div></div>`;
  h += `<div class="ireg" title="FSTAT (SPEC-7-29) — live from the cycle sample">
    <span class="irn">FSTAT</span><span class="ira">0x004</span><span class="iro">${fstatLive}</span>
    <button type="button" class="ipulse" data-rd="${regs.FSTAT}">READ</button></div>`;
  h += `<div class="ireg" title="FDEBUG (SPEC-7-29) — sticky flags, W1C; READ costs one rendered clk">
    <span class="irn">FDEBUG</span><span class="ira">0x008</span><span class="iro" id="insp-fdebug">—</span>
    <button type="button" class="ipulse" data-rd="${regs.FDEBUG}">READ</button>
    <button type="button" class="ipulse" data-wr="${regs.FDEBUG}" data-val="${1 << 24}" title="W1C TXSTALL">clr TXSTALL</button>
    <button type="button" class="ipulse" data-wr="${regs.FDEBUG}" data-val="${1 << 16}" title="W1C TXOVER">clr TXOVER</button>
    <button type="button" class="ipulse" data-wr="${regs.FDEBUG}" data-val="${1 << 8}" title="W1C RXUNDER">clr RXUNDER</button>
    <button type="button" class="ipulse" data-wr="${regs.FDEBUG}" data-val="${1}" title="W1C RXSTALL">clr RXSTALL</button></div>`;
  h += `<div class="ireg" title="FLEVEL (SPEC-7-29) — live TX/RX nibbles">
    <span class="irn">FLEVEL</span><span class="ira">0x00c</span><span class="iro">tx ${st.txLevel} rx ${st.rxLevel}</span>
    <button type="button" class="ipulse" data-rd="${regs.FLEVEL}">READ</button></div>`;
  h += `<div class="ireg" title="TXF0 (SPEC-7-28) — write pushes one 32-bit word (refused at full)">
    <span class="irn">TXF0</span><span class="ira">0x010</span>
    <div class="ifields"><div class="ifield"><span class="ifn">word</span><span class="ifb">31:0</span><input type="text" id="insp-txf0" class="ihex" placeholder="0x…" maxlength="10" /></div>
    <button type="button" id="insp-txf0go">FEED</button></div></div>`;
  h += `<div class="ireg" title="RXF0 (SPEC-7-28) — read pops one word (the RX drain)">
    <span class="irn">RXF0</span><span class="ira">0x020</span><span class="iro">level ${st.rxLevel}</span>
    <button type="button" id="insp-rxf0">DRAIN</button></div>`;
  h += `<div class="ireg" title="IRQ (SPEC-7-6) — 8 SM flags, W1C (the lamps above); IRQ_FORCE sets without side effects on pads">
    <span class="irn">IRQ</span><span class="ira">0x030</span><span class="iro">w1c</span>
    ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<button type="button" class="ipulse" data-wr="${regs.IRQ}" data-val="${1 << i}" title="clear flag ${i}">clr f${i}</button>`).join('')}
    <span class="irn">IRQ_FORCE</span><span class="ira">0x034</span>
    ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<button type="button" class="ipulse" data-wr="${regs.IRQ_FORCE}" data-val="${1 << i}" title="force flag ${i} (SPEC-7-6)">set f${i}</button>`).join('')}</div>`;
  h += `<div class="ireg" title="INPUT_SYNC_BYPASS (SPEC-7-7) — per-GPIO: 1 bypasses the 2-FF input synchroniser (CC-23)">
    <span class="irn">ISB</span><span class="ira">0x038</span><span class="iro" id="insp-isb">—</span>
    <div class="ifields"><div class="ifield"><span class="ifn">mask</span><span class="ifb">31:0</span><input type="text" id="insp-isbval" class="ihex" value="0x00000000" maxlength="10" /></div>
    <button type="button" id="insp-isbgo">WRITE</button>
    <button type="button" class="ipulse" data-rd="${regs.ISB}">READ</button></div></div>`;
  h += `<div class="ireg" title="DBG_PADOUT / DBG_PADOE (SPEC-7-8) — the driven levels/output enables, live">
    <span class="irn">PADOUT</span><span class="ira">0x03c</span><span class="iro">${hex32(st.gpioOut)}</span>
    <span class="irn">PADOE</span><span class="ira">0x040</span><span class="iro">${hex32(st.gpioOe)}</span></div>`;
  h += `<div class="ireg" title="DBG_CFGINFO (SPEC-7-9) — constant">
    <span class="irn">CFGINFO</span><span class="ira">0x044</span><span class="iro">0x10200404 · imem 32 · sm 4 · fifo 4</span></div>`;

  h += `<div class="igroup">SM0 — the config overlay (settable; edits land as queued reg writes, SPEC-7-14..26)</div>`;
  const groups = [
    ['clkdiv', 'CLKDIV', 'SM0_CLKDIV'],
    ['pinctrl', 'PINCTRL', 'SM0_PINCTRL'],
    ['execctrl', 'EXECCTRL', 'SM0_EXECCTRL'],
    ['shiftctrl', 'SHIFTCTRL', 'SM0_SHIFTCTRL'],
  ];
  for (const [group, label, regName] of groups) {
    const fields = VD.OVERLAY_GROUP_FIELDS(group);
    let fh = '';
    for (const [field, spec] of fields) fh += inspFieldRow(group, field, spec, OV[group][field]);
    h += `<div class="ireg" title="${regName} — compose ${hex32(VD.composeOverlay(group, OV[group]))}">
      <span class="irn">${label}</span><span class="ira">${group === 'clkdiv' ? '+0' : group === 'pinctrl' ? '+20' : group === 'execctrl' ? '+4' : '+8'}</span>
      <span class="iro">${hex32(VD.composeOverlay(group, OV[group]))}</span>
      <div class="ifields">${fh}</div></div>`;
  }
  h += `<div class="ireg" title="SM0_ADDR (SPEC-7-22) — the live PC">
    <span class="irn">ADDR</span><span class="ira">+12</span><span class="iro">${st.pc}</span></div>`;
  h += `<div class="ireg" title="SM0_INSTR (SPEC-7-23/24) — read: imem[pc]; write: FORCE-execute a word (delay ignored, bypasses the divider)">
    <span class="irn">INSTR</span><span class="ira">+16</span><span class="iro">0x${(BUILT[st.pc] || 0).toString(16).padStart(4, '0').toUpperCase()}</span>
    <div class="ifields"><div class="ifield"><span class="ifn">force</span><span class="ifb">15:0</span><input type="text" id="insp-force" class="ihex" placeholder="0x…" maxlength="6" /></div>
    <button type="button" id="insp-forcego">FORCE</button></div></div>`;
  h += `<div class="ireg" title="RXF0_PUTGET0..3 (SPEC-7-13) — the aux-mode storage window (readable in txput, writable in txget)">
    ${[0, 1, 2, 3].map((y) => `<button type="button" class="ipulse" data-rd="${regs.PUTGET0 + 4 * y}">PG${y}</button>`).join('')}
    <span class="iro" id="insp-putget">—</span></div>`;
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
  $('insp-ctrl-smen').onchange = (e) =>
    post({ cmd: 'regwrite', addr: regs.CTRL, data: e.target.checked ? 1 : 0 });
  $('insp-txf0go').onclick = () => {
    const v = parseHexWord($('insp-txf0').value);
    if (Number.isInteger(v)) post({ cmd: 'enqueueword', word: v >>> 0 });
  };
  $('insp-rxf0').onclick = () => post({ cmd: 'drain', n: 1 });
  $('insp-isbgo').onclick = () => {
    const v = parseHexWord($('insp-isbval').value);
    if (Number.isInteger(v)) post({ cmd: 'regwrite', addr: regs.ISB, data: v >>> 0 });
  };
  $('insp-forcego').onclick = () => {
    const v = parseHexWord($('insp-force').value);
    if (Number.isInteger(v)) post({ cmd: 'regwrite', addr: regs.SM0 + 16, data: v & 0xffff });
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
}

// ================= modeless row editor (C19 discipline; the
// listing now re-decodes under the live overlay allocation) =============
const ED = $('edittxt'),
  HL = $('edithl'),
  POP = $('edpop'),
  RE = $('rowedit'),
  HOST = $('progrows');
const SIDE = $('edside'),
  DLY = $('eddly');
let curRow = -1;
let asmErr = null; // row error of the last failed re-assembly (C19)

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
    const rows = wordsToRows(BUILT);
    PROG = BUILT.map((w, i) => ({ w, ...parseRow(rows[i]) }));
    post({ cmd: 'program', words: BUILT });
    requestAutosave();
  }
  updateUnbuilt();
}

const ISA = {
  jmp: {
    sig: 'jmp [cond] <target>',
    kind: 'control',
    params: [
      ['cond', 'always · !x · x-- · !y · y-- · x != y · pin · !osre'],
      ['target', 'address 0–31 or a label'],
    ],
    desc: 'Jump if the condition holds. x--/y-- test BEFORE decrementing.',
    spec: 'SPEC-3.1',
    args: ['!x', 'x--', '!y', 'y--', 'x != y', 'pin', '!osre'],
  },
  wait: {
    sig: 'wait <pol> gpio|pin|irq <index>',
    kind: 'control',
    params: [
      ['pol', '0 wait for low · 1 wait for high'],
      ['gpio', 'absolute GPIO number'],
      ['pin', 'pin relative to IN_BASE'],
      ['irq', 'flag; IRQ waits may use rel/prev/next'],
    ],
    desc: 'Stall the SM until the source matches the polarity.',
    spec: 'SPEC-3.2 · CC-15',
    args: ['gpio', 'pin', 'irq'],
  },
  in: {
    sig: 'in <src>, <count>',
    kind: 'data in',
    params: [
      ['src', 'pins · x · y · null · isr · osr'],
      ['count', '1–32 bits (0 means 32) shifted into ISR'],
    ],
    desc: 'Shift count bits from src into the ISR (right unless configured).',
    spec: 'SPEC-3.3',
    args: ['pins', 'x', 'y', 'null', 'isr', 'osr'],
  },
  out: {
    sig: 'out <dst>, <count>',
    kind: 'data out',
    params: [
      ['dst', 'pins · x · y · null · pindirs · pc · isr · exec'],
      ['count', '1–32 bits (0 means 32) shifted out of OSR'],
    ],
    desc: 'Shift count bits from the OSR to dst. pc = jump; exec = self-modifying.',
    spec: 'SPEC-3.4',
    args: ['pins', 'x', 'y', 'null', 'pindirs', 'pc', 'isr', 'exec'],
  },
  push: {
    sig: 'push [iffull] [block|noblock]',
    kind: 'fifo',
    params: [
      ['iffull', 'only if ISR reached its threshold'],
      ['block', 'stall until RX has room (default)'],
    ],
    desc: 'Write ISR to the RX FIFO and clear the shift counter.',
    spec: 'SPEC-3.5',
    args: ['iffull', 'block', 'noblock'],
  },
  pull: {
    sig: 'pull [ifempty] [block|noblock]',
    kind: 'fifo',
    params: [
      ['ifempty', 'only if OSR is empty'],
      ['block', 'stall until TX has data (default)'],
    ],
    desc: 'Load OSR from the TX FIFO and clear the shift counter.',
    spec: 'SPEC-3.5',
    args: ['ifempty', 'block', 'noblock'],
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
    spec: 'SPEC-3.6',
    args: ['pins', 'x', 'y', 'pindirs', 'exec', 'pc', 'isr', 'osr'],
  },
  irq: {
    sig: 'irq [set|wait|clear] <n> [rel|prev|next]',
    kind: 'sync',
    params: [
      ['n', 'flag 0–7'],
      ['rel', 'index relative to this SM'],
    ],
    desc: 'Signal other SMs; wait blocks until the flag clears.',
    spec: 'SPEC-3.8',
    args: ['wait', 'clear', 'rel', 'prev', 'next'],
  },
  set: {
    sig: 'set <dst>, <data>',
    kind: 'immediate',
    params: [
      ['dst', 'pins · x · y · pindirs'],
      ['data', '5-bit immediate 0–31'],
    ],
    desc: 'Write a constant. uart_tx uses it as the bit counter.',
    spec: 'SPEC-3.9',
    args: ['pins', 'x', 'y', 'pindirs'],
  },
  nop: {
    sig: 'nop',
    kind: 'control',
    params: [],
    desc: 'mov y, y — one free cycle.',
    spec: 'SPEC-3.6-10',
    args: [],
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
}
function openRow(i, focus) {
  if (curRow >= 0) commitRow();
  curRow = Math.max(0, Math.min(31, i));
  RE.hidden = false;
  RE.style.top = `${curRow * 20}px`;
  const p = parseRow(ROWS[curRow] || '');
  ED.value = ROWS[curRow]
    ? `${p.op}${p.args ? ` ${p.args}` : ''}${p.tgt != null ? (p.args ? ', ' : ' ') + p.tgt : ''}`
    : '';
  SIDE.value = p.side ?? '';
  DLY.value = p.delay || '';
  const f = { ins: ED, side: SIDE, dly: DLY }[focus || 'ins'];
  f.focus();
  f.setSelectionRange(f.value.length, f.value.length);
  renderED();
  edSel = 0;
  popupShow();
}
function commitRow() {
  if (curRow < 0) return;
  const ins = ED.value.trim().replace(/\s+/g, ' ');
  const sv = SIDE.value.trim(),
    dv = DLY.value.trim();
  const side = /^\d+$/.test(sv) ? ` side ${sv}` : '';
  const dly = /^\d+$/.test(dv) ? ` [${dv}]` : '';
  ROWS[curRow] = (ins + side + dly).trim();
  curRow = -1;
  RE.hidden = true;
  popupHide();
  HOST.classList.remove('picking');
  buildAndPush(); // C19: re-assemble; on success patch the engine image
  buildProgram();
  render(V.state);
}
function cancelRow() {
  curRow = -1;
  RE.hidden = true;
  popupHide();
  HOST.classList.remove('picking');
}
function hopRow(delta, focus) {
  const n = Math.max(0, Math.min(31, curRow + delta));
  commitRow();
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
      HOST.classList.remove('picking');
      ED.focus();
    } else {
      HOST.classList.remove('picking'); // clicked elsewhere: stand down
    }
    return;
  }
  if (e.target.closest('#rowedit')) return;
  const r = e.target.closest('.prow');
  if (r) openRow(+r.id.slice(2));
});
let edSel = 0,
  edCands = [];
function lineCtx() {
  const upto = ED.value.slice(0, ED.selectionStart);
  const ls = upto.lastIndexOf('\n') + 1;
  const line = upto.slice(ls);
  const m = line.match(/([A-Za-z_~!<>:[\]-]*[\w![\]]*)$/);
  const partial = m ? m[1] : '';
  const before = line.slice(0, line.length - partial.length);
  const toks = before.split(/[\s,]+/).filter(Boolean);
  return { line, toks, partial };
}
function computeCands() {
  const { toks, partial } = lineCtx();
  const p = partial.toLowerCase();
  const match = (list) =>
    list.map((c) => ({ t: c, kind: 'operand' })).filter((c) => c.t.toLowerCase().startsWith(p));
  if (!toks.length) {
    return Object.entries(ISA)
      .filter(([k]) => k.startsWith(p))
      .map(([k, v]) => ({ t: k, kind: v.kind, detail: v }));
  }
  const op = ISA[toks[0]];
  if (!op) return [];
  const n = toks.length - 1;
  if (toks[0] === 'jmp') {
    if (n === 0) {
      const conds = op.args
        .map((c) => ({ t: c, kind: 'cond', detail: ARG_NOTES[c] }))
        .filter((c) => c.t.toLowerCase().startsWith(p));
      return /[0-9]/.test(p)
        ? conds
        : [
            ...conds,
            {
              t: '↦ pick row',
              kind: 'pick',
              detail:
                'No condition = always jump. Click an address in the gutter — the arc shows the edge. Or type a condition first.',
            },
          ];
    }
    return [
      {
        t: '↦ pick row',
        kind: 'pick',
        detail:
          'Click an address in the gutter — the jump arc shows the edge. Or type 0–31; typing digits dismisses this.',
      },
    ].filter(() => !/[0-9]/.test(p));
  }
  if (toks[0] === 'mov') {
    const srcs = ['pins', 'x', 'y', 'null', 'status', 'isr', 'osr'];
    if (n === 0) return match(op.args).map((c) => ({ ...c, detail: ARG_NOTES[c.t] }));
    const opApplied = toks.slice(1).some((t) => t === '~' || t === '::');
    return match(opApplied ? srcs : ['~', '::', ...srcs]).map((c) => ({
      ...c,
      detail:
        ARG_NOTES[c.t] ||
        (c.t === '~' ? 'bitwise invert the source' : "reverse the source's bit order"),
    }));
  }
  const SECOND = {
    in: ['1', '4', '8', '16', '32'],
    out: ['1', '4', '8', '16', '32'],
    set: ['0', '1', '7', '31'],
    push: ['block', 'noblock'],
    pull: ['block', 'noblock'],
  };
  if (op.args.length)
    return match(n === 0 ? op.args : SECOND[toks[0]] || []).map((c) => ({
      ...c,
      detail: ARG_NOTES[c.t] || (c.t === op.sig.split(' ')[1] ? '' : 'number'),
    }));
  return match(op.args);
}
function detailHTML(c) {
  const { toks } = lineCtx();
  const op = ISA[toks[0]];
  if (op && c.kind !== 'pick' && c.detail && !c.detail.sig) {
    const n = toks.length - 1;
    const note = c.detail || '';
    const rows = op.params
      .map(
        (p, i) =>
          `<tr class="${i === n ? 'curp' : ''}"><td class="k">${esc(p[0])}</td><td>${esc(p[1])}</td></tr>`,
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
function popupShow() {
  edCands = computeCands();
  if (!edCands.length) {
    popupHide();
    HOST.classList.remove('picking');
    return;
  }
  edSel = Math.min(edSel, edCands.length - 1);
  HOST.classList.toggle(
    'picking',
    edCands.some((c) => c.kind === 'pick'),
  );
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
  let y = reb.bottom + 2;
  if (y + h > innerHeight - 8) y = reb.top - h - 2;
  POP.style.left = `${x + scrollX}px`;
  POP.style.top = `${Math.max(8, y) + scrollY}px`;
  mir.remove();
}
function popupHide() {
  POP.hidden = true;
}
function accept(c) {
  if (c.kind === 'pick') {
    HOST.classList.add('picking');
    popupHide();
    ED.focus();
    return;
  }
  const { partial } = lineCtx();
  const s = ED.selectionStart;
  const before = ED.value.slice(0, s - partial.length);
  const after = ED.value.slice(s);
  const toks = before.split(/[\s,]+/).filter(Boolean);
  const sep = !ISA[toks[0]] ? ' ' : toks.length === 1 ? ', ' : '';
  ED.value = before + c.t + sep + after;
  const np = (before + c.t + sep).length;
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
ED.addEventListener('blur', () => popupHide());
RE.addEventListener('focusout', (e) => {
  if (HOST.classList.contains('picking')) return;
  if (e.relatedTarget && RE.contains(e.relatedTarget)) return;
  setTimeout(() => {
    if (document.activeElement && RE.contains(document.activeElement)) return;
    commitRow();
  }, 0);
});
HOST.addEventListener('scroll', () => popupHide());
addEventListener('resize', () => popupHide());
SIDE.addEventListener('focus', () => HOST.classList.remove('picking'));
DLY.addEventListener('focus', () => HOST.classList.remove('picking'));
ED.addEventListener('keydown', (e) => {
  if (!POP.hidden) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      edSel = (edSel + 1) % edCands.length;
      popupShow();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      edSel = (edSel - 1 + edCands.length) % edCands.length;
      popupShow();
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      accept(edCands[edSel]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      popupHide();
    }
    return;
  }
  if (e.key === ' ' && e.ctrlKey) {
    e.preventDefault();
    popupShow();
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
$('bdrain').onclick = () => post({ cmd: 'drain', n: 1 });
$('bdrainall').onclick = () => {
  const avail = V.state.rxMirror.pushes - V.state.rxMirror.drains;
  if (avail > 0) post({ cmd: 'drain', n: avail });
};
$('irqlamps').addEventListener('click', (e) => {
  const l = e.target.closest('.ilamp[data-flag]');
  if (l) post({ cmd: 'regwrite', addr: VD.REG.IRQ, data: 1 << +l.dataset.flag });
});

// ---- the select options (pins 0..31) ------------------------------------
for (const id of ['lenspin', 'patpin']) {
  const sel = $(id);
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
render(V.state);

function applyUrlParams() {
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
      HOST.classList.add('picking');
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

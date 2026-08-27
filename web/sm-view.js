// sm-view.js — the C18 SM view client logic (KANBAN C18).
//
// The mock-up's hand-rolled simulator is deleted: every machine value
// rendered here (pins, PC, phase, X/Y, OSR/ISR, counters, FIFO level)
// comes from the wasm engine's per-clk state snapshot, posted by the
// Web Worker (engine-worker.js / engine-driver.js — the CI-gated core).
// What stays local is presentation: the canonical listing display, the
// modeless editor (edits mark the listing "unbuilt" — re-assembly on
// edit lands with C19), the ds-field allocator display re-decode (the
// machine side of the allocation is a real PINCTRL/EXECCTRL write),
// and the waveform/tag/monitor rendering of true pin samples.
'use strict';

const $ = (id) => document.getElementById(id); // declared first: the transport
// wiring below uses it at top level

// ---- the program (canonical C12 listing of the level fixture; words
// single-sourced from the driver's LEVEL) -------------------------------
// No labels: jump targets are drawn as margin arcs (like the wrap path) —
// the address is the only stored truth. side/delay re-decode from the ds
// field under the allocator (SPEC-4-1..3).
const LEVEL = VibeDriver.LEVEL;
const PROG = [
  { w: 0x9fa0, op: 'pull', args: 'block', side: 1, delay: 7 },
  { w: 0xf727, op: 'set', args: 'x, 7', side: 0, delay: 7 },
  { w: 0x6001, op: 'out', args: 'pins, 1', side: null, delay: 0 },
  { w: 0x0642, op: 'jmp', args: 'x--', tgt: 2, side: null, delay: 6 },
];
if (PROG.some((p, i) => p.w !== LEVEL.words[i]))
  throw new Error('view PROG table diverged from engine-driver LEVEL words');

const WRAP_TARGET = LEVEL.wrapTarget,
  WRAP_LAST = LEVEL.wrapLast;
const FIFODEPTH = LEVEL.fifoDepth,
  WIN = 128;

// ds-field allocation (the .side_set directive): side data bits + optional
// enable bit share 5 bits with delay. max delay = 2^(5-total) - 1.
// The stored program is just 16-bit words — change the allocation and the
// SAME bits re-split (split_sideset, encoding.py / SPEC-4-1..3). The
// listing honors the re-decode AND the machine genuinely re-decodes too:
// the worker re-writes PINCTRL.SIDESET_COUNT + EXECCTRL.SIDE_EN.
const ALLOC = { sideBits: LEVEL.sideBits, opt: LEVEL.opt };
const PROGRAM_OWN = { sideBits: LEVEL.sideBits, opt: LEVEL.opt }; // the authored .side_set
const dsTotal = () => ALLOC.sideBits + (ALLOC.opt ? 1 : 0);
const maxDelay = () => (1 << (5 - dsTotal())) - 1;

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
  EFF = PROG.map((p) => {
    const [dly, valid, val] = splitSideset(
      (p.w >> 8) & 0x1f,
      ALLOC.opt,
      ALLOC.sideBits + (ALLOC.opt ? 1 : 0),
    );
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
    txLevel: 0,
    txEmpty: true,
    txFull: false,
    txWords: [],
    monitor: { decoded: '', frameOff: null },
    wave: { pins: [], tags: [], startCycle: 0 },
    flashes: {},
    refused: 0,
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
    applyUrlParams();
    return;
  }
  if (m.cmd === 'state') {
    V.inflight = false;
    V.state = m.state;
    if (m.refused > 0) refuseFlash();
    render(V.state);
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
  post({ cmd: 'reset' });
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

// ================= rendering (all machine values from state) ==========
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
    const orig = i < PROG.length && ROWS[i] === ORIG[i];
    const eff = orig ? EFF[i] : null; // the slider re-decodes virgin words only
    const side = eff ? eff.side : p.side,
      dly = eff ? eff.delay : p.delay;
    const sideHtml =
      side == null
        ? `<span title="${ALLOC.opt ? 'opt enable bit is 0 — no side applied' : 'no side-set allocated (ds is all delay)'}">—</span>`
        : `<span>side <b>${side}</b></span>`;
    const dlyHtml = dly ? `<span>[${dly}]</span>` : `<span title="delay 0">—</span>`;
    r.title =
      (orig ? `0x${PROG[i].w.toString(16).padStart(4, '0').toUpperCase()} · ` : '') + ROWS[i];
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
  const arc = document.createElement('div');
  arc.id = 'wraparc';
  arc.title = `config · WRAP: after insn ${WRAP_LAST} the PC returns to ${WRAP_TARGET} instead of falling through`;
  arc.style.top = `${WRAP_TARGET * 20 + 10}px`;
  arc.style.height = `${(WRAP_LAST - WRAP_TARGET) * 20}px`;
  nodes.push(arc);
  const ah = document.createElement('div');
  ah.id = 'wraparrow';
  ah.title = arc.title;
  ah.style.top = `${WRAP_TARGET * 20 + 6}px`;
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
}
function updateUnbuilt() {
  const diverged = ROWS.some((r, i) => r !== ORIG[i]);
  const u = $('unbuilt');
  if (u) u.hidden = !diverged;
}
function renderAlloc() {
  const h = $('dspips');
  h.innerHTML = '';
  const total = dsTotal();
  for (let k = 0; k < 5; k++) {
    const d = document.createElement('div');
    d.className = `pip${k < total ? (k === 0 && ALLOC.opt ? ' en' : ' s') : ' d'}`;
    d.title =
      k < total
        ? k === 0 && ALLOC.opt
          ? 'opt-enable bit — per-instruction side on/off'
          : 'side data bit → gpio'
        : `delay bit (max delay ${maxDelay()})`;
    h.appendChild(d);
  }
  $('ssminus').disabled = !ALLOC.sideBits;
  $('ssplus').disabled = ALLOC.sideBits >= 5;
  $('ssopt').disabled = !ALLOC.sideBits;
  $('ssopt').checked = ALLOC.opt && !!ALLOC.sideBits;
  const redecoded = ALLOC.sideBits !== PROGRAM_OWN.sideBits || ALLOC.opt !== PROGRAM_OWN.opt;
  const info = $('dsinfo');
  info.innerHTML =
    `side ${ALLOC.sideBits}b${ALLOC.opt ? '+opt' : ''} · delay [0..${maxDelay()}]` +
    (redecoded
      ? ` <span style="color:var(--red)" title="same stored bits, re-decoded under this allocation — the machine runs what the bits now say (and the engine really does: PINCTRL/EXECCTRL were re-written)">· garbled</span>`
      : '');
  const st = $('sidetag');
  st.textContent = ALLOC.sideBits
    ? `side gpio0·${ALLOC.sideBits}${ALLOC.opt ? '+opt' : ''}`
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

const EXECFIELDS = {
  0: 'OP PULL · MODE block · FIFO→OSR',
  1: 'OP SET · DST X · DATA 7',
  2: "OP OUT · DST PINS <span class='cfgtx'>→ gpio0</span> · COUNT 1",
  3: "OP JMP · COND X-- · TARGET <span class='pcaddr'>02 ↷ margin</span>",
};

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
  const base = EXECFIELDS[disp] || 'unwritten memory · 0x0000 decodes as jmp 0';
  const side = e.side != null ? `SIDE ${e.side} <span class='cfgtx'>→ gpio0</span>` : '';
  f.innerHTML = `${base}<br>${side ? `${side} · ` : ''}delay ${e.delay}`;
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
    sub.textContent = 'pull block · TX empty · line held 1 (side)';
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
  renderBits($('osrbits'), st.osr, st.osrCnt, '');
  renderBits($('isrbits'), st.isr, 0, '');
  $('osrfill').style.width = `${(100 * st.osrCnt) / 32}%`;
  $('osrcnt').textContent = st.osrCnt;
  $('osre').classList.toggle('lit', st.osrCnt >= 32);
  const slots = $('fslots');
  slots.innerHTML = '';
  for (let i = 0; i < FIFODEPTH; i++) {
    const d = document.createElement('div');
    const full = i < st.txWords.length;
    d.className = `fslot${full ? ' full' : ''}${i === 0 ? ' next' : ''}${i >= 4 ? ' borrowed' : ''}`;
    if (i >= 4) d.title = 'config · storage borrowed from RX via FIFO JOIN TX';
    d.innerHTML = `<span class="idx">${i}</span><span class="hexv">${full ? hex32(st.txWords[i]) : '········'}</span><span class="chv">${full ? ascii(st.txWords[i]) : ''}</span>`;
    slots.appendChild(d);
  }
  $('fifolvl').textContent = st.txLevel;
  $('fifolvlfill').style.height = `${(100 * st.txLevel) / FIFODEPTH}%`;
  $('fifostall').classList.toggle('show', st.phase === 'STALL');
}

function renderMonitor(st) {
  $('monbuf').textContent = st.monitor.decoded ? `'${st.monitor.decoded}'` : '—';
  const n = [...st.monitor.decoded].length;
  $('moncnt').textContent = n ? `· ${n} bytes ✓` : '';
}

// ---- waveform (svg): true engine pin samples, monitor-derived tags ----
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
    if (j - i >= 3) {
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

function render(st) {
  renderProgram(st);
  renderExec(st);
  renderFrameMap(st);
  renderRegs(st);
  renderWave(st);
  renderMonitor(st);
  const fl = st.flashes || {};
  if (st.cycle !== V.lastFlashClk) {
    // one flash per clk, not per message
    if (fl.pull) flashPull();
    if (fl.jmp) flashJmp();
    if (fl.wrap) flashWrap();
    V.lastFlashClk = st.cycle;
  }
}

// ================= modeless row editor (unchanged from the mock-up;
// edits mark the listing unbuilt — re-assembly lands with C19) ========
const ED = $('edittxt'),
  HL = $('edithl'),
  POP = $('edpop'),
  RE = $('rowedit'),
  HOST = $('progrows');
const SIDE = $('edside'),
  DLY = $('eddly');
const ROWS = PROG.map(
  (p) =>
    `${p.op} ${p.args}${p.tgt != null ? `, ${p.tgt}` : ''}${p.side != null ? ` side ${p.side}` : ''}${p.delay ? ` [${p.delay}]` : ''}`,
).concat(Array(32 - PROG.length).fill(''));
const ORIG = [...ROWS];
let curRow = -1;

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

// ---- ds allocator: display re-decode + a REAL PINCTRL/EXECCTRL write -
function allocChanged() {
  buildProgram();
  render(V.state);
  post({ cmd: 'alloc', sideBits: ALLOC.sideBits, opt: ALLOC.opt });
}
$('ssminus').onclick = () => {
  if (ALLOC.sideBits > 0) {
    ALLOC.sideBits--;
    if (!ALLOC.sideBits) ALLOC.opt = false;
    allocChanged();
  }
};
$('ssplus').onclick = () => {
  if (ALLOC.sideBits < 5) {
    ALLOC.sideBits++;
    allocChanged();
  }
};
$('ssopt').onchange = (e) => {
  ALLOC.opt = e.target.checked && !!ALLOC.sideBits;
  allocChanged();
};

// ---- boot ----
addEventListener('error', (e) => {
  const f = document.querySelector('footer');
  if (f)
    f.innerHTML = `<span style="color:var(--red)">PAGE ERROR: ${e.message} @${e.lineno}</span>`;
});
enableCtrls(false);
buildProgram();
buildBits($('osrbits'));
buildBits($('isrbits'));
render(V.state);

function applyUrlParams() {
  // shareable states: ?t=N pre-runs N cycles (one worker batch), ?run=1
  // autoplays, ?ss=N&opt=0 presets the ds-field allocation; editor demo
  // states (?row/?complete/?pick) stay view-local as in the mock-up.
  const q = new URLSearchParams(location.search);
  if (q.has('ss')) {
    ALLOC.sideBits = Math.min(5, Math.max(0, Math.round(+q.get('ss')) || 0));
    ALLOC.opt = q.get('opt') !== '0' && !!ALLOC.sideBits;
    post({ cmd: 'alloc', sideBits: ALLOC.sideBits, opt: ALLOC.opt });
    buildProgram();
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

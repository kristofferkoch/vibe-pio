// levels.js — the C34 level-campaign runtime (KANBAN C34): the registry
// the level files register into, the monitor-profile judge, the predict
// gate, and the panel-absence surface table. The level SHELL (the band,
// the gated page) is sm-view.js glue over this module; the level DATA
// lives in one classic script per level under web/levels/.
//
// Design record: mockups/LEVELS-NOTES.md is the spec (the 2026-09-04
// grilling's owner decisions are on the KANBAN card). The load-bearing
// decisions encoded here:
//
//   - pass = receiver conformance, never golden traces: the square
//     profile judges the WAVE (stability over the tier's tolerance), so
//     any program that draws the same wave passes — the judge is a pure
//     function of a pin series + the profile, which is what lets the
//     engine-side gate (web/tests/levels.test.js) replay committed golden
//     series from pio_model through exactly the verdict the browser shows;
//   - the profile ladder is one square-wave receiver skeleton
//     parameterized by tiers (relaxed/exact/strict), versioned with the
//     level (v: 1) — tolerance SEMANTICS changes bump v, never silently;
//   - the predict gate locks the first run of a level-authored program
//     only: a committed prediction opens it forever, re-runs never
//     re-lock (expertise reversal is for par, punishment is for no one);
//   - panel gating is ABSENCE: a locked panel is display:none, out of
//     layout and Tab order both — the level page is its own geometry,
//     never ghosted placeholders (the SURFACE table below is the whole
//     vocabulary; a key absent from def.panels is absent from the page).
//
// Runtime JS is dependency-free: classic <script> before the level files
// and sm-view.js (globalThis.PioLevels, and PIO_LEVEL as the classic
// registration hook) or CommonJS (web/tests) — the engine-driver pattern.

((global) => {
  'use strict';

  // ================= the registry =================
  const LEVELS = new Map();

  function str(v, what, min = 1) {
    if (typeof v !== 'string' || v.length < min) throw new Error(`level: ${what} missing`);
    return v;
  }

  // Structural validation at registration time: a malformed level file
  // fails loudly at load, never half-renders a page.
  function validate(def) {
    str(def?.id, 'id');
    str(def?.name, 'name');
    if (!Number.isInteger(def?.chapter) || def.chapter < 0)
      throw new Error('level: chapter must be a whole number');
    str(def?.goal, 'goal', 8);
    if (!Array.isArray(def?.panels) || !def.panels.length)
      throw new Error('level: panels (the unlocked surface) must be a non-empty list');
    for (const k of def.panels)
      if (!(k in SURFACE) && !STRUCTURAL.has(k))
        throw new Error(`level: unknown panel key ${JSON.stringify(k)}`);
    if (!Array.isArray(def?.opcodes)) throw new Error('level: opcodes must be a list');
    if (!def?.program || !Array.isArray(def.program.listing))
      throw new Error('level: program.listing missing');
    for (const row of def.program.listing) str(row, 'program.listing row');
    // C35: the reference solution is its own field when the boot program
    // is not the answer (the modify/make fade — L1 boots the un-slowed
    // program, L2 boots empty); every level ships one either way
    if (def?.reference?.listing !== undefined) {
      if (!Array.isArray(def.reference.listing) || !def.reference.listing.length)
        throw new Error('level: reference.listing must be a non-empty list');
      for (const row of def.reference.listing) str(row, 'reference.listing row');
    }
    const pr = def.profile;
    if (pr?.kind !== 'square' || !Number.isInteger(pr?.v))
      throw new Error('level: profile must be a versioned square receiver');
    if (!Number.isInteger(pr.pin) || pr.pin < 0 || pr.pin > 31)
      throw new Error('level: profile.pin');
    if (!pr.tiers?.[pr.tier]) throw new Error(`level: tier ${pr.tier} not defined`);
    for (const [name, t] of Object.entries(pr.tiers)) {
      for (const f of ['periodLo', 'periodHi', 'dutyLoPct', 'dutyHiPct', 'minPeriods', 'stable'])
        if (!Number.isInteger(t[f]) || t[f] < 0) throw new Error(`level: tier ${name}.${f}`);
      if (t.periodLo < 2 || t.periodLo > t.periodHi)
        throw new Error(`level: tier ${name} period range`);
    }
    const pd = def?.predict;
    if (pd) {
      str(pd.ask, 'predict.ask', 8);
      if (!Array.isArray(pd.candidates) || pd.candidates.length < 2)
        throw new Error('level: predict needs at least two candidates');
      for (const c of pd.candidates) {
        str(c.id, 'predict.candidate id');
        str(c.label, 'predict.candidate label', 4);
        if (!/^[01]+$/.test(c.bits || '')) throw new Error(`level: candidate ${c.id} bits`);
      }
      if (!pd.candidates.some((c) => c.id === pd.answer)) throw new Error('level: predict.answer');
    }
    if (
      !def?.reference?.par ||
      !Number.isInteger(def.reference.par.words) ||
      !Number.isInteger(def.reference.par.period)
    )
      throw new Error('level: reference.par (words, period) missing');
  }

  function register(id, def) {
    if (typeof id !== 'string' || !id) throw new Error('PIO_LEVEL: id');
    if (LEVELS.has(id)) throw new Error(`PIO_LEVEL: ${id} registered twice`);
    validate(def);
    if (def.id !== id) throw new Error(`PIO_LEVEL: file registers ${def.id} as ${id}`);
    LEVELS.set(id, def);
  }

  // The active level: ?level=<id> on the shipped page (null = sandbox).
  function active(search) {
    const q = new URLSearchParams(search ?? (global.location ? global.location.search : ''));
    const id = q.get('level');
    return id ? (LEVELS.get(id) ?? null) : null;
  }

  // ================= the monitor judge =================
  // One square-wave receiver over a pin series: rising edges → periods →
  // duty; the tier's tolerances apply to the LAST `stable` periods and
  // require `minPeriods` completed periods first (a lens reports one
  // period — a judge demands the wave hold). Pure: the browser feeds it
  // the wave window, the levels gate feeds it the golden series; the
  // verdict text is the near-miss feedback the band shows.
  function squareJudge(bits, tp, defects) {
    const DEFECT = !!defects?.judge; // re-injected: any single in-range period passes
    if (!bits?.length) return { pass: false, verdict: 'awaiting run', period: null, dutyPct: null };
    const rising = [];
    for (let k = 1; k < bits.length; k++) if (bits[k - 1] === 0 && bits[k] === 1) rising.push(k);
    const cycles = [];
    for (let i = 1; i < rising.length; i++) {
      const period = rising[i] - rising[i - 1];
      let hi = 0;
      for (let k = rising[i - 1]; k < rising[i]; k++) hi += bits[k] ? 1 : 0;
      cycles.push({ period, dutyPct: Math.round((100 * hi) / period) });
    }
    const range = ` (${tp.periodLo}..${tp.periodHi} clk)`;
    const dutyRange = ` (${tp.dutyLoPct}..${tp.dutyHiPct}%)`;
    if (!rising.length)
      return {
        pass: false,
        verdict: 'no blink yet — the pin never rose',
        period: null,
        dutyPct: null,
      };
    if (DEFECT) {
      const c = cycles[cycles.length - 1];
      if (c && c.period >= tp.periodLo && c.period <= tp.periodHi)
        return {
          pass: true,
          verdict: 'square (defect: one period)',
          period: c.period,
          dutyPct: c.dutyPct,
        };
    }
    if (cycles.length < tp.minPeriods)
      return {
        pass: false,
        verdict: `${rising.length} rising edge${rising.length === 1 ? '' : 's'} — keep watching`,
        period: null,
        dutyPct: null,
      };
    const last = cycles.slice(-tp.stable);
    const badP = last.find((c) => c.period < tp.periodLo || c.period > tp.periodHi);
    if (badP)
      return {
        pass: false,
        verdict: `period ${badP.period} clk — outside${range}`,
        period: badP.period,
        dutyPct: badP.dutyPct,
      };
    const badD = last.find((c) => c.dutyPct < tp.dutyLoPct || c.dutyPct > tp.dutyHiPct);
    if (badD)
      return {
        pass: false,
        verdict: `duty ${badD.dutyPct}% — outside${dutyRange}`,
        period: badD.period,
        dutyPct: badD.dutyPct,
      };
    const c = last[last.length - 1];
    return {
      pass: true,
      verdict: `square · ${c.period} clk/cycle · ${c.dutyPct}% duty`,
      period: c.period,
      dutyPct: c.dutyPct,
    };
  }

  function judge(bits, profile, defects) {
    if (profile.kind !== 'square') throw new Error(`judge: no receiver for ${profile.kind}`);
    return squareJudge(bits, profile.tiers[profile.tier], defects);
  }

  // ================= the predict gate =================
  // Locked until a prediction is committed; open forever after. Levels
  // without a predict prompt (the player authored the program, or the
  // level predates the gate) never lock.
  function gateOpen(def, session, defects) {
    if (defects?.gate) return true; // re-injected: the gate never locks
    if (!def?.predict) return true;
    return !!session?.predicted;
  }

  // ================= the program state =================
  // The level's listing + overlay → a stored-program state the driver
  // loads verbatim (parseState validates the sms shape; absent fields
  // read their hardware-reset value, the same merge the inspector edits).
  function programState(def, Asm, Driver) {
    const A = Asm || global.PioAsm;
    const D = Driver || global.VibeDriver;
    const prog = A.createProgram(def.id);
    const ov0 = def.program.sms?.[0] || {};
    const ssCnt = ov0.pinctrl?.ssCnt || 0;
    const sideEn = !!ov0.execctrl?.sideEn;
    prog.sidesetBits = Math.max(0, ssCnt - (sideEn ? 1 : 0));
    prog.sidesetOpt = sideEn && ssCnt > 0;
    const words = new Array(32).fill(0);
    def.program.listing.forEach((row, i) => {
      words[i] = A.assembleInstruction(row, prog, {}, `level ${def.id} row ${i}`);
    });
    const lens =
      def.profile.kind === 'square' || def.profile.kind === 'uart'
        ? { mode: def.profile.kind, pin: def.profile.pin }
        : { mode: 'off', pin: def.profile.pin };
    return D.parseState({ v: 2, words, sms: def.program.sms, lens });
  }

  // ================= the surface (panel gating = absence) =================
  // Every key names DOM that EXISTS on the shipped page; a key absent
  // from the level's panels list hides its DOM (the [hidden] attribute —
  // display:none with the !important guard, out of layout AND Tab order).
  // Structural keys (no selector — they switch behavior or column
  // templates): transport/listing/wave name what STAYS, delayCol/sideCol
  // add the listing's columns, wrapSteppers arms the arc's steppers.
  const SURFACE = {
    file: ['#clkdivtag', '#bempty', '#bdemo', '#bexport', '#bimport', '#bcopy'],
    speed: ['#speed'],
    insnStep: ['#binsn'],
    machines: ['#smsbar'],
    pins: ['#pinstrip'],
    regs: ['#regs'],
    dsAlloc: ['#dsalloc'],
    progMeta: ['#progfoot'],
    execTitle: ['#exectitle'],
    execHead: ['#execslim'],
    isr: ['#isr'],
    fifos: ['#fiforow'],
    pullConn: ['#pullconn'],
    osr: ['#osr'],
    frameMap: ['#framemap'],
    mapTags: ['.maptag'],
    waveAux: ['#wavewinaux'],
    lensPick: ['#spin-lenspin'],
    monitorAux: ['#mon'],
    feed: ['#feed'],
    pattern: ['#pattern'],
  };
  const STRUCTURAL = new Set([
    'transport',
    'listing',
    'wave',
    'delayCol',
    'sideCol',
    'wrapSteppers',
  ]);

  // Apply one level's surface to a document. Pure DOM mutation of the
  // shipped page — the layout gate and the keyboard walk pin what it
  // produces; this table is the single vocabulary both sides share.
  function applySurface(doc, def) {
    const unlocked = new Set(def.panels);
    for (const [key, sels] of Object.entries(SURFACE)) {
      if (unlocked.has(key)) continue;
      for (const sel of sels)
        doc.querySelectorAll(sel).forEach((el) => {
          el.hidden = true;
        });
    }
    // lensPick pins rather than removes: the steppers (a Tab stop) leave
    // the order entirely while the pin NUMBER stays on the wave row's
    // face — the shell rewrites the label's own text node (C29
    // legibility: the row keeps naming its pin)
    if (!unlocked.has('lensPick')) {
      const spin = doc.querySelector('#spin-lenspin');
      if (spin) spin.hidden = true;
    }
    // the listing's columns: absent by default in a level; delayCol and
    // sideCol add them back (C35/C37-era levels unlock them one at a time)
    const prog = doc.querySelector('#program');
    if (prog) {
      prog.classList.toggle('col-delay', unlocked.has('delayCol'));
      prog.classList.toggle('col-side', unlocked.has('sideCol'));
    }
    doc.body.classList.add('level');
    const win = doc.querySelector('#win');
    if (win) win.classList.add('level');
    const main = doc.querySelector('main');
    if (main) main.classList.add('level');
    return unlocked;
  }

  const api = {
    register,
    active,
    get: (id) => LEVELS.get(id) ?? null,
    all: () => [...LEVELS.keys()],
    judge,
    squareJudge,
    gateOpen,
    programState,
    SURFACE,
    applySurface,
  };
  global.PioLevels = api;
  global.PIO_LEVEL = register; // the classic-script registration hook
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(this);

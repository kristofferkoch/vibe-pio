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

  // The jmp condition spellings (pio-asm.js JMP_CONDS minus 'always' —
  // the always-jump is digits at the first slot, unlocked with jmp
  // itself). The conds whitelist's vocabulary; the levels gate pins it
  // against the assembler's table so the two can never drift.
  const CONDS = ['!x', 'x--', '!y', 'y--', 'x != y', 'pin', '!osre'];

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
    // C37: the scrambler posture — the listing's edit is the row trade
    // (click-pair / Enter-mark + Enter-trade), the row editor never opens
    if (def?.scramble !== undefined && typeof def.scramble !== 'boolean')
      throw new Error('level: scramble must be a boolean');
    if (!def?.program || !Array.isArray(def.program.listing))
      throw new Error('level: program.listing missing');
    for (const row of def.program.listing) str(row, 'program.listing row');
    // C39: the reading levels' given — a list of pattern cfgs, one per
    // driven input pin, spelled exactly like the engine's pattern
    // contract ({mode:'square', pin, period} / {mode:'bits', pin, bits})
    // so applying the stimulus IS one pattern call per entry. The level
    // owns it forever: the pattern panel stays absent, the rows are the
    // world's, never the player's to edit.
    if (def?.stimulus !== undefined) {
      if (!Array.isArray(def.stimulus) || !def.stimulus.length)
        throw new Error('level: stimulus must be a non-empty list of pattern cfgs');
      if (def.stimulus.length > 4)
        throw new Error('level: at most four stimulus pins (one wave row each)');
      const pins = new Set();
      for (const cfg of def.stimulus) {
        if (cfg?.mode === 'square') {
          if (
            !Number.isInteger(cfg.period) ||
            cfg.period < 2 ||
            cfg.period > 1024 ||
            cfg.period & 1
          )
            throw new Error('level: stimulus square period must be an even clk count 2..1024');
        } else if (cfg?.mode === 'bits') {
          if (!/^[01]{1,256}$/.test(cfg.bits || ''))
            throw new Error('level: stimulus bits must be a 0/1 string (1..256 clks)');
        } else {
          throw new Error('level: stimulus cfg mode must be square|bits');
        }
        if (!Number.isInteger(cfg.pin) || cfg.pin < 0 || cfg.pin > 31)
          throw new Error('level: stimulus pin');
        if (pins.has(cfg.pin)) throw new Error('level: one pattern per stimulus pin');
        pins.add(cfg.pin);
      }
    }
    // C35: the reference solution is its own field when the boot program
    // is not the answer (the modify/make fade — L1 boots the un-slowed
    // program, L2 boots empty); every level ships one either way
    if (def?.reference?.listing !== undefined) {
      if (!Array.isArray(def.reference.listing) || !def.reference.listing.length)
        throw new Error('level: reference.listing must be a non-empty list');
      for (const row of def.reference.listing) str(row, 'reference.listing row');
    }
    const pr = def.profile;
    if (!Number.isInteger(pr?.v)) throw new Error('level: profile must be versioned');
    if (pr.kind === 'rx') {
      // C39: the RX judge — a pure judge over the pushed RX words, exact
      // by design (a value has no tolerance; the tier ladder lives on
      // timing judges — square here, decode at C40 — per the 2026-09-06
      // grilling). The words are 32-bit values.
      if (!Array.isArray(pr.words) || !pr.words.length || pr.words.length > 8)
        throw new Error('level: rx profile needs its expected words (1..8)');
      for (const w of pr.words)
        if (!Number.isInteger(w) || w < 0 || w > 0xffffffff)
          throw new Error('level: rx expected words are 32-bit values');
    } else if (pr.kind === 'square') {
      // the tier ladder skeleton (relaxed/exact/strict over one receiver)
    } else if (pr.kind === 'uart') {
      // C40: the decode judge — SPEC-16-9 run semantics over the output
      // wave (the monitor flips to receiver conformance at L7); expected
      // bytes = the driven data, the [BIT_LO,BIT_HI] skew window per
      // bit-time as the tier ladder. DBITS 8, no parity — the frame
      // map's own shape.
      if (!Array.isArray(pr.bytes) || !pr.bytes.length || pr.bytes.length > 4)
        throw new Error('level: uart profile needs its expected bytes (1..4)');
      for (const b of pr.bytes)
        if (!Number.isInteger(b) || b < 0 || b > 255)
          throw new Error('level: uart expected bytes are 8-bit values');
    } else {
      throw new Error(`level: no receiver for profile kind ${JSON.stringify(pr?.kind)}`);
    }
    // C36: the wave window is level geometry — a slow wave needs more
    // samples for the judge's stability window (L5's 64 clk/cycle runs a
    // 512-sample window; the default 128 covers every earlier level and
    // the sandbox). Must hold the active tier's periods comfortably.
    if (def?.waveWin !== undefined) {
      if (!Number.isInteger(def.waveWin) || def.waveWin < 128 || def.waveWin > 1024)
        throw new Error('level: waveWin must be a sample count in 128..1024');
      const t = pr.tiers?.[pr.tier];
      // enough completed periods in view for minPeriods to hold at any
      // window phase: risings >= minPeriods+1 needs (minPeriods+2) periods
      if (pr.kind === 'square' && t && def.waveWin < (t.minPeriods + 2) * t.periodHi)
        throw new Error('level: waveWin too short for the tier to judge steadily');
    }
    if (!Number.isInteger(pr.pin) || pr.pin < 0 || pr.pin > 31)
      throw new Error('level: profile.pin');
    if (pr.kind === 'square') {
      if (!pr.tiers?.[pr.tier]) throw new Error(`level: tier ${pr.tier} not defined`);
      for (const [name, t] of Object.entries(pr.tiers)) {
        for (const f of ['periodLo', 'periodHi', 'dutyLoPct', 'dutyHiPct', 'minPeriods', 'stable'])
          if (!Number.isInteger(t[f]) || t[f] < 0) throw new Error(`level: tier ${name}.${f}`);
        if (t.periodLo < 2 || t.periodLo > t.periodHi)
          throw new Error(`level: tier ${name} period range`);
      }
    }
    if (pr.kind === 'uart') {
      if (!pr.tiers?.[pr.tier]) throw new Error(`level: tier ${pr.tier} not defined`);
      for (const [name, t] of Object.entries(pr.tiers)) {
        for (const f of ['bitLo', 'bitHi'])
          if (!Number.isInteger(t[f]) || t[f] < 1) throw new Error(`level: tier ${name}.${f}`);
        if (t.bitLo > t.bitHi) throw new Error(`level: tier ${name} window (bitLo..bitHi)`);
      }
    }
    // C40: the condition leash — the jmp condition spellings a level may
    // suggest (the assembler's own table minus 'always': the always-jump
    // is digits at the first slot, unlocked with jmp itself). The pin
    // condition debuts at L7, the x-- slot at L8; before that the menu
    // stays shut. levels.js is dependency-free, so the spellings live
    // here and the gate pins them against PioAsm.JMP_CONDS.
    if (def?.conds !== undefined) {
      if (!Array.isArray(def.conds))
        throw new Error('level: conds must be a list of jmp conditions');
      for (const c of def.conds)
        if (!CONDS.includes(c))
          throw new Error(`level: unknown jmp condition ${JSON.stringify(c)}`);
    }
    const pd = def?.predict;
    if (pd) {
      str(pd.ask, 'predict.ask', 8);
      // C39: the word face — reading levels ask about a register's
      // contents, not a wave shape; the candidates render as bit-word
      // rows (the view's bits grammar) instead of wave thumbs
      if (pd.face !== undefined && pd.face !== 'wave' && pd.face !== 'isr')
        throw new Error('level: predict.face must be wave|isr');
      if (!Array.isArray(pd.candidates) || pd.candidates.length < 2)
        throw new Error('level: predict needs at least two candidates');
      for (const c of pd.candidates) {
        str(c.id, 'predict.candidate id');
        str(c.label, 'predict.candidate label', 4);
        if (!/^[01]+$/.test(c.bits || '')) throw new Error(`level: candidate ${c.id} bits`);
        if (pd.face === 'isr' && c.bits.length !== 32)
          throw new Error(`level: candidate ${c.id} bits must be one 32-bit word`);
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
    // every return carries a machine-readable `code` — the band face maps
    // it to a status word instead of parsing the prose (the verdict
    // strings stay pinned by the wave-contract tests verbatim)
    if (!bits?.length)
      return {
        pass: false,
        code: 'awaiting',
        verdict: 'awaiting run',
        period: null,
        dutyPct: null,
      };
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
        code: 'noblink',
        verdict: 'no blink yet — the pin never rose',
        period: null,
        dutyPct: null,
      };
    if (DEFECT) {
      const c = cycles[cycles.length - 1];
      if (c && c.period >= tp.periodLo && c.period <= tp.periodHi)
        return {
          pass: true,
          code: 'defect',
          verdict: 'square (defect: one period)',
          period: c.period,
          dutyPct: c.dutyPct,
        };
    }
    if (cycles.length < tp.minPeriods)
      return {
        pass: false,
        code: 'watching',
        verdict: `${rising.length} rising edge${rising.length === 1 ? '' : 's'} — keep watching`,
        period: null,
        dutyPct: null,
      };
    const last = cycles.slice(-tp.stable);
    const badP = last.find((c) => c.period < tp.periodLo || c.period > tp.periodHi);
    if (badP)
      return {
        pass: false,
        code: 'period',
        verdict: `period ${badP.period} clk — outside${range}`,
        period: badP.period,
        dutyPct: badP.dutyPct,
      };
    const badD = last.find((c) => c.dutyPct < tp.dutyLoPct || c.dutyPct > tp.dutyHiPct);
    if (badD)
      return {
        pass: false,
        code: 'duty',
        verdict: `duty ${badD.dutyPct}% — outside${dutyRange}`,
        period: badD.period,
        dutyPct: badD.dutyPct,
      };
    const c = last[last.length - 1];
    return {
      pass: true,
      code: 'pass',
      verdict: `square · ${c.period} clk/cycle · ${c.dutyPct}% duty`,
      period: c.period,
      dutyPct: c.dutyPct,
    };
  }

  // ================= the RX judge (C39) =================
  // A pure judge over the PUSHED RX words (in push order): the words are
  // compared against the profile's expected words exactly — a value has
  // no tolerance, so no tier ladder (the 2026-09-06 grilling decision;
  // the ladder lives on timing judges). The near-miss face is the point:
  // the verdict names the first divergent bit, so "one bit wrong" reads
  // as one bit, not as a red wall. Pure: the browser feeds it the
  // driver's pushed-word mirror, the levels gate the committed golden
  // words — the same verdict both sides.
  function rxJudge(seen, profile, defects) {
    const DEFECT = !!defects?.judge; // re-injected: any pushed word passes
    const want = profile.words;
    const got = seen || [];
    if (!got.length)
      return {
        pass: false,
        code: 'nowords',
        verdict: 'no words yet — the machine has pushed nothing to the RX FIFO',
      };
    if (DEFECT)
      return {
        pass: true,
        code: 'defect',
        verdict: `rx (defect: ${got.length} words, unchecked)`,
      };
    for (let i = 0; i < want.length && i < got.length; i++) {
      const g = got[i] >>> 0,
        w = want[i] >>> 0;
      if (g === w) continue;
      for (let b = 31; b >= 0; b--) {
        const gb = (g >>> b) & 1,
          wb = (w >>> b) & 1;
        if (gb !== wb)
          return {
            pass: false,
            code: 'diverge',
            verdict: `word ${i + 1} bit ${b} — got ${gb}, want ${wb}`,
          };
      }
    }
    if (got.length < want.length)
      return {
        pass: false,
        code: 'watching',
        verdict: `${got.length} of ${want.length} words in — keep watching`,
      };
    return {
      pass: true,
      code: 'pass',
      verdict: `rx · ${want.length} words — the pushed bits are the given bits`,
    };
  }

  // ================= the decode judge (C40) =================
  // A pure judge over the OUTPUT wave (SPEC-16-9 run semantics, the
  // uart_tx monitor's receiver): the line is read as maximal
  // constant-level runs; a run of L clk is m = ceil(L / bitHi)
  // bit-times, legal iff m*bitLo <= L (the [BIT_LO, BIT_HI] idiom — a
  // fractional divisor legitimately lands slots anywhere in the window,
  // an exact window means FRAC 0); the concatenated runs must form
  // start (0), 8 data bits LSB-first, stop (1) — a high tail completes
  // the frame once it outlasts the remaining positions' bitLo (a stop
  // merged into idle costs nothing). Expected bytes = the driven data;
  // the near-miss faces: a bad run names its frame position, a wrong
  // byte names the bit. Pure: the browser feeds it the wave window, the
  // levels gate the committed golden series — the same verdict both
  // sides. DBITS 8, no parity (the frame map's own shape); frames
  // decode in order, one expected byte each.
  function uartJudge(bits, profile, defects) {
    const DEFECT = !!defects?.judge; // re-injected: any decoded frame passes
    const tp = profile.tiers[profile.tier];
    const want = profile.bytes;
    if (!bits?.length)
      return { pass: false, code: 'awaiting', verdict: 'awaiting run', frames: [] };
    // arm on the first 1→0 (the lens rule: a reset-0 pad startup is not
    // a start bit — the line must be seen high first)
    let start = -1;
    for (let k = 1; k < bits.length; k++)
      if (bits[k - 1] === 1 && bits[k] === 0) {
        start = k;
        break;
      }
    if (start < 0)
      return {
        pass: false,
        code: 'idle',
        verdict: 'no frame yet — the line never fell',
        frames: [],
      };
    const runs = [];
    let i = start;
    while (i < bits.length) {
      let j = i + 1;
      while (j < bits.length && bits[j] === bits[i]) j++;
      runs.push({ lvl: bits[i] ? 1 : 0, len: j - i });
      i = j;
    }
    const STOP = 9; // frame positions: 0 = start, 1..8 = data, 9 = stop
    const frames = [];
    let pos = 0,
      byte = 0,
      fb = '';
    for (const { lvl, len } of runs) {
      const k = STOP + 1 - pos; // remaining positions incl. the stop
      const name = pos === 0 ? 'start' : pos <= 8 ? `D${pos - 1}` : 'stop';
      // the completing high tail: checked by outlasting k*bitLo, never
      // by the run window (SPEC-16-9 — the merged stop costs nothing)
      if (lvl === 1 && len >= k * tp.bitLo) {
        for (let b = 0; b < k; b++) if (pos + b >= 1 && pos + b <= 8) byte |= 1 << (pos + b - 1);
        fb += '1'.repeat(Math.min(len, k * tp.bitHi));
        frames.push({ byte, bits: fb });
        pos = 0;
        byte = 0;
        fb = '';
        continue;
      }
      const m = Math.max(1, Math.ceil(len / tp.bitHi)); // fewest bits ([MODEL])
      if (len < m * tp.bitLo)
        return {
          pass: false,
          code: 'timing',
          verdict: `${name} runs ${len} clk — outside (${tp.bitLo}..${tp.bitHi} clk/bit)`,
          frames: frames.map((f) => f.bits),
        };
      if (pos + m > STOP + 1)
        return {
          pass: false,
          code: 'frame',
          verdict: `${name} holds ${len} clk — the frame never completed`,
          frames: frames.map((f) => f.bits),
        };
      for (let b = 0; b < m; b++) if (pos + b >= 1 && pos + b <= 8) byte |= lvl << (pos + b - 1);
      fb += String(lvl).repeat(len);
      pos += m;
      if (pos === STOP + 1) {
        frames.push({ byte, bits: fb });
        pos = 0;
        byte = 0;
        fb = '';
      }
    }
    const out = frames.map((f) => f.bits);
    if (DEFECT && frames.length)
      return { pass: true, code: 'defect', verdict: 'frame (defect: byte unchecked)', frames: out };
    for (let i = 0; i < Math.min(want.length, frames.length); i++) {
      const g = frames[i].byte,
        w = want[i];
      if (g === w) continue;
      for (let b = 0; b < 8; b++)
        if (((g >> b) & 1) !== ((w >> b) & 1))
          return {
            pass: false,
            code: 'data',
            verdict: `byte ${i + 1} bit D${b} — got ${(g >> b) & 1}, want ${(w >> b) & 1}`,
            frames: out,
            diverge: b,
          };
    }
    if (frames.length < want.length)
      return {
        pass: false,
        code: 'watching',
        verdict: `${frames.length} of ${want.length} byte${want.length !== 1 ? 's' : ''} in — keep watching`,
        frames: out,
      };
    if (frames.length > want.length)
      return {
        pass: false,
        code: 'extra',
        verdict: `byte ${want.length + 1} — the line drove a byte the world never gave`,
        frames: out,
      };
    const hex = want.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    return {
      pass: true,
      code: 'pass',
      verdict: `frame · ${hex} — the echo is the given`,
      frames: out,
      byte: frames[0].byte,
    };
  }

  function judge(bits, profile, defects) {
    if (profile.kind === 'square') return squareJudge(bits, profile.tiers[profile.tier], defects);
    if (profile.kind === 'rx') return rxJudge(bits, profile, defects);
    if (profile.kind === 'uart') return uartJudge(bits, profile, defects);
    throw new Error(`judge: no receiver for ${profile.kind}`);
  }

  // ================= the golden target glyph =================
  // C38: the visual monitor draws the tier itself as a golden wave — the
  // profile is the level's visible spec, conformance never golden traces,
  // so the glyph's numbers ARE the tier's numbers. Pure drawing data, no
  // DOM: a representative accepted cycle as a bit string (rise first, the
  // centered duty as the drawn high) plus the two windows the judge
  // checks, in clk — where the falling edge may land (the duty band on
  // the representative width) and where the next rise may land
  // (periodLo..periodHi; a zero-width window draws as a gold tick).
  function targetGlyph(profile) {
    if (profile.kind === 'uart') {
      // C40: the byte glyph — the tier as a frame. The representative
      // bit-time is the [BIT_LO,BIT_HI] window's center pulled inside
      // it; the drawn template is the expected byte's own frame (start,
      // the data bits LSB-first — 2-bit symbols merge into runs, the
      // run semantics the judge itself reads — then the stop; the idle
      // tail beyond the stop is not drawn). The two acceptance windows
      // after the frame's first fall: where the next edge may land (one
      // bit-time) and the edge after that (two) — the C38 grammar with
      // the uart tier's own numbers.
      const tp = profile.tiers[profile.tier];
      const bt = Math.min(Math.max(Math.round((tp.bitLo + tp.bitHi) / 2), tp.bitLo), tp.bitHi);
      let bits = '0'.repeat(bt); // the start bit
      for (let b = 0; b < 8; b++) bits += String(((profile.bytes[0] ?? 0) >> b) & 1).repeat(bt);
      bits += '1'.repeat(bt); // the stop bit
      return {
        clks: 10 * bt,
        bits,
        fallFrom: tp.bitLo,
        fallTo: tp.bitHi,
        nextFrom: 2 * tp.bitLo,
        nextTo: 2 * tp.bitHi,
      };
    }
    if (profile.kind !== 'square') throw new Error(`targetGlyph: no receiver for ${profile.kind}`);
    const tp = profile.tiers[profile.tier];
    const clks = tp.periodHi;
    const fallFrom = (clks * tp.dutyLoPct) / 100;
    const fallTo = (clks * tp.dutyHiPct) / 100;
    // the drawn high is the band's center, pulled inside it and kept to
    // less than the full cycle (a template that drew a flat line would
    // not be a square wave)
    const mid = Math.min(
      Math.max(Math.round((fallFrom + fallTo) / 2), Math.ceil(fallFrom)),
      Math.floor(fallTo),
    );
    const hi = Math.min(Math.max(mid, 1), clks - 1);
    return {
      clks,
      bits: '1'.repeat(hi) + '0'.repeat(clks - hi),
      fallFrom,
      fallTo,
      nextFrom: tp.periodLo,
      nextTo: tp.periodHi,
    };
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
    // C39: the fifo twins split — the reading leg (L6) unlocks the RX
    // half alone (TX is the feeder's, chapter 3's L9); the row itself
    // stays while either half is unlocked (applySurface derives it)
    txfifo: ['#fifo'],
    rxfifo: ['#rxfifo'],
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
    // C39: the fifo row's own visibility is derived — it stays while
    // either half is unlocked (L6 ships the RX half alone, TX absent
    // until the feeder chapter), and leaves layout entirely when both
    // halves are locked (the whole-row absence every earlier level ships)
    const fiforow = doc.querySelector('#fiforow');
    if (fiforow) fiforow.hidden = !(unlocked.has('txfifo') || unlocked.has('rxfifo'));
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
    rxJudge,
    uartJudge,
    CONDS,
    targetGlyph,
    gateOpen,
    programState,
    SURFACE,
    applySurface,
  };
  global.PioLevels = api;
  global.PIO_LEVEL = register; // the classic-script registration hook
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(this);

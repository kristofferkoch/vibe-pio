// row-complete.js — the C32 row-editor completion slot model (KANBAN
// C32). Extracted from sm-view.js's computeCands on the extract-on-touch
// rule: the suggestion sense is logic, not DOM glue.
//
// The candidate model stops being a token index. Each instruction has a
// SLOT model — its canonical signature as pio-asm.js's disassembler
// spells it (the same golden anchor as the assembler port, itself pinned
// to pio_model by golden bit-vectors + the 65536-word round-trip) —
// walked against the typed tokens: the caret sits in the first unfilled
// canonical slot; the vocabulary is the assembler's own operand table
// (the two can never drift apart); the separator an accepted candidate
// appends is the canonical one (', ' only where the canonical text has a
// comma — `push iffull,` was assembler-tolerated, non-canonical); and a
// slot whose token is already complete offers nothing (`set x, 3`
// offering 31 was noise, not help — the caret-anchor canon of C31: a
// completion result is valid only while the caret stays in the construct
// that triggered it).
//
// The pre-C32 token-index model ships as the {defect:'token-index'} hook
// — the TestMutationsDiverge idiom: the unit suite asserts every C32
// behavior DIVERGES from it (gpio/pin/irq at wait's polarity slot; the
// menu emptying mid-push; irq's rel/prev/next back at the mode slot; the
// universal ', ' after the first operand).
//
// Runtime JS is dependency-free: classic <script> after pio-asm.js
// (globalThis.RowComplete) or CommonJS (web/tests) — the engine-driver /
// pio-asm.js pattern.

((global) => {
  'use strict';

  // Vocabularies, built lazily from PioAsm's own tables so the menu can
  // never disagree with the encoders (drift there is caught by the
  // assembler suite; the unit test here pins the derivation).
  let VOC = null;
  function voc() {
    if (VOC) return VOC;
    const A =
      global.PioAsm ||
      (typeof module !== 'undefined' && module.exports ? require('./pio-asm.js') : null);
    if (!A) throw new Error('row-complete: PioAsm not loaded (pio-asm.js must load first)');
    const keysMinus = (tbl, ...skip) => Object.keys(tbl).filter((k) => !skip.includes(k));
    VOC = {
      mnemonics: ['jmp', 'wait', 'in', 'out', 'push', 'pull', 'mov', 'irq', 'set', 'nop'],
      conds: keysMinus(A.JMP_CONDS, 'always'),
      // wait's source names — encodeCore's srcmap (pio-asm.js SPEC-3.2)
      waitSrcs: ['gpio', 'pin', 'irq', 'jmppin'],
      idxModes: keysMinus(A.IDX_MODES, ''),
      inSrcs: Object.keys(A.IN_SRCS),
      outDsts: Object.keys(A.OUT_DSTS),
      movDsts: keysMinus(A.MOVD_DSTS, 'rxfifo'),
      movSrcs: keysMinus(A.MOVS_SRCS, 'rxfifo'),
      movOps: ['~', '::'],
      setDsts: Object.keys(A.SET_DSTS),
      irqModes: ['set', 'wait', 'clear'],
      counts: ['1', '4', '8', '16', '32'],
      setData: ['0', '1', '7', '31'],
    };
    return VOC;
  }

  // The editor is one line; the caret's token context is the text up to
  // it. `partial` is the (possibly empty) word under the caret; `toks`
  // are the completed words before it, split on whitespace/commas — the
  // same tokenizer the view's lineCtx always used.
  function splitCtx(upto) {
    const ls = upto.lastIndexOf('\n') + 1;
    const line = upto.slice(ls);
    const m = line.match(/([A-Za-z_~!<>:[\]-]*[\w![\]]*)$/);
    const partial = m ? m[1] : '';
    const before = line.slice(0, line.length - partial.length);
    const toks = before.split(/[\s,]+/).filter(Boolean);
    return { toks, partial };
  }

  const starts = (list, p) => list.filter((t) => t.toLowerCase().startsWith(p));
  // a complete occupant: an exact vocabulary member, or a number in range
  const numOk = (p, lo, hi) => /^\d+$/.test(p) && +p >= lo && +p <= hi;
  const C = (t, sep, param, note) => ({ t, sep, param, ...(note ? { note } : {}) });

  // The slot walk. Returns { slot, toks, partial, cands }: `slot` is the
  // caret's slot identity (a string — not a token index; push's block
  // flag lives at token 1 or 2 depending on whether iffull was given),
  // `cands` the textual candidates for it, each carrying the canonical
  // `sep` to append on accept, the params-row `param` it highlights, and
  // a slot-specific `note` where one applies.
  function slots(upto) {
    const V = voc();
    const { toks, partial } = splitCtx(upto);
    const p = partial.toLowerCase();
    const mk = (slot, cands) => ({ slot, toks, partial, cands });
    const names = (list) => (list.some((t) => t.toLowerCase() === p) ? [] : starts(list, p));
    if (!toks.length)
      return mk(
        '',
        V.mnemonics.filter((m) => m.startsWith(p)).map((m) => C(m, ' ')),
      );

    const mn = toks[0].toLowerCase();
    const r = toks.slice(1); // the completed operands

    if (mn === 'jmp') {
      // jmp [cond] target — digits at the first slot are the target
      // itself (always-jump); the target slot's gesture (the gutter pick)
      // is the view's, not text
      if (!r.length && !/\d/.test(p))
        return mk(
          'jmp.cond',
          names(V.conds).map((t) => C(t, ', ', 'cond')),
        );
      return mk('jmp.target', []);
    }
    if (mn === 'wait') {
      // wait pol src index [mode] — all space-separated; the trailing
      // index mode exists only under the irq source
      if (!r.length)
        return mk(
          'wait.pol',
          names(['0', '1']).map((t) =>
            C(t, ' ', 'pol', t === '0' ? 'wait for low (pol 0)' : 'wait for high (pol 1)'),
          ),
        );
      if (r.length === 1)
        return mk(
          'wait.src',
          names(V.waitSrcs).map((t) => C(t, ' ')),
        );
      if (r.length === 2) return mk('wait.idx', []); // the index is typed, not listed
      if (r.length === 3 && r[1].toLowerCase() === 'irq')
        return mk(
          'wait.mode',
          names(V.idxModes).map((t) => C(t, '', 'irq')),
        );
      return mk('wait.done', []);
    }
    if (mn === 'in' || mn === 'out') {
      // in src, count / out dst, count — the one comma in the canonical
      // text sits between the two slots
      const list = mn === 'in' ? V.inSrcs : V.outDsts;
      if (!r.length)
        return mk(
          `${mn}.${mn === 'in' ? 'src' : 'dst'}`,
          names(list).map((t) => C(t, ', ', mn === 'in' ? 'src' : 'dst')),
        );
      if (r.length === 1) {
        // 0 means 32 (SPEC-2-18): every listed count assembles
        const c = p === '' ? V.counts : numOk(p, 0, 32) ? [] : starts(V.counts, p);
        return mk(
          `${mn}.count`,
          c.map((t) => C(t, '', 'count')),
        );
      }
      return mk(`${mn}.done`, []);
    }
    if (mn === 'push' || mn === 'pull') {
      // push [iffull] block|noblock / pull [ifempty] block|noblock —
      // space-separated flags, block defaulting in, canonical order
      // flag-first (SECOND had no entry for them: the menu emptied
      // mid-instruction)
      const iff = mn === 'push' ? 'iffull' : 'ifempty';
      if (!r.length) {
        const c = names([iff, 'block', 'noblock']);
        return mk(
          `${mn}.iff`,
          c.map((t) => C(t, t === iff ? ' ' : '', t === iff ? iff : 'block')),
        );
      }
      if (r.length === 1 && r[0].toLowerCase() === iff)
        return mk(
          `${mn}.blk`,
          names(['block', 'noblock']).map((t) => C(t, '', 'block')),
        );
      return mk(`${mn}.done`, []); // block/noblock given — canonically complete
    }
    if (mn === 'mov') {
      // mov dst, [op]src — the op and its source are one token (~y, ::x)
      if (!r.length)
        return mk(
          'mov.dst',
          names(V.movDsts).map((t) => C(t, ', ', 'dst')),
        );
      if (r.length === 1) {
        const mOp = /^(~|::|!)(.*)$/.exec(p);
        const srcTok = mOp ? mOp[2] : p;
        const done = V.movSrcs.includes(srcTok);
        const list = done ? [] : starts(['~', '::', ...V.movSrcs], p);
        return mk(
          'mov.src',
          list.map((t) =>
            C(
              t,
              '',
              t === '~' || t === '::' ? 'op' : 'src',
              t === '~'
                ? 'bitwise invert the source'
                : t === '::'
                  ? "reverse the source's bit order"
                  : undefined,
            ),
          ),
        );
      }
      if (r.length === 2 && (r[1] === '~' || r[1] === '::' || r[1] === '!'))
        return mk(
          'mov.src',
          names(V.movSrcs).map((t) => C(t, '', 'src')),
        );
      return mk('mov.done', []);
    }
    if (mn === 'irq') {
      // irq [set|wait|clear] n [rel|prev|next] — space-separated; `set`
      // is an accepted spelling of the default mode (canonical text
      // omits it, exactly as the disassembler does)
      if (!r.length)
        return mk(
          'irq.mode',
          names(V.irqModes).map((t) =>
            C(
              t,
              ' ',
              'mode',
              t === 'set'
                ? 'the default mode — an accepted spelling; canonical text omits it'
                : undefined,
            ),
          ),
        );
      const modeGiven = V.irqModes.includes(r[0].toLowerCase());
      if (modeGiven && r.length === 1) return mk('irq.n', []); // the index is typed
      if ((modeGiven && r.length === 2) || (!modeGiven && r.length === 1))
        return mk(
          'irq.rel',
          names(V.idxModes).map((t) => C(t, '', 'rel')),
        );
      return mk('irq.done', []);
    }
    if (mn === 'set') {
      // set dst, data — the 5-bit immediate
      if (!r.length)
        return mk(
          'set.dst',
          names(V.setDsts).map((t) => C(t, ', ', 'dst')),
        );
      if (r.length === 1) {
        const c = p === '' ? V.setData : numOk(p, 0, 31) ? [] : starts(V.setData, p);
        return mk(
          'set.data',
          c.map((t) => C(t, '', 'data')),
        );
      }
      return mk('set.done', []);
    }
    if (mn === 'nop') return mk('nop.done', []);
    return mk('?', []); // unknown mnemonic
  }

  // The pre-C32 token-index model, verbatim (minus the view's pick
  // gesture and detail kinds): candidates keyed by operand POSITION, a
  // SECOND table with no push/pull entry, and the universal ', ' after
  // the first operand. The standing red case — never the shipped path.
  function defect(toks, p) {
    const V = voc();
    const DEFECT_ARGS = {
      jmp: V.conds,
      wait: ['gpio', 'pin', 'irq'],
      in: V.inSrcs,
      out: V.outDsts,
      push: ['iffull', 'block', 'noblock'],
      pull: ['ifempty', 'block', 'noblock'],
      mov: V.movDsts,
      irq: ['wait', 'clear', 'rel', 'prev', 'next'],
      set: V.setDsts,
    };
    const DEFECT_SECOND = { in: V.counts, out: V.counts, set: V.setData };
    const known = toks.length && V.mnemonics.includes(toks[0].toLowerCase());
    const sep = !known ? ' ' : toks.length === 1 ? ', ' : '';
    const wrap = (list) => list.map((t) => ({ t, sep, param: undefined }));
    if (!toks.length) return { slot: 0, cands: wrap(V.mnemonics.filter((m) => m.startsWith(p))) };
    const mn = toks[0].toLowerCase();
    const args = DEFECT_ARGS[mn];
    if (!args) return { slot: toks.length, cands: [] };
    const n = toks.length - 1;
    if (mn === 'jmp') {
      if (n === 0) return { slot: 1, cands: wrap(starts(args, p)) };
      return { slot: toks.length, cands: [] };
    }
    if (mn === 'mov') {
      if (n === 0) return { slot: 1, cands: wrap(starts(args, p)) };
      const opApplied = toks.slice(1).some((t) => t === '~' || t === '::');
      return {
        slot: toks.length,
        cands: wrap(starts(opApplied ? V.movSrcs : ['~', '::', ...V.movSrcs], p)),
      };
    }
    const second = DEFECT_SECOND[mn];
    return {
      slot: toks.length,
      cands: wrap(starts(n === 0 ? args : second || [], p)),
    };
  }

  // The entry point. `upto` is the editor text up to the caret; the
  // {defect:'token-index'} opt re-injects the pre-C32 model.
  function analyze(upto, opts) {
    const ctx = splitCtx(upto);
    if (opts && opts.defect === 'token-index') {
      const d = defect(ctx.toks, ctx.partial.toLowerCase());
      return { toks: ctx.toks, partial: ctx.partial, slot: d.slot, cands: d.cands };
    }
    return slots(upto);
  }

  const api = { splitCtx, analyze };
  global.RowComplete = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(this);

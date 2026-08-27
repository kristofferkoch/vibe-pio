// pio-asm.js — the C19 in-browser assembler/disassembler (KANBAN C19).
//
// A line-faithful JS port of the C12 pio_model trio encoding.py /
// asm.py / disasm.py (which are themselves bit-equal to pioasm 2.3.0
// on every conf_pioexamples program — difftest --asm-check). The port
// is anchored to that oracle, never to itself: web/tests/pio-asm.test.js
// checks it against golden bit-vectors generated from pio_model
// (tools/gen_pio_asm_golden.py, drift-checked by `make js`) plus the
// canonical round-trip property (assemble(disassemble(w)) === w over
// the whole 16-bit space x 4 side-set configs — the C12 1-1 form).
//
// Section/file references in the comments name the pio_model source
// each block mirrors; the SPEC-/CC- citations are carried over verbatim
// so the traceability chain (SPEC fact -> RTL -> model -> this port)
// stays intact. Runtime JS is dependency-free: this file loads as a
// classic <script> (defining globalThis.PioAsm) and as a CommonJS
// module (the test suite) — the engine-driver.js pattern.

((global) => {
  'use strict';

  // ================= encoding.py =================

  const M32 = 0xffffffff;

  // Instruction classes (SPEC-2-2: bits 15:13).
  const C_JMP = 0,
    C_WAIT = 1,
    C_IN = 2,
    C_OUT = 3,
    C_PP = 4,
    C_MOV = 5,
    C_IRQ = 6,
    C_SET = 7;

  // JMP conditions (SPEC-3.1-2..9).
  const JC_ALWAYS = 0,
    JC_NOTX = 1,
    JC_XDEC = 2,
    JC_NOTY = 3,
    JC_YDEC = 4,
    JC_XNEY = 5,
    JC_PIN = 6,
    JC_NOTOSRE = 7;
  // encodeJmp takes cond === null for always (Python's None key).
  const JMP_CONDS = {
    always: JC_ALWAYS,
    '!x': JC_NOTX,
    'x--': JC_XDEC,
    '!y': JC_NOTY,
    'y--': JC_YDEC,
    'x != y': JC_XNEY,
    pin: JC_PIN,
    '!osre': JC_NOTOSRE,
  };

  // WAIT sources (SPEC-3.2-2..5).
  const WSRC_GPIO = 0,
    WSRC_PIN = 1,
    WSRC_IRQ = 2,
    WSRC_JMPPIN = 3;

  // IN sources (SPEC-3.3-2..6).
  const INS_PINS = 0,
    INS_X = 1,
    INS_Y = 2,
    INS_NULL = 3,
    INS_ISR = 6,
    INS_OSR = 7;
  const IN_SRCS = {
    pins: INS_PINS,
    x: INS_X,
    y: INS_Y,
    null: INS_NULL,
    isr: INS_ISR,
    osr: INS_OSR,
  };

  // OUT destinations (SPEC-3.4-2..8).
  const OUTD_PINS = 0,
    OUTD_X = 1,
    OUTD_Y = 2,
    OUTD_NULL = 3,
    OUTD_PINDIRS = 4,
    OUTD_PC = 5,
    OUTD_ISR = 6,
    OUTD_EXEC = 7;
  const OUT_DSTS = {
    pins: OUTD_PINS,
    x: OUTD_X,
    y: OUTD_Y,
    null: OUTD_NULL,
    pindirs: OUTD_PINDIRS,
    pc: OUTD_PC,
    isr: OUTD_ISR,
    exec: OUTD_EXEC,
  };

  // MOV destinations / sources (SPEC-3.6-1..8); 4 EXEC, 5 PC / 5 STATUS.
  const MOVD_PINS = 0,
    MOVD_X = 1,
    MOVD_Y = 2,
    MOVD_PINDIRS = 3,
    MOVD_EXEC = 4,
    MOVD_PC = 5,
    MOVD_ISR = 6,
    MOVD_OSR = 7;
  const MOVS_PINS = 0,
    MOVS_X = 1,
    MOVS_Y = 2,
    MOVS_NULL = 3,
    MOVS_STATUS = 5,
    MOVS_ISR = 6,
    MOVS_OSR = 7;
  const MOVD_DSTS = {
    pins: MOVD_PINS,
    x: MOVD_X,
    y: MOVD_Y,
    pindirs: MOVD_PINDIRS,
    exec: MOVD_EXEC,
    pc: MOVD_PC,
    isr: MOVD_ISR,
    osr: MOVD_OSR,
    rxfifo: null,
  };
  const MOVS_SRCS = {
    pins: MOVS_PINS,
    x: MOVS_X,
    y: MOVS_Y,
    null: MOVS_NULL,
    status: MOVS_STATUS,
    isr: MOVS_ISR,
    osr: MOVS_OSR,
    rxfifo: null,
  };
  const MOP_NONE = 0,
    MOP_INV = 1,
    MOP_REV = 2; // SPEC-3.6-9 (3 reserved)

  // SET destinations (SPEC-3.9-1/2).
  const SETD_PINS = 0,
    SETD_X = 1,
    SETD_Y = 2,
    SETD_PINDIRS = 4;
  const SET_DSTS = { pins: SETD_PINS, x: SETD_X, y: SETD_Y, pindirs: SETD_PINDIRS };

  // IRQ / WAIT-IRQ IdxModes (SPEC-3.8-4..7, SPEC-14.3-1).
  const IDX_THIS = 0,
    IDX_PREV = 1,
    IDX_REL = 2,
    IDX_NEXT = 3;
  const IDX_MODES = { '': IDX_THIS, prev: IDX_PREV, rel: IDX_REL, next: IDX_NEXT };

  class ReservedEncoding extends Error {
    constructor(msg) {
      super(msg);
      this.name = 'ReservedEncoding';
    }
  }

  class AsmError extends Error {
    // Assembly-time error (bad directive, expression or operand).
    constructor(msg) {
      super(msg);
      this.name = 'AsmError';
    }
  }

  function idxMode(mode) {
    // Python IDX_MODES[None] === IDX_THIS; null/'/' both map here.
    if (mode === null || mode === undefined) return IDX_THIS;
    const v = IDX_MODES[mode];
    if (v === undefined) throw new Error(`bad idx mode ${mode}`);
    return v;
  }

  // SPEC-2-1..5 field split: [class, delay/side-set, arg1, arg2].
  function split(word) {
    return [(word >> 13) & 7, (word >> 8) & 0x1f, (word >> 5) & 7, word & 0x1f];
  }

  // Delay/side-set split (SPEC-4-1..3, SPEC-4-9, SPEC-14.8-1) — exactly
  // what rtl/pio_sm_decoder.sv computes. sideset_count is the raw
  // PINCTRL field (0..5, inclusive of the enable bit when side_en).
  function splitSideset(dsField, sideEn, sidesetCount) {
    const total = sidesetCount & 7;
    if (total > 5) throw new ReservedEncoding('sideset_count > 5');
    const vbits = sideEn ? total - 1 : total;
    const ssField = total ? dsField >> (5 - total) : 0;
    const delayMask = 0x1f >> total;
    const enBit = total ? (ssField >> (total - 1)) & 1 : 0;
    const ssValid = total !== 0 && (!sideEn || enBit !== 0);
    const ssVal = ssValid && vbits ? ssField & (0x1f >> (5 - vbits)) : 0;
    return { delay: dsField & delayMask, ssValid, ssVal, ssBits: ssValid ? vbits : 0 };
  }

  // Full decode of one instruction word -> the onehot class strobes,
  // per-class operands and `illegal` (SPEC-13-1) — the bundle
  // rtl/pio_sm_decoder.sv hands to pio_sm_exec. Reserved encodings
  // decode with illegal=true (the RTL executes them as pure no-ops);
  // never throws. Keys mirror encoding.py's Decoded verbatim.
  function decode(word, sideEn = false, sidesetCount = 0) {
    const [cls, ds, arg1, arg2] = split(word);
    const ss = splitSideset(ds, sideEn, sidesetCount);
    const d = {
      word: word & 0xffff,
      cls,
      delay: ss.delay,
      ss_valid: ss.ssValid,
      ss_val: ss.ssVal,
      ss_bits: ss.ssBits,
      illegal: false,
      is_jmp: false,
      is_wait: false,
      is_in: false,
      is_out: false,
      is_push: false,
      is_pull: false,
      is_put: false,
      is_get: false,
      is_mov: false,
      is_irq: false,
      is_set: false,
    };
    if (cls === C_JMP) {
      // SPEC-2-7
      d.is_jmp = true;
      d.jmp_cond = arg1;
      d.jmp_addr = arg2;
    } else if (cls === C_WAIT) {
      // SPEC-2-8
      d.is_wait = true;
      d.wait_pol = (arg1 >> 2) & 1; // SPEC-3.2-1
      d.wait_src = arg1 & 3; // SPEC-3.2-2..5
      d.wait_index = arg2;
      if (d.wait_src === WSRC_JMPPIN && (arg2 & 0x1c) !== 0) d.illegal = true; // SPEC-13-1
    } else if (cls === C_IN) {
      // SPEC-2-9
      d.is_in = true;
      d.in_src = arg1;
      if (arg1 === 4 || arg1 === 5) d.illegal = true; // SPEC-3.3-5
      d.in_count = arg2 === 0 ? 32 : arg2; // SPEC-2-18
    } else if (cls === C_OUT) {
      // SPEC-2-10
      d.is_out = true;
      d.out_dst = arg1;
      d.out_count = arg2 === 0 ? 32 : arg2; // SPEC-2-18
    } else if (cls === C_PP) {
      // SPEC-14.2-1
      if (arg2 & 0x10) {
        if (word & 0x80) d.is_get = true;
        else d.is_put = true; // b7: GET/PUT
        d.aux_idxi = (arg2 >> 3) & 1; // SPEC-3.7-4
        d.aux_index = arg2 & 3;
        if ((arg2 & 4) !== 0 || (d.aux_idxi === 0 && (arg2 & 3) !== 0)) d.illegal = true; // SPEC-13-1
      } else {
        if (word & 0x80) d.is_pull = true;
        else d.is_push = true; // SPEC-2-11/13
        if (arg2 !== 0) d.illegal = true; // SPEC-13-1
        // SPEC-3.5-3 pioasm arg1 packing: b7 direction, b6 IfF/IfE, b5 Blk
        d.push_iff = (word >> 6) & 1;
        d.push_blk = (word >> 5) & 1;
        d.pull_ife = (word >> 6) & 1;
        d.pull_blk = (word >> 5) & 1;
      }
    } else if (cls === C_MOV) {
      // SPEC-2-15
      d.is_mov = true;
      d.mov_dst = arg1;
      d.mov_src = word & 7;
      d.mov_op = (arg2 >> 3) & 3;
      if (d.mov_op === 3 || d.mov_src === 4) d.illegal = true; // SPEC-13-1
    } else if (cls === C_IRQ) {
      // SPEC-2-16
      d.is_irq = true;
      d.irq_clr = (word >> 6) & 1; // SPEC-3.8-1
      d.irq_wait = (word >> 5) & 1; // SPEC-3.8-2
      d.irq_idxmode = (arg2 >> 3) & 3;
      d.irq_index = arg2 & 7;
      if (d.irq_clr && d.irq_wait) d.illegal = true; // SPEC-3.8-3
    } else {
      // SPEC-2-17
      d.is_set = true;
      d.set_dst = arg1;
      d.set_data = arg2;
      if (arg1 === 3 || arg1 === 5 || arg1 === 6 || arg1 === 7) d.illegal = true; // SPEC-3.9-2
    }
    return d;
  }

  // Pack the delay/side-set field, bit-equal to pioasm
  // (pio_assembler.cpp instruction::encode): delay is always masked to
  // 5 - sideset_count bits (SPEC-4-3); a present `side` shifts its
  // value into the top bits and, with SIDE_EN, forces the enable bit
  // 0x10 (SPEC-4-2 — an absent side contributes nothing, enable=0).
  function packDs(delay, sideVal, sideEn, sidesetCount, sidePresent) {
    const total = sidesetCount & 7;
    if (total === 0) {
      if (sidePresent && sideVal) {
        throw new ReservedEncoding('side value with SIDESET_COUNT=0 (SPEC-4-9)');
      }
      return delay & 0x1f;
    }
    const mask = (1 << (5 - total)) - 1;
    let field = delay & mask;
    if (sidePresent) {
      field |= (sideVal << (5 - total)) & 0x1f;
      if (sideEn) field |= 0x10;
    }
    return field;
  }

  // Pack the four SPEC-2-1..5 fields into one 16-bit word.
  function encode(clz, arg1, arg2, ds) {
    return ((clz << 13) | ((ds & 0x1f) << 8) | ((arg1 & 7) << 5) | (arg2 & 0x1f)) & 0xffff;
  }

  // The name-taking encoders throw TypeError("'key'") on an unknown
  // operand — the KeyError analog; assembleInstruction's wrapper turns
  // that into an AsmError naming the source line (the Python
  // `except KeyError` boundary of assemble_instruction).
  function badOperand(key) {
    throw new TypeError(`'${key}'`);
  }

  function encodeJmp(cond, addr, ds = 0) {
    // SPEC-2-7; cond is the pioasm condition text (null = always).
    const c = cond === null ? JC_ALWAYS : JMP_CONDS[cond];
    if (c === undefined) badOperand(cond);
    return encode(C_JMP, c, addr, ds);
  }

  function encodeWait(pol, src, index, ds = 0) {
    // SPEC-2-8; pol 1/0, src a WSRC_* constant.
    return encode(C_WAIT, ((pol ? 1 : 0) << 2) | src, index, ds);
  }

  function encodeIn(src, count, ds = 0) {
    // SPEC-2-9; src is the pioasm IN source name.
    if (IN_SRCS[src] === undefined) badOperand(src);
    return encode(C_IN, IN_SRCS[src], count & 0x1f, ds);
  }

  function encodeOut(dst, count, ds = 0) {
    // SPEC-2-10; dst is the pioasm OUT destination name.
    if (OUT_DSTS[dst] === undefined) badOperand(dst);
    return encode(C_OUT, OUT_DSTS[dst], count & 0x1f, ds);
  }

  function encodePush(iffull, block, ds = 0) {
    // SPEC-2-11.
    return encode(C_PP, (block ? 1 : 0) | ((iffull ? 1 : 0) << 1), 0, ds);
  }

  function encodePull(ifempty, block, ds = 0) {
    // SPEC-2-13.
    return encode(C_PP, 4 | (block ? 1 : 0) | ((ifempty ? 1 : 0) << 1), 0, ds);
  }

  function encodePut(index, ds = 0) {
    // SPEC-2-12: arg2 = 0x10 | (idx if literal else 0); a literal idx
    // packs IdxI=1 (0x08) + Index&3 (pioasm get_push_get_index).
    const arg2 = 0x10 | (index === null || index === undefined ? 0 : 8 | (index & 3));
    return encode(C_PP, 0, arg2, ds);
  }

  function encodeGet(index, ds = 0) {
    // SPEC-2-14 (index packing as encodePut).
    const arg2 = 0x10 | (index === null || index === undefined ? 0 : 8 | (index & 3));
    return encode(C_PP, 4, arg2, ds);
  }

  function encodeMov(dst, src, op, ds = 0) {
    // SPEC-2-15; dst/src are pioasm names, op a MOP_* constant.
    // `rxfifo` is not a MOV operand (it is FIFO-aux PUT/GET —
    // encodePut/encodeGet); it maps to null in the tables.
    const dstCode = MOVD_DSTS[dst];
    const srcCode = MOVS_SRCS[src];
    if (dstCode === undefined || srcCode === undefined)
      badOperand(dstCode === undefined ? dst : src);
    if (dstCode === null || srcCode === null)
      badOperand('rxfifo (use encodePut/encodeGet instead)');
    return encode(C_MOV, dstCode, ((op & 3) << 3) | srcCode, ds);
  }

  function encodeIrq(clr, wait, mode, index, ds = 0) {
    // SPEC-2-16; mode is an IDX_* constant or its pioasm name/null.
    const m = typeof mode === 'string' ? idxMode(mode) : mode;
    return encode(C_IRQ, ((clr ? 1 : 0) << 1) | (wait ? 1 : 0), ((m & 3) << 3) | (index & 7), ds);
  }

  function encodeSet(dst, data, ds = 0) {
    // SPEC-2-17; dst is the pioasm SET destination name.
    if (SET_DSTS[dst] === undefined) badOperand(dst);
    return encode(C_SET, SET_DSTS[dst], data, ds);
  }

  // ================= asm.py: expression evaluator =================
  // Subset: ints (dec/0x/0b), identifiers, + - * / % << >> & | ^ ~ and
  // parens. Division truncates toward zero like C (pioasm), not floor —
  // the classic JS porting trap (JS `/` floors on negatives). Shifts
  // use JS 32-bit semantics (pioasm compiles to C++ ints — 32-bit is
  // the faithful behavior; Python's bigints only diverge at shift >= 32,
  // which no real program uses).

  const TOK_RE =
    /(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+|[A-Za-z_.][A-Za-z0-9_.]*|<<|>>|[()+\-*/%&|^~])/y;

  function exprTokens(s, where) {
    const toks = [];
    let pos = 0;
    while (pos < s.length) {
      if (/\s/.test(s[pos])) {
        pos++;
        continue;
      }
      TOK_RE.lastIndex = pos;
      const m = TOK_RE.exec(s);
      if (!m) throw new AsmError(`bad expression token at '${s.slice(pos)}' (${where})`);
      toks.push(m[1]);
      pos = TOK_RE.lastIndex;
    }
    return toks;
  }

  // Python int(tok, 0): 0x/0b prefixes, plain decimal; leading-zero
  // decimals are rejected (fall through to symbol lookup, as in Python).
  function parseInt0(tok) {
    if (/^0[xX]/.test(tok)) return parseInt(tok.slice(2), 16);
    if (/^0[bB]/.test(tok)) return parseInt(tok.slice(2), 2);
    if (/^\d+$/.test(tok)) return tok.length > 1 && tok[0] === '0' ? Number.NaN : parseInt(tok, 10);
    return Number.NaN;
  }

  const PREC = {
    '|': 1,
    '^': 2,
    '&': 3,
    '<<': 4,
    '>>': 4,
    '+': 5,
    '-': 5,
    '*': 6,
    '/': 6,
    '%': 6,
  };

  class ExprParser {
    constructor(toks, symbols, where) {
      this.t = toks;
      this.i = 0;
      this.sym = symbols;
      this.where = where;
    }

    peek() {
      return this.i < this.t.length ? this.t[this.i] : null;
    }

    take() {
      const tok = this.peek();
      this.i++;
      return tok;
    }

    primary() {
      const tok = this.take();
      if (tok === null) throw new AsmError(`${this.where}: expression ended early`);
      if (tok === '(') {
        const v = this.binary(0);
        if (this.take() !== ')') throw new AsmError(`${this.where}: missing ')'`);
        return v;
      }
      if (tok === '-') return -this.primary();
      if (tok === '~') return ~this.primary();
      if (tok === '+') return this.primary();
      const v = parseInt0(tok);
      if (!Number.isNaN(v)) return v;
      if (Object.hasOwn(this.sym, tok)) return this.sym[tok];
      throw new AsmError(`${this.where}: unknown symbol '${tok}'`);
    }

    binary(minPrec) {
      let v = this.primary();
      for (;;) {
        const op = this.peek();
        if (op === null || PREC[op] === undefined || PREC[op] < minPrec) return v;
        this.take();
        const rhs = this.binary(PREC[op] + 1);
        if (op === '+') v += rhs;
        else if (op === '-') v -= rhs;
        else if (op === '*') v *= rhs;
        else if (op === '/') {
          if (rhs === 0) throw new AsmError(`${this.where}: division by zero`);
          v = Math.trunc(v / rhs); // C-style truncation
        } else if (op === '%') {
          if (rhs === 0) throw new AsmError(`${this.where}: division by zero`);
          v = v - rhs * Math.trunc(v / rhs); // C-style remainder
        } else if (op === '<<') v <<= rhs;
        else if (op === '>>') v >>= rhs;
        else if (op === '&') v &= rhs;
        else if (op === '|') v |= rhs;
        else if (op === '^') v ^= rhs;
      }
    }
  }

  function evalExpr(text, symbols, where = '') {
    return new ExprParser(exprTokens(text, where), symbols, where).binary(0);
  }

  // ================= asm.py: two-pass parser =================

  class Program {
    // One assembled .program: words plus the metadata the harness needs
    // (mirrors pio_model asm.Program).
    constructor(name) {
      this.name = name;
      this.pioVersion = null;
      this.origin = -1;
      this.wrapTarget = null; // index or null (default 0)
      this.wrap = null; // index or null (default last)
      this.sidesetBits = null; // .side_set N (null = absent)
      this.sidesetOpt = false;
      this.sidesetPindirs = false;
      this.symbols = {}; // .define values
      this.publicSymbols = new Set();
      this.labels = {}; // label -> instruction index
      this.publicLabels = new Set();
      this.srcLines = []; // {text, lineno} pass-2 inputs
      this.words = [];
      this.disasm = []; // canonical text per word (filled by callers)
    }

    get sidesetCount() {
      // PINCTRL.SIDESET_COUNT value (incl. enable bit, SPEC-7-26).
      if (this.sidesetBits === null) return 0;
      return this.sidesetBits + (this.sidesetOpt ? 1 : 0);
    }

    get sideEn() {
      return this.sidesetBits !== null && this.sidesetOpt;
    }
  }

  // Python str.split(None, maxsplit): split on whitespace runs, at most
  // maxsplit splits, no empty tokens.
  function pySplit(s, maxSplit) {
    const out = [];
    let i = 0;
    const n = s.length;
    while (i < n) {
      while (i < n && /\s/.test(s[i])) i++;
      if (i >= n) break;
      if (out.length === maxSplit) {
        out.push(s.slice(i));
        break;
      }
      let j = i;
      while (j < n && !/\s/.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
    }
    return out;
  }

  function stripCommas(s) {
    // Python str.strip(",")
    return s.replace(/^[,]+|[,]+$/g, '');
  }

  const LABEL_RE = /^(public\s+|PUBLIC\s+)?([A-Za-z_]\w*)\s*:\s*(.*)$/;

  function stripComment(line) {
    let out = '';
    let i = 0;
    const n = line.length;
    while (i < n) {
      const two = line.slice(i, i + 2);
      if (two === '//' || line[i] === ';') break;
      if (two === '/*') {
        // block comment (rare)
        const j = line.indexOf('*/', i + 2);
        i = j < 0 ? n : j + 2;
        continue;
      }
      out += line[i];
      i++;
    }
    return out;
  }

  function parseText(text, name = '<text>') {
    // Parse .pio source text -> array of assembled Programs.
    const programs = [];
    let prog = null;
    let inBlock = false;
    let pendingVersion = null; // .pio_version may lead .program
    const lines = text.split('\n');
    for (let ln = 1; ln <= lines.length; ln++) {
      const line = stripComment(lines[ln - 1]);
      if (inBlock) {
        if (line.trim() === '%}') inBlock = false;
        continue;
      }
      const s = line.trim();
      if (!s) continue;
      if (s.startsWith('%')) {
        // % c-sdk { ... %} etc.
        if (s !== '%}' && !s.endsWith('%}')) inBlock = true;
        continue;
      }
      if (s.startsWith('.')) {
        const toks = s.split(/\s+/);
        if (toks[0].toLowerCase() === '.program') {
          prog = new Program(toks[1]);
          if (pendingVersion !== null) {
            prog.pioVersion = pendingVersion;
            pendingVersion = null;
          }
          programs.push(prog);
          continue;
        }
        if (toks[0].toLowerCase() === '.lang_opt') continue; // host-language metadata only
        if (toks[0].toLowerCase() === '.pio_version' && prog === null) {
          pendingVersion = parseInt(pySplit(s, 1)[1], 10);
          continue;
        }
        prog = directive(s, prog, programs, name, ln);
        continue;
      }
      if (prog === null) throw new AsmError(`${name}:${ln}: instruction outside .program`);
      let rest = s;
      for (;;) {
        const m = LABEL_RE.exec(rest);
        if (!m) break;
        if (m[1]) prog.publicLabels.add(m[2]);
        if (Object.hasOwn(prog.labels, m[2])) {
          throw new AsmError(`${name}:${ln}: duplicate label ${m[2]}`);
        }
        prog.labels[m[2]] = prog.srcLines.length;
        rest = m[3].trim();
      }
      if (rest) prog.srcLines.push({ text: rest, lineno: ln });
    }
    for (const p of programs) finish(p);
    return programs;
  }

  function directive(s, prog, programs, name, lineno) {
    const toks = s.split(/\s+/);
    const d = toks[0].toLowerCase();
    const arg = s.slice(toks[0].length).trim();
    const where = `${name}:${lineno}`;
    if (d === '.program') {
      prog = new Program(toks[1]);
      programs.push(prog);
      return prog;
    }
    if (prog === null) throw new AsmError(`${where}: ${d} before .program`);
    if (d === '.pio_version') {
      prog.pioVersion = parseInt(arg, 10);
    } else if (d === '.origin') {
      prog.origin = evalExpr(arg, {}, where);
    } else if (d === '.wrap_target') {
      prog.wrapTarget = prog.srcLines.length; // next instruction's index
    } else if (d === '.wrap') {
      prog.wrap = prog.srcLines.length - 1; // preceding instruction
    } else if (d === '.side_set') {
      const parts = pySplit(arg, Infinity);
      prog.sidesetBits = evalExpr(parts[0], {}, where);
      for (const opt of parts.slice(1)) {
        if (opt === 'opt')
          prog.sidesetOpt = true; // SPEC-4-2 enable bit
        else if (opt === 'pindirs')
          prog.sidesetPindirs = true; // SPEC-4-4
        else throw new AsmError(`${where}: .side_set '${opt}'`);
      }
    } else if (d === '.define') {
      let parts = pySplit(arg, 1);
      let pub = false;
      if (parts.length && parts[0].toLowerCase() === 'public') {
        pub = true;
        parts = pySplit(arg, 2).slice(1);
      }
      if (parts.length !== 2) throw new AsmError(`${where}: .define NAME EXPR`);
      prog.symbols[parts[0]] = evalExpr(parts[1], prog.symbols, where);
      if (pub) prog.publicSymbols.add(parts[0]);
    } else if (d === '.lang_opt') {
      // host-language metadata only
    } else if (
      d === '.in' ||
      d === '.out' ||
      d === '.set_count' ||
      d === '.fifo' ||
      d === '.mov_status' ||
      d === '.clock_div'
    ) {
      throw new AsmError(
        `${where}: ${d} not supported by the native assembler (unused by the conformance programs)`,
      );
    } else {
      throw new AsmError(`${where}: unknown directive ${d}`);
    }
    return prog;
  }

  function finish(prog) {
    if (prog.sidesetBits !== null && prog.sidesetBits > 5) {
      throw new AsmError(`${prog.name}: side_set bits > 5`);
    }
    if (!prog.srcLines.length) {
      if (prog.wrap === null) {
        prog.wrap = 0;
        prog.wrapTarget = 0;
      }
      return;
    }
    prog.wrap = prog.wrap === null ? prog.srcLines.length - 1 : prog.wrap;
    prog.wrapTarget = prog.wrapTarget === null ? 0 : prog.wrapTarget;
    const symbols = { ...prog.symbols, ...prog.labels };
    prog.words = prog.srcLines.map(({ text, lineno }) =>
      assembleInstruction(text, prog, symbols, `${prog.name}:${lineno}`),
    );
  }

  // ================= asm.py: pass 2, one line -> word =================

  const SIDE_RE = /\bside\s+(\S+)/;
  const DELAY_RE = /\s\[\s*([^\]]+)\]\s*$/; // space-gated: rxfifo[i] is
  // an operand subscript, not a delay postfix

  function assembleInstruction(text, prog, symbols, where) {
    let line = text;
    let delay = 0;
    let sideVal = 0;
    let sidePresent = false;
    for (;;) {
      // [delay] / side val in any order
      let m = DELAY_RE.exec(line);
      if (m) {
        delay = evalExpr(m[1], symbols, where);
        line = line.slice(0, m.index).trim();
        continue;
      }
      m = SIDE_RE.exec(line);
      if (m) {
        sideVal = evalExpr(m[1], symbols, where);
        sidePresent = true;
        line = (line.slice(0, m.index) + line.slice(m.index + m[0].length)).trim();
        continue;
      }
      break;
    }
    const ds = packDs(delay, sideVal, prog.sideEn, prog.sidesetCount, sidePresent);
    const toks = line.replace(/,/g, ' , ').split(/\s+/).filter(Boolean);
    const mn = toks[0].toLowerCase();
    const rest = line.slice(toks[0].length).trim();

    let word;
    try {
      word = encodeCore(mn, rest, symbols, where);
    } catch (e) {
      // the Python `except KeyError` boundary: a raw table miss from a
      // name-taking encoder becomes an AsmError naming the line
      if (e instanceof TypeError)
        throw new AsmError(`${where}: unknown ${mn} operand ${e.message}`);
      throw e;
    }
    return (word | (ds << 8)) & 0xffff;
  }

  function opnd(rest, symbols, where) {
    // Evaluate one operand expression (strip trailing/leading commas).
    return evalExpr(rest.trim().replace(/[,]+$/, '').trim(), symbols, where);
  }

  function split2(rest, where) {
    // 'mnemonic a, b' -> [a, b]
    const i = rest.indexOf(',');
    if (i < 0) throw new AsmError(`${where}: expected 'mnemonic a, b' got '${rest}'`);
    return [rest.slice(0, i).trim(), rest.slice(i + 1).trim()];
  }

  function encodeCore(mn, rest, symbols, where) {
    if (mn === 'nop') {
      // SPEC-3.6-10
      if (rest) throw new AsmError(`${where}: nop takes no operands`);
      return encodeMov('y', 'y', MOP_NONE, 0);
    }
    if (mn === 'jmp') {
      // SPEC-3.1
      let cond = null;
      let target = rest;
      for (const c of ['x != y', '!x', 'x--', '!y', 'y--', 'pin', '!osre']) {
        if (rest.toLowerCase().startsWith(c) && rest.length > c.length) {
          cond = c;
          target = rest.slice(c.length).trim().replace(/^[,]+/, '').trim();
          break;
        }
      }
      return encodeJmp(cond, opnd(target, symbols, where), 0);
    }
    if (mn === 'wait') {
      // SPEC-3.2
      const parts = rest.split(/\s+/);
      const pol = parts[0] === '1' ? 1 : 0;
      const src = stripCommas(parts[1]).toLowerCase();
      let idx = 0;
      let mode = null;
      for (const t of parts.slice(2)) {
        const tl = stripCommas(t);
        if (tl === 'rel' || tl === 'prev' || tl === 'next') mode = tl;
        else idx = evalExpr(tl, symbols, where);
      }
      const srcmap = { gpio: WSRC_GPIO, pin: WSRC_PIN, irq: WSRC_IRQ, jmppin: WSRC_JMPPIN };
      if (srcmap[src] === undefined) badOperand(src);
      return encodeWait(pol, srcmap[src], src === 'irq' ? (idxMode(mode) << 3) | idx : idx, 0);
    }
    if (mn === 'in') {
      // SPEC-3.3
      const [src, cnt] = split2(rest, where);
      return encodeIn(src.toLowerCase(), opnd(cnt, symbols, where), 0);
    }
    if (mn === 'out') {
      // SPEC-3.4
      const [dst, cnt] = split2(rest, where);
      return encodeOut(dst.toLowerCase(), opnd(cnt, symbols, where), 0);
    }
    if (mn === 'push' || mn === 'pull') {
      // SPEC-3.5
      const iff = rest.includes('iffull') || rest.includes('ifempty');
      const blk = !/\bnoblock\b/.test(rest);
      return mn === 'push' ? encodePush(iff, blk, 0) : encodePull(iff, blk, 0);
    }
    if (mn === 'mov') {
      // SPEC-3.6 / SPEC-3.7
      const [dst, src] = split2(rest, where);
      let m = /^rxfifo\s*\[([^\]]*)\]/i.exec(dst);
      if (m) {
        const idx = m[1].trim();
        const idxv = idx === '' || idx.toLowerCase() === 'y' ? null : evalExpr(idx, symbols, where);
        return encodePut(idxv, 0);
      }
      m = /^rxfifo\s*\[([^\]]*)\]/i.exec(src);
      if (m) {
        const idx = m[1].trim();
        const idxv = idx === '' || idx.toLowerCase() === 'y' ? null : evalExpr(idx, symbols, where);
        return encodeGet(idxv, 0);
      }
      let s = src;
      let op = MOP_NONE;
      if (s[0] === '~' || s[0] === '!') {
        // pioasm: ~ and ! both invert
        op = MOP_INV;
        s = s.slice(1);
      } else if (s.startsWith('::')) {
        op = MOP_REV;
        s = s.slice(2);
      }
      return encodeMov(dst.toLowerCase(), s.toLowerCase().trim(), op, 0);
    }
    if (mn === 'irq') {
      // SPEC-3.8
      let clr = false;
      let wait = false;
      let mode = null;
      let idx = null;
      for (const t of rest.split(/\s+/)) {
        const tl = stripCommas(t);
        if (tl === 'clear') clr = true;
        else if (tl === 'wait') wait = true;
        else if (tl === 'nowait' || tl === 'set') {
          // accepted spellings, no effect
        } else if (tl === 'rel' || tl === 'prev' || tl === 'next') mode = tl;
        else if (idx === null) idx = evalExpr(tl, symbols, where);
      }
      if (idx === null) throw new AsmError(`${where}: irq needs an index`);
      return encodeIrq(clr, wait, idxMode(mode), idx, 0);
    }
    if (mn === 'set') {
      // SPEC-3.9
      const [dst, data] = split2(rest, where);
      return encodeSet(dst.toLowerCase(), opnd(data, symbols, where), 0);
    }
    throw new AsmError(`${where}: unknown mnemonic '${mn}'`);
  }

  // ================= disasm.py =================

  function revMap(table, skipNullValues) {
    const out = {};
    for (const [k, v] of Object.entries(table)) {
      if (skipNullValues && v === null) continue;
      out[v] = k;
    }
    return out;
  }
  const _JMP_CONDS = revMap(JMP_CONDS);
  const _IN_SRCS = revMap(IN_SRCS);
  const _OUT_DSTS = revMap(OUT_DSTS);
  const _MOVD_DSTS = revMap(MOVD_DSTS, true);
  const _MOVS_SRCS = revMap(MOVS_SRCS, true);
  _MOVS_SRCS[MOVS_STATUS] = 'status';
  const _SET_DSTS = revMap(SET_DSTS);
  const _IDX_MODES = revMap(IDX_MODES);
  const _OPS = { [MOP_NONE]: '', [MOP_INV]: '~', [MOP_REV]: '::' };

  // Word -> canonical instruction text (throws ReservedEncoding for
  // SPEC-13-1 encodings). The canonical one-space-separated form the
  // native assembler round-trips bit-exactly (the C12 1-1 property —
  // pinned here by the 65536-word round-trip test).
  function disassemble(word, sideEn = false, sidesetCount = 0) {
    const d = decode(word, sideEn, sidesetCount);
    if (d.illegal) {
      throw new ReservedEncoding(
        `reserved encoding ${word.toString(16).padStart(4, '0')} (SPEC-13-1)`,
      );
    }
    // ds-field aliasing (e.g. side-set data bits with the opt enable 0)
    // has no faithful text: the canonical re-pack must reproduce the word.
    const repack = packDs(d.delay, d.ss_val, sideEn, sidesetCount, d.ss_valid);
    if (repack !== ((word >> 8) & 0x1f)) {
      throw new ReservedEncoding(
        `aliased delay/side-set field ${((word >> 8) & 0x1f).toString(16).padStart(2, '0')} (SPEC-4-1..3)`,
      );
    }
    let pf = '';
    if (d.ss_valid) pf += ` side ${d.ss_val}`;
    if (d.delay) pf += ` [${d.delay}]`;
    const count = (n) => n || 32; // SPEC-2-18: bitcount 0 => 32

    if (d.is_jmp) {
      // SPEC-3.1
      const t = d.jmp_cond !== JC_ALWAYS ? ` ${_JMP_CONDS[d.jmp_cond]},` : '';
      return `jmp${t} ${d.jmp_addr}${pf}`;
    }
    if (d.is_wait) {
      // SPEC-3.2
      if (d.wait_src === WSRC_IRQ) {
        const mode = _IDX_MODES[d.wait_index >> 3] || '';
        return `wait ${d.wait_pol} irq ${d.wait_index & 7}${mode ? ` ${mode}` : ''}${pf}`;
      }
      if (d.wait_src === WSRC_JMPPIN) {
        return `wait ${d.wait_pol} jmppin ${d.wait_index & 3}${pf}`;
      }
      const src = d.wait_src === WSRC_GPIO ? 'gpio' : 'pin';
      return `wait ${d.wait_pol} ${src} ${d.wait_index}${pf}`;
    }
    if (d.is_in) {
      // SPEC-3.3
      return `in ${_IN_SRCS[d.in_src]}, ${count(d.word & 31)}${pf}`;
    }
    if (d.is_out) {
      // SPEC-3.4
      return `out ${_OUT_DSTS[d.out_dst]}, ${count(d.word & 31)}${pf}`;
    }
    if (d.is_push || d.is_pull) {
      // SPEC-3.5
      let m = '';
      if (d.is_push && d.push_iff) m += ' iffull';
      if (d.is_pull && d.pull_ife) m += ' ifempty';
      m += (d.is_push ? d.push_blk : d.pull_blk) ? ' block' : ' noblock';
      return (d.is_push ? 'push' : 'pull') + m + pf;
    }
    if (d.is_put || d.is_get) {
      // SPEC-3.7. arg1 must be exactly 000/100 (b7 GET) — anything else
      // is a SPEC-2-12 reserved encoding with no faithful text.
      const a1 = (d.word >> 5) & 7;
      if (a1 !== (d.is_get ? 4 : 0)) {
        throw new ReservedEncoding(`fifo-aux arg1 ${a1} reserved (SPEC-2-12)`);
      }
      const idx = d.aux_idxi ? `[${d.aux_index}]` : '[y]';
      if (d.is_put) return `mov rxfifo${idx}, isr${pf}`;
      return `mov osr, rxfifo${idx}${pf}`;
    }
    if (d.is_mov) {
      // SPEC-3.6
      if ((word & 0xffff) === 0xa042) return `nop${pf}`; // SPEC-3.6-10: nop == mov y, y
      return `mov ${_MOVD_DSTS[d.mov_dst]}, ${_OPS[d.mov_op]}${_MOVS_SRCS[d.mov_src]}${pf}`;
    }
    if (d.is_irq) {
      // SPEC-3.8
      if (d.word & 0x80) {
        // arg1 b7 must be 0 (SPEC-2-16)
        throw new ReservedEncoding('irq b7 set (SPEC-2-16)');
      }
      const m = d.irq_clr ? ' clear' : d.irq_wait ? ' wait' : '';
      const mode = _IDX_MODES[d.irq_idxmode] || '';
      return `irq${m} ${d.irq_index}${mode ? ` ${mode}` : ''}${pf}`;
    }
    // SET (SPEC-3.9)
    return `set ${_SET_DSTS[d.set_dst]}, ${d.set_data}${pf}`;
  }

  const api = {
    // encoding.py
    M32,
    C_JMP,
    C_WAIT,
    C_IN,
    C_OUT,
    C_PP,
    C_MOV,
    C_IRQ,
    C_SET,
    JC_ALWAYS,
    JC_NOTX,
    JC_XDEC,
    JC_NOTY,
    JC_YDEC,
    JC_XNEY,
    JC_PIN,
    JC_NOTOSRE,
    JMP_CONDS,
    WSRC_GPIO,
    WSRC_PIN,
    WSRC_IRQ,
    WSRC_JMPPIN,
    INS_PINS,
    INS_X,
    INS_Y,
    INS_NULL,
    INS_ISR,
    INS_OSR,
    IN_SRCS,
    OUTD_PINS,
    OUTD_X,
    OUTD_Y,
    OUTD_NULL,
    OUTD_PINDIRS,
    OUTD_PC,
    OUTD_ISR,
    OUTD_EXEC,
    OUT_DSTS,
    MOVD_PINS,
    MOVD_X,
    MOVD_Y,
    MOVD_PINDIRS,
    MOVD_EXEC,
    MOVD_PC,
    MOVD_ISR,
    MOVD_OSR,
    MOVS_PINS,
    MOVS_X,
    MOVS_Y,
    MOVS_NULL,
    MOVS_STATUS,
    MOVS_ISR,
    MOVS_OSR,
    MOVD_DSTS,
    MOVS_SRCS,
    MOP_NONE,
    MOP_INV,
    MOP_REV,
    SETD_PINS,
    SETD_X,
    SETD_Y,
    SETD_PINDIRS,
    SET_DSTS,
    IDX_THIS,
    IDX_PREV,
    IDX_REL,
    IDX_NEXT,
    IDX_MODES,
    ReservedEncoding,
    split,
    splitSideset,
    decode,
    packDs,
    encode,
    encodeJmp,
    encodeWait,
    encodeIn,
    encodeOut,
    encodePush,
    encodePull,
    encodePut,
    encodeGet,
    encodeMov,
    encodeIrq,
    encodeSet,
    // asm.py
    AsmError,
    Program,
    createProgram: (name) => new Program(name),
    evalExpr,
    parseText,
    assembleInstruction,
    // disasm.py
    disassemble,
  };
  global.PioAsm = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(this);

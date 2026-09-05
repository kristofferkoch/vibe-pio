// row-complete.test.js — the C32 completion slot-model unit suite
// (web/row-complete.js, extracted from sm-view.js's computeCands).
//
// Oracle-anchored, never self-anchored: the vocabularies must be
// PioAsm's own operand tables, and the separator discipline is checked
// by round-tripping composed rows through assemble/disassemble — the
// canonical spelling, not just an assembler-tolerated one (pio-asm.js is
// itself pinned to pio_model by golden bit-vectors + the 65536-word
// round-trip). The pre-C32 token-index model ships as the
// {defect:'token-index'} hook and every C32 behavior here is asserted to
// DIVERGE from it — the TestMutationsDiverge idiom, so a revert of the
// fix turns these very checks red.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const RC = require('../row-complete.js');
const PioAsm = require('../pio-asm.js');

const ts = (upto, opts) => RC.analyze(upto, opts).cands.map((c) => c.t);
const sepOf = (upto, t, opts) => {
  const c = RC.analyze(upto, opts).cands.find((x) => x.t === t);
  assert.ok(c, `no candidate '${t}' at ${JSON.stringify(upto)}`);
  return c.sep;
};

test('wait offers its polarity first — gpio/pin/irq sit at the source slot after it', () => {
  assert.deepStrictEqual(ts('wait '), ['0', '1']);
  assert.strictEqual(RC.analyze('wait ').slot, 'wait.pol');
  assert.deepStrictEqual(ts('wait 1 '), ['gpio', 'pin', 'irq', 'jmppin']);
  assert.strictEqual(RC.analyze('wait 1 ').slot, 'wait.src');
  // rel/prev/next follow the irq index — and only under the irq source
  assert.deepStrictEqual(ts('wait 1 irq 3 '), ['prev', 'rel', 'next']);
  assert.deepStrictEqual(ts('wait 1 gpio 3 '), []);
  // complete instructions go quiet
  assert.deepStrictEqual(ts('wait 1 gpio 5'), []);
  assert.deepStrictEqual(ts('wait 1 irq 3 rel'), []);
  // pre-C32: gpio/pin/irq stood in the polarity slot
  assert.deepStrictEqual(ts('wait ', { defect: 'token-index' }), ['gpio', 'pin', 'irq']);
  assert.deepStrictEqual(ts('wait 1 irq 3 ', { defect: 'token-index' }), []);
});

test('push/pull keep their flag slots — the menu no longer empties mid-instruction', () => {
  assert.deepStrictEqual(ts('push '), ['iffull', 'block', 'noblock']);
  assert.deepStrictEqual(ts('push iffull '), ['block', 'noblock']);
  assert.strictEqual(RC.analyze('push iffull ').slot, 'push.blk');
  assert.deepStrictEqual(ts('push iffull block'), []);
  assert.deepStrictEqual(ts('pull ifempty '), ['block', 'noblock']);
  assert.deepStrictEqual(ts('pull block '), []); // block/noblock given: canonically done
  // pre-C32: the SECOND table had no push/pull entry — the menu emptied
  assert.deepStrictEqual(ts('push iffull ', { defect: 'token-index' }), []);
  assert.deepStrictEqual(ts('pull ifempty ', { defect: 'token-index' }), []);
});

test("irq's set/wait/clear/rel/prev/next appear at their positions", () => {
  assert.deepStrictEqual(ts('irq '), ['set', 'wait', 'clear']);
  assert.strictEqual(RC.analyze('irq ').slot, 'irq.mode');
  assert.deepStrictEqual(ts('irq wait '), []); // the index slot — typed, not listed
  assert.deepStrictEqual(ts('irq wait 3 '), ['prev', 'rel', 'next']);
  assert.deepStrictEqual(ts('irq 3 '), ['prev', 'rel', 'next']); // no mode given
  assert.deepStrictEqual(ts('irq wait 3 rel'), []);
  // pre-C32: all five keywords (and no `set`) crowded the first slot
  assert.deepStrictEqual(ts('irq ', { defect: 'token-index' }), [
    'wait',
    'clear',
    'rel',
    'prev',
    'next',
  ]);
  assert.deepStrictEqual(ts('irq wait 3 ', { defect: 'token-index' }), []);
});

test('a complete slot offers nothing — the suppression rule', () => {
  // the card's example: 31 offered for a typed 3 was noise, not help
  assert.deepStrictEqual(ts('set x, 3'), []);
  assert.deepStrictEqual(ts('set x, 3', { defect: 'token-index' }), ['31']);
  // the empty slot still lists its quick picks
  assert.deepStrictEqual(ts('set x, '), ['0', '1', '7', '31']);
  assert.deepStrictEqual(ts('in x, '), ['1', '4', '8', '16', '32']);
  // a complete operand is never re-offered for itself
  assert.deepStrictEqual(ts('out pins'), []);
  assert.deepStrictEqual(ts('out pins', { defect: 'token-index' }), ['pins']);
  assert.deepStrictEqual(ts('out pins, 32'), []);
  assert.deepStrictEqual(ts('in x, 32'), []);
  assert.deepStrictEqual(ts('mov x, y'), []);
  assert.deepStrictEqual(ts('mov x, ~y'), []);
  assert.deepStrictEqual(ts('push iffull block'), []);
  assert.deepStrictEqual(ts('wait 1'), []); // the polarity token complete — quiet until the space
  assert.deepStrictEqual(ts('jmp pin'), []); // a complete condition
  assert.deepStrictEqual(ts('jmp 3'), []); // a complete target, typed digit-first
});

test('the separator an accept appends is the canonical spelling', () => {
  assert.strictEqual(sepOf('push ', 'iffull'), ' '); // push iffull block — no comma anywhere
  assert.strictEqual(sepOf('push iffull ', 'block'), '');
  assert.strictEqual(sepOf('pull ', 'ifempty'), ' ');
  assert.strictEqual(sepOf('irq ', 'wait'), ' ');
  assert.strictEqual(sepOf('irq wait 3 ', 'rel'), '');
  assert.strictEqual(sepOf('wait ', '1'), ' ');
  assert.strictEqual(sepOf('wait 1 ', 'gpio'), ' ');
  assert.strictEqual(sepOf('wait 1 irq 3 ', 'rel'), '');
  assert.strictEqual(sepOf('set ', 'x'), ', ');
  assert.strictEqual(sepOf('set x, ', '31'), '');
  assert.strictEqual(sepOf('in ', 'x'), ', ');
  assert.strictEqual(sepOf('out ', 'pins'), ', ');
  assert.strictEqual(sepOf('mov ', 'x'), ', ');
  assert.strictEqual(sepOf('mov x, ', '~'), ''); // ~ and its source are one token
  assert.strictEqual(sepOf('mov x, ', 'y'), '');
  assert.strictEqual(sepOf('jmp ', 'x--'), ', ');
  // pre-C32: the universal ', ' after the first operand
  assert.strictEqual(sepOf('push ', 'iffull', { defect: 'token-index' }), ', ');
  assert.strictEqual(sepOf('irq ', 'wait', { defect: 'token-index' }), ', ');
});

test('composed rows are the canonical text (pio-asm is the anchor)', () => {
  const prog = PioAsm.createProgram('t'); // no side-set: the ds bits are all delay
  const canonical = (text) => {
    const w = PioAsm.assembleInstruction(text, prog, {}, 't');
    return PioAsm.disassemble(w, prog.sideEn, prog.sidesetCount);
  };
  // compose like the editor does: a listed candidate accepts (text +
  // candidate + canonical sep), anything else is typed
  const row = (parts, opts) =>
    parts.reduce((text, part) => {
      const c = RC.analyze(text, opts).cands.find((x) => x.t === part);
      return text + (c ? c.t + c.sep : part);
    }, '');

  const rows = [
    row(['wait ', '1', 'gpio', '5']),
    row(['wait ', '0', 'irq', '4 ', 'rel']),
    row(['push ', 'iffull', 'block']),
    row(['pull ', 'ifempty', 'noblock']),
    row(['push ', 'block']),
    row(['irq ', 'wait', '3 ', 'rel']),
    row(['irq ', 'clear', '2']),
    row(['set ', 'x', '31']),
    row(['in ', 'pins', '32']),
    row(['out ', 'null', '16']),
    row(['mov ', 'x', '~', 'y']),
    row(['mov ', 'pins', '::isr']),
    row(['jmp ', 'x--', '6']),
    row(['jmp ', '7']),
  ];
  for (const text of rows) {
    assert.strictEqual(canonical(text), text, `composed row must be canonical: ${text}`);
  }
  assert.deepStrictEqual(rows, [
    'wait 1 gpio 5',
    'wait 0 irq 4 rel',
    'push iffull block',
    'pull ifempty noblock',
    'push block',
    'irq wait 3 rel',
    'irq clear 2',
    'set x, 31',
    'in pins, 32',
    'out null, 16',
    'mov x, ~y',
    'mov pins, ::isr',
    'jmp x--, 6',
    'jmp 7',
  ]);

  // `irq set` is the one accepted-but-unemitted spelling: it assembles
  // to the same word as the bare form, and the canonical text omits it
  const irqSet = row(['irq ', 'set', '0']);
  assert.strictEqual(irqSet, 'irq set 0');
  assert.strictEqual(
    PioAsm.assembleInstruction(irqSet, prog, {}, 't'),
    PioAsm.assembleInstruction('irq 0', prog, {}, 't'),
  );
  assert.strictEqual(canonical(irqSet), 'irq 0');

  // pre-C32 composition: the universal ', ' after the first operand —
  // assembler-tolerated, non-canonical (the card's push iffull, / irq wait,)
  const badPush = `${row(['push ', 'iffull'], { defect: 'token-index' })}block`;
  assert.strictEqual(badPush, 'push iffull, block');
  assert.strictEqual(canonical(badPush), 'push iffull block');
  const badIrq = `${row(['irq ', 'wait'], { defect: 'token-index' })}3 rel`;
  assert.strictEqual(badIrq, 'irq wait, 3 rel');
  assert.strictEqual(canonical(badIrq), 'irq wait 3 rel');
});

test('the vocabularies are the assembler own operand tables (drift-checked here)', () => {
  assert.deepStrictEqual(
    ts('jmp '),
    Object.keys(PioAsm.JMP_CONDS).filter((k) => k !== 'always'),
  );
  assert.deepStrictEqual(ts('in '), Object.keys(PioAsm.IN_SRCS));
  assert.deepStrictEqual(ts('out '), Object.keys(PioAsm.OUT_DSTS));
  assert.deepStrictEqual(ts('set '), Object.keys(PioAsm.SET_DSTS));
  assert.deepStrictEqual(
    ts('mov '),
    Object.keys(PioAsm.MOVD_DSTS).filter((k) => k !== 'rxfifo'),
  );
  assert.deepStrictEqual(ts('mov x, '), [
    '~',
    '::',
    ...Object.keys(PioAsm.MOVS_SRCS).filter((k) => k !== 'rxfifo'),
  ]);
  assert.deepStrictEqual(
    ts('mov x, ~ '),
    Object.keys(PioAsm.MOVS_SRCS).filter((k) => k !== 'rxfifo'),
  );
  assert.deepStrictEqual(ts('irq 3 '), Object.keys(PioAsm.IDX_MODES).filter(Boolean));
});

test('the slot is an identity, not a token index', () => {
  // push's block flag lives at token 1 or 2 depending on whether iffull
  // was given — the model names it one slot either way
  assert.strictEqual(RC.analyze('push ').slot, 'push.iff');
  assert.strictEqual(RC.analyze('push iffull ').slot, 'push.blk');
  assert.strictEqual(RC.analyze('push block ').slot, 'push.done');
  assert.strictEqual(typeof RC.analyze('push ', { defect: 'token-index' }).slot, 'number');
  assert.notStrictEqual(RC.analyze('wait ').slot, RC.analyze('wait 1 ').slot);
});

test('the mnemonic menu and the caret tokenizer (unchanged surfaces)', () => {
  assert.deepStrictEqual(ts(''), [
    'jmp',
    'wait',
    'in',
    'out',
    'push',
    'pull',
    'mov',
    'irq',
    'set',
    'nop',
  ]);
  assert.deepStrictEqual(ts('w'), ['wait']);
  assert.deepStrictEqual(ts('s'), ['set']);
  assert.deepStrictEqual(ts('jmp '), ['!x', 'x--', '!y', 'y--', 'x != y', 'pin', '!osre']);
  assert.deepStrictEqual(ts('jmp x'), ['x--', 'x != y']); // prefix filter
  assert.deepStrictEqual(ts('zork '), []); // unknown mnemonic
  const ctx = RC.splitCtx('set x, 3');
  assert.deepStrictEqual(ctx, { toks: ['set', 'x'], partial: '3' });
  assert.deepStrictEqual(RC.splitCtx('wait 1 '), { toks: ['wait', '1'], partial: '' });
  // slot-specific notes ride the candidate (the view maps them first)
  assert.match(RC.analyze('wait ').cands[0].note, /low/);
  assert.match(RC.analyze('mov x, ').cands[0].note, /invert/);
});

// C35: the level leash — opts.opcodes scopes the menu to an opcode
// whitelist (the level's `opcodes` field): the mnemonic slot offers
// only the unlocked set, a locked mnemonic's operand slots stay silent,
// and no whitelist leaves the sandbox menu whole.
test('the opcode whitelist scopes the menu — the level leash', () => {
  assert.deepStrictEqual(ts('', { opcodes: ['set'] }), ['set']);
  assert.deepStrictEqual(ts('s', { opcodes: ['set'] }), ['set']);
  assert.deepStrictEqual(ts('mo', { opcodes: ['set'] }), []); // never suggest the locked
  assert.deepStrictEqual(ts('mov x', { opcodes: ['set'] }), []); // operand slots silent too
  assert.deepStrictEqual(ts('', { opcodes: [] }), []); // empty whitelist: no authoring
  // an unlocked mnemonic's own operand slots flow through untouched
  assert.deepStrictEqual(ts('set ', { opcodes: ['set'] }), ts('set '));
  assert.strictEqual(sepOf('set', 'set', { opcodes: ['set'] }), ' ');
  assert.deepStrictEqual(ts(''), [
    'jmp',
    'wait',
    'in',
    'out',
    'push',
    'pull',
    'mov',
    'irq',
    'set',
    'nop',
  ]);
});

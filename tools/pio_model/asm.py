"""Native .pio assembler (C12) — the pico-examples directive subset.

Two-pass: pass 1 collects directives, labels and instruction text;
pass 2 evaluates expressions (defines + label addresses) and encodes
each instruction word per the SPEC-2 tables via encoding.py. Bit-equal
to pioasm 2.3.0 on every program of sim/conf_pioexamples.svh (the
difftest --asm-check gate; pioasm's instruction::encode is the packing
reference). Supported directives: .program .pio_version .origin
.wrap_target .wrap .side_set .define [public] .lang_opt (ignored); %%
code blocks are skipped. Not (yet) supported: .in/.out/.set_count/
.fifo/.mov_status/.clock_div directives — raise AsmError (none of the
conformance programs use them).
"""

import re
from pathlib import Path

from . import encoding as E


class AsmError(Exception):
    """Assembly-time error (bad directive, expression or operand)."""


class Program:
    """One assembled .program: words plus the metadata the harness needs
    (wrap bounds, sideset config, public symbols/labels — mirrors the
    per-program fields of sim/conf_pioexamples.svh)."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.pio_version: int | None = None
        self.origin: int = -1
        self.wrap_target: int | None = None  # index or None (default 0)
        self.wrap: int | None = None  # index or None (default last)
        self.sideset_bits: int | None = None  # .side_set N (None = absent)
        self.sideset_opt: bool = False
        self.sideset_pindirs: bool = False
        self.symbols: dict[str, int] = {}  # .define values
        self.public_symbols: set[str] = set()
        self.labels: dict[str, int] = {}  # label -> instruction index
        self.public_labels: set[str] = set()
        self.src_lines: list[tuple[str, int]] = []  # (text, lineno) pass-2 inputs
        self.words: list[int] = []
        self.disasm: list[str] = []  # canonical text per word

    @property
    def sideset_count(self) -> int:
        """PINCTRL.SIDESET_COUNT value (incl. enable bit, SPEC-7-26)."""
        if self.sideset_bits is None:
            return 0
        return self.sideset_bits + (1 if self.sideset_opt else 0)

    @property
    def side_en(self) -> bool:
        return self.sideset_bits is not None and self.sideset_opt

    @property
    def wrap_bounds(self) -> tuple[int, int]:
        """(wrap, wrap_target) after _finish() resolved the defaults."""
        assert self.wrap is not None
        assert self.wrap_target is not None
        return self.wrap, self.wrap_target


# ---------------------------------------------------------------------------
# Expression evaluator (subset: ints (dec/0x/0b), identifiers, + - * / %
# << >> & | ^ ~ and parens; C truncating division). Labels resolve to
# instruction indices (pioasm: labels are addresses relative to the
# program start — the SDK relocates JMP targets at load time, sdk N1).
# ---------------------------------------------------------------------------

_TOK_RE = re.compile(
    r"\s*(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+|[A-Za-z_.][\w.]*"
    r"|<<|>>|[()+\-*/%&|^~])"
)

_PREC: dict[str, int] = {"|": 1, "^": 2, "&": 3, "<<": 4, ">>": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6}


def _expr_tokens(s: str) -> list[str]:
    toks: list[str] = []
    pos = 0
    while pos < len(s):
        if s[pos].isspace():
            pos += 1
            continue
        m = _TOK_RE.match(s, pos)
        if not m:
            raise AsmError(f"bad expression token at {s[pos:]!r}")
        toks.append(m.group(1))
        pos = m.end()
    return toks


class _ExprParser:
    def __init__(self, toks: list[str], symbols: dict[str, int], where: str) -> None:
        self.t, self.i, self.sym, self.where = toks, 0, symbols, where

    def peek(self) -> str | None:
        return self.t[self.i] if self.i < len(self.t) else None

    def take(self) -> str | None:
        tok = self.peek()
        self.i += 1
        return tok

    def primary(self) -> int:
        tok = self.take()
        if tok is None:
            raise AsmError(f"{self.where}: expression ended early")
        if tok == "(":
            v = self.binary(0)
            if self.take() != ")":
                raise AsmError(f"{self.where}: missing ')'")
            return v
        if tok == "-":
            return -self.primary()
        if tok == "~":
            return ~self.primary()
        if tok == "+":
            return self.primary()
        try:
            return int(tok, 0)
        except ValueError:
            pass
        if tok in self.sym:
            return self.sym[tok]
        raise AsmError(f"{self.where}: unknown symbol {tok!r}")

    def binary(self, min_prec: int) -> int:
        v = self.primary()
        while True:
            op = self.peek()
            if op not in _PREC or _PREC[op] < min_prec:
                return v
            self.take()
            rhs = self.binary(_PREC[op] + 1)
            if op == "+":
                v += rhs
            elif op == "-":
                v -= rhs
            elif op == "*":
                v *= rhs
            elif op == "/":
                if rhs == 0:
                    raise AsmError(f"{self.where}: division by zero")
                v = int(v / rhs)  # C-style truncation
            elif op == "%":
                v = v - rhs * int(v / rhs)
            elif op == "<<":
                v <<= rhs
            elif op == ">>":
                v >>= rhs
            elif op == "&":
                v &= rhs
            elif op == "|":
                v |= rhs
            elif op == "^":
                v ^= rhs


def eval_expr(text: str, symbols: dict[str, int], where: str = "") -> int:
    """Evaluate one .pio expression (defines + labels in `symbols`).

    Division truncates toward zero like C (pioasm), not floor:

    >>> eval_expr("1+2*3", {})
    7
    >>> eval_expr("-7/2", {})
    -3
    >>> eval_expr("(1<<4) | N", {"N": 1})
    17
    """
    return _ExprParser(_expr_tokens(text), symbols, where).binary(0)


# ---------------------------------------------------------------------------
# Pass 1: line scanner.
# ---------------------------------------------------------------------------

_LABEL_RE = re.compile(r"^(public\s+|PUBLIC\s+)?([A-Za-z_][\w]*)\s*:\s*(.*)$")


def parse_file(path: str | Path) -> list[Program]:
    """Parse a .pio file -> list of Program (assembled words included)."""
    with open(path) as f:
        return parse_text(f.read(), str(path))


def parse_text(text: str, name: str = "<text>") -> list[Program]:
    """Parse .pio source text -> list of assembled programs.

    >>> p = parse_text(".program t\\nloop: set pins, 1 [3]\\njmp loop\\n")[0]
    >>> [hex(w) for w in p.words]
    ['0xe301', '0x0']
    >>> (p.wrap, p.wrap_target, p.labels["loop"])
    (1, 0, 0)
    """
    programs: list[Program] = []
    prog: Program | None = None
    in_block = False
    pending_version: int | None = None  # .pio_version may lead .program
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = _strip_comment(raw)
        if in_block:
            if line.strip() == "%}":
                in_block = False
            continue
        s = line.strip()
        if not s:
            continue
        if s.startswith("%"):  # % c-sdk { ... %} etc.
            if s != "%}" and not s.endswith("%}"):
                in_block = True
            continue
        if s.startswith("."):
            toks = s.split()
            if toks[0].lower() == ".program":
                prog = Program(toks[1])
                if pending_version is not None:
                    prog.pio_version, pending_version = pending_version, None
                programs.append(prog)
                continue
            if toks[0].lower() == ".lang_opt":
                continue  # host-language metadata only
            if toks[0].lower() == ".pio_version" and prog is None:
                pending_version = int(s.split(None, 1)[1])
                continue
            prog = _directive(s, prog, programs, name, lineno)
            continue
        if prog is None:
            raise AsmError(f"{name}:{lineno}: instruction outside .program")
        while s:
            m = _LABEL_RE.match(s)
            if m:
                if m.group(1):
                    prog.public_labels.add(m.group(2))
                if m.group(2) in prog.labels:
                    raise AsmError(f"{name}:{lineno}: duplicate label {m.group(2)}")
                prog.labels[m.group(2)] = len(prog.src_lines)
                s = m.group(3).strip()
                continue
            break
        if s:
            prog.src_lines.append((s, lineno))
    for p in programs:
        _finish(p)
    return programs


def _strip_comment(line: str) -> str:
    out: list[str] = []
    i, n = 0, len(line)
    while i < n:
        two = line[i : i + 2]
        if two == "//" or line[i] == ";":
            break
        if two == "/*":  # block comment (rare)
            j = line.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        out.append(line[i])
        i += 1
    return "".join(out)


def _directive(s: str, prog: Program | None, programs: list[Program], name: str, lineno: int) -> Program:
    toks = s.split()
    d = toks[0].lower()
    arg = s[len(toks[0]) :].strip()
    if d == ".program":
        prog = Program(toks[1])
        programs.append(prog)
        return prog
    if prog is None:
        raise AsmError(f"{name}:{lineno}: {d} before .program")
    if d == ".pio_version":
        prog.pio_version = int(arg)
    elif d == ".origin":
        prog.origin = eval_expr(arg, {}, f"{name}:{lineno}")
    elif d == ".wrap_target":
        prog.wrap_target = len(prog.src_lines)  # next instruction's index
    elif d == ".wrap":
        prog.wrap = len(prog.src_lines) - 1  # preceding instruction
    elif d == ".side_set":
        parts = arg.split()
        prog.sideset_bits = eval_expr(parts[0], {}, f"{name}:{lineno}")
        for opt in parts[1:]:
            if opt == "opt":
                prog.sideset_opt = True  # SPEC-4-2 enable bit
            elif opt == "pindirs":
                prog.sideset_pindirs = True  # SPEC-4-4
            else:
                raise AsmError(f"{name}:{lineno}: .side_set {opt!r}")
    elif d == ".define":
        parts = arg.split(None, 1)
        pub = False
        if parts and parts[0].lower() == "public":
            pub = True
            parts = arg.split(None, 2)[1:]
        if len(parts) != 2:
            raise AsmError(f"{name}:{lineno}: .define NAME EXPR")
        prog.symbols[parts[0]] = eval_expr(parts[1], prog.symbols, f"{name}:{lineno}")
        if pub:
            prog.public_symbols.add(parts[0])
    elif d == ".lang_opt":
        pass  # host-language metadata only
    elif d in (".in", ".out", ".set_count", ".fifo", ".mov_status", ".clock_div"):
        raise AsmError(
            f"{name}:{lineno}: {d} not supported by the native assembler (unused by the conformance programs)"
        )
    else:
        raise AsmError(f"{name}:{lineno}: unknown directive {d}")
    return prog


def _finish(prog: Program) -> None:
    if prog.sideset_bits is not None and prog.sideset_bits > 5:
        raise AsmError(f"{prog.name}: side_set bits > 5")
    if not prog.src_lines:
        if prog.wrap is None:
            prog.wrap, prog.wrap_target = 0, 0
        return
    prog.wrap = len(prog.src_lines) - 1 if prog.wrap is None else prog.wrap
    prog.wrap_target = 0 if prog.wrap_target is None else prog.wrap_target
    symbols = dict(prog.symbols)
    symbols.update(prog.labels)
    prog.words = [assemble_instruction(t, prog, symbols, f"{prog.name}:{ln}") for t, ln in prog.src_lines]


# ---------------------------------------------------------------------------
# Pass 2: one instruction line -> word.
# ---------------------------------------------------------------------------

_SIDE_RE = re.compile(r"\bside\s+(\S+)")
_DELAY_RE = re.compile(r"\s\[\s*([^\]]+)\]\s*$")  # space-gated: rxfifo[i] is
# an operand subscript, not a delay postfix


def assemble_instruction(text: str, prog: Program, symbols: dict[str, int], where: str) -> int:
    line = text
    delay, side_val, side_present = 0, 0, False
    while True:  # [delay] / side val in any order
        m = _DELAY_RE.search(line)
        if m:
            delay = eval_expr(m.group(1), symbols, where)
            line = line[: m.start()].strip()
            continue
        m = _SIDE_RE.search(line)
        if m:
            side_val = eval_expr(m.group(1), symbols, where)
            side_present = True
            line = (line[: m.start()] + line[m.end() :]).strip()
            continue
        break
    ds = E.pack_ds(delay, side_val, prog.side_en, prog.sideset_count, side_present)
    toks = line.replace(",", " , ").split()
    mn = toks[0].lower()
    rest = line[len(toks[0]) :].strip()

    try:
        word = _encode_core(mn, rest, symbols, where)
    except KeyError as ex:
        raise AsmError(f"{where}: unknown {mn} operand {ex}") from None
    return (word | (ds << 8)) & 0xFFFF


def _opnd(rest: str, symbols: dict[str, int], where: str) -> int:
    """Evaluate one operand expression (strip trailing/leading commas)."""
    return eval_expr(rest.strip().rstrip(",").strip(), symbols, where)


def _encode_core(mn: str, rest: str, symbols: dict[str, int], where: str) -> int:
    if mn == "nop":  # SPEC-3.6-10
        if rest:
            raise AsmError(f"{where}: nop takes no operands")
        return E.encode_mov("y", "y", E.MOP_NONE, 0)
    if mn == "jmp":  # SPEC-3.1
        cond, target = None, rest
        for c in ("x != y", "!x", "x--", "!y", "y--", "pin", "!osre"):
            if rest.lower().startswith(c) and len(rest) > len(c):
                cond, target = c, rest[len(c) :].strip().lstrip(",").strip()
                break
        return E.encode_jmp(cond, _opnd(target, symbols, where), 0)
    if mn == "wait":  # SPEC-3.2
        parts = rest.split()
        pol = 1 if parts[0] == "1" else 0
        src = parts[1].strip(",").lower()
        idx = 0
        mode = None
        for t in parts[2:]:
            tl = t.strip(",")
            if tl in ("rel", "prev", "next"):
                mode = tl
            else:
                idx = eval_expr(tl, symbols, where)
        srcmap = {"gpio": E.WSRC_GPIO, "pin": E.WSRC_PIN, "irq": E.WSRC_IRQ, "jmppin": E.WSRC_JMPPIN}
        return E.encode_wait(pol, srcmap[src], ((E.IDX_MODES[mode] << 3) | idx) if src == "irq" else idx, 0)
    if mn == "in":  # SPEC-3.3
        src, cnt = _split2(rest, where)
        return E.encode_in(src.lower(), _opnd(cnt, symbols, where), 0)
    if mn == "out":  # SPEC-3.4
        dst, cnt = _split2(rest, where)
        return E.encode_out(dst.lower(), _opnd(cnt, symbols, where), 0)
    if mn in ("push", "pull"):  # SPEC-3.5
        iff = "iffull" in rest or "ifempty" in rest
        blk = not re.search(r"\bnoblock\b", rest)
        return E.encode_push(iff, blk, 0) if mn == "push" else E.encode_pull(iff, blk, 0)
    if mn == "mov":  # SPEC-3.6 / SPEC-3.7
        dst, src = _split2(rest, where)
        m = re.match(r"rxfifo\s*\[([^\]]*)\]", dst, re.IGNORECASE)
        if m:
            idx = m.group(1).strip()
            idxv = None if idx == "" or idx.lower() == "y" else eval_expr(idx, symbols, where)
            return E.encode_put(idxv, 0)
        m = re.match(r"rxfifo\s*\[([^\]]*)\]", src, re.IGNORECASE)
        if m:
            idx = m.group(1).strip()
            idxv = None if idx == "" or idx.lower() == "y" else eval_expr(idx, symbols, where)
            return E.encode_get(idxv, 0)
        op = E.MOP_NONE
        if src[:1] in ("~", "!"):  # pioasm: ~ and ! both invert
            op, src = E.MOP_INV, src[1:]
        elif src.startswith("::"):
            op, src = E.MOP_REV, src[2:]
        return E.encode_mov(dst.lower(), src.lower().strip(), op, 0)
    if mn == "irq":  # SPEC-3.8
        clr = wait = False
        mode = None
        idx = None
        for t in rest.split():
            tl = t.strip(",")
            if tl == "clear":
                clr = True
            elif tl == "wait":
                wait = True
            elif tl in ("nowait", "set"):
                pass
            elif tl in ("rel", "prev", "next"):
                mode = tl
            elif idx is None:
                idx = eval_expr(tl, symbols, where)
        if idx is None:
            raise AsmError(f"{where}: irq needs an index")
        return E.encode_irq(clr, wait, E.IDX_MODES[mode], idx, 0)
    if mn == "set":  # SPEC-3.9
        dst, data = _split2(rest, where)
        return E.encode_set(dst.lower(), _opnd(data, symbols, where), 0)
    raise AsmError(f"{where}: unknown mnemonic {mn!r}")


def _split2(rest: str, where: str) -> tuple[str, str]:
    if "," not in rest:
        raise AsmError(f"{where}: expected 'mnemonic a, b' got {rest!r}")
    a, b = rest.split(",", 1)
    return a.strip(), b.strip()

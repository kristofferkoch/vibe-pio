#!/usr/bin/env python3
"""Traceability audit: cross-check SPEC-/CC- citations against the fact and
clause indexes (KANBAN: "Traceability audit script").

What it does
------------
1. Parses the fact index `docs/pio-spec.md` (inline tags `[SPEC-x.y-n]`) and
   the clause index `docs/cycle-contract.md` (§11 table rows `| CC-n |`,
   cross-checked against the body clause headers `**CC-n [...]`).
2. Scans `rtl/*.sv`, `formal/*.sv`, `formal/*.sby` for citations (and
   `sim/*.sv`, `sim/*.svh` as evidence-only context: sim citations are
   reported but do not verify — assertions and verification are scoped
   to rtl/ + formal/ per the card), expands the citation grammar
   (below), and classifies every defined fact/clause:
     - verified   : cited by at least one `assert` statement in a .sv file
     - referenced : cited only outside assertions (RTL comments, assumes,
                    covers, .sby config comments)
     - uncited    : never cited anywhere scanned
3. Reports hard defects and traceability gaps.

Citation grammar (all forms present in rtl/ + formal/ as of this script)
------------------------------------------------------------------------
- plain            SPEC-7-26, CC-11
- slash lists      suffix form SPEC-7-3/4, SPEC-7-2/9/29; full form
                   SPEC-5-1/5-5, CC-11/CC-12; mixed families
                   CC-6/CC-7/SPEC-10-2; bare sections SPEC-2/SPEC-4
- ranges           SPEC-2-1..18, CC-25..27, CC-14..CC-16; a range cites
                   every *defined* ID whose number falls inside it (the
                   numbering has gaps), and both endpoints must be defined
- section-wide     SPEC-8 (bare) and SPEC-8-x — cites every defined fact
                   of that section; attributed, but flagged "section-wide
                   only" in the report (weaker traceability)
- English suffix   CC-36-shaped / CC-36-defers cite CC-36; trailing
                   punctuation (. , ; : )) is stripped
An `(SPEC|CC)-` token the grammar cannot resolve is a PARSE defect, so new
citation styles cannot silently dodge the audit.

Assertion attribution policy
----------------------------
All assertions are immediate (`label : assert (expr);` inside always
blocks — owner convention). An assert is *sourced* when a citation is
attached to it directly or via the file's property registry:

- direct: a trailing comment on the statement's lines, a comment inside
  the statement, or the contiguous full-line comment block above it —
  crossing up to two structural guard lines (`if (...)`, `begin`, `end`,
  `always`) that carry no statement keyword;
- registry: header comment lines like `//   P4  CC-10: ...` define named
  properties (short identifier + two spaces + prose, extended over
  more-indented continuation lines; "P1..P4" range names expand to the
  individual keys). Entries in the leading header block inherit that
  block's preamble citations (the provenance prose before the first
  entry). An assert links to a registry entry through its label parts
  (`a_p4_ge` -> p4, `a_p5b` -> p5) or a property name mentioned in its
  attached comments (`// P1: reset default.` -> P1).

The linkage is a heuristic — asserts it misses are listed for review,
never silently dropped. Only `assert` verifies a fact; `assume`, `cover`
and `restrict` cite but do not verify.

Exit codes: 1 on hard defects (DUP-ID, INDEX-MISMATCH, DANGLING, PARSE);
with --strict, unsourced assertions also fail. Otherwise 0 (gaps are the
report). --self-test runs hermetic fixtures, no repo files needed.
"""

import argparse
import bisect
import glob
import re
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Citation grammar
# ---------------------------------------------------------------------------

RUN_RE = re.compile(r'(?:SPEC|CC)-[0-9][0-9A-Za-z./-]*')

SPEC_FULL = re.compile(r'^SPEC-(\d+(?:\.\d+)?)-(\d+)$')
SPEC_RANGE = re.compile(r'^SPEC-(\d+(?:\.\d+)?)-(\d+)\.\.(\d+)$')
SPEC_BARE = re.compile(r'^SPEC-(\d+(?:\.\d+)?)$')
SPEC_SEC_RANGE = re.compile(r'^SPEC-(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)$')
CC_FULL = re.compile(r'^CC-(\d+)$')
CC_RANGE = re.compile(r'^CC-(\d+)\.\.(?:CC-)?(\d+)$')
NUM_TAIL = re.compile(r'^\d+$')                  # suffix-share number
SPEC_TAIL = re.compile(r'^\d+(?:\.\d+)?-\d+$')   # full SPEC id tail
WORD_SUFFIX = re.compile(r'(.+?)((?:-[a-z]+)+)$')
VALID_BASE = re.compile(r'^(?:SPEC|CC)-[0-9][0-9A-Za-z./-]*$')

PROP_LINE = re.compile(r'^\s*//(\s+)([A-Za-z]\w{0,3}(?:\.\.[A-Za-z]\d+)?)\s{2,}(\S.*)$')
PROP_RANGE = re.compile(r'^([A-Za-z])(\d+)\.\.([A-Za-z])?(\d+)$')
FULL_COMMENT = re.compile(r'^\s*//')
STMT_KW = re.compile(r'\b(assert|assume|cover|restrict)\b')
LABEL_BEFORE = re.compile(r'([A-Za-z_]\w*)\s*:\s*$')
# Guard/wrapper lines an assert's doc comment may sit above (code lines
# only, and only if they carry no statement keyword).
STRUCTURAL = re.compile(
    r'^\s*(?:if\s*\(.*\)(?:\s*begin)?|begin\b|end\b|end\s+else\s+begin'
    r'|else\b|always\s*@.*|case\s*\(.*\)|endcase)\s*;?\s*$')


class Defect(Exception):
    pass


class Range:
    """`lo..hi` expansion; endpoints must be defined, inner gaps allowed."""

    def __init__(self, lo, hi, ids):
        self.lo, self.hi, self.ids = lo, hi, ids


class SecRange:
    """Section range SPEC-3.1..3.9: every defined fact of sections 3.1
    through 3.9 (inclusive, dotted-section numeric order)."""

    def __init__(self, lo, hi):
        self.lo, self.hi = lo, hi


def sec_tuple(sec):
    parts = [int(x) for x in sec.split('.')]
    return (parts[0], parts[1] if len(parts) > 1 else 0)


def _strip_suffix(el):
    """CC-36-shaped -> CC-36, SPEC-8-x -> SPEC-8 (the latter then matches
    the bare-section form, which carries the section-wide flag)."""
    m = WORD_SUFFIX.fullmatch(el)
    if m and not re.search(r'\d', m.group(2)) and \
            VALID_BASE.fullmatch(m.group(1)):
        return m.group(1)
    return el


def expand_run(run):
    """Expand one citation run into a list of (id, section_wide) and Ranges.

    Raises Defect on grammar violations (reported as PARSE defects).
    """
    tok = run.rstrip('.,;:)]')
    if not tok:
        return []
    out = []
    ctx = None  # (family, section) inherited by bare-number tails
    for el in tok.split('/'):
        if el == '':
            continue  # trailing slash before prose ("SPEC-2/§3")
        el = _strip_suffix(el)
        if (m := SPEC_RANGE.fullmatch(el)):
            sec, lo, hi = m.group(1), int(m.group(2)), int(m.group(3))
            out.append(Range(f'SPEC-{sec}-{lo}', f'SPEC-{sec}-{hi}',
                             [(f'SPEC-{sec}-{n}', False)
                              for n in range(lo, hi + 1)]))
        elif (m := CC_RANGE.fullmatch(el)):
            lo, hi = int(m.group(1)), int(m.group(2))
            out.append(Range(f'CC-{lo}', f'CC-{hi}',
                             [(f'CC-{n}', False) for n in range(lo, hi + 1)]))
        elif (m := SPEC_FULL.fullmatch(el)):
            out.append((f'SPEC-{m.group(1)}-{m.group(2)}', False))
            ctx = ('SPEC', m.group(1))
        elif (m := CC_FULL.fullmatch(el)):
            out.append((f'CC-{m.group(1)}', False))
            ctx = ('CC', None)
        elif (m := SPEC_BARE.fullmatch(el)):
            out.append((f'SPEC-{m.group(1)}', True))
            ctx = ('SPEC', m.group(1))
        elif (m := SPEC_SEC_RANGE.fullmatch(el)):
            out.append(SecRange(m.group(1), m.group(2)))
        elif NUM_TAIL.fullmatch(el) and ctx == ('CC', None):
            out.append((f'CC-{el}', False))
        elif NUM_TAIL.fullmatch(el) and ctx and ctx[0] == 'SPEC':
            out.append((f'SPEC-{ctx[1]}-{el}', False))
        elif SPEC_TAIL.fullmatch(el):
            out.append((f'SPEC-{el}', False))
            ctx = ('SPEC', el.split('-')[0])
        else:
            raise Defect(f'unparseable citation element {el!r} in {run!r}')
    return out


# ---------------------------------------------------------------------------
# Source scanning (comments vs code, statements, attached citations)
# ---------------------------------------------------------------------------

class SourceFile:
    def __init__(self, path):
        self.path = Path(path)
        self.rel = (str(self.path.relative_to(REPO))
                    if self.path.is_relative_to(REPO) else str(self.path))
        self.text = self.path.read_text()
        self.code, self.comment_spans = self._mask()
        self.line_starts = [0]
        for i, ch in enumerate(self.text):
            if ch == '\n':
                self.line_starts.append(i + 1)
        self.lines = self.text.split('\n')
        self.registry = self._build_registry()

    def line_of(self, pos):
        return bisect.bisect_right(self.line_starts, pos)

    def line_bounds(self, idx):  # idx is 1-based
        start = self.line_starts[idx - 1]
        end = self.line_starts[idx] - 1 if idx < len(self.line_starts) \
            else len(self.text)
        return start, end

    def _mask(self):
        """Code text (comments blanked, same length) + comment spans."""
        code = list(self.text)
        spans = []
        i, n = 0, len(self.text)
        while i < n:
            ch = self.text[i]
            if ch == '/' and i + 1 < n and self.text[i + 1] == '/':
                j = self.text.find('\n', i)
                j = n if j < 0 else j
                spans.append((i, j))
                for k in range(i, j):
                    code[k] = ' '
                i = j
            elif ch == '/' and i + 1 < n and self.text[i + 1] == '*':
                j = self.text.find('*/', i + 2)
                j = n if j < 0 else j + 2
                spans.append((i, j))
                for k in range(i, j):
                    if self.text[k] != '\n':
                        code[k] = ' '
                i = j
            elif ch == '"':
                j = i + 1
                while j < n and self.text[j] != '"':
                    j += 2 if self.text[j] == '\\' else 1
                i = j + 1
            else:
                i += 1
        return ''.join(code), spans

    def in_comment(self, pos):
        return any(s <= pos < e for s, e in self.comment_spans)

    def _build_registry(self):
        """Named-property registry from full-line comments (see docstring).

        Property tokens may be ranges ("P1..P4" -> P1..P4 keys). Entries
        declared inside the leading header comment block inherit the
        citations of that block's preamble (the prose before the first
        entry), which scopes the file-level provenance to every listed
        property.
        """
        registry = {}
        preamble = []
        in_head = True
        seen_entry = False
        entry, entry_keys, entry_indent = None, [], None
        for line in self.lines:
            if not FULL_COMMENT.match(line):
                in_head = False
                entry = None
                continue
            m = PROP_LINE.match(line)
            if m and re.search(r'\d', m.group(2)):
                entry_keys = self._expand_prop_names(m.group(2))
                runs = RUN_RE.findall(line)
                if in_head:
                    runs = runs + preamble
                for key in entry_keys:
                    registry.setdefault(key, []).extend(runs)
                entry, entry_indent = m.group(2), len(m.group(1))
                seen_entry = True
                continue
            if entry is not None:
                after = line.split('//', 1)[1]
                ind = len(after) - len(after.lstrip(' '))
                first = after.strip().split(' ')[0] if after.strip() else ''
                if ind > entry_indent and not re.fullmatch(
                        r'[A-Za-z]\w{0,3}\d\w{0,2}', first):
                    for key in entry_keys:
                        registry[key].extend(RUN_RE.findall(line))
                    continue
            elif in_head and not seen_entry:
                preamble.extend(RUN_RE.findall(line))
                continue
            entry = None
        return registry

    @staticmethod
    def _expand_prop_names(token):
        m = PROP_RANGE.fullmatch(token)
        if m and (m.group(3) is None or m.group(3) == m.group(1)):
            lo, hi = int(m.group(2)), int(m.group(4))
            return [f'{m.group(1)}{n}' for n in range(lo, hi + 1)]
        return [token]



def parse_statements(sf):
    """Statements with their owned regions (comment spans + above-block)."""
    stmts = []
    for m in STMT_KW.finditer(sf.code):
        semi = sf.code.find(';', m.end())
        if semi < 0:
            semi = len(sf.code) - 1
        pre = sf.code[max(0, m.start() - 48):m.start()]
        lm = LABEL_BEFORE.search(pre)
        label = lm.group(1) if lm else ''
        line = sf.line_of(m.start())

        owned = [(s, e) for s, e in sf.comment_spans if m.start() <= s <= semi]
        eol = sf.code.find('\n', semi)
        eol = len(sf.code) if eol < 0 else eol
        for s, e in sf.comment_spans:
            if semi < s < eol and not sf.code[semi + 1:s].strip():
                owned.append((s, e))
        # Full-line comment block above the statement. Doc comments often
        # sit above the if/begin guards wrapping the assert, so cross up
        # to two structural guard lines (code lines with no statement
        # keyword) between comment lines.
        code_lines = sf.code.split('\n')
        i = line - 2  # 0-based index of the line above
        structural_left = 2
        while i >= 0:
            if FULL_COMMENT.match(sf.lines[i]):
                owned.append(sf.line_bounds(i + 1))
                i -= 1
                continue
            if (structural_left and not STMT_KW.search(code_lines[i])
                    and STRUCTURAL.fullmatch(code_lines[i])):
                structural_left -= 1
                i -= 1
                continue
            break
        stmts.append({'kind': m.group(1), 'label': label, 'line': line,
                      'owned': owned})
    return stmts


def registry_runs(sf, stmt):
    """Registry citation runs linked to this statement.

    A label part or attached-comment name links to registry key K when
    they are equal, or when the part extends K with a non-digit suffix
    ("p5a" -> "p5") — a digit suffix ("p12" vs "p1") does not link.
    """
    names = set(stmt['label'].lower().split('_'))
    for tok in re.findall(r'[A-Za-z]\w{0,3}', ' '.join(
            sf.text[s:e] for s, e in stmt['owned'])):
        names.add(tok.lower())
    out = []
    for key in sf.registry:
        k = key.lower()
        for part in names:
            if k == part or (len(k) >= 2 and any(c.isdigit() for c in k)
                             and part.startswith(k)
                             and not part[len(k)].isdigit()):
                out.extend(sf.registry[key])
                break
    return out


# ---------------------------------------------------------------------------
# Audit driver
# ---------------------------------------------------------------------------

def id_key(cid):
    if cid.startswith('CC-'):
        return (1, 0, 0, int(cid[3:]))
    m = re.fullmatch(r'SPEC-(\d+)\.(\d+)-(\d+)', cid)
    if m:
        return (0, int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.fullmatch(r'SPEC-(\d+)-(\d+)', cid)
    if m:
        return (0, int(m.group(1)), 0, int(m.group(2)))
    return (0, 0, 0, 0)


class Audit:
    def __init__(self, spec_path, cc_path, source_patterns):
        self.defects = []
        self.fact_lines = {}
        self.clause_lines = {}
        self.cc_body = {}
        self._parse_indexes(spec_path, cc_path)

        paths = []
        for pat in source_patterns:
            paths.extend(sorted(glob.glob(str(pat))))
        self.sources = [SourceFile(p) for p in paths]

        self.occurrences = {}   # id -> [(rel, line, kind, wide)] positional
        self.assert_ev = {}     # id -> [(rel, line, label, wide)] all wins
        self.assert_total = 0
        self.assert_unsourced = []
        self._scan_sources()

    # -- indexes ------------------------------------------------------------

    def _parse_indexes(self, spec_path, cc_path):
        for i, line in enumerate(Path(spec_path).read_text().split('\n'), 1):
            for m in re.finditer(r'\[SPEC-[0-9.]+-[0-9]+\]', line):
                fid = m.group(0)[1:-1]
                if fid in self.fact_lines:
                    self.defects.append(
                        f'DUP-ID: {fid} defined at both '
                        f'{self.fact_lines[fid]} and {i} of {spec_path}')
                else:
                    self.fact_lines[fid] = i
        for i, line in enumerate(Path(cc_path).read_text().split('\n'), 1):
            if (m := re.match(r'\|\s*(CC-\d+)\s*\|', line)):
                self.clause_lines.setdefault(m.group(1), i)
            if (m := re.match(r'\*\*(CC-\d+)\s*\[', line)):
                self.cc_body.setdefault(m.group(1), i)
        for cid in sorted(set(self.cc_body) - set(self.clause_lines),
                          key=id_key):
            self.defects.append(
                f'INDEX-MISMATCH: {cid} in cycle-contract body '
                f'(line {self.cc_body[cid]}) but not in the clause index')
        for cid in sorted(set(self.clause_lines) - set(self.cc_body),
                          key=id_key):
            self.defects.append(
                f'INDEX-MISMATCH: {cid} in cycle-contract index '
                f'(line {self.clause_lines[cid]}) but not in the body')

    # -- sources ------------------------------------------------------------

    def _defined(self, cid):
        return cid in self.fact_lines or cid in self.clause_lines

    def _expand(self, run, rel, line):
        """Expand one run; record defects; return [(id, wide)]."""
        try:
            parts = expand_run(run)
        except Defect as d:
            self.defects.append(f'PARSE: {d} at {rel}:{line}')
            return []
        ids = []
        for part in parts:
            if isinstance(part, Range):
                if not self._defined(part.lo) or not self._defined(part.hi):
                    self.defects.append(
                        f'DANGLING: range {part.lo}..{part.hi} endpoint '
                        f'not defined at {rel}:{line}')
                    continue
                ids.extend((cid, wide) for cid, wide in part.ids
                           if self._defined(cid))
            elif isinstance(part, SecRange):
                lo, hi = sec_tuple(part.lo), sec_tuple(part.hi)
                members = [f for f in self.fact_lines
                           if lo <= sec_tuple(
                               f[5:].rsplit('-', 1)[0]) <= hi]
                if members:
                    ids.extend((f, True) for f in members)
                else:
                    self.defects.append(
                        f'DANGLING: section range SPEC-{part.lo}..{part.hi} '
                        f'has no defined facts at {rel}:{line}')
            else:
                cid, wide = part
                if wide and not self._defined(cid):
                    # Bare section (SPEC-8 / SPEC-8-x): resolve to every
                    # defined fact of that section.
                    members = [f for f in self.fact_lines
                               if f.startswith(cid + '-')]
                    if members:
                        ids.extend((f, True) for f in members)
                        continue
                if not self._defined(cid):
                    self.defects.append(
                        f'DANGLING: {cid} cited at {rel}:{line} is not in '
                        f'the index')
                else:
                    ids.append((cid, wide))
        return ids

    def _scan_sources(self):
        for sf in self.sources:
            base = ('sby' if sf.rel.endswith('.sby') else
                    'rtl' if sf.rel.startswith('rtl/') else
                    'sim' if sf.rel.startswith('sim/') else 'fv')
            stmts = ([] if sf.rel.endswith(('.sby', '.svh'))
                     or sf.rel.startswith('sim/')
                     else parse_statements(sf))
            owners = []  # (start, end, kind, label, line) per owned region
            for st in stmts:
                for s, e in st['owned']:
                    owners.append((s, e, st['kind'], st['label'], st['line']))

            for m in RUN_RE.finditer(sf.text):
                pos = m.start()
                kind = base + ('-comment' if sf.in_comment(pos)
                               else '-code')
                owner = next((o for o in owners if o[0] <= pos < o[1]), None)
                if owner:
                    kind = owner[2]
                for cid, wide in self._expand(m.group(0), sf.rel,
                                              sf.line_of(pos)):
                    self.occurrences.setdefault(cid, []).append(
                        (sf.rel, sf.line_of(pos), kind, wide))

            for st in stmts:
                if st['kind'] != 'assert':
                    continue
                self.assert_total += 1
                runs = [RUN_RE.findall(sf.text[s:e])
                        for s, e in st['owned']]
                runs = [r for chunk in runs for r in chunk]
                runs.extend(registry_runs(sf, st))
                ids = [(cid, wide) for r in runs
                       for cid, wide in self._expand(
                           r, sf.rel, st['line'])]
                if not ids:
                    self.assert_unsourced.append(
                        (sf.rel, st['line'], st['label']))
                else:
                    for cid, wide in ids:
                        self.assert_ev.setdefault(cid, []).append(
                            (sf.rel, st['line'], st['label'], wide))

    # -- classification / report --------------------------------------------

    def classified(self):
        verified, referenced, uncited = [], [], []
        for cid in list(self.fact_lines) + list(self.clause_lines):
            if cid in self.assert_ev:
                verified.append(cid)
            elif cid in self.occurrences:
                referenced.append(cid)
            else:
                uncited.append(cid)
        return (sorted(verified, key=id_key), sorted(referenced, key=id_key),
                sorted(uncited, key=id_key))

    def section_wide_only(self):
        """Verified ids whose every assert attribution is section-wide."""
        return sorted((cid for cid, evs in self.assert_ev.items()
                       if all(e[3] for e in evs)), key=id_key)

    def report(self):
        verified, referenced, uncited = self.classified()
        n_total = len(self.fact_lines) + len(self.clause_lines)
        idx_ok = not any(d.startswith('INDEX-MISMATCH') for d in self.defects)
        n_occ = sum(len(v) for v in self.occurrences.values())
        out = ['== vibe-pio traceability audit ==',
               f'fact index   : {len(self.fact_lines)} facts '
               f'from docs/pio-spec.md',
               f'clause index : {len(self.clause_lines)} clauses from '
               f'docs/cycle-contract.md §11 (body vs index: '
               f'{"ok" if idx_ok else "MISMATCH"})',
               f'sources      : '
               f'{sum(1 for s in self.sources if s.rel.startswith("rtl/"))} '
               f'rtl, '
               f'{sum(1 for s in self.sources if s.rel.startswith("formal/")
                      and s.rel.endswith(".sv"))} formal sv, '
               f'{sum(1 for s in self.sources if s.rel.endswith(".sby"))} '
               f'sby, '
               f'{sum(1 for s in self.sources if s.rel.startswith("sim/"))} '
               f'sim (evidence only)',
               f'assertions   : {self.assert_total} '
               f'({self.assert_total - len(self.assert_unsourced)} sourced, '
               f'{len(self.assert_unsourced)} unsourced)',
               f'citations    : {n_occ} occurrences, '
               f'{len(self.occurrences)} distinct IDs cited',
               '',
               '-- hard defects --']
        out.extend(self.defects if self.defects else ['(none)'])
        out.append('')
        out.append('-- asserts with no direct or registry-linked citation '
                   '(review) --')
        if self.assert_unsourced:
            out.extend(f'  {rel}:{line}  {label or "(unlabeled)"}'
                       for rel, line, label in self.assert_unsourced)
        else:
            out.append('  (none)')
        out.append('')
        out.append(f'-- verified by >=1 assertion: {len(verified)} of '
                   f'{n_total} '
                   f'({len(self.section_wide_only())} section-wide only) --')
        out.append('')
        sim_only = sum(
            1 for cid in referenced
            if all(o[2].startswith('sim') for o in self.occurrences[cid]))
        out.append(f'-- referenced but never asserted ({len(referenced)}; '
                   f'{sim_only} cited only in sim/) --')
        for cid in referenced:
            rel, line, kind, _ = self.occurrences[cid][0]
            out.append(f'  {cid:<14} {kind:<13} {rel}:{line}')
        out.append('')
        out.append(f'-- never cited in rtl/, formal/ or sim/ '
                   f'({len(uncited)}) --')
        out.extend('  ' + cid for cid in uncited)
        return '\n'.join(out)


# ---------------------------------------------------------------------------
# Self-test (hermetic fixtures, incl. red/green mutation checks)
# ---------------------------------------------------------------------------

def self_test():
    tmp = Path(tempfile.mkdtemp(prefix='trace_audit_selftest_'))
    try:
        (tmp / 'spec.md').write_text(
            '# spec\n## 2\n'
            '- [SPEC-2-1] fact one.\n'
            '- [SPEC-2-2] fact two.\n'
            '- [SPEC-2-5] fact five (3,4 absent: range gap).\n'
            '## 5\n'
            '- [SPEC-5-1] one.\n- [SPEC-5-5] five.\n- [SPEC-5-6] six.\n'
            '## 8\n- [SPEC-8-1] one.\n- [SPEC-8-2] two.\n'
            '## 10\n- [SPEC-10-2] two.\n'
            '## 14.8\n- [SPEC-14.8-1] deep.\n'
            '## 16\n- [SPEC-16-1] outside.\n')
        (tmp / 'cc.md').write_text(
            '# cc\n**CC-1 [MODEL] (a).** body.\n**CC-2 [MODEL] (b).** body.\n'
            '**CC-6 [MODEL] (c).** body.\n**CC-7 [MODEL] (d).** body.\n'
            '## 11. Clause index\n| Clause | stmt | Status |\n|---|---|---|\n'
            '| CC-1 | a | MODEL |\n| CC-2 | b | MODEL |\n'
            '| CC-6 | c | MODEL |\n| CC-7 | d | MODEL |\n')
        (tmp / 'rtl').mkdir()
        (tmp / 'rtl' / 'dut.sv').write_text(
            '// impl: SPEC-2-1..5 (range over a gap), SPEC-2-2\n'
            '// secrange: SPEC-5..8 (sections 5..8, not 10/14.8/16)\n'
            'module dut; endmodule\n')
        (tmp / 'formal').mkdir()
        (tmp / 'formal' / 'dut_fv.sv').write_text(
            '// FV props:\n'
            '//   Wrapper checks, per SPEC-2-2 (header preamble):\n'
            '//   P1  CC-1 protocol thing.\n'
            '//       continuation citing SPEC-5-1/5-5.\n'
            '//   P2  SPEC-8-x whole section.\n'
            '//   P9..P10  range-named props, no own citations.\n'
            'module dut_fv;\n'
            '  always @(posedge clk) begin\n'
            '    // P1: protocol\n'
            '    a_p1_x : assert (x); // CC-2 trailing\n'
            '    a_p2_y : assert (y);\n'
            '    a_bare : assert (z); // CC-6/CC-7/SPEC-10-2 mixed\n'
            '    if (1) assume (w);  // SPEC-5-6 assume-only\n'
            '    a_sfx : assert (q); // CC-2-shaped suffix\n'
            '    // P10: guard-climbed (CC-1)\n'
            '    if (1) begin\n'
            '      a_p10 : assert (t2);\n'
            '    end\n'
            '    if (1) begin\n'
            '      a_p9 : assert (t1);\n'
            '    end\n'
            '  end\n'
            'endmodule\n')
        (tmp / 'formal' / 'dut.sby').write_text(
            '# config citing CC-1\n[tasks]\nbmc\n')

        def run_audit():
            global REPO
            old = REPO
            REPO = tmp
            try:
                return Audit(tmp / 'spec.md', tmp / 'cc.md',
                             [str(tmp / 'rtl' / '*.sv'),
                              str(tmp / 'formal' / '*.sv'),
                              str(tmp / 'formal' / '*.sby')])
            finally:
                REPO = old

        aud = run_audit()
        assert_ev_ids = set(aud.assert_ev)
        checks = [
            ('range-gap', {'SPEC-2-1', 'SPEC-2-2', 'SPEC-2-5'} <=
             set(aud.occurrences)),
            ('secrange', 'SPEC-5-6' in aud.occurrences
             and 'SPEC-8-2' in aud.occurrences
             and 'SPEC-16-1' not in aud.occurrences
             and 'SPEC-14.8-1' not in aud.occurrences),
            ('slash-full', 'SPEC-5-5' in aud.occurrences),
            ('slash-mixed', 'SPEC-10-2' in aud.occurrences),
            ('wildcard', {'SPEC-8-1', 'SPEC-8-2'} <= assert_ev_ids),
            ('suffix-strip', 'CC-2' in assert_ev_ids),
            ('registry-link', 'SPEC-8-1' in assert_ev_ids
             and 'SPEC-8-2' in assert_ev_ids),
            ('registry-continuation', 'SPEC-5-1' in assert_ev_ids),
            ('prop-range-preamble', any(
                e[2] == 'a_p9' for e in aud.assert_ev.get('SPEC-2-2', []))),
            ('guard-climb', any(
                e[2] == 'a_p10' for e in aud.assert_ev.get('CC-1', []))),
            ('unsourced-none', not aud.assert_unsourced),
            ('assume-not-verify', 'SPEC-5-6' in aud.occurrences
             and 'SPEC-5-6' not in assert_ev_ids),
            ('sby-cited', 'CC-1' in aud.occurrences),
            ('no-dangling', not any(d.startswith('DANGLING')
                                    for d in aud.defects)),
            ('no-parse', not any(d.startswith('PARSE') for d in aud.defects)),
            ('no-index', not any(d.startswith('INDEX-MISMATCH')
                                 for d in aud.defects)),
        ]

        # Red/green mutation checks: each defect class must fire when the
        # corresponding defect is deliberately injected.
        aud2 = run_audit()  # baseline clean
        assert not aud2.defects, aud2.defects

        (tmp / 'rtl' / 'bad.sv').write_text(
            '// dangling: SPEC-2-99\n'
            '// parse trap: CC-1..CC-x\n')
        aud3 = run_audit()
        (tmp / 'rtl' / 'bad.sv').unlink()
        mut = [
            ('mut-dangling', any('SPEC-2-99' in d and
                                 d.startswith('DANGLING')
                                 for d in aud3.defects)),
            ('mut-parse', any(d.startswith('PARSE') for d in aud3.defects)),
        ]

        (tmp / 'spec.md').write_text(
            '# spec\n## 2\n- [SPEC-2-1] a.\n- [SPEC-2-1] again.\n')
        (tmp / 'cc.md').write_text(
            '# cc\n**CC-1 [MODEL] (a).** body.\n'
            '## 11. Clause index\n| CC-9 | missing body |\n')
        aud4 = run_audit()
        mut.extend([
            ('mut-dup-id', any(d.startswith('DUP-ID') for d in aud4.defects)),
            ('mut-index', any(d.startswith('INDEX-MISMATCH')
                              for d in aud4.defects)),
        ])

        (tmp / 'formal' / 'dut_fv.sv').write_text(
            'module dut_fv;\n'
            '  always @(posedge clk) begin\n'
            '    a_bare : assert (z);\n'
            '  end\n'
            'endmodule\n')
        aud5 = run_audit()
        mut.append(('mut-unsourced', aud5.assert_unsourced != []))

        ok = True
        for name, res in checks + mut:
            print(f'  {"ok  " if res else "FAIL"} {name}')
            ok = ok and res
        print('self-test passed' if ok else 'self-test FAILED')
        return 0 if ok else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        description='SPEC-/CC- traceability audit (see module docstring)')
    ap.add_argument('--spec', default='docs/pio-spec.md')
    ap.add_argument('--cc', default='docs/cycle-contract.md')
    ap.add_argument('--strict', action='store_true',
                    help='also fail on unsourced assertions')
    ap.add_argument('--self-test', action='store_true',
                    help='run hermetic fixtures and exit')
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()

    aud = Audit(args.spec, args.cc,
                ['rtl/*.sv', 'formal/*.sv', 'formal/*.sby',
                 'sim/*.sv', 'sim/*.svh'])
    print(aud.report())
    rc = 1 if aud.defects else 0
    if rc == 0 and args.strict and aud.assert_unsourced:
        print('\n--strict: unsourced assertions present')
        rc = 1
    return rc


if __name__ == '__main__':
    sys.exit(main())

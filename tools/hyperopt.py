#!/usr/bin/env python3
"""Hyperoptimizer (KANBAN C14): rewrite catalog + Pareto search.

Pipeline for one conformance seed (a program + its Schedule, C12):

  1. Search: exhaustive peephole closure (plus bounded stochastic walks)
     over a catalog of semantics-preserving rewrites. Each catalog entry
     is tagged trace-eq (the SPEC-16-7 trace is preserved, tick for
     tick) or spec-only (the waveform's event content is preserved but
     its timing may change — certification awaits the C15
     spec-conformance monitors), and cites the SPEC-/CC- facts it
     exploits.
  2. Screening: every candidate runs through the C12 model under the
     seed's own schedule/config (trace compare vs the original) and the
     C13 model pre-filter under the miter's config (reset PINCTRL/
     SHIFTCTRL/CLKDIV, per-side EXECCTRL under the SPEC-16-8 overlay).
  3. Pareto filter on (imem words, ticks per loop iteration — the G
     record period of the candidate's own trace) and certification of
     the trace-eq front through the full C13 oracle (sby BMC at the
     horizon, SPEC-16-3). What survives is "certified optimal within
     the rewrite closure at horizon N" — an honest bound, not a global
     optimum claim; the closure cap and the stimulus horizon are the
     two axes of that honesty.

Config-overlay support (the C11 extension point, SPEC-16-6/16-8): the
wrap rewrites change WRAP_TOP/WRAP_BOTTOM, carried by the miter's
per-side SM0_EXECCTRL_A/B and the EC_CMP_MASK readback exclusion.
Rewrites needing PINCTRL/SHIFTCTRL overlays (side-set fusion, autopull)
stay catalog-only — tagged, regression-cased, but outside the
certifiable search until the overlay widens.

--self-test runs the committed suite (the `make hyperopt` gate): the
per-rewrite regression cases (green = model trace-equal on the seed
schedule; red = the compensation re-injected-out, or the intentionally
unsound delay tamper, caught), search/Pareto units, and — needing sby
on PATH or the vibe-pio container — the end-to-end certifications: a
wrap_fold output certified PASS through the overlay miter, and the
delay-tamper rewrite FAILed by sby with a decoded counterexample.

The script is stdlib-only (runs in the container too).
"""

from __future__ import annotations

import argparse
import dataclasses
import itertools
import random
import re
import sys
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path
from typing import Any, TypedDict

TOOLS = str(Path(__file__).resolve().parent)
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

import hyperequiv as HE  # noqa: E402
from gen_level_goldens import assemble as gg_assemble  # noqa: E402
from gen_level_goldens import parse_level_file as gg_parse_level_file  # noqa: E402
from gen_level_goldens import pin_series as gg_pin_series  # noqa: E402
from gen_level_goldens import run_case as gg_run_case  # noqa: E402
from pio_model import asm, difftest, stim, tracefmt  # noqa: E402
from pio_model import encoding as E  # noqa: E402
from pio_model import model as M  # noqa: E402

REPO = Path(TOOLS).parent
# WRAP_TOP 16:12 | WRAP_BOTTOM 11:7 (SPEC-7-19/20) — the only EXECCTRL
# bits the C14 overlay may change (SPEC-16-8).
WRAP_BITS = (0x1F << 12) | (0x1F << 7)

# Conformance seeds: schedule case name -> (.pio path, program name) —
# difftest.CONF_PROGRAMS' list (minus set_scl_sda, the i2c case's aux
# program with no schedule of its own) plus the clkdiv schedule variants.
SEED_TABLE: dict[str, tuple[str, str]] = {
    prog: (rel, prog) for rel, prog in difftest.CONF_PROGRAMS if prog != "set_scl_sda"
}
SEED_TABLE["uart_tx_clkdiv"] = ("pio/uart_tx/uart_tx.pio", "uart_tx")
SEED_TABLE["uart_rx_clkdiv"] = ("pio/uart_rx/uart_rx.pio", "uart_rx")


# ---------------------------------------------------------------------------
# Candidates and seed context.
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Candidate:
    """One point of the rewrite space: an imem image plus the EXECCTRL it
    runs under (wrap bounds may be overlaid, SPEC-16-8). `reloc` maps an
    original pc to this candidate's pc (-1 = the word was deleted); the
    trail records (rewrite, site) for the report."""

    words: tuple[int, ...]
    execctrl: int
    reloc: tuple[int, ...]
    trail: tuple[tuple[str, int], ...] = ()


def _cand(
    words: Sequence[int], execctrl: int, reloc: Sequence[int], trail: Sequence[tuple[str, int]] = ()
) -> Candidate:
    return Candidate(tuple(words), execctrl, tuple(reloc), tuple(trail))


@dataclasses.dataclass
class SeedCtx:
    """Everything the rewrites need to know about the seed: the program,
    its schedule-scanned SM0 config (EXECCTRL/PINCTRL per the case's
    writes), the entry force point, and the model measurements
    (executed pcs, original trace, its G period)."""

    name: str
    words: tuple[int, ...]
    execctrl: int
    sched: stim.Schedule
    entry: int | None
    side_en: bool
    ss_total: int
    has_dyn_pc: bool  # any OUT PC / MOV PC — blocks deleting rewrites
    visited: frozenset[int]  # pcs the model ran through (superset: stalls)
    trace: list[tracefmt.Rec]
    period: int | None  # ticks per loop iteration (G-record period)

    @property
    def delay_mask(self) -> int:
        """Free delay bits under the seed's side-set config (SPEC-4-3)."""
        return (1 << (5 - self.ss_total)) - 1

    def decode(self, word: int) -> E.Decoded:
        return E.decode(word, self.side_en, self.ss_total)


def load_seed(name: str, repo: Path = REPO) -> SeedCtx:
    """Build the SeedCtx for a conformance case: assemble the program
    (C12), scan its Schedule for config/entry, run the model once.

    >>> ctx = load_seed("squarewave")
    >>> (len(ctx.words), ctx.entry, ctx.ss_total)
    (4, None, 0)
    >>> ctx.period  # set pins,1 [8] prologue, then the 4-clk pin loop
    4
    """
    rel, prog_name = SEED_TABLE[name]
    progs = asm.parse_file(repo / "third_party/pico-examples" / rel)
    prog = next(p for p in progs if p.name == prog_name)
    sched = next(s for n, s in stim.conformance_schedules(repo) if n == name)
    execctrl = 0
    pinctrl = M.PINCTRL_RESET
    entry: int | None = None
    for c in sched.cycles:
        op, addr, wdata = c[2], c[3], c[4]
        if op != stim.OP_WR:
            continue
        if addr == stim.A_SM0 + 4 * 1:
            execctrl = wdata
        elif addr == stim.A_SM0 + 4 * 5:
            pinctrl = wdata
        elif addr == stim.A_SM0 + 4 * 4:
            entry = wdata & 0x1F
    words = tuple(prog.words)
    trace = difftest.run_model_trace(sched)
    has_dyn_pc = any(
        (d["is_out"] and d.get("out_dst") == E.OUTD_PC) or (d["is_mov"] and d.get("mov_dst") == E.MOVD_PC)
        for d in (E.decode(w) for w in words)
    )
    return SeedCtx(
        name=name,
        words=words,
        execctrl=execctrl,
        sched=sched,
        entry=entry,
        side_en=((execctrl >> 30) & 1) != 0,
        ss_total=(pinctrl >> 29) & 7,
        has_dyn_pc=has_dyn_pc,
        visited=frozenset(_visited_pcs(sched)),
        trace=trace,
        period=trace_period(trace),
    )


def _fold_loopback(m: M.PIOBlockModel, gpio: int, lb: int) -> int:
    gin = gpio
    if lb:
        for p in range(32):
            if (lb >> p) & 1:
                lv = (m.gpio_lvl_r >> p) & 1 if (m.gpio_oe_r >> p) & 1 else 0
                gin = (gin & ~(1 << p)) | (lv << p)
    return gin


def _visited_pcs(sched: stim.Schedule) -> set[int]:
    """pcs the model occupies while running the schedule (stall/delay
    ticks repeat the executing pc, so this is exactly the executed set)."""
    m = M.PIOBlockModel()
    seen: set[int] = set()
    for c in sched.cycles:
        gpio, lb, op, addr, wdata, nbs, nbc, prv, nxt = c
        m.step(_fold_loopback(m, gpio, lb), lb, op, addr, wdata, nbs, nbc, prv, nxt)
        seen.add(m.pc_r)
    return seen


def trace_period(recs: Sequence[tracefmt.Rec], min_frac: float = 0.5) -> int | None:
    """Ticks per loop iteration: the eventual period of the G records'
    observable payload (gpio/oe/intr — the clk field itself never
    repeats). Data-dependent programs never settle inside the schedule
    -> None.

    >>> trace_period([("G", k, k % 2, 0, 0) for k in range(40)])
    2
    >>> trace_period([("G", k, k, 0, 0) for k in range(40)]) is None
    True
    """
    gs = [r[2:] for r in recs if r[0] == "G"]
    tail = gs[int(len(gs) * min_frac) :]
    for p in range(1, len(tail) // 2 + 1):
        if all(tail[i] == tail[i - p] for i in range(p, len(tail))):
            return p
    return None


# ---------------------------------------------------------------------------
# Word surgery: delay packing, relocation-aware deletion.
# ---------------------------------------------------------------------------


def _set_delay(ctx: SeedCtx, word: int, delay: int) -> int:
    """Rewrite the delay portion of the ds field (bits 12:8, SPEC-4-1)
    under the seed's side-set split; the side bits stay untouched."""
    m = ctx.delay_mask
    return (word & ~(m << 8) & 0xFFFF) | ((delay & m) << 8)


def _jmp_targets(words: Sequence[int]) -> set[int]:
    """Statically written pcs: every JMP's address operand (SPEC-8-4 —
    absolute). OUT PC / MOV PC are handled by the global has_dyn_pc gate."""
    return {w & 0x1F for w in words if ((w >> 13) & 7) == E.C_JMP}


def _delete_word(ctx: SeedCtx, cand: Candidate, k: int) -> Candidate | None:
    """Delete word k and relocate: JMP addresses and the wrap bounds
    shift down past k (SPEC-8-4, SPEC-7-19/20). None when anything
    targets k (a jump, the wrap, or the entry force) — the caller's
    preconditions should have ruled that out."""
    words = cand.words
    if k in _jmp_targets(words):
        return None
    ec = cand.execctrl
    et, eb = (ec >> 12) & 0x1F, (ec >> 7) & 0x1F
    if k in (et, eb):
        return None
    if ctx.entry is not None and cand.reloc[ctx.entry] == k:
        return None
    out = [
        (w & ~0x1F) | ((w & 0x1F) - 1) if ((w >> 13) & 7) == E.C_JMP and (w & 0x1F) > k else w
        for j, w in enumerate(words)
        if j != k  # SPEC-8-4: absolute JMP targets shift down past the cut
    ]
    ec2 = (ec & ~WRAP_BITS) | ((et - 1 if et > k else et) << 12) | ((eb - 1 if eb > k else eb) << 7)
    reloc2 = tuple(-1 if r == k else (r if r < k else r - 1) for r in cand.reloc)
    return _cand(out, ec2, reloc2, cand.trail)


def _succ(_ctx: SeedCtx, cand: Candidate, i: int) -> int:
    """Static successor of a non-branching word i: wrap first (SPEC-8-2),
    then pc+1."""
    if i == ((cand.execctrl >> 12) & 0x1F):
        return (cand.execctrl >> 7) & 0x1F
    return (i + 1) & 0x1F


def _tick_burner(ctx: SeedCtx, words: Sequence[int], i: int) -> int | None:
    """If word i burns exactly 1+delay ticks with no other effect, its
    delay. Covers `nop` = mov y,y (SPEC-3.6-10), `mov x,x`, and JMP to
    its own fall-through with a non-writing condition (SPEC-3.1-2..9 —
    x--/y-- write and never qualify). The word must be side-free with a
    clean ds field: value bits left in the ds field do nothing under the
    seed's config but read as delay under the miter's reset PINCTRL, so
    dropping them would not survive the oracle."""
    w = words[i]
    d = ctx.decode(w)
    if d["illegal"] or d["ss_valid"]:
        return None
    if ((w >> 8) & 0x1F) > ctx.delay_mask:
        return None
    if (
        d["is_mov"]
        and d.get("mov_op") == E.MOP_NONE
        and d.get("mov_dst") in (E.MOVD_X, E.MOVD_Y)
        and d.get("mov_src") == d.get("mov_dst")
    ):
        return d["delay"]
    if (
        d["is_jmp"]
        and d.get("jmp_cond") not in (E.JC_XDEC, E.JC_YDEC)
        and d.get("jmp_addr") == ((i + 1) & 0x1F)
        and i + 1 < len(words)
    ):
        return d["delay"]
    return None


def _can_absorb(ctx: SeedCtx, cand: Candidate, i: int, extra: int) -> bool:
    """Word i can take `extra` more delay ticks: it must complete by
    falling through (no JMP, no OUT/MOV PC — the successor would leave;
    no OUT/MOV EXEC — the latch suppresses the delay load), have room in
    the delay field (SPEC-4-3), and not be illegal. Stalling is fine:
    CC-22 keeps the delay from elapsing during a stall, so the folded
    ticks land exactly where the burned ticks did (CC-10)."""
    d = ctx.decode(cand.words[i])
    if d["illegal"] or d["is_jmp"]:
        return False
    if d["is_out"] and d.get("out_dst") in (E.OUTD_PC, E.OUTD_EXEC):
        return False
    if d["is_mov"] and d.get("mov_dst") in (E.MOVD_PC, E.MOVD_EXEC):
        return False
    return d["delay"] + extra <= ctx.delay_mask


def _no_side_clean(ctx: SeedCtx, w: int) -> bool:
    """Side-free with a clean ds field (see _tick_burner)."""
    d = ctx.decode(w)
    return not d["illegal"] and not d["ss_valid"] and ((w >> 8) & 0x1F) <= ctx.delay_mask


# ---------------------------------------------------------------------------
# The rewrite catalog. Each entry: name, tag (trace-eq | spec-only), the
# SPEC-/CC- facts it exploits, the config overlay it needs ("" | execctrl
# | pinctrl | shiftctrl), and the applicability/transform.
# ---------------------------------------------------------------------------


class Rewrite(TypedDict):
    name: str
    tag: str
    cites: str
    needs: str
    apply: Callable[[SeedCtx, Candidate], list[Candidate]]


def rw_fold_tick(ctx: SeedCtx, cand: Candidate) -> list[Candidate]:
    """Fold a pure 1-tick word (`nop`/`mov x,x`/JMP-to-next) and its
    delay into the fall-through predecessor's delay field and delete it
    — the same total time passes with one fewer imem word. Requires the
    predecessor to always fall through into the burned word, which the
    unique-in-edge gates in _delete_word enforce."""
    out: list[Candidate] = []
    words = cand.words
    for i in range(1, len(words)):
        burn = _tick_burner(ctx, words, i)
        if burn is None or not _can_absorb(ctx, cand, i - 1, 1 + burn):
            continue
        if _succ(ctx, cand, i - 1) != i:
            continue
        pd = ctx.decode(words[i - 1])["delay"]
        base = list(words)
        base[i - 1] = _set_delay(ctx, words[i - 1], pd + 1 + burn)
        stepped = _cand(base, cand.execctrl, cand.reloc, cand.trail)
        nxt = _delete_word(ctx, stepped, i)
        if nxt is not None:
            out.append(_cand(nxt.words, nxt.execctrl, nxt.reloc, [*cand.trail, ("fold_tick", i)]))
    return out


def _terminal_backjmp(ctx: SeedCtx, cand: Candidate) -> tuple[int, int, E.Decoded] | None:
    """The last word is an unconditional backward JMP with a clean ds
    field and the wrap sitting on it (the .pio default, SPEC-7-19):
    (index, target, decode)."""
    words = cand.words
    k = len(words) - 1
    if k < 1 or ((cand.execctrl >> 12) & 0x1F) != k:
        return None
    d = ctx.decode(words[k])
    if not d["is_jmp"] or d["illegal"] or d.get("jmp_cond") != E.JC_ALWAYS:
        return None
    target = d.get("jmp_addr", 0)
    if target >= k or not _no_side_clean(ctx, words[k]):
        return None
    return k, target, d


def _wrap_entry_ok(ctx: SeedCtx, cand: Candidate, k: int) -> bool:
    """Nothing may enter the deleted JMP's slot: no static jump targets
    it and the entry force does not point at it."""
    return k not in _jmp_targets(cand.words) and not (ctx.entry is not None and cand.reloc[ctx.entry] == k)


def rw_wrap_fold(ctx: SeedCtx, cand: Candidate) -> list[Candidate]:
    """Replace the terminal backward JMP with the free wrap (SPEC-8-2,
    CC-10 — wrap costs no tick) and fold its 1+delay ticks into the
    predecessor's delay field: one word shorter, tick-for-tick
    identical. The wrap bounds change — carried by the EXECCTRL overlay
    (SPEC-16-8)."""
    hit = _terminal_backjmp(ctx, cand)
    if hit is None:
        return []
    k, target, d = hit
    if not _can_absorb(ctx, cand, k - 1, 1 + d["delay"]) or _succ(ctx, cand, k - 1) != k:
        return []
    if not _wrap_entry_ok(ctx, cand, k):
        return []
    pd = ctx.decode(cand.words[k - 1])["delay"]
    base = list(cand.words)
    base[k - 1] = _set_delay(ctx, base[k - 1], pd + 1 + d["delay"])
    ec2 = (cand.execctrl & ~WRAP_BITS) | ((k - 1) << 12) | (target << 7)
    reloc2 = tuple(-1 if r == k else r for r in cand.reloc)
    return [_cand(base[:-1], ec2, reloc2, [*cand.trail, ("wrap_fold", k)])]


def rw_wrap_speed(ctx: SeedCtx, cand: Candidate) -> list[Candidate]:
    """Same terminal-JMP-to-wrap conversion without the delay
    compensation: 1+delay ticks faster per iteration. Spec-only — the
    observable events are the same but every one after the wrap lands
    earlier, so the SPEC-16-7 trace diverges by design (certification
    awaits the C15 spec-eq mode). Fires only when the predecessor's
    delay field cannot hold the folded ticks, so it never competes with
    wrap_fold."""
    hit = _terminal_backjmp(ctx, cand)
    if hit is None:
        return []
    k, target, d = hit
    if not _wrap_entry_ok(ctx, cand, k):
        return []
    if _can_absorb(ctx, cand, k - 1, 1 + d["delay"]) and _succ(ctx, cand, k - 1) == k:
        return []  # the trace-eq wrap_fold covers this case
    ec2 = (cand.execctrl & ~WRAP_BITS) | ((k - 1) << 12) | (target << 7)
    reloc2 = tuple(-1 if r == k else r for r in cand.reloc)
    return [_cand(cand.words[:-1], ec2, reloc2, [*cand.trail, ("wrap_speed", k)])]


def rw_dce(ctx: SeedCtx, cand: Candidate) -> list[Candidate]:
    """Delete a word the model never ran through under the seed's
    schedule (dead under that stimulus, at that horizon) — compaction
    with JMP/wrap relocation. The certification horizon bounds the
    claim (SPEC-16-3): under different stimulus the dead word may be
    live, which is exactly what the oracle screens for."""
    if ctx.has_dyn_pc:
        return []
    live = {cand.reloc[o] for o in ctx.visited}
    targets = _jmp_targets(cand.words)
    for j in range(len(cand.words)):
        if j in live or j in targets:
            continue
        nxt = _delete_word(ctx, cand, j)
        if nxt is not None:
            return [_cand(nxt.words, nxt.execctrl, nxt.reloc, [*cand.trail, ("dce", j)])]
    return []


def _t_reader(w: int, t: int) -> bool:
    """Word w reads register t in {x, y}: MOV/IN source, or a JMP
    condition mentioning it (SPEC-3.1-2..9 — x--/y-- read and maybe
    write; either way the fold must stop there)."""
    d = E.decode(w)
    reg_src = (E.MOVS_X if t == E.MOVD_X else E.MOVS_Y) if d["is_mov"] else None
    in_src = (E.INS_X if t == E.MOVD_X else E.INS_Y) if d["is_in"] else None
    if (d["is_mov"] and d.get("mov_src") == reg_src) or (d["is_in"] and d.get("in_src") == in_src):
        return True
    if d["is_jmp"]:
        conds = {E.JC_NOTX, E.JC_XDEC, E.JC_XNEY} if t == E.MOVD_X else {E.JC_NOTY, E.JC_YDEC, E.JC_XNEY}
        return d.get("jmp_cond") in conds
    return False


def _t_writer(w: int, t: int) -> bool:
    """Word w writes register t in {x, y} (a PULL's no-block fallback
    loads X — SPEC-3.5-12 — so any PULL counts for X)."""
    d = E.decode(w)
    if d["is_mov"]:
        return d.get("mov_dst") == t
    if d["is_out"] or d["is_set"]:
        return d.get("out_dst") == t or d.get("set_dst") == t
    return t == E.MOVD_X and d["is_pull"]


def rw_mov_not_fold(ctx: SeedCtx, cand: Candidate) -> list[Candidate]:
    """SPEC-3.6-9 algebra: `mov t, ~s; mov u, ~t` == `mov u, s` when t
    is dead after the pair — one word shorter, with the deleted tick
    folded into the predecessor exactly as fold_tick does. t must be a
    pure temp (x or y: ISR/OSR carry shifter counters, autopush/pull
    state — SPEC-3.6-14, CC-11..13), and the pair must be entered only
    through its predecessor (no jumps/wrap/entry into either word)."""
    words = cand.words
    targets = _jmp_targets(words)
    eb = (cand.execctrl >> 7) & 0x1F
    for i in range(1, len(words) - 1):
        w1, w2 = words[i], words[i + 1]
        d1, d2 = ctx.decode(w1), ctx.decode(w2)
        t = d1.get("mov_dst")
        s = d1.get("mov_src")
        if (
            not d1["is_mov"]
            or d1["illegal"]
            or d2["illegal"]
            or d1.get("mov_op") != E.MOP_INV
            or t not in (E.MOVD_X, E.MOVD_Y)
            or s == t
            or ((w1 >> 8) & 0x1F) != 0  # delay 0, no side, no dead bits
        ):
            continue
        if not d2["is_mov"] or d2.get("mov_op") != E.MOP_INV or d2.get("mov_src") != t:
            continue
        if not _can_absorb(ctx, cand, i - 1, 1) or _succ(ctx, cand, i - 1) != i:
            continue
        if {i, i + 1} & targets or i == eb or (i + 1) == eb:
            continue
        if ctx.entry is not None and cand.reloc[ctx.entry] in (i, i + 1):
            continue
        for j in range(i + 2, len(words)):  # t must stay dead until rewritten
            if _t_reader(words[j], t):
                break
            if _t_writer(words[j], t):
                break  # redefined below the pair: later readers are safe
        else:
            base = list(words)
            base[i - 1] = _set_delay(ctx, base[i - 1], ctx.decode(base[i - 1])["delay"] + 1)
            base[i + 1] = (w2 & 0xFFC0) | (s or 0)  # op none, src s
            stepped = _cand(base, cand.execctrl, cand.reloc, cand.trail)
            nxt = _delete_word(ctx, stepped, i)
            if nxt is not None:
                return [_cand(nxt.words, nxt.execctrl, nxt.reloc, [*cand.trail, ("mov_not_fold", i)])]
    return []


def rw_sideset_fuse(_ctx: SeedCtx, _cand: Candidate) -> list[Candidate]:
    """SPEC-4-1/4-6 + CC-5: move `set pins, k` into the following
    instruction's side-set field (side-set lands on the instruction's
    first cycle even under stall) and delete the SET. Needs a PINCTRL
    overlay (SIDESET_COUNT/BASE) — beyond the C13 v1 miter, so this
    entry is catalog-only: documented, never searched. Timing shifts
    (the follower executes 1+delay earlier), so it is spec-only even
    with the overlay."""
    return []  # overlay-locked (SPEC-16-6)


def rw_delay_absorb(ctx: SeedCtx, cand: Candidate) -> list[Candidate]:
    """CC-22: delay does not elapse during a stall. When every execution
    of `A [d]` under the seed stimulus stalls >= d+1 cycles first, the
    delay is never visible and can be stripped — d ticks faster. The
    gate is model-measured over the seed's stimulus, so spec-only (the
    bound is the horizon, SPEC-16-3); applied only to the un-rewritten
    seed, where word indices still line up with the measurement."""
    if cand.trail:
        return []
    runs = _min_stall_runs(ctx.sched)
    for i, w in enumerate(cand.words):
        d = ctx.decode(w)
        if d["illegal"] or d["delay"] == 0 or not _no_side_clean(ctx, w):
            continue
        if runs.get(i, -1) > d["delay"]:  # every visit stalled > delay first
            base = list(cand.words)
            base[i] = _set_delay(ctx, w, 0)
            return [_cand(base, cand.execctrl, cand.reloc, [*cand.trail, ("delay_absorb", i)])]
    return []


def rw_autopull(_ctx: SeedCtx, _cand: Candidate) -> list[Candidate]:
    """CC-11/CC-12: with autopull the OSR refills around OUTs, so a
    `pull` feeding an OUT loop can be deleted. Needs a SHIFTCTRL
    overlay — catalog-only like side-set fusion (SPEC-16-6)."""
    return []  # overlay-locked (SPEC-16-6)


CATALOG: tuple[Rewrite, ...] = (
    Rewrite(
        name="fold_tick", tag="trace-eq", cites="SPEC-3.6-10, SPEC-4-3, CC-10, CC-22", needs="", apply=rw_fold_tick
    ),
    Rewrite(name="wrap_fold", tag="trace-eq", cites="SPEC-8-2, CC-10, SPEC-16-8", needs="execctrl", apply=rw_wrap_fold),
    Rewrite(name="mov_not_fold", tag="trace-eq", cites="SPEC-3.6-9", needs="", apply=rw_mov_not_fold),
    Rewrite(name="dce", tag="trace-eq", cites="SPEC-8-4, SPEC-16-3", needs="", apply=rw_dce),
    Rewrite(
        name="wrap_speed", tag="spec-only", cites="SPEC-8-2, CC-10, SPEC-16-8", needs="execctrl", apply=rw_wrap_speed
    ),
    Rewrite(name="delay_absorb", tag="spec-only", cites="CC-22, SPEC-16-3", needs="", apply=rw_delay_absorb),
    Rewrite(
        name="sideset_fuse", tag="spec-only", cites="SPEC-4-1, SPEC-4-6, CC-5", needs="pinctrl", apply=rw_sideset_fuse
    ),
    Rewrite(name="autopull", tag="spec-only", cites="CC-11, CC-12", needs="shiftctrl", apply=rw_autopull),
)


def catalog_rewrite(name: str) -> Rewrite:
    return next(r for r in CATALOG if r["name"] == name)


def _min_stall_runs(sched: stim.Schedule) -> dict[int, int]:
    """Per pc, the shortest run of consecutive STALL clks over all its
    visits under the schedule (model-measured; pcs never visited are
    absent). The pc cannot change mid-stall, so a run is a maximal
    consecutive stretch of stalled clks on one pc."""
    m = M.PIOBlockModel()
    best: dict[int, int] = {}
    run = 0
    pc = 0
    for c in sched.cycles:
        gpio, lb, op, addr, wdata, nbs, nbc, prv, nxt = c
        m.step(_fold_loopback(m, gpio, lb), lb, op, addr, wdata, nbs, nbc, prv, nxt)
        if m.state_r == M.ST_STALL:
            if run == 0:
                pc = m.pc_r
            run += 1
        else:
            if run:
                best[pc] = min(best.get(pc, run), run)
            run = 0
    if run:
        best[pc] = min(best.get(pc, run), run)
    return best


# ---------------------------------------------------------------------------
# Screening: rebuilt schedules, model trace compare, oracle pre-filter.
# ---------------------------------------------------------------------------


def rebuild_schedule(sched: stim.Schedule, cand: Candidate, entry_cur: int | None) -> stim.Schedule:
    """The candidate's schedule: identical timeline with the imem image,
    the EXECCTRL word and the entry force remapped. entry_cur is the
    entry in the candidate's own pc space, or None when the seed has no
    entry force; a deleted entry (negative) leaves the force write
    untouched (screen() rejects such candidates first)."""
    s2 = stim.Schedule()
    s2.cycles = [list(c) for c in sched.cycles]
    for c in s2.cycles:
        op, addr = c[2], c[3]
        if op != stim.OP_WR:
            continue
        if stim.A_IMEM0 <= addr < stim.A_IMEM0 + 4 * 32:
            i = (addr - stim.A_IMEM0) // 4
            c[4] = cand.words[i] if i < len(cand.words) else 0
        elif addr == stim.A_SM0 + 4 * 1:
            c[4] = cand.execctrl
        elif addr == stim.A_SM0 + 4 * 4 and entry_cur is not None and entry_cur >= 0:
            c[4] = entry_cur & 0x1F
    return s2


class Screening(TypedDict):
    """Model-side verdict for one candidate under the seed's schedule."""

    ok: bool
    div: str | None  # first divergence when not ok


def _entry_cur(ctx: SeedCtx, cand: Candidate) -> int | None:
    """The seed's entry force point in the candidate's pc space (None =
    no force; a caller seeing a negative value must reject)."""
    return None if ctx.entry is None else cand.reloc[ctx.entry]


def screen(ctx: SeedCtx, cand: Candidate) -> Screening:
    """C12-model trace compare of the candidate vs the original under
    the seed's own schedule and config (SPEC-16-7, SPEC-16-2 rules)."""
    entry_cur = _entry_cur(ctx, cand)
    if entry_cur is not None and entry_cur < 0:
        return Screening(ok=False, div="entry force points at a deleted word")
    recs = difftest.run_model_trace(rebuild_schedule(ctx.sched, cand, entry_cur))
    try:
        tracefmt.compare(ctx.trace, recs)
    except tracefmt.TraceMismatch as ex:
        return Screening(ok=False, div=str(ex))
    return Screening(ok=True, div=None)


def miter_prefilter(ctx: SeedCtx, cand: Candidate, horizon: int, rounds: int, seed: int) -> HE.Divergence | None:
    """The C13 pre-filter under the miter's config (reset PINCTRL/
    SHIFTCTRL, per-side EXECCTRL): a divergence is a definite reject."""
    pair = HE.ProgPair(ctx.words, cand.words, ctx.execctrl, cand.execctrl)
    return HE.prefilter(pair, horizon, rounds, seed)


# ---------------------------------------------------------------------------
# Search: exhaustive closure + bounded stochastic walks, Pareto filter.
# ---------------------------------------------------------------------------


class SearchOpts(TypedDict):
    include_spec: bool
    max_states: int
    tries: int
    rng_seed: int


def _applicable(ctx: SeedCtx, cand: Candidate, opts: SearchOpts) -> list[Candidate]:
    out: list[Candidate] = []
    for rw in CATALOG:
        if rw["needs"] not in ("", "execctrl"):
            continue  # overlay-locked (SPEC-16-6): catalog-only
        if rw["tag"] != "trace-eq" and not opts["include_spec"]:
            continue
        out += rw["apply"](ctx, cand)
    return out


def _key(cand: Candidate) -> tuple[tuple[int, ...], int]:
    return cand.words, cand.execctrl


def search(ctx: SeedCtx, opts: SearchOpts) -> tuple[list[Candidate], bool]:
    """Exhaustive peephole closure from the seed (BFS, deduplicated by
    the (words, execctrl) key, capped at max_states) plus bounded
    stochastic walks when the cap trips. -> (states, capped)."""
    start = _cand(ctx.words, ctx.execctrl, tuple(range(len(ctx.words))), ())
    seen = {_key(start)}
    states: list[Candidate] = [start]
    frontier = [start]
    capped = False
    while frontier:
        cur = frontier.pop(0)
        for nxt in _applicable(ctx, cur, opts):
            if _key(nxt) in seen:
                continue
            if len(states) >= opts["max_states"]:
                capped = True
                break
            seen.add(_key(nxt))
            states.append(nxt)
            frontier.append(nxt)
        if capped:
            break
    if capped and opts["tries"]:
        rng = random.Random(opts["rng_seed"])
        for _ in range(opts["tries"]):  # stochastic complement past the cap
            cur = start
            for _depth in range(8):
                nxts = [c for c in _applicable(ctx, cur, opts) if _key(c) not in seen]
                if not nxts:
                    break
                cur = rng.choice(nxts)
                if len(states) >= opts["max_states"] + opts["tries"]:
                    break
                seen.add(_key(cur))
                states.append(cur)
    return states, capped


@dataclasses.dataclass
class Evaluated:
    """One searched candidate with both screenings and its metrics."""

    cand: Candidate
    screen: Screening
    period: int | None
    note: str = ""


def evaluate(ctx: SeedCtx, cand: Candidate) -> Evaluated:
    entry_cur = _entry_cur(ctx, cand)
    sched = rebuild_schedule(ctx.sched, cand, entry_cur)
    period = trace_period(difftest.run_model_trace(sched)) if sched is not None else None
    return Evaluated(cand=cand, screen=screen(ctx, cand), period=period)


def pareto_front(evs: Sequence[Evaluated]) -> list[Evaluated]:
    """Non-dominated on (imem words, ticks per loop iteration); an
    unsettled period (data-dependent program) counts as +inf — it can
    never dominate on speed, only on size.

    >>> a = Evaluated(_cand([1], 0, (0,)), Screening(ok=True, div=None), 4)
    >>> b = Evaluated(_cand([1, 2], 0, (0, 1)), Screening(ok=True, div=None), 2)
    >>> c = Evaluated(_cand([1, 2, 3], 0, (0, 1, 2)), Screening(ok=True, div=None), 1)
    >>> [len(e.cand.words) for e in pareto_front([a, b, c])]
    [1, 2, 3]
    """

    def dom(x: Evaluated, y: Evaluated) -> bool:
        px = x.period if x.period is not None else float("inf")
        py = y.period if y.period is not None else float("inf")
        return (
            len(x.cand.words) <= len(y.cand.words) and px <= py and (len(x.cand.words) < len(y.cand.words) or px < py)
        )

    return [e for e in evs if not any(dom(o, e) for o in evs if o is not e)]


# ---------------------------------------------------------------------------
# Certification: the C13 oracle on the trace-eq Pareto front.
# ---------------------------------------------------------------------------


def certify(ctx: SeedCtx, cand: Candidate, horizon: int, *, seed: int, timeout: int, tag: str) -> HE.Verdict:
    """Full C13 oracle run for one candidate (prefilter + sby BMC at the
    horizon, SPEC-16-3) through the EXECCTRL overlay miter (SPEC-16-8)."""
    diff = (ctx.execctrl ^ cand.execctrl) & ~WRAP_BITS & 0x7FFFFFFF
    if diff:
        return HE.Verdict(kind="ERROR", lines=[f"overlay leaves the wrap fields (SPEC-16-8): 0x{diff:08x}"])
    pair = HE.ProgPair(ctx.words, cand.words, ctx.execctrl, cand.execctrl if cand.execctrl != ctx.execctrl else None)
    return HE.check_pair(
        pair,
        horizon,
        seed=seed,
        rounds=8,
        prefilter_on=True,
        timeout=timeout,
        tag=tag,
        keep=False,
    )


# ---------------------------------------------------------------------------
# The per-seed report.
# ---------------------------------------------------------------------------


def run_seed(
    ctx: SeedCtx,
    horizon: int,
    opts: SearchOpts,
    *,
    certify_on: bool = True,
    timeout: int = 600,
) -> dict[str, object]:
    """Search + screen + Pareto + certify one seed; prints the report.
    -> summary dict (states, front size, certified count)."""
    states, capped = search(ctx, opts)
    evs = [evaluate(ctx, c) for c in states]
    good = [e for e in evs if e.screen["ok"]]
    front = pareto_front(good)
    print(
        f"=== {ctx.name}: {len(ctx.words)} words, period {ctx.period}, {len(evs)} states"
        + (" (capped)" if capped else "")
    )
    for e in evs:
        if not e.screen["ok"]:
            trail = ">".join(f"{n}@{s}" for n, s in e.cand.trail) or "-"
            print(f"  reject {trail}: {e.screen['div']}")
    certified = 0
    certifiable = 0
    for e in front:
        trail = ">".join(f"{n}@{s}" for n, s in e.cand.trail) or "(original)"
        tags = {n for n, _ in e.cand.trail}
        spec = any(catalog_rewrite(n)["tag"] == "spec-only" for n in tags)
        head = f"  front {len(e.cand.words):2d}w period {e.period if e.period is not None else '-':>4} {trail}"
        if spec:
            pf = miter_prefilter(ctx, e.cand, horizon, 4, 1)
            state = "diverges as expected" if pf else "no divergence"
            print(f"{head}\n     spec-only: trace diverges by design; awaits C15 (prefilter: {state})")
            continue
        if e.cand.trail and certify_on:
            certifiable += 1
            v = certify(ctx, e.cand, horizon, seed=1, timeout=timeout, tag=f"hyp_{ctx.name}")
            e.note = v["kind"]
            print(f"{head} -> oracle {v['kind']}")
            if v["kind"] == "PASS":
                certified += 1
            elif v["kind"] == "FAIL":
                print("     " + v["lines"][-1])
        else:
            print(head)
    if capped:
        verdict = "closure capped — stochastic complement only"
    elif certified < certifiable:
        verdict = f"{certifiable - certified} front member(s) uncertified (TIMEOUT/FAIL above) — claim screened-only"
    elif not certify_on:
        verdict = "model-screened optimal within rewrite closure (no sby run; use without --no-certify to certify)"
    else:
        verdict = f"certified optimal within rewrite closure at horizon {horizon}"
    print(f"  => {verdict}; rejected {len(evs) - len(good)}, front {len(front)}, certified {certified}")
    return {"name": ctx.name, "words": len(ctx.words), "states": len(evs), "front": len(front), "certified": certified}


# ---------------------------------------------------------------------------
# The intentionally unsound rewrite (red case): delay tamper.
# ---------------------------------------------------------------------------


def tamper_delay(ctx: SeedCtx, cand: Candidate) -> list[Candidate]:
    """NOT semantics-preserving — the card's red case: bump the first
    delay-bearing word's delay by one tick with no compensation. The
    oracle must catch it (pre-filter and sby). Lives outside CATALOG."""
    for i, w in enumerate(cand.words):
        d = ctx.decode(w)
        if d["delay"] < ctx.delay_mask and not d["ss_valid"]:
            base = list(cand.words)
            base[i] = _set_delay(ctx, w, d["delay"] + 1)
            return [_cand(base, cand.execctrl, cand.reloc, [*cand.trail, ("tamper_delay", i)])]
    return []


# ---------------------------------------------------------------------------
# C36: level par — the Pareto front per level, derived and drift-checked.
# KANBAN C36: "fronts from tools/hyperopt.py, numbers committed per level;
# the hyperopt suite re-derives the front (drift-checked like the golden
# vectors)". The front is over (imem words, clk/cycle) of programs that
# pass the level's own monitor profile — the champion of that front is the
# committed reference.par, so par is a derived number, never a guess.
# ---------------------------------------------------------------------------

# The honest solution space per level (design data, like gen_level_goldens'
# PERTURBATIONS table): "wrap" = a whole-listing wrap loop over set rows
# (the chapter-0/1 vocabulary; the level's pinned WRAP_TOP caps the words);
# "prefix" = the boot listing's first row kept verbatim (the task IS that
# row — L3's preamble must run once) with a jmp back edge closing a loop
# over the rows above it; "scramble" = the boot's rows in every order (L4:
# the Parsons rung — the vocabulary is fixed, the order is the whole task,
# so the honest space is the permutations); "given" = the level's own
# program is the only honest one (L6: a predict→run level with no editor —
# nothing else can be authored, so the front is the single given point and
# the drift gate pins par == it). Every level under web/levels/ needs an
# entry.
FRONT_CLASS: dict[str, str] = {
    "l0": "wrap",
    "l1": "wrap",
    "l2": "wrap",
    "l3": "prefix",
    "l4": "scramble",
    "l5": "wrap",
    "l6": "given",
}


def _rx_judge(seen: Sequence[int], prof: dict[str, Any]) -> dict[str, Any]:
    """The Python mirror of web/levels.js rxJudge (C39) — the JS gate
    stays the authority (it replays the committed goldens); this mirror
    exists so the front search can judge reading levels without a
    browser. Same semantics: the pushed words compared against the
    profile's expected words exactly, the verdict naming the first
    divergent bit; fewer words than expected keeps watching; a value
    has no tolerance, so there is no ladder.

    >>> p = {"kind": "rx", "words": [0x80000000, 0]}
    >>> _rx_judge([0x80000000, 0], p)["pass"]
    True
    >>> _rx_judge([0x40000000, 0], p)["verdict"]
    'word 1 bit 31 — got 0, want 1'
    >>> _rx_judge([], p)["verdict"]
    'no words yet — the machine has pushed nothing to the RX FIFO'
    >>> _rx_judge([0x80000000], p)["verdict"]
    '1 of 2 words in — keep watching'
    """
    want = prof["words"]
    got = list(seen or [])
    if not got:
        return {"pass": False, "verdict": "no words yet — the machine has pushed nothing to the RX FIFO"}
    for i in range(min(len(want), len(got))):
        g, w = got[i] & 0xFFFFFFFF, want[i] & 0xFFFFFFFF
        if g == w:
            continue
        for b in range(31, -1, -1):
            if ((g >> b) & 1) != ((w >> b) & 1):
                return {
                    "pass": False,
                    "verdict": f"word {i + 1} bit {b} — got {(g >> b) & 1}, want {(w >> b) & 1}",
                }
    if len(got) < len(want):
        return {"pass": False, "verdict": f"{len(got)} of {len(want)} words in — keep watching"}
    return {"pass": True, "verdict": ""}


_ROW_MAX = 32  # one row's clks: the instruction plus at most 31 delay (SPEC-4-3)

_ROW_DELAY = re.compile(r"\[(\d+)\]$")


def _given_front(lid: str, defn: dict[str, Any]) -> list[tuple[int, int, list[str]]]:
    """derive_level_front's given leg (C39's L6): the level's program is
    the only honest solution — no editor exists, nothing else can be
    authored — so the front is one point, model-verified through the
    goldens' own load timeline + stimulus (the rx judge must go green
    over the pushed words). The period axis is the analytic pre-stall
    loop period: each row costs 1 + its delay (the given class carries
    no jmp — the loop is the wrap, and the push-full stall that follows
    is steady-state, not the loop).
    """
    prof = defn["profile"]
    sms: list[dict[str, Any] | None] = defn["program"].get("sms") or [None, None, None, None]
    ref = defn.get("reference", {}).get("listing") or defn["program"]["listing"]
    if any(r.startswith("jmp") for r in ref):
        raise SystemExit(f"front {lid}: given class assumes a wrap loop (no jmp rows)")
    stimulus = defn.get("stimulus") or []
    w32 = gg_assemble(ref, sms[0], f"front:{lid}") + [0] * (32 - len(ref))
    rc = gg_run_case(w32, sms, stimulus, prof["pin"], True)
    v = _rx_judge(rc.get("rx", []), prof)
    if not v["pass"]:
        raise SystemExit(f"front {lid}: the given program does not pass its own profile — {v['verdict']}")
    period = sum(1 + (int(m.group(1)) if (m := _ROW_DELAY.search(r)) else 0) for r in ref)
    used = len([w for w in w32 if w])
    return [(used, period, ref)]


def _js_round_div(num: int, den: int) -> int:
    """Math.round(num/den) for non-negative ints — round-half-up, exactly
    the JS judge's duty arithmetic (Python's round() is banker's rounding
    and disagrees at the .5 boundaries; a mirror that diverges from the
    authority at a boundary tier is a wrong front).

    >>> _js_round_div(100, 8)  # 12.5: Math.round says 13, round() says 12
    13
    >>> _js_round_div(300, 8)  # 37.5 -> 38
    38
    >>> _js_round_div(37 * 100, 64)  # 57.8125 -> 58
    58
    """
    return (2 * num + den) // (2 * den)


def _split_rows(clks: int) -> list[int]:
    """The minimal delays covering `clks` ticks of one pin level: full
    [31]s then the remainder (each row is 1+delay clks, delay 0..31 —
    SPEC-4-3's 5-bit budget).

    >>> _split_rows(1), _split_rows(16), _split_rows(32), _split_rows(48)
    ([0], [15], [31], [31, 15])
    >>> len(_split_rows(64))
    2
    """
    if clks < 1:
        raise ValueError("a pin-level run is at least one clk")
    full, rem = divmod(clks, _ROW_MAX)
    return [31] * full + ([rem - 1] if rem else [])


def _set_rows(val: int, delays: Sequence[int]) -> list[str]:
    """Canonical set rows for one pin-level run."""
    return [f"set pins, {val} [{d}]" if d else f"set pins, {val}" for d in delays]


def _square_judge(bits: str, tp: dict[str, int]) -> dict[str, Any]:
    """The Python mirror of web/levels.js squareJudge — the JS gate stays
    the authority (it replays the committed goldens); this mirror exists
    so the front search can judge candidates without a browser. Same
    semantics: rising edges -> periods -> duty, the `stable` tail within
    the tier's bounds, `minPeriods` completed periods first.

    >>> t = {"periodLo": 2, "periodHi": 2, "dutyLoPct": 40, "dutyHiPct": 60, "minPeriods": 2, "stable": 2}
    >>> _square_judge("0010101010", t)["pass"]
    True
    >>> _square_judge("0010000000", t)["verdict"]
    '1 rising edge — keep watching'
    >>> _square_judge("001010110110110", t)["verdict"]
    'period 3 clk — outside (2..2 clk)'
    """
    rising = [k for k in range(1, len(bits)) if bits[k - 1] == "0" and bits[k] == "1"]
    cycles = []
    for i in range(1, len(rising)):
        period = rising[i] - rising[i - 1]
        hi = sum(1 for k in range(rising[i - 1], rising[i]) if bits[k] == "1")
        cycles.append((period, _js_round_div(100 * hi, period)))
    if not rising:
        return {"pass": False, "verdict": "no blink yet — the pin never rose", "period": None}
    if len(cycles) < tp["minPeriods"]:
        return {
            "pass": False,
            "verdict": f"{len(rising)} rising edge{'s' if len(rising) != 1 else ''} — keep watching",
            "period": None,
        }
    last = cycles[-tp["stable"] :]
    for p, _duty in last:
        if not tp["periodLo"] <= p <= tp["periodHi"]:
            return {
                "pass": False,
                "verdict": f"period {p} clk — outside ({tp['periodLo']}..{tp['periodHi']} clk)",
                "period": p,
            }
    for p, duty in last:
        if not tp["dutyLoPct"] <= duty <= tp["dutyHiPct"]:
            return {
                "pass": False,
                "verdict": f"duty {duty}% — outside ({tp['dutyLoPct']}..{tp['dutyHiPct']}%)",
                "period": p,
            }
    return {"pass": True, "verdict": "", "period": last[-1][0]}


def _wrap_listings(tp: dict[str, int], max_words: int) -> Iterator[tuple[int, int, list[str]]]:
    """Every minimal-words whole-listing wrap loop per (period, duty) the
    tier accepts: alternating hi/lo runs of set rows, each run packed to
    [31]s (extra same-value runs or jmp rows only add words or hide time
    — always dominated). -> (words, predicted period, listing)."""
    for period in range(max(2, tp["periodLo"]), tp["periodHi"] + 1):
        for hi in range(1, period):
            duty = _js_round_div(100 * hi, period)
            if not tp["dutyLoPct"] <= duty <= tp["dutyHiPct"]:
                continue
            rows = _set_rows(1, _split_rows(hi)) + _set_rows(0, _split_rows(period - hi))
            if len(rows) > max_words:
                continue
            yield len(rows), period, rows


def _prefix_listings(tp: dict[str, int], max_words: int, prefix: list[str]) -> Iterator[tuple[int, int, list[str]]]:
    """L3's class: the boot's first row kept verbatim (the preamble runs
    once), a loop of hi/lo set rows above it closed by a jmp back edge —
    the jmp's own 1+delay clks hold the loop's last pin level. Both loop
    orders enumerate (ends-low and ends-high: the jmp's clks count toward
    whichever level it holds). -> (words, predicted period, listing)."""
    entry = len(prefix)
    for period in range(max(2, tp["periodLo"]), tp["periodHi"] + 1):
        for hi in range(1, period):
            hi_rows = _set_rows(1, _split_rows(hi))
            for lo in range(1, period - hi):
                d = period - hi - lo - 1  # the jmp row's delay
                if not 0 <= d <= 31:
                    continue
                for ends_low in (True, False):
                    eff_hi = hi if ends_low else hi + 1 + d
                    duty = _js_round_div(100 * eff_hi, period)
                    if not tp["dutyLoPct"] <= duty <= tp["dutyHiPct"]:
                        continue
                    lo_rows = _set_rows(0, _split_rows(lo))
                    jmp = f"jmp {entry} [{d}]" if d else f"jmp {entry}"
                    loop = (hi_rows + lo_rows + [jmp]) if ends_low else (lo_rows + hi_rows + [jmp])
                    rows = list(prefix) + loop
                    if len(rows) > max_words:
                        continue
                    yield len(rows), period, rows


_SET_ROW = re.compile(r"^set pins, ([01])(?: \[(\d+)\])?$")
_JMP_ROW = re.compile(r"^jmp (\d+)$")


def _perm_points(listing: list[str], wrap_top: int) -> Iterator[tuple[int, int | None, list[str]]]:
    """L4's class: the given rows in every order (the vocabulary is
    fixed, the order is the whole task) with the analytic steady-loop
    (period, duty) each order draws, under the chapter-1 timing rules:
    a row with delay d costs 1+d clks; the jmp row at position j with
    target t costs 1 clk holding the level of the row before it, leaves
    rows 0..t-1 as once-preamble, loops rows t..j, and strands rows
    j+1.. as dead; a jmp on its own target parks (the wave never cycles
    again); a jmp at position 0 forward-jumps and the pinned wrap
    (WRAP_BOTTOM 0) closes the loop over rows t..wrap_top and 0..j.
    -> (period, dutyPct, listing); duty None = never-cycles (never a
    pass; not worth a model run).

    >>> rows = ["set pins, 1 [7]", "set pins, 1 [1]", "set pins, 0 [1]",
    ...         "set pins, 0 [2]", "jmp 1"]
    >>> pts = {(p, d) for p, d, _ in _perm_points(rows, 4)}
    >>> (8, 25) in pts   # the reference: flash once, then the 1:3 blink
    True
    >>> (14, 57) in pts  # the boot: the flash trapped inside the loop
    True
    >>> (9, 33) in pts   # a 9-clk order exists? no — 1+1+1+2 delays and
    ...                  # the jmp make every full-loop order sum to 8 or 14
    False
    """
    parts: list[tuple[str, int | None, int]] = []  # (kind, pin level, delay)
    tgt = -1
    for row in listing:
        m = _SET_ROW.match(row)
        if m:
            parts.append(("set", int(m.group(1)), int(m.group(2) or 0)))
            continue
        m = _JMP_ROW.match(row)
        if m:
            parts.append(("jmp", None, 0))
            tgt = int(m.group(1))
            continue
        raise SystemExit(f"scramble front: unparseable row {row!r}")
    if not any(k == "jmp" for k, _v, _d in parts):
        raise SystemExit("scramble front: no jmp row in the vocabulary")
    if sum(1 for k, _v, _d in parts if k == "jmp") != 1:
        raise SystemExit("scramble front: the vocabulary needs exactly one jmp row")
    for perm in itertools.permutations(range(len(parts))):
        rows = [parts[i] for i in perm]
        j = next(i for i, r in enumerate(rows) if r[0] == "jmp")
        if j > wrap_top:
            raise SystemExit("scramble front: the jmp row parked beyond WRAP_TOP never runs")
        # the loop's row indexes and the row that precedes the jmp in
        # execution (whose level the jmp's clk holds)
        if tgt == j:
            continue  # a jmp on its own target: park, the wave is over
        if tgt < j:
            loop = list(range(tgt, j))
            prev = j - 1
        else:  # forward jump: the wrap (WRAP_BOTTOM 0) closes the loop
            loop = list(range(tgt, wrap_top + 1)) + list(range(j))
            prev = j - 1 if j > 0 else wrap_top
        period = sum(1 + rows[i][2] for i in loop) + 1
        hi = sum(1 + rows[i][2] for i in loop if rows[i][1] == 1) + (1 if rows[prev][1] == 1 else 0)
        yield period, _js_round_div(100 * hi, period), [listing[i] for i in perm]


def _scramble_front(lid: str, defn: dict[str, Any]) -> list[tuple[int, int, list[str]]]:
    """derive_level_front's scramble leg: every order of the GIVEN rows,
    deduped by analytic (period, duty) — the judge's verdict depends on
    exactly those two numbers over the steady loop — then each distinct
    point model-verified through the goldens' own load timeline, the
    same discipline as the analytic classes (prediction mismatch raises).
    """
    prof = defn["profile"]
    tp = prof["tiers"][prof["tier"]]
    sms: list[dict[str, Any] | None] = defn["program"].get("sms") or [None, None, None, None]
    ex = (sms[0] or {}).get("execctrl", {})
    wrap_top = ex.get("wrapTop", 31)
    if ex.get("wrapBot", 0) != 0:
        raise SystemExit(f"front {lid}: scramble class needs WRAP_BOTTOM 0")
    words = len(defn["program"]["listing"])
    seen: dict[tuple[int, int], list[str]] = {}
    for period, duty, lst in _perm_points(defn["program"]["listing"], wrap_top):
        if duty is None:
            continue  # a park or a flat loop — the wave never cycles
        seen.setdefault((period, duty), lst)
    evs: list[Evaluated] = []
    listings: dict[tuple[int, int], list[str]] = {}
    for (period, _duty), lst in sorted(seen.items()):
        w32 = gg_assemble(lst, sms[0], f"front:{lid}") + [0] * (32 - len(lst))
        series = gg_pin_series(w32, sms, prof["pin"])
        win = defn.get("waveWin", 128)
        v_full = _square_judge(series, tp)
        v_win = _square_judge(series[-win:], tp)
        if not (v_full["pass"] and v_win["pass"]):
            continue
        if v_full["period"] != period:
            raise SystemExit(f"front {lid}: {lst} predicted period {period}, the model says {v_full['period']}")
        evs.append(
            Evaluated(
                cand=_cand(tuple(w32[:words]), 0, tuple(range(words)), ()),
                screen=Screening(ok=True, div=None),
                period=period,
            )
        )
        listings[(words, period)] = lst
    front = sorted(pareto_front(evs), key=lambda e: (len(e.cand.words), e.period or 0))
    return [(len(e.cand.words), e.period or 0, listings[(len(e.cand.words), e.period or 0)]) for e in front]


def derive_level_front(lid: str, defn: dict[str, Any]) -> list[tuple[int, int, list[str]]]:
    """One level's verified Pareto front: enumerate the class's
    minimal-words candidates per (period, duty), run each DISTINCT
    (words, period) point through the goldens' own load timeline
    (pio_model, gen_level_goldens.pin_series), judge with the level's
    active tier over the full series AND the waveWin window (the browser
    judges the window — both must pass), then pareto_front on
    (words, period). A candidate whose model period disagrees with the
    prediction raises: the analytic enumeration and the model must never
    drift apart silently. -> sorted [(words, period, champion listing)].
    """
    kind = FRONT_CLASS[lid]
    if kind == "scramble":
        return _scramble_front(lid, defn)
    if kind == "given":
        return _given_front(lid, defn)
    prof = defn["profile"]
    tp = prof["tiers"][prof["tier"]]
    sms: list[dict[str, Any] | None] = defn["program"].get("sms") or [None, None, None, None]
    wrap_top = (sms[0] or {}).get("execctrl", {}).get("wrapTop", 31)
    max_words = wrap_top + 1  # the pinned wrap caps the live rows
    prefix = defn["program"]["listing"][:1] if kind == "prefix" else []
    enum = _prefix_listings(tp, max_words, prefix) if kind == "prefix" else _wrap_listings(tp, max_words)

    seen: dict[tuple[int, int], list[str]] = {}
    for words, period, listing in enum:
        seen.setdefault((words, period), listing)
    evs: list[Evaluated] = []
    listings: dict[tuple[int, int], list[str]] = {}
    for (words, period), listing in sorted(seen.items()):
        w32 = gg_assemble(listing, sms[0], f"front:{lid}") + [0] * (32 - len(listing))
        series = gg_pin_series(w32, sms, prof["pin"])
        win = defn.get("waveWin", 128)
        v_full = _square_judge(series, tp)
        v_win = _square_judge(series[-win:], tp)
        if not (v_full["pass"] and v_win["pass"]):
            continue  # the analytic point is not a real solution — drop it
        if v_full["period"] != period:
            raise SystemExit(f"front {lid}: {listing} predicted period {period}, the model says {v_full['period']}")
        # the candidate carries the UNPADDED image so pareto_front's word
        # axis counts rows, not the 32-slot mirror
        evs.append(
            Evaluated(
                cand=_cand(tuple(w32[:words]), 0, tuple(range(words)), ()),
                screen=Screening(ok=True, div=None),
                period=period,
            )
        )
        listings[(words, period)] = listing
    front = sorted(pareto_front(evs), key=lambda e: (len(e.cand.words), e.period or 0))
    return [(len(e.cand.words), e.period or 0, listings[(len(e.cand.words), e.period or 0)]) for e in front]


def level_front_report(repo: Path = REPO) -> dict[str, list[tuple[int, int, list[str]]]]:
    """Every level's derived front (id -> sorted (words, period, listing))."""
    out: dict[str, list[tuple[int, int, list[str]]]] = {}
    for path in sorted((repo / "web" / "levels").glob("*.js")):
        lid, defn = gg_parse_level_file(path)
        if lid not in FRONT_CLASS:
            raise SystemExit(f"{lid}: no FRONT_CLASS entry — every level's par needs its honest solution space")
        out[lid] = derive_level_front(lid, defn)
    return out


def level_front_checks(repo: Path = REPO) -> list[tuple[str, bool]]:
    """The C36 par drift gate: every level's committed reference.par must
    equal the derived front's champion (fewest words, then fewest clks),
    and the committed reference solution must pass its own profile within
    par on both axes. The red side runs in-process: a tampered par (one
    word too generous) must be flagged — a check that only ever passed
    may be vacuous.
    """
    checks: list[tuple[str, bool]] = []
    fronts = level_front_report(repo)
    for lid, front in sorted(fronts.items()):
        _, defn = gg_parse_level_file(repo / "web" / "levels" / f"{lid}.js")
        par = defn["reference"]["par"]
        champion = (front[0][0], front[0][1]) if front else None
        checks.append((f"front-{lid}-par", champion == (par["words"], par["period"])))
        prof = defn["profile"]
        tp = prof.get("tiers", {}).get(prof.get("tier"), {"periodLo": 0, "periodHi": 0})
        sms: list[dict[str, Any] | None] = defn["program"].get("sms") or [None, None, None, None]
        ref = defn.get("reference", {}).get("listing") or defn["program"]["listing"]
        w32 = gg_assemble(ref, sms[0], f"ref:{lid}") + [0] * (32 - len(ref))
        used = len([w for w in w32 if w])
        if prof["kind"] == "rx":
            # C39: the reading levels' reference leg — the rx judge over
            # the model's pushed words (the same replay the gate commits)
            rc = gg_run_case(w32, sms, defn.get("stimulus") or [], prof["pin"], True)
            v_rx = _rx_judge(rc.get("rx", []), prof)
            checks.append((f"front-{lid}-reference", bool(v_rx["pass"]) and used <= par["words"]))
            continue
        v = _square_judge(gg_pin_series(w32, sms, prof["pin"]), tp)
        checks.append(
            (
                f"front-{lid}-reference",
                bool(v["pass"]) and used <= par["words"] and (v["period"] or 0) <= par["period"],
            )
        )
    # the red side: one word of slack must be flagged as drift
    if fronts:
        lid = min(fronts)
        front = fronts[lid]
        champion = (front[0][0], front[0][1]) if front else None
        tampered = (champion[0] + 1, champion[1]) if champion else (0, 0)
        checks.append((f"front-{lid}-red-tampered", champion != tampered))
    return checks


# ---------------------------------------------------------------------------
# Self-test (make hyperopt): hermetic + end-to-end.
# ---------------------------------------------------------------------------


def _mini_ctx(words: Sequence[int], execctrl: int, feeds: Sequence[tuple[int, int]] = (), nclk: int = 48) -> SeedCtx:
    """A synthetic seed: no sideset, plain schedule (load, EXECCTRL,
    enable, idle), optional (clk, word) TXF0 feeds."""
    s = stim.Schedule()
    s.load_imem(list(words))
    s.w(stim.A_SM0 + 4 * 1, execctrl)
    s.enable()
    feed_points = dict(feeds)
    for k in range(nclk):
        if k in feed_points:
            s.feed(feed_points[k])
        else:
            s.idle()
    trace = difftest.run_model_trace(s)
    has_dyn_pc = any(
        (d["is_out"] and d.get("out_dst") == E.OUTD_PC) or (d["is_mov"] and d.get("mov_dst") == E.MOVD_PC)
        for d in (E.decode(w) for w in words)
    )
    return SeedCtx(
        name="mini",
        words=tuple(words),
        execctrl=execctrl,
        sched=s,
        entry=None,
        side_en=False,
        ss_total=0,
        has_dyn_pc=has_dyn_pc,
        visited=frozenset(_visited_pcs(s)),
        trace=trace,
        period=trace_period(trace),
    )


def _self_test_hermetic() -> list[tuple[str, bool]]:
    checks: list[tuple[str, bool]] = []
    set1, set0, nop = 0xE101, 0xE100, 0xA042  # set pins,1 [1] / set pins,0 [1] / nop

    # -- fold_tick: `nop [2]` folded into the predecessor's delay field.
    ctx = _mini_ctx([set1, nop | (2 << 8), set0], 0x2000)  # wrap 2->0
    outs = rw_fold_tick(ctx, _cand(ctx.words, ctx.execctrl, (0, 1, 2), ()))
    checks.append(("fold-fires", len(outs) == 1))
    if outs:
        folded = outs[0]
        checks.append(
            ("fold-word", folded.words == ((set1 & ~0x1F00) | (4 << 8), set0) and (folded.execctrl >> 12) & 0x1F == 1)
        )
        checks.append(("fold-green", screen(ctx, folded)["ok"]))
        # red: the same deletion WITHOUT the delay compensation diverges.
        uncomp = _cand([set1, set0], 0x1000, (0, 2), ())
        checks.append(("fold-red-uncompensated", not screen(ctx, uncomp)["ok"]))

    # -- wrap_fold: the terminal backward jmp becomes the free wrap, its
    # tick folded into the predecessor.
    ctx = _mini_ctx([set1, set0, 0x0000], 0x2000)  # ...; jmp 0
    outs = rw_wrap_fold(ctx, _cand(ctx.words, ctx.execctrl, (0, 1, 2), ()))
    checks.append(("wrap-fires", len(outs) == 1))
    if outs:
        wf = outs[0]
        checks.append(("wrap-word", wf.words == (set1, (set0 & ~0x1F00) | (2 << 8))))
        checks.append(("wrap-overlay", (wf.execctrl >> 12) & 0x1F == 1 and (wf.execctrl >> 7) & 0x1F == 0))
        checks.append(("wrap-green", screen(ctx, wf)["ok"]))
        checks.append(("wrap-prefilter", miter_prefilter(ctx, wf, 24, 4, 1) is None))
        # red: wrap_speed (no compensation) diverges under trace-eq —
        # the honest spec-only demo.
        ws = _cand([set1, set0], 0x1000, (0, 1), ())
        checks.append(("wrap-speed-red", not screen(ctx, ws)["ok"]))

    # -- dce: the never-executed tail word compacts out.
    ctx = _mini_ctx([set1, 0x0000, set0], 0x1000)  # wrap 1->0; word 2 dead
    outs = rw_dce(ctx, _cand(ctx.words, ctx.execctrl, (0, 1, 2), ()))
    checks.append(("dce-fires", len(outs) == 1))
    if outs:
        checks.append(("dce-word", outs[0].words == (set1, 0x0000) and (outs[0].execctrl >> 12) & 0x1F == 1))
        checks.append(("dce-green", screen(ctx, outs[0])["ok"]))

    # -- mov_not_fold: mov x,~y; mov isr,~x  ==>  mov isr, y (x dead).
    mx = E.encode_mov("x", "y", E.MOP_INV)
    misr = E.encode_mov("isr", "x", E.MOP_INV)
    push = E.encode_push(False, True)
    ctx = _mini_ctx([push, mx, misr, push], 0x3000)
    outs = rw_mov_not_fold(ctx, _cand(ctx.words, ctx.execctrl, (0, 1, 2, 3), ()))
    checks.append(("mnf-fires", len(outs) == 1))
    if outs:
        checks.append(("mnf-word", outs[0].words[1] == E.encode_mov("isr", "y", E.MOP_NONE)))
        checks.append(("mnf-green", screen(ctx, outs[0])["ok"]))
    # blocked when x stays live after the pair (a later reader).
    ctx2 = _mini_ctx([push, mx, misr, push, E.encode_mov("isr", "x", E.MOP_NONE)], 0x4000)
    checks.append(
        ("mnf-blocked-live", rw_mov_not_fold(ctx2, _cand(ctx2.words, ctx2.execctrl, tuple(range(5)), ())) == [])
    )

    # -- delay_absorb: spec-only — the stripped delay shifts timing even
    # though every execution stalled past it first (CC-22 gate met).
    ctx = _mini_ctx([E.encode_pull(False, True, 2), set1], 0x1000, feeds=[(20, 0xAA)])
    outs = rw_delay_absorb(ctx, _cand(ctx.words, ctx.execctrl, (0, 1), ()))
    checks.append(("dabs-fires", len(outs) == 1))
    if outs:
        checks.append(("dabs-spec-only-red", not screen(ctx, outs[0])["ok"]))

    # -- sideset_fuse / autopull: overlay-locked entries stay inert in
    # the search but keep their catalog tags and citations.
    checks.append(
        (
            "overlay-locked-tags",
            catalog_rewrite("sideset_fuse")["needs"] == "pinctrl"
            and catalog_rewrite("autopull")["needs"] == "shiftctrl"
            and "CC-11" in catalog_rewrite("autopull")["cites"],
        )
    )

    # -- search + Pareto: closure over the mini program; the front picks
    # the smallest word count at the unchanged period, all green.
    ctx = _mini_ctx([set1, nop | (2 << 8), set0, 0x0000], 0x3000)  # ...; jmp 0
    opts = SearchOpts(include_spec=False, max_states=64, tries=0, rng_seed=1)
    states, capped = search(ctx, opts)
    evs = [evaluate(ctx, c) for c in states]
    good = [e for e in evs if e.screen["ok"]]
    front = pareto_front(good)
    checks.append(("search-closure", not capped and len(states) >= 4))
    checks.append(("search-all-green", len(good) == len(evs)))
    checks.append(("search-front-min", bool(front) and min(len(e.cand.words) for e in front) == 2))
    if front:
        best = min(front, key=lambda e: len(e.cand.words))
        checks.append(("search-front-period", best.period == ctx.period))

    # -- tamper: the unsound rewrite is caught by the pre-filter.
    ctx = _mini_ctx([set1, set0], 0x1000)
    tampered = tamper_delay(ctx, _cand(ctx.words, ctx.execctrl, (0, 1), ()))[0]
    checks.append(("tamper-word", tampered.words == ((set1 & ~0x1F00) | (2 << 8), set0)))
    checks.append(("tamper-prefilter-red", miter_prefilter(ctx, tampered, 24, 4, 1) is not None))

    # -- trace_period on the real squarewave conformance seed.
    checks.append(("squarewave-period", load_seed("squarewave").period == 4))
    return checks


def self_test() -> int:
    checks = _self_test_hermetic()
    # C36: the level par fronts re-derive and match the committed numbers
    # (needs only pio_model + the repo's level files — no sby)
    checks += level_front_checks()
    if HE.toolchain() is None:
        print("no sby on PATH and no vibe-pio container image — end-to-end cases cannot run")
        for name, _ in checks:
            print(f"  ??  {name}")
        return HE.EXIT_CODES["ERROR"]
    # e2e 1: a wrap_fold output certified PASS through the overlay miter.
    set1, set0 = 0xE101, 0xE100
    ctx = _mini_ctx([set1, set0, 0x0000], 0x2000)
    wf = rw_wrap_fold(ctx, _cand(ctx.words, ctx.execctrl, (0, 1, 2), ()))[0]
    v = certify(ctx, wf, 16, seed=1, timeout=1800, tag="hyp_st_wrap")
    checks.append(("e2e-wrap-fold-certified", v["kind"] == "PASS"))
    # e2e 2: the delay tamper FAILed by sby itself (pre-filter off) with
    # a decoded counterexample.
    ctx = _mini_ctx([set1, set0], 0x1000)
    tp = tamper_delay(ctx, _cand(ctx.words, ctx.execctrl, (0, 1), ()))[0]
    pair = HE.ProgPair(ctx.words, tp.words, ctx.execctrl)
    v = HE.check_pair(pair, 16, seed=1, rounds=0, prefilter_on=False, timeout=1800, tag="hyp_st_tamper", keep=False)
    dec = [ln for ln in v["lines"] if "divergence at clk" in ln]
    checks.append(("e2e-tamper-sby-red", v["kind"] == "FAIL" and bool(dec)))
    for tag in ("hyp_st_wrap", "hyp_st_tamper"):
        HE._rm_tree(HE.BUILD / "equiv" / tag)  # noqa: SLF001 — gate leaves nothing behind
    ok = True
    for name, res in checks:
        print(f"  {'ok  ' if res else 'FAIL'} {name}")
        ok = ok and res
    print("self-test passed" if ok else "self-test FAILED")
    return 0 if ok else 1


# ---------------------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="C14 hyperoptimizer (see module docstring)")
    ap.add_argument("--seed", default=None, help="conformance case name, 'list', or 'all'")
    ap.add_argument("--horizon", type=int, default=40, help="certification BMC depth (SPEC-16-3)")
    ap.add_argument("--tries", type=int, default=16, help="stochastic walks when the closure cap trips")
    ap.add_argument("--max-states", type=int, default=512, help="closure state cap")
    ap.add_argument("--include-spec", action="store_true", help="also search spec-only rewrites (uncertified)")
    ap.add_argument("--no-certify", action="store_true", help="skip the sby certification runs")
    ap.add_argument("--timeout", type=int, default=600, help="per-case sby wall-clock seconds")
    ap.add_argument("--rng", type=int, default=1, help="search RNG seed")
    ap.add_argument("--self-test", action="store_true", help="run the committed self-test suite")
    ap.add_argument(
        "--level-fronts",
        action="store_true",
        help="C36: derive every level's par front and check the committed numbers (no sby needed)",
    )
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()
    if args.level_fronts:
        ok = True
        for lid, front in sorted(level_front_report().items()):
            par = gg_parse_level_file(REPO / "web" / "levels" / f"{lid}.js")[1]["reference"]["par"]
            match = bool(front) and (front[0][0], front[0][1]) == (par["words"], par["period"])
            ok = ok and match
            points = " ".join(f"{w}w/{p}clk" for w, p, _ in front)
            print(f"  {'ok  ' if match else 'DRIFT'} {lid}: front [{points}] vs par {par['words']}w/{par['period']}clk")
            for _w, _p, listing in front[:1]:
                print(f"        champion: {' | '.join(listing)}")
        return 0 if ok else 1
    if args.seed is None or args.seed == "list":
        print("conformance seeds:", " ".join(sorted(SEED_TABLE)))
        return 0
    if args.seed != "all" and args.seed not in SEED_TABLE:
        print(f"ERROR: unknown seed {args.seed!r} (see --seed list)")
        return HE.EXIT_CODES["ERROR"]
    names = sorted(SEED_TABLE) if args.seed == "all" else [args.seed]
    opts = SearchOpts(
        include_spec=args.include_spec,
        max_states=args.max_states,
        tries=args.tries,
        rng_seed=args.rng,
    )
    for name in names:
        run_seed(load_seed(name), args.horizon, opts, certify_on=not args.no_certify, timeout=args.timeout)
    return 0


if __name__ == "__main__":
    sys.exit(main())

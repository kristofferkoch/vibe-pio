"""C14 hyperoptimizer units: one committed regression case per catalog
rewrite (green = model trace-equal on the seed schedule; red = the
compensation re-injected-out, or the rewrite's known divergence), plus
the search / Pareto / period / schedule-rebuild machinery. Hermetic —
synthetic programs only; the sbacked end-to-end certifications are the
`make hyperopt` gate (tools/hyperopt.py --self-test)."""

import hyperopt as H
import pytest
from pio_model import encoding as E
from pio_model import tracefmt

SET1, SET0, NOP = 0xE101, 0xE100, 0xA042  # set pins,1 [1] / set pins,0 [1] / nop
PUSH = E.encode_push(False, True)


def _ctx(words, execctrl, feeds=()):
    return H._mini_ctx(words, execctrl, feeds=feeds)


def _start(ctx):
    return H._cand(ctx.words, ctx.execctrl, tuple(range(len(ctx.words))), ())


# -- fold_tick (trace-eq; SPEC-3.6-10, SPEC-4-3, CC-10, CC-22) ----------


def test_fold_tick_fires_and_transforms() -> None:
    ctx = _ctx([SET1, NOP | (2 << 8), SET0], 0x2000)  # set; nop [2]; set
    outs = H.rw_fold_tick(ctx, _start(ctx))
    assert len(outs) == 1
    f = outs[0]
    assert f.words == ((SET1 & ~0x1F00) | (4 << 8), SET0)  # 1 + 1 + 2 delay
    assert (f.execctrl >> 12) & 0x1F == 1  # wrap_top relocated


def test_fold_tick_green() -> None:
    ctx = _ctx([SET1, NOP | (2 << 8), SET0], 0x2000)
    assert H.screen(ctx, H.rw_fold_tick(ctx, _start(ctx))[0])["ok"]


def test_fold_tick_red_uncompensated() -> None:
    # Re-injected defect: the same deletion WITHOUT folding the burned
    # ticks into the predecessor's delay — 3 ticks vanish per loop.
    ctx = _ctx([SET1, NOP | (2 << 8), SET0], 0x2000)
    uncomp = H._cand([SET1, SET0], 0x1000, (0, 2), ())
    assert not H.screen(ctx, uncomp)["ok"]


def test_fold_tick_blocked_when_jump_targets_the_burner() -> None:
    # The nop is the loop head (jmp 1 enters it on every iteration), so
    # it has no unique fall-through in-edge.
    ctx = _ctx([SET1, NOP | (2 << 8), SET0, 0x0001], 0x3000)  # jmp 1
    sites = [c for c in H.rw_fold_tick(ctx, _start(ctx)) if c.trail and c.trail[0][1] == 1]
    assert sites == []


def test_fold_tick_blocked_when_predecessor_branches() -> None:
    # Predecessor is a conditional jmp: the folded delay would also
    # apply on the taken path, where the nop never executes.
    ctx = _ctx([E.encode_jmp("!x", 2), SET0, NOP], 0x2000)
    assert H.rw_fold_tick(ctx, _start(ctx)) == []


# -- wrap_fold (trace-eq; SPEC-8-2, CC-10, SPEC-16-8) --------------------


def test_wrap_fold_fires_and_transforms() -> None:
    ctx = _ctx([SET1, SET0, 0x0000], 0x2000)  # ...; jmp 0
    outs = H.rw_wrap_fold(ctx, _start(ctx))
    assert len(outs) == 1
    wf = outs[0]
    assert wf.words == (SET1, (SET0 & ~0x1F00) | (2 << 8))  # jmp's tick folded
    assert (wf.execctrl >> 12) & 0x1F == 1  # wrap_top = the old predecessor
    assert (wf.execctrl >> 7) & 0x1F == 0  # wrap_bottom = the jmp target


def test_wrap_fold_green_and_miter_clean() -> None:
    ctx = _ctx([SET1, SET0, 0x0000], 0x2000)
    wf = H.rw_wrap_fold(ctx, _start(ctx))[0]
    assert H.screen(ctx, wf)["ok"]
    assert H.miter_prefilter(ctx, wf, 24, 4, 1) is None


def test_wrap_fold_red_uncompensated() -> None:
    # wrap_speed's output (the same rewrite without the delay
    # compensation): one tick faster per iteration — the honest spec-only
    # divergence, certification awaits C15.
    ctx = _ctx([SET1, SET0, 0x0000], 0x2000)
    ws = H._cand([SET1, SET0], 0x1000, (0, 1), ())
    assert not H.screen(ctx, ws)["ok"]


def test_wrap_fold_blocked_conditional() -> None:
    jmp_x = E.encode_jmp("x--", 0)
    ctx = _ctx([SET1, SET0, jmp_x], 0x2000)
    assert H.rw_wrap_fold(ctx, _start(ctx)) == []


def test_wrap_fold_blocked_when_wrap_top_not_last() -> None:
    # .wrap sits below the terminal jmp: moving wrap_top would change
    # flow at the old wrap point.
    ctx = _ctx([SET1, SET0, 0x0000], 0x1000)  # wrap_top = 1, jmp at 2
    assert H.rw_wrap_fold(ctx, _start(ctx)) == []


# -- dce (trace-eq within the stimulus horizon; SPEC-8-4, SPEC-16-3) -----


def test_dce_fires_and_transforms() -> None:
    ctx = _ctx([SET1, 0x0000, SET0], 0x1000)  # set; jmp 0; (dead) set
    outs = H.rw_dce(ctx, _start(ctx))
    assert len(outs) == 1
    assert outs[0].words == (SET1, 0x0000)
    assert H.screen(ctx, outs[0])["ok"]


def test_dce_blocked_when_pc_written_dynamically() -> None:
    # quadrature_encoder-style dispatch: MOV PC makes static relocation
    # of jump targets impossible.
    ctx = _ctx([E.encode_mov("pc", "isr", E.MOP_NONE), SET1, SET0], 0x2000)
    assert ctx.has_dyn_pc
    assert H.rw_dce(ctx, _start(ctx)) == []


# -- mov_not_fold (trace-eq; SPEC-3.6-9) ---------------------------------


def test_mov_not_fold_fires_and_transforms() -> None:
    mx = E.encode_mov("x", "y", E.MOP_INV)
    misr = E.encode_mov("isr", "x", E.MOP_INV)
    ctx = _ctx([PUSH, mx, misr, PUSH], 0x3000)
    outs = H.rw_mov_not_fold(ctx, _start(ctx))
    assert len(outs) == 1
    assert outs[0].words[1] == E.encode_mov("isr", "y", E.MOP_NONE)  # u = ~(~y)
    assert H.screen(ctx, outs[0])["ok"]


def test_mov_not_fold_blocked_when_temp_stays_live() -> None:
    mx = E.encode_mov("x", "y", E.MOP_INV)
    misr = E.encode_mov("isr", "x", E.MOP_INV)
    reader = E.encode_mov("isr", "x", E.MOP_NONE)  # reads x after the pair
    ctx = _ctx([PUSH, mx, misr, PUSH, reader], 0x4000)
    assert H.rw_mov_not_fold(ctx, _start(ctx)) == []


def test_mov_not_fold_blocked_when_pair_is_a_jump_target() -> None:
    mx = E.encode_mov("x", "y", E.MOP_INV)
    misr = E.encode_mov("isr", "x", E.MOP_INV)
    jmp = E.encode_jmp(None, 2)  # jumps into the consumer
    ctx = _ctx([PUSH, mx, misr, PUSH, jmp], 0x4000)
    assert H.rw_mov_not_fold(ctx, _start(ctx)) == []


# -- spec-only entries ----------------------------------------------------


def test_wrap_speed_is_the_uncompensated_variant() -> None:
    # Fires only when the predecessor cannot absorb the folded ticks
    # (delay field full): then the jmp's removal is a pure speed win.
    big = (SET0 & ~0x1F00) | (31 << 8)  # delay 31 — no room to fold
    ctx = _ctx([SET1, big, 0x0000], 0x2000)
    outs = H.rw_wrap_speed(ctx, _start(ctx))
    assert len(outs) == 1
    assert outs[0].words == (SET1, big)
    assert not H.screen(ctx, outs[0])["ok"]  # 1 tick faster: diverges by design


def test_delay_absorb_fires_and_diverges() -> None:
    # CC-22 gate met (every execution stalls past the delay first), yet
    # stripping it shifts post-stall timing — spec-only by nature.
    pull2 = E.encode_pull(False, True, 2)
    ctx = _ctx([pull2, SET1], 0x1000, feeds=[(20, 0xAA)])
    outs = H.rw_delay_absorb(ctx, _start(ctx))
    assert len(outs) == 1
    assert outs[0].words == (E.encode_pull(False, True, 0), SET1)
    assert not H.screen(ctx, outs[0])["ok"]


def test_overlay_locked_entries_never_searched() -> None:
    # sideset_fuse (needs a PINCTRL overlay) and autopull (SHIFTCTRL)
    # stay catalog-only (SPEC-16-6): tagged, cited, inert.
    assert H.catalog_rewrite("sideset_fuse")["tag"] == "spec-only"
    assert H.catalog_rewrite("sideset_fuse")["needs"] == "pinctrl"
    assert H.catalog_rewrite("autopull")["needs"] == "shiftctrl"
    assert "SPEC-4-6" in H.catalog_rewrite("sideset_fuse")["cites"]
    assert H.rw_sideset_fuse(_ctx0(), _cand0()) == []
    assert H.rw_autopull(_ctx0(), _cand0()) == []
    ctx = _ctx([SET1, SET0], 0x1000)
    opts = H.SearchOpts(include_spec=True, max_states=64, tries=0, rng_seed=1)
    states, _ = H.search(ctx, opts)
    assert all(name not in {"sideset_fuse", "autopull"} for c in states for name, _site in c.trail)


# -- catalog integrity -----------------------------------------------------


def test_catalog_tags_and_citations() -> None:
    names = [r["name"] for r in H.CATALOG]
    assert names == [
        "fold_tick",
        "wrap_fold",
        "mov_not_fold",
        "dce",
        "wrap_speed",
        "delay_absorb",
        "sideset_fuse",
        "autopull",
    ]
    for r in H.CATALOG:
        assert r["tag"] in ("trace-eq", "spec-only")
        assert r["cites"]  # every entry cites its SPEC-/CC- facts


# -- search / Pareto / period / schedule rebuild ---------------------------


def test_search_closure_front_and_period() -> None:
    ctx = _ctx([SET1, NOP | (2 << 8), SET0, 0x0000], 0x3000)  # ...; jmp 0
    opts = H.SearchOpts(include_spec=False, max_states=64, tries=0, rng_seed=1)
    states, capped = H.search(ctx, opts)
    assert not capped
    assert len(states) >= 4
    evs = [H.evaluate(ctx, c) for c in states]
    assert all(e.screen["ok"] for e in evs)
    front = H.pareto_front(evs)
    best = min(front, key=lambda e: len(e.cand.words))
    assert len(best.cand.words) == 2  # fold_tick + wrap_fold compose
    assert best.period == ctx.period  # trace-eq: timing untouched


def test_pareto_front_dominance() -> None:
    evs = [
        H.Evaluated(H._cand([1, 2, 3], 0, (0, 1, 2)), H.Screening(ok=True, div=None), 8),
        H.Evaluated(H._cand([1, 2], 0, (0, 1)), H.Screening(ok=True, div=None), 8),  # dominates #1
        H.Evaluated(H._cand([1, 2], 0, (0, 1)), H.Screening(ok=True, div=None), 4),  # dominates both
    ]
    front = H.pareto_front(evs)
    assert len(front) == 1
    assert front[0].period == 4


def test_trace_period() -> None:
    assert H.trace_period([("G", k, k % 3, 0, 0) for k in range(30)]) == 3
    assert H.trace_period([("G", k, k, k, k) for k in range(30)]) is None


def test_rebuild_schedule_remaps_image_config_and_entry() -> None:
    ctx = _ctx([SET1, SET0], 0x1000)
    s = H.rebuild_schedule(
        ctx.sched,
        H._cand([0xE003], 0x0000, (0,)),
        0,
    )
    words = [c[4] for c in s.cycles if c[2] == 1 and 0x048 <= c[3] < 0x0C8]
    assert words[:1] == [0xE003]
    assert len(words) == 2  # tail write zeroed
    exec_w = [c[4] for c in s.cycles if c[2] == 1 and c[3] == 0x0CC]
    assert exec_w == [0]


def test_screen_rejects_deleted_entry() -> None:
    ctx = _ctx([SET1, SET0], 0x1000)
    ctx.entry = 1  # force point on the deleted word
    cand = H._cand([SET1], 0x0000, (0, -1), ())
    scr = H.screen(ctx, cand)
    assert not scr["ok"]
    assert "entry" in (scr["div"] or "")


# -- tamper (the intentionally unsound rewrite) -----------------------------


def test_tamper_caught_by_prefilter() -> None:
    ctx = _ctx([SET1, SET0], 0x1000)
    tampered = H.tamper_delay(ctx, _start(ctx))[0]
    assert tampered.words == ((SET1 & ~0x1F00) | (2 << 8), SET0)  # [1] -> [2]
    assert H.miter_prefilter(ctx, tampered, 24, 4, 1) is not None


def _ctx0():
    return _ctx([SET1, SET0], 0x1000)


def _cand0():
    ctx = _ctx0()
    return _start(ctx)


def test_certify_rejects_non_wrap_overlay() -> None:
    ctx = _ctx([SET1, SET0], 0x1000)
    stray = H._cand([SET1, SET0], 0x1000 | (1 << 24), (0, 1), ())  # jmp_pin differs
    v = H.certify(ctx, stray, 16, seed=1, timeout=60, tag="t_stray")
    assert v["kind"] == "ERROR"


def test_tracefmt_ec_mask_overlay() -> None:
    # The C12 comparison takes the pair's overlay mask (SPEC-16-8).
    recs_a = [("G", 0, 0, 0, 0), ("R", 0, 0x0CC, 0x00001234)]
    recs_b = [("G", 0, 0, 0, 0), ("R", 0, 0x0CC, 0x00005234)]  # wrap bits differ
    assert tracefmt.normalize(recs_a, 0x7FFE0FFF) == tracefmt.normalize(recs_b, 0x7FFE0FFF)
    assert tracefmt.normalize(recs_a) != tracefmt.normalize(recs_b)


def test_mini_ctx_fixture_sanity() -> None:
    ctx = _ctx([SET1, SET0], 0x1000)
    assert ctx.period == 4
    assert ctx.visited == {0, 1}
    assert not ctx.has_dyn_pc


def test_period_uses_observables_only() -> None:
    # The clk field never repeats; only the observable payload may.
    recs = [("G", k, 1, 0, 0) for k in range(20)]
    assert H.trace_period(recs) == 1


def test_delete_word_relocates_jumps_and_wrap() -> None:
    ctx = _ctx([E.encode_jmp(None, 1), SET0, NOP], 0x2000)
    cand = _start(ctx)
    assert H._delete_word(ctx, cand, 1) is None  # the jmp targets word 1
    assert H._delete_word(ctx, cand, 2) is None  # word 2 is wrap_top
    ctx2 = _ctx([E.encode_jmp(None, 3), SET1, SET0, NOP], 0x3000)
    out = H._delete_word(ctx2, _start(ctx2), 1)
    assert out is not None
    assert out.words[0] == E.encode_jmp(None, 2)  # target 3 -> 2
    assert (out.execctrl >> 12) & 0x1F == 2  # wrap_top 3 -> 2


@pytest.mark.parametrize(
    ("word", "expect"),
    [
        (NOP, 0),  # nop (SPEC-3.6-10)
        (E.encode_mov("x", "x", E.MOP_NONE), 0),  # mov x,x
        (E.encode_jmp(None, 0), None),  # jmp 0 at pc 0: self-loop, not to-next
        (E.encode_jmp("x--", 1), None),  # jmp-to-next but x-- writes x
        (E.encode_mov("x", "x", E.MOP_INV), None),  # mov x,~x changes x
    ],
)
def test_tick_burner_classification(word: int, expect: int | None) -> None:
    ctx = _ctx([word, SET0], 0x1000)
    assert H._tick_burner(ctx, ctx.words, 0) == expect

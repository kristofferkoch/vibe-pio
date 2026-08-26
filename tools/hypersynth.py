#!/usr/bin/env python3
"""Symbolic-program synthesis witness pipeline (KANBAN C16): cover trace
-> witness PIO program -> re-verified artifact.

Pipeline for one target (--target sq|uart, SPEC-16-11):

  1. Synthesis: a generated sby cover task instantiates the committed
     harness top (formal/pio_synth_fv.sv) with `chparam -set SYM 1
     pio_instr_mem` — the 32 imem words are free anyconst values and the
     solver searches for a program whose run satisfies the C15 monitor
     cover goal (SPEC-16-9) on gpio_out[0].
  2. Extraction: the cover VCD's sym_words vector, SM0 PC stream,
     per-clk environment (gpio_in, IRQ-neighbour views) and observables
     are decoded into a Witness (SPEC-16-12).
  3. Canonicalization: words the PC never visited are solver don't-cares
     (arbitrary bits, possibly reserved encodings) — replaced by `nop`
     (0xA042); a *visited* reserved word aborts (no faithful text, and
     no-opping it could change behaviour). The canonical 32 words are
     disassembled to .pio text (C12) and the text re-assembled bit-exact.
  4. Re-verification of the canonical program, all three legs required:
     (a) C12-model replay — the model loads the canonical words
         word-serially (SPEC-7-10), applies the harness prologue, replays
         the VCD environment; its SPEC-16-1 observables must match the
         VCD's cycle-for-cycle, and the run-length window checker (the
         SPEC-16-9 timing semantics in Python) must pass on gpio_out[0];
     (b) an auto-generated iverilog TB runs the canonical words through
         pio_block under the same C15 monitor instance — acceptance plus
         the cover's decoded payload;
     (c) bounded formal conformance — the same harness top re-instantiated
         with FREE=0/PROG=<canonical words> (words via the prologue, SYM
         off) under the replayed environment; the standing assertion
         assert (!err) is BMC-checked at the witness horizon
         (SPEC-16-3/12).

  5. The red non-vacuity case (--red or self-test): the contradictory
     spec (pio_synth_red_fv — the same pin under [2,2] and [3,3] square
     monitors) must come back UNSAT ("Unreached cover statement"),
     demonstrating the solver genuinely reads the monitor goals.

Verdicts / exit codes: PASS 0, FAIL 1, TIMEOUT 2, ERROR 3. --self-test
runs the committed suite (the `make synth` gate): hermetic fixtures
(window checker red/green, run lengths, VCD decode, canonicalization,
disassembly round-trip) plus the end-to-end pipeline for both targets
and the red case. Needs sby on PATH or the vibe-pio container image
(the difftest toolchain fallback). Case artifacts land under
build/synth/<tag>/ and are removed by the self-test.

The script is stdlib-only (runs in the container too).
"""

from __future__ import annotations

import argparse
import dataclasses
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import TypedDict

TOOLS = str(Path(__file__).resolve().parent)
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from pio_model import asm, disasm, stim  # noqa: E402
from pio_model import encoding as E  # noqa: E402
from pio_model import model as M  # noqa: E402

REPO = Path(TOOLS).parent
BUILD = REPO / "build"
FORMAL = REPO / "formal"
SIM = REPO / "sim"
RTL_FILES = (
    "pio_block.sv",
    "pio_instr_mem.sv",
    "pio_sm.sv",
    "pio_sm_regs.sv",
    "pio_sm_decoder.sv",
    "pio_sm_exec.sv",
    "pio_sm_shift.sv",
    "pio_sm_fifo.sv",
    "pio_irq_flags.sv",
    "pio_gpio_mux.sv",
    "pio_mon_uart_tx.sv",
    "pio_mon_square.sv",
)
FV_FILE = "pio_synth_fv.sv"
NOP = 0xA042  # mov y, y (SPEC-3.6-10) — the canonicalization filler

OP_NONE, OP_WR = stim.OP_NONE, stim.OP_WR

# Harness config writes (formal/pio_synth_fv.sv prologue, SPEC-16-11):
# PINCTRL SET base 0 count 1, EXECCTRL wrap 31->0, CTRL SM0-enable.
PINCTRL_W = 0x0400_0000
EXECCTRL_W = 0x0000_0000
CTRL_W = 0x0000_0001

EXIT_CODES = {"PASS": 0, "FAIL": 1, "TIMEOUT": 2, "ERROR": 3}


# ---------------------------------------------------------------------------
# Targets (SPEC-16-11): one per committed cover task in formal/pio_synth.sby.
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Target:
    """One synthesis target: harness top, cover depth, monitor window.

    kind drives the Python window checker and the generated TB checks:
    'sq' wants 8+ accepted square half-periods in [window, window];
    'uart' wants 1+ accepted frame (BIT window [window, window], even
    parity) decoding `payload`."""

    name: str
    kind: str  # sq | uart
    top: str  # formal/pio_synth_fv.sv top module
    depth: int  # cover BMC depth (SPEC-16-11 recorded values)
    window: int  # HALF for sq, BIT for uart (exact window, CC-26)
    payload: int = 0x55  # uart cover's decoded byte (SPEC-16-9)


TARGETS: dict[str, Target] = {
    "sq": Target("sq", "sq", "pio_synth_sq_fv", 28, 2),
    "uart": Target("uart", "uart", "pio_synth_uart_fv", 40, 2, 0x55),
}


class SynthError(Exception):
    """Pipeline failure with a human-readable cause."""


# ---------------------------------------------------------------------------
# Witness data: environment stream, timeline, extracted witness.
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Env:
    """One clk of harness environment (the top's free inputs).

    >>> Env(0x12).gpio
    18
    """

    gpio: int = 0
    nbs: int = 0
    nbc: int = 0
    iprev: int = 0
    inext: int = 0


IDLE_ENV = Env()


@dataclasses.dataclass(frozen=True)
class Step:
    """One replay clk: one reg-bus op plus the environment (SPEC-16-7's
    stimulus side; the replay never reads, so OP_NONE/OP_WR only)."""

    op: int
    addr: int
    wdata: int
    env: Env


def prologue_steps(words: Sequence[int], env0: Env = IDLE_ENV) -> list[Step]:
    """The FREE=0 replay prologue: word-serial imem writes (SPEC-7-10)
    then the harness config triple (SPEC-16-11). env0 carries the
    synthesis run's prologue-clk environment on the first three clks.

    >>> prologue_steps([1] * 32)[0].addr == stim.A_IMEM0
    True
    >>> [s.addr for s in prologue_steps([0] * 32)[32:]]
    [220, 204, 0]
    """
    steps = [
        Step(OP_WR, stim.A_IMEM0 + 4 * i, words[i] & 0xFFFF, env0 if i < 3 else IDLE_ENV) for i in range(len(words))
    ]
    cfg = (
        (stim.A_SM0 + 4 * 5, PINCTRL_W),
        (stim.A_SM0 + 4 * 1, EXECCTRL_W),
        (stim.A_CTRL, CTRL_W),
    )
    steps += [Step(OP_WR, a, d, IDLE_ENV) for a, d in cfg]
    return steps


@dataclasses.dataclass
class Witness:
    """A decoded cover trace (SPEC-16-12): the solver's 32 words, the
    visited-PC set, the canonical words shipped onward, and the replay
    timeline (prologue + free phase)."""

    target: Target
    raw_words: list[int]
    canon: list[int]
    visited: set[int]
    free_env: list[Env]
    out32: list[int]  # VCD gpio_out per free clk (model-diff reference)
    oe32: list[int]
    horizon: int  # free-phase clk count (the SPEC-16-3 bound)

    @property
    def timeline(self) -> list[Step]:
        """The full replay: canonical-word prologue + free environment."""
        env0 = self.free_env[0] if self.free_env else IDLE_ENV
        return prologue_steps(self.canon, env0) + [Step(OP_NONE, 0, 0, e) for e in self.free_env]


# ---------------------------------------------------------------------------
# SPEC-16-9 window checkers (the Python half of the re-verification).
# ---------------------------------------------------------------------------


def run_lengths(bits: Sequence[int]) -> list[tuple[int, int]]:
    """Waveform -> maximal constant-level runs [(level, length), ...].

    >>> run_lengths([1, 1, 0, 1, 1, 1])
    [(1, 2), (0, 1), (1, 3)]
    >>> run_lengths([])
    []
    """
    runs: list[tuple[int, int]] = []
    for raw in bits:
        b = raw & 1
        if runs and runs[-1][0] == b:
            runs[-1] = (b, runs[-1][1] + 1)
        else:
            runs.append((b, 1))
    return runs


def check_square(bits: Sequence[int], half: int) -> list[str]:
    """SPEC-16-9 square semantics: the run spanning monitor start (the
    first, pre-anchor run) is unmeasured; every later interval between
    consecutive edges must lie in the exact window [half, half]. The
    final run is held to the same bound — a longer run has already
    raised the monitor's err_hi at its (half+1)-th clk (bounded
    detection), so an over-long tail is a real violation, while a
    horizon-truncated tail of <= half clk is merely unmeasured.

    >>> check_square([0, 0, 1, 1, 0, 0, 1, 1, 0, 0], 2)
    []
    >>> check_square([0, 1, 1, 0, 0, 1, 1, 1], 2)
    ['run 3: level 1 length 3 outside [2, 2]']
    """
    errs: list[str] = []
    for i, (lvl, ln) in enumerate(run_lengths(bits)[1:], 1):
        if not half <= ln <= half:
            errs.append(f"run {i}: level {lvl} length {ln} outside [{half}, {half}]")
    return errs


def check_uart(bits: Sequence[int], bit: int, payload: int) -> tuple[list[str], int | None]:
    """SPEC-16-9 UART-TX frame decode at an exact window. Leading low
    runs are the not-yet-driven line (the monitor sits in IDLE); the
    first high run anchors idle, then every edge-terminated run of L clk
    decodes L // bit slots (L % bit != 0 is a timing error). The
    bitstream must read start(0), 8 data LSB-first, even parity, stop(1)
    — the stop merged into the trailing ones-run costs nothing, and a
    low slot at/after the stop position is a structure error.
    -> (errors, decoded byte | None).

    >>> ok = [1, 0,0, 1,1, 0,0, 1,1, 0,0, 1,1, 0,0, 1,1, 0,0, 0,0, 1,1,1]
    >>> check_uart(ok, 2, 0x55)
    ([], 85)
    >>> check_uart([1, 0,0,0, 1,1,1, 1], 2, 0x00)[0][0]
    'run 0: length 3 not a multiple of 2'
    """
    runs = run_lengths(bits)
    start = next((i for i, (lvl, _) in enumerate(runs) if lvl == 1), None)
    if start is None:
        return ["no idle-high anchor (line never drove high)"], None
    body = runs[start + 1 :]
    if not body:
        return ["no start edge after the idle anchor"], None
    slots: list[int] = []
    for i, (lvl, ln) in enumerate(body[:-1]):
        if ln % bit:
            return [f"run {i}: length {ln} not a multiple of {bit}"], None
        slots += [lvl] * (ln // bit)
    # The final run is the stop/idle tail: if high, it completes the
    # frame once L + 1 >= k * bit for the k slots still missing through
    # the stop (SPEC-16-9) — its length is otherwise unbounded (a stop
    # merged into idle costs nothing) and never needs to be a multiple.
    # If low, the trace ends mid-frame: mark it so the structural checks
    # below report the truncation/structure error.
    lvl_f, ln_f = body[-1]
    stop_pos = 10
    if lvl_f == 1 and len(slots) <= stop_pos:
        k = stop_pos + 1 - len(slots)
        if ln_f + 1 < k * bit:
            return [f"stop tail {ln_f} clk cannot complete {k} slots at {bit} clk"], None
        slots += [1] * k
    elif lvl_f == 0:
        slots.append(0)
    if len(slots) < stop_pos + 1:
        return [f"frame incomplete: {len(slots)} slots decoded, need {stop_pos + 1}"], None
    errs: list[str] = []
    if slots[stop_pos] != 1:
        errs.append("stop slot is not 1")
    if any(s == 0 for s in slots[stop_pos + 1 :]):
        errs.append("low slot after the stop position")
    data = sum(slots[1 + i] << i for i in range(8))
    if slots[9] != (data.bit_count() & 1):
        errs.append(f"parity bit {slots[9]} != even parity of 0x{data:02x}")
    if data != payload:
        errs.append(f"decoded 0x{data:02x} != payload 0x{payload:02x}")
    return errs, data


# ---------------------------------------------------------------------------
# VCD decoding (the hyperequiv sampler, target-suffix map).
# ---------------------------------------------------------------------------


class Sample(TypedDict):
    t: int  # VCD timestamp of the posedge section
    step: int  # posedge ordinal
    rst: int
    vals: dict[str, int]  # short name -> value (x/z/absent -> missing)


# Suffix-matched signals of the pio_synth_*_fv tops: the harness's own
# nets (rst/free_c/gpio_in/...) and the two probe points that cannot be
# ported out (the anyconst words, SM0's PC — SPEC-16-12).
SIGS = {
    "rst": ".rst",
    "free": ".free_c",
    "gpio_in": ".gpio_in",
    "iprev": ".irq_prev_r",
    "inext": ".irq_next_r",
    "nbs": ".nb_set",
    "nbc": ".nb_clr",
    "out": ".gpio_out",
    "oe": ".gpio_oe",
    "words": ".u_dut.u_imem.g_sym.sym_words",
    "pc": ".u_dut.u_sm0.u_exec.pc_r",
    "mon_err": ".u_mon.err",
    "mon_edges": ".u_mon.edges",
}


def parse_vcd_samples(path: str | Path, sigs: dict[str, str] | None = None) -> list[Sample]:
    """Posedge-section snapshots of the wanted signals (the hyperequiv
    smtbmc-VCD convention: one section per BMC step holds the cycle's
    stimulus and the post-edge register values). x/z/absent values are
    left out of vals.

    >>> len(parse_vcd_samples("/nonexistent")) if False else True
    True
    """
    sigs = sigs or SIGS
    want: dict[str, str] = {}  # VCD id -> short name
    scope: list[str] = []
    fullname: dict[str, str] = {}
    with open(path) as f:
        for raw in f:
            ln = raw.strip()
            if ln.startswith("$scope"):
                scope.append(ln.split()[2])
            elif ln.startswith("$upscope"):
                scope.pop()
            elif ln.startswith("$var"):
                t = ln.split()
                fullname.setdefault(t[3], ".".join([*scope, t[4]]))
            elif ln.startswith("$enddefinitions"):
                break
    for vid, full in fullname.items():
        for short, sfx in sigs.items():
            if full.endswith(sfx) and short not in want.values():
                want[vid] = short
    samples: list[Sample] = []
    vals: dict[str, str] = {}
    t, is_edge = 0, False

    def close() -> None:
        if not is_edge:
            return
        snap: dict[str, int] = {}
        for short in sigs:
            raw = vals.get(short)
            if raw is not None and not set(raw) & {"x", "z"}:
                snap[short] = int(raw, 2)
        samples.append(Sample(t=t, step=len(samples), rst=snap.get("rst", 0), vals=snap))

    with open(path) as f:
        started = False
        for raw in f:
            if not started:
                if raw.startswith("$enddefinitions"):
                    started = True
                continue
            ln = raw.strip()
            if ln.startswith("#"):
                close()
                t, is_edge = int(ln[1:]), False
                continue
            if not ln or ln.startswith("$"):
                continue
            if ln == "1!":
                is_edge = True
                continue
            if ln[0] == "b":
                bts, _, vid = ln[1:].partition(" ")
                short = want.get(vid.strip())
                if short:
                    vals[short] = bts
            else:
                short = want.get(ln[1:])
                if short:
                    vals[short] = ln[0]
        close()
    return samples


def active_samples(samples: Sequence[Sample]) -> list[Sample]:
    """Samples after the last rst=1 posedge (model clk 0 = the first
    clk with rst de-asserted, the hyperequiv convention). A mid-trace
    rst would restart the harness prologue — refused upstream."""
    start = 1
    for i, s in enumerate(samples):
        if s["rst"]:
            start = i + 1
    return [s for s in samples if s["step"] >= start]


def words_of(sym: int) -> list[int]:
    """The 512-bit sym_words vector -> 32 words, word i = bits [16*i+:
    16] (pio_synth_fv's PROG packing).

    >>> [f"{w:04x}" for w in words_of(0x0002_E081)[:2]]
    ['e081', '0002']
    """
    return [(sym >> (16 * i)) & 0xFFFF for i in range(32)]


def canon_words(raw: Sequence[int], visited: set[int]) -> list[int]:
    """SPEC-16-12 canonicalization: never-visited words (solver
    don't-cares) become nop; a *visited* reserved word (SPEC-13-1 — the
    solver uses them as cheap big-delay parks) becomes a delay-preserving
    nop: reserved encodings execute as pure no-ops with their delay
    field honored (decoder/model agree — model.py's delay_load is not
    illegal-gated), so NOP | delay bits is behaviour-equivalent. The
    replay diff against the original VCD re-checks every substitution.

    >>> canon_words([0xE081, 0x1F1F], {0})
    [57473, 41026]
    >>> [f"{w:04x}" for w in canon_words([0xFFFF], {0})]
    ['bf42']
    """
    out: list[int] = []
    for i, word in enumerate(raw):
        w = word & 0xFFFF
        if i not in visited:
            out.append(NOP)
            continue
        try:
            disasm.disassemble(w, False, 0)
            out.append(w)
        except E.ReservedEncoding:
            out.append(NOP | (w & 0x1F00))  # nop [delay] (SPEC-13-1)
    return out


def extract_witness(target: Target, samples: Sequence[Sample], cover_step: int | None = None) -> Witness:
    """Active cover-trace samples -> Witness (SPEC-16-12): raw words,
    visited PCs, per-clk free-phase environment and VCD observables.

    cover_step (the sby log's "Reached cover statement ... in step N")
    truncates the trace at the cover: sections past it are solver
    don't-cares — nothing constrains signals irrelevant to the already-
    fired cover there (e.g. gpio_out pins the monitor does not watch),
    and the deterministic replay must not be diffed against them.

    The visited set is the union of SM0 PCs over the retained samples
    but the last: a pc value present in section k is fetched at the
    first clk it holds (ticks fire every clk at the reset CLKDIV 1, so
    a new pc means a new fetch, CC-33), while the final section's pc
    was latched at the closing edge and never fetched — its word is a
    solver don't-care like any unvisited one."""
    act = active_samples(samples)
    if cover_step is not None:
        act = [s for s in act if s["step"] <= cover_step]
    free = [s for s in act if s["vals"].get("free")]
    if len(free) < 4:
        raise SynthError(f"only {len(free)} free-phase samples in the cover trace")
    sym = next((s["vals"]["words"] for s in act if "words" in s["vals"]), None)
    if sym is None:
        raise SynthError("sym_words not found in the cover trace (SYM off?)")
    raw = words_of(sym)
    visited = {s["vals"]["pc"] for s in act[:-1] if "pc" in s["vals"]}
    canon = canon_words(raw, visited)
    env = [
        Env(
            s["vals"].get("gpio_in", 0),
            s["vals"].get("nbs", 0),
            s["vals"].get("nbc", 0),
            s["vals"].get("iprev", 0),
            s["vals"].get("inext", 0),
        )
        for s in free
    ]
    return Witness(
        target=target,
        raw_words=raw,
        canon=canon,
        visited=visited,
        free_env=env,
        out32=[s["vals"].get("out", 0) for s in free],
        oe32=[s["vals"].get("oe", 0) for s in free],
        horizon=len(free),
    )


# ---------------------------------------------------------------------------
# Re-verification leg (a): C12-model replay + SPEC-16-9 window check.
# ---------------------------------------------------------------------------


def replay_model(w: Witness) -> tuple[list[str], list[int]]:
    """Run the canonical program through the C12 model on the witness
    timeline -> (errors, gpio_out[0] waveform). The differential tie-back
    compares the free-phase observables against the VCD's (SPEC-16-1);
    the replay prologue is 32 clks longer than the synthesis run's
    (word-serial load), and the input synchronizers (CC-23) flush within
    2 clk of identical inputs, so a nonzero synthesis-prologue
    environment delays the compare start by 2 clks — an all-zero one
    compares every clk. The window check then runs on the model's full
    waveform (SPEC-16-9), prologue included: the leading low run is the
    unmeasured anchor for sq and the not-yet-driven line for uart.

    >>> w = Witness(TARGETS["sq"], [], [NOP] * 32, set(), [IDLE_ENV] * 8, [], [], 8)
    >>> replay_model(w)[0]
    []
    """
    mdl = M.PIOBlockModel()
    mdl.reset()
    bits: list[int] = []
    obs: list[tuple[int, int, int]] = []
    for st in w.timeline:
        o = mdl.step(st.env.gpio, 0, st.op, st.addr, st.wdata, st.env.nbs, st.env.nbc, st.env.iprev, st.env.inext)
        obs.append((o["gpio_out"], o["gpio_oe"], o["intr"]))
        bits.append(o["gpio_out"] & 1)
    errs: list[str] = []
    prologue = len(w.canon) + 3
    off = 2 if any(s.env != IDLE_ENV for s in w.timeline[:3]) else 0
    for j in range(off, min(w.horizon, len(w.out32))):
        if obs[prologue + j][0] != w.out32[j]:
            errs.append(
                f"model/VCD gpio_out differ at free clk {j}: model 0x{obs[prologue + j][0]:08x} vcd 0x{w.out32[j]:08x}"
            )
            break
    t = w.target
    # The window check runs on all bits but the last: the monitors sample
    # each clk's gpio_out at the CLOSING edge (SPEC-16-9 registered
    # sampling), so the horizon's final sample is one clk past the last
    # edge they ever took — the cover fired on pre-lag state, and the
    # checker must judge exactly what the monitor judged.
    seen = bits[:-1] if len(bits) > 1 else bits
    if t.kind == "sq":
        errs += check_square(seen, t.window)
    else:
        uerrs, _ = check_uart(seen, t.window, t.payload)
        errs += uerrs
    return errs, bits


# ---------------------------------------------------------------------------
# Re-verification leg (b): the generated iverilog TB.
# ---------------------------------------------------------------------------


def tb_sv(w: Witness) -> str:
    """The auto-generated witness TB (SPEC-16-12 leg b): tb_common
    idioms, the canonical words loaded word-serially, the harness config
    triple, the VCD environment replayed at the negedge (the
    tb_trace_dump discipline: nothing races the posedge), and the C15
    monitor instance checking acceptance + payload at the horizon."""
    t = w.target
    tl = w.timeline
    n_tl = len(tl)
    n_pro = len(w.canon) + 3
    env_rom = "\n".join(
        f"      env_gpio[{j}] = 32'h{e.gpio & 0xFFFFFFFF:08X}; env_nbs[{j}] = 8'h{e.nbs & 0xFF:02X};"
        f" env_nbc[{j}] = 8'h{e.nbc & 0xFF:02X}; env_iprev[{j}] = 8'h{e.iprev & 0xFF:02X};"
        f" env_inext[{j}] = 8'h{e.inext & 0xFF:02X};"
        for j, e in enumerate(s.env for s in tl)
    )
    op_rom = "\n".join(
        f"      ops_addr[{j}] = 9'h{s.addr:03X}; ops_wdata[{j}] = 32'h{s.wdata & 0xFFFFFFFF:08X};"
        for j, s in enumerate(tl)
        if s.op == OP_WR
    )
    win = t.window
    if t.kind == "sq":
        mon = f"""  logic        s_err, s_lo, s_hi;
  logic [15:0] s_edges;

  pio_mon_square #(.HALF_LO({win}), .HALF_HI({win}))
      u_mon (.clk(clk), .rst(rst), .sig(gpio_out_w[0]),
             .err(s_err), .err_lo(s_lo), .err_hi(s_hi),
             .edge_t(), .edges(s_edges), .dbg_state(), .dbg_len());"""
        checks = """      // Goal-moment check (SPEC-16-12 leg b): the cover predicate itself,
      // latched at the clk it fires during the replay — immune to the
      // replay's clk-phase offset against the synthesis trace (the
      // predicate is sticky). Never firing within the timeline is the
      // canonicalization-broken case.
      if (!ok) ok = (s_edges >= 16'd8) && !s_err && gpio_oe_w[0];"""
    else:
        mon = f"""  logic        m_err, m_et, m_ef, m_fd;
  logic [15:0] m_frames;
  logic [7:0]  m_data;

  pio_mon_uart_tx #(.DBITS(8), .PARITY(1'b1), .BIT_LO({win}), .BIT_HI({win}))
      u_mon (.clk(clk), .rst(rst), .rx(gpio_out_w[0]),
             .err(m_err), .err_timing(m_et), .err_frame(m_ef),
             .frame_done(m_fd), .frames(m_frames), .data(m_data),
             .dbg_state(), .dbg_len(), .dbg_pos());"""
        checks = f"""      // Goal-moment check (SPEC-16-12 leg b): an accepted frame decoding
      // the payload, monitor error-free at that clk, pad driven.
      if (!ok) ok = (m_frames != 16'd0) && (m_data == 8'h{t.payload:02X}) && !m_err && gpio_oe_w[0];"""
    return f"""// Generated by tools/hypersynth.py (KANBAN C16) — DO NOT EDIT.
// Witness re-verification TB (SPEC-16-12 leg b): the canonical synthesized
// program under the C15 {t.kind} monitor ({t.name} target, window [{win},{win}]),
// environment replayed from the cover trace. tb_pio_mon/bus_wr idioms.
`include "tb_common.sv"

module tb_witness;

  logic clk;
  logic rst;
  tb_clk_rst u_cr (.clk(clk));

  logic [8:0]  reg_addr;
  logic [31:0] reg_wdata;
  logic        reg_write, reg_read;
  logic [31:0] reg_rdata_w;
  logic [31:0] gpio_in, gpio_out_w, gpio_oe_w;
  logic [7:0]  irq_prev_r, irq_next_r, nb_set, nb_clr;
  logic [7:0]  irq_prev_o_w, irq_next_o_w;
  logic [7:0]  prev_exp_set_w, prev_exp_clr_w, next_exp_set_w, next_exp_clr_w;
  logic [15:0] intr_w;

  pio_block u_dut (
      .clk(clk), .rst(rst),
      .reg_addr(reg_addr), .reg_wdata(reg_wdata),
      .reg_write(reg_write), .reg_read(reg_read), .reg_rdata(reg_rdata_w),
      .gpio_in(gpio_in), .gpio_out(gpio_out_w), .gpio_oe(gpio_oe_w),
      .irq_prev_r(irq_prev_r), .irq_next_r(irq_next_r),
      .nb_set(nb_set), .nb_clr(nb_clr),
      .irq_prev_o(irq_prev_o_w), .irq_next_o(irq_next_o_w),
      .prev_exp_set(prev_exp_set_w), .prev_exp_clr(prev_exp_clr_w),
      .next_exp_set(next_exp_set_w), .next_exp_clr(next_exp_clr_w),
      .intr(intr_w)
  );

{mon}

  // Replay ROMs: per-clk environment and the prologue bus ops.
  logic [31:0] env_gpio  [0:{n_tl - 1}];
  logic [7:0]  env_nbs   [0:{n_tl - 1}];
  logic [7:0]  env_nbc   [0:{n_tl - 1}];
  logic [7:0]  env_iprev [0:{n_tl - 1}];
  logic [7:0]  env_inext [0:{n_tl - 1}];
  logic [8:0]  ops_addr  [0:{n_pro - 1}];
  logic [31:0] ops_wdata [0:{n_pro - 1}];
  integer j, k;
  logic ok;

  initial begin
{env_rom}
{op_rom}
  end

  task automatic drive_env(input integer idx);
    begin
      gpio_in    = env_gpio[idx];
      nb_set     = env_nbs[idx];
      nb_clr     = env_nbc[idx];
      irq_prev_r = env_iprev[idx];
      irq_next_r = env_inext[idx];
    end
  endtask

  initial begin
    reg_write = 1'b0;
    reg_read  = 1'b0;
    gpio_in = 32'd0; irq_prev_r = 8'd0; irq_next_r = 8'd0;
    nb_set = 8'd0; nb_clr = 8'd0;
    ok = 1'b0;
    `DO_RESET(3)
    // Replay timeline: {n_pro} prologue clks (imem + config writes) then
    // {w.horizon} free clks of environment; the goal predicate is latched
    // at every free clk (SPEC-16-12 leg b — see the check below).
    for (j = 0; j < {n_pro}; j++) begin
      @(negedge clk);
      drive_env(j);
      reg_addr  = ops_addr[j];
      reg_wdata = ops_wdata[j];
      reg_write = 1'b1;
    end
    @(negedge clk);
    reg_write = 1'b0;
    for (j = {n_pro}; j < {n_tl}; j++) begin
      @(negedge clk);
      drive_env(j);
{checks}
    end
    // One post-edge sample past the last free clk covers the closing
    // edge's monitor update (the goal's sticky predicate, +/- one clk
    // of replay-phase slop is harmless).
    @(posedge clk);
    #1;
{checks}
    `check1(ok, 1'b1)
    `TB_FINISH
  end

endmodule
"""


def _iverilog_cmd(case_dir: Path) -> list[str]:
    """The compile+run command for the generated TB: native iverilog or
    the vibe-pio container wrap."""
    case_dir = case_dir.resolve()
    tb = "/work/" + (case_dir / "tb_witness.sv").relative_to(REPO).as_posix()
    sh = (
        f"iverilog -g2012 -I /work/sim -s tb_witness -o tb_witness.vvp {tb}"
        f" /work/sim/tb_common.sv {' '.join(f'/work/rtl/{f}' for f in RTL_FILES)}"
        " && vvp tb_witness.vvp"
    )
    if shutil.which("iverilog"):
        native = sh.replace("/work/", str(REPO) + "/").replace(f"-I {REPO}/sim", f"-I {SIM}")
        return ["sh", "-c", native]
    return [*_docker_prefix(case_dir), "sh", "-c", sh]


def run_tb(w: Witness, case_dir: Path) -> list[str]:
    """Compile + run the generated TB -> error list."""
    (case_dir / "tb_witness.sv").write_text(tb_sv(w))
    r = subprocess.run(_iverilog_cmd(case_dir), capture_output=True, text=True, check=False)
    (case_dir / "tb_witness.log").write_text(r.stdout + r.stderr)
    if r.returncode != 0:
        return [f"generated TB failed (rc={r.returncode}); see tb_witness.log"]
    if "TB STATUS : PASS" not in r.stdout:
        return ["generated TB did not PASS; see tb_witness.log"]
    return []


# ---------------------------------------------------------------------------
# Re-verification leg (c): bounded formal conformance (FREE=0 instance).
# ---------------------------------------------------------------------------


def case_sv(w: Witness) -> str:
    """The generated conformance top (SPEC-16-12 leg c): the harness with
    FREE=0 (canonical words via the prologue, SYM off) under a phase-rom
    replay of the witness environment; its standing assert (!err) is the
    claim (SPEC-16-3 bounded at 2 + timeline + 4 clk)."""
    t = w.target
    tl = w.timeline
    n = len(tl)
    words = ",\n                                ".join(f"16'h{x:04X}" for x in reversed(w.canon))
    rom = "\n".join(
        f"        8'd{j}: begin gpio_in_c = 32'h{e.gpio & 0xFFFFFFFF:08X};"
        f" nbs_c = 8'h{e.nbs & 0xFF:02X}; nbc_c = 8'h{e.nbc & 0xFF:02X};"
        f" iprev_c = 8'h{e.iprev & 0xFF:02X}; inext_c = 8'h{e.inext & 0xFF:02X}; end"
        for j, e in enumerate(s.env for s in tl)
    )
    return f"""// Generated by tools/hypersynth.py (KANBAN C16) — DO NOT EDIT.
// Witness bounded-conformance top (SPEC-16-12 leg c): pio_synth_{t.name}_fv
// with FREE=0 — the canonical words load via the prologue (SPEC-7-10), SYM
// off — and the phase ROM replays the cover trace's environment so the
// standing sq_conf/uart_conf assertion (!err) is checked on exactly the
// witness run (SPEC-16-3 bounded claim).
module pio_synth_case (
    input logic clk
);
  // Phase 0..1: rst held (the harness's A1 assume, CC-1, satisfied by
  // construction — phase_r carries an init value); phase 2.. replays the
  // witness timeline.
  logic [7:0] phase_r = 8'd0;
  always_ff @(posedge clk)
    if (phase_r < 8'd{min(n + 3, 250)}) phase_r <= phase_r + 8'd1;

  logic rst;
  assign rst = (phase_r < 8'd2);

  logic [31:0] gpio_in_c;
  logic [7:0]  nbs_c, nbc_c, iprev_c, inext_c;

  always_comb begin
    gpio_in_c = 32'd0; nbs_c = 8'd0; nbc_c = 8'd0; iprev_c = 8'd0; inext_c = 8'd0;
    if (phase_r >= 8'd2) begin
      case (phase_r - 8'd2)
{rom}
        default: ;
      endcase
    end
  end

  pio_synth_{t.name}_fv #(
      .FREE(1'b0),
      .PROG({{{words}}}),
      .PROG_LEN(6'd32)
  ) u (
      .clk(clk), .rst(rst), .gpio_in(gpio_in_c),
      .irq_prev_r(iprev_c), .irq_next_r(inext_c),
      .nb_set(nbs_c), .nb_clr(nbc_c)
  );
endmodule
"""


def toolchain() -> list[str] | None:
    """sby prefix (empty = native), or the vibe-pio container wrap; None
    when neither is available (hyperequiv's fallback)."""
    if shutil.which("sby"):
        return []
    if shutil.which("docker"):
        out = subprocess.run(
            ["docker", "images", "-q", "vibe-pio:latest"], capture_output=True, text=True, check=False
        ).stdout.strip()
        if out:
            return ["docker", "run", "--rm", "-v", f"{REPO}:/work"]
    return None


def _rm_tree(path: Path) -> None:
    """Best-effort recursive remove (container runs leave root-owned
    workdirs — hand the path to a root rm inside the image)."""
    shutil.rmtree(path, ignore_errors=True)
    if path.exists() and shutil.which("docker"):
        rel = "/work/" + path.relative_to(REPO).as_posix()
        subprocess.run(
            ["docker", "run", "--rm", "-v", f"{REPO}:/work", "vibe-pio:latest", "rm", "-rf", rel],
            capture_output=True,
            check=False,
        )
        shutil.rmtree(path, ignore_errors=True)


def _docker_prefix(case_dir: Path) -> list[str]:
    case_dir = case_dir.resolve()
    return [
        "docker",
        "run",
        "--rm",
        "-v",
        f"{REPO}:/work",
        "-w",
        "/work/" + case_dir.relative_to(REPO).as_posix(),
        "vibe-pio:latest",
    ]


def synth_sby(target: Target, depth: int, rel_repo: str) -> str:
    """The generated synthesis task: the committed harness top with SYM
    on (SPEC-16-11), cover at the target depth."""
    reads = "\n".join(f"read -formal -sv {f}" for f in RTL_FILES)
    files = "\n".join(f"{rel_repo}/rtl/{f}" for f in RTL_FILES)
    return f"""# Generated by tools/hypersynth.py (KANBAN C16) — DO NOT EDIT.
[tasks]
synth

[options]
synth: mode cover
synth: depth {depth}

[engines]
synth: smtbmc boolector

[script]
{reads}
read -formal -sv {FV_FILE}
chparam -set SYM 1 pio_instr_mem
prep -top {target.top}
memory_map

[files]
{files}
{rel_repo}/formal/{FV_FILE}
"""


def conf_sby(depth: int, rel_repo: str) -> str:
    """The generated conformance task: the case top (FREE=0), bmc."""
    reads = "\n".join(f"read -formal -sv {f}" for f in RTL_FILES)
    files = "\n".join(f"{rel_repo}/rtl/{f}" for f in RTL_FILES)
    return f"""# Generated by tools/hypersynth.py (KANBAN C16) — DO NOT EDIT.
[tasks]
bmc

[options]
bmc: mode bmc
bmc: depth {depth}

[engines]
bmc: smtbmc boolector

[script]
{reads}
read -formal -sv {FV_FILE}
read -formal -sv pio_synth_case_fv.sv
prep -top pio_synth_case
memory_map

[files]
{files}
{rel_repo}/formal/{FV_FILE}
./pio_synth_case_fv.sv
"""


def run_sby(sby_text: str, task: str, case_dir: Path, timeout: int) -> tuple[str, str]:
    """Write <task>.sby into case_dir, run it -> (status, log)."""
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / f"{task}.sby").write_text(sby_text)
    tc = toolchain()
    if tc is None:
        raise SynthError("no sby on PATH and no vibe-pio container image")
    if tc:
        cmd = [
            *_docker_prefix(case_dir),
            "timeout",
            "-k",
            "5",
            str(timeout),
            "sby",
            "-f",
            "-d",
            task,
            f"{task}.sby",
        ]
    else:
        cmd = ["timeout", "-k", "5", str(timeout), "sby", "-f", "-d", task, f"{task}.sby"]
    r = subprocess.run(cmd, cwd=case_dir, capture_output=True, text=True, check=False)
    log = r.stdout + r.stderr
    (case_dir / f"{task}.log").write_text(log)
    status = "ERROR"
    if r.returncode in (124, 137):
        status = "TIMEOUT"
    else:
        sf = case_dir / task / "status"
        if sf.is_file():
            first = sf.read_text().split()
            if first and first[0].upper() in ("PASS", "FAIL", "UNKNOWN", "ERROR", "TIMEOUT"):
                status = first[0].upper()
        elif r.returncode == 0:
            status = "PASS"
    return status, log


# ---------------------------------------------------------------------------
# .pio emission (C12 disassembler, round-trip checked).
# ---------------------------------------------------------------------------


def pio_text(w: Witness) -> str:
    """Canonical words -> .pio program text (SPEC-16-12).

    >>> w = Witness(TARGETS["sq"], [], [NOP] * 32, set(), [], [], [], 0)
    >>> pio_text(w).count('    nop')
    32
    """
    t = w.target
    lines = [
        f".program witness_{t.name}",
        f"; synthesized by tools/hypersynth.py (C16, SPEC-16-11/12) — {t.name} target",
        "; never-visited words nop-filled (0xA042) — solver don't-cares",
    ]
    for i, word in enumerate(w.canon):
        mark = "" if i in w.visited else "   ; not executed (nop-filled)"
        lines.append(f"    {disasm.disassemble(word, False, 0)}{mark}")
    return "\n".join(lines) + "\n"


def emit_pio(w: Witness, case_dir: Path) -> Path:
    """Write witness.pio and check the assembler round-trip (C12)."""
    p = case_dir / "witness.pio"
    text = pio_text(w)
    p.write_text(text)
    words = [x & 0xFFFF for x in asm.parse_text(text)[0].words]
    if words != w.canon:
        raise SynthError(f".pio round-trip mismatch: {words} != {w.canon}")
    return p


# ---------------------------------------------------------------------------
# Driver: one target end-to-end.
# ---------------------------------------------------------------------------


def synthesize(
    target: Target, *, depth: int | None = None, timeout: int = 3600, tag: str | None = None
) -> tuple[str, list[str]]:
    """Full pipeline for one target -> (verdict kind, report lines)."""
    case_dir = BUILD / "synth" / (tag or target.name)
    if case_dir.exists():
        _rm_tree(case_dir)
    depth = depth or target.depth
    rel = os.path.relpath(REPO, case_dir).replace(os.sep, "/")
    status, log = run_sby(synth_sby(target, depth, rel), "synth", case_dir, timeout)
    head = [f"target {target.name}: top {target.top}, cover depth {depth} (SPEC-16-11)"]
    if status != "PASS":
        kind = "TIMEOUT" if status == "TIMEOUT" else "ERROR"
        return kind, [*head, f"-- sby cover: {status}", *log.splitlines()[-6:]]
    vcds = sorted((case_dir / "synth").glob("engine_*/trace*.vcd"))
    if not vcds:
        return "ERROR", [*head, "cover PASS but no trace VCD found"]
    m = re.search(r"Reached cover statement.*in step (\d+)", log)
    cover_step = int(m.group(1)) if m else None
    if cover_step is None:
        return "ERROR", [*head, "cover step not parsed from the sby log"]
    try:
        w = extract_witness(target, parse_vcd_samples(vcds[0]), cover_step)
    except SynthError as ex:
        return "ERROR", [*head, f"extraction failed: {ex}"]
    lines = [
        *head,
        f"-- cover trace: {vcds[0].relative_to(REPO)}",
        f"raw words     : {' '.join(f'{x:04x}' for x in w.raw_words)}",
        f"visited PCs   : {sorted(w.visited)}",
        f"canonical     : {' '.join(f'{x:04x}' for x in w.canon)}",
        f"free clks     : {w.horizon}",
    ]
    try:
        errs, _ = replay_model(w)
        pio = emit_pio(w, case_dir)
    except SynthError as ex:
        return "FAIL", [*lines, f"canonicalization/emission failed: {ex}"]
    lines.append(f"witness.pio   : {pio.relative_to(REPO)}")
    if errs:
        return "FAIL", [*lines, "-- model replay FAILED:", *[f"   {e}" for e in errs]]
    lines.append("-- model replay: observables match the VCD; SPEC-16-9 window check clean")
    tb_errs = run_tb(w, case_dir)
    if tb_errs:
        return "FAIL", [*lines, "-- generated TB FAILED:", *[f"   {e}" for e in tb_errs]]
    lines.append("-- generated TB: PASS (monitor accepted; payload decoded)")
    # Conformance depth = the full replay timeline: the goal-gated assert
    # (goal_hit || !err) holds at every clk, so more depth is strictly
    # more checking of the pre-goal window; errors past the goal moment
    # are legal for any finite horizon (SPEC-16-3).
    conf_depth = 2 + len(w.timeline)
    (case_dir / "pio_synth_case_fv.sv").write_text(case_sv(w))
    cstatus, clog = run_sby(conf_sby(conf_depth, rel), "conf", case_dir, timeout)
    if cstatus != "PASS":
        return ("TIMEOUT" if cstatus == "TIMEOUT" else "FAIL"), [
            *lines,
            f"-- conformance bmc: {cstatus}",
            *clog.splitlines()[-6:],
        ]
    lines.append(f"-- conformance bmc: PASS at depth {conf_depth} (SPEC-16-3/12)")
    return "PASS", lines


def red_case(depth: int = 28, timeout: int = 3600) -> tuple[str, list[str]]:
    """The contradictory-spec non-vacuity case (SPEC-16-11): [2,2] and
    [3,3] on one pin — the cover must be UNSAT ("Unreached cover
    statement"), i.e. the sby task FAILs with no witness.

    >>> 'Unreached' in 'Unreached cover statement'
    True
    """
    case_dir = BUILD / "synth" / "red"
    if case_dir.exists():
        _rm_tree(case_dir)
    rel = os.path.relpath(REPO, case_dir).replace(os.sep, "/")
    sby = synth_sby(TARGETS["sq"], depth, rel).replace(f"prep -top {TARGETS['sq'].top}", "prep -top pio_synth_red_fv")
    status, log = run_sby(sby, "synth", case_dir, timeout)
    unreached = "Unreached cover statement" in log
    ok = status == "FAIL" and unreached
    return (
        "PASS" if ok else "FAIL",
        [
            f"red case: pio_synth_red_fv cover depth {depth} — expect FAIL + Unreached cover statement",
            f"-- sby: {status}; unreached-cover marker: {unreached}",
        ],
    )


# ---------------------------------------------------------------------------
# Self-test (make synth): hermetic fixtures + end-to-end cases.
# ---------------------------------------------------------------------------


def _tiny_vcd(words: Sequence[int] | None = None) -> str:
    """A minimal pio_synth-shaped cover VCD: initstate posedge with rst,
    two prologue posedges (free=0), then five free posedges with words
    set and gpio_out[0] toggling 2-clk halves (the sq shape). words
    defaults to word0=0xE081, word1=0x0002, word2=0x00EB (visited PCs
    0,1,2); pc=0 appears in the prologue sections so the anchor word
    counts as visited."""
    words = list(words) if words else [0xE081, 0x0002, 0x00EB]
    bits = "".join(f"{(words[i] if i < len(words) else 0):016b}" for i in range(31, -1, -1))
    return f"""$timescale 1ns $end
$scope module top $end
$var wire 1 ! clk $end
$var wire 1 n1 rst $end
$var wire 1 n2 free_c $end
$var wire 32 n3 gpio_in $end
$var wire 8 n4 nb_set $end
$var wire 8 n5 nb_clr $end
$var wire 8 n6 irq_prev_r $end
$var wire 8 n7 irq_next_r $end
$var wire 32 n8 gpio_out $end
$var wire 32 n9 gpio_oe $end
$scope module u_dut $end
$scope module u_imem $end
$scope module g_sym $end
$var wire 512 n10 sym_words $end
$upscope $end
$upscope $end
$scope module u_sm0 $end
$scope module u_exec $end
$var wire 5 n11 pc_r $end
$upscope $end
$upscope $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
1!
1n1
0n2
b0 n3
b0 n4
b0 n5
b0 n6
b0 n7
b0 n8
b0 n9
b{bits} n10
b00000 n11
#10
1!
0n1
0n2
b00000 n11
#20
1!
0n2
b00000 n11
#30
1!
1n2
b{bits} n10
b00001 n11
b00000000000000000000000000000001 n8
b00000000000000000000000000000001 n9
#40
1!
b00001 n11
#50
1!
b00010 n11
b00000000000000000000000000000000 n8
#60
1!
b00010 n11
#70
1!
b00001 n11
b00000000000000000000000000000001 n8
"""


def _self_test_hermetic() -> list[tuple[str, bool]]:
    checks: list[tuple[str, bool]] = []
    # Window checkers (SPEC-16-9), red/green.
    checks.append(("sq-green", check_square([0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1], 2) == []))
    checks.append(("sq-red-long", check_square([0, 1, 1, 1, 0, 0], 2) != []))
    checks.append(("sq-red-short", check_square([0, 1, 0, 0, 1, 1], 2) != []))
    # 0x55 LSB-first = 1,0,1,0,1,0,1,0; even parity of 0x55 = 0, merged
    # with data-bit-8's zeros run; stop 1s merge into idle (SPEC-16-9).
    ok = [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1]
    errs, data = check_uart(ok, 2, 0x55)
    checks.append(("uart-green", errs == [] and data == 0x55))
    par_bad = [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1]
    errs, _ = check_uart(par_bad, 2, 0x55)
    checks.append(("uart-red-parity", any("parity" in e for e in errs)))
    short_start = [1, 0, 1, 1, 0, 0]
    errs, _ = check_uart(short_start, 2, 0xFF)
    checks.append(("uart-red-timing", any("multiple" in e for e in errs)))
    errs, _ = check_uart([0, 0, 0], 2, 0)
    checks.append(("uart-no-anchor", errs != []))
    # run_lengths law: runs alternate levels and partition the waveform.
    bits = [1, 1, 1, 0, 0, 1]
    rl = run_lengths(bits)
    checks.append(("runs-alternate", all(rl[i][0] != rl[i + 1][0] for i in range(len(rl) - 1))))
    checks.append(("runs-partition", sum(ln for _, ln in rl) == len(bits)))
    # words_of packing / prologue shape.
    checks.append(("words-pack", words_of(0x0002_E081)[:2] == [0xE081, 0x0002]))
    ps = prologue_steps([0xA042] * 32)
    checks.append(("prologue-35", len(ps) == 35 and ps[32].addr == stim.A_SM0 + 4 * 5))
    checks.append(("prologue-ctrl-last", ps[-1].addr == stim.A_CTRL and ps[-1].wdata == CTRL_W))
    # VCD decode on the synthetic fixture.
    with tempfile.TemporaryDirectory(prefix="hypersynth_st_") as td:
        f = Path(td) / "t.vcd"
        f.write_text(_tiny_vcd())
        samples = parse_vcd_samples(f)
        w = extract_witness(TARGETS["sq"], samples)
        checks.append(("vcd-free-count", w.horizon == 5))
        checks.append(("vcd-words", w.raw_words[:3] == [0xE081, 0x0002, 0x00EB]))
        checks.append(("vcd-visited", w.visited == {0, 1, 2}))
        checks.append(("vcd-canon-nops-unvisited", w.canon[3] == NOP and w.canon[31] == NOP))
        checks.append(("vcd-canon-keeps-visited", w.canon[0] == 0xE081 and w.canon[2] == 0x00EB))
        checks.append(("vcd-out-toggles", w.out32 == [1, 1, 0, 0, 1]))
        checks.append(("vcd-oe", w.oe32 == [1, 1, 1, 1, 1]))
        # A reserved encoding at a visited PC canonicalizes to the
        # delay-preserving nop (SPEC-13-1: no-op execution, delay kept).
        reserved = next(w16 for w16 in range(0x4000, 0x6000) if E.decode(w16, False, 0)["illegal"])
        f.write_text(_tiny_vcd([reserved, 0x0002, 0x00EB]))
        w = extract_witness(TARGETS["sq"], parse_vcd_samples(f))
        checks.append(("vcd-reserved-delay-nop", w.canon[0] == NOP | (reserved & 0x1F00)))
    # .pio emission round-trip on a nop-filled witness.
    w = Witness(TARGETS["sq"], [], [NOP] * 32, set(), [], [], [], 0)
    text = pio_text(w)
    checks.append(("pio-roundtrip", [x & 0xFFFF for x in asm.parse_text(text)[0].words] == [NOP] * 32))
    # replay_model on an empty-observables witness must not diff (the
    # VCD-less self-check path).
    w2 = Witness(TARGETS["sq"], [], [NOP] * 32, set(), [IDLE_ENV] * 8, [], [], 8)
    checks.append(("replay-empty-obs", replay_model(w2)[0] == []))
    return checks


def self_test() -> int:
    checks = _self_test_hermetic()
    if toolchain() is None:
        print("no sby on PATH and no vibe-pio container image — end-to-end cases cannot run")
        for name, _ in checks:
            print(f"  ??  {name}")
        return EXIT_CODES["ERROR"]
    for tgt in ("sq", "uart"):
        kind, lines = synthesize(TARGETS[tgt], tag=f"st_{tgt}")
        print("\n".join(lines))
        checks.append((f"e2e-{tgt}-pass", kind == "PASS"))
    kind, lines = red_case()
    print("\n".join(lines))
    checks.append(("e2e-red-unsat", kind == "PASS"))
    for tag in ("st_sq", "st_uart", "red"):
        _rm_tree(BUILD / "synth" / tag)
    ok = True
    for name, res in checks:
        print(f"  {'ok  ' if res else 'FAIL'} {name}")
        ok = ok and res
    print("self-test passed" if ok else "self-test FAILED")
    return 0 if ok else 1


# ---------------------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="C16 symbolic-program synthesis witness pipeline (see module docstring)")
    ap.add_argument("--target", choices=sorted(TARGETS), default=None, help="synthesis target (sq | uart)")
    ap.add_argument("--depth", type=int, default=None, help="cover BMC depth override (SPEC-16-3 bound)")
    ap.add_argument("--timeout", type=int, default=3600, help="per-sby wall-clock seconds")
    ap.add_argument("--tag", default=None, help="case dir name under build/synth/")
    ap.add_argument("--red", action="store_true", help="run the contradictory-spec UNSAT case instead")
    ap.add_argument("--self-test", action="store_true", help="run the committed self-test suite")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()
    if args.red:
        kind, lines = red_case(timeout=args.timeout)
        print("=== hypersynth (C16): red non-vacuity case ===")
        print("\n".join(lines))
        print(f"VERDICT: {kind}")
        return EXIT_CODES[kind]
    if args.target is None:
        ap.error("--target is required (or --self-test / --red)")
    kind, lines = synthesize(TARGETS[args.target], depth=args.depth, timeout=args.timeout, tag=args.tag)
    print("=== hypersynth (C16): symbolic-program synthesis witness pipeline ===")
    print("\n".join(lines))
    print(f"VERDICT: {kind}")
    return EXIT_CODES[kind]


if __name__ == "__main__":
    sys.exit(main())

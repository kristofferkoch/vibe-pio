#!/usr/bin/env python3
"""C17/C18 web gate: verilator lint + AOT wasm build + three-way trace
gate + the shipped-client gate. The browser runs the verified RTL
itself — Verilator --cc --assert elaborates pio_shim_top (pio_block +
the compiled-in invariant subset, web/pio_shim_top.sv), em++ links the
Verilated model into one modularized wasm engine (build/web/
pio_engine.js) that is both the headless gate runner's backend
(web/node_gate.js) and the shipped game engine for the C18 client
web/sm-view.html (pio_model stays the CI cross-check oracle).

Gates (KANBAN C17/C18 done-when):
  --lint          (1) verilator --lint-only -Wall over rtl/*.sv. Waivers:
                  only the four documented verification idioms (below);
                  everything else is fixed in RTL (the C17 lint-compat
                  work: the iverilog∩yosys subset convention gained a
                  third tool, AGENTS.md).
  --build         (2) the AOT wasm build: verilator --cc --assert -> em++
                  objects -> modularized engine, headless node-runnable.
  --threeway      (3) SPEC-16-7 traces model <-> iverilog <-> verilator-wasm
                  on the C12 conformance matrix + the difftest fuzz
                  corpus (same seed), via tracefmt.compare.
  --mutation-demo (4) red/green on the two re-injected defects:
                  PIO_DEFECT_SAMPLE_LATE (the shim samples observables
                  after the retiring posedge — caught by the trace diff,
                  leg 1) and PIO_DEFECT_INVARIANT (the i1 imem shadow
                  drops word-0 writes — the DUT is untouched, only the
                  compiled-in asserts can catch it, leg 2: proves the
                  binary's self-check path fires).
  --client        (5) the C18/C21/C24 client gate: web/engine-driver.js (the
                  exact client core the browser worker runs) drives the
                  wasm engine's game face through five sandbox legs
                  (the uart demo / pin drives + the pattern generator /
                  clkdiv!=1 / join overlay + RXF0 drains / aux put-get)
                  plus the four C24 multi-SM legs (per-SM load with
                  feeds + entry forces, parallel SMs on the shared imem,
                  inter-SM IRQ handoff, cross-SM pin arbitration with a
                  mid-run per-SM overlay edit); pio_model mirrors each
                  leg's timeline (the _SandboxMirror of the driver's
                  clocking rules) and the node gate requires
                  gpio-word-identical samples plus identical reg-read
                  rdata, the lens decodes, and the TX/RX mirror
                  agreements. Plus the three client-side mutation demos
                  (red, then green): CLIENT_DEFECT_PIN (pin sampled off
                  gpio_out bit 1 — caught by the model gpio diff),
                  CLIENT_DEFECT_MIRROR (TX contents mirror never pops —
                  caught by the mirror-vs-engine level check) and the
                  C24 CLIENT_DEFECT_SMADDR (SM config-window stride
                  transcribed as 0x14 — caught by the arbitration leg's
                  gpio diff).
  --self-test     all five (the `make web` target).

Runs with native verilator+em++/node when present, else one vibe-pio
container run per command (the difftest idiom; file arguments are
repo-relative, cwd = repo root).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

TOOLS = str(Path(__file__).resolve().parent.parent)
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from pio_model import (  # noqa: E402
    difftest,
    stim,
    tracefmt,
)
from pio_model import encoding as E  # noqa: E402
from pio_model.difftest import REPO, run_model_trace, run_rtl_trace  # noqa: E402

BUILD = REPO / "build"
WEB = REPO / "web"
RTL_SRC = sorted(p for p in (REPO / "rtl").glob("*.sv"))

# -Wall minus the repo's documented verification idioms (the lint gate
# fails on anything outside these classes; see DESIGN.md §RTL
# conventions):
#   PINMISSING / PINCONNECTEMPTY — dangling dbg_* verification readbacks
#     (the pio_sm / pio_gpio_mux export idiom: yosys cannot probe
#     instance internals, so readbacks stay port-observable and their
#     consumers above may leave them unconnected);
#   UNUSEDPARAM — decode-table localparams kept complete for readability
#     (the SPEC-14.x enumerations);
#   UNUSEDSIGNAL — interface-complete strobes with documented no-op
#     semantics (pio_sm_fifo's aux_get / sys_aux_rd: PUSH under PUT/GET
#     is the no-op, SPEC-3.5-8).
LINT_WAIVERS = ("PINMISSING", "PINCONNECTEMPTY", "UNUSEDPARAM", "UNUSEDSIGNAL")

# One wasm link config for both faces: modularized for the node gate
# runner and the C18 client; EXIT_RUNTIME so a failing compiled-in
# assertion terminates the process (the gate checks the exit status).
EMXX_FLAGS = (
    "-O2",
    "-g0",
    "-sMODULARIZE=1",
    "-sEXPORT_NAME=PioEngine",
    (
        "-sEXPORTED_FUNCTIONS=_pio_stim_trace,_pio_engine_reset,_pio_reg_write,"
        "_pio_reg_read,_pio_step,_pio_snapshot,_pio_last_cycle,_malloc,_free"
    ),
    "-sEXPORTED_RUNTIME_METHODS=lengthBytesUTF8,stringToUTF8,UTF8ToString,HEAPU8",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sEXIT_RUNTIME=1",
)


# ---------------------------------------------------------------------------
# Toolchain: native verilator+em++ or the vibe-pio container.
# ---------------------------------------------------------------------------


def _web_toolchain() -> list[str]:
    """Prefix list for verilator/make/em++/node commands (the difftest
    _toolchain idiom: native when both are on PATH, else one container
    run per command — arguments must be repo-relative)."""
    if shutil.which("verilator") and shutil.which("em++"):
        return []
    if shutil.which("docker"):
        out = subprocess.run(
            ["docker", "images", "-q", "vibe-pio:latest"], capture_output=True, text=True, check=False
        ).stdout.strip()
        if out:
            return ["docker", "run", "--rm", "-v", f"{REPO}:/work", "-w", "/work", "vibe-pio:latest"]
    sys.exit("no native verilator+em++ on PATH and no vibe-pio docker image — see container/Dockerfile")


_PREFIXED = ("verilator", "make", "em++", "node")


def _rel(p: Path) -> str:
    return p.resolve().relative_to(REPO).as_posix()


def _run(cmd: list[str], *, check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    tc = _web_toolchain()
    full = [*tc, *cmd] if cmd[0] in _PREFIXED else cmd
    run_env = {**os.environ, **env} if env else None
    r = subprocess.run(full, cwd=REPO, capture_output=True, text=True, check=False, env=run_env)
    if check and r.returncode != 0:
        tail = "\n".join((r.stdout + r.stderr).strip().splitlines()[-12:])
        raise RuntimeError(f"command failed ({' '.join(full[:5])}...):\n{tail}")
    return r


# ---------------------------------------------------------------------------
# Gate 1: lint.
# ---------------------------------------------------------------------------


def cmd_lint() -> int:
    cmd = [
        "verilator",
        "--lint-only",
        "-Wall",
        "--top-module",
        "pio_block",
        *[f"-Wno-{w}" for w in LINT_WAIVERS],
        *[_rel(p) for p in RTL_SRC],
    ]
    r = _run(cmd, check=False)
    warns = [ln for ln in (r.stdout + r.stderr).splitlines() if "%Warning" in ln or "%Error" in ln]
    if r.returncode != 0 or warns:
        print(f"FAIL lint: {len(warns)} diagnostic line(s)")
        for ln in warns[:20]:
            print(f"  {ln}")
        return 1
    print(f"PASS lint: verilator -Wall clean over {len(RTL_SRC)} rtl/*.sv (waived: {', '.join(LINT_WAIVERS)})")
    return 0


# ---------------------------------------------------------------------------
# Gate 2: the AOT wasm build.
# ---------------------------------------------------------------------------


def build_engine(
    out_dir: Path,
    *,
    sv_defines: tuple[str, ...] = (),
    cxx_defines: tuple[str, ...] = (),
) -> Path:
    """Verilate pio_shim_top (--assert: the invariant subset compiled in),
    compile the objects with em++, link the modularized engine.
    -> the pio_engine.js path (its .wasm sits beside it)."""
    mdir = out_dir / "obj"
    out_dir.mkdir(parents=True, exist_ok=True)
    mdir.mkdir(parents=True, exist_ok=True)  # verilator does not mkdir -p its Mdir
    # VL_IGNORE_UNKNOWN_ARCH: verilatedos.h has no wasm branch for
    # VL_CPU_RELAX; the no-op definition is the sanctioned escape.
    cflags = " ".join(["-DVL_IGNORE_UNKNOWN_ARCH", "-O1", *[f"-D{d}" for d in cxx_defines]])
    _run(
        [
            "verilator",
            "--cc",
            "--assert",
            "-j",
            "8",
            "--top-module",
            "pio_shim_top",
            "-Mdir",
            _rel(mdir),
            "--exe",
            "-CFLAGS",
            cflags,
            # the lint gate's documented idiom waivers — verilator treats
            # warnings as errors in --cc too
            *[f"-Wno-{w}" for w in LINT_WAIVERS],
            *[f"-D{d}" for d in sv_defines],
            _rel(WEB / "pio_shim.cpp"),
            _rel(WEB / "pio_shim_top.sv"),
            *[_rel(p) for p in RTL_SRC],
        ]
    )
    # Objects only — the final link is ours (verilated.mk hardcodes
    # LINK=g++ and appends -lpthread/-latomic, which wasm-ld has not).
    _run(
        [
            "make",
            "-C",
            _rel(mdir),
            "-f",
            "Vpio_shim_top.mk",
            "CXX=em++",
            "pio_shim.o",
            "verilated.o",
            "verilated_threads.o",
            "Vpio_shim_top__ALL.a",
        ]
    )
    engine = out_dir / "pio_engine.js"
    _run(
        [
            "em++",
            *EMXX_FLAGS,
            *[f"-D{d}" for d in cxx_defines],
            f"{_rel(mdir)}/pio_shim.o",
            f"{_rel(mdir)}/verilated.o",
            f"{_rel(mdir)}/verilated_threads.o",
            f"{_rel(mdir)}/Vpio_shim_top__ALL.a",
            "-o",
            _rel(engine),
        ]
    )
    return engine


def cmd_build() -> Path:
    engine = build_engine(BUILD / "web")
    js = engine.stat().st_size
    wasm = engine.with_suffix(".wasm").stat().st_size if engine.with_suffix(".wasm").exists() else 0
    print(f"PASS build: {engine.relative_to(REPO)} (js {js // 1024} KB, wasm {wasm // 1024} KB)")
    return engine


# ---------------------------------------------------------------------------
# Gate 3: the three-way trace gate.
# ---------------------------------------------------------------------------


def run_wasm_trace(mem: Path, trace: Path, engine: Path) -> subprocess.CompletedProcess[str]:
    """Replay one pio-stim image through the wasm engine (headless node).
    A compiled-in assertion violation aborts the process — the nonzero
    exit is the verdict, any partial trace stays unwritten."""
    return _run(["node", _rel(WEB / "node_gate.js"), _rel(engine), _rel(mem), _rel(trace)], check=False)


def threeway_case(name: str, sched: stim.Schedule, engine: Path) -> tuple[bool, str]:
    """-> (ok, message): model vs iverilog vs verilator-wasm, SPEC-16-7
    observables under the SPEC-16-2 exclusions."""
    tag = re.sub(r"\W+", "_", name)
    BUILD.mkdir(exist_ok=True)
    mem = BUILD / f"stim_{tag}.mem"
    sched.write_mem(mem)
    try:
        model_lines = run_model_trace(sched)
        rtl_trace = BUILD / f"rtl_{tag}.trace"
        run_rtl_trace(str(mem), str(rtl_trace))
        wasm_trace = BUILD / f"wasm_{tag}.trace"
        r = run_wasm_trace(mem, wasm_trace, engine)
        if r.returncode != 0:
            tail = "\n".join((r.stdout + r.stderr).strip().splitlines()[-6:])
            return False, f"wasm engine failed (exit {r.returncode}):\n{tail}"
        tracefmt.compare(model_lines, tracefmt.parse_trace(rtl_trace))
        tracefmt.compare(model_lines, tracefmt.parse_trace(wasm_trace))
    except tracefmt.TraceMismatch as ex:
        return False, str(ex)
    except (RuntimeError, ValueError) as ex:
        return False, f"harness error: {ex}"
    return True, ""


def cmd_threeway(engine: Path | None = None, fuzz_n: int = 6, seed: int = 1) -> int:
    if engine is None:
        engine = build_engine(BUILD / "web")
    cases = list(stim.conformance_schedules(REPO))
    rng = random.Random(seed)
    # the difftest --fuzz corpus, same seed
    cases.extend(difftest._random_case(rng, i) for i in range(fuzz_n))  # noqa: SLF001
    print(f"--- three-way: {len(cases)} cases (conformance matrix + fuzz {fuzz_n}, seed {seed})")
    fails = 0
    for name, sched in cases:
        ok, msg = threeway_case(name, sched, engine)
        if ok:
            print(f"PASS {name} ({len(sched.cycles)} clks)")
        else:
            fails += 1
            print(f"FAIL {name}: {msg}")
    print(f"=== three-way: {len(cases) - fails} passed, {fails} failed")
    return 1 if fails else 0


# ---------------------------------------------------------------------------
# Gate 4: mutation demo (red, then green) on the two defect hooks.
# ---------------------------------------------------------------------------


def _mini_sched() -> stim.Schedule:
    """The demo program — the difftest mini_cc11 shape (back-to-back
    OUTs with autopull@1: the CC-11 stall-refill corner) driving an
    alternating pin waveform, plus SM0_INSTR reads at spread pcs. The
    G lines move from the first OUT landing (leg 1's trace diff goes
    hot) and pc0 revisits 0 while imem[0] is nonzero (leg 2's i1
    shadow check)."""
    words = [
        E.encode_out("pins", 1, 0),  # 0: out pins,1
        E.encode_out("pins", 1, 0),  # 1: out pins,1
        E.encode_jmp(None, 0, 0),  # 2: jmp 0
    ]
    s = stim.Schedule()
    s.load_imem(words)
    s.w(stim.A_SM0 + 4 * 5, stim.pctrl(out_cnt=1))
    s.w(stim.A_SM0 + 4 * 1, stim.execctrl(2, 0))
    s.w(stim.A_SM0 + 4 * 2, stim.shiftctrl(pull_thr=1, autopull=True))
    s.idle(1)  # a SHIFTCTRL write settles before the feeds (SPEC-6-2)
    for _ in range(4):
        s.feed(0xAAAAAAAA)  # alternating bits: the pin toggles per OUT
    s.enable()
    s.run_to(30)
    for _ in range(4):
        s.idle(3)
        s.r(stim.A_SM0 + 4 * 4)  # SM0_INSTR (SPEC-7-24) at varied pcs
    s.run_to(60)
    return s


def cmd_mutation_demo(engine: Path) -> int:
    sched = _mini_sched()
    BUILD.mkdir(exist_ok=True)
    tag = re.sub(r"\W+", "_", "webdemo")
    mem = BUILD / f"stim_{tag}.mem"
    sched.write_mem(mem)
    model_lines = run_model_trace(sched)
    fails = 0

    def wasm(trace: Path, eng: Path) -> subprocess.CompletedProcess[str]:
        return run_wasm_trace(mem, trace, eng)

    # Leg 1 — shim defect: observables sampled after the retiring edge.
    print("--- mutation demo 1: PIO_DEFECT_SAMPLE_LATE (trace diff catches)")
    defect1 = build_engine(BUILD / "web-defect-sample-late", cxx_defines=("PIO_DEFECT_SAMPLE_LATE",))
    r = wasm(BUILD / "wasm_demo_defect1.trace", defect1)
    red1 = r.returncode != 0
    msg = ""
    if not red1:
        try:
            tracefmt.compare(model_lines, tracefmt.parse_trace(BUILD / "wasm_demo_defect1.trace"))
        except tracefmt.TraceMismatch as ex:
            red1, msg = True, str(ex)
    if not red1:
        fails += 1
        print("FAIL sample_late: NOT caught (the demo never moves the observables?)")
    else:
        print(f"PASS sample_late: red ({msg or 'engine aborted'})")

    # Leg 2 — shadow defect: the DUT is untouched; only the compiled-in
    # i1 assertion can notice the stale shadow.
    print("--- mutation demo 2: PIO_DEFECT_INVARIANT (compiled-in assert catches)")
    defect2 = build_engine(BUILD / "web-defect-invariant", sv_defines=("PIO_DEFECT_INVARIANT",))
    r = wasm(BUILD / "wasm_demo_defect2.trace", defect2)
    out = (r.stdout + r.stderr).strip()
    if r.returncode == 0:
        fails += 1
        print("FAIL invariant_defect: NOT caught (assert never fired — wiring broken?)")
    else:
        hit = next((ln for ln in out.splitlines() if "i1" in ln), "")
        print(f"PASS invariant_defect: red (exit {r.returncode}) {hit}")

    # Green: the clean engine on the same schedule.
    r = wasm(BUILD / "wasm_demo_clean.trace", engine)
    ok = r.returncode == 0
    green_msg = ""
    if ok:
        try:
            tracefmt.compare(model_lines, tracefmt.parse_trace(BUILD / "wasm_demo_clean.trace"))
        except tracefmt.TraceMismatch as ex:
            ok = False
            green_msg = str(ex)
    if not ok:
        fails += 1
        print(f"FAIL clean engine diverged: {green_msg or f'exit {r.returncode}'}")
    else:
        print("PASS clean: green")
    return 1 if fails else 0


# ---------------------------------------------------------------------------
# Gate 5: the C18/C21 client gate (driver-level, model-cross-checked).
# ---------------------------------------------------------------------------

# The client-gate run length for the uart_demo leg: 4 frames x 80 clks +
# startup/stall tail — 'P','I','O','!' decoded and the SM parked in the
# TX-empty stall.
CLIENT_RUN_CLKS = 360


class _SandboxMirror:
    """The python twin of web/engine-driver.js's clocking rules, driving a
    stim.Schedule the model replays: every driver action appends the same
    rendered clks — the per-SM load timeline (C24: config windows at the
    0x18 stride, per-SM CLKDIV/entry/feeds, one CTRL enable), queued reg
    ops (one clk each), and the composed gpio_in per step clk (drive
    latches + the pattern generator; op clks hold the last level — the
    shim's sticky-input discipline). Each _leg_* below mirrors its JS
    twin in web/node_client_gate.js call for call; the gate is the
    lockstep check between them."""

    def __init__(self) -> None:
        self.s = stim.Schedule()
        self.drives: list[int | None] = [None] * 32
        # C39: the single pattern became a list — a level's stimulus is
        # one pattern per driven input pin (set_stimulus); the client
        # gate's one-generator set_pattern replaces the whole list, the
        # JS twin's exact contract (engine-driver.js setPattern).
        self.pats: list[dict[str, Any]] = []

    # -- stimulus composition (engine-driver.js composedGpio/patLevel) --
    def _pattern_level(self, pat: dict[str, Any], idx: int) -> int:
        if pat["mode"] == "square":
            return (idx // (pat["period"] >> 1)) % 2
        if pat["mode"] == "bits":
            return pat["bits"][min(idx, len(pat["bits"]) - 1)]
        return 0

    def _gpio(self) -> int:
        g = 0
        for p, lvl in enumerate(self.drives):
            if lvl == 1:
                g |= 1 << p
        for pat in self.pats:
            idx = max(0, len(self.s.cycles) - pat["start_idx"])
            g = (g & ~(1 << pat["pin"])) | (self._pattern_level(pat, idx) << pat["pin"])
        return g & 0xFFFFFFFF

    def _step_clk(self) -> None:
        self.s.set_gpio(self._gpio())
        self.s.idle(1)

    def run(self, n: int) -> None:
        for _ in range(n):
            self._step_clk()

    def set_drive(self, pin: int, lvl: int | None) -> None:
        self.drives[pin] = lvl

    def set_pattern(self, mode: str = "off", pin: int = 0, period: int = 16, bits: list[int] | None = None) -> None:
        """The sandbox's ONE-generator contract (the JS twin's setPattern):
        replaces every active pattern."""
        self.pats = []
        if mode != "off":
            self.pats = [self._norm_pattern(mode, pin, period, bits)]
        # re-arming restarts the phase at this clk, whatever the mode

    def set_stimulus(self, cfgs: list[dict[str, Any]]) -> None:
        """C39: the level's given — one pattern cfg per driven input pin,
        all armed together at this clk (the JS twin's setStimulus; bits
        may be a 0/1 string, the level format's spelling)."""
        self.pats = [self._norm_pattern(c["mode"], c["pin"], c.get("period", 16), c.get("bits")) for c in cfgs]

    def _norm_pattern(self, mode: str, pin: int, period: int, bits: list[int] | str | None) -> dict[str, Any]:
        start = len(self.s.cycles)
        if mode == "square":
            # the JS twin rounds here (its UI cfg may carry a float); this
            # side's callers are ints by signature — only the even-up and
            # the floor survive the translation
            p = max(2, period)
            if p & 1:
                p += 1  # even periods only (half low / half high)
            return {"mode": "square", "pin": pin, "period": p, "bits": [0], "start_idx": start}
        bl = [int(b) for b in bits] if isinstance(bits, str) else (list(bits) if bits else [])
        return {"mode": "bits", "pin": pin, "period": 16, "bits": bl or [0], "start_idx": start}

    def gpio_in_series(self) -> list[int]:
        """The composed gpio_in per appended cycle (the sticky discipline:
        op clks carry the last composed level) — the JS twin's
        allGpioIn(), the stimulus rows' and the goldens' driven series."""
        return [c[0] for c in self.s.cycles]

    def drain_all(self, sm: int = 0) -> int:
        """Read FLEVEL, then drain exactly the reported RX level — the
        pushed words in push order, never past the level (RXUNDER is a
        defect, not an observation). -> the number of words drained."""
        self.flevel()
        reads = [r for r in run_model_trace(self.s) if r[0] == "R"]  # the freshest FLEVEL read
        lvl = (reads[-1][3] >> (4 + 8 * sm)) & 0xF  # SPEC-7-29: RX0 7:4, RX1 15:12, ...
        self.drain(lvl, sm)
        return lvl

    # -- the load timeline (engine-driver.js load): nonzero imem words,
    #    then per SM PINCTRL, EXECCTRL, SHIFTCTRL, the one SPEC-6-2 settle
    #    clk, per-SM CLKDIV while non-default, the per-SM entry force,
    #    per-SM seed feeds (TXFx), one CTRL write enabling the mask.
    def load(self, words: list[int], cfgs: list[dict[str, Any]]) -> None:
        for i, w in enumerate(words):
            if w:
                self.s.w(stim.A_IMEM0 + 4 * i, w)
        for i, c in enumerate(cfgs):
            self.s.w(stim.sm_addr(i, 5), c["pinctrl"])
            self.s.w(stim.sm_addr(i, 1), c["execctrl"])
            self.s.w(stim.sm_addr(i, 2), c["shiftctrl"])
        self._step_clk()  # the SPEC-6-2 settle clk
        for i, c in enumerate(cfgs):
            cw = c.get("clkdiv")
            if cw is not None and cw != stim.clkdiv():
                self.s.w(stim.sm_addr(i, 0), cw)
        for i, c in enumerate(cfgs):
            entry = c.get("entry")
            if entry is not None:
                self.s.set_pc(entry, sm=i)  # jmp entry (set_pc idiom)
        for i, c in enumerate(cfgs):
            for f in c.get("feeds", ()):  # type: ignore[union-attr]
                self.s.feed(f, sm=i)
        mask = 0
        for i, c in enumerate(cfgs):
            if c.get("en", True):
                mask |= 1 << i
        self.s.enable(mask)

    def set_shiftctrl(self, sm: int, word: int, *, fjoin_changed: bool) -> None:
        self.s.w(stim.sm_addr(sm, 2), word)
        if fjoin_changed:
            self._step_clk()  # the SPEC-6-2 settle clk

    def set_pinctrl(self, sm: int, word: int) -> None:
        self.s.w(stim.sm_addr(sm, 5), word)

    def drain(self, n: int, sm: int = 0) -> None:
        for _ in range(n):
            self.s.r(stim.A_RXF0 + 4 * sm)

    def read(self, addr: int) -> None:
        self.s.r(addr)

    def flevel(self) -> None:
        self.read(stim.A_FLEVEL)


def _sm_cfg(
    pinctrl_w: int | None = None,
    exec_w: int | None = None,
    shift_w: int | None = None,
    clkdiv_w: int | None = None,
    feeds: tuple[int, ...] = (),
    entry: int | None = None,
    en: bool = True,
) -> dict[str, Any]:
    """One SM's load config — the reset overlay by default (the stored
    program's reset words, model.py CLKDIV/EXECCTRL/SHIFTCTRL/PINCTRL
    _RESET)."""
    return {
        "pinctrl": pinctrl_w if pinctrl_w is not None else stim.pctrl(set_cnt=5),
        "execctrl": exec_w if exec_w is not None else stim.execctrl(1, 31, status_sel=3, status_n=31),
        "shiftctrl": shift_w if shift_w is not None else stim.shiftctrl(),
        "clkdiv": clkdiv_w,
        "feeds": feeds,
        "entry": entry,
        "en": en,
    }


def _leg_trace(m: _SandboxMirror, **extra: Any) -> dict[str, Any]:
    """pio_model's oracle for one leg: the per-clk gpio_out words
    (SPEC-16-7 G records — full 32-bit, stronger than the C18 bit0
    series) and the ordered reg-read records."""
    recs = run_model_trace(m.s)
    gpio: list[int] = []
    reads: list[list[int]] = []
    for rec in recs:
        if rec[0] == "G":
            gpio.append(rec[2])
        elif rec[0] == "R":
            reads.append([rec[2], rec[3]])
    return {"gpio": gpio, "reads": reads, **extra}


def _frame_bits(byte: int, idle_cells: int = 2) -> list[int]:
    """One 8N1 frame as a pasted bitstream (8 clks/bit) — the JS twin is
    frameBits() in web/node_client_gate.js."""
    cells = [1] * idle_cells + [0] + [(byte >> i) & 1 for i in range(8)] + [1]
    return [c for c in cells for _ in range(8)]


def _client_legs() -> list[tuple[str, dict[str, Any]]]:
    """(name, expected) per leg — the python twins of LEGS in
    web/node_client_gate.js, call for call."""
    legs: list[tuple[str, dict[str, Any]]] = []
    off = _sm_cfg(en=False)  # the single-SM legs' SM1..3: disabled, reset overlay

    # uart_demo — the demoted level-02 fixture (the C18 leg)
    m = _SandboxMirror()
    m.load(
        [0x9FA0, 0xF727, 0x6001, 0x0642],
        [
            _sm_cfg(
                stim.pctrl(ss_cnt=2, out_cnt=1),
                stim.execctrl(3, 0, side_en=True),
                stim.shiftctrl(fjoin_tx=True),
                feeds=(0x50, 0x49, 0x4F, 0x21),  # 'P','I','O','!'
            ),
            off,
            off,
            off,
        ],
    )
    m.run(CLIENT_RUN_CLKS)
    m.flevel()
    legs.append(("uart_demo", _leg_trace(m, decoded="PIO!", txMirror=True)))

    # pin_echo — manual drives + the square pattern through a mov-pins
    # echo (set pindirs makes pin0 an output; in_base 3: out pin k echoes
    # input pin k+3, so pin0 shows the pin3 drives and pin1 the pin4
    # pattern); the square lens verdict is read off the echoed wave.
    m = _SandboxMirror()
    m.load(
        [E.encode_set("pindirs", 1), E.encode_mov("pins", "pins", E.MOP_NONE), E.encode_jmp(None, 1)],
        [
            _sm_cfg(stim.pctrl(set_cnt=1, in_base=3), stim.execctrl(2, 1)),
            off,
            off,
            off,
        ],
    )
    m.set_drive(3, 1)
    m.run(12)
    m.set_drive(3, 0)
    m.run(9)
    m.set_drive(3, 1)
    m.run(7)
    m.set_pattern(mode="square", pin=4, period=16)
    m.run(64)
    m.flevel()
    legs.append(("pin_echo", _leg_trace(m, square={"period": 16, "dutyPct": 50})))

    # clkdiv_frac — a set-pins squarewave behind CLKDIV INT=2 FRAC=128
    m = _SandboxMirror()
    m.load(
        [E.encode_set("pins", 1, 3), E.encode_set("pins", 0, 3), E.encode_jmp(None, 0)],
        [
            _sm_cfg(stim.pctrl(set_cnt=1), stim.execctrl(2, 0), clkdiv_w=stim.clkdiv(2, 128)),
            off,
            off,
            off,
        ],
    )
    m.run(150)
    m.flevel()
    legs.append(("clkdiv_frac", _leg_trace(m)))

    # join_rx_drain — the sampler (in pins,1 [7] + autopush @8, in_base 5)
    # under a pasted-frame bitstream; RXF0 drains, a mid-run FJOIN_RX
    # overlay edit (flush + settle), drains into the 8-deep.
    m = _SandboxMirror()
    m.load(
        [E.encode_in("pins", 1, 7), E.encode_jmp(None, 0)],
        [
            _sm_cfg(stim.pctrl(in_base=5), stim.execctrl(1, 0), stim.shiftctrl(push_thr=8, autopush=True)),
            off,
            off,
            off,
        ],
    )
    m.set_pattern(mode="bits", pin=5, bits=_frame_bits(0x55))  # 'U'
    m.run(208)  # ~3 sample groups land in the 4-deep RX
    m.drain(2)  # the JS twin's drainRx(2, 0) + run(2): two read clks
    m.flevel()  # 1 word remains
    # the JS twin's setOverlayField(...) + run(2): the write clk (sticky
    # gpio_in) + the SPEC-6-2 settle clk, appended here directly
    m.set_shiftctrl(0, stim.shiftctrl(fjoin_rx=True, push_thr=8, autopush=True), fjoin_changed=True)
    m.run(520)  # ~8 sample groups into the 8-deep RX
    m.drain(6)  # the JS twin's drainRx(6, 0) + run(6): six read clks
    m.flevel()
    legs.append(("join_rx_drain", _leg_trace(m, rxMirror=True)))

    # aux_putget — FJOIN_RX_PUT: the SM PUTs ISR into the RX storage
    # (mov rxfifo[y], isr, index 0 via set y,0), the system reads the
    # window back (SPEC-7-13). in pins,8 grabs pins 12..5 into ISR[31:24].
    m = _SandboxMirror()
    m.load(
        [E.encode_set("y", 0), E.encode_in("pins", 8, 1), E.encode_put(None), E.encode_jmp(None, 1)],
        [
            _sm_cfg(stim.pctrl(in_base=5), stim.execctrl(3, 1), stim.shiftctrl(fjoin_rx_put=True)),
            off,
            off,
            off,
        ],
    )
    for pin, lvl in {5: 1, 6: 0, 7: 1, 8: 1, 9: 0, 10: 1, 11: 0, 12: 1}.items():
        m.set_drive(pin, lvl)
    m.run(16)
    m.read(stim.A_PUTGET0)  # 0xAD000000: pins 12..5 as ISR[31:24]
    m.read(stim.A_PUTGET0 + 4)  # storage 1: never written
    m.set_drive(5, 0)
    m.set_drive(12, 0)  # flip both end pins
    m.run(16)
    m.read(stim.A_PUTGET0)  # 0x2C000000 after the flip
    legs.append(("aux_putget", _leg_trace(m)))

    # ---- the C24 multi-SM legs: load / parallel / IRQ / arbitration ----

    # multi_load — the per-SM windows end to end: SM1 squares pin 1 while
    # SM2 echoes TXF2 -> RXF2 (pull/mov/push at slots 8..11 behind an
    # entry force), the drains read RXF2 back, FLEVEL shows the per-SM
    # nibbles. SM0/SM3 stay disabled.
    echo = [
        E.encode_pull(False, True, 0),  # pull block
        E.encode_mov("isr", "osr", E.MOP_NONE, 0),
        E.encode_push(False, True, 0),  # push block
        E.encode_jmp(None, 8, 0),
    ]
    m = _SandboxMirror()
    m.load(
        [E.encode_set("pins", 1, 1), E.encode_set("pins", 0, 1)] + [0] * 6 + echo,
        [
            off,
            _sm_cfg(stim.pctrl(set_cnt=1, set_base=1), stim.execctrl(1, 0)),
            _sm_cfg(exec_w=stim.execctrl(11, 8), feeds=(0xCAFEBABE, 0x13579BDF, 2), entry=8),
            off,
        ],
    )
    m.run(120)
    m.flevel()
    m.drain(3, sm=2)  # the JS twin's drainRx(3, 2)
    m.flevel()
    m.run(40)
    legs.append(("multi_load", _leg_trace(m, rxMirror=True)))

    # multi_parallel — four SMs on one shared imem, per-SM SET_BASE pins
    # (SM i squares pin i), SM2 behind its own divider (CC-26 is per SM).
    m = _SandboxMirror()
    m.load(
        [E.encode_set("pins", 1, 1), E.encode_set("pins", 0, 1)],
        [
            _sm_cfg(stim.pctrl(set_cnt=1, set_base=0), stim.execctrl(1, 0)),
            _sm_cfg(stim.pctrl(set_cnt=1, set_base=1), stim.execctrl(1, 0)),
            _sm_cfg(stim.pctrl(set_cnt=1, set_base=2), stim.execctrl(1, 0), clkdiv_w=stim.clkdiv(2)),
            _sm_cfg(stim.pctrl(set_cnt=1, set_base=3), stim.execctrl(1, 0)),
        ],
    )
    m.run(120)
    m.read(stim.A_FSTAT)
    m.flevel()
    m.read(stim.A_PADOUT)
    m.run(40)
    legs.append(("multi_parallel", _leg_trace(m)))

    # multi_irq — inter-SM IRQ handoff (the multi_irq_handoff corpus
    # program through the sandbox): SM1 `irq 0 rel` sets flag 1, SM3
    # `irq 0 rel` flag 3 (SPEC-3.8-6); SM0/SM2 wait on their flags, set
    # their pin, and jump home — the completing WAIT-1 clears (CC-15),
    # so the flags chatter while the two setters loop.
    words = [0] * 32
    words[0] = E.encode_wait(1, E.WSRC_IRQ, 1, 0)  # SM0 @0
    words[1] = E.encode_set("pins", 1, 0)
    words[2] = E.encode_jmp(None, 0, 0)
    words[8] = E.encode_irq(False, False, 2, 0, 0)  # SM1 @8: irq 0 rel
    words[9] = E.encode_jmp(None, 8, 0)
    words[16] = E.encode_wait(1, E.WSRC_IRQ, 3, 0)  # SM2 @16
    words[17] = E.encode_set("pins", 1, 1)
    words[18] = E.encode_jmp(None, 16, 0)
    words[26] = E.encode_irq(False, False, 2, 0, 0)  # SM3 @26: irq 0 rel
    words[27] = E.encode_jmp(None, 26, 0)
    m = _SandboxMirror()
    m.load(
        words,
        [
            _sm_cfg(stim.pctrl(set_cnt=1, set_base=0), stim.execctrl(2, 0)),
            _sm_cfg(exec_w=stim.execctrl(9, 8), entry=8),
            _sm_cfg(stim.pctrl(set_cnt=1, set_base=2), stim.execctrl(17, 16), entry=16),
            _sm_cfg(exec_w=stim.execctrl(27, 26), entry=26),
        ],
    )
    m.run(80)
    m.read(stim.A_IRQ)
    m.run(20)
    m.read(stim.A_IRQ)
    m.run(40)
    legs.append(("multi_irq", _leg_trace(m)))

    # multi_arb — cross-SM pin priority (CC-7): SM0 writes 0 and SM3
    # writes 1 to pin 0 every clk (mov pins), SM1 toggles pin 1 in
    # parallel; mid-run SM3's OUT_BASE moves to pin 2 (the overlay edit
    # the --defect=smaddr mutation demo must misaddress).
    m = _SandboxMirror()
    arb_words = [0] * 32
    arb_words[0] = E.encode_mov("pins", "null", E.MOP_NONE)
    arb_words[1] = E.encode_mov("pins", "null", E.MOP_NONE)
    arb_words[8] = E.encode_set("pins", 1, 3)
    arb_words[9] = E.encode_set("pins", 0, 3)
    arb_words[16] = E.encode_mov("pins", "null", E.MOP_INV)
    arb_words[17] = E.encode_mov("pins", "null", E.MOP_INV)
    m.load(
        arb_words,
        [
            _sm_cfg(stim.pctrl(out_cnt=1), stim.execctrl(1, 0)),
            _sm_cfg(stim.pctrl(set_cnt=1, set_base=1), stim.execctrl(9, 8), entry=8),
            off,
            _sm_cfg(stim.pctrl(out_cnt=1), stim.execctrl(17, 16), entry=16),
        ],
    )
    m.run(90)
    m.read(stim.A_PADOUT)
    m.read(stim.A_PADOE)
    # the JS twin's setOverlayField(3, 'pinctrl', 'outBase', 2): SM3's
    # window takes the write, pin 2 becomes SM3's — the queued write
    # retires inside the twin's run(16), so the mirror counts it here
    m.set_pinctrl(3, stim.pctrl(out_cnt=1, out_base=2))
    m.run(15)
    m.read(stim.A_PADOUT)
    m.run(14)
    legs.append(("multi_arb", _leg_trace(m)))

    return legs


def _client_expected() -> dict[str, object]:
    return {"legs": dict(_client_legs())}


def run_client_gate(engine: Path, expected: Path, defect: str | None = None) -> subprocess.CompletedProcess[str]:
    cmd = ["node", _rel(WEB / "node_client_gate.js"), _rel(engine), _rel(expected)]
    if defect:
        cmd.append(f"--defect={defect}")
    return _run(cmd, check=False)


def cmd_client(engine: Path | None = None) -> int:
    if engine is None:
        engine = build_engine(BUILD / "web")
    exp = _client_expected()
    exp_path = BUILD / "web" / "client_expected.json"
    exp_path.parent.mkdir(parents=True, exist_ok=True)
    exp_path.write_text(json.dumps(exp))
    fails = 0

    def report(r: subprocess.CompletedProcess[str]) -> list[str]:
        return [ln for ln in (r.stdout + r.stderr).splitlines() if ln.startswith(("PASS", "FAIL"))]

    # Green: the clean client core against the model oracle.
    print("--- client gate: driver vs pio_model oracle (5 sandbox + 4 multi-SM legs)")
    r = run_client_gate(engine, exp_path)
    for ln in report(r):
        print(f"  {ln}")
    if r.returncode != 0:
        fails += 1
        print("FAIL client: diverged from the model oracle (see above)")
    else:
        print(f"PASS client: green ({sum(1 for ln in report(r) if ln.startswith('PASS'))} checks)")

    # Mutation demo legs — the client-side red-injection hooks.
    print("--- client mutation demo 1: --defect=pin (model gpio diff catches)")
    r = run_client_gate(engine, exp_path, defect="pin")
    pin_fail = next((ln for ln in report(r) if ln.startswith("FAIL uart_demo pin")), "")
    if r.returncode == 0 or not pin_fail:
        fails += 1
        print("FAIL defect_pin: NOT caught (the pin series never diverges?)")
    else:
        print(f"PASS defect_pin: red ({pin_fail.split(' — ', 1)[-1]})")

    print("--- client mutation demo 2: --defect=mirror (mirror-vs-engine check catches)")
    r = run_client_gate(engine, exp_path, defect="mirror")
    mir_fail = next((ln for ln in report(r) if ln.startswith("FAIL uart_demo tx mirror")), "")
    if r.returncode == 0 or not mir_fail:
        fails += 1
        print("FAIL defect_mirror: NOT caught (the mirror never disagrees?)")
    else:
        print(f"PASS defect_mirror: red ({mir_fail.split(' — ', 1)[-1]})")

    # C24 — the SM-window stride transcription defect: the mid-run SM3
    # OUT_BASE edit on the arbitration leg lands outside SM3's window,
    # so the machine keeps writing pin 0 and the gpio series diverges.
    print("--- client mutation demo 3: --defect=smaddr (model gpio diff catches)")
    r = run_client_gate(engine, exp_path, defect="smaddr")
    adr_fail = next((ln for ln in report(r) if ln.startswith("FAIL multi_arb gpio series")), "")
    if r.returncode == 0 or not adr_fail:
        fails += 1
        print("FAIL defect_smaddr: NOT caught (the window stride never bites?)")
    else:
        print(f"PASS defect_smaddr: red ({adr_fail.split(' — ', 1)[-1]})")
    return 1 if fails else 0


# ---------------------------------------------------------------------------


def cmd_self_test() -> int:
    rc = cmd_lint()
    engine = cmd_build()
    rc |= cmd_threeway(engine)
    rc |= cmd_mutation_demo(engine)
    rc |= cmd_client(engine)
    print(f"=== self-test {'PASS' if rc == 0 else 'FAIL'}")
    return rc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lint", action="store_true")
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--threeway", action="store_true")
    ap.add_argument("--fuzz", type=int, default=6, metavar="N")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--mutation-demo", action="store_true")
    ap.add_argument("--client", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    rc = 0
    if args.lint:
        rc |= cmd_lint()
    if args.build:
        cmd_build()
    if args.threeway:
        rc |= cmd_threeway(fuzz_n=args.fuzz, seed=args.seed)
    if args.mutation_demo:
        rc |= cmd_mutation_demo(build_engine(BUILD / "web"))
    if args.client:
        rc |= cmd_client(build_engine(BUILD / "web"))
    if args.self_test:
        rc |= cmd_self_test()
    if not any([args.lint, args.build, args.threeway, args.mutation_demo, args.client, args.self_test]):
        ap.print_help()
        rc = 2
    return rc


if __name__ == "__main__":
    sys.exit(main())

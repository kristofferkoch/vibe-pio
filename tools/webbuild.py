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
  --client        (5) the C18 client gate: web/engine-driver.js (the
                  exact client core the browser worker runs) drives the
                  wasm engine's game face through the level-02 load
                  timeline; pio_model produces the expected pin series
                  + final FLEVEL for the identical timeline and the
                  node gate requires pin-identical samples, the
                  reg-read value, the decoded 'PIO!' monitor output and
                  the TX-mirror/tx_level agreement. Plus the two
                  client-side mutation demos (red, then green):
                  CLIENT_DEFECT_PIN (pin sampled off gpio_out bit 1 —
                  caught by the model pin diff) and
                  CLIENT_DEFECT_MIRROR (TX contents mirror never pops —
                  caught by the mirror-vs-engine level check).
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
# Gate 5: the C18 client gate (driver-level, model-cross-checked).
# ---------------------------------------------------------------------------

# The client-gate run length: 4 frames x 80 clks + startup/stall tail —
# 'P','I','O','!' decoded and the SM parked in the TX-empty stall.
CLIENT_RUN_CLKS = 360


def _client_level_sched() -> stim.Schedule:
    """The level-02 load timeline, mirroring web/engine-driver.js load()
    cycle for cycle (imem words, PINCTRL, EXECCTRL, SHIFTCTRL, the
    SPEC-6-2 settle clk, seed feeds, enable) then CLIENT_RUN_CLKS clks
    and a final FLEVEL read. web/sm-view.js asserts the words match
    VibeDriver.LEVEL; this python mirror is pinned by the pin-series
    comparison itself."""
    words = [0x9FA0, 0xF727, 0x6001, 0x0642]
    s = stim.Schedule()
    s.load_imem(words)
    s.w(stim.A_SM0 + 4 * 5, stim.pctrl(ss_cnt=2, out_cnt=1))
    s.w(stim.A_SM0 + 4 * 1, stim.execctrl(3, 0, side_en=True))
    s.w(stim.A_SM0 + 4 * 2, stim.shiftctrl(fjoin_tx=True))
    s.idle(1)
    for f in (0x50, 0x49, 0x4F, 0x21):  # 'P','I','O','!'
        s.feed(f)
    s.enable()
    s.run_to(len(s.cycles) + CLIENT_RUN_CLKS)
    s.r(stim.A_FLEVEL)
    return s


def _client_expected() -> dict[str, object]:
    """pio_model's oracle for the client run: the per-clk gpio_out bit0
    series (SPEC-16-7 G records) and the final FLEVEL read."""
    recs = run_model_trace(_client_level_sched())
    pins: list[int] = []
    flevel = None
    for rec in recs:
        if rec[0] == "G":
            pins.append(rec[2] & 1)
        elif rec[0] == "R" and rec[2] == stim.A_FLEVEL:
            flevel = rec[3]
    if flevel is None:
        raise RuntimeError("client oracle: model trace carries no FLEVEL R record")
    return {"runClks": CLIENT_RUN_CLKS, "pins": pins, "flevel": flevel}


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
    print("--- client gate: driver vs pio_model oracle (level 02, uart_tx)")
    r = run_client_gate(engine, exp_path)
    for ln in report(r):
        print(f"  {ln}")
    if r.returncode != 0:
        fails += 1
        print("FAIL client: diverged from the model oracle (see above)")
    else:
        print("PASS client: green")

    # Mutation demo legs — the client-side red-injection hooks.
    print("--- client mutation demo 1: --defect=pin (model pin diff catches)")
    r = run_client_gate(engine, exp_path, defect="pin")
    pin_fail = next((ln for ln in report(r) if ln.startswith("FAIL pins")), "")
    if r.returncode == 0 or not pin_fail:
        fails += 1
        print("FAIL defect_pin: NOT caught (the pin series never diverges?)")
    else:
        print(f"PASS defect_pin: red ({pin_fail.split(' — ', 1)[-1]})")

    print("--- client mutation demo 2: --defect=mirror (mirror-vs-engine check catches)")
    r = run_client_gate(engine, exp_path, defect="mirror")
    mir_fail = next((ln for ln in report(r) if ln.startswith("FAIL tx mirror")), "")
    if r.returncode == 0 or not mir_fail:
        fails += 1
        print("FAIL defect_mirror: NOT caught (the mirror never disagrees?)")
    else:
        print(f"PASS defect_mirror: red ({mir_fail.split(' — ', 1)[-1]})")
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

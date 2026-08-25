#!/usr/bin/env python3
"""C12 differential-test CLI: model vs RTL on the SPEC-16-7 observables.

Gates (KANBAN C12 done-when):
  --asm-check        (1) native assembler bit-equal to pioasm on every
                       conf_pioexamples program (live pioasm when
                       build/pioasm exists — the docker recipe in
                       sim/gen_conf_pioexamples.py — else the committed
                       pioasm words parsed out of sim/conf_pioexamples.svh),
                       plus the 65536-word disasm/reasm round-trip.
  --conformance      (2) model trace == RTL trace for every conformance
                       program (auto-generated pio-stim schedules on
                       sim/tb_trace_dump.sv).
  --fuzz N           (3) N randomized programs x stimulus, model vs RTL.
  --mutation-demo    (4) injected model bugs caught by the differ (red),
                       same cases green unmutated.

--self-test runs a quick pass of all four (the `make model` target).
The RTL runs through iverilog/vvp inside the vibe-pio container when no
native toolchain is on PATH (container/Dockerfile).
"""

import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pio_model import asm, disasm, encoding as E, model as M, stim, tracefmt

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BUILD = os.path.join(REPO, "build")
TB = os.path.join(REPO, "sim", "tb_trace_dump.sv")
EX = os.path.join(REPO, "third_party", "pico-examples")

# (source .pio, program name) — exactly sim/gen_conf_pioexamples.py's list.
CONF_PROGRAMS = [
    ("pio/squarewave/squarewave.pio", "squarewave"),
    ("pio/addition/addition.pio", "addition"),
    ("pio/ws2812/ws2812.pio", "ws2812"),
    ("pio/uart_tx/uart_tx.pio", "uart_tx"),
    ("pio/spi/spi.pio", "spi_cpha0"),
    ("pio/spi/spi.pio", "spi_cpha1"),
    ("pio/spi/spi.pio", "spi_cpha0_cs"),
    ("pio/clocked_input/clocked_input.pio", "clocked_input"),
    ("pio/quadrature_encoder/quadrature_encoder.pio",
     "quadrature_encoder"),
    ("pio/onewire/onewire_library/onewire_library.pio", "onewire"),
    ("pio/i2c/i2c.pio", "i2c"),
    ("pio/i2c/i2c.pio", "set_scl_sda"),
    ("pio/manchester_encoding/manchester_encoding.pio", "manchester_tx"),
    ("pio/manchester_encoding/manchester_encoding.pio", "manchester_rx"),
    ("pio/differential_manchester/differential_manchester.pio",
     "differential_manchester_tx"),
    ("pio/differential_manchester/differential_manchester.pio",
     "differential_manchester_rx"),
    ("pio/uart_rx/uart_rx.pio", "uart_rx"),
    ("pio/hub75/hub75.pio", "hub75_data_rgb888"),
    ("pio/apa102/apa102.pio", "apa102_rgb555"),
]

# Mutation-demo pairs are defined with gate 4 below (they mix conformance
# cases with synthetic mini-programs).


# ---------------------------------------------------------------------------
# Toolchain: native iverilog or the vibe-pio container.
# ---------------------------------------------------------------------------

def _toolchain():
    if shutil.which("iverilog"):
        return []
    if shutil.which("docker"):
        out = subprocess.run(["docker", "images", "-q", "vibe-pio:latest"],
                             capture_output=True, text=True).stdout.strip()
        if out:
            return ["docker", "run", "--rm", "-v", f"{REPO}:/work",
                    "-w", "/work", "vibe-pio:latest"]
    sys.exit("no iverilog on PATH and no vibe-pio docker image — see "
             "container/Dockerfile")


_VVP = None


def run_rtl_trace(mem_path, trace_path, vvp=None, log=None):
    """Run tb_trace_dump on one pio-stim image -> trace file (the vvp
    image is compiled once per process)."""
    global _VVP
    tc = _toolchain()
    rel = os.path.relpath(mem_path, REPO)
    rel_out = os.path.relpath(trace_path, REPO)
    if vvp is None:
        if _VVP is None:
            os.makedirs(BUILD, exist_ok=True)
            _VVP = os.path.join(BUILD, "tb_trace_dump.vvp")
            cmd = tc + ["iverilog", "-g2012", "-I", "sim", "-s",
                        "tb_trace_dump", "-o", os.path.relpath(_VVP, REPO),
                        os.path.relpath(TB, REPO)] \
                + [f"rtl/{p}" for p in sorted(os.listdir(
                    os.path.join(REPO, "rtl"))) if p.endswith(".sv")]
            subprocess.run(cmd, cwd=REPO, check=True,
                           stdout=subprocess.DEVNULL)
        vvp = _VVP
    cmd = tc + ["vvp", os.path.relpath(vvp, REPO),
                f"+stim={rel}", f"+trace={rel_out}"]
    r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)
    if log is not None:
        with open(log, "w") as f:
            f.write(r.stdout + r.stderr)
    if "TB STATUS : PASS" not in r.stdout:
        raise RuntimeError(f"RTL TB failed on {rel}:\n{r.stdout}\n{r.stderr}")


# ---------------------------------------------------------------------------
# Model side: run a Schedule -> trace records.
# ---------------------------------------------------------------------------

def run_model_trace(sched, mutations=()):
    mdl = M.PIOBlockModel(mutations=mutations)
    lines = []
    for k, c in enumerate(sched.cycles):
        gpio, lb, op, addr, wdata, nbs, nbc, prv, nxt = c
        gin = gpio
        if lb:  # fold loopback pins from the model's own outputs
            for p in range(32):
                if (lb >> p) & 1:
                    lv = (mdl.gpio_lvl_r >> p) & 1 if (mdl.gpio_oe_r >> p) & 1 \
                        else 0
                    gin = (gin & ~(1 << p)) | (lv << p)
        obs = mdl.step(gin, lb, op, addr, wdata, nbs, nbc, prv, nxt)
        lines.append(("G", k, obs["gpio_out"], obs["gpio_oe"], obs["intr"]))
        if op == stim.OP_RD:
            lines.append(("R", k, addr, obs["rdata"]))
    return lines


def diff_case(name, sched, mutations=(), verbose=True):
    """-> (ok, message). Runs model + RTL on one schedule and compares."""
    os.makedirs(BUILD, exist_ok=True)
    tag = re.sub(r"\W+", "_", name)
    mem = os.path.join(BUILD, f"stim_{tag}.mem")
    trl = os.path.join(BUILD, f"rtl_{tag}.trace")
    sched.write_mem(mem)
    try:
        model_lines = run_model_trace(sched, mutations)
        run_rtl_trace(mem, trl)
        rtl_lines = tracefmt.parse_trace(trl)
        tracefmt.compare(model_lines, rtl_lines)
    except tracefmt.TraceMismatch as ex:
        return False, str(ex)
    except (RuntimeError, ValueError) as ex:
        return False, f"harness error: {ex}"
    if verbose:
        print(f"PASS {name} ({len(sched.cycles)} clks"
              + (f", mutations={sorted(mutations)}" if mutations else "")
              + ")")
    return True, ""


# ---------------------------------------------------------------------------
# Gate 1: assembler vs pioasm (+ disassembler round-trip).
# ---------------------------------------------------------------------------

def _pioasm_words_live():
    """Run build/pioasm -o json per source -> {(rel, name): [words]}."""
    pioasm = os.path.join(BUILD, "pioasm")
    if not os.access(pioasm, os.X_OK):
        return None
    out = {}
    with tempfile.TemporaryDirectory() as td:
        for rel, name in CONF_PROGRAMS:
            dst = os.path.join(td, "o.json")
            r = subprocess.run([pioasm, "-o", "json",
                                os.path.join(EX, rel), dst],
                               capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError(f"pioasm failed on {rel}: {r.stderr}")
            doc = json.load(open(dst))
            prog = next(p for p in doc["programs"] if p["name"] == name)
            out[(rel, name)] = [int(i["hex"], 16)
                                for i in prog["instructions"]]
    return out


def _pioasm_words_svh():
    """Parse the committed pioasm words out of sim/conf_pioexamples.svh
    (the per-word hex literals of each load_<name> task)."""
    svh = open(os.path.join(REPO, "sim", "conf_pioexamples.svh")).read()
    out = {}
    for m in re.finditer(
            r"task automatic load_(\w+)\(input int base\);(.*?)endtask",
            svh, re.S):
        words = [int(w, 16) for w in
                 re.findall(r"32'h([0-9a-fA-F]{4})\b", m.group(2))]
        name = m.group(1)
        rel = next((r for r, n in CONF_PROGRAMS if n == name), name)
        out[(rel, name)] = words
    return out


def cmd_asm_check(args):
    ok = True
    ref = _pioasm_words_live()
    src = "build/pioasm (live)" if ref else None
    if ref is None:
        ref = _pioasm_words_svh()
        src = "sim/conf_pioexamples.svh (committed)"
    print(f"--- asm-check vs pioasm 2.3.0 words from {src}")
    for rel, name in CONF_PROGRAMS:
        progs = asm.parse_file(os.path.join(EX, rel))
        mine = next(p for p in progs if p.name == name)
        want = ref[(rel, name)]
        if mine.words != want:
            ok = False
            k = next(i for i in range(min(len(want), len(mine.words)))
                     if mine.words[i] != want[i]) \
                if len(mine.words) == len(want) else 0
            print(f"FAIL {name}: first diff at word {k}: "
                  f"{mine.words[k]:04x} vs pioasm {want[k]:04x}")
        else:
            print(f"PASS {name} ({len(want)} words bit-equal)")
    # disassembler round-trip across the whole word space
    print("--- disassembler round-trip (assemble(disassemble(w)) == w)")
    cfgs = [(False, 0), (False, 2), (True, 2), (True, 3)]
    bad = 0
    for side_en, ss in cfgs:
        prog = asm.Program("rt")
        prog.sideset_bits = ss - (1 if side_en else 0)
        prog.sideset_opt = side_en
        for w in range(1 << 16):
            try:
                txt = disasm.disassemble(w, side_en, ss)
            except E.ReservedEncoding:
                continue
            try:
                w2 = asm._assemble_instruction(txt, prog, {}, "rt")
            except asm.AsmError:
                bad += 1
                continue
            if w2 != w:
                bad += 1
    print(f"{'PASS' if bad == 0 else 'FAIL'} round-trip: {bad} mismatched,"
          f" {len(cfgs)} side-set configs x 65536 words")
    ok = ok and bad == 0
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# Gate 2: conformance matrix.
# ---------------------------------------------------------------------------

def cmd_conformance(args):
    cases = stim.conformance_schedules(REPO)
    fails = 0
    print(f"--- conformance: {len(cases)} program schedules")
    for name, sched in cases:
        ok, msg = diff_case(name, sched)
        if not ok:
            fails += 1
            print(f"FAIL {name}: {msg}")
    print(f"=== conformance: {len(cases) - fails} passed, {fails} failed")
    return 1 if fails else 0


# ---------------------------------------------------------------------------
# Gate 3: randomized differential fuzzing.
# ---------------------------------------------------------------------------

READ_ADDRS = stim.READ_POOL
WRITE_OPS = [  # SPEC-16-5 traffic-only free-phase writes
    ("w", stim.A_TXF0, lambda r: r.getrandbits(32)),
    ("w", stim.A_FDEBUG, lambda r: 1 << r.randrange(32)),
    ("w", stim.A_IRQ, lambda r: 1 << r.randrange(8)),
    ("w", stim.A_IRQ_FORCE, lambda r: 1 << r.randrange(8)),
    ("w", stim.A_ISB, lambda r: r.getrandbits(32)),
]


def _random_program(rng):
    """Random instruction mix biased to the stall/auto/EXEC corners."""
    words, n = [], rng.randrange(4, 13)
    for i in range(n):
        cls = rng.choices(
            [E.C_JMP, E.C_WAIT, E.C_IN, E.C_OUT, E.C_PP, E.C_MOV,
             E.C_IRQ, E.C_SET],
            weights=[3, 2, 3, 3, 3, 2, 1, 2])[0]
        ds = rng.choice([0, 0, 0, 1, 2, rng.randrange(32)])
        if cls == E.C_JMP:
            w = E.encode_jmp(rng.choice(list(E.JMP_CONDS)),
                             rng.randrange(32), ds)
        elif cls == E.C_WAIT:
            src = rng.choice([E.WSRC_GPIO, E.WSRC_PIN, E.WSRC_IRQ])
            w = E.encode_wait(rng.randrange(2), src, rng.randrange(32), ds)
        elif cls == E.C_IN:
            w = E.encode_in(rng.choice(list(E.IN_SRCS)),
                            rng.choice([1, 2, 4, 8, 31, 32]), ds)
        elif cls == E.C_OUT:
            w = E.encode_out(rng.choice(list(E.OUT_DSTS)),
                             rng.choice([1, 2, 4, 8, 16, 32]), ds)
        elif cls == E.C_PP:
            if rng.random() < 0.3 and ds == 0:
                w = (E.encode_put if rng.random() < 0.5 else E.encode_get)(
                    rng.randrange(4) if rng.random() < 0.5 else None, ds)
            else:
                w = E.encode_push(rng.randrange(2), rng.randrange(2), ds) \
                    if rng.random() < 0.5 \
                    else E.encode_pull(rng.randrange(2), rng.randrange(2), ds)
        elif cls == E.C_MOV:
            w = E.encode_mov(rng.choice(["x", "y", "isr", "osr", "pins",
                                         "pc", "exec", "pindirs"]),
                             rng.choice(["x", "y", "isr", "osr", "null",
                                         "pins", "status"]),
                             rng.randrange(3), ds)
        elif cls == E.C_IRQ:
            w = E.encode_irq(rng.choice([0, 0, 0, 1]),
                             rng.choice([0, 0, 0, 1]),
                             rng.randrange(4), rng.randrange(8), ds)
        else:
            w = E.encode_set(rng.choice(["pins", "x", "y", "pindirs"]),
                             rng.randrange(32), ds)
        words.append(w)
    return words


def _random_case(rng, idx):
    words = _random_program(rng)
    wrap_top = len(words) - 1
    ss_cnt = rng.choice([0, 0, 1, 2])
    s = stim.Schedule()
    s.load_imem(words)
    s.w(stim.A_SM0 + 4 * 5, stim.pctrl(
        ss_cnt=ss_cnt, set_cnt=rng.choice([0, 1, 2]),
        out_cnt=rng.choice([0, 1, 2, 5]), in_base=rng.randrange(32),
        ss_base=rng.randrange(32), set_base=rng.randrange(32),
        out_base=rng.randrange(32)))
    s.w(stim.A_SM0 + 4 * 1, stim.execctrl(
        wrap_top, rng.randrange(wrap_top + 1) if wrap_top else 0,
        jmp_pin=rng.randrange(32),
        side_en=(ss_cnt > 0 and rng.random() < 0.5),
        out_sticky=rng.random() < 0.3,
        status_sel=rng.randrange(4), status_n=rng.choice([0, 1, 4, 8, 31])))
    s.w(stim.A_SM0 + 4 * 2, stim.shiftctrl(
        fjoin_rx=rng.random() < 0.1, fjoin_tx=rng.random() < 0.1,
        pull_thr=rng.choice([0, 1, 4, 8, 16]),
        push_thr=rng.choice([0, 1, 4, 8, 16]),
        out_right=rng.random() < 0.5, in_right=rng.random() < 0.5,
        autopull=rng.random() < 0.6, autopush=rng.random() < 0.6,
        fjoin_rx_put=rng.random() < 0.08,
        fjoin_rx_get=rng.random() < 0.08))
    if rng.random() < 0.3:
        s.w(stim.A_SM0 + 4 * 0,
            stim.clkdiv(rng.choice([1, 1, 2, 3]),
                        rng.choice([0, 85, 128, 200])))
    if rng.random() < 0.25:
        s.set_pc(rng.randrange(len(words)))    # prologue-phase force
    for _ in range(rng.randrange(4)):
        s.feed(rng.getrandbits(32))
    s.enable()
    # free phase
    n = rng.randrange(180, 420)
    gpio = 0
    while len(s.cycles) < n:
        r = rng.random()
        if r < 0.10:
            gpio = rng.getrandbits(32) if rng.random() < 0.3 \
                else gpio ^ (1 << rng.randrange(32))
            s.set_gpio(gpio)
        elif r < 0.16:
            _, addr, gen = rng.choice(WRITE_OPS)
            s.w(addr, gen(rng))
        elif r < 0.22:
            s.r(rng.choice(READ_ADDRS))
        else:
            s.idle()
    s.r(stim.A_FSTAT)
    s.r(stim.A_FLEVEL)
    return f"fuzz{idx:03d}", s


def cmd_fuzz(n, seed):
    rng = random.Random(seed)
    fails = 0
    print(f"--- fuzz: {n} random program x stimulus cases (seed {seed})")
    for i in range(n):
        name, sched = _random_case(rng, i)
        ok, msg = diff_case(name, sched, verbose=False)
        if not ok:
            fails += 1
            print(f"FAIL {name} (seed {seed}): {msg}")
        else:
            print(f"PASS {name} ({len(sched.cycles)} clks)")
    print(f"=== fuzz: {n - fails} passed, {fails} failed")
    return 1 if fails else 0


# ---------------------------------------------------------------------------
# Gate 4: mutation demo (red), then green. Each pair names the mutated
# fact and a case that deterministically drives the mutated path within
# its horizon: conformance programs where they qualify, synthetic
# mini-programs where none do (ws2812-style loops always leave a
# non-OUT tick between OUTs, so the CC-11 stall-refill corner and the
# same-clk IRQ-force/WAIT race get dedicated schedules).
# ---------------------------------------------------------------------------

def _mini_cc11():
    """Back-to-back OUTs with autopull@1: the first OUT hits the CC-11
    stall-with-refill path on its very first tick, and the out pins make
    the mutation's one-tick advance observable immediately."""
    words = [E.encode_out("pins", 1, 0),         # 0: out pins,1
             E.encode_out("pins", 1, 0),         # 1: out pins,1
             E.encode_jmp(None, 0, 0)]           # 2: jmp 0
    s = stim.Schedule()
    s.load_imem(words)
    s.w(stim.A_SM0 + 4 * 1, stim.execctrl(2, 0))
    s.w(stim.A_SM0 + 4 * 2, stim.shiftctrl(pull_thr=1, autopull=True))
    s.w(stim.A_SM0 + 4 * 5, stim.pctrl(out_cnt=1))
    for _ in range(4):
        s.feed(0xAAAAAAAA)
    s.enable()
    s.run_to(60)
    s.r(stim.A_FSTAT)
    s.run_to(80)
    return s


def _mini_irq37():
    """`wait 1 irq 0` at clkdiv 1 with an IRQ_FORCE write scheduled on
    the exact clk the WAIT's tick evaluates (both sides identical), so
    the CC-37 one-cycle visibility rule is the only thing keeping the
    completion tick honest."""
    words = [E.encode_wait(1, E.WSRC_IRQ, 0, 0),   # 0: wait 1 irq 0
             E.encode_set("pins", 1, 0),           # 1: set pins,1
             E.encode_jmp(None, 1, 0)]             # 2: jmp 1
    s = stim.Schedule()
    s.load_imem(words)
    s.w(stim.A_SM0 + 4 * 1, stim.execctrl(2, 0))
    s.w(stim.A_SM0 + 4 * 5, stim.pctrl(0, 1, 0, 0, 0, 0, 0))
    s.enable()
    s.run_to(40)
    s.w(stim.A_IRQ_FORCE, 1)                  # flag set retires end-of-clk
    s.run_to(80)
    s.r(stim.A_IRQ)
    s.run_to(96)
    return s


MUTATION_DEMO = [
    ("cc11_no_stall", None, _mini_cc11),          # CC-11/CC-12
    ("jmp_postdec", "addition", None),            # SPEC-14.5-1
    ("sync_1ff", "clocked_input", None),          # CC-23
    ("wrap_off", "spi_cpha0", None),              # SPEC-8-2 (pure wrap loop)
    ("ss_opt_ignored", "uart_tx", None),          # SPEC-4-2
    ("delay_in_stall", "ws2812", None),           # CC-14
    ("irq_same_cycle", None, _mini_irq37),        # CC-37
]


def cmd_mutation_demo(args):
    cases = dict(stim.conformance_schedules(REPO))
    fails = 0
    print("--- mutation demo: injected model bug (red) / removed (green)")
    for mut, case, mini in MUTATION_DEMO:
        sched = mini() if mini else cases[case]
        name = case or mut
        ok_red, msg = diff_case(f"{name}+{mut}", sched, (mut,),
                                verbose=False)
        ok_green, _ = diff_case(f"{name}-clean", sched, (),
                                verbose=False)
        if ok_red:
            fails += 1
            print(f"FAIL {mut} on {name}: NOT caught (the case never "
                  "drives the mutated path, or the model matches the "
                  "RTL bug-for-bug)")
        elif not ok_green:
            fails += 1
            print(f"FAIL {name}: unmutated run diverged: {msg}")
        else:
            print(f"PASS {mut} on {name}: red ({msg}) / green")
    return 1 if fails else 0


# ---------------------------------------------------------------------------

def cmd_self_test(args):
    rc = 0
    rc |= cmd_asm_check(args)
    rc |= cmd_conformance(args)
    rc |= cmd_fuzz(6, 1)
    rc |= cmd_mutation_demo(args)
    print(f"=== self-test {'PASS' if rc == 0 else 'FAIL'}")
    return rc


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--asm-check", action="store_true")
    ap.add_argument("--conformance", action="store_true")
    ap.add_argument("--fuzz", type=int, metavar="N")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--mutation-demo", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    rc = 0
    if args.asm_check:
        rc |= cmd_asm_check(args)
    if args.conformance:
        rc |= cmd_conformance(args)
    if args.fuzz:
        rc |= cmd_fuzz(args.fuzz, args.seed)
    if args.mutation_demo:
        rc |= cmd_mutation_demo(args)
    if args.self_test:
        rc |= cmd_self_test(args)
    if not any([args.asm_check, args.conformance, args.fuzz,
                args.mutation_demo, args.self_test]):
        ap.print_help()
        rc = 2
    return rc


if __name__ == "__main__":
    sys.exit(main())

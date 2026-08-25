#!/usr/bin/env python3
"""Equivalence-oracle CLI (KANBAN C13): program pair + horizon -> verdict.

Pipeline for one case (--a/--b, words or .pio programs; --horizon N):

  1. Python-model pre-filter (C12): both programs run in lockstep through
     PIOBlockModel on shared random stimulus that mirrors the C11 miter's
     free-phase rules (SPEC-16-5 traffic-only broadcast writes) and the
     miter's fixed config (EXECCTRL per --execctrl; CLKDIV/SHIFTCTRL/
     PINCTRL at reset — the v1 single-config scope, SPEC-16-6). A
     SPEC-16-7 trace divergence is a definite FAIL, decoded on the spot.
  2. sby certification: a generated C11 miter instance
     (pio_equiv_miter #(...PROG_A/PROG_B...) — formal/pio_equiv_fv.sv)
     through `sby -f` bmc at depth N (SPEC-16-3 bounded equivalence).
  3. On sby FAIL the counterexample VCD is decoded into a divergence
     report (first differing observable, cycle, pin, disassembled PCs —
     SPEC-16-1/2), and the CEX stimulus is replayed through both C12
     models to verify it reproduces the divergence.

Verdicts / exit codes: PASS 0, FAIL 1, TIMEOUT 2, ERROR 3.

--self-test runs the committed suite (the `make equiv` gate): hermetic
fixture checks (packing, VCD decode red/green, SPEC-16-2 exclusion
handling, pre-filter red/green — patterned on tools/trace_audit.py
--self-test) plus the end-to-end cases: equivalent pair PASS, inequivalent
pair FAIL via pre-filter, inequivalent pair FAIL via sby with the decoded
CEX report, and the timeout path. End-to-end needs sby on PATH or the
vibe-pio container image (the difftest toolchain fallback).

The script is stdlib-only (runs in the container too); case artifacts
land under build/equiv/<tag>/ and are removed on PASS (kept on FAIL).
"""

from __future__ import annotations

import argparse
import dataclasses
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import TypedDict, cast

TOOLS = str(Path(__file__).resolve().parent)
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from pio_model import (  # noqa: E402
    asm,
    disasm,
    stim,
    tracefmt,
)
from pio_model import encoding as E  # noqa: E402
from pio_model import model as M  # noqa: E402

REPO = Path(TOOLS).parent
BUILD = REPO / "build"
FORMAL = REPO / "formal"
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
)
WRAPPER_MOD = "pio_equiv_case"  # deterministic top; ports = pio_equiv_miter's
WRAPPER_FILE = "pio_equiv_case_fv.sv"  # flat-copied into src/ (unique basename)

# The C11 default pair (formal/pio_equiv_fv.sv parameters): pull block /
# set pins,1 [1] / nop-class word / set pins,0 [1] / push block, with the
# only A/B difference in the never-observed X/Y register file.
GREEN_A = (0x80A0, 0xE101, 0xA042, 0xE100, 0x8020)
GREEN_B = (0x80A0, 0xE101, 0xA021, 0xE100, 0x8020)
RED_B = (0x80A0, 0xE100, 0xA021, 0xE100, 0x8020)  # word 1: set pins,0 [1]

OP_NONE, OP_WR, OP_RD = stim.OP_NONE, stim.OP_WR, stim.OP_RD

# VCD signals (suffix match on the hierarchical name; the generated
# wrapper instantiates the miter as `u_m`). reg_*_a/b are the muxed
# per-instance bus views: prologue writes and free-phase ops alike.
SIGS = {
    "rst": ".u_m.rst",
    "gpio_in": ".u_m.gpio_in",
    "nbs": ".u_m.nb_set",
    "nbc": ".u_m.nb_clr",
    "iprev": ".u_m.irq_prev_r",
    "inext": ".u_m.irq_next_r",
    "addr": ".u_m.reg_addr_a",
    "write": ".u_m.reg_write_a",
    "read": ".u_m.reg_read_a",
    "wd_a": ".u_m.reg_wdata_a",
    "wd_b": ".u_m.reg_wdata_b",
    "rd_a": ".u_m.reg_rdata_a",
    "rd_b": ".u_m.reg_rdata_b",
    "out_a": ".u_m.gpio_out_a",
    "out_b": ".u_m.gpio_out_b",
    "oe_a": ".u_m.gpio_oe_a",
    "oe_b": ".u_m.gpio_oe_b",
    "intr_a": ".u_m.intr_a",
    "intr_b": ".u_m.intr_b",
    "pc_a": ".u_m.u_a.u_sm0.u_exec.pc_r",
    "pc_b": ".u_m.u_b.u_sm0.u_exec.pc_r",
}

REG_NAMES = {
    0x000: "CTRL",
    0x004: "FSTAT",
    0x008: "FDEBUG",
    0x00C: "FLEVEL",
    0x010: "TXF0",
    0x020: "RXF0",
    0x030: "IRQ",
    0x034: "IRQ_FORCE",
    0x038: "INPUT_SYNC_BYPASS",
    0x03C: "DBG_PADOUT",
    0x040: "DBG_PADOE",
    0x044: "DBG_CFGINFO",
    0x0C8: "SM0_CLKDIV",
    0x0CC: "SM0_EXECCTRL",
    0x0D0: "SM0_SHIFTCTRL",
    0x0D4: "SM0_ADDR",
    0x0D8: "SM0_INSTR",
    0x0DC: "SM0_PINCTRL",
}


def reg_name(addr: int) -> str:
    """Human name for a reg-bus address (SPEC-7-x map).

    >>> reg_name(0x010)
    'TXF0'
    >>> reg_name(0x054)
    'INSTR_MEM[3]'
    """
    if addr in REG_NAMES:
        return REG_NAMES[addr]
    if 0x048 <= addr <= 0x0C4:
        return f"INSTR_MEM[{(addr - 0x048) // 4}]"
    if 0x128 <= addr <= 0x134:
        return f"TXGET[{(addr - 0x128) // 4}]"
    return f"0x{addr:03x}"


# ---------------------------------------------------------------------------
# Case definition: program pair, packing, default EXECCTRL.
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class ProgPair:
    """One equivalence case: two imem images + the shared SM0 config the
    C11 miter expresses (EXECCTRL only; everything else resets, SPEC-16-6)."""

    words_a: tuple[int, ...]
    words_b: tuple[int, ...]
    execctrl: int

    @property
    def prog_len(self) -> int:
        """PROG_LEN: words the prologue writes (SPEC-16-4 init protocol)."""
        return max(len(self.words_a), len(self.words_b))

    @property
    def prologue_clks(self) -> int:
        return self.prog_len + 2  # imem + EXECCTRL + CTRL writes

    def word(self, side: str, i: int) -> int:
        w = self.words_a if side == "a" else self.words_b
        return w[i] if i < len(w) else 0


def pack_words(words: Sequence[int]) -> int:
    """32 x 16-bit words -> the 512-bit miter parameter, word i at bits
    16*i (LSB = word 0) — the packing of pio_equiv_miter's PROG_A/PROG_B.

    >>> hex(pack_words([0x80A0, 0xE101, 0xA042, 0xE100, 0x8020]) & 0xFFFFFFFF)
    '0xe10180a0'
    >>> pack_words([0x1234]) >> (16 * 31)
    0
    """
    if len(words) > 32:
        raise ValueError(f"{len(words)} words: imem holds 32 (SPEC-7-10)")
    v = 0
    for i, w in enumerate(words):
        v |= w << (16 * i)
    return v


def default_execctrl(words_a: Sequence[int], words_b: Sequence[int]) -> int:
    """EXECCTRL with wrap_top = last loaded word, wrap_bottom = 0 (the
    C11 default: the whole loaded image is the loop body, SPEC-7-19/20).

    >>> hex(default_execctrl(GREEN_A, GREEN_B))
    '0x4000'
    """
    return ((max(len(words_a), len(words_b)) - 1) << 12) & 0x1F000


def parse_program(spec: str) -> list[int]:
    """Program spec -> words: '80A0,E101,...' hex list, or a .pio path
    with optional ':program' selector (assembled by the C12 assembler).

    >>> parse_program("80A0, E101")
    [32928, 57601]
    """
    if "/" not in spec and not spec.endswith(".pio"):
        words = [int(t, 16) for t in re.split(r"[,\s]+", spec.strip()) if t]
        bad = [w for w in words if not 0 <= w <= 0xFFFF]
        if bad:
            raise ValueError(f"words out of range: {[f'{w:04x}' for w in bad]}")
        return words
    path, _, name = spec.partition(":")
    progs = asm.parse_file(path)
    if not progs:
        raise ValueError(f"{path}: no .program found")
    if name:
        prog = next((p for p in progs if p.name == name), None)
        if prog is None:
            raise ValueError(f"{path}: no program {name!r} ({[p.name for p in progs]})")
    else:
        prog = progs[0]
    return prog.words


def make_pair(spec_a: str, spec_b: str, execctrl: int | None) -> ProgPair:
    wa, wb = parse_program(spec_a), parse_program(spec_b)
    if not wa or not wb:
        raise ValueError("empty program")
    ec = default_execctrl(wa, wb) if execctrl is None else execctrl
    return ProgPair(tuple(wa), tuple(wb), ec)


# ---------------------------------------------------------------------------
# Generated miter instance (SV wrapper + sby task), difftest toolchain.
# ---------------------------------------------------------------------------


def wrapper_sv(pair: ProgPair) -> str:
    """The generated C11 miter instance: PROG_A/PROG_B/PROG_LEN/
    SM0_EXECCTRL literal overrides on pio_equiv_miter (the committed
    pio_equiv_miter_red pattern, SPEC-16-4/6)."""
    words_a = [pair.word("a", i) for i in range(32)]
    words_b = [pair.word("b", i) for i in range(32)]
    pa = ",\n                                ".join(f"16'h{w:04X}" for w in reversed(words_a))
    pb = ",\n                                ".join(f"16'h{w:04X}" for w in reversed(words_b))
    return f"""// Generated by tools/hyperequiv.py (KANBAN C13) — DO NOT EDIT.
// One C11 miter instance (SPEC-16-1..7): pio_equiv_miter with the case's
// program pair, prologue length and shared SM0_EXECCTRL (SPEC-16-4/6).
module {WRAPPER_MOD} (
    input  logic        clk,
    input  logic        rst,
    input  logic [31:0] gpio_in,
    input  logic [7:0]  irq_prev_r,
    input  logic [7:0]  irq_next_r,
    input  logic [7:0]  nb_set,
    input  logic [7:0]  nb_clr,
    input  logic        wren_free,
    input  logic [8:0]  waddr_free,
    input  logic [31:0] wdata_free
);
  pio_equiv_miter #(
      .PROG_A({{{pa}}}),
      .PROG_B({{{pb}}}),
      .PROG_LEN(5'd{pair.prog_len}),
      .SM0_EXECCTRL(32'h{pair.execctrl:08X})
  ) u_m (
      .clk (clk), .rst (rst),
      .gpio_in (gpio_in),
      .irq_prev_r (irq_prev_r), .irq_next_r (irq_next_r),
      .nb_set (nb_set), .nb_clr (nb_clr),
      .wren_free (wren_free), .waddr_free (waddr_free), .wdata_free (wdata_free)
  );
endmodule
"""


def case_sby(depth: int, rel_repo: str = "../../..") -> str:
    """The generated sby task: bmc at depth = horizon (SPEC-16-3), the
    committed pio_equiv.sby engine/memory_map choices (boolector; FIFO/
    imem memories mapped — the doubled-design solver note). rel_repo is
    the path from the .sby's directory back to the repo root."""
    reads = "\n".join(f"read -formal -sv {f}" for f in RTL_FILES)
    files = "\n".join(f"{rel_repo}/rtl/{f}" for f in RTL_FILES)
    return f"""# Generated by tools/hyperequiv.py (KANBAN C13) — DO NOT EDIT.
[tasks]
bmc

[options]
bmc: mode bmc
bmc: depth {depth}

[engines]
bmc: smtbmc boolector

[script]
{reads}
read -formal -sv pio_equiv_fv.sv
read -formal -sv {WRAPPER_FILE}
prep -top {WRAPPER_MOD}
memory_map

[files]
{files}
{rel_repo}/formal/pio_equiv_fv.sv
./{WRAPPER_FILE}
"""


def toolchain() -> list[str] | None:
    """sby prefix (empty = native), or the vibe-pio container wrap; None
    when neither is available (difftest's _toolchain pattern)."""
    if shutil.which("sby"):
        return []
    if shutil.which("docker"):
        out = subprocess.run(
            ["docker", "images", "-q", "vibe-pio:latest"], capture_output=True, text=True, check=False
        ).stdout.strip()
        if out:
            return ["docker", "run", "--rm", "-v", f"{REPO}:/work", "vibe-pio:latest"]
    return None


# ---------------------------------------------------------------------------
# Divergence reports (first differing observable, cycle, pin, PCs).
# ---------------------------------------------------------------------------


@dataclasses.dataclass
class Divergence:
    """First divergence between the two sides (SPEC-16-1/2 observables)."""

    clk: int  # SPEC-16-7 clk (0 = first clk with rst de-asserted)
    kind: str  # gpio_out | gpio_oe | intr | rdata | trace-length
    pin: int | None  # first differing bit
    va: int
    vb: int
    addr: int | None = None  # read address for kind == rdata
    pc_a: int | None = None
    pc_b: int | None = None
    src: str = ""  # where it was found (pre-filter round / sby CEX)

    def lines(self, pair: ProgPair) -> list[str]:
        if self.kind == "rdata":
            where = f" at {reg_name(self.addr or 0)} (0x{(self.addr or 0):03x})"
            head = f"divergence at clk {self.clk}: rdata{where}: A=0x{self.va:08x} B=0x{self.vb:08x}"
        elif self.kind == "trace-length":
            head = f"divergence at clk {self.clk}: trace length A={self.va} B={self.vb}"
        else:
            unit = "pin" if self.kind in ("gpio_out", "gpio_oe") else "bit"
            head = f"divergence at clk {self.clk}: {self.kind} {unit} {self.pin}: A=0x{self.va:08x} B=0x{self.vb:08x}"
        out = [head + (f"  [{self.src}]" if self.src else "")]
        if self.pc_a is not None and self.pc_b is not None:
            out.append(
                f"  pc: A={self.pc_a} '{disasm_word(pair, 'a', self.pc_a)}'  "
                f"B={self.pc_b} '{disasm_word(pair, 'b', self.pc_b)}'"
            )
        return out


def disasm_word(pair: ProgPair, side: str, pc: int) -> str:
    """imem[pc] disassembled (C12) under the case's side-set config
    (sideset count 0 at PINCTRL reset, side_en from EXECCTRL bit 30)."""
    w = pair.word(side, pc & 0x1F)
    try:
        return disasm.disassemble(w, ((pair.execctrl >> 30) & 1) != 0, 0)
    except E.ReservedEncoding:
        return f".word {w:04x} (reserved, SPEC-13-1)"


def _first_diff_bit(x: int, y: int) -> int | None:
    """Lowest set bit of x^y.

    >>> _first_diff_bit(0b10100, 0b10000)
    2
    >>> _first_diff_bit(7, 7) is None
    True
    """
    d = x ^ y
    return d.bit_length() - 1 if d else None


# ---------------------------------------------------------------------------
# Model-side execution: shared prologue + free stimulus (SPEC-16-4/5).
# ---------------------------------------------------------------------------


class Stim(TypedDict):
    """One free-phase clk of shared stimulus (SPEC-16-5: traffic-only
    writes, broadcast; gpio_in and IRQ neighbour views free)."""

    op: int
    addr: int
    wdata: int
    gpio: int
    nbs: int
    nbc: int
    iprev: int
    inext: int


IDLE = Stim(op=OP_NONE, addr=0, wdata=0, gpio=0, nbs=0, nbc=0, iprev=0, inext=0)

# The two tracefmt.Rec variants (SPEC-16-7), as concrete types for casts.
GRec = tuple[str, int, int, int, int]


def _step_rec(mdl: M.PIOBlockModel, clk: int, op: int, addr: int, wdata: int, st: Stim) -> list[tracefmt.Rec]:
    """One model clk -> trace records (G per clk, R on reads; SPEC-16-7)."""
    obs = mdl.step(st["gpio"], 0, op, addr, wdata, st["nbs"], st["nbc"], st["iprev"], st["inext"])
    recs: list[tracefmt.Rec] = [("G", clk, obs["gpio_out"], obs["gpio_oe"], obs["intr"])]
    if op == OP_RD:
        rdata = obs["rdata"]
        assert rdata is not None  # a read op always samples rdata
        recs.append(("R", clk, addr, rdata))
    return recs


def run_pair_models(
    pair: ProgPair, free: Sequence[Stim]
) -> tuple[list[tracefmt.Rec], list[tracefmt.Rec], list[tuple[int, int]]]:
    """Both programs in lockstep (prologue per SPEC-16-4, shared free
    stimulus per SPEC-16-5) -> (recs_a, recs_b, per-clk entry PCs)."""
    ma, mb = M.PIOBlockModel(), M.PIOBlockModel()
    recs_a: list[tracefmt.Rec] = []
    recs_b: list[tracefmt.Rec] = []
    pcs: list[tuple[int, int]] = []
    clk = 0
    for i in range(pair.prog_len):  # word-serial imem writes (SPEC-7-10)
        pcs.append((ma.pc_r, mb.pc_r))
        recs_a += _step_rec(ma, clk, OP_WR, stim.A_IMEM0 + 4 * i, pair.word("a", i), IDLE)
        recs_b += _step_rec(mb, clk, OP_WR, stim.A_IMEM0 + 4 * i, pair.word("b", i), IDLE)
        clk += 1
    pcs.append((ma.pc_r, mb.pc_r))
    recs_a += _step_rec(ma, clk, OP_WR, stim.A_SM0 + 4 * 1, pair.execctrl, IDLE)  # SPEC-7-15
    recs_b += _step_rec(mb, clk, OP_WR, stim.A_SM0 + 4 * 1, pair.execctrl, IDLE)
    clk += 1
    pcs.append((ma.pc_r, mb.pc_r))
    recs_a += _step_rec(ma, clk, OP_WR, stim.A_CTRL, 1, IDLE)  # SM0 enable (SPEC-7-2)
    recs_b += _step_rec(mb, clk, OP_WR, stim.A_CTRL, 1, IDLE)
    clk += 1
    for st in free:  # free phase: identical bus ops on both instances
        pcs.append((ma.pc_r, mb.pc_r))
        recs_a += _step_rec(ma, clk, st["op"], st["addr"], st["wdata"], st)
        recs_b += _step_rec(mb, clk, st["op"], st["addr"], st["wdata"], st)
        clk += 1
    return recs_a, recs_b, pcs


def _culprit_pcs(pcs: Sequence[tuple[int, int]], clk: int, kind: str) -> tuple[int | None, int | None]:
    """The PCs to report for a divergence at clk (pcs[j] = pc during clk
    j, both from the model's pre-step state and from the VCD's post-edge
    samples). A G divergence at clk j landed at the edge closing clk j-1:
    the culprit is the instruction that ticked during clk j-1. An R
    divergence samples start-of-clk state, so the current pc (where
    execution stands) is the informative one. Verified against the
    recorded C11 red CEX: divergence at clk 10, culprit `set pins` at
    pc 1 on both sides.

    >>> _culprit_pcs([(0, 0), (1, 1), (2, 2)], 2, "gpio_out")
    (1, 1)
    >>> _culprit_pcs([(0, 0), (1, 1), (2, 2)], 2, "rdata")
    (2, 2)
    """
    j = clk - 1 if (kind != "rdata" and clk >= 1) else clk
    return pcs[j] if 0 <= j < len(pcs) else (None, None)


def decode_first_divergence(
    recs_a: Sequence[tracefmt.Rec], recs_b: Sequence[tracefmt.Rec], pcs: Sequence[tuple[int, int]], src: str
) -> Divergence | None:
    """First SPEC-16-7 trace divergence -> Divergence (None if equal).

    >>> decode_first_divergence([("G", 0, 1, 0, 0)], [("G", 0, 1, 0, 0)], [(0, 0)], "")
    >>> decode_first_divergence([("G", 0, 5, 0, 0)], [("G", 0, 4, 0, 0)], [(1, 2)], "x").pin
    0
    """
    a, b = tracefmt.normalize(recs_a), tracefmt.normalize(recs_b)
    for i in range(max(len(a), len(b))):
        ra = a[i] if i < len(a) else None
        rb = b[i] if i < len(b) else None
        if ra == rb:
            continue
        first = ra if ra is not None else rb
        assert first is not None
        clk = first[1]
        if ra is None or rb is None:
            pc_a, pc_b = _culprit_pcs(pcs, clk, "trace-length")
            return Divergence(clk, "trace-length", None, len(a), len(b), None, pc_a, pc_b, src)
        if len(ra) == len(rb) == 5:  # G records: SPEC-16-1 observables
            ga, gb = cast(GRec, ra), cast(GRec, rb)
            for kind, fa, fb in (("gpio_out", ga[2], gb[2]), ("gpio_oe", ga[3], gb[3]), ("intr", ga[4], gb[4])):
                if fa != fb:
                    pc_a, pc_b = _culprit_pcs(pcs, clk, kind)
                    return Divergence(clk, kind, _first_diff_bit(fa, fb), fa, fb, None, pc_a, pc_b, src)
        assert len(ra) == len(rb) == 4  # R records
        pc_a, pc_b = _culprit_pcs(pcs, clk, "rdata")
        return Divergence(clk, "rdata", None, ra[3], rb[3], ra[2], pc_a, pc_b, src)  # SPEC-16-2
    return None


# The read-address pool: state the observables actually expose (FIFO
# levels, flags, gpio pads, SM0 config banks) plus the excluded SM0_ADDR/
# SM0_INSTR words exercising the SPEC-16-2 mask/drop logic.
READ_POOL = (
    stim.A_FSTAT,
    stim.A_FDEBUG,
    stim.A_FLEVEL,
    stim.A_RXF0,
    stim.A_IRQ,
    stim.A_PADOUT,
    stim.A_PADOE,
    stim.A_SM0 + 4 * 0,
    stim.A_SM0 + 4 * 1,
    stim.A_SM0 + 4 * 2,
    stim.A_SM0 + 4 * 3,
    stim.A_SM0 + 4 * 4,
    stim.A_SM0 + 4 * 5,
    stim.A_IMEM0 + 4 * 2,
)

TRAFFIC_WRITES = (  # SPEC-16-5 free-phase writes (A3 in the miter)
    (stim.A_TXF0, 34),
    (stim.A_FDEBUG, 8),
    (stim.A_IRQ, 8),
    (stim.A_IRQ_FORCE, 8),
    (stim.A_ISB, 6),
)


def random_free_stimulus(rng: random.Random, n: int) -> list[Stim]:
    """n free-phase clks of shared random stimulus: one bus op per clk
    (traffic write, read, or idle) plus drifting gpio_in / IRQ-neighbour
    environment — the miter's free inputs are anyseq, broadcast."""
    out: list[Stim] = []
    gpio = 0
    nbs = nbc = iprev = inext = 0
    waddrs = [a for a, _ in TRAFFIC_WRITES]
    wweights = [w for _, w in TRAFFIC_WRITES]
    for _ in range(n):
        r = rng.random()
        op, addr, wdata = OP_NONE, 0, 0
        if r < 0.64:
            op = OP_WR
            addr = rng.choices(waddrs, weights=wweights)[0]
            wdata = (
                rng.getrandbits(32)
                if addr == stim.A_TXF0
                else 1 << rng.randrange(32)
                if addr == stim.A_FDEBUG
                else 1 << rng.randrange(8)
            )
        elif r < 0.79:
            op, addr = OP_RD, rng.choice(READ_POOL)
        if rng.random() < 0.10:
            gpio = rng.getrandbits(32) if rng.random() < 0.3 else gpio ^ (1 << rng.randrange(32))
        if rng.random() < 0.04:
            nbs = rng.getrandbits(8)
        if rng.random() < 0.04:
            nbc = rng.getrandbits(8)
        if rng.random() < 0.04:
            iprev = rng.getrandbits(8)
        if rng.random() < 0.04:
            inext = rng.getrandbits(8)
        out.append(Stim(op=op, addr=addr, wdata=wdata, gpio=gpio, nbs=nbs, nbc=nbc, iprev=iprev, inext=inext))
    return out


def prefilter(pair: ProgPair, horizon: int, rounds: int, seed: int) -> Divergence | None:
    """Random-stimulus lockstep through the C12 model; a divergence here
    is a definite FAIL (the model is the RTL-conformance-golden view)."""
    n = max(8, horizon - pair.prologue_clks)
    for r in range(rounds):
        free = random_free_stimulus(random.Random(seed * 1000 + r), n)
        recs_a, recs_b, pcs = run_pair_models(pair, free)
        div = decode_first_divergence(recs_a, recs_b, pcs, f"pre-filter round {r + 1}/{rounds}, seed {seed}")
        if div is not None:
            return div
    return None


# ---------------------------------------------------------------------------
# sby runner.
# ---------------------------------------------------------------------------


class SbyResult(TypedDict):
    status: str  # PASS | FAIL | TIMEOUT | ERROR
    workdir: str
    log_tail: str


def run_sby(pair: ProgPair, horizon: int, timeout: int, tag: str, case_dir: Path) -> SbyResult:
    """Generate the miter instance + sby task into case_dir and run it.
    Verdict from the workdir status file (sby's own accounting)."""
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / WRAPPER_FILE).write_text(wrapper_sv(pair))
    rel_repo = os.path.relpath(REPO, case_dir).replace(os.sep, "/")
    (case_dir / f"{tag}.sby").write_text(case_sby(horizon, rel_repo))
    tc = toolchain()
    assert tc is not None, "toolchain checked by caller"
    # `timeout -k` carries the wall clock in front of sby so the engine
    # tree dies with the wrapper in both the native and container runs.
    cmd = [
        *tc[:1],
        *tc[1:-1],
        *(_docker_wd(case_dir) if tc and tc[0] == "docker" else []),
        tc[-1] if tc else "sby",
        "timeout",
        "-k",
        "5",
        str(timeout),
        "sby",
        "-f",
        "-d",
        "work",
        f"{tag}.sby",
        "bmc",
    ]
    r = subprocess.run(cmd, cwd=case_dir, capture_output=True, text=True, check=False)
    log = r.stdout + r.stderr
    (case_dir / "sby.log").write_text(log)
    status_file = case_dir / "work" / "status"
    status = "ERROR"
    if r.returncode in (124, 137):
        status = "TIMEOUT"
    elif status_file.is_file():
        toks = status_file.read_text().split()
        first = toks[0].upper() if toks else ""
        if first in ("PASS", "FAIL", "UNKNOWN", "ERROR", "TIMEOUT"):
            status = first
    elif r.returncode == 0:
        status = "PASS"
    return SbyResult(status=status, workdir=str(case_dir / "work"), log_tail="\n".join(log.splitlines()[-6:]))


def _docker_wd(case_dir: Path) -> list[str]:
    """The case dir as seen inside the container (repo mounted at /work)."""
    return ["-w", "/work/" + case_dir.relative_to(REPO).as_posix()]


def _rm_tree(path: Path) -> None:
    """Best-effort recursive remove. Container runs leave root-owned
    workdirs behind (sby runs as root in the image), so when a plain
    rmtree comes up short, hand the path to a root rm inside the image."""
    shutil.rmtree(path, ignore_errors=True)
    if path.exists() and shutil.which("docker"):
        rel = "/work/" + path.relative_to(REPO).as_posix()
        subprocess.run(
            ["docker", "run", "--rm", "-v", f"{REPO}:/work", "vibe-pio:latest", "rm", "-rf", rel],
            capture_output=True,
            check=False,
        )
        shutil.rmtree(path, ignore_errors=True)


# ---------------------------------------------------------------------------
# VCD decoding: posedge samples, divergence, stimulus for replay.
# ---------------------------------------------------------------------------


class Sample(TypedDict):
    t: int  # VCD timestamp of the posedge section
    step: int  # posedge ordinal (0 = the initstate section)
    rst: int
    vals: dict[str, int]  # SIGS name -> value (x/z or absent -> missing)


def parse_vcd_samples(path: str | Path) -> list[Sample]:
    """Posedge-section snapshots of the wanted signals.

    smtbmc VCDs advance one BMC step per clk period: the posedge event
    (`1!`) section at t=10k holds both the new stimulus for cycle k and
    the post-edge register values, so one snapshot per event suffices
    (verified against the recorded C11 red counterexample). Values still
    x/z or absent are left out of vals."""
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
        for short, sfx in SIGS.items():
            if full.endswith(sfx):
                want[vid] = short
    samples: list[Sample] = []
    vals: dict[str, str] = {}
    t, is_edge = 0, False

    def close() -> None:
        if not is_edge:
            return
        snap: dict[str, int] = {}
        for short in SIGS:
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
            if ln.startswith("$"):
                continue
            if ln == "1!":
                is_edge = True
                continue
            if ln[0] == "b":
                bits, _, vid = ln[1:].partition(" ")
                short = want.get(vid.strip())
                if short:
                    vals[short] = bits
            else:
                short = want.get(ln[1:])
                if short:
                    vals[short] = ln[0]
        close()
    return samples


def _active_samples(samples: Sequence[Sample]) -> list[Sample]:
    """Samples from the last rst=1 posedge onward: model clk j is VCD
    posedge j+1 (the initstate posedge carries the assumed rst, CC-1);
    a mid-trace rst restarts the prologue symmetrically (miter A1)."""
    start = 1
    for i, s in enumerate(samples):
        if s["rst"]:
            start = i + 1
    return [s for s in samples if s["step"] >= start]


def samples_to_recs(samples: Sequence[Sample]) -> tuple[list[tracefmt.Rec], list[tracefmt.Rec], list[tuple[int, int]]]:
    """Active VCD samples -> (recs_a, recs_b, per-clk PCs), SPEC-16-7
    records built from the twin's own observable signals."""
    act = _active_samples(samples)
    recs_a: list[tracefmt.Rec] = []
    recs_b: list[tracefmt.Rec] = []
    pcs: list[tuple[int, int]] = []
    for clk, s in enumerate(act):
        v = s["vals"]
        # pcs[j] = pc during model clk j (the same convention as the
        # model's pre-step state): sample j+1 is the post-edge state at
        # the start of model clk j.
        pcs.append((v.get("pc_a", 0), v.get("pc_b", 0)))
        recs_a.append(("G", clk, v.get("out_a", 0), v.get("oe_a", 0), v.get("intr_a", 0)))
        recs_b.append(("G", clk, v.get("out_b", 0), v.get("oe_b", 0), v.get("intr_b", 0)))
        if v.get("read"):
            recs_a.append(("R", clk, v.get("addr", 0), v.get("rd_a", 0)))
            recs_b.append(("R", clk, v.get("addr", 0), v.get("rd_b", 0)))
    return recs_a, recs_b, pcs


def decode_vcd(samples: Sequence[Sample]) -> Divergence | None:
    """First VCD observable divergence (SPEC-16-1 per clk, SPEC-16-2 at
    read strobes, both taken from the twin's own signals)."""
    recs_a, recs_b, pcs = samples_to_recs(samples)
    return decode_first_divergence(recs_a, recs_b, pcs, "sby counterexample")


def replay_cex(samples: Sequence[Sample]) -> tuple[Divergence | None, str]:
    """Replay the CEX stimulus through both C12 models: per-clk bus ops
    taken verbatim from the muxed reg bus (prologue and free phase
    alike), environment from the shared free inputs. -> (divergence,
    note); a clean replay of a FAILing CEX is reported as a mismatch."""
    ma, mb = M.PIOBlockModel(), M.PIOBlockModel()
    recs_a: list[tracefmt.Rec] = []
    recs_b: list[tracefmt.Rec] = []
    pcs: list[tuple[int, int]] = []
    clk = 0
    for s in samples:
        if s["rst"]:
            ma.reset()
            mb.reset()
            continue
        v = s["vals"]
        op = OP_WR if v.get("write") else (OP_RD if v.get("read") else OP_NONE)
        pcs.append((ma.pc_r, mb.pc_r))
        oa = ma.step(
            v.get("gpio_in", 0),
            0,
            op,
            v.get("addr", 0),
            v.get("wd_a", 0),
            v.get("nbs", 0),
            v.get("nbc", 0),
            v.get("iprev", 0),
            v.get("inext", 0),
        )
        ob = mb.step(
            v.get("gpio_in", 0),
            0,
            op,
            v.get("addr", 0),
            v.get("wd_b", 0),
            v.get("nbs", 0),
            v.get("nbc", 0),
            v.get("iprev", 0),
            v.get("inext", 0),
        )
        recs_a.append(("G", clk, oa["gpio_out"], oa["gpio_oe"], oa["intr"]))
        recs_b.append(("G", clk, ob["gpio_out"], ob["gpio_oe"], ob["intr"]))
        if op == OP_RD:
            assert oa["rdata"] is not None
            assert ob["rdata"] is not None
            recs_a.append(("R", clk, v.get("addr", 0), oa["rdata"]))
            recs_b.append(("R", clk, v.get("addr", 0), ob["rdata"]))
        clk += 1
    div = decode_first_divergence(recs_a, recs_b, pcs, "CEX replay in golden model")
    if div is None:
        return None, "replay found no divergence (CEX outside the SPEC-16-7 trace relation)"
    return div, f"replayed in the C12 golden model: reproduces at clk {div.clk} (values match)"


# ---------------------------------------------------------------------------
# Verdicts and the oracle driver.
# ---------------------------------------------------------------------------


class Verdict(TypedDict):
    kind: str  # PASS | FAIL | TIMEOUT | ERROR
    lines: list[str]


EXIT_CODES = {"PASS": 0, "FAIL": 1, "TIMEOUT": 2, "ERROR": 3}


def check_pair(
    pair: ProgPair,
    horizon: int,
    *,
    seed: int,
    rounds: int,
    prefilter_on: bool,
    timeout: int,
    tag: str,
    keep: bool,
) -> Verdict:
    """The full oracle pipeline for one case -> Verdict."""
    if horizon < pair.prologue_clks + 4:
        return Verdict(kind="ERROR", lines=[f"horizon {horizon} < prologue {pair.prologue_clks} + 4 free clk"])
    case_dir = BUILD / "equiv" / tag
    if case_dir.exists():
        _rm_tree(case_dir)
    head = [
        (
            f"program A: {len(pair.words_a)} words; program B: {len(pair.words_b)} words; "
            f"prologue {pair.prologue_clks} clk"
        ),
        (
            f"SM0_EXECCTRL 0x{pair.execctrl:08x} (wrap {(pair.execctrl >> 12) & 0x1F}->{(pair.execctrl >> 7) & 0x1F}); "
            f"horizon {horizon} clk (sby bmc depth)"
        ),
    ]
    if prefilter_on:
        div = prefilter(pair, horizon, rounds, seed)
        if div is not None:
            return Verdict(kind="FAIL", lines=[*head, "-- pre-filter (C12 model, random stimulus)", *div.lines(pair)])
        head.append(f"-- pre-filter: {rounds} rounds, no divergence (seed {seed})")
    if toolchain() is None:
        return Verdict(kind="ERROR", lines=[*head, "no sby on PATH and no vibe-pio container image"])
    res = run_sby(pair, horizon, timeout, tag, case_dir)
    if res["status"] == "PASS":
        if not keep:
            _rm_tree(case_dir)
        return Verdict(kind="PASS", lines=[*head, "-- sby bmc: PASS", f"equivalent at horizon {horizon} (SPEC-16-3)"])
    if res["status"] == "TIMEOUT":
        return Verdict(
            kind="TIMEOUT",
            lines=[
                *head,
                f"-- sby bmc: TIMEOUT after {timeout}s (workdir kept: {res['workdir']})",
                "no verdict: raise --timeout or lower --horizon",
            ],
        )
    if res["status"] == "FAIL":
        vcds = sorted((case_dir / "work").glob("engine_*/trace*.vcd"))
        if not vcds:
            return Verdict(
                kind="ERROR",
                lines=[*head, "-- sby bmc: FAIL but no counterexample VCD found", res["log_tail"]],
            )
        samples = parse_vcd_samples(vcds[0])
        div = decode_vcd(samples)
        lines = [*head, "-- sby bmc: FAIL (counterexample)"]
        if div is not None:
            lines += div.lines(pair)
        rdiv, note = replay_cex(samples)
        lines.append(f"-- decode: {note}")
        if rdiv is not None and div is not None and (rdiv.clk, rdiv.kind, rdiv.pin) != (div.clk, div.kind, div.pin):
            lines.append(
                f"   WARNING: replay divergence clk {rdiv.clk}/{rdiv.kind}/{rdiv.pin} "
                f"!= VCD clk {div.clk}/{div.kind}/{div.pin}"
            )
        if div is None and rdiv is None:
            lines.append("   no SPEC-16-7 divergence decoded; see " + str(vcds[0]))
        lines.append(f"   counterexample trace: {vcds[0]}")
        return Verdict(kind="FAIL", lines=lines)
    return Verdict(kind="ERROR", lines=[*head, f"-- sby bmc: {res['status']}", res["log_tail"]])


# ---------------------------------------------------------------------------
# Self-test (make equiv): hermetic fixtures + end-to-end cases.
# ---------------------------------------------------------------------------


def _tiny_vcd(kind: str, pin: int) -> str:
    """Synthetic miter-shaped VCD: initstate posedge with rst, then two
    more posedges; the A/B observable pair diverges at the second one
    (model clk 1). `_none_` keeps both sides equal (the green mutation)."""
    a_out = (1 << pin) if kind == "gpio_out" else 0
    b_out = 0
    a_oe = (1 << pin) if kind == "gpio_oe" else 0
    b_oe = 0
    a_intr = (1 << pin) if kind == "intr" else 0
    b_intr = 0
    return f"""$timescale 1ns $end
$scope module top $end
$scope module u_m $end
$var wire 1 ! clk $end
$var wire 1 n1 rst $end
$var wire 32 n2 gpio_out_a $end
$var wire 32 n3 gpio_out_b $end
$var wire 32 n4 gpio_oe_a $end
$var wire 32 n5 gpio_oe_b $end
$var wire 16 n6 intr_a $end
$var wire 16 n7 intr_b $end
$var wire 1 n8 reg_read_a $end
$var wire 9 n9 reg_addr_a $end
$var wire 32 n10 reg_rdata_a $end
$var wire 32 n11 reg_rdata_b $end
$scope module u_a $end
$scope module u_sm0 $end
$scope module u_exec $end
$var wire 5 n12 pc_r $end
$upscope $end
$upscope $end
$upscope $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
1!
1n1
b0 n2
b0 n3
b0 n4
b0 n5
b0 n6
b0 n7
b0 n8
b0 n9
b0 n10
b0 n11
b0 n12
#10
0n1
#20
1!
#30
0n1
#40
1!
b{a_out:032b} n2
b{b_out:032b} n3
b{a_oe:032b} n4
b{b_oe:032b} n5
b{a_intr:016b} n6
b{b_intr:016b} n7
b00001 n12
#50
0n1
"""


def _self_test_hermetic() -> list[tuple[str, bool]]:
    checks: list[tuple[str, bool]] = []
    checks.append(("pack-matches-c11", pack_words(GREEN_A) == 0x8020_E100_A042_E101_80A0))
    w = wrapper_sv(ProgPair(GREEN_A, GREEN_B, 0x4000))
    checks.append(
        (
            "wrapper-params",
            "16'h80A0" in w and "PROG_LEN(5'd5)" in w and "SM0_EXECCTRL(32'h00004000)" in w,
        )
    )
    pair = make_pair(",".join(f"{x:04x}" for x in GREEN_A), ",".join(f"{x:04x}" for x in GREEN_B), None)
    checks.append(("parse-hex", pair.words_a == GREEN_A and pair.execctrl == 0x4000))
    with tempfile.TemporaryDirectory(prefix="hyperequiv_st_") as td:
        pio = Path(td) / "mini.pio"
        pio.write_text(".program p1\n    nop\n    set pins, 1\n.program p2\n    mov x, x\n    set pins, 1\n")
        checks.append(("parse-pio", parse_program(f"{pio}:p2") == [0xA021, 0xE001]))
    s1 = random_free_stimulus(random.Random(7), 64)
    s2 = random_free_stimulus(random.Random(7), 64)
    s3 = random_free_stimulus(random.Random(8), 64)
    checks.append(("stim-determinism", s1 == s2 and s1 != s3))
    ops = {st["op"] for st in random_free_stimulus(random.Random(3), 400)}
    checks.append(("stim-covers-ops", ops == {OP_NONE, OP_WR, OP_RD}))

    # pre-filter red/green (model-only)
    g = ProgPair(GREEN_A, GREEN_B, 0x4000)
    r = ProgPair(GREEN_A, RED_B, 0x4000)
    checks.append(("prefilter-green", prefilter(g, 24, 6, 1) is None))
    d = prefilter(r, 24, 6, 1)
    checks.append(("prefilter-red", d is not None and d.kind == "gpio_out" and d.pin == 0))

    # VCD decode red/green (synthetic fixtures; kind and first-diff pin)
    for name, kind, pin in (("vcd-out", "gpio_out", 0), ("vcd-oe", "gpio_oe", 17), ("vcd-intr", "intr", 3)):
        with tempfile.TemporaryDirectory() as td:
            f = Path(td) / "t.vcd"
            f.write_text(_tiny_vcd(kind, pin))
            dv = decode_vcd(parse_vcd_samples(f))
            checks.append((name, dv is not None and dv.kind == kind and dv.pin == pin and dv.clk == 1))
    with tempfile.TemporaryDirectory() as td:  # mutation: equal sides -> none
        f = Path(td) / "t.vcd"
        f.write_text(_tiny_vcd("none", 5))
        checks.append(("vcd-green", decode_vcd(parse_vcd_samples(f)) is None))

    # SPEC-16-2 exclusions in the decode path: EXECCTRL reads compare
    # with bit 31 masked; SM0_INSTR (and SM0_ADDR) reads are dropped.
    recs_a = [("G", 0, 0, 0, 0), ("R", 0, stim.A_SM0 + 4 * 1, 0x80000000), ("R", 1, stim.A_FLEVEL, 3)]
    recs_b = [("G", 0, 0, 0, 0), ("R", 0, stim.A_SM0 + 4 * 1, 0x00000000), ("R", 1, stim.A_FLEVEL, 3)]
    pcs = [(0, 0)] * 2
    checks.append(("excl-mask31", decode_first_divergence(recs_a, recs_b, pcs, "") is None))
    recs_a[1] = ("R", 0, stim.A_SM0 + 4 * 4, 0x1234)  # SM0_INSTR: dropped
    recs_b[1] = ("R", 0, stim.A_SM0 + 4 * 4, 0xDEAD)
    checks.append(("excl-instr", decode_first_divergence(recs_a, recs_b, pcs, "") is None))
    recs_b[2] = ("R", 1, stim.A_FLEVEL, 4)
    dv = decode_first_divergence(recs_a, recs_b, pcs, "")
    checks.append(("excl-flevel-diverges", dv is not None and dv.kind == "rdata"))
    return checks


def self_test() -> int:
    checks = _self_test_hermetic()
    if toolchain() is None:
        print("no sby on PATH and no vibe-pio container image — end-to-end cases cannot run")
        for name, _ in checks:
            print(f"  ??  {name}")
        return EXIT_CODES["ERROR"]
    g = ProgPair(GREEN_A, GREEN_B, 0x4000)
    r = ProgPair(GREEN_A, RED_B, 0x4000)
    v = check_pair(g, 16, seed=1, rounds=12, prefilter_on=True, timeout=1800, tag="st_green", keep=False)
    checks.append(("e2e-green-pass", v["kind"] == "PASS"))
    v = check_pair(r, 16, seed=1, rounds=6, prefilter_on=True, timeout=1800, tag="st_red_pf", keep=False)
    checks.append(("e2e-red-prefilter", v["kind"] == "FAIL" and any("pre-filter" in ln for ln in v["lines"])))
    v = check_pair(r, 16, seed=1, rounds=6, prefilter_on=False, timeout=1800, tag="st_red_sby", keep=False)
    dec = [ln for ln in v["lines"] if "divergence at clk" in ln and "gpio_out" in ln]
    rep = [ln for ln in v["lines"] if "replayed in the C12 golden model" in ln]
    checks.append(("e2e-red-sby-fail", v["kind"] == "FAIL"))
    checks.append(("e2e-red-sby-decode", bool(dec) and "pin 0" in dec[0]))
    checks.append(("e2e-red-sby-replay", bool(rep) and "reproduces" in rep[0]))
    v = check_pair(g, 48, seed=1, rounds=2, prefilter_on=True, timeout=12, tag="st_timeout", keep=False)
    checks.append(("e2e-timeout", v["kind"] == "TIMEOUT"))
    for tag in ("st_green", "st_red_pf", "st_red_sby", "st_timeout"):
        _rm_tree(BUILD / "equiv" / tag)  # the gate leaves nothing behind
    ok = True
    for name, res in checks:
        print(f"  {'ok  ' if res else 'FAIL'} {name}")
        ok = ok and res
    print("self-test passed" if ok else "self-test FAILED")
    return 0 if ok else 1


# ---------------------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="C13 equivalence oracle (see module docstring)")
    ap.add_argument("--a", help="program A: hex words '80A0,E101,...' or file.pio[:name]")
    ap.add_argument("--b", help="program B (same spec forms)")
    ap.add_argument("--horizon", type=int, default=48, help="BMC depth in clk (SPEC-16-3; default 48)")
    ap.add_argument(
        "--execctrl", type=lambda s: int(s, 0), default=None, help="SM0_EXECCTRL override (default: wrap N-1->0)"
    )
    ap.add_argument("--seed", type=int, default=1, help="pre-filter RNG seed")
    ap.add_argument(
        "--prefilter-rounds", type=int, default=12, help="random-stimulus rounds (0 disables the pre-filter)"
    )
    ap.add_argument("--timeout", type=int, default=3600, help="sby wall-clock seconds")
    ap.add_argument("--tag", default=None, help="case dir name under build/equiv/ (default: 'case')")
    ap.add_argument("--keep", action="store_true", help="keep case artifacts on PASS too")
    ap.add_argument("--self-test", action="store_true", help="run the committed self-test suite")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()
    if args.a is None or args.b is None:
        ap.error("--a and --b are required (or --self-test)")
    try:
        pair = make_pair(args.a, args.b, args.execctrl)
    except (ValueError, asm.AsmError, OSError) as ex:
        print(f"ERROR: {ex}")
        return EXIT_CODES["ERROR"]
    verdict = check_pair(
        pair,
        args.horizon,
        seed=args.seed,
        rounds=max(0, args.prefilter_rounds),
        prefilter_on=args.prefilter_rounds > 0,
        timeout=args.timeout,
        tag=args.tag or "case",
        keep=args.keep,
    )
    print("=== hyperequiv (C13): program-pair equivalence oracle ===")
    for ln in verdict["lines"]:
        print(ln)
    print(f"VERDICT: {verdict['kind']}")
    return EXIT_CODES[verdict["kind"]]


if __name__ == "__main__":
    sys.exit(main())

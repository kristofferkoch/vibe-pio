"""C17 web-backend units (the fast, toolchain-free slice of the
tools/webbuild.py --self-test suite; the wasm builds, three-way gate and
mutation demos are the `make web` gate)."""

import shutil
import subprocess

import pytest
import webbuild as W
from pio_model import stim


def test_lint_waivers_are_exactly_the_documented_idioms() -> None:
    # The lint gate fails on anything outside these four classes —
    # extending the list needs a DESIGN.md rationale, not a lazy edit.
    assert W.LINT_WAIVERS == ("PINMISSING", "PINCONNECTEMPTY", "UNUSEDPARAM", "UNUSEDSIGNAL")


def test_engine_link_config_exports_both_faces() -> None:
    flags = " ".join(W.EMXX_FLAGS)
    # Modularized: node_gate.js require()s it, the C18 client loads it.
    assert "-sMODULARIZE=1" in flags
    assert "-sEXPORT_NAME=PioEngine" in flags
    # Gate face + game face + the string helpers node_gate.js uses.
    for fn in (
        "_pio_stim_trace",
        "_pio_engine_reset",
        "_pio_reg_write",
        "_pio_reg_read",
        "_pio_step",
        "_pio_snapshot",
        "_malloc",
        "_free",
    ):
        assert fn in flags
    for rt in ("lengthBytesUTF8", "stringToUTF8", "UTF8ToString", "HEAPU8"):
        assert rt in flags
    # A failing compiled-in assertion must terminate the process.
    assert "-sEXIT_RUNTIME=1" in flags


def test_build_targets_the_shim_wrapper_not_bare_pio_block() -> None:
    # The invariant subset (pio_shim_top.sv) is compiled in — a build
    # over bare pio_block would silently drop the self-checks.
    src = (W.WEB / "pio_shim.cpp").read_text()
    assert '#include "Vpio_shim_top.h"' in src


def test_defect_hooks_exist() -> None:
    # The two red-injection hooks of the mutation demo (AGENTS.md TDD
    # discipline) — deleting one must break this test, not silently
    # neuter the demo.
    assert "PIO_DEFECT_SAMPLE_LATE" in (W.WEB / "pio_shim.cpp").read_text()
    assert "PIO_DEFECT_INVARIANT" in (W.WEB / "pio_shim_top.sv").read_text()
    # And they are never set in the real link config.
    assert "PIO_DEFECT" not in " ".join(W.EMXX_FLAGS)


def test_mini_sched_drives_both_demo_legs() -> None:
    s = W._mini_sched()
    # The OUT waveform moves gpio_out early (leg 1's trace diff).
    assert any(c[2] == stim.OP_WR and c[3] == stim.A_CTRL for c in s.cycles)
    # SM0_INSTR reads at spread pcs while pc0 revisits 0 (leg 2's i1
    # shadow check).
    reads = [c[3] for c in s.cycles if c[2] == stim.OP_RD]
    assert stim.A_SM0 + 4 * 4 in reads
    # The first imem word is nonzero (the stale-shadow defect is
    # observable on it).
    imem_writes = [c[4] for c in s.cycles if c[2] == stim.OP_WR and stim.A_IMEM0 <= c[3] < stim.A_IMEM0 + 4 * 32]
    assert imem_writes
    assert imem_writes[0] != 0


def test_node_gate_script_is_syntactically_valid() -> None:
    if not shutil.which("node"):
        pytest.skip("node not on PATH")
    r = subprocess.run(["node", "--check", str(W.WEB / "node_gate.js")], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stderr


def test_rel_is_repo_relative() -> None:
    assert W._rel(W.REPO / "web" / "node_gate.js") == "web/node_gate.js"


def test_rtl_glob_matches_sim_flows() -> None:
    # Every rtl/*.sv source (the Makefile sim glob and the sby [files]
    # sets compile the same set the wasm build compiles).
    names = {p.name for p in W.RTL_SRC}
    assert "pio_block.sv" in names
    assert len(names) == len(list((W.REPO / "rtl").glob("*.sv")))


def test_multi_sm_mirror_load_writes_every_window_at_the_stride() -> None:
    # C24: the per-SM load timeline — each SM's PINCTRL/EXECCTRL/
    # SHIFTCTRL land in its own window (stride 0x18), ONE settle clk
    # after the config batch, then the per-SM entry force / TXF feed /
    # CTRL enable mask (mirroring web/engine-driver.js load clk for
    # clk; the client gate is the lockstep check).
    m = W._SandboxMirror()
    m.load(
        [0xA042],
        [
            W._sm_cfg(),
            W._sm_cfg(stim.pctrl(set_cnt=1), stim.execctrl(1, 0), entry=2, feeds=(0x55,)),
            W._sm_cfg(en=False),
            W._sm_cfg(en=False),
        ],
    )
    ops = [(c[2], c[3], c[4]) for c in m.s.cycles]
    assert ops == [
        (stim.OP_WR, stim.A_IMEM0, 0xA042),
        # SM0..3 windows, p/e/s each (reset overlay except SM1's)
        (stim.OP_WR, stim.sm_addr(0, 5), stim.pctrl(set_cnt=5)),
        (stim.OP_WR, stim.sm_addr(0, 1), stim.execctrl(1, 31, status_sel=3, status_n=31)),
        (stim.OP_WR, stim.sm_addr(0, 2), stim.shiftctrl()),
        (stim.OP_WR, stim.sm_addr(1, 5), stim.pctrl(set_cnt=1)),
        (stim.OP_WR, stim.sm_addr(1, 1), stim.execctrl(1, 0)),
        (stim.OP_WR, stim.sm_addr(1, 2), stim.shiftctrl()),
        (stim.OP_WR, stim.sm_addr(2, 5), stim.pctrl(set_cnt=5)),
        (stim.OP_WR, stim.sm_addr(2, 1), stim.execctrl(1, 31, status_sel=3, status_n=31)),
        (stim.OP_WR, stim.sm_addr(2, 2), stim.shiftctrl()),
        (stim.OP_WR, stim.sm_addr(3, 5), stim.pctrl(set_cnt=5)),
        (stim.OP_WR, stim.sm_addr(3, 1), stim.execctrl(1, 31, status_sel=3, status_n=31)),
        (stim.OP_WR, stim.sm_addr(3, 2), stim.shiftctrl()),
        (0, 0, 0),  # the SPEC-6-2 settle clk
        (stim.OP_WR, stim.sm_addr(1, 4), 0x0002),  # SM1_INSTR: jmp 2
        (stim.OP_WR, stim.A_TXF0 + 4, 0x55),  # SM1 feed (TXF1)
        (stim.OP_WR, stim.A_CTRL, 0b0011),  # the enable mask
    ]


def test_client_legs_include_the_multi_sm_corpus() -> None:
    # The four C24 legs exist and produce real timelines against the
    # model oracle.
    legs = dict(W._client_legs())
    for name in ("multi_load", "multi_parallel", "multi_irq", "multi_arb"):
        assert name in legs
        assert len(legs[name]["gpio"]) > 0
        assert len(legs[name]["reads"]) > 0
    # The arbitration leg exercises CC-7 end to end: pre-edit, SM3 (the
    # highest writer) wins pin 0; the mid-run OUT_BASE edit moves SM3 to
    # pin 2, so pin 0 falls back to SM0's 0.
    reads = legs["multi_arb"]["reads"]
    assert reads[0][0] == stim.A_PADOUT
    assert reads[0][1] & 1 == 1
    assert reads[2][0] == stim.A_PADOUT
    assert reads[2][1] & 1 == 0
    assert reads[2][1] & 4 == 4
    # The IRQ leg's flags chatter through the REL handoff: both reads
    # see flags 1 and 3 set (0xa).
    assert all(a == stim.A_IRQ and v == 0xA for a, v in legs["multi_irq"]["reads"])


def test_client_defect_hooks_exist() -> None:
    # The C24 red-injection hooks (AGENTS.md TDD discipline) — deleting
    # one must break this test, not silently neuter the demo.
    src = (W.WEB / "engine-driver.js").read_text()
    assert "DEFECT_SMADDR" in src
    assert "DEFECT_OWNER" in src
    # The gate's third mutation demo runs the smaddr hook end to end.
    gate = (W.WEB / "node_client_gate.js").read_text()
    assert "smaddr" in gate

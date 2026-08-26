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

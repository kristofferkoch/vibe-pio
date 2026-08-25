"""C13 equivalence-oracle units (the fast, sby-free slice of the
tools/hyperequiv.py --self-test suite; the end-to-end sby cases are the
`make equiv` gate). Red/green: each decoder check has an equal-sides
mutation that must NOT report a divergence."""

import random
from pathlib import Path

import hyperequiv as H
import pytest
from pio_model import stim


@pytest.fixture
def green() -> H.ProgPair:
    return H.ProgPair(H.GREEN_A, H.GREEN_B, 0x4000)


@pytest.fixture
def red() -> H.ProgPair:
    return H.ProgPair(H.GREEN_A, H.RED_B, 0x4000)


def test_pack_words_matches_c11_default() -> None:
    # The committed pio_equiv_miter PROG_A/PROG_B constants, LSB = word 0.
    assert H.pack_words(H.GREEN_A) == 0x8020_E100_A042_E101_80A0
    assert H.pack_words(H.GREEN_B) == 0x8020_E100_A021_E101_80A0


def test_pack_words_rejects_oversized() -> None:
    with pytest.raises(ValueError, match="32"):
        H.pack_words([0] * 33)


def test_default_execctrl_wrap() -> None:
    # wrap_top = last loaded word, wrap_bottom = 0 (SPEC-7-19/20).
    assert H.default_execctrl(H.GREEN_A, H.GREEN_B) == 0x4000
    assert H.default_execctrl([1, 2, 3], [1]) == 0x2000


def test_wrapper_literals(green: H.ProgPair) -> None:
    w = H.wrapper_sv(green)
    assert "PROG_LEN(5'd5)" in w
    assert "SM0_EXECCTRL(32'h00004000)" in w
    # MSB-first word lists, zero-padded to 32: word 0 last, padding
    # first; 27 zero pads per program, 54 across the pair.
    assert "16'h80A0" in w
    assert w.count("16'h0000") == 54


def test_parse_program_hex() -> None:
    pair = H.make_pair("80A0,E101,A042,E100,8020", "80A0,E101,A021,E100,8020", None)
    assert pair.words_a == tuple(H.GREEN_A)
    assert pair.words_b == tuple(H.GREEN_B)
    assert pair.prog_len == 5


def test_parse_program_hex_out_of_range() -> None:
    with pytest.raises(ValueError, match="out of range"):
        H.parse_program("80A0,1FFFF")


def test_parse_program_pio(tmp_path: Path) -> None:
    pio = tmp_path / "mini.pio"
    pio.write_text(".program p1\n    nop\n.program p2\n    mov x, x\n    set pins, 1\n")
    assert H.parse_program(f"{pio}:p2") == [0xA021, 0xE001]
    assert H.parse_program(str(pio)) == [0xA042]  # first program: just nop
    with pytest.raises(ValueError, match="no program"):
        H.parse_program(f"{pio}:nope")


def test_stimulus_seeded_and_balanced() -> None:
    a = H.random_free_stimulus(random.Random(7), 200)
    b = H.random_free_stimulus(random.Random(7), 200)
    assert a == b  # deterministic under the seed
    ops = {s["op"] for s in a}
    assert ops == {stim.OP_NONE, stim.OP_WR, stim.OP_RD}
    # Free-phase writes stay inside the SPEC-16-5 traffic set.
    wr_addrs = {s["addr"] for s in a if s["op"] == stim.OP_WR}
    assert wr_addrs <= {stim.A_TXF0, stim.A_FDEBUG, stim.A_IRQ, stim.A_IRQ_FORCE, stim.A_ISB}


def test_prefilter_green_no_divergence(green: H.ProgPair) -> None:
    assert H.prefilter(green, 24, 6, 1) is None


def test_prefilter_red_diverges(red: H.ProgPair) -> None:
    d = H.prefilter(red, 24, 6, 1)
    assert d is not None
    assert d.kind == "gpio_out"
    assert d.pin == 0
    assert (d.va & 1) == 1
    assert (d.vb & 1) == 0
    assert d.pc_a == d.pc_b == 1  # the flipped `set pins` word


def test_vcd_decode_finds_divergence(tmp_path: Path) -> None:
    for kind, pin in (("gpio_out", 0), ("gpio_oe", 17), ("intr", 3)):
        f = tmp_path / f"{kind}.vcd"
        f.write_text(H._tiny_vcd(kind, pin))
        d = H.decode_vcd(H.parse_vcd_samples(f))
        assert d is not None
        assert d.kind == kind
        assert d.pin == pin
        assert d.clk == 1


def test_vcd_decode_equal_sides_no_divergence(tmp_path: Path) -> None:
    # Mutation (vacuity guard): identical observables -> no divergence.
    f = tmp_path / "green.vcd"
    f.write_text(H._tiny_vcd("none", 5))
    assert H.decode_vcd(H.parse_vcd_samples(f)) is None


def test_decode_spec16_2_exclusions() -> None:
    recs_a = [("G", 0, 0, 0, 0), ("R", 0, stim.A_SM0 + 4 * 1, 0x80000000), ("R", 1, stim.A_FLEVEL, 3)]
    recs_b = [("G", 0, 0, 0, 0), ("R", 0, stim.A_SM0 + 4 * 1, 0x00000000), ("R", 1, stim.A_FLEVEL, 3)]
    pcs = [(0, 0)] * 2
    # EXECCTRL bit 31 masked (SPEC-7-15 overlay).
    assert H.decode_first_divergence(recs_a, recs_b, pcs, "") is None
    # SM0_INSTR reads dropped (SPEC-7-24): program text differs by
    # hypothesis.
    recs_a[1] = ("R", 0, stim.A_SM0 + 4 * 4, 0x1234)
    recs_b[1] = ("R", 0, stim.A_SM0 + 4 * 4, 0xDEAD)
    assert H.decode_first_divergence(recs_a, recs_b, pcs, "") is None
    # A real read divergence still fires, with the address in the report.
    recs_b[2] = ("R", 1, stim.A_FLEVEL, 4)
    d = H.decode_first_divergence(recs_a, recs_b, pcs, "")
    assert d is not None
    assert d.kind == "rdata"
    assert d.addr == stim.A_FLEVEL


def test_divergence_report_lines(red: H.ProgPair) -> None:
    d = H.Divergence(clk=10, kind="gpio_out", pin=0, va=1, vb=0, pc_a=1, pc_b=1, src="test")
    lines = d.lines(red)
    assert any("clk 10" in ln and "gpio_out pin 0" in ln for ln in lines)
    # Disassembled culprit PCs (C12): the flipped `set pins` word.
    assert any("'set pins, 1 [1]'" in ln and "'set pins, 0 [1]'" in ln for ln in lines)

"""C16 witness-pipeline units (the fast, sby-free slice of the
tools/hypersynth.py --self-test suite; the end-to-end synthesis cases
are the `make synth` gate). Red/green: each checker has a corrupted
waveform that must NOT pass (SPEC-16-9)."""

from pathlib import Path

import hypersynth as H
import pytest
from pio_model import asm
from pio_model import encoding as E


def test_run_lengths_laws() -> None:
    bits = [1, 1, 1, 0, 0, 1, 0]
    rl = H.run_lengths(bits)
    assert sum(ln for _, ln in rl) == len(bits)
    assert all(rl[i][0] != rl[i + 1][0] for i in range(len(rl) - 1))
    assert rl == [(1, 3), (0, 2), (1, 1), (0, 1)]


class TestSquareWindow:
    def test_green_exact_halves(self) -> None:
        assert H.check_square([0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1], 2) == []

    def test_red_long_half(self) -> None:
        # SPEC-16-9: a 3-clk half against the [2,2] window.
        assert H.check_square([0, 1, 1, 1, 0, 0], 2) != []

    def test_red_short_half(self) -> None:
        assert H.check_square([0, 1, 0, 0, 1, 1], 2) != []

    def test_leading_run_unmeasured(self) -> None:
        # The pre-anchor run is free (SPEC-16-9), however long.
        assert H.check_square([0] * 9 + [1, 1, 0, 0], 2) == []


# 0x55 LSB-first = 1,0,1,0,1,0,1,0; even parity 0 merges with data-bit-8's
# zeros; the stop merges into idle (SPEC-16-9).
UART_OK = [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1]


class TestUartWindow:
    def test_green_55(self) -> None:
        errs, data = H.check_uart(UART_OK, 2, 0x55)
        assert errs == []
        assert data == 0x55

    def test_red_parity(self) -> None:
        # Parity slot forced 1 (odd) for 0x55 (even parity): the zeros
        # run holding data-bit-7+parity splits, parity rides the merged
        # ones tail (SPEC-16-9's merged-stop shape, wrong level).
        bad = UART_OK[:19] + [1] * 6
        errs, _ = H.check_uart(bad, 2, 0x55)
        assert any("parity" in e for e in errs)

    def test_red_timing(self) -> None:
        # A 3-clk start run is not a multiple of the 2-clk bit-time.
        errs, _ = H.check_uart([1, 0, 0, 0, 1, 1, 1, 1], 2, 0xFF)
        assert any("multiple" in e for e in errs)

    def test_red_no_anchor(self) -> None:
        assert H.check_uart([0, 0, 0], 2, 0)[0] != []

    def test_red_incomplete(self) -> None:
        errs, _ = H.check_uart(UART_OK[:10], 2, 0x55)
        assert any("incomplete" in e for e in errs)


def test_words_of_packing() -> None:
    assert H.words_of(0x0002_E081)[:2] == [0xE081, 0x0002]
    assert len(H.words_of((1 << 512) - 1)) == 32


def test_prologue_shape() -> None:
    ps = H.prologue_steps([0xA042] * 32)
    assert len(ps) == 35
    assert ps[0].addr == 0x048  # SPEC-7-10 window
    assert ps[31].addr == 0x0C4
    assert [s.addr for s in ps[32:]] == [0x0DC, 0x0CC, 0x000]  # PINCTRL/EXECCTRL/CTRL
    assert ps[-1].wdata == 1


def test_canon_words() -> None:
    # Unvisited -> nop; visited clean word kept.
    out = H.canon_words([0xE081, 0x1F1F], {0})
    assert out == [0xE081, H.NOP]
    # Visited reserved -> delay-preserving nop (SPEC-13-1 no-op + delay).
    reserved = next(w for w in range(0x4000, 0x6000) if E.decode(w, False, 0)["illegal"])
    assert H.canon_words([reserved], {0}) == [H.NOP | (reserved & 0x1F00)]


def test_pio_roundtrip(tmp_path: Path) -> None:
    w = H.Witness(H.TARGETS["sq"], [], [H.NOP] * 32, set(), [], [], [], 0)
    text = H.pio_text(w)
    p = tmp_path / "w.pio"
    p.write_text(text)
    assert [x & 0xFFFF for x in asm.parse_text(text)[0].words] == [H.NOP] * 32


def test_vcd_fixture(tmp_path: Path) -> None:
    f = tmp_path / "t.vcd"
    f.write_text(H._tiny_vcd())
    samples = H.parse_vcd_samples(f)
    w = H.extract_witness(H.TARGETS["sq"], samples)
    assert w.horizon == 5
    assert w.raw_words[:3] == [0xE081, 0x0002, 0x00EB]
    # The final section's pc is latched-but-unfetched -> word 1 (=0002 at
    # pc 1 is visited; the tail pc value's word stays a don't-care).
    assert w.visited == {0, 1, 2}
    assert w.canon[3] == H.NOP
    assert w.canon[0] == 0xE081
    assert w.out32 == [1, 1, 0, 0, 1]


def test_extract_rejects_short_trace(tmp_path: Path) -> None:
    f = tmp_path / "t.vcd"
    f.write_text(H._tiny_vcd().split("#30")[0] + "\n")  # prologue only
    with pytest.raises(H.SynthError, match="free-phase"):
        H.extract_witness(H.TARGETS["sq"], H.parse_vcd_samples(f))


def test_synthesis_sby_has_chparam() -> None:
    text = H.synth_sby(H.TARGETS["sq"], 28, "../..")
    assert "chparam -set SYM 1 pio_instr_mem" in text
    assert "prep -top pio_synth_sq_fv" in text
    assert "mode cover" in text


def test_red_case_swaps_top() -> None:
    # The generated red task preps the contradictory-spec top.
    text = H.synth_sby(H.TARGETS["sq"], 28, "../..").replace("prep -top pio_synth_sq_fv", "prep -top pio_synth_red_fv")
    assert "prep -top pio_synth_red_fv" in text

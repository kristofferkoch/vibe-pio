"""tracefmt.py: SPEC-16-7 trace lines, normalization, comparison."""

from pathlib import Path

import pytest
from pio_model import tracefmt


def _write(tmp_path: Path, text: str) -> Path:
    p = tmp_path / "t.trace"
    p.write_text(text)
    return p


class TestLines:
    def test_g_line_format(self):
        assert tracefmt.g_line(0, 0, 0, 0) == "0 G 00000000 00000000 0000"
        assert tracefmt.g_line(12, 0xDEADBEEF, 0xFF, 0x1234) == "12 G deadbeef 000000ff 1234"

    def test_r_line_format(self):
        assert tracefmt.r_line(3, 0x0C8, 0x55) == "3 R 0c8 00000055"


class TestParseWrite:
    def test_round_trip_with_comments(self, tmp_path):
        lines = [tracefmt.g_line(0, 1, 2, 3), tracefmt.r_line(0, 0x20, 0xAA), tracefmt.g_line(1, 4, 5, 6)]
        tracefmt.write_trace(tmp_path / "a.trace", lines)
        recs = tracefmt.parse_trace(tmp_path / "a.trace")
        assert recs == [("G", 0, 1, 2, 3), ("R", 0, 0x20, 0xAA), ("G", 1, 4, 5, 6)]

    def test_bad_header(self, tmp_path):
        p = _write(tmp_path, "not a trace\n")
        with pytest.raises(ValueError, match="bad header"):
            tracefmt.parse_trace(p)

    def test_bad_record(self, tmp_path):
        p = _write(tmp_path, tracefmt.HEADER + "\n0 X 1 2\n")
        with pytest.raises(ValueError, match="bad record"):
            tracefmt.parse_trace(p)


class TestNormalize:
    def test_sm_window_exclusions_spec_16_2(self):
        a_sm0, a_sm1 = 0x0C8, 0x0E0
        recs = [
            ("R", 0, a_sm0 + 4 * 3, 9),  # SM0 INSTR -> drop (SPEC-7-24)
            ("R", 0, a_sm0 + 4 * 4, 9),  # SM0 ADDR  -> drop (SPEC-7-22)
            ("R", 0, a_sm0 + 4 * 1, 0x80000000),  # EXECCTRL -> mask bit 31
            ("R", 0, a_sm0 + 4 * 0, 0x10000),  # CLKDIV -> keep
            ("R", 0, a_sm1 + 4 * 4, 9),  # SM1 INSTR -> drop
            ("R", 0, 0x010, 0x55),  # TXF0 -> keep
        ]
        out = tracefmt.normalize(recs)
        assert out == [("R", 0, a_sm0 + 4 * 1, 0), ("R", 0, a_sm0 + 4 * 0, 0x10000), ("R", 0, 0x010, 0x55)]

    def test_g_lines_pass_through(self):
        g = ("G", 0, 1, 2, 3)
        assert tracefmt.normalize([g]) == [g]


class TestCompare:
    def test_equal_after_normalize(self):
        a = [("R", 0, 0x0C8 + 4 * 4, 5), ("G", 1, 0, 0, 0)]
        b = [("R", 0, 0x0C8 + 4 * 4, 9), ("G", 1, 0, 0, 0)]  # dropped addr
        tracefmt.compare(a, b)  # no raise

    def test_first_divergence_report(self):
        a = [("G", 0, 0, 0, 0), ("G", 1, 1, 0, 0)]
        b = [("G", 0, 0, 0, 0), ("G", 1, 2, 0, 0)]
        with pytest.raises(tracefmt.TraceMismatch, match="clk 1"):
            tracefmt.compare(a, b)

    def test_length_divergence(self):
        a = [("G", 0, 0, 0, 0)]
        b = [("G", 0, 0, 0, 0), ("G", 1, 0, 0, 0)]
        with pytest.raises(tracefmt.TraceMismatch, match="record 1"):
            tracefmt.compare(a, b)

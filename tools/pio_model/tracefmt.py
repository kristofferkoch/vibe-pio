"""SPEC-16-7 trace exchange format v1: emission and comparison.

Line-oriented ASCII; `#` comments; header `pio-trace v1`. Per clk: one
`<clk> G <gpio_out:8hex> <gpio_oe:8hex> <intr:4hex>` line (exactly one
per clk, no gaps, clk decimal, 0 = first clk with rst de-asserted), and
for each completing reg read a `<clk> R <addr:3hex> <rdata:8hex>` line
after that clk's G line. Lowercase fixed-width hex throughout.

Equivalence-aware comparison (SPEC-16-2 exclusions): R lines at the
SMx_INSTR (imem[pc], SPEC-7-24) and SMx_ADDR (pc, SPEC-7-22) addresses
are dropped; SMx_EXECCTRL reads compare with bit 31 masked (the
EXEC_STALLED RO overlay, SPEC-7-15). Under an EXECCTRL config overlay
(SPEC-16-8, C14) the pair's intentionally-differing bits are masked too,
via normalize's ec_mask argument.
"""

from collections.abc import Sequence
from pathlib import Path

# One normalized trace record: G = ("G", clk, gpio_out, gpio_oe, intr),
# R = ("R", clk, addr, rdata).
Rec = tuple[str, int, int, int, int] | tuple[str, int, int, int]

HEADER = "pio-trace v1"


def g_line(clk: int, gpio_out: int, gpio_oe: int, intr: int) -> str:
    """The per-clk observable line (SPEC-16-1).

    >>> g_line(0, 0, 0, 0)
    '0 G 00000000 00000000 0000'
    """
    return f"{clk} G {gpio_out:08x} {gpio_oe:08x} {intr:04x}"


def r_line(clk: int, addr: int, rdata: int) -> str:
    """A completed reg-read line (SPEC-16-2).

    >>> r_line(3, 0x0C8, 0x55)
    '3 R 0c8 00000055'
    """
    return f"{clk} R {addr:03x} {rdata:08x}"


def write_trace(path: str | Path, lines: list[str]) -> None:
    with open(path, "w") as f:
        f.write(HEADER + "\n")
        f.write("\n".join(lines) + "\n")


def parse_trace(path: str | Path) -> list[Rec]:
    """-> list of raw record tuples ('G', clk, ...) in file order."""
    recs: list[Rec] = []
    with open(path) as f:
        head = f.readline().strip()
        if head != HEADER:
            raise ValueError(f"{path}: bad header {head!r}")
        for raw in f:
            ln = raw.strip()
            if not ln or ln.startswith("#"):
                continue
            toks = ln.split()
            kind = toks[1]
            if kind == "G":
                recs.append(("G", int(toks[0]), int(toks[2], 16), int(toks[3], 16), int(toks[4], 16)))
            elif kind == "R":
                recs.append(("R", int(toks[0]), int(toks[2], 16), int(toks[3], 16)))
            else:
                raise ValueError(f"{path}: bad record {ln!r}")
    return recs


def _classify(addr: int) -> str:
    """SPEC-16-2 exclusion classification for a read address."""
    widx = (addr >> 2) & 0x7F
    if 50 <= widx <= 73:  # SMx window (SPEC-7-14..26)
        sm_reg = (widx - 50) % 6
        if sm_reg == 3:
            return "drop"  # SMx_ADDR (SPEC-7-22)
        if sm_reg == 4:
            return "drop"  # SMx_INSTR (SPEC-7-24)
        if sm_reg == 1:
            return "mask31"  # EXECCTRL (SPEC-7-15)
    return "keep"


def normalize(recs: Sequence[Rec], ec_mask: int = 0x7FFFFFFF) -> list[Rec]:
    """Apply the SPEC-16-2 exclusions -> comparable record list.

    ec_mask ANDs SMx_EXECCTRL read payloads (bit 31 masked by the
    default, SPEC-7-15); a pair running an EXECCTRL overlay passes the
    complement of its intentional difference instead (SPEC-16-8).

    >>> normalize([("R", 0, 0x0CC, 0x80001234)])
    [('R', 0, 204, 4660)]
    >>> normalize([("R", 0, 0x0CC, 0xFFFF1234)], ec_mask=0x7FF0FFFF)  # wrap bits overlaid
    [('R', 0, 204, 2146439732)]
    """
    out: list[Rec] = []
    for r in recs:
        if r[0] == "G":
            out.append(r)
        else:
            kind = _classify(r[2])
            if kind == "drop":
                continue
            if kind == "mask31":
                out.append(("R", r[1], r[2], r[3] & ec_mask))
            else:
                out.append(r)
    return out


class TraceMismatch(Exception):
    """First-divergence report for the differ (consumed by difftest and
    later by the C13 oracle's divergence reports)."""

    def __init__(self, message: str, model_rec: Rec | None = None, rtl_rec: Rec | None = None) -> None:
        super().__init__(message)
        self.model_rec = model_rec
        self.rtl_rec = rtl_rec


def compare(model_recs: Sequence[Rec], rtl_recs: Sequence[Rec]) -> None:
    """Raise TraceMismatch on the first divergence (SPEC-16-7:
    line-identical after the SPEC-16-2 exclusions)."""
    a = normalize(model_recs)
    b = normalize(rtl_recs)
    for i in range(max(len(a), len(b))):
        ra = a[i] if i < len(a) else None
        rb = b[i] if i < len(b) else None
        if ra != rb:
            first = ra if ra is not None else rb
            clk = first[1] if first is not None else 0
            raise TraceMismatch(f"first divergence at record {i} (clk {clk}): model {ra} vs rtl {rb}", ra, rb)

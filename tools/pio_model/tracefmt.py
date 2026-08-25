"""SPEC-16-7 trace exchange format v1: emission and comparison.

Line-oriented ASCII; `#` comments; header `pio-trace v1`. Per clk: one
`<clk> G <gpio_out:8hex> <gpio_oe:8hex> <intr:4hex>` line (exactly one
per clk, no gaps, clk decimal, 0 = first clk with rst de-asserted), and
for each completing reg read a `<clk> R <addr:3hex> <rdata:8hex>` line
after that clk's G line. Lowercase fixed-width hex throughout.

Equivalence-aware comparison (SPEC-16-2 exclusions): R lines at the
SMx_INSTR (imem[pc], SPEC-7-24) and SMx_ADDR (pc, SPEC-7-22) addresses
are dropped; SMx_EXECCTRL reads compare with bit 31 masked (the
EXEC_STALLED RO overlay, SPEC-7-15).
"""

HEADER = "pio-trace v1"


def g_line(clk, gpio_out, gpio_oe, intr):
    return (f"{clk} G {gpio_out:08x} {gpio_oe:08x} {intr:04x}")


def r_line(clk, addr, rdata):
    return f"{clk} R {addr:03x} {rdata:08x}"


def write_trace(path, lines):
    with open(path, "w") as f:
        f.write(HEADER + "\n")
        f.write("\n".join(lines) + "\n")


def parse_trace(path):
    """-> list of raw record tuples ('G', clk, ...) in file order."""
    recs = []
    with open(path) as f:
        head = f.readline().strip()
        if head != HEADER:
            raise ValueError(f"{path}: bad header {head!r}")
        for ln in f:
            ln = ln.strip()
            if not ln or ln.startswith("#"):
                continue
            toks = ln.split()
            kind = toks[1]
            if kind == "G":
                recs.append(("G", int(toks[0]), int(toks[2], 16),
                             int(toks[3], 16), int(toks[4], 16)))
            elif kind == "R":
                recs.append(("R", int(toks[0]), int(toks[2], 16),
                             int(toks[3], 16)))
            else:
                raise ValueError(f"{path}: bad record {ln!r}")
    return recs


def _classify(addr):
    """SPEC-16-2 exclusion classification for a read address."""
    widx = (addr >> 2) & 0x7F
    if 50 <= widx <= 73:                      # SMx window (SPEC-7-14..26)
        sm_reg = (widx - 50) % 6
        if sm_reg == 3:
            return "drop"                     # SMx_ADDR (SPEC-7-22)
        if sm_reg == 4:
            return "drop"                     # SMx_INSTR (SPEC-7-24)
        if sm_reg == 1:
            return "mask31"                   # EXECCTRL (SPEC-7-15)
    return "keep"


def normalize(recs):
    """Apply the SPEC-16-2 exclusions -> comparable record list."""
    out = []
    for r in recs:
        if r[0] == "G":
            out.append(r)
        else:
            kind = _classify(r[2])
            if kind == "drop":
                continue
            if kind == "mask31":
                out.append(("R", r[1], r[2], r[3] & 0x7FFFFFFF))
            else:
                out.append(r)
    return out


class TraceMismatch(Exception):
    """First-divergence report for the differ (consumed by difftest and
    later by the C13 oracle's divergence reports)."""

    def __init__(self, message, model_rec=None, rtl_rec=None):
        super().__init__(message)
        self.model_rec = model_rec
        self.rtl_rec = rtl_rec


def compare(model_recs, rtl_recs):
    """Raise TraceMismatch on the first divergence (SPEC-16-7:
    line-identical after the SPEC-16-2 exclusions)."""
    a = normalize(model_recs)
    b = normalize(rtl_recs)
    for i in range(max(len(a), len(b))):
        ra = a[i] if i < len(a) else None
        rb = b[i] if i < len(b) else None
        if ra != rb:
            clk = (ra or rb or (None,))[1]
            raise TraceMismatch(
                f"first divergence at record {i} (clk {clk}): "
                f"model {ra} vs rtl {rb}", ra, rb)

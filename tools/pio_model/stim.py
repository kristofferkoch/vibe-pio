"""Stimulus schedules for the model-vs-RTL trace differential.

A Schedule is the shared per-clk timeline both sides consume:
  - the Python model directly (PIOBlockModel.step per cycle),
  - the RTL through sim/tb_trace_dump.sv via a $readmemh memory image
    (pio-stim v1: word 0 = N; then 6 words per cycle k —
    gpio_in, lb_mask, op<<9|addr, wdata, nb_set<<8|nb_clr,
    irq_prev<<8|irq_next; op 0 idle / 1 write / 2 read).

gpio_in is the *post-loopback* pad value: lb_mask pins read back the
DUT's own gpio_oe/gpio_out of the same clk (the tb_conf_pioexamples
lb_mask idiom); the model folds the same function.

The 19 conformance cases mirror sim/tb_conf_pioexamples.sv: each CF
check's register config (the MFY_* calls), pre-enable TXF feeds and
set_pc entry points; the two-SM loopback checks (CF12/15/16/17) run
their single-SM trace variants — the tx program with its own output
looped back, the rx program with a scripted frame on gpio_in. The
multi-SM cases after them (SM-indexed config windows, TXF1..3 feeds,
inter-SM IRQ handoff and cross-SM pin arbitration) have no CF
precedent — they are the multi-SM corpus the model's scope grew.
"""

from collections.abc import Callable, Sequence
from pathlib import Path

from . import asm
from . import encoding as E

# Register addresses (SPEC-7-x; byte map, word-aligned).
A_CTRL, A_FSTAT, A_FDEBUG, A_FLEVEL = 0x000, 0x004, 0x008, 0x00C
A_TXF0, A_RXF0, A_IRQ, A_IRQ_FORCE = 0x010, 0x020, 0x030, 0x034
A_ISB, A_PADOUT, A_PADOE, A_CFGINFO = 0x038, 0x03C, 0x040, 0x044
A_IMEM0 = 0x048  # + 4*i (SPEC-7-10)
A_SM0 = 0x0C8  # + 4*r: CLKDIV..PINCTRL
A_PUTGET0 = 0x128  # + 0x10*sm + 4*y (SPEC-7-13)


def sm_addr(sm: int, reg: int) -> int:
    """Byte address of SM window register `reg` (0 CLKDIV .. 5 PINCTRL,
    4 INSTR = the forced-instruction write, SPEC-7-23) for SM `sm` —
    stride 0x18 per SM (SPEC-7-x per-SM map).

    >>> hex(sm_addr(0, 0))
    '0xc8'
    >>> hex(sm_addr(3, 4))
    '0x120'
    """
    return A_SM0 + 0x18 * (sm & 3) + 4 * (reg & 7)


OP_NONE, OP_WR, OP_RD = 0, 1, 2

READ_POOL = (
    A_FSTAT,
    A_FDEBUG,
    A_FLEVEL,
    A_RXF0,
    A_RXF0 + 4,  # RXF1
    A_RXF0 + 8,  # RXF2
    A_IRQ,
    A_ISB,
    A_PADOUT,
    A_PADOE,
    A_CFGINFO,
    A_SM0 + 0,
    A_SM0 + 1,
    A_SM0 + 2,
    A_SM0 + 3,
    A_SM0 + 4,
    A_SM0 + 5,
    sm_addr(1, 0),
    sm_addr(1, 1),
    sm_addr(1, 5),
    sm_addr(2, 0),
    sm_addr(2, 2),
    sm_addr(3, 1),
    sm_addr(3, 5),
    A_PUTGET0,
    A_PUTGET0 + 4,
    A_PUTGET0 + 0x10,
)


class Schedule:
    """Per-clk timeline: (gpio_in, lb_mask, op, addr, wdata,
    nb_set, nb_clr, irq_prev, irq_next).

    >>> s = Schedule()
    >>> s.w(0x010, 0xAA); s.r(0x004); s.idle()
    >>> s.cycles[0] == [0, 0, OP_WR, 0x010, 0xAA, 0, 0, 0, 0]
    True
    >>> s.cycles[1][2] == OP_RD
    True
    """

    def __init__(self) -> None:
        self.cycles: list[list[int]] = []
        self.gpio: int = 0
        self.lb: int = 0
        self.nb_set: int = 0
        self.nb_clr: int = 0
        self.irq_prev: int = 0
        self.irq_next: int = 0

    # -- timeline builders (each op consumes one clk) -----------------
    def _append(self, op: int = OP_NONE, addr: int = 0, wdata: int = 0) -> None:
        self.cycles.append(
            [self.gpio, self.lb, op, addr, wdata, self.nb_set, self.nb_clr, self.irq_prev, self.irq_next]
        )

    def w(self, addr: int, data: int) -> None:
        """One clk writing `data` to the reg-bus address."""
        self._append(OP_WR, addr, data)

    def r(self, addr: int) -> None:
        """One clk reading the reg-bus address (emits an R trace line)."""
        self._append(OP_RD, addr, 0)

    def idle(self, n: int = 1) -> None:
        for _ in range(n):
            self._append()

    def run_to(self, k: int) -> None:
        """Idle until the timeline holds k cycles."""
        while len(self.cycles) < k:
            self._append()

    def set_gpio(self, value: int) -> None:
        self.gpio = value & 0xFFFFFFFF

    def set_lb(self, mask: int) -> None:
        self.lb = mask & 0xFFFFFFFF

    # -- higher-level helpers -----------------------------------------
    def load_imem(self, words: list[int], base: int = 0) -> None:
        for i, word in enumerate(words):
            self.w(A_IMEM0 + 4 * (base + i), word)  # SPEC-7-10

    def enable(self, mask: int = 1) -> None:
        self.w(A_CTRL, mask)  # SPEC-7-2

    def set_pc(self, pc: int, sm: int = 0) -> None:
        """The pio_sm_init idiom: forced JMP via SMx_INSTR (SPEC-7-23,
        sdk N2). Prologue-phase use only (SPEC-16-5)."""
        self.w(sm_addr(sm, 4), 0x0000 | ((pc & 0x1F) << 0))  # jmp pc

    def feed(self, word: int, sm: int = 0) -> None:
        self.w(A_TXF0 + 4 * (sm & 3), word)  # TXFx (SPEC-7-28)

    # -- pio-stim v1 memory image --------------------------------------
    def to_mem(self) -> str:
        out = [f"{len(self.cycles):08x}"]
        for c in self.cycles:
            gpio, lb, op, addr, wdata, nbs, nbc, prv, nxt = c
            out.append(f"{gpio:08x}")
            out.append(f"{lb:08x}")
            out.append(f"{((op << 9) | (addr & 0x1FF)):08x}")
            out.append(f"{wdata:08x}")
            out.append(f"{((nbs << 8) | nbc):08x}")
            out.append(f"{((prv << 8) | nxt):08x}")
        return "\n".join(out) + "\n"

    def write_mem(self, path: str | Path) -> None:
        with open(path, "w") as f:
            f.write(self.to_mem())


# ---------------------------------------------------------------------------
# SM config word builders (SPEC-7-14..26) — same packing as the
# tb_conf_pioexamples.sv MFY_* functions.
# ---------------------------------------------------------------------------


def pctrl(
    ss_cnt: int = 0,
    set_cnt: int = 0,
    out_cnt: int = 0,
    in_base: int = 0,
    ss_base: int = 0,
    set_base: int = 0,
    out_base: int = 0,
) -> int:
    """PINCTRL word (SPEC-7-26 bit layout).

    >>> hex(pctrl(ss_cnt=5, set_cnt=3, out_cnt=2, in_base=17, ss_base=9, set_base=6, out_base=1))
    '0xac28a4c1'
    """
    return (
        (ss_cnt << 29)
        | (set_cnt << 26)
        | (out_cnt << 20)
        | (in_base << 15)
        | (ss_base << 10)
        | (set_base << 5)
        | out_base
    )


def execctrl(
    wrap_top: int,
    wrap_bot: int,
    jmp_pin: int = 0,
    side_en: bool = False,
    side_pindirs: bool = False,
    status_sel: int = 0,
    status_n: int = 0,
    out_sticky: bool = False,
) -> int:
    """EXECCTRL word (SPEC-7-15..20 bit layout).

    >>> hex(execctrl(31, 7))
    '0x1f380'
    """
    return (
        (wrap_top << 12)
        | (wrap_bot << 7)
        | (jmp_pin << 24)
        | ((1 << 30) if side_en else 0)
        | ((1 << 29) if side_pindirs else 0)
        | (status_sel << 5)
        | status_n
        | ((1 << 17) if out_sticky else 0)
    )


def shiftctrl(
    fjoin_rx: bool = False,
    fjoin_tx: bool = False,
    pull_thr: int = 32,
    push_thr: int = 32,
    out_right: bool = True,
    in_right: bool = True,
    autopull: bool = False,
    autopush: bool = False,
    fjoin_rx_put: bool = False,
    fjoin_rx_get: bool = False,
    in_count: int = 0,
) -> int:
    # thresholds are 5-bit fields, 32 encodes as 0 (SPEC-5-7)
    return (
        ((1 << 31) if fjoin_rx else 0)
        | ((1 << 30) if fjoin_tx else 0)
        | ((pull_thr & 31) << 25)
        | ((push_thr & 31) << 20)
        | ((1 << 19) if out_right else 0)
        | ((1 << 18) if in_right else 0)
        | ((1 << 17) if autopull else 0)
        | ((1 << 16) if autopush else 0)
        | ((1 << 15) if fjoin_rx_put else 0)
        | ((1 << 14) if fjoin_rx_get else 0)
        | (in_count & 31)
    )


def clkdiv(intg: int = 1, frac: int = 0) -> int:
    """CLKDIV word: INT<<16 | FRAC<<8 (SPEC-7-14; the reset value INT=1).

    >>> hex(clkdiv())
    '0x10000'
    >>> hex(clkdiv(135, 162))
    '0x87a200'
    """
    return ((intg & 0xFFFF) << 16) | ((frac & 0xFF) << 8)


# ---------------------------------------------------------------------------
# Conformance program schedules.
# ---------------------------------------------------------------------------


def _prog(repo: str | Path, rel: str, name: str) -> asm.Program:
    progs = asm.parse_file(Path(repo) / "third_party/pico-examples" / rel)
    return next(p for p in progs if p.name == name)


def _uart_frame(byte: int) -> list[int]:
    """8n1 line levels, LSB first, one clk per bit (idle-high).

    >>> _uart_frame(0x55)
    [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1]
    """
    return [0] + [(byte >> i) & 1 for i in range(8)] + [1, 1]


def _sched_basic(
    prog: asm.Program,
    pctrl_v: int,
    exec_v: int,
    shift_v: int | None,
    clkdiv_v: int = clkdiv(),
    entry: int | None = None,
    feeds: Sequence[int] = (),
    post: Callable[[Schedule], object] | None = None,  # stmt-sequence lambdas: return ignored
    nclk: int = 300,
) -> Schedule:
    """The common CF shape: load words, config, entry-point force, feeds,
    enable, then a program-specific post-enable timeline."""
    s = Schedule()
    s.load_imem(prog.words)
    s.w(A_SM0 + 4 * 5, pctrl_v)
    s.w(A_SM0 + 4 * 1, exec_v)
    if shift_v is not None:
        s.w(A_SM0 + 4 * 2, shift_v)
        # one idle clk so a FJOIN-changing SHIFTCTRL write flushes
        # (SPEC-6-2) before the feeds land — otherwise the coincident
        # TXF write is dropped by the flush edge (as the RTL does)
        s.idle(1)
    if clkdiv_v != clkdiv():
        s.w(A_SM0 + 4 * 0, clkdiv_v)
    if entry is not None:
        s.set_pc(entry)
    for f in feeds:
        s.feed(f)
    s.enable()
    if post is not None:
        post(s)
    s.run_to(nclk)
    return s


def _gpio_script(s: Schedule, pairs: list[tuple[int, int]], pin: int | None = None) -> None:
    """Script gpio_in from the timeline head: (level, clks) segments on
    one pin, or full 32-bit values when pin is None."""
    k = len(s.cycles)
    for level, n in pairs:
        s.run_to(k)
        s.set_gpio(level if pin is None else ((level & 1) << pin))
        k += n
    s.run_to(k)


def conformance_schedules(repo: str | Path) -> list[tuple[str, Schedule]]:
    """-> ordered [(case, Schedule)] for the 19 conf_pioexamples programs."""
    cases: list[tuple[str, Schedule]] = []

    def add(name: str, sched: Schedule) -> None:
        cases.append((name, sched))

    def pick(rel: str, nm: str) -> asm.Program:
        return _prog(repo, rel, nm)

    # CF1 squarewave — PCTRL set base 2 count 1 (tb_conf cf1)
    p = pick("pio/squarewave/squarewave.pio", "squarewave")
    add("squarewave", _sched_basic(p, pctrl(0, 1, 0, 0, 0, 2, 0), execctrl(*p.wrap_bounds), None, nclk=200))

    # CF2 addition — PULL/MOV/PUSH e2e (tb_conf cf2)
    p = pick("pio/addition/addition.pio", "addition")
    add(
        "addition",
        _sched_basic(
            p,
            pctrl(),
            execctrl(*p.wrap_bounds),
            None,
            post=lambda s: (
                s.run_to(20),
                s.feed(7),
                s.feed(3),
                s.run_to(90),
                s.r(A_FSTAT),
                s.r(A_RXF0),
                s.r(A_FLEVEL),
                s.run_to(110),
                s.feed(0xFFFFFFFF),
                s.feed(1),
                s.run_to(190),
                s.r(A_RXF0),
                s.r(A_FSTAT),
            ),
            nclk=220,
        ),
    )

    # CF3 ws2812 — autopull LEFT @24, JOIN_TX (tb_conf cf3). One word:
    # the OSR bottoms out around clk 250 and the OUT stalls on the empty
    # TX (CC-11/CC-17 corner, SPEC-15-3), released by the clk-270 feed.
    p = pick("pio/ws2812/ws2812.pio", "ws2812")
    add(
        "ws2812",
        _sched_basic(
            p,
            pctrl(1, 0, 1, 0, 0, 0, 0),
            execctrl(*p.wrap_bounds),
            shiftctrl(fjoin_tx=True, pull_thr=24, out_right=False, in_right=True, autopull=True),
            feeds=[0x80000100],
            post=lambda s: (s.run_to(270), s.feed(0xFFFFFF00), s.r(A_FSTAT)),
            nclk=320,
        ),
    )

    # CF4 uart_tx — ss 1 opt + out pin 0 (tb_conf cf4)
    p = pick("pio/uart_tx/uart_tx.pio", "uart_tx")
    add(
        "uart_tx",
        _sched_basic(
            p,
            pctrl(2, 0, 1, 0, 0, 0, 0),
            execctrl(*p.wrap_bounds, side_en=True),  # SIDE_EN (cf4)
            shiftctrl(fjoin_tx=True),
            feeds=[0x55],
            post=lambda s: (s.run_to(100), s.feed(0x00), s.r(A_FSTAT)),
            nclk=180,
        ),
    )

    # CF5 spi_cpha0 — MISO bypass (tb_conf cf5)
    p = pick("pio/spi/spi.pio", "spi_cpha0")
    add(
        "spi_cpha0",
        _sched_basic(
            p,
            pctrl(1, 0, 1, 2, 0, 0, 1),
            execctrl(*p.wrap_bounds),
            shiftctrl(pull_thr=8, push_thr=8, out_right=False, in_right=False, autopull=True, autopush=True),
            feeds=[0xA5000000],
            post=lambda s: (s.run_to(30), s.w(A_ISB, 4), s.feed(0x3C000000), s.run_to(120), s.r(A_RXF0)),
            nclk=160,
        ),
    )

    # CF6 spi_cpha1 (tb_conf cf6)
    p = pick("pio/spi/spi.pio", "spi_cpha1")
    add(
        "spi_cpha1",
        _sched_basic(
            p,
            pctrl(1, 0, 1, 2, 0, 0, 1),
            execctrl(*p.wrap_bounds),
            shiftctrl(pull_thr=8, push_thr=8, out_right=False, in_right=False, autopull=True, autopush=True),
            feeds=[0x3C000000],
            post=lambda s: (s.run_to(30), s.w(A_ISB, 4), s.r(A_FLEVEL)),
            nclk=160,
        ),
    )

    # CF7 spi_cpha0_cs — entry point + the TXSTALL W1C idiom (tb_conf cf7)
    p = pick("pio/spi/spi.pio", "spi_cpha0_cs")
    add(
        "spi_cpha0_cs",
        _sched_basic(
            p,
            pctrl(2, 0, 1, 3, 0, 0, 2),
            execctrl(*p.wrap_bounds),
            shiftctrl(pull_thr=8, push_thr=8, out_right=False, in_right=False, autopull=True, autopush=True),
            entry=p.labels["entry_point"],
            feeds=[0x5A000000, 0x3C000000],
            post=lambda s: (
                s.run_to(30),
                s.w(A_ISB, 8),
                s.r(A_FDEBUG),
                s.w(A_FDEBUG, 1 << 24),  # W1C TXSTALL0
                s.run_to(120),
                s.feed(0xA5000000),
                s.r(A_FDEBUG),
            ),
            nclk=180,
        ),
    )

    # CF8 clocked_input — in @8 right, autopush (tb_conf cf8)
    p = pick("pio/clocked_input/clocked_input.pio", "clocked_input")
    s = _sched_basic(
        p,
        pctrl(0, 0, 0, 4, 0, 0, 0),
        execctrl(*p.wrap_bounds),
        shiftctrl(fjoin_rx=True, push_thr=8, out_right=True, in_right=False, autopush=True),
        nclk=0,
    )
    # clock+data per the C init's 2-pin window (in_base=4): pin 5 is the
    # clock (the program waits on `pin 1` = in_bus[1]), pin 4 the data
    # (in pins samples in_bus[0]). 4-clk clock cells with a data pattern
    # that changes across edges, so a one-clk sampling shift (e.g. a
    # CC-23 mutation) flips captured bits.
    data = [1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 1]
    segs = []
    for i, d in enumerate(data):
        # clock: low 2, high 2; data toggles every clk so a one-clk
        # sampling shift flips the captured bit (~half the samples)
        segs.append((((i & 1) << 4) | 0x00, 1))
        segs.append(((d << 4) | 0x00, 1))
        segs.append((((i & 1) << 4) | 0x20, 1))
        segs.append(((d << 4) | 0x20, 1))
    _gpio_script(s, segs)
    k = len(s.cycles)
    for i in range(5):  # scatter RXF0/FLEVEL reads
        s.run_to(k + 40 * i)
        s.r(A_RXF0)
        s.r(A_FLEVEL)
    s.run_to(k + 40 * 5)
    add("clocked_input", s)

    # CF9 quadrature_encoder — jump table + push noblock (tb_conf cf9)
    p = pick("pio/quadrature_encoder/quadrature_encoder.pio", "quadrature_encoder")
    s = _sched_basic(p, pctrl(), execctrl(*p.wrap_bounds), shiftctrl(out_right=True, in_right=False), nclk=0)
    # AB quadrature walk on pins 0/1
    seq = [(0b00, 4), (0b01, 4), (0b11, 4), (0b10, 4)] * 6
    k = len(s.cycles)
    for val, n in seq:
        s.run_to(k)
        s.set_gpio(val)
        k += n
    s.run_to(340)
    for _ in range(4):
        s.r(A_RXF0)
    s.r(A_FSTAT)
    s.run_to(380)
    add("quadrature_encoder", s)

    # CF10 onewire — od pads simplified to scripted gpio (tb_conf cf10)
    p = pick("pio/onewire/onewire_library/onewire_library.pio", "onewire")
    s = _sched_basic(
        p,
        pctrl(1, 0, 0, 0, 0, 0, 0),
        execctrl(*p.wrap_bounds, side_pindirs=True),  # cf10
        shiftctrl(pull_thr=8, push_thr=8, out_right=True, in_right=True, autopull=True, autopush=True),
        entry=p.labels["reset_bus"],
        nclk=0,
    )
    # reset pulse (480 clks low) + presence (70) + read slots
    _gpio_script(s, [(0, 480), (1, 70)] + [(0, 60), (1, 8)] * 16, pin=0)
    s.run_to(700)
    s.r(A_RXF0)
    s.feed(0xFF)
    s.run_to(760)
    add("onewire", s)

    # CF11 i2c — entry point, TXF exec records (tb_conf cf11)
    p = pick("pio/i2c/i2c.pio", "i2c")
    aux = pick("pio/i2c/i2c.pio", "set_scl_sda")
    s = Schedule()
    s.load_imem(p.words)
    s.load_imem(aux.words, base=24)
    s.w(A_SM0 + 4 * 5, pctrl(2, 2, 1, 0, 1, 0, 0))
    s.w(A_SM0 + 4 * 1, execctrl(*p.wrap_bounds, side_en=True, side_pindirs=True))  # cf11
    s.w(
        A_SM0 + 4 * 2, shiftctrl(pull_thr=16, push_thr=8, out_right=False, in_right=False, autopull=True, autopush=True)
    )
    s.set_pc(p.labels["entry_point"])
    s.enable()
    s.run_to(30)
    s.feed(0x08000800)  # 2<<10 | final=0 | data=0
    s.run_to(60)
    s.feed((0xFF80 << 16) | 0xFF80)  # set pindirs,0 side 1 [7] x2
    s.run_to(90)
    s.feed((0xF780 << 16) | 0xF780)
    s.run_to(120)
    s.r(A_FLEVEL)
    s.r(A_FSTAT)
    s.run_to(140)
    # scripted SCL/SDA wire (open-drain pads simplified): clock + ACK
    _gpio_script(s, [(0b11, 40), (0b10, 20), (0b11, 20), (0b01, 20), (0b11, 20)])
    s.run_to(300)
    add("i2c", s)

    # CF12 manchester — single-SM variants of the tx/rx loopback
    p = pick("pio/manchester_encoding/manchester_encoding.pio", "manchester_tx")
    s = _sched_basic(
        p,
        pctrl(2, 1, 0, 0, 0, 0, 0),
        execctrl(*p.wrap_bounds, side_en=True),  # cf12
        shiftctrl(fjoin_tx=True, out_right=True, in_right=True, autopull=True),
        entry=p.labels["start"],
        nclk=0,
    )
    s.set_lb(1)  # wire pin0 from own output
    s.run_to(40)
    for f in (0, 0x0FF0A55A, 0x12345678):
        s.feed(f)
    s.run_to(360)
    s.r(A_FSTAT)
    s.run_to(400)
    add("manchester_tx", s)

    p = pick("pio/manchester_encoding/manchester_encoding.pio", "manchester_rx")
    s = _sched_basic(
        p,
        pctrl(0, 0, 0, 0, 0, 0, 0),
        execctrl(*p.wrap_bounds),
        shiftctrl(fjoin_rx=True, out_right=True, in_right=True, autopush=True),
        nclk=0,
    )
    # 12 clk/bit manchester of 0xA55A: each bit = mid-bit transition
    frame = []
    for bit in [(0xA55A >> i) & 1 for i in range(16)] + [1, 1]:
        frame += [(bit, 6), (1 - bit, 6)]
    _gpio_script(s, frame, pin=0)
    s.run_to(600)
    for _ in range(2):
        s.r(A_RXF0)
    s.run_to(640)
    add("manchester_rx", s)

    # CF15 differential manchester — single-SM variants
    p = pick("pio/differential_manchester/differential_manchester.pio", "differential_manchester_tx")
    s = _sched_basic(
        p,
        pctrl(2, 1, 0, 0, 0, 0, 0),
        execctrl(*p.wrap_bounds, side_en=True),  # cf15
        shiftctrl(fjoin_tx=True, out_right=True, in_right=True, autopull=True),
        entry=p.labels["start"],
        nclk=0,
    )
    s.set_lb(1)
    s.run_to(40)
    for f in (0, 0x0FF0A55A, 0x12345678):
        s.feed(f)
    s.run_to(400)
    add("differential_manchester_tx", s)

    p = pick("pio/differential_manchester/differential_manchester.pio", "differential_manchester_rx")
    s = _sched_basic(
        p,
        pctrl(0, 0, 0, 0, 0, 0, 0),
        execctrl(*p.wrap_bounds),
        shiftctrl(fjoin_rx=True, out_right=True, in_right=True, autopush=True),
        nclk=0,
    )
    # 16 clk/bit, start-of-bit edge always transitions
    frame = []
    lvl = 0
    for bit in [(0xA55A >> i) & 1 for i in range(16)] + [1, 1]:
        frame.append((lvl, 8))
        nxt = lvl if bit else 1 - lvl  # '1': no mid transition
        frame.append((nxt, 8))
        lvl = 1 - nxt
    _gpio_script(s, frame, pin=0)
    s.run_to(760)
    s.r(A_RXF0)
    s.run_to(800)
    add("differential_manchester_rx", s)

    # CF16 uart_rx — scripted 8n1 frames at 8 clk/bit (tb_conf cf16 rx side)
    p = pick("pio/uart_rx/uart_rx.pio", "uart_rx")
    s = _sched_basic(p, pctrl(0, 0, 0, 0, 0, 0, 0), execctrl(*p.wrap_bounds), shiftctrl(fjoin_rx=True), nclk=0)
    for byte in (0x48, 0x65, 0x6C):
        _gpio_script(s, [(b, 8) for b in _uart_frame(byte)], pin=0)
    s.run_to(420)
    for _ in range(3):
        s.r(A_RXF0)
    s.r(A_FSTAT)
    s.run_to(460)
    add("uart_rx", s)

    # CF13 hub75_data_rgb888 — imem patch while running (SPEC-15-6, CC-33)
    p = pick("pio/hub75/hub75.pio", "hub75_data_rgb888")
    add(
        "hub75_data_rgb888",
        _sched_basic(
            p,
            pctrl(1, 0, 6, 0, 6, 0, 0),
            execctrl(*p.wrap_bounds),
            shiftctrl(pull_thr=24, out_right=True, in_right=False, autopull=True),
            feeds=[0x040201, 0x0],
            post=lambda s: (
                s.run_to(150),
                s.feed(0x040201),
                s.feed(0x0),
                s.run_to(190),
                s.w(A_IMEM0 + 4 * 7, 0x1000),  # jmp 0 side 1
                s.w(A_IMEM0 + 4 * 15, 0x1000),  # CC-33 patch
                s.r(A_SM0 + 4 * 3),
                s.r(A_SM0 + 4 * 4),  # dropped addrs
                s.run_to(260),
            ),
            nclk=300,
        ),
    )

    # CF14 apa102_rgb555 — in isr rotate / in osr counter (tb_conf cf14)
    p = pick("pio/apa102/apa102.pio", "apa102_rgb555")
    add(
        "apa102_rgb555",
        _sched_basic(
            p,
            pctrl(0, 1, 1, 0, 0, 1, 0),
            execctrl(*p.wrap_bounds),
            shiftctrl(pull_thr=16, out_right=True, in_right=True, autopull=True),
            feeds=[0x040201, 0x0],
            post=lambda s: (s.run_to(200), s.r(A_FLEVEL), s.r(A_FSTAT)),
            nclk=240,
        ),
    )

    # CF17 uart at the realistic fractional clkdiv — single-SM tx side
    # (the CF17 clkdiv INT=135 FRAC=162; the divider trace is the target)
    p = pick("pio/uart_tx/uart_tx.pio", "uart_tx")
    add(
        "uart_tx_clkdiv",
        _sched_basic(
            p,
            pctrl(2, 0, 1, 0, 0, 0, 0),
            execctrl(*p.wrap_bounds, side_en=True),  # cf17
            shiftctrl(fjoin_tx=True),
            clkdiv_v=clkdiv(135, 162),
            feeds=[0x48, 0x65],
            post=lambda s: (s.run_to(900), s.feed(0x6C), s.r(A_FSTAT)),
            nclk=1100,
        ),
    )

    # CF17 rx side — scripted frame through the 2-FF sync at clkdiv
    p = pick("pio/uart_rx/uart_rx.pio", "uart_rx")
    s = _sched_basic(
        p,
        pctrl(0, 0, 0, 0, 0, 0, 0),
        execctrl(*p.wrap_bounds),
        shiftctrl(fjoin_rx=True),
        clkdiv_v=clkdiv(135, 162),
        nclk=0,
    )
    for byte in (0x48, 0x65):
        _gpio_script(s, [(b, 136) for b in _uart_frame(byte)], pin=0)
    s.run_to(3400)
    for _ in range(2):
        s.r(A_RXF0)
    s.run_to(3500)
    add("uart_rx_clkdiv", s)

    # The multi-SM corpus: no CF precedent — parallel SMs on the shared
    # imem, cross-SM pin arbitration, inter-SM IRQ handoff, and the
    # SM1..3 FIFO/window accesses.
    cases.extend(_multi_sm_cases())
    return cases


def _multi_sm_cases() -> list[tuple[str, Schedule]]:
    """Multi-SM schedules: SM-indexed config windows, TXF1..3 feeds,
    per-SM dividers, inter-SM IRQ REL handoff (SPEC-3.8-6), cross-SM
    pin priority (CC-7) and the aux putget windows beyond SM0."""

    def config(
        s: Schedule, sm: int, pctrl_v: int, exec_v: int, shift_v: int | None = None, div_v: int | None = None
    ) -> None:
        s.w(sm_addr(sm, 5), pctrl_v)
        s.w(sm_addr(sm, 1), exec_v)
        if shift_v is not None:
            s.w(sm_addr(sm, 2), shift_v)
            # one idle clk so a FJOIN-changing SHIFTCTRL write flushes
            # (SPEC-6-2) before any queue op or PUTGET write lands
            s.idle(1)
        if div_v is not None:
            s.w(sm_addr(sm, 0), div_v)

    cases: list[tuple[str, Schedule]] = []

    # parallel squares: all four SMs on one shared imem, per-SM SET_BASE
    # pins, SM2 at its own divider (CC-26 is per SM).
    sq = [E.encode_set("pins", 1, 1), E.encode_set("pins", 0, 1)]
    s = Schedule()
    s.load_imem(sq)
    for i in range(4):
        config(s, i, pctrl(set_cnt=1, set_base=i), execctrl(1, 0), div_v=clkdiv(2) if i == 2 else None)
    s.enable(0xF)
    s.run_to(120)
    s.r(A_FSTAT)
    s.r(A_FLEVEL)
    s.r(A_PADOUT)
    s.run_to(160)
    cases.append(("multi_parallel", s))

    # arbitration: SM0 writes 0 and SM3 writes 1 to pin 0 every clk
    # (CC-7: highest SM wins); SM1 toggles pin 1 in parallel.
    mov0 = E.encode_mov("pins", "null", E.MOP_NONE)
    mov1 = E.encode_mov("pins", "null", E.MOP_INV)
    s = Schedule()
    s.load_imem([mov0, mov0])
    s.load_imem([E.encode_set("pins", 1, 3), E.encode_set("pins", 0, 3)], base=8)
    s.load_imem([mov1, mov1], base=16)
    config(s, 0, pctrl(out_cnt=1), execctrl(1, 0))
    config(s, 1, pctrl(set_cnt=1, set_base=1), execctrl(9, 8))
    config(s, 3, pctrl(out_cnt=1), execctrl(17, 16))
    s.set_pc(8, sm=1)
    s.set_pc(16, sm=3)
    s.enable(0b1011)
    s.run_to(90)
    s.r(A_PADOUT)
    s.r(A_PADOE)
    s.run_to(120)
    cases.append(("multi_arbitrate", s))

    # inter-SM IRQ handoff: SM1 `irq 0 rel` -> flag 1, SM3 `irq 0 rel`
    # -> flag 3 (SPEC-3.8-6); SM0 and SM2 wait on their flags. The
    # completing WAIT-1 clears (CC-15), so the flags chatter while the
    # two setters loop.
    words = [
        E.encode_wait(1, E.WSRC_IRQ, 1, 0),  # SM0 @0
        E.encode_set("pins", 1, 0),
        E.encode_jmp(None, 0, 0),
        0,
        0,
        0,
        0,
        0,
        E.encode_irq(False, False, 2, 0, 0),  # SM1 @8: irq nowait 0 rel
        E.encode_jmp(None, 8, 0),
        0,
        0,
        0,
        0,
        0,
        0,
        E.encode_wait(1, E.WSRC_IRQ, 3, 0),  # SM2 @16
        E.encode_set("pins", 1, 1),
        E.encode_jmp(None, 16, 0),
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        E.encode_irq(False, False, 2, 0, 0),  # SM3 @26: irq nowait 0 rel
        E.encode_jmp(None, 26, 0),
        0,
        0,
        0,
        0,
    ]
    s = Schedule()
    s.load_imem(words)
    config(s, 0, pctrl(set_cnt=1, set_base=0), execctrl(2, 0))
    config(s, 1, pctrl(), execctrl(9, 8))
    config(s, 2, pctrl(set_cnt=1, set_base=2), execctrl(17, 16))
    config(s, 3, pctrl(), execctrl(27, 26))
    s.set_pc(8, sm=1)
    s.set_pc(16, sm=2)
    s.set_pc(26, sm=3)
    s.enable(0xF)
    s.run_to(80)
    s.r(A_IRQ)
    s.run_to(100)
    s.r(A_IRQ)
    s.run_to(140)
    cases.append(("multi_irq_handoff", s))

    # SM1..3 FIFO windows: SM2 echoes TXF2 -> RXF2 while SM1 runs a
    # square on pin 1 (TXF2 feeds, RXF2 reads, FSTAT/FLEVEL nibbles).
    echo = [
        E.encode_pull(True, True, 0),  # pull block
        E.encode_mov("isr", "osr", E.MOP_NONE, 0),
        E.encode_push(True, True, 0),  # push block
        E.encode_jmp(None, 8, 0),
    ]
    s = Schedule()
    s.load_imem([E.encode_set("pins", 1, 1), E.encode_set("pins", 0, 1)], base=0)
    s.load_imem(echo, base=8)
    config(s, 1, pctrl(set_cnt=1, set_base=1), execctrl(1, 0))
    config(s, 2, pctrl(), execctrl(11, 8))
    for w in (0xCAFEBABE, 0x13579BDF, 2):
        s.feed(w, sm=2)
    s.enable(0b110)
    s.run_to(120)
    s.r(A_FLEVEL)
    s.r(A_FSTAT)
    for _ in range(3):
        s.r(A_RXF0 + 8)  # RXF2
    s.r(A_FLEVEL)
    s.run_to(160)
    cases.append(("multi_txf_sm2", s))

    # aux putget beyond SM0: SM1 in TXGET (fjoin_rx_get) serving `get`
    # from its PUTGET window while SM0 squares pin 0.
    getp = [
        E.encode_get(0, 0),  # get 0 (SPEC-3.7-3, y-indexed immediate)
        E.encode_out("pins", 8, 0),
        E.encode_jmp(None, 16, 0),
    ]
    s = Schedule()
    s.load_imem([E.encode_set("pins", 1, 2), E.encode_set("pins", 0, 2)], base=0)
    s.load_imem(getp, base=16)
    config(s, 0, pctrl(set_cnt=1, set_base=0), execctrl(1, 0))
    config(
        s, 1, pctrl(out_cnt=8, out_base=2), execctrl(18, 16), shiftctrl(fjoin_rx_get=True, pull_thr=8, autopull=True)
    )
    s.set_pc(16, sm=1)
    s.w(A_PUTGET0 + 0x10, 0x000000FF)  # SM1 PUTGET slot 0
    s.w(A_PUTGET0 + 0x10 + 4, 0xFFFFFF00)  # slot 1
    s.enable(0b11)
    s.run_to(120)
    s.r(A_FLEVEL)
    s.r(A_PUTGET0 + 0x10)  # slot readback
    s.run_to(160)
    cases.append(("multi_putget_sm1", s))

    return cases

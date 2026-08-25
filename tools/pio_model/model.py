"""clk-accurate golden model of one pio_block (C12) — SM0 live, SM1..3
held at reset (the SPEC-16-4 single-SM scoping).

This is a cycle-by-cycle transcription of the RTL, not a re-derivation
from the datasheet: every section below carries the rtl/ file it
mirrors and the SPEC-/CC- citations the RTL itself cites. The
combinational-then-edge discipline matches the RTL's non-blocking
assignments: all per-cycle reads see start-of-clk state (CC-4), all
effects land at the cycle-closing edge (CC-3).

Step protocol (difftest + sim/tb_trace_dump.sv use the identical one):
    obs = step(gpio_in, lb_mask, op, addr, wdata, ...)
  - cycle k = the interval between clk edge k and k+1; clk 0 is the
    first cycle with rst de-asserted (SPEC-16-7), so clk-0 observables
    are the reset values;
  - inputs (gpio_in after lb_mask folding, the one reg-bus op, the
    neighbour IRQ vectors) are the cycle-k values; obs carries the
    per-clk observables (gpio_out/oe, intr — SPEC-16-1) and reg_rdata
    if the op is a read (SPEC-16-2);
  - the edge update then applies every registered effect.

Mutation hooks (the C12 red/green demo): named deviations from the
cited facts, e.g. mutations={"cc11_no_stall"} drops the CC-11
autopull-OUT stall. Un-mutated, the model's contract is trace equality
with the RTL on the SPEC-16-7 observables.
"""

from typing import Self, TypedDict

from . import encoding as E

M32 = 0xFFFFFFFF
M16 = 0xFFFF

# pio_sm.sv FIFO-mode encoding (SPEC-6-2/6-3).
FM_TXRX, FM_TX, FM_RX, FM_TXPUT, FM_TXGET, FM_PUTGET = range(6)

# pio_sm_exec onehot FSM states.
ST_FETCH, ST_EXEC, ST_STALL, ST_DELAY = 0b0001, 0b0010, 0b0100, 0b1000

# Datasheet config reset values (pio_sm_regs.sv).
CLKDIV_RESET = 0x00010000  # INT=1 FRAC=0 (SPEC-7-14)
EXECCTRL_RESET = 0x00001FFF  # WRAP_TOP=1, WRAP_BOTTOM=31, STATUS_N=31
SHIFTCTRL_RESET = 0x000C0000  # both SHIFTDIR right (SPEC-5-2)
PINCTRL_RESET = 0x14000000  # SET_COUNT=5 (SPEC-7-26)


class Observables(TypedDict):
    """The per-clk observable bundle (SPEC-16-1/2): pad levels at the clk
    boundary, the interrupt line, and the reg-bus read payload when this
    cycle's op is a read (else rdata=None)."""

    gpio_out: int
    gpio_oe: int
    intr: int
    rdata: int | None
    read: bool
    addr: int


MUTATIONS = (
    "jmp_postdec",  # SPEC-14.5-1: branch tests post-decrement X/Y
    "cc11_no_stall",  # CC-11/CC-12: threshold OUT completes + refills
    "ss_opt_ignored",  # SPEC-4-2: opt side-set fires with enable=0
    "sync_1ff",  # CC-23: input path sees sync-FF1 everywhere
    "wrap_off",  # SPEC-8-2: no wrap, PC always +1
    "delay_in_stall",  # CC-14: delay elapses during a stall
    "irq_same_cycle",  # CC-37: flag set visible in its own clk cycle
)


def _bit(v: int, i: int) -> int:
    return (v >> i) & 1


def _ror32(v: int, s: int) -> int:
    s &= 31
    return ((v >> s) | (v << (32 - s))) & M32 if s else v & M32


def _rol32(v: int, s: int) -> int:
    s &= 31
    return ((v << s) | (v >> (32 - s))) & M32 if s else v & M32


def _bitrev32(v: int) -> int:
    return int(f"{v:032b}"[::-1], 2)


class PIOBlockModel:
    """One pio_block (rtl/pio_block.sv and children), single-SM scope.

    >>> m = PIOBlockModel()
    >>> obs = m.step(0)                # clk 0: reset values on the pads
    >>> (obs["gpio_out"], obs["gpio_oe"], obs["intr"])   # doctest: +NORMALIZE_WHITESPACE
    (0, 0, 240)
    >>> obs["rdata"] is None           # no reg read this clk
    True
    >>> m.ctrl_r = 1                   # SM0 enable (SPEC-7-2)
    >>> m.imem = [E.encode_set("pins", 1, 0), E.encode_jmp(None, 0, 0)]
    >>> m.pinctrl_r = 1 << 26          # SET_COUNT=1 (SPEC-7-26)
    >>> _ = [m.step(0) for _ in range(6)]
    >>> m.gpio_lvl_r
    1
    """

    def __init__(self, mutations: tuple[str, ...] | list[str] = ()) -> None:
        bad = set(mutations) - set(MUTATIONS)
        if bad:
            raise ValueError(f"unknown mutations: {sorted(bad)}")
        self.mut: set[str] = set(mutations)
        self.reset()

    # ------------------------------------------------------------------
    # Reset (CC-1): every register's rst value, per its owner module.
    # ------------------------------------------------------------------
    def reset(self) -> Self:
        # pio_block.sv block regs
        self.ctrl_r: int = 0  # CTRL.SM_ENABLE (SPEC-7-2)
        self.isb_r: int = 0  # INPUT_SYNC_BYPASS (SPEC-7-7)
        self.imem: list[int] = [0] * 32  # pio_instr_mem all-zero reset
        # pio_irq_flags.sv
        self.flags_r: int = 0
        # pio_gpio_mux.sv
        self.sync1_r: int = 0
        self.sync2_r: int = 0
        self.gpio_lvl_r: int = 0
        self.gpio_oe_r: int = 0
        self.sticky_mask: list[int] = [0] * 4  # SM0's record is live
        self.sticky_lvl: list[int] = [0] * 4
        self.sticky_dir: list[int] = [0] * 4
        self.sticky_is_dir: list[int] = [0] * 4
        # pio_sm_regs.sv config banks (datasheet defaults)
        self.clkdiv_r: int = CLKDIV_RESET
        self.execctrl_r: int = EXECCTRL_RESET
        self.shiftctrl_r: int = SHIFTCTRL_RESET
        self.pinctrl_r: int = PINCTRL_RESET
        # divider (CC-26): phase/stretch/count/pending
        self.phase_r: int = 0
        self.stretch_r: int = 0
        self.count_r: int = 0
        self.pending_r: int = 0
        # pio_sm_exec.sv
        self.state_r: int = ST_FETCH
        self.pc_r: int = 0
        self.x_r: int = 0
        self.y_r: int = 0
        self.delay_cnt_r: int = 0
        self.latch_r: int = 0  # CC-34/35 EXEC/force latch
        self.latch_vld_r: int = 0
        self.latch_force_r: int = 0
        self.force_pend_r: int = 0
        self.forced_stall_r: int = 0
        self.irqw_wait_r: int = 0
        self.restart_pend_r: int = 0
        self.irq_prev: int = 0  # relay views (CC-38), latched
        self.irq_next: int = 0  # at each step() entry
        # pio_sm_shift.sv (SPEC-5-3)
        self.osr_r: int = 0
        self.isr_r: int = 0
        self.osr_cnt_r: int = 32
        self.isr_cnt_r: int = 0
        # pio_sm_fifo.sv
        self.mode_r: int = FM_TXRX
        self.tx_mem: list[int] = [0] * 8
        self.rx_mem: list[int] = [0] * 8
        self.tx_head: int = 0
        self.tx_tail: int = 0
        self.rx_head: int = 0
        self.rx_tail: int = 0
        self.tx_level: int = 0
        self.rx_level: int = 0
        self.fdbg_tx_stall: int = 0  # SPEC-6-7 stickies
        self.fdbg_rx_stall: int = 0
        self.fdbg_tx_over: int = 0
        self.fdbg_rx_under: int = 0
        self._mut_stall_seen: bool = False  # delay_in_stall demo state
        return self

    # ------------------------------------------------------------------
    # Config field decode (pio_sm_regs.sv bit positions, SPEC-7-14..26).
    # ------------------------------------------------------------------
    @property
    def clkdiv_int(self) -> int:
        return (self.clkdiv_r >> 16) & M16

    @property
    def clkdiv_frac(self) -> int:
        return (self.clkdiv_r >> 8) & 0xFF

    @property
    def side_en(self) -> bool:
        return _bit(self.execctrl_r, 30) != 0  # SPEC-7-16

    @property
    def side_pindir(self) -> bool:
        return _bit(self.execctrl_r, 29) != 0

    @property
    def jmp_pin(self) -> int:
        return (self.execctrl_r >> 24) & 0x1F

    @property
    def out_sticky_en(self) -> bool:
        return _bit(self.execctrl_r, 17) != 0  # SPEC-7-18

    @property
    def wrap_top(self) -> int:
        return (self.execctrl_r >> 12) & 0x1F  # SPEC-7-19

    @property
    def wrap_bottom(self) -> int:
        return (self.execctrl_r >> 7) & 0x1F

    @property
    def status_sel(self) -> int:
        return (self.execctrl_r >> 5) & 3  # SPEC-7-20

    @property
    def status_n(self) -> int:
        return self.execctrl_r & 0x1F

    @property
    def fjoin_rx(self) -> bool:
        return _bit(self.shiftctrl_r, 31) != 0  # SPEC-7-21

    @property
    def fjoin_tx(self) -> bool:
        return _bit(self.shiftctrl_r, 30) != 0

    @property
    def pull_thresh(self) -> int:
        return (self.shiftctrl_r >> 25) & 0x1F  # SPEC-5-7 (0 encodes 32)

    @property
    def push_thresh(self) -> int:
        return (self.shiftctrl_r >> 20) & 0x1F

    @property
    def out_shift_left(self) -> bool:
        return not _bit(self.shiftctrl_r, 19)  # SPEC-5-2: 1 = right

    @property
    def in_shift_left(self) -> bool:
        return not _bit(self.shiftctrl_r, 18)

    @property
    def autopull(self) -> bool:
        return _bit(self.shiftctrl_r, 17) != 0  # SPEC-5-8

    @property
    def autopush(self) -> bool:
        return _bit(self.shiftctrl_r, 16) != 0  # SPEC-5-9

    @property
    def fjoin_rx_put(self) -> bool:
        return _bit(self.shiftctrl_r, 15) != 0  # SPEC-6-3

    @property
    def fjoin_rx_get(self) -> bool:
        return _bit(self.shiftctrl_r, 14) != 0

    @property
    def in_mask_count(self) -> int:
        return self.shiftctrl_r & 0x1F  # SPEC-7-21, 0 = 32

    @property
    def sideset_count(self) -> int:
        return (self.pinctrl_r >> 29) & 7  # SPEC-7-26

    @property
    def set_count(self) -> int:
        return (self.pinctrl_r >> 26) & 7

    @property
    def out_count(self) -> int:
        return (self.pinctrl_r >> 20) & 0x3F  # 0 = 32 pins

    @property
    def in_base(self) -> int:
        return (self.pinctrl_r >> 15) & 0x1F  # SPEC-10-3

    @property
    def sideset_base(self) -> int:
        return (self.pinctrl_r >> 10) & 0x1F  # SPEC-4-5

    @property
    def set_base(self) -> int:
        return (self.pinctrl_r >> 5) & 0x1F  # SPEC-3.9-3

    @property
    def out_base(self) -> int:
        return self.pinctrl_r & 0x1F  # SPEC-3.4-2

    @property
    def fifo_mode(self) -> int:  # pio_sm.sv decode (SPEC-6-2/3)
        if self.fjoin_rx_put:
            return FM_PUTGET if self.fjoin_rx_get else FM_TXPUT
        if self.fjoin_rx_get:
            return FM_TXGET
        if self.fjoin_tx:
            return FM_TX
        if self.fjoin_rx:
            return FM_RX
        return FM_TXRX

    def _flag_rd(self, flags: int, mode: int, idx: int) -> int:
        """pio_sm_exec flag_rd (SPEC-3.8-4..7; SM0: REL adds 0 mod 4)."""
        if mode == 0:
            return _bit(flags, idx)
        if mode == 1:
            return _bit(self.irq_prev, idx)
        if mode == 2:
            return _bit(flags, (idx & 4) | (idx & 3))
        return _bit(self.irq_next, idx)

    # ==================================================================
    # One clk cycle. Returns the per-clk observables dict (SPEC-16-1/2).
    # ==================================================================
    def step(
        self,
        gpio_in: int,
        lb_mask: int = 0,
        op: int = 0,
        addr: int = 0,
        wdata: int = 0,
        nb_set: int = 0,
        nb_clr: int = 0,
        irq_prev: int = 0,
        irq_next: int = 0,
    ) -> Observables:
        self.irq_prev = irq_prev & 0xFF  # relay views (CC-38)
        self.irq_next = irq_next & 0xFF
        reg_write = op == 1
        reg_read = op == 2
        wdata &= M32

        # ---------------- pio_block: address decode (SPEC-7-x) --------
        widx = (addr >> 2) & 0x7F
        imem_hit = 18 <= widx <= 49  # 0x048..0x0c4 (SPEC-7-10)
        imem_addr = (widx - 18) & 0x1F
        sm_hit = 50 <= widx <= 73  # 0x0c8..0x124
        sm_off = widx - 50
        sm_sel = min(sm_off // 6, 3)
        sm_reg = sm_off - 6 * sm_sel
        aux_hit = 74 <= widx <= 89  # 0x128..0x164 (SPEC-7-13)
        aux_off = widx - 74
        aux_sel, bus_aux_idx = aux_off >> 2, aux_off & 3
        if sm_hit and sm_sel != 0 and (reg_write or reg_read):
            raise ValueError(f"SM{sm_sel} window access 0x{addr:03x} is out of the single-SM scope (SPEC-16-4)")
        if reg_write and widx in (5, 6, 7):  # TXF1..3
            raise ValueError("TXF1..3 writes are out of scope (SPEC-16-4)")
        if reg_read and widx in (9, 10, 11):  # RXF1..3
            raise ValueError("RXF1..3 reads are out of scope (SPEC-16-4)")

        clkdiv_we = reg_write and sm_hit and sm_reg == 0
        execctrl_we = reg_write and sm_hit and sm_reg == 1
        shiftctrl_we = reg_write and sm_hit and sm_reg == 2
        pinctrl_we = reg_write and sm_hit and sm_reg == 5
        force_we = reg_write and sm_hit and sm_reg == 4  # SPEC-7-23
        sm_restart = reg_write and widx == 0 and _bit(wdata, 4)  # SPEC-7-3
        clkdiv_restart = reg_write and widx == 0 and _bit(wdata, 8)  # CC-27
        sys_tx_wr = reg_write and widx == 4  # TXF0 (SPEC-7-28)
        sys_rx_rd = reg_read and widx == 8  # RXF0
        sys_aux_wr = reg_write and aux_hit and aux_sel == 0
        fdbg_clr: dict[str, int] = {  # FDEBUG W1C (SPEC-7-29)
            "tx_stall": _bit(wdata, 24) if (reg_write and widx == 2) else 0,
            "rx_stall": _bit(wdata, 0) if (reg_write and widx == 2) else 0,
            "tx_over": _bit(wdata, 16) if (reg_write and widx == 2) else 0,
            "rx_under": _bit(wdata, 8) if (reg_write and widx == 2) else 0,
        }
        irq_w1c = (wdata & 0xFF) if (reg_write and widx == 12) else 0
        irq_force = (wdata & 0xFF) if (reg_write and widx == 13) else 0

        # ---------------- gpio input path (pio_gpio_mux, CC-23) -------
        if "sync_1ff" in self.mut:
            gpio_seen = self.sync1_r
        else:
            gpio_seen = 0
            for p in range(32):
                seen = _bit(self.sync1_r, p) if _bit(self.isb_r, p) else _bit(self.sync2_r, p)
                gpio_seen |= seen << p
        count = self.in_mask_count  # SPEC-10-3 rotate + mask
        in_mask = M32 if count == 0 else (M32 >> (32 - count))
        in_bus = _ror32(gpio_seen, self.in_base) & in_mask

        # ---------------- divider combinational (pio_sm_regs, CC-26) --
        sm_en = self.ctrl_r & 1  # SM0 enable (SPEC-7-2)
        int_eff = 65536 if self.clkdiv_int == 0 else self.clkdiv_int
        frac_eff = 0 if self.clkdiv_int == 0 else self.clkdiv_frac
        target = int_eff + (1 if (self.stretch_r and self.clkdiv_int != 0) else 0)
        terminal = sm_en and self.count_r >= target - 1
        phase_sum = self.phase_r + frac_eff
        phase_next = phase_sum & 0xFF
        phase_carry = 1 if phase_sum >= 256 else 0

        # pio_sm_exec tick arbitration (CC-1/CC-35/CC-36)
        force_tick = self.force_pend_r or self.forced_stall_r
        sm_tick = sm_en and self.pending_r and not force_tick
        tick_forced = force_tick
        tick_sm = sm_tick and not tick_forced

        m_restart = tick_sm and self.restart_pend_r  # [MODEL] restart
        m_delay = tick_sm and not self.restart_pend_r and self.state_r == ST_DELAY
        m_exec = tick_forced or (tick_sm and not self.restart_pend_r and self.state_r != ST_DELAY)

        # ---------------- instruction selection + decode (CC-33/34) ---
        src_latch = tick_forced or (self.latch_vld_r and not self.latch_force_r)
        instr_mem_w = self.imem[self.pc_r]
        instr_cur = self.latch_r if src_latch else instr_mem_w
        d = E.decode(instr_cur, self.side_en, self.sideset_count)

        first_tick = m_exec and (not self.forced_stall_r if tick_forced else self.state_r != ST_STALL)

        # Early flag-view computation (pio_irq_flags, CC-37): everything
        # except the compl-gated clears (WAIT-1-irq / irq clear) is
        # known before stall evaluation. The irq_same_cycle mutation
        # lets same-cycle readers see these in-cycle sets (CC-37 viol).
        irq_set_req = first_tick and not d["illegal"] and d["is_irq"] and not d.get("irq_clr", 0)
        wsrc = d.get("wait_src", 0)
        widx5 = d.get("wait_index", 0)
        irq_flag_idx = d.get("irq_index", 0) if d["is_irq"] else widx5 & 7
        irq_idx_mode = d.get("irq_idxmode", 0) if d["is_irq"] else (widx5 >> 3) & 3
        loc_set_early = irq_force | (nb_set & 0xFF)
        loc_clr_early = irq_w1c | (nb_clr & 0xFF)
        if irq_idx_mode in (0, 2) and irq_set_req:  # SPEC-3.8-4/6
            loc_set_early |= 1 << irq_flag_idx
        flags_now = (
            ((self.flags_r | loc_set_early) & ~loc_clr_early) & 0xFF if "irq_same_cycle" in self.mut else self.flags_r
        )

        # ---------------- FIFO status (pio_sm_fifo, CC-4 start-of-tick)
        if self.fifo_mode == FM_TX:
            tx_depth, rx_depth = 8, 0  # SPEC-6-2
        elif self.fifo_mode == FM_RX:
            tx_depth, rx_depth = 0, 8
        elif self.fifo_mode in (FM_TXPUT, FM_TXGET, FM_PUTGET):
            tx_depth, rx_depth = 4, 0  # SPEC-6-4
        else:
            tx_depth = rx_depth = 4
        tx_full = tx_depth == 0 or self.tx_level >= tx_depth
        tx_empty = tx_depth == 0 or self.tx_level == 0
        rx_full = rx_depth == 0 or self.rx_level >= rx_depth
        rx_empty = rx_depth == 0 or self.rx_level == 0

        # ---------------- exec combinational (pio_sm_exec) ------------
        pull_thr = 32 if self.pull_thresh == 0 else self.pull_thresh
        push_thr = 32 if self.push_thresh == 0 else self.push_thresh
        tx_queue = self.fifo_mode in (FM_TXRX, FM_TX, FM_TXPUT, FM_TXGET)
        rx_queue = self.fifo_mode in (FM_TXRX, FM_RX)
        put_ok = self.fifo_mode in (FM_TXPUT, FM_PUTGET)  # SPEC-3.7-5
        get_ok = self.fifo_mode in (FM_TXGET, FM_PUTGET)
        ap_on = self.autopull and tx_queue  # undefined configs off
        aph_on = self.autopush and rx_queue

        if self.status_sel == 0:  # SPEC-3.6-12 TXLEVEL
            status_val = M32 if self.tx_level < self.status_n else 0
        elif self.status_sel == 1:  # RXLEVEL
            status_val = M32 if self.rx_level < self.status_n else 0
        elif self.status_sel == 2:  # IRQ (SPEC-12-9)
            n = self.status_n
            mode = (((n >> 4) & 1) << 1) | ((n >> 3) & 1)
            status_val = M32 if self._flag_rd(flags_now, mode, n & 7) else 0
        else:
            status_val = 0  # reserved selector

        osre = self.osr_cnt_r >= pull_thr  # SPEC-3.1-9
        tx_head_data = self.tx_mem[self.tx_head]  # CC-29

        # JMP condition (SPEC-3.1-2..11, SPEC-14.5-1)
        cond = d.get("jmp_cond", 0)
        x_pre, y_pre = self.x_r, self.y_r
        if "jmp_postdec" in self.mut and cond in (E.JC_XDEC, E.JC_YDEC):
            pre = x_pre if cond == E.JC_XDEC else y_pre
            jmp_taken = ((pre - 1) & M32) != 0
        elif cond == E.JC_ALWAYS:
            jmp_taken = True
        elif cond == E.JC_NOTX:
            jmp_taken = x_pre == 0
        elif cond == E.JC_XDEC:
            jmp_taken = x_pre != 0
        elif cond == E.JC_NOTY:
            jmp_taken = y_pre == 0
        elif cond == E.JC_YDEC:
            jmp_taken = y_pre != 0
        elif cond == E.JC_XNEY:
            jmp_taken = x_pre != y_pre
        elif cond == E.JC_PIN:
            jmp_taken = _bit(gpio_seen, self.jmp_pin)
        else:
            jmp_taken = not osre

        # WAIT condition (SPEC-3.2, CC-15)
        if wsrc == E.WSRC_GPIO:
            wait_pin = _bit(gpio_seen, widx5)
        elif wsrc == E.WSRC_PIN:
            wait_pin = _bit(in_bus, widx5)
        elif wsrc == E.WSRC_IRQ:
            wait_pin = self._flag_rd(flags_now, (widx5 >> 3) & 3, widx5 & 7)
        else:  # JMPPIN (SPEC-3.2-5)
            wait_pin = _bit(gpio_seen, (self.jmp_pin + (widx5 & 3)) & 0x1F)
        wait_cond = wait_pin == d.get("wait_pol", 1)

        # MOV source value + op (SPEC-3.6)
        msrc = d.get("mov_src", 0)
        if msrc == E.MOVS_PINS:
            mov_src_val = in_bus
        elif msrc == E.MOVS_X:
            mov_src_val = self.x_r
        elif msrc == E.MOVS_Y:
            mov_src_val = self.y_r
        elif msrc == E.MOVS_NULL:
            mov_src_val = 0
        elif msrc == E.MOVS_ISR:
            mov_src_val = self.isr_r
        elif msrc == E.MOVS_OSR:
            mov_src_val = self.osr_r
        else:
            mov_src_val = status_val
        mop = d.get("mov_op", 0)
        mov_result = (
            (~mov_src_val & M32) if mop == E.MOP_INV else _bitrev32(mov_src_val) if mop == E.MOP_REV else mov_src_val
        )

        # Stall evaluation (SPEC-9, CC-11..CC-21)
        push_guard = (not d.get("push_iff", 0)) or self.isr_cnt_r >= push_thr  # SPEC-3.5-5, CC-31
        pull_guard = (not d.get("pull_ife", 0)) or self.osr_cnt_r >= pull_thr  # SPEC-3.5-10, CC-31
        pull_fence = (not self.autopull) or self.osr_cnt_r >= pull_thr
        irqw_flag = self._flag_rd(flags_now, d.get("irq_idxmode", 0), d.get("irq_index", 0))
        irqw_rel = self.irqw_wait_r and not irqw_flag  # CC-16

        out_count = d.get("out_count", 0)
        in_count = d.get("in_count", 0)
        out_mask = (1 << out_count) - 1
        in_mask = (1 << in_count) - 1

        # Shifter combinational values (pio_sm_shift) — CC-4/CC-9
        out_data = (self.osr_r >> (32 - out_count)) if self.out_shift_left else (self.osr_r & out_mask)  # SPEC-3.4-1
        osr_shifted = (self.osr_r << out_count) & M32 if self.out_shift_left else self.osr_r >> out_count
        in_src = d.get("in_src", 0)
        if in_src == E.INS_PINS:
            in_data = in_bus
        elif in_src == E.INS_X:
            in_data = self.x_r
        elif in_src == E.INS_Y:
            in_data = self.y_r
        elif in_src == E.INS_OSR:
            in_data = self.osr_r  # SPEC-3.3-8
        else:
            in_data = 0  # NULL (SPEC-14.6-1)
        if in_count == 32:
            isr_shifted = in_data  # full shift-in replaces ISR
            isr_rotated = self.isr_r  # rotate by 32 = identity
        elif self.in_shift_left:
            isr_shifted = ((self.isr_r << in_count) & M32) | (in_data & in_mask)
            isr_rotated = ((self.isr_r << in_count) & M32) | (self.isr_r >> (32 - in_count))
        else:
            isr_shifted = ((self.isr_r >> in_count) | ((in_data & in_mask) << (32 - in_count))) & M32
            isr_rotated = ((self.isr_r >> in_count) | ((self.isr_r << (32 - in_count)) & M32)) & M32
        isr_next_in = isr_rotated if in_src == E.INS_ISR else isr_shifted

        osr_cnt_sat = min(self.osr_cnt_r + out_count, 32)  # SPEC-5-4
        isr_cnt_sat = min(self.isr_cnt_r + in_count, 32)
        autopull_ge_thr = self.autopull and self.osr_cnt_r >= pull_thr
        autopull_post_thr = self.autopull and osr_cnt_sat >= pull_thr
        autopush_req = self.autopush and isr_cnt_sat >= push_thr
        autopush_data = isr_next_in  # CC-9 post-shift ISR

        out_ap_ge = m_exec and d["is_out"] and not d["illegal"] and ap_on and autopull_ge_thr  # CC-11

        stall = False
        if m_exec and not d["illegal"]:
            if d["is_wait"]:
                stall = not wait_cond  # CC-15
            elif d["is_irq"] and d.get("irq_wait", 0) and not d.get("irq_clr", 0):
                stall = not irqw_rel  # CC-16
            elif d["is_push"]:
                stall = push_guard and d.get("push_blk", 1) and rx_full and rx_queue  # CC-19
            elif d["is_pull"]:
                stall = pull_guard and pull_fence and d.get("pull_blk", 1) and tx_empty  # CC-20
            elif d["is_out"]:
                stall = out_ap_ge
                if "cc11_no_stall" in self.mut:
                    stall = False  # the CC-11 violation
            elif d["is_in"]:
                stall = aph_on and autopush_req and rx_full  # CC-13
        compl = m_exec and not stall

        # PC / explicit writes / EXEC latch decisions (SPEC-8, CC-34/35)
        pc_wr_explicit = (
            compl
            and not d["illegal"]
            and (
                (d["is_jmp"] and jmp_taken)
                or (d["is_out"] and d.get("out_dst", 0) == E.OUTD_PC)
                or (d["is_mov"] and d.get("mov_dst", 0) == E.MOVD_PC)
            )
        )
        pc_wr_val = d.get("jmp_addr", 0) if d["is_jmp"] else (out_data & 0x1F if d["is_out"] else mov_result & 0x1F)
        if pc_wr_explicit:
            pc_next = pc_wr_val
        elif src_latch:
            pc_next = self.pc_r  # no implicit advance
        elif "wrap_off" in self.mut:
            pc_next = (self.pc_r + 1) & 0x1F  # SPEC-8-2 violation
        elif self.pc_r == self.wrap_top:
            pc_next = self.wrap_bottom  # SPEC-8-2
        else:
            pc_next = (self.pc_r + 1) & 0x1F  # SPEC-8-3

        just_latched = (
            compl
            and not d["illegal"]
            and (
                (d["is_out"] and d.get("out_dst", 0) == E.OUTD_EXEC)
                or (d["is_mov"] and d.get("mov_dst", 0) == E.MOVD_EXEC)
            )
        )
        exec_word = (out_data & M16) if d["is_out"] else (mov_result & M16)

        delay_load = compl and not just_latched and not tick_forced

        x_wr = (
            compl
            and not d["illegal"]
            and (
                (d["is_jmp"] and cond == E.JC_XDEC)
                or (d["is_out"] and d.get("out_dst", 0) == E.OUTD_X)
                or (d["is_set"] and d.get("set_dst", 0) == E.SETD_X)
                or (d["is_mov"] and d.get("mov_dst", 0) == E.MOVD_X)
            )
        )
        y_wr = (
            compl
            and not d["illegal"]
            and (
                (d["is_jmp"] and cond == E.JC_YDEC)
                or (d["is_out"] and d.get("out_dst", 0) == E.OUTD_Y)
                or (d["is_set"] and d.get("set_dst", 0) == E.SETD_Y)
                or (d["is_mov"] and d.get("mov_dst", 0) == E.MOVD_Y)
            )
        )
        if d["is_jmp"]:
            x_val, y_val = (self.x_r - 1) & M32, (self.y_r - 1) & M32
        elif d["is_out"]:
            x_val = y_val = out_data
        elif d["is_set"]:
            x_val = y_val = d.get("set_data", 0)
        else:
            x_val = y_val = mov_result

        # Shifter/FIFO dispatch (pio_sm_exec §dispatch)
        ap_ge_refill = out_ap_ge and not tx_empty  # CC-11 stall refill
        ap_post_refill = compl and d["is_out"] and not d["illegal"] and ap_on and autopull_post_thr and not tx_empty
        ap_bg = (
            m_exec
            and not d["illegal"]
            and not d["is_out"]
            and ap_on
            and autopull_ge_thr
            and not tx_empty
            and not (d["is_pull"] or (d["is_get"] and get_ok) or (d["is_mov"] and d.get("mov_dst", 0) == E.MOVD_OSR))
        )
        pull_load = compl and not d["illegal"] and d["is_pull"] and pull_guard and pull_fence and not tx_empty  # CC-20
        pull_fallb = (
            compl
            and not d["illegal"]
            and d["is_pull"]
            and pull_guard
            and pull_fence
            and not d.get("pull_blk", 1)
            and tx_empty
        )  # CC-32, SPEC-14.7-1
        get_en = compl and not d["illegal"] and d["is_get"] and get_ok
        mov_osr = compl and not d["illegal"] and d["is_mov"] and d.get("mov_dst", 0) == E.MOVD_OSR

        aux_idx = d.get("aux_index", 0) if d.get("aux_idxi", 0) else self.y_r & 3  # SPEC-3.7-4
        aux_get_data = self.rx_mem[aux_idx]  # CC-21
        aux_put = compl and not d["illegal"] and d["is_put"] and put_ok

        out_en = compl and not d["illegal"] and d["is_out"]
        osr_wr_en = m_restart or ap_ge_refill or ap_post_refill or ap_bg or pull_load or pull_fallb or get_en or mov_osr
        if m_restart:
            osr_wr_data, osr_wr_cnt = self.osr_r, 32
        elif pull_load or ap_ge_refill or ap_post_refill or ap_bg:
            osr_wr_data, osr_wr_cnt = tx_head_data, 0
        elif pull_fallb:
            osr_wr_data, osr_wr_cnt = self.x_r, 0  # SPEC-3.5-12
        elif get_en:
            osr_wr_data, osr_wr_cnt = aux_get_data, 0
        else:
            osr_wr_data, osr_wr_cnt = mov_result, 0
        tx_pop = pull_load or ap_ge_refill or ap_post_refill or ap_bg

        in_en = compl and not d["illegal"] and d["is_in"]  # CC-9

        in_ap = compl and not d["illegal"] and d["is_in"] and aph_on and autopush_req and not rx_full
        push_do = compl and not d["illegal"] and d["is_push"] and rx_queue and push_guard
        rx_push = in_ap or (push_do and not rx_full)
        rx_push_data = self.isr_r if d["is_push"] else autopush_data

        out_isr = compl and not d["illegal"] and d["is_out"] and d.get("out_dst", 0) == E.OUTD_ISR
        mov_isr = compl and not d["illegal"] and d["is_mov"] and d.get("mov_dst", 0) == E.MOVD_ISR
        isr_wr_en = m_restart or in_ap or push_do or out_isr or mov_isr
        if m_restart:
            isr_wr_data, isr_wr_cnt = 0, 0  # SPEC-7-3 clear
        elif out_isr:
            isr_wr_data, isr_wr_cnt = out_data, out_count  # SPEC-5-6
        elif mov_isr:
            isr_wr_data, isr_wr_cnt = mov_result, 0
        else:
            isr_wr_data, isr_wr_cnt = 0, 0  # PUSH/autopush clear

        tx_stall_req = (
            m_exec
            and not d["illegal"]
            and d["is_pull"]
            and pull_guard
            and pull_fence
            and d.get("pull_blk", 1)
            and tx_empty
        ) or (out_ap_ge and tx_empty)
        rx_stall_req = (m_exec and not d["illegal"] and d["is_in"] and aph_on and autopush_req and rx_full) or (
            push_do and not d.get("push_blk", 1) and rx_full
        )

        # GPIO write bundles (CC-5/CC-8; priority in the mux below)
        ss_bits = d["ss_bits"]
        ss_valid = d["ss_valid"]
        if "ss_opt_ignored" in self.mut and self.sideset_count:
            ss_valid = True  # SPEC-4-2 violation: the
            ss_bits = self.sideset_count - (1 if self.side_en else 0)
            ss_val_mut = d["ss_val"]  # data bits below the enable
        else:
            ss_val_mut = d["ss_val"]
        gpio_ss_we = first_tick and ss_valid and not d["illegal"]
        gpio_out_we = (
            compl
            and not d["illegal"]
            and (
                (d["is_out"] and d.get("out_dst", 0) in (E.OUTD_PINS, E.OUTD_PINDIRS))
                or (d["is_mov"] and d.get("mov_dst", 0) in (E.MOVD_PINS, E.MOVD_PINDIRS))
            )
        )
        gpio_out_pindir = (
            d.get("out_dst", 0) == E.OUTD_PINDIRS if d["is_out"] else d.get("mov_dst", 0) == E.MOVD_PINDIRS
        )
        gpio_out_data = out_data if d["is_out"] else mov_result
        gpio_set_we = (
            compl and not d["illegal"] and d["is_set"] and d.get("set_dst", 0) in (E.SETD_PINS, E.SETD_PINDIRS)
        )

        # IRQ clear request (SPEC-3.8-1; WAIT-1-irq completing clear
        # CC-15). The set request is computed early (flag view above).
        irq_clr_req = (
            compl
            and not d["illegal"]
            and (
                (d["is_irq"] and d.get("irq_clr", 0)) or (d["is_wait"] and wsrc == E.WSRC_IRQ and d.get("wait_pol", 1))
            )
        )

        # ---------------- pio_gpio_mux output resolution (CC-6/CC-7) --
        def place_mask(base: int, n: int) -> int:
            if n == 0 or n > 31:
                return M32  # 0 = 32 pins (SPEC-7-26)
            return _rol32(M32 >> (32 - n), base)

        os_lvl_mask = os_lvl_data = 0
        os_dir_mask = os_dir_data = 0
        if gpio_out_we:
            m = place_mask(self.out_base, self.out_count)
            data = _rol32(gpio_out_data, self.out_base)
            if gpio_out_pindir:
                os_dir_mask, os_dir_data = m, data & m
            else:
                os_lvl_mask, os_lvl_data = m, data & m
        elif gpio_set_we and self.set_count != 0:
            m = place_mask(self.set_base, self.set_count)
            data = _rol32(d.get("set_data", 0), self.set_base)
            if d.get("set_dst", 0) == E.SETD_PINDIRS:
                os_dir_mask, os_dir_data = m, data & m
            else:
                os_lvl_mask, os_lvl_data = m, data & m
        ss_lvl_mask = ss_lvl_data = 0
        ss_dir_mask = ss_dir_data = 0
        if gpio_ss_we and ss_bits != 0:
            m = place_mask(self.sideset_base, ss_bits)
            data = _rol32(ss_val_mut, self.sideset_base)
            if self.side_pindir:  # SPEC-4-4
                ss_dir_mask, ss_dir_data = m, data & m
            else:
                ss_lvl_mask, ss_lvl_data = m, data & m

        lvl_next = self.gpio_lvl_r
        oe_next = self.gpio_oe_r
        if self.out_sticky_en and not self.sticky_is_dir[0]:  # CC-5
            lvl_next = ((lvl_next & ~self.sticky_mask[0]) | self.sticky_lvl[0]) & M32
        if self.out_sticky_en and self.sticky_is_dir[0]:
            oe_next = ((oe_next & ~self.sticky_mask[0]) | self.sticky_dir[0]) & M32
        lvl_next = ((lvl_next & ~os_lvl_mask) | os_lvl_data) & M32
        oe_next = ((oe_next & ~os_dir_mask) | os_dir_data) & M32
        lvl_next = ((lvl_next & ~ss_lvl_mask) | ss_lvl_data) & M32  # CC-6
        oe_next = ((oe_next & ~ss_dir_mask) | ss_dir_data) & M32

        sticky_wr = gpio_out_we or (gpio_set_we and self.set_count != 0)
        sticky_isdir_next = gpio_out_pindir if gpio_out_we else d.get("set_dst", 0) == E.SETD_PINDIRS
        sticky_mask_next = (os_lvl_mask | os_dir_mask) if sticky_wr else self.sticky_mask[0]
        sticky_lvl_next = os_lvl_data if (sticky_wr and not sticky_isdir_next) else self.sticky_lvl[0]
        sticky_dir_next = os_dir_data if (sticky_wr and sticky_isdir_next) else self.sticky_dir[0]

        # ---------------- pio_irq_flags combinational (CC-37/39) ------
        loc_set = loc_set_early
        loc_clr = loc_clr_early
        if irq_idx_mode in (0, 2):  # SPEC-3.8-4/6 (REL: SM0 +0)
            if irq_clr_req:
                loc_clr |= 1 << irq_flag_idx
        # IdxMode 1/3 (PREV/NEXT) route out to the neighbour blocks via
        # pio_top's relay — out of single-block scope; no local effect.
        flags_next = (self.flags_r | loc_set) & ~loc_clr & 0xFF  # CC-39

        # ---------------- pio_sm_fifo accepted-op decoding ------------
        # fifo_mode here is the pre-edge mode (config banks update in
        # the edge section below) — mode_r samples it at the edge, so a
        # SHIFTCTRL FJOIN write flushes on the FOLLOWING clk and drops
        # any queue op coincident with the flush edge (SPEC-6-2).
        fm_pre = self.fifo_mode  # pre-edge mode sample
        flush = fm_pre != self.mode_r  # SPEC-6-2
        tick_any = sm_tick or force_tick  # pio_sm tick fanout
        rx_queue_wr = tick_any and rx_push and rx_depth != 0 and self.rx_level < rx_depth
        rx_queue_rd = sys_rx_rd and rx_depth != 0 and self.rx_level != 0
        tx_wr = sys_tx_wr and tx_depth != 0 and self.tx_level < tx_depth
        tx_rd = tick_any and tx_pop and tx_depth != 0 and self.tx_level != 0
        aux_put_en = tick_any and aux_put and self.fifo_mode in (FM_TXPUT, FM_PUTGET)
        sys_aux_wr_en = sys_aux_wr and self.fifo_mode == FM_TXGET
        tx_over_set = sys_tx_wr and not tx_wr  # SPEC-6-5
        rx_under_set = sys_rx_rd and not rx_queue_rd

        # ---------------- read mux + compositions (SPEC-16-2) ---------
        # SM1..3 static nibbles: empty FIFOs, reset config, pc 0. Their
        # FSTAT bits come from the 0x0f00_0f00 reset pattern; SM0's four
        # bits are overlaid from live state (SPEC-7-29).
        sm0_mask = (1 << 24) | (1 << 16) | (1 << 8) | 1
        fstat = (
            (0x0F00_0F00 & ~sm0_mask)
            | ((1 if tx_empty else 0) << 24)
            | ((1 if tx_full else 0) << 16)
            | ((1 if rx_empty else 0) << 8)
            | ((1 if rx_full else 0) << 0)
        )
        fdebug = (self.fdbg_tx_stall << 24) | (self.fdbg_tx_over << 16) | (self.fdbg_rx_under << 8) | self.fdbg_rx_stall
        flevel = (self.tx_level & 0xF) | ((self.rx_level & 0xF) << 4)
        intr = (
            (flags_now << 8)
            | 0xE0  # SM3..1 TXNFULL = 1
            | ((0 if tx_full else 1) << 4)
            | (0 if rx_empty else 1)
        ) & 0xFFFF
        execctrl_rb = (self.execctrl_r & 0x7FFFFFFF) | (0x80000000 if self.forced_stall_r else 0)  # SPEC-7-15

        if widx == 0:
            rdata = self.ctrl_r & 0xF
        elif widx == 1:
            rdata = fstat
        elif widx == 2:
            rdata = fdebug
        elif widx == 3:
            rdata = flevel
        elif widx == 8:
            rdata = self.rx_mem[self.rx_head]  # RXF0 (SPEC-7-28)
        elif widx == 12:
            rdata = flags_now  # SPEC-7-6
        elif widx == 14:
            rdata = self.isb_r
        elif widx == 15:
            rdata = self.gpio_lvl_r  # DBG_PADOUT (SPEC-7-8)
        elif widx == 16:
            rdata = self.gpio_oe_r
        elif widx == 17:
            rdata = 0x10200404  # DBG_CFGINFO (SPEC-7-9)
        elif sm_hit:
            rdata = (
                self.clkdiv_r
                if sm_reg == 0
                else execctrl_rb
                if sm_reg == 1
                else self.shiftctrl_r
                if sm_reg == 2
                else self.pc_r
                if sm_reg == 3  # SPEC-7-22
                else instr_mem_w
                if sm_reg == 4  # SPEC-7-24
                else self.pinctrl_r
            )
        elif aux_hit:
            rdata = self.rx_mem[bus_aux_idx]  # SPEC-7-13
        else:
            rdata = 0

        # ---------------- per-clk observables (SPEC-16-1/2) -----------
        obs = Observables(
            gpio_out=self.gpio_lvl_r,
            gpio_oe=self.gpio_oe_r,
            intr=intr,
            rdata=rdata if reg_read else None,
            read=reg_read,
            addr=addr,
        )

        # ==============================================================
        # Edge update — every always_ff below its RTL priority order.
        # ==============================================================
        if reg_write and imem_hit:
            self.imem[imem_addr] = wdata & M16  # CC-33
        if reg_write and widx == 0:
            self.ctrl_r = wdata & 0xF
        if reg_write and widx == 14:
            self.isb_r = wdata

        if clkdiv_we:
            self.clkdiv_r = wdata
        if execctrl_we:
            self.execctrl_r = wdata
        if shiftctrl_we:
            self.shiftctrl_r = wdata
        if pinctrl_we:
            self.pinctrl_r = wdata

        self.flags_r = flags_next  # CC-37/CC-39

        self.sync2_r = self.sync1_r  # CC-23
        self.sync1_r = gpio_in & M32

        self.gpio_lvl_r = lvl_next
        self.gpio_oe_r = oe_next
        if sticky_wr:
            self.sticky_mask[0] = sticky_mask_next
            self.sticky_is_dir[0] = 1 if sticky_isdir_next else 0
            if sticky_isdir_next:
                self.sticky_dir[0] = sticky_dir_next
            else:
                self.sticky_lvl[0] = sticky_lvl_next

        # Divider (pio_sm_regs always_ff, CC-26/CC-27/CC-36)
        if clkdiv_restart:
            self.phase_r = 0
            self.stretch_r = 0
            self.count_r = 0
            self.pending_r = 0
        elif sm_en:
            if terminal:
                self.count_r = 0
                self.pending_r = 1
                self.phase_r = phase_next
                self.stretch_r = phase_carry
            else:
                self.count_r += 1
                if not (force_tick and self.pending_r):
                    self.pending_r = 0

        # --- pio_sm_exec register groups ---
        # G1: FSM state
        if m_restart:
            if sm_restart and self.state_r == ST_DELAY:
                self.state_r = ST_FETCH
        elif tick_forced:
            if compl:
                if just_latched:
                    self.state_r = ST_EXEC  # CC-34
                elif pc_wr_explicit:
                    self.state_r = ST_FETCH  # CC-35
                elif self.state_r == ST_EXEC:
                    self.state_r = ST_FETCH
                elif sm_restart and self.state_r == ST_DELAY:
                    self.state_r = ST_FETCH
            elif sm_restart and self.state_r in (ST_DELAY, ST_EXEC):
                self.state_r = ST_FETCH
        elif m_exec:
            if not compl:
                self.state_r = ST_STALL
            elif just_latched:
                self.state_r = ST_EXEC
            elif d["delay"] != 0:
                self.state_r = ST_DELAY  # CC-10
            else:
                self.state_r = ST_FETCH
        elif sm_restart:
            if self.state_r == ST_DELAY or (self.state_r == ST_EXEC and self.latch_force_r):
                self.state_r = ST_FETCH
        elif m_delay and not sm_restart:
            if self.delay_cnt_r == 1:
                self.state_r = ST_FETCH

        # G2: PC + X + Y (SM_RESTART preserves all three, SPEC-7-3)
        if compl:
            self.pc_r = pc_next & 0x1F
            if x_wr:
                self.x_r = x_val & M32
            if y_wr:
                self.y_r = y_val & M32

        # G3: delay counter (CC-10/CC-14)
        mut_dly = "delay_in_stall" in self.mut and self._mut_stall_seen
        if delay_load and not mut_dly:
            self.delay_cnt_r = d["delay"]
        elif sm_restart:
            self.delay_cnt_r = 0
        elif tick_forced and compl and (just_latched or pc_wr_explicit):
            self.delay_cnt_r = 0  # preempted delay
        elif m_delay:
            self.delay_cnt_r = (self.delay_cnt_r - 1) & 0x1F
        elif "delay_in_stall" in self.mut and m_exec and stall:
            # CC-14 violation: the delay field starts counting at the
            # instruction's first (stalled) tick and elapses while the
            # stall holds — the post-stall delay shrinks by the stall
            # length instead of freezing (the completion reload is
            # suppressed above via _mut_stall_seen).
            if first_tick:
                self.delay_cnt_r = d["delay"]
            else:
                self.delay_cnt_r = (self.delay_cnt_r - 1) & 0x1F
        if m_exec and stall:
            self._mut_stall_seen = True
        if compl:
            self._mut_stall_seen = False

        # G4: EXEC / forced-instruction latch (SPEC-7-23, CC-34/35)
        if force_we:
            self.latch_r = wdata & M16
            self.latch_vld_r = 1
            self.latch_force_r = 1
            self.force_pend_r = 1
            self.forced_stall_r = 0
        elif sm_restart:
            self.force_pend_r = 0
            self.forced_stall_r = 0
            if compl and just_latched:
                self.latch_r = exec_word
                self.latch_vld_r = 1
                self.latch_force_r = 0
            elif self.latch_force_r:
                self.latch_vld_r = 0
                self.latch_force_r = 0
        elif tick_forced:
            if compl:
                self.force_pend_r = 0
                self.forced_stall_r = 0
                self.latch_vld_r = 1 if just_latched else 0
                self.latch_force_r = 0
                if just_latched:
                    self.latch_r = exec_word
            else:
                self.forced_stall_r = 1  # EXEC_STALLED (SPEC-7-15)
        elif compl and just_latched:
            self.latch_r = exec_word
            self.latch_vld_r = 1
            self.latch_force_r = 0
        elif m_exec and src_latch and compl:
            self.latch_vld_r = 0

        # G5: irq-wait two-phase + restart pending (CC-16, SPEC-7-3)
        if sm_restart:
            self.irqw_wait_r = 0
            self.restart_pend_r = 1
        else:
            if m_restart:
                self.restart_pend_r = 0
            if m_exec and not d["illegal"] and d["is_irq"] and d.get("irq_wait", 0) and not d.get("irq_clr", 0):
                self.irqw_wait_r = 0 if compl else 1
            elif tick_forced and compl and pc_wr_explicit:
                self.irqw_wait_r = 0

        # --- pio_sm_shift register groups (tick_any-qualified) ---
        if tick_any:
            if osr_wr_en:
                self.osr_r = osr_wr_data & M32
                self.osr_cnt_r = osr_wr_cnt & 0x3F
            elif out_en:
                self.osr_r = osr_shifted
                self.osr_cnt_r = osr_cnt_sat
            if isr_wr_en:
                self.isr_r = isr_wr_data & M32
                self.isr_cnt_r = isr_wr_cnt & 0x3F
            elif in_en:
                self.isr_r = isr_next_in & M32
                self.isr_cnt_r = isr_cnt_sat

        # --- pio_sm_fifo register groups ---
        if flush:
            self.tx_head = self.tx_tail = 0
            self.tx_level = 0
            self.rx_head = self.rx_tail = 0
            self.rx_level = 0
        else:
            if tx_wr:
                self.tx_mem[self.tx_tail] = wdata
                self.tx_tail = (self.tx_tail + 1) & 7
            if tx_rd:
                self.tx_head = (self.tx_head + 1) & 7
            self.tx_level += (1 if tx_wr else 0) - (1 if tx_rd else 0)
            if rx_queue_wr:
                self.rx_mem[self.rx_tail] = rx_push_data & M32
                self.rx_tail = (self.rx_tail + 1) & 7
            elif aux_put_en:
                self.rx_mem[aux_idx & 3] = self.isr_r & M32
            elif sys_aux_wr_en:
                self.rx_mem[bus_aux_idx] = wdata & M32
            if rx_queue_rd:
                self.rx_head = (self.rx_head + 1) & 7
            self.rx_level += (1 if rx_queue_wr else 0) - (1 if rx_queue_rd else 0)
        # pio_sm_fifo mode sampler: the registered pre-edge mode (a
        # config write changes fifo_mode from the NEXT clk, so the flush
        # edge fires exactly once, the cycle after the FJOIN change).
        self.mode_r = fm_pre

        # FDEBUG stickies (SPEC-6-7): W1C beats set
        if fdbg_clr["tx_stall"]:
            self.fdbg_tx_stall = 0
        elif tx_stall_req and tick_any:
            self.fdbg_tx_stall = 1
        if fdbg_clr["rx_stall"]:
            self.fdbg_rx_stall = 0
        elif rx_stall_req and tick_any:
            self.fdbg_rx_stall = 1
        if fdbg_clr["tx_over"]:
            self.fdbg_tx_over = 0
        elif tx_over_set:
            self.fdbg_tx_over = 1
        if fdbg_clr["rx_under"]:
            self.fdbg_rx_under = 0
        elif rx_under_set:
            self.fdbg_rx_under = 1

        return obs

"""model.py: clk-level behaviour of the golden model, RTL-free.

These are model-vs-itself checks (no iverilog): reset observables,
instruction/delay/divider cadence (the CC timing the model transcribes),
and mutation divergence — every mutation must change the observable
trace on a program that drives the mutated path (the pure-Python half
of the C12 red/green demo; the RTL half is difftest --mutation-demo).
"""

import itertools

import pytest
from pio_model import difftest, stim
from pio_model import encoding as E
from pio_model import model as M


def trace(sched, mutations=()):
    return difftest.run_model_trace(sched, mutations)


def gpio_transitions(recs, bit):
    """Clks at which gpio_out[bit] toggles (after the initial rise set)."""
    out = []
    prev = None
    for rec in recs:
        if rec[0] != "G":
            continue
        lvl = (rec[2] >> bit) & 1
        if prev is not None and lvl != prev:
            out.append(rec[1])
        prev = lvl
    return out


def spacings(recs, bit):
    """Steady-state toggle spacings (first spacing dropped: warmup)."""
    t = gpio_transitions(recs, bit)
    return [b - a for a, b in itertools.pairwise(t)]


def read_at(recs, addr):
    return [r[3] for r in recs if r[0] == "R" and r[2] == addr]


class TestResetObservables:
    def test_clk0_is_reset_state(self):
        s = stim.Schedule()
        s.enable()
        s.r(stim.A_FSTAT)
        s.r(stim.A_FLEVEL)
        s.r(stim.A_IRQ)
        recs = trace(s)
        # clk 0 G line: zeros + SM3..1 TXNFULL (0xE0), TX-not-full (0x10),
        # RX-not-empty (0 — the FIFO is empty)
        assert recs[0] == ("G", 0, 0, 0, 0x00F0)
        assert read_at(recs, stim.A_FSTAT) == [0x0F000F00]  # all FIFOs empty
        assert read_at(recs, stim.A_FLEVEL) == [0]
        assert read_at(recs, stim.A_IRQ) == [0]

    def test_flevel_counts_feeds(self):
        s = stim.Schedule()
        s.feed(1)
        s.feed(2)
        s.r(stim.A_FLEVEL)
        assert read_at(trace(s), stim.A_FLEVEL) == [2]  # tx=2, rx=0


class TestCadence:
    def _square(self, delay, clkdiv_v=None):
        words = [E.encode_set("pins", 1, delay), E.encode_set("pins", 0, delay)]
        s = stim.Schedule()
        s.load_imem(words)
        s.w(stim.A_SM0 + 4 * 5, stim.pctrl(set_cnt=1))
        s.w(stim.A_SM0 + 4 * 1, stim.execctrl(1, 0))
        if clkdiv_v is not None:
            s.w(stim.A_SM0 + 4 * 0, clkdiv_v)
        s.enable()
        s.run_to(80)
        return s

    def test_set_delay_cadence(self):
        # set pins + delay d: one exec clk + d delay clks per instruction
        # (CC-10), so a 2-instruction square wave toggles every d+1 clks
        assert set(spacings(trace(self._square(1)), 0)) == {2}
        assert set(spacings(trace(self._square(3)), 0)) == {4}

    def test_fractional_divider_cadence_cc26(self):
        # INT=2 FRAC=128: terminal every 2 clks, +1 stretch every other
        # terminal (phase wraps 256) -> toggle spacings alternate 2/3
        assert set(spacings(trace(self._square(0, stim.clkdiv(2, 128))), 0)) == {2, 3}

    def test_pull_out_datapath(self):
        words = [E.encode_pull(False, True, 0), E.encode_out("pins", 4, 0), E.encode_jmp(None, 0, 0)]
        s = stim.Schedule()
        s.load_imem(words)
        s.w(stim.A_SM0 + 4 * 5, stim.pctrl(out_cnt=4))
        s.w(stim.A_SM0 + 4 * 1, stim.execctrl(2, 0))
        s.enable()
        s.feed(0xBEEF)
        s.run_to(60)
        recs = trace(s)
        outs = {r[2] for r in recs if r[0] == "G"}
        assert 0xF in outs  # first OUT shift, right-first: 0xBEEF low nibble


class TestMutationsDiverge:
    """Each mutation must perturb the trace on a program that drives the
    mutated path (model red/green without the RTL):"""

    def _jmp_postdec_prog(self):
        # x=0: correct JMP x-- tests pre-dec (not taken, SPEC-14.5-1) ->
        # slow square; the mutated post-dec test sees 0-1 != 0 -> taken
        # -> fast square.
        words = [
            E.encode_set("x", 0, 0),
            E.encode_jmp("x--", 6, 0),
            E.encode_set("pins", 1, 3),
            E.encode_set("pins", 0, 3),
            E.encode_jmp(None, 2, 0),
            E.encode_mov("y", "y", 0, 0),
            E.encode_set("pins", 1, 0),
            E.encode_set("pins", 0, 0),
            E.encode_jmp(None, 6, 0),
        ]
        s = stim.Schedule()
        s.load_imem(words)
        s.w(stim.A_SM0 + 4 * 5, stim.pctrl(set_cnt=1))
        s.w(stim.A_SM0 + 4 * 1, stim.execctrl(8, 0))
        s.enable()
        s.run_to(120)
        return s

    def test_jmp_postdec(self):
        clean = trace(self._jmp_postdec_prog())
        # slow loop: 4 clks high (1+3), 5 low (4 + the jmp clk)
        assert set(spacings(clean, 0)) == {4, 5}
        mut = trace(self._jmp_postdec_prog(), ("jmp_postdec",))
        assert set(spacings(mut, 0)) == {1, 2}  # jmp-less tight square
        assert mut != clean

    def test_wrap_off(self):
        words = [E.encode_set("pins", 1, 3), E.encode_set("pins", 0, 3)]
        s = stim.Schedule()
        s.load_imem(words)
        s.w(stim.A_SM0 + 4 * 5, stim.pctrl(set_cnt=1))
        s.w(stim.A_SM0 + 4 * 1, stim.execctrl(1, 0))
        s.enable()
        s.run_to(80)
        clean = trace(s)
        assert set(spacings(clean, 0)) == {4}  # symmetric 2-instr wrap loop
        # wrap_off runs off the end into imem zeros (jmp 0): one dead clk
        assert set(spacings(trace(s, ("wrap_off",)), 0)) == {4, 5}

    def _ss_opt_prog(self):
        # set pins (side 1) once -> pin1 high; the jmp loop carries no
        # side, so SPEC-4-2 says pin1 holds. The mutation fires side 0
        # on the jmp and drives pin1 low.
        words = [E.encode_set("pins", 1, E.pack_ds(0, 1, True, 2, True)), E.encode_jmp(None, 1, 0)]
        s = stim.Schedule()
        s.load_imem(words)
        s.w(stim.A_SM0 + 4 * 5, stim.pctrl(ss_cnt=2, set_cnt=1, ss_base=1))
        s.w(stim.A_SM0 + 4 * 1, stim.execctrl(1, 0, side_en=True))
        s.enable()
        s.run_to(60)
        return s

    def test_ss_opt_ignored(self):
        clean = trace(self._ss_opt_prog())
        # after instr0's side 1, pin1 holds for the rest of the run
        hi = [i for i, r in enumerate(clean) if r[0] == "G" and (r[2] >> 1) & 1]
        assert hi
        assert hi[-1] == len([r for r in clean if r[0] == "G"]) - 1
        mut = trace(self._ss_opt_prog(), ("ss_opt_ignored",))
        assert any(not ((r[2] >> 1) & 1) for r in mut if r[0] == "G")

    def _sync_wait_prog(self):
        words = [E.encode_wait(1, E.WSRC_PIN, 0, 0), E.encode_set("pins", 1, 0), E.encode_jmp(None, 1, 0)]
        s = stim.Schedule()
        s.load_imem(words)
        s.w(stim.A_SM0 + 4 * 5, stim.pctrl(set_cnt=1))
        s.w(stim.A_SM0 + 4 * 1, stim.execctrl(2, 0))
        s.enable()
        s.run_to(20)
        s.set_gpio(1)
        s.run_to(60)
        return s

    def test_sync_1ff(self):
        # CC-23: the input path is 2-FF synced; the mutation reads sync1
        # (1 clk earlier), so completion (pin0 rising) lands one clk sooner
        def rise_clk(recs):
            return next(r[1] for r in recs if r[0] == "G" and r[2] & 1)

        clean = trace(self._sync_wait_prog())
        mut = trace(self._sync_wait_prog(), ("sync_1ff",))
        assert rise_clk(clean) == rise_clk(mut) + 1

    def _cc11_prog(self):
        # back-to-back OUTs with autopull@1 on an empty TX: the first OUT
        # takes the CC-11 stall-with-refill path on its first tick.
        words = [E.encode_out("pins", 1, 0), E.encode_out("pins", 1, 0), E.encode_jmp(None, 0, 0)]
        s = stim.Schedule()
        s.load_imem(words)
        s.w(stim.A_SM0 + 4 * 1, stim.execctrl(2, 0))
        s.w(stim.A_SM0 + 4 * 2, stim.shiftctrl(pull_thr=1, autopull=True))
        s.w(stim.A_SM0 + 4 * 5, stim.pctrl(out_cnt=1))
        for _ in range(4):
            s.feed(0xAAAAAAAA)
        s.enable()
        s.run_to(60)
        s.r(stim.A_FSTAT)
        s.run_to(80)
        return s

    def test_cc11_no_stall(self):
        assert trace(self._cc11_prog(), ("cc11_no_stall",)) != trace(self._cc11_prog())

    def _delay_in_stall_prog(self):
        # autopull@2, one word fed: OUT#1 consumes a bit and refills,
        # OUT#2 drains to threshold, OUT#3 stalls on the empty TX — with
        # delay 2 pending. The mid-run second feed releases the stall;
        # the mutation has spent the delay during the stall, so every
        # later pin edge shifts vs the clean model (CC-14 violation).
        words = [E.encode_out("pins", 1, 2)]
        s = stim.Schedule()
        s.load_imem(words)
        s.w(stim.A_SM0 + 4 * 1, stim.execctrl(0, 0))
        s.w(stim.A_SM0 + 4 * 2, stim.shiftctrl(pull_thr=2, autopull=True))
        s.w(stim.A_SM0 + 4 * 5, stim.pctrl(out_cnt=1))
        s.feed(0xAAAAAAAA)
        s.enable()
        s.run_to(60)
        s.feed(0xAAAAAAAA)  # release the CC-11 stall mid-run
        s.run_to(140)
        return s

    def test_delay_in_stall(self):
        assert trace(self._delay_in_stall_prog(), ("delay_in_stall",)) != trace(self._delay_in_stall_prog())

    def _irq37_prog(self):
        words = [E.encode_wait(1, E.WSRC_IRQ, 0, 0), E.encode_set("pins", 1, 0), E.encode_jmp(None, 1, 0)]
        s = stim.Schedule()
        s.load_imem(words)
        s.w(stim.A_SM0 + 4 * 1, stim.execctrl(2, 0))
        s.w(stim.A_SM0 + 4 * 5, stim.pctrl(set_cnt=1))
        s.enable()
        s.run_to(40)
        s.w(stim.A_IRQ_FORCE, 1)  # flag set lands end-of-clk (CC-37)
        s.run_to(80)
        s.r(stim.A_IRQ)
        s.run_to(96)
        return s

    def test_irq_same_cycle(self):
        assert trace(self._irq37_prog(), ("irq_same_cycle",)) != trace(self._irq37_prog())

    def _multi_pri_prog(self):
        # SM0 writes 0 / SM3 writes 1 to pin 0 every clk (CC-7)
        mov0 = E.encode_mov("pins", "null", E.MOP_NONE)
        mov1 = E.encode_mov("pins", "null", E.MOP_INV)
        s = stim.Schedule()
        s.load_imem([mov0, mov0])
        s.load_imem([mov1, mov1], base=16)
        s.w(stim.A_SM0 + 4 * 5, stim.pctrl(out_cnt=1))
        s.w(stim.A_SM0 + 4 * 1, stim.execctrl(1, 0))
        s.w(stim.sm_addr(3, 5), stim.pctrl(out_cnt=1))
        s.w(stim.sm_addr(3, 1), stim.execctrl(17, 16))
        s.set_pc(16, sm=3)
        s.enable(0b1001)
        s.run_to(60)
        return s

    def test_gpio_pri_low(self):
        clean = trace(self._multi_pri_prog())
        hi = [r for r in clean if r[0] == "G" and r[2] & 1]
        assert len(hi) > 40  # SM3 wins the every-clk collision
        mut = trace(self._multi_pri_prog(), ("gpio_pri_low",))
        assert not any(r[0] == "G" and r[2] & 1 for r in mut[10:])  # SM0 wins instead

    def _multi_irq_prog(self):
        words = [
            E.encode_wait(1, E.WSRC_IRQ, 1, 0),
            E.encode_set("pins", 1, 0),
            E.encode_jmp(None, 1, 0),
            0,
            0,
            0,
            0,
            0,
            E.encode_irq(False, False, 2, 0, 0),  # irq nowait 0 rel
            E.encode_jmp(None, 9, 0),
        ]
        s = stim.Schedule()
        s.load_imem(words)
        s.w(stim.A_SM0 + 4 * 5, stim.pctrl(set_cnt=1))
        s.w(stim.A_SM0 + 4 * 1, stim.execctrl(2, 0))
        s.set_pc(8, sm=1)
        s.enable(0b11)
        s.run_to(60)
        return s

    def test_irq_rel_off(self):
        clean = trace(self._multi_irq_prog())
        assert any(r[0] == "G" and r[2] & 1 for r in clean)  # SM1's rel set releases SM0
        mut = trace(self._multi_irq_prog(), ("irq_rel_off",))
        assert not any(r[0] == "G" and r[2] & 1 for r in mut)  # flag 0 set: wait never releases

    def test_unknown_mutation_rejected(self):
        with pytest.raises(ValueError, match="unknown mutations"):
            M.PIOBlockModel(mutations=("bogus",))


class TestMultiSM:
    """All four SMs live (the multi-SM model scope): SM1..3 window
    accesses, TXF1..3 feeds, per-SM compositions, inter-SM IRQ REL
    (SPEC-3.8-6) and cross-SM pin priority (CC-7)."""

    SM1 = stim.A_SM0 + 0x18  # SMx window stride 0x18 (SPEC-7-x)
    SM3 = stim.A_SM0 + 0x18 * 3

    def test_sm1_config_readback(self):
        s = stim.Schedule()
        s.w(self.SM1 + 4 * 0, stim.clkdiv(3, 7))  # SM1 CLKDIV
        s.r(self.SM1 + 4 * 0)
        s.r(self.SM3 + 4 * 5)  # SM3 PINCTRL: reset value (SPEC-7-26)
        assert read_at(trace(s), self.SM1 + 4 * 0) == [stim.clkdiv(3, 7)]
        assert read_at(trace(s), self.SM3 + 4 * 5) == [stim.pctrl(set_cnt=5)]

    def test_txf1_flevel_nibble(self):
        s = stim.Schedule()
        s.w(stim.A_TXF0 + 4, 0xAA)  # TXF1
        s.w(stim.A_TXF0 + 4, 0xBB)
        s.r(stim.A_FLEVEL)
        s.r(stim.A_FSTAT)
        recs = trace(s)
        assert read_at(recs, stim.A_FLEVEL) == [2 << 8]  # SM1 TX nibble at 8*1
        # SM1 holds 2 of 4 words: not empty, not full -> TXEMPTY1 (bit 25) clears
        assert read_at(recs, stim.A_FSTAT) == [0x0D00_0F00]

    def test_all_four_squares(self):
        # one shared imem squarewave, four SMs at per-SM SET_BASE pins
        words = [E.encode_set("pins", 1, 2), E.encode_set("pins", 0, 2)]
        s = stim.Schedule()
        s.load_imem(words)
        for i in range(4):
            s.w(stim.A_SM0 + 0x18 * i + 4 * 1, stim.execctrl(1, 0))
            s.w(stim.A_SM0 + 0x18 * i + 4 * 5, stim.pctrl(set_cnt=1, set_base=i))
        s.enable(0xF)
        s.run_to(80)
        recs = trace(s)
        for pin in range(4):
            assert set(spacings(recs, pin)) == {3}  # 1 exec + 2 delay clks

    def test_irq_rel_from_sm1(self):
        # SM1 `irq nowait 0 rel` sets flag 1 (REL adds the SM id mod 4,
        # SPEC-3.8-6); SM0 waits on flag 1, then drives its pin. The
        # completing WAIT-1 clears the flag again (CC-15), so the final
        # IRQ read shows 0 — the pin rise is the REL discriminator (a
        # broken REL sets flag 0 and the wait never releases).
        words = [
            E.encode_wait(1, E.WSRC_IRQ, 1, 0),  # SM0 @0
            E.encode_set("pins", 1, 0),
            E.encode_jmp(None, 1, 0),
            0,
            0,
            0,
            0,
            0,
            E.encode_irq(False, False, 2, 0, 0),  # SM1 @8: irq nowait 0 rel
            E.encode_jmp(None, 9, 0),  # park after the one set
        ]
        s = stim.Schedule()
        s.load_imem(words)
        s.w(stim.A_SM0 + 4 * 5, stim.pctrl(set_cnt=1))
        s.w(self.SM1 + 4 * 4, 8)  # SM1_INSTR force: jmp 8 (set_pc idiom)
        s.enable(0b11)
        s.run_to(40)
        s.r(stim.A_IRQ)
        s.run_to(60)
        recs = trace(s)
        assert read_at(recs, stim.A_IRQ) == [0x00]  # cleared by the WAIT-1 (CC-15)
        assert any(r[0] == "G" and r[2] & 1 for r in recs)  # SM0 released

    def test_gpio_priority_cc7(self):
        # SM0 writes 0 and SM3 writes 1 to pin 0 on every clk: the
        # highest-numbered SM wins (CC-7), so pin 0 reads 1 throughout
        # the steady state.
        mov0 = E.encode_mov("pins", "null", E.MOP_NONE)
        mov1 = E.encode_mov("pins", "null", E.MOP_INV)  # ~0 -> bit0 = 1
        s = stim.Schedule()
        s.load_imem([mov0, mov0])
        s.load_imem([mov1, mov1], base=16)
        s.w(stim.A_SM0 + 4 * 1, stim.execctrl(1, 0))
        s.w(stim.A_SM0 + 4 * 5, stim.pctrl(out_cnt=1))
        s.w(self.SM3 + 4 * 1, stim.execctrl(17, 16))
        s.w(self.SM3 + 4 * 5, stim.pctrl(out_cnt=1))
        s.w(self.SM3 + 4 * 4, 16)  # SM3_INSTR force: jmp 16
        s.enable(0b1001)
        s.run_to(60)
        g = [r for r in trace(s) if r[0] == "G"]
        steady = [r[2] & 1 for r in g[-20:]]
        assert steady
        assert all(steady)

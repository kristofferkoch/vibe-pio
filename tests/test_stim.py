"""stim.py: Schedule timeline + pio-stim v1 image + config builders."""

from pio_model import stim


class TestSchedule:
    def test_ops_append_cycles(self):
        s = stim.Schedule()
        s.w(0x010, 0xAA)
        s.r(0x004)
        s.idle(2)
        assert len(s.cycles) == 4
        w = s.cycles[0]
        assert w == [0, 0, stim.OP_WR, 0x010, 0xAA, 0, 0, 0, 0]
        r = s.cycles[1]
        assert r == [0, 0, stim.OP_RD, 0x004, 0, 0, 0, 0, 0]
        assert s.cycles[2] == [0, 0, stim.OP_NONE, 0, 0, 0, 0, 0, 0]

    def test_run_to_never_shrinks(self):
        s = stim.Schedule()
        s.run_to(3)
        s.run_to(1)
        assert len(s.cycles) == 3

    def test_gpio_and_sticky_fields_persist(self):
        s = stim.Schedule()
        s.set_gpio(0x1234)
        s.set_lb(0xF)
        s.idle(1)
        assert s.cycles[0][0] == 0x1234
        assert s.cycles[0][1] == 0xF

    def test_to_mem_packing(self):
        s = stim.Schedule()
        s.set_gpio(1)
        s.w(0x1FF, 0xDEADBEEF)
        s.idle(1)
        lines = s.to_mem().splitlines()
        assert lines[0] == f"{2:08x}"  # header: cycle count (set_gpio appends none)
        assert lines[1] == f"{1:08x}"  # gpio_in
        assert lines[2] == "00000000"  # lb_mask
        assert lines[3] == f"{(stim.OP_WR << 9) | 0x1FF:08x}"
        assert lines[4] == "deadbeef"
        assert lines[5] == "00000000"
        assert lines[6] == "00000000"
        assert len(lines) == 1 + 2 * 6

    def test_nb_and_irq_packing(self):
        s = stim.Schedule()
        s.nb_set = 0x05
        s.nb_clr = 0x02
        s.irq_prev = 0x11
        s.irq_next = 0x22
        s.idle(1)
        lines = s.to_mem().splitlines()
        assert lines[5] == f"{(0x05 << 8) | 0x02:08x}"
        assert lines[6] == f"{(0x11 << 8) | 0x22:08x}"

    def test_load_imem_and_helpers(self):
        s = stim.Schedule()
        s.load_imem([0xE001, 0xA042])
        assert s.cycles[0][3] == stim.A_IMEM0
        assert s.cycles[1][3] == stim.A_IMEM0 + 4
        s.enable()
        assert s.cycles[2][3] == stim.A_CTRL
        assert s.cycles[2][4] == 1
        s.set_pc(9)
        assert s.cycles[3][3] == stim.A_SM0 + 16
        assert s.cycles[3][4] == 9
        s.feed(0x55)
        assert s.cycles[4][3] == stim.A_TXF0
        assert s.cycles[4][4] == 0x55


class TestConfigBuilders:
    def test_pctrl_fields(self):
        assert stim.pctrl() == 0
        assert (
            stim.pctrl(ss_cnt=5, set_cnt=3, out_cnt=2, in_base=17, ss_base=9, set_base=6, out_base=1)
            == (5 << 29) | (3 << 26) | (2 << 20) | (17 << 15) | (9 << 10) | (6 << 5) | 1
        )

    def test_execctrl_fields(self):
        assert stim.execctrl(31, 7) == (31 << 12) | (7 << 7)
        assert (
            stim.execctrl(0, 0, jmp_pin=5, side_en=True, out_sticky=True, status_sel=2, status_n=9)
            == (5 << 24) | (1 << 30) | (1 << 17) | (2 << 5) | 9
        )

    def test_shiftctrl_fields(self):
        v = stim.shiftctrl(
            fjoin_rx=True, pull_thr=8, push_thr=24, out_right=False, in_right=True, autopull=True, fjoin_rx_put=True
        )
        assert v == (1 << 31) | (8 << 25) | (24 << 20) | (1 << 18) | (1 << 17) | (1 << 15)
        assert stim.shiftctrl() == (1 << 19) | (1 << 18)  # right/right default

    def test_clkdiv_packing(self):
        assert stim.clkdiv() == 1 << 16  # INT=1 FRAC=0 (SPEC-7-14 reset)
        assert stim.clkdiv(135, 162) == (135 << 16) | (162 << 8)

    def test_uart_frame(self):
        # 8n1 idle-high: start 0, 8 LSB-first data bits, stop/idle 1s
        assert stim._uart_frame(0x55) == [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1]
        assert len(stim._uart_frame(0x00)) == 11

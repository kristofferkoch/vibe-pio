"""disasm.py: word -> canonical text, reserved-encoding rejection."""

import pytest
from pio_model import asm, disasm
from pio_model import encoding as E


class TestCanonicalText:
    def test_known_words(self):
        assert disasm.disassemble(0x0000) == "jmp 0"
        assert disasm.disassemble(0xA042) == "nop"
        assert disasm.disassemble(0xE001) == "set pins, 1"
        assert disasm.disassemble(0x6001) == "out pins, 1"

    def test_postfix_order_side_then_delay(self):
        w = E.encode_set("pins", 1, 0) | E.pack_ds(3, 0, False, 0, False) << 8
        assert disasm.disassemble(w) == "set pins, 1 [3]"

    def test_bitcount_32_rendering(self):  # SPEC-2-18
        assert disasm.disassemble(E.encode_in("x", 0, 0)) == "in x, 32"
        assert disasm.disassemble(E.encode_out("null", 0, 0)) == "out null, 32"

    def test_push_pull_modifiers(self):
        assert disasm.disassemble(E.encode_push(True, True, 0)) == "push iffull block"
        assert disasm.disassemble(E.encode_pull(False, False, 0)) == "pull noblock"

    def test_fifo_aux_forms(self):
        assert disasm.disassemble(E.encode_put(2, 0)) == "mov rxfifo[2], isr"
        assert disasm.disassemble(E.encode_get(None, 0)) == "mov osr, rxfifo[y]"


class TestReserved:
    def test_illegal_encoding_raises(self):
        with pytest.raises(E.ReservedEncoding):
            disasm.disassemble(E.encode_in("pins", 0, 0) | (4 << 5))

    def test_aliased_ds_field_raises(self):
        # side-set data bits below a cleared opt-enable have no canonical
        # text: ds = enable(0) + data(1), count 2 (SPEC-4-1..3)
        w = E.encode_set("pins", 1, 0) | (0x08 << 8)
        with pytest.raises(E.ReservedEncoding):
            disasm.disassemble(w, True, 2)


class TestRoundTrip:
    def test_reassemble_sampled_space(self):
        # The full 4-config x 65536 sweep is difftest --asm-check; here a
        # deterministic sample keeps the unit suite fast.
        for side_en, ss in ((False, 0), (True, 2)):
            prog = asm.Program("rt")
            prog.sideset_bits = ss - (1 if side_en else 0)
            prog.sideset_opt = side_en
            for w in range(0, 0x10000, 131):
                try:
                    txt = disasm.disassemble(w, side_en, ss)
                except E.ReservedEncoding:
                    continue
                assert asm.assemble_instruction(txt, prog, {}, "rt") == w

"""encoding.py: field split / decode / pack (SPEC-2, SPEC-4, SPEC-13-1)."""

import pytest
from pio_model import encoding as E


class TestSplit:
    def test_field_split_spec_2_1_to_5(self):
        # SPEC-2-1..5: class 15:13, delay/side-set 12:8, arg1 7:5, arg2 4:0
        # 0xA042 = mov y, y (nop): class 5, ds 0, arg1 2, arg2 2
        assert E.split(0xA042) == (E.C_MOV, 0, 2, 2)

    def test_split_is_field_inverse_of_encode(self):
        for w in range(0, 0x10000, 257):  # deterministic sample
            cls, ds, a1, a2 = E.split(w)
            assert E.encode(cls, a1, a2, ds) == w


class TestDecode:
    def test_jmp_fields(self):
        d = E.decode(E.encode_jmp("x--", 9, 0x15))
        assert d["is_jmp"]
        assert not d["illegal"]
        assert d["jmp_cond"] == E.JC_XDEC
        assert d["jmp_addr"] == 9
        assert d["delay"] == 0x15 & 0x1F

    def test_in_bitcount_zero_means_32(self):  # SPEC-2-18
        assert E.decode(E.encode_in("x", 0, 0))["in_count"] == 32
        assert E.decode(E.encode_out("pins", 0, 0))["out_count"] == 32

    def test_push_pull_overload_spec_14_2_1(self):
        d = E.decode(E.encode_push(True, False, 0))
        assert d["is_push"]
        assert not d["is_pull"]
        assert not d["illegal"]
        assert d["push_iff"] == 1
        assert d["push_blk"] == 0
        d = E.decode(E.encode_pull(False, True, 0))
        assert d["is_pull"]
        assert d["pull_ife"] == 0
        assert d["pull_blk"] == 1
        # b7=1 with arg2<0x10 is GET/PUT, not PULL
        d = E.decode(E.encode_get(None, 0))
        assert d["is_get"]
        assert not d["is_pull"]
        # nonzero arg2 on PUSH/PULL is reserved
        assert E.decode(E.encode(E.C_PP, 0, 1, 0))["illegal"]

    def test_reserved_encodings_spec_13_1(self):
        assert E.decode(E.encode_in("pins", 0, 0) | (4 << 5))["illegal"]  # IN src 4
        assert E.decode(E.encode_mov("x", "x", 3, 0))["illegal"]  # MOV op 3
        assert E.decode(E.encode_irq(True, True, None, 0, 0))["illegal"]  # SPEC-3.8-3
        assert E.decode(E.encode(E.C_SET, 3, 0, 0))["illegal"]  # SET dst 3
        # WAIT JMPPIN with nonzero high index bits
        assert E.decode(E.encode_wait(1, E.WSRC_JMPPIN, 0x10, 0))["illegal"]

    def test_wait_index_packs_idxmode(self):
        d = E.decode(E.encode_wait(0, E.WSRC_IRQ, (E.IDX_MODES["rel"] << 3) | 5, 0))
        assert d["wait_src"] == E.WSRC_IRQ
        assert d["wait_index"] == (E.IDX_MODES["rel"] << 3) | 5
        assert d["wait_pol"] == 0

    def test_decoded_word_is_masked(self):
        assert E.decode(0x12345678 & 0xFFFFFFFF)["word"] == 0x5678


class TestSideSet:
    def test_no_sideset_full_delay(self):
        # SPEC-4-9: count 0 = no side-set, all 5 bits are delay
        assert E.split_sideset(0x1F, False, 0) == (0x1F, False, 0, 0)

    def test_opt_enable_bit_spec_4_2(self):
        # side_en, count 2: bit 4 = enable, bit 3 = value, delay 3 bits
        assert E.split_sideset(0b11000, True, 2) == (0, True, 1, 1)
        assert E.split_sideset(0b11010, True, 2) == (2, True, 1, 1)
        # enable=0: no side-set, the value bit reads back as plain delay
        assert E.split_sideset(0b01010, True, 2) == (2, False, 0, 0)

    def test_non_opt_full_value(self):
        # count 3, no opt: 3 value bits, 2 delay bits
        assert E.split_sideset(0b10111, False, 3) == (0b11, True, 0b101, 3)

    def test_count_over_5_is_reserved(self):
        with pytest.raises(E.ReservedEncoding):
            E.split_sideset(0, False, 6)

    def test_pack_split_inverse(self):
        # Canonical fields repack exactly; aliased fields (data bits below
        # a cleared opt-enable) are excluded — no canonical form exists.
        for side_en, cnt in ((False, 0), (False, 2), (True, 2), (True, 3)):
            vbits = cnt - 1 if side_en else cnt
            for field in range(32):
                delay, ss_valid, ss_val, ss_bits = E.split_sideset(field, side_en, cnt)
                rebuilt = delay
                if ss_valid:
                    if side_en:
                        rebuilt |= 1 << (cnt - 1)
                    rebuilt |= ss_val << (5 - cnt)
                assert ss_bits == (vbits if ss_valid else 0)
                if rebuilt == field:  # canonical fields repack exactly
                    repack = E.pack_ds(delay, ss_val, side_en, cnt, ss_valid)
                    assert repack == field, (field, side_en, cnt, repack)

    def test_pack_side_without_directive_raises(self):
        with pytest.raises(E.ReservedEncoding):
            E.pack_ds(0, 1, False, 0, True)


class TestEncoders:
    def test_known_words(self):
        # Independent literals (hand-packed from the SPEC-2 tables).
        assert E.encode_jmp(None, 0, 0) == 0x0000  # jmp 0
        assert E.encode_mov("y", "y", 0, 0) == 0xA042  # nop (SPEC-3.6-10)
        assert E.encode_set("pins", 1, 0) == 0xE001
        assert E.encode_out("pins", 1, 0) == 0x6001
        assert E.encode_in("pins", 8, 0) == 0x4008
        assert E.encode_wait(1, E.WSRC_GPIO, 3, 0) == 0x2083
        assert E.encode_push(False, True, 0) == 0x8020

    def test_put_get_index_packing(self):
        # SPEC-2-12: arg2 = 0x10 | (IdxI<<3 | Index) when literal
        assert E.encode_put(None, 0) & 0x1F == 0x10
        assert E.encode_put(2, 0) & 0x1F == 0x1A
        assert E.encode_get(1, 0) & 0x1F == 0x19

    def test_mov_op_operands(self):
        w = E.encode_mov("x", "y", E.MOP_INV, 0)
        assert w & 0x1F == (E.MOP_INV << 3) | E.MOVS_Y

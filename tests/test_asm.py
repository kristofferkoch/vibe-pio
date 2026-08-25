"""asm.py: native .pio assembler — directives, expressions, encoding."""

import pytest
from pio_model import asm
from pio_model import encoding as E


def parse_one(text):
    progs = asm.parse_text(text)
    assert len(progs) == 1
    return progs[0]


class TestExpressions:
    def test_precedence_and_arithmetic(self):
        sym = {}
        assert asm.eval_expr("1+2*3", sym) == 7
        assert asm.eval_expr("(1+2)*3", sym) == 9
        assert asm.eval_expr("1|2^3&7", sym) == 1 | (2 ^ (3 & 7))
        assert asm.eval_expr("1<<4", sym) == 16
        assert asm.eval_expr("255>>2", sym) == 63
        assert asm.eval_expr("~0", sym) == -1
        assert asm.eval_expr("-7+3", sym) == -4
        assert asm.eval_expr("0x1f", sym) == 31
        assert asm.eval_expr("0b101", sym) == 5

    def test_c_truncating_division(self):
        # pioasm uses C semantics: truncation toward zero, not floor
        sym = {}
        assert asm.eval_expr("7/2", sym) == 3
        assert asm.eval_expr("-7/2", sym) == -3
        assert asm.eval_expr("-7%2", sym) == -1
        assert asm.eval_expr("7%-2", sym) == 1

    def test_symbols_and_labels(self):
        assert asm.eval_expr("N+1", {"N": 5}) == 6
        with pytest.raises(asm.AsmError):
            asm.eval_expr("nope", {})
        with pytest.raises(asm.AsmError):
            asm.eval_expr("1/0", {})

    def test_bad_token(self):
        with pytest.raises(asm.AsmError):
            asm.eval_expr("1 + $", {})


class TestDirectives:
    def test_program_defaults(self):
        p = parse_one(".program t\nset pins, 1\n")
        assert p.name == "t"
        assert p.words == [0xE001]
        assert p.wrap == 0  # single instr: both bounds collapse
        assert p.wrap_target == 0

    def test_wrap_bounds(self):
        p = parse_one(".program t\n.wrap_target\nnop\nnop\n.wrap\nnop\n")
        assert p.wrap_target == 0
        assert p.wrap == 1  # the instruction preceding .wrap

    def test_side_set_config(self):
        p = parse_one(".program t\n.side_set 1 opt\nnop\n")
        assert p.sideset_bits == 1
        assert p.sideset_opt
        assert p.sideset_count == 2  # incl. enable bit (SPEC-7-26)
        assert p.side_en

    def test_define_public(self):
        p = parse_one(".program t\n.define public N 3\nset x, N\n")
        assert p.words == [E.encode_set("x", 3, 0)]
        assert "N" in p.public_symbols
        assert p.symbols["N"] == 3

    def test_lang_opt_and_csdk_block_ignored(self):
        text = ".program t\n.lang_opt c func=1\n% c-sdk {\nthis is not parsed\n%}\nnop\n"
        assert parse_one(text).words == [0xA042]

    def test_pio_version_leading_program(self):
        p = parse_one(".pio_version 1\n.program t\nnop\n")
        assert p.pio_version == 1

    def test_labels(self):
        p = parse_one(".program t\npublic loop:\nnop\nnop\njmp loop\n")
        assert p.labels == {"loop": 0}  # label addr = next instr index
        assert "loop" in p.public_labels
        assert p.words[2] == E.encode_jmp(None, 0, 0)

    def test_duplicate_label_raises(self):
        with pytest.raises(asm.AsmError):
            parse_one(".program t\nx: nop\nx: nop\n")

    def test_instruction_outside_program(self):
        with pytest.raises(asm.AsmError):
            asm.parse_text("nop\n")

    def test_unsupported_directive(self):
        with pytest.raises(asm.AsmError):
            parse_one(".program t\n.fifo 8\nnop\n")

    def test_unknown_directive(self):
        with pytest.raises(asm.AsmError):
            parse_one(".program t\n.bogus 1\nnop\n")


class TestInstructions:
    def test_delay_and_side_packing(self):
        # out pins, 1 side 1 [2] with .side_set 1 opt:
        # ds = enable 0x10 | value 1<<3 | delay 2 (SPEC-4-2/4-3)
        p = parse_one(".program t\n.side_set 1 opt\nout pins, 1 side 1 [2]\n")
        assert p.words == [0x6001 | (0x1A << 8)]

    def test_side_then_delay_order_free(self):
        a = parse_one(".program t\n.side_set 1 opt\nout pins, 1 side 1 [2]\n")
        b = parse_one(".program t\n.side_set 1 opt\nout pins, 1 [2] side 1\n")
        assert a.words == b.words

    def test_jmp_condition_forms(self):
        p = parse_one(
            ".program t\n"
            "jmp tgt\njmp !x tgt\njmp x-- tgt\njmp !y tgt\njmp y-- tgt\n"
            "jmp x != y tgt\njmp pin tgt\njmp !osre tgt\ntgt: nop\n"
        )
        conds = [E.JMP_CONDS[k] for k in (None, "!x", "x--", "!y", "y--", "x != y", "pin", "!osre")]
        assert p.words[:8] == [E.encode(E.C_JMP, c, 8, 0) for c in conds]

    def test_push_pull_modifiers(self):
        p = parse_one(".program t\npush block\npull ifempty noblock\n")
        assert p.words[0] == E.encode_push(False, True, 0)
        assert p.words[1] == E.encode_pull(True, False, 0)

    def test_mov_variants(self):
        p = parse_one(".program t\nmov x, ~y\nmov osr, ::x\nmov rxfifo[2], isr\nmov x, rxfifo[y]\n")
        assert p.words[0] == E.encode_mov("x", "y", E.MOP_INV, 0)
        assert p.words[1] == E.encode_mov("osr", "x", E.MOP_REV, 0)
        assert p.words[2] == E.encode_put(2, 0)
        assert p.words[3] == E.encode_get(None, 0)

    def test_irq_and_wait_forms(self):
        p = parse_one(".program t\nirq wait 1 rel\nirq clear 2\nwait 1 gpio 3\nwait 0 pin 4\n")
        assert p.words[0] == E.encode_irq(False, True, E.IDX_MODES["rel"], 1, 0)
        assert p.words[1] == E.encode_irq(True, False, None, 2, 0)
        assert p.words[2] == E.encode_wait(1, E.WSRC_GPIO, 3, 0)
        assert p.words[3] == E.encode_wait(0, E.WSRC_PIN, 4, 0)

    def test_irq_without_index_raises(self):
        # red/green: this used to escape as a bare TypeError from the
        # encoder instead of an AsmError naming the source line
        with pytest.raises(asm.AsmError, match="irq needs an index"):
            parse_one(".program t\nirq clear\n")

    def test_nop_encoding(self):
        assert parse_one(".program t\nnop\n").words == [0xA042]

    def test_unknown_mnemonic(self):
        with pytest.raises(asm.AsmError):
            parse_one(".program t\nfrobnicate x\n")

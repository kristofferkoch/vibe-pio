"""Instruction-word field split, encode and decode (C12).

Mirrors rtl/pio_sm_decoder.sv's pure-combinational contract:
  - field split SPEC-2-1..5 (class 15:13, delay/side-set 12:8, arg1 7:5,
    arg2 4:0),
  - the class-0x4 overload rule SPEC-14.2-1 (arg2[4]=1 => FIFO-aux MOV
    PUT/GET, else PUSH/PULL, nonzero arg2 => reserved),
  - bitcount 0 => 32 (SPEC-2-18),
  - the delay/side-set split under EXECCTRL.SIDE_EN +
    PINCTRL.SIDESET_COUNT (SPEC-4-1..3, SPEC-4-9, SPEC-14.8-1),
  - the SPEC-13-1 reserved list.

One shared decode feeds the disassembler and the model (the model must see
exactly the fields the RTL decoder extracts).
"""

from typing import NotRequired, TypedDict

M32 = 0xFFFFFFFF

# Instruction classes (SPEC-2-2: bits 15:13).
C_JMP, C_WAIT, C_IN, C_OUT, C_PP, C_MOV, C_IRQ, C_SET = range(8)

# JMP conditions (SPEC-3.1-2..9).
JC_ALWAYS, JC_NOTX, JC_XDEC, JC_NOTY, JC_YDEC, JC_XNEY, JC_PIN, JC_NOTOSRE = range(8)
JMP_CONDS: dict[str | None, int] = {
    None: JC_ALWAYS,
    "always": JC_ALWAYS,
    "!x": JC_NOTX,
    "x--": JC_XDEC,
    "!y": JC_NOTY,
    "y--": JC_YDEC,
    "x != y": JC_XNEY,
    "pin": JC_PIN,
    "!osre": JC_NOTOSRE,
}

# WAIT sources (SPEC-3.2-2..5).
WSRC_GPIO, WSRC_PIN, WSRC_IRQ, WSRC_JMPPIN = range(4)

# IN sources (SPEC-3.3-2..6).
INS_PINS, INS_X, INS_Y, INS_NULL, INS_ISR, INS_OSR = 0, 1, 2, 3, 6, 7
IN_SRCS: dict[str, int] = {"pins": INS_PINS, "x": INS_X, "y": INS_Y, "null": INS_NULL, "isr": INS_ISR, "osr": INS_OSR}

# OUT destinations (SPEC-3.4-2..8).
OUTD_PINS, OUTD_X, OUTD_Y, OUTD_NULL, OUTD_PINDIRS, OUTD_PC, OUTD_ISR, OUTD_EXEC = range(8)
OUT_DSTS: dict[str, int] = {
    "pins": OUTD_PINS,
    "x": OUTD_X,
    "y": OUTD_Y,
    "null": OUTD_NULL,
    "pindirs": OUTD_PINDIRS,
    "pc": OUTD_PC,
    "isr": OUTD_ISR,
    "exec": OUTD_EXEC,
}

# MOV destinations / sources (SPEC-3.6-1..8); 4 EXEC, 5 PC / 5 STATUS.
MOVD_PINS, MOVD_X, MOVD_Y, MOVD_PINDIRS, MOVD_EXEC, MOVD_PC, MOVD_ISR, MOVD_OSR = range(8)
MOVS_PINS, MOVS_X, MOVS_Y, MOVS_NULL, MOVS_STATUS, MOVS_ISR, MOVS_OSR = 0, 1, 2, 3, 5, 6, 7
MOVD_DSTS: dict[str, int | None] = {
    "pins": MOVD_PINS,
    "x": MOVD_X,
    "y": MOVD_Y,
    "pindirs": MOVD_PINDIRS,
    "exec": MOVD_EXEC,
    "pc": MOVD_PC,
    "isr": MOVD_ISR,
    "osr": MOVD_OSR,
    "rxfifo": None,
}
MOVS_SRCS: dict[str, int | None] = {
    "pins": MOVS_PINS,
    "x": MOVS_X,
    "y": MOVS_Y,
    "null": MOVS_NULL,
    "status": MOVS_STATUS,
    "isr": MOVS_ISR,
    "osr": MOVS_OSR,
    "rxfifo": None,
}
MOP_NONE, MOP_INV, MOP_REV = 0, 1, 2  # SPEC-3.6-9 (3 reserved)

# SET destinations (SPEC-3.9-1/2).
SETD_PINS, SETD_X, SETD_Y, SETD_PINDIRS = 0, 1, 2, 4
SET_DSTS: dict[str, int] = {"pins": SETD_PINS, "x": SETD_X, "y": SETD_Y, "pindirs": SETD_PINDIRS}

# IRQ / WAIT-IRQ IdxModes (SPEC-3.8-4..7, SPEC-14.3-1).
IDX_THIS, IDX_PREV, IDX_REL, IDX_NEXT = 0, 1, 2, 3
IDX_MODES: dict[str | None, int] = {None: IDX_THIS, "": IDX_THIS, "prev": IDX_PREV, "rel": IDX_REL, "next": IDX_NEXT}


class ReservedEncoding(Exception):
    """A SPEC-13-1 reserved/undefined encoding (reason text attached)."""


class Decoded(TypedDict):
    """The decoder output bundle — exactly what rtl/pio_sm_decoder.sv
    hands to pio_sm_exec. The onehot class strobes and shared fields are
    always present; per-class operands only for the decoded class
    (read them via d.get(..., default), as the model does)."""

    word: int
    cls: int
    delay: int
    ss_valid: bool
    ss_val: int
    ss_bits: int
    illegal: bool
    is_jmp: bool
    is_wait: bool
    is_in: bool
    is_out: bool
    is_push: bool
    is_pull: bool
    is_put: bool
    is_get: bool
    is_mov: bool
    is_irq: bool
    is_set: bool
    jmp_cond: NotRequired[int]
    jmp_addr: NotRequired[int]
    wait_pol: NotRequired[int]
    wait_src: NotRequired[int]
    wait_index: NotRequired[int]
    in_src: NotRequired[int]
    in_count: NotRequired[int]
    out_dst: NotRequired[int]
    out_count: NotRequired[int]
    aux_idxi: NotRequired[int]
    aux_index: NotRequired[int]
    push_iff: NotRequired[int]
    push_blk: NotRequired[int]
    pull_ife: NotRequired[int]
    pull_blk: NotRequired[int]
    mov_dst: NotRequired[int]
    mov_src: NotRequired[int]
    mov_op: NotRequired[int]
    irq_clr: NotRequired[int]
    irq_wait: NotRequired[int]
    irq_idxmode: NotRequired[int]
    irq_index: NotRequired[int]
    set_dst: NotRequired[int]
    set_data: NotRequired[int]


def split(word: int) -> tuple[int, int, int, int]:
    """SPEC-2-1..5 field split: (class, delay/side-set, arg1, arg2).

    >>> split(0xA042)  # mov y, y (the nop encoding)
    (5, 0, 2, 2)
    """
    return ((word >> 13) & 7, (word >> 8) & 0x1F, (word >> 5) & 7, word & 0x1F)


def split_sideset(ds_field: int, side_en: bool, sideset_count: int) -> tuple[int, bool, int, int]:
    """Delay/side-set split (SPEC-4-1..3, SPEC-4-9, SPEC-14.8-1).

    Returns (delay, ss_valid, ss_val, ss_bits) exactly as
    rtl/pio_sm_decoder.sv computes them. sideset_count is the raw
    PINCTRL field (0..5, inclusive of the enable bit when side_en).

    >>> split_sideset(0b11010, True, 2)   # opt: bit4 enables, bit3 = data
    (2, True, 1, 1)
    >>> split_sideset(0b01010, True, 2)   # enable 0: value bit reads as delay
    (2, False, 0, 0)
    >>> split_sideset(0b10111, False, 3)  # no opt: 3 data bits, 2 delay
    (3, True, 5, 3)
    """
    total = sideset_count & 7
    if total > 5:
        raise ReservedEncoding("sideset_count > 5")
    vbits = (total - 1) if side_en else total
    ss_field = ds_field >> (5 - total) if total else 0
    delay_mask = 0x1F >> total
    en_bit = (ss_field >> (total - 1)) & 1 if total else 0
    ss_valid = total != 0 and (not side_en or en_bit != 0)
    ss_val = (ss_field & (0x1F >> (5 - vbits))) if (ss_valid and vbits) else 0
    return ds_field & delay_mask, ss_valid, ss_val, (vbits if ss_valid else 0)


def decode(word: int, side_en: bool = False, sideset_count: int = 0) -> Decoded:
    """Full decode of one instruction word.

    Returns the onehot class strobes, per-class operands and `illegal`
    (SPEC-13-1) — the exact bundle rtl/pio_sm_decoder.sv hands to
    pio_sm_exec. Raises nothing: reserved encodings decode with
    illegal=True (the RTL executes them as pure no-ops).

    >>> decode(encode_jmp("x--", 9, 0))["jmp_cond"] == JC_XDEC
    True
    >>> decode(encode_in("x", 0, 0))["in_count"]  # SPEC-2-18: 0 => 32
    32
    >>> decode(encode(C_IN, 4, 0, 0))["illegal"]  # IN source 4 reserved
    True
    """
    cls, ds, arg1, arg2 = split(word)
    delay, ss_valid, ss_val, ss_bits = split_sideset(ds, side_en, sideset_count)
    d: Decoded = {
        "word": word & 0xFFFF,
        "cls": cls,
        "delay": delay,
        "ss_valid": ss_valid,
        "ss_val": ss_val,
        "ss_bits": ss_bits,
        "illegal": False,
        "is_jmp": False,
        "is_wait": False,
        "is_in": False,
        "is_out": False,
        "is_push": False,
        "is_pull": False,
        "is_put": False,
        "is_get": False,
        "is_mov": False,
        "is_irq": False,
        "is_set": False,
    }
    if cls == C_JMP:  # SPEC-2-7
        d["is_jmp"] = True
        d["jmp_cond"] = arg1
        d["jmp_addr"] = arg2
    elif cls == C_WAIT:  # SPEC-2-8
        d["is_wait"] = True
        d["wait_pol"] = (arg1 >> 2) & 1  # SPEC-3.2-1
        d["wait_src"] = arg1 & 3  # SPEC-3.2-2..5
        d["wait_index"] = arg2
        if d["wait_src"] == WSRC_JMPPIN and (arg2 & 0x1C) != 0:  # SPEC-13-1
            d["illegal"] = True
    elif cls == C_IN:  # SPEC-2-9
        d["is_in"] = True
        d["in_src"] = arg1
        if arg1 in (4, 5):  # SPEC-3.3-5
            d["illegal"] = True
        d["in_count"] = 32 if arg2 == 0 else arg2  # SPEC-2-18
    elif cls == C_OUT:  # SPEC-2-10
        d["is_out"] = True
        d["out_dst"] = arg1
        d["out_count"] = 32 if arg2 == 0 else arg2  # SPEC-2-18
    elif cls == C_PP:  # SPEC-14.2-1
        if arg2 & 0x10:
            if word & 0x80:  # b7: GET/PUT
                d["is_get"] = True
            else:
                d["is_put"] = True
            d["aux_idxi"] = (arg2 >> 3) & 1  # SPEC-3.7-4
            d["aux_index"] = arg2 & 3
            if (arg2 & 4) != 0 or (d["aux_idxi"] == 0 and (arg2 & 3) != 0):
                d["illegal"] = True  # SPEC-13-1
        else:
            if word & 0x80:  # SPEC-2-11/13
                d["is_pull"] = True
            else:
                d["is_push"] = True
            if arg2 != 0:
                d["illegal"] = True  # SPEC-13-1
            # SPEC-3.5-3 pioasm arg1 packing: b7 direction, b6 IfF/IfE, b5 Blk
            d["push_iff"] = (word >> 6) & 1
            d["push_blk"] = (word >> 5) & 1
            d["pull_ife"] = (word >> 6) & 1
            d["pull_blk"] = (word >> 5) & 1
    elif cls == C_MOV:  # SPEC-2-15
        d["is_mov"] = True
        d["mov_dst"] = arg1
        d["mov_src"] = word & 7
        d["mov_op"] = (arg2 >> 3) & 3
        if d["mov_op"] == 3 or d["mov_src"] == 4:  # SPEC-13-1
            d["illegal"] = True
    elif cls == C_IRQ:  # SPEC-2-16
        d["is_irq"] = True
        d["irq_clr"] = (word >> 6) & 1  # SPEC-3.8-1
        d["irq_wait"] = (word >> 5) & 1  # SPEC-3.8-2
        d["irq_idxmode"] = (arg2 >> 3) & 3
        d["irq_index"] = arg2 & 7
        if d["irq_clr"] and d["irq_wait"]:  # SPEC-3.8-3
            d["illegal"] = True
    else:  # SPEC-2-17
        d["is_set"] = True
        d["set_dst"] = arg1
        d["set_data"] = arg2
        if arg1 in (3, 5, 6, 7):  # SPEC-3.9-2
            d["illegal"] = True
    return d


def pack_ds(delay: int, side_val: int, side_en: bool, sideset_count: int, side_present: bool) -> int:
    """Pack the delay/side-set field, bit-equal to pioasm
    (pio_assembler.cpp instruction::encode): delay is always masked to
    5 - sideset_count bits (SPEC-4-3); a present `side` shifts its value
    into the top bits and, with SIDE_EN, forces the enable bit 0x10
    (SPEC-4-2 — an absent side contributes nothing, enable=0).

    >>> pack_ds(2, 1, True, 2, True)   # en | value 1<<3 | delay 2
    26
    >>> pack_ds(7, 0, False, 0, False)
    7
    """
    total = sideset_count & 7
    if total == 0:
        if side_present and side_val:
            raise ReservedEncoding("side value with SIDESET_COUNT=0 (SPEC-4-9)")
        return delay & 0x1F
    mask = (1 << (5 - total)) - 1
    field = delay & mask
    if side_present:
        field |= (side_val << (5 - total)) & 0x1F
        if side_en:
            field |= 0x10
    return field


def encode(clz: int, arg1: int, arg2: int, ds: int) -> int:
    """Pack the four SPEC-2-1..5 fields into one 16-bit word.

    >>> hex(encode(C_MOV, MOVD_Y, MOVS_Y, 0))
    '0xa042'
    """
    return ((clz << 13) | ((ds & 0x1F) << 8) | ((arg1 & 7) << 5) | (arg2 & 0x1F)) & 0xFFFF


def encode_jmp(cond: str | None, addr: int, ds: int = 0) -> int:
    """SPEC-2-7. cond is the pioasm condition text (None = always).

    >>> hex(encode_jmp(None, 0))
    '0x0'
    """
    return encode(C_JMP, JMP_CONDS[cond], addr, ds)  # SPEC-2-7


def encode_wait(pol: int | bool, src: int, index: int, ds: int = 0) -> int:
    """SPEC-2-8. pol 1/0, src a WSRC_* constant."""
    return encode(C_WAIT, ((1 if pol else 0) << 2) | src, index, ds)  # SPEC-2-8


def encode_in(src: str, count: int, ds: int = 0) -> int:
    """SPEC-2-9. src is the pioasm IN source name."""
    return encode(C_IN, IN_SRCS[src], count & 0x1F, ds)  # SPEC-2-9


def encode_out(dst: str, count: int, ds: int = 0) -> int:
    """SPEC-2-10. dst is the pioasm OUT destination name."""
    return encode(C_OUT, OUT_DSTS[dst], count & 0x1F, ds)  # SPEC-2-10


def encode_push(iffull: bool, block: bool, ds: int = 0) -> int:
    """SPEC-2-11."""
    return encode(C_PP, (1 if block else 0) | ((1 if iffull else 0) << 1), 0, ds)  # SPEC-2-11


def encode_pull(ifempty: bool, block: bool, ds: int = 0) -> int:
    """SPEC-2-13."""
    return encode(C_PP, 4 | (1 if block else 0) | ((1 if ifempty else 0) << 1), 0, ds)  # SPEC-2-13


def encode_put(index: int | None, ds: int = 0) -> int:
    """SPEC-2-12: arg2 = 0x10 | (idx if literal else 0); idx literal packs
    IdxI=1 (0x08) + Index&3 (pioasm get_push_get_index).

    >>> encode_put(None, 0) & 0x1F
    16
    >>> encode_put(2, 0) & 0x1F
    26
    """
    arg2 = 0x10 | ((8 | (index & 3)) if index is not None else 0)
    return encode(C_PP, 0, arg2, ds)


def encode_get(index: int | None, ds: int = 0) -> int:
    """SPEC-2-14 (index packing as encode_put)."""
    arg2 = 0x10 | ((8 | (index & 3)) if index is not None else 0)
    return encode(C_PP, 4, arg2, ds)  # SPEC-2-14


def encode_mov(dst: str, src: str, op: int, ds: int = 0) -> int:
    """SPEC-2-15. dst/src are pioasm names; op a MOP_* constant.

    `rxfifo` is not a MOV operand (it is FIFO-aux PUT/GET — encode_put /
    encode_get); it maps to None in the tables and is rejected here.
    """
    dst_code, src_code = MOVD_DSTS[dst], MOVS_SRCS[src]
    if dst_code is None or src_code is None:
        raise KeyError("rxfifo (use encode_put/encode_get instead)")
    return encode(C_MOV, dst_code, ((op & 3) << 3) | src_code, ds)


def encode_irq(clr: bool, wait: bool, mode: int | str | None, index: int, ds: int = 0) -> int:
    """SPEC-2-16. mode is an IDX_* constant or its pioasm name/None.

    >>> encode_irq(False, True, "rel", 1) & 0x1F  # IdxMode rel (2) << 3 | index 1
    17
    """
    if mode is None or isinstance(mode, str):
        mode = IDX_MODES[mode]
    return encode(
        C_IRQ, ((1 if clr else 0) << 1) | (1 if wait else 0), ((mode & 3) << 3) | (index & 7), ds
    )  # SPEC-2-16


def encode_set(dst: str, data: int, ds: int = 0) -> int:
    """SPEC-2-17. dst is the pioasm SET destination name.

    >>> hex(encode_set("pins", 1))
    '0xe001'
    """
    return encode(C_SET, SET_DSTS[dst], data, ds)  # SPEC-2-17

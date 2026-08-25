"""Disassembler: 16-bit word -> pioasm-syntax text (C12).

Canonical one-space-separated form of the pioasm dialect the examples
use (sim/conf_pioexamples.svh carries pioasm's own renderings); the
native assembler round-trips this text bit-exactly (the 65536-word
round-trip is a difftest self-check). Reserved encodings raise
ReservedEncoding (SPEC-13-1) — the model executes them as no-ops, but
they have no faithful text.
"""

from . import encoding as E

_JMP_CONDS = {v: k for k, v in E.JMP_CONDS.items() if k is not None}
_IN_SRCS = {v: k for k, v in E.IN_SRCS.items()}
_OUT_DSTS = {v: k for k, v in E.OUT_DSTS.items()}
_MOVD_DSTS = {v: k for k, v in E.MOVD_DSTS.items() if k is not None}
_MOVS_SRCS = {v: k for k, v in E.MOVS_SRCS.items() if k is not None}
_MOVS_SRCS[E.MOVS_STATUS] = "status"
_SET_DSTS = {v: k for k, v in E.SET_DSTS.items()}
_IDX_MODES = {v: k for k, v in E.IDX_MODES.items() if k}
_OPS = {E.MOP_NONE: "", E.MOP_INV: "~", E.MOP_REV: "::"}


def _postfix(d):
    s = ""
    if d["ss_valid"]:
        s += f" side {d['ss_val']}"
    if d["delay"]:
        s += f" [{d['delay']}]"
    return s


def disassemble(word, side_en=False, sideset_count=0):
    """Word -> canonical instruction text (raises ReservedEncoding for
    SPEC-13-1 encodings)."""
    d = E.decode(word, side_en, sideset_count)
    if d["illegal"]:
        raise E.ReservedEncoding(f"reserved encoding {word & 0xFFFF:04x} "
                                 "(SPEC-13-1)")
    # ds-field aliasing (e.g. side-set data bits with the opt enable 0)
    # has no faithful text: the canonical re-pack must reproduce the word.
    repack = E.pack_ds(d["delay"], d["ss_val"], side_en, sideset_count,
                       d["ss_valid"])
    if repack != ((word >> 8) & 0x1F):
        raise E.ReservedEncoding(f"aliased delay/side-set field "
                                 f"{(word >> 8) & 0x1F:02x} (SPEC-4-1..3)")
    pf = _postfix(d)

    def count(n):                      # SPEC-2-18: bitcount 0 => 32
        return n if n else 32

    if d["is_jmp"]:                    # SPEC-3.1
        cond = _JMP_CONDS[d["jmp_cond"]]
        t = f" {cond}," if d["jmp_cond"] != E.JC_ALWAYS else ""
        return f"jmp{t} {d['jmp_addr']}{pf}"
    if d["is_wait"]:                   # SPEC-3.2
        if d["wait_src"] == E.WSRC_IRQ:
            mode = _IDX_MODES.get(d["wait_index"] >> 3, "") or ""
            return (f"wait {d['wait_pol']} irq {d['wait_index'] & 7}"
                    + (f" {mode}" if mode else "") + pf)
        if d["wait_src"] == E.WSRC_JMPPIN:
            return f"wait {d['wait_pol']} jmppin {d['wait_index'] & 3}{pf}"
        src = "gpio" if d["wait_src"] == E.WSRC_GPIO else "pin"
        return f"wait {d['wait_pol']} {src} {d['wait_index']}{pf}"
    if d["is_in"]:                     # SPEC-3.3
        return f"in {_IN_SRCS[d['in_src']]}, {count(d['word'] & 31)}{pf}"
    if d["is_out"]:                    # SPEC-3.4
        return f"out {_OUT_DSTS[d['out_dst']]}, {count(d['word'] & 31)}{pf}"
    if d["is_push"] or d["is_pull"]:   # SPEC-3.5
        m = ""
        if d["is_push"] and d["push_iff"]:
            m += " iffull"
        if d["is_pull"] and d["pull_ife"]:
            m += " ifempty"
        m += " noblock" if not (d["push_blk"] if d["is_push"] else d["pull_blk"]) \
            else " block"
        return ("push" if d["is_push"] else "pull") + m + pf
    if d["is_put"] or d["is_get"]:     # SPEC-3.7
        # arg1 must be exactly 000/100 (b7 GET) — anything else is a
        # SPEC-2-12 reserved encoding with no faithful text.
        a1 = (d["word"] >> 5) & 7
        if a1 != (4 if d["is_get"] else 0):
            raise E.ReservedEncoding(f"fifo-aux arg1 {a1} reserved "
                                     "(SPEC-2-12)")
        idx = f"[{d['aux_index']}]" if d["aux_idxi"] else "[y]"
        if d["is_put"]:
            return f"mov rxfifo{idx}, isr{pf}"
        return f"mov osr, rxfifo{idx}{pf}"
    if d["is_mov"]:                    # SPEC-3.6
        if (word & 0xFFFF) == 0xA042:
            return f"nop{pf}"          # SPEC-3.6-10: nop == mov y, y
        return (f"mov {_MOVD_DSTS[d['mov_dst']]}, "
                f"{_OPS[d['mov_op']]}{_MOVS_SRCS[d['mov_src']]}{pf}")
    if d["is_irq"]:                    # SPEC-3.8
        if d["word"] & 0x80:           # arg1 b7 must be 0 (SPEC-2-16)
            raise E.ReservedEncoding("irq b7 set (SPEC-2-16)")
        m = " clear" if d["irq_clr"] else (" wait" if d["irq_wait"] else "")
        mode = _IDX_MODES.get(d["irq_idxmode"], "")
        return f"irq{m} {d['irq_index']}{(' ' + mode) if mode else ''}{pf}"
    # SET (SPEC-3.9)
    return f"set {_SET_DSTS[d['set_dst']]}, {d['set_data']}{pf}"

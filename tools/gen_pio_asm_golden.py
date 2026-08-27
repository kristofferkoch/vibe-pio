#!/usr/bin/env python3
"""C19 golden-vector generator: pio_model asm/disasm -> the committed JS
fixture web/tests/pio-asm-golden.json.

The in-browser assembler (web/pio-asm.js) is a JS port of the C12
pio_model asm/disasm/encoding trio, which is itself bit-equal to pioasm
2.3.0 on every conformance program (difftest --asm-check). The port is
anchored to that oracle — not to itself — by this fixture: for every
sim/conf_pioexamples.svh program it records

  - the full .pio source text (the JS parser sees exactly this),
  - the assembled 16-bit words (pioasm-equal by the C12 gate),
  - the canonical disassembly of each word under the program's own
    side-set configuration (the C12 1-1 form),
  - a handful of expression-evaluator goldens (the C truncating-division
    corners a naive JS `/`/`%` port gets wrong).

web/tests/pio-asm.test.js checks the JS port against all of it, plus
the canonical round-trip property (assemble(disassemble(w)) == w over
the whole 16-bit space x 4 side-set configs — the difftest --asm-check
round-trip, ported). The canonical round-trip is self-contained (no
fixture needed); the goldens are what make it an oracle check.

Drift guard: `--check` regenerates and diffs against the committed
file, exiting nonzero on any drift (wired into `make js`, so a pio_model
change that moves the target silently cannot leave the fixture stale).
Regenerate with no arguments after a deliberate pio_model change.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TOOLS = str(Path(__file__).resolve().parent.parent)
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from pio_model import asm, disasm  # noqa: E402
from pio_model.difftest import CONF_PROGRAMS, REPO  # noqa: E402

FIXTURE = REPO / "web" / "tests" / "pio-asm-golden.json"

# Expression goldens: (text, expected). The division/modulo rows pin C
# truncation toward zero (pioasm is C++; JS `/` floors on negatives).
EXPR_GOLDENS: list[tuple[str, int]] = [
    ("1+2*3", 7),
    ("(1<<4) | N", 17),  # symbol substitution (N=1 below)
    ("-7/2", -3),
    ("7/-2", -3),
    ("-7%2", -1),
    ("7%-2", 1),
    ("0x1f", 31),
    ("0b101", 5),
    ("~0", -1),
    ("1|2^3&7", 1 | (2 ^ (3 & 7))),
    ("255>>2", 63),
]


def build_fixture() -> tuple[dict[str, object], int]:
    """(fixture dict, program count) — the count for the summary line."""
    programs: list[dict[str, object]] = []
    for rel, name in CONF_PROGRAMS:
        src = (REPO / "third_party" / "pico-examples" / rel).read_text()
        prog = next(p for p in asm.parse_text(src, rel) if p.name == name)
        entry: dict[str, object] = {
            "name": name,
            "src": src,
            "sideset": {"bits": prog.sideset_bits, "opt": prog.sideset_opt},
            "words": prog.words,
            "disasm": [disasm.disassemble(w, prog.side_en, prog.sideset_count) for w in prog.words],
        }
        programs.append(entry)
    exprs = []
    for text, want in EXPR_GOLDENS:
        # evaluate with N=1 defined (symbol + precedence in one check)
        exprs.append({"text": text, "symbols": {"N": 1} if "N" in text else {}, "value": want})
        assert asm.eval_expr(text, {"N": 1}) == want, text  # the oracle itself
    return (
        {
            "generator": (
                "tools/gen_pio_asm_golden.py — pio_model C12 asm/disasm (bit-equal to "
                "pioasm 2.3.0 per difftest --asm-check); regenerate after deliberate "
                "pio_model changes, never hand-edit"
            ),
            "programs": programs,
            "exprs": exprs,
        },
        len(programs),
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="diff against the committed fixture")
    args = ap.parse_args()
    fixture, n = build_fixture()
    if args.check:
        # content-wise drift check (deep compare of the parsed JSON):
        # the committed file is biome-formatted (biome collapses short
        # arrays), so bytes are biome's business — content is ours.
        have = json.loads(FIXTURE.read_text())
        if have != fixture:
            print(f"FAIL golden drift: {FIXTURE.relative_to(REPO)} differs from pio_model output")
            print(
                "  regenerate: python3 tools/gen_pio_asm_golden.py && npx biome format --write web/tests/pio-asm-golden.json"
            )
            return 1
        print(f"PASS golden fixture: {n} programs match pio_model asm/disasm bit-for-bit")
        return 0
    FIXTURE.write_text(json.dumps(fixture, indent=2) + "\n")
    print(f"wrote {FIXTURE.relative_to(REPO)}: {n} programs, {len(EXPR_GOLDENS)} expr goldens")
    print("run `npx biome format --write web/tests/pio-asm-golden.json` before committing (biome owns the layout)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

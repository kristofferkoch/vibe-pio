#!/usr/bin/env python3
"""C34 level-golden generator: the level definitions run through pio_model
-> the committed JS fixture web/tests/levels-golden.json.

web/tests/levels.test.js (the levels gate in `make js`) is engine-side:
it drives the shipped level files against ENGINE truth the way
pio-asm-golden.json anchors the assembler — never against itself. The
unit suite has no PIO core (the fake engine is ABI-only by design), so
the engine's answer to "what does this level's program do to the pins"
arrives here, committed: for every level under web/levels/ this tool

  - parses the level file's JSON payload back out (level files are pure
    data registered through PIO_LEVEL — the same object the browser's
    classic script hands the registry),
  - assembles the listing with pio_model's own assembler (bit-equal to
    pioasm 2.3.0 per `make model`'s asm-check) under the level's own
    side-set context,
  - replays the driver's exact load timeline (the _SandboxMirror the
    make-web client gate runs in lockstep with web/engine-driver.js:
    nonzero imem words, per-SM PINCTRL/EXECCTRL/SHIFTCTRL over the
    reset overlay, the SPEC-6-2 settle clk, per-SM CLKDIV/entry/feeds,
    the CTRL enable) and N plain run clks,
  - records the profile pin's level per rendered clk (the same series
    the driver's allPins()/wave window carries — load clks included),
    for the reference program AND the perturbed variants (the gate's
    red cases: a judge that accepts these is a lens, not a judge),
  - records the per-SM config words it composed, so the JS side can pin
    VibeDriver.composeOverlay against the oracle words (the merge over
    hardware-reset values is part of the level format's contract).

Drift guard: `--check` regenerates and deep-compares against the
committed file (wired into `make js` next to gen_pio_asm_golden.py), so
a pio_model change that moves a level's wave cannot leave the fixture
stale. Regenerate with no arguments after a deliberate change (then let
biome own the file's layout: `npx biome format --write` it).

Stdlib-only (pio_model's discipline): `make js` runs this on hosts and
in the container.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

TOOLS = str(Path(__file__).resolve().parent.parent)
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from pio_model import asm, stim  # noqa: E402
from pio_model.difftest import REPO, run_model_trace  # noqa: E402

from webbuild import _SandboxMirror  # noqa: E402  (the client gate's own load-timeline twin)

FIXTURE = REPO / "web" / "tests" / "levels-golden.json"
LEVELS_DIR = REPO / "web" / "levels"
RUN_CLKS = 256  # ~128 periods of the L0 wave: plenty for every tier's stability window

# hardware-reset overlay values (engine-driver.js newSm / model.py *_RESET)
# — the level's overlay merges over these before composing.
RESET: dict[str, dict[str, Any]] = {
    "clkdiv": {"intg": 1, "frac": 0},
    "pinctrl": {"ssCnt": 0, "setCnt": 5, "outCnt": 0, "inBase": 0, "ssBase": 0, "setBase": 0, "outBase": 0},
    "execctrl": {
        "sideEn": False, "sidePindirs": False, "jmpPin": 0, "outEnSel": 0,
        "inlineOutEn": False, "outSticky": False, "wrapTop": 1, "wrapBot": 31,
        "statusSel": 3, "statusN": 31,
    },
    "shiftctrl": {
        "fjoinRx": False, "fjoinTx": False, "pullThr": 32, "pushThr": 32,
        "outRight": True, "inRight": True, "autopull": False, "autopush": False,
        "fjoinRxPut": False, "fjoinRxGet": False, "inCount": 0,
    },
}

# The perturbed variants per level (the gate's red cases). Each entry is
# a (name, listing) pair assembled and loaded exactly like the reference,
# through the level's own overlay.
PERTURBATIONS: dict[str, list[tuple[str, list[str]]]] = {
    "l0": [
        ("both-high", ["set pins, 1", "set pins, 1"]),  # freezes on: the held-wave belief
        ("one-row", ["set pins, 1"]),  # jmp-0 park after row 0: one blink, flat high
        ("flat-low", ["set pins, 0", "set pins, 0"]),  # never rises
    ],
}

LEVEL_RE = re.compile(
    r"globalThis\.PIO_LEVEL\??\.\(\s*'(?P<id>[a-z0-9]+)'\s*,\s*(?P<body>\{.*\})\s*\)\s*;",
    re.S,
)


def parse_level_file(path: Path) -> tuple[str, dict[str, Any]]:
    """The level file's (id, JSON payload) — the object literal is strict
    JSON (the house rule for web/levels/*.js: comments stay outside)."""
    text = path.read_text()
    m = LEVEL_RE.search(text)
    if not m:
        raise SystemExit(f"{path}: no PIO_LEVEL(...) registration found")
    body = re.sub(r",(\s*[}\]])", r"\1", m.group("body"))  # tolerate trailing commas
    return m.group("id"), json.loads(body)


def merged(sm_def: dict[str, Any] | None, group: str) -> dict[str, Any]:
    base = dict(RESET[group])
    for k, v in (sm_def or {}).get(group, {}).items():
        base[k] = v
    return base


def compose_config(sm_def: dict[str, Any] | None) -> dict[str, int | None]:
    """The per-SM reg words the driver's load writes for this level SM
    (stim builders over the merged overlay — the words whose bits the JS
    side pins against VibeDriver.composeOverlay)."""
    pc = merged(sm_def, "pinctrl")
    ex = merged(sm_def, "execctrl")
    sc = merged(sm_def, "shiftctrl")
    cd = merged(sm_def, "clkdiv")
    # stim.execctrl has no out_en_sel/inline_out_en knobs; the driver's
    # compose of them must stay at reset (0/false) for these levels —
    # assert the level never asks for what the stim mirror cannot spell.
    for field in ("outEnSel", "inlineOutEn"):
        if ex[field] != RESET["execctrl"][field]:
            raise SystemExit(f"level overlays {field}: the stim mirror cannot compose it")
    return {
        "pinctrl": stim.pctrl(
            ss_cnt=pc["ssCnt"], set_cnt=pc["setCnt"], out_cnt=pc["outCnt"],
            in_base=pc["inBase"], ss_base=pc["ssBase"], set_base=pc["setBase"],
            out_base=pc["outBase"],
        ),
        "execctrl": stim.execctrl(
            wrap_top=ex["wrapTop"], wrap_bot=ex["wrapBot"], jmp_pin=ex["jmpPin"],
            side_en=ex["sideEn"], side_pindirs=ex["sidePindirs"],
            status_sel=ex["statusSel"], status_n=ex["statusN"], out_sticky=ex["outSticky"],
        ),
        "shiftctrl": stim.shiftctrl(
            fjoin_rx=sc["fjoinRx"], fjoin_tx=sc["fjoinTx"], pull_thr=sc["pullThr"],
            push_thr=sc["pushThr"], out_right=sc["outRight"], in_right=sc["inRight"],
            autopull=sc["autopull"], autopush=sc["autopush"],
            fjoin_rx_put=sc["fjoinRxPut"], fjoin_rx_get=sc["fjoinRxGet"], in_count=sc["inCount"],
        ),
        "clkdiv": stim.clkdiv(cd["intg"], cd["frac"]),
    }


def assemble(listing: list[str], sm_def: dict[str, Any] | None, name: str) -> list[int]:
    """pio_model's assembler under the level's own side-set context."""
    prog = asm.Program(name)
    pc = merged(sm_def, "pinctrl")
    ex = merged(sm_def, "execctrl")
    ss_cnt = pc["ssCnt"] - (1 if ex["sideEn"] else 0)
    prog.sideset_bits = max(0, ss_cnt) if pc["ssCnt"] else None
    prog.sideset_opt = bool(ex["sideEn"]) and pc["ssCnt"] > 0
    words = []
    for i, row in enumerate(listing):
        words.append(asm.assemble_instruction(row, prog, {}, f"{name}:{i}"))
    return words


def pin_series(words: list[int], sms: list[dict[str, Any] | None], pin: int) -> str:
    """The driver's load timeline + RUN_CLKS plain clks, replayed on
    pio_model; the profile pin's level per rendered clk (G records —
    load clks included, exactly what allPins()/the wave window carry)."""
    m = _SandboxMirror()
    m.load(
        words,
        [
            {
                "pinctrl": w["pinctrl"],  # type: ignore[index]
                "execctrl": w["execctrl"],  # type: ignore[index]
                "shiftctrl": w["shiftctrl"],  # type: ignore[index]
                "clkdiv": w["clkdiv"],  # type: ignore[index]
                "feeds": tuple(sms[i].get("feeds", ())),  # type: ignore[union-attr]
                "entry": sms[i].get("entry"),  # type: ignore[union-attr]
                "en": (sms[i] or {}).get("en", True),
            }
            for i, w in enumerate(compose_all(sms))
        ],
    )
    m.run(RUN_CLKS)
    gpio = [rec[2] for rec in run_model_trace(m.s) if rec[0] == "G"]
    return "".join(str((g >> pin) & 1) for g in gpio)


def compose_all(sms: list[dict[str, Any] | None]) -> list[dict[str, int | None]]:
    return [compose_config(sm) for sm in sms]


def generate() -> dict[str, Any]:
    out: dict[str, Any] = {
        "generator": "tools/gen_level_goldens.py",
        "note": (
            "pio_model oracle output for the level campaign — regenerated by"
            " tools/gen_level_goldens.py, drift-checked in make js; words/config"
            " pin the JS side, series feed the monitor judge (levels.test.js)"
        ),
        "levels": {},
    }
    for path in sorted(LEVELS_DIR.glob("*.js")):
        lid, defn = parse_level_file(path)
        sms = defn["program"].get("sms") or [None, None, None, None]
        pin = defn["profile"]["pin"]
        words = new_words(assemble(defn["program"]["listing"], sms[0], lid))
        cases = [{"name": "reference", "listing": defn["program"]["listing"], "series": pin_series(words, sms, pin)}]
        for name, listing in PERTURBATIONS.get(lid, []):
            w = new_words(assemble(listing, sms[0], f"{lid}:{name}"))
            cases.append({"name": name, "listing": listing, "series": pin_series(w, sms, pin)})
        out["levels"][lid] = {
            "words": words,
            "config": [  # per-SM composed reg words (the composeOverlay pin)
                [w["pinctrl"], w["execctrl"], w["shiftctrl"], w["clkdiv"]]  # type: ignore[index]
                for w in compose_all(sms)
            ],
            "cases": cases,
        }
    return out


def new_words(words: list[int]) -> list[int]:
    return words + [0] * (32 - len(words))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="diff against the committed fixture")
    args = ap.parse_args()

    fresh = generate()
    if args.check:
        committed = json.loads(FIXTURE.read_text())
        if committed != fresh:
            print(f"drift: {FIXTURE} does not match pio_model (regenerate and commit)")
            return 1
        print(f"ok: {FIXTURE} matches pio_model")
        return 0
    FIXTURE.write_text(json.dumps(fresh, indent=2) + "\n")
    print(f"wrote {FIXTURE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

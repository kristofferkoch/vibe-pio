// l1.js — the L1 "Metronome" definition (KANBAN C35; chapter 0 of the
// level campaign, mockups/LEVELS-NOTES.md the spec). The fade's first
// rung after L0's worked example: a one-cell modification. The program
// arrives exactly as L0 left it (2 clk per flash) and the monitor now
// times it — the exact tier demands one flash every 8 clk, so the delay
// column debuts as the only editable surface (the side column stays
// hidden: no side-set until chapter 4). The row editor does NOT open
// here — authoring is L2's debut; the listing's delay cell is the whole
// editor (click a row, or Enter/digit from the listing cursor).
//
// Classic script, dependency-free, pure data: it registers through
// PIO_LEVEL (levels.js defines the hook and loads first; the loader in
// sm-view.html writes this tag for ?level=l1 before sm-view.js runs).
// The object payload below is strict JSON — tools/gen_level_goldens.py
// parses it back out to run the program through pio_model — so keep
// comments OUTSIDE the object and the spelling JSON-exact. (That is why
// web/levels/ is outside biome's includes: the payload's format owner
// is the generator's JSON parse, not the JS formatter's quote style.)
globalThis.PIO_LEVEL?.('l1', {
  "id": "l1",
  "name": "Metronome",
  "chapter": 0,
  "goal": "slow the blink to one flash every 8 clk — the program as given flashes every 2",
  "program": {
    "listing": ["set pins, 1", "set pins, 0"],
    "sms": [
      {
        "pinctrl": { "setCnt": 1 },
        "execctrl": { "wrapTop": 1, "wrapBot": 0 }
      },
      { "en": false },
      { "en": false },
      { "en": false }
    ]
  },
  "panels": ["transport", "listing", "wave", "delayCol"],
  "opcodes": [],
  "profile": {
    "kind": "square",
    "v": 1,
    "pin": 0,
    "tier": "exact",
    "tiers": {
      "relaxed": { "periodLo": 6, "periodHi": 10, "dutyLoPct": 30, "dutyHiPct": 70, "minPeriods": 4, "stable": 2 },
      "exact":   { "periodLo": 8, "periodHi": 8,  "dutyLoPct": 40, "dutyHiPct": 60, "minPeriods": 4, "stable": 4 },
      "strict":  { "periodLo": 8, "periodHi": 8,  "dutyLoPct": 50, "dutyHiPct": 50, "minPeriods": 8, "stable": 8 }
    }
  },
  "reference": {
    "listing": ["set pins, 1 [3]", "set pins, 0 [3]"],
    "par": { "words": 2, "period": 8 }
  }
});

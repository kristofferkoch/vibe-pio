// l2.js — the L2 "Author's hand" definition (KANBAN C35; chapter 0 of
// the level campaign, mockups/LEVELS-NOTES.md the spec). Chapter 0's
// generation rung: the listing boots EMPTY (from scratch — all 32 rows
// are honest `·` from cycle one) and the row editor opens in a level
// for the first time, leashed to the unlocked opcode set: completions
// offer `set` only (a filter over C32's slot-aware candidates), and the
// editor's delay cell carries what L1 taught. The side cell is absent —
// no side-set until chapter 4. The task: a 1:3 duty wave, high one clk
// in every four. No predict card: the program is the player's from the
// first keystroke (the gate never locks an authored program).
//
// Classic script, dependency-free, pure data: it registers through
// PIO_LEVEL (levels.js defines the hook and loads first; the loader in
// sm-view.html writes this tag for ?level=l2 before sm-view.js runs).
// The object payload below is strict JSON — tools/gen_level_goldens.py
// parses it back out to run the program through pio_model — so keep
// comments OUTSIDE the object and the spelling JSON-exact. (That is why
// web/levels/ is outside biome's includes: the payload's format owner
// is the generator's JSON parse, not the JS formatter's quote style.)
globalThis.PIO_LEVEL?.('l2', {
  "id": "l2",
  "name": "Author's hand",
  "chapter": 0,
  "goal": "write the wave yourself: gpio0 high one clk in every four — duty 1:3",
  "program": {
    "listing": [],
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
  "opcodes": ["set"],
  "profile": {
    "kind": "square",
    "v": 1,
    "pin": 0,
    "tier": "exact",
    "tiers": {
      "relaxed": { "periodLo": 4, "periodHi": 6, "dutyLoPct": 10, "dutyHiPct": 40, "minPeriods": 4, "stable": 2 },
      "exact":   { "periodLo": 4, "periodHi": 4, "dutyLoPct": 15, "dutyHiPct": 40, "minPeriods": 4, "stable": 4 },
      "strict":  { "periodLo": 4, "periodHi": 4, "dutyLoPct": 24, "dutyHiPct": 26, "minPeriods": 8, "stable": 8 }
    }
  },
  "reference": {
    "listing": ["set pins, 1", "set pins, 0 [2]"],
    "par": { "words": 2, "period": 4 }
  }
});

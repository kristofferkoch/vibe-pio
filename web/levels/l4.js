// l4.js — the L4 "Out of order" definition (KANBAN C37; chapter 1 of
// the level campaign, mockups/LEVELS-NOTES.md the spec — the notes'
// "L4 Scrambler", the Parsons rung). Comprehension by reordering, zero
// generation load: the rows arrive shuffled and the only edit is the
// TRADE — click a row, click another, their contents trade places (the
// keyboard: Enter marks, arrows walk, Enter trades, per the C25
// grammar). The row editor never opens; the given rows are the whole
// vocabulary.
//
// The boot IS the canonical misconception: the once-flash (`set pins, 1
// [7]`) trapped INSIDE the loop, so the flash comes round every period
// (period 14, legibly outside the 8-clk window). The way out reads the
// jmp off the face: `jmp 1` names address 1, so whatever sits at
// address 0 runs exactly once — the flash belongs there. The second
// reading hides in the reference's last two rows: the jmp's own clk
// holds the level of the row before it, so the loop must close on a LOW
// row (the high-before-jmp golden reds at duty 38); and a jmp parked
// mid-listing leaves the rows after it dead (they never execute — the
// dead-rows golden never blinks again).
//
// Classic script, dependency-free, pure data: it registers through
// PIO_LEVEL (levels.js defines the hook and loads first; the loader in
// sm-view.html writes this tag for ?level=l4 before sm-view.js runs).
// The object payload below is strict JSON — tools/gen_level_goldens.py
// parses it back out to run the program through pio_model — so keep
// comments OUTSIDE the object and the spelling JSON-exact. (That is why
// web/levels/ is outside biome's includes: the payload's format owner
// is the generator's JSON parse, not the JS formatter's quote style.)
globalThis.PIO_LEVEL?.('l4', {
  "id": "l4",
  "name": "Out of order",
  "chapter": 1,
  "goal": "the rows arrived shuffled — trade them until the wave is the long flash once, then the blink forever",
  "scramble": true,
  "program": {
    "listing": ["set pins, 1 [1]", "set pins, 0 [2]", "set pins, 1 [7]", "set pins, 0 [1]", "jmp 1"],
    "sms": [
      {
        "pinctrl": { "setCnt": 1 },
        "execctrl": { "wrapTop": 4, "wrapBot": 0 }
      },
      { "en": false },
      { "en": false },
      { "en": false }
    ]
  },
  "panels": ["transport", "listing", "wave", "delayCol"],
  "opcodes": ["set", "jmp"],
  "profile": {
    "kind": "square",
    "v": 1,
    "pin": 0,
    "tier": "exact",
    "tiers": {
      "relaxed": { "periodLo": 6, "periodHi": 10, "dutyLoPct": 15, "dutyHiPct": 60, "minPeriods": 4, "stable": 2 },
      "exact":   { "periodLo": 8, "periodHi": 8,  "dutyLoPct": 15, "dutyHiPct": 35, "minPeriods": 4, "stable": 4 },
      "strict":  { "periodLo": 8, "periodHi": 8,  "dutyLoPct": 24, "dutyHiPct": 26, "minPeriods": 8, "stable": 8 }
    }
  },
  "reference": {
    "listing": ["set pins, 1 [7]", "set pins, 1 [1]", "set pins, 0 [1]", "set pins, 0 [2]", "jmp 1"],
    "par": { "words": 5, "period": 8 }
  }
});

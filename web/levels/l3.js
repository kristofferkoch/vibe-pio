// l3.js — the L3 "Two ways to loop" definition (KANBAN C36; chapter 1 of
// the level campaign, mockups/LEVELS-NOTES.md the spec). jmp debuts with
// a job, not as syntax: the task is one the wrap cannot do. The boot
// ships L2's answer transplanted after a once-preamble (`set pins, 1
// [7]`, row 0) and the wrap stays pinned over the whole listing (0..3,
// steppers locked) — so the wrap loop drags the preamble round every
// period and the exact tier reds it. The way out is a jmp back edge
// that skips row 0: structure, the campaign's first explicit loop
// control. The cost lesson ships with it — the naive port (keep L2's
// delays, add `jmp 1`) runs period 5: jmp eats a slot AND a cycle, wrap
// eats neither. The par line after the solve says 4 words · 4 clk; L2's
// said the same wave in 2 words with no back-edge clk — the player is
// meant to notice the difference.
//
// Classic script, dependency-free, pure data: it registers through
// PIO_LEVEL (levels.js defines the hook and loads first; the loader in
// sm-view.html writes this tag for ?level=l3 before sm-view.js runs).
// The object payload below is strict JSON — tools/gen_level_goldens.py
// parses it back out to run the program through pio_model — so keep
// comments OUTSIDE the object and the spelling JSON-exact. (That is why
// web/levels/ is outside biome's includes: the payload's format owner
// is the generator's JSON parse, not the JS formatter's quote style.)
globalThis.PIO_LEVEL?.('l3', {
  "id": "l3",
  "name": "Two ways to loop",
  "chapter": 1,
  "goal": "one long flash first, then the 1:3 wave forever — the flash must not come round again",
  "program": {
    "listing": ["set pins, 1 [7]", "set pins, 1", "set pins, 0 [2]"],
    "sms": [
      {
        "pinctrl": { "setCnt": 1 },
        "execctrl": { "wrapTop": 3, "wrapBot": 0 }
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
      "relaxed": { "periodLo": 4, "periodHi": 6, "dutyLoPct": 10, "dutyHiPct": 40, "minPeriods": 4, "stable": 2 },
      "exact":   { "periodLo": 4, "periodHi": 4, "dutyLoPct": 15, "dutyHiPct": 40, "minPeriods": 4, "stable": 4 },
      "strict":  { "periodLo": 4, "periodHi": 4, "dutyLoPct": 24, "dutyHiPct": 26, "minPeriods": 8, "stable": 8 }
    }
  },
  "reference": {
    "listing": ["set pins, 1 [7]", "set pins, 1", "set pins, 0 [1]", "jmp 1"],
    "par": { "words": 4, "period": 4 }
  }
});

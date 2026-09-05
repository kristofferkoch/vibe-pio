// l5.js — the L5 "The long blink" definition (KANBAN C36; chapter 1 of
// the level campaign, mockups/LEVELS-NOTES.md the spec). The stretch
// level: the same 1:3 wave as L2, sixteen times slower — gpio0 high 16
// clk in every 64. The lesson is the [31] ceiling and the first feel of
// the 5-bit ds budget (SPEC-4-3): all five bits are delay until
// side-set exists (the allocator itself stays hidden until chapter 4),
// so no single row can wait out the 48-clk low time — the wait must
// split across rows, and the wave must still add up. The listing boots
// empty (from scratch, the L2 discipline); the wrap stays pinned to the
// reference extent (0..2, steppers locked).
//
// waveWin: the wave window is the level's own geometry — 64 clk/cycle
// needs 512 samples for the judge's stability window to see enough
// periods of the slow wave (the sandbox and the earlier levels keep the
// 128-sample default). levels.js validates it; the driver's window
// follows it on level pages.
//
// Classic script, dependency-free, pure data: it registers through
// PIO_LEVEL (levels.js defines the hook and loads first; the loader in
// sm-view.html writes this tag for ?level=l5 before sm-view.js runs).
// The object payload below is strict JSON — tools/gen_level_goldens.py
// parses it back out to run the program through pio_model — so keep
// comments OUTSIDE the object and the spelling JSON-exact. (That is why
// web/levels/ is outside biome's includes: the payload's format owner
// is the generator's JSON parse, not the JS formatter's quote style.)
globalThis.PIO_LEVEL?.('l5', {
  "id": "l5",
  "name": "The long blink",
  "chapter": 1,
  "goal": "the same 1:3 wave, sixteen times slower: one flash every 64 clk — high 16 in every 64",
  "program": {
    "listing": [],
    "sms": [
      {
        "pinctrl": { "setCnt": 1 },
        "execctrl": { "wrapTop": 2, "wrapBot": 0 }
      },
      { "en": false },
      { "en": false },
      { "en": false }
    ]
  },
  "panels": ["transport", "listing", "wave", "delayCol"],
  "opcodes": ["set", "jmp"],
  "waveWin": 512,
  "profile": {
    "kind": "square",
    "v": 1,
    "pin": 0,
    "tier": "exact",
    "tiers": {
      "relaxed": { "periodLo": 48, "periodHi": 80, "dutyLoPct": 20, "dutyHiPct": 60, "minPeriods": 3, "stable": 3 },
      "exact":   { "periodLo": 64, "periodHi": 64, "dutyLoPct": 15, "dutyHiPct": 40, "minPeriods": 4, "stable": 4 },
      "strict":  { "periodLo": 64, "periodHi": 64, "dutyLoPct": 24, "dutyHiPct": 26, "minPeriods": 6, "stable": 6 }
    }
  },
  "reference": {
    "listing": ["set pins, 1 [15]", "set pins, 0 [31]", "set pins, 0 [15]"],
    "par": { "words": 3, "period": 64 }
  }
});

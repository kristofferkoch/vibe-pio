// l0.js — the L0 "First light" definition (KANBAN C34; chapter 0 of the
// level campaign, mockups/LEVELS-NOTES.md the spec). The proof level of
// the vertical slice: a prefilled two-row program, the predict question
// about the wrap, and the square-wave monitor's relaxed tier.
//
// Classic script, dependency-free, pure data: it registers through
// PIO_LEVEL (levels.js defines the hook and loads first; the loader in
// sm-view.html writes this tag for ?level=l0 before sm-view.js runs).
// The object payload below is strict JSON — tools/gen_level_goldens.py
// parses it back out to run the program through pio_model — so keep
// comments OUTSIDE the object and the spelling JSON-exact. (That is why
// web/levels/ is outside biome's includes: the payload's format owner
// is the generator's JSON parse, not the JS formatter's quote style.)
globalThis.PIO_LEVEL?.('l0', {
  "id": "l0",
  "name": "First light",
  "chapter": 0,
  "goal": "hold the wave square: the light on gpio0 must keep blinking",
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
  "panels": ["transport", "listing", "wave"],
  "opcodes": [],
  "profile": {
    "kind": "square",
    "v": 1,
    "pin": 0,
    "tier": "relaxed",
    "tiers": {
      "relaxed": {
        "periodLo": 2,
        "periodHi": 128,
        "dutyLoPct": 20,
        "dutyHiPct": 80,
        "minPeriods": 4,
        "stable": 2
      },
      "exact": {
        "periodLo": 2,
        "periodHi": 2,
        "dutyLoPct": 40,
        "dutyHiPct": 60,
        "minPeriods": 4,
        "stable": 4
      },
      "strict": {
        "periodLo": 2,
        "periodHi": 2,
        "dutyLoPct": 50,
        "dutyHiPct": 50,
        "minPeriods": 8,
        "stable": 8
      }
    }
  },
  "predict": {
    "ask": "the PC has passed the last row — what happens to the light next?",
    "answer": "repeats",
    "candidates": [
      {
        "id": "repeats",
        "label": "it keeps blinking — the program runs again",
        "bits": "0010101010101010"
      },
      {
        "id": "dark",
        "label": "one blink, then dark — the program is over",
        "bits": "0010000000000000"
      },
      {
        "id": "held",
        "label": "it stays lit — the light freezes on",
        "bits": "0011111111111111"
      }
    ]
  },
  "reference": { "par": { "words": 2, "period": 2 } }
});

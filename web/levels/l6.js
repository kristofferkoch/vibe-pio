// l6.js — the L6 "Listen" definition (KANBAN C39; chapter 2 of the level
// campaign, mockups/LEVELS-NOTES.md the spec). The reading slice: the
// world arrives on a wire. The level drives gpio1 with a square pattern
// (period 4 — 2 clk low, 2 clk high, drawn on the wave's own stimulus
// row above the lens row), and the given program is the whole lesson:
// `in pins, 1` shifts the pin's bit into the ISR (the gatherer debuts,
// at bit 31 under IN_SHIFTDIR's reset-right), `push` hands the word to
// the RX FIFO and clears the ISR; the wrap does it again every 2 clk.
// The RX FIFO is 4 deep — the fifth push stalls on a full FIFO (the
// honest machine), so acceptance is the FIRST FOUR pushed words against
// the driven pattern's first four sampled bits (1,0,1,0 — the RX judge,
// exact by design: a value has no tolerance).
//
// The predict question is the misconception inoculation: which end of
// the ISR does the bit land in? The candidates are bit-word rows (the
// ISR panel's own bits grammar) — bit 31 (the truth under shift-right),
// bit 0 (the enters-at-the-start belief), and all zeros (the
// push-clears-before-it-arrives belief).
//
// Classic script, dependency-free, pure data: it registers through
// PIO_LEVEL (levels.js defines the hook and loads first; the loader in
// sm-view.html writes this tag for ?level=l6 before sm-view.js runs).
// The object payload below is strict JSON — tools/gen_level_goldens.py
// parses it back out to run the program through pio_model — so keep
// comments OUTSIDE the object and the spelling JSON-exact. (That is why
// web/levels/ is outside biome's includes: the payload's format owner
// is the generator's JSON parse, not the JS formatter's quote style.)
globalThis.PIO_LEVEL?.('l6', {
  "id": "l6",
  "name": "Listen",
  "chapter": 2,
  "goal": "listen: the world waves at gpio1 — every pass, row 0 reads one bit into the ISR and row 1 pushes it to the RX FIFO",
  "program": {
    "listing": ["in pins, 1", "push block"],
    "sms": [
      {
        "pinctrl": { "inBase": 1 },
        "execctrl": { "wrapTop": 1, "wrapBot": 0 }
      },
      { "en": false },
      { "en": false },
      { "en": false }
    ]
  },
  "panels": ["transport", "listing", "wave", "isr", "rxfifo"],
  "opcodes": [],
  "stimulus": [
    {
      "mode": "square",
      "pin": 1,
      "period": 4
    }
  ],
  "profile": {
    "kind": "rx",
    "v": 1,
    "pin": 1,
    "words": [2147483648, 0, 2147483648, 0]
  },
  "predict": {
    "ask": "the first word push hands to the RX FIFO — what arrives?",
    "face": "isr",
    "answer": "msb",
    "candidates": [
      {
        "id": "msb",
        "label": "the bit lands at the far end — bit 31",
        "bits": "10000000000000000000000000000000"
      },
      {
        "id": "lsb",
        "label": "the bit lands at the start — bit 0",
        "bits": "00000000000000000000000000000001"
      },
      {
        "id": "zero",
        "label": "all zeros — push empties the ISR before it arrives",
        "bits": "00000000000000000000000000000000"
      }
    ]
  },
  "reference": { "par": { "words": 2, "period": 2 } }
});

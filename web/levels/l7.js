// l7.js — the L7 "Echo" definition (KANBAN C40; chapter 2 of the level
// campaign, mockups/LEVELS-NOTES.md the spec). jmp pin gets its job: the
// first conditional, reacting to the world. The level drives a byte's
// UART frame on gpio2 (start 0, D0..D7 LSB-first 0x33, stop 1 — one
// symbol every 8 clk, inside the enable square's high window) and the
// task is the echo: copy the frame onto gpio0.
//
// The copy in the level's vocabulary (set+in+out+jmp) is the branchy
// pair — `jmp pin` tests the data pin (JMP_PIN = gpio2, the first
// conditional jump of the campaign), `set pins` drives its value, and
// the delays hold each bit for its whole bit-time. The reference rides
// the `·` row home: the high path's set returns through the empty row
// 3, a free jmp 0 that still costs its clk (the L5 lesson recurring —
// budgeted into the [5]), so the honest form is 3 words, not 4. That
// rate IS the gate the player writes: the ungated copy (the racer, no
// delays) resamples every 2-3 clk and its runs skew outside the
// judge's [8,8] window; the 9/8 loop drifts and drops a bit (the
// relaxed tier decodes a different byte and names it). `out` cannot
// copy — the OSR is empty without a pull, and the in/out-belief golden
// shows it: the line never rises. The monitor flips to receiver
// conformance here: the decode judge (kind 'uart', SPEC-16-9 run
// semantics) reads the OUTPUT wave, expected bytes = the driven data,
// and the frame map rides the wave as the subgoal labels
// (START/D0..D7/STOP under the uart lens at the frame's own 8 clk/bit).
//
// One reshape vs the card, on the machine's own evidence: the enable
// square is drawn and narrated (the speaking window) but never tested
// by the program — one JMP_PIN can name one wire, and with no `mov`
// and no `pull` the branchy pair testing the DATA pin is the only copy
// the vocabulary has (model-verified: in+out drives zeros forever).
// "Hold when enable drops" lands as the quiet tail — the world holds
// the stop level through the disable windows and the echo holds with
// it, the sticky gpio_out doing the freezing.
//
// Classic script, dependency-free, pure data: it registers through
// PIO_LEVEL (levels.js defines the hook and loads first; the loader in
// sm-view.html writes this tag for ?level=l7 before sm-view.js runs).
// The object payload below is strict JSON — tools/gen_level_goldens.py
// parses it back out to run the program through pio_model — so keep
// comments OUTSIDE the object and the spelling JSON-exact. (That is why
// web/levels/ is outside biome's includes: the payload's format owner
// is the generator's JSON parse, not the JS formatter's quote style.)
globalThis.PIO_LEVEL?.('l7', {
  "id": "l7",
  "name": "Echo",
  "chapter": 2,
  "goal": "the world drives a byte's frame on gpio2 while enable speaks on gpio1 — echo it onto gpio0 one bit per 8-clk bit-time; hold the line between frames",
  "program": {
    "listing": [],
    "sms": [
      {
        "pinctrl": { "setCnt": 1, "outCnt": 1, "inBase": 2 },
        "execctrl": { "jmpPin": 2, "wrapTop": 1, "wrapBot": 0 }
      },
      { "en": false },
      { "en": false },
      { "en": false }
    ]
  },
  "panels": ["transport", "listing", "wave", "delayCol", "frameMap", "isr", "rxfifo"],
  "opcodes": ["set", "in", "out", "jmp"],
  "conds": ["pin"],
  "stimulus": [
    {
      "mode": "square",
      "pin": 1,
      "period": 160
    },
    {
      "mode": "bits",
      "pin": 2,
      "bits": "1111111111111111111111111111111111111111111111111111111111111111111111111111111100000000111111111111111100000000000000001111111111111111000000000000000011111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111"
    }
  ],
  "profile": {
    "kind": "uart",
    "v": 1,
    "pin": 0,
    "tier": "exact",
    "bytes": [51],
    "tiers": {
      "relaxed": { "bitLo": 6, "bitHi": 10 },
      "exact": { "bitLo": 8, "bitHi": 8 },
      "strict": { "bitLo": 8, "bitHi": 8 }
    }
  },
  "reference": {
    "listing": ["jmp pin, 2", "set pins, 0 [6]", "set pins, 1 [5]"],
    "par": { "words": 3, "period": 8 }
  }
});

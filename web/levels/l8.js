// l8.js — the L8 "Fencepost" definition (KANBAN C41; chapter 2 of the
// level campaign, mockups/LEVELS-NOTES.md the spec). The designed
// off-by-one: `set x` + `jmp x--` to gather exactly N bits of the
// driven pattern, then `push`. SPEC-3.1-4 is the whole lesson — the
// condition tests X's PRE-decrement value and decrements regardless,
// so the X=1 jump still fires and `set x, N` gathers N+1 bits. The
// near-miss is legible BY DESIGN: the pattern is a 2-clk low tick
// followed by sixteen 1s (period 18 clk), the correct word reads
// 11111110 (0xFE — the tick's 0 plus seven 1s), one-bit-too-many
// pushes 11111111 (the extra 1 shifted the 0 off the end — the
// verdict lands at bit 24), one-bit-too-few pushes 1111110 (a 1
// missing at bit 25): the decoded value itself shows the off-by-one,
// never a mystery red.
//
// The gather lap is exactly 18 clk (set 1 + in/jmp ×8 = 16 + push 1),
// the pattern's own period, so every lap samples the same phase and
// pushes the same word — the fifth push stalls on the full FIFO,
// L6's honest-machine story recurring. The X/Y scratch panel debuts
// here (the stepper role — Sajaniemi's roles-in-use: each register
// debuts in the level whose task needs it): #xy shows X counting down
// while the gather runs. The delay column stays SHUT — structure, not
// delay, is the lesson.
//
// The goal NUDGES, never tells (owner review 2026-09-07): it states
// the task (8 sampled bits to one pushed word) and points at the new
// surface (registers exist; set and jmp reach them), but names no
// recipe and no decrement semantics — the fencepost lesson is the
// DECODED NEAR-MISS's to teach, not the brief's to spoil.
//
// Classic script, dependency-free, pure data: it registers through
// PIO_LEVEL (levels.js defines the hook and loads first; the loader in
// sm-view.html writes this tag for ?level=l8 before sm-view.js runs).
// The object payload below is strict JSON — tools/gen_level_goldens.py
// parses it back out to run the program through pio_model — so keep
// comments OUTSIDE the object and the spelling JSON-exact. (That is why
// web/levels/ is outside biome's includes: the payload's format owner
// is the generator's JSON parse, not the JS formatter's quote style.)
globalThis.PIO_LEVEL?.('l8', {
  "id": "l8",
  "name": "Fencepost",
  "chapter": 2,
  "goal": "count the gather: the world ticks its bits on gpio1 — exactly 8 sampled bits make the word push hands to the RX FIFO; the machine has registers now, and set and jmp can reach them",
  "program": {
    "listing": [],
    "sms": [
      {
        "pinctrl": { "inBase": 1 },
        "execctrl": { "wrapTop": 3, "wrapBot": 0 }
      },
      { "en": false },
      { "en": false },
      { "en": false }
    ]
  },
  "panels": ["transport", "listing", "wave", "isr", "rxfifo", "xy"],
  "opcodes": ["set", "in", "push", "jmp"],
  "conds": ["x--"],
  "stimulus": [
    {
      "mode": "bits",
      "pin": 1,
      "bits": "0011111111111111110011111111111111110011111111111111110011111111111111110011111111111111110011111111111111110011111111111111110011111111111111110011111111111111110011111111111111110011111111111111110011111111111111110011111111111111110011111111111111110011"
    }
  ],
  "profile": {
    "kind": "rx",
    "v": 1,
    "pin": 1,
    "words": [4261412864, 4261412864, 4261412864, 4261412864]
  },
  "reference": {
    "listing": ["set x, 7", "in pins, 1", "jmp x--, 1", "push block"],
    "par": { "words": 4, "period": 2 }
  }
});

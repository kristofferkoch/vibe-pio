// l9.js — the L9 "Words" definition (KANBAN C44; chapter 3 of the level
// campaign, mockups/LEVELS-NOTES.md the spec). The feeder opens: the
// world stops waving on a wire and starts leaving WORDS — four of them,
// preloaded on the TX FIFO (the demo's own feeds machinery, static and
// read-only forever). The given program is the reading slice's TX twin:
// row 0 pulls one word into the OSR every lap, row 1 shifts ONE bit of
// it (bit 0 — LSB first under the reset shift-right) to gpio0, and the
// wrap does it again every 2 clk.
//
// The dry-out is terminal (the 2026-09-08 grilling): after the fourth
// word the fifth pull stalls forever — the L6 honest-machine story on
// the TX side — and the stall IS the lesson. The PRIMM Investigate verb
// debuts as its own face: a post-stall commit riding the predict card's
// grammar (candidates, one commit), while the existing stall narration
// (the chip, the banner, the tooltips) stays as the evidence it points
// at. The monitor is the tx judge — the rx twin over the PULLED words,
// exact by design — narrating the dry-out ("3 of 4 words in"); it never
// fires the pass. The PASS is the investigate commit: say why the
// machine stopped.
//
// The fed bytes are the fiction's first payload fragment (the bible
// round's ch3 slice, 2026-09-08): plain ASCII in the previous owner's
// mundane-warm register, anonymous for now — practice-payload data that
// rereads as a person having been here. 'hey!' — deniable-as-demo-data
// is the fence: the demo's own 'PIO!' pattern, but theirs. A wrong bit
// stays a garbled glyph on the face that decodes (L10's); here the
// bytes ride the FIFO panel's hex/ASCII slots and one bit of each
// reaches the wire.
//
// The predict question is the shift-direction inoculation: which bit of
// each word does `out` reach first? Bit 0 (the truth under
// OUT_SHIFTDIR's reset right), bit 31 (the far-end belief — all four
// MSBs read 0, the wire never moves), or the whole-word drain (the OSR
// empties before the next pull — exactly the serialization L10 will
// teach, believed one level early).
//
// Classic script, dependency-free, pure data: it registers through
// PIO_LEVEL (levels.js defines the hook and loads first; the loader in
// sm-view.html writes this tag for ?level=l9 before sm-view.js runs).
// The object payload below is strict JSON — tools/gen_level_goldens.py
// parses it back out to run the program through pio_model — so keep
// comments OUTSIDE the object and the spelling JSON-exact. (That is why
// web/levels/ is outside biome's includes: the payload's format owner
// is the generator's JSON parse, not the JS formatter's quote style.)
globalThis.PIO_LEVEL?.('l9', {
  "id": "l9",
  "name": "Words",
  "chapter": 3,
  "goal": "four words wait in the feed — every lap row 0 pulls one into the OSR and row 1 shifts one bit of it to gpio0; run the feed down, and when the machine stops, say why",
  "program": {
    "listing": ["pull block", "out pins, 1"],
    "sms": [
      {
        "pinctrl": { "outCnt": 1 },
        "execctrl": { "wrapTop": 1, "wrapBot": 0 },
        "feeds": [104, 101, 121, 33]
      },
      { "en": false },
      { "en": false },
      { "en": false }
    ]
  },
  "panels": ["transport", "listing", "wave", "txfifo", "pullConn", "osr"],
  "opcodes": [],
  "profile": {
    "kind": "tx",
    "v": 1,
    "pin": 0,
    "words": [104, 101, 121, 33]
  },
  "predict": {
    "ask": "every lap row 0 pulls one word and row 1 shifts a single bit of it to gpio0 — which bit reaches the wire?",
    "face": "wave",
    "answer": "lsb",
    "candidates": [
      {
        "id": "lsb",
        "label": "each word's near end — bit 0 — shifts out first",
        "bits": "0011111111111111111111111111"
      },
      {
        "id": "msb",
        "label": "each word's far end — bit 31 — shifts out first",
        "bits": "0000000000000000000000000000"
      },
      {
        "id": "drain",
        "label": "the whole first word streams out, one bit per lap, before the next pull",
        "bits": "0000000011000011110000000000"
      }
    ]
  },
  "investigate": {
    "ask": "the machine has stopped — the cursor sits on row 0 and the chip reads red. why did it stop?",
    "answer": "dry",
    "candidates": [
      {
        "id": "dry",
        "label": "the feed ran dry — pull waits on an empty TX FIFO for a word that is not coming"
      },
      {
        "id": "done",
        "label": "the program is finished — the listing ran out of rows to run"
      },
      {
        "id": "full",
        "label": "the FIFO is full — the machine made too many words for it"
      }
    ]
  },
  "reference": { "par": { "words": 2, "period": 2 } }
});

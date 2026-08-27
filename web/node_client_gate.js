// node_client_gate.js — headless C18 client gate (KANBAN C18).
//
// Runs the shipped client core (web/engine-driver.js — the same module
// the browser worker uses) against the wasm engine and checks it
// against the pio_model oracle: the gate's expected.json carries the
// golden pin series (gpio_out bit0 per clk, from the model's SPEC-16-7
// G records) and the final FLEVEL read for the identical load timeline.
//
// Checks:
//   asm    — the C19 in-browser assembler reproduces the level's words
//            bit-exactly (assemble(disassemble(w)) per word under the
//            level's .side_set — the shipped listing path sm-view.js
//            renders and re-assembles through);
//   pins   — the driver's per-cycle pin samples equal the model series
//            (every rendered clk, load cycles included);
//   flevel — the driver's reg-read FLEVEL equals the model's R record;
//   mon    — the receiver monitor decoded 'PIO!' (4 bytes);
//   mirror — the TX contents mirror level equals the engine tx_level.
//
// Exit nonzero on the first failing check — the C18 mutation demos
// (--defect=pin / --defect=mirror, the driver's red-injection hooks)
// rely on that.
//
// Usage: node node_client_gate.js <pio_engine.js> <expected.json> [--defect=pin|mirror]

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const defectArg = argv.find((a) => a.startsWith('--defect='));
const defects = defectArg ? { [defectArg.slice(9)]: true } : {};
const engineJs = argv[0];
const expPath = argv[1];
if (!engineJs || !expPath) {
  console.error(
    'usage: node node_client_gate.js <pio_engine.js> <expected.json> [--defect=pin|mirror]',
  );
  process.exit(2);
}

const VibeDriver = require(path.resolve(__dirname, 'engine-driver.js'));
const PioAsm = require(path.resolve(__dirname, 'pio-asm.js'));
const PioEngine = require(path.resolve(engineJs));
const expected = JSON.parse(fs.readFileSync(expPath, 'utf8'));
const RUN_CLKS = expected.runClks;

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`PASS ${name}${detail ? ` (${detail})` : ''}`);
  else {
    failed = true;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

PioEngine()
  .then((M) => {
    const drv = VibeDriver.create(M, defects);
    drv.load();

    // C19: the shipped listing path — canonical disassembly of the
    // level words under the level's .side_set must re-assemble into the
    // same bits (sm-view.js derives its listing exactly this way).
    const { LEVEL } = VibeDriver;
    const prog = PioAsm.createProgram('gate');
    prog.sidesetBits = LEVEL.sideBits;
    prog.sidesetOpt = LEVEL.opt;
    const rebuilt = LEVEL.words.map((w) =>
      PioAsm.assembleInstruction(
        PioAsm.disassemble(w, prog.sideEn, prog.sidesetCount),
        prog,
        {},
        'gate',
      ),
    );
    check(
      'asm round-trip of the level listing',
      rebuilt.every((w, i) => w === LEVEL.words[i]),
      rebuilt.map((w, i) => `0x${w.toString(16)} vs 0x${LEVEL.words[i].toString(16)}`).join(' '),
    );

    drv.run(RUN_CLKS);
    const flevel = drv.readFlevel();
    const st = drv.getState();

    const pins = drv.allPins();
    check(
      'pins series vs pio_model',
      pins.length === expected.pins.length && pins.every((p, i) => p === expected.pins[i]),
      pins.length !== expected.pins.length
        ? `length ${pins.length} vs ${expected.pins.length}`
        : (() => {
            const i = pins.findIndex((p, k) => p !== expected.pins[k]);
            return i < 0 ? `${pins.length} clks equal` : `first divergence at clk ${i}`;
          })(),
    );
    check(
      'flevel read vs pio_model',
      flevel === expected.flevel,
      `0x${flevel.toString(16)} vs 0x${expected.flevel.toString(16)}`,
    );
    check('monitor decoded', st.monitor.decoded === 'PIO!', JSON.stringify(st.monitor.decoded));
    check(
      'tx mirror vs engine level',
      st.txWords.length === st.txLevel,
      `mirror ${st.txWords.length} vs engine ${st.txLevel}`,
    );

    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(String(err));
    process.exit(1);
  });

// node_client_gate.js — headless C18/C21 client gate (KANBAN C18/C21).
//
// Runs the shipped client core (web/engine-driver.js — the same module
// the browser worker uses) against the wasm engine and checks it against
// the pio_model oracle. The gate's expected.json (from
// tools/webbuild.py) carries, per leg, the golden full gpio_out word
// series (SPEC-16-7 G records — every rendered clk, load cycles
// included) and the ordered reg-read records (addr + rdata), produced by
// the python mirror of the driver's clocking rules for the identical leg
// script. The legs and their mirrors are written 1:1 — keep the call
// sequences in both files identical:
//
//   uart_demo       the demoted level-02 fixture (the C18 leg): the
//                   'PIO!' decode, the FLEVEL read, the TX mirror;
//   pin_echo        manual pin drives + the square pattern generator
//                   through a mov-pins echo program (set pindirs, in/out
//                   mapping), with the square lens verdict on the echoed
//                   wave;
//   clkdiv_frac     a set-pins squarewave behind CLKDIV INT=2 FRAC=128
//                   (SPEC-7-14) — the divided timeline;
//   join_rx_drain   the sampler program (in pins,1 [7] + autopush @8):
//                   a pasted-bitstream frame on the input pin, RXF0
//                   drains, a mid-run FJOIN_RX overlay edit (flush + the
//                   SPEC-6-2 settle clk), more drains into the 8-deep;
//   aux_putget      FJOIN_RX_PUT: the SM PUTs ISR into the RX storage
//                   (mov rxfifo[y], isr), the system reads it back
//                   through the RXF0_PUTGET window (SPEC-7-13).
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

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`PASS ${name}${detail ? ` (${detail})` : ''}`);
  else {
    failed = true;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---- leg helpers (the python twins: webbuild.py _leg_*/_SandboxMirror)
function asmWords(lines) {
  const prog = PioAsm.createProgram('gate');
  return lines.map((t) => PioAsm.assembleInstruction(t, prog, {}, 'gate'));
}

function legState(lines, over) {
  const st = VibeDriver.newState();
  st.words = asmWords(lines).concat(new Array(32 - lines.length).fill(0));
  Object.assign(st.pinctrl, over.pinctrl || {});
  Object.assign(st.execctrl, over.execctrl || {});
  Object.assign(st.shiftctrl, over.shiftctrl || {});
  Object.assign(st.clkdiv, over.clkdiv || {});
  if (over.feeds) st.feeds = over.feeds.slice();
  if (over.entry != null) st.entry = over.entry;
  if (over.lens) st.lens = { ...over.lens };
  return st;
}

// One 8N1 frame as a pasted bitstream (8 clks/bit, idle-high prefix) —
// the pattern-generator stimulus of the drain legs.
function frameBits(byte, idleCells = 2) {
  const cells = [];
  for (let i = 0; i < idleCells; i++) cells.push(1);
  cells.push(0);
  for (let i = 0; i < 8; i++) cells.push((byte >> i) & 1);
  cells.push(1);
  const bits = [];
  for (const c of cells) for (let k = 0; k < 8; k++) bits.push(c);
  return bits;
}

// ---- the legs (mirror each _leg_* in tools/webbuild.py 1:1) -----------
const LEGS = {
  uart_demo(drv) {
    drv.load(VibeDriver.DEMO_UART_TX); // lens uart@0 preset by the demo
    drv.run(360);
    drv.readFlevel();
    const st = drv.getState();
    return {
      gpio: drv.allGpio(),
      pins: drv.allPins(), // the lens-pin series the driver sampled
      lensPin: 0, // the demo lens
      reads: st.readLog.map(({ addr, rdata }) => [addr, rdata]),
      decoded: st.monitor.decoded,
      txMirror: st.txWords.length === st.txLevel,
    };
  },

  pin_echo(drv) {
    const st = legState(['set pindirs, 1', 'mov pins, pins', 'jmp 1'], {
      pinctrl: { setCnt: 1, inBase: 3 },
      execctrl: { wrapTop: 2, wrapBot: 1, statusSel: 0, statusN: 0 },
    });
    drv.load(st);
    drv.setDrive(3, 1);
    drv.run(12);
    drv.setDrive(3, 0);
    drv.run(9);
    drv.setDrive(3, 1);
    drv.run(7);
    drv.setPattern({ mode: 'square', pin: 4, period: 16 });
    drv.setLens({ mode: 'square', pin: 1 }); // the echo of pin4 on out pin1
    drv.run(64);
    drv.readFlevel();
    const s = drv.getState();
    return {
      gpio: drv.allGpio(),
      pins: drv.allPins(),
      lensPin: 1, // the square lens targets the echo pin
      reads: s.readLog.map(({ addr, rdata }) => [addr, rdata]),
      square: s.monitor.square,
    };
  },

  clkdiv_frac(drv) {
    const st = legState(['set pins, 1 [3]', 'set pins, 0 [3]', 'jmp 0'], {
      pinctrl: { setCnt: 1 },
      execctrl: { wrapTop: 2, wrapBot: 0, statusSel: 0, statusN: 0 },
      clkdiv: { intg: 2, frac: 128 },
    });
    drv.load(st);
    drv.run(150);
    drv.readFlevel();
    const s = drv.getState();
    return {
      gpio: drv.allGpio(),
      pins: drv.allPins(),
      reads: s.readLog.map(({ addr, rdata }) => [addr, rdata]),
    };
  },

  join_rx_drain(drv) {
    const st = legState(['in pins, 1 [7]', 'jmp 0'], {
      pinctrl: { inBase: 5 },
      execctrl: { wrapTop: 1, wrapBot: 0, statusSel: 0, statusN: 0 },
      shiftctrl: { autopush: true, pushThr: 8 },
    });
    drv.load(st);
    drv.setPattern({ mode: 'bits', pin: 5, bits: frameBits(0x55) }); // 'U'
    drv.run(208); // ~3 sample groups land in the 4-deep RX
    drv.drainRx(2);
    drv.run(2);
    drv.readFlevel(); // 1 word remains
    drv.setOverlayField('shiftctrl', 'fjoinRx', true); // flush + settle
    drv.run(2); // the SHIFTCTRL write clk + the SPEC-6-2 settle clk
    drv.run(520); // ~8 sample groups into the 8-deep RX
    drv.drainRx(6);
    drv.run(6);
    drv.readFlevel();
    const s = drv.getState();
    return {
      gpio: drv.allGpio(),
      pins: drv.allPins(),
      reads: s.readLog.map(({ addr, rdata }) => [addr, rdata]),
      rxMirror: s.rxMirror.ok,
    };
  },

  aux_putget(drv) {
    const st = legState(['set y, 0', 'in pins, 8 [1]', 'mov rxfifo[y], isr', 'jmp 1'], {
      pinctrl: { inBase: 5 },
      execctrl: { wrapTop: 3, wrapBot: 1, statusSel: 0, statusN: 0 },
      shiftctrl: { fjoinRxPut: true },
    });
    drv.load(st);
    const drives = { 5: 1, 6: 0, 7: 1, 8: 1, 9: 0, 10: 1, 11: 0, 12: 1 };
    for (const [pin, lvl] of Object.entries(drives)) drv.setDrive(+pin, lvl);
    drv.run(16);
    drv.readRegNow(VibeDriver.REG.PUTGET0); // 0xAD000000: pins 12..5 as ISR[31:24]
    drv.readRegNow(VibeDriver.REG.PUTGET0 + 4); // storage 1: never written
    drv.setDrive(5, 0);
    drv.setDrive(12, 0); // flip both end pins
    drv.run(16);
    drv.readRegNow(VibeDriver.REG.PUTGET0); // 0x2C000000 after the flip
    const s = drv.getState();
    return {
      gpio: drv.allGpio(),
      pins: drv.allPins(),
      reads: s.readLog.map(({ addr, rdata }) => [addr, rdata]),
    };
  },
};

PioEngine()
  .then((M) => {
    for (const [name, leg] of Object.entries(LEGS)) {
      const drv = VibeDriver.create(M, defects);
      const got = leg(drv);
      const exp = expected.legs[name];
      if (!exp) {
        check(`${name} expected`, false, 'no oracle entry');
        continue;
      }
      // the watch-pin bit series the DRIVER sampled (the C18 check,
      // kept: comparing the driver's own series — not bits re-derived
      // from the raw words — is what gives the pin-sampling defect
      // hooks their bite)
      const pin = got.lensPin ?? 0;
      check(
        `${name} pin series vs pio_model`,
        got.pins.length === exp.gpio.length &&
          got.pins.every((p, i) => p === ((exp.gpio[i] >>> pin) & 1)),
        got.pins.length !== exp.gpio.length
          ? `length ${got.pins.length} vs ${exp.gpio.length}`
          : (() => {
              const i = got.pins.findIndex((p, k) => p !== ((exp.gpio[k] >>> pin) & 1));
              return i < 0
                ? `bit${pin}, ${got.pins.length} clks equal`
                : `bit${pin} diverges at clk ${i}`;
            })(),
      );
      check(
        `${name} gpio series vs pio_model`,
        got.gpio.length === exp.gpio.length && got.gpio.every((g, i) => g >>> 0 === exp.gpio[i]),
        got.gpio.length !== exp.gpio.length
          ? `length ${got.gpio.length} vs ${exp.gpio.length}`
          : (() => {
              const i = got.gpio.findIndex((g, k) => g >>> 0 !== exp.gpio[k]);
              return i < 0
                ? `${got.gpio.length} clks equal`
                : `first divergence at clk ${i}: 0x${(got.gpio[i] >>> 0).toString(16)} vs 0x${exp.gpio[i].toString(16)}`;
            })(),
      );
      if (exp.reads) {
        check(
          `${name} reg reads vs pio_model`,
          got.reads.length === exp.reads.length &&
            got.reads.every(([a, v], i) => a === exp.reads[i][0] && v >>> 0 === exp.reads[i][1]),
          got.reads.length !== exp.reads.length
            ? `${got.reads.length} vs ${exp.reads.length} reads`
            : got.reads
                .map(([a, v], i) =>
                  a === exp.reads[i][0] && v >>> 0 === exp.reads[i][1]
                    ? ''
                    : `read ${i} @0x${a.toString(16)}: 0x${(v >>> 0).toString(16)} vs 0x${exp.reads[i][1].toString(16)}`,
                )
                .filter(Boolean)
                .join('; ') || `${got.reads.length} reads equal`,
        );
      }
      if (exp.decoded !== undefined)
        check(`${name} lens decoded`, got.decoded === exp.decoded, JSON.stringify(got.decoded));
      if (exp.square !== undefined)
        check(
          `${name} square lens verdict`,
          got.square &&
            got.square.period === exp.square.period &&
            got.square.dutyPct === exp.square.dutyPct,
          got.square ? `period ${got.square.period} duty ${got.square.dutyPct}%` : 'no verdict',
        );
      if (exp.txMirror !== undefined) check(`${name} tx mirror`, got.txMirror === true);
      if (exp.rxMirror !== undefined) check(`${name} rx mirror`, got.rxMirror === true);
    }
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(String(err));
    process.exit(1);
  });

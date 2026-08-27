// engine-driver.js — the C18 client core (KANBAN C18).
//
// Pure logic, no DOM and no Worker API: the same instance runs inside
// web/engine-worker.js (the browser client) and under node
// (web/node_client_gate.js) — the CI gate therefore checks exactly what
// the view renders. The engine itself is the verified RTL (the C17
// wasm build); this driver never re-implements PIO semantics, it only
//
//   - drives the game face (pio_reg_write / pio_reg_read / pio_step) —
//     loading a program + config overlay is just reg-bus writes
//     (SPEC-7-10/14..26), one retired clk each, every cycle rendered;
//   - decodes the pre-edge PioCycle sample (pio_shim.cpp: the negedge
//     sample point — CC-40 pin landing, start-of-clk SM state);
//   - keeps the TX-FIFO CONTENTS mirror (display bookkeeping only:
//     the words this client wrote minus the engine's tx_pop strobes —
//     the level bar always shows the engine's tx_level);
//   - runs the receiver-style frame monitor + per-cycle waveform tags
//     (mockups/sm-view.html's monitor, over true engine pin samples).
//
// Red-injection hooks for the C18 mutation demo (never enabled in a
// real run; web/node_client_gate.js turns them on via create()'s
// `defects` argument):
//   {pin: true}    — sample gpio_out bit 1 instead of bit 0: the pin
//                    series diverges from the model oracle;
//   {mirror: true} — the TX mirror never pops: it disagrees with the
//                    engine's tx_level.

/* global PioEngine */
((global) => {
  'use strict';

  // ---- register map (SPEC-7-x; mirrors tools/pio_model/stim.py) ----
  const REG = {
    CTRL: 0x000,
    FSTAT: 0x004,
    FLEVEL: 0x00c,
    TXF0: 0x010,
    IMEM0: 0x048, // + 4*i (SPEC-7-10)
    SM0: 0x0c8, // + CLKDIV 0 / EXECCTRL 4 / SHIFTCTRL 8 / INSTR 16 / PINCTRL 20
  };

  // u_exec onehot FSM (rtl/pio_sm_exec.sv)
  const ST = { FETCH: 1, EXEC: 2, STALL: 4, DELAY: 8 };

  // PioCycle strobe bits (pio_shim.cpp)
  const S_TICK = 1,
    S_EXEC = 2,
    S_COMPLETE = 4,
    S_PC_WR = 8,
    S_TX_POP = 16,
    S_RX_PUSH = 32,
    S_TX_EMPTY = 64,
    S_TX_FULL = 128;

  // PioCycle struct offsets in bytes (pio_shim.cpp — little-endian).
  const CYC = {
    clk: 0,
    gpio_out: 8,
    gpio_oe: 12,
    intr: 16,
    pc: 20,
    state: 24,
    delay: 28,
    x: 32,
    y: 36,
    osr: 40,
    isr: 44,
    osr_cnt: 48,
    isr_cnt: 52,
    tx_level: 56,
    rx_level: 60,
    strobes: 64,
  };
  const CYC_SIZE = 72;

  // ---- level 02 "IDLE HANDS" fixture (the mock-up's uart_tx) -------
  // Canonical C12 listing; words are the level definition (no assembler
  // in the client — re-assembly on edit lands with C19).
  //   0: 0x9FA0  pull block side 1 [7]
  //   1: 0xF727  set x, 7 side 0 [7]
  //   2: 0x6001  out pins, 1
  //   3: 0x0642  jmp x--, 2 [6]
  const LEVEL = {
    words: [0x9fa0, 0xf727, 0x6001, 0x0642],
    wrapTarget: 0,
    wrapLast: 3,
    sideBits: 1,
    opt: true, // .side_set 1 opt
    outCnt: 1,
    outBase: 0, // out pins → gpio0
    wrapTopBits: 3,
    wrapBotBits: 0, // EXECCTRL wrap fields
    // FJOIN_TX (8-deep TX, SPEC-6-2) + OUT_SHIFT_DIR right (SPEC-7-21):
    // stim.shiftctrl(fjoin_tx=True) bit-for-bit.
    shiftctrl: 0x40080000,
    seedFeeds: [0x50, 0x49, 0x4f, 0x21], // 'P','I','O','!'
    fifoDepth: 8,
    bitCyc: 8, // 8 clks/bit (delay budget)
  };

  function pinctrlFor(sideBits, opt) {
    const ssCnt = sideBits + (opt ? 1 : 0); // + enable bit (SPEC-7-26)
    return ((ssCnt & 7) << 29) | (LEVEL.outCnt << 20) | LEVEL.outBase;
  }
  function execctrlFor(sideBits, opt) {
    // wrap fields + SIDE_EN (bit 30) — everything else level-static
    const sideEn = opt && sideBits > 0 ? 1 << 30 : 0;
    return (LEVEL.wrapTopBits << 12) | (LEVEL.wrapBotBits << 7) | sideEn;
  }

  function create(M, defects) {
    const DEFECT_PIN = !!defects?.pin;
    const DEFECT_MIRROR = !!defects?.mirror;
    const cyclePtr = M._pio_last_cycle();
    const dv = new DataView(M.HEAPU8.buffer, cyclePtr, CYC_SIZE);

    function readCycle() {
      return {
        clk: dv.getUint32(CYC.clk, true) + dv.getUint32(CYC.clk + 4, true) * 4294967296,
        gpioOut: dv.getUint32(CYC.gpio_out, true),
        gpioOe: dv.getUint32(CYC.gpio_oe, true),
        intr: dv.getUint32(CYC.intr, true),
        pc: dv.getUint32(CYC.pc, true),
        state: dv.getUint32(CYC.state, true),
        delay: dv.getUint32(CYC.delay, true),
        x: dv.getUint32(CYC.x, true),
        y: dv.getUint32(CYC.y, true),
        osr: dv.getUint32(CYC.osr, true),
        isr: dv.getUint32(CYC.isr, true),
        osrCnt: dv.getUint32(CYC.osr_cnt, true),
        isrCnt: dv.getUint32(CYC.isr_cnt, true),
        txLevel: dv.getUint32(CYC.tx_level, true),
        rxLevel: dv.getUint32(CYC.rx_level, true),
        strobes: dv.getUint32(CYC.strobes, true),
      };
    }

    // ---------------- state ----------------
    let pins = []; // gpio_out bit per cycle (the waveform truth)
    let tags = []; // monitor-derived meaning per cycle
    let txWords = []; // TX FIFO contents mirror (display bookkeeping)
    let pendingOps = []; // queued reg-bus ops, one rendered clk each
    let alloc = { sideBits: LEVEL.sideBits, opt: LEVEL.opt };
    let memWords = new Array(32).fill(0); // imem image this client wrote
    let last = null; // decoded PioCycle of the most recent clk
    let flashes = {};
    let mon = { armed: false, start: 0, bits: [], frameOff: null, stopTail: -1, decoded: '' };
    let refused = 0;

    function pinBit(cycle) {
      return (cycle.gpioOut >> (DEFECT_PIN ? 1 : 0)) & 1; // defect: bit 1
    }

    // Receiver-style monitor over engine pin samples: arms on the idle→0
    // falling edge, tags cycles by frame position, decodes at the stop
    // center (mockups/sm-view.html monitor, C15 flavor). The frame is
    // DECIDED at the stop-bit center (off 76) — the monitor disarms
    // there (a back-to-back frame's next falling edge lands at off 80
    // and must be caught), with stopTail keeping the tag warm through
    // the stop bit's tail cycles.
    function monitorCycle(pin, k) {
      // k=0 has no prior level: the reset-0 pad startup is not a
      // falling edge — the monitor only arms on a seen 1→0 transition.
      const prev = k > 0 ? pins[k - 1] : 0;
      if (!mon.armed) {
        if (k <= mon.stopTail) return 'STOP';
        if (prev === 1 && pin === 0) {
          mon.armed = true;
          mon.start = k;
          mon.bits = [];
        }
        return 'IDLE';
      }
      const off = k - mon.start;
      mon.frameOff = off;
      if (off >= 12 && off < 76 && (off - 12) % 8 === 0 && mon.bits.length < 8) mon.bits.push(pin);
      if (off < 8) return 'START';
      if (off < 72) return `D${(off - 8) >> 3}`;
      if (off === 76) {
        // stop-bit center: 9.5 bit times
        let ch = 0;
        mon.bits.forEach((b, i) => {
          ch |= b << i;
        });
        if (pin === 1 && mon.bits.length === 8) mon.decoded += String.fromCharCode(ch);
        mon.armed = false;
        mon.frameOff = null;
        mon.stopTail = mon.start + 79;
      }
      return 'STOP';
    }

    function record(cycle) {
      const k = pins.length;
      const pin = pinBit(cycle);
      pins.push(pin);
      tags.push(monitorCycle(pin, k));
      if (cycle.strobes & S_TX_POP && !DEFECT_MIRROR) txWords.shift(); // defect: never pops
      if (cycle.strobes & S_RX_PUSH) {
        /* rx path unused at level 02 */
      }
      flashes = {
        pull: !!(cycle.strobes & S_TX_POP),
        push: !!(cycle.strobes & S_RX_PUSH),
        jmp: !!(cycle.strobes & S_PC_WR),
        wrap:
          !!(cycle.strobes & S_COMPLETE) &&
          !(cycle.strobes & S_PC_WR) &&
          cycle.pc === LEVEL.wrapLast,
        execInsn: !!(cycle.strobes & S_EXEC),
      };
      // Latch the executing pc at record time, not lazily at read time:
      // a batch that spans EXEC->DELAY (worker {cmd:'run',cycles:N}, the
      // ?t= URL pre-run) must still display the delaying instruction —
      // found by the C20 unit suite (displayedPc latches... red/green).
      if (cycle.strobes & S_EXEC) lastExecPc = cycle.pc;
      last = cycle;
    }

    function doWrite(addr, data) {
      M._pio_reg_write(addr, data | 0);
      record(readCycle());
    }
    function doStep() {
      M._pio_step(0, 0, 0); // gpio_in idle, no neighbour IRQs (level 02)
      record(readCycle());
    }

    // One rendered clk: a queued reg op if any, else a plain step.
    function step() {
      if (pendingOps.length) {
        const op = pendingOps.shift();
        if (op !== null)
          doWrite(op.addr, op.data); // null = the idle clk
        else doStep();
        return;
      }
      doStep();
    }

    function clearRunState() {
      pins = [];
      tags = [];
      txWords = [];
      pendingOps = [];
      mon = { armed: false, start: 0, bits: [], frameOff: null, stopTail: -1, decoded: '' };
      refused = 0;
      flashes = {};
      last = null;
    }

    // The load timeline mirrors tools/pio_model stim._sched_basic exactly
    // (the CI gate compares the resulting pin series against pio_model):
    // imem words, PINCTRL, EXECCTRL, SHIFTCTRL, one idle clk so a
    // FJOIN-changing SHIFTCTRL write flushes before the feeds land
    // (SPEC-6-2), seed feeds, enable. Every load clk is a rendered clk
    // (recorded like any other) — run(N) counts only clks after load.
    function load() {
      M._pio_engine_reset();
      clearRunState();
      memWords = new Array(32).fill(0);
      LEVEL.words.forEach((w, i) => {
        pendingOps.push({ addr: REG.IMEM0 + 4 * i, data: w });
        memWords[i] = w;
      });
      pendingOps.push({ addr: REG.SM0 + 20, data: pinctrlFor(alloc.sideBits, alloc.opt) });
      pendingOps.push({ addr: REG.SM0 + 4, data: execctrlFor(alloc.sideBits, alloc.opt) });
      pendingOps.push({ addr: REG.SM0 + 8, data: LEVEL.shiftctrl });
      pendingOps.push(null); // the idle clk (SPEC-6-2)
      LEVEL.seedFeeds.forEach((f) => {
        pendingOps.push({ addr: REG.TXF0, data: f });
      });
      pendingOps.push({ addr: REG.CTRL, data: 1 }); // SM0 enable (SPEC-7-2)
      while (pendingOps.length) step();
      txWords = LEVEL.seedFeeds.slice();
    }

    function run(n) {
      for (let i = 0; i < n; i++) step();
    }

    // Enqueue bytes into the TX FIFO as queued reg writes; refuse at the
    // first word that would overflow (tx_full from the last true sample —
    // nothing else writes between cycles, so the cached flag is exact).
    function enqueue(bytes) {
      refused = 0;
      for (const b of bytes) {
        if (last && last.strobes & S_TX_FULL) {
          refused++;
          break;
        }
        pendingOps.push({ addr: REG.TXF0, data: b & 0xff });
        txWords.push(b & 0xff);
      }
      return refused;
    }

    // Change the ds-field allocation for real: PINCTRL.SIDESET_COUNT +
    // EXECCTRL.SIDE_EN are config registers, so the machine re-decodes
    // the SAME stored bits under the new split within two clks.
    function setAlloc(sideBits, opt) {
      alloc = { sideBits, opt };
      pendingOps.push({ addr: REG.SM0 + 20, data: pinctrlFor(sideBits, opt) });
      pendingOps.push({ addr: REG.SM0 + 4, data: execctrlFor(sideBits, opt) });
    }

    // The C19 re-assemble-on-edit commit path: patch the live imem image
    // (SPEC-7-10, one rendered clk per changed word — writing imem of a
    // running SM is legal; the SM fetches the new bits on its next
    // instruction boundary). words is the full 32-slot image; only
    // slots that differ from what this client last wrote are queued,
    // and 0 clears a slot back to untouched-memory (jmp 0).
    function setProgram(words) {
      for (let i = 0; i < 32; i++) {
        const w = words[i] | 0;
        if (w !== memWords[i]) {
          pendingOps.push({ addr: REG.IMEM0 + 4 * i, data: w });
          memWords[i] = w;
        }
      }
    }

    // "⏭ INSN": step until the displayed instruction changes (or the SM
    // stalls) — the mock-up's do/while over true engine samples.
    function stepInsn() {
      const p0 = displayedPc();
      let n = 0;
      do {
        step();
        n++;
      } while (displayedPc() === p0 && phaseOf() !== 'STALL' && n < 200);
    }

    // A reg read is a rendered clk too (the trace's R-line discipline).
    function readFlevel() {
      if (pendingOps.length) step(); // keep the timeline aligned with load
      const v = M._pio_reg_read(REG.FLEVEL);
      record(readCycle());
      return v >>> 0;
    }

    // pc of the most recent S_EXEC clk — latched eagerly in record() so
    // unobserved batches still display the delaying instruction
    let lastExecPc = 0;
    function displayedPc() {
      if (!last) return 0;
      return last.state === ST.DELAY ? lastExecPc : last.pc;
    }
    function phaseOf() {
      if (!last) return 'OFF';
      if (last.state === ST.STALL) return 'STALL';
      if (last.state === ST.DELAY) return 'DELAY';
      if (last.state === ST.FETCH || last.state === ST.EXEC)
        return last.strobes & S_TICK ? 'EXEC' : 'OFF';
      return 'OFF';
    }

    const WAVE_WIN = 128;
    function getState() {
      const n = pins.length;
      const from = Math.max(0, n - WAVE_WIN);
      return {
        cycle: last ? last.clk : 0,
        pin: n ? pins[n - 1] : 0,
        pc: last ? last.pc : 0,
        displayPc: displayedPc(),
        phase: phaseOf(),
        delay: last ? last.delay : 0,
        x: last ? last.x : 0,
        y: last ? last.y : 0,
        osr: last ? last.osr : 0,
        isr: last ? last.isr : 0,
        osrCnt: last ? last.osrCnt : 0,
        isrCnt: last ? last.isrCnt : 0,
        txLevel: last ? last.txLevel : 0,
        txEmpty: last ? !!(last.strobes & S_TX_EMPTY) : true,
        txFull: last ? !!(last.strobes & S_TX_FULL) : false,
        txWords: txWords.slice(),
        monitor: { decoded: mon.decoded, frameOff: mon.armed ? mon.frameOff : null },
        wave: { pins: pins.slice(from), tags: tags.slice(from), startCycle: from },
        flashes,
        refused,
        alloc: { ...alloc },
      };
    }

    return {
      load,
      step,
      run,
      stepInsn,
      enqueue,
      setAlloc,
      setProgram,
      readFlevel,
      getState,
      allPins: () => pins.slice(),
      LEVEL,
      REG,
      ST,
    };
  }

  const api = { create, LEVEL, REG, ST, CYC };
  global.VibeDriver = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(this);

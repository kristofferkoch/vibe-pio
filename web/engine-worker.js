// engine-worker.js — the C18/C21/C24 Web Worker (KANBAN C18/C21/C24).
//
// Loads the wasm engine (build/web/pio_engine.js, the C17 AOT build of
// the verified RTL) inside the worker and exposes the driver through
// postMessage, so the main thread never stalls on engine work: batch
// stepping ({cmd:'run', cycles:N}) runs N clks per message and returns
// one state snapshot the view renders from. The worker owns no state:
// the view sends the sandbox state on load/reset; overlay/drive/pattern/
// lens edits go straight through to the driver (pure logic, unit-tested
// against the fake engine — this file is transport only).
//
// Protocol (all replies carry {cmd:'state', state} unless noted; the
// per-SM commands carry the SM index 0..3 — C24):
//   {cmd:'init', engineUrl}     → {cmd:'ready'} (loads driver + engine)
//   {cmd:'load', state}         → reset + program/config/feeds/enable
//                                 (state = the v2 sandbox object: words
//                                 + per-SM overlay; lens preset)
//   {cmd:'run', cycles:N}       → batch-step N clks
//   {cmd:'step'}                → one clk
//   {cmd:'select', sm}          → the selected SM (the detail panes',
//                                 stepInsn's SM)
//   {cmd:'stepInsn'}            → step the selected SM one instruction
//   {cmd:'enqueue', bytes, sm}  → TXFx writes; reply also carries {refused}
//   {cmd:'enqueueword', word, sm} → the inspector's TXFx row
//   {cmd:'program', words}      → C19 re-assemble-on-edit: patch the live
//                                 imem image (one rendered clk per changed
//                                 word; the SM keeps running)
//   {cmd:'overlay', sm, group, field, value} → a config-field edit of
//                                 SM sm (queues the composed reg write +
//                                 the SPEC-6-2 settle clk on fifo-mode
//                                 changes)
//   {cmd:'control', sm, id, gesture} → a C22 drawn-config control on SM
//                                 sm (the DESIGN-NOTES grammar): the
//                                 shared controlEdit table maps the
//                                 gesture to overlay edits, landed
//                                 atomically
//   {cmd:'drive', pin, level}   → a hold-latch pin drive (null releases)
//   {cmd:'pattern', cfg}        → the pattern generator (off/square/bits)
//   {cmd:'lens', mode, pin}     → the monitor lens (off/square/uart)
//   {cmd:'drain', n, sm}        → queue n RXFx reads of SM sm (the RX
//                                 drain)
//   {cmd:'regread', addr}       → a queued read, flushed; reply carries
//                                 {rdata} (the inspector's RO rows)
//   {cmd:'regwrite', addr, data} → a generic write, flushed (CTRL pulses,
//                                 IRQ W1C/force, ISB, FDEBUG W1C, the
//                                 SMx_INSTR force — never the overlay
//                                 regs: those go through 'overlay')
//   {cmd:'serialize'}           → reply also carries {json} (the
//                                 stored-program format, for autosave)
//   {cmd:'reset', state}        → load again (the view's program)

/* global importScripts, onmessage, postMessage, VibeDriver, PioEngine */
'use strict';

let drv = null;

function postState(extra) {
  postMessage(Object.assign({ cmd: 'state', state: drv.getState() }, extra || {}));
}

// biome-ignore lint/suspicious/noGlobalAssign: onmessage is the Web Worker API entry point — assigning the global handler is the worker's contract
onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'init') {
    try {
      importScripts('engine-driver.js');
      importScripts(m.engineUrl); // defines the modularized PioEngine factory
      // The .wasm sits beside the engine JS, not beside this worker.
      PioEngine({ locateFile: (f) => new URL(f, m.engineUrl).href }).then(
        (M) => {
          drv = VibeDriver.create(M);
          postMessage({ cmd: 'ready' });
          postState();
        },
        (err) => {
          // an engine-side failure must reach the view — an unhandled
          // worker rejection is invisible to worker.onerror
          postMessage({ cmd: 'werr', message: String(err?.stack || err) });
        },
      );
    } catch (err) {
      postMessage({ cmd: 'werr', message: String(err?.stack || err) });
    }
    return;
  }
  if (!drv) return; // commands before init are dropped
  try {
    switch (m.cmd) {
      case 'load':
        drv.load(m.state);
        postState();
        break;
      case 'run':
        drv.run(m.cycles | 0);
        postState();
        break;
      case 'step':
        drv.step();
        postState();
        break;
      case 'select':
        drv.select(m.sm | 0);
        postState();
        break;
      case 'stepInsn':
        drv.stepInsn();
        postState();
        break;
      case 'enqueue': {
        const refused = drv.enqueue(m.bytes || [], m.sm | 0);
        postState({ refused });
        break;
      }
      case 'enqueueword':
        drv.enqueueWord(m.word >>> 0, m.sm | 0);
        postState();
        break;
      case 'program':
        drv.setProgram(m.words || []);
        postState();
        break;
      case 'overlay':
        drv.setOverlayField(m.sm | 0, m.group, m.field, m.value);
        postState();
        break;
      case 'control':
        drv.applyControl(m.sm | 0, m.id, m.gesture);
        postState();
        break;
      case 'drive':
        drv.setDrive(m.pin | 0, m.level === null ? null : m.level | 0);
        postState();
        break;
      case 'pattern':
        drv.setPattern(m.cfg || { mode: 'off' });
        postState();
        break;
      case 'lens':
        drv.setLens({ mode: m.mode || 'off', pin: m.pin | 0 });
        postState();
        break;
      case 'drain': {
        const drained = drv.drainRx(m.n | 0, m.sm | 0);
        postState({ drained });
        break;
      }
      case 'regread': {
        const rdata = drv.readRegNow(m.addr >>> 0);
        postState({ rdata, raddr: m.addr >>> 0 });
        break;
      }
      case 'regwrite':
        drv.writeRegNow(m.addr >>> 0, m.data | 0);
        postState();
        break;
      case 'serialize':
        postState({ json: drv.serialize() });
        break;
      case 'reset':
        drv.load(m.state);
        postState();
        break;
      default:
        break;
    }
  } catch (err) {
    postMessage({ cmd: 'werr', message: String(err?.stack || err) });
  }
};

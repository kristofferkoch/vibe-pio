// engine-worker.js — the C18 Web Worker (KANBAN C18).
//
// Loads the wasm engine (build/web/pio_engine.js, the C17 AOT build of
// the verified RTL) inside the worker and exposes the driver through
// postMessage, so the main thread never stalls on engine work: batch
// stepping ({cmd:'run', cycles:N}) runs N clks per message and returns
// one state snapshot the view renders from.
//
// Protocol (all replies carry {cmd:'state', state} unless noted):
//   {cmd:'init', engineUrl}  → {cmd:'ready'} (loads driver + engine)
//   {cmd:'load'}             → reset + program/config/feeds/enable
//   {cmd:'run', cycles:N}    → batch-step N clks
//   {cmd:'step'}             → one clk
//   {cmd:'stepInsn'}         → step one instruction
//   {cmd:'enqueue', bytes}   → TXF writes; reply also carries {refused}
//   {cmd:'alloc', sideBits, opt} → real PINCTRL/EXECCTRL re-write
//   {cmd:'program', words}   → C19 re-assemble-on-edit: patch the live
//                              imem image (one rendered clk per changed
//                              word; the SM keeps running)
//   {cmd:'reset'}            → load again

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
          drv.load();
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
        drv.load();
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
      case 'stepInsn':
        drv.stepInsn();
        postState();
        break;
      case 'enqueue': {
        const refused = drv.enqueue(m.bytes || []);
        postState({ refused });
        break;
      }
      case 'alloc':
        drv.setAlloc(m.sideBits, !!m.opt);
        postState();
        break;
      case 'program':
        drv.setProgram(m.words || []);
        postState();
        break;
      case 'reset':
        drv.load();
        postState();
        break;
      default:
        break;
    }
  } catch (err) {
    postMessage({ cmd: 'werr', message: String(err?.stack || err) });
  }
};

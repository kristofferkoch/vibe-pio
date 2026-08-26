// node_gate.js — headless gate runner for the wasm engine (KANBAN C17).
// Loads the modularized PioEngine build, replays one pio-stim v1 image
// through pio_stim_trace, writes the SPEC-16-7 trace. The compiled-in
// invariant subset (pio_shim_top.sv, Verilator --assert) aborts the
// process on violation, so the exit status is part of the gate.
//
// Usage: node node_gate.js <pio_engine.js> <stim.mem> <out.trace>
// Paths may be absolute or relative to the repo root (the gate always
// runs with cwd = repo root).

'use strict';

const fs = require('fs');
const path = require('path');

const engineJs = process.argv[2];
const stimPath = process.argv[3];
const tracePath = process.argv[4];
if (!engineJs || !stimPath || !tracePath) {
    console.error('usage: node node_gate.js <pio_engine.js> <stim.mem> <out.trace>');
    process.exit(2);
}
// The engine path resolves from cwd (the gate always runs at repo root),
// not from this script's directory.
const PioEngine = require(path.resolve(engineJs));
PioEngine().then((M) => {
    const stim = fs.readFileSync(stimPath, 'utf8');
    const bytes = M.lengthBytesUTF8(stim) + 1;
    const inPtr = M._malloc(bytes);
    M.stringToUTF8(stim, inPtr, bytes);
    const outPtr = M._pio_stim_trace(inPtr);
    const trace = M.UTF8ToString(outPtr);
    fs.writeFileSync(tracePath, trace);
    process.exit(0);
}).catch((err) => {
    console.error(String(err));
    process.exit(1);
});

// fake-engine-module.js — the fake engine wearing the PioEngine factory
// face (web/tests/keyboard.test.js serves it at build/web/pio_engine.js).
//
// The real engine-worker.js boots by importScripts(engineUrl) and calling
// the PioEngine({locateFile}) factory, whose promise resolves to the wasm
// module the driver drives through the pio_shim ABI. This file loads the
// suite's own fake engine (fake-engine.js — the same CommonJS fixture the
// driver unit tests use, never a second implementation) and exposes it
// behind that exact factory shape, so the keyboard walk exercises the
// shipped transport — the real engine-worker.js, unmodified — with no
// wasm build on the machine.

/* global importScripts */
'use strict';

var module = { exports: {} };
importScripts('/web/tests/fake-engine.js');
// biome-ignore lint/correctness/noUnusedVariables: PioEngine is the export — engine-worker.js reads it as a worker global after importScripts(this)
var PioEngine = () => Promise.resolve(module.exports.createFake());

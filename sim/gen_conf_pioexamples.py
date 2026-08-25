#!/usr/bin/env python3
"""Generate sim/conf_pioexamples.svh — assembled words of the official
pico-examples PIO programs, as loader tasks for the conformance testbench
(sim/tb_conf_pioexamples.sv; KANBAN "Ingest official pico-examples PIO
programs ... as conformance tests").

Sources (see docs/xcheck-picoexamples.md §1 provenance):
  - third_party/pico-examples @ c81c855ffdedc825975a40ba357723a71358ddf0
  - assembled with pioasm from third_party/pioasm-sdk @ 98a542c
    (SDK 2.3.0 Release), built by the pioasm-builder container recipe in
    this header; the binary is expected at build/pioasm (gitignored).

Regeneration (from the repo root):
    docker build -t pioasm-builder - <<'EOF'
    FROM debian:trixie-slim
    RUN apt-get update && apt-get install -y --no-install-recommends \
        g++ cmake make && rm -rf /var/lib/apt/lists/*
    EOF
    git -C third_party/pioasm-sdk sparse-checkout add pico_sdk_version.cmake
    docker run --rm -v "$PWD:/work" pioasm-builder bash -c \
      'cmake -S /work/third_party/pioasm-sdk/tools/pioasm -B /tmp/b \
       -DPIOASM_VERSION_STRING=2.3.0 && cmake --build /tmp/b -j$(nproc) \
       && cp /tmp/b/pioasm /work/build/pioasm'
    python3 sim/gen_conf_pioexamples.py

The script is deterministic: same sources + same pioasm => same .svh (the
pioASMVersion stamp records the assembler). The generated file is committed
so `make sim` never needs pioasm, docker, or third_party/.

Per program the .svh provides:
  <NAME>_N                word count
  <NAME>_ORIGIN           .origin (-1 = any)
  <NAME>_WRAP_TARGET/_WRAP  wrap bounds (relative to program start)
  <NAME>_SS_SIZE/_SS_OPT/_SS_PINDIRS  .side_set directive facts
  <NAME>_LBL_<LABEL>      public label addresses (relative to program start)
  <NAME>_<SYMBOL>         `.define public` constant values
  load_<name>(base)       loader task writing the words via the TB reg bus
"""

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
PIOASM = REPO / "build" / "pioasm"
EX = REPO / "third_party" / "pico-examples"
JSON_DIR = REPO / "build" / "conf_json"
OUT_SVH = REPO / "sim" / "conf_pioexamples.svh"

# (source .pio under third_party/pico-examples, program name to extract).
# Exactly the programs sim/tb_conf_pioexamples.sv runs (CF1..CF16); the
# coverage map in that TB's header says which check uses which program.
PROGRAMS: list[tuple[str, str]] = [
    ("pio/squarewave/squarewave.pio", "squarewave"),  # CF1
    ("pio/addition/addition.pio", "addition"),  # CF2
    ("pio/ws2812/ws2812.pio", "ws2812"),  # CF3
    ("pio/uart_tx/uart_tx.pio", "uart_tx"),  # CF4
    ("pio/spi/spi.pio", "spi_cpha0"),  # CF5
    ("pio/spi/spi.pio", "spi_cpha1"),  # CF6
    ("pio/spi/spi.pio", "spi_cpha0_cs"),  # CF7
    ("pio/clocked_input/clocked_input.pio", "clocked_input"),  # CF8
    ("pio/quadrature_encoder/quadrature_encoder.pio", "quadrature_encoder"),  # CF9
    ("pio/onewire/onewire_library/onewire_library.pio", "onewire"),  # CF10
    ("pio/i2c/i2c.pio", "i2c"),  # CF11
    ("pio/i2c/i2c.pio", "set_scl_sda"),  # CF11
    ("pio/manchester_encoding/manchester_encoding.pio", "manchester_tx"),  # CF12
    ("pio/manchester_encoding/manchester_encoding.pio", "manchester_rx"),  # CF12
    ("pio/differential_manchester/differential_manchester.pio", "differential_manchester_tx"),  # CF15
    ("pio/differential_manchester/differential_manchester.pio", "differential_manchester_rx"),  # CF15
    ("pio/uart_rx/uart_rx.pio", "uart_rx"),  # CF16
    ("pio/hub75/hub75.pio", "hub75_data_rgb888"),  # CF13
    ("pio/apa102/apa102.pio", "apa102_rgb555"),  # CF14
]


def assemble(rel_path: str) -> dict[str, Any]:
    """Run pioasm -o json on one .pio file; return its parsed JSON."""
    src = EX / rel_path
    dst = JSON_DIR / (rel_path.replace("/", "_") + ".json")
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(PIOASM), "-o", "json", str(src), str(dst)], check=True)
    return json.loads(dst.read_text())


def emit(asm_version: str, entries: list[tuple[str, str, dict[str, Any]]]) -> str:
    lines: list[str] = []
    w = lines.append
    w("// conf_pioexamples.svh — AUTO-GENERATED, DO NOT EDIT")
    w("//")
    w("// Assembled PIO programs from the official raspberrypi/pico-examples")
    w("// repo (commit c81c855ffdedc825975a40ba357723a71358ddf0), to be run on")
    w("// pio_block by sim/tb_conf_pioexamples.sv. Regenerate with")
    w("// sim/gen_conf_pioexamples.py (see its header for the full recipe);")
    w(f"// pioasm {asm_version}, third_party/pioasm-sdk @ 98a542c).")
    w("//")
    w("// Addresses (wrap bounds, public labels) are relative to the program")
    w("// start; pass the load offset as `base` to the loader task.")
    w("")
    for rel_path, name, prog in entries:
        ins = prog["instructions"]
        ss = prog.get("sideset")
        w("// " + "-" * 74)
        w(f"// {name} — {rel_path} ({len(ins)} instructions)")
        w(
            f"// wrap_target={prog['wrapTarget']} wrap={prog['wrap']}"
            f" origin={prog['origin']}"
            + (f" sideset(size={ss['size']}, opt={int(ss['optional'])}, pindirs={int(ss['pindirs'])})" if ss else "")
        )
        uname = name.upper()
        w(f"localparam int {uname}_N          = {len(ins)};")
        w(f"localparam int {uname}_ORIGIN     = {prog['origin']};")
        w(f"localparam int {uname}_WRAP_TARGET= {prog['wrapTarget']};  // .wrap_target (relative)")
        w(f"localparam int {uname}_WRAP       = {prog['wrap']};  // .wrap (relative)")
        if ss:
            w(f"localparam int {uname}_SS_SIZE     = {ss['size']};  // .side_set bit count (incl. opt bit)")
            w(
                f"localparam int {uname}_SS_OPT      = {int(ss['optional'])};"
                f"{'' if ss['optional'] else '  // no opt bit: every instr side-sets'}"
            )
            w(f"localparam int {uname}_SS_PINDIRS  = {int(ss['pindirs'])};")
        for sym, val in sorted(prog.get("publicSymbols", {}).items()):
            w(f"localparam int {uname}_{sym.upper()} = {val};  // .define public {sym}")
        for lbl, val in sorted(prog.get("publicLabels", {}).items()):
            w(f"localparam int {uname}_LBL_{lbl.upper()} = {val};  // public {lbl}")
        w(f"task automatic load_{name}(input int base);")
        for k, instr in enumerate(ins):
            # keep pioasm's own disassembly text verbatim: it is the
            # human-facing reference for what each word is
            wobj = int(instr["hex"], 16)
            if (wobj >> 13) == 0:
                # JMP: pioasm bakes the target as an offset from the
                # program start; the SDK's pio_add_program relocates it by
                # the load offset at load time — same here (mod 32, the
                # imem depth)
                rel = wobj & 0x1F
                w(
                    f"  bus_wr(A_IMEM(base+{k}), (32'h{wobj:04x} & 32'hffff_e0)"
                    f" | ((5'(base) + 5'd{rel}) & 5'h1f));"
                    f"  // {instr['instruction'].rstrip()} (jmp +base)"
                )
            else:
                w(f"  bus_wr(A_IMEM(base+{k}), 32'h{instr['hex']});  // {instr['instruction'].rstrip()}")
        w("endtask")
        w("")
    return "\n".join(lines) + "\n"


def main() -> None:
    if not PIOASM.is_file() or not PIOASM.stat().st_mode & 0o111:
        sys.exit(f"no pioasm at {PIOASM} — see this file's header for the build recipe")
    entries: list[tuple[str, str, dict[str, Any]]] = []
    seen_files: dict[str, dict[str, Any]] = {}
    asm_version = None
    for rel_path, prog_name in PROGRAMS:
        if rel_path not in seen_files:
            seen_files[rel_path] = assemble(rel_path)
        doc = seen_files[rel_path]
        asm_version = doc.get("pioASMVersion", "?")
        match = [p for p in doc["programs"] if p["name"] == prog_name]
        if not match:
            sys.exit(f"{rel_path}: no program '{prog_name}' (have {[p['name'] for p in doc['programs']]})")
        entries.append((rel_path, prog_name, match[0]))
    OUT_SVH.write_text(emit(str(asm_version), entries))
    print(f"wrote {OUT_SVH} ({len(entries)} programs)")


if __name__ == "__main__":
    main()

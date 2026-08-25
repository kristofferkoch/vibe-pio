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
    python3 sim/gen_conf_picoexamples.py

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
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIOASM = os.path.join(REPO, "build", "pioasm")
EX = os.path.join(REPO, "third_party", "pico-examples")
JSON_DIR = os.path.join(REPO, "build", "conf_json")
OUT_SVH = os.path.join(REPO, "sim", "conf_pioexamples.svh")

# (source .pio under third_party/pico-examples, program name to extract).
# Exactly the programs sim/tb_conf_pioexamples.sv runs (CF1..CF13); the
# coverage map in that TB's header says which check uses which program.
PROGRAMS = [
    ("pio/squarewave/squarewave.pio", "squarewave"),                     # CF1
    ("pio/addition/addition.pio", "addition"),                           # CF2
    ("pio/ws2812/ws2812.pio", "ws2812"),                                 # CF3
    ("pio/uart_tx/uart_tx.pio", "uart_tx"),                              # CF4
    ("pio/spi/spi.pio", "spi_cpha0"),                                    # CF5
    ("pio/spi/spi.pio", "spi_cpha1"),                                    # CF6
    ("pio/spi/spi.pio", "spi_cpha0_cs"),                                 # CF7
    ("pio/clocked_input/clocked_input.pio", "clocked_input"),            # CF8
    ("pio/quadrature_encoder/quadrature_encoder.pio",
     "quadrature_encoder"),                                              # CF9
    ("pio/onewire/onewire_library/onewire_library.pio", "onewire"),      # CF10
    ("pio/i2c/i2c.pio", "i2c"),                                          # CF11
    ("pio/i2c/i2c.pio", "set_scl_sda"),                                  # CF11
    ("pio/manchester_encoding/manchester_encoding.pio", "manchester_tx"),  # CF12
    ("pio/manchester_encoding/manchester_encoding.pio", "manchester_rx"),  # CF12
    ("pio/hub75/hub75.pio", "hub75_data_rgb888"),                        # CF13
    ("pio/apa102/apa102.pio", "apa102_rgb555"),                          # CF14
]


def assemble(rel_path):
    """Run pioasm -o json on one .pio file; return its parsed JSON."""
    src = os.path.join(EX, rel_path)
    dst = os.path.join(JSON_DIR, rel_path.replace("/", "_") + ".json")
    os.makedirs(JSON_DIR, exist_ok=True)
    subprocess.run([PIOASM, "-o", "json", src, dst], check=True)
    with open(dst) as f:
        return json.load(f)


def emit(asm_version, entries):
    lines = []
    w = lines.append
    w("// conf_pioexamples.svh — AUTO-GENERATED, DO NOT EDIT")
    w("//")
    w("// Assembled PIO programs from the official raspberrypi/pico-examples")
    w("// repo (commit c81c855ffdedc825975a40ba357723a71358ddf0), to be run on")
    w("// pio_block by sim/tb_conf_picoexamples.sv. Regenerate with")
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
        w(f"// wrap_target={prog['wrapTarget']} wrap={prog['wrap']}"
          f" origin={prog['origin']}"
          + (f" sideset(size={ss['size']}, opt={int(ss['optional'])},"
             f" pindirs={int(ss['pindirs'])})" if ss else ""))
        uname = name.upper()
        w(f"localparam int {uname}_N          = {len(ins)};")
        w(f"localparam int {uname}_ORIGIN     = {prog['origin']};")
        w(f"localparam int {uname}_WRAP_TARGET= {prog['wrapTarget']};"
          f"  // .wrap_target (relative)")
        w(f"localparam int {uname}_WRAP       = {prog['wrap']};"
          f"  // .wrap (relative)")
        if ss:
            w(f"localparam int {uname}_SS_SIZE     = {ss['size']};"
              f"  // .side_set bit count (incl. opt bit)")
            w(f"localparam int {uname}_SS_OPT      = {int(ss['optional'])};"
              f"{'' if ss['optional'] else '  // no opt bit: every instr side-sets'}")
            w(f"localparam int {uname}_SS_PINDIRS  = {int(ss['pindirs'])};")
        for sym, val in sorted(prog.get("publicSymbols", {}).items()):
            w(f"localparam int {uname}_{sym.upper()} = {val};"
              f"  // .define public {sym}")
        for lbl, val in sorted(prog.get("publicLabels", {}).items()):
            w(f"localparam int {uname}_LBL_{lbl.upper()} = {val};"
              f"  // public {lbl}")
        w(f"task automatic load_{name}(input int base);")
        for k, ins in enumerate(ins):
            # keep pioasm's own disassembly text verbatim: it is the
            # human-facing reference for what each word is
            wobj = int(ins['hex'], 16)
            if (wobj >> 13) == 0:
                # JMP: pioasm bakes the target as an offset from the
                # program start; the SDK's pio_add_program relocates it by
                # the load offset at load time — same here (mod 32, the
                # imem depth)
                rel = wobj & 0x1F
                w("  bus_wr(A_IMEM(base+%d), (32'h%04x & 32'hffff_e0)"
                  " | ((5'(base) + 5'd%d) & 5'h1f));"
                  "  // %s (jmp +base)"
                  % (k, wobj, rel, ins['instruction'].rstrip()))
            else:
                w(f"  bus_wr(A_IMEM(base+{k}), 32'h{ins['hex']});"
                  f"  // {ins['instruction'].rstrip()}")
        w("endtask")
        w("")
    return "\n".join(lines) + "\n"


def main():
    if not os.access(PIOASM, os.X_OK):
        sys.exit(f"no pioasm at {PIOASM} — see this file's header for the "
                 "build recipe")
    entries = []
    seen_files = {}
    asm_version = None
    for rel_path, prog_name in PROGRAMS:
        if rel_path not in seen_files:
            seen_files[rel_path] = assemble(rel_path)
        doc = seen_files[rel_path]
        asm_version = doc.get("pioASMVersion", "?")
        match = [p for p in doc["programs"] if p["name"] == prog_name]
        if not match:
            sys.exit(f"{rel_path}: no program '{prog_name}' "
                     f"(have {[p['name'] for p in doc['programs']]})")
        entries.append((rel_path, prog_name, match[0]))
    with open(OUT_SVH, "w") as f:
        f.write(emit(asm_version, entries))
    print(f"wrote {OUT_SVH} ({len(entries)} programs)")


if __name__ == "__main__":
    main()

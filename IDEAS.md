# IDEAS

Loose, undiscussed ideas from humans and LLMs. Anything here is **not**
agreed work. Items are promoted to `KANBAN.md` only after a grilling
session. Append freely; prune ruthlessly when promoted or rejected.

- Should we also model the RP2350's PIO "input synchronizer bypass" and
  the new-to-RP2350 features (e.g. GPIO-out override, DOORBELL IRQs)?
  Or target the RP2040 subset first for simplicity?
- Coverage-driven random program testing: generate random PIO programs +
  expected traces from a Python golden model, diff against RTL.
- Could the synthesis harness use `cover` statements to *mine* programs
  for common protocols (I2C, SPI modes, UART) rather than assertions only?
- Fpga target? (iCE40/ECP5 via yosys+nextpnr) as a real-world gate check.
- Export witness programs as .pio assembler source for pioasm compatibility.
- Property-based "differential" testing against the actual RP2350 silicon
  via a hardware-in-the-loop capture rig (long-term).

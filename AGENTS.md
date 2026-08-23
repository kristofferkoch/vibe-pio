# AGENTS.md

Conventions for AI agents (and subagents) working in this repo.

- **KANBAN.md** is the work queue: planned items only. Pick items respecting
  their dependency order. When you complete an item, your commit must delete
  it from the board. Never add loose ideas to KANBAN — append them to
  **IDEAS.md** instead; they get promoted only via a grilling session.
- Every commit you make must carry an `Agent:` trailer identifying the
  model and harness that performed the work, e.g.
  `Agent: ZCode (builtin:zai-coding-plan/GLM-5.3)`.
- Code goes in the SystemVerilog subset common to iverilog (`-g2012`) and
  yosys (`read_verilog -sv`): `always_ff`/`always_comb`, no interfaces or
  classes. See `DESIGN.md` before structural changes.

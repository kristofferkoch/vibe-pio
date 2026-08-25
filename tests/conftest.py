"""pytest scaffolding: make tools/ importable and the repo paths absolute.

The pio_model package and tools/ scripts are stdlib-only and run in
place (also inside the vibe-pio container, which has no uv/venv) — they
are not installed into the uv environment, so the suite imports them
through the same sys.path shim tools/pio_model/difftest.py uses.
"""

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TOOLS = REPO / "tools"

if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

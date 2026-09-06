#!/usr/bin/env python3
"""Serve the shipped client from the repo root, Cache-Control:
no-store (the mockups/serve.py lesson — a heuristically cached copy
once produced a stale-UI false bug report). The campaign landing
(web/index.html) is the front door (KANBAN C42): / REDIRECTS to it —
the same pattern the Pages artifact's own index.html uses — because
every asset reference in the client is relative to the page (levels.js,
sm-view.css, the engine at ../build/web/pio_engine.js), so the landing
must live at its own /web/ URL; serving its bytes directly at / would
strand the scripts at /levels.js. The client needs the repo root as
base so the wasm engine resolves at build/web/pio_engine.js:

    http://localhost:8138/            (redirects to the campaign map)
    http://localhost:8138/web/sm-view.html

Requires `make web` (or tools/webbuild.py --build) to have produced
build/web/pio_engine.js first."""

import functools
import http.server
import os
import sys
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EXT = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return EXT.get(ext, super().guess_type(path))

    def do_GET(self):
        # / is the campaign's front door: a redirect, never a direct
        # serve (the page's relative assets need its /web/ URL) and
        # never a directory listing
        if urlparse(self.path).path in ("/", "/index.html"):
            self.send_response(307)
            self.send_header("Location", "/web/index.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_GET()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8138
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=ROOT))
    print(f"serving {ROOT} on http://localhost:{port}/ (the campaign map — no-store)")
    srv.serve_forever()

#!/usr/bin/env python3
"""Serve the mock-up with Cache-Control: no-store — mockups change fast
and a heuristically cached copy caused a stale-UI false bug report.

Serves the REPO ROOT (not mockups/): since the C26 era skin the mock-up
loads its two bitmap webfonts from web/fonts/, so it must be viewed as
    http://localhost:8137/mockups/sm-view.html
"""

import functools
import http.server
import os

DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8137), functools.partial(Handler, directory=DIR))
    print("serving", DIR, "on http://localhost:8137/mockups/sm-view.html (no-store)")
    srv.serve_forever()

#!/usr/bin/env python3
"""Serve the mock-up with Cache-Control: no-store — mockups change fast
and a heuristically cached copy caused a stale-UI false bug report."""
import functools
import http.server
import os

DIR = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

if __name__ == "__main__":
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8137), functools.partial(Handler, directory=DIR))
    print("serving", DIR, "on http://localhost:8137 (no-store)")
    srv.serve_forever()

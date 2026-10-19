"""Local dev server for Road Rush that tells the browser never to cache, so edits show on reload.

Usage: python tools/serve.py [port]   (default 8080), then open http://localhost:8080
"""
import functools
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = functools.partial(NoCache, directory=str(ROOT))
    print(f"Road Rush on http://localhost:{port}")
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()

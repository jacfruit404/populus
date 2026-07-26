#!/usr/bin/env python3
"""Static file server for Populus, plus a tiny persistence API for the ledger.

The calibration ledger has to outlive the browser tab, so predictions are
written to ledger.json next to this file. Plain text, inspectable, diffable.
Writes are atomic (temp file + rename) so an interrupted save cannot corrupt
a record of past predictions.

Loopback only. There is no auth here and it is not meant to leave the machine.
"""
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DIR = os.path.dirname(os.path.abspath(__file__))
LEDGER_PATH = os.path.join(DIR, "ledger.json")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


def read_ledger():
    try:
        with open(LEDGER_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except (json.JSONDecodeError, OSError) as exc:
        print(f"  ! ledger.json unreadable ({exc}); serving empty", file=sys.stderr)
        return []


def write_ledger(rows):
    tmp = LEDGER_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, indent=1, ensure_ascii=False)
    os.replace(tmp, LEDGER_PATH)          # atomic on POSIX


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def _send_json(self, payload, code=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/ledger":
            return self._send_json(read_ledger())
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/ledger":
            return self.send_error(404)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 4_000_000:
                raise ValueError("payload too large")
            rows = json.loads(self.rfile.read(length) or b"[]")
            if not isinstance(rows, list):
                raise ValueError("expected a JSON array")
            write_ledger(rows)
            closed = sum(1 for r in rows if isinstance(r, dict) and r.get("outcome"))
            print(f"  ledger saved: {len(rows)} prediction(s), {closed} closed")
            return self._send_json({"ok": True, "count": len(rows)})
        except Exception as exc:                                  # noqa: BLE001
            return self._send_json({"ok": False, "error": str(exc)}, 400)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        msg = fmt % args
        if "/api/ledger" in msg or "favicon" in msg:
            return
        sys.stderr.write("  %s\n" % msg)


if __name__ == "__main__":
    existing = read_ledger()
    if existing:
        closed = sum(1 for r in existing if r.get("outcome"))
        print(f"ledger: {len(existing)} prediction(s) on file, {closed} closed, "
              f"{len(existing)-closed} awaiting an outcome")
    else:
        print("ledger: empty — predictions you commit will be written to ledger.json")
    print(f"populus: http://localhost:{PORT}")
    print("ctrl-c to stop")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

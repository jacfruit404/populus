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
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DIR = os.path.dirname(os.path.abspath(__file__))
LEDGER_PATH = os.path.join(DIR, "ledger.json")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

# Hosted-model proxy. The stronger the model, the more nuanced the populations
# and stimulus loadings — but a hosted key must never reach the browser, so the
# page posts to /api/llm and the key is read from the environment here, server
# side. Uses the standard library only: the whole project has no dependencies
# and this keeps it that way (no `anthropic` SDK, no pip install).
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
# Default to the most capable model; override with POPULUS_MODEL (e.g.
# claude-sonnet-5 / claude-haiku-4-5) when cost or latency matters more.
POPULUS_MODEL = os.environ.get("POPULUS_MODEL", "claude-opus-5").strip()


def call_anthropic(system, messages, max_tokens):
    """One Messages API call. Returns the assistant's text, or raises."""
    if not ANTHROPIC_KEY:
        raise RuntimeError("no ANTHROPIC_API_KEY set — export one to use the hosted model, "
                           "or point the model panel at a local Ollama endpoint instead")
    body = json.dumps({
        "model": POPULUS_MODEL,
        "max_tokens": max_tokens,
        # These are structured-extraction calls (loadings, populations), not
        # open-ended reasoning, so thinking off is faster and cheaper. Accepted
        # on Opus 5 at the default effort.
        "thinking": {"type": "disabled"},
        "system": system,
        "messages": messages,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body, method="POST",
        headers={
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read())
    # Assistant text lives in the first text block; a refusal has stop_reason
    # "refusal" and no usable text, so surface that rather than an empty string.
    if payload.get("stop_reason") == "refusal":
        raise RuntimeError("the model declined this request")
    for block in payload.get("content", []):
        if block.get("type") == "text":
            return block["text"]
    raise RuntimeError("no text in the model response")


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
        path = self.path.split("?")[0]
        if path == "/api/llm":
            return self._do_llm()
        if path != "/api/ledger":
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

    def _do_llm(self):
        """Proxy one chat turn to the hosted model. Accepts {system, prompt} or
        {system, messages, max_tokens}; returns {ok, text} or {ok:false, error}."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 1_000_000:
                raise ValueError("payload too large")
            req = json.loads(self.rfile.read(length) or b"{}")
            system = str(req.get("system") or "")
            messages = req.get("messages")
            if not messages:
                messages = [{"role": "user", "content": str(req.get("prompt") or "")}]
            max_tokens = min(int(req.get("max_tokens") or 2048), 8192)
            text = call_anthropic(system, messages, max_tokens)
            return self._send_json({"ok": True, "text": text, "model": POPULUS_MODEL})
        except urllib.error.HTTPError as exc:                     # the model API said no
            detail = exc.read().decode("utf-8", "replace")[:400]
            return self._send_json({"ok": False, "error": f"model API {exc.code}: {detail}"}, 502)
        except Exception as exc:                                  # noqa: BLE001
            # 503 when simply unconfigured, so the page can fall back quietly
            code = 503 if "ANTHROPIC_API_KEY" in str(exc) else 400
            return self._send_json({"ok": False, "error": str(exc)}, code)

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
    if ANTHROPIC_KEY:
        print(f"hosted model: on ({POPULUS_MODEL}) — key read from ANTHROPIC_API_KEY, "
              f"never sent to the browser")
    else:
        print("hosted model: off — set ANTHROPIC_API_KEY to enable /api/llm "
              "(the app still runs on the built-in markets and a local Ollama)")
    print(f"populus: http://localhost:{PORT}")
    print("ctrl-c to stop")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

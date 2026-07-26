#!/usr/bin/env bash
# Serve Populus over http://localhost so the local model will talk to it.
#
# Why this exists: opening index.html directly gives the page a file:// origin,
# and Ollama refuses cross-origin requests from file://. Served over localhost,
# Ollama's default CORS policy allows it and no configuration is needed.

set -e
PORT="${1:-8765}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! curl -s --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  echo "note: no Ollama server on :11434 — the app still runs, the model panel just won't connect."
  echo "      start it with 'ollama serve' or by opening the Ollama app."
else
  COUNT=$(curl -s --max-time 3 http://127.0.0.1:11434/api/tags | grep -o '"name"' | wc -l | tr -d ' ')
  echo "ollama: up, $COUNT model(s) installed"
  [ "$COUNT" = "0" ] && echo "        pull one first, e.g.: ollama pull qwen2.5:14b"
fi

echo "populus: http://localhost:$PORT"
echo "ctrl-c to stop"
cd "$DIR"
command -v python3 >/dev/null && exec python3 -m http.server "$PORT" --bind 127.0.0.1
exec npx --yes serve -l "$PORT" .

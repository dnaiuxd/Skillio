#!/bin/bash
#
# Double-click this file in Finder to start Skillio.
# It sets up the Python environment on first run, starts the server,
# and opens the app in your browser.
#
# Close this Terminal window (or press Ctrl-C) to stop the server.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/backend"

PORT=8787
URL="http://localhost:$PORT"

# Already running? Just open it.
if curl -fs -o /dev/null --max-time 2 "$URL/api/health"; then
  echo "Skillio is already running — opening $URL"
  open "$URL"
  exit 0
fi

# First run: create the venv. Then always sync deps with requirements.txt
# (a no-op in a second when nothing changed).
if [ ! -x .venv/bin/python3 ]; then
  echo "First run — setting up the Python environment (this takes a minute)…"
  python3 -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
fi
.venv/bin/pip install --quiet -r requirements.txt

# Open the browser once the server answers.
(
  for _ in $(seq 1 40); do
    if curl -fs -o /dev/null "$URL/api/health"; then
      open "$URL"
      break
    fi
    sleep 0.25
  done
) &

echo
echo "Skillio running at $URL"
echo "Close this window (or press Ctrl-C) to stop it."
echo

exec .venv/bin/uvicorn app:app --host 127.0.0.1 --port "$PORT"

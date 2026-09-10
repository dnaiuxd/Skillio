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

# 8787 is what a normal install uses and what the docs say. Override it to
# run a second checkout alongside the first — a development copy beside the
# one you actually use:
#
#     SKILLIO_PORT=8788 ./Skillio.command
#
# The two keep separate scan logs already: the database lives inside each
# checkout, so nothing is shared but the port.
PORT="${SKILLIO_PORT:-8787}"
URL="http://localhost:$PORT"

# Already running? Just open it.
if curl -fs -o /dev/null --max-time 2 "$URL/api/health"; then
  echo "Skillio is already running — opening $URL"
  open "$URL"
  exit 0
fi

# The newest stable Python at or above this. uv downloads a matching
# interpreter when the machine hasn't got one, which is the whole point:
# macOS ships Python 3.9, which is past end-of-life, and a venv built on
# Apple's copy is also a symlink into the Command Line Tools — so it breaks
# the next time those update. Without uv we fall back to whatever `python3`
# is, which still works; you just don't get the upgrade.
PYTHON_SPEC=">=3.11"

# A venv built by `python3 -m venv` writes an absolute shebang into every
# console script, so renaming or moving the repo leaves .venv/bin/uvicorn
# present and executable but pointing at a python that is no longer there.
# Testing python3 alone misses this: the interpreter symlink is absolute too
# and often still resolves, so the venv looks fine right up until exec fails.
# uv's venvs use a relocatable `#!/bin/sh` shim and don't have the problem,
# but the fallback path below does, so check what actually gets run.
venv_is_usable() {
  [ -x .venv/bin/python3 ] || return 1
  .venv/bin/python3 --version >/dev/null 2>&1 || return 1
  # Absent on a venv whose dependencies haven't been installed yet, which is
  # a perfectly good venv — only a present-but-unrunnable one is broken.
  [ ! -e .venv/bin/uvicorn ] || .venv/bin/uvicorn --version >/dev/null 2>&1
}

if ! venv_is_usable; then
  if [ -e .venv ]; then
    echo "The Python environment is broken — rebuilding it…"
    rm -rf .venv
  else
    echo "First run — setting up the Python environment (this takes a minute)…"
  fi
  if command -v uv >/dev/null 2>&1; then
    uv venv --python "$PYTHON_SPEC" .venv
  else
    python3 -m venv .venv
    .venv/bin/pip install --quiet --upgrade pip
  fi
fi

# `uv venv` leaves pip out on purpose, so which installer to use depends on
# how this venv was built — not on whether uv is on PATH right now.
if [ -x .venv/bin/pip ]; then
  .venv/bin/pip install --quiet -r requirements.txt
elif command -v uv >/dev/null 2>&1; then
  uv pip install --quiet --python .venv/bin/python -r requirements.txt
else
  echo "This environment was built by uv, which is no longer installed."
  echo "Delete backend/.venv and run this again to rebuild it."
  exit 1
fi

echo "Python $(.venv/bin/python3 --version 2>&1 | cut -d' ' -f2)"

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

SKILLIO_PORT="$PORT" exec .venv/bin/uvicorn app:app --host 127.0.0.1 --port "$PORT"

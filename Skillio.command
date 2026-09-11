#!/bin/bash
#
# Double-click this file in Finder to start Skillio.
# It sets up the Python environment on first run, starts the server,
# and opens the app in your browser.
#
# On the first run it offers to hand the server to macOS, so that it starts
# at login and needs no Terminal window. Take that and you never open this
# file again — the Dock icon is enough. Decline it and Skillio runs here,
# for as long as this window stays open.

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

say() { printf '  %s\n' "$*"; }

# The standalone window — no tabs, no address bar, no browser menus — is a
# real app that Chrome and Safari install for you, from a menu item that
# neither of them exposes to scripts. So this cannot be automated; what it
# CAN do is notice the app once it exists and open that instead of a tab.
# Locations differ by browser, and Chrome's folder carries a .localized
# suffix that Finder hides.
skillio_app() {
  for candidate in \
      "$HOME/Applications/Skillio.app" \
      "$HOME/Applications/Chrome Apps.localized/Skillio.app" \
      "$HOME/Applications/Chrome Apps/Skillio.app" \
      "/Applications/Skillio.app"; do
    if [ -d "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# Opens the standalone app when there is one. Returns non-zero when it fell
# back to an ordinary browser tab, which is the caller's cue to explain how
# to get the real window.
open_skillio() {
  installed="$(skillio_app)" || { open "$URL"; return 1; }
  open -a "$installed"
}

dock_hint() {
  printf '\n  One last step, once: turn Skillio into a real app window with no\n'
  printf '  tabs, no address bar and no browser menus.\n\n'
  if [ -d "/Applications/Google Chrome.app" ]; then
    say "Chrome:  ⋮ menu → Cast, save and share → Install page as app…"
  fi
  say "Safari:  File menu → Add to Dock…"
  printf '\n  You only do this once. After that it lives in your Dock, and\n'
  printf '  Skillio opens straight into it.\n\n'
}

# Already running? Just open it.
if curl -fs -o /dev/null --max-time 2 "$URL/api/health"; then
  echo "Skillio is already running — opening $URL"
  open_skillio || dock_hint
  exit 0
fi

# --- offer to hand it to macOS ---------------------------------------------
# Asked BEFORE the environment is built, for two reasons: the question arrives
# straight away rather than after a minute of silent setup, and saying yes
# hands the whole job to install-service.sh, which builds the venv itself.
# Doing it the other way round built the same venv twice.

# Same label the installer derives, so "is there already a service?" is asked
# about the right one when a second checkout runs on another port.
if [ "$PORT" = "8787" ]; then
  LABEL="com.skillio.gui"
else
  LABEL="com.skillio.gui.$PORT"
fi
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# Records a "no" so the question is asked once, not at every launch. Deleting
# this file is how you get asked again; the installer is also always there.
DECLINED="$SCRIPT_DIR/backend/.no-background-service"

# Three reasons not to ask: a service is already installed, the answer was
# already no, or nobody is there to answer. That last one matters — a
# .command double-clicked in Finder gets a terminal, but this file is also
# run from scripts, and a prompt written to a pipe just hangs forever.
if [ ! -f "$PLIST" ] && [ ! -f "$DECLINED" ] && [ -t 0 ]; then
  printf '\n  Skillio can run in this window — but then closing the window\n'
  printf '  stops it, and it is gone after a restart.\n\n'
  printf '  Or macOS can look after it: starts when you log in, restarts\n'
  printf '  itself if it crashes, and needs no window at all.\n\n'
  printf '  Hand it to macOS? [Y/n] '
  # Three outcomes, not two. A failed read is end-of-input — Ctrl-D, or a
  # pipe that closed — and that is not an answer: recording it as "no" would
  # permanently settle a question the user never actually answered.
  if read -r reply; then
    case "$reply" in
      [Nn]*)
        printf '\n'
        : > "$DECLINED"
        say "Right — Skillio will run in this window, and stops when you"
        say "close it. Two things you can still do, whenever you like:"
        printf '\n'
        say "  Put it in the Dock, as a proper app window:"
        if [ -d "/Applications/Google Chrome.app" ]; then
          say "    Chrome:  ⋮ menu → Cast, save and share → Install page as app…"
        fi
        say "    Safari:  File menu → Add to Dock…"
        printf '\n'
        say "  Hand it to macOS after all, so it starts at login:"
        say "    Run at login, at the bottom of the left rail in Skillio"
        say "    (or ./macos/install-service.sh)"
        printf '\n'
        ;;
      *)
        printf '\n'
        if SKILLIO_PORT="$PORT" "$SCRIPT_DIR/macos/install-service.sh"; then
          open_skillio || dock_hint
          say "Skillio is running, and will come back on its own from now on."
          say "To undo: ./macos/install-service.sh --uninstall"
          printf '\n  You can close this window.\n\n'
          exit 0
        fi
        # Do not strand anyone on a failed install — fall through and run the
        # server here, which is what they would have got anyway.
        printf '\n'
        say "That did not work, so Skillio will run in this window instead."
        printf '\n'
        ;;
    esac
  else
    printf '\n'
    say "No answer — starting Skillio in this window for now."
    say "You will be asked again next time."
    printf '\n'
  fi
elif [ -f "$DECLINED" ]; then
  # The offer is made once, so without this the way back is only ever
  # visible in the single run where it was turned down.
  printf '\n'
  say "Running in this window. To have macOS keep Skillio running instead,"
  say "click Run at login at the bottom of the left rail."
  printf '\n'
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
      open_skillio || true
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

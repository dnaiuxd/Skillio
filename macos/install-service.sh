#!/bin/bash
#
# Install (or reinstall) Skillio as a launchd background service.
#
#   ./macos/install-service.sh              install or upgrade
#   ./macos/install-service.sh --dry-run    show the plist, change nothing
#   ./macos/install-service.sh --no-start   write the agent, don't start it
#   ./macos/install-service.sh --uninstall  stop and remove
#
# Everything machine-specific is discovered at run time rather than baked
# into a checked-in plist, so this works from wherever the repo lives.
set -euo pipefail

PORT="${SKILLIO_PORT:-8787}"
# The label and the log carry the port when it isn't the default, so a second
# checkout installed as its own service cannot boot out the first one or write
# over its log. At the default port the names are unchanged, so an existing
# install upgrades in place.
if [ "$PORT" = "8787" ]; then
  LABEL="com.skillio.gui"
  LOG="$HOME/Library/Logs/skillio.log"
else
  LABEL="com.skillio.gui.$PORT"
  LOG="$HOME/Library/Logs/skillio-$PORT.log"
fi
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REAL_PLIST="$PLIST"
# Labels used by older versions. Booted out on install so a rename can't
# leave a second copy of the server running against the same port.
LEGACY_LABELS=("com.myskillspector.gui" "com.skillspector.gui")

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="gui/$(id -u)"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n error: %s\n' "$*" >&2; exit 1; }

bootout_if_loaded() {
  # bootout exits non-zero when the label isn't loaded; that's not an error.
  launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
  # It also returns BEFORE launchd has finished tearing the job down, so a
  # bootstrap issued straight afterwards fails with "Bootstrap failed: 5:
  # Input/output error" — and leaves the plist on disk with nothing loaded,
  # which is the app simply not running. Wait for the label to really go.
  for _ in $(seq 1 40); do
    launchctl print "$DOMAIN/$1" >/dev/null 2>&1 || return 0
    sleep 0.25
  done
}

# --- uninstall -------------------------------------------------------------
if [ "${1:-}" = "--uninstall" ]; then
  bootout_if_loaded "$LABEL"
  for legacy in "${LEGACY_LABELS[@]}"; do bootout_if_loaded "$legacy"; done
  rm -f "$PLIST"
  say "Removed $LABEL."
  say "Your scan log is untouched at $REPO/backend/skillio.db"
  exit 0
fi

DRY_RUN=0
# Writes and validates the agent but does not start it. The app itself uses
# this when it is holding the port: launchd would fail to bind, and KeepAlive
# would retry the crash forever. Something else starts it once the port frees.
NO_START=0
case "${1:-}" in
  --dry-run)
    DRY_RUN=1
    PLIST="$(mktemp -t skillio-plist)"
    printf '\nDry run — generating the plist only, nothing will be installed\n\n'
    ;;
  --no-start)
    NO_START=1
    printf '\nInstalling Skillio service (not starting it)\n\n'
    ;;
  *)
    printf '\nInstalling Skillio service\n\n'
    ;;
esac

# --- preflight -------------------------------------------------------------
# Kept in step with Skillio.command, which owns the real logic — it picks a
# current Python through uv when uv is there, and falls back to the system
# python3 when it isn't. Telling people `python3 -m venv` here would hand
# them the end-of-life 3.9 the launcher now avoids.
if command -v uv >/dev/null 2>&1; then
  VENV_SETUP="cd '$REPO/backend' && rm -rf .venv && uv venv --python '>=3.11' .venv && uv pip install --python .venv/bin/python -r requirements.txt"
else
  VENV_SETUP="cd '$REPO/backend' && rm -rf .venv && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
fi
UVICORN="$REPO/backend/.venv/bin/uvicorn"
# What launchd is actually pointed at. Named "Skillio" because macOS builds
# the Login Items list from the executable's filename — running uvicorn
# directly listed the agent as "uvicorn", twice, once per checkout.
# The everyday install is "Skillio"; a second checkout on another port is
# "Skillio-Dev", so the two are told apart in System Settings rather than
# appearing as two identical rows. Same rule as the label and the log above.
if [ "$PORT" = "8787" ]; then
  LAUNCHER="$REPO/macos/Skillio"
else
  LAUNCHER="$REPO/macos/Skillio-Dev"
fi

# Which installer to use depends on what the venv CONTAINS — `uv venv` ships
# no pip — not on whether uv happens to be on PATH right now.
install_requirements() {
  if [ -x "$REPO/backend/.venv/bin/pip" ]; then
    (cd "$REPO/backend" && .venv/bin/pip install --quiet -r requirements.txt)
  elif command -v uv >/dev/null 2>&1; then
    (cd "$REPO/backend" && uv pip install --quiet --python .venv/bin/python -r requirements.txt)
  else
    fail "This venv was built by uv, which is no longer installed.
       Rebuild it: $VENV_SETUP"
  fi
}

# Executable is not the same as runnable. A venv bakes its absolute path
# into every script's shebang, so moving or renaming the repo leaves
# uvicorn present, executable, and pointing at a python that no longer
# exists. launchd would accept the job and the port would stay silent.
venv_is_usable() {
  [ -x "$UVICORN" ] && "$UVICORN" --version >/dev/null 2>&1
}

# Build it rather than explain how to. This used to fail with the commands
# printed out, which put a wall between the one-click launcher and the
# background service: everyone who started by double-clicking Skillio.command
# had to open a terminal to get any further. Running the commands is strictly
# less work than reading them.
build_venv() {
  if [ -e "$REPO/backend/.venv" ]; then
    say "The Python environment is broken — rebuilding it…"
  else
    say "Setting up the Python environment (this takes a minute)…"
  fi
  rm -rf "$REPO/backend/.venv"
  if command -v uv >/dev/null 2>&1; then
    (cd "$REPO/backend" && uv venv --quiet --python '>=3.11' .venv) \
      || fail "Could not create the Python environment. Try by hand: $VENV_SETUP"
  else
    (cd "$REPO/backend" && python3 -m venv .venv) \
      || fail "Could not create the Python environment. Try by hand: $VENV_SETUP"
  fi
  # A venv with no packages in it has no uvicorn, so the usability check
  # below would fail on a perfectly good build. Install first, then verify.
  install_requirements || fail "Could not install dependencies. Try by hand: $VENV_SETUP"
  venv_is_usable || fail "Built a Python environment but uvicorn will not run.
       Try by hand: $VENV_SETUP"
}

[ -x "$LAUNCHER" ] || fail "Missing or non-executable: $LAUNCHER
       This is part of the repository; restore it with: git checkout macos/Skillio"

if ! venv_is_usable; then
  # --dry-run promises to change nothing, and building a venv is a change.
  if [ "$DRY_RUN" -eq 1 ]; then
    say "No usable venv at $REPO/backend/.venv — a real run would build one."
  else
    build_venv
  fi
fi

# --- bring dependencies up to date -----------------------------------------
# The plist runs uvicorn and nothing else, so a service restart picks up new
# CODE but never new DEPENDENCIES. That makes this script the update path: a
# `git pull` that raises a version floor in requirements.txt would otherwise
# leave the service starting against the old packages, and the failure lands
# in a log nobody is watching. Which installer to use depends on what the
# venv contains — `uv venv` ships no pip — not on whether uv is on PATH.
if [ "$DRY_RUN" -eq 0 ]; then
  say "Syncing dependencies…"
  install_requirements || fail "Could not install dependencies. Try: $VENV_SETUP"
fi

SKILLSPECTOR="$(command -v skillspector || true)"
if [ -n "$SKILLSPECTOR" ]; then
  SKILLSPECTOR_BIN_DIR="$(cd "$(dirname "$SKILLSPECTOR")" && pwd)"
  say "Found skillspector at $SKILLSPECTOR"
else
  # Not fatal: the app runs and shows "not found on PATH" in its header.
  SKILLSPECTOR_BIN_DIR="$HOME/.local/bin"
  say "WARNING: skillspector is not on your PATH. The app will start but"
  say "         cannot scan until you install it:"
  say "         uv tool install git+https://github.com/NVIDIA/skillspector.git"
fi

# --- carry the LLM provider forward ---------------------------------------
# A launchd agent gets none of your shell environment, so the provider has
# to live in the plist. Losing it on reinstall is silent — scans keep
# succeeding, they just quietly stop running the semantic analyzers — so
# prefer an explicit value, then whatever the previous install had.
read_provider_from() {
  [ -f "$1" ] || return 1
  /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:SKILLSPECTOR_PROVIDER" "$1" 2>/dev/null
}
PROVIDER_ASKED=0
PROVIDER="${SKILLSPECTOR_PROVIDER:-}"
PROVIDER_SOURCE="the SKILLSPECTOR_PROVIDER in your shell"
if [ -z "$PROVIDER" ]; then
  PROVIDER="$(read_provider_from "$REAL_PLIST" || true)"
  PROVIDER_SOURCE="your previous install"
fi
if [ -z "$PROVIDER" ]; then
  for legacy in "${LEGACY_LABELS[@]}"; do
    PROVIDER="$(read_provider_from "$HOME/Library/LaunchAgents/$legacy.plist" || true)"
    [ -n "$PROVIDER" ] && { PROVIDER_SOURCE="your previous install ($legacy)"; break; }
  done
fi

# Nothing known and someone is watching: ask, rather than quietly installing a
# static-only service. This is the only moment the omission is visible — from
# the app a static-only scan looks like a successful scan, because it is one;
# it just never judged whether the skill does what it says. Only offered when
# `claude` is actually on PATH, since configuring a provider that isn't there
# would trade a silent gap for a loud failure on every scan.
if [ -z "$PROVIDER" ] && [ "$DRY_RUN" -eq 0 ] && [ "$NO_START" -eq 0 ] \
   && [ -t 0 ] && command -v claude >/dev/null 2>&1; then
  printf '\n  Skillio can run three extra analyzers that judge whether a skill\n'
  printf '  really does what it claims — the part no static check can see.\n'
  printf '  They can use your existing Claude Code login: no API key needed.\n\n'
  printf '  Turn them on? [Y/n] '
  PROVIDER_ASKED=1
  if read -r reply; then
    case "$reply" in
      [Nn]*) say "Left off — scans will be static-only." ;;
      *)     PROVIDER="claude_cli"; PROVIDER_SOURCE="your answer just now" ;;
    esac
  else
    # Piped, closed, or walked away from. Silence is not consent: these scans
    # spend the user's Claude plan, so default to off and say so.
    printf '\n'
    say "No answer — leaving the semantic analyzers off."
  fi
fi

PROVIDER_XML=""
if [ -n "$PROVIDER" ]; then
  say "LLM provider: $PROVIDER (from $PROVIDER_SOURCE)"
  PROVIDER_XML="
        <key>SKILLSPECTOR_PROVIDER</key>
        <string>$PROVIDER</string>"
elif [ "$PROVIDER_ASKED" -eq 1 ]; then
  # Just asked and told no. Repeating the pitch here said the same thing
  # three ways in a row; one line is enough to record the choice.
  say "  Change your mind: SKILLSPECTOR_PROVIDER=claude_cli ./macos/install-service.sh"
else
  say "No LLM provider set — scans will be static-only."
  say "  To enable the semantic analyzers, re-run as:"
  say "    SKILLSPECTOR_PROVIDER=claude_cli ./macos/install-service.sh"
fi

# --- carry the log across a rename ----------------------------------------
# Newest first: if several old databases are lying around, the most recent
# naming wins rather than resurrecting a stale one.
NEW_DB="$REPO/backend/skillio.db"
if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$NEW_DB" ]; then
  for old in myskillspector.db skillspector_gui.db; do
    if [ -f "$REPO/backend/$old" ]; then
      mv "$REPO/backend/$old" "$NEW_DB"
      say "Moved your existing scan log ($old) to skillio.db"
      break
    fi
  done
fi

# --- write the plist -------------------------------------------------------
mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$LAUNCHER</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$REPO/backend</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$REPO/backend/.venv/bin:$SKILLSPECTOR_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <!-- The app reads this to build its CORS allowlist; --port above only
             tells uvicorn where to listen, not the server what its origin is. -->
        <key>SKILLIO_PORT</key>
        <string>$PORT</string>$PROVIDER_XML
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ProcessType</key>
    <string>Background</string>

    <key>StandardOutPath</key>
    <string>$LOG</string>

    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
PLIST_EOF

plutil -lint "$PLIST" >/dev/null || fail "Generated an invalid plist at $PLIST"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n--- %s ---\n' "$PLIST"
  cat "$PLIST"
  printf -- '--- end ---\n\n'
  say "Valid plist. Nothing installed; re-run without --dry-run to apply."
  rm -f "$PLIST"
  exit 0
fi

if [ "$NO_START" -eq 1 ]; then
  say "Wrote $PLIST"
  say "Not started — launchd will run it from your next login, or sooner if"
  say "something bootstraps it once port $PORT is free."
  printf '\n'
  exit 0
fi

# --- (re)load --------------------------------------------------------------
# bootout then bootstrap, never kickstart: kickstart restarts the process
# without re-reading the plist, so a changed provider would not take effect.
for legacy in "${LEGACY_LABELS[@]}"; do
  if [ -f "$HOME/Library/LaunchAgents/$legacy.plist" ] || launchctl print "$DOMAIN/$legacy" >/dev/null 2>&1; then
    bootout_if_loaded "$legacy"
    rm -f "$HOME/Library/LaunchAgents/$legacy.plist"
    say "Removed the old $legacy service"
  fi
done
bootout_if_loaded "$LABEL"
# Belt and braces: even after the label is gone, launchd can still refuse the
# bootstrap for a moment. Retry, then let the real error through on the last
# attempt rather than swallowing it.
for attempt in 1 2 3 4; do
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && break
  [ "$attempt" = "4" ] && launchctl bootstrap "$DOMAIN" "$PLIST"
  sleep 1
done

# --- verify ----------------------------------------------------------------
printf '\n  Waiting for the server'
for _ in $(seq 1 20); do
  if curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    printf '\r%*s\r' 40 ''
    say "Running at http://localhost:$PORT"
    say "Logs: $LOG"
    printf '\n'
    exit 0
  fi
  printf '.'
  sleep 1
done

printf '\n'
fail "Service installed but did not answer on port $PORT within 20s.
       Check the log: $LOG"

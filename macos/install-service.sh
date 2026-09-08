#!/bin/bash
#
# Install (or reinstall) Skillio as a launchd background service.
#
#   ./macos/install-service.sh              install or upgrade
#   ./macos/install-service.sh --dry-run    show the plist, change nothing
#   ./macos/install-service.sh --uninstall  stop and remove
#
# Everything machine-specific is discovered at run time rather than baked
# into a checked-in plist, so this works from wherever the repo lives.
set -euo pipefail

LABEL="com.skillio.gui"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REAL_PLIST="$PLIST"
LOG="$HOME/Library/Logs/skillio.log"
PORT=8787
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
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  PLIST="$(mktemp -t skillio-plist)"
  printf '\nDry run — generating the plist only, nothing will be installed\n\n'
else
  printf '\nInstalling Skillio service\n\n'
fi

# --- preflight -------------------------------------------------------------
VENV_SETUP="cd '$REPO/backend' && rm -rf .venv && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
UVICORN="$REPO/backend/.venv/bin/uvicorn"
[ -x "$UVICORN" ] || fail "No venv found at $REPO/backend/.venv
       Create it first:
         $VENV_SETUP"

# Executable is not the same as runnable. A venv bakes its absolute path
# into every script's shebang, so moving or renaming the repo leaves
# uvicorn present, executable, and pointing at a python that no longer
# exists. launchd would accept the job and the port would stay silent.
"$UVICORN" --version >/dev/null 2>&1 || fail "The venv at $REPO/backend/.venv is broken.
       Its scripts point at a path that no longer exists, which is what
       happens when the repo is moved or renamed. Rebuild it:
         $VENV_SETUP"

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

PROVIDER_XML=""
if [ -n "$PROVIDER" ]; then
  say "LLM provider: $PROVIDER (from $PROVIDER_SOURCE)"
  PROVIDER_XML="
        <key>SKILLSPECTOR_PROVIDER</key>
        <string>$PROVIDER</string>"
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
        <string>$UVICORN</string>
        <string>app:app</string>
        <string>--host</string>
        <string>127.0.0.1</string>
        <string>--port</string>
        <string>$PORT</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$REPO/backend</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$REPO/backend/.venv/bin:$SKILLSPECTOR_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>$PROVIDER_XML
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
launchctl bootstrap "$DOMAIN" "$PLIST"

# --- verify ----------------------------------------------------------------
printf '\n  Waiting for the server'
for _ in $(seq 1 20); do
  if curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    printf '\r'
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

# SkillSpector GUI

A local dashboard for [NVIDIA SkillSpector](https://github.com/NVIDIA/SkillSpector):
scan an agent skill, browse a history of everything you've scanned, and
approve or reject each one before you install it.

It's a thin wrapper — all the actual security analysis is done by the
`skillspector` CLI. This app just gives you a browsable log instead of
reading terminal output every time.

## 1. Install SkillSpector itself (one-time)

```bash
git clone https://github.com/NVIDIA/SkillSpector.git
cd SkillSpector
uv venv && source .venv/bin/activate
make install
```

Confirm it's on your PATH:

```bash
skillspector --version
```

If you want the optional LLM semantic pass (the "LLM review" checkbox in
the GUI), set a provider — otherwise leave it off and the GUI runs static
analysis only:

```bash
export SKILLSPECTOR_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
```

## 2. Get the GUI

```bash
git clone https://github.com/dnaiuxd/skills-spector.git
```

### Run it — one-click (macOS)

Double-click **`SkillSpector.command`** in the repo root. On the first
run it creates the Python environment and installs dependencies; after
that it just starts the server and opens the app in your browser. Close
the Terminal window it opens to stop the server. Double-clicking it
again while it's already running simply reopens the tab.

### Run it — always (background service, macOS)

To have `http://localhost:8787` up permanently — started at login,
restarted if it crashes, surviving reboots — install the bundled
launchd agent:

```bash
cp macos/com.skillspector.gui.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.skillspector.gui.plist
```

The paths inside the plist are absolute — edit them if the repo doesn't
live at `~/Projects/skills-spector`, or if you rebuild `backend/.venv`.
Run `backend` setup once first (the "manually" steps below, through
`pip install`) so the venv exists. Logs go to
`~/Library/Logs/skillspector-gui.log`.

To stop and remove it:

```bash
launchctl bootout gui/$(id -u)/com.skillspector.gui
rm ~/Library/LaunchAgents/com.skillspector.gui.plist
```

### Install it as an app

With the server running, open `http://localhost:8787` and add it to your
Dock as a standalone window:

- **Chrome** — ⋮ → *Cast, save, and share* → **Install page as app…**
  (the manifest makes this option appear; an install icon also shows in
  the address bar)
- **Safari 17+** — File → **Add to Dock**

The Dock icon only opens the window — it still needs the server up, so
pair it with the background service above.

### Run it — manually

```bash
cd skills-spector/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8787
```

The backend serves the static frontend, so there's nothing else to
start. Open **http://localhost:8787**.

## Using it

- **Scan bar** — paste a git URL, a local path, or a `.zip`, then hit
  Scan. Re-scanning the same source updates its existing row rather than
  duplicating it, so you get a fresh score after a skill's code changes.
- **Log** — every skill you've scanned, sorted by most recent. Score,
  verdict, and gate status at a glance; the score is color-coded
  (green ≤ 20, amber 21–50, red > 50).
- **Detail view** — click any row for the full findings list, grouped by
  severity, plus the raw error if a scan failed (e.g. skillspector not
  found, or the source is unreachable).
- **Gate** — Approve / Reject / Reset. This is local state for your own
  workflow — a simple record of "I looked at this and decided," not
  something that blocks an install anywhere else. Wire it into your own
  install scripts if you want it to be enforced.

## Notes

- Data lives in `backend/skillspector_gui.db` (SQLite, git-ignored) —
  delete it to reset the log.
- The findings parser expects roughly the shape SkillSpector's `--format
  json` output currently has (`findings[]` with `rule_id`, `severity`,
  `file`, `start_line`, `message`/`explanation`). If a future SkillSpector
  release renames fields, the score/verdict at the top of the report
  should still be picked up even if individual findings render sparsely —
  check `app.js`'s `renderFindings` / `_extract_score_and_verdict` if the
  schema drifts.
- Scans run synchronously (the request blocks until `skillspector`
  finishes) and time out after 5 minutes. That's fine for single skills
  but will feel slow on a big repo with the LLM pass on. If that becomes
  a problem, the natural next step is a background job queue instead of a
  blocking POST.

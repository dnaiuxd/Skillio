# Skillio

A local dashboard for [NVIDIA SkillSpector](https://github.com/NVIDIA/SkillSpector):
scan an agent skill or the MCP Registry, browse a history of everything
you've scanned, and approve or reject each one before you install it.

It's a thin wrapper — all the actual security analysis is done by the
`skillspector` CLI. This app just gives you a browsable log instead of
reading terminal output every time.

> **Not affiliated with NVIDIA.** Skillio is an independent,
> unofficial front-end. **SkillSpector** is NVIDIA's tool, distributed
> separately under Apache-2.0 and installed by you — it is not bundled,
> modified, or redistributed here. Every security finding you see comes
> from it, not from this app. Names and trademarks belong to their
> respective owners.

## 1. Install SkillSpector itself (one-time)

SkillSpector is a separate tool — this GUI only drives it. Install it
with [uv](https://docs.astral.sh/uv/) so the `skillspector` command lands
on your PATH:

```bash
uv tool install git+https://github.com/NVIDIA/skillspector.git
```

Confirm it's there:

```bash
skillspector --version
```

The GUI shows "skillspector ready" in the top-right when it can find it,
"skillspector not found on PATH" otherwise.

If you want the optional LLM semantic pass (the "Review using LLM"
switch in the GUI), set a provider. Without one, SkillSpector does not error — it
quietly skips the semantic analyzers and returns a static-only report, so
the GUI shows a warning on the detail page when that happens.

If you already have the Claude Code CLI, the simplest option needs no API
key at all — `claude_cli` reuses its existing login (it spends that
subscription's quota rather than a separate API budget):

```bash
export SKILLSPECTOR_PROVIDER=claude_cli
```

Otherwise pick a provider and give it a key:

```bash
export SKILLSPECTOR_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
```

`skillspector scan --help` lists every supported provider. Three analyzers
turn on with any of them — `semantic_developer_intent`,
`semantic_quality_policy`, `semantic_security_discovery` — on top of the
~20 static ones that always run. They judge whether a skill's behaviour
matches its stated purpose, which matters because a `SKILL.md` is prose
your agent obeys and malicious instructions there have no code signature.

## 2. Get the GUI

```bash
git clone https://github.com/dnaiuxd/skillio.git
```

### Run it — one-click (macOS)

Double-click **`Skillio.command`** in the repo root. On the first
run it creates the Python environment and installs dependencies; after
that it just starts the server and opens the app in your browser. Close
the Terminal window it opens to stop the server. Double-clicking it
again while it's already running simply reopens the tab.

**Which Python you get.** macOS ships 3.9, which is past end-of-life, and
a venv built on Apple's copy is a symlink into the Command Line Tools that
breaks the next time those update. So if [uv](https://docs.astral.sh/uv/)
is installed — and it already is, if you installed SkillSpector the
documented way — the launcher builds the environment with
`uv venv --python '>=3.11'`, which uses the newest stable Python on the
machine and downloads one if there isn't a suitable one. Without uv it
falls back to the system `python3`; the app still runs, you just don't get
the upgrade.

uv's environments are also relocatable — its console scripts use a
`#!/bin/sh` shim rather than an absolute shebang — so moving or renaming
the folder no longer breaks them. The launcher checks anyway: it runs
`.venv/bin/uvicorn` rather than trusting the file to be there, because a
stdlib venv survives a move with a working `python3` and a `uvicorn` that
dies with "bad interpreter". If it finds one in that state it rebuilds it.

### Run it — always (background service, macOS)

To have `http://localhost:8787` up permanently — started at login,
restarted if it crashes, surviving reboots:

```bash
SKILLSPECTOR_PROVIDER=claude_cli ./macos/install-service.sh
```

The script writes the launchd agent from wherever the repo actually
lives, so there are no paths to hand-edit. It finds `skillspector` on
your PATH and puts its directory into the agent's environment, since a
launchd job inherits nothing from your shell. Add `--dry-run` to see the
plist it would write without installing anything.

`SKILLSPECTOR_PROVIDER` matters: a launchd agent can't see the variable
you exported in a terminal, and without it in the plist the scan silently
falls back to static-only. Set it on the command line as above, and on
later re-runs the script carries it forward from your previous install
so a reinstall can't quietly disable the semantic analyzers. With
`claude_cli` there's no secret to store; a key-based provider lands in a
plaintext file in your home directory.

Run `backend` setup once first (the "manually" steps below, through
`pip install`) so the venv exists — the script checks and tells you if
it's missing. Logs go to `~/Library/Logs/skillio.log`.

Re-run the same command any time to pick up changes; it reloads with
`bootout` + `bootstrap` rather than `kickstart`, which restarts the
process **without** re-reading the plist and would silently ignore a
changed provider.

To stop and remove it (your scan log is untouched):

```bash
./macos/install-service.sh --uninstall
```

**Don't run a second server by hand while the agent is installed.** The
agent has `KeepAlive`, so if something else already holds port 8787 it
starts, fails to bind, exits, and launchd restarts it — forever. That
loop is not harmless: uvicorn runs the app's startup hook *before* it
binds the port, and startup is where the orphaned-scan sweep lives, so
every lap through the loop marks any scan currently in flight as "the
server stopped while this scan was running". The scan itself keeps going
and its real result still lands when it finishes, but the log says it
failed in the meantime. Check with:

```bash
tail ~/Library/Logs/skillio.log     # "address already in use", over and over
launchctl list | grep skillio       # a non-zero exit status in column 2
```

Fix it by stopping whichever server you started by hand, or by
uninstalling the agent if you'd rather launch it yourself.

### Install it as an app

With the server running, open `http://localhost:8787` and add it to your
Dock as a standalone window:

- **Chrome** — ⋮ → *Cast, save, and share* → **Install page as app…**
  (the manifest makes this option appear; an install icon also shows in
  the address bar)
- **Safari 17+** — File → **Add to Dock**

The Dock icon only opens the window — it still needs the server up, so
pair it with the background service above.

### Run two checkouts side by side

Useful if you're changing Skillio and want the copy you actually *use* left
alone. Point the second one at another port:

```bash
SKILLIO_PORT=8788 ./Skillio.command
```

The two share nothing. The scan log lives inside each checkout
(`backend/skillio.db`), so they keep separate histories, and the server
builds its CORS allowlist from `SKILLIO_PORT` — hardcoding 8787 there used
to mean the second instance's own browser origin was refused by its own
backend.

The background service takes the same variable, and at a non-default port
it names itself and its log after it — `com.skillio.gui.8788` and
`~/Library/Logs/skillio-8788.log` — so installing one cannot boot out the
other. At 8787 the names are unchanged, so an existing install upgrades in
place.

A workable split: keep the everyday copy on 8787 as the background service,
and run the one you're editing on 8788 by hand, only when you want it. One
service on the machine means the two can never contend for a port.

### Run it — manually

```bash
cd skillio/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8787
```

The backend serves the static frontend, so there's nothing else to
start. Open **http://localhost:8787**.

## Using it

- **Registry reports are trimmed before they are stored.** A live scan of
  the official registry came back at 196 MB — 96,854 servers, 98,029
  findings — of which about 180 MB was `servers` and `snapshots`,
  per-server payload this app never renders. Those two keys are dropped
  and the findings list is capped at 1,000, taking the stored report to
  about 0.16 MB. The true count is kept and the detail page says how many
  were left out, because a short findings list must never be mistaken for
  a clean one. The score is SkillSpector's and reflects all of them.
  The gate fingerprint is taken *before* the trim, over the full report —
  otherwise a registry could be rewritten past the 1,000th finding, hash
  identical, and keep an approval you never gave it.
- **Skill / MCP Registry** — which of the two things SkillSpector reads.
  A registry URL and a skill URL are not distinguishable by shape, so the
  choice is stated rather than guessed, and it is passed straight through
  as `--mcp-registry`. SkillSpector accepts only the official registry
  endpoint — `https://registry.modelcontextprotocol.io/v0/servers`,
  exactly, without query parameters — and rejects anything else. Registry
  mode hides the `.zip` drop zone, which cannot be a registry.
  **A registry scan often fails partway through, and that is upstream.**
  The registry pages 30 servers at a time, so covering ~96,850 of them
  takes roughly 3,200 sequential requests. Measured over 120 of those,
  about 1.7% came back `500`; the same cursor fetched fine on an
  immediate retry, but SkillSpector aborts on the first one rather than
  retrying, so a full pass rarely survives. The failure is recorded on
  the row like any other — score `—`, verdict `Error`, the stderr on the
  detail page — so nothing is corrupted, and re-running is the only
  remedy from this side.
- **Scan bar** — paste a git URL, a local path, or a `.zip` (`~` is
  expanded), or drop a `.zip` onto the upload area / click it to browse.
  Then hit Scan. Re-scanning the same source updates its existing row
  rather than duplicating it, so you get a fresh score after a skill's
  code changes. Uploads are streamed to a temp file, scanned, and
  deleted — only the report is kept, and they're identified by a hash of
  their contents, so two unrelated files both named `skill.zip` stay
  separate rows instead of overwriting each other.
- **Skillio Scan** — every skill you've scanned, sorted by most recent. The
  ⓘ beside the heading opens a short "What is Skillio?" dialog; it reads
  once and then it is in the way, so it lives behind a trigger rather than
  standing above the table. Score,
  verdict, and gate status at a glance. The risk band comes from the
  report's own `risk_assessment.severity` rather than being re-derived
  here, so it can't drift from what SkillSpector decided — four bands,
  matching its `_RISK_SEVERITY_BANDS`: LOW 0–20, MEDIUM 21–50, HIGH
  51–80, CRITICAL 81–100. HIGH and CRITICAL share the red treatment
  because both mean DO NOT INSTALL, but each still shows its own name.
  The **Current / Archived** toggle switches which set you're
  looking at.
- **Detail view** — click any row for the full findings list, grouped by
  severity, plus the raw error if a scan failed (e.g. skillspector not
  found, or the source is unreachable). An **LLM review** chip appears when
  the semantic pass actually ran, and an amber notice appears when
  SkillSpector could only partially inspect the skill — worth reading,
  because "no findings" from a scan that couldn't parse the files is not
  the same as "clean".
  Three separate things are reported separately, because conflating them
  is confusing: the **N files scanned** chip is scope (what was looked
  at), the amber notice is completeness (how fully it was read), and the
  findings list is results (what was wrong). **Files scanned** at the
  bottom expands to the full inventory — every file SkillSpector
  enumerated, the ones with findings first, each marked clean or carrying
  its worst severity. A clean file never appears in the findings list, so
  without this there's no way to tell "scanned and fine" from "not
  scanned".
- **Gate** — Install / Do Not Install. This is local state for your own
  workflow — a simple record of "I looked at this and decided," not
  something that blocks an install anywhere else. Wire it into your own
  install scripts if you want it to be enforced.
  **Install Status** reads Pending until you decide, then Approved or Not
  Approved. Deciding hides both buttons and leaves a **Reset**, which
  clears the gate back to Pending and hands them back — so a decision is
  deliberate but never a trap.
  A decision applies to the report you saw, so if a re-scan comes back
  different — the score, the verdict, or which findings were raised — the
  gate resets to pending and says so on the detail page. An identical
  re-scan keeps your decision, so checking for drift costs you nothing.
- **Archive** — moves a scan out of the current log without losing it.
  Find it under the Archived tab, where **Restore to Scanned Skill** puts
  it back with its decision intact, and **Reset** puts it back *and*
  reopens the gate so you can decide again. Re-scanning an archived
  source also brings it back automatically. **Delete permanently**
  (archived items only) is the one irreversible action.

## Notes

- Fonts are self-hosted (latin `.woff2` subsets in `frontend/fonts/`, no
  CDN call): Noto Sans for headings and body/UI, Noto Sans Mono for code.
  Licenses sit next to the files (both are OFL).
- **The commands are on the page, not on GitHub.** Both states that ask you
  to run something — "not found on PATH" and "an update is available" — show
  the exact `uv tool` command inline, with one line saying where to run it
  and that your scan log isn't touched. An ⓘ beside either opens a single
  **Installing & upgrading SkillSpector** dialog: what `uv tool` does with
  its isolated environments, why the shim path never changes, what an
  unpinned git install actually fetches, and what to do when `skillspector`
  still isn't found — including the launchd case, where the agent carries
  its own PATH and needs `./macos/install-service.sh` re-run.
- **Check for updates** in the sidebar compares your installed
  `skillspector` against the newest tag on NVIDIA's repo and links to it.
  It runs only when you click it — nothing is checked on load, on a
  schedule, or in the background — and it is the only outbound call this
  app makes; everything else is local. Versions are compared as numbers,
  not text, so 2.10.0 correctly outranks 2.9.0.
- Data lives in `backend/skillio.db` (SQLite, git-ignored) —
  delete it to reset the log.
- **Theme** follows your OS by default; the sun/moon switch in the
  top-right overrides it either way and the choice is remembered. The light
  palette is the original cream one; dark is GitHub Primer's, token for
  token — `canvas.default` #0d1117, `canvas.subtle` #161b22, `fg.default`
  #e6edf3, `fg.muted` #8b949e — with its own status colours rather than
  the light ones reused. Links use Primer's `accent.fg` in both — those are dark by design and would fail contrast on a dark
  ground. Every pairing the CSS actually uses was checked against WCAG
  2.2 AA (text ≥ 4.5:1, control boundaries ≥ 3:1).
- SkillSpector fails closed: a LOW-band result that would normally read
  SAFE is downgraded to CAUTION whenever the scan was degraded or
  incomplete. That's why a skill can score 0 and still say Caution — the
  detail page says so explicitly rather than leaving it looking like a
  contradiction.
- The parser targets SkillSpector v2.11's `--format json` shape:
  `risk_assessment.{score,severity,recommendation}` for the headline, and an
  `issues[]` array (one entry per code location — the GUI collapses
  repeats of a `finding_id` into one row) with `severity`, `location`,
  `pattern`, `explanation`, `remediation`. The top-level keys
  (`risk_score`, `findings[]`) are also accepted — and they are not just
  a legacy fallback any more: an `--mcp-registry` scan returns exactly
  that shape, with `mcp_registry`, `server_count` and `max_risk_score`
  alongside. So both branches are live, one per target type, and there
  are tests over each. If a later release renames things, check
  `_extract_score_and_verdict` in `backend/app.py` and `renderFindings`
  in `frontend/app.js`.
- Scans run in the background. The POST returns as soon as the row
  exists, and the row carries its own progress: it shows up in the log
  marked *scanning…* and fills in when `skillspector` finishes. So the
  scan is visible where you'd look for it, and reloading the page or
  closing the tab doesn't lose it — the state lives on the server, not in
  the tab. A re-scan keeps the previous score on show, dimmed, until the
  new one lands; the old answer is still the best one available until
  then. One scan runs at a time — a second request gets a 409 rather than
  queueing. A skill scan times out after 5 minutes; a registry scan gets
  30, because the official registry is hundreds of servers read in one
  pass and measured past 5 minutes on its own, while a *skill* still
  running at 5 minutes is stuck. If the server
  stops mid-scan, that row is closed out on the next start and says so,
  instead of spinning forever with nothing behind it.

## Tests

```bash
./run-tests.sh
```

Stdlib `unittest` for the backend and a dependency-free Node script for
the frontend — nothing to install beyond the venv you already made.

They cover the pure functions, which is where every bug this app has
shipped actually lived: report parsing (`_extract_score_and_verdict`),
the gate fingerprint that decides whether a re-scan invalidates your
decision (`_report_fingerprint`), the risk band (`severityBand`), the
incomplete-scan notice (`coverageNotice`), and severity counting. The
scan lifecycle is covered too — the one-at-a-time slot, and the startup
sweep that closes out a scan orphaned by a restart — against a throwaway
database in a temp directory. No network and no `skillspector` binary;
the whole suite still runs in well under a second.

`frontend/tests/run.js` loads `app.js` behind a small DOM stub rather
than copying functions out of it, so renaming something in the app fails
the suite instead of silently testing a stale copy. The stub hands back a
node for any id asked of it, which would happily hide a control deleted
from the markup — so one test reads `index.html` and checks that every id
`app.js` looks up is really there.

## Releasing

Skillio's version lives in exactly one place: `SKILLIO_VERSION` in
`backend/app.py`. The footer and the left rail read it from
`/api/health` rather than keeping a second copy, so there is nothing to
keep in sync by hand.

```bash
./release.sh patch          # 1.0.0 -> 1.0.1
./release.sh minor          # 1.0.0 -> 1.1.0
./release.sh major          # 1.0.0 -> 2.0.0
./release.sh 1.4.2          # or set it outright
./release.sh minor --dry-run
```

It validates the version first, so a typo is rejected on its own terms
rather than behind a complaint about your tree. Only a strict
`MAJOR.MINOR.PATCH` is accepted — `1.4.2.7` and `01.2.3` are refused, and
the test gate cannot catch those for you because it runs against the tree
*before* the bump. Then it refuses to run off `main`, refuses on a dirty
tree, refuses if the tag already exists, and runs both suites — a tag is a
claim that the commit works. Finally it rewrites the one version line,
commits it as `Release vX.Y.Z`, and adds an annotated tag.

It does not push. The last line prints the command:

```bash
git push --follow-tags origin main
```

## License

[MIT](LICENSE) — do what you like with it, keep the copyright notice.

Two things it doesn't cover:

- **SkillSpector is not bundled here.** It's a separate NVIDIA tool under
  Apache-2.0 that you install yourself; this app invokes it as a
  subprocess. Its licence governs it, not this repo.
- **The bundled fonts keep their own licences** — see
  `frontend/fonts/LICENSE-*.txt` (OFL for both). MIT covers the code, not the typefaces.

# My SkillSpector

A local dashboard for [NVIDIA SkillSpector](https://github.com/NVIDIA/SkillSpector):
scan an agent skill, browse a history of everything you've scanned, and
approve or reject each one before you install it.

It's a thin wrapper — all the actual security analysis is done by the
`skillspector` CLI. This app just gives you a browsable log instead of
reading terminal output every time.

> **Not affiliated with NVIDIA.** My SkillSpector is an independent,
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
git clone https://github.com/dnaiuxd/skills-spector.git
```

### Run it — one-click (macOS)

Double-click **`My SkillSpector.command`** in the repo root. On the first
run it creates the Python environment and installs dependencies; after
that it just starts the server and opens the app in your browser. Close
the Terminal window it opens to stop the server. Double-clicking it
again while it's already running simply reopens the tab.

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
it's missing. Logs go to `~/Library/Logs/myskillspector.log`.

Re-run the same command any time to pick up changes; it reloads with
`bootout` + `bootstrap` rather than `kickstart`, which restarts the
process **without** re-reading the plist and would silently ignore a
changed provider.

To stop and remove it (your scan log is untouched):

```bash
./macos/install-service.sh --uninstall
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

- **Scan bar** — paste a git URL, a local path, or a `.zip` (`~` is
  expanded), or drop a `.zip` onto the upload area / click it to browse.
  Then hit Scan. Re-scanning the same source updates its existing row
  rather than duplicating it, so you get a fresh score after a skill's
  code changes. Uploads are streamed to a temp file, scanned, and
  deleted — only the report is kept, and they're identified by a hash of
  their contents, so two unrelated files both named `skill.zip` stay
  separate rows instead of overwriting each other.
- **Log** — every skill you've scanned, sorted by most recent. Score,
  verdict, and gate status at a glance. The risk band comes from the
  report's own `risk_assessment.severity` rather than being re-derived
  here, so it can't drift from what SkillSpector decided — four bands,
  matching its `_RISK_SEVERITY_BANDS`: LOW 0–20, MEDIUM 21–50, HIGH
  51–80, CRITICAL 81–100. HIGH and CRITICAL share the red treatment
  because both mean DO NOT INSTALL, but each still shows its own name.
  The **Scanned Skill / Archived** toggle switches which set you're
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
  CDN call): Bebas Neue for the wordmark, Montserrat for headings, Open
  Sans for body/UI, system mono for code. Licenses sit next to the files
  (all three are OFL).
- Data lives in `backend/myskillspector.db` (SQLite, git-ignored) —
  delete it to reset the log.
- **Dark theme** follows your OS by default; the sun/moon switch in the
  top-right overrides it either way and the choice is remembered. The dark palette
  is warm rather than neutral grey, so the cream character survives, and
  the status colours are separate values rather than the light ones
  reused — those are dark by design and would fail contrast on a dark
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
  `pattern`, `explanation`, `remediation`. Older top-level keys
  (`risk_score`, `findings[]`) are still accepted as a fallback. If a
  later release renames things, check `_extract_score_and_verdict` in
  `backend/app.py` and `renderFindings` in `frontend/app.js`.
- Scans run synchronously (the request blocks until `skillspector`
  finishes) and time out after 5 minutes. That's fine for single skills
  but will feel slow on a big repo with the LLM pass on. If that becomes
  a problem, the natural next step is a background job queue instead of a
  blocking POST.

## License

[MIT](LICENSE) — do what you like with it, keep the copyright notice.

Two things it doesn't cover:

- **SkillSpector is not bundled here.** It's a separate NVIDIA tool under
  Apache-2.0 that you install yourself; this app invokes it as a
  subprocess. Its licence governs it, not this repo.
- **The bundled fonts keep their own licences** — see
  `frontend/fonts/LICENSE-*.txt` (OFL for Montserrat, Open Sans,
  and Bebas Neue). MIT covers the code, not the typefaces.

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

## 2. Install and run the GUI

```bash
cd skillspector-gui/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8787
```

Open **http://localhost:8787**.

## Using it

- **Scan bar** — paste a git URL, a local path, or a `.zip`, then hit
  Scan. Re-scanning the same source updates its existing row rather than
  duplicating it, so you get a fresh score after a skill's code changes.
- **Log** — every skill you've scanned, sorted by most recent. Score,
  verdict, and gate status at a glance.
- **Detail view** — click any row for the full findings list, grouped by
  severity, plus the raw error if a scan failed (e.g. skillspector not
  found, or the source is unreachable).
- **Gate** — Approve / Reject / Reset. This is local state for your own
  workflow — a simple record of "I looked at this and decided," not
  something that blocks an install anywhere else. Wire it into your own
  install scripts if you want it to be enforced.

## Notes

- Data lives in `backend/skillspector_gui.db` (SQLite) — delete it to
  reset the log.
- The findings parser expects roughly the shape SkillSpector's `--format
  json` output currently has (`findings[]` with `rule_id`, `severity`,
  `file`, `start_line`, `message`/`explanation`). If a future SkillSpector
  release renames fields, the score/verdict at the top of the report
  should still be picked up even if individual findings render sparsely —
  check `app.js`'s `renderFindings` / `_extract_score_and_verdict` if the
  schema drifts.
- Scans run synchronously (the request blocks until `skillspector`
  finishes), which is fine for single skills but will feel slow on a big
  repo with the LLM pass on. If that becomes a problem, the natural next
  step is a background job queue instead of a blocking POST.

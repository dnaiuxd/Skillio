# How it works, and why

Design notes for Skillio. None of this is needed to use the app — see the
[README](../README.md) for that. It's here because most of these decisions
cost something to arrive at, and the reasoning is worth more than the result.

## Reading a 256 MB report

**A registry report is streamed, not loaded.** The official registry's report
is about 256 MB of JSON. Reading it whole and handing it to `json.loads` peaks
around 1.1 GB — the text held once as a string and again, several times over,
as the object graph. Skillio asks SkillSpector to write the report to a file
(`--output`) and pulls the findings out one at a time: the first 1,000 are
kept, every one of them contributes to the gate fingerprint, and the rest are
dropped as they go. `servers` and `snapshots` are never built at all. Measured
end to end through the scan worker: **69 MB peak instead of 1,127 MB**, in two
seconds. A skill report is a few tens of KB and takes the plain path.

**Registry reports are trimmed before they are stored.** A live scan of the
official registry came back at 196 MB — 96,854 servers, 98,029 findings — of
which about 180 MB was `servers` and `snapshots`, per-server payload this app
never renders. Those two keys are dropped and the findings list is capped at
1,000, taking the stored report to about 0.16 MB. The true count is kept and
the detail page says how many were left out, because a short findings list
must never be mistaken for a clean one. The score is SkillSpector's and
reflects all of them.

**The gate fingerprint is taken before the trim**, over the full report —
otherwise a registry could be rewritten past the 1,000th finding, hash
identical, and keep an approval you never gave it.

## Scanning

**Skill / MCP Registry** is stated rather than guessed. A registry URL and a
skill URL are not distinguishable by shape, so the choice is passed straight
through as `--mcp-registry`. SkillSpector accepts only the official registry
endpoint — `https://registry.modelcontextprotocol.io/v0/servers`, exactly,
without query parameters — and rejects anything else. Registry mode hides the
`.zip` drop zone, which cannot be a registry.

**Registry scans usually fail partway through, and that is upstream.** The
registry pages 30 servers at a time, so covering ~96,850 of them takes roughly
3,200 sequential requests — and SkillSpector abandons the whole scan on the
first network hiccup rather than retrying that page. Over that many requests,
one hiccup is close to certain. Observed twice: once as HTTP `500` on about
1.7% of requests (the same cursor succeeded on an immediate retry), and once
as `[Errno 54] Connection reset by peer` about ten minutes in. A later
100-request sample saw no errors at all, so the rate moves around; the
fragility does not, because it only takes one.

**Scans run in the background.** The POST returns as soon as the row exists,
and the row carries its own progress: it shows up in the log marked
*scanning…* and fills in when `skillspector` finishes. So the scan is visible
where you'd look for it, and reloading the page or closing the tab doesn't
lose it — the state lives on the server, not in the tab. A re-scan keeps the
previous score on show, dimmed, until the new one lands; the old answer is
still the best one available until then. One scan runs at a time — a second
request gets a 409 rather than queueing. A skill scan times out after 5
minutes; a registry scan gets 30, because the official registry is hundreds of
servers read in one pass and measured past 5 minutes on its own, while a
*skill* still running at 5 minutes is stuck. If the server stops mid-scan,
that row is closed out on the next start and says so, instead of spinning
forever with nothing behind it.

**Uploads are streamed to a temp file, scanned, and deleted** — only the
report is kept, and they're identified by a hash of their contents, so two
unrelated files both named `skill.zip` stay separate rows instead of
overwriting each other.

## Reading the results

**Risk bands come from the report, not from us.** The band is the report's own
`risk_assessment.severity` rather than something re-derived here, so it can't
drift from what SkillSpector decided — four bands, matching its
`_RISK_SEVERITY_BANDS`: LOW 0–20, MEDIUM 21–50, HIGH 51–80, CRITICAL 81–100.
HIGH and CRITICAL share the red treatment because both mean DO NOT INSTALL,
but each still shows its own name.

**SkillSpector fails closed.** A LOW-band result that would normally read SAFE
is downgraded to CAUTION whenever the scan was degraded or incomplete. That's
why a skill can score 0 and still say Caution — the detail page says so
explicitly rather than leaving it looking like a contradiction.

**Three separate things are reported separately**, because conflating them is
confusing: the **N files scanned** chip is scope (what was looked at), the
amber notice is completeness (how fully it was read), and the findings list is
results (what was wrong). **Files scanned** at the bottom expands to the full
inventory — every file SkillSpector enumerated, the ones with findings first,
each marked clean or carrying its worst severity. A clean file never appears
in the findings list, so without this there's no way to tell "scanned and
fine" from "not scanned".

**A failed scan says what went wrong in words.** Nine failures are recognised
— a repository that wouldn't clone, a host off SkillSpector's allowlist, a
corrupt `.zip`, the registry dropping a connection, a timeout, a missing
binary — each answering what happened and whether there is anything to do
about it. Every pattern was matched against output produced on purpose rather
than guessed from source, and matching runs on whitespace-collapsed text
because the CLI hard-wraps its own errors mid-phrase at about 78 columns. The
raw text is never discarded: it moves into a *Technical details* disclosure,
which is what makes a bug report worth reading.

**The gate is local state.** Install / Do Not Install is a record of "I looked
at this and decided", not something that blocks an install anywhere else. Wire
it into your own install scripts if you want it enforced. Deciding hides both
buttons and leaves a **Reset**, so a decision is deliberate but never a trap.
A decision applies to the report you saw: if a re-scan comes back different —
the score, the verdict, or which findings were raised — the gate resets to
pending and says so.

## The report shapes

The parser targets SkillSpector v2.11's `--format json` shape:
`risk_assessment.{score,severity,recommendation}` for the headline, and an
`issues[]` array (one entry per code location — the GUI collapses repeats of a
`finding_id` into one row) with `severity`, `location`, `pattern`,
`explanation`, `remediation`.

The top-level keys (`risk_score`, `findings[]`) are also accepted — and they
are not just a legacy fallback any more: an `--mcp-registry` scan returns
exactly that shape, with `mcp_registry`, `server_count` and `max_risk_score`
alongside. So both branches are live, one per target type, and there are tests
over each. If a later release renames things, check
`_extract_score_and_verdict` in `backend/app.py` and `renderFindings` in
`frontend/app.js`.

## Update checks

**A new release of Skillio shows as a tag beside the wordmark.** The check
runs on page load but the answer is cached server-side for six hours, so a
reload costs nothing, and a failure is silent — an app that nags about its own
update check failing is worse than one that says nothing. It reads the
repository's `tags.atom`, which GitHub serves only for public repositories —
so if you fork this and make yours private, the feed 404s and the tag simply
never appears. That is the failure mode by design: silence, never a false
"you're up to date".

**The version comes from the entry's tag, not its title.** Publishing a GitHub
Release renames that tag's feed entry to the release *name*, and reading that
printed the whole headline where a version belonged — "v1.7.2 — plain-language
scan failures available".

**Check for updates checks both tools**, and bypasses the cache when it does,
because a check that answers from earlier in the day is not a check. Versions
are compared as numbers, not text, so 2.10.0 correctly outranks 2.9.0.
SkillSpector's answer lands in a card in the rail — every outcome in the same
box, each with a ✕ — and a new Skillio release raises a banner above the
header instead, since that one has somewhere to send you. While the banner is
up the header tag steps aside rather than saying the same sentence twice.

**The commands are on the page, not on GitHub.** Both states that ask you to
run something — "not found on PATH" and "an update is available" — show the
exact `uv tool` command inline, with one line saying where to run it and that
your scan log isn't touched. An ⓘ beside either opens a single **Installing &
upgrading SkillSpector** dialog: what `uv tool` does with its isolated
environments, why the shim path never changes, what an unpinned git install
actually fetches, and what to do when `skillspector` still isn't found —
including the launchd case, where the agent carries its own PATH.

## Interface

**Theme** follows your OS by default; the sun/moon switch in the top-right
overrides it either way and the choice is remembered. The light palette is the
original cream one; dark is GitHub Primer's, token for token —
`canvas.default` #0d1117, `canvas.subtle` #161b22, `fg.default` #e6edf3,
`fg.muted` #8b949e — with its own status colours rather than the light ones
reused. Links use Primer's `accent.fg` in both. Every pairing the CSS actually
uses was checked against WCAG 2.2 AA (text ≥ 4.5:1, control boundaries ≥ 3:1).

**The ⓘ triggers and the ✕ controls are the size of their glyphs**, not 44px
squares around them: at 44 the mark sat inside a 13px dead ring, so a click or
a hover well clear of the icon still fired it. 24×24 is what you see and what
WCAG 2.2 AA asks for (2.5.8); coarse pointers get the 44px floor back through
an invisible overlay, since a finger has no 3px precision and there is no
cursor to give the dead ring away.

**Each ⓘ carries a tooltip**, on hover *and* on focus, whose words are its
`aria-label` — one copy, so what is shown and what is announced cannot drift.
Esc dismisses it without moving the pointer, and the tip is a child of its
trigger so the pointer can move onto it without it vanishing (WCAG 2.2
1.4.13). It is hidden with `display: none` rather than `visibility: hidden`,
because a hidden-but-laid-out chip on a trigger near the right edge gave a
390px page a horizontal scrollbar.

**The credit line carries Skillio's own identity** — `Skillio · vX.Y.Z ·
dhavalnaik.com`, in the rail on desktop and the footer on narrow. "Skillio"
links to the source repository; the URL comes from `/api/health` so it has one
home in the backend rather than a copy in the markup.

**Fonts are self-hosted** (latin `.woff2` subsets in `frontend/fonts/`, no CDN
call): Noto Sans for headings and body, Noto Sans Mono for code. Licences sit
next to the files (both OFL).

## Storage

Data lives in `backend/skillio.db` (SQLite, git-ignored) — delete it to reset
the log. Deleting a scan runs `VACUUM`, because SQLite keeps freed pages
inside the file and reuses them rather than returning them to the OS, and
"delete permanently" should leave nothing behind — including the space.

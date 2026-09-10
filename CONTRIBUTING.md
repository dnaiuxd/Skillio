# Working on Skillio

## Tests

```bash
./run-tests.sh
```

Stdlib `unittest` for the backend and a dependency-free Node script for the
frontend — nothing to install beyond the venv you already made. No network and
no `skillspector` binary; the whole suite runs in well under a second.

They cover the pure functions, which is where every bug this app has shipped
actually lived: report parsing (`_extract_score_and_verdict`), the gate
fingerprint that decides whether a re-scan invalidates your decision
(`_report_fingerprint`), the risk band (`severityBand`), the incomplete-scan
notice (`coverageNotice`), the failure messages (`friendlyError`), and
severity counting. The scan lifecycle is covered too — the one-at-a-time slot,
and the startup sweep that closes out a scan orphaned by a restart — against a
throwaway database in a temp directory.

`frontend/tests/run.js` loads `app.js` behind a small DOM stub rather than
copying functions out of it, so renaming something in the app fails the suite
instead of silently testing a stale copy. The stub hands back a node for any
id asked of it, which would happily hide a control deleted from the markup —
so one test reads `index.html` and checks that every id `app.js` looks up is
really there.

Several tests assert on the CSS. That reads as odd until you've watched a
44px touch target quietly become 24px, or a modifier class stop being applied;
those are the regressions a unit test can't see and a screenshot won't catch
either. Anchor such assertions to declarations (`/\n\s*visibility:\s*hidden;/`)
rather than bare substrings — more than once a regex has matched the
explanatory comment above the rule it was meant to check.

## Verifying UI changes

Run the app and look at it in a real browser. A server that answers `curl` is
not proof the page renders, and neither is CSS that reads correctly.

If you drive Chrome over CDP, **always clear the emulation override when
you're done**:

```js
await send("Emulation.setDeviceMetricsOverride",
  {width: 0, height: 0, deviceScaleFactor: 0, mobile: false});
await send("Emulation.clearDeviceMetricsOverride");
```

The override belongs to the target, not to your session — closing the
connection does not undo it, and `clearDeviceMetricsOverride` alone will not
undo one an earlier session set. A window left with a pinned viewport looks
exactly like a broken responsive layout. Call `Network.setCacheDisabled` too,
or you will measure the stylesheet you just replaced.

## Running two checkouts side by side

Useful if you're changing Skillio and want the copy you actually *use* left
alone. Point the second one at another port:

```bash
SKILLIO_PORT=8788 ./Skillio.command
```

The two share nothing. The scan log lives inside each checkout
(`backend/skillio.db`), so they keep separate histories, and the server builds
its CORS allowlist from `SKILLIO_PORT` — hardcoding 8787 there used to mean the
second instance's own browser origin was refused by its own backend.

The background service takes the same variable, and at a non-default port it
names itself and its log after it — `com.skillio.gui.8788` and
`~/Library/Logs/skillio-8788.log` — so installing one cannot boot out the
other. At 8787 the names are unchanged, so an existing install upgrades in
place.

A workable split: keep the everyday copy on 8787 as the background service,
and run the one you're editing on 8788 by hand, only when you want it. One
service on the machine means the two can never contend for a port.

Note that a Python change needs a restart — uvicorn serves the frontend from
disk on every request, but `app.py` is loaded once at process start.

## Releasing

Skillio's version lives in exactly one place: `SKILLIO_VERSION` in
`backend/app.py`. The footer and the left rail read it from `/api/health`
rather than keeping a second copy, so there is nothing to keep in sync by hand.

```bash
./release.sh patch          # 1.0.0 -> 1.0.1
./release.sh minor          # 1.0.0 -> 1.1.0
./release.sh major          # 1.0.0 -> 2.0.0
./release.sh 1.4.2          # or set it outright
./release.sh minor --dry-run
```

It validates the version first, so a typo is rejected on its own terms rather
than behind a complaint about your tree. Only a strict `MAJOR.MINOR.PATCH` is
accepted — `1.4.2.7` and `01.2.3` are refused, and the test gate cannot catch
those for you because it runs against the tree *before* the bump. Then it
refuses to run off `main`, refuses on a dirty tree, refuses if the tag already
exists, and runs both suites — a tag is a claim that the commit works. Finally
it rewrites the one version line, commits it as `Release vX.Y.Z`, and adds an
annotated tag.

It does not push. The last line prints the command:

```bash
git push --follow-tags origin main
```

Release notes are written by hand. `gh release create --generate-notes`
produces only a compare link here, because this repo has no merged pull
requests for it to summarise.

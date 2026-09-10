"""
Tests for the pure functions in app.py — the report parsing and the gate
fingerprint. Stdlib unittest only, no extra dependencies:

    backend/.venv/bin/python -m unittest discover backend

Every case here is a bug this app actually shipped, or the boundary that
bug sat on. They are cheap because none of this touches the network, the
database or the skillspector binary.
"""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app
import storage
from app import (_derive_name, _extract_score_and_verdict,
                 _parse_version, _report_fingerprint, _run_scan,
                 _trim_registry_report, _update_available)


def _fake_run_writing_report(seen: dict, payload: str):
    """A stand-in for subprocess.run that behaves like skillspector.

    A registry scan is invoked with --output, so the report lands in a file
    rather than on stdout. A fake that always answered on stdout would test a
    path the app no longer takes.
    """
    class Proc:
        returncode = 0
        stderr = ""
        stdout = ""

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        seen.setdefault("timeouts", []).append(kw.get("timeout"))
        if "--output" in cmd:
            Path(cmd[cmd.index("--output") + 1]).write_text(payload)
            Proc.stdout = ""
        else:
            Proc.stdout = payload
        return Proc()

    return fake_run


class ExtractScoreAndVerdict(unittest.TestCase):
    """SkillSpector v2.11 nests the headline under risk_assessment. Reading
    only the top level is what made every real scan show "—" and "no
    findings" until it was found."""

    def test_reads_the_nested_shape(self):
        report = {"risk_assessment": {"score": 28, "recommendation": "CAUTION"}}
        self.assertEqual(_extract_score_and_verdict(report), (28, "CAUTION"))

    def test_falls_back_to_legacy_top_level_keys(self):
        report = {"risk_score": 72, "verdict": "DO_NOT_INSTALL"}
        self.assertEqual(_extract_score_and_verdict(report), (72, "DO_NOT_INSTALL"))

    def test_nested_wins_over_top_level(self):
        report = {"risk_assessment": {"score": 5, "recommendation": "SAFE"},
                  "risk_score": 99, "verdict": "DO_NOT_INSTALL"}
        self.assertEqual(_extract_score_and_verdict(report), (5, "SAFE"))

    def test_reads_an_mcp_registry_report(self):
        # Not a hypothetical: this is the shape the live registry scan
        # returned. It uses the top-level keys, so what the README used to
        # call a legacy fallback is the live path for every registry scan —
        # deleting it as dead code would break MCP scanning silently.
        report = {
            "mcp_registry": True,
            "source": "https://registry.modelcontextprotocol.io/v0/servers",
            "server_count": 96850,
            "risk_score": 100,
            "max_risk_score": 30,
            "findings": [{"id": "MC001", "severity": "CRITICAL"}],
        }
        score, verdict = _extract_score_and_verdict(report)
        self.assertEqual(score, 100)
        self.assertIsNotNone(verdict)

    def test_zero_is_a_real_score_not_a_missing_one(self):
        # A falsy-but-present score. `or` chaining here would skip it and
        # report no score at all for the safest possible result.
        score, _ = _extract_score_and_verdict(
            {"risk_assessment": {"score": 0, "recommendation": "CAUTION"}})
        self.assertEqual(score, 0)

    def test_derives_a_verdict_when_only_a_score_is_present(self):
        self.assertEqual(_extract_score_and_verdict({"risk_score": 80})[1], "do_not_install")
        self.assertEqual(_extract_score_and_verdict({"risk_score": 10})[1], "ok")

    def test_numeric_string_score_is_coerced(self):
        self.assertEqual(_extract_score_and_verdict({"risk_score": "42"})[0], 42)

    def test_non_numeric_score_becomes_none(self):
        # The report is untrusted — a scanned skill influences it, especially
        # under --llm. SQLite's INTEGER affinity stores a non-numeric string
        # verbatim, so a payload here would reach the frontend intact.
        for hostile in ("<img src=x onerror=alert(1)>", "", None, [], {}, "NaN"):
            with self.subTest(score=hostile):
                self.assertIsNone(_extract_score_and_verdict({"risk_score": hostile})[0])

    def test_booleans_are_not_scores(self):
        # bool is a subclass of int; True would otherwise become 1.
        self.assertIsNone(_extract_score_and_verdict({"risk_score": True})[0])

    def test_float_score_is_truncated_to_int(self):
        self.assertEqual(_extract_score_and_verdict({"risk_score": 28.9})[0], 28)

    def test_empty_report(self):
        self.assertEqual(_extract_score_and_verdict({}), (None, None))

    def test_risk_assessment_of_the_wrong_type_is_ignored(self):
        self.assertEqual(_extract_score_and_verdict({"risk_assessment": "nope"}), (None, None))


class ReportFingerprint(unittest.TestCase):
    """The gate records "I reviewed *this* report". The fingerprint is what
    decides whether a re-scan invalidates that decision."""

    def _report(self, score=28, verdict="CAUTION", issues=None):
        return {"risk_assessment": {"score": score, "recommendation": verdict},
                "issues": issues if issues is not None else
                          [{"finding_id": "f1", "severity": "MEDIUM"}]}

    def test_identical_reports_match(self):
        # An unchanged re-scan must keep the decision, or checking for drift
        # would cost the user their gate every time.
        self.assertEqual(_report_fingerprint(self._report()),
                         _report_fingerprint(self._report()))

    def test_finding_order_does_not_matter(self):
        a = self._report(issues=[{"finding_id": "f1", "severity": "LOW"},
                                 {"finding_id": "f2", "severity": "HIGH"}])
        b = self._report(issues=[{"finding_id": "f2", "severity": "HIGH"},
                                 {"finding_id": "f1", "severity": "LOW"}])
        self.assertEqual(_report_fingerprint(a), _report_fingerprint(b))

    def test_a_changed_score_changes_it(self):
        self.assertNotEqual(_report_fingerprint(self._report(score=28)),
                            _report_fingerprint(self._report(score=72)))

    def test_a_changed_verdict_changes_it(self):
        self.assertNotEqual(_report_fingerprint(self._report(verdict="CAUTION")),
                            _report_fingerprint(self._report(verdict="DO_NOT_INSTALL")))

    def test_an_escalated_severity_changes_it(self):
        # Same finding, now critical. Score can stay put while the meaning
        # changes, so severity has to be part of the identity.
        self.assertNotEqual(
            _report_fingerprint(self._report(issues=[{"finding_id": "f1", "severity": "MEDIUM"}])),
            _report_fingerprint(self._report(issues=[{"finding_id": "f1", "severity": "CRITICAL"}])))

    def test_a_new_finding_changes_it(self):
        self.assertNotEqual(
            _report_fingerprint(self._report()),
            _report_fingerprint(self._report(issues=[{"finding_id": "f1", "severity": "MEDIUM"},
                                                     {"finding_id": "f2", "severity": "LOW"}])))

    def test_occurrence_count_is_part_of_the_identity(self):
        # SkillSpector emits one issue per code location, and the fingerprint
        # keeps them all rather than collapsing to a set. That is deliberate:
        # its scorer stops counting a rule after the third occurrence
        # (_MAX_OCCURRENCES_PER_RULE = 3), so a skill going from 3 subprocess
        # calls to 30 can score identically. The count is the only signal
        # that anything changed, and losing it would leave an approval
        # standing over a materially different skill.
        one = self._report(issues=[{"finding_id": "f1", "severity": "MEDIUM"}])
        three = self._report(issues=[{"finding_id": "f1", "severity": "MEDIUM"}] * 3)
        self.assertNotEqual(_report_fingerprint(one), _report_fingerprint(three))

    def test_the_same_report_twice_still_matches_despite_that(self):
        # The flip side: counting occurrences must not make an unchanged
        # re-scan look different, or drift-checking costs you the gate.
        dupes = [{"finding_id": "f1", "severity": "MEDIUM"}] * 3
        self.assertEqual(_report_fingerprint(self._report(issues=dupes)),
                         _report_fingerprint(self._report(issues=list(dupes))))

    def test_none_report_has_no_fingerprint(self):
        # A failed scan carries none. upsert_scan COALESCEs so the last known
        # good one survives; without that the gate could never reset again.
        self.assertIsNone(_report_fingerprint(None))
        self.assertIsNone(_report_fingerprint("not a dict"))

    def test_malformed_issue_entries_are_skipped(self):
        self.assertIsNotNone(_report_fingerprint(self._report(issues=["", None, 42])))


class DeriveName(unittest.TestCase):
    def test_git_url(self):
        self.assertEqual(_derive_name("https://github.com/NVIDIA/skillspector.git"), "skillspector")

    def test_suffix_strip_is_case_insensitive(self):
        self.assertEqual(_derive_name("https://example.com/Thing.GIT"), "Thing")
        self.assertEqual(_derive_name("/tmp/Skill.ZIP"), "Skill")

    def test_trailing_slash(self):
        self.assertEqual(_derive_name("/Users/x/.claude/skills/model-chat/"), "model-chat")

    def test_windows_separators(self):
        self.assertEqual(_derive_name(r"C:\skills\my-skill.zip"), "my-skill")

    def test_bare_name_survives(self):
        self.assertEqual(_derive_name("model-chat"), "model-chat")




class ScanSlot(unittest.TestCase):
    """Scans run one at a time. The slot is what says so, and a slot that
    leaks is worse than a blocking POST: the app refuses every later scan
    with nothing running to justify it."""

    def setUp(self):
        app._release_scan_slot()

    tearDown = setUp

    def test_a_second_scan_is_refused_while_one_holds_the_slot(self):
        self.assertTrue(app._claim_scan_slot())
        self.assertFalse(app._claim_scan_slot())

    def test_releasing_lets_the_next_scan_through(self):
        app._claim_scan_slot()
        app._release_scan_slot()
        self.assertTrue(app._claim_scan_slot())

    def test_release_is_safe_when_nothing_is_running(self):
        app._release_scan_slot()
        self.assertTrue(app._claim_scan_slot())


class ScanLifecycle(unittest.TestCase):
    """The row is the job, so the row has to be honest about it — including
    after a restart, where a row still marked 'running' has no worker behind
    it and would otherwise spin forever."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="skillio_test_")
        self._patch = mock.patch.object(storage, "DB_PATH", Path(self.tmp) / "t.db")
        self._patch.start()
        storage.init_db()

    def tearDown(self):
        self._patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _finish(self, source="s", name="n", score=10):
        return storage.upsert_scan(
            source=source, name=name, score=score, verdict="CAUTION",
            report={"risk_assessment": {"score": score}}, error=None,
            fingerprint="fp",
        )

    def test_begin_scan_opens_a_running_row(self):
        row = storage.begin_scan("s", "n")
        self.assertEqual(row["scan_state"], "running")
        self.assertIsNone(row["score"])

    def test_finishing_takes_the_row_out_of_running(self):
        storage.begin_scan("s", "n")
        self.assertEqual(self._finish()["scan_state"], "done")

    def test_a_rescan_keeps_the_previous_result_on_show(self):
        # The old answer is the best one available until the new one lands,
        # so a re-scan must not blank the row it is refreshing.
        self._finish(score=42)
        row = storage.begin_scan("s", "n")
        self.assertEqual(row["scan_state"], "running")
        self.assertEqual(row["score"], 42)

    def test_a_rescan_clears_the_previous_error(self):
        storage.upsert_scan(source="s", name="n", score=None, verdict=None,
                            report=None, error="skillspector not found")
        self.assertIsNone(storage.begin_scan("s", "n")["error"])

    def test_the_sweep_closes_a_scan_orphaned_by_a_restart(self):
        storage.begin_scan("s", "n")
        self.assertEqual(storage.sweep_running_scans(), 1)
        row = storage.find_by_source("s")
        self.assertEqual(row["scan_state"], "done")
        self.assertIn("never finished", row["error"])

    def test_the_sweep_leaves_finished_scans_alone(self):
        self._finish()
        self.assertEqual(storage.sweep_running_scans(), 0)
        self.assertIsNone(storage.find_by_source("s")["error"])

    def test_the_sweep_does_not_overwrite_a_real_error(self):
        # A row can be 'running' and already carry an error from the scan
        # before it; the real cause is more useful than the generic one.
        storage.upsert_scan(source="s", name="n", score=None, verdict=None,
                            report=None, error="the real cause")
        conn = storage.get_conn()
        conn.execute("UPDATE skills SET scan_state = 'running' WHERE source = 's'")
        conn.commit()
        conn.close()
        storage.sweep_running_scans()
        self.assertEqual(storage.find_by_source("s")["error"], "the real cause")


class VersionComparison(unittest.TestCase):
    """The update check compares numbers, not text. As strings "2.9.0" sorts
    above "2.10.0", which would hide every release in a 2.10+ line."""

    def test_ten_is_newer_than_nine(self):
        self.assertTrue(_update_available("2.9.0", "2.10.0"))
        self.assertFalse(_update_available("2.10.0", "2.9.0"))

    def test_the_v_prefix_is_optional_on_either_side(self):
        # skillspector --version and the git tag need not agree about it.
        self.assertTrue(_update_available("2.11.0", "v2.11.1"))
        self.assertTrue(_update_available("v2.11.0", "2.11.1"))
        self.assertTrue(_update_available("v2.11.0", "v2.11.1"))
        self.assertTrue(_update_available("2.11.0", "2.11.1"))

    def test_a_name_in_front_does_not_stop_it(self):
        # What the CLI actually prints: "SkillSpector v2.11.0".
        self.assertTrue(
            _update_available("SkillSpector v2.11.0", "SkillSpector v2.11.1")
        )

    def test_the_same_version_is_not_an_update(self):
        self.assertFalse(_update_available("v2.11.0", "2.11.0"))

    def test_a_missing_or_unreadable_version_is_not_an_update(self):
        # Never nag on the strength of something that could not be read.
        for installed, latest in (
            (None, "2.11.1"), ("2.11.0", None), (None, None),
            ("", "2.11.1"), ("unreleased", "2.11.1"), ("2.11.0", "nightly"),
        ):
            self.assertFalse(_update_available(installed, latest),
                             f"{installed!r} vs {latest!r}")

    def test_parsing_pulls_the_numbers_out(self):
        self.assertEqual(_parse_version("SkillSpector v2.11.0"), (2, 11, 0))
        self.assertEqual(_parse_version("2.11.0"), (2, 11, 0))
        self.assertIsNone(_parse_version("v2.11"))
        self.assertIsNone(_parse_version(None))


class TrimRegistryReport(unittest.TestCase):
    """A live registry report was 196MB, of which 180MB was per-server payload
    this app never shows. Stored whole it would sit in SQLite and come back out
    of /api/skills on every poll."""

    def _report(self, n_findings=5):
        return {
            "mcp_registry": True,
            "risk_score": 100,
            "max_risk_score": 30,
            "server_count": 96854,
            "servers": [{"blob": "x" * 100} for _ in range(50)],
            "snapshots": [{"blob": "x" * 100} for _ in range(50)],
            "findings": [{"id": f"MC{i}", "severity": "HIGH"} for i in range(n_findings)],
        }

    def test_the_headline_survives(self):
        t = _trim_registry_report(self._report())
        for key in ("mcp_registry", "risk_score", "max_risk_score", "server_count"):
            self.assertIn(key, t)

    def test_the_payload_nobody_renders_is_dropped(self):
        t = _trim_registry_report(self._report())
        self.assertNotIn("servers", t)
        self.assertNotIn("snapshots", t)

    def test_a_short_findings_list_is_left_alone(self):
        t = _trim_registry_report(self._report(n_findings=5))
        self.assertEqual(len(t["findings"]), 5)
        self.assertNotIn("findings_total", t)

    def test_a_long_findings_list_is_capped_and_says_so(self):
        # The count must survive the cap. A truncated list that looked
        # complete would read as "only 1000 problems" for a report that
        # found 98,029 of them.
        t = _trim_registry_report(self._report(n_findings=app.MCP_MAX_FINDINGS + 250))
        self.assertEqual(len(t["findings"]), app.MCP_MAX_FINDINGS)
        self.assertEqual(t["findings_total"], app.MCP_MAX_FINDINGS + 250)

    def test_it_does_not_choke_on_a_non_dict(self):
        self.assertEqual(_trim_registry_report(None), None)


class ScanCommand(unittest.TestCase):
    """What actually reaches the CLI. A skill and an MCP Registry are read
    differently by skillspector, and the flag is the only thing that says
    which — a registry URL and a skill URL look alike."""

    def _cmd(self, **kwargs):
        seen = {}
        fake_run = _fake_run_writing_report(seen, '{"risk_assessment": {"score": 0}}')
        with mock.patch.object(app.shutil, "which", return_value="/bin/skillspector"), \
             mock.patch.object(app.subprocess, "run", fake_run):
            _run_scan("SOURCE", **kwargs)
        return seen["cmd"]

    def test_a_skill_scan_carries_no_registry_flag(self):
        self.assertNotIn("--mcp-registry", self._cmd(use_llm=False))

    def test_an_mcp_registry_scan_says_so(self):
        self.assertIn("--mcp-registry", self._cmd(use_llm=False, mcp_registry=True))

    def test_the_flag_stays_ahead_of_the_source_separator(self):
        # Everything after "--" is the positional. A flag that slipped past it
        # would be read as part of the source and silently ignored.
        cmd = self._cmd(use_llm=False, mcp_registry=True)
        self.assertLess(cmd.index("--mcp-registry"), cmd.index("--"))
        self.assertEqual(cmd[-1], "SOURCE")

    def test_a_registry_gets_longer_than_a_skill(self):
        # Measured: the official registry ran past five minutes, which the
        # skill limit would have killed. A skill running that long is stuck.
        seen = {}

        fake_run = _fake_run_writing_report(seen, '{"risk_assessment": {"score": 0}}')
        with mock.patch.object(app.shutil, "which", return_value="/bin/skillspector"), \
             mock.patch.object(app.subprocess, "run", fake_run):
            _run_scan("SOURCE", use_llm=False)
            _run_scan("SOURCE", use_llm=False, mcp_registry=True)
        skill_timeout, registry_timeout = seen["timeouts"]
        self.assertEqual(skill_timeout, app.SCAN_TIMEOUT_SECONDS)
        self.assertEqual(registry_timeout, app.MCP_REGISTRY_TIMEOUT_SECONDS)
        self.assertGreater(registry_timeout, skill_timeout)

    def test_llm_and_registry_are_independent(self):
        with_llm = self._cmd(use_llm=True, mcp_registry=True)
        self.assertIn("--mcp-registry", with_llm)
        self.assertNotIn("--no-llm", with_llm)


class SkillioVersion(unittest.TestCase):
    """release.sh is the only thing that edits SKILLIO_VERSION, and it finds
    the line with a `^SKILLIO_VERSION = "..."$` regex, splits it on dots and
    increments a field. These guard the shape that contract depends on: a
    botched bump should fail here rather than ship a "v1.0" in the footer."""

    def test_version_is_major_minor_patch(self):
        parts = app.SKILLIO_VERSION.split(".")
        self.assertEqual(len(parts), 3, app.SKILLIO_VERSION)
        for part in parts:
            self.assertTrue(part.isdigit(), app.SKILLIO_VERSION)
            # "01" would survive isdigit() and then compare wrong.
            self.assertEqual(str(int(part)), part, app.SKILLIO_VERSION)

    def test_declaration_matches_what_release_sh_greps_for(self):
        """The script's sed anchors to the whole line. A reformat that wrapped
        it, quoted it differently or indented it would leave release.sh
        silently finding nothing."""
        source = (Path(app.__file__)).read_text()
        wanted = f'SKILLIO_VERSION = "{app.SKILLIO_VERSION}"'
        self.assertIn(f"\n{wanted}\n", source)

    def test_health_reports_it(self):
        """The UI carries no second copy — it reads the version off /api/health,
        so that key going missing would blank the footer, not just change it."""
        with mock.patch.object(app.shutil, "which", return_value=None):
            self.assertEqual(app.health()["skillio_version"], app.SKILLIO_VERSION)


class GateSurvivesTrimming(unittest.TestCase):
    """A gate decision records "I reviewed THIS report". Trimming throws away
    97k of a registry's findings, so a fingerprint taken after the trim is
    blind to every change past the first 1,000 — and an approval could outlive
    the report it was made about, which is the one thing the gate prevents."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="skillio_test_")
        self._patch = mock.patch.object(storage, "DB_PATH", Path(self.tmp) / "t.db")
        self._patch.start()
        storage.init_db()

    def tearDown(self):
        self._patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    @staticmethod
    def _registry_report(tail_id):
        """A capped-size registry report whose only variation is past the cap."""
        findings = [{"id": f"F{i}", "severity": "low"}
                    for i in range(app.MCP_MAX_FINDINGS)]
        findings.append({"id": tail_id, "severity": "critical"})
        return {"mcp_registry": True, "risk_score": 100,
                "verdict": "DO_NOT_INSTALL", "findings": findings}

    def _run_with(self, report):
        fake_run = _fake_run_writing_report({}, json.dumps(report))
        with mock.patch.object(app.shutil, "which", return_value="/bin/skillspector"), \
             mock.patch.object(app.subprocess, "run", fake_run):
            app._claim_scan_slot()
            storage.begin_scan("REG", "MCP Registry", target_type="mcp_registry")
            app._scan_worker("REG", "MCP Registry", "REG",
                             use_llm=False, mcp_registry=True)
        conn = storage.get_conn()
        fp = conn.execute(
            "SELECT report_fingerprint FROM skills WHERE source = 'REG'"
        ).fetchone()[0]
        conn.close()
        return fp

    def test_a_change_past_the_cap_still_changes_the_fingerprint(self):
        first = self._run_with(self._registry_report("TAIL-A"))
        second = self._run_with(self._registry_report("TAIL-B"))
        self.assertIsNotNone(first)
        self.assertNotEqual(
            first, second,
            "fingerprint was taken after trimming, so the gate is blind past "
            "the first %d findings" % app.MCP_MAX_FINDINGS,
        )

    def test_an_unchanged_registry_keeps_its_gate(self):
        """The other half: re-scanning something identical must NOT reset a
        decision, or checking for drift would cost you your approval."""
        self.assertEqual(
            self._run_with(self._registry_report("TAIL-A")),
            self._run_with(self._registry_report("TAIL-A")),
        )

    def test_the_row_still_reports_as_a_registry(self):
        """upsert_scan's INSERT branch fires when the row was deleted from the
        log mid-scan. Without target_type there, a finished registry scan
        re-lands in the log presented as a skill."""
        self._run_with(self._registry_report("TAIL-A"))
        conn = storage.get_conn()
        conn.execute("DELETE FROM skills WHERE source = 'REG'")
        conn.commit()
        conn.close()
        self._run_with(self._registry_report("TAIL-A"))
        self.assertEqual(storage.find_by_source("REG")["target_type"], "mcp_registry")


class ReleaseScript(unittest.TestCase):
    """release.sh writes a version into source, commits it and tags it. The
    argument check is all that stands between a typo and a pushed tag — and
    the test gate cannot help, because it runs against the tree BEFORE the
    bump, so the tests asserting on SKILLIO_VERSION have already passed."""

    SCRIPT = Path(__file__).resolve().parent.parent / "release.sh"

    def _run(self, arg):
        return subprocess.run(
            ["bash", str(self.SCRIPT), arg, "--dry-run"],
            capture_output=True, text=True, timeout=60,
        )

    def test_malformed_versions_are_refused(self):
        # Each of these was accepted by the original [0-9]*.[0-9]*.[0-9]* glob,
        # which anchors neither the field count nor leading zeros.
        for bad in ("1.4.2.7", "01.2.3", "1.2.x", "1.2", "v1.2.3", ""):
            with self.subTest(version=bad):
                proc = self._run(bad)
                self.assertNotEqual(proc.returncode, 0, f"{bad!r} was accepted")
                self.assertIn("error:", proc.stderr)

    def test_a_wellformed_version_gets_past_the_argument_check(self):
        """It may still stop at a git guard — that is fine and not what this
        asserts. What matters is that it is not rejected as malformed."""
        proc = self._run("1.4.2")
        self.assertNotIn("MAJOR.MINOR.PATCH version", proc.stderr)


class VersionCache(unittest.TestCase):
    """`skillspector --version` spins up the whole CLI, so the answer is
    cached. A FAILURE is not an answer, though — caching that made one bad
    start report "your installed version could not be read" until restart."""

    def setUp(self):
        app._version_cache.clear()

    def tearDown(self):
        app._version_cache.clear()

    def test_a_failed_read_is_retried_not_remembered(self):
        calls = []

        class Ok:
            returncode = 0
            stdout = "SkillSpector v2.11.2"
            stderr = ""

        def flaky(cmd, **kw):
            calls.append(cmd)
            if len(calls) == 1:
                raise OSError("transient")
            return Ok()

        with mock.patch.object(app.subprocess, "run", flaky):
            self.assertIsNone(app._skillspector_version("/bin/skillspector"))
            self.assertEqual(
                app._skillspector_version("/bin/skillspector"),
                "SkillSpector v2.11.2",
            )
        self.assertEqual(len(calls), 2, "the failure was cached instead of retried")

    def test_a_successful_read_is_only_taken_once(self):
        calls = []

        class Ok:
            returncode = 0
            stdout = "SkillSpector v2.11.2"
            stderr = ""

        def counted(cmd, **kw):
            calls.append(cmd)
            return Ok()

        with mock.patch.object(app.subprocess, "run", counted):
            for _ in range(3):
                app._skillspector_version("/bin/skillspector")
        self.assertEqual(len(calls), 1, "the cache stopped working")

    def test_refresh_goes_back_to_the_binary(self):
        """The update check passes refresh=True, because an upgrade you just
        ran is exactly the case where the cached value is stale."""
        seen = ["SkillSpector v2.11.0", "SkillSpector v2.11.2"]

        def changing(cmd, **kw):
            class P:
                returncode = 0
                stdout = seen.pop(0)
                stderr = ""
            return P()

        with mock.patch.object(app.subprocess, "run", changing):
            self.assertEqual(
                app._skillspector_version("/bin/skillspector"), "SkillSpector v2.11.0"
            )
            self.assertEqual(
                app._skillspector_version("/bin/skillspector", refresh=True),
                "SkillSpector v2.11.2",
            )


class PortFromEnvironment(unittest.TestCase):
    """The port is only ever used to build the CORS allowlist, which means a
    bad value is spliced straight into an origin the server will trust."""

    def _port(self, value):
        env = {} if value is None else {"SKILLIO_PORT": value}
        with mock.patch.dict(app.os.environ, env, clear=False):
            if value is None:
                app.os.environ.pop("SKILLIO_PORT", None)
            return app._port()

    def test_it_defaults_to_the_documented_port(self):
        self.assertEqual(self._port(None), "8787")
        self.assertEqual(self._port(""), "8787")
        self.assertEqual(self._port("   "), "8787")

    def test_a_second_checkout_can_claim_its_own_port(self):
        self.assertEqual(self._port("8788"), "8788")
        self.assertEqual(self._port(" 8788 "), "8788")

    def test_junk_falls_back_rather_than_reaching_the_allowlist(self):
        for bad in ("not-a-port", "80 80", "8788; rm -rf /", "-1", "0",
                    "65536", "99999", "8788.5"):
            with self.subTest(value=bad):
                self.assertEqual(self._port(bad), "8787")


class SkillioSelfUpdate(unittest.TestCase):
    """Skillio checking for its own release. This runs on every page load, so
    it must be cheap and it must never break the page — the repository can be
    private, the machine offline, GitHub rate-limiting."""

    def setUp(self):
        app._skillio_update_cache.update({"at": 0.0, "value": None})

    tearDown = setUp

    def test_an_unreachable_feed_reports_no_update_rather_than_raising(self):
        def boom(*a, **kw):
            raise OSError("404: the repository is private")

        with mock.patch.object(app, "_latest_tag", boom):
            r = app._skillio_update()
        self.assertFalse(r["update_available"])
        self.assertIsNone(r["latest"])
        # Still tells the UI where the project lives, so the brand link works.
        self.assertEqual(r["url"], app.SKILLIO_REPO)

    def test_a_newer_tag_is_reported(self):
        with mock.patch.object(app, "SKILLIO_VERSION", "1.0.0"), \
             mock.patch.object(app, "_latest_tag",
                               return_value=("v1.5.0", "https://example.invalid/t")):
            r = app._skillio_update()
        self.assertTrue(r["update_available"])
        self.assertEqual(r["latest"], "v1.5.0")

    def test_the_same_version_is_not_an_update(self):
        with mock.patch.object(app, "_latest_tag",
                               return_value=(f"v{app.SKILLIO_VERSION}", "u")):
            self.assertFalse(app._skillio_update()["update_available"])

    def test_an_older_tag_is_not_an_update(self):
        """Guards against a string compare: "v1.10.0" < "v1.9.0" as text."""
        with mock.patch.object(app, "SKILLIO_VERSION", "1.10.0"), \
             mock.patch.object(app, "_latest_tag", return_value=("v1.9.0", "u")):
            self.assertFalse(app._skillio_update()["update_available"])

    def test_it_is_cached_so_a_page_load_costs_nothing(self):
        calls = []

        def counted(feed=None):
            calls.append(feed)
            return ("v9.9.9", "https://example.invalid/t")

        with mock.patch.object(app, "_latest_tag", counted):
            for _ in range(5):
                app._skillio_update()
        self.assertEqual(len(calls), 1, "GitHub was hit on every page load")

    def test_the_cache_expires(self):
        calls = []

        def counted(feed=None):
            calls.append(feed)
            return ("v9.9.9", "https://example.invalid/t")

        with mock.patch.object(app, "_latest_tag", counted):
            app._skillio_update(now=1000.0)
            app._skillio_update(now=1000.0 + app.SKILLIO_UPDATE_TTL_SECONDS - 1)
            self.assertEqual(len(calls), 1)
            app._skillio_update(now=1000.0 + app.SKILLIO_UPDATE_TTL_SECONDS + 1)
            self.assertEqual(len(calls), 2)

    def test_a_caller_cannot_edit_the_cache(self):
        with mock.patch.object(app, "_latest_tag",
                               return_value=("v9.9.9", "https://example.invalid/t")):
            first = app._skillio_update()
            first["update_available"] = "tampered"
            self.assertNotEqual(app._skillio_update()["update_available"], "tampered")

    def test_health_carries_the_repository_url(self):
        """The header's brand link reads it from here, so the URL has one home
        rather than a copy in the markup that can drift."""
        with mock.patch.object(app.shutil, "which", return_value=None):
            self.assertEqual(app.health()["repo_url"], app.SKILLIO_REPO)

    def test_the_feed_lookup_takes_a_feed(self):
        """Both checks share _latest_tag; it defaulted to SkillSpector's feed
        and would silently report SkillSpector's tags as Skillio's."""
        seen = {}

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'<feed xmlns="http://www.w3.org/2005/Atom"></feed>'

        def fake_open(req, timeout=None):
            seen["url"] = req.full_url
            return Resp()

        with mock.patch.object(app.urllib.request, "urlopen", fake_open):
            with self.assertRaises(RuntimeError):
                app._latest_tag(app.SKILLIO_TAGS_FEED)
        self.assertEqual(seen["url"], app.SKILLIO_TAGS_FEED)
        # Against the constant, not a spelling of it — the repository has
        # been renamed once already and this hardcoded the old casing.
        self.assertTrue(seen["url"].startswith(app.SKILLIO_REPO))
        self.assertNotEqual(seen["url"], app.TAGS_FEED)


class DeleteReclaimsSpace(unittest.TestCase):
    """SQLite keeps freed pages inside the file and reuses them; it does not
    shrink on DELETE. "Delete permanently" is the one irreversible action in
    this app, so it should leave nothing behind — including the space."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="skillio_test_")
        self._patch = mock.patch.object(storage, "DB_PATH", Path(self.tmp) / "t.db")
        self._patch.start()
        storage.init_db()

    def tearDown(self):
        self._patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _size(self):
        return storage.DB_PATH.stat().st_size

    @staticmethod
    def _big_report():
        return {"findings": [{"id": f"F{i}", "severity": "low"} for i in range(20000)]}

    def test_the_file_shrinks_when_a_report_is_deleted(self):
        row = storage.upsert_scan("SRC", "big", 100, "DO_NOT_INSTALL",
                                  self._big_report())
        full = self._size()
        self.assertGreater(full, 200_000, "the fixture is not big enough to test this")
        self.assertTrue(storage.delete_skill(row["id"]))
        self.assertLess(
            self._size(), full // 4,
            "the database did not shrink — is the VACUUM still there?",
        )

    def test_deleting_nothing_does_not_vacuum(self):
        """VACUUM rewrites the whole file. Doing that for a delete that
        matched no rows would be work for nothing."""
        storage.upsert_scan("SRC", "big", 100, "X", self._big_report())
        before = self._size()
        self.assertFalse(storage.delete_skill(999999))
        self.assertEqual(self._size(), before)

    def test_the_other_rows_survive_it(self):
        keep = storage.upsert_scan("KEEP", "keep", 10, "CAUTION", {"findings": []})
        drop = storage.upsert_scan("DROP", "drop", 100, "X", self._big_report())
        storage.delete_skill(drop["id"])
        self.assertIsNone(storage.find_by_source("DROP"))
        survivor = storage.find_by_source("KEEP")
        self.assertIsNotNone(survivor)
        self.assertEqual(survivor["id"], keep["id"])
        self.assertEqual(survivor["verdict"], "CAUTION")


class StreamingRegistryReport(unittest.TestCase):
    """The registry report is ~256 MB. json.loads on it peaks at 1.1 GB, and
    the trim cannot help because it only runs after that parse. These cover
    the streaming reader that replaces it."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="skillio_test_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, report):
        path = Path(self.tmp) / "report.json"
        path.write_text(json.dumps(report))
        return str(path)

    @staticmethod
    def _registry(n_findings, tail_id="TAIL"):
        findings = [{"id": f"F{i}", "severity": "low"} for i in range(n_findings)]
        findings.append({"id": tail_id, "severity": "critical"})
        return {
            "mcp_registry": True,
            "source": "https://registry.modelcontextprotocol.io/v0/servers",
            "server_count": 96854,
            "risk_score": 100,
            "max_risk_score": 30,
            # The two keys that are 180 MB of the real thing and are never
            # rendered. Streaming must not materialise them at all.
            "servers": [{"name": f"s{i}", "junk": "x" * 50} for i in range(500)],
            "snapshots": [{"id": i} for i in range(500)],
            "findings": findings,
        }

    def test_it_keeps_the_headline_and_caps_the_findings(self):
        path = self._write(self._registry(app.MCP_MAX_FINDINGS + 500))
        report, _ = app._stream_registry_report(path)
        self.assertEqual(report["risk_score"], 100)
        self.assertEqual(report["server_count"], 96854)
        self.assertTrue(report["mcp_registry"])
        self.assertEqual(len(report["findings"]), app.MCP_MAX_FINDINGS)
        self.assertEqual(report["findings_total"], app.MCP_MAX_FINDINGS + 501)

    def test_the_payload_keys_never_reach_the_report(self):
        path = self._write(self._registry(10))
        report, _ = app._stream_registry_report(path)
        self.assertNotIn("servers", report)
        self.assertNotIn("snapshots", report)

    def test_a_short_report_claims_no_truncation(self):
        """findings_total is what the UI uses to say "showing N of M". Setting
        it when nothing was dropped would print a lie."""
        path = self._write(self._registry(5))
        report, _ = app._stream_registry_report(path)
        self.assertNotIn("findings_total", report)
        self.assertEqual(len(report["findings"]), 6)

    def test_the_fingerprint_sees_findings_past_the_cap(self):
        """The gate invariant. Two registries identical up to the cap and
        different after it must not hash the same."""
        a = self._write(self._registry(app.MCP_MAX_FINDINGS, tail_id="A"))
        fp_a = app._stream_registry_report(a)[1]
        b = self._write(self._registry(app.MCP_MAX_FINDINGS, tail_id="B"))
        fp_b = app._stream_registry_report(b)[1]
        self.assertIsNotNone(fp_a)
        self.assertNotEqual(fp_a, fp_b)

    def test_an_unchanged_registry_keeps_its_fingerprint(self):
        a = self._write(self._registry(50, tail_id="SAME"))
        b = self._write(self._registry(50, tail_id="SAME"))
        self.assertEqual(
            app._stream_registry_report(a)[1], app._stream_registry_report(b)[1]
        )

    def test_it_agrees_with_the_non_streaming_path(self):
        """The fallback for an install without ijson must not disagree about
        what a report says."""
        raw = self._registry(app.MCP_MAX_FINDINGS + 20)
        streamed, fp_stream = app._stream_registry_report(self._write(raw))
        buffered = app._trim_registry_report(json.loads(json.dumps(raw)))
        fp_buffered = app._report_fingerprint(json.loads(json.dumps(raw)))
        self.assertEqual(streamed["findings_total"], buffered["findings_total"])
        self.assertEqual(len(streamed["findings"]), len(buffered["findings"]))
        self.assertEqual(streamed["risk_score"], buffered["risk_score"])
        self.assertEqual(fp_stream, fp_buffered)

    def test_the_report_file_is_cleaned_up(self):
        """A quarter-gigabyte temp file must not survive the scan."""
        seen = {}
        fake_run = _fake_run_writing_report(seen, json.dumps(self._registry(3)))
        with mock.patch.object(app.shutil, "which", return_value="/bin/skillspector"), \
             mock.patch.object(app.subprocess, "run", fake_run):
            app._run_scan("SRC", use_llm=False, mcp_registry=True)
        out = seen["cmd"][seen["cmd"].index("--output") + 1]
        self.assertFalse(Path(out).exists(), "the report file was left behind")
        self.assertFalse(Path(out).parent.exists(), "the temp dir was left behind")

    def test_without_ijson_it_falls_back_rather_than_failing(self):
        """An install that pulled code without syncing dependencies should run
        the old path, not refuse to start."""
        seen = {}
        fake_run = _fake_run_writing_report(seen, json.dumps(self._registry(5)))
        with mock.patch.object(app, "ijson", None), \
             mock.patch.object(app.shutil, "which", return_value="/bin/skillspector"), \
             mock.patch.object(app.subprocess, "run", fake_run):
            report, fp = app._run_scan("SRC", use_llm=False, mcp_registry=True)
        self.assertNotIn("--output", seen["cmd"])
        self.assertNotIn("servers", report)
        self.assertIsNotNone(fp)


if __name__ == "__main__":
    unittest.main()

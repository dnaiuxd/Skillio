"""
Tests for the pure functions in app.py — the report parsing and the gate
fingerprint. Stdlib unittest only, no extra dependencies:

    backend/.venv/bin/python -m unittest discover backend

Every case here is a bug this app actually shipped, or the boundary that
bug sat on. They are cheap because none of this touches the network, the
database or the skillspector binary.
"""
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app
import storage
from app import (_derive_name, _extract_score_and_verdict,
                 _parse_version, _report_fingerprint, _run_scan,
                 _update_available)


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


class ScanCommand(unittest.TestCase):
    """What actually reaches the CLI. A skill and an MCP registry are read
    differently by skillspector, and the flag is the only thing that says
    which — a registry URL and a skill URL look alike."""

    def _cmd(self, **kwargs):
        seen = {}

        class Proc:
            returncode = 0
            stdout = '{"risk_assessment": {"score": 0}}'
            stderr = ""

        def fake_run(cmd, **_):
            seen["cmd"] = cmd
            return Proc()

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

        class Proc:
            returncode = 0
            stdout = '{"risk_assessment": {"score": 0}}'
            stderr = ""

        def fake_run(cmd, **kw):
            seen.setdefault("timeouts", []).append(kw.get("timeout"))
            return Proc()

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


if __name__ == "__main__":
    unittest.main()

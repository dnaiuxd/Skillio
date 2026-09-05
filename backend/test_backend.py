"""
Tests for the pure functions in app.py — the report parsing and the gate
fingerprint. Stdlib unittest only, no extra dependencies:

    backend/.venv/bin/python -m unittest discover backend

Every case here is a bug this app actually shipped, or the boundary that
bug sat on. They are cheap because none of this touches the network, the
database or the skillspector binary.
"""
import unittest

from app import _derive_name, _extract_score_and_verdict, _report_fingerprint


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


if __name__ == "__main__":
    unittest.main()

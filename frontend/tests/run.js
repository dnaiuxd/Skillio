/**
 * Tests for the pure functions in app.js — risk band, coverage notice, gate
 * label, severity counting. No dependencies and no test runner:
 *
 *     node frontend/tests/run.js
 *
 * app.js is a browser-global script, so it is loaded here behind a DOM stub
 * rather than sliced up with regexes. That way the tests exercise the file
 * that actually ships, and a rename inside it fails loudly instead of
 * silently testing nothing.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// --- the smallest DOM that lets app.js finish evaluating -------------------
// Attributes and focus are real rather than no-ops: the empty-source nudge is
// expressed entirely in aria-invalid and where focus lands, so a stub that
// swallowed both would assert nothing.
let focused = null;
const el = (id) => {
  const attrs = new Map();
  const node = {
    id,
    addEventListener() {},
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    hasAttribute: (k) => attrs.has(k),
    removeAttribute(k) { attrs.delete(k); },
    focus() { focused = node; },
    contains: () => false,
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll: () => [],
    querySelector: () => null,
    style: {},
    dataset: {},
    files: [],
    hidden: false,
    textContent: "",
    innerHTML: "",
    value: "",
  };
  return node;
};

// One node per id, so a test can hold the same object app.js captured in els.
const nodes = new Map();
const byId = (id) => {
  if (!nodes.has(id)) nodes.set(id, el(id));
  return nodes.get(id);
};

const sandbox = {
  console,
  document: {
    getElementById: byId,
    querySelector: el,
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: { dataset: {} },
    body: el(),
  },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  // Resolve nothing: checkHealth() and loadSkills() fire on load and must not
  // reach the network or leave the process with a pending handle.
  fetch: () => new Promise(() => {}),
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  // topbarColor() reads --topbar-bg off the root to keep the PWA title bar
  // in step with the header; returning "" exercises its fallback.
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  addEventListener() {},
  setTimeout,
  clearTimeout,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8"),
  sandbox,
  { filename: "app.js" }
);

const { severityBand, bandClass, severityWord, coverageNotice,
        gateStatusLabel, countBySeverity, isHighRisk, severityRank,
        showSourceError, clearSourceError, runScan,
        isScanning, syncScanState } = sandbox;

for (const [name, fn] of Object.entries({
  severityBand, bandClass, severityWord, coverageNotice,
  gateStatusLabel, countBySeverity, isHighRisk, severityRank,
  showSourceError, clearSourceError, runScan, isScanning, syncScanState,
})) {
  assert.equal(typeof fn, "function", `app.js no longer exports ${name}`);
}

// --- tiny runner -----------------------------------------------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push([name, e]);
  }
}
const skill = (score, severity, rec = "CAUTION") => ({
  score,
  verdict: rec,
  report: { risk_assessment: { score, severity, recommendation: rec } },
});

// --- risk band -------------------------------------------------------------
// Mirrors SkillSpector's _RISK_SEVERITY_BANDS: 81 CRITICAL, 51 HIGH,
// 21 MEDIUM, 0 LOW. We displayed "high" for everything above 50 until this
// was checked against its source, so a 100 read one band too low.
test("band boundaries match SkillSpector's", () => {
  for (const [score, want] of [[0, "low"], [20, "low"], [21, "medium"], [50, "medium"],
                               [51, "high"], [80, "high"], [81, "critical"], [100, "critical"]]) {
    assert.equal(severityWord(score), want, `score ${score}`);
  }
});

test("null score has no band", () => assert.equal(severityWord(null), null));

test("the report's own severity outranks the score", () => {
  assert.equal(severityBand(skill(5, "CRITICAL")), "critical");
  assert.equal(severityBand(skill(95, "LOW")), "low");
});

test("an unrecognised severity falls back to the score", () => {
  assert.equal(severityBand(skill(95, "BOGUS")), "critical");
  assert.equal(severityBand({ score: 95, report: {} }), "critical");
  assert.equal(severityBand({ score: 95 }), "critical");
});

test("critical and high share the red class, since both mean do-not-install", () => {
  assert.equal(bandClass("critical"), "critical");
  assert.equal(bandClass("high"), "critical");
  assert.equal(bandClass("medium"), "medium");
  assert.equal(bandClass("low"), "ok");
  assert.equal(bandClass(null), "pending");
});

test("high risk fires on the band or on the verdict text", () => {
  assert.equal(isHighRisk(skill(90, "CRITICAL")), true);
  assert.equal(isHighRisk({ score: 5, verdict: "DO_NOT_INSTALL", report: {} }), true);
  assert.equal(isHighRisk({ score: 5, verdict: "do not install", report: {} }), true);
  assert.equal(isHighRisk(skill(5, "LOW", "SAFE")), false);
});

// --- coverage notice -------------------------------------------------------
const ac = (o) => ({ analysis_completeness: { ledger_exceptions: [], ...o } });

test("a complete scan says nothing", () => {
  assert.equal(coverageNotice(ac({
    total_components: 4, fully_inspected_files: 4, partially_inspected_files: 0,
    entirely_uninspected_files: 0, coverage_percent: 100 })), null);
});

test("no analysis_completeness says nothing", () => {
  assert.equal(coverageNotice({}), null);
  assert.equal(coverageNotice(null), null);
});

test("a partial scan warns and names its reasons", () => {
  const out = coverageNotice(ac({
    total_components: 1, fully_inspected_files: 0, partially_inspected_files: 1,
    entirely_uninspected_files: 0, coverage_percent: 0,
    ledger_exceptions: [{ reason_code: "reference_unresolved" },
                        { reason_code: "static_parse_limit" }] }));
  assert.match(out, /incomplete/);
  assert.match(out, /Reasons: some file references couldn't be followed and part of the code/);
  // The point of the notice: a low score from an unread skill is not "safe".
  assert.match(out, /not the same as the skill being safe/);
});

test("one reason reads 'Reason', several read 'Reasons'", () => {
  const one = coverageNotice(ac({
    total_components: 3, fully_inspected_files: 1, partially_inspected_files: 2,
    entirely_uninspected_files: 0, coverage_percent: 33,
    ledger_exceptions: [{ reason_code: "runtime_limit" }] }));
  assert.match(one, /\nReason: the scan ran out of time\./);
});

test("phrasing adapts to how many files there were", () => {
  const single = coverageNotice(ac({
    total_components: 1, fully_inspected_files: 0, partially_inspected_files: 1,
    entirely_uninspected_files: 0, coverage_percent: 0 }));
  assert.match(single, /the one file in this skill/);

  const none = coverageNotice(ac({
    total_components: 334, fully_inspected_files: 0, partially_inspected_files: 334,
    entirely_uninspected_files: 0, coverage_percent: 0 }));
  assert.match(none, /any of its 334 files/);

  const some = coverageNotice(ac({
    total_components: 4, fully_inspected_files: 1, partially_inspected_files: 3,
    entirely_uninspected_files: 0, coverage_percent: 25 }));
  assert.match(some, /only fully read 1 of its 4 files/);
});

test("an unknown reason code is humanised rather than dropped", () => {
  const out = coverageNotice(ac({
    total_components: 2, fully_inspected_files: 1, partially_inspected_files: 1,
    entirely_uninspected_files: 0, coverage_percent: 50,
    ledger_exceptions: [{ reason_code: "some_future_reason" }] }));
  assert.match(out, /some future reason/);
});

// --- gate label ------------------------------------------------------------
test("rejected displays as 'not approved' without changing the stored value", () => {
  assert.equal(gateStatusLabel("rejected"), "not approved");
  assert.equal(gateStatusLabel("approved"), "approved");
  assert.equal(gateStatusLabel("pending"), "pending");
  assert.equal(gateStatusLabel(undefined), "pending");
});

// --- severity counting -----------------------------------------------------
test("counts the four real bands", () => {
  const c = countBySeverity([{ severity: "CRITICAL" }, { severity: "medium" },
                             { severity: "Medium" }, { severity: "LOW" }]);
  assert.equal(c.critical, 1);
  assert.equal(c.medium, 2);
  assert.equal(c.low, 1);
  assert.equal(c.high, 0);
  assert.equal(c.other, 0);
});

test("an unexpected level lands in 'other' instead of vanishing", () => {
  // SkillSpector defines exactly four severities. If a later release adds
  // one, the chart must not silently stop adding up.
  const c = countBySeverity([{ severity: "INFO" }, { severity: "MEDIUM" }]);
  assert.equal(c.other, 1);
  assert.equal(c.medium, 1);
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), 2);
});

test("a missing severity is counted, not dropped", () => {
  assert.equal(countBySeverity([{}]).other, 1);
});

test("severity ranks sort worst-first, unknowns last", () => {
  assert.ok(severityRank("critical") < severityRank("high"));
  assert.ok(severityRank("low") < severityRank("nonsense"));
});

// --- empty-source nudge ----------------------------------------------------
// The bug this guards: `if (!stagedFile && !source) return;` meant clicking
// Scan on an empty form did nothing at all, which reads as a broken button.
const scanInput = sandbox.document.getElementById("scan-input");
const fieldError = sandbox.document.getElementById("scan-input-error");
const scanStatus = sandbox.document.getElementById("scan-status");

function resetNudge() {
  scanInput.removeAttribute("aria-invalid");
  scanInput.value = "";
  fieldError.hidden = true;
  fieldError.textContent = "";
  scanStatus.hidden = true;
  scanStatus.textContent = "";
  focused = null;
}

test("scanning with no source says so instead of returning silently", () => {
  resetNudge();
  // runScan is async, but everything up to its first await — the empty-source
  // guard included — runs synchronously, so the side effects are here already.
  runScan();
  assert.equal(fieldError.hidden, false);
  assert.match(fieldError.textContent, /Git URL/);
});

test("the nudge marks the field invalid and puts focus where the fix goes", () => {
  resetNudge();
  runScan();
  assert.equal(scanInput.getAttribute("aria-invalid"), "true");
  assert.equal(focused, scanInput, "focus should return to the empty input");
});

test("whitespace is not a source", () => {
  resetNudge();
  scanInput.value = "   ";
  runScan();
  assert.equal(fieldError.hidden, false);
});

test("the nudge stays out of #scan-status, which is action feedback", () => {
  // Field validation belongs beside the field; #scan-status is kept for scan
  // progress and for uploads that were rejected.
  resetNudge();
  runScan();
  assert.equal(scanStatus.hidden, true);
  assert.equal(scanStatus.textContent, "");
});

test("clearing takes back both the message and the invalid state", () => {
  resetNudge();
  runScan();
  clearSourceError();
  assert.equal(scanInput.getAttribute("aria-invalid"), null);
  assert.equal(fieldError.hidden, true);
  assert.equal(fieldError.textContent, "");
});

test("clearing is a no-op when nothing is wrong", () => {
  // It runs on every keystroke, so it must not touch a slot it did not set.
  resetNudge();
  fieldError.hidden = false;
  fieldError.textContent = "untouched";
  clearSourceError();
  assert.equal(fieldError.textContent, "untouched");
  assert.equal(fieldError.hidden, false);
});

// Last of this group on purpose: a source that passes the guard leaves the
// module mid-scan, waiting on a fetch the stub never resolves.
test("a source that is present scans rather than nudging", () => {
  resetNudge();
  scanInput.value = "https://github.com/example/skill";
  runScan();
  assert.equal(fieldError.hidden, true, "a real source must not be rejected");
  assert.equal(scanInput.getAttribute("aria-invalid"), null);
});

// --- background scanning ---------------------------------------------------
// The scan runs on the server and the row carries its progress, so the log —
// not a flag in this tab — decides whether the form is locked. That is what
// makes a reload mid-scan pick the state back up instead of losing it.
const useLlm = sandbox.document.getElementById("use-llm");
const scanBtn = sandbox.document.getElementById("scan-btn");

test("a row is scanning only while the server says so", () => {
  assert.equal(isScanning({ scan_state: "running" }), true);
  assert.equal(isScanning({ scan_state: "done" }), false);
  assert.equal(isScanning({}), false);
  assert.equal(isScanning(null), false);
});

test("a running row locks the form, even on a cold load", () => {
  // No scan was started in this tab; the state comes purely from the log.
  syncScanState([{ scan_state: "running" }, { scan_state: "done" }]);
  assert.equal(scanBtn.disabled, true);
  assert.equal(scanBtn.textContent, "Scanning…");
  assert.equal(useLlm.disabled, true);
});

test("the form comes back once nothing is running", () => {
  syncScanState([{ scan_state: "running" }]);
  syncScanState([{ scan_state: "done" }]);
  assert.equal(scanBtn.disabled, false);
  assert.equal(scanBtn.textContent, "Scan");
  assert.equal(useLlm.disabled, false);
});

test("an empty log leaves the form usable", () => {
  syncScanState([]);
  assert.equal(scanBtn.disabled, false);
  assert.equal(scanBtn.textContent, "Scan");
});

// --- report ----------------------------------------------------------------
for (const [name, err] of failures) {
  console.error(`  FAIL  ${name}\n        ${err.message.split("\n")[0]}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

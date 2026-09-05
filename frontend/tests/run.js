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
const el = () => ({
  addEventListener() {},
  setAttribute() {},
  getAttribute: () => null,
  focus() {},
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
});

const sandbox = {
  console,
  document: {
    getElementById: el,
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
        gateStatusLabel, countBySeverity, isHighRisk, severityRank } = sandbox;

for (const [name, fn] of Object.entries({
  severityBand, bandClass, severityWord, coverageNotice,
  gateStatusLabel, countBySeverity, isHighRisk, severityRank,
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

// --- report ----------------------------------------------------------------
for (const [name, err] of failures) {
  console.error(`  FAIL  ${name}\n        ${err.message.split("\n")[0]}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

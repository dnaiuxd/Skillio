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
// Attributes, focus, classes and children are real rather than no-ops: the
// empty-source nudge lives entirely in aria-invalid and where focus lands,
// and the failure box entirely in which classes it carries and which children
// it holds. A stub that swallowed either would assert nothing.
let focused = null;
const el = (id) => {
  const attrs = new Map();
  const classes = new Set();
  const node = {
    id,
    addEventListener() {},
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    hasAttribute: (k) => attrs.has(k),
    removeAttribute(k) { attrs.delete(k); },
    focus() { focused = node; },
    contains: () => false,
    classList: {
      add(...c) { for (const x of c) classes.add(x); },
      remove(...c) { for (const x of c) classes.delete(x); },
      contains: (c) => classes.has(c),
      toggle(c, on) {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
    },
    children: [],
    appendChild(child) { node.children.push(child); return child; },
    append(...kids) { node.children.push(...kids); },
    querySelectorAll: () => [],
    querySelector: () => null,
    style: {},
    dataset: {},
    files: [],
    hidden: false,
    innerHTML: "",
    value: "",
  };
  // Assigning textContent empties a node in a real DOM, which is exactly how
  // the failure box is cleared before it is rebuilt.
  let text = "";
  Object.defineProperty(node, "textContent", {
    get: () => (node.children.length ? node.children.map((c) => c.textContent).join("") : text),
    set(v) { text = String(v); node.children.length = 0; },
  });
  return node;
};

// One node per id, so a test can hold the same object app.js captured in els.
const nodes = new Map();
const byId = (id) => {
  if (!nodes.has(id)) nodes.set(id, el(id));
  return nodes.get(id);
};

// One node per selector too, so app.js and a test asking for ".scan-or" get
// the same object. Registering a selector directly overrides it, which is how
// a test says which radio is checked.
const selectors = new Map();
const bySelector = (sel) => {
  if (!selectors.has(sel)) selectors.set(sel, el(sel));
  return selectors.get(sel);
};

const sandbox = {
  console,
  document: {
    getElementById: byId,
    createElement: (tag) => {
      const n = el(tag);
      n.tagName = String(tag).toUpperCase();
      return n;
    },
    querySelector: bySelector,
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
        isScanning, syncScanState, updateNotice,
        scanMode, isMcpMode, onScanModeChange, updateSourceType,
        truncationNotice, friendlyError, renderScanError,
        resetDetailError, requestMessage } = sandbox;

for (const [name, fn] of Object.entries({
  severityBand, bandClass, severityWord, coverageNotice,
  gateStatusLabel, countBySeverity, isHighRisk, severityRank,
  showSourceError, clearSourceError, runScan, isScanning, syncScanState,
  updateNotice, scanMode, isMcpMode, onScanModeChange, updateSourceType,
  truncationNotice, friendlyError, renderScanError, resetDetailError,
  requestMessage,
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

// --- update check ----------------------------------------------------------
test("a newer release is announced with a link to it", () => {
  const n = updateNotice({
    installed: "SkillSpector v2.11.0", latest: "SkillSpector v2.11.1",
    url: "https://github.com/NVIDIA/SkillSpector/releases/tag/v2.11.1",
    update_available: true, comparable: true,
  });
  assert.equal(n.kind, "available");
  // The tag title already carries the product name; prefixing it again would
  // read "SkillSpector SkillSpector v2.11.1".
  assert.equal(n.text, "SkillSpector v2.11.1 is available");
  assert.match(n.url, /^https:\/\//);
});

test("being up to date says so, and offers no link", () => {
  const n = updateNotice({
    installed: "SkillSpector v2.11.1", latest: "SkillSpector v2.11.1",
    url: "https://example.invalid", update_available: false, comparable: true,
  });
  assert.equal(n.kind, "current");
  assert.match(n.text, /latest/);
  assert.equal(n.url, undefined);
});

test("an unreadable installed version is not reported as up to date", () => {
  // The dangerous wrong answer: telling someone they are current when the
  // comparison never actually happened.
  const n = updateNotice({
    installed: null, latest: "SkillSpector v2.11.1",
    url: "https://example.test", update_available: false, comparable: false,
  });
  assert.equal(n.kind, "unknown");
  assert.doesNotMatch(n.text, /You're on the latest/);
});

test("no payload yields no notice rather than throwing", () => {
  assert.equal(updateNotice(null), null);
  assert.equal(updateNotice(undefined), null);
});

// --- what is being scanned -------------------------------------------------
// skillspector reads a skill and an MCP Registry differently, and the two
// look alike as URLs, so the mode is stated rather than sniffed.
const MODE_SEL = 'input[name="scan-mode"]:checked';
const dropZone = sandbox.document.getElementById("drop-zone");
const scanOr = sandbox.document.querySelector(".scan-or");
const sourceType = sandbox.document.getElementById("source-type");

function setMode(value) {
  selectors.set(MODE_SEL, { value });
}

test("a scan is a skill scan unless something says otherwise", () => {
  selectors.delete(MODE_SEL);
  assert.equal(scanMode(), "skill");
  assert.equal(isMcpMode(), false);
});

test("choosing the registry is reported as the registry", () => {
  setMode("mcp_registry");
  assert.equal(scanMode(), "mcp_registry");
  assert.equal(isMcpMode(), true);
});

test("registry mode puts the .zip drop zone away", () => {
  // A registry is a URL or a payload path; an upload cannot be one, and the
  // upload endpoint has no way to pass the flag even if it were.
  setMode("mcp_registry");
  onScanModeChange();
  assert.equal(dropZone.hidden, true);
  assert.equal(scanOr.hidden, true);
  assert.match(scanInput.placeholder || "", /MCP Registry/);
});

test("going back to skills brings the drop zone back", () => {
  setMode("mcp_registry");
  onScanModeChange();
  setMode("skill");
  onScanModeChange();
  assert.equal(dropZone.hidden, false);
  assert.equal(scanOr.hidden, false);
  assert.match(scanInput.placeholder || "", /\.zip/);
});

test("the source-type chip stays quiet for a registry", () => {
  // It names skill sources. Calling a registry URL a "Git URL" would be
  // worse than saying nothing at all.
  setMode("mcp_registry");
  sourceType.hidden = false;
  scanInput.value = "https://registry.modelcontextprotocol.io/v0/servers";
  updateSourceType();
  assert.equal(sourceType.hidden, true);
  selectors.delete(MODE_SEL);
});

// --- an MCP Registry report ------------------------------------------------
// The shape a live --mcp-registry scan returns: top-level risk_score and
// findings[], with no risk_assessment block at all. The display has to read
// it through the same path a skill report takes.
const mcpReport = {
  mcp_registry: true,
  source: "https://registry.modelcontextprotocol.io/v0/servers",
  server_count: 96850,
  risk_score: 100,
  max_risk_score: 30,
  findings: [{ id: "MC001", severity: "CRITICAL" }, { id: "MC002", severity: "HIGH" }],
};
const mcpRow = { score: 100, verdict: "do_not_install", report: mcpReport };

test("a registry report still lands in a band", () => {
  // No risk_assessment.severity to read, so this comes off the score.
  assert.equal(severityBand(mcpRow), "critical");
  assert.equal(bandClass(severityBand(mcpRow)), "critical");
  assert.equal(isHighRisk(mcpRow), true);
});

test("a registry report's findings are counted", () => {
  const c = countBySeverity(mcpReport.findings);
  assert.equal(c.critical, 1);
  assert.equal(c.high, 1);
});

test("a registry report raises no coverage warning of its own", () => {
  // It carries no analysis_completeness; that must read as "nothing to say"
  // rather than as an incomplete scan.
  assert.equal(coverageNotice(mcpReport), null);
});

test("a capped findings list says how much is missing", () => {
  // The standing rule in this app: a short list must never be mistaken for a
  // clean one. A cap is exactly that hazard.
  const n = truncationNotice({ findings_total: 98029 }, 1000);
  assert.match(n, /1,000/);
  assert.match(n, /98,029/);
  assert.match(n, /not\s+the full list/);
});

test("it counts the rows on the page, not the raw list", () => {
  // dedupeFindings collapses repeats of one finding_id into a single row, so
  // the stored list and the rendered list are different lengths. Quoting the
  // stored one over 40 visible rows would be its own small lie.
  const n = truncationNotice({ findings: new Array(1000).fill({}), findings_total: 98029 }, 40);
  assert.match(n, /Showing 40 of 98,029/);
});

test("an uncapped list says nothing", () => {
  assert.equal(truncationNotice({ findings: [{}, {}] }, 2), null);
  assert.equal(truncationNotice({ findings: [{}, {}], findings_total: 2 }, 2), null);
  assert.equal(truncationNotice(null, 0), null);
  // No count means nothing trustworthy to claim, so claim nothing.
  assert.equal(truncationNotice({ findings_total: 98029 }, undefined), null);
});

// --- what a failed scan says -----------------------------------------------
// Every string below was produced by running skillspector against a source
// chosen to break it, then copied out of stderr verbatim — hard wrapping and
// all. Patterns matched against imagined output are patterns that match
// nothing, which is the failure mode this whole feature exists to avoid.
const RAW = {
  registry:
    "skillspector produced no report (exit code 2). stderr: Error: MCP Registry " +
    "source failed: https://registry.modelcontextprotocol.io/v0/servers: " +
    "[Errno 54] Connection reset by peer",
  clone:
    "skillspector produced no output (exit code 2). stderr: Error: Failed to " +
    "clone repository",
  host:
    "skillspector produced no output (exit code 2). stderr: Error: Host " +
    "'registry.modelcontextprotocol.io' is not in the allowed hosts list.\n" +
    "Allowed: ['bitbucket.org', 'github.com', 'gitlab.com', 'huggingface.co', \n" +
    "'raw.githubusercontent.com']",
  inputType:
    "skillspector produced no output (exit code 2). stderr: Error: Cannot " +
    "determine input type for: /nope/definitely-missing\nSupported formats: " +
    "Git URL, file URL, .zip file, .md file, or directory",
  zip:
    "skillspector produced no output (exit code 2). stderr: Error: Invalid zip file: \n" +
    "/private/tmp/claude-501/-Users-dnaiuxd-Projects-skillio/95df2a3f-8769-45f5-898b-\n" +
    "506b13408ed7/scratchpad/fake.zip",
  timeout: "Scan timed out after 3600s",
  missing:
    "skillspector was not found on PATH. Install it first: `uv tool install " +
    "git+https://github.com/NVIDIA/skillspector.git`",
};

const FALLBACK_LEAD = friendlyError("something nobody has ever seen").lead;

test("every real failure gets its own answer, not the generic one", () => {
  for (const [name, raw] of Object.entries(RAW)) {
    const { lead, hint } = friendlyError(raw);
    assert.notEqual(lead, FALLBACK_LEAD, `${name} falls through to the fallback`);
    assert.ok(hint && hint.length > 20, `${name} says what happened but not what to do`);
  }
});

test("the CLI's own line wrapping cannot break a match", () => {
  // rich wraps stderr at ~78 columns, mid-phrase and mid-path, so a newline
  // lands in the middle of the words being matched. This one is wrapped
  // straight through "allowed hosts list".
  const wrapped =
    "Error: Host 'a-very-long-hostname-that-pushes-the-line-over.example.com' is\n" +
    "not in the allowed hosts list.";
  assert.match(friendlyError(wrapped).lead, /trusted sites/);
});

test("a registry address in Skill mode is answered by the host rule", () => {
  // It matches both rules — it says "registry.modelcontextprotocol.io" and it
  // is a host rejection. Only one of the two tells you what to do about it,
  // so order in the table is load-bearing.
  const { lead, hint } = friendlyError(RAW.host);
  assert.match(lead, /trusted sites/);
  assert.match(hint, /switch the mode/i);
  assert.equal(/thousands of requests/.test(hint), false);
});

test("a real registry failure blames the registry, not the user", () => {
  const { lead, hint } = friendlyError(RAW.registry);
  assert.match(lead, /MCP Registry stopped answering/);
  assert.match(hint, /Nothing is wrong with your setup/);
});

test("a timeout is reported in minutes, not in seconds", () => {
  assert.match(friendlyError("Scan timed out after 3600s").lead, /60-minute/);
  assert.match(friendlyError("Scan timed out after 600s").lead, /10-minute/);
  // Never "0-minute": a sub-minute limit still reads as a limit.
  assert.match(friendlyError("Scan timed out after 20s").lead, /1-minute/);
});

test("an unrecognised failure still says something useful", () => {
  for (const raw of [null, undefined, "", "   ", "Scan failed unexpectedly: KeyError"]) {
    const { lead, hint } = friendlyError(raw);
    assert.equal(lead, FALLBACK_LEAD);
    assert.ok(hint.length > 20);
  }
});

test("the box keeps SkillSpector's own words, folded away", () => {
  // The plain sentence is for the person reading it; the raw text is what
  // makes a bug report worth having. Losing the second to gain the first
  // would be a bad trade, so it is asserted verbatim.
  const box = sandbox.document.getElementById("detail-error");
  renderScanError(RAW.registry);
  assert.equal(box.classList.contains("detail-error--fail"), true);
  assert.equal(box.hidden, false);

  const [lead, hint, details] = box.children;
  assert.equal(lead.className, "detail-error-lead");
  assert.equal(hint.className, "detail-error-hint");
  assert.equal(details.className, "detail-error-raw");
  assert.equal(details.tagName, "DETAILS");

  const [summary, pre] = details.children;
  assert.equal(summary.tagName, "SUMMARY");
  assert.match(summary.textContent, /Technical details/);
  assert.equal(pre.tagName, "PRE");
  assert.equal(pre.textContent, RAW.registry);
});

test("nothing is built when there is nothing to fold away", () => {
  const box = sandbox.document.getElementById("detail-error");
  renderScanError("");
  assert.equal(box.children.length, 2, "an empty disclosure was added anyway");
});

test("clearing takes the children and the modifier together", () => {
  // The same box shows a failure, a caveat and a delete error. A leftover
  // <details> or a leftover class renders one of them dressed as another.
  const box = sandbox.document.getElementById("detail-error");
  renderScanError(RAW.clone);
  resetDetailError();
  assert.equal(box.children.length, 0);
  assert.equal(box.classList.contains("detail-error--fail"), false);
  assert.equal(box.classList.contains("detail-error--warn"), false);
});

test("the failure path never prints a raw exit code at the reader", () => {
  // "produced no report (exit code 2)" is a true sentence that helps nobody.
  // It belongs in the disclosure, never in the lead or the hint.
  for (const raw of Object.values(RAW)) {
    const { lead, hint } = friendlyError(raw);
    for (const part of [lead, hint]) {
      assert.equal(/exit code|stderr|Errno|Traceback/i.test(part), false,
        `machine wording leaked into: ${part}`);
    }
  }
});

test("a server that isn't there is said in words, not in browser jargon", () => {
  // "Failed to fetch" is what the browser calls it; it is also exactly what
  // the user sees when the launchd job has died, which has an actual fix.
  for (const m of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch", ""]) {
    const said = requestMessage(new Error(m), "Couldn't start the scan");
    assert.match(said, /isn't answering/);
    assert.match(said, /reopen Skillio/);
    assert.equal(/fetch|NetworkError/i.test(said), false);
  }
});

test("a bare status code is turned into a sentence with somewhere to look", () => {
  const said = requestMessage(new Error("HTTP 500"), "Couldn't start the scan");
  assert.match(said, /Couldn't start the scan/);
  assert.match(said, /HTTP 500/);
  assert.match(said, /~\/Library\/Logs/);
});

test("a reason the backend wrote is passed through as it stands", () => {
  // The backend's details are already written for this screen — rewording
  // them here would mean two copies of the same sentence drifting apart.
  const said = requestMessage(
    new Error("A scan is already running. Wait for it to finish."),
    "Couldn't start the scan"
  );
  assert.match(said, /already running/);
});

// --- the markup app.js assumes ---------------------------------------------
// The DOM stub above hands back a node for any id asked of it, so app.js
// evaluates cleanly even against markup that no longer has the element. That
// is a blind spot: renaming an id in index.html and forgetting app.js (or the
// reverse) breaks a control in the browser and nothing here notices. This
// checks the two files against each other.
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("every id app.js looks up exists in index.html", () => {
  const wanted = [...appSource.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(wanted.length > 20, `only found ${wanted.length} getElementById calls`);
  const missing = wanted.filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, [], `ids in app.js with no element: ${missing.join(", ")}`);
});

test("the About dialog is a real <dialog> with its trigger and close", () => {
  // showModal() is what brings the focus trap, Esc-to-close and the inert
  // background. Downgrading this to a <div> would lose all three silently.
  assert.match(html, /<dialog[^>]*id="about-dialog"/);
  assert.match(html, /id="about-btn"/);
  assert.match(html, /id="about-close"/);
  assert.match(appSource, /aboutDialog\.showModal\(\)/);
  // A modal needs an accessible name, and aria-labelledby has to point at
  // something that is actually in the dialog.
  const labelledBy = html.match(/<dialog[^>]*aria-labelledby="([^"]+)"/);
  assert.ok(labelledBy, "the dialog has no aria-labelledby");
  assert.match(html, new RegExp(`id="${labelledBy[1]}"`));
});

test("the credit link's hover-only underline stays documented", () => {
  // Hover-only means colour alone marks it as a link at rest (WCAG 1.4.1),
  // and :hover never fires on touch. That is the owner's deliberate call on
  // their own byline — but a deliberate deviation is only deliberate while
  // the reasoning travels with it, so this fails if the note is dropped.
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  // Shared with .brand-link now, so match the selector rather than "{".
  const at = css.search(/^\.credit-link[,{\s]/m);
  assert.notEqual(at, -1, "no .credit-link rule in style.css");
  assert.match(css.slice(Math.max(0, at - 900), at), /KNOWN, DELIBERATE DEVIATION/);
  assert.match(css.slice(Math.max(0, at - 900), at), /1\.4\.1/);
});

test("the log heading and the registry label read as intended", () => {
  assert.match(html, /<h2 class="list-title">Skillio Scan<\/h2>/);
  // "MCP Registry" is a proper noun; a lowercase r is a typo, not a style.
  assert.equal(/MCP registry/.test(html), false);
  assert.equal(/MCP registry/.test(appSource), false);
});

test("the scan input's accessible name follows the mode", () => {
  // The accessible name outranks the placeholder for a screen reader, so a
  // stale one announces the exact input the field cannot take.
  const radio = sandbox.document.querySelector('input[name="scan-mode"]:checked');

  radio.value = "mcp_registry";
  onScanModeChange();
  assert.match(scanInput.getAttribute("aria-label"), /MCP Registry/);

  radio.value = "skill";
  onScanModeChange();
  assert.match(scanInput.getAttribute("aria-label"), /Git URL/);
  assert.equal(/MCP Registry/.test(scanInput.getAttribute("aria-label")), false);
});

test("the mode is synced at boot, not only on change", () => {
  // A reload restores the checked radio without firing `change`, which left
  // the drop zone visible while the POST carried mcp_registry: true.
  assert.match(appSource, /^onScanModeChange\(\);$/m);
});

test("an empty findings list cannot wipe the truncation notice", () => {
  // renderFindings appends the notice and then, if nothing survived, used to
  // assign innerHTML — deleting the warning and rendering a capped report as
  // clean. The no-findings branch must build a node, not clobber the box.
  const body = appSource.slice(appSource.indexOf("function renderFindings"));
  const branch = body.slice(body.indexOf("findings.length === 0"), body.indexOf("const sorted"));
  assert.equal(/innerHTML\s*=/.test(branch), false, "no-findings branch still assigns innerHTML");
  assert.match(branch, /appendChild/);
});

test("the SkillSpector help dialog is a real modal with a name", () => {
  assert.match(html, /<dialog[^>]*id="skillspector-help-dialog"/);
  assert.match(html, /id="skillspector-help-close"/);
  const labelledBy = html.match(/<dialog[^>]*id="skillspector-help-dialog"[^>]*aria-labelledby="([^"]+)"/);
  assert.ok(labelledBy, "the help dialog has no aria-labelledby");
  assert.match(html, new RegExp(`id="${labelledBy[1]}"`));
  assert.match(appSource, /helpDialog\.showModal\(\)/);
});

test("the help dialog opens at its own title, not scrolled past it", () => {
  // autofocus on the Close button at the far end scrolls a long dialog to the
  // bottom on open, so it lands mid-sentence with the heading off-screen.
  const dlg = html.slice(html.indexOf('id="skillspector-help-dialog"'));
  const body = dlg.slice(0, dlg.indexOf("</dialog>"));
  assert.match(body, /<h2[^>]*id="skillspector-help-title"[^>]*autofocus/);
  assert.equal(/id="skillspector-help-close"[^>]*autofocus/.test(body), false);
});

test("neither command state sends you to GitHub to find out what to run", () => {
  // The whole point: the command and its explanation come to the user. The
  // not-installed state used to be a bare "install it first" link out.
  assert.equal(/install it first/i.test(appSource), false);
  const health = appSource.slice(appSource.indexOf("function checkHealth"));
  const branch = health.slice(0, health.indexOf("function isScanning"));
  assert.match(branch, /renderCommandBlock\(/);
  assert.match(branch, /uv tool install/);
});

test("the inline info trigger is still a 44px target", () => {
  // It sits in a line of running text, so it is easy to shrink it to fit.
  // The project's floor is 44, met with transparent padding, not a small box.
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  const rule = css.match(/\.info-btn--inline\s*\{([^}]*)\}/);
  assert.ok(rule, "no .info-btn--inline rule");
  assert.match(rule[1], /width:\s*44px/);
  assert.match(rule[1], /height:\s*44px/);
});

test("the credit line's Skillio is the link to the repository", () => {
  const links = [...html.matchAll(/<a class="brand-link"[^>]*>([^<]*)<\/a>/g)];
  assert.equal(links.length, 2, "expected one in the rail and one in the footer");
  for (const m of links) assert.equal(m[1].trim(), "Skillio");
  // The URL comes from /api/health so there is one copy of it, in the backend.
  assert.equal(/class="brand-link"[^>]*href="https?:/.test(html), false,
    "repo URL hardcoded in markup");
  assert.match(appSource, /data-repo-link[\s\S]{0,120}?\.href = data\.repo_url/);
});

test("the header is the wordmark alone", () => {
  const h1 = html.match(/<h1 class="topbar-title">[\s\S]*?<\/h1>/);
  assert.ok(h1, "no topbar title");
  assert.equal(/data-app-version/.test(h1[0]), false, "version is back in the header");
  assert.equal(/topbar-brand/.test(h1[0]), false, "wordmark is a link again");
  // The update tag is the one thing that does belong up there.
  assert.match(h1[0], /id="skillio-update"/);
});

test("the version renders as the number alone", () => {
  // "Skillio" sits beside it as its own element — the link — so repeating
  // the name here would print it twice in a row.
  const fn = appSource.slice(appSource.indexOf("function showAppVersion"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /`v\$\{version\}`/);
  assert.equal(/Skillio v\$\{version\}/.test(body), false);
});

test("the update tag starts hidden and is checked on load", () => {
  assert.match(html, /id="skillio-update"[^>]*hidden/);
  assert.match(appSource, /^checkSkillioUpdate\(\);$/m);
});

test("a failed self-update check says nothing at all", () => {
  // The repo may be private or the machine offline. An app that nags about
  // its own update check failing is worse than one that stays quiet.
  const fn = appSource.slice(appSource.indexOf("async function checkSkillioUpdate"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /if \(!res\.ok\) return/);
  assert.match(body, /!d\.update_available/);
  // Nothing in the failure path writes to the page.
  const katch = body.slice(body.indexOf("catch"));
  assert.equal(/textContent|hidden\s*=/.test(katch), false);
});

// --- report ----------------------------------------------------------------
for (const [name, err] of failures) {
  console.error(`  FAIL  ${name}\n        ${err.message.split("\n")[0]}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

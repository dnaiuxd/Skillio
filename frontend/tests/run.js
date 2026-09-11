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
  const handlers = {};
  const node = {
    id,
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    // Not a DOM method: how a test presses a button the code just built.
    fire(type, ev = {}) { for (const fn of handlers[type] || []) fn(ev); },
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
  // Assigning className replaces the whole class list, which is how the
  // update card is reset — a plain property would have left the modifier on.
  Object.defineProperty(node, "className", {
    get: () => [...classes].join(" "),
    set(v) {
      classes.clear();
      for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c);
    },
  });
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
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), children: [] }),
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
        resetDetailError, requestMessage, vLabel, showSkillioBanner,
        renderSkillioUpdate, dismissSkillioBanner, fetchSkillioUpdate,
        makeUpdateClose, versionOf, attachTip, makeHelpButton,
        hideTips, allowTips } = sandbox;

for (const [name, fn] of Object.entries({
  severityBand, bandClass, severityWord, coverageNotice,
  gateStatusLabel, countBySeverity, isHighRisk, severityRank,
  showSourceError, clearSourceError, runScan, isScanning, syncScanState,
  updateNotice, scanMode, isMcpMode, onScanModeChange, updateSourceType,
  truncationNotice, friendlyError, renderScanError, resetDetailError,
  requestMessage, vLabel, showSkillioBanner, renderSkillioUpdate,
  dismissSkillioBanner, fetchSkillioUpdate, makeUpdateClose,
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
  // Named once, whatever shape the version arrives in. It used to be the feed
  // entry's title, which carried the product name already; it is the bare tag
  // now, and both have to come out as one "SkillSpector".
  assert.equal(n.text, "SkillSpector v2.11.1 is available");
  assert.match(n.url, /^https:\/\//);
});

test("the product is named once, whichever shape the version arrives in", () => {
  // Publishing a GitHub Release renames the tag's feed entry to the release
  // NAME, so a server that predates the backend fix — or a cached answer
  // written before it — can still send "SkillSpector v2.11.1" here.
  for (const latest of ["v2.11.1", "2.11.1", "SkillSpector v2.11.1",
                        "v2.11.1 — a release with a title"]) {
    const n = updateNotice({ installed: "SkillSpector v2.11.0", latest,
      url: "https://example.invalid", update_available: true, comparable: true });
    assert.equal(n.text, "SkillSpector v2.11.1 is available", `from ${latest}`);
  }
  // And the same for the banner, which builds its own sentence.
  showSkillioBanner({ installed: "1.7.2", latest: "v1.8.0 — plain-language scan failures",
    update_available: true });
  assert.equal(
    sandbox.document.getElementById("skillio-banner-text").textContent,
    "Skillio v1.8.0 is available — you're on v1.7.2."
  );
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

// --- the Skillio update banner ---------------------------------------------
test("a version label never doubles its v", () => {
  // Tags carry it ("v1.8.0"), SKILLIO_VERSION does not ("1.7.2"), and both
  // land in the same sentence.
  assert.equal(vLabel("1.7.2"), "v1.7.2");
  assert.equal(vLabel("v1.8.0"), "v1.8.0");
  assert.equal(vLabel(""), "");
  assert.equal(vLabel(null), "");
});

test("the banner names both versions and links the release", () => {
  const banner = sandbox.document.getElementById("skillio-banner");
  const link = sandbox.document.getElementById("skillio-banner-link");
  showSkillioBanner({
    installed: "1.7.2",
    latest: "v1.8.0",
    url: "https://github.com/dnaiuxd/Skillio/releases/tag/v1.8.0",
    update_available: true,
  });
  assert.equal(banner.hidden, false);
  const text = sandbox.document.getElementById("skillio-banner-text").textContent;
  assert.match(text, /Skillio v1\.8\.0 is available/);
  assert.match(text, /you're on v1\.7\.2/);
  assert.equal(/vv/.test(text), false);
  assert.equal(link.href, "https://github.com/dnaiuxd/Skillio/releases/tag/v1.8.0");
});

test("no update means nothing at all — no banner, no extra line", () => {
  // The card beside this is about SkillSpector. A second sentence in it about
  // a second piece of software read as if the two were the same thing, so an
  // up-to-date Skillio now says nothing rather than something reassuring.
  const banner = sandbox.document.getElementById("skillio-banner");
  banner.hidden = true;
  const card = sandbox.document.getElementById("update-result");
  card.textContent = "";
  renderSkillioUpdate({ installed: "1.7.2", latest: "v1.7.2", update_available: false });
  assert.equal(banner.hidden, true, "raised a banner for an up-to-date app");
  assert.equal(card.textContent, "", "wrote about Skillio into SkillSpector's card");
  assert.equal(/Skillio itself is up to date/.test(appSource), false,
    "the reassurance line is still in app.js");
});

test("a check that failed says nothing either way", () => {
  const banner = sandbox.document.getElementById("skillio-banner");
  const card = sandbox.document.getElementById("update-result");
  banner.hidden = true;
  card.textContent = "";
  renderSkillioUpdate(null);
  assert.equal(banner.hidden, true);
  assert.equal(card.textContent, "");
});

test("dismissing puts focus back where it came from", () => {
  // The close button is inside the thing it closes, so focus would otherwise
  // land on <body> and a keyboard user would restart from the top.
  showSkillioBanner({ installed: "1.7.2", latest: "v1.8.0", update_available: true });
  dismissSkillioBanner();
  assert.equal(sandbox.document.getElementById("skillio-banner").hidden, true);
  assert.equal(focused, sandbox.document.getElementById("update-check"));
});

test("the banner sits above the h1 and starts hidden", () => {
  const banner = html.match(/<div class="app-banner"[^>]*>/);
  assert.ok(banner, "no banner markup");
  assert.match(banner[0], /hidden/);
  assert.match(banner[0], /role="status"/);
  assert.ok(html.indexOf('id="skillio-banner"') < html.indexOf("<header"),
    "the banner is not above the header");
  assert.ok(html.indexOf('id="skillio-banner"') < html.indexOf("<h1"),
    "the banner is not above the h1");
  // A link out of the app, and a close control with a name.
  assert.match(html, /id="skillio-banner-link"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /id="skillio-banner-close"[\s\S]{0,120}aria-label="[^"]+"/);
});

test("nothing announces itself on load", () => {
  // The banner belongs to the button. checkSkillioUpdate is the load path and
  // must never raise it — the quiet tag beside the wordmark is its whole job.
  const fn = appSource.slice(appSource.indexOf("async function checkSkillioUpdate"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.equal(/showSkillioBanner/.test(body), false, "the load path raises the banner");
  assert.match(appSource, /^checkSkillioUpdate\(\);$/m);
});

test("the button checks both things, and one failing does not hide the other", () => {
  // "Check for updates" is plural. A SkillSpector check that throws used to
  // end the function; Skillio's answer has to survive it.
  const fn = appSource.slice(appSource.indexOf("async function checkForUpdates"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /fetchSkillioUpdate\(\{ refresh: true \}\)/);
  const katch = body.slice(body.indexOf("} catch"));
  assert.match(katch, /renderSkillioUpdate\(await skillioCheck\)/);
});

test("a pressed button asks for a fresh answer, not this morning's", () => {
  // The server holds Skillio's answer for six hours, which is right for the
  // silent check on load and wrong for a button someone just pressed.
  const fn = appSource.slice(appSource.indexOf("async function fetchSkillioUpdate"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /refresh \? "\?refresh=true" : ""/);
  // And the load path does NOT ask for one, or the cache would never be used.
  const loader = appSource.slice(appSource.indexOf("async function checkSkillioUpdate"));
  const lbody = loader.slice(0, loader.indexOf("\n}\n"));
  assert.equal(/refresh/.test(lbody), false, "the load check busts the cache");
});

test("closing the update card empties it and hands focus back", () => {
  // Hiding alone would leave last week's answer in the DOM, one unhide away
  // from being shown as if it were current.
  const card = sandbox.document.getElementById("update-result");
  const btn = makeUpdateClose();
  card.hidden = false;
  card.textContent = "v2.12.0 is available";
  card.classList.add("update-result--available");
  btn.fire("click");
  assert.equal(card.hidden, true);
  assert.equal(card.textContent, "");
  assert.equal(card.classList.contains("update-result--available"), false);
  assert.equal(focused, sandbox.document.getElementById("update-check"));
});

test("the card's close control is a real button with a name", () => {
  const btn = makeUpdateClose();
  assert.equal(btn.type, "button");
  assert.equal(btn.getAttribute("aria-label"), "Close update result");
  // Last in its row, so the headline keeps the left edge.
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  const own = css.match(/\n\.update-close \{([^}]*)\}/);
  assert.ok(own, "no .update-close rule");
  assert.match(own[1], /margin-left:\s*auto/);
});

test("there is one dismiss control, shared by the card and the banner", () => {
  // They were 24px and 44px, which read as two different controls doing the
  // same job. One rule now, so they cannot drift apart again.
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  const shared = css.match(/\n\.update-close,\n\.app-banner-close \{([^}]*)\}/);
  assert.ok(shared, "the two close controls no longer share a rule");
  assert.match(shared[1], /width:\s*24px/);
  assert.match(shared[1], /height:\s*24px/);
  assert.match(shared[1], /position:\s*relative/);
  // The banner's ✕ may not re-declare a size of its own: the only block it
  // opens is the shared one above. (Matching "\n.app-banner-close {" alone
  // would hit the second line of that shared selector and always fail.)
  const opens = [...css.matchAll(/\n(?:([^\n]*)\n)?\.app-banner-close \{/g)];
  assert.equal(opens.length, 1, ".app-banner-close opens more than one rule");
  assert.equal(opens[0][1], ".update-close,", ".app-banner-close has its own rule again");
  // Touch keeps the 44px floor for both.
  const coarse = css.match(
    /@media \(pointer: coarse\) \{\s*\.update-close::after,\s*\.app-banner-close::after \{([^}]*)\}/
  );
  assert.ok(coarse, "no coarse-pointer expansion for the close controls");
  assert.match(coarse[1], /inset:\s*-10px/); // 24 + 10 + 10 = 44
});

test("the header tag steps aside while the banner says the same thing", () => {
  const tag = sandbox.document.getElementById("skillio-update");
  const banner = sandbox.document.getElementById("skillio-banner");
  banner.hidden = true;
  tag.hidden = true;

  renderSkillioUpdate({ installed: "1.7.2", latest: "v1.8.0",
    url: "https://example.invalid", update_available: true });
  assert.equal(banner.hidden, false, "no banner");
  assert.equal(tag.hidden, true, "the tag repeats the banner beneath it");

  // Dismissing the banner does not dismiss the update: the tag takes it back,
  // filled in, not empty.
  dismissSkillioBanner();
  assert.equal(banner.hidden, true);
  assert.equal(tag.hidden, false, "the news vanished with the banner");
  assert.equal(tag.textContent, "v1.8.0 available");
  assert.equal(tag.href, "https://example.invalid");
});

test("the banner's amber comes from the palette, not from a new colour", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  const token = css.match(/--attention-bg:([^;]+);/);
  assert.ok(token, "no --attention-bg token");
  // Derived from --medium, so both themes follow without a second copy.
  assert.match(token[1], /var\(--medium\)/);
  const rule = css.match(/\n\.app-banner \{([^}]*)\}/);
  assert.match(rule[1], /var\(--attention-bg\)/);
  assert.equal(/#[0-9a-f]{3,6}/i.test(rule[1]), false, "hardcoded colour in the banner");
});

// --- tooltips on the info triggers -----------------------------------------
test("a tooltip says exactly what the accessible name says", () => {
  // One copy of the words. A tooltip maintained separately from the
  // aria-label is two different answers to the same question, and only one
  // of them gets read aloud.
  const btn = sandbox.document.createElement("button");
  btn.setAttribute("aria-label", "What is Skillio?");
  attachTip(btn);
  const tip = btn.children[0];
  assert.equal(tip.className, "info-tip");
  assert.equal(tip.textContent, "What is Skillio?");
  // Hidden from the accessibility tree: the button already announces this.
  assert.equal(tip.getAttribute("aria-hidden"), "true");
});

test("attaching twice does not stack two tooltips", () => {
  const btn = sandbox.document.createElement("button");
  btn.setAttribute("aria-label", "What is Skillio?");
  btn.querySelector = (sel) =>
    sel === ".info-tip" ? btn.children.find((c) => c.className === "info-tip") || null : null;
  attachTip(btn);
  attachTip(btn);
  assert.equal(btn.children.filter((c) => c.className === "info-tip").length, 1);
});

test("a trigger with no accessible name gets no tooltip", () => {
  // There would be nothing to put in it, and an empty chip on hover is worse
  // than none.
  const btn = sandbox.document.createElement("button");
  attachTip(btn);
  assert.equal(btn.children.length, 0);
});

test("the inline help trigger carries one too", () => {
  const btn = makeHelpButton("How installing and upgrading SkillSpector works");
  const tip = btn.children.find((c) => c.className === "info-tip");
  assert.ok(tip, "the inline trigger has no tooltip");
  assert.equal(tip.textContent, "How installing and upgrading SkillSpector works");
});

test("the tooltip meets 1.4.13 — focus, dismiss, hover", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  // Focus, not just hover: a keyboard user gets the same words.
  assert.match(css, /\.info-btn:hover \.info-tip,\s*\n\.info-btn:focus-visible \.info-tip/);
  // Dismissible: Esc sets a flag on the root that wins over :hover.
  assert.match(css, /:root\.tips-off \.info-tip/);
  assert.match(appSource, /if \(e\.key === "Escape"\) hideTips\(\)/);
  // ...and the flag lifts again, or the next hover would be dead.
  assert.match(appSource, /mousemove", allowTips/);
  assert.match(appSource, /focusin", allowTips/);
  // Hoverable comes from the tip being a CHILD of the trigger: moving the
  // pointer onto the tip is still hovering the button.
  assert.match(appSource, /btn\.appendChild\(tip\)/);
  // Out of the layout entirely while hidden, not merely invisible: a
  // visibility:hidden box still occupies space, and a 234px tip on a trigger
  // near the right edge gave the page a horizontal scrollbar at 390px.
  const rule = css.match(/\n\.info-tip \{([^}]*)\}/);
  assert.ok(rule, "no .info-tip rule");
  assert.match(rule[1], /display:\s*none/);
  // Anchored to a declaration: the rule's own comment explains why
  // visibility:hidden was wrong, and an unanchored match hits the prose.
  assert.equal(/\n\s*visibility:\s*hidden;/.test(rule[1]), false,
    "back to visibility, which still takes part in layout");
  assert.match(rule[1], /max-width: min\(240px, calc\(100vw - 32px\)\)/);
});

test("the tooltip is drawn from tokens, and separates from an ink surface", () => {
  // The chip is --ink and so is .btn-primary right below the LLM trigger:
  // without a hairline of the page's own ground the two merge into one shape.
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  const rule = css.match(/\n\.info-tip \{([^}]*)\}/)[1];
  assert.match(rule, /background: var\(--ink\)/);
  assert.match(rule, /color: var\(--surface\)/);
  assert.match(rule, /border: 1px solid var\(--surface\)/);
  assert.equal(/#[0-9a-f]{3,6}/i.test(rule), false, "hardcoded colour in the tooltip");
});

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

test("the info trigger's target is the icon, and touch still gets 44px", () => {
  // It was a 44px square around an 18px glyph: 13px of dead ring on every
  // side, so a hover or a click over the blank space beside the ⓘ — or over
  // the tail of the words before it — fired it. The box is the glyph plus a
  // 3px ring now, which is what the user sees and what WCAG 2.2 AA asks for
  // (2.5.8, 24×24). A finger has no 3px precision, so coarse pointers get
  // the project's 44px floor back through an overlay that moves no layout.
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  const rule = css.match(/\n\.info-btn \{([^}]*)\}/);
  assert.ok(rule, "no .info-btn rule");
  assert.match(rule[1], /width:\s*24px/);
  assert.match(rule[1], /height:\s*24px/);
  assert.match(rule[1], /position:\s*relative/);
  const coarse = css.match(/@media \(pointer: coarse\) \{\s*\.info-btn::after \{([^}]*)\}/);
  assert.ok(coarse, "no coarse-pointer expansion for .info-btn");
  assert.match(coarse[1], /inset:\s*-10px/); // 24 + 10 + 10 = 44
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
  // The repo may be unreachable or the machine offline. An app that nags
  // about its own update check failing is worse than one that stays quiet.
  // The fetch is its own function now, and the silence lives there.
  const fn = appSource.slice(appSource.indexOf("async function fetchSkillioUpdate"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /if \(!res\.ok\) return null/);
  assert.equal(/textContent|hidden\s*=/.test(body), false, "the fetch writes to the page");
  assert.match(body.slice(body.indexOf("catch")), /return null/);
  // And the load-time caller still refuses to announce a non-update.
  const loader = appSource.slice(appSource.indexOf("async function checkSkillioUpdate"));
  assert.match(loader.slice(0, loader.indexOf("\n}\n")), /!d\.update_available/);
});


test("the handover waits for launchd, not for anything answering the port", () => {
  // The server on its way OUT still answers /api/health. Polling that
  // reported success half a second in, while the launchd process did not
  // yet exist — only `managed` tells the two apart.
  const fn = appSource.slice(appSource.indexOf("async function waitForHandover"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /\/service/);
  assert.ok(!/\/health/.test(body), "waits on /health, which the outgoing server answers");
  assert.match(body, /managed/);
});

test("the install POST cannot be sent by a page on another site", () => {
  // A JSON content type is not decoration here: it forces a CORS preflight,
  // which a simple form-encoded POST would skip.
  const fn = appSource.slice(appSource.indexOf("async function installService"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /"Content-Type":\s*"application\/json"/);
});

test("the run-at-login offer is hidden until the server says to show it", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const offer = html.slice(html.indexOf('id="service-offer"'));
  assert.match(offer.slice(0, offer.indexOf(">") + 1), /hidden/);
  // And it is only shown for a server nobody is already managing.
  const fn = appSource.slice(appSource.indexOf("async function refreshServiceOffer"));
  assert.match(fn.slice(0, fn.indexOf("\n}\n")), /supported && !state\.managed/);
});

test("each handover state is told apart by more than its colour", () => {
  // .info-dialog p is (0,1,1) and sets colour; an unscoped modifier at
  // (0,1,0) lost to it, and every state rendered the same grey.
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  for (const kind of ["working", "done", "error"]) {
    assert.match(
      css,
      new RegExp(`\\.info-dialog \\.service-status--${kind}`),
      `.service-status--${kind} is not scoped under .info-dialog and will lose to .info-dialog p`
    );
  }
  // Colour is the secondary signal; the sentence itself carries the state.
  assert.match(appSource, /setServiceStatus\(\s*\n?\s*"Done\./);
});

test("the dialog's buttons are not flush against the note below them", () => {
  // `.info-dialog p` carries a bottom margin and no top one, so an
  // actions row with only margin-top left a measured 0px gap.
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  const rule = css.slice(css.indexOf(".info-dialog-actions {"));
  assert.match(rule.slice(0, rule.indexOf("}")), /margin:\s*18px 0/);
});

// --- report ----------------------------------------------------------------
for (const [name, err] of failures) {
  console.error(`  FAIL  ${name}\n        ${err.message.split("\n")[0]}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

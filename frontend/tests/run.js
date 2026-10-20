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
  // And it sets innerHTML to the escaped text, as a real one does — which is
  // the whole of how escapeHtml works, so without it every escape is "".
  let text = "";
  let html = "";
  Object.defineProperty(node, "textContent", {
    get: () => (node.children.length ? node.children.map((c) => c.textContent).join("") : text),
    set(v) {
      text = String(v);
      node.children.length = 0;
      html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
  });
  Object.defineProperty(node, "innerHTML", {
    get: () => html,
    // Replaces the children too, as a real one does — the log is emptied this way.
    set(v) { html = String(v); node.children.length = 0; },
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
    // Whatever the stub's focus() last landed on, as a real document reports.
    get activeElement() { return focused; },
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

const { severityBand, bandClass, severityWord, coverageNotice, llmNotice,
        gateStatusLabel, countBySeverity, isHighRisk, severityRank,
        showSourceError, clearSourceError, runScan,
        isScanning, syncScanState, updateNotice,
        scanMode, isMcpMode, onScanModeChange, updateSourceType,
        truncationNotice, friendlyError, renderScanError,
        resetDetailError, requestMessage, vLabel, showSkillioBanner,
        renderSkillioUpdate, dismissSkillioBanner, fetchSkillioUpdate,
        makeUpdateClose, versionOf, attachTip, makeHelpButton,
        hideTips, allowTips, triageSummary, triageRank, renderDetailSource,
        fmtDuration, durationLine, filesChip, secondLookHtml, aiReviewLine,
        codeSpans, reviewLine, updateGateControls, renderSkillList, loadSkills, setTab,
        renderDetail } = sandbox;

for (const [name, fn] of Object.entries({
  severityBand, bandClass, severityWord, coverageNotice, llmNotice,
  gateStatusLabel, countBySeverity, isHighRisk, severityRank,
  showSourceError, clearSourceError, runScan, isScanning, syncScanState,
  updateNotice, scanMode, isMcpMode, onScanModeChange, updateSourceType,
  truncationNotice, friendlyError, renderScanError, resetDetailError,
  requestMessage, vLabel, showSkillioBanner, renderSkillioUpdate,
  dismissSkillioBanner, fetchSkillioUpdate, makeUpdateClose,
  triageSummary, triageRank, fmtDuration, durationLine, filesChip,
  secondLookHtml, aiReviewLine, codeSpans, updateGateControls,
  renderSkillList, loadSkills, setTab, renderDetail,
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
// Async tests run one after another, after every sync test has finished, so
// a stubbed fetch or timer in one can't leak into the next one mid-flight.
let asyncChain = Promise.resolve();
function testAsync(name, fn) {
  asyncChain = asyncChain.then(fn).then(
    () => { passed++; },
    (e) => { failures.push([name, e]); }
  );
}
// Lets every pending promise inside app.js settle.
const flush = () => new Promise((r) => setImmediate(r));
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

// --- B-08: nothing to decide on, no decision buttons ------------------------
const gateApprove = sandbox.document.querySelector('.gate-btn[data-status="approved"]');
const gateReject = sandbox.document.querySelector('.gate-btn[data-status="rejected"]');
const gateNote = sandbox.document.getElementById("gate-note");

test("a scan with no report offers no Install / Do Not Install, and says why", () => {
  updateGateControls({ archived: false, status: "pending", report: null, error: "boom" });
  assert.equal(gateApprove.hidden, true);
  assert.equal(gateReject.hidden, true);
  assert.equal(gateNote.hidden, false);
  assert.match(gateNote.textContent, /no report/i);
});

test("a running scan offers no decision until it lands", () => {
  updateGateControls({ archived: false, status: "pending", report: {}, scan_state: "running" });
  assert.equal(gateApprove.hidden, true);
  assert.equal(gateReject.hidden, true);
  assert.equal(gateNote.hidden, false);
  assert.match(gateNote.textContent, /finishes/);
});

test("a failed RE-scan keeps the gate: the kept report is what you decide on", () => {
  updateGateControls({ archived: false, status: "pending", report: {}, error: "boom", report_scanned: 1 });
  assert.equal(gateApprove.hidden, false);
  assert.equal(gateReject.hidden, false);
  assert.equal(gateNote.hidden, true);
});

test("a decided or archived row says nothing extra", () => {
  updateGateControls({ archived: true, status: "pending", report: null });
  assert.equal(gateNote.hidden, true);
  updateGateControls({ archived: false, status: "approved", report: {}, scan_state: "running" });
  assert.equal(gateNote.hidden, true);
  assert.equal(gateApprove.hidden, true);
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

// --- B-06: a poll must not throw keyboard focus away ------------------------
// The stub's querySelector finds nothing, so rows get a real .row-open node
// here — the same one app.js wires up and focuses.
function installRowButtons() {
  const realCreate = sandbox.document.createElement;
  sandbox.document.createElement = (tag) => {
    const n = realCreate(tag);
    if (tag === "tr") {
      const btn = el("row-open");
      btn.className = "row-open";
      n.openBtn = btn;
      n.querySelector = (sel) => (sel === ".row-open" ? btn : null);
    }
    return n;
  };
  return () => { sandbox.document.createElement = realCreate; };
}
function withRowButtons(fn) {
  const restore = installRowButtons();
  try { return fn(); } finally { restore(); }
}
const skillRows = sandbox.document.getElementById("skill-rows");
const row = (id, extra = {}) => ({ id, name: `s${id}`, source: `/tmp/s${id}`, status: "pending", ...extra });

test("focus on a log row survives the row being rebuilt", () => {
  withRowButtons(() => {
    renderSkillList([row(1, { scan_state: "running" }), row(2)]);
    skillRows.children[1].openBtn.focus();
    renderSkillList([row(1, { score: 10 }), row(2)]);
    assert.equal(focused, skillRows.children[1].openBtn, "focus should land on row 2's new button");
  });
});

test("an unchanged poll leaves the rows alone, so nothing is re-announced", () => {
  withRowButtons(() => {
    renderSkillList([row(3, { scan_state: "running" }), row(4)]);
    const before = skillRows.children[0];
    renderSkillList([row(3, { scan_state: "running" }), row(4)]);
    assert.equal(skillRows.children[0], before);
  });
});

test("focus elsewhere is not pulled into the log", () => {
  withRowButtons(() => {
    renderSkillList([row(5)]);
    scanInput.focus();
    renderSkillList([row(5, { score: 1 })]);
    assert.equal(focused, scanInput);
  });
});

// --- B-07: one failed poll must not strand the form on "Scanning…" ----------
function stubTimers() {
  const calls = [];
  sandbox.setTimeout = (fn, ms) => { calls.push({ fn, ms }); return calls.length; };
  sandbox.clearTimeout = () => {};
  return calls;
}
function restoreTimers() {
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.fetch = () => new Promise(() => {});
}
const okJson = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });

testAsync("a failed poll during a scan schedules another, a little later", async () => {
  const timers = stubTimers();
  try {
    syncScanState([{ scan_state: "running" }]);
    const first = timers.at(-1).ms;
    sandbox.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    await loadSkills();
    await flush();
    assert.ok(timers.length >= 2, "no poll was scheduled after the failure");
    assert.ok(timers.at(-1).ms > first, "the retry should back off");
    assert.equal(scanBtn.textContent, "Scanning…", "state is unknown, so the form stays locked");
  } finally { restoreTimers(); }
});

testAsync("the poll recovers once the server answers again", async () => {
  const timers = stubTimers();
  const restoreRows = installRowButtons();
  try {
    syncScanState([{ scan_state: "running" }]);
    sandbox.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    await loadSkills();
    await flush();
    sandbox.fetch = () => okJson([{ id: 1, scan_state: "done" }]);
    timers.at(-1).fn();
    await flush(); await flush();
    assert.equal(scanBtn.textContent, "Scan");
    assert.equal(scanBtn.disabled, false);
  } finally { restoreRows(); restoreTimers(); }
});

testAsync("switching to Archived mid-scan keeps the scan polled", async () => {
  const timers = stubTimers();
  const urls = [];
  try {
    sandbox.fetch = (url) => {
      urls.push(url);
      return okJson(/archived=true/.test(url) ? [] : [{ id: 1, scan_state: "running" }]);
    };
    syncScanState([{ scan_state: "running" }]);
    setTab(true);
    await flush(); await flush();
    const before = timers.length;
    timers.at(-1).fn();
    await flush(); await flush();
    assert.ok(urls.some((u) => /archived=false/.test(u)), "the current log was never asked");
    assert.ok(timers.length > before, "polling stopped on the Archived tab");
    assert.equal(skillRows.children.length, 0, "the archived list must not be overwritten");
  } finally {
    sandbox.fetch = () => okJson([]);
    setTab(false);
    await flush(); await flush();
    restoreTimers();
  }
});

// --- B-09: the detail page knows a re-scan is running -----------------------
const detailError = sandbox.document.getElementById("detail-error");
const detailView = sandbox.document.getElementById("detail-view");
const detailText = () => detailError.children.map((c) => c.textContent).join("\n");

test("an open detail page says a re-scan is in progress, and from when the results are", () => {
  renderDetail({ id: 9, name: "x", source: "/tmp/x", status: "pending", archived: false,
                 scan_state: "running", report: {}, report_scanned: 1760000000 });
  assert.equal(detailError.hidden, false);
  assert.ok(detailError.classList.contains("detail-error--warn"));
  assert.match(detailText(), /Re-scan in progress/);
  assert.match(detailText(), /previous scan, on /);
});

test("a first scan still running says results will appear here", () => {
  renderDetail({ id: 9, name: "x", source: "/tmp/x", status: "pending", archived: false,
                 scan_state: "running", report: null });
  assert.match(detailText(), /Scan in progress/);
});

testAsync("the open detail page re-renders when its row's scan lands", async () => {
  const timers = stubTimers();
  const restoreRows = installRowButtons();
  try {
    sandbox.fetch = (url) => okJson(/\/skills\/9$/.test(url)
      ? { id: 9, name: "x", source: "/tmp/x", status: "pending", archived: false,
          scan_state: "running", report: {}, report_scanned: 1 }
      : [{ id: 9, scan_state: "running" }]);
    await sandbox.openDetail(9);
    assert.match(detailText(), /Re-scan in progress/);
    syncScanState([{ id: 9, scan_state: "running" }]);
    sandbox.fetch = (url) => okJson(/\/skills\/9$/.test(url)
      ? { id: 9, name: "x", source: "/tmp/x", status: "pending", archived: false,
          scan_state: "done", report: {} }
      : [{ id: 9, scan_state: "done" }]);
    timers.at(-1).fn();
    await flush(); await flush(); await flush();
    assert.doesNotMatch(detailText(), /in progress/);
  } finally {
    detailView.hidden = true;
    restoreRows();
    restoreTimers();
  }
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
  zipLink:
    "skillspector produced no output (exit code 2). stderr: Error: Zip links " +
    "are not supported",
  zipEncrypted: "skillspector produced no output (exit code 2). stderr: Error: Encrypted zip entries are not supported",
  zipSpecial: "skillspector produced no output (exit code 2). stderr: Error: Zip special-file entries are not supported",
  zipInconsistent: "skillspector produced no output (exit code 2). stderr: Error: Zip entry type is inconsistent",
  zipSlip: "skillspector produced no output (exit code 2). stderr: Error: Zip entry would escape extraction directory (zip-slip)",
  zipSlipPath: "skillspector produced no output (exit code 2). stderr: Error: Zip entry has an unsafe or ambiguous path (zip-slip)",
  zipDuplicate: "skillspector produced no output (exit code 2). stderr: Error: Zip contains duplicate extraction paths",
  zipConflict: "skillspector produced no output (exit code 2). stderr: Error: Zip file entry conflicts with a directory",
  zipTruncated: "skillspector produced no output (exit code 2). stderr: Error: Zip member size did not match its declaration",
  zipCap:
    "skillspector produced no output (exit code 2). stderr: Error: Zip exceeded ingest cap: 90000 " +
    "members > INGEST_MAX_ZIP_MEMBERS (50000)",
  gitCap:
    "skillspector produced no output (exit code 2). stderr: Error: Git clone exceeded ingest entry " +
    "cap: > INGEST_MAX_TREE_ENTRIES (200000)",
  ingestTime: "skillspector produced no output (exit code 2). stderr: Error: Zip ingest exceeded its time limit",
  // Kept wrapped exactly as the CLI emitted it: the break lands inside the
  // path, one character after the phrase being matched.
  linkedInput:
    "skillspector produced no output (exit code 2). stderr: Error: Refusing " +
    "to resolve a symlinked input: \n/private/tmp/claude-501/-Users-dnaiuxd-" +
    "Projects-skillio/406e0b2c-8225-46eb-b2d6-\n1edd28e3e304/scratchpad/" +
    "linktest/linked",
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

test("a symlink in a zip sends you to the source, not back to the zip", () => {
  // Verified against the real failure: one `AGENTS.md -> CLAUDE.md` entry in
  // an 815-entry archive, and SkillSpector reads none of it. The same tree
  // scanned as a directory reports normally, so the answer has to name the
  // other route rather than suggest re-downloading the same archive.
  const { lead, hint } = friendlyError(RAW.zipLink);
  assert.match(lead, /symbolic link/);
  assert.match(hint, /GitHub/);
  // The neighbouring zip rule says "download it again", which here would
  // hand back a byte-identical archive that fails byte-identically.
  assert.equal(/download it again/i.test(hint), false);
});

test("the ingest time limit is not read as the ingest size cap", () => {
  // "Zip ingest exceeded its time limit" and "Zip exceeded ingest cap" are
  // one word order apart. Matching the wrong one sends you to a subfolder
  // for a size problem you don't have.
  assert.match(friendlyError(RAW.ingestTime).lead, /ran out of time/);
  assert.match(friendlyError(RAW.zipCap).lead, /bigger than/);
  assert.match(friendlyError(RAW.gitCap).lead, /bigger than/);
});

test("the ingest cap does not send anyone to GitHub", () => {
  // INGEST_MAX_BYTES applies to a clone exactly as it does to a zip, so the
  // advice that works for every other zip failure is wrong for this one.
  for (const raw of [RAW.zipCap, RAW.gitCap]) {
    const { hint } = friendlyError(raw);
    assert.match(hint, /subfolder/);
    assert.match(hint, /same caps apply to a clone/);
  }
});

test("an escaping entry is called out as deliberate, not as a mishap", () => {
  // Every other zip rule describes an inconvenience. This one describes an
  // archive built to write somewhere it shouldn't, and has to read that way.
  for (const raw of [RAW.zipSlip, RAW.zipSlipPath]) {
    const { lead, hint } = friendlyError(raw);
    assert.match(lead, /outside the folder/);
    assert.match(hint, /zip-slip/);
    assert.match(hint, /where the file came from/);
  }
});

test("every zip rejection keeps its own answer apart from its neighbours", () => {
  // These strings differ by a word or two and the regexes are alternations,
  // so a careless one swallows its neighbour and both render the same.
  // One representative per rule. Entries that share a rule on purpose are
  // asserted below instead — grouping is the point, collision is the bug.
  const keys = [
    "zip", "zipLink", "zipEncrypted", "zipSpecial", "zipSlip",
    "zipDuplicate", "zipTruncated", "zipCap", "ingestTime", "linkedInput",
  ];
  const leads = keys.map((k) => friendlyError(RAW[k]).lead);
  assert.equal(new Set(leads).size, keys.length, `two rules collided: ${leads}`);
});

test("rejections with the same answer are deliberately given the same words", () => {
  // A special-file entry and a self-contradicting one are the same problem
  // to the reader and have the same way out, so they share a rule. Split
  // them only if the advice ever diverges.
  const same = (a, b) =>
    assert.equal(friendlyError(RAW[a]).lead, friendlyError(RAW[b]).lead);
  same("zipSpecial", "zipInconsistent");
  same("zipSlip", "zipSlipPath");
  same("zipDuplicate", "zipConflict");
  same("zipCap", "gitCap");
});

test("a timeout is reported in minutes, not in seconds", () => {
  assert.match(friendlyError("Scan timed out after 3600s").lead, /60-minute/);
  assert.match(friendlyError("Scan timed out after 600s").lead, /10-minute/);
  // Never "0-minute": a sub-minute limit still reads as a limit.
  assert.match(friendlyError("Scan timed out after 20s").lead, /1-minute/);
});

test("a source link is exactly the source", () => {
  // This text gets copied back into the scan box; a trailing "↗" once made
  // git clone "….git ↗". The arrow is drawn beside the link, not in it.
  const box = sandbox.document.getElementById("detail-source");
  renderDetailSource("https://github.com/a/strix.git");
  assert.equal(box.textContent, "https://github.com/a/strix.git");
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  assert.doesNotMatch(css, /\n\.detail-source a::(?:before|after)/);
  assert.match(css, /\n\.detail-source:has\(> a\)::after \{[^}]*content: " ↗" \/ "";/);
});

test("a timeout doesn't blame the network", () => {
  // A timed-out strix scan was pure CPU with no sockets open; pointing at
  // the network sent the diagnosis the wrong way.
  const { hint } = friendlyError("Scan timed out after 900s");
  assert.doesNotMatch(hint, /network/i);
  assert.match(hint, /folder/);
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

// --- B-19: a failed gate or archive call stays on the page and says so -----
// These used to bail back to the log: nothing saved, nothing said.
function failingFetch() {
  return Promise.reject(new TypeError("Failed to fetch"));
}
async function pressAndFail(call) {
  const box = sandbox.document.getElementById("detail-error");
  const detail = sandbox.document.getElementById("detail-view");
  vm.runInContext("currentSkillId = 7", sandbox);
  detail.hidden = false;
  resetDetailError();
  box.hidden = true;
  const real = sandbox.fetch;
  sandbox.fetch = failingFetch;
  try {
    await call();
  } finally {
    sandbox.fetch = real;
  }
  assert.equal(detail.hidden, false, "dropped back to the log");
  assert.equal(box.hidden, false, "the failure box stayed hidden");
  assert.equal(vm.runInContext("currentSkillId", sandbox), 7, "forgot which record this is");
  assert.equal(focused, box, "focus did not move to the message");
  return box.textContent;
}

testAsync("a decision that didn't save says so and stays put", async () => {
  const t = await pressAndFail(() => sandbox.setGateStatus("approved"));
  assert.match(t, /Could not save that decision/);
  assert.match(t, /Nothing was changed/);
});

testAsync("a reset that failed says so and stays put", async () => {
  const t = await pressAndFail(() => sandbox.onGateReset());
  assert.match(t, /Could not reset this decision/);
});

testAsync("an archive that failed says so and stays put", async () => {
  const t = await pressAndFail(() => sandbox.setArchived(true));
  assert.match(t, /Could not archive this record/);
});

testAsync("a restore that failed says so and stays put", async () => {
  const t = await pressAndFail(() => sandbox.setArchived(false));
  assert.match(t, /Could not restore this record to the log/);
});

test("the action failure reuses the box's own look, not a new one", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const fn = src.slice(src.indexOf("function showActionError"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /resetDetailError\(\)/);
  assert.equal(/classList\.add/.test(body), false, "a new modifier class crept in");
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
  // The version reaches the accessible name, which attachTip also prints as
  // the tooltip. The tag is a button now, so there is no href carrying it.
  assert.equal(tag.getAttribute("aria-label"), "v1.8.0 available — how to update");

  // ...and the release notes are still one click away, now inside the dialog
  // beside the command rather than replacing the page you are reading.
  const dialog = sandbox.document.getElementById("update-dialog");
  let opened = false;
  dialog.showModal = () => { opened = true; };
  tag.fire("click");
  assert.equal(opened, true, "the tag no longer opens the steps");
  assert.equal(
    sandbox.document.getElementById("update-dialog-link").href,
    "https://example.invalid"
  );
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

test("the update tag opens the steps rather than navigating", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  // A link would navigate away from a page whose whole job right now is to
  // tell you what to type. Anchored to the tag itself, not to any <button>.
  assert.match(html, /<button[^>]*id="skillio-update"/);
  assert.equal(/<a[^>]*id="skillio-update"/.test(html), false,
    "back to a link, which navigates instead of opening the steps");
  // Wrapped rather than passed directly — see the MouseEvent note below.
  assert.match(appSource, /els\.skillioUpdate\.addEventListener\("click", \(\) => openUpdateDialog\(\)\)/);
  assert.match(appSource, /els\.updateDialog\.showModal\(\)/);
});

test("the update steps are copyable and name the checkout that answered", () => {
  // The command lives in the dialog, NOT the tooltip: a tooltip is gone the
  // moment the pointer moves toward it, so nothing in one can be copied.
  assert.match(appSource, /cd \$\{repoPath\} && \$\{update\}/);
  // From /api/health, never the ~/Skillio the docs name — a second checkout
  // updating the everyday install is a command that changes nothing visible.
  assert.match(appSource, /setUpdateCommand\(data\.repo_path\)/);
  assert.equal(/cd ~\/Skillio/.test(appSource), false,
    "hardcoded install path — wrong for every second checkout");
  // A server too old to report a path still gets a usable command. This is
  // every install between the pull and the restart: uvicorn serves this file
  // from disk while app.py stays as loaded, so the frontend runs ahead of the
  // backend, and that is exactly when this dialog gets opened. It shipped
  // showing an empty box.
  assert.match(appSource, /repoPath \? .* : update/);
  assert.equal(/if \(data\.repo_path\)/.test(appSource), false,
    "guarded again, which leaves the command empty against an older server");
});

test("the banner's button says what it does, and copies without rebuilding it", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  // "Update" promised something Skillio does not do — it copies a command
  // you then run yourself.
  assert.match(html, /<button[^>]*id="skillio-banner-copy"[^>]*>Copy command<\/button>/);
  // Read back out of the dialog. A second copy of the command here would
  // drift from that one the moment either changed, and both would claim to
  // be the thing you should run.
  const fn = appSource.slice(appSource.indexOf("async function copyUpdateCommand"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /els\.updateDialogCommand\.textContent/);
  assert.equal(/git pull &&/.test(body), false, "the command is built twice");
});

test("the dialog opens whether or not the clipboard obliged", () => {
  const fn = appSource.slice(appSource.indexOf("async function copyUpdateCommand"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  // One exit, two sentences. A refused clipboard is not a failure path: the
  // same command is on screen either way, and the line above it says which
  // of the two happened rather than leaving a silent no-op.
  assert.equal((body.match(/openUpdateDialog\(/g) || []).length, 1,
    "more than one way out — the refused case has drifted from the copied one");
  assert.match(body, /copied\s*\n?\s*\?/);
  assert.match(body, /catch/);
});

test("the tag opens the dialog without claiming anything was copied", () => {
  // openUpdateDialog takes the clipboard line as its first argument, so
  // handing the listener straight to it put a MouseEvent in that sentence.
  assert.match(appSource, /addEventListener\("click", \(\) => openUpdateDialog\(\)\)/);
  const fn = appSource.slice(appSource.indexOf("function openUpdateDialog"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /note = ""/);
  // Written and hidden together, so a second open cannot inherit the first's
  // sentence.
  assert.match(body, /updateDialogCopied\.textContent = note/);
  assert.match(body, /updateDialogCopied\.hidden = !note/);
});

test("the copied line is not the grey it is trying not to be", () => {
  // .info-dialog p is (0,1,1) and sets colour. Bare, at (0,1,0), this lost to
  // it and rendered in --ink-soft — measured rgb(92,85,75) — which is exactly
  // the tie the old handover states lost.
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  assert.match(css, /\n\.info-dialog \.update-copied \{/);
  assert.equal(/\n\.update-copied \{/.test(css), false,
    "unscoped again, so .info-dialog p wins and the confirmation renders grey");
  const rule = css.match(/\n\.info-dialog \.update-copied \{([^}]*)\}/)[1];
  assert.match(rule, /color: var\(--ok\)/);
  assert.equal(/#[0-9a-f]{3,6}/i.test(rule), false, "hardcoded colour");
});

test("only the log scrolls on desktop, and nothing guesses the topbar's height", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");

  // The rail used to carry min-height: calc(100vh - 78px) as a stand-in for
  // "the viewport below the topbar". The topbar measures 81px, so every
  // window — at any size — was 3px too tall and showed a scrollbar for them.
  const rail = css.match(/\n\.scan-sidebar \{([^}]*)\}/);
  assert.ok(rail, "no .scan-sidebar rule");
  assert.equal(/min-height:\s*calc\(100vh/.test(rail[1]), false,
    "back to subtracting a hardcoded topbar height from 100vh");

  // min-height: 0 is what lets the shell's children shrink and scroll
  // themselves instead of pushing the page taller.
  const shell = css.match(/@media \(min-width: 1025px\) \{([\s\S]*?)\n\}/);
  assert.ok(shell, "no desktop shell query");
  assert.match(shell[1], /\.app \{[^}]*min-height: 0/);
  assert.match(shell[1], /main \{[^}]*overflow-y: auto/);
  assert.match(shell[1], /body \{[^}]*overflow: hidden/);

  // One scrollbar in the app, and it is the log's. The rail still scrolls on
  // a window too short for the form — clipping it instead would put the Scan
  // button out of reach — it just does not draw a bar for it.
  assert.match(shell[1], /\.scan-sidebar \{[^}]*scrollbar-width: none/);
  assert.match(shell[1], /\.scan-sidebar::-webkit-scrollbar \{[^}]*display: none/);
  assert.match(shell[1], /\.scan-sidebar \{[^}]*overflow-y: auto/,
    "the rail was clipped rather than silently scrollable — Scan becomes unreachable");

  // Declared below the base rules it overrides: `.scan-sidebar` is (0,1,0) in
  // both places, so source order is the only thing separating them.
  assert.ok(css.indexOf("\n.scan-sidebar {") < css.indexOf("@media (min-width: 1025px)"),
    "the desktop shell sits above the rules it overrides, so it loses the tie");

  // 1025 and 1024 leave no width where both apply, and none where neither
  // does — an overlap would page-scroll and pane-scroll at the same time.
  assert.match(css, /@media \(max-width: 1024px\)/);
});

test("the footer sits on the bottom edge when the content is short", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  const tablet = css.match(/@media \(max-width: 1024px\) \{([\s\S]*?)\n\}/);
  assert.ok(tablet, "no tablet query");

  // The page still scrolls in this layout, so the shell cannot own the
  // viewport the way it does on desktop. Without a column at least a screen
  // tall, the credit line landed wherever the content stopped — measured at
  // 992x1500 with 526px of empty window below it.
  assert.match(tablet[1], /body \{[^}]*flex-direction: column/);
  assert.match(tablet[1], /body \{[^}]*min-height: 100vh/);
  assert.match(tablet[1], /\.app \{[^}]*flex: 1/);

  // dvh AFTER vh, or the fallback wins on the browsers that support both and
  // a phone puts the footer below the fold behind the URL bar.
  const body = tablet[1].match(/body \{([^}]*)\}/)[1];
  const vh = body.indexOf("min-height: 100vh");
  const dvh = body.indexOf("min-height: 100dvh");
  assert.ok(dvh !== -1, "no dvh unit — 100vh alone is wrong on a phone");
  assert.ok(vh < dvh, "dvh is declared above vh, so the fallback overrides it");
});

test("the update dialog's two buttons are the same size", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  // .info-dialog-close carries a 10px top margin, for a Close standing alone
  // under the prose. In an actions row the row supplies that spacing already,
  // and the margin made this button 10px shorter than the link beside it —
  // the flex row stretches its items, so a margin comes straight off the box.
  const button = html.match(/<button[^>]*id="update-dialog-close"[^>]*>/)[0];
  assert.equal(/info-dialog-close/.test(button), false,
    "the stray margin is back, and the two buttons differ by exactly it");
  // Anchored to the declaration, not the prose above it.
  assert.match(css, /\n\.info-dialog-close \{\s*\n\s*margin-top: 10px;/);
  // A link in that row still arrives underlined and .info-dialog-a coloured.
  const reset = css.match(/\n\.info-dialog-actions \.btn \{([^}]*)\}/);
  assert.ok(reset, "no reset for an <a class=btn> in the actions row");
  assert.match(reset[1], /text-decoration: none/);
  assert.match(reset[1], /color: var\(--ink\)/);
  // Not a hardcoded height: the row stretches them, so pinning one would
  // just be a second number to keep in step with .btn's padding.
  assert.equal(/height:/.test(reset[1]), false, "height pinned by hand");
});

test("the update tag's tooltip is dismissible, and stays that way", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  const reveal = css.indexOf(".update-tag:hover .info-tip");
  const dismiss = css.indexOf(":root.tips-off .info-tip");
  assert.ok(reveal !== -1, "the update tag never reveals its tip");
  assert.ok(dismiss !== -1, "no .tips-off rule");
  // Both selectors are (0,2,0), so ONLY source order separates them. Below
  // the dismiss rule this tip would ignore Esc while the icon tips obeyed it.
  assert.ok(reveal < dismiss,
    "the reveal rule sank below .tips-off, so Esc stops dismissing this tip");
  // The accessible name carries the visible words (WCAG 2.5.3) and is what
  // attachTip prints, so the tip cannot drift from the label.
  assert.match(appSource, /\$\{versionOf\(d\.latest\)\} available — how to update/);
  assert.match(appSource, /attachTip\(els\.skillioUpdate\)/);
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

// --- B-17: Current / Archived are a real ARIA tab set ----------------------
test("both tabs control one tabpanel, and only the selected one is tabbable", () => {
  const cur = html.match(/<button[^>]*id="tab-current"[^>]*>/)[0];
  const arc = html.match(/<button[^>]*id="tab-archived"[^>]*>/)[0];
  for (const t of [cur, arc]) assert.match(t, /aria-controls="log-panel"/);
  assert.match(html, /<div[^>]*id="log-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-current"/);
  assert.equal(/tabindex/.test(cur), false, "the selected tab left the tab order");
  assert.match(arc, /tabindex="-1"/);
  // The panel wraps everything the tabs switch between.
  const panel = html.slice(html.indexOf('id="log-panel"'), html.indexOf('id="detail-view"'));
  for (const id of ["log-summary", "skill-rows", "empty-state"]) assert.match(panel, new RegExp(`id="${id}"`));
});

test("setTab moves the roving tabindex and the panel's label with the selection", () => {
  const cur = sandbox.document.getElementById("tab-current");
  const arc = sandbox.document.getElementById("tab-archived");
  const panel = sandbox.document.getElementById("log-panel");
  sandbox.setTab(true);
  assert.equal(arc.getAttribute("aria-selected"), "true");
  assert.equal(arc.getAttribute("tabindex"), "0");
  assert.equal(cur.getAttribute("tabindex"), "-1");
  assert.equal(panel.getAttribute("aria-labelledby"), "tab-archived");
  sandbox.setTab(false);
  assert.equal(cur.getAttribute("tabindex"), "0");
  assert.equal(arc.getAttribute("tabindex"), "-1");
  assert.equal(panel.getAttribute("aria-labelledby"), "tab-current");
});

test("arrow keys, Home and End switch tabs and take focus along", () => {
  const cur = sandbox.document.getElementById("tab-current");
  const arc = sandbox.document.getElementById("tab-archived");
  const press = (node, key) => node.fire("keydown", { key, preventDefault() {} });
  sandbox.setTab(false);
  press(cur, "ArrowRight");
  assert.equal(focused, arc);
  assert.equal(arc.getAttribute("aria-selected"), "true");
  press(arc, "ArrowLeft");
  assert.equal(focused, cur);
  assert.equal(cur.getAttribute("aria-selected"), "true");
  press(cur, "End");
  assert.equal(focused, arc);
  press(arc, "Home");
  assert.equal(focused, cur);
  assert.equal(cur.getAttribute("aria-selected"), "true");
});

// --- B-18 / B-14: words that name real places and real times ---------------
test("restore names the log, which is a place that exists", () => {
  assert.match(html, /<button id="restore-btn"[^>]*>Restore to log<\/button>/);
  assert.equal(/Scanned Skill/.test(html), false);
});

test("static mode's time is honest about a whole repo", () => {
  const info = html.slice(html.indexOf('id="llm-info"'), html.indexOf("</div>", html.indexOf('id="llm-info"')));
  assert.match(info.replace(/\s+/g, " "), /Seconds for one skill; a whole repo can take several minutes\./);
  assert.equal(/Takes\s+seconds/.test(info), false);
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


test("the dialog's buttons are not flush against the note below them", () => {
  // `.info-dialog p` carries a bottom margin and no top one, so an
  // actions row with only margin-top left a measured 0px gap.
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  const rule = css.slice(css.indexOf(".info-dialog-actions {"));
  assert.match(rule.slice(0, rule.indexOf("}")), /margin:\s*18px 0/);
});


// Both payloads below are real: the same repository, the same machine, the
// same SKILLSPECTOR_PROVIDER, scanned minutes apart.
const SCAN_ALL_CALLS_FAILED = {
  llm_requested: true, llm_available: false,
  llm_calls_attempted: 4, llm_calls_succeeded: 0, llm_degraded: true,
};
const SCAN_ONE_CALL_WORKED = {
  llm_requested: true, llm_available: true,
  llm_calls_attempted: 4, llm_calls_succeeded: 1, llm_degraded: true,
};

test("a configured provider is never reported as missing", () => {
  // The bug: llm_available is "at least one call came back usable", and this
  // was read as "a provider is configured". It sent people to change a
  // setting that was already correct.
  const n = llmNotice(SCAN_ALL_CALLS_FAILED);
  assert.ok(n, "expected a notice");
  const whole = n.text + " " + (n.note || "");
  assert.ok(!/SKILLSPECTOR_PROVIDER/.test(whole),
    "told the user to set a provider that was already set");
  assert.match(n.text, /provider is set/);
  assert.match(n.note, /Rescanning usually works/i);
});

test("a sentence carries on in lower case after its semicolon", () => {
  const n = llmNotice(SCAN_ALL_CALLS_FAILED);
  assert.equal(n.note, "Nothing is misconfigured; rescanning usually works.");
  assert.ok(n.note.includes(n.action), "the underlined word no longer matches");
});

test("only a scan that attempted nothing blames the provider", () => {
  const n = llmNotice({ llm_requested: true, llm_available: false,
                        llm_calls_attempted: 0, llm_calls_succeeded: 0 });
  assert.match(n.text, /SKILLSPECTOR_PROVIDER/);
  // claude_cli needs no API key, so the key is conditional.
  assert.match(n.text, /if your\s+provider needs one/);
  // Nothing to act on beyond the setting itself.
  assert.equal(n.note, undefined);
});

test("the same setup does not get two different diagnoses", () => {
  // 0-of-4 and 1-of-4 differ only in luck. Neither may claim a config fault.
  for (const meta of [SCAN_ALL_CALLS_FAILED, SCAN_ONE_CALL_WORKED]) {
    const n = llmNotice(meta) || {};
    assert.ok(!/SKILLSPECTOR_PROVIDER/.test((n.text || "") + (n.note || "")));
  }
});

test("a partly degraded scan says how much it lost", () => {
  const n = llmNotice(SCAN_ONE_CALL_WORKED);
  assert.match(n.text, /3 of 4 calls/);
  assert.match(n.text, /static analysis alone/);
  assert.match(n.note, /Rescanning usually recovers them/);
});

test("the word to underline is actually present in the note", () => {
  // appendNote falls back to plain text when it cannot find the action, so a
  // drifting word would silently lose its underline rather than fail.
  for (const meta of [SCAN_ALL_CALLS_FAILED, SCAN_ONE_CALL_WORKED]) {
    const n = llmNotice(meta);
    assert.ok(n.note.includes(n.action),
      `action ${JSON.stringify(n.action)} missing from ${JSON.stringify(n.note)}`);
  }
});

test("a clean LLM scan says nothing, and neither does an unasked one", () => {
  assert.equal(llmNotice({ llm_requested: true, llm_available: true,
                           llm_calls_attempted: 4, llm_calls_succeeded: 4 }), null);
  assert.equal(llmNotice({ llm_requested: false }), null);
  assert.equal(llmNotice(null), null);
});

test("reports predating the call counts still get the old diagnosis", () => {
  // SkillSpector did not always emit these; guessing would be worse.
  assert.match(llmNotice({ llm_requested: true, llm_available: false }).text,
               /SKILLSPECTOR_PROVIDER/);
  assert.equal(llmNotice({ llm_requested: true, llm_available: true }), null);
});

test("one failed call is not pluralised", () => {
  const n = llmNotice({ llm_requested: true, llm_available: false,
                        llm_calls_attempted: 1, llm_calls_succeeded: 0 });
  assert.match(n.text, /all 1 call came back/);
});

test("the note is bold, on its own line, with one word underlined", () => {
  // textContent cannot carry emphasis, so the notice is built from elements.
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  const note = css.slice(css.indexOf(".detail-error-note {"));
  assert.match(note.slice(0, note.indexOf("}")), /display:\s*block/);
  assert.match(note.slice(0, note.indexOf("}")), /font-weight:\s*[67]00/);
  const action = css.slice(css.indexOf(".detail-error-note-action {"));
  assert.match(action.slice(0, action.indexOf("}")), /text-decoration:\s*underline/);
});

test("notices are no longer flattened into one string", () => {
  // The join() it replaced could not hold a <strong> or a <span>.
  assert.ok(!/notices\.join/.test(appSource),
    "notices are still joined into textContent, which drops the emphasis");
  assert.match(appSource, /function renderNotices/);
});

test("the container keeps pre-wrap, which coverageNotice depends on", () => {
  // coverageNotice puts real newlines inside its own text.
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  const rule = css.slice(css.indexOf(".detail-error {"));
  assert.match(rule.slice(0, rule.indexOf("}")), /white-space:\s*pre-wrap/);
});

// --- must review vs. notes -------------------------------------------------
test("the triage summary counts both groups", () => {
  const t = triageSummary({ rule: 1, must_review: 2, notes: 11 });
  assert.equal(t.mustText, "2 must review");
  assert.equal(t.notesText, "11 notes");
  assert.equal(t.must, 2);
});

test("one note is singular, and zero must-review still says so", () => {
  // "0 must review" is the answer people look for; hiding it would leave
  // them wondering whether the rule ran at all.
  const t = triageSummary({ rule: 1, must_review: 0, notes: 1 });
  assert.equal(t.mustText, "0 must review");
  assert.equal(t.notesText, "1 note");
});

test("a partial count says it covers only the findings shown", () => {
  const t = triageSummary({ rule: 1, must_review: 0, notes: 1000, partial: true });
  assert.match(t.notesText, /counted over the findings shown$/);
});

test("no count means no summary, rather than a made-up zero", () => {
  assert.equal(triageSummary(undefined), null);
  assert.equal(triageSummary({}), null);
});

test("must-review findings sort ahead of notes", () => {
  assert.ok(triageRank({ skillio_triage: "must_review" }) < triageRank({ skillio_triage: "note" }));
  assert.equal(triageRank({}), triageRank({ skillio_triage: "note" }));
});

test("the tag is words, not only colour", () => {
  assert.match(appSource, /<span class="triage-tag">Must review<\/span>/);
});

test("the triage colour rule is declared, not just mentioned", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  assert.match(css, /^\.triage-must--some \{\n  color: var\(--critical\);\n\}/m);
});

// --- B-11: the gate buttons' hover keeps AA in both themes ----------------
test("the gate hover is a measured token, not a brightness filter", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  assert.equal(/^\s*filter:\s*brightness/m.test(css), false,
    "brightness() darkens dark-theme red to 4.23:1 under --surface text");
  assert.match(css, /^\s*--critical-hover:\s*color-mix\(in srgb, var\(--critical\) \d+%, var\(--ink\)\);/m);
  assert.match(css, /^\s*--ok-hover:\s*color-mix\(in srgb, var\(--ok\) \d+%, var\(--ink\)\);/m);
  for (const [status, token] of [["rejected", "critical"], ["approved", "ok"]]) {
    const m = css.match(new RegExp(`\\n\\.gate-btn\\[data-status="${status}"\\]:not\\(:disabled\\):hover \\{([^}]*)\\}`));
    assert.ok(m, `no hover rule for ${status}`);
    assert.match(m[1], new RegExp(`background: var\\(--${token}-hover\\)`));
    assert.match(m[1], new RegExp(`border-color: var\\(--${token}-hover\\)`));
  }
});

// --- scan duration ----------------------------------------------------------
// Under the date in the log, so a slow scan shows up without opening it.
test("durations read as minutes and seconds", () => {
  assert.equal(fmtDuration(42.4), "42s");
  assert.equal(fmtDuration(0.3), "<1s");
  assert.equal(fmtDuration(242), "4m 02s");
  assert.equal(fmtDuration(900.4), "15m 00s");
  assert.equal(fmtDuration(3725), "1h 02m");
});

test("a finished scan says how long it took", () => {
  const html = durationLine({ scan_state: "done", scan_seconds: 242 });
  assert.match(html, /class="scan-duration"/);
  assert.match(html, /took 4m 02s/);
});

test("a scan from before timing shows a dash a screen reader can explain", () => {
  const html = durationLine({ scan_state: "done", scan_seconds: null });
  assert.match(html, /—/);
  assert.match(html, /class="visually-hidden">duration not recorded/);
});

test("a running scan shows no duration rather than the last one", () => {
  assert.equal(durationLine({ scan_state: "running", scan_seconds: null }), "");
});

test("the duration line is styled as secondary text", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  assert.match(css, /^\.scan-duration \{\n  display: block;\n  font-family: var\(--mono\);\n  font-size: var\(--text-xs\);\n  color: var\(--ink-soft\);/m);
});

// --- files chip -------------------------------------------------------------
test("an incomplete read says how many files were fully read", () => {
  const c = filesChip({ total_components: 537, fully_inspected_files: 204 });
  assert.equal(c.text, "204 of 537 files fully read");
  assert.equal(c.partial, true);
});

test("a complete read keeps the plain count", () => {
  const c = filesChip({ total_components: 11, fully_inspected_files: 11 });
  assert.equal(c.text, "11 files scanned");
  assert.equal(c.partial, false);
  assert.equal(filesChip({ total_components: 1 }).text, "1 file scanned");
});

test("no completeness data means no files chip", () => {
  assert.equal(filesChip(null), null);
  assert.equal(filesChip({ total_components: 0 }), null);
});

// --- B-13: the files panel badge counts findings, then names the worst ----
test("a file's badge reads as N findings, worst severity", () => {
  const list = sandbox.document.getElementById("files-panel-list");
  sandbox.renderFilesPanel({
    components: [{ path: "a.py" }, { path: "b.py" }, { path: "c.py" }],
    issues: [
      { location: { file: "a.py" }, severity: "HIGH" },
      { location: { file: "a.py" }, severity: "low" },
      { location: { file: "a.py" }, severity: "medium" },
      { location: { file: "b.py" }, severity: "medium" },
    ],
  });
  assert.match(list.innerHTML, />3 findings · worst high</);
  assert.match(list.innerHTML, />1 finding · worst medium</);
  assert.equal(/>\d+ (high|medium)</.test(list.innerHTML), false,
    "back to '3 high', which reads as three high findings");
});

test("the partial chip's dot is declared, not just mentioned", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  assert.match(css, /^\.scan-meta-chip\.scan-meta-chip--partial::before \{\n  background: var\(--medium\);\n\}/m);
});

// --- report ----------------------------------------------------------------
// --- second look -------------------------------------------------------------
const CAIDO_LOOK = {
  v: 1, kind: "local", lower: true,
  headline: "Probably harmless: talks to a program on your own computer",
  takes: "a setting called `STRIX_CAIDO_URL`. It's an address, not a password or key.",
  sends_to: "`127.0.0.1:48080` by default, which means your own computer.",
  when: "when `_login_as_guest()` is called.",
  worth_knowing: "if someone changed that setting (`STRIX_CAIDO_URL`), it could point somewhere else.",
};

test("the second look answers the three questions in a list", () => {
  const html = secondLookHtml({ skillio_second_look: CAIDO_LOOK });
  assert.match(html, /<p class="second-look-headline">Probably harmless: talks to a program on your own computer<\/p>/);
  for (const k of ["Takes", "Sends to", "When", "Worth knowing"]) {
    assert.ok(html.includes(`<dt>${k}</dt>`), k);
  }
  assert.ok(html.includes("<code>STRIX_CAIDO_URL</code>"));
  assert.ok(html.includes("second-look--lowered"));
});

test("a look that didn't lower keeps the serious edge", () => {
  const html = secondLookHtml({ skillio_second_look: { ...CAIDO_LOOK, lower: false } });
  assert.ok(!html.includes("second-look--lowered"));
  // "yes" is not true: a stored report is data.
  assert.ok(!secondLookHtml({ skillio_second_look: { ...CAIDO_LOOK, lower: "yes" } })
    .includes("second-look--lowered"));
});

test("couldn't check shows its reason instead of the questions", () => {
  const html = secondLookHtml({ skillio_second_look: {
    kind: "unchecked", lower: false, headline: "Couldn't check this one",
    detail: "Skillio couldn't get a copy of this file to read.",
  } });
  assert.ok(html.includes("Couldn't check this one"));
  assert.ok(html.includes('class="second-look-detail"'));
  assert.ok(!html.includes("<dl"));
});

test("no look, no card", () => {
  assert.equal(secondLookHtml({}), "");
  assert.equal(secondLookHtml({ skillio_second_look: "x" }), "");
});

test("code spans are escaped before they are wrapped", () => {
  assert.equal(codeSpans("a `<b>` c"), "a <code>&lt;b&gt;</code> c");
  assert.ok(!secondLookHtml({ skillio_second_look: { ...CAIDO_LOOK, headline: "<img src=x>" } })
    .includes("<img"));
});

test("the AI review is reported, and only for outcomes it knows", () => {
  assert.match(aiReviewLine({ evidence: { llm_review_outcome: "disagreed" } }), /disagreed with this alarm/);
  assert.match(aiReviewLine({ evidence: { llm_review_outcome: "agreed" } }), /agreed with this alarm/);
  assert.equal(aiReviewLine({ evidence: { llm_review_outcome: "weird" } }), null);
  assert.equal(aiReviewLine({}), null);
});

test("SkillSpector's alarm stays under the card", () => {
  const body = appSource.slice(appSource.indexOf("function renderFindings"));
  assert.ok(body.indexOf("${look}") < body.indexOf('class="finding-message"'));
});

test("the second-look edge colours are declared, not just mentioned", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  assert.match(css, /^\.second-look \{\n(?:  .*\n)*?  border-left: 3px solid var\(--critical\);/m);
  assert.match(css, /^\.second-look\.second-look--lowered \{\n  border-left-color: var\(--ok\);\n\}/m);
});

test("a finding's header row wraps and its long words break", () => {
  // A mono path or a rule name has no break opportunity of its own, and one
  // pushed the detail view to 765px on a 375px phone.
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  assert.match(css, /^\.finding-top \{\n(?:  .*\n)*?  flex-wrap: wrap;/m);
  for (const sel of ["finding-location", "finding-message", "finding-remediation"]) {
    assert.match(css, new RegExp(`^\\.${sel} \\{\\n(?:  .*\\n)*?  overflow-wrap: anywhere;`, "m"), sel);
  }
});

// --- B-01: a failed re-scan keeps the last result ---------------------------
test("a failed scan says so under the date", () => {
  assert.match(durationLine({ error: "x", scan_seconds: 900 }), /failed after 15m 00s/);
  assert.match(durationLine({ error: "x" }), />failed</);
  assert.match(durationLine({ scan_seconds: 900 }), /took 15m 00s/);
});

test("a failed re-scan says the results are from the last scan that worked", () => {
  const box = sandbox.document.getElementById("detail-error");
  const texts = () => box.children.map((c) => c.textContent);
  renderScanError("Scan timed out after 900s", 1760000000);
  assert.ok(texts().some((t) => /from the last scan that worked, on /.test(t)));
  renderScanError("Scan timed out after 900s", null);
  assert.ok(texts().includes("The results below are from the last scan that worked."));
  renderScanError("Scan timed out after 900s");
  assert.ok(!texts().some((t) => /last scan that worked/.test(t)));
});

// --- B-05/B-23/K-03: the log works from a summary ----------------------------
test("the band comes from the summary when the log has no report", () => {
  assert.equal(severityBand({ score: 10, summary: { severity: "CRITICAL" } }), "critical");
  assert.equal(severityBand({ score: 95, summary: null }), "critical");
});

test("the log says how many must be reviewed, and how much was read", () => {
  const html = reviewLine({ summary: { must_review: 3, coverage_percent: 38 } });
  assert.match(html, /<span class="triage-must--some">3 must review<\/span>/);
  assert.match(html, /38% fully read/);
});

test("a full read and nothing to review stay quiet", () => {
  const html = reviewLine({ summary: { must_review: 0, coverage_percent: 100 } });
  assert.match(html, /0 must review/);
  assert.ok(!html.includes("triage-must--some"));
  assert.ok(!html.includes("fully read"));
});

test("no summary, or a running scan, gets no review line", () => {
  assert.equal(reviewLine({ summary: null }), "");
  assert.equal(reviewLine({ scan_state: "running", summary: { must_review: 2 } }), "");
});

asyncChain.then(() => {
  for (const [name, err] of failures) {
    console.error(`  FAIL  ${name}\n        ${err.message.split("\n")[0]}`);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});

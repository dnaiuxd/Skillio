const API = "/api";

const els = {
  health: document.getElementById("health"),
  app: document.getElementById("app"),
  scanInput: document.getElementById("scan-input"),
  sourceType: document.getElementById("source-type"),
  scanOr: document.querySelector(".scan-or"),
  dropZone: document.getElementById("drop-zone"),
  fileInput: document.getElementById("file-input"),
  fileChip: document.getElementById("file-chip"),
  fileChipName: document.getElementById("file-chip-name"),
  fileClear: document.getElementById("file-clear"),
  scanBtn: document.getElementById("scan-btn"),
  scanStatus: document.getElementById("scan-status"),
  useLlm: document.getElementById("use-llm"),
  llmInfoBtn: document.getElementById("llm-info-btn"),
  llmInfo: document.getElementById("llm-info"),
  listView: document.getElementById("list-view"),
  detailView: document.getElementById("detail-view"),
  tabCurrent: document.getElementById("tab-current"),
  tabArchived: document.getElementById("tab-archived"),
  skillRows: document.getElementById("skill-rows"),
  logSummary: document.getElementById("log-summary"),
  emptyState: document.getElementById("empty-state"),
  backBtn: document.getElementById("back-btn"),
  archiveBtn: document.getElementById("archive-btn"),
  restoreBtn: document.getElementById("restore-btn"),
  deleteBtn: document.getElementById("delete-btn"),
  detailName: document.getElementById("detail-name"),
  detailSource: document.getElementById("detail-source"),
  scanMeta: document.getElementById("scan-meta"),
  detailScore: document.getElementById("detail-score"),
  detailVerdict: document.getElementById("detail-verdict"),
  scoreMeter: document.getElementById("score-meter"),
  scoreMeterMarker: document.querySelector("#score-meter .score-meter-marker"),
  detailError: document.getElementById("detail-error"),
  findingsList: document.getElementById("findings-list"),
  severityBreakdown: document.getElementById("severity-breakdown"),
  filesPanel: document.getElementById("files-panel"),
  filesPanelCount: document.getElementById("files-panel-count"),
  filesPanelList: document.getElementById("files-panel-list"),
  gateCurrent: document.getElementById("gate-current"),
  gateReset: document.getElementById("gate-reset"),
  gateApprove: document.querySelector('.gate-btn[data-status="approved"]'),
  gateReject: document.querySelector('.gate-btn[data-status="rejected"]'),
  themeBtn: document.getElementById("theme-btn"),
  themeColor: document.querySelector('meta[name="theme-color"]'),
};

// --- theme -----------------------------------------------------------------
// No stored value means "follow the OS", which is the default state — the
// media query in the stylesheet handles it and nothing is stamped on <html>.
// Clicking commits an explicit choice that then outranks the OS.
// Read the token rather than keeping a copy of it. An installed PWA paints
// its title bar with theme-color, so a hardcoded value that drifts from
// --topbar-bg splits the header into two colours — which is exactly what a
// stale #221d16 did after the palette moved to Primer.
function topbarColor() {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--topbar-bg")
    .trim();
  return v || "#fcf8f2";
}

function effectiveTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === "dark" || set === "light") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function syncThemeButton() {
  const dark = effectiveTheme() === "dark";
  // role="switch" reports state through aria-checked, so the label stays a
  // stable noun ("Dark theme") rather than flipping between two verbs.
  els.themeBtn.setAttribute("aria-checked", String(dark));
  // Keeps the browser chrome (and the installed app's title bar) in step.
  if (els.themeColor) els.themeColor.setAttribute("content", topbarColor());
}

function toggleTheme() {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("theme", next);
  } catch (e) {
    // Storage unavailable — the choice still applies for this page view.
  }
  syncThemeButton();
}

// SkillSpector defines exactly these four (_SEVERITY_POINTS / _SEVERITY_RANK
// in nodes/report.py). There is no INFO level — a fifth row here was always
// rendering a permanent zero.
const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

let currentSkillId = null;
let scanning = false;
let stagedFile = null;
let showingArchived = false;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Mirrors SkillSpector's _RISK_SEVERITY_BANDS — [(81, CRITICAL), (51, HIGH),
// (21, MEDIUM), (0, LOW)]. Only a fallback: a report states its own band and
// severityBand() prefers it. This exists for rows that have no report at all
// (a failed scan) or a shape we don't recognise.
function severityWord(score) {
  if (score == null) return null;
  if (score > 80) return "critical";
  if (score > 50) return "high";
  if (score > 20) return "medium";
  return "low";
}

// The band SkillSpector itself assigned. Reading it rather than re-deriving
// keeps one source of truth: if NVIDIA retunes the thresholds, we follow
// automatically instead of quietly disagreeing with the tool we're wrapping.
function severityBand(skill) {
  const ra = (skill && skill.report && skill.report.risk_assessment) || null;
  const stated = ra && typeof ra.severity === "string" ? ra.severity.toLowerCase() : "";
  if (SEVERITY_ORDER.includes(stated)) return stated;
  return severityWord(skill ? skill.score : null);
}

// CRITICAL and HIGH share the red treatment — both are DO_NOT_INSTALL, and
// inventing a fifth colour to split them would imply a distinction the gate
// doesn't make. The band still shows its real name in text.
function bandClass(band) {
  if (band === "critical" || band === "high") return "critical";
  if (band === "medium") return "medium";
  if (band === "low") return "ok";
  return "pending";
}

// The solid red treatment is reserved for the high-risk "do not install"
// call — either SkillSpector recommended it, or our score band is critical.
function isHighRisk(skill) {
  return (
    bandClass(severityBand(skill)) === "critical" ||
    /do[ _-]?not[ _-]?install/i.test((skill && skill.verdict) || "")
  );
}

function deriveName(source) {
  let s = source.replace(/\/+$/, "");
  s = s.replace(/\.(git|zip)$/i, "");
  const parts = s.split(/[/\\]/);
  return parts[parts.length - 1] || s;
}

// Recognise what kind of source the field currently holds, for the chip.
function detectSourceType(raw) {
  const v = (raw || "").trim();
  if (!v) return null;
  if (/\.zip$/i.test(v)) return { key: "zip", label: ".zip archive" };
  if (
    /^(https?:|git@|ssh:|git:)/i.test(v) ||
    /\.git$/i.test(v) ||
    /^(www\.)?(github|gitlab|bitbucket)\./i.test(v)
  ) {
    return { key: "git", label: "Git URL" };
  }
  if (/^(\/|~|\.\.?[/\\]|[a-zA-Z]:[/\\])/.test(v)) {
    return { key: "path", label: "Local path" };
  }
  return { key: "other", label: "Unrecognized source" };
}

function updateSourceType() {
  const t = detectSourceType(els.scanInput.value);
  // Only confirm a recognised type; stay quiet otherwise.
  if (!t || t.key === "other") {
    els.sourceType.hidden = true;
    return;
  }
  els.sourceType.textContent = t.label;
  els.sourceType.className = `source-type source-type--${t.key}`;
  els.sourceType.hidden = false;
}

// --- file upload staging: you scan either a typed source OR a dropped .zip ---
function stageFile(file) {
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) {
    els.fileInput.value = "";
    showScanStatus("Only .zip archives can be uploaded.", true);
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    els.fileInput.value = "";
    showScanStatus("That file is over the 100 MB limit.", true);
    return;
  }
  stagedFile = file;
  // reveal the role="status" chip before naming the file, so it announces
  els.fileChip.hidden = false;
  els.fileChipName.textContent = file.name;
  els.dropZone.hidden = true;
  els.scanOr.hidden = true;
  els.scanInput.value = "";
  els.scanInput.disabled = true;
  updateSourceType();
  hideScanStatus();
}

function clearStagedFile() {
  stagedFile = null;
  els.fileInput.value = "";
  els.fileChip.hidden = true;
  els.dropZone.hidden = false;
  els.scanOr.hidden = false;
  els.scanInput.disabled = false;
}

function showScanStatus(msg, isError = false) {
  els.scanStatus.classList.toggle("error", isError);
  // Reveal before writing: a role="status" region mutated while it is
  // display:none is usually never announced.
  els.scanStatus.hidden = false;
  els.scanStatus.textContent = msg;
}

function hideScanStatus() {
  els.scanStatus.hidden = true;
  els.scanStatus.classList.remove("error");
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

async function checkHealth() {
  try {
    const res = await fetch(`${API}/health`);
    const data = await res.json();
    if (data.skillspector_installed) {
      els.health.textContent = `NVIDIA skillspector ready — ${data.version || "installed"}`;
      els.health.className = "health ok";
    } else {
      els.health.innerHTML =
        "NVIDIA skillspector not found on PATH — " +
        '<a href="https://github.com/NVIDIA/skillspector" target="_blank" rel="noopener noreferrer">install it first ↗</a>';
      els.health.className = "health bad";
    }
  } catch (e) {
    els.health.textContent = "backend unreachable";
    els.health.className = "health bad";
  }
}

async function loadSkills() {
  try {
    const res = await fetch(`${API}/skills?archived=${showingArchived}`);
    renderSkillList(await res.json());
  } catch (e) {
    // Backend unreachable — checkHealth() already surfaces this in the topbar.
  }
}

function setTab(archived) {
  showingArchived = archived;
  els.tabCurrent.setAttribute("aria-selected", String(!archived));
  els.tabArchived.setAttribute("aria-selected", String(archived));
  loadSkills();
}

function renderLogSummary(skills) {
  const el = els.logSummary;
  if (!skills.length) {
    el.hidden = true;
    return;
  }
  const count = (status) => skills.filter((k) => k.status === status).length;
  const tiles = [
    ["scanned", skills.length],
    ["approved", count("approved")],
    ["not approved", count("rejected")],
    ["pending", count("pending")],
  ];
  el.innerHTML = tiles
    .map(
      ([label, n]) =>
        `<div class="stat"><span class="stat-num">${n}</span><span class="stat-label">${label}</span></div>`
    )
    .join("");
  el.hidden = false;
}

function renderSkillList(skills) {
  els.skillRows.innerHTML = "";
  els.emptyState.textContent = showingArchived
    ? "Nothing archived yet. Archive a scan from its detail page to move it here."
    : "No skills scanned yet. Paste a source on the left and run a scan.";
  els.emptyState.hidden = skills.length > 0;
  renderLogSummary(skills);

  for (const s of skills) {
    const tr = document.createElement("tr");
    tr.className = "skill-row";

    const sevWord = severityBand(s);
    const sevClass = bandClass(sevWord);

    const verdictText = humanize(s.verdict) || (s.error ? "error" : "—");
    // Only the high-risk "do not install" call gets the solid red badge;
    // everything else is quiet text.
    const verdictCell = isHighRisk(s)
      ? `<span class="pill pill-critical">${escapeHtml(verdictText)}</span>`
      : `<span class="verdict-text">${escapeHtml(verdictText)}</span>`;

    tr.innerHTML = `
      <td>
        <button type="button" class="row-open">
          <span class="skill-name">${escapeHtml(s.name)}</span>
          <span class="skill-source">${escapeHtml(s.source)}</span>
        </button>
      </td>
      <td>
        <span class="score-badge score-badge--${sevClass}">${escapeHtml(s.score ?? "—")}</span>
        ${sevWord ? `<span class="score-severity">${sevWord}</span>` : ""}
      </td>
      <td>${verdictCell}</td>
      <td>${fmtDate(s.last_scanned)}</td>
      <td><span class="gate-text gate-text--${gateClass(s.status)}">${escapeHtml(gateStatusLabel(s.status))}</span></td>
    `;

    const openBtn = tr.querySelector(".row-open");
    openBtn.setAttribute("aria-label", `View scan details for ${s.name}`);
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDetail(s.id);
    });
    tr.addEventListener("click", () => {
      if (window.getSelection && String(window.getSelection())) return;
      openDetail(s.id);
    });

    els.skillRows.appendChild(tr);
  }
}

function gateClass(status) {
  if (status === "approved") return "ok";
  if (status === "rejected") return "critical";
  return "pending";
}

// The stored status stays "rejected" — this is display only. "Not approved"
// reads as the counterpart to the Install / Do Not Install pair; "rejected"
// sounds like the scan failed. Lowercase because the CSS capitalizes.
function gateStatusLabel(status) {
  if (status === "rejected") return "not approved";
  return status || "pending";
}

function renderGateCurrent(status) {
  els.gateCurrent.innerHTML =
    `<span class="gate-current-label">install status</span>` +
    `<span class="gate-current-value gate-current-value--${gateClass(status)}">` +
    `${escapeHtml(gateStatusLabel(status))}</span>`;
}

// Three states, and only one set of controls is ever live:
//   undecided  -> Install / Do Not Install
//   decided    -> Reset, so a decision stays changeable once the pair is gone
//   archived   -> Reset, which also restores the item to the log
function updateGateControls(archived, status) {
  const decided = status === "approved" || status === "rejected";
  els.gateApprove.hidden = archived || decided;
  els.gateReject.hidden = archived || decided;
  els.gateReset.hidden = !archived && !decided;
}

// Scope of the scan, stated up front: how many files it covered and whether
// the semantic pass ran. Without the file count a one-file skill and a
// 300-file repo produce identical-looking reports. This is deliberately a
// count of files *looked at*, not a verdict — how completely they were read
// is the coverage notice's job, and what was found in them is the findings
// list's. Conflating the three is what made "11 files" read as "11 findings".
function renderScanMeta(skill) {
  const meta = (skill.report && skill.report.metadata) || {};
  const ac = (skill.report && skill.report.analysis_completeness) || null;
  const chips = [];

  const total = ac && ac.total_components;
  if (typeof total === "number" && total > 0) {
    chips.push(`${total} ${total === 1 ? "file" : "files"} scanned`);
  }
  if (meta.llm_requested && meta.llm_available) chips.push("Review using LLM");

  els.scanMeta.innerHTML = chips
    .map((c) => `<span class="scan-meta-chip">${escapeHtml(c)}</span>`)
    .join("");
  els.scanMeta.hidden = chips.length === 0;
}

// SkillSpector's reason codes, in words someone deciding whether to install
// something can act on.
const COVERAGE_REASONS = {
  static_parse_limit: "part of the code was too complex to parse",
  reference_unresolved: "some file references couldn't be followed",
  runtime_limit: "the scan ran out of time",
  obfuscated_instruction_text: "some text was deliberately obfuscated",
  file_too_large: "a file was too large to read",
  binary_content: "some files were binary and couldn't be read",
};

// "Nothing found" and "couldn't read it" must not look the same in a security
// tool. Only warn when files genuinely weren't fully inspected.
//
// An earlier version tried to soften this when reference_unresolved was the
// only reason code, on the theory that prose like "clarity/simplicity" scans
// as a file path and shouldn't raise an alarm. Real reports disprove the
// premise: a scan with 13 unresolved references still reported 11 of 11 files
// fully inspected at 100% coverage. Unresolved references don't reduce
// coverage, so that branch could never fire — a static_parse_limit is what
// actually drops a file. Don't re-add it without a report that proves the case.
function coverageNotice(report) {
  const ac = (report && report.analysis_completeness) || null;
  if (!ac) return null;
  const partial = ac.partially_inspected_files || 0;
  const skipped = ac.entirely_uninspected_files || 0;
  const coverage = ac.coverage_percent;
  const shortfall =
    partial > 0 || skipped > 0 || (typeof coverage === "number" && coverage < 100);
  if (!shortfall) return null;

  const total = ac.total_components ?? 0;
  const full = ac.fully_inspected_files ?? 0;
  let what;
  if (total === 1) what = "couldn't fully read the one file in this skill";
  else if (full === 0) what = `couldn't fully read any of its ${total} files`;
  else what = `only fully read ${full} of its ${total} files`;

  const seen = [];
  for (const ex of ac.ledger_exceptions || []) {
    const code = ex.reason_code;
    if (code && !seen.includes(code)) seen.push(code);
  }
  const reasons = seen.map((c) => COVERAGE_REASONS[c] || humanize(c));
  let why = "";
  if (reasons.length === 1) {
    why = `\nReason: ${reasons[0]}.`;
  } else if (reasons.length > 1) {
    why =
      `\nReasons: ${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}.`;
  }

  // \n renders as a line break — .detail-error is white-space: pre-wrap.
  return (
    `This scan was incomplete — SkillSpector ${what}, so parts of it were ` +
    `never checked.${why}\nA low score here means nothing was found in the ` +
    `parts it could read, which is not the same as the skill being safe.`
  );
}

function renderDetailSource(src) {
  src = src || "";
  els.detailSource.textContent = "";
  if (/^https?:\/\//i.test(src)) {
    const a = document.createElement("a");
    a.href = src;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = `${src} ↗`;
    els.detailSource.appendChild(a);
  } else {
    els.detailSource.textContent = src;
  }
}

function escapeHtml(str) {
  if (str == null) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// "DO_NOT_INSTALL" -> "do not install" (CSS then capitalizes it)
function humanize(str) {
  return (str || "").replace(/[_-]+/g, " ").trim().toLowerCase();
}

async function runScan() {
  if (scanning) return;
  const source = els.scanInput.value.trim();
  if (!stagedFile && !source) return;
  scanning = true;

  const useLlm = els.useLlm.checked;
  const controls = [
    els.scanInput,
    els.useLlm,
    els.scanBtn,
    els.fileInput,
    els.fileClear,
  ];
  controls.forEach((el) => (el.disabled = true));
  els.scanBtn.textContent = "Scanning…";
  const label = deriveName(stagedFile ? stagedFile.name : source);
  showScanStatus(
    `Scanning ${label}` +
      (useLlm ? " with LLM review — this can take a few minutes" : "…")
  );

  try {
    let res;
    if (stagedFile) {
      const form = new FormData();
      form.append("file", stagedFile);
      form.append("use_llm", String(useLlm));
      res = await fetch(`${API}/scan/upload`, { method: "POST", body: form });
    } else {
      res = await fetch(`${API}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, use_llm: useLlm }),
      });
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        detail = (await res.json()).detail || detail;
      } catch (_) {
        /* non-JSON error body */
      }
      throw new Error(detail);
    }
    const skill = await res.json();
    hideScanStatus();
    // A new or re-run scan always lands in the current log.
    setTab(false);
    if (skill && skill.id != null) {
      openDetail(skill.id);
    }
    clearStagedFile();
    els.scanInput.value = "";
    updateSourceType();
  } catch (e) {
    showScanStatus(`Scan request failed: ${e.message}`, true);
  } finally {
    scanning = false;
    controls.forEach((el) => (el.disabled = false));
    els.scanInput.disabled = stagedFile != null;
    els.scanBtn.textContent = "Scan";
  }
}

function showDetailView(show) {
  els.detailView.hidden = !show;
  els.listView.hidden = show;
  // detail takes the full width; the scan sidebar + log go away
  els.app.classList.toggle("detail-open", show);
}

async function openDetail(id) {
  let skill;
  try {
    const res = await fetch(`${API}/skills/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    skill = await res.json();
  } catch (e) {
    // Row is gone (deleted elsewhere) or the backend is down — just refresh.
    await loadSkills();
    return;
  }
  currentSkillId = id;
  renderDetail(skill);
  showDetailView(true);
}

function renderDetail(skill) {
  els.detailName.textContent = skill.name;
  renderDetailSource(skill.source);
  renderScanMeta(skill);

  // Active items can be archived; archived items can be restored or purged.
  els.archiveBtn.hidden = skill.archived;
  els.restoreBtn.hidden = !skill.archived;
  els.deleteBtn.hidden = !skill.archived;
  updateGateControls(skill.archived, skill.status);

  const sevClass = bandClass(severityBand(skill));
  els.detailScore.textContent = skill.score ?? "—";
  els.detailScore.className = `detail-score detail-score--${sevClass}`;

  if (typeof skill.score === "number") {
    els.scoreMeterMarker.style.left = `${Math.max(0, Math.min(100, skill.score))}%`;
    els.scoreMeter.hidden = false;
  } else {
    els.scoreMeter.hidden = true;
  }

  const sevWord = severityBand(skill);
  const verdictParts = [];
  if (sevWord) verdictParts.push(`${sevWord} risk`);
  if (skill.verdict) verdictParts.push(humanize(skill.verdict));
  else if (skill.error) verdictParts.push("scan failed");
  else if (!sevWord) verdictParts.push("no verdict");
  els.detailVerdict.textContent = verdictParts.join(" · ");
  // Red badge only for the high-risk "do not install" case; otherwise quiet text.
  els.detailVerdict.classList.toggle(
    "detail-verdict-label--danger",
    isHighRisk(skill)
  );

  renderGateCurrent(skill.status);

  // SkillSpector silently degrades to static-only when the LLM pass was asked
  // for but no provider is configured — say so rather than passing it off as
  // a full scan.
  const meta = (skill.report && skill.report.metadata) || {};
  const notices = [];
  // SkillSpector fails closed: a LOW band that would normally read SAFE is
  // downgraded to CAUTION when the scan was degraded or incomplete
  // (nodes/report.py). Without saying so, "0 · Low Risk · Caution" looks
  // like the tool contradicting itself.
  const ra = (skill.report && skill.report.risk_assessment) || {};
  const recommendation = String(ra.recommendation || "").toUpperCase();
  if (
    String(ra.severity || "").toUpperCase() === "LOW" &&
    recommendation &&
    recommendation !== "SAFE"
  ) {
    notices.push(
      "Scored low risk, but not marked safe. SkillSpector won't call a scan " +
        "safe when it couldn't finish inspecting everything — the score " +
        "reflects what it managed to check, not what it missed."
    );
  }
  if (skill.gate_cleared) {
    notices.push(
      "This skill changed since you gated it, so the previous decision was " +
        "cleared. Review the findings below and decide again."
    );
  }
  if (meta.llm_requested && !meta.llm_available) {
    notices.push(
      "LLM review was requested but no provider was configured, so this is a " +
        "static-only scan. Set SKILLSPECTOR_PROVIDER and the matching API key, " +
        "then scan again."
    );
  }
  const coverage = coverageNotice(skill.report);
  if (coverage) notices.push(coverage);
  els.detailError.classList.toggle(
    "detail-error--warn",
    !skill.error && notices.length > 0
  );
  if (skill.error) {
    els.detailError.hidden = false;
    els.detailError.textContent = skill.error;
  } else if (notices.length) {
    els.detailError.hidden = false;
    els.detailError.textContent = notices.join("\n\n");
  } else {
    // Clear, don't just hide: leaving the previous skill's notice in the DOM
    // means any future path that unhides this element shows a warning about
    // something else entirely.
    els.detailError.textContent = "";
    els.detailError.hidden = true;
  }

  renderFindings(skill.report);
  renderFilesPanel(skill.report);
}

// The findings list only names files that had a problem, so a clean file is
// invisible there — which makes "11 files scanned" look like it lost eight of
// them. This is the inventory: every file SkillSpector enumerated, each marked
// clean or carrying its worst severity. Collapsed by default; the count is in
// the summary so it reads without opening.
function renderFilesPanel(report) {
  const components = (report && report.components) || null;
  if (!Array.isArray(components) || components.length === 0) {
    els.filesPanel.hidden = true;
    els.filesPanelList.innerHTML = "";
    return;
  }

  // Worst severity per file, from the raw issue rows — one file can hold
  // several findings and we want the most serious one on the badge.
  const worst = new Map();
  const counts = new Map();
  for (const issue of (report && report.issues) || []) {
    const file = (issue.location || {}).file;
    if (!file) continue;
    counts.set(file, (counts.get(file) || 0) + 1);
    const sev = (issue.severity || "").toLowerCase();
    const prev = worst.get(file);
    if (prev === undefined || severityRank(sev) < severityRank(prev)) {
      worst.set(file, sev);
    }
  }

  const rows = components.slice().sort((a, b) => {
    const ra = worst.has(a.path) ? severityRank(worst.get(a.path)) : 99;
    const rb = worst.has(b.path) ? severityRank(worst.get(b.path)) : 99;
    if (ra !== rb) return ra - rb;
    return String(a.path).localeCompare(String(b.path));
  });

  const flagged = worst.size;
  els.filesPanelCount.textContent = flagged
    ? `${components.length} scanned · ${flagged} with findings`
    : `${components.length} scanned · all clean`;

  els.filesPanelList.innerHTML = rows
    .map((c) => {
      const sev = worst.get(c.path);
      const n = counts.get(c.path) || 0;
      const badge = sev
        ? `<span class="pill ${findingPillClass(sev)}">${n} ${escapeHtml(sev)}</span>`
        : `<span class="pill pill-ok pill--soft">clean</span>`;
      const bits = [c.type, typeof c.lines === "number" ? `${c.lines} lines` : null]
        .filter(Boolean)
        .join(" · ");
      return (
        `<li class="file-row">` +
        `<span class="file-row-path">${escapeHtml(c.path)}</span>` +
        `<span class="file-row-meta">${escapeHtml(bits)}</span>` +
        badge +
        `</li>`
      );
    })
    .join("");
  els.filesPanel.hidden = false;
}

function severityRank(sev) {
  const i = SEVERITY_ORDER.indexOf((sev || "").toLowerCase());
  return i === -1 ? SEVERITY_ORDER.length : i;
}

// critical/high stay solid red; medium/low/info get a softer tinted badge
function findingPillClass(severity) {
  const sev = (severity || "").toLowerCase();
  if (sev === "critical" || sev === "high") return "pill-critical";
  if (sev === "medium") return "pill-medium pill--soft";
  return "pill-ok pill--soft";
}

// Anything outside the four known bands lands in "other". It gets a row only
// when it actually occurs, so an unexpected level from a future SkillSpector
// can't silently vanish from a chart that's supposed to add up.
function countBySeverity(findings) {
  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  counts.other = 0;
  for (const f of findings) {
    const s = (f.severity || "").toLowerCase();
    counts[SEVERITY_ORDER.includes(s) ? s : "other"]++;
  }
  return counts;
}

function renderSeverityBreakdown(findings) {
  const el = els.severityBreakdown;
  if (!findings || findings.length === 0) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }

  const counts = countBySeverity(findings);
  const bands = counts.other > 0 ? [...SEVERITY_ORDER, "other"] : SEVERITY_ORDER;
  const max = Math.max(1, ...bands.map((s) => counts[s]));

  const rows = bands.map((sev) => {
    const n = counts[sev];
    const width = ((n / max) * 100).toFixed(1);
    return `
      <div class="sev-row${n === 0 ? " sev-row--empty" : ""}">
        <span class="sev-label">${sev}</span>
        <span class="sev-track"><span class="sev-bar" style="width:${width}%"></span></span>
        <span class="sev-count">${n}</span>
      </div>`;
  }).join("");

  el.innerHTML = `
    <figcaption class="severity-breakdown-head">
      <span>Findings by severity</span>
      <span>${findings.length} total</span>
    </figcaption>
    ${rows}`;
  el.hidden = false;
}

// SkillSpector reports one "issue" per code location; collapse repeats of the
// same finding into one row that lists every line it hit.
function dedupeFindings(list) {
  const seen = new Map();
  for (const f of list) {
    const key =
      f.finding_id || f.id || `${f.category || ""}|${f.pattern || f.message || ""}`;
    const spot = f.location || (f.occurrences && f.occurrences[0]) || f;
    const loc =
      spot && spot.file
        ? `${spot.file}${spot.start_line ? ":" + spot.start_line : ""}`
        : "";
    if (seen.has(key)) {
      if (loc) seen.get(key)._locs.add(loc);
    } else {
      seen.set(key, { ...f, _locs: new Set(loc ? [loc] : []) });
    }
  }
  return [...seen.values()];
}

function findingTitle(f) {
  return f.category || f.rule_id || f.id || "finding";
}

function findingMessage(f) {
  return f.pattern || f.message || f.explanation || f.finding || "";
}

// "a.py:1", "a.py:9", "b.py:4" -> "a.py:1, 9  ·  b.py:4"
function findingLocations(f) {
  const locs = f._locs ? [...f._locs] : [];
  if (!locs.length) return "";
  const byFile = new Map();
  for (const l of locs) {
    const cut = l.lastIndexOf(":");
    const file = cut > 0 ? l.slice(0, cut) : l;
    const line = cut > 0 ? l.slice(cut + 1) : "";
    if (!byFile.has(file)) byFile.set(file, []);
    if (line) byFile.get(file).push(line);
  }
  return [...byFile.entries()]
    .map(([file, lines]) => {
      if (!lines.length) return file;
      const shown = lines.slice(0, 4).join(", ");
      return `${file}:${shown}${lines.length > 4 ? ` +${lines.length - 4}` : ""}`;
    })
    .join("  ·  ");
}

function renderFindings(report) {
  els.findingsList.innerHTML = "";
  const raw = report && (report.findings || report.results || report.issues);
  const findings = dedupeFindings(raw || []);

  renderSeverityBreakdown(findings);

  if (findings.length === 0) {
    els.findingsList.innerHTML = `<div class="no-findings">No findings in this report.</div>`;
    return;
  }

  const sorted = [...findings].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity)
  );

  for (const f of sorted) {
    const div = document.createElement("div");
    div.className = "finding";
    div.innerHTML = `
      <div class="finding-top">
        <span class="finding-rule">${escapeHtml(findingTitle(f))}</span>
        <span class="finding-location">${escapeHtml(findingLocations(f))}</span>
        <span class="pill ${findingPillClass(f.severity)}">${escapeHtml((f.severity || "").toLowerCase())}</span>
      </div>
      <div class="finding-message">${escapeHtml(findingMessage(f))}</div>
      ${f.remediation ? `<div class="finding-remediation">Fix: ${escapeHtml(f.remediation)}</div>` : ""}
    `;
    els.findingsList.appendChild(div);
  }
}

async function setGateStatus(status) {
  if (currentSkillId == null) return;
  try {
    const res = await fetch(`${API}/skills/${currentSkillId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Re-render the whole detail, not just the badge: the response clears
    // gate_cleared, and the "decision was cleared" notice has to go with it.
    renderDetail(await res.json());
    // The button that was just clicked is now hidden — move focus to the
    // control that replaced it rather than dropping it to <body>.
    if (!els.gateReset.hidden) els.gateReset.focus();
    loadSkills();
  } catch (e) {
    // Record is gone or the backend is down — bail back to a fresh log.
    showDetailView(false);
    loadSkills();
  }
}

// Reset clears the gate back to pending and hands the decision buttons back.
// Reachable two ways: on a decided item (change your mind) and on an archived
// one, where it also restores the item to the log. The un-archive call is a
// harmless no-op in the first case, so both paths share one handler.
async function onGateReset() {
  if (currentSkillId == null) return;
  try {
    for (const [path, body] of [
      [`/skills/${currentSkillId}/status`, { status: "pending" }],
      [`/skills/${currentSkillId}/archive`, { archived: false }],
    ]) {
      const res = await fetch(`${API}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }
    const res = await fetch(`${API}/skills/${currentSkillId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderDetail(await res.json());
    // Reset hides itself; don't drop keyboard focus to <body>.
    els.gateApprove.focus();
    setTab(false);
  } catch (e) {
    showDetailView(false);
    loadSkills();
  }
}

async function setArchived(archived) {
  if (currentSkillId == null) return;
  try {
    const res = await fetch(`${API}/skills/${currentSkillId}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    // Record is gone or backend is down — fall through and refresh the list.
  }
  currentSkillId = null;
  showDetailView(false);
  loadSkills();
}

async function deleteSkill() {
  if (currentSkillId == null) return;
  const name = els.detailName.textContent || "this skill";
  if (
    !confirm(
      `Delete "${name}" for good? This removes the scan record and its findings — it can't be undone.`
    )
  ) {
    return;
  }

  try {
    const res = await fetch(`${API}/skills/${currentSkillId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    els.detailError.classList.remove("detail-error--warn");
    els.detailError.hidden = false;
    els.detailError.textContent =
      "Could not delete this record — it may have already been removed, or the backend is down. Go back and refresh the log.";
    return;
  }

  currentSkillId = null;
  showDetailView(false);
  loadSkills();
}

// --- wiring ---
els.scanBtn.addEventListener("click", runScan);
els.scanInput.addEventListener("input", updateSourceType);
els.llmInfoBtn.addEventListener("click", () => {
  const opening = els.llmInfo.hidden;
  els.llmInfo.hidden = !opening;
  els.llmInfoBtn.setAttribute("aria-expanded", String(opening));
});
els.scanInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runScan();
});
els.backBtn.addEventListener("click", () => {
  showDetailView(false);
  loadSkills();
});
els.archiveBtn.addEventListener("click", () => setArchived(true));
els.restoreBtn.addEventListener("click", () => setArchived(false));
els.deleteBtn.addEventListener("click", deleteSkill);
els.gateReset.addEventListener("click", onGateReset);
document.querySelectorAll(".gate-btn[data-status]").forEach((btn) => {
  btn.addEventListener("click", () => setGateStatus(btn.dataset.status));
});

// --- theme ---
els.themeBtn.addEventListener("click", toggleTheme);
syncThemeButton();
// While no explicit choice is stored, follow the OS if it changes mid-session.
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    if (!document.documentElement.dataset.theme) syncThemeButton();
  });

// --- log / archived tabs ---
els.tabCurrent.addEventListener("click", () => setTab(false));
els.tabArchived.addEventListener("click", () => setTab(true));
[els.tabCurrent, els.tabArchived].forEach((tab, i, tabs) => {
  tab.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const other = tabs[i === 0 ? 1 : 0];
      other.focus();
      other.click();
    }
  });
});

// --- drop zone ---
els.fileInput.addEventListener("change", () => stageFile(els.fileInput.files[0]));
els.fileClear.addEventListener("click", clearStagedFile);

["dragenter", "dragover"].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    if (!scanning) els.dropZone.classList.add("drop-zone--over");
  })
);
els.dropZone.addEventListener("dragleave", (e) => {
  if (!els.dropZone.contains(e.relatedTarget)) {
    els.dropZone.classList.remove("drop-zone--over");
  }
});
els.dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.dropZone.classList.remove("drop-zone--over");
  if (scanning) return;
  stageFile(e.dataTransfer.files && e.dataTransfer.files[0]);
});

// A file dropped anywhere else would make the browser navigate to it.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  if (!els.dropZone.contains(e.target)) e.preventDefault();
});

checkHealth();
loadSkills();

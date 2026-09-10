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
  scanInputError: document.getElementById("scan-input-error"),
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
  updateCheck: document.getElementById("update-check"),
  skillioUpdate: document.getElementById("skillio-update"),
  installHint: document.getElementById("install-hint"),
  helpDialog: document.getElementById("skillspector-help-dialog"),
  helpClose: document.getElementById("skillspector-help-close"),
  aboutBtn: document.getElementById("about-btn"),
  aboutDialog: document.getElementById("about-dialog"),
  aboutClose: document.getElementById("about-close"),
  updateResult: document.getElementById("update-result"),
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
// True while the server has a scan in flight — set from the log, not guessed
// here, so a reload during a scan restores the state instead of losing it.
let scanning = false;
let posting = false;        // the POST itself, before the row exists
let pollTimer = null;
let pendingScanId = null;   // the row to open once its scan lands
const POLL_MS = 1500;
let stagedFile = null;
let showingArchived = false;
let updateChecking = false;
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

function scanMode() {
  const checked = document.querySelector('input[name="scan-mode"]:checked');
  return checked && checked.value ? checked.value : "skill";
}

function isMcpMode() {
  return scanMode() === "mcp_registry";
}

// A registry is a URL or a payload path — never a .zip upload — so the drop
// zone goes away rather than offering something the scan cannot accept.
function onScanModeChange() {
  const mcp = isMcpMode();
  if (mcp && stagedFile) clearStagedFile();
  els.dropZone.hidden = mcp || stagedFile != null;
  els.scanOr.hidden = mcp || stagedFile != null;
  els.scanInput.placeholder = mcp
    ? "MCP Registry URL or payload path"
    : "Git URL, path, or .zip";
  // The accessible name outranks the placeholder for a screen reader, so
  // leaving it fixed announces "Git URL, local path, or .zip" in registry
  // mode — the one thing the field cannot take there.
  els.scanInput.setAttribute(
    "aria-label",
    mcp
      ? "What to scan — MCP Registry URL or payload path"
      : "What to scan — Git URL, local path, or .zip"
  );
  clearSourceError();
  updateSourceType();
}

function updateSourceType() {
  // The chip names skill sources. A registry URL is not one of them, and
  // labelling it "Git URL" would be worse than saying nothing.
  if (isMcpMode()) {
    els.sourceType.hidden = true;
    return;
  }
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
  clearSourceError();
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

// Clicking Scan with nothing entered used to return silently, which reads as
// a broken button. This is field validation, not action feedback, so it lands
// beside the input rather than in #scan-status down by the button — that
// region stays for scan progress and upload errors.
//
// role="alert" rather than focus alone: pressing Enter inside the empty input
// leaves focus where it already was, so nothing would re-announce. Focus still
// moves on the click path, because that is where the fix has to be typed.
function showSourceError(msg) {
  // Reveal before writing — an alert mutated while display:none is usually
  // never announced.
  els.scanInputError.hidden = false;
  els.scanInputError.textContent = msg;
  els.scanInput.setAttribute("aria-invalid", "true");
  els.scanInput.focus();
}

function clearSourceError() {
  if (!els.scanInput.hasAttribute("aria-invalid")) return;
  els.scanInput.removeAttribute("aria-invalid");
  els.scanInputError.hidden = true;
  els.scanInputError.textContent = "";
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// What the result line should say, kept apart from the DOM so it can be
// tested. The backend reports whether the two versions were comparable at
// all, so a version we could not read is never announced as "up to date".
function updateNotice(d) {
  if (!d) return null;
  if (d.update_available) {
    return {
      kind: "available",
      text: `${d.latest} is available`,
      url: d.url,
      command: "uv tool upgrade skillspector",
    };
  }
  if (!d.comparable) {
    return {
      kind: "unknown",
      text: `Latest is ${d.latest}, but your installed version could not be read.`,
      url: d.url,
    };
  }
  return { kind: "current", text: `You're on the latest (${d.installed}).` };
}

async function checkForUpdates() {
  if (updateChecking) return;
  updateChecking = true;
  els.updateCheck.disabled = true;
  els.updateCheck.textContent = "Checking…";
  els.updateResult.hidden = false; // reveal before writing, as elsewhere
  els.updateResult.textContent = "";
  els.updateResult.className = "update-result";
  try {
    const res = await fetch(`${API}/updates`);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        detail = (await res.json()).detail || detail;
      } catch (_) {
        /* non-JSON error body */
      }
      throw new Error(detail);
    }
    const notice = updateNotice(await res.json());
    if (!notice) throw new Error("empty response");
    // Only the kind with something to do earns the weight of a card.
    els.updateResult.className = `update-result update-result--${notice.kind}`;

    // Headline and link share a row: "vX is available — Release notes" is one
    // statement, and giving the link its own line made a two-fact card read as
    // three stacked ones.
    const headRow = document.createElement("div");
    headRow.className = "update-headline-row";
    const head = document.createElement("span");
    head.className = "update-headline";
    head.textContent = notice.text;
    headRow.append(head);
    els.updateResult.append(headRow);

    if (notice.url) {
      // Built with DOM calls, not innerHTML: escapeHtml is for text nodes and
      // would not make a URL safe to drop into an href.
      const a = document.createElement("a");
      a.className = "update-link";
      a.href = notice.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Release notes ↗";
      headRow.append(a);
    }
    if (notice.command) {
      renderCommandBlock(
        els.updateResult,
        "Update with",
        notice.command,
        "Run this in a terminal, then check again. Your scan log isn't touched.",
        "How installing and upgrading SkillSpector works"
      );
    }
  } catch (e) {
    els.updateResult.textContent = requestMessage(e, "Couldn't check for updates");
    els.updateResult.className = "update-result update-result--error";
  } finally {
    updateChecking = false;
    els.updateCheck.disabled = false;
    els.updateCheck.textContent = "Check for updates";
  }
}

// Static markup, not user data — the same glyph the LLM and About triggers
// use, so all three info affordances read as one thing.
const INFO_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" />' +
  '<path d="M12 11.25v4.75" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />' +
  '<circle cx="12" cy="7.9" r="1.05" fill="currentColor" />' +
  "</svg>";

// One explanation, reachable from wherever a skillspector command is shown.
// The point is that neither card sends you to GitHub to find out what the
// command you are about to paste into a terminal actually does.
function makeHelpButton(label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "info-btn info-btn--inline";
  btn.setAttribute("aria-label", label);
  btn.innerHTML = INFO_ICON_SVG;
  btn.addEventListener("click", () => els.helpDialog.showModal());
  return btn;
}

// "Update with  ⓘ" / "Install with  ⓘ" over a copyable command, then one
// plain line answering the question people actually have: where do I run
// this, and does it touch my data.
function renderCommandBlock(parent, labelText, command, note, helpLabel) {
  const row = document.createElement("div");
  row.className = "command-row";
  const label = document.createElement("span");
  label.className = "update-command-label";
  label.textContent = labelText;
  row.append(label, makeHelpButton(helpLabel));

  const code = document.createElement("code");
  code.className = "update-command";
  code.textContent = command;

  const hint = document.createElement("span");
  hint.className = "command-note";
  hint.textContent = note;

  parent.append(row, code, hint);
}

function showAppVersion(version) {
  if (!version) return;
  // Two credit lines exist — the rail on desktop, the footer on narrow — and
  // only one is ever visible, so both are filled rather than picking one.
  // The word "Skillio" beside it is its own element now — it is the link to
  // the repository — so this carries the number alone.
  for (const el of document.querySelectorAll("[data-app-version]")) {
    el.textContent = `v${version}`;
    el.hidden = false;
  }
}

// A quiet tag beside the version, not a modal or a banner: a new release of
// this app is worth knowing about and never worth interrupting for. Silent
// when the check couldn't reach the feed — an app that nags about its own
// update check failing is worse than one that says nothing.
async function checkSkillioUpdate() {
  try {
    const res = await fetch(`${API}/updates/skillio`);
    if (!res.ok) return;
    const d = await res.json();
    if (!d || !d.update_available || !d.latest) return;
    els.skillioUpdate.textContent = `${d.latest} available`;
    if (d.url) els.skillioUpdate.href = d.url;
    els.skillioUpdate.hidden = false;
  } catch (e) {
    // Offline, or the repository isn't public. Either way: say nothing.
  }
}

async function checkHealth() {
  try {
    const res = await fetch(`${API}/health`);
    const data = await res.json();
    showAppVersion(data.skillio_version);
    // Set rather than hardcoded in the markup, so the repository URL lives in
    // exactly one place. Both credit lines exist — the rail on desktop, the
    // footer on narrow — so both are filled. Until this arrives the word is
    // simply not a link.
    if (data.repo_url) {
      for (const el of document.querySelectorAll("[data-repo-link]")) {
        el.href = data.repo_url;
      }
    }
    if (data.skillspector_installed) {
      els.health.textContent = `NVIDIA skillspector ready — ${data.version || "installed"}`;
      els.health.className = "health ok";
      els.installHint.hidden = true;
      els.installHint.textContent = "";
    } else {
      els.health.textContent = "NVIDIA skillspector not found on PATH";
      els.health.className = "health bad";
      // This is the state where sending someone to GitHub stops them using
      // the app at all, so the command and the explanation come to them.
      els.installHint.textContent = "";
      els.installHint.hidden = false; // reveal before writing, as elsewhere
      renderCommandBlock(
        els.installHint,
        "Install with",
        "uv tool install git+https://github.com/NVIDIA/skillspector.git",
        "Run this in a terminal, then reload this page. Needs uv.",
        "How installing and upgrading SkillSpector works"
      );
    }
  } catch (e) {
    els.health.textContent = "backend unreachable";
    els.health.className = "health bad";
  }
}

function isScanning(skill) {
  return !!skill && skill.scan_state === "running";
}

// The scan runs on the server and the row carries its progress, so the log is
// the source of truth for "is a scan happening" — not a flag in this tab. That
// is what makes a reload mid-scan pick up where it left off.
function setScanControls(busy) {
  for (const el of [els.scanInput, els.useLlm, els.scanBtn, els.fileInput,
                    els.fileClear]) {
    el.disabled = busy;
  }
  for (const radio of document.querySelectorAll('input[name="scan-mode"]')) {
    radio.disabled = busy;
  }
  if (!busy) els.scanInput.disabled = stagedFile != null;
  els.scanBtn.textContent = busy ? "Scanning…" : "Scan";
}

function syncScanState(skills) {
  scanning = skills.some(isScanning);
  setScanControls(scanning);
  clearTimeout(pollTimer);
  if (scanning) {
    pollTimer = setTimeout(loadSkills, POLL_MS);
    return;
  }
  pollTimer = null;
  hideScanStatus();
  // Opening the finished report is the old blocking flow's payoff; keep it,
  // but never yank the view out from under someone already reading something.
  if (pendingScanId != null) {
    const id = pendingScanId;
    pendingScanId = null;
    if (els.detailView.hidden) openDetail(id);
  }
}

async function loadSkills() {
  try {
    const res = await fetch(`${API}/skills?archived=${showingArchived}`);
    const skills = await res.json();
    renderSkillList(skills);
    // A running scan always lives in the current log, so the archived view
    // cannot speak to it. Polling resumes when the current tab comes back.
    if (!showingArchived) syncScanState(skills);
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
    : "Nothing scanned yet. Paste a source on the left and run a scan.";
  els.emptyState.hidden = skills.length > 0;
  renderLogSummary(skills);

  for (const s of skills) {
    const tr = document.createElement("tr");
    tr.className = isScanning(s) ? "skill-row skill-row--scanning" : "skill-row";

    const sevWord = severityBand(s);
    const sevClass = bandClass(sevWord);

    const verdictText = humanize(s.verdict) || (s.error ? "error" : "—");
    // Only the high-risk "do not install" call gets the solid red badge;
    // everything else is quiet text.
    const verdictCell = isScanning(s)
      ? `<span class="scanning-tag"><span class="scanning-dot" aria-hidden="true"></span>scanning…</span>`
      : isHighRisk(s)
      ? `<span class="pill pill-critical">${escapeHtml(verdictText)}</span>`
      : `<span class="verdict-text">${escapeHtml(verdictText)}</span>`;

    tr.innerHTML = `
      <td>
        <button type="button" class="row-open">
          <span class="skill-name">${escapeHtml(s.name)}</span>${
            s.target_type === "mcp_registry"
              ? `<span class="target-tag">MCP Registry</span>`
              : ""
          }
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

// --- what went wrong, in plain words ---------------------------------------
// A failed scan used to print the line SkillSpector wrote for whoever wrote
// SkillSpector: "Error: Failed to clone repository", "[Errno 54] Connection
// reset by peer", "skillspector produced no report (exit code 2)". Each one
// is true and none of them answers the two questions the person looking at
// the screen actually has — what happened, and is there anything I can do.
//
// So each entry answers both, and the stored text is not thrown away: it
// moves into the disclosure underneath, which is what makes a bug report
// worth reading. Every pattern here was matched against a failure produced
// on purpose, not guessed from the source.
//
// Matching runs on whitespace-collapsed text: the CLI hard-wraps its own
// errors at about 78 columns, mid-phrase and mid-path, so a newline can land
// anywhere inside the words being matched.
//
// Order matters. A registry URL pasted in Skill mode fails the host check
// and mentions the registry, and it is the host check that has the useful
// answer, so that entry comes first.
const SCAN_FAILURES = [
  {
    when: /not in the allowed hosts list/i,
    lead: "SkillSpector only downloads from a few trusted sites, and that isn't one of them.",
    hint:
      "GitHub, GitLab, Bitbucket and Hugging Face are allowed. To scan the " +
      "MCP Registry, switch the mode above to MCP Registry — pasting its " +
      "address in Skill mode won't work.",
  },
  {
    when: /mcp registry source failed|registry\.modelcontextprotocol\.io/i,
    lead: "The MCP Registry stopped answering partway through the scan.",
    hint:
      "Nothing is wrong with your setup or your machine. A registry scan " +
      "makes thousands of requests one after another and SkillSpector stops " +
      "at the first one that fails, so this is common. Trying again is the " +
      "only thing to do — there is nothing here to fix.",
  },
  {
    when: /failed to clone repository/i,
    lead: "That repository couldn't be downloaded.",
    hint:
      "Check the address, and that the repository is public — Skillio has no " +
      "sign-in details, so a private repository looks exactly like one that " +
      "doesn't exist.",
  },
  {
    when: /cannot determine input type/i,
    lead: "Skillio couldn't tell what kind of source that is.",
    hint:
      "It takes a Git URL, a .zip file, a .md file, or a folder on this Mac. " +
      "If it's a path, check it for a typo — this is also what a folder that " +
      "isn't there looks like.",
  },
  {
    when: /invalid zip file/i,
    lead: "That .zip couldn't be opened.",
    hint:
      "It may have been damaged on the way down, or it may not be a zip at " +
      "all. Download it again, or unzip it yourself and scan the folder.",
  },
  {
    when: /was not found on path/i,
    lead: "SkillSpector isn't installed, so there was nothing to scan with.",
    hint:
      "Install it and scan again. The command is in the left column, beside " +
      "“Install with”, along with what it does.",
  },
  {
    when: /could not parse|could not read skillspector's report/i,
    lead: "SkillSpector finished, but Skillio couldn't read the report it wrote.",
    hint:
      "That usually means SkillSpector's report format has moved on. Use " +
      "Check for updates in the left column, then scan again.",
  },
  {
    when: /scan timed out after (\d+)s/i,
    lead: (m) =>
      `The scan passed its ${Math.max(1, Math.round(Number(m[1]) / 60))}-minute limit and was stopped.`,
    hint:
      "Nothing was saved. A genuinely large repository can need longer than " +
      "this, but a scan stuck waiting on the network usually never finishes " +
      "at all, however long it is given.",
  },
  {
    // Last of the specific ones: the wording above is more useful wherever it
    // applies, and every one of those can also contain a network phrase.
    when: /connection reset|connection refused|connection aborted|network is unreachable|name resolution|nodename nor servname|max retries exceeded|ssl|certificate verif/i,
    lead: "The download couldn't get through.",
    hint:
      "Check you're online and try again. A VPN, a company proxy or a " +
      "captive Wi-Fi login will also stop it, and each looks like this.",
  },
];

const SCAN_FAILURE_FALLBACK = {
  lead: "The scan didn't finish.",
  hint:
    "SkillSpector's own message is below. That's the thing to read, and the " +
    "thing to quote if you report it.",
};

// Always returns a lead and a hint; the raw text is the caller's to keep.
function friendlyError(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return { ...SCAN_FAILURE_FALLBACK };
  for (const f of SCAN_FAILURES) {
    const m = text.match(f.when);
    if (!m) continue;
    return {
      lead: typeof f.lead === "function" ? f.lead(m) : f.lead,
      hint: typeof f.hint === "function" ? f.hint(m) : f.hint,
    };
  }
  return { ...SCAN_FAILURE_FALLBACK };
}

// The sentence, the suggestion, then SkillSpector's own words folded away.
// Collapsed by default: the person who needs them knows to open it, and the
// person who doesn't shouldn't have to read a traceback to learn their Wi-Fi
// dropped.
function renderScanError(raw) {
  resetDetailError();
  els.detailError.classList.add("detail-error--fail");
  els.detailError.hidden = false;

  const { lead, hint } = friendlyError(raw);
  const leadEl = document.createElement("p");
  leadEl.className = "detail-error-lead";
  leadEl.textContent = lead;
  els.detailError.appendChild(leadEl);

  if (hint) {
    const hintEl = document.createElement("p");
    hintEl.className = "detail-error-hint";
    hintEl.textContent = hint;
    els.detailError.appendChild(hintEl);
  }

  const text = String(raw || "").trim();
  if (!text) return;
  const details = document.createElement("details");
  details.className = "detail-error-raw";
  const summary = document.createElement("summary");
  summary.className = "detail-error-raw-summary";
  summary.textContent = "Technical details";
  const pre = document.createElement("pre");
  pre.textContent = text;
  details.append(summary, pre);
  els.detailError.appendChild(details);
}

// Children and modifier together: the box is reused for three different
// things, and leaving either behind renders one of them dressed as another.
function resetDetailError() {
  els.detailError.textContent = "";
  els.detailError.classList.remove("detail-error--warn");
  els.detailError.classList.remove("detail-error--fail");
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
  if (scanning || posting) return;
  const source = els.scanInput.value.trim();
  if (!stagedFile && !source) {
    showSourceError("Enter a Git URL, path, or .zip — or choose a file below.");
    return;
  }
  posting = true;

  const useLlm = els.useLlm.checked;
  setScanControls(true);
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
        body: JSON.stringify({
          source,
          use_llm: useLlm,
          mcp_registry: isMcpMode(),
        }),
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
    // The POST now returns the row, not the result: the scan is running on
    // the server. Remember which row to open, and let the log carry it.
    const skill = await res.json();
    pendingScanId = skill && skill.id != null ? skill.id : null;
    clearStagedFile();
    els.scanInput.value = "";
    updateSourceType();
    // A new or re-run scan always lands in the current log. setTab reloads it,
    // and syncScanState takes over the controls and the polling from there.
    setTab(false);
  } catch (e) {
    showScanStatus(requestMessage(e, "Couldn't start the scan"), true);
    setScanControls(false);
  } finally {
    posting = false;
  }
}

// Two things go wrong with a request from this page and they need different
// sentences: the server isn't there at all, or the server answered and said
// why. "Failed to fetch" is the browser's phrase for the first and tells the
// reader nothing; the second is already a sentence the backend wrote for this
// screen, so it passes through untouched.
function requestMessage(e, whatFailed) {
  const msg = String((e && e.message) || "").trim();
  if (!msg || /failed to fetch|load failed|networkerror/i.test(msg)) {
    return (
      "Skillio's own server isn't answering — it may have stopped. Quit and " +
      "reopen Skillio, then try again."
    );
  }
  const http = msg.match(/^HTTP (\d+)$/);
  if (http) {
    return (
      `${whatFailed} — the server answered with an error (HTTP ${http[1]}). ` +
      "If it keeps happening, its log is in ~/Library/Logs."
    );
  }
  return `${whatFailed} — ${msg}`;
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
  if (skill.error) {
    renderScanError(skill.error);
  } else if (notices.length) {
    resetDetailError();
    els.detailError.classList.add("detail-error--warn");
    els.detailError.hidden = false;
    els.detailError.textContent = notices.join("\n\n");
  } else {
    // Clear, don't just hide: leaving the previous skill's notice in the DOM
    // means any future path that unhides this element shows a warning about
    // something else entirely.
    resetDetailError();
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

// The registry report is capped before storage — 98k findings is not a page
// anyone reads, and the whole report was 196MB. Saying so matters: this app's
// standing rule is that a short findings list must never be mistaken for a
// clean one.
// `shown` is how many rows the page actually renders — the DEDUPED count.
// It is passed in rather than re-derived here because the two differ:
// dedupeFindings collapses repeats of one finding_id into a single row, so a
// capped 1,000-finding report can render 40. "Showing 1,000" above 40 rows is
// its own kind of lie, and this function exists to stop exactly that.
function truncationNotice(report, shown) {
  const total = report && report.findings_total;
  if (!total || typeof shown !== "number" || total <= shown) return null;
  return (
    `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} findings. ` +
    `The rest were left out to keep the report a workable size — this is not ` +
    `the full list, and the score above reflects all of them.`
  );
}

function renderFindings(report) {
  els.findingsList.innerHTML = "";
  const raw = report && (report.findings || report.results || report.issues);
  const findings = dedupeFindings(raw || []);

  renderSeverityBreakdown(findings);

  const truncated = truncationNotice(report, findings.length);
  if (truncated) {
    const p = document.createElement("p");
    p.className = "findings-truncated";
    p.textContent = truncated;
    els.findingsList.appendChild(p);
  }

  if (findings.length === 0) {
    // appendChild, not innerHTML: an assignment here wipes the truncation
    // warning appended just above it, and a capped report would then render
    // as "No findings" — the precise failure that warning exists to prevent.
    const empty = document.createElement("div");
    empty.className = "no-findings";
    empty.textContent = "No findings in this report.";
    els.findingsList.appendChild(empty);
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
    resetDetailError();
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
els.updateCheck.addEventListener("click", checkForUpdates);
for (const radio of document.querySelectorAll('input[name="scan-mode"]')) {
  radio.addEventListener("change", onScanModeChange);
}
els.scanInput.addEventListener("input", () => {
  clearSourceError();
  updateSourceType();
});
// --- "What is Skillio?" dialog ---
// showModal(), not the open attribute: only the modal path brings the focus
// trap, Esc-to-close and inert background, and it restores focus to the
// trigger on close without being asked.
els.aboutBtn.addEventListener("click", () => els.aboutDialog.showModal());
els.helpClose.addEventListener("click", () => els.helpDialog.close());
els.helpDialog.addEventListener("click", (e) => {
  if (e.target === els.helpDialog) els.helpDialog.close();
});
els.aboutClose.addEventListener("click", () => els.aboutDialog.close());
// The backdrop is a pseudo-element, so a click on it targets the <dialog>
// itself; a click on the content targets something inside the body div.
els.aboutDialog.addEventListener("click", (e) => {
  if (e.target === els.aboutDialog) els.aboutDialog.close();
});
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
// Its own request, deliberately: the result is cached server-side for hours,
// so this costs nothing on a reload, and a slow or failed GitHub call must
// never hold up the health line or the log.
checkSkillioUpdate();
// Not only on change: a reload (or a bfcache restore) brings the checked
// radio back without firing `change`, which left the drop zone and the
// placeholder describing skill mode while the POST carried mcp_registry: true.
onScanModeChange();

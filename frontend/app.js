const API = "/api";

const els = {
  health: document.getElementById("health"),
  app: document.getElementById("app"),
  scanInput: document.getElementById("scan-input"),
  sourceType: document.getElementById("source-type"),
  scanBtn: document.getElementById("scan-btn"),
  scanStatus: document.getElementById("scan-status"),
  useLlm: document.getElementById("use-llm"),
  listView: document.getElementById("list-view"),
  detailView: document.getElementById("detail-view"),
  skillRows: document.getElementById("skill-rows"),
  logSummary: document.getElementById("log-summary"),
  emptyState: document.getElementById("empty-state"),
  backBtn: document.getElementById("back-btn"),
  deleteBtn: document.getElementById("delete-btn"),
  detailName: document.getElementById("detail-name"),
  detailSource: document.getElementById("detail-source"),
  detailScore: document.getElementById("detail-score"),
  detailVerdict: document.getElementById("detail-verdict"),
  scoreMeter: document.getElementById("score-meter"),
  scoreMeterMarker: document.querySelector("#score-meter .score-meter-marker"),
  detailError: document.getElementById("detail-error"),
  findingsList: document.getElementById("findings-list"),
  severityBreakdown: document.getElementById("severity-breakdown"),
  gateCurrent: document.getElementById("gate-current"),
};

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

let currentSkillId = null;
let scanning = false;

function severityClass(score) {
  if (score == null) return "pending";
  if (score > 50) return "critical";
  if (score > 20) return "medium";
  return "ok";
}

function severityWord(score) {
  if (score == null) return null;
  if (score > 50) return "high";
  if (score > 20) return "medium";
  return "low";
}

// The solid red treatment is reserved for the high-risk "do not install"
// call — either SkillSpector recommended it, or our score band is critical.
function isHighRisk(score, verdict) {
  return (
    severityClass(score) === "critical" ||
    /do[ _-]?not[ _-]?install/i.test(verdict || "")
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

function showScanStatus(msg, isError = false) {
  els.scanStatus.textContent = msg;
  els.scanStatus.classList.toggle("error", isError);
  els.scanStatus.hidden = false;
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
    const res = await fetch(`${API}/skills`);
    renderSkillList(await res.json());
  } catch (e) {
    // Backend unreachable — checkHealth() already surfaces this in the topbar.
  }
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
    ["rejected", count("rejected")],
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
  els.emptyState.hidden = skills.length > 0;
  renderLogSummary(skills);

  for (const s of skills) {
    const tr = document.createElement("tr");
    tr.className = "skill-row";

    const sevClass = severityClass(s.score);
    const sevWord = severityWord(s.score);

    const verdictText = humanize(s.verdict) || (s.error ? "error" : "—");
    // Only the high-risk "do not install" call gets the solid red badge;
    // everything else is quiet text.
    const verdictCell = isHighRisk(s.score, s.verdict)
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
        <span class="score-badge score-badge--${sevClass}">${s.score ?? "—"}</span>
        ${sevWord ? `<span class="score-severity">${sevWord}</span>` : ""}
      </td>
      <td>${verdictCell}</td>
      <td>${fmtDate(s.last_scanned)}</td>
      <td><span class="gate-text gate-text--${gateClass(s.status)}">${escapeHtml(s.status)}</span></td>
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

function renderGateCurrent(status) {
  els.gateCurrent.innerHTML =
    `<span class="gate-current-label">currently:</span>` +
    `<span class="gate-current-value gate-current-value--${gateClass(status)}">${escapeHtml(status)}</span>`;
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
  const source = els.scanInput.value.trim();
  if (!source || scanning) return;
  scanning = true;

  const useLlm = els.useLlm.checked;
  const controls = [els.scanInput, els.useLlm, els.scanBtn];
  controls.forEach((el) => (el.disabled = true));
  els.scanBtn.textContent = "Scanning…";
  showScanStatus(
    `Scanning ${deriveName(source)}` +
      (useLlm ? " with LLM review — this can take a few minutes" : "…")
  );

  try {
    const res = await fetch(`${API}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, use_llm: useLlm }),
    });
    const skill = await res.json();
    hideScanStatus();
    await loadSkills();
    if (skill && skill.id != null) {
      openDetail(skill.id);
    }
    els.scanInput.value = "";
    updateSourceType();
  } catch (e) {
    showScanStatus(`Scan request failed: ${e.message}`, true);
  } finally {
    scanning = false;
    controls.forEach((el) => (el.disabled = false));
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
  els.detailSource.textContent = skill.source;

  const sevClass = severityClass(skill.score);
  els.detailScore.textContent = skill.score ?? "—";
  els.detailScore.className = `detail-score detail-score--${sevClass}`;

  if (typeof skill.score === "number") {
    els.scoreMeterMarker.style.left = `${Math.max(0, Math.min(100, skill.score))}%`;
    els.scoreMeter.hidden = false;
  } else {
    els.scoreMeter.hidden = true;
  }

  const sevWord = severityWord(skill.score);
  const verdictParts = [];
  if (sevWord) verdictParts.push(`${sevWord} risk`);
  if (skill.verdict) verdictParts.push(humanize(skill.verdict));
  else if (skill.error) verdictParts.push("scan failed");
  else if (!sevWord) verdictParts.push("no verdict");
  els.detailVerdict.textContent = verdictParts.join(" · ");
  // Red badge only for the high-risk "do not install" case; otherwise quiet text.
  els.detailVerdict.classList.toggle(
    "detail-verdict-label--danger",
    isHighRisk(skill.score, skill.verdict)
  );

  renderGateCurrent(skill.status);

  if (skill.error) {
    els.detailError.hidden = false;
    els.detailError.textContent = skill.error;
  } else {
    els.detailError.hidden = true;
  }

  renderFindings(skill.report);
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

function countBySeverity(findings) {
  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  for (const f of findings) {
    const s = (f.severity || "").toLowerCase();
    counts[s in counts ? s : "info"]++;
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
  const max = Math.max(1, ...SEVERITY_ORDER.map((s) => counts[s]));

  const rows = SEVERITY_ORDER.map((sev) => {
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
    const skill = await res.json();
    renderGateCurrent(skill.status);
    loadSkills();
  } catch (e) {
    // Record is gone or the backend is down — bail back to a fresh log.
    showDetailView(false);
    loadSkills();
  }
}

async function deleteSkill() {
  if (currentSkillId == null) return;
  const name = els.detailName.textContent || "this skill";
  if (
    !confirm(
      `Delete "${name}" from the log? This removes the scan record and its findings.`
    )
  ) {
    return;
  }

  const res = await fetch(`${API}/skills/${currentSkillId}`, { method: "DELETE" });
  if (!res.ok) {
    els.detailError.hidden = false;
    els.detailError.textContent =
      "Could not delete this record — it may have already been removed. Go back and refresh the log.";
    return;
  }

  currentSkillId = null;
  showDetailView(false);
  loadSkills();
}

// --- wiring ---
els.scanBtn.addEventListener("click", runScan);
els.scanInput.addEventListener("input", updateSourceType);
els.scanInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runScan();
});
els.backBtn.addEventListener("click", () => {
  showDetailView(false);
  loadSkills();
});
els.deleteBtn.addEventListener("click", deleteSkill);
document.querySelectorAll(".gate-btn").forEach((btn) => {
  btn.addEventListener("click", () => setGateStatus(btn.dataset.status));
});

checkHealth();
loadSkills();

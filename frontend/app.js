const API = "/api";

const els = {
  health: document.getElementById("health"),
  scanBar: document.querySelector(".scan-bar"),
  scanInput: document.getElementById("scan-input"),
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

function deriveName(source) {
  let s = source.replace(/\/+$/, "");
  if (s.endsWith(".git")) s = s.slice(0, -4);
  const parts = s.split("/");
  return parts[parts.length - 1] || s;
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
      els.health.textContent = `skillspector ready — ${data.version || "installed"}`;
      els.health.className = "health ok";
    } else {
      els.health.textContent = "skillspector not found on PATH — install it first";
      els.health.className = "health bad";
    }
  } catch (e) {
    els.health.textContent = "backend unreachable";
    els.health.className = "health bad";
  }
}

async function loadSkills() {
  const res = await fetch(`${API}/skills`);
  const skills = await res.json();
  renderSkillList(skills);
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
      <td><span class="pill pill-${sevClass}">${escapeHtml(humanize(s.verdict) || (s.error ? "error" : "—"))}</span></td>
      <td><span class="pill pill-${gateClass(s.status)}">${escapeHtml(s.status)}</span></td>
      <td>${fmtDate(s.last_scanned)}</td>
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

function escapeHtml(str) {
  if (str == null) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// "do_not_install" -> "do not install" (CSS then capitalizes it)
function humanize(str) {
  return (str || "").replace(/[_-]+/g, " ").trim();
}

async function runScan() {
  const source = els.scanInput.value.trim();
  if (!source) return;

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
  } catch (e) {
    showScanStatus(`Scan request failed: ${e.message}`, true);
  } finally {
    controls.forEach((el) => (el.disabled = false));
    els.scanBtn.textContent = "Scan";
  }
}

function showDetailView(show) {
  els.detailView.hidden = !show;
  els.listView.hidden = show;
  els.scanBar.hidden = show; // hide the scan bar while viewing a skill
}

async function openDetail(id) {
  currentSkillId = id;
  const res = await fetch(`${API}/skills/${id}`);
  const skill = await res.json();
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

  els.gateCurrent.textContent = `currently: ${skill.status}`;

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

function renderFindings(report) {
  els.findingsList.innerHTML = "";
  const findings = report && (report.findings || report.results || []);

  renderSeverityBreakdown(findings || []);

  if (!findings || findings.length === 0) {
    els.findingsList.innerHTML = `<div class="no-findings">No findings in this report.</div>`;
    return;
  }

  const sorted = [...findings].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity)
  );

  for (const f of sorted) {
    const div = document.createElement("div");
    div.className = "finding";
    const loc = f.file ? `${f.file}${f.start_line ? ":" + f.start_line : ""}` : "";
    div.innerHTML = `
      <div class="finding-top">
        <span class="finding-rule">${escapeHtml(f.rule_id || f.category || "finding")}</span>
        <span class="finding-location">${escapeHtml(loc)}</span>
        <span class="pill pill-${(f.severity || "pending").toLowerCase() === "critical" || (f.severity || "").toLowerCase() === "high" ? "critical" : (f.severity || "").toLowerCase() === "medium" ? "medium" : "ok"}">${escapeHtml(f.severity || "")}</span>
      </div>
      <div class="finding-message">${escapeHtml(f.message || f.explanation || f.finding || "")}</div>
      ${f.remediation ? `<div class="finding-remediation">Fix: ${escapeHtml(f.remediation)}</div>` : ""}
    `;
    els.findingsList.appendChild(div);
  }
}

async function setGateStatus(status) {
  if (currentSkillId == null) return;
  const res = await fetch(`${API}/skills/${currentSkillId}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  const skill = await res.json();
  els.gateCurrent.textContent = `currently: ${skill.status}`;
  loadSkills();
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

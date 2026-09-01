const API = "/api";

const els = {
  health: document.getElementById("health"),
  scanInput: document.getElementById("scan-input"),
  scanBtn: document.getElementById("scan-btn"),
  useLlm: document.getElementById("use-llm"),
  listView: document.getElementById("list-view"),
  detailView: document.getElementById("detail-view"),
  skillRows: document.getElementById("skill-rows"),
  emptyState: document.getElementById("empty-state"),
  backBtn: document.getElementById("back-btn"),
  detailName: document.getElementById("detail-name"),
  detailSource: document.getElementById("detail-source"),
  detailScore: document.getElementById("detail-score"),
  detailVerdict: document.getElementById("detail-verdict"),
  detailError: document.getElementById("detail-error"),
  findingsList: document.getElementById("findings-list"),
  gateCurrent: document.getElementById("gate-current"),
};

let currentSkillId = null;

function severityClass(score) {
  if (score == null) return "pending";
  if (score > 50) return "critical";
  if (score > 20) return "medium";
  return "ok";
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

function renderSkillList(skills) {
  els.skillRows.innerHTML = "";
  els.emptyState.hidden = skills.length > 0;

  for (const s of skills) {
    const tr = document.createElement("tr");
    tr.className = "skill-row";
    tr.addEventListener("click", () => openDetail(s.id));

    const sevClass = severityClass(s.score);

    tr.innerHTML = `
      <td>
        <span class="skill-name">${escapeHtml(s.name)}</span>
        <span class="skill-source">${escapeHtml(s.source)}</span>
      </td>
      <td><span class="score-badge" style="color:var(--${sevClass})">${s.score ?? "—"}</span></td>
      <td><span class="pill pill-${sevClass}">${escapeHtml(s.verdict || (s.error ? "error" : "—"))}</span></td>
      <td><span class="pill pill-${gateClass(s.status)}">${s.status}</span></td>
      <td>${fmtDate(s.last_scanned)}</td>
    `;
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

async function runScan() {
  const source = els.scanInput.value.trim();
  if (!source) return;

  els.scanBtn.disabled = true;
  els.scanBtn.textContent = "Scanning…";

  try {
    const res = await fetch(`${API}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, use_llm: els.useLlm.checked }),
    });
    const skill = await res.json();
    await loadSkills();
    if (skill && skill.id != null) {
      openDetail(skill.id);
    }
    els.scanInput.value = "";
  } catch (e) {
    alert("Scan request failed: " + e.message);
  } finally {
    els.scanBtn.disabled = false;
    els.scanBtn.textContent = "Scan";
  }
}

async function openDetail(id) {
  currentSkillId = id;
  const res = await fetch(`${API}/skills/${id}`);
  const skill = await res.json();
  renderDetail(skill);
  els.listView.hidden = true;
  els.detailView.hidden = false;
}

function renderDetail(skill) {
  els.detailName.textContent = skill.name;
  els.detailSource.textContent = skill.source;

  const sevClass = severityClass(skill.score);
  els.detailScore.textContent = skill.score ?? "—";
  els.detailScore.style.color = `var(--${sevClass})`;
  els.detailVerdict.textContent = skill.verdict || (skill.error ? "scan failed" : "no verdict");

  els.gateCurrent.textContent = `currently: ${skill.status}`;

  if (skill.error) {
    els.detailError.hidden = false;
    els.detailError.textContent = skill.error;
  } else {
    els.detailError.hidden = true;
  }

  renderFindings(skill.report);
}

function renderFindings(report) {
  els.findingsList.innerHTML = "";
  const findings = report && (report.findings || report.results || []);

  if (!findings || findings.length === 0) {
    els.findingsList.innerHTML = `<div class="no-findings">No findings in this report.</div>`;
    return;
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...findings].sort((a, b) => {
    const sa = order[(a.severity || "").toLowerCase()] ?? 99;
    const sb = order[(b.severity || "").toLowerCase()] ?? 99;
    return sa - sb;
  });

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

// --- wiring ---
els.scanBtn.addEventListener("click", runScan);
els.scanInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runScan();
});
els.backBtn.addEventListener("click", () => {
  els.detailView.hidden = true;
  els.listView.hidden = false;
  loadSkills();
});
document.querySelectorAll(".gate-btn").forEach((btn) => {
  btn.addEventListener("click", () => setGateStatus(btn.dataset.status));
});

checkHealth();
loadSkills();

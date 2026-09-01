const API = "/api";

const els = {
  health: document.getElementById("health"),
  scanInput: document.getElementById("scan-input"),
  scanBtn: document.getElementById("scan-btn"),
  scanStatus: document.getElementById("scan-status"),
  useLlm: document.getElementById("use-llm"),
  listView: document.getElementById("list-view"),
  detailView: document.getElementById("detail-view"),
  skillRows: document.getElementById("skill-rows"),
  emptyState: document.getElementById("empty-state"),
  backBtn: document.getElementById("back-btn"),
  deleteBtn: document.getElementById("delete-btn"),
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

function renderSkillList(skills) {
  els.skillRows.innerHTML = "";
  els.emptyState.hidden = skills.length > 0;

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
      <td><span class="pill pill-${sevClass}">${escapeHtml(s.verdict || (s.error ? "error" : "—"))}</span></td>
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
  els.detailScore.className = `detail-score detail-score--${sevClass}`;

  const sevWord = severityWord(skill.score);
  const verdictParts = [];
  if (sevWord) verdictParts.push(`${sevWord} risk`);
  if (skill.verdict) verdictParts.push(skill.verdict);
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
  els.detailView.hidden = true;
  els.listView.hidden = false;
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
els.deleteBtn.addEventListener("click", deleteSkill);
document.querySelectorAll(".gate-btn").forEach((btn) => {
  btn.addEventListener("click", () => setGateStatus(btn.dataset.status));
});

checkHealth();
loadSkills();

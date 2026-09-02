"""
SkillSpector GUI backend.

Wraps the `skillspector` CLI (https://github.com/NVIDIA/SkillSpector) with a
small FastAPI service: run scans, keep a history of scanned skills, and let
you approve or reject a skill before installing it.

Run with:
    uvicorn app:app --reload --port 8787

Requires `skillspector` to be installed and on PATH (see the SkillSpector
README: git clone + `uv venv` + `make install`).
"""
import json
import mimetypes
import shutil
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

import storage

# StaticFiles infers Content-Type from this map; .webmanifest isn't registered
# by default on macOS, so Chrome would fetch the manifest as text/plain.
mimetypes.add_type("application/manifest+json", ".webmanifest")


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.init_db()
    yield


app = FastAPI(title="SkillSpector GUI", lifespan=lifespan)

# The frontend is served from this same app (same origin), so CORS isn't
# needed for normal use. Scope it to localhost only — a wildcard would let
# any site you visit POST /api/scan (which shells out) or read your log.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8787",
        "http://127.0.0.1:8787",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

SCAN_TIMEOUT_SECONDS = 300


class ScanRequest(BaseModel):
    source: str  # git URL, local path, or zip path
    use_llm: bool = False


class StatusRequest(BaseModel):
    status: str  # "pending" | "approved" | "rejected"


def _skillspector_path() -> Optional[str]:
    return shutil.which("skillspector")


def _derive_name(source: str) -> str:
    s = source.rstrip("/")
    if s.endswith(".git"):
        s = s[:-4]
    return s.split("/")[-1] or s


def _run_scan(source: str, use_llm: bool) -> dict:
    """Invoke the skillspector CLI and parse its JSON report."""
    binary = _skillspector_path()
    if not binary:
        raise RuntimeError(
            "skillspector was not found on PATH. Install it first: "
            "git clone https://github.com/NVIDIA/SkillSpector.git, then "
            "`uv venv && source .venv/bin/activate && make install`."
        )

    cmd = [binary, "scan", source, "--format", "json"]
    if not use_llm:
        cmd.append("--no-llm")

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=SCAN_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Scan timed out after {SCAN_TIMEOUT_SECONDS}s") from exc

    stdout = proc.stdout.strip()
    if not stdout:
        raise RuntimeError(
            f"skillspector produced no output (exit code {proc.returncode}). "
            f"stderr: {proc.stderr.strip()[:500]}"
        )

    try:
        report = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Could not parse skillspector output as JSON: {exc}. "
            f"Raw output: {stdout[:500]}"
        ) from exc

    return report


def _first_present(report: dict, *keys):
    """First key whose value is not None — so a real 0 isn't skipped."""
    for key in keys:
        if report.get(key) is not None:
            return report[key]
    return None


def _extract_score_and_verdict(report: dict) -> tuple[Optional[int], Optional[str]]:
    # SkillSpector nests these under "risk_assessment" (score + recommendation);
    # fall back to top-level keys for older or differently-shaped reports.
    ra = report.get("risk_assessment")
    ra = ra if isinstance(ra, dict) else {}

    score = _first_present(ra, "score", "risk_score", "overall_score")
    if score is None:
        score = _first_present(report, "risk_score", "score", "overall_score")

    verdict = _first_present(ra, "recommendation", "verdict", "result")
    if verdict is None:
        verdict = _first_present(report, "verdict", "recommendation", "result")

    if verdict is None and isinstance(score, (int, float)):
        verdict = "do_not_install" if score > 50 else "ok"
    return score, verdict


# `skillspector --version` spins up the whole CLI (~5s); its output never
# changes for a given binary, so look it up once per path and cache it.
_version_cache: dict[str, Optional[str]] = {}


def _skillspector_version(binary: str) -> Optional[str]:
    if binary not in _version_cache:
        try:
            proc = subprocess.run(
                [binary, "--version"], capture_output=True, text=True, timeout=15
            )
            _version_cache[binary] = proc.stdout.strip() or None
        except Exception:
            _version_cache[binary] = None
    return _version_cache[binary]


@app.get("/api/health")
def health() -> dict:
    binary = _skillspector_path()
    return {
        "skillspector_installed": binary is not None,
        "skillspector_path": binary,
        "version": _skillspector_version(binary) if binary else None,
    }


@app.get("/api/skills")
def list_skills() -> list:
    return storage.list_skills()


@app.get("/api/skills/{skill_id}")
def get_skill(skill_id: int) -> dict:
    skill = storage.get_skill(skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")
    return skill


@app.post("/api/scan")
def scan(req: ScanRequest) -> dict:
    source = req.source.strip()
    if not source:
        raise HTTPException(status_code=400, detail="source is required")

    name = _derive_name(source)

    try:
        report = _run_scan(source, req.use_llm)
    except RuntimeError as exc:
        return storage.upsert_scan(
            source=source, name=name, score=None, verdict=None,
            report=None, error=str(exc),
        )

    score, verdict = _extract_score_and_verdict(report)
    return storage.upsert_scan(
        source=source, name=name, score=score, verdict=verdict,
        report=report, error=None,
    )


@app.post("/api/skills/{skill_id}/status")
def set_status(skill_id: int, req: StatusRequest) -> dict:
    if req.status not in ("pending", "approved", "rejected"):
        raise HTTPException(status_code=400, detail="invalid status")
    skill = storage.set_status(skill_id, req.status)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")
    return skill


@app.delete("/api/skills/{skill_id}")
def delete_skill(skill_id: int) -> dict:
    ok = storage.delete_skill(skill_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Skill not found")
    return {"deleted": True}


# --- Serve the static frontend last, so /api/* routes above take priority ---
@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR)), name="frontend")

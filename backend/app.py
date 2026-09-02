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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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


def _extract_score_and_verdict(report: dict) -> tuple[Optional[int], Optional[str]]:
    score = (
        report.get("risk_score")
        or report.get("score")
        or report.get("overall_score")
    )
    verdict = (
        report.get("verdict")
        or report.get("recommendation")
        or report.get("result")
    )
    if verdict is None and isinstance(score, (int, float)):
        verdict = "do_not_install" if score > 50 else "ok"
    return score, verdict


@app.get("/api/health")
def health() -> dict:
    binary = _skillspector_path()
    version = None
    if binary:
        try:
            proc = subprocess.run(
                [binary, "--version"], capture_output=True, text=True, timeout=10
            )
            version = proc.stdout.strip() or proc.stderr.strip()
        except Exception:
            version = "unknown"
    return {
        "skillspector_installed": binary is not None,
        "skillspector_path": binary,
        "version": version,
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

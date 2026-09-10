"""
Skillio backend.

Wraps the `skillspector` CLI (https://github.com/NVIDIA/SkillSpector) with a
small FastAPI service: run scans, keep a history of scanned skills, and let
you approve or reject a skill before installing it.

Run with:
    uvicorn app:app --reload --port 8787

Requires `skillspector` to be installed and on PATH:
    uv tool install git+https://github.com/NVIDIA/skillspector.git
"""
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import threading
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
from xml.etree import ElementTree

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
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
    # A worker thread dies with the process, so any row still marked 'running'
    # is a leftover from a previous life, not a scan anyone is waiting on.
    storage.sweep_running_scans()
    yield


# Skillio's own version, distinct from the skillspector version reported by
# /api/health. Single source of truth: the UI reads it from that endpoint
# rather than carrying a second copy that could drift.
SKILLIO_VERSION = "1.2.2"

app = FastAPI(title="Skillio", version=SKILLIO_VERSION, lifespan=lifespan)

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
# The official MCP Registry is hundreds of servers read in one pass, so it
# legitimately runs far longer than any single skill. Measured against the live
# registry at over five minutes, which the skill limit would have cut off — and
# a skill that runs that long is stuck, so the two cannot share a number.
MCP_REGISTRY_TIMEOUT_SECONDS = 1800


class ScanRequest(BaseModel):
    source: str  # git URL, local path, or zip path
    use_llm: bool = False
    # SkillSpector reads an MCP Registry payload or URL differently from a
    # skill, so which one this is has to be said rather than guessed: a
    # registry URL and a skill URL are not distinguishable by shape.
    mcp_registry: bool = False


class StatusRequest(BaseModel):
    status: str  # "pending" | "approved" | "rejected"


class ArchiveRequest(BaseModel):
    archived: bool = True


def _skillspector_path() -> Optional[str]:
    return shutil.which("skillspector")


def _derive_name(source: str) -> str:
    s = source.rstrip("/")
    for suffix in (".git", ".zip"):
        if s.lower().endswith(suffix):
            s = s[: -len(suffix)]
    return s.split("/")[-1].split("\\")[-1] or s


def _run_scan(source: str, use_llm: bool, mcp_registry: bool = False) -> dict:
    """Invoke the skillspector CLI and parse its JSON report."""
    binary = _skillspector_path()
    if not binary:
        raise RuntimeError(
            "skillspector was not found on PATH. Install it first: "
            "`uv tool install git+https://github.com/NVIDIA/skillspector.git` "
            "(see https://github.com/NVIDIA/skillspector)."
        )

    # The CLI parses a leading-dash positional as an option, so a source like
    # "-o /somewhere" would be read as a flag rather than a thing to scan.
    if source.startswith("-"):
        raise RuntimeError(
            "Source must not start with '-'. Prefix a relative path with './'."
        )

    cmd = [binary, "scan", "--format", "json"]
    if not use_llm:
        cmd.append("--no-llm")
    if mcp_registry:
        cmd.append("--mcp-registry")
    cmd += ["--", source]

    timeout = (
        MCP_REGISTRY_TIMEOUT_SECONDS if mcp_registry else SCAN_TIMEOUT_SECONDS
    )
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Scan timed out after {timeout}s") from exc

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


def _report_fingerprint(report: Optional[dict]) -> Optional[str]:
    """Identity of a report's *risk content* — score, verdict, and which
    findings were raised. Re-running an unchanged skill yields the same
    fingerprint; a changed skill yields a different one."""
    if not isinstance(report, dict):
        return None
    score, verdict = _extract_score_and_verdict(report)
    issues = report.get("issues") or report.get("findings") or report.get("results") or []
    ids = []
    if isinstance(issues, list):
        for issue in issues:
            if not isinstance(issue, dict):
                continue
            # Severity is part of the identity: the same finding escalated
            # from medium to critical is a report the user must re-review.
            ids.append(
                str(
                    issue.get("match_fingerprint")
                    or issue.get("finding_id")
                    or issue.get("id")
                    or issue.get("pattern")
                    or ""
                )
                + "|"
                + str(issue.get("severity") or "")
            )
    payload = json.dumps(
        {"score": score, "verdict": verdict, "findings": sorted(ids)},
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


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

    # The report is untrusted (a scanned skill can influence it, especially
    # under --llm). SQLite's INTEGER affinity stores a non-numeric string
    # verbatim, so coerce here rather than letting one reach the frontend.
    if isinstance(score, bool) or not isinstance(score, (int, float)):
        try:
            score = int(str(score).strip())
        except (TypeError, ValueError):
            score = None
    else:
        score = int(score)
    return score, verdict


# `skillspector --version` spins up the whole CLI (~5s); its output never
# changes for a given binary, so look it up once per path and cache it.
_version_cache: dict[str, Optional[str]] = {}


def _skillspector_version(binary: str, refresh: bool = False) -> Optional[str]:
    if not refresh and binary in _version_cache:
        return _version_cache[binary]
    try:
        proc = subprocess.run(
            [binary, "--version"], capture_output=True, text=True, timeout=15
        )
        version = proc.stdout.strip() or None
    except Exception:
        version = None
    # Only a SUCCESSFUL read is a stable fact about this binary. Caching the
    # failure too meant one slow or interrupted start poisoned the version for
    # the life of the process: the health line fell back to "installed" with no
    # version, and the update check reported "your installed version could not
    # be read" forever. Observed live right after a service restart.
    if version is not None:
        _version_cache[binary] = version
    return version


# --- is there a newer SkillSpector? ------------------------------------------
_VERSION_RE = re.compile(r"v?(\d+)\.(\d+)\.(\d+)")


def _parse_version(text: Optional[str]) -> Optional[tuple]:
    """'v2.11.0' or 'SkillSpector v2.11.0' -> (2, 11, 0). None if unparseable."""
    if not text:
        return None
    m = _VERSION_RE.search(text.strip())
    return tuple(int(g) for g in m.groups()) if m else None


def _update_available(installed: Optional[str], latest: Optional[str]) -> bool:
    """Compare as numbers, not text — "2.9.0" sorts above "2.10.0" as a string.

    Both sides are normalised because the CLI says "SkillSpector v2.11.0"
    while a bare tag may say "2.11.0".
    """
    a, b = _parse_version(installed), _parse_version(latest)
    return bool(a and b and b > a)


TAGS_FEED = "https://github.com/NVIDIA/SkillSpector/tags.atom"
_ATOM = "{http://www.w3.org/2005/Atom}"


def _latest_tag() -> tuple[str, str]:
    """Newest version tag and its GitHub URL. Raises on any failure."""
    req = urllib.request.Request(TAGS_FEED, headers={"User-Agent": "skillio"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        root = ElementTree.fromstring(resp.read())
    for entry in root.findall(f"{_ATOM}entry"):  # newest first
        title = (entry.findtext(f"{_ATOM}title") or "").strip()
        if _parse_version(title):
            # The entry's own link, rather than a guessed /releases/tag/ URL
            # that need not exist if the project only tags.
            link = entry.find(f"{_ATOM}link")
            href = link.get("href") if link is not None else None
            # This ends up in an href, so only ever hand back a real https URL.
            if not (href or "").startswith("https://"):
                href = TAGS_FEED
            return title, href
    raise RuntimeError("no version tags in the feed")


@app.get("/api/updates")
def check_updates() -> dict:
    # refresh=True on purpose: the point of this check is that you then run
    # `uv tool upgrade skillspector`, and the cached version would keep
    # claiming an update is available until the server was restarted.
    binary = _skillspector_path()
    installed = _skillspector_version(binary, refresh=True) if binary else None
    try:
        latest, url = _latest_tag()
    except Exception as exc:
        # The cause only: the caller supplies the framing, and "couldn't reach
        # GitHub" would be a lie for a feed that answered but carried no tags.
        raise HTTPException(
            status_code=502, detail=f"couldn't read the tag feed ({exc})"
        )
    return {
        "installed": installed,
        "latest": latest,
        "url": url,
        "update_available": _update_available(installed, latest),
        # Whether the two could be compared at all, so the UI never has to
        # re-derive version parsing to work out what it may claim.
        "comparable": _parse_version(installed) is not None,
    }


@app.get("/api/health")
def health() -> dict:
    binary = _skillspector_path()
    return {
        "skillspector_installed": binary is not None,
        "skillspector_path": binary,
        "version": _skillspector_version(binary) if binary else None,
        "skillio_version": SKILLIO_VERSION,
    }


@app.get("/api/skills")
def list_skills(archived: bool = False) -> list:
    return storage.list_skills(archived)


@app.get("/api/skills/{skill_id}")
def get_skill(skill_id: int) -> dict:
    skill = storage.get_skill(skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")
    return skill


# --- running a scan without blocking the request -----------------------------
# The scan row IS the job: it is written as 'running' before the worker starts,
# so the log shows the scan while it happens instead of only once it lands.
#
# One at a time. skillspector with the LLM pass on is the slow case, and
# running several at once mostly spends the provider quota faster.
_scan_lock = threading.Lock()
_scan_active = False


def _claim_scan_slot() -> bool:
    global _scan_active
    with _scan_lock:
        if _scan_active:
            return False
        _scan_active = True
        return True


def _release_scan_slot() -> None:
    global _scan_active
    with _scan_lock:
        _scan_active = False


SCAN_BUSY_DETAIL = "A scan is already running. Wait for it to finish."


# A registry report is not a skill report's size. The live official registry
# returned ~196MB, of which ~180MB is `servers` and `snapshots` — per-server
# payload this app never renders, which would go into SQLite and back out of
# /api/skills on every poll. Findings are shown, but 98k of them is not a page
# anyone can read, so they are capped and the true total recorded.
MCP_REPORT_DROP_KEYS = ("servers", "snapshots")
MCP_MAX_FINDINGS = 1000


def _trim_registry_report(report: dict) -> dict:
    """Keep what the UI actually shows. Only ever applied to registry scans."""
    if not isinstance(report, dict):
        return report
    trimmed = {k: v for k, v in report.items() if k not in MCP_REPORT_DROP_KEYS}
    findings = trimmed.get("findings")
    if isinstance(findings, list) and len(findings) > MCP_MAX_FINDINGS:
        trimmed["findings_total"] = len(findings)
        trimmed["findings"] = findings[:MCP_MAX_FINDINGS]
    return trimmed


def _scan_worker(
    source: str,
    name: str,
    target: str,
    use_llm: bool,
    cleanup_dir: Optional[str] = None,
    mcp_registry: bool = False,
) -> None:
    """Run one scan and write the result onto its row. Never raises."""
    try:
        try:
            report = _run_scan(target, use_llm, mcp_registry)
            # Fingerprint what was scanned, not what gets stored. Trimming
            # throws away 97k of a registry's findings, and a fingerprint taken
            # after that is blind to every change past the first 1,000 — so a
            # registry could be rewritten underneath an approved gate and still
            # hash identical, which is the one thing the gate exists to stop.
            fingerprint = _report_fingerprint(report)
            if mcp_registry:
                report = _trim_registry_report(report)
        except RuntimeError as exc:
            storage.upsert_scan(
                source=source, name=name, score=None, verdict=None,
                report=None, error=str(exc),
            )
            return
        score, verdict = _extract_score_and_verdict(report)
        storage.upsert_scan(
            source=source, name=name, score=score, verdict=verdict,
            report=report, error=None, fingerprint=fingerprint,
            target_type="mcp_registry" if mcp_registry else "skill",
        )
    except Exception as exc:  # noqa: BLE001 - the row must never stay 'running'
        storage.upsert_scan(
            source=source, name=name, score=None, verdict=None,
            report=None, error=f"Scan failed unexpectedly: {exc}",
        )
    finally:
        if cleanup_dir:
            shutil.rmtree(cleanup_dir, ignore_errors=True)
        _release_scan_slot()


def _start_scan(
    source: str, name: str, target: str, use_llm: bool,
    cleanup_dir: Optional[str] = None, mcp_registry: bool = False,
) -> dict:
    """Claim the row, hand the work to a thread, and return the row at once."""
    try:
        row = storage.begin_scan(
            source, name, "mcp_registry" if mcp_registry else "skill"
        )
    except Exception:
        _release_scan_slot()
        raise
    threading.Thread(
        target=_scan_worker,
        args=(source, name, target, use_llm, cleanup_dir, mcp_registry),
        daemon=True,
    ).start()
    return row


@app.post("/api/scan")
def scan(req: ScanRequest) -> dict:
    # expanduser so "~/Downloads/skill.zip" works; a no-op for URLs.
    source = os.path.expanduser(req.source.strip())
    if not source:
        raise HTTPException(status_code=400, detail="source is required")

    # The registry's URL ends in "/v0/servers", so _derive_name would file
    # every registry scan in the log under the bare word "servers".
    name = "MCP Registry" if req.mcp_registry else _derive_name(source)

    if not _claim_scan_slot():
        raise HTTPException(status_code=409, detail=SCAN_BUSY_DETAIL)
    return _start_scan(
        source, name, source, req.use_llm, mcp_registry=req.mcp_registry
    )


MAX_UPLOAD_BYTES = 100 * 1024 * 1024


@app.post("/api/scan/upload")
async def scan_upload(
    file: UploadFile = File(...),
    use_llm: bool = Form(False),
) -> dict:
    """Scan an uploaded .zip: stream it to a temp file, then scan in the
    background. Once the worker has been handed the file it owns the temp
    directory and deletes it when the scan ends, however it ends."""
    filename = os.path.basename(file.filename or "").strip() or "upload.zip"
    if not filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Only .zip archives can be uploaded")

    tmpdir = tempfile.mkdtemp(prefix="skillio_")
    tmppath = os.path.join(tmpdir, filename)
    handed_off = False
    try:
        written = 0
        digest = hashlib.sha256()
        with open(tmppath, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413, detail="Upload exceeds the 100 MB limit"
                    )
                digest.update(chunk)
                out.write(chunk)

        # Identify an upload by its CONTENT, not its filename — otherwise two
        # unrelated files both called "skill.zip" collapse into one row and the
        # second inherits the gate decision made about the first.
        name = _derive_name(filename)
        source = f"{filename} · upload:{digest.hexdigest()[:32]}"

        if not _claim_scan_slot():
            raise HTTPException(status_code=409, detail=SCAN_BUSY_DETAIL)
        row = _start_scan(source, name, tmppath, use_llm, cleanup_dir=tmpdir)
        handed_off = True
        return row
    finally:
        # Only ours to delete until the worker takes it on.
        if not handed_off:
            shutil.rmtree(tmpdir, ignore_errors=True)


@app.post("/api/skills/{skill_id}/status")
def set_status(skill_id: int, req: StatusRequest) -> dict:
    if req.status not in ("pending", "approved", "rejected"):
        raise HTTPException(status_code=400, detail="invalid status")
    skill = storage.set_status(skill_id, req.status)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")
    return skill


@app.post("/api/skills/{skill_id}/archive")
def archive_skill(skill_id: int, req: ArchiveRequest) -> dict:
    skill = storage.set_archived(skill_id, req.archived)
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

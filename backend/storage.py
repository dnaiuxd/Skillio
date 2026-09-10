"""
Storage layer for Skillio.
Persists scanned skills, their latest report, and an approve/reject gate
status in a local SQLite database (skillio.db).
"""
import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

DB_PATH = Path(__file__).parent / "skillio.db"

_SCHEMA = """
    CREATE TABLE IF NOT EXISTS skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        first_scanned REAL NOT NULL,
        last_scanned REAL NOT NULL,
        score INTEGER,
        verdict TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        archived INTEGER NOT NULL DEFAULT 0,
        report_fingerprint TEXT,
        gate_cleared INTEGER NOT NULL DEFAULT 0,
        report_json TEXT,
        error TEXT,
        -- Scan lifecycle, distinct from `status` above, which is the gate
        -- decision. 'running' means a worker is filling this row in.
        scan_state TEXT NOT NULL DEFAULT 'done',
        -- What was scanned: 'skill' or 'mcp_registry'. SkillSpector reads the
        -- two differently, and a row has to remember which it was.
        target_type TEXT NOT NULL DEFAULT 'skill'
    )
"""

# Columns added after the first release, applied to older DBs on connect.
_ADDED_COLUMNS = (
    ("archived", "INTEGER NOT NULL DEFAULT 0"),
    ("report_fingerprint", "TEXT"),
    ("gate_cleared", "INTEGER NOT NULL DEFAULT 0"),
    ("scan_state", "TEXT NOT NULL DEFAULT 'done'"),
    ("target_type", "TEXT NOT NULL DEFAULT 'skill'"),
)


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # Ensure the schema on every connection so deleting the .db file to
    # reset the log doesn't 500 a long-running server until it restarts.
    conn.execute(_SCHEMA)
    # Bring older DBs up to the current column set.
    cols = {row[1] for row in conn.execute("PRAGMA table_info(skills)")}
    for column, ddl in _ADDED_COLUMNS:
        if column not in cols:
            conn.execute(f"ALTER TABLE skills ADD COLUMN {column} {ddl}")
    return conn


def init_db() -> None:
    get_conn().close()


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    if d.get("report_json"):
        try:
            d["report"] = json.loads(d["report_json"])
        except (json.JSONDecodeError, TypeError):
            d["report"] = None
    else:
        d["report"] = None
    d.pop("report_json", None)
    d.pop("report_fingerprint", None)
    d["archived"] = bool(d.get("archived"))
    d["gate_cleared"] = bool(d.get("gate_cleared"))
    return d


def find_by_source(source: str) -> Optional[dict[str, Any]]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM skills WHERE source = ?", (source,)).fetchone()
    conn.close()
    return _row_to_dict(row) if row else None


def begin_scan(source: str, name: str, target_type: str = "skill") -> dict[str, Any]:
    """Claim a row for a scan that is about to start, and return it.

    The row is the job: it appears in the log immediately as 'running' so a
    scan is visible while it happens rather than only once it lands. A re-scan
    keeps the previous score and report on show until the new one replaces
    them — the old answer is still the best one available until then.
    """
    now = time.time()
    conn = get_conn()
    existing = conn.execute(
        "SELECT id FROM skills WHERE source = ?", (source,)
    ).fetchone()
    if existing:
        conn.execute(
            """
            UPDATE skills
            SET name = ?, last_scanned = ?, archived = 0,
                scan_state = 'running', error = NULL, target_type = ?
            WHERE id = ?
            """,
            (name, now, target_type, existing["id"]),
        )
        skill_id = existing["id"]
    else:
        cur = conn.execute(
            """
            INSERT INTO skills (source, name, first_scanned, last_scanned,
                                score, verdict, status, scan_state, target_type)
            VALUES (?, ?, ?, ?, NULL, NULL, 'pending', 'running', ?)
            """,
            (source, name, now, now, target_type),
        )
        skill_id = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def sweep_running_scans() -> int:
    """Close out scans orphaned by a restart.

    A worker thread dies with the process, so a row left saying 'running'
    would spin in the UI forever with nothing behind it. Called on startup.
    """
    conn = get_conn()
    cur = conn.execute(
        """
        UPDATE skills
        SET scan_state = 'done', error = COALESCE(error, ?)
        WHERE scan_state = 'running'
        """,
        ("The server stopped while this scan was running, so it never "
         "finished. Scan it again.",),
    )
    conn.commit()
    conn.close()
    return cur.rowcount


def upsert_scan(
    source: str,
    name: str,
    score: Optional[int],
    verdict: Optional[str],
    report: Optional[dict],
    error: Optional[str] = None,
    fingerprint: Optional[str] = None,
    target_type: str = "skill",
) -> dict[str, Any]:
    now = time.time()
    report_json = json.dumps(report) if report is not None else None
    conn = get_conn()
    existing = conn.execute(
        "SELECT id, status, report_fingerprint FROM skills WHERE source = ?",
        (source,),
    ).fetchone()
    if existing:
        # A gate decision is a record of "I reviewed *this* report". If the
        # re-scan produced a different one, the old decision no longer applies
        # — clear it and flag why, so an approval can't outlive what it was for.
        changed = (
            fingerprint is not None
            and existing["report_fingerprint"] is not None
            and fingerprint != existing["report_fingerprint"]
        )
        stale_gate = changed and existing["status"] != "pending"
        conn.execute(
            """
            UPDATE skills
            SET name = ?, last_scanned = ?, score = ?, verdict = ?,
                report_json = ?, error = ?, archived = 0,
                scan_state = 'done',
                -- A failed scan carries no fingerprint; keep the last known
                -- good one or the next real change would not be detected.
                report_fingerprint = COALESCE(?, report_fingerprint),
                status = CASE WHEN ? THEN 'pending' ELSE status END,
                gate_cleared = CASE WHEN ? THEN 1 ELSE gate_cleared END
            WHERE id = ?
            """,
            (
                name, now, score, verdict, report_json, error, fingerprint,
                1 if stale_gate else 0,
                1 if stale_gate else 0,
                existing["id"],
            ),
        )
        skill_id = existing["id"]
    else:
        cur = conn.execute(
            """
            INSERT INTO skills (source, name, first_scanned, last_scanned,
                                 score, verdict, status, report_json, error,
                                 report_fingerprint, scan_state, target_type)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'done', ?)
            """,
            (source, name, now, now, score, verdict, report_json, error,
             fingerprint, target_type),
        )
        skill_id = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def list_skills(archived: bool = False) -> list[dict[str, Any]]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM skills WHERE archived = ? ORDER BY last_scanned DESC",
        (1 if archived else 0,),
    ).fetchall()
    conn.close()
    return [_row_to_dict(r) for r in rows]


def get_skill(skill_id: int) -> Optional[dict[str, Any]]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
    conn.close()
    return _row_to_dict(row) if row else None


def set_status(skill_id: int, status: str) -> Optional[dict[str, Any]]:
    conn = get_conn()
    # An explicit decision clears the "we reset this for you" notice.
    conn.execute(
        "UPDATE skills SET status = ?, gate_cleared = 0 WHERE id = ?",
        (status, skill_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
    conn.close()
    return _row_to_dict(row) if row else None


def set_archived(skill_id: int, archived: bool) -> Optional[dict[str, Any]]:
    conn = get_conn()
    conn.execute(
        "UPDATE skills SET archived = ? WHERE id = ?",
        (1 if archived else 0, skill_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
    conn.close()
    return _row_to_dict(row) if row else None


def delete_skill(skill_id: int) -> bool:
    """Delete a scan record, and actually give the disk space back.

    SQLite keeps freed pages inside the file and reuses them later; it does
    not shrink the file on DELETE (auto_vacuum defaults to NONE). That is
    normally the right trade, but here the thing being deleted is a stored
    report — and a trimmed MCP Registry report is ~0.16 MB against a skill's
    ~10-30 KB. "Delete permanently" is the one irreversible action in the app,
    so it should leave nothing behind, including the space.

    VACUUM rewrites the database, so it must run outside a transaction and is
    only worth doing when something was actually removed.
    """
    conn = get_conn()
    cur = conn.execute("DELETE FROM skills WHERE id = ?", (skill_id,))
    conn.commit()
    deleted = cur.rowcount > 0
    if deleted:
        conn.execute("VACUUM")
    conn.close()
    return deleted

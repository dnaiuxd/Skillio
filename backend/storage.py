"""
Storage layer for SkillSpector GUI.
Persists scanned skills, their latest report, and an approve/reject gate
status in a local SQLite database (skillspector_gui.db).
"""
import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

DB_PATH = Path(__file__).parent / "skillspector_gui.db"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    conn = get_conn()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS skills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            name TEXT NOT NULL,
            first_scanned REAL NOT NULL,
            last_scanned REAL NOT NULL,
            score INTEGER,
            verdict TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            report_json TEXT,
            error TEXT
        )
        """
    )
    conn.commit()
    conn.close()


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
    return d


def find_by_source(source: str) -> Optional[dict[str, Any]]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM skills WHERE source = ?", (source,)).fetchone()
    conn.close()
    return _row_to_dict(row) if row else None


def upsert_scan(
    source: str,
    name: str,
    score: Optional[int],
    verdict: Optional[str],
    report: Optional[dict],
    error: Optional[str] = None,
) -> dict[str, Any]:
    now = time.time()
    report_json = json.dumps(report) if report is not None else None
    conn = get_conn()
    existing = conn.execute(
        "SELECT id, status FROM skills WHERE source = ?", (source,)
    ).fetchone()
    if existing:
        conn.execute(
            """
            UPDATE skills
            SET name = ?, last_scanned = ?, score = ?, verdict = ?,
                report_json = ?, error = ?
            WHERE id = ?
            """,
            (name, now, score, verdict, report_json, error, existing["id"]),
        )
        skill_id = existing["id"]
    else:
        cur = conn.execute(
            """
            INSERT INTO skills (source, name, first_scanned, last_scanned,
                                 score, verdict, status, report_json, error)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
            """,
            (source, name, now, now, score, verdict, report_json, error),
        )
        skill_id = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def list_skills() -> list[dict[str, Any]]:
    conn = get_conn()
    rows = conn.execute("SELECT * FROM skills ORDER BY last_scanned DESC").fetchall()
    conn.close()
    return [_row_to_dict(r) for r in rows]


def get_skill(skill_id: int) -> Optional[dict[str, Any]]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
    conn.close()
    return _row_to_dict(row) if row else None


def set_status(skill_id: int, status: str) -> Optional[dict[str, Any]]:
    conn = get_conn()
    conn.execute("UPDATE skills SET status = ? WHERE id = ?", (status, skill_id))
    conn.commit()
    row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
    conn.close()
    return _row_to_dict(row) if row else None


def delete_skill(skill_id: int) -> bool:
    conn = get_conn()
    cur = conn.execute("DELETE FROM skills WHERE id = ?", (skill_id,))
    conn.commit()
    conn.close()
    return cur.rowcount > 0

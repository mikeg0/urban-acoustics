"""SQLite store-and-forward for telemetry, health, and event uploads.

This is the persistence layer that lets the device survive WiFi outages
and reboots without losing data. Two tables:

* ``mqtt_queue`` — pending MQTT publishes (telemetry, health, event/announce,
  event/done). Ordered FIFO. Lower-priority rows are pruned first when the
  on-disk cap is hit; event-related rows are pruned last.

* ``event_uploads`` — pending event payloads with their FLAC bytes spooled
  to disk under ``audio_dir``. Holds intent/PUT/done state across crashes.

The schema is intentionally tiny — exactly the columns the supervisor reads
back on retry. Anything elaborate (priorities, tags, ACK ledgers) belongs in
a real broker, not on a Pi Zero.

Concurrency: a single :class:`QueueStore` instance is shared between the
supervisor coroutines. SQLite WAL plus a per-instance asyncio lock is
sufficient for our write rate (<10 ops/sec).
"""

from __future__ import annotations

import asyncio
import json
import logging
import pathlib
import sqlite3
import time
from dataclasses import dataclass


log = logging.getLogger(__name__)


# Lower priority is pruned first. Event-related rows stay last.
PRIO_TELEMETRY = 0
PRIO_HEALTH = 1
PRIO_EVENT_ANNOUNCE = 2
PRIO_EVENT_DONE = 3


_SCHEMA = """
CREATE TABLE IF NOT EXISTS mqtt_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic       TEXT NOT NULL,
    payload     TEXT NOT NULL,
    qos         INTEGER NOT NULL DEFAULT 0,
    priority    INTEGER NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_mqtt_queue_due ON mqtt_queue(next_attempt_at, id);

CREATE TABLE IF NOT EXISTS event_uploads (
    event_id    TEXT PRIMARY KEY,
    ts          REAL NOT NULL,
    duration_s  REAL NOT NULL,
    peak_db     REAL NOT NULL,
    sha256      TEXT NOT NULL,
    size        INTEGER NOT NULL,
    flac_path   TEXT NOT NULL,
    status      TEXT NOT NULL,           -- 'pending' | 'uploaded' | 'done'
    storage_key TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at REAL NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL,
    -- Pi-side classifier prelim. All three set or all three NULL.
    prelim_classification TEXT,
    prelim_confidence     REAL,
    prelim_model_version  TEXT
);
CREATE INDEX IF NOT EXISTS ix_event_uploads_due ON event_uploads(status, next_attempt_at);
"""

# Columns we ADD via ALTER TABLE on existing databases. SQLite has no
# IF NOT EXISTS form for ADD COLUMN, so we probe pragma_table_info first.
_EVENT_UPLOAD_OPTIONAL_COLUMNS: tuple[tuple[str, str], ...] = (
    ("prelim_classification", "TEXT"),
    ("prelim_confidence", "REAL"),
    ("prelim_model_version", "TEXT"),
)


@dataclass(frozen=True)
class QueuedMessage:
    id: int
    topic: str
    payload: str
    qos: int
    attempt_count: int


@dataclass(frozen=True)
class QueuedUpload:
    event_id: str
    ts: float
    duration_s: float
    peak_db: float
    sha256: str
    size: int
    flac_path: pathlib.Path
    status: str
    storage_key: str | None
    attempt_count: int
    # Optional Pi-side prelim classification, attached at materialise
    # time. All three are set together or all are None — the SQLite
    # row stores NULL for "no classifier loaded".
    prelim_classification: str | None = None
    prelim_confidence: float | None = None
    prelim_model_version: str | None = None


def _ensure_event_upload_columns(conn: sqlite3.Connection) -> None:
    """ALTER TABLE on existing dbs so the prelim columns appear.

    SQLite has no ``ADD COLUMN IF NOT EXISTS``, so we read
    ``pragma_table_info`` and only emit ``ADD COLUMN`` for the ones
    missing. Idempotent and safe to call on every open.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(event_uploads)")}
    for name, typ in _EVENT_UPLOAD_OPTIONAL_COLUMNS:
        if name in cols:
            continue
        conn.execute(f"ALTER TABLE event_uploads ADD COLUMN {name} {typ}")


def _backoff_seconds(attempt: int, *, base: float = 2.0, cap: float = 300.0) -> float:
    """Exponential backoff with a cap and no jitter (Pi has no reliable RNG
    early in boot; deterministic backoff is also easier to reason about in
    journalctl)."""
    delay = base * (2 ** max(0, attempt - 1))
    return min(delay, cap)


class QueueStore:
    def __init__(self, db_path: pathlib.Path, *, max_bytes: int) -> None:
        self.db_path = db_path
        self.max_bytes = max_bytes
        self._conn: sqlite3.Connection | None = None
        self._lock = asyncio.Lock()

    # --- lifecycle --------------------------------------------------------

    def open(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(
            self.db_path,
            isolation_level=None,         # autocommit; we manage transactions
            check_same_thread=False,
        )
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.executescript(_SCHEMA)
        _ensure_event_upload_columns(conn)
        self._conn = conn
        log.info("queue store opened at %s (WAL, max_bytes=%d)", self.db_path, self.max_bytes)

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            raise RuntimeError("queue store is not open")
        return self._conn

    # --- MQTT queue -------------------------------------------------------

    async def enqueue_mqtt(self, *, topic: str, payload: str, qos: int, priority: int) -> int:
        async with self._lock:
            await self._enforce_cap()
            now = time.time()
            cur = self.conn.execute(
                "INSERT INTO mqtt_queue(topic, payload, qos, priority, created_at, next_attempt_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (topic, payload, qos, priority, now, now),
            )
            return int(cur.lastrowid)

    async def pop_due_mqtt(self, *, now: float, limit: int = 32) -> list[QueuedMessage]:
        async with self._lock:
            rows = self.conn.execute(
                "SELECT id, topic, payload, qos, attempt_count FROM mqtt_queue "
                "WHERE next_attempt_at <= ? ORDER BY priority DESC, id ASC LIMIT ?",
                (now, limit),
            ).fetchall()
        return [QueuedMessage(*r) for r in rows]

    async def ack_mqtt(self, message_id: int) -> None:
        async with self._lock:
            self.conn.execute("DELETE FROM mqtt_queue WHERE id = ?", (message_id,))

    async def fail_mqtt(self, message_id: int) -> None:
        async with self._lock:
            row = self.conn.execute(
                "SELECT attempt_count FROM mqtt_queue WHERE id = ?", (message_id,),
            ).fetchone()
            if row is None:
                return
            attempts = int(row[0]) + 1
            self.conn.execute(
                "UPDATE mqtt_queue SET attempt_count = ?, next_attempt_at = ? WHERE id = ?",
                (attempts, time.time() + _backoff_seconds(attempts), message_id),
            )

    # --- event uploads ----------------------------------------------------

    async def add_event_upload(
        self,
        *,
        event_id: str,
        ts: float,
        duration_s: float,
        peak_db: float,
        sha256: str,
        size: int,
        flac_path: pathlib.Path,
        prelim_classification: str | None = None,
        prelim_confidence: float | None = None,
        prelim_model_version: str | None = None,
    ) -> None:
        async with self._lock:
            await self._enforce_cap()
            now = time.time()
            self.conn.execute(
                "INSERT OR REPLACE INTO event_uploads "
                "(event_id, ts, duration_s, peak_db, sha256, size, flac_path, status, "
                " storage_key, attempt_count, next_attempt_at, created_at, updated_at, "
                " prelim_classification, prelim_confidence, prelim_model_version) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, ?, ?, ?, ?, ?, ?)",
                (
                    event_id, ts, duration_s, peak_db, sha256, size, str(flac_path),
                    now, now, now,
                    prelim_classification, prelim_confidence, prelim_model_version,
                ),
            )

    async def list_pending_uploads(self, *, now: float, limit: int = 8) -> list[QueuedUpload]:
        async with self._lock:
            rows = self.conn.execute(
                "SELECT event_id, ts, duration_s, peak_db, sha256, size, flac_path, "
                "status, storage_key, attempt_count, "
                "prelim_classification, prelim_confidence, prelim_model_version "
                "FROM event_uploads WHERE status != 'done' AND next_attempt_at <= ? "
                "ORDER BY created_at ASC LIMIT ?",
                (now, limit),
            ).fetchall()
        out: list[QueuedUpload] = []
        for r in rows:
            out.append(
                QueuedUpload(
                    event_id=r[0], ts=r[1], duration_s=r[2], peak_db=r[3],
                    sha256=r[4], size=r[5], flac_path=pathlib.Path(r[6]),
                    status=r[7], storage_key=r[8], attempt_count=r[9],
                    prelim_classification=r[10],
                    prelim_confidence=r[11],
                    prelim_model_version=r[12],
                )
            )
        return out

    async def mark_upload_progress(
        self, event_id: str, *, status: str, storage_key: str | None = None,
    ) -> None:
        async with self._lock:
            now = time.time()
            if storage_key is not None:
                self.conn.execute(
                    "UPDATE event_uploads SET status = ?, storage_key = ?, "
                    "updated_at = ?, next_attempt_at = 0 WHERE event_id = ?",
                    (status, storage_key, now, event_id),
                )
            else:
                self.conn.execute(
                    "UPDATE event_uploads SET status = ?, updated_at = ?, "
                    "next_attempt_at = 0 WHERE event_id = ?",
                    (status, now, event_id),
                )

    async def fail_upload(self, event_id: str) -> None:
        async with self._lock:
            row = self.conn.execute(
                "SELECT attempt_count FROM event_uploads WHERE event_id = ?", (event_id,),
            ).fetchone()
            if row is None:
                return
            attempts = int(row[0]) + 1
            self.conn.execute(
                "UPDATE event_uploads SET attempt_count = ?, next_attempt_at = ?, "
                "updated_at = ? WHERE event_id = ?",
                (attempts, time.time() + _backoff_seconds(attempts), time.time(), event_id),
            )

    async def remove_event_upload(self, event_id: str) -> pathlib.Path | None:
        async with self._lock:
            row = self.conn.execute(
                "SELECT flac_path FROM event_uploads WHERE event_id = ?", (event_id,),
            ).fetchone()
            if row is None:
                return None
            self.conn.execute("DELETE FROM event_uploads WHERE event_id = ?", (event_id,))
            return pathlib.Path(row[0])

    # --- stats / pressure -------------------------------------------------

    async def stats(self) -> tuple[int, int]:
        async with self._lock:
            row = self.conn.execute(
                "SELECT (SELECT COUNT(*) FROM mqtt_queue) + (SELECT COUNT(*) FROM event_uploads), "
                "       (SELECT IFNULL(SUM(LENGTH(payload)), 0) FROM mqtt_queue) + "
                "       (SELECT IFNULL(SUM(size), 0) FROM event_uploads)"
            ).fetchone()
            return int(row[0]), int(row[1])

    async def _enforce_cap(self) -> None:
        """Prune lowest-priority MQTT rows when the database exceeds the
        configured size cap. Event uploads survive — they are user-visible
        and far more expensive to recreate than a missed telemetry tick.

        Caller must already hold ``self._lock``.
        """
        try:
            on_disk = self.db_path.stat().st_size
        except FileNotFoundError:
            return
        # Quick path: most of the time we're well under.
        if on_disk <= self.max_bytes:
            return
        # Drop the oldest, lowest-priority MQTT messages in batches until
        # we are back under or we run out of non-event rows.
        log.warning("queue: on-disk %d > cap %d; pruning low-priority rows", on_disk, self.max_bytes)
        while True:
            row = self.conn.execute(
                "SELECT id FROM mqtt_queue ORDER BY priority ASC, id ASC LIMIT 100"
            ).fetchall()
            if not row:
                break
            ids = tuple(r[0] for r in row)
            self.conn.execute(
                f"DELETE FROM mqtt_queue WHERE id IN ({','.join('?' * len(ids))})", ids,
            )
            self.conn.execute("VACUUM;")
            try:
                if self.db_path.stat().st_size <= self.max_bytes:
                    break
            except FileNotFoundError:
                break

"""
Zen Sync relay server.

Zero-knowledge: stores only ciphertext blobs + opaque metadata.
Never sees plaintext, keys, or workspace content.

Endpoints:
  POST /api/register            - create account (returns account_id)
  POST /api/devices             - register device under account (requires account)
  GET  /api/devices             - list devices (requires account)
  POST /api/blobs               - publish encrypted blob (requires device)
  GET  /api/blobs               - pull blobs since timestamp (requires device)
  GET  /api/health              - health check
"""
from __future__ import annotations

import os
import sqlite3
import time
import uuid
from collections import defaultdict, deque
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

import base64

from fastapi import FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

# --- config ---
DATA_DIR = Path(os.environ.get("ZENSYNC_DATA_DIR", "/opt/zensync/data"))
DB_PATH = DATA_DIR / "zensync.db"
MAX_BLOB_SIZE = 16 * 1024 * 1024  # 16 MB max per blob (ciphertext)
MAX_BLOBS_PER_ACCOUNT = 10_000
MAX_DEVICES_PER_ACCOUNT = 20
MAX_PULL_RESULTS = 500
NONCE_SIZE = 24  # XChaCha20-Poly1305 IETF nonce
SALT_MIN_SIZE = 16
SALT_MAX_SIZE = 64
RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_MAX_REQUESTS = 60  # per account per window

# Registration gate: if set, /api/register requires this token.
# Generate with: python3 -c "import secrets; print(secrets.token_urlsafe(32))"
REGISTRATION_TOKEN = os.environ.get("ZENSYNC_REG_TOKEN", "")

# --- app ---
app = FastAPI(title="Zen Sync Relay", version="0.2.0")


# --- rate limiter (in-memory, per account) ---
_rate_buckets: dict[str, deque[float]] = defaultdict(deque)
_rate_locks: dict[str, float] = {}
_ip_register_buckets: dict[str, deque[float]] = defaultdict(deque)


def _const_time_eq(a: str, b: str) -> bool:
    """Constant-time string comparison to prevent timing attacks."""
    import hmac
    return hmac.compare_digest(a.encode(), b.encode())


def check_rate_limit(account_id: str) -> None:
    now = time.time()
    bucket = _rate_buckets[account_id]
    while bucket and bucket[0] < now - RATE_LIMIT_WINDOW:
        bucket.popleft()
    if len(bucket) >= RATE_LIMIT_MAX_REQUESTS:
        raise HTTPException(429, "rate limit exceeded")
    bucket.append(now)
    # Periodic cleanup of stale buckets (every ~5 min)
    if len(_rate_buckets) > 1000:
        stale = [k for k, v in _rate_buckets if not v or v[0] < now - RATE_LIMIT_WINDOW * 10]
        for k in stale:
            del _rate_buckets[k]


def check_ip_register_limit(ip: str) -> None:
    """Limit registration requests per IP (prevents DoS on /api/register)."""
    now = time.time()
    bucket = _ip_register_buckets[ip]
    while bucket and bucket[0] < now - 3600:  # 1 hour window
        bucket.popleft()
    if len(bucket) >= 5:  # max 5 registrations per hour per IP
        raise HTTPException(429, "too many registrations from this IP")
    bucket.append(now)


# --- db ---
@contextmanager
def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with get_db() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY,
                salt BLOB NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                created_at REAL NOT NULL,
                last_seen REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS blobs (
                id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                version INTEGER NOT NULL,
                ciphertext BLOB NOT NULL,
                nonce BLOB NOT NULL,
                timestamp REAL NOT NULL,
                size INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_blobs_account_ts
                ON blobs(account_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_devices_account
                ON devices(account_id);
            """
        )


@app.on_event("startup")
def _startup():
    init_db()


# --- models ---
class RegisterRequest(BaseModel):
    salt: str = Field(..., description="Argon2id salt, base64-encoded")
    token: str = Field("", description="Registration token (required if ZENSYNC_REG_TOKEN is set)")

    @field_validator("salt")
    @classmethod
    def validate_salt(cls, v: str) -> str:
        try:
            decoded = base64.b64decode(v)
        except Exception:
            raise ValueError("salt must be valid base64")
        if len(decoded) < SALT_MIN_SIZE:
            raise ValueError(f"salt must be at least {SALT_MIN_SIZE} bytes")
        if len(decoded) > SALT_MAX_SIZE:
            raise ValueError(f"salt must be at most {SALT_MAX_SIZE} bytes")
        return v


class RegisterResponse(BaseModel):
    account_id: str


class DeviceRequest(BaseModel):
    name: str = Field(..., max_length=100)


class DeviceResponse(BaseModel):
    device_id: str
    name: str
    created_at: float
    last_seen: float


class PublishBlobRequest(BaseModel):
    version: int = Field(..., ge=0)
    ciphertext: str
    nonce: str

    @field_validator("nonce")
    @classmethod
    def validate_nonce(cls, v: str) -> str:
        try:
            decoded = base64.b64decode(v)
        except Exception:
            raise ValueError("nonce must be valid base64")
        if len(decoded) != NONCE_SIZE:
            raise ValueError(f"nonce must be exactly {NONCE_SIZE} bytes")
        return v

    @field_validator("ciphertext")
    @classmethod
    def validate_ciphertext_size(cls, v: str) -> str:
        try:
            decoded = base64.b64decode(v)
        except Exception:
            raise ValueError("ciphertext must be valid base64")
        if len(decoded) > MAX_BLOB_SIZE:
            raise ValueError(f"ciphertext exceeds {MAX_BLOB_SIZE} bytes")
        if len(decoded) == 0:
            raise ValueError("ciphertext must not be empty")
        return v


class BlobEntry(BaseModel):
    blob_id: str
    device_id: str
    device_name: str
    version: int
    ciphertext: str
    nonce: str
    timestamp: float
    size: int


# --- auth helpers ---
def require_account(x_account_id: Optional[str] = Header(None)) -> str:
    if not x_account_id:
        raise HTTPException(401, "missing X-Account-Id header")
    with get_db() as conn:
        row = conn.execute(
            "SELECT id FROM accounts WHERE id = ?", (x_account_id,)
        ).fetchone()
    if not row:
        raise HTTPException(403, "invalid account")
    check_rate_limit(x_account_id)
    return x_account_id


def require_device(
    x_account_id: Optional[str] = Header(None),
    x_device_id: Optional[str] = Header(None),
) -> tuple[str, str]:
    account_id = require_account(x_account_id)
    if not x_device_id:
        raise HTTPException(401, "missing X-Device-Id header")
    with get_db() as conn:
        row = conn.execute(
            "SELECT id FROM devices WHERE id = ? AND account_id = ?",
            (x_device_id, account_id),
        ).fetchone()
    if not row:
        raise HTTPException(403, "invalid device for account")
    with get_db() as conn:
        conn.execute(
            "UPDATE devices SET last_seen = ? WHERE id = ?",
            (time.time(), x_device_id),
        )
    return account_id, x_device_id


# --- routes ---
@app.get("/api/health")
def health():
    return {"status": "ok", "version": app.version}


@app.post("/api/register", response_model=RegisterResponse)
def register(req: RegisterRequest, request: Request):
    # Gate: if registration token is configured, require it
    if REGISTRATION_TOKEN:
        if not req.token or not _const_time_eq(req.token, REGISTRATION_TOKEN):
            raise HTTPException(403, "registration closed")
    # IP rate limit (prevents DoS via repeated registration)
    check_ip_register_limit(request.client.host if request.client else "0.0.0.0")
    account_id = str(uuid.uuid4())
    salt_bytes = base64.b64decode(req.salt)
    with get_db() as conn:
        conn.execute(
            "INSERT INTO accounts (id, salt, created_at) VALUES (?, ?, ?)",
            (account_id, salt_bytes, time.time()),
        )
    return RegisterResponse(account_id=account_id)


@app.post("/api/devices", response_model=DeviceResponse)
def register_device(
    req: DeviceRequest,
    account_id: str = Header(..., alias="X-Account-Id"),
):
    account_id = require_account(account_id)

    with get_db() as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM devices WHERE account_id = ?", (account_id,)
        ).fetchone()[0]
        if count >= MAX_DEVICES_PER_ACCOUNT:
            raise HTTPException(403, f"max {MAX_DEVICES_PER_ACCOUNT} devices per account")

        device_id = str(uuid.uuid4())
        now = time.time()
        conn.execute(
            "INSERT INTO devices (id, account_id, name, created_at, last_seen) "
            "VALUES (?, ?, ?, ?, ?)",
            (device_id, account_id, req.name, now, now),
        )
        row = conn.execute(
            "SELECT * FROM devices WHERE id = ?", (device_id,)
        ).fetchone()
    return DeviceResponse(
        device_id=row["id"],
        name=row["name"],
        created_at=row["created_at"],
        last_seen=row["last_seen"],
    )


@app.get("/api/devices", response_model=list[DeviceResponse])
def list_devices(account_id: str = Header(..., alias="X-Account-Id")):
    account_id = require_account(account_id)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM devices WHERE account_id = ? ORDER BY created_at",
            (account_id,),
        ).fetchall()
    return [
        DeviceResponse(
            device_id=r["id"],
            name=r["name"],
            created_at=r["created_at"],
            last_seen=r["last_seen"],
        )
        for r in rows
    ]


@app.post("/api/blobs")
def publish_blob(
    req: PublishBlobRequest,
    account_id: str = Header(..., alias="X-Account-Id"),
    device_id: str = Header(..., alias="X-Device-Id"),
):
    account_id, device_id = require_device(account_id, device_id)

    blob_id = str(uuid.uuid4())
    now = time.time()
    ciphertext_bytes = base64.b64decode(req.ciphertext)
    nonce_bytes = base64.b64decode(req.nonce)

    with get_db() as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM blobs WHERE account_id = ?", (account_id,)
        ).fetchone()[0]
        if count >= MAX_BLOBS_PER_ACCOUNT:
            conn.execute(
                "DELETE FROM blobs WHERE id IN ("
                "  SELECT id FROM blobs WHERE account_id = ? "
                "  ORDER BY timestamp ASC LIMIT 1"
                ")",
                (account_id,),
            )

        conn.execute(
            "INSERT INTO blobs (id, account_id, device_id, version, "
            "ciphertext, nonce, timestamp, size) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                blob_id,
                account_id,
                device_id,
                req.version,
                ciphertext_bytes,
                nonce_bytes,
                now,
                len(ciphertext_bytes),
            ),
        )

    return {"blob_id": blob_id, "timestamp": now}


@app.get("/api/blobs", response_model=list[BlobEntry])
def pull_blobs(
    request: Request,
    response: Response,
    account_id: str = Header(..., alias="X-Account-Id"),
    device_id: str = Header(..., alias="X-Device-Id"),
    since: float = 0.0,
    limit: int = MAX_PULL_RESULTS,
):
    account_id, device_id = require_device(account_id, device_id)

    if since < 0:
        since = 0.0
    limit = max(1, min(limit, MAX_PULL_RESULTS))

    with get_db() as conn:
        rows = conn.execute(
            "SELECT b.*, d.name as device_name FROM blobs b "
            "JOIN devices d ON b.device_id = d.id "
            "WHERE b.account_id = ? AND b.device_id != ? "
            "AND b.timestamp > ? "
            "ORDER BY b.timestamp ASC "
            "LIMIT ?",
            (account_id, device_id, since, limit + 1),
        ).fetchall()

    has_more = len(rows) > limit
    rows = rows[:limit]

    result = [
        BlobEntry(
            blob_id=r["id"],
            device_id=r["device_id"],
            device_name=r["device_name"],
            version=r["version"],
            ciphertext=base64.b64encode(r["ciphertext"]).decode(),
            nonce=base64.b64encode(r["nonce"]).decode(),
            timestamp=r["timestamp"],
            size=r["size"],
        )
        for r in rows
    ]

    response.headers["X-Has-More"] = "true" if has_more else "false"
    return result

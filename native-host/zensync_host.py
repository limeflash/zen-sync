"""
Zen Sync native messaging host.

Communicates with the WebExtension via Mozilla native messaging (stdio JSON).
Reads Zen Browser profile data, encrypts it end-to-end, and syncs via the relay.

Responsibilities:
  - READ:  extract workspaces, tabs, groups, pinned, containers, folders from profile
  - CRYPTO: derive key (Argon2id), encrypt/decrypt (XChaCha20-Poly1305)
  - SYNC:  publish/pull encrypted blobs to/from relay
  - WRITE: apply remote state to local profile (phase 2)
"""
from __future__ import annotations

import json
import struct
import sys
import os
import base64
import time
from pathlib import Path
from typing import Any

# --- native messaging protocol ---


def read_message() -> dict[str, Any]:
    """Read a single native message from stdin (length-prefixed JSON).

    Enforces a max message size to prevent OOM from malicious length prefixes.
    Mozilla native messaging spec limits messages to 1 MB.
    """
    MAX_MSG_SIZE = 1 * 1024 * 1024  # 1 MB

    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return {}
    msg_len = struct.unpack("<I", raw_len)[0]
    if msg_len == 0:
        return {}
    if msg_len > MAX_MSG_SIZE:
        raise ValueError(f"message too large: {msg_len} bytes (max {MAX_MSG_SIZE})")
    data = sys.stdin.buffer.read(msg_len)
    if len(data) < msg_len:
        return {}
    return json.loads(data.decode("utf-8"))


def send_message(msg: dict[str, Any]) -> None:
    """Send a native message to stdout (length-prefixed JSON)."""
    data = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# --- profile discovery ---


def find_zen_profile() -> Path | None:
    """Find the active Zen Browser profile directory."""
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", "")) / "Zen"
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "Zen"
    else:
        base = Path.home() / ".zen"

    if not base.exists():
        return None

    profiles_ini = base / "profiles.ini"
    if not profiles_ini.exists():
        return None

    import configparser

    config = configparser.ConfigParser()
    config.read(profiles_ini)

    # Collect all profiles
    profiles: list[Path] = []
    for section in config.sections():
        if not section.startswith("Profile"):
            continue
        path_str = config.get(section, "Path", fallback=None)
        if not path_str:
            continue
        if config.getboolean(section, "IsRelative", fallback=True):
            profile_path = base / path_str
        else:
            profile_path = Path(path_str)
        if profile_path.exists():
            profiles.append(profile_path)

    if not profiles:
        return None

    # Prefer the profile with the most recently modified zen-sessions.jsonlz4
    # (the Default flag in profiles.ini can be wrong / stale)
    best: Path | None = None
    best_mtime: float = 0
    for p in profiles:
        zen_sessions = p / "zen-sessions.jsonlz4"
        if zen_sessions.exists():
            mtime = zen_sessions.stat().st_mtime
            if mtime > best_mtime:
                best_mtime = mtime
                best = p

    if best:
        return best

    # Fallback: Install section default, then Default=1, then first profile
    for section in config.sections():
        if section.startswith("Install") and config.has_option(section, "Default"):
            path_str = config.get(section, "Default")
            p = base / path_str if not Path(path_str).is_absolute() else Path(path_str)
            if p.exists():
                return p

    for section in config.sections():
        if not section.startswith("Profile"):
            continue
        if config.getboolean(section, "Default", fallback=False):
            path_str = config.get(section, "Path", fallback=None)
            if path_str:
                p = base / path_str if config.getboolean(section, "IsRelative", fallback=True) else Path(path_str)
                if p.exists():
                    return p

    return profiles[0]


# --- mozlz4 decompression ---


def read_mozlz4(path: Path, fail_closed: bool = False) -> Any:
    """Read and decompress a Mozilla .jsonlz4 file, returning parsed JSON.

    Args:
        path: file to read
        fail_closed: if True (for primary session store), raise on corruption
                     instead of returning {} — prevents publishing empty state

    Guards against decompression bombs by capping uncompressed size.
    """
    import lz4.block
    import struct

    MAX_UNCOMPRESSED_SIZE = 64 * 1024 * 1024  # 64 MB

    try:
        data = path.read_bytes()
        magic = data[:8]
        if magic != b"mozLz40\x00":
            if fail_closed:
                raise ValueError("session file has invalid magic — refusing to publish empty state")
            return {}
        uncompressed_size = struct.unpack("<I", data[8:12])[0]
        if uncompressed_size > MAX_UNCOMPRESSED_SIZE:
            if fail_closed:
                raise ValueError("session file exceeds size limit — refusing to publish")
            return {}
        decompressed = lz4.block.decompress(data[12:], uncompressed_size=uncompressed_size)
        return json.loads(decompressed.decode("utf-8"))
    except Exception as e:
        if fail_closed:
            raise
        # Non-critical files (recovery backup, live folders) — return empty
        return {}


def write_mozlz4(path: Path, data: dict[str, Any]) -> None:
    """Compress JSON to Mozilla .jsonlz4 format and write to file.

    Format: 8-byte magic (mozLz40\\0) + 4-byte LE uncompressed size + LZ4 block.
    Uses store_size=False — Mozilla stores size in the 4-byte header, not in LZ4 block.
    """
    import lz4.block
    import struct

    raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
    compressed = lz4.block.compress(raw, store_size=False)
    header = b"mozLz40\x00" + struct.pack("<I", len(raw))
    path.write_bytes(header + compressed)


def is_zen_running() -> bool:
    """Detect if Zen Browser is currently running."""
    import subprocess
    system = platform.system()
    try:
        if system == "Windows":
            result = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq zen.exe", "/NH"],
                capture_output=True, text=True, timeout=5
            )
            return "zen.exe" in result.stdout.lower()
        elif system == "Darwin":
            result = subprocess.run(
                ["pgrep", "-x", "zen"],
                capture_output=True, text=True, timeout=5
            )
            return result.returncode == 0
        else:
            result = subprocess.run(
                ["pgrep", "-x", "zen"],
                capture_output=True, text=True, timeout=5
            )
            return result.returncode == 0
    except Exception:
        # If detection fails, assume running (fail-closed — don't risk overwriting)
        return True


# --- data extraction ---


def extract_state(profile_path: Path) -> dict[str, Any]:
    """Extract all syncable state from the Zen Browser profile.

    Returns a dict with keys: spaces, tabs, groups, folders, containers,
    split_views, active_space, timestamp, source_device.
    """
    # Primary source: zen-sessions.jsonlz4 (Zen-specific session store)
    # fail_closed=True: if this is corrupt, refuse to publish (don't overwrite with empty)
    zen_sessions = profile_path / "zen-sessions.jsonlz4"
    session_data: dict[str, Any] = {}
    if zen_sessions.exists():
        session_data = read_mozlz4(zen_sessions, fail_closed=True)

    # Firefox session store (for activeZenSpace + window-level data)
    active_space = None
    recovery = profile_path / "sessionstore-backups" / "recovery.jsonlz4"
    if recovery.exists():
        recovery_data = read_mozlz4(recovery)
        windows = recovery_data.get("windows", [])
        if windows:
            active_space = windows[0].get("activeZenSpace")

    # Container definitions
    containers = []
    containers_file = profile_path / "containers.json"
    if containers_file.exists():
        containers_raw = json.loads(containers_file.read_text("utf-8"))
        for identity in containers_raw.get("identities", []):
            if identity.get("public", False):
                containers.append(
                    {
                        "userContextId": identity.get("userContextId"),
                        "name": identity.get("name"),
                        "icon": identity.get("icon"),
                        "color": identity.get("color"),
                    }
                )

    # Build tab entries (strip heavy fields, keep sync-relevant data)
    raw_tabs = session_data.get("tabs", [])
    tabs = []
    for t in raw_tabs:
        entries = t.get("entries", [])
        # Use the session's 'index' field to select the current entry
        # Firefox/Zen stores 1-based index of current history entry
        idx = t.get("index", len(entries))
        if idx and 1 <= idx <= len(entries):
            current_entry = entries[idx - 1]
        elif entries:
            current_entry = entries[-1]
        else:
            current_entry = {}
        tabs.append(
            {
                "zenSyncId": t.get("zenSyncId"),
                "zenWorkspace": t.get("zenWorkspace"),
                "url": current_entry.get("url", ""),
                "title": current_entry.get("title", ""),
                "pinned": t.get("pinned", False),
                "zenEssential": t.get("zenEssential", False),
                "zenPinnedIcon": t.get("zenPinnedIcon"),
                "userContextId": t.get("userContextId", 0),
                "groupId": t.get("groupId"),
                "zenGlanceId": t.get("zenGlanceId"),
                "zenIsGlance": t.get("zenIsGlance", False),
                "zenLiveFolderItemId": t.get("zenLiveFolderItemId"),
                "lastAccessed": t.get("lastAccessed", 0),
            }
        )

    # Spaces (workspaces)
    spaces = []
    for s in session_data.get("spaces", []):
        spaces.append(
            {
                "uuid": s.get("uuid"),
                "name": s.get("name"),
                "icon": s.get("icon"),
                "theme": s.get("theme"),
                "containerTabId": s.get("containerTabId", 0),
            }
        )

    # Tab groups
    groups = []
    for g in session_data.get("groups", []):
        groups.append(
            {
                "id": g.get("id"),
                "name": g.get("name"),
                "color": g.get("color"),
                "collapsed": g.get("collapsed", False),
                "pinned": g.get("pinned", False),
                "splitView": g.get("splitView", False),
            }
        )

    # Tab folders (Zen feature)
    folders = []
    for f in session_data.get("folders", []):
        folders.append(
            {
                "id": f.get("id"),
                "name": f.get("name"),
                "workspaceId": f.get("workspaceId"),
                "parentId": f.get("parentId"),
                "emptyTabIds": f.get("emptyTabIds", []),
                "userIcon": f.get("userIcon", ""),
                "collapsed": f.get("collapsed", False),
                "pinned": f.get("pinned", False),
            }
        )

    # Split views
    split_views = session_data.get("splitViewData", [])

    return {
        "spaces": spaces,
        "active_space": active_space,
        "tabs": tabs,
        "groups": groups,
        "folders": folders,
        "containers": containers,
        "split_views": split_views,
        "timestamp": time.time(),
    }


# --- crypto (E2E) ---


def derive_key(passphrase: str, salt: bytes) -> bytes:
    """Derive a 32-byte encryption key from passphrase + salt using Argon2id."""
    try:
        from argon2.low_level import hash_secret_raw, Type
    except ImportError:
        raise RuntimeError("argon2-cffi not installed")

    return hash_secret_raw(
        secret=passphrase.encode("utf-8"),
        salt=salt,
        time_cost=3,
        memory_cost=65536,  # 64 MB
        parallelism=4,
        hash_len=32,
        type=Type.ID,
    )


def derive_auth_token(enc_key: bytes) -> bytes:
    """Derive a separate auth token from the encryption key via HMAC-SHA256.

    The auth token is sent to the server for authentication.
    The server stores only a hash of it — never the encryption key.
    """
    import hashlib
    import hmac
    return hmac.new(enc_key, b"zensync_auth_token", hashlib.sha256).digest()


def derive_auth_token_hash(auth_token: bytes) -> str:
    """Hash the auth token for server-side storage (bcrypt-like via SHA256 + salt).

    The server stores this hash. Even if the server DB leaks,
    the auth token (and thus the encryption key) cannot be recovered.
    """
    import hashlib
    return hashlib.sha256(auth_token + b"zensync_server_salt").hexdigest()


def encrypt(key: bytes, plaintext: bytes) -> tuple[bytes, bytes]:
    """Encrypt with XChaCha20-Poly1305. Returns (ciphertext, nonce)."""
    try:
        from nacl.bindings import crypto_aead_xchacha20poly1305_ietf_encrypt
        from nacl.utils import random
    except ImportError:
        raise RuntimeError("pynacl not installed")

    nonce = random(24)  # XChaCha20 uses 24-byte nonce
    ciphertext = crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, None, nonce, key)
    return ciphertext, nonce


def decrypt(key: bytes, ciphertext: bytes, nonce: bytes) -> bytes:
    """Decrypt XChaCha20-Poly1305."""
    try:
        from nacl.bindings import crypto_aead_xchacha20poly1305_ietf_decrypt
    except ImportError:
        raise RuntimeError("pynacl not installed")

    return crypto_aead_xchacha20poly1305_ietf_decrypt(ciphertext, None, nonce, key)


# --- keyring (OS-secure storage for derived key) ---


def store_key(account_id: str, passphrase: str, salt: bytes) -> bool:
    """Derive key from passphrase and store in OS keyring. Passphrase is NOT stored.

    Raises RuntimeError if keyring is unavailable — no plaintext fallback.
    """
    key = derive_key(passphrase, salt)
    try:
        import keyring
        keyring.set_password("zensync", account_id, key.hex())
        return True
    except Exception as e:
        raise RuntimeError(
            f"System keyring is unavailable. Key cannot be stored securely. "
            f"Install keyring backend (e.g. on Linux: dbus, gnome-keyring). Error: {e}"
        )


def get_key(account_id: str) -> bytes | None:
    """Retrieve derived key from OS keyring."""
    try:
        import keyring
        hex_key = keyring.get_password("zensync", account_id)
        if hex_key:
            return bytes.fromhex(hex_key)
    except Exception:
        pass
    return None


def delete_key(account_id: str) -> bool:
    """Remove key from keyring."""
    try:
        import keyring
        keyring.delete_password("zensync", account_id)
    except Exception:
        pass
    return True


# --- message handling ---


def handle_message(msg: dict[str, Any]) -> dict[str, Any]:
    """Dispatch a native messaging request."""
    action = msg.get("action")

    if action == "ping":
        return {"ok": True, "pong": True}

    if action == "extract":
        profile = find_zen_profile()
        if not profile:
            return {"ok": False, "error": "no Zen profile found"}
        state = extract_state(profile)
        return {"ok": True, "state": state}

    if action == "store_key":
        account_id = msg.get("accountId", "")
        passphrase = msg.get("passphrase", "")
        salt_b64 = msg.get("salt", "")
        if not all([account_id, passphrase, salt_b64]):
            return {"ok": False, "error": "accountId, passphrase, and salt are required"}
        salt = base64.b64decode(salt_b64)
        store_key(account_id, passphrase, salt)
        return {"ok": True}

    if action == "derive_auth":
        """Derive auth token + hash from passphrase+salt for server registration/auth.
        Returns auth_token (hex, sent to server on every request) and auth_hash
        (sent once at registration, server stores only the hash)."""
        passphrase = msg.get("passphrase", "")
        salt_b64 = msg.get("salt", "")
        if not all([passphrase, salt_b64]):
            return {"ok": False, "error": "passphrase and salt are required"}
        salt = base64.b64decode(salt_b64)
        enc_key = derive_key(passphrase, salt)
        auth_token = derive_auth_token(enc_key)
        auth_hash = derive_auth_token_hash(auth_token)
        return {
            "ok": True,
            "auth_token": auth_token.hex(),
            "auth_hash": auth_hash,
        }

    if action == "get_auth_token":
        """Get stored auth token from keyring (derived at setup time)."""
        account_id = msg.get("accountId", "")
        if not account_id:
            return {"ok": False, "error": "accountId is required"}
        # auth token is stored alongside enc key in keyring
        try:
            import keyring
            auth_hex = keyring.get_password("zensync_auth", account_id)
            if auth_hex:
                return {"ok": True, "auth_token": auth_hex}
        except Exception:
            pass
        return {"ok": False, "error": "auth token not found in keyring"}

    if action == "store_auth_token":
        """Store auth token in keyring separately from enc key."""
        account_id = msg.get("accountId", "")
        auth_token_hex = msg.get("authToken", "")
        if not all([account_id, auth_token_hex]):
            return {"ok": False, "error": "accountId and authToken are required"}
        try:
            import keyring
            keyring.set_password("zensync_auth", account_id, auth_token_hex)
            return {"ok": True}
        except Exception as e:
            raise RuntimeError(f"keyring unavailable: {e}")

    if action == "has_key":
        account_id = msg.get("accountId", "")
        if not account_id:
            return {"ok": False, "error": "accountId is required"}
        key = get_key(account_id)
        return {"ok": True, "has_key": key is not None}

    if action == "encrypt":
        account_id = msg.get("accountId", "")
        data = json.dumps(msg.get("data", {})).encode("utf-8")

        # Try to use stored key (from keyring), fall back to passphrase+salt
        key = None
        if account_id:
            key = get_key(account_id)
        if key is None:
            passphrase = msg.get("passphrase", "")
            salt_b64 = msg.get("salt", "")
            if not salt_b64:
                return {"ok": False, "error": "salt is required (must be shared across all devices)"}
            if not passphrase:
                return {"ok": False, "error": "passphrase is required (or run store_key first)"}
            salt = base64.b64decode(salt_b64)
            if len(salt) < 16:
                return {"ok": False, "error": "salt must be at least 16 bytes"}
            key = derive_key(passphrase, salt)

        ciphertext, nonce = encrypt(key, data)
        return {
            "ok": True,
            "ciphertext": base64.b64encode(ciphertext).decode(),
            "nonce": base64.b64encode(nonce).decode(),
        }

    if action == "decrypt":
        account_id = msg.get("accountId", "")
        ciphertext_b64 = msg.get("ciphertext", "")
        nonce_b64 = msg.get("nonce", "")
        if not all([ciphertext_b64, nonce_b64]):
            return {"ok": False, "error": "ciphertext and nonce are required"}

        # Try stored key, fall back to passphrase+salt
        key = None
        if account_id:
            key = get_key(account_id)
        if key is None:
            passphrase = msg.get("passphrase", "")
            salt_b64 = msg.get("salt", "")
            if not all([salt_b64, passphrase]):
                return {"ok": False, "error": "stored key not found; passphrase+salt required"}
            salt = base64.b64decode(salt_b64)
            key = derive_key(passphrase, salt)

        ciphertext = base64.b64decode(ciphertext_b64)
        nonce = base64.b64decode(nonce_b64)
        if len(nonce) != 24:
            return {"ok": False, "error": "nonce must be 24 bytes"}
        plaintext = decrypt(key, ciphertext, nonce)
        return {"ok": True, "data": json.loads(plaintext.decode("utf-8"))}

    if action == "delete_key":
        account_id = msg.get("accountId", "")
        if not account_id:
            return {"ok": False, "error": "accountId is required"}
        delete_key(account_id)
        return {"ok": True}

    if action == "apply_state":
        """Legacy direct apply — kept for backward compat but not recommended.
        Use stage_apply + commit_staged_apply for safe flow."""
        state = msg.get("state", {})
        if not state:
            return {"ok": False, "error": "state is required"}
        required_keys = {"spaces", "tabs", "groups", "folders"}
        missing = required_keys - set(state.keys())
        if missing:
            return {"ok": False, "error": f"state missing keys: {missing}"}
        if len(state.get("tabs", [])) == 0 and len(state.get("spaces", [])) == 0:
            return {"ok": False, "error": "refusing to apply empty state (no tabs, no spaces)"}
        profile = find_zen_profile()
        if not profile:
            return {"ok": False, "error": "no Zen profile found"}
        import time as _time
        import shutil
        backup_dir = profile / f".zensync_backup_{int(_time.time())}"
        backup_dir.mkdir(exist_ok=True)
        for f in ["zen-sessions.jsonlz4", "sessionstore.jsonlz4", "sessionstore-backups/recovery.jsonlz4", "containers.json"]:
            src = profile / f
            if src.exists():
                shutil.copy2(src, backup_dir / src.name)
        zen_sessions_data = {
            "spaces": state.get("spaces", []),
            "tabs": state.get("tabs", []),
            "groups": state.get("groups", []),
            "folders": state.get("folders", []),
            "splitViewData": state.get("split_views", []),
            "lastCollected": _time.time() * 1000,
        }
        write_mozlz4(profile / "zen-sessions.jsonlz4", zen_sessions_data)
        if state.get("containers"):
            containers_file = profile / "containers.json"
            existing = {}
            if containers_file.exists():
                try:
                    existing = json.loads(containers_file.read_text("utf-8"))
                except Exception:
                    existing = {}
            existing_identities = existing.get("identities", [])
            synced_ids = {c["userContextId"] for c in state["containers"] if c.get("userContextId")}
            kept = [i for i in existing_identities if i.get("userContextId") not in synced_ids]
            existing["identities"] = kept + state["containers"]
            containers_file.write_text(json.dumps(existing, indent=2), encoding="utf-8")
        return {"ok": True, "backup_dir": str(backup_dir), "tabs_written": len(state.get("tabs", [])), "spaces_written": len(state.get("spaces", [])), "message": "State applied. Restart Zen Browser to see changes. Backup saved to: " + str(backup_dir)}

    if action == "is_zen_running":
        return {"ok": True, "running": is_zen_running()}

    if action == "stage_apply":
        """Stage remote state for apply — does NOT modify live profile files.
        Returns staged_apply_id. Use commit_staged_apply after Zen is closed."""
        state = msg.get("state", {})
        if not state:
            return {"ok": False, "error": "state is required"}
        required_keys = {"spaces", "tabs", "groups", "folders"}
        missing = required_keys - set(state.keys())
        if missing:
            return {"ok": False, "error": f"state missing keys: {missing}"}
        if len(state.get("tabs", [])) == 0 and len(state.get("spaces", [])) == 0:
            return {"ok": False, "error": "refusing to stage empty state (no tabs, no spaces)"}
        profile = find_zen_profile()
        if not profile:
            return {"ok": False, "error": "no Zen profile found"}

        import time as _time
        import shutil
        import hashlib as _hl
        stage_id = f"stage_{int(_time.time())}"
        stage_dir = profile / ".zensync_staging" / stage_id
        stage_dir.mkdir(parents=True, exist_ok=True)

        # Backup originals
        backup_manifest = {"timestamp": _time.time(), "files": {}}
        for f in ["zen-sessions.jsonlz4", "sessionstore.jsonlz4", "sessionstore-backups/recovery.jsonlz4", "containers.json"]:
            src = profile / f
            if src.exists():
                dst = stage_dir / "backup" / src.name
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                backup_manifest["files"][f] = {
                    "backup_path": str(dst),
                    "sha256": _hl.sha256(src.read_bytes()).hexdigest(),
                }

        # Prepare replacement zen-sessions.jsonlz4
        zen_sessions_data = {
            "spaces": state.get("spaces", []),
            "tabs": state.get("tabs", []),
            "groups": state.get("groups", []),
            "folders": state.get("folders", []),
            "splitViewData": state.get("split_views", []),
            "lastCollected": _time.time() * 1000,
        }
        write_mozlz4(stage_dir / "zen-sessions.jsonlz4", zen_sessions_data)

        # Prepare containers.json if needed
        if state.get("containers"):
            containers_file = profile / "containers.json"
            existing = {}
            if containers_file.exists():
                try:
                    existing = json.loads(containers_file.read_text("utf-8"))
                except Exception:
                    existing = {}
            existing_identities = existing.get("identities", [])
            synced_ids = {c["userContextId"] for c in state["containers"] if c.get("userContextId")}
            kept = [i for i in existing_identities if i.get("userContextId") not in synced_ids]
            existing["identities"] = kept + state["containers"]
            (stage_dir / "containers.json").write_text(json.dumps(existing, indent=2), encoding="utf-8")

        # Write manifest
        (stage_dir / "manifest.json").write_text(json.dumps({
            **backup_manifest,
            "stage_id": stage_id,
            "profile_path": str(profile),
            "tabs_count": len(state.get("tabs", [])),
            "spaces_count": len(state.get("spaces", [])),
        }, indent=2), encoding="utf-8")

        return {
            "ok": True,
            "stage_id": stage_id,
            "profile_path": str(profile),
            "zen_running": is_zen_running(),
            "tabs_count": len(state.get("tabs", [])),
            "spaces_count": len(state.get("spaces", [])),
            "message": "State staged. Close Zen Browser, then commit.",
        }

    if action == "commit_staged_apply":
        """Commit staged state — only if Zen is NOT running. Atomic replace."""
        stage_id = msg.get("stage_id", "")
        if not stage_id:
            return {"ok": False, "error": "stage_id is required"}
        profile = find_zen_profile()
        if not profile:
            return {"ok": False, "error": "no Zen profile found"}

        if is_zen_running():
            return {"ok": False, "error": "Zen Browser is still running. Close it first, then commit."}

        stage_dir = profile / ".zensync_staging" / stage_id
        if not stage_dir.exists():
            return {"ok": False, "error": f"stage {stage_id} not found"}

        import shutil
        import os as _os

        # Atomic replace: write temp then rename
        staged_zen_sessions = stage_dir / "zen-sessions.jsonlz4"
        if staged_zen_sessions.exists():
            target = profile / "zen-sessions.jsonlz4"
            tmp = target.with_suffix(".jsonlz4.tmp")
            shutil.copy2(staged_zen_sessions, tmp)
            _os.replace(str(tmp), str(target))

        staged_containers = stage_dir / "containers.json"
        if staged_containers.exists():
            target = profile / "containers.json"
            tmp = target.with_suffix(".json.tmp")
            shutil.copy2(staged_containers, tmp)
            _os.replace(str(tmp), str(target))

        # Clean up staging
        shutil.rmtree(stage_dir)

        return {
            "ok": True,
            "message": "State applied successfully. Open Zen Browser to see synced workspaces.",
        }

    if action == "abort_staged_apply":
        """Remove staged state without applying."""
        stage_id = msg.get("stage_id", "")
        if not stage_id:
            return {"ok": False, "error": "stage_id is required"}
        profile = find_zen_profile()
        if not profile:
            return {"ok": False, "error": "no Zen profile found"}
        stage_dir = profile / ".zensync_staging" / stage_id
        if stage_dir.exists():
            import shutil
            shutil.rmtree(stage_dir)
            return {"ok": True, "message": "Staged apply aborted."}
        return {"ok": False, "error": "stage not found"}

    if action == "import_tabs":
        """Return tab data for live import via browser.tabs.create() in extension.
        Non-destructive: extension creates tabs, doesn't close existing ones.
        Does NOT restore workspace assignment (not possible via WebExtension API)."""
        state = msg.get("state", {})
        if not state:
            return {"ok": False, "error": "state is required"}
        tabs = state.get("tabs", [])
        if not tabs:
            return {"ok": False, "error": "no tabs in state"}
        # Return simplified tab list for extension to create
        import_tabs_list = []
        for t in tabs:
            url = t.get("url", "")
            # Skip privileged URLs that Firefox won't open via tabs.create
            if url.startswith(("about:", "chrome:", "resource:", "moz-extension:")):
                continue
            import_tabs_list.append({
                "url": url,
                "title": t.get("title", ""),
                "pinned": t.get("pinned", False),
                "workspace": t.get("zenWorkspace"),
            })
        return {"ok": True, "tabs": import_tabs_list, "count": len(import_tabs_list),
                "skipped": len(tabs) - len(import_tabs_list),
                "note": "Tabs will open in current workspace. Zen workspace assignment not supported via API."}

    return {"ok": False, "error": f"unknown action: {action}"}


def main():
    while True:
        try:
            msg = read_message()
        except Exception:
            break
        if not msg:
            break
        try:
            response = handle_message(msg)
        except Exception as e:
            error_type = type(e).__name__
            # Don't leak file paths or internal details to the extension
            safe_errors = {
                "ValueError": str(e),
                "RuntimeError": str(e),
            }
            response = {"ok": False, "error": safe_errors.get(error_type, f"{error_type}: operation failed")}
        send_message(response)


if __name__ == "__main__":
    main()

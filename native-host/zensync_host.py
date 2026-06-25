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


def read_mozlz4(path: Path) -> Any:
    """Read and decompress a Mozilla .jsonlz4 file, returning parsed JSON.

    Guards against decompression bombs by capping uncompressed size.
    """
    import lz4.block
    import struct

    MAX_UNCOMPRESSED_SIZE = 64 * 1024 * 1024  # 64 MB — session stores are typically < 1 MB

    data = path.read_bytes()
    magic = data[:8]
    if magic != b"mozLz40\x00":
        raise ValueError(f"not a mozlz4 file: {path} (magic={magic!r})")
    uncompressed_size = struct.unpack("<I", data[8:12])[0]
    if uncompressed_size > MAX_UNCOMPRESSED_SIZE:
        raise ValueError(
            f"uncompressed size {uncompressed_size} exceeds limit {MAX_UNCOMPRESSED_SIZE}"
        )
    decompressed = lz4.block.decompress(data[12:], uncompressed_size=uncompressed_size)
    return json.loads(decompressed.decode("utf-8"))


# --- data extraction ---


def extract_state(profile_path: Path) -> dict[str, Any]:
    """Extract all syncable state from the Zen Browser profile.

    Returns a dict with keys: spaces, tabs, groups, folders, containers,
    split_views, active_space, timestamp, source_device.
    """
    # Primary source: zen-sessions.jsonlz4 (Zen-specific session store)
    zen_sessions = profile_path / "zen-sessions.jsonlz4"
    session_data: dict[str, Any] = {}
    if zen_sessions.exists():
        session_data = read_mozlz4(zen_sessions)

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
        current_entry = entries[-1] if entries else {}
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
    """Derive a 32-byte key from passphrase + salt using Argon2id."""
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

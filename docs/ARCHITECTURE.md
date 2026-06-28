# Zen Sync — Architecture & Security Model

Zen Sync is **end-to-end encrypted**. The relay is a dumb, zero-knowledge blob
store; everything sensitive is encrypted and decrypted on the client.

```
 Device A                          Relay (zensync.simg.pro)                Device B
 ┌───────────────┐                 ┌──────────────────────┐               ┌───────────────┐
 │ passphrase    │                 │  Caddy (TLS/HTTP3)    │               │ passphrase    │
 │   │ PBKDF2    │                 │      │               │               │   │ PBKDF2    │
 │   ▼           │   ciphertext    │      ▼               │  ciphertext   │   ▼           │
 │ AES-256-GCM ──┼────────────────▶│  uvicorn / FastAPI   │◀──────────────┼── AES-256-GCM │
 │ (encrypt)     │                 │      │               │               │  (decrypt)    │
 │ workspaces+   │                 │      ▼               │               │ workspaces+   │
 │ tabs          │                 │  SQLite (blobs only) │               │ tabs          │
 └───────────────┘                 └──────────────────────┘               └───────────────┘
```

## Key derivation (client)
From the user passphrase + a random 16-byte salt (Base64), PBKDF2-HMAC-SHA-256
with **100,000 iterations** derives:

- **`encryptionKey`** — a 256-bit AES-GCM key (salt = the raw salt).
- **`authBits`** — 256 bits derived with `salt = saltB64 + "_auth_salt"`. Its
  hex form is the **auth token** sent as `X-Auth-Token`.

At registration the client sends `auth_hash = sha256(authBits || "zensync_server_salt")`.
The server stores only `auth_hash` and the `salt`; it can verify tokens but can
never derive the encryption key.

## Encryption
State is `JSON.stringify({ spaces, tabs, groups, folders, split_views, timestamp })`,
encrypted with **AES-256-GCM** and a fresh random 12-byte nonce per blob. The
relay stores `{ ciphertext, nonce, timestamp }` and nothing else.

## Sync reconciliation (client)
Single-blob, latest-wins, with divergence detection:

1. **Pull** the newest remote blob. If the pull fails, **abort** (never push over
   good server state with stale local data).
2. Collect local state and hash its content (excluding the volatile timestamp).
3. Compare against the last reconciled `timestamp`/hash:
   - remote newer → **apply** it live (workspaces/tabs propagate to all windows);
   - else local changed → **push** it;
   - both changed → conflict, converge on the newer remote (reported in status).
4. A re-entrancy guard coalesces concurrent manual + background (5-min) syncs.

## What the client persists locally
Per Firefox profile (prefs, `zen.sync.*`): relay URL, account id, device id,
salt, the derived **auth token** and **AES key** (never the raw passphrase),
plus last-sync bookkeeping. See `client/modules/ZenSyncService.sys.mjs`.

## Threat model (summary)
- The relay and anyone on the wire see only ciphertext + sizes/timestamps.
- Compromise of the passphrase compromises the data (it derives both keys).
- The derived key persists on disk in the profile to allow headless background
  sync; full-disk encryption / OS account security is assumed.

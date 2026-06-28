# Zen Sync Relay — API

Base URL: the user-configured **Relay URL** (e.g. `https://zensync.simg.pro`).
A TLS proxy (Caddy) sits in front of the FastAPI/uvicorn app; it answers `GET /`
(`zensync relay`) and `GET /health`, while everything under `/api/*` is the app.

All bodies are JSON. Authenticated requests carry:

| Header | Meaning |
| ------ | ------- |
| `X-Account-Id` | Account id returned by `/api/register` |
| `X-Auth-Token` | `hex(authBits)` — derived auth token (see [ARCHITECTURE](ARCHITECTURE.md)) |
| `X-Device-Id`  | This device's id (blob endpoints only) |

Auth check: the server recomputes `sha256(bytes.fromhex(X-Auth-Token) + b"zensync_server_salt")`
and constant-time-compares it to the `auth_hash` stored at registration.

**Limits:** 60 requests/min per account; 5 registrations/hour per IP; ≤20 devices,
≤10 000 blobs and ≤512 MB per account; ≤16 MB per blob.

## Endpoints

### `GET /api/health`
`{ "status": "ok", "version": "..." }`.

### `POST /api/register` → `{ "account_id" }`
**Fail-closed:** returns `403` unless the relay sets `ZENSYNC_REG_TOKEN` (then the
client must send a matching `token`) or `ZENSYNC_ALLOW_OPEN_REGISTRATION=true`.
```json
{ "salt": "<base64, 16–64 bytes>", "auth_hash": "<hex sha256>", "token": "" }
```

### `POST /api/devices`  *(auth)* → `DeviceResponse`
`{ "name": "My Laptop" }` → `{ "device_id", "name", "created_at", "last_seen" }`.

### `GET /api/devices`  *(auth)* → `[DeviceResponse]`
Ordered by `created_at`.

### `PATCH /api/devices/{device_id}`  *(auth)* → `DeviceResponse`
Rename. Body `{ "name": "New Name" }`.

### `DELETE /api/devices/{device_id}`  *(auth)*
Revoke a device and delete its blobs → `{ "ok": true, "message": "device revoked" }`.

### `DELETE /api/account`  *(auth)*
Delete the account; devices + blobs cascade → `{ "ok": true, "message": "account deleted" }`.
*(Added so the client's "Delete Account" works.)*

### `POST /api/blobs`  *(auth + `X-Device-Id`)* → `{ "blob_id", "timestamp" }`
```json
{ "version": 1, "ciphertext": "<base64>", "nonce": "<base64, 12 or 24 bytes>" }
```
`nonce` accepts **12 bytes (AES-256-GCM, the native client)** or 24 bytes
(XChaCha20). The server stamps `timestamp` (epoch seconds, float) and evicts the
oldest blobs when account quotas are exceeded.

### `GET /api/blobs`  *(auth + `X-Device-Id`)* → `[BlobEntry]`
Query: `since` (timestamp, default 0), `since_id` (tie-break cursor), `limit`
(≤500). **Excludes the caller's own device's blobs**, ascending by timestamp.
Each entry: `{ blob_id, device_id, device_name, version, ciphertext, nonce, timestamp, size }`.
Response headers `X-Has-More`, `X-Next-Cursor`, `X-Next-Cursor-Id` page the results.

## Status codes
- `200` success · `403` bad/missing auth or closed registration · `404` unknown
  account/device · `422` validation (missing header/field, bad nonce/ciphertext)
  · `429` rate limited.

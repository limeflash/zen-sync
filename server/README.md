# Zen Sync Relay (server)

The self-hostable **FastAPI** relay behind Zen Sync. It is **zero-knowledge**: it
stores only encrypted blobs + minimal account/device metadata and never sees your
tabs, workspaces, keys, or passphrase. Deploy it behind a TLS proxy
(Caddy → uvicorn → FastAPI + SQLite).

## Files
| File | Purpose |
| ---- | ------- |
| `main.py` | The whole app: models, auth, rate limits, quotas, routes. |
| `requirements.txt` | `fastapi`, `uvicorn`, `pydantic`. |
| `Caddyfile` | Production reverse-proxy (automatic HTTPS). |
| `zensync-relay.service` | systemd unit. |
| `Dockerfile` | Container image. |

## Run locally
```bash
cd server
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export ZENSYNC_DATA_DIR=./data ZENSYNC_ALLOW_OPEN_REGISTRATION=true
uvicorn main:app --reload --port 8000
```
Then set the browser client's **Relay URL** to `http://localhost:8000`.

Sanity check:
```bash
curl -s localhost:8000/api/health        # {"status":"ok",...}
curl -s localhost:8000/api/devices       # 422 (missing X-Account-Id) — auth works
```

## Docker
```bash
docker build -t zensync-relay ./server
docker run -p 8000:8000 -v $PWD/data:/data -e ZENSYNC_DATA_DIR=/data zensync-relay
```

## Configuration (env)
| Var | Default | Meaning |
| --- | ------- | ------- |
| `ZENSYNC_DATA_DIR` | `/opt/zensync/data` | SQLite DB location. |
| `ZENSYNC_REG_TOKEN` | *(unset)* | If set, `/api/register` requires this exact token. |
| `ZENSYNC_ALLOW_OPEN_REGISTRATION` | `false` | Allow open signup. **Registration is fail-closed:** if neither this nor `ZENSYNC_REG_TOKEN` is set, all registration is rejected (403). |

## Deploy (systemd + Caddy)
```bash
# on the server, as root
git pull                                  # or copy server/ over
pip install -r requirements.txt
cp zensync-relay.service /etc/systemd/system/
systemctl daemon-reload && systemctl restart zensync-relay
# Caddy: place Caddyfile at /etc/caddy/Caddyfile, then: systemctl reload caddy
```

## Notes / fixes
- Accepts **12-byte (AES-256-GCM)** and 24-byte (XChaCha20) nonces. The previous
  hard 24-byte requirement rejected every blob the native client pushed (422).
- `DELETE /api/account` implements the client's "Delete Account" action.

Full HTTP contract: [`../docs/API.md`](../docs/API.md).

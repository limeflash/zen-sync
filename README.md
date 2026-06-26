<div align="center">

<img src="assets/logo.png" width="120" height="120" alt="Zen Sync logo" />

# Zen Sync

**End-to-end encrypted sync of Zen Browser workspaces, tabs, groups, containers, and folders across all your devices.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status: Alpha](https://img.shields.io/badge/status-alpha-orange.svg)]()
[![Server](https://img.shields.io/badge/server-FastAPI-009688.svg)]()
[![Extension](https://img.shields.io/badge/extension-WebExtension-FF7139.svg)]()
[![Encryption](https://img.shields.io/badge/encryption-XChaCha20--Poly1305-red.svg)]()

---

Self-hosted · Zero-knowledge · E2E encrypted · No telemetry · No third-party servers

</div>

---

## What is this?

Zen Browser is a beautiful Firefox-based browser with a **Spaces** (workspaces) feature — but it has no built-in cross-device sync for spaces, tabs, or groups. Mozilla Sync doesn't cover Zen's workspace-specific features.

**Zen Sync** fills that gap. It syncs your Zen Browser state across all your machines (macOS + Windows) with end-to-end encryption. Your data is encrypted on-device before it ever touches a server. The relay sees only ciphertext.

### What gets synced

| Category | Source in profile |
| --- | --- |
| **Spaces / Workspaces** | `zen-sessions.jsonlz4` → `spaces[]` |
| **Active workspace** | `recovery.jsonlz4` → `activeZenSpace` |
| **Open tabs** | `zen-sessions.jsonlz4` → `tabs[]` (URL, title, workspace assignment) |
| **Tab groups** | `zen-sessions.jsonlz4` → `groups[]` |
| **Pinned tabs & Essentials** | `tabs[]` where `pinned` or `zenEssential` |
| **Container tabs** | `tabs[]` → `userContextId` + `containers.json` |
| **Tab folders** (Zen feature) | `zen-sessions.jsonlz4` → `folders[]` |
| **Split views** | `zen-sessions.jsonlz4` → `splitViewData[]` |

### How it works

```
 ┌──────────────┐   native      ┌──────────────┐    HTTPS     ┌──────────────┐
 │  Zen Browser │   messaging   │  native host │   REST      │  sync relay  │
 │  extension   │ <───────────> │  (Python)    │ <──────────> │  (FastAPI)   │
 │  (UI, crypto)│               │  (profile IO)│              │  (ciphertext)│
 └──────────────┘               └──────────────┘              └──────────────┘
      your device                                              your server
```

- **Extension** (WebExtension): UI, sync coordination, relay client
- **Native host** (Python): reads/writes Zen profile data, performs crypto, communicates with extension via native messaging
- **Relay server** (FastAPI): stores encrypted blobs + opaque metadata only — never sees plaintext, keys, or workspace content

### Encryption

- **Key derivation**: Argon2id (64MB, 3 iterations, 4 parallelism) from your passphrase + random salt
- **Encryption**: XChaCha20-Poly1305 (AEAD) via PyNaCl
- **Key storage**: derived key stored in OS keyring (Windows Credential Manager / macOS Keychain), passphrase never persisted
- **Server**: zero-knowledge — sees only ciphertext + metadata (account ID, device ID, timestamps)

## Quick start

### 1. Clone

```bash
git clone https://github.com/limeflash/zen-sync.git
cd zen-sync
```

### 2. Install the native host

```bash
cd native-host
python install.py
```

This creates a Python venv, installs dependencies, and registers the native messaging host with your browser. Run `python install.py --status` to verify everything is in place.

### 3. Load the extension

1. Open Zen Browser
2. Go to `about:debugging#/runtime/this-firefox`
3. Click **"Load Temporary Add-on..."**
4. Select `zen-sync/extension/manifest.json`
5. The Zen Sync icon appears in your toolbar

### 4. Set up your account

1. Click the Zen Sync icon
2. Go to the **Setup** tab
3. Enter a **Device Name** and a strong **Passphrase** (8+ characters)
4. Click **Create Account**

### 5. Join on another device

1. Install the native host: `python install.py`
2. Load the extension in Zen Browser
3. Click the Zen Sync icon → **Join** tab
4. Enter your **Account ID** and **Salt** (shown on device 1's Status tab — copy buttons provided)
5. Enter the same **Passphrase**
6. Click **Join Account**

Sync runs automatically every 2 minutes, or manually via **Sync Now**.

## Deploy your own relay server

Zen Sync is designed to be **self-hosted**. You need a server with:
- Python 3.10+
- A domain name (or subdomain) pointing to it
- Ports 80 + 443 open

### Option A: One-command deploy (Ubuntu/Debian)

```bash
# SSH into your server, then:
git clone https://github.com/limeflash/zen-sync.git /opt/zensync-src
cd /opt/zensync-src/server
python3 -m venv /opt/zensync/venv
/opt/zensync/venv/bin/pip install -r requirements.txt
mkdir -p /opt/zensync/app /opt/zensync/data
cp main.py Caddyfile zensync-relay.service /opt/zensync/app/
# Edit Caddyfile: replace your-relay.example.com with your domain
# Then:
cp /opt/zensync/app/zensync-relay.service /etc/systemd/system/
systemctl enable --now zensync-relay
# Install Caddy: https://caddyserver.com/docs/install
systemctl enable --now caddy
```

### Option B: Deploy with AI agent (Claude / Codex / GPT)

Paste this prompt into your AI coding agent:

> ```
> I need you to deploy a Zen Sync relay server on this machine.
> 
> The project is at: https://github.com/limeflash/zen-sync
> Clone it, then deploy the server/ directory:
> 
> 1. Clone the repo to /opt/zensync-src
> 2. Create a Python venv at /opt/zensync/venv
> 3. Install deps: fastapi, uvicorn[standard], pydantic
> 4. Copy server/main.py to /opt/zensync/app/main.py
> 5. Set ZENSYNC_DATA_DIR=/opt/zensync/data
> 6. Create a systemd service "zensync-relay" running:
>    /opt/zensync/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
>    WorkingDirectory=/opt/zensync/app
> 7. Install Caddy and configure reverse proxy:
>    - Domain: REPLACE_WITH_YOUR_DOMAIN
>    - Proxy /api/* to localhost:8000
>    - Auto TLS via Let's Encrypt
>    - Security headers (HSTS, X-Content-Type-Options, X-Frame-Options)
>    - Request body max 17MB
> 8. Enable + start both services
> 9. Verify: curl https://REPLACE_WITH_YOUR_DOMAIN/api/health should return {"status":"ok"}
> 10. Tell me the relay URL so I can point my extension at it
> ```

### Option C: Free deployment options

| Platform | How | Cost | Notes |
| --- | --- | --- | --- |
| **Fly.io** | `fly deploy` with Dockerfile | Free tier (3 VMs) | Easiest free option; good latency |
| **Render.com** | Web service from repo | Free tier | Sleeps after 15 min idle |
| **Railway.app** | Deploy from GitHub | $5/mo credit | Always-on, good DX |
| **Oracle Cloud Free** | VPS (always free) | Free | Full VM, you manage TLS |
| **Google Cloud Run** | Container deploy | Free tier | Scale-to-zero, per-request billing |
| **Hetzner VPS** | Cheapest full VPS | ~€4/mo | Full control, best value |
| **Vultr / DigitalOcean** | VPS droplet | $4-6/mo | Simple, reliable |

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed guides per platform.

### Point your extension at your relay

The relay URL is entered in the extension UI — no code editing needed:

1. Click the Zen Sync icon → **Setup** tab
2. Enter your **Relay URL** (e.g. `https://zensync.yourname.com`)
3. Enter your **Registration Token** (from the server's `ZENSYNC_REG_TOKEN` env var)
4. Continue with device name + passphrase

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Relay URL | Extension UI → Setup/Join → "Relay URL" field | `https://your-relay.example.com` |
| Sync interval | `extension/background.js` → `SYNC_INTERVAL_MIN` | 2 minutes |
| Max blob size | `server/main.py` → `MAX_BLOB_SIZE` | 16 MB |
| Rate limit | `server/main.py` → `RATE_LIMIT_MAX_REQUESTS` | 60 req/min |
| Data directory | env `ZENSYNC_DATA_DIR` | `/opt/zensync/data` |

## Repository structure

```
zen-sync/
├── extension/          WebExtension (UI, crypto coordination, relay client)
│   ├── manifest.json
│   ├── background.js
│   ├── popup/
│   │   ├── popup.html   shadcn-inspired UI (Zen brand palette)
│   │   ├── popup.js     UI logic + QR pairing
│   │   ├── styles.css   Zen Browser design system
│   │   └── qrcode.js    QR code library (MIT)
│   └── icons/
├── native-host/        Python native messaging host
│   ├── zensync_host.py  profile reader + E2E crypto
│   ├── install.py       unified installer (venv + deps + manifest)
│   └── requirements.txt
├── server/             FastAPI relay server
│   ├── main.py          zero-knowledge blob storage
│   ├── Caddyfile        reverse proxy + auto TLS
│   └── zensync-relay.service
├── assets/             logos and images
├── docs/               architecture docs
├── LICENSE              MIT
└── INSTALL.md           detailed install guide
```

## Security

| Threat | Mitigation |
| --- | --- |
| Server operator reads data | All payloads encrypted client-side; server sees only ciphertext |
| Server compromised | Same — no plaintext on server, ever |
| Passive network attacker | HTTPS in transit **plus** E2E encryption (defense in depth) |
| Lost passphrase | Not recoverable; by design. Lose key = lose data |
| Malicious extension update | Extension is self-hosted / signed; native host verifies origin |
| Stale sync overwriting new | Per-workspace logical clock; LWW with monotonic counter |
| Auth bypass | All relay endpoints verify account + device existence |
| Rate limiting | 60 req/min per account (configurable) |

## Acknowledgements

This project is built on top of and deeply inspired by **[Zen Browser](https://zen-browser.app)** — a calmer, more productive Firefox-based browser. Zen Sync wouldn't exist without Zen's excellent workspaces feature and their open-source approach. If you enjoy Zen Sync, please also check out Zen Browser and consider supporting their work.

Zen Browser is built on **[Mozilla Firefox](https://www.mozilla.org/firefox/)** — one of the most important open-source projects in the world. Without Firefox, its WebExtension APIs, session store, and the entire Gecko engine, neither Zen Browser nor Zen Sync would exist. We stand on the shoulders of giants.

- **Mozilla Firefox**: [mozilla.org/firefox](https://www.mozilla.org/firefox/) · [GitHub (mozilla-central)](https://github.com/mozilla/gecko-dev) · [Donate to Mozilla](https://give.mozilla.org)
- **Zen Browser**: [zen-browser.app](https://zen-browser.app) · [GitHub](https://github.com/zen-browser/desktop) · [Patreon](https://patreon.com/zen_browser) · [Ko-fi](https://ko-fi.com/zen_browser)
- **QR Code Generator**: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase (MIT)

Zen Sync is an independent project and is not affiliated with or endorsed by the Zen Browser team or Mozilla.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Quick dev setup

```bash
git clone https://github.com/limeflash/zen-sync.git
cd zen-sync/native-host && python install.py
# Load extension in Zen Browser via about:debugging
# Make changes, reload extension, test
```

## License

[MIT](LICENSE) — do whatever you want, just keep the copyright notice.

## Status

**Alpha — push/pull encrypted snapshot only.** The current build publishes encrypted snapshots of your Zen Browser state and can pull + decrypt remote state. Applying remote state back to your Zen profile (write-back) is not yet implemented. Think of it as encrypted backup + cross-device viewing, not full bidirectional sync yet.

**Alpha.** This project is under active development. The READ path (extract + encrypt + push + pull + decrypt) is fully working and tested end-to-end. The WRITE path (applying remote state back to the local Zen profile) is the next major milestone.

- [x] Research Zen workspace data model
- [x] Server relay (FastAPI + Caddy + TLS)
- [x] Native host (profile reader + E2E crypto)
- [x] Extension (UI + sync coordination + QR pairing)
- [x] Security audit (10 critical + 8 medium fixes applied)
- [x] E2E test (register → push → pull → decrypt — verified)
- [ ] WRITE path (apply remote state to local profile)
- [ ] macOS testing
- [ ] Package as signed XPI for permanent install
- [ ] Conflict resolution (merge instead of LWW)

<div align="center">

---

Made with care for the Zen Browser community

</div>
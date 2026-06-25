# AI Agent Install Prompt

Paste this into Claude, Codex, GPT, or any AI coding agent to deploy Zen Sync end-to-end.

---

## Full deploy (server + extension + native host)

```
I need you to set up Zen Sync — an end-to-end encrypted sync tool for Zen Browser workspaces.

Repository: https://github.com/limeflash/zen-sync

Do the following in order:

### 1. Clone the repo
git clone https://github.com/limeflash/zen-sync.git

### 2. Deploy the relay server (on a remote VPS or this machine)
- Install Python 3.10+ if not present
- Create venv at /opt/zensync/venv
- Install: fastapi, uvicorn[standard], pydantic
- Copy server/main.py to /opt/zensync/app/main.py
- Set env: ZENSYNC_DATA_DIR=/opt/zensync/data
- Create systemd service "zensync-relay":
    ExecStart=/opt/zensync/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
    WorkingDirectory=/opt/zensync/app
- Enable + start the service
- Verify: curl http://127.0.0.1:8000/api/health → {"status":"ok"}

### 3. Set up Caddy reverse proxy with TLS
- Install Caddy
- Configure: domain REPLACE_WITH_YOUR_DOMAIN
    - Proxy /api/* to localhost:8000
    - Auto TLS via Let's Encrypt
    - Security headers: HSTS, X-Content-Type-Options, X-Frame-Options
    - Request body max 17MB
- Start Caddy
- Verify: curl https://REPLACE_WITH_YOUR_DOMAIN/api/health → {"status":"ok"}

### 4. Install the native host (on your local machine)
cd native-host
python install.py
python install.py --status  # verify all green

### 5. Point the extension at your relay
- Edit extension/background.js: set RELAY_URL to your domain
- Load extension in Zen Browser:
    about:debugging#/runtime/this-firefox → Load Temporary Add-on → extension/manifest.json

### 6. Set up account
- Click Zen Sync icon → Setup tab → enter device name + passphrase → Create Account
- On second device: install native host + load extension → Join tab → enter Account ID + Salt + passphrase

Tell me the relay URL when done.
```

---

## Native host only (local machine, use existing relay)

```
Set up the Zen Sync native host on this machine.

1. Clone: git clone https://github.com/limeflash/zen-sync.git
2. Run: cd zen-sync/native-host && python install.py
3. Verify: python install.py --status (all should be True/present)
4. Load extension in Zen Browser:
   about:debugging#/runtime/this-firefox → Load Temporary Add-on → extension/manifest.json
5. Click the Zen Sync icon → Setup → enter device name + passphrase → Create Account

If using an existing relay, edit extension/background.js and set RELAY_URL to the relay's URL before loading the extension.
```

---

## Server only (deploy relay)

```
Deploy a Zen Sync relay server.

Repo: https://github.com/limeflash/zen-sync (use server/ directory)

Steps:
1. git clone https://github.com/limeflash/zen-sync.git /opt/zensync-src
2. python3 -m venv /opt/zensync/venv
3. /opt/zensync/venv/bin/pip install fastapi 'uvicorn[standard]' pydantic
4. mkdir -p /opt/zensync/app /opt/zensync/data
5. cp /opt/zensync-src/server/main.py /opt/zensync/app/
6. Create systemd service running uvicorn on port 8000, WorkingDirectory=/opt/zensync/app
7. Install Caddy, configure reverse proxy for YOUR_DOMAIN → localhost:8000 with auto TLS
8. Enable + start both services
9. Verify: curl https://YOUR_DOMAIN/api/health

Set ZENSYNC_DATA_DIR=/opt/zensync/data as environment variable in the systemd service.
```
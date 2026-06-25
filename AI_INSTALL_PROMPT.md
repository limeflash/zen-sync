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
- Generate a registration token: python3 -c "import secrets; print(secrets.token_urlsafe(32))"
- Set env: ZENSYNC_REG_TOKEN=<the generated token>
- Create systemd service "zensync-relay":
    ExecStart=/opt/zensync/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
    WorkingDirectory=/opt/zensync/app
    Environment=ZENSYNC_DATA_DIR=/opt/zensync/data
    Environment=ZENSYNC_REG_TOKEN=<the generated token>
- Enable + start the service
- Verify: curl http://127.0.0.1:8000/api/health → {"status":"ok"}

### 3. Set up Caddy reverse proxy with TLS
- Install Caddy
- Configure: your domain
    - Proxy /api/* to localhost:8000
    - Auto TLS via Let's Encrypt
    - Security headers: HSTS, X-Content-Type-Options, X-Frame-Options
    - Request body max 17MB
- Start Caddy
- Verify: curl https://YOUR_DOMAIN/api/health → {"status":"ok"}

### 4. Install the native host (on your local machine)
cd native-host
python install.py
python install.py --status  # verify all green

### 5. Load the extension in Zen Browser
- about:debugging#/runtime/this-firefox → Load Temporary Add-on → extension/manifest.json
- Click the Zen Sync icon → Setup tab
- Enter:
    Relay URL: https://YOUR_DOMAIN
    Registration Token: <the token from step 2>
    Device Name: your device name
    Passphrase: your strong passphrase
- Click Create Account

### 6. Add another device
- Install native host: python install.py
- Load extension in Zen Browser
- Click Zen Sync → Join tab
- Enter:
    Relay URL: https://YOUR_DOMAIN
    Account ID: (from device 1's Status tab)
    Salt: (from device 1's Status tab)
    Passphrase: same as device 1
    Device Name: new device name
- Click Join Account

Tell me the relay URL and registration token when done.
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
5. Click the Zen Sync icon → Setup tab
6. Enter:
   - Relay URL (provided below)
   - Registration Token (provided below)
   - Device Name (e.g. "MacBook")
   - Passphrase (strong, 8+ chars)
7. Click Create Account

Relay URL: REPLACE_WITH_YOUR_RELAY_URL
Registration Token: REPLACE_WITH_YOUR_REGISTRATION_TOKEN
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
6. Generate registration token: python3 -c "import secrets; print(secrets.token_urlsafe(32))"
7. Create systemd service running uvicorn on port 8000:
   - WorkingDirectory=/opt/zensync/app
   - Environment=ZENSYNC_DATA_DIR=/opt/zensync/data
   - Environment=ZENSYNC_REG_TOKEN=<generated token>
8. Install Caddy, configure reverse proxy for YOUR_DOMAIN → localhost:8000 with auto TLS
9. Enable + start both services
10. Verify: curl https://YOUR_DOMAIN/api/health → {"status":"ok"}
11. Also verify registration is gated: curl -X POST https://YOUR_DOMAIN/api/register -H 'Content-Type: application/json' -d '{"salt":"dGVzdA=="}' should return 403 "registration closed"
12. Report back: relay URL + registration token

The relay URL and registration token go into the extension UI (Setup tab → Relay URL + Registration Token fields).
```
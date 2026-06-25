# Deployment Guide

Zen Sync relay is a lightweight Python (FastAPI) server behind Caddy (reverse proxy with auto TLS). You can deploy it anywhere Python 3.10+ runs.

## Prerequisites

- A domain or subdomain (e.g. `zensync.yourname.com`) pointing to your server's IP
- Ports 80 + 443 open (for Caddy's automatic TLS)
- Python 3.10+
- Root/sudo access (for systemd + Caddy)

---

## Fly.io (free tier, easiest)

Fly.io gives you 3 free shared-core VMs with 256MB RAM each — more than enough.

```bash
# Install flyctl: https://fly.io/docs/hands-on/install-flyctl/
fly launch --no-deploy
# Edit fly.toml: set internal_port = 8000
fly deploy
# Point your domain's A record to the fly.io IP
fly certs add zensync.yourname.com
```

Create a `Dockerfile` in `server/`:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY main.py .
ENV ZENSYNC_DATA_DIR=/data
VOLUME /data
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

## Render.com (free tier)

1. Fork this repo to your GitHub
2. Go to [render.com](https://render.com) → New → Web Service → connect repo
3. Settings:
   - Build: `pip install -r server/requirements.txt`
   - Start: `cd server && uvicorn main:app --host 0.0.0.0 --port $PORT`
   - Env: `ZENSYNC_DATA_DIR=/var/lib/zensync`
4. Add your domain in settings → custom domain
5. Render provides TLS automatically

## Oracle Cloud (always free VPS)

Oracle Cloud gives you a free ARM VPS (4 cores, 24GB RAM) — way more than enough.

1. Sign up at [oraclecloud.com](https://oraclecloud.com)
2. Create an Always Free VM (Ampere A1)
3. SSH in, then:

```bash
sudo apt update && sudo apt install -y python3-venv python3-pip
git clone https://github.com/limeflash/zen-sync.git /opt/zensync-src
cd /opt/zensync-src/server
python3 -m venv /opt/zensync/venv
/opt/zensync/venv/bin/pip install -r requirements.txt
mkdir -p /opt/zensync/app /opt/zensync/data
cp main.py /opt/zensync/app/
# Set up Caddy for TLS (see below)
```

## Hetzner / Vultr / DigitalOcean VPS

Same as Oracle Cloud — get a VPS, SSH in, run the commands above.

## Caddy setup (automatic TLS)

```bash
# Install Caddy: https://caddyserver.com/docs/install
sudo apt install -y caddy

# Edit Caddyfile
sudo nano /etc/caddy/Caddyfile
```

```Caddyfile
zensync.yourname.com {
    encode zstd gzip
    request_body { max_size 17825792 }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
    }
    handle /api/* {
        reverse_proxy localhost:8000
    }
    respond "zensync relay" 200
}
```

```bash
sudo systemctl restart caddy
# Verify
curl https://zensync.yourname.com/api/health
# → {"status":"ok","version":"0.2.0"}
```

## systemd service

```bash
sudo cp /opt/zensync-src/server/zensync-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zensync-relay
```

## Point your extension at the relay

No code editing needed — the relay URL is entered in the extension UI:

1. Click the Zen Sync icon → **Setup** tab
2. Enter your **Relay URL** (e.g. `https://zensync.yourname.com`)
3. Enter your **Registration Token** (from the server's `ZENSYNC_REG_TOKEN` env var)
4. Continue with device name + passphrase

The relay URL is stored in `browser.storage.local` and used for all requests.
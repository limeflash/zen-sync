# Installation

## Prerequisites

- **Zen Browser** installed (Windows or macOS)
- **Python 3.10+** installed and on PATH (`python --version`)
- Git to clone this repo

## Quick install

```bash
git clone https://github.com/limeflash/zen-sync.git
cd zen-sync/native-host
python install.py
```

That's it for the native host. Now load the extension:

1. Open Zen Browser
2. Go to `about:debugging#/runtime/this-firefox`
3. Click **"Load Temporary Add-on..."**
4. Select `zen-sync/extension/manifest.json`
5. The Zen Sync icon appears in your toolbar

## Setup (first device)

1. Click the Zen Sync icon in the toolbar
2. Go to the **Setup** tab
3. Enter a **Device Name** (e.g. "Windows PC")
4. Enter a **Passphrase** (8+ characters — remember it, it cannot be recovered)
5. Click **Create Account**

Your workspaces are now syncing.

## Join (second device)

1. Install the native host on the second device (same `install.py`)
2. Load the extension in Zen Browser
3. Click the Zen Sync icon → **Join** tab
4. Enter the **Account ID**, **Salt**, and **Passphrase** from the first device
   (find them in the Status tab on device 1, or run `install.py --status`)
5. Click **Join Account**

## What gets synced

- Spaces / Workspaces (names, icons, themes, container assignments)
- Open tabs (URLs, titles, workspace assignment)
- Tab groups (names, colors, collapse state)
- Pinned tabs & Essentials
- Container tabs (definitions + assignments)
- Tab folders (Zen-specific)
- Active workspace

## Troubleshooting

### Extension can't connect to native host

Run the installer status check:

```bash
cd zen-sync/native-host
python install.py --status
```

All items should show `True` / `present`. If not, re-run `python install.py`.

### Sync not working

1. Click the Zen Sync icon → **Status** tab → **Sync Now**
2. Check the error message in the popup
3. Verify the relay is up: open `https://your-relay.example.com/api/health` in your browser
   (should return `{"status":"ok"}`)

### Wrong passphrase

If you forget your passphrase, there is no recovery. You must:
1. Uninstall: `python install.py --uninstall`
2. Reinstall: `python install.py`
3. Create a new account

### Uninstall

```bash
cd zen-sync/native-host
python install.py --uninstall
```

Then remove the extension from Zen Browser (`about:addons` → Remove).

## Platform notes

### Windows

- Native host manifest registered in `HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\zensync_host`
- Python venv at `native-host/venv/`
- Launcher: `native-host/zensync_host.bat`

### macOS

- Native host manifest at `~/Library/Application Support/Mozilla/NativeMessagingHosts/zensync_host.json`
- No `sudo` needed (user-level directory)
- Python venv at `native-host/venv/`

### Linux

- Native host manifest at `~/.mozilla/native-messaging-hosts/zensync_host.json`
- Python venv at `native-host/venv/`

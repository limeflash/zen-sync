#!/usr/bin/env python3
"""
Zen Sync — unified installer.

Does everything:
  1. Creates a Python venv for the native host
  2. Installs dependencies (argon2-cffi, pynacl, lz4, keyring)
  3. Writes the native messaging manifest to the correct platform location
  4. Registers in Windows registry (if applicable)
  5. Creates a launcher wrapper (.bat on Windows, .sh on macOS/Linux)

Usage:
  python install.py              # install
  python install.py --uninstall  # remove everything
  python install.py --status     # check installation state
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

HOST_NAME = "zensync_host"
EXTENSION_ID = "zensync@limeflash.dev"
SCRIPT_DIR = Path(__file__).parent.resolve()
HOST_SCRIPT = SCRIPT_DIR / "zensync_host.py"
VENV_DIR = SCRIPT_DIR / "venv"
REQUIREMENTS = SCRIPT_DIR / "requirements.txt"


def venv_python() -> Path:
    if platform.system() == "Windows":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def run(cmd: list[str], **kw) -> None:
    print(f"  $ {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if result.returncode != 0:
        if result.stderr:
            print(f"  STDERR: {result.stderr.strip()}")
        raise RuntimeError(f"command failed (exit {result.returncode}): {' '.join(cmd)}")
    if result.stdout and result.stdout.strip():
        for line in result.stdout.strip().splitlines():
            print(f"  {line}")


def get_manifest_path() -> Path:
    system = platform.system()
    if system == "Windows":
        base = Path(os.environ.get("APPDATA", "")) / "Mozilla" / "NativeMessagingHosts"
    elif system == "Darwin":
        # User-level path (no sudo needed)
        base = Path.home() / "Library" / "Application Support" / "Mozilla" / "NativeMessagingHosts"
    else:
        base = Path.home() / ".mozilla" / "native-messaging-hosts"
    return base / f"{HOST_NAME}.json"


def get_launcher_path() -> Path:
    if platform.system() == "Windows":
        return SCRIPT_DIR / "zensync_host.bat"
    return SCRIPT_DIR / "zensync_host.sh"


def build_launcher(venv_py: Path) -> str:
    launcher = get_launcher_path()
    if platform.system() == "Windows":
        launcher.write_text(f'@echo off\r\n"{venv_py}" "{HOST_SCRIPT}" %*\r\n')
    else:
        launcher.write_text(f'#!/bin/sh\nexec "{venv_py}" "{HOST_SCRIPT}" "$@"\n')
        launcher.chmod(0o755)
    return str(launcher)


def build_manifest(host_path: str) -> dict:
    return {
        "name": HOST_NAME,
        "description": "Zen Sync native messaging host",
        "type": "stdio",
        "path": host_path,
        "allowed_extensions": [EXTENSION_ID],
    }


def install_windows_registry(manifest_path: Path) -> None:
    key = rf"HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\{HOST_NAME}"
    run(["reg", "add", key, "/ve", "/t", "REG_SZ", "/d", str(manifest_path), "/f"])
    print(f"  Registry: {key} -> {manifest_path}")


def uninstall_windows_registry() -> None:
    key = rf"HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\{HOST_NAME}"
    run(["reg", "delete", key, "/f"])


def install() -> None:
    print("=" * 60)
    print("  Zen Sync — Installer")
    print("=" * 60)

    py = sys.executable
    print(f"\n[1/5] Creating Python venv at: {VENV_DIR}")
    if VENV_DIR.exists():
        print("  venv already exists, reusing")
    else:
        run([py, "-m", "venv", str(VENV_DIR)])

    venv_py = venv_python()
    print(f"\n[2/5] Upgrading pip")
    run([str(venv_py), "-m", "pip", "install", "--upgrade", "pip", "-q"])

    print(f"\n[3/5] Installing dependencies from requirements.txt")
    run([str(venv_py), "-m", "pip", "install", "-r", str(REQUIREMENTS), "-q"])

    print(f"\n[4/5] Writing launcher + manifest")
    host_path = build_launcher(venv_py)
    print(f"  Launcher: {host_path}")

    manifest = build_manifest(host_path)
    manifest_path = get_manifest_path()
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"  Manifest: {manifest_path}")

    if platform.system() == "Windows":
        print(f"\n[5/5] Registering in Windows registry")
        install_windows_registry(manifest_path)
    else:
        print(f"\n[5/5] (no registry step needed on {platform.system()})")

    print("\n" + "=" * 60)
    print("  INSTALLATION COMPLETE")
    print("=" * 60)
    print(f"""
Next steps:

1. Load the extension in Zen Browser:
   - Open: about:debugging#/runtime/this-firefox
   - Click "Load Temporary Add-on"
   - Select: {SCRIPT_DIR.parent / "extension" / "manifest.json"}

2. The Zen Sync icon should appear in your toolbar.
   Click it to set up your account.

3. To install on another device, repeat this installer,
   then use "Join" in the popup with your account details.
""")


def uninstall() -> None:
    print("=" * 60)
    print("  Zen Sync — Uninstaller")
    print("=" * 60)

    manifest_path = get_manifest_path()
    if manifest_path.exists():
        manifest_path.unlink()
        print(f"\n  Removed manifest: {manifest_path}")
    else:
        print(f"\n  Manifest not found: {manifest_path}")

    if platform.system() == "Windows":
        try:
            uninstall_windows_registry()
            print(f"  Removed registry key")
        except RuntimeError:
            print(f"  Registry key not found (already clean)")

    launcher = get_launcher_path()
    if launcher.exists():
        launcher.unlink()
        print(f"  Removed launcher: {launcher}")

    if VENV_DIR.exists():
        shutil.rmtree(VENV_DIR)
        print(f"  Removed venv: {VENV_DIR}")

    print("\n  Uninstallation complete.")


def status() -> None:
    print("=" * 60)
    print("  Zen Sync — Installation Status")
    print("=" * 60)

    manifest_path = get_manifest_path()
    print(f"\n  Manifest path: {manifest_path}")
    print(f"  Manifest exists: {manifest_path.exists()}")
    if manifest_path.exists():
        m = json.loads(manifest_path.read_text())
        print(f"  Host path: {m.get('path')}")
        print(f"  Extension ID: {m.get('allowed_extensions', [None])[0]}")
        host_path = Path(m.get("path", ""))
        print(f"  Host launcher exists: {host_path.exists()}")

    launcher = get_launcher_path()
    print(f"\n  Launcher: {launcher}")
    print(f"  Launcher exists: {launcher.exists()}")

    print(f"\n  Venv: {VENV_DIR}")
    print(f"  Venv exists: {VENV_DIR.exists()}")
    if VENV_DIR.exists():
        vp = venv_python()
        print(f"  Venv python: {vp}")
        print(f"  Venv python exists: {vp.exists()}")

    if platform.system() == "Windows":
        key = rf"HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\{HOST_NAME}"
        result = subprocess.run(
            ["reg", "query", key, "/ve"],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            print(f"\n  Registry key: {key} (present)")
        else:
            print(f"\n  Registry key: {key} (NOT FOUND)")

    print(f"\n  Host script: {HOST_SCRIPT}")
    print(f"  Host script exists: {HOST_SCRIPT.exists()}")


if __name__ == "__main__":
    if "--uninstall" in sys.argv:
        uninstall()
    elif "--status" in sys.argv:
        status()
    else:
        install()
# Contributing to Zen Sync

Thanks for your interest! Zen Sync has two parts — a browser-side **client**
module and a self-hostable **server** relay — that share one API contract.

## Repo layout
- `client/` — the browser module (consumed by
  [zen-browser-plus](https://github.com/limeflash/zen-browser-plus) as a git
  submodule at `src/zen/sync/`). See [`client/README.md`](client/README.md).
- `server/` — the FastAPI relay. See [`server/README.md`](server/README.md).
- `docs/` — [API.md](docs/API.md) and [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Getting started
```bash
git clone https://github.com/limeflash/zen-sync.git
cd zen-sync/server && pip install -r requirements.txt
ZENSYNC_ALLOW_OPEN_REGISTRATION=true uvicorn main:app --reload --port 8000
```
For the client, work inside the browser repo's submodule and rebuild (see
`client/README.md`); the browser console (`Ctrl+Shift+J`) shows `ZenSync:` logs.

## Before you push
- **Server:** `python -m py_compile server/main.py` and (optional) `bandit -r server -ll`.
- **Client:** `node --check client/modules/ZenSyncService.sys.mjs client/preferences/zenSyncSettings.js`.
- Keep the **API contract** ([docs/API.md](docs/API.md)) and client in sync — a
  change on one side usually needs the other.

## Code style
- **Python:** standard style, type hints preferred.
- **JavaScript (client):** matches Firefox front-end style (2-space indent,
  semicolons, `async/await`); MPL-2.0 header on new files.

## Security
Please don't open public issues for vulnerabilities — use a private GitHub
security advisory.

## License
Contributions to `server/`/docs are under [MIT](LICENSE); contributions to
`client/` are under [MPL-2.0](https://www.mozilla.org/MPL/2.0/) (Firefox-derived).

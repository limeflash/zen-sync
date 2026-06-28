# Zen Sync — client module

The browser-side of Zen Sync. These files are the **canonical source**; the
[zen-browser-plus](https://github.com/limeflash/zen-browser-plus) browser repo
consumes them as a **git submodule** mounted at `src/zen/sync/`.

## Files
| File | Role |
| ---- | ---- |
| `modules/ZenSyncService.sys.mjs` | Core service: key derivation, AES-GCM, relay calls, sync reconciliation, secret storage. Exposed as `chrome://browser/content/zen-components/ZenSyncService.sys.mjs`. |
| `preferences/zenSync.inc.xhtml`  | The **Zen Sync** preferences pane markup (`#include`d into `about:preferences`). Also loads `zenSyncSettings.js`. |
| `preferences/zenSyncSettings.js` | `gZenSyncSettings` — the pane controller (setup / join / device list / sync / disconnect / delete). |
| `locales/en-US/zen-sync.ftl`     | Fluent strings for the pane. |

## How the browser wires it up
Because `src/zen/` maps to `engine/zen/` and the `src/` overlay is copied
wholesale into the Firefox engine, the browser repo references these paths:

- **`src/zen/common/jar.inc.mn`** packages the service:
  `content/browser/zen-components/ZenSyncService.sys.mjs (../../zen/sync/client/modules/ZenSyncService.sys.mjs)`
- **`preferences-xhtml.patch`** includes the pane:
  `#include ../../../zen/sync/client/preferences/zenSync.inc.xhtml`
- **`jar-mn.patch`** packages the controller:
  `content/browser/preferences/zenSyncSettings.js (../../../zen/sync/client/preferences/zenSyncSettings.js)`
- **`BrowserGlue`** calls `ZenSyncService.init()`; **`preferences.js`** runs
  `register_module("paneZenSync", gZenSyncSettings)`.

## Updating
Edit here, commit & push this repo, then in the browser repo:
```bash
git -C src/zen/sync pull        # or: git submodule update --remote src/zen/sync
git add src/zen/sync && git commit -m "chore(sync): bump zen-sync submodule"
```

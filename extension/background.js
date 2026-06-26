/**
 * Zen Sync — background script
 *
 * Coordinates: native host (profile IO + crypto) <-> relay (ciphertext storage)
 * Runs sync cycle on alarm + on-demand.
 */

const DEFAULT_RELAY_URL = "https://your-relay.example.com";
const SYNC_INTERVAL_MIN = 2; // every 2 minutes
const NATIVE_HOST_NAME = "zensync_host";

console.log("[zensync] background script loaded");

// --- native messaging ---

function sendToNative(message) {
  const NATIVE_TIMEOUT_MS = 30000; // 30s — Argon2id can take a few seconds
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { port.disconnect(); } catch (_) {}
        reject(new Error("native host timeout"));
      }
    }, NATIVE_TIMEOUT_MS);

    const port = browser.runtime.connectNative(NATIVE_HOST_NAME);
    port.onMessage.addListener((response) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(response);
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const err = browser.runtime.lastError;
        reject(new Error(err ? err.message : "native host disconnected"));
      }
    });
    port.postMessage(message);
  });
}

// --- relay client ---
async function getRelayUrl() {
  const stored = await browser.storage.local.get("relayUrl");
  return stored.relayUrl || DEFAULT_RELAY_URL;
}

async function relayRequest(path, method = "GET", body = null, headers = {}) {
  const RELAY_TIMEOUT_MS = 15000;
  const relayUrl = await getRelayUrl();
  const authToken = await getAuthToken();
  const allHeaders = { "Content-Type": "application/json", ...headers };
  if (authToken) allHeaders["X-Auth-Token"] = authToken;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  try {
    const req = {
      method,
      headers: allHeaders,
      signal: controller.signal,
    };
    if (body) req.body = JSON.stringify(body);
    const res = await fetch(`${relayUrl}${path}`, req);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`relay ${method} ${path}: ${res.status} ${text.substring(0, 200)}`);
    }
    try {
      const data = await res.json();
      // Attach response headers for pagination support
      data._responseHeaders = {
        "X-Has-More": res.headers.get("X-Has-More"),
        "X-Next-Cursor": res.headers.get("X-Next-Cursor"),
        "X-Next-Cursor-Id": res.headers.get("X-Next-Cursor-Id"),
      };
      return data;
    } catch {
      throw new Error(`relay ${method} ${path}: invalid JSON response`);
    }
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`relay ${method} ${path}: timeout after ${RELAY_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// --- sync logic ---

async function getStoredState() {
  return browser.storage.local.get([
    "accountId",
    "deviceId",
    "deviceName",
    "salt",
    "lastSyncTimestamp",
    "lastSyncBlobId",
  ]);
}

async function getAuthToken() {
  // Get auth token from native host keyring — never stored in browser.storage.local
  const stored = await browser.storage.local.get("accountId");
  if (!stored.accountId) return "";
  try {
    const resp = await sendToNative({ action: "get_auth_token", accountId: stored.accountId });
    return resp.ok ? (resp.auth_token || "") : "";
  } catch {
    return "";
  }
}

async function performSyncPush() {
  const stored = await getStoredState();
  if (!stored.accountId || !stored.deviceId) {
    return { ok: false, error: "not configured" };
  }

  // 1. Extract state from profile via native host
  const extractResp = await sendToNative({ action: "extract" });
  if (!extractResp.ok) {
    return { ok: false, error: `extract: ${extractResp.error}` };
  }

  // 2. Encrypt (uses stored key from OS keyring, no passphrase in extension)
  const encryptResp = await sendToNative({
    action: "encrypt",
    accountId: stored.accountId,
    data: extractResp.state,
  });
  if (!encryptResp.ok) {
    return { ok: false, error: `encrypt: ${encryptResp.error}` };
  }

  // 3. Publish to relay
  await relayRequest(
    "/api/blobs",
    "POST",
    {
      version: Math.floor(Date.now() / 1000),
      ciphertext: encryptResp.ciphertext,
      nonce: encryptResp.nonce,
    },
    {
      "X-Account-Id": stored.accountId,
      "X-Device-Id": stored.deviceId,
    }
  );

  return { ok: true, pushed: true };
}

async function performSyncPull() {
  const stored = await getStoredState();
  if (!stored.accountId || !stored.deviceId) {
    return { ok: false, error: "not configured" };
  }

  let since = stored.lastSyncTimestamp || 0;
  let sinceId = stored.lastSyncBlobId || "";
  const remoteStates = [];
  let totalPulled = 0;
  const MAX_PAGES = 20;

  for (let page = 0; page < MAX_PAGES; page++) {
    let url = `/api/blobs?since=${since}`;
    if (sinceId) url += `&since_id=${sinceId}`;
    const resp = await relayRequest(
      url, "GET", null,
      { "X-Account-Id": stored.accountId, "X-Device-Id": stored.deviceId }
    );

    const blobs = resp.filter(b => !b._responseHeaders);
    const headers = resp._responseHeaders || {};

    if (!blobs || blobs.length === 0) {
      break;
    }

    // Decrypt each blob
    for (const blob of blobs) {
      const decryptResp = await sendToNative({
        action: "decrypt",
        accountId: stored.accountId,
        ciphertext: blob.ciphertext,
        nonce: blob.nonce,
      });
      if (decryptResp.ok) {
        remoteStates.push({
          deviceName: blob.device_name,
          timestamp: blob.timestamp,
          state: decryptResp.data,
        });
      }
      totalPulled++;
    }

    // Advance cursor AFTER every non-empty page (before checking has_more)
    const lastBlob = blobs[blobs.length - 1];
    since = lastBlob.timestamp;
    sinceId = lastBlob.blob_id;

    // Also use server headers if available (more reliable)
    if (headers["X-Next-Cursor"]) {
      since = parseFloat(headers["X-Next-Cursor"]);
      sinceId = headers["X-Next-Cursor-Id"] || sinceId;
    }

    if (headers["X-Has-More"] !== "true") {
      break;
    }
  }

  if (totalPulled === 0) {
    return { ok: true, pulled: 0 };
  }

  // 3. Store the latest remote state for UI display + apply
  if (remoteStates.length > 0) {
    remoteStates.sort((a, b) => b.timestamp - a.timestamp);
    const latest = remoteStates[0];
    await browser.storage.local.set({
      lastRemoteState: latest.state,
      lastRemoteDevice: latest.deviceName,
      lastRemoteTime: latest.timestamp,
    });
  }

  // 4. Update last sync cursor (composite: timestamp + blob_id)
  await browser.storage.local.set({
    lastSyncTimestamp: since,
    lastSyncBlobId: sinceId,
  });

  return { ok: true, pulled: totalPulled };
}

async function performSync() {
  try {
    const pushResult = await performSyncPush();
    const pullResult = await performSyncPull();
    const result = {
      ok: true,
      push: pushResult,
      pull: pullResult,
      time: Date.now(),
    };
    await browser.storage.local.set({ lastSyncResult: result });
    return result;
  } catch (e) {
    const result = { ok: false, error: e.message, time: Date.now() };
    await browser.storage.local.set({ lastSyncResult: result });
    return result;
  }
}

// --- setup / pairing ---

async function setupAccount(passphrase, deviceName, token, relayUrl) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = btoa(String.fromCharCode(...salt));

  // Store relay URL if provided
  if (relayUrl) {
    await browser.storage.local.set({ relayUrl });
  }

  // 1. Derive auth token + hash via native host
  console.log("[zensync] setup: deriving auth token...");
  const authResp = await sendToNative({
    action: "derive_auth",
    passphrase: passphrase,
    salt: saltB64,
  });
  if (!authResp.ok) {
    return { ok: false, error: `derive_auth: ${authResp.error}` };
  }
  const authToken = authResp.auth_token;
  const authHash = authResp.auth_hash;

  // 2. Register on relay (sends auth_hash, server stores hash only)
  console.log("[zensync] setup: registering on relay...");
  const regResp = await relayRequest("/api/register", "POST", {
    salt: saltB64,
    token: token || "",
    auth_hash: authHash,
  });
  console.log("[zensync] setup: account registered:", regResp.account_id);

  // 3. Register device
  console.log("[zensync] setup: registering device...");
  const deviceResp = await relayRequest(
    "/api/devices",
    "POST",
    { name: deviceName },
    { "X-Account-Id": regResp.account_id }
  );
  console.log("[zensync] setup: device registered:", deviceResp.device_id);

  // 4. Store enc key + auth token in OS keyring
  console.log("[zensync] setup: storing key in native host (Argon2id, may take a few seconds)...");
  const keyResp = await sendToNative({
    action: "store_key",
    accountId: regResp.account_id,
    passphrase: passphrase,
    salt: saltB64,
  });
  if (!keyResp.ok) {
    return { ok: false, error: `failed to store key: ${keyResp.error}` };
  }
  // Store auth token in keyring too
  const storeAuthResp = await sendToNative({
    action: "store_auth_token",
    accountId: regResp.account_id,
    authToken: authToken,
  });
  if (!storeAuthResp.ok) {
    return { ok: false, error: `failed to store auth token: ${storeAuthResp.error}` };
  }

  await browser.storage.local.set({
    accountId: regResp.account_id,
    deviceId: deviceResp.device_id,
    deviceName: deviceName,
    salt: saltB64,
    lastSyncTimestamp: 0,
  });
  console.log("[zensync] setup: complete");

  return { ok: true, accountId: regResp.account_id, deviceId: deviceResp.device_id };
}

async function joinAccount(accountId, passphrase, saltB64, deviceName, relayUrl) {
  // Store relay URL if provided
  if (relayUrl) {
    await browser.storage.local.set({ relayUrl });
  }

  // 1. Derive auth token from passphrase+salt (same as setup, salt is shared)
  const authResp = await sendToNative({
    action: "derive_auth",
    passphrase: passphrase,
    salt: saltB64,
  });
  if (!authResp.ok) {
    return { ok: false, error: `derive_auth: ${authResp.error}` };
  }
  const authToken = authResp.auth_token;

  // 2. Register device under existing account
  const deviceResp = await relayRequest(
    "/api/devices",
    "POST",
    { name: deviceName },
    { "X-Account-Id": accountId }
  );

  // 3. Store enc key + auth token in OS keyring
  const keyResp = await sendToNative({
    action: "store_key",
    accountId: accountId,
    passphrase: passphrase,
    salt: saltB64,
  });
  if (!keyResp.ok) {
    return { ok: false, error: `failed to store key: ${keyResp.error}` };
  }
  const storeAuthResp = await sendToNative({
    action: "store_auth_token",
    accountId: accountId,
    authToken: authToken,
  });
  if (!storeAuthResp.ok) {
    return { ok: false, error: `failed to store auth token: ${storeAuthResp.error}` };
  }

  await browser.storage.local.set({
    accountId: accountId,
    deviceId: deviceResp.device_id,
    deviceName: deviceName,
    salt: saltB64,
    lastSyncTimestamp: 0,
  });

  return { ok: true, deviceId: deviceResp.device_id };
}

// --- alarms (periodic sync) ---

browser.alarms.create("sync", { periodInMinutes: SYNC_INTERVAL_MIN });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync") {
    performSync();
  }
});

// --- apply remote state ---

async function stageAndApply() {
  // Safe apply: stage → check Zen → commit (or instruct user to close)
  const stored = await browser.storage.local.get(["lastRemoteState", "lastRemoteDevice"]);
  if (!stored.lastRemoteState) {
    return { ok: false, error: "no remote state available — sync first" };
  }

  // 1. Stage
  console.log("[zensync] staging remote state...");
  const stageResp = await sendToNative({ action: "stage_apply", state: stored.lastRemoteState });
  if (!stageResp.ok) {
    return { ok: false, error: `stage: ${stageResp.error}` };
  }
  console.log("[zensync] staged:", stageResp.stage_id, "Zen running:", stageResp.zen_running);

  // 2. If Zen is running, instruct user to close
  if (stageResp.zen_running) {
    await browser.storage.local.set({ pendingStageId: stageResp.stage_id });
    return {
      ok: true,
      needs_restart: true,
      stage_id: stageResp.stage_id,
      message: "State staged. Close Zen Browser, then click 'Commit Apply' to finish.",
      tabs_count: stageResp.tabs_count,
      spaces_count: stageResp.spaces_count,
    };
  }

  // 3. Zen is closed — commit immediately
  console.log("[zensync] Zen not running, committing...");
  const commitResp = await sendToNative({ action: "commit_staged_apply", stage_id: stageResp.stage_id });
  if (commitResp.ok) {
    await browser.storage.local.set({ lastAppliedTimestamp: Date.now() });
  }
  return commitResp;
}

async function commitApply() {
  // Commit after user closed Zen
  const stored = await browser.storage.local.get("pendingStageId");
  if (!stored.pendingStageId) {
    return { ok: false, error: "no pending apply. Stage first." };
  }

  // Check if Zen is still running
  const runningResp = await sendToNative({ action: "is_zen_running" });
  if (runningResp.ok && runningResp.running) {
    return { ok: false, error: "Zen Browser is still running. Please close it first." };
  }

  console.log("[zensync] committing staged apply...");
  const resp = await sendToNative({ action: "commit_staged_apply", stage_id: stored.pendingStageId });
  if (resp.ok) {
    await browser.storage.local.remove("pendingStageId");
    await browser.storage.local.set({ lastAppliedTimestamp: Date.now() });
  }
  return resp;
}

async function importTabsLive() {
  // Live tabs-only import — no restart, non-destructive
  const stored = await browser.storage.local.get("lastRemoteState");
  if (!stored.lastRemoteState) {
    return { ok: false, error: "no remote state available — sync first" };
  }

  // Get tab list from native host (filters privileged URLs)
  const resp = await sendToNative({ action: "import_tabs", state: stored.lastRemoteState });
  if (!resp.ok) {
    return { ok: false, error: resp.error };
  }

  // Create tabs via WebExtension API
  let created = 0;
  let failed = 0;
  for (const tab of resp.tabs) {
    try {
      await browser.tabs.create({
        url: tab.url,
        active: false,
        pinned: tab.pinned || false,
      });
      created++;
    } catch (e) {
      console.warn("[zensync] failed to create tab:", tab.url, e);
      failed++;
    }
  }

  return {
    ok: true,
    created: created,
    failed: failed,
    skipped: resp.skipped,
    note: resp.note,
  };
}

// --- message handler (from popup) ---

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[zensync] message received:", message.action);
  (async () => {
    try {
      switch (message.action) {
        case "sync-now":
          console.log("[zensync] starting sync...");
          sendResponse(await performSync());
          break;
      case "apply":
          sendResponse(await stageAndApply());
          break;
      case "commit-apply":
          sendResponse(await commitApply());
          break;
      case "import-tabs":
          sendResponse(await importTabsLive());
          break;
      case "setup":
          sendResponse(
            await setupAccount(message.passphrase, message.deviceName, message.token, message.relayUrl)
          );
          break;
      case "join":
          sendResponse(
            await joinAccount(
              message.accountId,
              message.passphrase,
              message.salt,
              message.deviceName,
              message.relayUrl
            )
          );
          break;
        case "status": {
          const stored = await getStoredState();
          const status = {
            configured: !!(stored.accountId && stored.deviceId),
            accountId: stored.accountId,
            deviceName: stored.deviceName,
          };
          const lastResult = (await browser.storage.local.get("lastSyncResult")).lastSyncResult;
          if (lastResult) {
            status.lastSync = lastResult.time;
            status.lastError = lastResult.ok ? null : lastResult.error;
            status.pushOk = lastResult.push?.ok || false;
            status.pulled = lastResult.pull?.pulled;
          }
          sendResponse(status);
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown action" });
      }
    } catch (e) {
      console.error("[zensync] message handler error:", e);
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // async response
});

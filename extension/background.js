/**
 * Zen Sync — background script
 *
 * Coordinates: native host (profile IO + crypto) <-> relay (ciphertext storage)
 * Runs sync cycle on alarm + on-demand.
 */

const RELAY_URL = "https://your-relay.example.com"; // ← change this to your server
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

async function relayRequest(path, method = "GET", body = null, headers = {}) {
  const RELAY_TIMEOUT_MS = 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  try {
    const req = {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      signal: controller.signal,
    };
    if (body) req.body = JSON.stringify(body);
    const res = await fetch(`${RELAY_URL}${path}`, req);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`relay ${method} ${path}: ${res.status} ${text.substring(0, 200)}`);
    }
    try {
      return await res.json();
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
  ]);
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

  const since = stored.lastSyncTimestamp || 0;

  // 1. Pull blobs from other devices
  const blobs = await relayRequest(
    `/api/blobs?since=${since}`,
    "GET",
    null,
    {
      "X-Account-Id": stored.accountId,
      "X-Device-Id": stored.deviceId,
    }
  );

  if (!blobs || blobs.length === 0) {
    return { ok: true, pulled: 0 };
  }

  // 2. Decrypt each blob (uses stored key from OS keyring)
  const remoteStates = [];
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
  }

  // 3. Apply latest state (phase 2: write back to profile)
  // For now, store the latest remote state for UI display
  if (remoteStates.length > 0) {
    remoteStates.sort((a, b) => b.timestamp - a.timestamp);
    const latest = remoteStates[0];
    await browser.storage.local.set({
      lastRemoteState: latest.state,
      lastRemoteDevice: latest.deviceName,
      lastRemoteTime: latest.timestamp,
    });
  }

  // 4. Update last sync timestamp
  const latestTimestamp = blobs[blobs.length - 1].timestamp;
  await browser.storage.local.set({ lastSyncTimestamp: latestTimestamp });

  return { ok: true, pulled: remoteStates.length };
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

async function setupAccount(passphrase, deviceName, token) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = btoa(String.fromCharCode(...salt));

  console.log("[zensync] setup: registering on relay...");
  const regResp = await relayRequest("/api/register", "POST", {
    salt: saltB64,
    token: token || "",
  });
  console.log("[zensync] setup: account registered:", regResp.account_id);

  // Register device
  console.log("[zensync] setup: registering device...");
  const deviceResp = await relayRequest(
    "/api/devices",
    "POST",
    { name: deviceName },
    { "X-Account-Id": regResp.account_id }
  );
  console.log("[zensync] setup: device registered:", deviceResp.device_id);

  // Store derived key in OS keyring via native host (passphrase never persisted)
  console.log("[zensync] setup: storing key in native host (Argon2id, may take a few seconds)...");
  const keyResp = await sendToNative({
    action: "store_key",
    accountId: regResp.account_id,
    passphrase: passphrase,
    salt: saltB64,
  });
  console.log("[zensync] setup: store_key response:", keyResp.ok);
  if (!keyResp.ok) {
    return { ok: false, error: `failed to store key: ${keyResp.error}` };
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

async function joinAccount(accountId, passphrase, saltB64, deviceName) {
  // Register device under existing account
  const deviceResp = await relayRequest(
    "/api/devices",
    "POST",
    { name: deviceName },
    { "X-Account-Id": accountId }
  );

  // Store derived key in OS keyring
  const keyResp = await sendToNative({
    action: "store_key",
    accountId: accountId,
    passphrase: passphrase,
    salt: saltB64,
  });
  if (!keyResp.ok) {
    return { ok: false, error: `failed to store key: ${keyResp.error}` };
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
        case "setup":
          sendResponse(
            await setupAccount(message.passphrase, message.deviceName, message.token)
          );
          break;
        case "join":
          sendResponse(
            await joinAccount(
              message.accountId,
              message.passphrase,
              message.salt,
              message.deviceName
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

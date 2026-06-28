/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const { interfaces: Ci } = Components;

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenSessionStore: "resource:///modules/zen/ZenSessionManager.sys.mjs",
  ZenWindowSync: "resource:///modules/zen/ZenWindowSync.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
});

// How often background sync runs (5 minutes).
const SYNC_INTERVAL_MS = 300000;

function bufToBase64(buf) {
  const arr = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < arr.byteLength; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

function base64ToBuf(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Strip trailing slashes so `${base}${path}` never produces a double slash.
function normalizeRelayUrl(url) {
  return (url || "").trim().replace(/\/+$/, "");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export class nsZenSyncService {
  #initialized = false;
  #syncIntervalId = null;
  // A2: re-entrancy guard — holds the in-flight syncNow() promise, if any.
  #syncInFlight = null;

  init() {
    if (this.#initialized) return;
    this.#initialized = true;

    // A5: only run the periodic timer once an account is actually configured.
    if (this.#isConfiguredSync()) {
      this.startPeriodicSync();
    }
  }

  #getStringPref(pref, defaultValue = "") {
    try {
      return Services.prefs.getStringPref(pref);
    } catch (e) {
      return defaultValue;
    }
  }

  #getBoolPref(pref, defaultValue = false) {
    try {
      return Services.prefs.getBoolPref(pref);
    } catch (e) {
      return defaultValue;
    }
  }

  // Synchronous configured check (prefs are available synchronously).
  #isConfiguredSync() {
    return !!(
      this.#getStringPref("zen.sync.account_id") &&
      this.#getStringPref("zen.sync.device_id")
    );
  }

  async isConfigured() {
    return this.#isConfiguredSync();
  }

  async getConfig() {
    return {
      relayUrl: this.#getStringPref("zen.sync.relay_url"),
      accountId: this.#getStringPref("zen.sync.account_id"),
      deviceId: this.#getStringPref("zen.sync.device_id"),
      deviceName: this.#getStringPref("zen.sync.device_name"),
      salt: this.#getStringPref("zen.sync.salt"),
    };
  }

  async getStatus() {
    const lastSyncTime = this.#getStringPref("zen.sync.last_sync_time");
    const lastSyncDetails = this.#getStringPref("zen.sync.last_sync_details");
    const connected = this.#getBoolPref("zen.sync.connected", false);
    return {
      lastSyncTime: lastSyncTime ? parseInt(lastSyncTime, 10) : null,
      lastSyncDetails,
      connected,
    };
  }

  // ---- Secret handling ---------------------------------------------------
  // A4: we never persist the raw passphrase. We persist only derived material:
  //   - the auth token (used to authenticate to the relay)
  //   - the exported AES-GCM encryption key (used to en/decrypt blobs)
  // This keeps background sync working in temporary profiles without writing
  // the user's reusable passphrase to disk in cleartext.

  storeSecret(username, secret) {
    if (username === "auth_token") {
      Services.prefs.setStringPref("zen.sync.auth_token", secret);
    }
  }

  getSecret(username) {
    if (username === "auth_token") {
      return this.#getStringPref("zen.sync.auth_token");
    }
    return null;
  }

  deleteSecret(username) {
    const pref = username === "auth_token" ? "zen.sync.auth_token" : null;
    if (!pref) return;
    try {
      if (Services.prefs.prefHasUserValue(pref)) {
        Services.prefs.clearUserPref(pref);
      }
    } catch (e) {
      console.error(`ZenSync: error deleting secret pref ${pref}:`, e);
    }
  }

  async #storeEncryptionKey(key) {
    const raw = await crypto.subtle.exportKey("raw", key);
    Services.prefs.setStringPref("zen.sync.enc_key", bufToBase64(raw));
  }

  async #loadEncryptionKey() {
    let b64 = this.#getStringPref("zen.sync.enc_key");
    if (!b64) {
      // Migration from older builds that stored the raw passphrase in prefs:
      // re-derive the key, persist it, and wipe the plaintext passphrase.
      const legacyPassphrase = this.#getStringPref("zen.sync.passphrase");
      const salt = this.#getStringPref("zen.sync.salt");
      if (legacyPassphrase && salt) {
        const { encryptionKey } = await this.deriveKeys(legacyPassphrase, salt);
        await this.#storeEncryptionKey(encryptionKey);
        try {
          if (Services.prefs.prefHasUserValue("zen.sync.passphrase")) {
            Services.prefs.clearUserPref("zen.sync.passphrase");
          }
        } catch (e) {
          console.error("ZenSync: failed to clear legacy passphrase pref:", e);
        }
        return encryptionKey;
      }
      throw new Error("Encryption key missing — please reconnect Zen Sync");
    }
    return crypto.subtle.importKey(
      "raw",
      base64ToBuf(b64),
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  // ---- Crypto ------------------------------------------------------------

  async deriveKeys(passphrase, saltB64) {
    const salt = base64ToBuf(saltB64);
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey", "deriveBits"]
    );

    const encryptionKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 100000,
        hash: "SHA-256"
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    const authBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: enc.encode(saltB64 + "_auth_salt"),
        iterations: 100000,
        hash: "SHA-256"
      },
      baseKey,
      256
    );

    const authToken = Array.from(new Uint8Array(authBits))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    return { encryptionKey, authToken, authBits };
  }

  async encryptState(encryptionKey, data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      encryptionKey,
      enc.encode(JSON.stringify(data))
    );
    return {
      ciphertext: bufToBase64(ciphertext),
      nonce: bufToBase64(iv)
    };
  }

  async decryptState(encryptionKey, ciphertextB64, nonceB64) {
    const ciphertext = base64ToBuf(ciphertextB64);
    const iv = base64ToBuf(nonceB64);
    let decrypted;
    try {
      decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        encryptionKey,
        ciphertext
      );
    } catch (e) {
      // A6: AES-GCM throws an opaque OperationError on auth-tag mismatch.
      throw new Error("Failed to decrypt remote data — wrong passphrase or corrupted blob");
    }
    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decrypted));
  }

  // Stable content hash (excludes the volatile timestamp) used to detect
  // whether local state diverged from the last reconciled state.
  async #hashContent(content) {
    const json = JSON.stringify(content);
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
    return bufToBase64(buf);
  }

  // ---- Relay -------------------------------------------------------------

  async relayRequest(path, method = "GET", body = null, overrideHeaders = {}) {
    const relayUrl = normalizeRelayUrl(this.#getStringPref("zen.sync.relay_url"));
    if (!relayUrl) throw new Error("Relay URL not configured");

    const accountId = this.#getStringPref("zen.sync.account_id");
    const authToken = this.getSecret("auth_token");

    const headers = {
      "Content-Type": "application/json",
      ...overrideHeaders
    };
    if (accountId) headers["X-Account-Id"] = accountId;
    if (authToken) headers["X-Auth-Token"] = authToken;

    const req = { method, headers };
    if (body) req.body = JSON.stringify(body);

    const res = await fetch(`${relayUrl}${path}`, req);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Relay error: ${res.status} ${text.substring(0, 100)}`);
    }
    return res.json();
  }

  async setupAccount({ relayUrl, token, passphrase, deviceName }) {
    relayUrl = normalizeRelayUrl(relayUrl);
    if (!/^https?:\/\//i.test(relayUrl)) {
      throw new Error("Relay URL must start with http:// or https://");
    }

    // Generate salt (16 bytes)
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const saltB64 = bufToBase64(saltBytes);

    const { encryptionKey, authToken, authBits } = await this.deriveKeys(passphrase, saltB64);

    // Compute hash for auth token (sha256 of auth bits + server salt)
    const saltBytesText = new TextEncoder().encode("zensync_server_salt");
    const concatBytes = new Uint8Array(authBits.byteLength + saltBytesText.byteLength);
    concatBytes.set(new Uint8Array(authBits), 0);
    concatBytes.set(saltBytesText, authBits.byteLength);

    const authHashBuf = await crypto.subtle.digest("SHA-256", concatBytes);
    const authHash = Array.from(new Uint8Array(authHashBuf))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    // Temporarily save relay URL to allow relayRequest to resolve
    Services.prefs.setStringPref("zen.sync.relay_url", relayUrl);

    // 1. Register account
    const regResp = await this.relayRequest("/api/register", "POST", {
      auth_hash: authHash,
      salt: saltB64,
      token: token || "",
    });

    // 2. Register device
    const deviceResp = await this.relayRequest(
      "/api/devices",
      "POST",
      { name: deviceName },
      { "X-Account-Id": regResp.account_id, "X-Auth-Token": authToken }
    );

    // 3. Save config
    Services.prefs.setStringPref("zen.sync.account_id", regResp.account_id);
    Services.prefs.setStringPref("zen.sync.device_id", deviceResp.device_id);
    Services.prefs.setStringPref("zen.sync.device_name", deviceName);
    Services.prefs.setStringPref("zen.sync.salt", saltB64);
    Services.prefs.setBoolPref("zen.sync.connected", true);

    await this.storeSecret("auth_token", authToken);
    await this.#storeEncryptionKey(encryptionKey);

    // Trigger initial sync
    await this.syncNow();
    this.startPeriodicSync();
  }

  async joinAccount({ relayUrl, accountId, salt, passphrase, deviceName }) {
    relayUrl = normalizeRelayUrl(relayUrl);
    if (!/^https?:\/\//i.test(relayUrl)) {
      throw new Error("Relay URL must start with http:// or https://");
    }

    const { encryptionKey, authToken } = await this.deriveKeys(passphrase, salt);

    // Temporarily save to allow request
    Services.prefs.setStringPref("zen.sync.relay_url", relayUrl);

    // Register device
    const deviceResp = await this.relayRequest(
      "/api/devices",
      "POST",
      { name: deviceName },
      { "X-Account-Id": accountId, "X-Auth-Token": authToken }
    );

    // Save config
    Services.prefs.setStringPref("zen.sync.account_id", accountId);
    Services.prefs.setStringPref("zen.sync.device_id", deviceResp.device_id);
    Services.prefs.setStringPref("zen.sync.device_name", deviceName);
    Services.prefs.setStringPref("zen.sync.salt", salt);
    Services.prefs.setBoolPref("zen.sync.connected", true);

    await this.storeSecret("auth_token", authToken);
    await this.#storeEncryptionKey(encryptionKey);

    // Trigger initial sync
    await this.syncNow();
    this.startPeriodicSync();
  }

  async listDevices() {
    const config = await this.getConfig();
    if (!config.accountId) return [];
    return this.relayRequest("/api/devices", "GET");
  }

  async deleteDevice(deviceId) {
    const config = await this.getConfig();
    if (!config.accountId) return;
    return this.relayRequest(`/api/devices/${deviceId}`, "DELETE");
  }

  async renameDevice(newName) {
    const config = await this.getConfig();
    if (!config.deviceId) return;

    await this.relayRequest(`/api/devices/${config.deviceId}`, "PATCH", { name: newName });
    Services.prefs.setStringPref("zen.sync.device_name", newName);
  }

  // Normalize remote blob payload (server uses snake_case) into the content
  // shape we hash and apply.
  #remoteContent(remoteState) {
    return {
      spaces: remoteState.spaces || [],
      tabs: remoteState.tabs || [],
      groups: remoteState.groups || [],
      folders: remoteState.folders || [],
      split_views: remoteState.split_views || remoteState.splitViewData || [],
    };
  }

  async syncNow() {
    // A2: coalesce concurrent calls (manual "Sync Now" + background timer).
    if (this.#syncInFlight) {
      return this.#syncInFlight;
    }
    this.#syncInFlight = this.#doSync().finally(() => {
      this.#syncInFlight = null;
    });
    return this.#syncInFlight;
  }

  async #doSync() {
    try {
      if (!this.#isConfiguredSync()) return;

      const config = await this.getConfig();
      const encryptionKey = await this.#loadEncryptionKey();

      // 1. Pull latest remote state.
      // A3: if the pull itself fails (network/auth), we must NOT fall through
      // to a push, or we could clobber good server state with stale local data.
      let remoteState = null;
      let remoteTimestamp = 0;
      const pullResp = await this.relayRequest("/api/blobs", "GET", null, {
        "X-Device-Id": config.deviceId,
      });
      if (pullResp && pullResp.length > 0) {
        // Find the blob with the highest timestamp
        let latestBlob = pullResp[0];
        for (const blob of pullResp) {
          if ((blob.timestamp || 0) > (latestBlob.timestamp || 0)) {
            latestBlob = blob;
          }
        }
        remoteState = await this.decryptState(encryptionKey, latestBlob.ciphertext, latestBlob.nonce);
        remoteTimestamp = latestBlob.timestamp || 0;
      }

      // 2. Collect current local state.
      const localStateData = lazy.ZenSessionStore.data || {};
      const localTabs = (localStateData.tabs || []).map(t => ({
        zenSyncId: t.zenSyncId || t.id || "",
        zenWorkspace: t.zenWorkspace || "",
        url: t.url || "",
        title: t.title || "",
        pinned: !!t.pinned,
        userContextId: t.userContextId || 0,
        groupId: t.groupId || null,
      }));

      const localContent = {
        spaces: localStateData.spaces || [],
        tabs: localTabs,
        groups: localStateData.groups || [],
        folders: localStateData.folders || [],
        split_views: localStateData.splitViewData || [],
      };

      // 3. Reconcile. All timestamps are epoch SECONDS.
      const lastSyncedTs = parseInt(this.#getStringPref("zen.sync.last_synced_ts"), 10) || 0;
      const lastSyncedHash = this.#getStringPref("zen.sync.last_synced_hash");
      const localHash = await this.#hashContent(localContent);
      const localChanged = localHash !== lastSyncedHash;
      const remoteIsNew = !!remoteState && remoteTimestamp > lastSyncedTs;

      let applied = false;
      let detail = "Success";

      if (remoteIsNew) {
        // Remote advanced beyond what we last reconciled. Apply it. When the
        // local copy also changed since the last sync we have a genuine
        // conflict; with a single-blob store we converge on the newer remote
        // (server-wins) and report it rather than silently dropping data both
        // ways.
        const remoteContent = this.#remoteContent(remoteState);
        lazy.ZenSessionStore.setSyncData({
          spaces: remoteContent.spaces,
          tabs: remoteContent.tabs,
          groups: remoteContent.groups,
          folders: remoteContent.folders,
          splitViewData: remoteContent.split_views,
        });
        lazy.ZenWindowSync.propagateWorkspacesToAllWindows(remoteContent.spaces);

        Services.prefs.setStringPref("zen.sync.last_synced_ts", String(remoteTimestamp));
        Services.prefs.setStringPref(
          "zen.sync.last_synced_hash",
          await this.#hashContent(remoteContent)
        );
        applied = true;
        detail = localChanged
          ? "Conflict resolved: applied newer remote state"
          : "Applied remote changes";
      }

      // 4. Push local state only when it diverged and we didn't just apply a
      // newer remote (avoids re-uploading what we just pulled / ping-pong).
      if (!applied && localChanged) {
        const pushTs = nowSeconds();
        const { ciphertext, nonce } = await this.encryptState(encryptionKey, {
          ...localContent,
          timestamp: pushTs,
        });
        await this.relayRequest("/api/blobs", "POST", {
          version: 1,
          ciphertext,
          nonce,
        }, {
          "X-Device-Id": config.deviceId,
        });
        Services.prefs.setStringPref("zen.sync.last_synced_ts", String(pushTs));
        Services.prefs.setStringPref("zen.sync.last_synced_hash", localHash);
        detail = "Pushed local changes";
      } else if (!applied && !localChanged) {
        detail = "Up to date";
      }

      Services.prefs.setStringPref("zen.sync.last_sync_time", Date.now().toString());
      Services.prefs.setStringPref("zen.sync.last_sync_details", detail);
      Services.prefs.setBoolPref("zen.sync.connected", true);
    } catch (e) {
      Services.prefs.setStringPref("zen.sync.last_sync_time", Date.now().toString());
      Services.prefs.setStringPref("zen.sync.last_sync_details", `Error: ${e.message}`);
      Services.prefs.setBoolPref("zen.sync.connected", false);
      throw e;
    }
  }

  async disconnectAccount() {
    try {
      this.stopPeriodicSync();
    } catch (e) {
      console.error("ZenSync: error stopping sync:", e);
    }

    try {
      this.deleteSecret("auth_token");
    } catch (e) {
      console.error("ZenSync: error deleting auth_token:", e);
    }

    const prefsToClear = [
      "zen.sync.relay_url",
      "zen.sync.account_id",
      "zen.sync.device_id",
      "zen.sync.device_name",
      "zen.sync.salt",
      "zen.sync.last_sync_time",
      "zen.sync.last_sync_details",
      "zen.sync.last_synced_ts",
      "zen.sync.last_synced_hash",
      "zen.sync.connected",
      "zen.sync.auth_token",
      "zen.sync.enc_key",
      // Legacy: clear any plaintext passphrase left by older builds.
      "zen.sync.passphrase",
    ];

    for (const pref of prefsToClear) {
      try {
        if (Services.prefs.prefHasUserValue(pref)) {
          Services.prefs.clearUserPref(pref);
        }
      } catch (e) {
        console.error(`ZenSync: error clearing pref ${pref}:`, e);
      }
    }
  }

  async deleteAccountFromServer() {
    const config = await this.getConfig();
    if (!config.accountId) return;

    try {
      await this.relayRequest("/api/account", "DELETE");
    } catch (e) {
      console.error("ZenSync: error deleting account from server:", e);
      throw e;
    }

    await this.disconnectAccount();
  }

  startPeriodicSync() {
    this.stopPeriodicSync();
    this.#syncIntervalId = lazy.setInterval(() => {
      this.syncNow().catch(e => console.error("ZenSync: background sync failed:", e));
    }, SYNC_INTERVAL_MS);
  }

  stopPeriodicSync() {
    if (this.#syncIntervalId) {
      lazy.clearInterval(this.#syncIntervalId);
      this.#syncIntervalId = null;
    }
  }

  restartBrowser() {
    Services.startup.quit(Ci.nsIAppStartup.eRestart | Ci.nsIAppStartup.eAttemptQuit);
  }
}

export const ZenSyncService = new nsZenSyncService();

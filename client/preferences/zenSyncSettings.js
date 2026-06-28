/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Zen Sync preferences pane controller (gZenSyncSettings).
// Loaded into about:preferences by zenSync.inc.xhtml and registered via
// register_module("paneZenSync", gZenSyncSettings) in preferences.js.
// Talks to the relay through the global ZenSyncService (ZenSyncService.sys.mjs).

var gZenSyncSettings = {
  isJoinMode: false,

  async init() {
    const setupGroup = document.getElementById("zenSyncSetupGroup");
    const statusGroup = document.getElementById("zenSyncStatusGroup");

    if (!setupGroup || !statusGroup) {
      return;
    }

    if (this.__hasInitialized) {
      return;
    }
    this.__hasInitialized = true;

    // Load elements
    this.relayUrlInput = document.getElementById("zenSyncRelayUrl");
    this.tokenInput = document.getElementById("zenSyncToken");
    this.deviceNameInput = document.getElementById("zenSyncDeviceName");
    this.passphraseInput = document.getElementById("zenSyncPassphrase");
    this.joinAccountIdInput = document.getElementById("zenSyncJoinAccountId");
    this.joinSaltInput = document.getElementById("zenSyncJoinSalt");

    this.activeDeviceInput = document.getElementById("zenSyncActiveDeviceName");
    this.accountIdInput = document.getElementById("zenSyncAccountId");
    this.saltInput = document.getElementById("zenSyncSalt");
    this.lastTimeLabel = document.getElementById("zenSyncLastTime");
    this.statusText = document.getElementById("zenSyncStatusText");
    this.statusDot = document.getElementById("zenSyncStatusDot");

    this.btnAction = document.getElementById("zenSyncBtnAction");
    this.btnSwitchMode = document.getElementById("zenSyncBtnSwitchMode");
    this.btnRename = document.getElementById("zenSyncBtnRenameDevice");
    this.btnSyncNow = document.getElementById("zenSyncBtnSyncNow");
    this.btnDisconnect = document.getElementById("zenSyncBtnDisconnect");
    this.btnDeleteAccount = document.getElementById("zenSyncBtnDeleteAccount");

    // Add listeners
    this.btnAction.addEventListener("click", () => this.handleAction());
    this.btnSwitchMode.addEventListener("click", () => this.toggleSetupMode());
    this.btnRename.addEventListener("click", () => this.handleRename());
    this.btnSyncNow.addEventListener("click", () => this.handleSyncNow());
    this.btnDisconnect.addEventListener("click", () => this.handleDisconnect());
    if (this.btnDeleteAccount) {
      this.btnDeleteAccount.addEventListener("click", () => this.handleDeleteAccount());
    }

    // Initialize UI state
    await this.updateUI();

    window.addEventListener("unload", () => {
      this.__hasInitialized = false;
    });
  },

  toggleSetupMode() {
    this.isJoinMode = !this.isJoinMode;
    
    const header = document.getElementById("zenSyncSetupHeader");
    const desc = document.getElementById("zenSyncSetupDesc");
    const rowToken = document.getElementById("zenSyncRowToken");
    const rowJoinId = document.getElementById("zenSyncRowJoinAccountId");
    const rowJoinSalt = document.getElementById("zenSyncRowJoinSalt");

    if (this.isJoinMode) {
      if (header) header.textContent = "Join Existing Account";
      if (desc) desc.textContent = "Connect to an existing Zen Sync account using the credentials from your other device.";
      if (rowToken) rowToken.hidden = true;
      if (rowJoinId) rowJoinId.hidden = false;
      if (rowJoinSalt) rowJoinSalt.hidden = false;
      if (this.btnAction) this.btnAction.label = "Join Account";
      if (this.btnSwitchMode) this.btnSwitchMode.label = "Create New Account Instead";
    } else {
      if (header) header.textContent = "Create New Sync Account";
      if (desc) desc.textContent = "Connect your browser to a self-hosted or public Zen Sync relay to synchronize workspaces and tabs.";
      if (rowToken) rowToken.hidden = false;
      if (rowJoinId) rowJoinId.hidden = true;
      if (rowJoinSalt) rowJoinSalt.hidden = true;
      if (this.btnAction) this.btnAction.label = "Create Account";
      if (this.btnSwitchMode) this.btnSwitchMode.label = "Join Existing Account Instead";
    }
  },

  async updateUI() {
    try {
      const isConfigured = await ZenSyncService.isConfigured();
      const setupGroup = document.getElementById("zenSyncSetupGroup");
      const statusGroup = document.getElementById("zenSyncStatusGroup");

      if (!isConfigured) {
        setupGroup.hidden = false;
        statusGroup.hidden = true;
        try {
          this.relayUrlInput.value = Services.prefs.getStringPref("zen.sync.relay_url");
        } catch (e) {
          this.relayUrlInput.value = "";
        }
        this.deviceNameInput.value = "";
        this.passphraseInput.value = "";
        this.tokenInput.value = "";
        this.joinAccountIdInput.value = "";
        this.joinSaltInput.value = "";
        this.isJoinMode = true; // force toggleSetupMode to switch to false (Create Mode)
        this.toggleSetupMode();
      } else {
        setupGroup.hidden = true;
        statusGroup.hidden = false;
        
        const config = await ZenSyncService.getConfig();
        this.activeDeviceInput.value = config.deviceName || "";
        this.accountIdInput.value = config.accountId || "";
        this.saltInput.value = config.salt || "";
        
        const status = await ZenSyncService.getStatus();
        this.statusText.textContent = status.connected ? "Connected" : "Disconnected (Error)";
        this.statusDot.style.background = status.connected ? "#10b981" : "#ef4444";
        
        if (status.lastSyncTime) {
          const timeStr = new Date(status.lastSyncTime).toLocaleString();
          this.lastTimeLabel.textContent = `Last Synced: ${timeStr} (${status.lastSyncDetails || "Success"})`;
        } else {
          this.lastTimeLabel.textContent = "Last Synced: Never";
        }

        // Update linked devices list
        const listContainer = document.getElementById("zenSyncDeviceList");
        if (listContainer) {
          listContainer.textContent = "";
          try {
            const devices = await ZenSyncService.listDevices();
            if (devices && devices.length > 0) {
              for (const device of devices) {
                const deviceRow = document.createElement("div");
                deviceRow.className = "device-item-row";

                const nameSpan = document.createElement("span");
                nameSpan.textContent = device.name + (device.device_id === config.deviceId ? " (Current Device)" : "");
                nameSpan.style.flex = "1";
                nameSpan.style.fontWeight = device.device_id === config.deviceId ? "600" : "400";

                const seenSpan = document.createElement("span");
                seenSpan.style.color = "var(--in-content-deemphasized-text, #a3a3a3)";
                seenSpan.style.fontSize = "11px";
                seenSpan.style.marginRight = "12px";
                const lastSeenDate = new Date(device.last_seen * 1000).toLocaleString();
                seenSpan.textContent = `Last seen: ${lastSeenDate}`;

                deviceRow.appendChild(nameSpan);
                deviceRow.appendChild(seenSpan);

                if (device.device_id !== config.deviceId) {
                  const revokeBtn = document.createElement("button");
                  revokeBtn.textContent = "Revoke";
                  revokeBtn.className = "accessory-button";
                  revokeBtn.setAttribute("is", "highlightable-button");
                  revokeBtn.addEventListener("click", async () => {
                    if (confirm(`Are you sure you want to revoke/remove device "${device.name}"?`)) {
                      revokeBtn.disabled = true;
                      try {
                        await ZenSyncService.deleteDevice(device.device_id);
                        await this.updateUI();
                      } catch (e) {
                        alert(`Failed to revoke device: ${e.message}`);
                        revokeBtn.disabled = false;
                      }
                    }
                  });
                  deviceRow.appendChild(revokeBtn);
                }

                listContainer.appendChild(deviceRow);
              }
            } else {
              listContainer.textContent = "No linked devices found.";
            }
          } catch (e) {
            listContainer.textContent = `Error loading devices: ${e.message}`;
          }
        }
      }
    } catch (e) {
      console.error("ZenSync: error updating UI:", e);
      // Fallback: force UI state swap
      const setupGroup = document.getElementById("zenSyncSetupGroup");
      const statusGroup = document.getElementById("zenSyncStatusGroup");
      if (setupGroup && statusGroup) {
        setupGroup.hidden = false;
        statusGroup.hidden = true;
      }
    }
  },

  async handleAction() {
    const relayUrl = this.relayUrlInput.value.trim();
    const passphrase = this.passphraseInput.value;
    const deviceName = this.deviceNameInput.value.trim() || "Desktop Browser";

    if (!relayUrl || !passphrase) {
      alert("Relay URL and Passphrase are required!");
      return;
    }

    this.btnAction.disabled = true;
    this.btnSwitchMode.disabled = true;
    try {
      if (this.isJoinMode) {
        const accountId = this.joinAccountIdInput.value.trim();
        const salt = this.joinSaltInput.value.trim();
        if (!accountId || !salt) {
          alert("Account ID and Salt are required to join an existing account!");
          this.btnAction.disabled = false;
          this.btnSwitchMode.disabled = false;
          return;
        }
        await ZenSyncService.joinAccount({ relayUrl, accountId, salt, passphrase, deviceName });
      } else {
        const token = this.tokenInput.value.trim();
        await ZenSyncService.setupAccount({ relayUrl, token, passphrase, deviceName });
      }
      await this.updateUI();
    } catch (e) {
      alert(`Setup failed: ${e.message}`);
    } finally {
      this.btnAction.disabled = false;
      this.btnSwitchMode.disabled = false;
    }
  },

  async handleRename() {
    const newName = this.activeDeviceInput.value.trim();
    if (!newName) {
      alert("Device name cannot be empty!");
      return;
    }
    this.btnRename.disabled = true;
    try {
      await ZenSyncService.renameDevice(newName);
      alert("Device name updated successfully!");
      await this.updateUI();
    } catch (e) {
      alert(`Rename failed: ${e.message}`);
    } finally {
      this.btnRename.disabled = false;
    }
  },

  async handleSyncNow() {
    this.btnSyncNow.disabled = true;
    this.statusText.textContent = "Syncing...";
    this.statusDot.style.background = "#3b82f6";
    try {
      await ZenSyncService.syncNow();
      alert("Sync completed successfully!");
    } catch (e) {
      alert(`Sync failed: ${e.message}`);
    } finally {
      this.btnSyncNow.disabled = false;
      await this.updateUI();
    }
  },

  async handleDisconnect() {
    if (confirm("Are you sure you want to disconnect this device from sync? All credentials will be deleted locally.")) {
      try {
        await ZenSyncService.disconnectAccount();
      } catch (e) {
        console.error("Error calling disconnectAccount:", e);
      }
      try {
        await this.updateUI();
      } catch (e) {
        console.error("Error updating UI:", e);
        // Fallback: force UI state swap
        const setupGroup = document.getElementById("zenSyncSetupGroup");
        const statusGroup = document.getElementById("zenSyncStatusGroup");
        if (setupGroup && statusGroup) {
          setupGroup.hidden = false;
          statusGroup.hidden = true;
        }
      }
    }
  },

  async handleDeleteAccount() {
    if (confirm("Are you sure you want to PERMANENTLY delete your sync account from the server? This cannot be undone and will delete all data on the relay.")) {
      try {
        await ZenSyncService.deleteAccountFromServer();
        alert("Account deleted successfully!");
      } catch (e) {
        console.error("Error calling deleteAccountFromServer:", e);
        alert(`Failed to delete account from server: ${e.message}`);
      }
      try {
        await this.updateUI();
      } catch (e) {
        console.error("Error updating UI:", e);
        // Fallback: force UI state swap
        const setupGroup = document.getElementById("zenSyncSetupGroup");
        const statusGroup = document.getElementById("zenSyncStatusGroup");
        if (setupGroup && statusGroup) {
          setupGroup.hidden = false;
          statusGroup.hidden = true;
        }
      }
    }
  }
};

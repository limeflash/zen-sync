/**
 * Zen Sync — popup UI logic (shadcn-style)
 */

const $ = (id) => document.getElementById(id);

// --- theme ---
function loadTheme() {
  const saved = localStorage.getItem("zensync-theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  $("icon-moon").style.display = saved === "dark" ? "none" : "block";
  $("icon-sun").style.display = saved === "dark" ? "block" : "none";
}
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("zensync-theme", next);
  $("icon-moon").style.display = next === "dark" ? "none" : "block";
  $("icon-sun").style.display = next === "dark" ? "block" : "none";
}
$("theme-toggle").addEventListener("click", toggleTheme);

// --- tabs ---
function switchTab(tab) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === `view-${tab}`));
  if (tab === "status") refreshStatus();
  if (tab === "pair") refreshQR();
}
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));

// --- auto-save form state (survives popup close/reopen) ---
const FORM_STORAGE_KEY = "zensync_form_draft";

function saveFormDraft() {
  // Fire-and-forget: don't await, popup may close before promise resolves
  browser.storage.local.set({
    [FORM_STORAGE_KEY]: {
      setup_device: $("setup-device")?.value || "",
      setup_relay: $("setup-relay")?.value || "",
      setup_token: $("setup-token")?.value || "",
      join_relay: $("join-relay")?.value || "",
      join_account: $("join-account")?.value || "",
      join_salt: $("join-salt")?.value || "",
      join_device: $("join-device")?.value || "",
    }
  });
}

function loadFormDraft() {
  return browser.storage.local.get(FORM_STORAGE_KEY).then(stored => {
    const draft = stored[FORM_STORAGE_KEY];
    if (!draft) return;
    for (const [id, val] of Object.entries(draft)) {
      const el = $(id);
      if (el && val) el.value = val;
    }
  });
}

// Auto-save on every keystroke + on blur (popup close)
document.querySelectorAll("input").forEach(el => {
  el.addEventListener("input", saveFormDraft);
  el.addEventListener("change", saveFormDraft);
  el.addEventListener("blur", saveFormDraft);
});

// Save on popup unload (last chance before close)
window.addEventListener("beforeunload", saveFormDraft);
window.addEventListener("pagehide", saveFormDraft);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveFormDraft();
});

// --- toast ---
function showToast(msg, type = "") {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove("show"), 2500);
}

// --- copy ---
document.querySelectorAll(".copy-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const target = $(btn.dataset.copy);
    if (!target || !target.value) return;
    try {
      await navigator.clipboard.writeText(target.value);
      btn.classList.add("copied");
      showToast("Copied to clipboard", "success");
      setTimeout(() => btn.classList.remove("copied"), 1500);
    } catch {
      target.select();
      document.execCommand("copy");
      showToast("Copied", "success");
    }
  });
});

// --- native messaging ---
async function sendToBg(msg, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout: background did not respond in ${timeoutMs / 1000}s`));
    }, timeoutMs);

    browser.runtime.sendMessage(msg).then(
      (resp) => { clearTimeout(timer); resolve(resp); },
      (err) => { clearTimeout(timer); reject(new Error(err?.message || String(err))); }
    );
  });
}

// --- status ---
async function refreshStatus() {
  try {
    const status = await sendToBg({ action: "status" });
    const dot = $("status-dot");
    const text = $("status-text");

    if (!status.configured) {
      dot.className = "status-dot idle";
      text.textContent = "Not configured";
      $("status-device").textContent = "—";
      $("status-account").textContent = "—";
      $("btn-sync").disabled = true;
      $("sync-card").style.display = "none";
      $("account-info").style.display = "none";
      $("btn-edit-device").style.display = "none";
      $("edit-device-container").style.display = "none";
      $("status-device").style.display = "inline";
      return;
    }

    dot.className = "status-dot ok";
    text.textContent = "Connected";
    $("status-device").textContent = status.deviceName || "—";
    $("status-device").style.display = "inline";
    $("btn-edit-device").style.display = "inline-block";
    $("edit-device-container").style.display = "none";
    $("status-account").textContent = status.accountId
      ? `${status.accountId.slice(0, 8)}…${status.accountId.slice(-4)}`
      : "—";
      $("btn-sync").disabled = false;
      // Enable apply + import if we have remote state
      browser.storage.local.get("lastRemoteState").then(s => {
        const hasRemote = !!s.lastRemoteState;
        $("btn-apply").disabled = !hasRemote;
        $("btn-import").disabled = !hasRemote;
      });

    if (status.lastSync) {
      $("sync-card").style.display = "block";
      const time = new Date(status.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      $("sync-time").textContent = time;
      if (status.lastError) {
        $("sync-push").textContent = "Error";
        $("sync-pull").textContent = status.lastError.slice(0, 30);
        dot.className = "status-dot err";
        text.textContent = "Sync error";
      } else {
        $("sync-push").textContent = status.pushOk ? "OK" : "—";
        $("sync-pull").textContent = status.pulled != null ? `${status.pulled} items` : "—";
      }
    } else {
      $("sync-card").style.display = "none";
    }

    // Show pairing info
    const stored = await browser.storage.local.get(["accountId", "salt"]);
    if (stored.accountId && stored.salt) {
      $("account-info").style.display = "block";
      $("copy-account").value = stored.accountId;
      $("copy-salt").value = stored.salt;
    } else {
      $("account-info").style.display = "none";
    }
  } catch (e) {
    $("status-text").textContent = `Error: ${e.message}`;
    $("status-dot").className = "status-dot err";
  }
}

$("btn-refresh").addEventListener("click", refreshStatus);

// --- rename device ---
$("btn-edit-device").addEventListener("click", () => {
  const currentName = $("status-device").textContent;
  $("input-device-name").value = currentName === "—" ? "" : currentName;
  $("status-device").style.display = "none";
  $("btn-edit-device").style.display = "none";
  $("edit-device-container").style.display = "inline-flex";
  $("input-device-name").focus();
});

$("btn-cancel-device").addEventListener("click", () => {
  $("status-device").style.display = "inline";
  $("btn-edit-device").style.display = "inline-block";
  $("edit-device-container").style.display = "none";
});

$("btn-save-device").addEventListener("click", async () => {
  const newName = $("input-device-name").value.trim();
  if (!newName) {
    showToast("Device name cannot be empty", "error");
    return;
  }
  const saveBtn = $("btn-save-device");
  saveBtn.disabled = true;
  saveBtn.textContent = "...";
  try {
    const res = await sendToBg({ action: "rename-device", name: newName });
    if (res.ok) {
      showToast("Device renamed successfully", "success");
      $("status-device").textContent = newName;
      $("status-device").style.display = "inline";
      $("btn-edit-device").style.display = "inline-block";
      $("edit-device-container").style.display = "none";
    } else {
      showToast(res.error || "Failed to rename device", "error");
    }
  } catch (e) {
    showToast(e.message || "Error renaming device", "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
});

// --- apply remote state: safe (stage + commit) ---
$("btn-apply").addEventListener("click", async () => {
  const btn = $("btn-apply");
  const btnText = $("btn-apply-text");
  btn.disabled = true;
  btnText.textContent = "Staging…";
  try {
    const result = await sendToBg({ action: "apply" });
    if (result.ok) {
      if (result.needs_restart) {
        btnText.textContent = "Staged";
        $("btn-commit").style.display = "inline-flex";
        $("btn-commit").disabled = false;
        showToast("Staged! Close Zen Browser, then click Commit.", "success");
      } else {
        btnText.textContent = "Applied!";
        showToast("State applied. Open Zen Browser.", "success");
      }
    } else {
      btnText.textContent = "Error";
      showToast(result.error || "Apply failed", "error");
    }
  } catch (e) {
    btnText.textContent = "Error";
    showToast(e.message, "error");
  }
  setTimeout(() => {
    btnText.textContent = "Safe Apply (restart)";
    btn.disabled = false;
  }, 3000);
});

// --- commit apply (after Zen closed) ---
$("btn-commit").addEventListener("click", async () => {
  const btn = $("btn-commit");
  const btnText = $("btn-commit-text");
  btn.disabled = true;
  btnText.textContent = "Checking Zen…";
  try {
    const result = await sendToBg({ action: "commit-apply" });
    if (result.ok) {
      btnText.textContent = "Done!";
      showToast("Applied! Open Zen Browser to see synced workspaces.", "success");
      btn.style.display = "none";
    } else {
      btnText.textContent = "Commit Apply (Zen closed)";
      showToast(result.error || "Commit failed", "error");
    }
  } catch (e) {
    btnText.textContent = "Commit Apply (Zen closed)";
    showToast(e.message, "error");
  }
  setTimeout(() => {
    btnText.textContent = "Commit Apply (Zen closed)";
    btn.disabled = false;
  }, 3000);
});

// --- import tabs (live, no restart) ---
$("btn-import").addEventListener("click", async () => {
  const btn = $("btn-import");
  const btnText = $("btn-import-text");
  btn.disabled = true;
  btnText.textContent = "Importing…";
  try {
    const result = await sendToBg({ action: "import-tabs" });
    if (result.ok) {
      btnText.textContent = `Imported ${result.created} tabs`;
      const msg = `Imported ${result.created} tabs, ${result.failed} failed, ${result.skipped} skipped`;
      showToast(msg, "success");
    } else {
      btnText.textContent = "Error";
      showToast(result.error || "Import failed", "error");
    }
  } catch (e) {
    btnText.textContent = "Error";
    showToast(e.message, "error");
  }
  setTimeout(() => {
    btnText.textContent = "Import Tabs (live)";
    btn.disabled = false;
  }, 3000);
});

// --- sync ---
$("btn-sync").addEventListener("click", async () => {
  const btn = $("btn-sync");
  const btnText = $("btn-sync-text");
  const dot = $("status-dot");
  const text = $("status-text");

  btn.disabled = true;
  btnText.textContent = "Syncing…";
  dot.className = "status-dot sync";
  text.textContent = "Syncing…";

  try {
    const result = await sendToBg({ action: "sync-now" });
    if (result.ok) {
      btnText.textContent = "Done!";
      dot.className = "status-dot ok";
      text.textContent = "Synced";
      showToast(`Synced: push ${result.push?.ok ? "OK" : "skip"}, pull ${result.pull?.pulled || 0}`, "success");
    } else {
      btnText.textContent = "Error";
      dot.className = "status-dot err";
      text.textContent = "Error";
      showToast(result.error || "Sync failed", "error");
    }
  } catch (e) {
    btnText.textContent = "Error";
    dot.className = "status-dot err";
    text.textContent = "Error";
    showToast(e.message, "error");
  }
  setTimeout(() => {
    btnText.textContent = "Sync Now";
    btn.disabled = false;
    refreshStatus();
  }, 2000);
});

// --- setup ---
$("btn-setup").addEventListener("click", async () => {
  const deviceName = $("setup-device").value.trim() || "Unknown Device";
  const pass = $("setup-pass").value;
  const pass2 = $("setup-pass2").value;
  const token = $("setup-token").value.trim();
  const relayUrl = $("setup-relay").value.trim();

  if (!relayUrl) { showToast("Relay URL is required", "error"); return; }
  if (!pass || pass.length < 8) { showToast("Passphrase must be 8+ characters", "error"); return; }
  if (pass !== pass2) { showToast("Passphrases don't match", "error"); return; }

  const btn = $("btn-setup");
  btn.disabled = true;
  btn.textContent = "Creating…";

  try {
    const result = await sendToBg({ action: "setup", passphrase: pass, deviceName, token, relayUrl });
    if (result.ok) {
      showToast("Account created!", "success");
      $("setup-pass").value = "";
      $("setup-pass2").value = "";
      $("setup-token").value = "";
      // Clear token from draft, keep relay URL + device name
      saveFormDraft();
      setTimeout(() => switchTab("status"), 800);
    } else {
      showToast(result.error || "Setup failed", "error");
      btn.disabled = false;
      btn.textContent = "Create Account";
    }
  } catch (e) {
    showToast(e.message, "error");
    btn.disabled = false;
    btn.textContent = "Create Account";
  }
});

// --- join ---
$("btn-join").addEventListener("click", async () => {
  const accountId = $("join-account").value.trim();
  const salt = $("join-salt").value.trim();
  const pass = $("join-pass").value;
  const deviceName = $("join-device").value.trim() || "Unknown Device";
  const relayUrl = $("join-relay").value.trim();

  if (!relayUrl) { showToast("Relay URL is required", "error"); return; }
  if (!accountId || !salt || !pass) { showToast("Account ID, Salt, and Passphrase are required", "error"); return; }

  const btn = $("btn-join");
  btn.disabled = true;
  btn.textContent = "Joining…";

  try {
    const result = await sendToBg({ action: "join", accountId, passphrase: pass, salt, deviceName, relayUrl });
    if (result.ok) {
      showToast("Joined!", "success");
      $("join-pass").value = "";
      saveFormDraft();
      setTimeout(() => switchTab("status"), 800);
    } else {
      showToast(result.error || "Join failed", "error");
      btn.disabled = false;
      btn.textContent = "Join Account";
    }
  } catch (e) {
    showToast(e.message, "error");
    btn.disabled = false;
    btn.textContent = "Join Account";
  }
});

// --- QR pairing (account export via QR) ---
// QR contains account ID + salt + relay URL for easy sharing to device 2.
// No expiry/token — this is a convenience export, not a security boundary.
// The passphrase is NOT included — device 2 must enter it separately.

function refreshQR() {
  if (typeof qrcode === "undefined") {
    $("pair-not-configured").innerHTML = "⚠ QR library failed to load.";
    $("pair-not-configured").style.display = "block";
    $("pair-qr-canvas").style.display = "none";
    return;
  }

  browser.storage.local.get(["accountId", "salt", "relayUrl"]).then(stored => {
    if (!stored.accountId || !stored.salt) {
      $("pair-not-configured").textContent = "Set up an account first to generate a QR code.";
      $("pair-not-configured").style.display = "block";
      $("pair-qr-canvas").style.display = "none";
      return;
    }

    $("pair-not-configured").style.display = "none";

    const data = JSON.stringify({
      a: stored.accountId,
      s: stored.salt,
      r: stored.relayUrl || "your-relay-url",
    });

    try {
      const canvas = $("pair-qr-canvas");
      canvas.style.display = "block";
      drawQR(canvas, data);
    } catch (e) {
      $("pair-not-configured").textContent = "⚠ " + e.message;
      $("pair-not-configured").style.display = "block";
      $("pair-qr-canvas").style.display = "none";
    }
  }).catch(err => {
    $("pair-not-configured").textContent = "⚠ " + err.message;
    $("pair-not-configured").style.display = "block";
    $("pair-qr-canvas").style.display = "none";
  });
}

function drawQR(canvas, data) {
  // typeNumber 0 = auto-detect smallest size, errorCorrection 'M'
  const qr = qrcode(0, "M");
  qr.addData(data);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const size = 260;
  const margin = 20;
  const cellSize = (size - margin * 2) / moduleCount;

  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // White background with slight rounding
  ctx.fillStyle = "#ffffff";
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, 10);
    ctx.fill();
  } else {
    ctx.fillRect(0, 0, size, size);
  }

  // Draw modules
  ctx.fillStyle = "#000000";
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.isDark(row, col)) {
        const x = margin + col * cellSize;
        const y = margin + row * cellSize;
        ctx.fillRect(x, y, Math.ceil(cellSize), Math.ceil(cellSize));
      }
    }
  }
}

$("btn-regen-qr").addEventListener("click", () => {
  refreshQR();
});

// --- init ---
loadTheme();
// Load draft FIRST (blocking), then refresh status
browser.storage.local.get(FORM_STORAGE_KEY).then(stored => {
  const draft = stored[FORM_STORAGE_KEY];
  console.log("[zensync] loadFormDraft:", draft ? "has draft" : "no draft");
  if (draft) {
    for (const [id, val] of Object.entries(draft)) {
      const el = $(id);
      if (el && val) {
        el.value = val;
        console.log("[zensync] restored:", id, "=", val.substring(0, 20) + "...");
      }
    }
  }
  refreshStatus();
});

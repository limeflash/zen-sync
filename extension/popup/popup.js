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
      return;
    }

    dot.className = "status-dot ok";
    text.textContent = "Connected";
    $("status-device").textContent = status.deviceName || "—";
    $("status-account").textContent = status.accountId
      ? `${status.accountId.slice(0, 8)}…${status.accountId.slice(-4)}`
      : "—";
    $("btn-sync").disabled = false;

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

// --- QR pairing (real QR via qrcode-generator library) ---

const PAIR_TTL_SEC = 60; // QR valid for 60 seconds, then auto-regenerates
let _pairToken = null;
let _pairExpiry = 0;
let _pairTimer = null;

function uuid() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

function generatePairingToken() {
  _pairToken = uuid();
  _pairExpiry = Date.now() + PAIR_TTL_SEC * 1000;
}

function startPairCountdown() {
  clearInterval(_pairTimer);
  _pairTimer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((_pairExpiry - Date.now()) / 1000));
    const el = $("pair-countdown");
    if (el) {
      el.textContent = remaining > 0 ? `${remaining}s` : "Expired";
      el.className = "pair-timer" + (remaining <= 10 ? " urgent" : "");
    }
    if (remaining <= 0) {
      clearInterval(_pairTimer);
      refreshQR(true); // force new token
    }
  }, 1000);
}

function refreshQR(forceNewToken = false) {
  // Check if qrcode library loaded
  if (typeof qrcode === "undefined") {
    $("pair-not-configured").innerHTML = "⚠ QR library failed to load.";
    $("pair-not-configured").style.display = "block";
    $("pair-qr-canvas").style.display = "none";
    return;
  }

  browser.storage.local.get(["accountId", "salt"]).then(stored => {
    if (!stored.accountId || !stored.salt) {
      $("pair-not-configured").textContent = "Set up an account first to generate a QR code.";
      $("pair-not-configured").style.display = "block";
      $("pair-qr-canvas").style.display = "none";
      $("pair-countdown").style.display = "none";
      return;
    }

    // Generate new token if forced, or if expired, or if none exists
    const now = Date.now();
    if (forceNewToken || !_pairToken || now >= _pairExpiry) {
      generatePairingToken();
    }

    $("pair-not-configured").style.display = "none";

    const data = JSON.stringify({
      a: stored.accountId,
      s: stored.salt,
      r: "your-relay-url", // placeholder — replaced with configured relay at runtime
      t: _pairToken,
      e: _pairExpiry,
    });

    try {
      const canvas = $("pair-qr-canvas");
      canvas.style.display = "block";
      drawQR(canvas, data);

      // Show countdown
      $("pair-countdown").style.display = "inline-block";
      startPairCountdown();
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
  refreshQR(true); // force new token
});

// --- init ---
loadTheme();
refreshStatus();

const { invoke } = window.__TAURI__.core;

let currentSnapshot = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  document.getElementById("addBtn").addEventListener("click", () => showEditForm());
  document.getElementById("envBtn").addEventListener("click", showEnvStatus);
  document.getElementById("backupBtn").addEventListener("click", doBackup);
  document.getElementById("restoreBtn").addEventListener("click", showRestore);
  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) hideModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const modal = document.getElementById("modalOverlay");
      if (modal.classList.contains("show")) hideModal();
      const editing = document.querySelector(".provider-card.editing");
      if (editing) cancelEdit();
    }
  });

  await refresh();
}

async function refresh() {
  try {
    currentSnapshot = await invoke("get_config");
    document.getElementById("configPath").textContent =
      currentSnapshot.config_path.replace(/^\/Users\/[^/]+/, "~");
    renderActiveBanner(currentSnapshot);
    renderProviders(currentSnapshot);
  } catch (err) {
    toast("Failed to load config: " + err, "error");
  }
}

function renderActiveBanner(snap) {
  const banner = document.getElementById("activeBanner");
  if (!snap.active_provider) {
    banner.classList.add("empty");
    return;
  }
  banner.classList.remove("empty");
  banner.innerHTML = `
    <div class="active-banner-icon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M13 3L5 14h6l-1 7 8-11h-6l1-7z" fill="#fff" stroke="#fff" stroke-width="0.5" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="active-banner-text">
      <div class="active-banner-label">Active Provider</div>
      <div class="active-banner-provider">${esc(snap.active_provider)}</div>
      <div class="active-banner-model">${esc(snap.active_model || "—")}</div>
    </div>
  `;
}

function renderProviders(snap) {
  const list = document.getElementById("providerList");
  const count = document.getElementById("providerCount");
  count.textContent = snap.providers.length > 0 ? `(${snap.providers.length})` : "";

  if (snap.providers.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect x="8" y="6" width="32" height="36" rx="4" stroke="currentColor" stroke-width="2"/>
            <path d="M16 16h16M16 22h16M16 28h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="empty-state-text">No providers configured yet</div>
        <div class="empty-state-hint">Click "Add Provider" to get started</div>
      </div>
    `;
    return;
  }

  list.innerHTML = snap.providers.map((p) => providerCardHTML(p)).join("");

  list.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", handleCardAction);
  });
}

function providerCardHTML(p) {
  const keyBadge = p.is_env_set
    ? `<span class="badge badge-success">Key Set</span>`
    : `<span class="badge badge-danger">Key Missing</span>`;

  const activeBadge = p.is_active
    ? `<span class="badge badge-accent">Active</span>`
    : "";

  const setDefaultBtn = !p.is_active
    ? `<button class="icon-btn" data-action="activate" data-id="${esc(p.id)}" title="Set as default">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 2l2 4 4 .5-3 3 .8 4-3.8-2-3.8 2 .8-4-3-3 4-.5L8 2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
       </button>`
    : "";

  return `
    <div class="provider-card ${p.is_active ? "active" : ""}" data-id="${esc(p.id)}">
      <div class="provider-card-top">
        <span class="provider-dot"></span>
        <span class="provider-name">${esc(p.name)}</span>
        <div class="provider-badges">
          ${activeBadge}
          ${keyBadge}
        </div>
        <div class="provider-actions">
          ${setDefaultBtn}
          <button class="icon-btn" data-action="edit" data-id="${esc(p.id)}" title="Edit">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-8 8H3v-3l8-8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          </button>
          <button class="icon-btn danger" data-action="remove" data-id="${esc(p.id)}" title="Remove">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
      <div class="provider-card-body">
        <div class="provider-model">${esc(p.id === p.name ? p.id : p.id + " / " + p.name)}</div>
        <div class="provider-url">${esc(p.base_url)}</div>
        <div class="provider-meta">
          <span class="provider-meta-item"><strong>wire_api:</strong> ${esc(p.wire_api)}</span>
          <span class="provider-meta-item"><strong>env_key:</strong> ${esc(p.env_key)}</span>
        </div>
      </div>
    </div>
  `;
}

function handleCardAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const provider = currentSnapshot.providers.find((p) => p.id === id);
  if (!provider) return;

  if (action === "activate") showActivateModal(provider);
  else if (action === "edit") showEditForm(provider);
  else if (action === "remove") showRemoveConfirm(provider);
}

function showActivateModal(provider) {
  showModal(`
    <div class="modal-title">Set Default Provider</div>
    <div class="confirm-text">
      Switch the active provider to <strong>${esc(provider.name)}</strong>.<br>
      Enter the model to use:
    </div>
    <div class="form-group" style="margin-bottom:16px">
      <input class="form-input mono" id="activateModel" value="${esc(currentSnapshot.active_model || "")}" placeholder="e.g. anthropic/claude-sonnet-4" />
    </div>
    <div class="confirm-actions">
      <button class="btn btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" id="confirmActivate">Set Active</button>
    </div>
  `);
  document.getElementById("confirmActivate").addEventListener("click", async () => {
    const model = document.getElementById("activateModel").value.trim();
    if (!model) return toast("Model name is required", "error");
    try {
      await invoke("set_default", { input: { providerId: provider.id, model } });
      hideModal();
      toast(`${provider.name} is now the default`, "success");
      await refresh();
    } catch (err) {
      toast("Failed: " + err, "error");
    }
  });
  document.getElementById("activateModel").focus();
}

function showEditForm(provider) {
  const isEdit = !!provider;
  const p = provider || {};
  const list = document.getElementById("providerList");

  const existing = list.querySelector(".editing-card");
  if (existing) existing.remove();

  const card = document.createElement("div");
  card.className = "provider-card editing editing-card";
  card.innerHTML = editFormHTML(p, isEdit);

  if (isEdit) {
    const target = list.querySelector(`[data-id="${p.id}"]`);
    if (target) target.replaceWith(card);
    else list.prepend(card);
  } else {
    list.prepend(card);
  }

  card.querySelector("[data-action='cancel']").addEventListener("click", cancelEdit);
  card.querySelector("[data-action='save']").addEventListener("click", () => saveProviderFromForm(card, isEdit ? p.id : null));
  card.querySelector("#formProviderId").focus();
}

function editFormHTML(p, isEdit) {
  return `
    <div class="edit-form">
      <div class="edit-form-title">
        ${isEdit ? "Edit Provider" : "Add New Provider"}
        <button class="modal-close" data-action="cancel"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Provider ID</label>
          <input class="form-input mono" id="formProviderId" value="${esc(p.id || "")}" placeholder="openrouter" ${isEdit ? "disabled" : ""} />
        </div>
        <div class="form-group">
          <label class="form-label">Display Name</label>
          <input class="form-input" id="formName" value="${esc(p.name || "")}" placeholder="OpenRouter" />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Base URL</label>
        <input class="form-input mono" id="formBaseUrl" value="${esc(p.base_url || "")}" placeholder="https://openrouter.ai/api/v1" />
      </div>
      <div class="form-row">
      <div class="form-group">
        <label class="form-label">Default Model</label>
        <input class="form-input mono" id="formModel" value="${esc(currentSnapshot.active_model || "")}" placeholder="anthropic/claude-sonnet-4" />
        <div class="form-hint">The exact model name your provider's API expects (e.g. <code>anthropic/claude-sonnet-4</code> for OpenRouter, <code>gpt-4o</code> for OpenAI, <code>qwen2.5-coder:32b</code> for Ollama).</div>
      </div>
        <div class="form-group">
          <label class="form-label">Wire API</label>
          <select class="form-select" id="formWireApi">
            <option value="responses" ${p.wire_api === "responses" ? "selected" : ""}>Responses API</option>
            <option value="chat" ${p.wire_api === "chat" ? "selected" : ""}>Chat Completions</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Env Var Name</label>
          <input class="form-input mono" id="formEnvKey" value="${esc(p.env_key || "")}" placeholder="OPENROUTER_API_KEY" />
        </div>
        <div class="form-group">
          <label class="form-label">API Key ${isEdit ? "(leave blank to keep existing)" : ""}</label>
          <input class="form-input mono" id="formApiKey" type="password" placeholder="${isEdit ? "••••••••" : "sk-or-v1-..."}" />
        </div>
      </div>
      <label class="form-check">
        <input type="checkbox" id="formSetDefault" ${!isEdit || p.is_active ? "checked" : ""} />
        Set as default provider
      </label>
      <div class="form-actions">
        <button class="btn btn-secondary" data-action="cancel">Cancel</button>
        <button class="btn btn-primary" data-action="save">${isEdit ? "Update" : "Save"} Provider</button>
      </div>
    </div>
  `;
}

function cancelEdit() {
  refresh();
}

async function saveProviderFromForm(card, existingId) {
  const id = card.querySelector("#formProviderId").value.trim();
  const name = card.querySelector("#formName").value.trim();
  const baseUrl = card.querySelector("#formBaseUrl").value.trim();
  const model = card.querySelector("#formModel").value.trim();
  const envKey = card.querySelector("#formEnvKey").value.trim();
  const apiKey = card.querySelector("#formApiKey").value.trim();
  const wireApi = card.querySelector("#formWireApi").value;
  const setDefault = card.querySelector("#formSetDefault").checked;

  if (!id) return toast("Provider ID is required", "error");
  if (!name) return toast("Display name is required", "error");
  if (!baseUrl) return toast("Base URL is required", "error");
  if (!envKey) return toast("Env var name is required", "error");
  if (!existingId && !apiKey) return toast("API key is required for new providers", "error");

  try {
    await invoke("save_provider", {
      input: {
        id,
        name,
        baseUrl,
        model: model || id,
        envKey,
        apiKey,
        wireApi,
        setAsDefault: setDefault,
      },
    });
    toast(`${name} saved successfully`, "success");
    await refresh();
  } catch (err) {
    toast("Failed to save: " + err, "error");
  }
}

function showRemoveConfirm(provider) {
  showModal(`
    <div class="modal-title">Remove Provider</div>
    <div class="confirm-text">
      Remove <strong>${esc(provider.name)}</strong> from config?<br>
      <span style="color: var(--text-dim); font-size: 12px;">The API key env var will be left untouched.</span>
    </div>
    <div class="confirm-actions">
      <button class="btn btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn btn-danger" id="confirmRemove">Remove</button>
    </div>
  `);
  document.getElementById("confirmRemove").addEventListener("click", async () => {
    try {
      await invoke("remove_provider", { providerId: provider.id });
      hideModal();
      toast(`${provider.name} removed`, "success");
      await refresh();
    } catch (err) {
      toast("Failed: " + err, "error");
    }
  });
}

async function showEnvStatus() {
  try {
    const status = await invoke("get_env_status");
    if (status.length === 0) {
      showModal(`
        <div class="modal-title">Environment Variable Status</div>
        <div class="confirm-text">No providers configured.</div>
        <div class="confirm-actions">
          <button class="btn btn-secondary" onclick="hideModal()">Close</button>
        </div>
      `);
      return;
    }
    const items = status.map(([id, isSet]) => {
      const provider = currentSnapshot.providers.find((p) => p.id === id);
      const keyName = provider ? provider.env_key : "";
      return `
        <div class="env-item">
          <div>
            <div class="env-item-name">${esc(id)}</div>
            <div class="env-item-key">${esc(keyName)}</div>
          </div>
          ${isSet
            ? `<span class="badge badge-success">SET</span>`
            : `<span class="badge badge-danger">MISSING</span>`
          }
        </div>
      `;
    }).join("");
    showModal(`
      <div class="modal-title">
        Environment Variable Status
        <button class="modal-close" onclick="hideModal()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
      </div>
      <div class="env-list">${items}</div>
      <div style="margin-top:14px; font-size:12px; color:var(--text-dim);">
        Keys set via the app are written to your shell rc file. Open a new terminal or run <code>source ~/.zshrc</code> for changes to take effect.
      </div>
    `);
  } catch (err) {
    toast("Failed: " + err, "error");
  }
}

async function doBackup() {
  try {
    const path = await invoke("backup_config");
    toast("Backup created", "success");
  } catch (err) {
    toast("Backup failed: " + err, "error");
  }
}

async function showRestore() {
  try {
    const backups = await invoke("list_backups");
    if (backups.length === 0) {
      showModal(`
        <div class="modal-title">Restore Config</div>
        <div class="confirm-text">No backups found in ~/.codex/</div>
        <div class="confirm-actions">
          <button class="btn btn-secondary" onclick="hideModal()">Close</button>
        </div>
      `);
      return;
    }
    const items = backups.map(([name, ts]) => {
      const date = new Date(parseInt(ts) * 1000);
      const dateStr = date.toLocaleString();
      return `
        <div class="backup-item">
          <div>
            <div class="backup-item-name">${esc(dateStr)}</div>
          </div>
          <button class="btn btn-secondary" data-restore="${esc(name)}">Restore</button>
        </div>
      `;
    }).join("");
    showModal(`
      <div class="modal-title">
        Restore Config
        <button class="modal-close" onclick="hideModal()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
      </div>
      <div class="backup-list">${items}</div>
      <div style="margin-top:14px; font-size:12px; color:var(--text-dim);">
        Restoring creates a backup of the current config first.
      </div>
    `);
    document.querySelectorAll("[data-restore]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const filename = btn.dataset.restore;
        try {
          await invoke("restore_config", { filename });
          hideModal();
          toast("Config restored", "success");
          await refresh();
        } catch (err) {
          toast("Restore failed: " + err, "error");
        }
      });
    });
  } catch (err) {
    toast("Failed: " + err, "error");
  }
}

function showModal(html) {
  const overlay = document.getElementById("modalOverlay");
  document.getElementById("modalContent").innerHTML = html;
  overlay.classList.add("show");
}

function hideModal() {
  document.getElementById("modalOverlay").classList.remove("show");
}

function toast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const icons = {
    success: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="var(--success)"/><path d="M5 8.5l2 2 4-4.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    error: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="var(--danger)"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    info: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="var(--accent)"/><path d="M8 7v4.5M8 4.5v.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  };
  el.innerHTML = `<span class="toast-icon">${icons[type] || ""}</span>${esc(message)}`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.animation = "toastOut 0.2s ease forwards";
    setTimeout(() => el.remove(), 200);
  }, 3000);
}

function esc(s) {
  const div = document.createElement("div");
  div.textContent = String(s || "");
  return div.innerHTML;
}

window.hideModal = hideModal;

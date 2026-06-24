const { invoke } = window.__TAURI__.core;

// ─── Per-target configuration ───────────────────────────────────────────
// Each target describes one coding agent (Codex, Claude Code) and how to talk
// to its backend commands, what presets it offers, and how its cards/form look.

const CODEX_PRESETS = [
  { id: "huoshan", name: "HuoShan GLM 5.2", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", model: "glm-latest", envKey: "HUOSHAN_API_KEY", wireApi: "responses" },
  { id: "opencode-go", name: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1", model: "glm-5.2", envKey: "OPENCODE_GO_API_KEY", wireApi: "responses" },
  { id: "prism-api", name: "Prism API", baseUrl: "https://sub2api.558686.xyz/v1", model: "gpt-5.5", envKey: "PRISM_API_KEY", wireApi: "responses" },
];

const CLAUDE_PRESETS = [
  { id: "huoshan", name: "HuoShan GLM 5.2", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", model: "glm-latest", authType: "auth_token" },
  { id: "opencode-go", name: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go", model: "glm-5.2", authType: "auth_token" },
  { id: "litellm", name: "LiteLLM Proxy", baseUrl: "http://localhost:4000", model: "claude-sonnet-4-20250514", authType: "auth_token" },
];

const TARGETS = {
  codex: {
    id: "codex",
    label: "Codex",
    presets: CODEX_PRESETS,
    defaultCard: { iconId: "openai", name: "Built-in Default", model: "openai", url: "Codex built-in OpenAI provider" },
    getConfig: () => invoke("get_config"),
    save: (input) => invoke("save_provider", { input }),
    setDefault: (id) => invoke("set_default", { input: { providerId: id } }),
    resetDefault: () => invoke("reset_to_default"),
    remove: (id) => invoke("remove_provider", { providerId: id }),
    envStatus: () => invoke("get_env_status"),
    backup: () => invoke("backup_config"),
    listBackups: () => invoke("list_backups"),
    restore: (filename) => invoke("restore_config", { filename }),
    hasEnvStatus: true,
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    presets: CLAUDE_PRESETS,
    defaultCard: { iconId: "anthropic", name: "Anthropic Default", model: "claude (subscription)", url: "Native Anthropic API — uses your Claude subscription" },
    getConfig: () => invoke("get_claude_config"),
    save: (input) => invoke("save_claude_provider", { input }),
    setDefault: (id) => invoke("set_claude_default", { input: { providerId: id } }),
    resetDefault: () => invoke("reset_claude_default"),
    remove: (id) => invoke("remove_claude_provider", { providerId: id }),
    envStatus: null,
    backup: () => invoke("backup_claude_config"),
    listBackups: () => invoke("list_claude_backups"),
    restore: (ts) => invoke("restore_claude_config", { ts }),
    hasEnvStatus: false,
  },
};

const STORAGE_KEY = "providerSwitcher.target";
let currentTargetId = localStorage.getItem(STORAGE_KEY) || "codex";
if (!TARGETS[currentTargetId]) currentTargetId = "codex";
function T() { return TARGETS[currentTargetId]; }

let currentSnapshot = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  document.querySelectorAll(".target-seg").forEach((btn) => {
    btn.addEventListener("click", () => switchTarget(btn.dataset.target));
  });
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

  applyTargetUI();
  await refresh();
}

function switchTarget(id) {
  if (!TARGETS[id] || id === currentTargetId) return;
  currentTargetId = id;
  localStorage.setItem(STORAGE_KEY, id);
  hideModal();
  const editing = document.querySelector(".editing-card");
  if (editing) editing.remove();
  applyTargetUI();
  refresh();
}

function applyTargetUI() {
  const t = T();
  document.querySelectorAll(".target-seg").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.target === currentTargetId);
  });
  document.getElementById("appTitle").textContent = `${t.label} Providers`;
  document.getElementById("envBtn").style.display = t.hasEnvStatus ? "" : "none";
}

async function refresh() {
  try {
    currentSnapshot = await T().getConfig();
    document.getElementById("configPath").textContent =
      shortenPath(currentSnapshot.config_path || currentSnapshot.settings_path);
    renderActiveBanner(currentSnapshot);
    renderProviders(currentSnapshot);
  } catch (err) {
    toast("Failed to load config: " + err, "error");
  }
}

function renderActiveBanner(snap) {
  const banner = document.getElementById("activeBanner");
  banner.classList.remove("empty");
  const def = T().defaultCard;

  let id, name, model;
  if (snap.active_provider) {
    id = snap.active_provider;
    const provider = snap.providers.find((p) => p.id === id);
    name = provider ? provider.name : id;
    model = snap.active_model || "—";
  } else {
    id = def.iconId;
    name = def.name;
    model = def.model;
  }

  const color = ProviderIcons.colorFor(id, name);
  const icon = ProviderIcons.render(id, name, { size: 22, fill: "#fff", letterColor: "#fff" });
  banner.innerHTML = `
    <div class="active-banner-icon" style="background:${color}">
      ${icon}
    </div>
    <div class="active-banner-text">
      <div class="active-banner-label">Active Provider</div>
      <div class="active-banner-provider">${esc(name)}</div>
      <div class="active-banner-model">${esc(model)}</div>
    </div>
  `;
}

function renderProviders(snap) {
  const list = document.getElementById("providerList");
  const count = document.getElementById("providerCount");
  count.textContent = snap.providers.length > 0 ? `(${snap.providers.length})` : "";

  const defaultCard = defaultCardHTML(!snap.active_provider);

  if (snap.providers.length === 0) {
    list.innerHTML = defaultCard;
    bindCardEvents(list);
    return;
  }

  list.innerHTML = defaultCard + snap.providers.map((p) => providerCardHTML(p)).join("");
  bindCardEvents(list);
}

function bindCardEvents(list) {
  list.querySelectorAll(".provider-card").forEach((card) => {
    card.addEventListener("click", handleCardClick);
  });
  list.querySelectorAll("[data-action]").forEach((btn) => {
    if (btn.tagName === "BUTTON") {
      btn.addEventListener("click", handleCardAction);
    }
  });
}

function handleCardClick(e) {
  if (e.target.closest("button") || e.target.closest(".editing-card")) return;

  const card = e.currentTarget;
  const action = card.dataset.action;
  const id = card.dataset.id;

  if (action === "activate-default") {
    T().resetDefault()
      .then(() => { toast("Switched to default", "success"); refresh(); })
      .catch((err) => toast("Failed: " + err, "error"));
  } else if (action === "activate" && id) {
    T().setDefault(id)
      .then(() => {
        const p = currentSnapshot.providers.find((p) => p.id === id);
        toast(`${p?.name || id} is now the default`, "success");
        refresh();
      })
      .catch((err) => toast("Failed: " + err, "error"));
  }
}

function defaultCardHTML(isActive) {
  const def = T().defaultCard;
  const color = ProviderIcons.colorFor(def.iconId, def.name);
  const icon = ProviderIcons.render(def.iconId, def.name, { size: 20, fill: color });

  return `
    <div class="provider-card ${isActive ? "active" : ""}" data-action="activate-default">
      <div class="provider-card-top">
        <span class="provider-icon" style="--brand:${color}">${icon}</span>
        <span class="provider-name">${esc(def.name)}</span>
        <div class="provider-badges">
          <span class="badge badge-success">Built-in</span>
        </div>
      </div>
      <div class="provider-card-body">
        <div class="provider-model">${esc(def.model)}</div>
        <div class="provider-url">${esc(def.url)}</div>
      </div>
    </div>
  `;
}

function providerCardHTML(p) {
  const isClaude = T().id === "claude";
  const keyOk = isClaude ? p.is_key_set : p.is_env_set;
  const keyBadge = keyOk
    ? `<span class="badge badge-success">Key Set</span>`
    : `<span class="badge badge-danger">Key Missing</span>`;

  const color = ProviderIcons.colorFor(p.id, p.name);
  const icon = ProviderIcons.render(p.id, p.name, { size: 20, fill: color, letterColor: color });

  const meta = isClaude
    ? `<span class="provider-meta-item"><strong>auth:</strong> ${p.auth_type === "api_key" ? "x-api-key" : "Bearer token"}</span>`
    : `<span class="provider-meta-item"><strong>wire_api:</strong> ${esc(p.wire_api)}</span><span class="provider-meta-item"><strong>env_key:</strong> ${esc(p.env_key)}</span>`;

  return `
    <div class="provider-card ${p.is_active ? "active" : ""}" data-id="${esc(p.id)}" data-action="${p.is_active ? "" : "activate"}" data-id-attr="${esc(p.id)}">
      <div class="provider-card-top">
        <span class="provider-icon" style="--brand:${color}">${icon}</span>
        <span class="provider-name">${esc(p.name)}</span>
        <div class="provider-badges">
          ${keyBadge}
        </div>
        <div class="provider-actions">
          <button class="icon-btn" data-action="edit" data-id="${esc(p.id)}" title="Edit">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-8 8H3v-3l8-8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          </button>
          <button class="icon-btn" data-action="clone" data-id="${esc(p.id)}" title="Clone">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M11 3.5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          </button>
          <button class="icon-btn danger" data-action="remove" data-id="${esc(p.id)}" title="Remove">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
      <div class="provider-card-body">
        <div class="provider-model">${esc(p.model || p.id)}</div>
        <div class="provider-url">${esc(p.base_url)}</div>
        <div class="provider-meta">
          ${meta}
        </div>
      </div>
    </div>
  `;
}

function handleCardAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;

  if (action === "activate-default") {
    T().resetDefault()
      .then(() => {
        toast("Switched to default", "success");
        refresh();
      })
      .catch((err) => toast("Failed: " + err, "error"));
    return;
  }

  const id = btn.dataset.id;
  const provider = currentSnapshot.providers.find((p) => p.id === id);
  if (!provider) return;

  if (action === "activate") {
    T().setDefault(provider.id)
      .then(() => {
        toast(`${provider.name} is now the default`, "success");
        refresh();
      })
      .catch((err) => toast("Failed: " + err, "error"));
  } else if (action === "edit") showEditForm(provider);
  else if (action === "clone") showEditForm(provider, true);
  else if (action === "remove") showRemoveConfirm(provider);
}

function showEditForm(provider, isClone = false) {
  const isEdit = !!provider && !isClone;
  const p = provider || {};
  const list = document.getElementById("providerList");

  const existing = list.querySelector(".editing-card");
  if (existing) existing.remove();

  const card = document.createElement("div");
  card.className = "provider-card editing editing-card";
  card.innerHTML = editFormHTML(p, isEdit, isClone);

  if (isEdit) {
    const target = list.querySelector(`[data-id="${p.id}"]`);
    if (target) target.replaceWith(card);
    else list.prepend(card);
  } else {
    list.prepend(card);
  }

  card.querySelectorAll("[data-action='cancel']").forEach((btn) => {
    btn.addEventListener("click", cancelEdit);
  });
  card.querySelector("[data-action='save']").addEventListener("click", () => saveProviderFromForm(card, isEdit ? p.id : null));
  card.querySelector("#formProviderId").focus();
}

function presetOptionsHTML() {
  const presets = T().presets;
  const opts = presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
  return `<option value="">Choose a preset...</option>${opts}`;
}

function editFormHTML(p, isEdit, isClone) {
  const isClaude = T().id === "claude";
  const title = isClone ? "Clone Provider" : isEdit ? "Edit Provider" : "Add New Provider";
  const ac = 'autocapitalize="off" autocorrect="off" spellcheck="false"';

  const presetBlock = !isEdit ? `
      <div class="form-group">
        <label class="form-label">Quick add from preset</label>
        <select class="form-select" id="formPreset" onchange="applyPreset(parseInt(this.value))">
          ${presetOptionsHTML()}
        </select>
      </div>` : "";

  const authOrWireBlock = isClaude ? `
        <div class="form-group">
          <label class="form-label">Auth Type</label>
          <select class="form-select" id="formAuthType">
            <option value="auth_token" ${p.auth_type === "api_key" ? "" : "selected"}>Auth Token (Bearer header)</option>
            <option value="api_key" ${p.auth_type === "api_key" ? "selected" : ""}>API Key (x-api-key header)</option>
          </select>
          <div class="form-hint">Use <strong>Auth Token</strong> if your endpoint expects <code>Authorization: Bearer …</code>. Use <strong>API Key</strong> for Anthropic's native <code>x-api-key</code> header.</div>
        </div>` : `
        <div class="form-group">
          <label class="form-label">Wire API</label>
          <select class="form-select" id="formWireApi">
            <option value="responses" selected>Responses API</option>
          </select>
          <div class="form-hint">Codex only supports the <strong>Responses API</strong> (<code>wire_api = "responses"</code>).</div>
        </div>`;

  const envKeyBlock = isClaude ? "" : `
        <div class="form-group">
          <label class="form-label">Env Var Name</label>
          <input class="form-input mono" id="formEnvKey" value="${esc(p.env_key || "")}" placeholder="OPENROUTER_API_KEY" ${ac} />
        </div>`;

  const modelHint = isClaude
    ? `The model name your endpoint accepts (e.g. <code>claude-sonnet-4-20250514</code>). Claude Code sends this as <code>ANTHROPIC_MODEL</code>.`
    : `The exact model name your provider's API expects (e.g. <code>glm-4-7-251222</code> for HuoShan, <code>gpt-4o</code> for OpenAI).`;

  const apiKeyHint = isClaude
    ? `Stored in <code>~/.claude/provider-switcher.json</code> (chmod 600). When this provider is active it's written to <code>~/.claude/settings.json</code> under <code>env</code>.`
    : `Stored in your shell rc file, never in config.toml.`;

  return `
    <div class="edit-form">
      <div class="edit-form-title">
        ${title}
        <button class="modal-close" data-action="cancel"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
      </div>
      ${presetBlock}
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Provider ID</label>
          <input class="form-input mono" id="formProviderId" value="${esc(isClone ? "" : p.id || "")}" placeholder="openrouter" ${isEdit ? "disabled" : ""} ${ac} />
        </div>
        <div class="form-group">
          <label class="form-label">Display Name</label>
          <input class="form-input" id="formName" value="${esc(p.name || "")}" placeholder="OpenRouter" ${ac} />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Base URL</label>
        <input class="form-input mono" id="formBaseUrl" value="${esc(p.base_url || "")}" placeholder="${isClaude ? "http://localhost:4000" : "https://openrouter.ai/api/v1"}" ${ac} />
        ${isClaude ? `<div class="form-hint">Root URL of an Anthropic Messages-compatible endpoint. Claude Code appends <code>/v1/messages</code>. Works for both the Claude Code CLI and desktop app.</div>` : ""}
      </div>
      <div class="form-row">
      <div class="form-group">
        <label class="form-label">Default Model</label>
        <input class="form-input mono" id="formModel" value="${esc(p.model || "")}" placeholder="${isClaude ? "claude-sonnet-4-20250514" : "anthropic/claude-sonnet-4"}" ${ac} />
        <div class="form-hint">${modelHint}</div>
      </div>
        ${authOrWireBlock}
      </div>
      <div class="form-row">
        ${envKeyBlock}
        <div class="form-group">
          <label class="form-label">API Key ${isEdit ? "(leave blank to keep existing)" : ""}</label>
          <input class="form-input mono" id="formApiKey" type="password" placeholder="${isEdit ? "••••••••" : "sk-..."}" ${ac} />
          <div class="form-hint">${apiKeyHint}</div>
        </div>
      </div>
      <label class="form-check">
        <input type="checkbox" id="formSetDefault" ${!isEdit || p.is_active ? "checked" : ""} />
        Set as default provider
      </label>
      <div class="form-actions">
        <button class="btn btn-secondary" data-action="cancel">Cancel</button>
        <button class="btn btn-primary" data-action="save">${isClone ? "Clone" : isEdit ? "Update" : "Save"} Provider</button>
      </div>
    </div>
  `;
}

function cancelEdit() {
  refresh();
}

async function saveProviderFromForm(card, existingId) {
  const isClaude = T().id === "claude";
  const id = card.querySelector("#formProviderId").value.trim();
  const name = card.querySelector("#formName").value.trim();
  const baseUrl = card.querySelector("#formBaseUrl").value.trim();
  const model = card.querySelector("#formModel").value.trim();
  const apiKey = card.querySelector("#formApiKey").value.trim();
  const setDefault = card.querySelector("#formSetDefault").checked;

  if (!id) return toast("Provider ID is required", "error");
  if (!name) return toast("Display name is required", "error");
  if (!baseUrl) return toast("Base URL is required", "error");
  if (!existingId && !apiKey) return toast("API key is required for new providers", "error");

  try {
    if (isClaude) {
      const authType = card.querySelector("#formAuthType").value;
      await T().save({
        id, name, baseUrl, model: model || id, authType, apiKey, setAsDefault: setDefault,
      });
    } else {
      const envKey = card.querySelector("#formEnvKey").value.trim();
      const wireApi = card.querySelector("#formWireApi").value;
      if (!envKey) return toast("Env var name is required", "error");
      await T().save({
        id, name, baseUrl, model: model || id, envKey, apiKey, wireApi, setAsDefault: setDefault,
      });
    }
    toast(`${name} saved successfully`, "success");
    await refresh();
  } catch (err) {
    toast("Failed to save: " + err, "error");
  }
}

function showRemoveConfirm(provider) {
  const isClaude = T().id === "claude";
  const note = isClaude
    ? "If this is the active provider, the ANTHROPIC_* env vars will be cleared from settings.json."
    : "The API key env var will be left untouched.";
  showModal(`
    <div class="modal-title">Remove Provider</div>
    <div class="confirm-text">
      Remove <strong>${esc(provider.name)}</strong> from config?<br>
      <span style="color: var(--text-dim); font-size: 12px;">${note}</span>
    </div>
    <div class="confirm-actions">
      <button class="btn btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn btn-danger" id="confirmRemove">Remove</button>
    </div>
  `);
  document.getElementById("confirmRemove").addEventListener("click", async () => {
    try {
      await T().remove(provider.id);
      hideModal();
      toast(`${provider.name} removed`, "success");
      await refresh();
    } catch (err) {
      toast("Failed: " + err, "error");
    }
  });
}

async function showEnvStatus() {
  if (!T().hasEnvStatus) return;
  try {
    const status = await T().envStatus();
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
    await T().backup();
    toast("Backup created", "success");
  } catch (err) {
    toast("Backup failed: " + err, "error");
  }
}

async function showRestore() {
  const isClaude = T().id === "claude";
  const dirLabel = isClaude ? "~/.claude/" : "~/.codex/";
  try {
    const backups = await T().listBackups();
    if (backups.length === 0) {
      showModal(`
        <div class="modal-title">Restore Config</div>
        <div class="confirm-text">No backups found in ${esc(dirLabel)}</div>
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
        const key = btn.dataset.restore;
        try {
          await T().restore(key);
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

function shortenPath(path) {
  return path
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^[A-Z]:[\\/]Users[\\/][^\\/]+/i, "~")
    .replace(/\\/g, "/");
}

function esc(s) {
  const div = document.createElement("div");
  div.textContent = String(s || "");
  return div.innerHTML;
}

function applyPreset(idx) {
  if (isNaN(idx)) return;
  const p = T().presets[idx];
  if (!p) return;
  document.getElementById("formProviderId").value = p.id;
  document.getElementById("formName").value = p.name;
  document.getElementById("formBaseUrl").value = p.baseUrl;
  document.getElementById("formModel").value = p.model;
  if (T().id === "claude") {
    document.getElementById("formAuthType").value = p.authType;
  } else {
    document.getElementById("formEnvKey").value = p.envKey;
    document.getElementById("formWireApi").value = p.wireApi;
  }
}

window.hideModal = hideModal;
window.applyPreset = applyPreset;

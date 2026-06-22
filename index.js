#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const TOML = require("@iarna/toml");
const prompts = require("prompts");

const IS_WIN = process.platform === "win32";

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
function codexDir() {
  return path.join(homeDir(), ".codex");
}
function configPath() {
  return path.join(codexDir(), "config.toml");
}
function codexStorePath() {
  return path.join(codexDir(), "provider-switcher.json");
}

// App-owned sidecar that holds the per-provider `model` (app metadata that is NOT
// part of Codex's native `[model_providers.*]` schema). Mirrors the Tauri backend
// so config.toml stays limited to Codex-native fields.
function readCodexStore() {
  const p = codexStorePath();
  if (!fs.existsSync(p)) return { providers: {} };
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    if (!raw) return { providers: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.providers) {
      return { providers: {} };
    }
    return { providers: parsed.providers };
  } catch {
    return { providers: {} };
  }
}

function writeCodexStore(store) {
  ensureConfigFile();
  const p = codexStorePath();
  if (fs.existsSync(p)) {
    const bak = `${p}.bak.${Date.now()}`;
    fs.copyFileSync(p, bak);
  }
  fs.writeFileSync(p, JSON.stringify(store, null, 2) + "\n");
  if (!IS_WIN) fs.chmodSync(p, 0o600);
}

function setCodexProviderModel(providerId, model) {
  const store = readCodexStore();
  const meta = store.providers[providerId] || {};
  meta.model = model;
  store.providers[providerId] = meta;
  writeCodexStore(store);
}

function removeCodexProviderModel(providerId) {
  const store = readCodexStore();
  if (store.providers[providerId]) {
    delete store.providers[providerId];
    writeCodexStore(store);
  }
}

function getCodexProviderModel(providerId) {
  const store = readCodexStore();
  const meta = store.providers[providerId];
  return meta && meta.model ? meta.model : null;
}

// One-time migration: lift any `model = "..."` field from `[model_providers.*]`
// in config.toml into the sidecar and strip it from config.toml. Idempotent.
function migrateCodexProviderModels() {
  const config = readConfig();
  if (!config.model_providers) return;
  let changed = false;
  const store = readCodexStore();
  for (const id of Object.keys(config.model_providers)) {
    const pt = config.model_providers[id];
    if (pt && Object.prototype.hasOwnProperty.call(pt, "model")) {
      const meta = store.providers[id] || {};
      meta.model = String(pt.model);
      store.providers[id] = meta;
      delete pt.model;
      changed = true;
    }
  }
  if (changed) {
    writeConfig(config);
    writeCodexStore(store);
  }
}

function ensureConfigFile() {
  const dir = codexDir();
  const cfg = configPath();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, "");
}

function readConfig() {
  ensureConfigFile();
  const cfg = configPath();
  const raw = fs.readFileSync(cfg, "utf8").trim();
  if (!raw) return {};
  try {
    return TOML.parse(raw);
  } catch (err) {
    console.error(`Failed to parse ${cfg}: ${err.message}`);
    process.exit(1);
  }
}

function backupConfig() {
  const cfg = configPath();
  if (!fs.existsSync(cfg)) return null;
  const ts = Date.now();
  const bak = `${cfg}.bak.${ts}`;
  fs.copyFileSync(cfg, bak);
  const store = codexStorePath();
  if (fs.existsSync(store)) {
    fs.copyFileSync(store, `${store}.bak.${ts}`);
  }
  return bak;
}

function serializeConfig(config) {
  const lines = [];
  const topScalars = [];
  const tables = [];

  for (const key of Object.keys(config)) {
    const val = config[key];
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      tables.push(key);
    } else {
      topScalars.push(key);
    }
  }

  for (const key of topScalars) {
    lines.push(`${key} = ${tomlValue(config[key])}`);
  }

  for (const tableKey of tables) {
    const table = config[tableKey];
    if (tableKey === "model_providers") {
      for (const providerId of Object.keys(table)) {
        lines.push("");
        lines.push(`[model_providers.${providerId}]`);
        for (const field of Object.keys(table[providerId])) {
          lines.push(`${field} = ${tomlValue(table[providerId][field])}`);
        }
      }
    } else {
      lines.push("");
      lines.push(`[${tableKey}]`);
      for (const field of Object.keys(table)) {
        const fv = table[field];
        if (fv !== null && typeof fv === "object" && !Array.isArray(fv)) {
          lines.push(`[${tableKey}.${field}]`);
          for (const sub of Object.keys(fv)) {
            lines.push(`${sub} = ${tomlValue(fv[sub])}`);
          }
        } else {
          lines.push(`${field} = ${tomlValue(fv)}`);
        }
      }
    }
  }

  return lines.join("\n") + "\n";
}

function tomlValue(val) {
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  return `"${String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function writeConfig(config) {
  ensureConfigFile();
  const bak = backupConfig();
  fs.writeFileSync(configPath(), serializeConfig(config));
  if (bak) console.log(`Backup created: ${bak}`);
}

function getProviders(config) {
  if (!config.model_providers) return {};
  return config.model_providers;
}

function pickRcFile() {
  const shell = process.env.SHELL || "";
  const candidates = [];
  if (shell.includes("zsh")) candidates.push(".zshrc");
  if (shell.includes("bash")) candidates.push(".bashrc", ".bash_profile");
  candidates.push(".zshrc", ".bashrc", ".bash_profile", ".profile");
  for (const c of candidates) {
    const p = path.join(homeDir(), c);
    if (fs.existsSync(p)) return p;
  }
  return path.join(homeDir(), ".zshrc");
}

function setUserEnv(key, value) {
  if (IS_WIN) {
    execSync(`setx ${key} "${value.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
    console.log(`Saved ${key} via setx (Windows). Restart Codex/terminal to apply.`);
    return;
  }
  const rcFile = pickRcFile();
  let content = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, "utf8") : "";
  const line = `export ${key}="${value}"`;
  const regex = new RegExp(`^\\s*export ${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = content.trimEnd() + "\n" + line + "\n";
  }
  fs.writeFileSync(rcFile, content);
  console.log(`Saved ${key} to ${rcFile}. Run: source ${rcFile}`);
}

function isEnvVarSet(key) {
  return Boolean(process.env[key]);
}

function cyan(s) {
  return `\x1b[36m${s}\x1b[0m`;
}
function green(s) {
  return `\x1b[32m${s}\x1b[0m`;
}
function red(s) {
  return `\x1b[31m${s}\x1b[0m`;
}
function dim(s) {
  return `\x1b[2m${s}\x1b[0m`;
}
function bold(s) {
  return `\x1b[1m${s}\x1b[0m`;
}

const PROVIDER_PRESETS = [
  { title: "Custom (fill in manually)", value: null },
  {
    title: "HuoShan GLM 5.2 — Volcano Engine (Responses API)",
    value: { id: "huoshan", name: "HuoShan GLM 5.2", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", model: "glm-latest", envKey: "HUOSHAN_API_KEY", wireApi: "responses" },
  },
  {
    title: "OpenCode Go — glm-5.2 (Chat Completions)",
    value: { id: "opencode-go", name: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1", model: "glm-5.2", envKey: "OPENCODE_GO_API_KEY", wireApi: "chat" },
  },
];

async function cmdAdd() {
  const presetChoice = await prompts({
    type: "select",
    name: "preset",
    message: "Choose a provider preset",
    choices: PROVIDER_PRESETS,
    initial: 0,
  });
  if (!presetChoice) return;
  const preset = presetChoice.preset || null;

  const answers = await prompts([
    { type: "text", name: "providerId", message: "Provider ID", initial: preset ? preset.id : "openrouter", validate: (v) => (v.trim() ? true : "Required") },
    { type: "text", name: "providerName", message: "Provider display name", initial: preset ? preset.name : "OpenRouter" },
    { type: "text", name: "baseUrl", message: "Base URL", initial: preset ? preset.baseUrl : "https://openrouter.ai/api/v1" },
    { type: "text", name: "model", message: "Default model", initial: preset ? preset.model : "anthropic/claude-sonnet-4" },
    { type: "text", name: "envKey", message: "Env var name", initial: preset ? preset.envKey : "OPENROUTER_API_KEY" },
    { type: "password", name: "apiKey", message: "API key (stored in shell env, not in TOML)" },
    {
      type: "select",
      name: "wireApi",
      message: "Wire API",
      choices: [
        { title: "Responses API (recommended for Codex)", value: "responses" },
        { title: "Chat Completions API", value: "chat" },
      ],
      initial: preset ? (preset.wireApi === "chat" ? 1 : 0) : 0,
    },
    {
      type: "confirm",
      name: "setActive",
      message: "Set as the default provider/model now?",
      initial: true,
    },
  ]);

  if (!answers.providerId) return;

  migrateCodexProviderModels();
  const config = readConfig();
  config.model_providers = config.model_providers || {};
  config.model_providers[answers.providerId] = {
    name: answers.providerName || answers.providerId,
    base_url: answers.baseUrl,
    env_key: answers.envKey,
    wire_api: answers.wireApi,
  };

  if (answers.setActive) {
    config.model_provider = answers.providerId;
    config.model = answers.model;
  }

  writeConfig(config);
  setCodexProviderModel(answers.providerId, answers.model);

  if (answers.apiKey) {
    setUserEnv(answers.envKey, answers.apiKey);
  }

  console.log(green("\nProvider saved."));
  if (answers.setActive) {
    console.log(`Default: ${bold(answers.providerId)} / ${bold(answers.model)}`);
  }
  console.log(dim("Restart Codex Desktop so it picks up the new config/env."));
}

function cmdList() {
  const config = readConfig();
  const providers = getProviders(config);
  const ids = Object.keys(providers);
  if (ids.length === 0) {
    console.log(dim("No providers configured yet. Run `cpm add`."));
    return;
  }
  const activeProvider = config.model_provider;
  const activeModel = config.model;
  console.log(bold("Configured providers:\n"));
  for (const id of ids) {
    const p = providers[id];
    const marker = id === activeProvider ? green("* ") : "  ";
    const keyState = isEnvVarSet(p.env_key) ? green("set") : red("MISSING");
    console.log(`${marker}${cyan(id)} — ${p.name || id}`);
    console.log(`     base_url: ${p.base_url}`);
    console.log(`     wire_api: ${p.wire_api}`);
    console.log(`     env_key:  ${p.env_key} [${keyState} in current shell]`);
    if (id === activeProvider) {
      console.log(`     model:    ${activeModel || "(none)"}`);
    }
  }
  console.log(`\n${green("*")} = active default`);
}

async function cmdUse(providerArg, modelArg) {
  migrateCodexProviderModels();
  const config = readConfig();
  const providers = getProviders(config);
  const ids = Object.keys(providers);

  let providerId = providerArg;
  let model = modelArg;

  if (!providerId) {
    if (ids.length === 0) {
      console.log(dim("No providers configured yet. Run `cpm add`."));
      return;
    }
    const choice = await prompts({
      type: "select",
      name: "id",
      message: "Switch default provider",
      choices: ids.map((id) => ({ title: `${id} — ${providers[id].name || id}`, value: id })),
    });
    providerId = choice && choice.id;
  }

  if (!providerId || !providers[providerId]) {
    if (providerArg) {
      console.log(red(`Unknown provider: ${providerArg}`));
      console.log(dim(`Available: ${ids.join(", ") || "(none)"}`));
    } else {
      console.log(dim("Cancelled."));
    }
    return;
  }

  if (!model) {
    const savedModel = getCodexProviderModel(providerId);
    const m = await prompts({
      type: "text",
      name: "value",
      message: "Default model",
      initial: savedModel || config.model || "",
    });
    model = m && m.value;
  }

  if (!model) {
    console.log(dim("Cancelled."));
    return;
  }

  config.model_provider = providerId;
  config.model = model;
  writeConfig(config);
  setCodexProviderModel(providerId, model);
  console.log(green(`Default set to ${providerId} / ${model}`));
  console.log(dim("Restart Codex Desktop to apply."));
}

async function cmdRemove(providerArg) {
  migrateCodexProviderModels();
  const config = readConfig();
  const providers = getProviders(config);
  const ids = Object.keys(providers);
  let providerId = providerArg;

  if (!providerId) {
    if (ids.length === 0) {
      console.log(dim("No providers configured."));
      return;
    }
    const choice = await prompts({
      type: "select",
      name: "id",
      message: "Remove provider",
      choices: ids.map((id) => ({ title: `${id} — ${providers[id].name || id}`, value: id })),
    });
    providerId = choice && choice.id;
  }

  if (!providerId || !providers[providerId]) {
    if (providerArg) {
      console.log(red(`Unknown provider: ${providerArg}`));
    } else {
      console.log(dim("Cancelled."));
    }
    return;
  }

  const confirm = await prompts({
    type: "confirm",
    name: "ok",
    message: `Remove '${providerId}' from config.toml? (env var is left untouched)`,
    initial: false,
  });
  if (!confirm || !confirm.ok) return;

  delete config.model_providers[providerId];
  if (config.model_provider === providerId) {
    delete config.model_provider;
    delete config.model;
  }
  writeConfig(config);
  removeCodexProviderModel(providerId);
  console.log(green(`Removed ${providerId}.`));
}

function cmdEnv() {
  const config = readConfig();
  const providers = getProviders(config);
  const ids = Object.keys(providers);
  if (ids.length === 0) {
    console.log(dim("No providers configured."));
    return;
  }
  console.log(bold("Env var status (current shell):\n"));
  for (const id of ids) {
    const p = providers[id];
    const state = isEnvVarSet(p.env_key) ? green("SET") : red("MISSING");
    console.log(`  ${cyan(id.padEnd(16))} ${p.env_key.padEnd(28)} [${state}]`);
  }
  console.log(dim("\nNote: a freshly set var only shows as SET after `source ~/.zshrc` or a new terminal."));
}

function cmdBackup() {
  const bak = backupConfig();
  if (bak) console.log(green(`Backup created: ${bak}`));
  else console.log(dim("No config.toml exists yet."));
}

async function cmdRestore() {
  const files = fs
    .readdirSync(codexDir())
    .filter((f) => f.startsWith("config.toml.bak."))
    .sort()
    .reverse();
  if (files.length === 0) {
    console.log(dim("No backups found in ~/.codex"));
    return;
  }
  const choice = await prompts({
    type: "select",
    name: "file",
    message: "Restore from backup",
    choices: files.map((f) => ({ title: f, value: f })),
  });
  if (!choice.file) return;
  backupConfig();
  fs.copyFileSync(path.join(codexDir(), choice.file), configPath());

  // Restore the matching sidecar backup (same timestamp), if present.
  const ts = choice.file.replace(/^config\.toml\.bak\./, "");
  const store = codexStorePath();
  const storeBak = path.join(codexDir(), `provider-switcher.json.bak.${ts}`);
  if (fs.existsSync(storeBak)) {
    fs.copyFileSync(storeBak, store);
    if (!IS_WIN) fs.chmodSync(store, 0o600);
  }

  // A restored pre-migration backup may carry `model = "..."` inside
  // `[model_providers.*]`; migrate it into the sidecar so config.toml stays clean.
  migrateCodexProviderModels();

  console.log(green(`Restored from ${choice.file}`));
}

function help() {
  console.log(
    bold("codex-provider-manager (cpm)") +
      " — manage Codex model provider configs\n\n" +
      "Usage:\n" +
      "  cpm                       Interactive: add a provider\n" +
      "  cpm add                   Add a new provider (interactive)\n" +
      "  cpm list                  List providers + show active default & env status\n" +
      "  cpm use [provider] [model]  Switch the default provider/model\n" +
      "  cpm remove [provider]     Remove a provider from config\n" +
      "  cpm env                   Show which API key env vars are set\n" +
      "  cpm backup                Create a timestamped backup of config.toml\n" +
      "  cpm restore               Restore config.toml from a backup\n" +
      "  cpm help                  Show this help\n\n" +
      dim("Config: " + configPath())
  );
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case undefined:
    case "add":
      await cmdAdd();
      break;
    case "list":
    case "ls":
      cmdList();
      break;
    case "use":
    case "switch":
      await cmdUse(rest[0], rest[1]);
      break;
    case "remove":
    case "rm":
      await cmdRemove(rest[0]);
      break;
    case "env":
      cmdEnv();
      break;
    case "backup":
      cmdBackup();
      break;
    case "restore":
      await cmdRestore();
      break;
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    default:
      console.log(red(`Unknown command: ${cmd}`));
      help();
      process.exit(1);
  }
}

module.exports = {
  homeDir,
  codexDir,
  configPath,
  codexStorePath,
  readConfig,
  writeConfig,
  serializeConfig,
  backupConfig,
  getProviders,
  setUserEnv,
  pickRcFile,
  isEnvVarSet,
  readCodexStore,
  writeCodexStore,
  setCodexProviderModel,
  removeCodexProviderModel,
  getCodexProviderModel,
  migrateCodexProviderModels,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

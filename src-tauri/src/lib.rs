use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

fn codex_dir() -> PathBuf {
    let home = dirs::home_dir().expect("Cannot find home directory");
    home.join(".codex")
}

fn config_path() -> PathBuf {
    codex_dir().join("config.toml")
}

fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    secs.to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Provider {
    pub name: String,
    pub base_url: String,
    pub env_key: String,
    pub wire_api: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub env_key: String,
    pub wire_api: String,
    pub is_active: bool,
    pub is_env_set: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ConfigSnapshot {
    pub providers: Vec<ProviderInfo>,
    pub active_provider: Option<String>,
    pub active_model: Option<String>,
    pub config_path: String,
}

fn read_config_toml() -> Result<toml::Value, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(toml::Value::Table(toml::value::Table::new()));
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config: {}", e))?;
    if content.trim().is_empty() {
        return Ok(toml::Value::Table(toml::value::Table::new()));
    }
    toml::from_str(&content).map_err(|e| format!("Failed to parse TOML: {}", e))
}

fn write_config_toml(config: &toml::Value) -> Result<(), String> {
    let path = config_path();
    fs::create_dir_all(codex_dir()).map_err(|e| format!("Cannot create .codex dir: {}", e))?;

    if path.exists() {
        let bak = format!("{}.bak.{}", path.display(), timestamp());
        let _ = fs::copy(&path, &bak);
    }

    let content = toml::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize TOML: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

// ─── Codex app-owned sidecar ──────────────────────────────────────────────
// The per-provider `model` is app metadata, NOT a Codex-native field of
// `[model_providers.*]` (Codex's schema there is name/base_url/env_key/wire_api).
// We store it in a sidecar JSON file so config.toml stays limited to fields Codex
// actually understands. This mirrors how Claude Code keeps app metadata in
// ~/.claude/provider-switcher.json and only writes ANTHROPIC_* env vars into
// settings.json — so resetting to the built-in default never leaves app-only
// pollution behind in the agent's native config.
fn codex_store_path() -> PathBuf {
    codex_dir().join("provider-switcher.json")
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CodexProviderMeta {
    #[serde(default)]
    pub model: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CodexStore {
    #[serde(default)]
    pub providers: std::collections::BTreeMap<String, CodexProviderMeta>,
}

fn read_codex_store() -> Result<CodexStore, String> {
    let path = codex_store_path();
    if !path.exists() {
        return Ok(CodexStore::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read provider-switcher.json: {}", e))?;
    if content.trim().is_empty() {
        return Ok(CodexStore::default());
    }
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse provider-switcher.json: {}", e))
}

fn write_codex_store(store: &CodexStore) -> Result<(), String> {
    let dir = codex_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create .codex dir: {}", e))?;
    let path = codex_store_path();
    if path.exists() {
        let bak = format!("{}.bak.{}", path.display(), timestamp());
        let _ = fs::copy(&path, &bak);
    }
    let mut content = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize provider-switcher.json: {}", e))?;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    fs::write(&path, &content)
        .map_err(|e| format!("Failed to write provider-switcher.json: {}", e))?;
    set_file_perms_600(&path);
    Ok(())
}

/// Pure core of the migration: given a parsed config.toml and the current sidecar,
/// move any `model = "..."` from `[model_providers.*]` into the sidecar and strip
/// it from config.toml. Returns the updated (config, store, changed). This is the
/// testable part — the file-backed wrapper below handles I/O.
fn migrate_codex_provider_models_into(
    mut config: toml::Value,
    mut store: CodexStore,
) -> (toml::Value, CodexStore, bool) {
    let mut changed = false;
    let root = match config.as_table_mut() {
        Some(t) => t,
        None => return (config, store, changed),
    };

    if let Some(toml::Value::Table(providers_table)) = root.get_mut("model_providers") {
        for (id, val) in providers_table.iter_mut() {
            if let toml::Value::Table(pt) = val {
                if let Some(toml::Value::String(model)) = pt.remove("model") {
                    let meta = store
                        .providers
                        .entry(id.clone())
                        .or_default();
                    meta.model = model;
                    changed = true;
                }
            }
        }
    }

    (config, store, changed)
}

/// Move any `model = "..."` field from `[model_providers.X]` tables in config.toml
/// into the sidecar, and strip it from config.toml. Idempotent: a no-op once
/// migration has run. Keeps config.toml limited to Codex-native fields so that
/// `reset_to_default` leaves no app-only metadata behind.
fn migrate_codex_provider_models() -> Result<(), String> {
    let config = read_config_toml()?;
    let store = read_codex_store()?;
    let (config, store, changed) = migrate_codex_provider_models_into(config, store);
    if changed {
        write_config_toml(&config)?;
        write_codex_store(&store)?;
    }
    Ok(())
}

fn ensure_table<'a>(root: &'a mut toml::value::Table, key: &str) -> Result<&'a mut toml::value::Table, String> {
    if !root.contains_key(key) {
        root.insert(key.to_string(), toml::Value::Table(toml::value::Table::new()));
    }
    match root.get_mut(key) {
        Some(toml::Value::Table(t)) => Ok(t),
        _ => Err(format!("Config key '{}' is not a table", key)),
    }
}

fn is_env_key_set(env_key: &str) -> bool {
    if std::env::var(env_key).is_ok() {
        return true;
    }

    if cfg!(target_os = "windows") {
        let output = std::process::Command::new("cmd")
            .args(["/C", &format!("echo %{}%", env_key)])
            .output();
        if let Ok(out) = output {
            let val = String::from_utf8_lossy(&out.stdout).trim().to_string();
            return val != format!("%{}%", env_key) && !val.is_empty();
        }
        return false;
    }

    let home = dirs::home_dir().expect("Cannot find home directory");
    let shell = std::env::var("SHELL").unwrap_or_default();

    let mut candidates: Vec<&str> = Vec::new();
    if shell.contains("zsh") {
        candidates.push(".zshrc");
    }
    if shell.contains("bash") {
        candidates.push(".bashrc");
        candidates.push(".bash_profile");
    }
    candidates.push(".zshrc");
    candidates.push(".bashrc");
    candidates.push(".bash_profile");
    candidates.push(".profile");

    for c in &candidates {
        let p = home.join(c);
        if p.exists() {
            if let Ok(content) = fs::read_to_string(&p) {
                let pattern = format!("export {}=", env_key);
                if content
                    .lines()
                    .any(|line| line.trim_start().starts_with(&pattern))
                {
                    return true;
                }
            }
        }
    }
    false
}

#[tauri::command]
fn get_config() -> Result<ConfigSnapshot, String> {
    migrate_codex_provider_models()?;
    let config = read_config_toml()?;
    let root = config.as_table().ok_or("Config root is not a table")?;

    let active_provider = root
        .get("model_provider")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let active_model = root
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let store = read_codex_store()?;

    let mut providers = Vec::new();

    if let Some(toml::Value::Table(providers_table)) = root.get("model_providers") {
        for (id, val) in providers_table {
            if let toml::Value::Table(pt) = val {
                let env_key = pt
                    .get("env_key")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let is_env_set = is_env_key_set(&env_key);

                // Per-provider model lives in the sidecar (app metadata), not in
                // config.toml's `[model_providers.*]` table.
                let model = store
                    .providers
                    .get(id)
                    .map(|m| m.model.clone())
                    .unwrap_or_default();

                providers.push(ProviderInfo {
                    id: id.clone(),
                    name: pt
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(id)
                        .to_string(),
                    base_url: pt
                        .get("base_url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    model,
                    env_key: env_key.clone(),
                    wire_api: pt
                        .get("wire_api")
                        .and_then(|v| v.as_str())
                        .unwrap_or("responses")
                        .to_string(),
                    is_active: active_provider.as_deref() == Some(id.as_str()),
                    is_env_set,
                });
            }
        }
    }

    providers.sort_by(|a, b| b.is_active.cmp(&a.is_active).then(a.id.cmp(&b.id)));

    Ok(ConfigSnapshot {
        providers,
        active_provider,
        active_model,
        config_path: config_path().to_string_lossy().to_string(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProviderInput {
    id: String,
    name: String,
    base_url: String,
    model: String,
    env_key: String,
    api_key: String,
    wire_api: String,
    set_as_default: bool,
}

#[tauri::command]
fn save_provider(input: SaveProviderInput) -> Result<(), String> {
    migrate_codex_provider_models()?;
    let mut config = read_config_toml()?;
    let root = config.as_table_mut().ok_or("Config root is not a table")?;

    let providers_table = ensure_table(root, "model_providers")?;

    // Codex-native fields only — `model` is NOT part of `[model_providers.*]`
    // and is stored in the sidecar below.
    let mut pt = toml::value::Table::new();
    pt.insert("name".to_string(), toml::Value::String(input.name));
    pt.insert("base_url".to_string(), toml::Value::String(input.base_url));
    pt.insert("env_key".to_string(), toml::Value::String(input.env_key.clone()));
    pt.insert("wire_api".to_string(), toml::Value::String(input.wire_api));
    providers_table.insert(input.id.clone(), toml::Value::Table(pt));

    if input.set_as_default {
        root.insert("model_provider".to_string(), toml::Value::String(input.id.clone()));
        root.insert("model".to_string(), toml::Value::String(input.model.clone()));
    }

    write_config_toml(&config)?;

    // Persist the per-provider model in the app-owned sidecar.
    let mut store = read_codex_store()?;
    let meta = store
        .providers
        .entry(input.id.clone())
        .or_default();
    meta.model = input.model.clone();
    write_codex_store(&store)?;

    if !input.api_key.is_empty() {
        set_env_var(input.env_key, input.api_key)?;
    }

    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetDefaultInput {
    provider_id: String,
}

#[tauri::command]
fn set_default(input: SetDefaultInput) -> Result<(), String> {
    migrate_codex_provider_models()?;
    let mut config = read_config_toml()?;
    let root = config.as_table_mut().ok_or("Config root is not a table")?;

    let providers_table = root
        .get("model_providers")
        .and_then(|v| v.as_table())
        .ok_or("No providers configured")?;

    if !providers_table.contains_key(&input.provider_id) {
        return Err(format!("Unknown provider: {}", input.provider_id));
    }

    // Per-provider model is app metadata stored in the sidecar, not in
    // `[model_providers.*]`.
    let store = read_codex_store()?;
    let model = store
        .providers
        .get(&input.provider_id)
        .map(|m| m.model.clone())
        .filter(|s| !s.is_empty())
        .ok_or(format!(
            "No model saved for provider: {}. Edit the provider in the app to set a model.",
            input.provider_id
        ))?;

    root.insert(
        "model_provider".to_string(),
        toml::Value::String(input.provider_id),
    );
    root.insert("model".to_string(), toml::Value::String(model));

    write_config_toml(&config)?;
    Ok(())
}

#[tauri::command]
fn reset_to_default() -> Result<(), String> {
    migrate_codex_provider_models()?;
    let mut config = read_config_toml()?;
    let root = config.as_table_mut().ok_or("Config root is not a table")?;

    root.remove("model_provider");
    root.remove("model");

    write_config_toml(&config)?;
    Ok(())
}

#[tauri::command]
fn remove_provider(provider_id: String) -> Result<(), String> {
    migrate_codex_provider_models()?;
    let mut config = read_config_toml()?;
    let root = config.as_table_mut().ok_or("Config root is not a table")?;

    if let Some(toml::Value::Table(providers_table)) = root.get_mut("model_providers") {
        providers_table.remove(&provider_id);
    }

    if root
        .get("model_provider")
        .and_then(|v| v.as_str())
        == Some(&provider_id)
    {
        root.remove("model_provider");
        root.remove("model");
    }

    write_config_toml(&config)?;

    // Also drop the per-provider model from the sidecar.
    let mut store = read_codex_store()?;
    store.providers.remove(&provider_id);
    write_codex_store(&store)?;

    Ok(())
}

#[tauri::command]
fn set_env_var(key: String, value: String) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        let output = std::process::Command::new("setx")
            .arg(&key)
            .arg(&value)
            .output()
            .map_err(|e| format!("setx failed: {}", e))?;
        if !output.status.success() {
            return Err(format!("setx failed: {}", String::from_utf8_lossy(&output.stderr)));
        }
        return Ok(());
    }

    let home = dirs::home_dir().expect("Cannot find home directory");
    let shell = std::env::var("SHELL").unwrap_or_default();

    let mut candidates: Vec<&str> = Vec::new();
    if shell.contains("zsh") {
        candidates.push(".zshrc");
    }
    if shell.contains("bash") {
        candidates.push(".bashrc");
        candidates.push(".bash_profile");
    }
    candidates.push(".zshrc");
    candidates.push(".bashrc");
    candidates.push(".bash_profile");
    candidates.push(".profile");

    let rc_file = {
        let mut found = home.join(".zshrc");
        for c in &candidates {
            let p = home.join(c);
            if p.exists() {
                found = p;
                break;
            }
        }
        found
    };

    let content = if rc_file.exists() {
        fs::read_to_string(&rc_file).unwrap_or_default()
    } else {
        String::new()
    };

    let line = format!("export {}=\"{}\"", key, value);
    let pattern = format!("export {}=", key);

    let mut found = false;
    let mut lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();

    for line_ref in lines.iter_mut() {
        if line_ref.trim_start().starts_with(&pattern) {
            *line_ref = line.clone();
            found = true;
            break;
        }
    }

    if !found {
        if !content.is_empty() && !content.ends_with('\n') {
            lines.push(String::new());
        }
        lines.push(line);
    }

    let new_content = lines.join("\n") + "\n";
    fs::write(&rc_file, new_content)
        .map_err(|e| format!("Failed to write {}: {}", rc_file.display(), e))?;

    std::env::set_var(&key, &value);

    Ok(())
}

#[tauri::command]
fn get_env_status() -> Result<Vec<(String, bool)>, String> {
    let config = read_config_toml()?;
    let root = config.as_table().ok_or("Config root is not a table")?;

    let mut result = Vec::new();

    if let Some(toml::Value::Table(providers_table)) = root.get("model_providers") {
        for (id, val) in providers_table {
            if let toml::Value::Table(pt) = val {
                let env_key = pt
                    .get("env_key")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let is_set = is_env_key_set(&env_key);
                result.push((id.clone(), is_set));
            }
        }
    }

    Ok(result)
}

#[tauri::command]
fn backup_config() -> Result<String, String> {
    let path = config_path();
    if !path.exists() {
        return Err("No config.toml exists yet".to_string());
    }
    let ts = timestamp();
    let bak = format!("{}.bak.{}", path.display(), ts);
    fs::copy(&path, &bak).map_err(|e| format!("Backup failed: {}", e))?;

    // Also back up the sidecar so a restore brings back per-provider models.
    let store = codex_store_path();
    if store.exists() {
        let store_bak = format!("{}.bak.{}", store.display(), ts);
        let _ = fs::copy(&store, &store_bak);
    }

    Ok(bak)
}

#[tauri::command]
fn list_backups() -> Result<Vec<(String, String)>, String> {
    let dir = codex_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut backups = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Cannot read dir: {}", e))?;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("config.toml.bak.") {
            let ts = name.trim_start_matches("config.toml.bak.").to_string();
            backups.push((name, ts));
        }
    }

    backups.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(backups)
}

#[tauri::command]
fn restore_config(filename: String) -> Result<(), String> {
    let dir = codex_dir();
    let backup_path = dir.join(&filename);

    if !backup_path.exists() {
        return Err(format!("Backup not found: {}", filename));
    }

    let current = config_path();
    if current.exists() {
        let bak = format!("{}.bak.{}", current.display(), timestamp());
        let _ = fs::copy(&current, &bak);
    }

    fs::copy(&backup_path, &current)
        .map_err(|e| format!("Restore failed: {}", e))?;

    // Restore the matching sidecar backup (same timestamp), if present.
    if let Some(ts) = filename.strip_prefix("config.toml.bak.") {
        let store = codex_store_path();
        let store_bak = dir.join(format!("provider-switcher.json.bak.{}", ts));
        if store_bak.exists() {
            if store.exists() {
                let cur_bak = format!("{}.bak.{}", store.display(), timestamp());
                let _ = fs::copy(&store, &cur_bak);
            }
            fs::copy(&store_bak, &store)
                .map_err(|e| format!("Restore sidecar failed: {}", e))?;
            set_file_perms_600(&store);
        }
    }

    // A restored pre-migration backup may carry `model = "..."` inside
    // `[model_providers.*]`; migrate it into the sidecar so config.toml stays clean.
    migrate_codex_provider_models()?;

    Ok(())
}

// ===================== Claude Code =====================

fn claude_dir() -> PathBuf {
    let home = dirs::home_dir().expect("Cannot find home directory");
    home.join(".claude")
}

fn claude_settings_path() -> PathBuf {
    claude_dir().join("settings.json")
}

fn claude_store_path() -> PathBuf {
    claude_dir().join("provider-switcher.json")
}

fn set_file_perms_600(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(path, perms);
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClaudeProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub auth_type: String,
    pub api_key: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ClaudeStore {
    #[serde(default)]
    pub providers: Vec<ClaudeProvider>,
    #[serde(default)]
    pub active_provider: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ClaudeProviderInfo {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub auth_type: String,
    pub is_active: bool,
    pub is_key_set: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ClaudeConfigSnapshot {
    pub providers: Vec<ClaudeProviderInfo>,
    pub active_provider: Option<String>,
    pub active_model: Option<String>,
    pub settings_path: String,
    pub store_path: String,
}

fn read_claude_settings() -> Result<serde_json::Value, String> {
    let path = claude_settings_path();
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read settings.json: {}", e))?;
    if content.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings.json: {}", e))
}

fn write_claude_settings(val: &serde_json::Value) -> Result<(), String> {
    let dir = claude_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create .claude dir: {}", e))?;
    let path = claude_settings_path();
    if path.exists() {
        let bak = format!("{}.bak.{}", path.display(), timestamp());
        let _ = fs::copy(&path, &bak);
    }
    let content = serde_json::to_string_pretty(val)
        .map_err(|e| format!("Failed to serialize settings.json: {}", e))?;
    let mut out = content;
    if !out.ends_with('\n') {
        out.push('\n');
    }
    fs::write(&path, &out).map_err(|e| format!("Failed to write settings.json: {}", e))?;
    set_file_perms_600(&path);
    Ok(())
}

fn read_claude_store() -> Result<ClaudeStore, String> {
    let path = claude_store_path();
    if !path.exists() {
        return Ok(ClaudeStore::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read provider-switcher.json: {}", e))?;
    if content.trim().is_empty() {
        return Ok(ClaudeStore::default());
    }
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse provider-switcher.json: {}", e))
}

fn write_claude_store(store: &ClaudeStore) -> Result<(), String> {
    let dir = claude_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create .claude dir: {}", e))?;
    let path = claude_store_path();
    if path.exists() {
        let bak = format!("{}.bak.{}", path.display(), timestamp());
        let _ = fs::copy(&path, &bak);
    }
    let mut content = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize provider-switcher.json: {}", e))?;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    fs::write(&path, &content).map_err(|e| format!("Failed to write provider-switcher.json: {}", e))?;
    set_file_perms_600(&path);
    Ok(())
}

fn apply_provider_to_settings(settings: &mut serde_json::Value, p: &ClaudeProvider) -> Result<(), String> {
    let obj = settings
        .as_object_mut()
        .ok_or("settings.json root is not a JSON object")?;
    let env = obj
        .entry("env".to_string())
        .or_insert_with(|| serde_json::json!({}));
    let env_obj = env
        .as_object_mut()
        .ok_or("settings.json 'env' is not a JSON object")?;

    env_obj.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        serde_json::Value::String(p.base_url.clone()),
    );
    env_obj.insert(
        "ANTHROPIC_MODEL".to_string(),
        serde_json::Value::String(p.model.clone()),
    );
    if p.auth_type == "api_key" {
        env_obj.insert(
            "ANTHROPIC_API_KEY".to_string(),
            serde_json::Value::String(p.api_key.clone()),
        );
        env_obj.remove("ANTHROPIC_AUTH_TOKEN");
    } else {
        env_obj.insert(
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            serde_json::Value::String(p.api_key.clone()),
        );
        env_obj.remove("ANTHROPIC_API_KEY");
    }
    Ok(())
}

fn reset_claude_env_in_settings(settings: &mut serde_json::Value) -> Result<(), String> {
    if let Some(obj) = settings.as_object_mut() {
        if let Some(env) = obj.get_mut("env").and_then(|v| v.as_object_mut()) {
            env.remove("ANTHROPIC_BASE_URL");
            env.remove("ANTHROPIC_MODEL");
            env.remove("ANTHROPIC_AUTH_TOKEN");
            env.remove("ANTHROPIC_API_KEY");
        }
    }
    Ok(())
}

fn activate_claude(id: &str, store: &mut ClaudeStore) -> Result<(), String> {
    let p = store
        .providers
        .iter()
        .find(|p| p.id == id)
        .ok_or(format!("Unknown provider: {}", id))?
        .clone();

    let mut settings = read_claude_settings()?;
    apply_provider_to_settings(&mut settings, &p)?;
    write_claude_settings(&settings)?;
    store.active_provider = Some(id.to_string());
    write_claude_store(store)?;
    Ok(())
}

#[tauri::command]
fn get_claude_config() -> Result<ClaudeConfigSnapshot, String> {
    let store = read_claude_store()?;
    let settings = read_claude_settings()?;
    let env = settings.get("env").and_then(|v| v.as_object());

    let active_base_url = env
        .and_then(|m| m.get("ANTHROPIC_BASE_URL"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let active_model = env
        .and_then(|m| m.get("ANTHROPIC_MODEL"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut active_provider: Option<String> = None;
    if let Some(ref base_url) = active_base_url {
        for p in &store.providers {
            if &p.base_url == base_url
                && (active_model.as_deref() == Some(&p.model) || active_model.is_none())
            {
                active_provider = Some(p.id.clone());
                break;
            }
        }
    }

    let mut providers = Vec::new();
    for p in &store.providers {
        providers.push(ClaudeProviderInfo {
            id: p.id.clone(),
            name: p.name.clone(),
            base_url: p.base_url.clone(),
            model: p.model.clone(),
            auth_type: p.auth_type.clone(),
            is_active: active_provider.as_deref() == Some(&p.id),
            is_key_set: !p.api_key.is_empty(),
        });
    }
    providers.sort_by(|a, b| b.is_active.cmp(&a.is_active).then(a.id.cmp(&b.id)));

    Ok(ClaudeConfigSnapshot {
        providers,
        active_provider,
        active_model,
        settings_path: claude_settings_path().to_string_lossy().to_string(),
        store_path: claude_store_path().to_string_lossy().to_string(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveClaudeProviderInput {
    id: String,
    name: String,
    base_url: String,
    model: String,
    auth_type: String,
    api_key: String,
    set_as_default: bool,
}

#[tauri::command]
fn save_claude_provider(input: SaveClaudeProviderInput) -> Result<(), String> {
    let mut store = read_claude_store()?;

    if let Some(existing) = store.providers.iter_mut().find(|p| p.id == input.id) {
        existing.name = input.name.clone();
        existing.base_url = input.base_url.clone();
        existing.model = input.model.clone();
        existing.auth_type = input.auth_type.clone();
        if !input.api_key.is_empty() {
            existing.api_key = input.api_key.clone();
        }
    } else {
        store.providers.push(ClaudeProvider {
            id: input.id.clone(),
            name: input.name.clone(),
            base_url: input.base_url.clone(),
            model: input.model.clone(),
            auth_type: input.auth_type.clone(),
            api_key: input.api_key.clone(),
        });
    }

    if input.set_as_default {
        activate_claude(&input.id, &mut store)?;
    } else {
        write_claude_store(&store)?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetClaudeDefaultInput {
    provider_id: String,
}

#[tauri::command]
fn set_claude_default(input: SetClaudeDefaultInput) -> Result<(), String> {
    let mut store = read_claude_store()?;
    activate_claude(&input.provider_id, &mut store)
}

#[tauri::command]
fn reset_claude_default() -> Result<(), String> {
    let mut settings = read_claude_settings()?;
    reset_claude_env_in_settings(&mut settings)?;
    write_claude_settings(&settings)?;

    let mut store = read_claude_store()?;
    store.active_provider = None;
    write_claude_store(&store)?;
    Ok(())
}

#[tauri::command]
fn remove_claude_provider(provider_id: String) -> Result<(), String> {
    let mut store = read_claude_store()?;
    let was_active = store.active_provider.as_deref() == Some(&provider_id);
    store.providers.retain(|p| p.id != provider_id);
    if store.active_provider.as_deref() == Some(&provider_id) {
        store.active_provider = None;
    }
    write_claude_store(&store)?;

    if was_active {
        let mut settings = read_claude_settings()?;
        reset_claude_env_in_settings(&mut settings)?;
        write_claude_settings(&settings)?;
    }
    Ok(())
}

#[tauri::command]
fn backup_claude_config() -> Result<String, String> {
    let dir = claude_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create .claude dir: {}", e))?;
    let ts = timestamp();
    let settings = claude_settings_path();
    let store = claude_store_path();
    if settings.exists() {
        let bak = dir.join(format!("settings.json.bak.{}", ts));
        fs::copy(&settings, &bak).map_err(|e| format!("Backup settings failed: {}", e))?;
    }
    if store.exists() {
        let bak = dir.join(format!("provider-switcher.json.bak.{}", ts));
        fs::copy(&store, &bak).map_err(|e| format!("Backup store failed: {}", e))?;
    }
    Ok(ts)
}

#[tauri::command]
fn list_claude_backups() -> Result<Vec<(String, String)>, String> {
    let dir = claude_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut tss: Vec<String> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Cannot read dir: {}", e))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(rest) = name.strip_prefix("settings.json.bak.") {
            tss.push(rest.to_string());
        }
    }
    tss.sort();
    tss.dedup();
    let mut out: Vec<(String, String)> = tss.into_iter().map(|ts| (ts.clone(), ts)).collect();
    out.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(out)
}

#[tauri::command]
fn restore_claude_config(ts: String) -> Result<(), String> {
    let dir = claude_dir();
    let settings = claude_settings_path();
    let store = claude_store_path();
    let settings_bak = dir.join(format!("settings.json.bak.{}", ts));
    let store_bak = dir.join(format!("provider-switcher.json.bak.{}", ts));

    if !settings_bak.exists() && !store_bak.exists() {
        return Err(format!("Backup not found for timestamp: {}", ts));
    }

    let new_ts = timestamp();
    if settings.exists() {
        let _ = fs::copy(&settings, dir.join(format!("settings.json.bak.{}", new_ts)));
    }
    if store.exists() {
        let _ = fs::copy(&store, dir.join(format!("provider-switcher.json.bak.{}", new_ts)));
    }

    if settings_bak.exists() {
        fs::copy(&settings_bak, &settings).map_err(|e| format!("Restore settings failed: {}", e))?;
        set_file_perms_600(&settings);
    }
    if store_bak.exists() {
        fs::copy(&store_bak, &store).map_err(|e| format!("Restore store failed: {}", e))?;
        set_file_perms_600(&store);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_provider,
            set_default,
            remove_provider,
            reset_to_default,
            set_env_var,
            get_env_status,
            backup_config,
            list_backups,
            restore_config,
            get_claude_config,
            save_claude_provider,
            set_claude_default,
            reset_claude_default,
            remove_claude_provider,
            backup_claude_config,
            list_claude_backups,
            restore_claude_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with_user_keys() -> serde_json::Value {
        // Mimics a real ~/.claude/settings.json that already has user prefs.
        serde_json::json!({
            "model": "opus",
            "enabledPlugins": { "typescript-lsp@claude-plugins-official": true },
            "effortLevel": "high",
            "remoteControlAtStartup": false,
            "agentPushNotifEnabled": true
        })
    }

    fn provider(auth_type: &str) -> ClaudeProvider {
        ClaudeProvider {
            id: "litellm".to_string(),
            name: "LiteLLM Proxy".to_string(),
            base_url: "http://localhost:4000".to_string(),
            model: "claude-sonnet-4-20250514".to_string(),
            auth_type: auth_type.to_string(),
            api_key: "sk-test-123".to_string(),
        }
    }

    #[test]
    fn apply_auth_token_writes_bearer_and_preserves_user_keys() {
        let mut s = settings_with_user_keys();
        apply_provider_to_settings(&mut s, &provider("auth_token")).unwrap();

        let env = s.get("env").unwrap().as_object().unwrap();
        assert_eq!(env.get("ANTHROPIC_BASE_URL").unwrap(), "http://localhost:4000");
        assert_eq!(env.get("ANTHROPIC_MODEL").unwrap(), "claude-sonnet-4-20250514");
        assert_eq!(env.get("ANTHROPIC_AUTH_TOKEN").unwrap(), "sk-test-123");
        assert!(env.get("ANTHROPIC_API_KEY").is_none(), "api_key must be absent when auth_type=auth_token");

        // User's existing top-level keys must survive.
        assert_eq!(s.get("model").unwrap(), "opus");
        assert_eq!(s.get("effortLevel").unwrap(), "high");
        assert!(s.get("enabledPlugins").unwrap().is_object());
    }

    #[test]
    fn apply_api_key_writes_xapikey_and_removes_token() {
        let mut s = settings_with_user_keys();
        // Pre-existing stale token should be cleared when switching to api_key.
        {
            let env = s.as_object_mut().unwrap()
                .entry("env".to_string()).or_insert_with(|| serde_json::json!({}))
                .as_object_mut().unwrap();
            env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), serde_json::json!("stale"));
        }
        apply_provider_to_settings(&mut s, &provider("api_key")).unwrap();

        let env = s.get("env").unwrap().as_object().unwrap();
        assert_eq!(env.get("ANTHROPIC_API_KEY").unwrap(), "sk-test-123");
        assert!(env.get("ANTHROPIC_AUTH_TOKEN").is_none(), "auth_token must be cleared when auth_type=api_key");
    }

    #[test]
    fn reset_removes_only_anthropic_vars_and_keeps_other_env() {
        let mut s = settings_with_user_keys();
        apply_provider_to_settings(&mut s, &provider("auth_token")).unwrap();
        // Add an unrelated env var the user set themselves.
        {
            let env = s.get_mut("env").unwrap().as_object_mut().unwrap();
            env.insert("OTEL_METRICS_EXPORTER".to_string(), serde_json::json!("otlp"));
        }

        reset_claude_env_in_settings(&mut s).unwrap();

        let env = s.get("env").unwrap().as_object().unwrap();
        assert!(env.get("ANTHROPIC_BASE_URL").is_none());
        assert!(env.get("ANTHROPIC_MODEL").is_none());
        assert!(env.get("ANTHROPIC_AUTH_TOKEN").is_none());
        assert!(env.get("ANTHROPIC_API_KEY").is_none());
        assert_eq!(env.get("OTEL_METRICS_EXPORTER").unwrap(), "otlp", "unrelated env vars must be preserved");
        assert_eq!(s.get("model").unwrap(), "opus", "user settings must be preserved");
    }

    #[test]
    fn apply_then_reset_roundtrips_to_original_user_keys() {
        let original = settings_with_user_keys();
        let mut s = original.clone();
        apply_provider_to_settings(&mut s, &provider("auth_token")).unwrap();
        reset_claude_env_in_settings(&mut s).unwrap();

        // Every original top-level key is still present with the same value.
        for (k, v) in original.as_object().unwrap() {
            assert_eq!(s.get(k).unwrap(), v, "key {} changed after roundtrip", k);
        }
    }

    #[test]
    fn apply_preserves_top_level_key_order() {
        let mut s = settings_with_user_keys();
        let before: Vec<String> = s.as_object().unwrap().keys().cloned().collect();
        apply_provider_to_settings(&mut s, &provider("auth_token")).unwrap();
        reset_claude_env_in_settings(&mut s).unwrap();
        let after: Vec<String> = s.as_object().unwrap().keys().cloned().collect();
        // The user's original keys must remain in the same relative order.
        // `env` may be newly inserted (appended) by apply, which is fine.
        let after_user_only: Vec<&String> = after.iter().filter(|k| before.contains(k)).collect();
        let before_refs: Vec<&String> = before.iter().collect();
        assert_eq!(after_user_only, before_refs, "top-level user key order must be preserved (preserve_order feature)");
    }

    // ─── Codex sidecar migration tests ────────────────────────────────────
    // These verify the fix for the bug where `model = "..."` was written inside
    // `[model_providers.*]` (non-standard for Codex) and left behind after
    // `reset_to_default`. Migration lifts it into the app-owned sidecar so
    // config.toml stays limited to Codex-native fields.

    fn codex_config_with_legacy_model() -> toml::Value {
        // Mimics a pre-fix config.toml: `model` inside [model_providers.*].
        toml::from_str(
            r#"
model_provider = "huoshan"
model = "glm-latest"

[model_providers.huoshan]
name = "HuoShan GLM 5.2"
base_url = "https://ark.cn-beijing.volces.com/api/coding/v3"
env_key = "HUOSHAN_API_KEY"
wire_api = "responses"
model = "glm-latest"

[model_providers.opencode-go]
name = "OpenCode Go"
base_url = "https://opencode.ai/zen/go/v1"
env_key = "OPENCODE_GO_API_KEY"
wire_api = "responses"
model = "glm-5.2"
"#,
        )
        .unwrap()
    }

    #[test]
    fn migrate_moves_per_provider_model_into_sidecar() {
        let config = codex_config_with_legacy_model();
        let store = CodexStore::default();

        let (new_config, new_store, changed) =
            migrate_codex_provider_models_into(config, store);

        assert!(changed, "migration should report changes");

        // config.toml: no `model` inside [model_providers.*] anymore.
        let providers = new_config
            .get("model_providers")
            .and_then(|v| v.as_table())
            .unwrap();
        for (_id, pt) in providers {
            assert!(
                pt.get("model").is_none(),
                "per-provider `model` must be stripped from config.toml"
            );
            // Codex-native fields must survive.
            assert!(pt.get("name").is_some());
            assert!(pt.get("base_url").is_some());
            assert!(pt.get("env_key").is_some());
            assert!(pt.get("wire_api").is_some());
        }

        // sidecar: per-provider model now lives here.
        assert_eq!(new_store.providers.get("huoshan").unwrap().model, "glm-latest");
        assert_eq!(new_store.providers.get("opencode-go").unwrap().model, "glm-5.2");
    }

    #[test]
    fn migrate_preserves_top_level_model_and_provider() {
        let config = codex_config_with_legacy_model();
        let (new_config, _store, _changed) =
            migrate_codex_provider_models_into(config, CodexStore::default());

        // Top-level model/model_provider are the active-provider selectors and
        // must NOT be touched by migration (reset_to_default handles those).
        assert_eq!(
            new_config.get("model_provider").and_then(|v| v.as_str()),
            Some("huoshan")
        );
        assert_eq!(
            new_config.get("model").and_then(|v| v.as_str()),
            Some("glm-latest")
        );
    }

    #[test]
    fn migrate_is_idempotent() {
        let config = codex_config_with_legacy_model();
        let (config, store, _) =
            migrate_codex_provider_models_into(config, CodexStore::default());

        // Second run: nothing left to move.
        let (config2, store2, changed2) =
            migrate_codex_provider_models_into(config, store);

        assert!(!changed2, "second migration must be a no-op");
        assert_eq!(store2.providers.len(), 2);
        // Still no `model` inside [model_providers.*].
        let providers = config2.get("model_providers").and_then(|v| v.as_table()).unwrap();
        for (_id, pt) in providers {
            assert!(pt.get("model").is_none());
        }
    }

    #[test]
    fn migrate_on_clean_config_is_noop() {
        // A clean (post-fix) config has no `model` inside [model_providers.*].
        let config: toml::Value = toml::from_str(
            r#"
[model_providers.huoshan]
name = "HuoShan GLM 5.2"
base_url = "https://ark.cn-beijing.volces.com/api/coding/v3"
env_key = "HUOSHAN_API_KEY"
wire_api = "responses"
"#,
        )
        .unwrap();
        let store = CodexStore::default();
        let (_config, _store, changed) =
            migrate_codex_provider_models_into(config, store);
        assert!(!changed, "clean config must not trigger migration writes");
    }

    #[test]
    fn migrate_does_not_overwrite_existing_sidecar_model_when_no_legacy_field() {
        // If config.toml has no `model` inside [model_providers.*] but the sidecar
        // already has a model (post-migration state), migration must be a no-op
        // and must not clobber the sidecar.
        let config: toml::Value = toml::from_str(
            r#"
[model_providers.huoshan]
name = "HuoShan GLM 5.2"
base_url = "https://ark.cn-beijing.volces.com/api/coding/v3"
env_key = "HUOSHAN_API_KEY"
wire_api = "responses"
"#,
        )
        .unwrap();
        let mut store = CodexStore::default();
        store.providers.insert(
            "huoshan".to_string(),
            CodexProviderMeta { model: "glm-latest".to_string() },
        );
        let (_config, new_store, changed) =
            migrate_codex_provider_models_into(config, store);
        assert!(!changed);
        assert_eq!(new_store.providers.get("huoshan").unwrap().model, "glm-latest");
    }

    #[test]
    fn migrate_handles_empty_config() {
        let config = toml::Value::Table(toml::value::Table::new());
        let (_config, _store, changed) =
            migrate_codex_provider_models_into(config, CodexStore::default());
        assert!(!changed, "empty config must not trigger migration writes");
    }
}

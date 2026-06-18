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

fn ensure_table<'a>(root: &'a mut toml::value::Table, key: &str) -> Result<&'a mut toml::value::Table, String> {
    if !root.contains_key(key) {
        root.insert(key.to_string(), toml::Value::Table(toml::value::Table::new()));
    }
    match root.get_mut(key) {
        Some(toml::Value::Table(t)) => Ok(t),
        _ => Err(format!("Config key '{}' is not a table", key)),
    }
}

fn pick_rc_file() -> PathBuf {
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
            return p;
        }
    }
    home.join(".zshrc")
}

#[tauri::command]
fn get_config() -> Result<ConfigSnapshot, String> {
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

    let mut providers = Vec::new();

    if let Some(toml::Value::Table(providers_table)) = root.get("model_providers") {
        for (id, val) in providers_table {
            if let toml::Value::Table(pt) = val {
                let env_key = pt
                    .get("env_key")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let is_env_set = std::env::var(&env_key).is_ok();

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
    let mut config = read_config_toml()?;
    let root = config.as_table_mut().ok_or("Config root is not a table")?;

    let providers_table = ensure_table(root, "model_providers")?;

    let mut pt = toml::value::Table::new();
    pt.insert("name".to_string(), toml::Value::String(input.name));
    pt.insert("base_url".to_string(), toml::Value::String(input.base_url));
    pt.insert("env_key".to_string(), toml::Value::String(input.env_key.clone()));
    pt.insert("wire_api".to_string(), toml::Value::String(input.wire_api));
    providers_table.insert(input.id.clone(), toml::Value::Table(pt));

    if input.set_as_default {
        root.insert("model_provider".to_string(), toml::Value::String(input.id.clone()));
        root.insert("model".to_string(), toml::Value::String(input.model));
    }

    write_config_toml(&config)?;

    if !input.api_key.is_empty() {
        set_env_var(input.env_key, input.api_key)?;
    }

    Ok(())
}

#[derive(Deserialize)]
struct SetDefaultInput {
    provider_id: String,
    model: String,
}

#[tauri::command]
fn set_default(input: SetDefaultInput) -> Result<(), String> {
    let mut config = read_config_toml()?;
    let root = config.as_table_mut().ok_or("Config root is not a table")?;

    let providers_table = root
        .get("model_providers")
        .and_then(|v| v.as_table())
        .ok_or("No providers configured")?;

    if !providers_table.contains_key(&input.provider_id) {
        return Err(format!("Unknown provider: {}", input.provider_id));
    }

    root.insert(
        "model_provider".to_string(),
        toml::Value::String(input.provider_id),
    );
    root.insert("model".to_string(), toml::Value::String(input.model));

    write_config_toml(&config)?;
    Ok(())
}

#[tauri::command]
fn remove_provider(provider_id: String) -> Result<(), String> {
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

    let rc_file = pick_rc_file();
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
                let is_set = std::env::var(&env_key).is_ok();
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
    let bak = format!("{}.bak.{}", path.display(), timestamp());
    fs::copy(&path, &bak).map_err(|e| format!("Backup failed: {}", e))?;
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
            set_env_var,
            get_env_status,
            backup_config,
            list_backups,
            restore_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

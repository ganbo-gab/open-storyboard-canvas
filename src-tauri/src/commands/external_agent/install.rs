//! CLI configuration installation. Configs are merged structurally; private receipts
//! retain the exact before/after bytes so an untouched install can be undone losslessly.
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use toml_edit::{DocumentMut, Item, Table};

use super::{ExternalAgentCommandError, ExternalAgentRuntime};

const ENTRY: &str = "storyboard_canvas";
// Serialize read/merge/write transactions from multiple invoke calls in this process.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

type InstallResult<T> = Result<T, ExternalAgentCommandError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExternalAgentInstallState {
    NotInstalled,
    Installed,
    Conflict,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentInstallStatus {
    pub cli: ExternalAgentRuntime,
    pub path: String,
    pub descriptor_path: String,
    pub installed: bool,
    pub state: ExternalAgentInstallState,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentInstallPreview {
    pub status: ExternalAgentInstallStatus,
    pub changed: bool,
    pub diff: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentInstallOutcome {
    pub status: ExternalAgentInstallStatus,
    pub changed: bool,
    pub backup_path: Option<String>,
    pub restored_original: bool,
}

#[derive(Debug)]
struct InstallContext {
    cli: ExternalAgentRuntime,
    path: PathBuf,
    descriptor_path: PathBuf,
    executable: PathBuf,
    receipt_path: PathBuf,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallReceipt {
    schema_version: u8,
    config_path: PathBuf,
    // None means the config did not exist, which is different from an empty file.
    original_bytes: Option<Vec<u8>>,
    installed_bytes: Vec<u8>,
}

impl InstallContext {
    // HOME is an explicit dependency here; tests never mutate process environment.
    fn new(cli: ExternalAgentRuntime, home: &Path, app_data: &Path, executable: PathBuf) -> Self {
        let path = match cli {
            ExternalAgentRuntime::Codex => home.join(".codex/config.toml"),
            ExternalAgentRuntime::Claude => home.join(".claude.json"),
        };
        Self {
            cli,
            path,
            descriptor_path: app_data.join("mcp/osc.json"),
            executable,
            receipt_path: app_data
                .join("mcp/install")
                .join(format!("{}.json", cli.binary_name())),
        }
    }

    fn from_app(app: &AppHandle, cli: ExternalAgentRuntime) -> InstallResult<Self> {
        let home = app
            .path()
            .home_dir()
            .map_err(|error| failure("resolve home directory", error))?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| failure("resolve app data directory", error))?;
        let executable = std::env::current_exe()
            .map_err(|error| failure("resolve the Canvas executable", error))?;
        Ok(Self::new(cli, &home, &app_data, executable))
    }

    fn desired_entry(&self) -> InstallResult<Value> {
        let executable = self.executable.to_str().ok_or_else(|| {
            ExternalAgentCommandError::invalid_request("The Canvas executable path is not UTF-8.")
        })?;
        let descriptor = self.descriptor_path.to_str().ok_or_else(|| {
            ExternalAgentCommandError::invalid_request("The Canvas descriptor path is not UTF-8.")
        })?;
        let mut entry = Map::new();
        entry.insert("command".into(), json!(executable));
        entry.insert("args".into(), json!(["--external-agent-mcp", descriptor]));
        match self.cli {
            ExternalAgentRuntime::Codex => {
                entry.insert("startup_timeout_sec".into(), json!(10));
                entry.insert("tool_timeout_sec".into(), json!(3600));
            }
            ExternalAgentRuntime::Claude => {
                entry.insert("type".into(), json!("stdio"));
                entry.insert("env".into(), json!({}));
            }
        }
        Ok(Value::Object(entry))
    }

    fn read_receipt(&self) -> InstallResult<Option<InstallReceipt>> {
        let Some(bytes) = read_optional(&self.receipt_path)? else {
            return Ok(None);
        };
        let receipt: InstallReceipt = serde_json::from_slice(&bytes)
            .map_err(|error| failure("read the Canvas install receipt", error))?;
        if receipt.schema_version != 1 || receipt.config_path != self.path {
            return Err(ExternalAgentCommandError::invalid_request(
                "The Canvas install receipt does not match this CLI configuration.",
            ));
        }
        Ok(Some(receipt))
    }

    fn status_for(&self, bytes: Option<&[u8]>) -> InstallResult<ExternalAgentInstallStatus> {
        let entry = config_entry(self.cli, bytes.unwrap_or_default())?;
        let desired = self.desired_entry()?;
        let owned = if let Some(receipt) = self.read_receipt()? {
            config_entry(self.cli, &receipt.installed_bytes)?
        } else {
            None
        };
        let state = match &entry {
            None => ExternalAgentInstallState::NotInstalled,
            Some(entry) if entry == &desired || owned.as_ref() == Some(entry) => {
                ExternalAgentInstallState::Installed
            }
            Some(_) => ExternalAgentInstallState::Conflict,
        };
        Ok(ExternalAgentInstallStatus {
            cli: self.cli,
            path: self.path.to_string_lossy().into_owned(),
            descriptor_path: self.descriptor_path.to_string_lossy().into_owned(),
            installed: state == ExternalAgentInstallState::Installed,
            state,
            message: (state == ExternalAgentInstallState::Conflict).then(|| {
                "A different storyboard_canvas entry already exists. It was not modified.".into()
            }),
        })
    }

    fn status(&self) -> InstallResult<ExternalAgentInstallStatus> {
        self.status_for(read_optional(&self.path)?.as_deref())
    }

    fn install_bytes(&self, before: Option<&[u8]>) -> InstallResult<Vec<u8>> {
        let entry = config_entry(self.cli, before.unwrap_or_default())?;
        let desired = self.desired_entry()?;
        match entry {
            Some(entry) if entry == desired => Ok(before.unwrap_or_default().to_vec()),
            Some(entry) => {
                let owned = self
                    .read_receipt()?
                    .map(|receipt| config_entry(self.cli, &receipt.installed_bytes))
                    .transpose()?
                    .flatten();
                if owned.as_ref() != Some(&entry) {
                    return Err(ExternalAgentCommandError::invalid_request(
                        "A conflicting storyboard_canvas entry exists. Rename the foreign entry before installing; no configuration was changed.",
                    ));
                }
                merge_entry(self.cli, before.unwrap_or_default(), Some(&desired))
            }
            None => merge_entry(self.cli, before.unwrap_or_default(), Some(&desired)),
        }
    }

    fn preview(&self) -> InstallResult<ExternalAgentInstallPreview> {
        let before = read_optional(&self.path)?;
        let status = self.status_for(before.as_deref())?;
        let after = self.install_bytes(before.as_deref())?;
        let changed = before.as_deref() != Some(after.as_slice());
        Ok(ExternalAgentInstallPreview {
            status,
            changed,
            diff: unified_diff(&self.path, before.as_deref(), &after),
        })
    }

    fn install(&self) -> InstallResult<ExternalAgentInstallOutcome> {
        let before = read_optional(&self.path)?;
        let after = self.install_bytes(before.as_deref())?;
        if before.as_deref() == Some(after.as_slice()) {
            return Ok(ExternalAgentInstallOutcome {
                status: self.status_for(Some(&after))?,
                changed: false,
                backup_path: None,
                restored_original: false,
            });
        }
        let previous_receipt = self.read_receipt()?;
        let current_entry = config_entry(self.cli, before.as_deref().unwrap_or_default())?;
        let original_bytes = if let Some(previous) = previous_receipt
            .as_ref()
            .filter(|_| current_entry.is_some())
        {
            if current_entry == config_entry(self.cli, &previous.installed_bytes)? {
                if before.as_deref() == Some(previous.installed_bytes.as_slice()) {
                    previous.original_bytes.clone()
                } else {
                    // Reinstall after unrelated edits establishes a new baseline with
                    // those edits retained, not the obsolete original snapshot.
                    Some(merge_entry(
                        self.cli,
                        before.as_deref().unwrap_or_default(),
                        None,
                    )?)
                }
            } else {
                before.clone()
            }
        } else {
            before.clone()
        };
        let receipt = InstallReceipt {
            schema_version: 1,
            config_path: self.path.clone(),
            original_bytes,
            installed_bytes: after,
        };
        // Persist recovery information before touching the CLI file. If a write fails,
        // the receipt is harmless: restoration requires the exact installed snapshot.
        let receipt_bytes = serde_json::to_vec(&receipt)
            .map_err(|error| failure("encode the Canvas install receipt", error))?;
        private_directory(self.receipt_path.parent().expect("receipt directory"))?;
        atomic_write(&self.receipt_path, &receipt_bytes, None)?;
        let backup = match self.write_config(before.as_deref(), Some(&receipt.installed_bytes)) {
            Ok(backup) => backup,
            Err(error) => {
                if let Some(previous) = previous_receipt {
                    let bytes = serde_json::to_vec(&previous).map_err(|error| {
                        failure("encode the previous Canvas install receipt", error)
                    })?;
                    atomic_write(&self.receipt_path, &bytes, None)?;
                } else {
                    fs::remove_file(&self.receipt_path)
                        .map_err(|error| failure("roll back the Canvas install receipt", error))?;
                }
                return Err(error);
            }
        };
        Ok(ExternalAgentInstallOutcome {
            status: self.status_for(Some(&receipt.installed_bytes))?,
            changed: true,
            backup_path: Some(backup.to_string_lossy().into_owned()),
            restored_original: false,
        })
    }

    fn uninstall(&self) -> InstallResult<ExternalAgentInstallOutcome> {
        let before = read_optional(&self.path)?;
        let status = self.status_for(before.as_deref())?;
        if status.state == ExternalAgentInstallState::Conflict {
            return Err(ExternalAgentCommandError::invalid_request(
                "The storyboard_canvas entry was changed or belongs to another application; no configuration was changed.",
            ));
        }
        if !status.installed {
            // Do not restore a stale receipt over independently removed configuration.
            return Ok(ExternalAgentInstallOutcome {
                status,
                changed: false,
                backup_path: None,
                restored_original: false,
            });
        }
        let receipt = self.read_receipt()?;
        let restore = receipt
            .as_ref()
            .filter(|receipt| before.as_deref() == Some(receipt.installed_bytes.as_slice()));
        let after = if let Some(receipt) = restore {
            receipt.original_bytes.clone()
        } else {
            Some(merge_entry(
                self.cli,
                before.as_deref().unwrap_or_default(),
                None,
            )?)
        };
        let backup = self.write_config(before.as_deref(), after.as_deref())?;
        // A stale receipt is safe after a failed removal, but must not claim a future
        // installation. Surface cleanup failures instead of silently hiding them.
        match fs::remove_file(&self.receipt_path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(failure("remove the Canvas install receipt", error)),
        }
        Ok(ExternalAgentInstallOutcome {
            status: self.status_for(after.as_deref())?,
            changed: true,
            backup_path: Some(backup.to_string_lossy().into_owned()),
            restored_original: restore.is_some(),
        })
    }

    fn write_config(&self, before: Option<&[u8]>, after: Option<&[u8]>) -> InstallResult<PathBuf> {
        ensure_unchanged(&self.path, before)?;
        let parent = self.path.parent().expect("CLI config directory");
        if !parent.exists() {
            private_directory(parent)?;
        }
        // create_new prevents a same-clock timestamp from overwriting an old backup.
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| failure("timestamp the CLI backup", error))?
            .as_nanos();
        let mut name = self
            .path
            .file_name()
            .expect("CLI config filename")
            .to_os_string();
        name.push(format!(".osc-backup-{stamp}"));
        let backup = parent.join(name);
        write_new_private(&backup, before.unwrap_or_default())?;
        ensure_unchanged(&self.path, before)?;
        match after {
            Some(bytes) => {
                let permissions = fs::metadata(&self.path)
                    .ok()
                    .map(|metadata| metadata.permissions());
                atomic_write(&self.path, bytes, permissions)?;
            }
            None => fs::remove_file(&self.path)
                .map_err(|error| failure("remove the installed CLI configuration", error))?,
        }
        Ok(backup)
    }
}

fn failure(action: &str, error: impl std::fmt::Display) -> ExternalAgentCommandError {
    ExternalAgentCommandError::process(format!("Failed to {action}: {error}"))
}

fn read_optional(path: &Path) -> InstallResult<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failure("read the CLI configuration", error)),
    }
}

fn ensure_unchanged(path: &Path, expected: Option<&[u8]>) -> InstallResult<()> {
    if read_optional(path)?.as_deref() != expected {
        return Err(ExternalAgentCommandError::process(
            "The CLI configuration changed while it was being edited. No configuration was overwritten; retry with a fresh preview.",
        ));
    }
    Ok(())
}

fn private_directory(path: &Path) -> InstallResult<()> {
    fs::create_dir_all(path).map_err(|error| failure("create the install directory", error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| failure("protect the install directory", error))?;
    }
    Ok(())
}

fn write_new_private(path: &Path, bytes: &[u8]) -> InstallResult<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| failure("create the CLI backup", error))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| failure("persist the CLI backup", error))
}

fn atomic_write(
    path: &Path,
    bytes: &[u8],
    permissions: Option<fs::Permissions>,
) -> InstallResult<()> {
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().expect("file directory"))
        .map_err(|error| failure("prepare the configuration write", error))?;
    if let Some(permissions) = permissions {
        temp.as_file()
            .set_permissions(permissions)
            .map_err(|error| failure("preserve CLI configuration permissions", error))?;
    }
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|error| failure("persist the configuration write", error))?;
    temp.persist(path)
        .map_err(|error| failure("replace the configuration file", error.error))?;
    Ok(())
}

fn config_text(bytes: &[u8]) -> InstallResult<&str> {
    std::str::from_utf8(bytes)
        .map_err(|error| failure("decode the CLI configuration as UTF-8", error))
}

fn toml_document(bytes: &[u8]) -> InstallResult<DocumentMut> {
    config_text(bytes)?
        .parse::<DocumentMut>()
        .map_err(|error| failure("parse the Codex TOML configuration", error))
}

fn json_document(bytes: &[u8]) -> InstallResult<Value> {
    let document = if bytes.iter().all(u8::is_ascii_whitespace) {
        json!({})
    } else {
        serde_json::from_slice(bytes)
            .map_err(|error| failure("parse the Claude JSON configuration", error))?
    };
    if !document.is_object() {
        return Err(ExternalAgentCommandError::invalid_request(
            "Claude configuration must be a JSON object.",
        ));
    }
    Ok(document)
}

// Normalization is only used for ownership checks, never for rewriting TOML.
fn toml_item_json(item: &Item) -> Value {
    if let Some(table) = item.as_table_like() {
        return Value::Object(
            table
                .iter()
                .map(|(key, value)| (key.to_owned(), toml_item_json(value)))
                .collect(),
        );
    }
    item.as_value().map(toml_value_json).unwrap_or(Value::Null)
}

fn toml_value_json(value: &toml_edit::Value) -> Value {
    match value {
        toml_edit::Value::String(value) => json!(value.value()),
        toml_edit::Value::Integer(value) => json!(value.value()),
        toml_edit::Value::Float(value) => json!(value.value()),
        toml_edit::Value::Boolean(value) => json!(value.value()),
        toml_edit::Value::Datetime(value) => json!(value.value().to_string()),
        toml_edit::Value::Array(array) => Value::Array(array.iter().map(toml_value_json).collect()),
        toml_edit::Value::InlineTable(table) => Value::Object(
            table
                .iter()
                .map(|(key, value)| (key.to_owned(), toml_value_json(value)))
                .collect(),
        ),
    }
}

fn config_entry(cli: ExternalAgentRuntime, bytes: &[u8]) -> InstallResult<Option<Value>> {
    match cli {
        ExternalAgentRuntime::Codex => {
            let document = toml_document(bytes)?;
            let Some(servers) = document.get("mcp_servers") else {
                return Ok(None);
            };
            let servers = servers.as_table_like().ok_or_else(|| {
                ExternalAgentCommandError::invalid_request("Codex mcp_servers must be a table.")
            })?;
            Ok(servers.get(ENTRY).map(toml_item_json))
        }
        ExternalAgentRuntime::Claude => {
            let document = json_document(bytes)?;
            let Some(servers) = document.get("mcpServers") else {
                return Ok(None);
            };
            let servers = servers.as_object().ok_or_else(|| {
                ExternalAgentCommandError::invalid_request("Claude mcpServers must be an object.")
            })?;
            Ok(servers.get(ENTRY).cloned())
        }
    }
}

fn merge_entry(
    cli: ExternalAgentRuntime,
    bytes: &[u8],
    entry: Option<&Value>,
) -> InstallResult<Vec<u8>> {
    match cli {
        ExternalAgentRuntime::Codex => {
            let mut document = toml_document(bytes)?;
            if document.get("mcp_servers").is_none() {
                let mut servers = Table::new();
                servers.set_implicit(true);
                document.insert("mcp_servers", Item::Table(servers));
            }
            let inline_parent = document
                .get("mcp_servers")
                .is_some_and(Item::is_inline_table);
            let servers = document
                .get_mut("mcp_servers")
                .and_then(Item::as_table_like_mut)
                .ok_or_else(|| {
                    ExternalAgentCommandError::invalid_request("Codex mcp_servers must be a table.")
                })?;
            if let Some(entry) = entry {
                let mut server = Table::new();
                server.insert(
                    "command",
                    toml_edit::value(entry["command"].as_str().expect("command")),
                );
                let mut args = toml_edit::Array::new();
                for arg in entry["args"].as_array().expect("args") {
                    args.push(arg.as_str().expect("string argument"));
                }
                server.insert("args", toml_edit::value(args));
                server.insert("startup_timeout_sec", toml_edit::value(10));
                server.insert("tool_timeout_sec", toml_edit::value(3600));
                // Inline parent tables must also receive an inline child value.
                if inline_parent {
                    servers.insert(
                        ENTRY,
                        Item::Value(toml_edit::Value::InlineTable(server.into_inline_table())),
                    );
                } else {
                    servers.insert(ENTRY, Item::Table(server));
                }
            } else {
                servers.remove(ENTRY);
            }
            Ok(document.to_string().into_bytes())
        }
        ExternalAgentRuntime::Claude => {
            let mut document = json_document(bytes)?;
            let root = document.as_object_mut().expect("validated root");
            let servers = root
                .entry("mcpServers")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or_else(|| {
                    ExternalAgentCommandError::invalid_request(
                        "Claude mcpServers must be an object.",
                    )
                })?;
            if let Some(entry) = entry {
                servers.insert(ENTRY.into(), entry.clone());
            } else {
                servers.remove(ENTRY);
            }
            let mut bytes = serde_json::to_vec_pretty(&document)
                .map_err(|error| failure("encode the Claude configuration", error))?;
            bytes.push(b'\n');
            Ok(bytes)
        }
    }
}

/// A single replacement hunk with three unchanged context lines at either end.
/// Unlike a shell diff, this works on Windows and never needs a temporary file.
fn unified_diff(path: &Path, before: Option<&[u8]>, after: &[u8]) -> String {
    let absent = before.is_none();
    let before = before.unwrap_or_default();
    if before == after {
        return String::new();
    }
    // Both sides were parsed as UTF-8 before reaching the preview.
    let old: Vec<&str> = std::str::from_utf8(before)
        .expect("parsed before")
        .split_inclusive('\n')
        .collect();
    let new: Vec<&str> = std::str::from_utf8(after)
        .expect("parsed after")
        .split_inclusive('\n')
        .collect();
    let common_start = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let common_end = old[common_start..]
        .iter()
        .rev()
        .zip(new[common_start..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let start = common_start.saturating_sub(3);
    let old_end = (old.len() - common_end + 3).min(old.len());
    let new_end = (new.len() - common_end + 3).min(new.len());
    let mut diff = format!(
        "--- {}\n+++ {}\n@@ -{},{} +{},{} @@\n",
        if absent {
            "/dev/null".into()
        } else {
            path.to_string_lossy()
        },
        path.to_string_lossy(),
        if old_end == 0 { 0 } else { start + 1 },
        old_end - start,
        if new_end == 0 { 0 } else { start + 1 },
        new_end - start
    );
    let mut line = |prefix: char, text: &str| {
        diff.push(prefix);
        diff.push_str(text);
        if !text.ends_with('\n') {
            diff.push_str("\n\\ No newline at end of file\n");
        }
    };
    for text in &old[start..common_start] {
        line(' ', text);
    }
    for text in &old[common_start..old.len() - common_end] {
        line('-', text);
    }
    for text in &new[common_start..new.len() - common_end] {
        line('+', text);
    }
    for text in &old[old.len() - common_end..old_end] {
        line(' ', text);
    }
    diff
}

// Disk I/O runs off the UI thread, and all operations share the transaction lock.
async fn invoke<T: Send + 'static>(
    app: AppHandle,
    cli: ExternalAgentRuntime,
    action: impl FnOnce(InstallContext) -> InstallResult<T> + Send + 'static,
) -> InstallResult<T> {
    let context = InstallContext::from_app(&app, cli)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CONFIG_LOCK.lock().map_err(|_| {
            ExternalAgentCommandError::process("The CLI install lock is unavailable.")
        })?;
        action(context)
    })
    .await
    .map_err(|error| failure("complete the CLI configuration operation", error))?
}

#[tauri::command]
pub async fn external_agent_install(
    app: AppHandle,
    cli: ExternalAgentRuntime,
) -> InstallResult<ExternalAgentInstallOutcome> {
    invoke(app, cli, |context| context.install()).await
}

#[tauri::command]
pub async fn external_agent_uninstall(
    app: AppHandle,
    cli: ExternalAgentRuntime,
) -> InstallResult<ExternalAgentInstallOutcome> {
    invoke(app, cli, |context| context.uninstall()).await
}

#[tauri::command]
pub async fn external_agent_install_status(
    app: AppHandle,
    cli: ExternalAgentRuntime,
) -> InstallResult<ExternalAgentInstallStatus> {
    invoke(app, cli, |context| context.status()).await
}

#[tauri::command]
pub async fn external_agent_install_preview(
    app: AppHandle,
    cli: ExternalAgentRuntime,
) -> InstallResult<ExternalAgentInstallPreview> {
    invoke(app, cli, |context| context.preview()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    struct Fixture {
        _root: TempDir,
        context: InstallContext,
    }

    impl Fixture {
        fn new(cli: ExternalAgentRuntime) -> Self {
            let root = tempfile::tempdir().unwrap();
            let context = InstallContext::new(
                cli,
                &root.path().join("home"),
                &root.path().join("app data"),
                root.path().join("Canvas App/canvas"),
            );
            Self {
                _root: root,
                context,
            }
        }

        fn seed(&self, bytes: &[u8]) {
            fs::create_dir_all(self.context.path.parent().unwrap()).unwrap();
            fs::write(&self.context.path, bytes).unwrap();
        }

        fn bytes(&self) -> Vec<u8> {
            fs::read(&self.context.path).unwrap()
        }

        fn backups(&self) -> Vec<PathBuf> {
            fs::read_dir(self.context.path.parent().unwrap())
                .unwrap()
                .filter_map(|entry| {
                    let path = entry.unwrap().path();
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .contains(".osc-backup-")
                        .then_some(path)
                })
                .collect()
        }
    }

    #[test]
    fn empty_configs_install_and_uninstall_both_formats() {
        for cli in [ExternalAgentRuntime::Codex, ExternalAgentRuntime::Claude] {
            let fixture = Fixture::new(cli);
            fixture.seed(b"");
            assert_eq!(
                fixture.context.status().unwrap().state,
                ExternalAgentInstallState::NotInstalled
            );
            let outcome = fixture.context.install().unwrap();
            assert!(outcome.changed);
            assert!(outcome.status.installed);
            assert_eq!(fs::read(outcome.backup_path.unwrap()).unwrap(), b"");
            assert_eq!(
                config_entry(cli, &fixture.bytes()).unwrap(),
                Some(fixture.context.desired_entry().unwrap())
            );
            let outcome = fixture.context.uninstall().unwrap();
            assert!(outcome.changed && outcome.restored_original);
            assert!(!outcome.status.installed);
            assert_eq!(fixture.bytes(), b"");
        }
    }

    #[test]
    fn absent_configs_restore_absence_with_backups() {
        for cli in [ExternalAgentRuntime::Codex, ExternalAgentRuntime::Claude] {
            let fixture = Fixture::new(cli);
            assert!(fixture.context.install().unwrap().changed);
            let installed = fixture.bytes();
            let outcome = fixture.context.uninstall().unwrap();
            assert!(outcome.restored_original);
            assert!(!fixture.context.path.exists());
            assert_eq!(fs::read(outcome.backup_path.unwrap()).unwrap(), installed);
            assert_eq!(fixture.backups().len(), 2);
            assert!(!fixture.context.uninstall().unwrap().changed);
        }
    }

    #[test]
    fn existing_toml_retains_comments_formatting_and_other_servers() {
        let fixture = Fixture::new(ExternalAgentRuntime::Codex);
        let original = b"# my config\nmodel = 'custom' # keep this\n\n[mcp_servers.other] # neighbor\ncommand = 'other-tool'\nargs = ['one', 'two']\n";
        fixture.seed(original);
        fixture.context.install().unwrap();
        let installed = fixture.bytes();
        assert!(std::str::from_utf8(&installed)
            .unwrap()
            .starts_with(std::str::from_utf8(original).unwrap()));
        let document = toml_document(&installed).unwrap();
        let ours = &document["mcp_servers"][ENTRY];
        assert_eq!(ours["startup_timeout_sec"].as_integer(), Some(10));
        assert_eq!(ours["tool_timeout_sec"].as_integer(), Some(3600));
        assert_eq!(ours["args"].as_array().unwrap().len(), 2);
        fixture.context.uninstall().unwrap();
        assert_eq!(fixture.bytes(), original);
    }

    #[test]
    fn existing_json_retains_all_unrelated_keys_and_exact_restore_bytes() {
        let fixture = Fixture::new(ExternalAgentRuntime::Claude);
        let original = b"{\r\n \"theme\":\"dark\", \"projects\":{\"/project\":{\"trusted\":true}},\r\n \"mcpServers\":{\"other\":{\"command\":\"other-tool\"}}\r\n}";
        fixture.seed(original);
        fixture.context.install().unwrap();
        let installed: Value = serde_json::from_slice(&fixture.bytes()).unwrap();
        assert_eq!(installed["theme"], "dark");
        assert_eq!(installed["projects"]["/project"]["trusted"], true);
        assert_eq!(installed["mcpServers"]["other"]["command"], "other-tool");
        assert_eq!(installed["mcpServers"][ENTRY]["type"], "stdio");
        fixture.context.uninstall().unwrap();
        assert_eq!(fixture.bytes(), original);
    }

    #[test]
    fn install_is_idempotent_without_rewriting_config_receipt_or_backup() {
        for cli in [ExternalAgentRuntime::Codex, ExternalAgentRuntime::Claude] {
            let fixture = Fixture::new(cli);
            fixture.context.install().unwrap();
            let before = fixture.bytes();
            let receipt = fs::read(&fixture.context.receipt_path).unwrap();
            let modified = fs::metadata(&fixture.context.path)
                .unwrap()
                .modified()
                .unwrap();
            let outcome = fixture.context.install().unwrap();
            assert!(!outcome.changed);
            assert!(outcome.backup_path.is_none());
            assert_eq!(fixture.bytes(), before);
            assert_eq!(fs::read(&fixture.context.receipt_path).unwrap(), receipt);
            assert_eq!(
                fs::metadata(&fixture.context.path)
                    .unwrap()
                    .modified()
                    .unwrap(),
                modified
            );
            assert_eq!(fixture.backups().len(), 1);
            let preview = fixture.context.preview().unwrap();
            assert!(!preview.changed);
            assert!(preview.diff.is_empty());
        }
    }

    #[test]
    fn preview_has_unified_diff_and_never_writes() {
        for cli in [ExternalAgentRuntime::Codex, ExternalAgentRuntime::Claude] {
            let fixture = Fixture::new(cli);
            let preview = fixture.context.preview().unwrap();
            assert!(preview.changed);
            assert!(preview.diff.starts_with("--- /dev/null\n+++ "));
            assert!(preview.diff.contains("@@ -0,0 +1,"));
            assert!(preview.diff.contains(ENTRY));
            assert!(!fixture.context.path.parent().unwrap().exists());
            assert!(!fixture.context.receipt_path.parent().unwrap().exists());
            let original: &[u8] = match cli {
                ExternalAgentRuntime::Codex => b"# comment\nmodel = 'mine'\n",
                ExternalAgentRuntime::Claude => b"{\"theme\":\"dark\"}",
            };
            fixture.seed(original);
            let preview = fixture.context.preview().unwrap();
            assert!(preview.changed);
            assert!(preview.diff.contains("@@ -1,"));
            assert_eq!(fixture.bytes(), original);
            assert!(fixture.backups().is_empty());
            assert!(!fixture.context.receipt_path.exists());
        }
    }

    #[test]
    fn subsequent_toml_edits_survive_uninstall() {
        let fixture = Fixture::new(ExternalAgentRuntime::Codex);
        fixture.seed(b"# original\nmodel = 'old'\n");
        fixture.context.install().unwrap();
        let installed = String::from_utf8(fixture.bytes()).unwrap();
        let edited = installed.replace("model = 'old'", "model = 'new' # user edit")
            + "\n[mcp_servers.later]\ncommand = 'later-tool'\n";
        fixture.seed(edited.as_bytes());
        let outcome = fixture.context.uninstall().unwrap();
        assert!(!outcome.restored_original);
        let remaining = String::from_utf8(fixture.bytes()).unwrap();
        assert!(remaining.contains("model = 'new' # user edit"));
        assert!(remaining.contains("[mcp_servers.later]\ncommand = 'later-tool'"));
        assert!(!remaining.contains(ENTRY));
        assert_eq!(
            fs::read(outcome.backup_path.unwrap()).unwrap(),
            edited.as_bytes()
        );
    }

    #[test]
    fn subsequent_json_edits_survive_uninstall() {
        let fixture = Fixture::new(ExternalAgentRuntime::Claude);
        fixture.seed(b"{\"theme\":\"old\"}");
        fixture.context.install().unwrap();
        let mut edited: Value = serde_json::from_slice(&fixture.bytes()).unwrap();
        edited["theme"] = json!("new");
        edited["mcpServers"]["later"] = json!({"command": "later-tool"});
        edited["newSetting"] = json!([1, 2, 3]);
        fixture.seed(&serde_json::to_vec(&edited).unwrap());
        let outcome = fixture.context.uninstall().unwrap();
        assert!(!outcome.restored_original);
        let remaining: Value = serde_json::from_slice(&fixture.bytes()).unwrap();
        assert_eq!(remaining["theme"], "new");
        assert_eq!(remaining["newSetting"], json!([1, 2, 3]));
        assert_eq!(remaining["mcpServers"]["later"]["command"], "later-tool");
        assert!(remaining["mcpServers"].get(ENTRY).is_none());
    }

    #[test]
    fn foreign_named_entries_are_never_overwritten_or_removed() {
        for cli in [ExternalAgentRuntime::Codex, ExternalAgentRuntime::Claude] {
            let fixture = Fixture::new(cli);
            let original: &[u8] = match cli {
                ExternalAgentRuntime::Codex => {
                    b"[mcp_servers.storyboard_canvas]\ncommand = 'foreign'\n"
                }
                ExternalAgentRuntime::Claude => {
                    b"{\"mcpServers\":{\"storyboard_canvas\":{\"command\":\"foreign\"}}}"
                }
            };
            fixture.seed(original);
            assert_eq!(
                fixture.context.status().unwrap().state,
                ExternalAgentInstallState::Conflict
            );
            assert!(fixture.context.preview().is_err());
            assert!(fixture.context.install().is_err());
            assert!(fixture.context.uninstall().is_err());
            assert_eq!(fixture.bytes(), original);
            assert!(fixture.backups().is_empty());
            assert!(!fixture.context.receipt_path.exists());
        }
    }

    #[test]
    fn changed_owned_entry_is_treated_as_conflict() {
        for cli in [ExternalAgentRuntime::Codex, ExternalAgentRuntime::Claude] {
            let fixture = Fixture::new(cli);
            fixture.context.install().unwrap();
            let mut entry = fixture.context.desired_entry().unwrap();
            entry["command"] = json!("replacement");
            let edited = match cli {
                ExternalAgentRuntime::Codex => String::from_utf8(fixture.bytes())
                    .unwrap()
                    .replace(fixture.context.executable.to_str().unwrap(), "replacement")
                    .into_bytes(),
                ExternalAgentRuntime::Claude => {
                    merge_entry(cli, &fixture.bytes(), Some(&entry)).unwrap()
                }
            };
            fixture.seed(&edited);
            assert_eq!(
                fixture.context.status().unwrap().state,
                ExternalAgentInstallState::Conflict
            );
            assert!(fixture.context.uninstall().is_err());
            assert_eq!(fixture.bytes(), edited);
        }
    }

    #[test]
    fn malformed_configs_are_not_overwritten() {
        for (cli, malformed) in [
            (ExternalAgentRuntime::Codex, "mcp_servers = 'not a table'"),
            (ExternalAgentRuntime::Codex, "[broken"),
            (ExternalAgentRuntime::Claude, "{\"mcpServers\":null}"),
            (ExternalAgentRuntime::Claude, "[]"),
            (ExternalAgentRuntime::Claude, "{broken"),
        ] {
            let fixture = Fixture::new(cli);
            fixture.seed(malformed.as_bytes());
            assert!(fixture.context.install().is_err());
            assert_eq!(fixture.bytes(), malformed.as_bytes());
            assert!(fixture.backups().is_empty());
        }
    }

    #[test]
    fn inline_toml_parent_tables_are_preserved() {
        let fixture = Fixture::new(ExternalAgentRuntime::Codex);
        let original = b"mcp_servers = { other = { command = 'other-tool' } } # inline\n";
        fixture.seed(original);
        fixture.context.install().unwrap();
        let document = toml_document(&fixture.bytes()).unwrap();
        assert_eq!(
            document["mcp_servers"]["other"]["command"].as_str(),
            Some("other-tool")
        );
        assert!(String::from_utf8(fixture.bytes())
            .unwrap()
            .contains("# inline"));
        fixture.context.uninstall().unwrap();
        assert_eq!(fixture.bytes(), original);
    }

    #[test]
    fn reinstall_after_executable_move_keeps_exact_original_baseline() {
        for cli in [ExternalAgentRuntime::Codex, ExternalAgentRuntime::Claude] {
            let mut fixture = Fixture::new(cli);
            let original: &[u8] = match cli {
                ExternalAgentRuntime::Codex => b"# keep exactly\nmodel = 'mine'\n",
                ExternalAgentRuntime::Claude => b"{ \"theme\" : \"mine\" }",
            };
            fixture.seed(original);
            fixture.context.install().unwrap();
            fixture.context.executable = fixture._root.path().join("moved/Canvas");
            assert!(fixture.context.status().unwrap().installed);
            let before_preview = fixture.bytes();
            assert!(fixture.context.preview().unwrap().changed);
            assert_eq!(fixture.bytes(), before_preview);
            let outcome = fixture.context.install().unwrap();
            assert!(outcome.changed);
            assert_eq!(
                config_entry(cli, &fixture.bytes()).unwrap(),
                Some(fixture.context.desired_entry().unwrap())
            );
            assert!(!fixture.context.install().unwrap().changed);
            assert!(fixture.context.uninstall().unwrap().restored_original);
            assert_eq!(fixture.bytes(), original);
            assert_eq!(fixture.backups().len(), 3);
        }
    }

    #[test]
    fn reinstall_after_unrelated_edits_never_restores_obsolete_baseline() {
        for cli in [ExternalAgentRuntime::Codex, ExternalAgentRuntime::Claude] {
            let mut fixture = Fixture::new(cli);
            fixture.context.install().unwrap();
            let edited = match cli {
                ExternalAgentRuntime::Codex => {
                    let mut bytes = b"# new preference\nmodel = 'new'\n".to_vec();
                    bytes.extend_from_slice(&fixture.bytes());
                    bytes
                }
                ExternalAgentRuntime::Claude => {
                    let mut document: Value = serde_json::from_slice(&fixture.bytes()).unwrap();
                    document["theme"] = json!("new");
                    serde_json::to_vec(&document).unwrap()
                }
            };
            fixture.seed(&edited);
            fixture.context.executable = fixture._root.path().join("moved/Canvas");
            fixture.context.install().unwrap();
            fixture.context.uninstall().unwrap();
            let remaining = fixture.bytes();
            assert!(config_entry(cli, &remaining).unwrap().is_none());
            match cli {
                ExternalAgentRuntime::Codex => assert!(String::from_utf8(remaining)
                    .unwrap()
                    .contains("# new preference\nmodel = 'new'")),
                ExternalAgentRuntime::Claude => assert_eq!(
                    serde_json::from_slice::<Value>(&remaining).unwrap()["theme"],
                    "new"
                ),
            }
        }
    }

    #[test]
    fn independent_config_removal_does_not_restore_stale_receipt() {
        let fixture = Fixture::new(ExternalAgentRuntime::Claude);
        fixture.seed(b"{\"theme\":\"old\"}");
        fixture.context.install().unwrap();
        fixture.seed(b"{\"theme\":\"new\"}");
        assert!(!fixture.context.uninstall().unwrap().changed);
        assert_eq!(fixture.bytes(), b"{\"theme\":\"new\"}");
        fixture.context.install().unwrap();
        assert!(fixture.context.uninstall().unwrap().restored_original);
        assert_eq!(fixture.bytes(), b"{\"theme\":\"new\"}");
    }

    #[test]
    fn diff_marks_missing_final_newline() {
        let diff = unified_diff(Path::new("config"), Some(b"old"), b"new\n");
        assert!(diff.contains("-old\n\\ No newline at end of file\n+new\n"));
        assert!(diff.contains("@@ -1,1 +1,1 @@"));
    }

    #[cfg(unix)]
    #[test]
    fn backup_receipt_and_new_config_are_private_and_existing_mode_is_preserved() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new(ExternalAgentRuntime::Claude);
        let outcome = fixture.context.install().unwrap();
        for path in [
            fixture.context.path.clone(),
            fixture.context.receipt_path.clone(),
            PathBuf::from(outcome.backup_path.unwrap()),
        ] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::set_permissions(&fixture.context.path, fs::Permissions::from_mode(0o640)).unwrap();
        let mut edited: Value = serde_json::from_slice(&fixture.bytes()).unwrap();
        edited["theme"] = json!("new");
        fixture.seed(&serde_json::to_vec(&edited).unwrap());
        fixture.context.uninstall().unwrap();
        assert_eq!(
            fs::metadata(&fixture.context.path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
    }
}

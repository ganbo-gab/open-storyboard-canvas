use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, State};
use tempfile::Builder as TempFileBuilder;
use uuid::Uuid;

use super::codex::toml_string;
use super::process::LaunchTarget;
use super::protocol::validate_tools;
use super::session::terminate_session;
use super::{
    now_millis, BrokerCredentials, ExternalAgentCommandError, ExternalAgentRuntime,
    ExternalAgentSession, ExternalAgentState, ExternalAgentToolDefinition, SessionWorkspace,
    CAPABILITY_LIFETIME_MS,
};

const CONNECTION_DESCRIPTOR_SCHEMA_VERSION: u8 = 1;
const CONNECTION_DESCRIPTOR_PREFIX: &str = "canvas-mcp-";
const CONNECTION_DESCRIPTOR_SUFFIX: &str = ".json";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateExternalAgentConnectionRequest {
    pub project_id: String,
    pub project_name: String,
    #[serde(default)]
    pub tools: Vec<ExternalAgentToolDefinition>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentConnectionProject {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentProviderConfig {
    pub format: &'static str,
    pub contents: String,
    pub destination_macos: &'static str,
    pub destination_windows: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentConnectionConfigs {
    pub codex: ExternalAgentProviderConfig,
    pub claude: ExternalAgentProviderConfig,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentConnectionInfo {
    pub schema_version: u8,
    pub connection_id: Option<String>,
    pub status: String,
    pub project: Option<ExternalAgentConnectionProject>,
    pub scope: Vec<String>,
    pub permission_mode: &'static str,
    pub created_at: Option<u64>,
    pub expires_at: Option<u64>,
    pub connected_at: Option<u64>,
    pub last_activity_at: Option<u64>,
    pub call_count: u64,
    pub descriptor_path: Option<String>,
    pub configs: Option<ExternalAgentConnectionConfigs>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalAgentConnectionDescriptor {
    pub schema_version: u8,
    pub broker_address: String,
    pub capability_token: String,
    pub session_id: String,
    pub expires_at: u64,
}

fn validate_project_text(
    value: String,
    field: &str,
    max_chars: usize,
) -> Result<String, ExternalAgentCommandError> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > max_chars
        || trimmed.chars().any(char::is_control)
    {
        return Err(ExternalAgentCommandError::invalid_request(format!(
            "External Agent {field} has an invalid format."
        )));
    }
    Ok(trimmed.to_string())
}

fn write_connection_descriptor(
    descriptor_root: &Path,
    connection_id: &str,
    descriptor: &ExternalAgentConnectionDescriptor,
) -> Result<PathBuf, ExternalAgentCommandError> {
    std::fs::create_dir_all(descriptor_root).map_err(|error| {
        ExternalAgentCommandError::process(format!(
            "Failed to prepare the Canvas MCP descriptor directory: {error}"
        ))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(descriptor_root, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                ExternalAgentCommandError::process(format!(
                    "Failed to protect the Canvas MCP descriptor directory: {error}"
                ))
            },
        )?;
    }

    let path = descriptor_root.join(format!(
        "{CONNECTION_DESCRIPTOR_PREFIX}{connection_id}{CONNECTION_DESCRIPTOR_SUFFIX}"
    ));
    let bytes = serde_json::to_vec(descriptor).map_err(|_| {
        ExternalAgentCommandError::process("Failed to encode the Canvas MCP descriptor.")
    })?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|error| {
        ExternalAgentCommandError::process(format!(
            "Failed to create the Canvas MCP descriptor: {error}"
        ))
    })?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = std::fs::remove_file(&path);
        return Err(ExternalAgentCommandError::process(format!(
            "Failed to persist the Canvas MCP descriptor: {error}"
        )));
    }
    Ok(path)
}

fn build_provider_configs(
    executable: &Path,
    descriptor_path: &Path,
) -> Result<ExternalAgentConnectionConfigs, ExternalAgentCommandError> {
    let executable = executable.to_string_lossy();
    let descriptor_path = descriptor_path.to_string_lossy();
    let codex = format!(
        "[mcp_servers.storyboard_canvas]\ncommand = {}\nargs = [\"--external-agent-mcp\", {}]\nstartup_timeout_sec = 10\ntool_timeout_sec = 3600\n",
        toml_string(&executable),
        toml_string(&descriptor_path),
    );
    let claude = serde_json::to_string_pretty(&json!({
        "mcpServers": {
            "storyboard_canvas": {
                "type": "stdio",
                "command": executable.as_ref(),
                "args": ["--external-agent-mcp", descriptor_path.as_ref()],
                "env": {}
            }
        }
    }))
    .map_err(|_| ExternalAgentCommandError::process("Failed to encode Claude Code MCP config."))?;
    Ok(ExternalAgentConnectionConfigs {
        codex: ExternalAgentProviderConfig {
            format: "toml",
            contents: codex,
            destination_macos: "~/.codex/config.toml",
            destination_windows: "%USERPROFILE%\\.codex\\config.toml",
        },
        claude: ExternalAgentProviderConfig {
            format: "json",
            contents: claude,
            destination_macos: "~/.claude.json (project mcpServers entry)",
            destination_windows: "%USERPROFILE%\\.claude.json (project mcpServers entry)",
        },
    })
}

fn disconnected_connection() -> ExternalAgentConnectionInfo {
    ExternalAgentConnectionInfo {
        schema_version: 1,
        connection_id: None,
        status: "disconnected".to_string(),
        project: None,
        scope: Vec::new(),
        permission_mode: "manual",
        created_at: None,
        expires_at: None,
        connected_at: None,
        last_activity_at: None,
        call_count: 0,
        descriptor_path: None,
        configs: None,
    }
}

pub(crate) fn connection_info(
    session: &ExternalAgentSession,
) -> Result<ExternalAgentConnectionInfo, ExternalAgentCommandError> {
    let descriptor_path = session.descriptor_path.as_ref().ok_or_else(|| {
        ExternalAgentCommandError::not_found("External Agent connection descriptor is unavailable.")
    })?;
    let executable = std::env::current_exe().map_err(|error| {
        ExternalAgentCommandError::process(format!(
            "Failed to resolve the bundled Canvas MCP executable: {error}"
        ))
    })?;
    let now = now_millis();
    let connected_at = session.connected_at.load(Ordering::SeqCst);
    let last_activity_at = session.last_activity_at.load(Ordering::SeqCst);
    let status = if now >= session.capability_expires_at {
        "expired"
    } else if connected_at > 0 {
        "connected"
    } else {
        "ready"
    };
    let mut scope = session.tools.keys().cloned().collect::<Vec<_>>();
    scope.sort();
    Ok(ExternalAgentConnectionInfo {
        schema_version: 1,
        connection_id: Some(session.id.clone()),
        status: status.to_string(),
        project: Some(ExternalAgentConnectionProject {
            id: session.project_id.clone().unwrap_or_default(),
            name: session.project_name.clone().unwrap_or_default(),
        }),
        scope,
        permission_mode: "manual",
        created_at: Some(session.created_at),
        expires_at: Some(session.capability_expires_at),
        connected_at: (connected_at > 0).then_some(connected_at),
        last_activity_at: (last_activity_at > 0).then_some(last_activity_at),
        call_count: session.call_count.load(Ordering::SeqCst),
        descriptor_path: Some(descriptor_path.to_string_lossy().into_owned()),
        configs: Some(build_provider_configs(&executable, descriptor_path)?),
    })
}

#[tauri::command]
pub async fn create_external_agent_connection(
    app: AppHandle,
    state: State<'_, ExternalAgentState>,
    request: CreateExternalAgentConnectionRequest,
) -> Result<ExternalAgentConnectionInfo, ExternalAgentCommandError> {
    if !state.inner.broker_started.load(Ordering::SeqCst) {
        return Err(ExternalAgentCommandError::unavailable(
            state
                .inner
                .broker_initialization_error
                .clone()
                .unwrap_or_else(|| "Canvas MCP broker is not running.".to_string()),
        ));
    }
    let project_id = validate_project_text(request.project_id, "project id", 256)?;
    let project_name = validate_project_text(request.project_name, "project name", 256)?;
    let tools = validate_tools(request.tools)?
        .into_iter()
        .map(|mut tool| {
            tool.requires_approval = true;
            tool
        })
        .collect::<Vec<_>>();
    if tools.is_empty() {
        return Err(ExternalAgentCommandError::invalid_request(
            "At least one bounded Canvas MCP tool is required.",
        ));
    }

    if let Some(previous_id) = state.inner.managed_connection_id.read().await.clone() {
        terminate_session(&state.inner, &app, &previous_id, None).await;
    }

    let address = state.inner.broker_address.ok_or_else(|| {
        ExternalAgentCommandError::unavailable("Canvas MCP broker address is unavailable.")
    })?;
    let connection_id = Uuid::new_v4().to_string();
    let capability_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let created_at = now_millis();
    let expires_at = created_at.saturating_add(CAPABILITY_LIFETIME_MS);
    let descriptor_root = state
        .inner
        .connection_descriptor_root
        .lock()
        .map_err(|_| ExternalAgentCommandError::process("Descriptor root lock is poisoned."))?
        .clone();
    let descriptor = ExternalAgentConnectionDescriptor {
        schema_version: CONNECTION_DESCRIPTOR_SCHEMA_VERSION,
        broker_address: address.to_string(),
        capability_token: capability_token.clone(),
        session_id: connection_id.clone(),
        expires_at,
    };
    let descriptor_path =
        write_connection_descriptor(&descriptor_root, &connection_id, &descriptor)?;
    let workspace = TempFileBuilder::new()
        .prefix("managed-mcp-")
        .tempdir_in(&descriptor_root)
        .map_err(|error| {
            let _ = std::fs::remove_file(&descriptor_path);
            ExternalAgentCommandError::process(format!(
                "Failed to create the managed MCP workspace: {error}"
            ))
        })?;
    let broker = BrokerCredentials {
        address: address.to_string(),
        token: capability_token.clone(),
        session_id: connection_id.clone(),
    };
    let target = LaunchTarget::from_direct(
        std::env::current_exe().map_err(|error| {
            ExternalAgentCommandError::process(format!(
                "Failed to resolve the bundled Canvas MCP executable: {error}"
            ))
        })?,
        ExternalAgentRuntime::Codex,
    );
    let session = Arc::new(ExternalAgentSession {
        id: connection_id.clone(),
        runtime: ExternalAgentRuntime::Codex,
        capability_token,
        capability_expires_at: expires_at,
        broker,
        target,
        workspace: std::sync::Mutex::new(Some(SessionWorkspace::Temporary(workspace))),
        tools: tools
            .into_iter()
            .map(|tool| (tool.name.clone(), tool))
            .collect(),
        provider_session_id: tokio::sync::RwLock::new(None),
        model: None,
        created_at,
        cancelled: std::sync::atomic::AtomicBool::new(false),
        active_turn_id: tokio::sync::RwLock::new(Some(format!("managed-{connection_id}"))),
        active_process: tokio::sync::Mutex::new(None),
        codex_stdin: tokio::sync::Mutex::new(None),
        next_rpc_id: std::sync::atomic::AtomicU64::new(1),
        pending_rpc: tokio::sync::Mutex::new(std::collections::HashMap::new()),
        claude_has_history: std::sync::atomic::AtomicBool::new(false),
        turn_gate: tokio::sync::Mutex::new(()),
        turn_workspaces: tokio::sync::Mutex::new(std::collections::HashMap::new()),
        user_managed: true,
        project_id: Some(project_id),
        project_name: Some(project_name),
        descriptor_path: Some(descriptor_path),
        connected_at: std::sync::atomic::AtomicU64::new(0),
        last_activity_at: std::sync::atomic::AtomicU64::new(0),
        call_count: std::sync::atomic::AtomicU64::new(0),
    });
    state
        .inner
        .sessions
        .write()
        .await
        .insert(connection_id.clone(), session.clone());
    *state.inner.managed_connection_id.write().await = Some(connection_id);
    connection_info(&session)
}

#[tauri::command]
pub async fn inspect_external_agent_connection(
    state: State<'_, ExternalAgentState>,
) -> Result<ExternalAgentConnectionInfo, ExternalAgentCommandError> {
    let Some(connection_id) = state.inner.managed_connection_id.read().await.clone() else {
        return Ok(disconnected_connection());
    };
    let Some(session) = state
        .inner
        .sessions
        .read()
        .await
        .get(&connection_id)
        .cloned()
    else {
        *state.inner.managed_connection_id.write().await = None;
        return Ok(disconnected_connection());
    };
    connection_info(&session)
}

#[tauri::command]
pub async fn revoke_external_agent_connection(
    app: AppHandle,
    state: State<'_, ExternalAgentState>,
    connection_id: String,
) -> Result<ExternalAgentConnectionInfo, ExternalAgentCommandError> {
    let active_id = state.inner.managed_connection_id.read().await.clone();
    if active_id.as_deref() != Some(connection_id.as_str()) {
        return Err(ExternalAgentCommandError::not_found(
            "External Agent connection not found.",
        ));
    }
    terminate_session(&state.inner, &app, &connection_id, None).await;
    *state.inner.managed_connection_id.write().await = None;
    Ok(disconnected_connection())
}

#[tauri::command]
pub async fn replay_external_agent_pending_tool_calls(
    app: AppHandle,
    state: State<'_, ExternalAgentState>,
) -> Result<usize, ExternalAgentCommandError> {
    let Some(connection_id) = state.inner.managed_connection_id.read().await.clone() else {
        return Ok(0);
    };
    let events = state
        .inner
        .pending_tools
        .lock()
        .await
        .values()
        .filter(|pending| pending.session_id == connection_id)
        .map(|pending| pending.event.clone())
        .collect::<Vec<_>>();
    for event in &events {
        super::emit_event(&app, event.clone());
    }
    Ok(events.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_configs_use_descriptor_path_without_capability_material() {
        let configs = build_provider_configs(
            Path::new(r#"C:\Program Files\Storyboard Canvas\canvas.exe"#),
            Path::new(r#"C:\Users\Alice\AppData\Canvas MCP\descriptor.json"#),
        )
        .unwrap();
        assert!(configs.codex.contents.contains("--external-agent-mcp"));
        assert!(configs.claude.contents.contains("--external-agent-mcp"));
        assert!(configs.codex.contents.contains("descriptor.json"));
        assert!(!configs
            .codex
            .contents
            .contains("STORYBOARD_EXTERNAL_AGENT_TOKEN"));
        assert!(!configs
            .claude
            .contents
            .contains("STORYBOARD_EXTERNAL_AGENT_TOKEN"));
        serde_json::from_str::<serde_json::Value>(&configs.claude.contents).unwrap();
    }

    #[test]
    fn descriptor_file_is_private_and_exclusive() {
        let root = tempfile::tempdir().unwrap();
        let descriptor = ExternalAgentConnectionDescriptor {
            schema_version: 1,
            broker_address: "127.0.0.1:1234".to_string(),
            capability_token: "secret-capability".to_string(),
            session_id: "session-a".to_string(),
            expires_at: u64::MAX,
        };
        let path = write_connection_descriptor(root.path(), "session-a", &descriptor).unwrap();
        assert!(write_connection_descriptor(root.path(), "session-a", &descriptor).is_err());
        let decoded: ExternalAgentConnectionDescriptor =
            serde_json::from_slice(&std::fs::read(path.clone()).unwrap()).unwrap();
        assert_eq!(decoded.capability_token, "secret-capability");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o077,
                0
            );
        }
    }
}

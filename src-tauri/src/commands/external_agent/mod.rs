mod claude;
mod codex;
mod mcp;
mod process;
mod process_tree;
mod protocol;
mod session;
mod workspace;

use std::collections::HashMap;
use std::net::{SocketAddr, TcpListener as StdTcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use claude::start_claude_turn;
#[cfg(test)]
use codex::reject_forbidden_codex_notification;
use codex::{codex_rpc, send_codex_turn, start_codex_process};
pub use mcp::{is_external_agent_mcp_mode, run_external_agent_mcp_mode};
use process::{
    diagnose_runtime, discover_runtime, prepare_isolated_codex_home, safe_system_prompt,
    LaunchTarget,
};
use protocol::{
    read_bounded_jsonl_line, redact_text, sanitize_json, truncate_chars, validate_prompt,
    validate_tool_resolution, validate_tools,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use session::{clear_active_process, drain_stderr, set_active_process, terminate_session};
use tauri::{AppHandle, Emitter, Manager, State};
use tempfile::TempDir;
use tokio::process::ChildStdin;
use tokio::sync::{oneshot, Mutex, RwLock};
use uuid::Uuid;
use workspace::{
    cleanup_stale_workspaces, cleanup_turn_workspace, create_workspace,
    persist_codex_thread_marker, retain_turn_workspace, stage_turn_attachments,
};

pub const EXTERNAL_AGENT_EVENT_NAME: &str = "external-agent-event";
const SESSION_ROOT_NAME: &str = "open-storyboard-canvas/external-agents";
const STALE_WORKSPACE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const STALE_CODEX_WORKSPACE_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const CODEX_WORKSPACE_PREFIX: &str = "codex-session-";
const CODEX_THREAD_MARKER: &str = ".provider-thread-id";
const RPC_TIMEOUT: Duration = Duration::from_secs(15);
const STDERR_RETAIN_BYTES: usize = 8 * 1024;
const MAX_ATTACHMENTS: usize = 8;
const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const CAPABILITY_LIFETIME_MS: u64 = 12 * 60 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExternalAgentRuntime {
    Codex,
    Claude,
}

impl ExternalAgentRuntime {
    pub(crate) fn binary_name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentRuntimeDiagnostic {
    pub runtime: ExternalAgentRuntime,
    pub installed: bool,
    pub compatible: bool,
    pub authenticated: bool,
    pub version: Option<String>,
    pub executable_name: Option<String>,
    pub status: String,
    pub message: Option<String>,
}

impl ExternalAgentRuntimeDiagnostic {
    fn unavailable(runtime: ExternalAgentRuntime) -> Self {
        Self {
            runtime,
            installed: false,
            compatible: false,
            authenticated: false,
            version: None,
            executable_name: None,
            status: "notInstalled".to_string(),
            message: Some(format!(
                "{} CLI was not found. Install it from the provider's official documentation, then retry detection.",
                runtime.binary_name()
            )),
        }
    }

    fn error(
        runtime: ExternalAgentRuntime,
        executable_name: Option<String>,
        message: String,
    ) -> Self {
        Self {
            runtime,
            installed: true,
            compatible: false,
            authenticated: false,
            version: None,
            executable_name,
            status: "error".to_string(),
            message: Some(truncate_chars(&message, 512)),
        }
    }

    fn available(
        runtime: ExternalAgentRuntime,
        executable_name: String,
        version: Option<String>,
        compatible: bool,
        authenticated: bool,
    ) -> Self {
        let (status, message) = if !compatible {
            (
                "incompatible",
                Some(
                    "The installed CLI does not expose the required structured stdio protocol."
                        .to_string(),
                ),
            )
        } else if !authenticated {
            (
                "authRequired",
                Some(format!(
                    "{} CLI is installed but is not authenticated.",
                    runtime.binary_name()
                )),
            )
        } else {
            ("ready", None)
        };
        Self {
            runtime,
            installed: true,
            compatible,
            authenticated,
            version,
            executable_name: Some(executable_name),
            status: status.to_string(),
            message,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(default)]
    pub requires_approval: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentStartRequest {
    pub runtime: ExternalAgentRuntime,
    #[serde(default)]
    pub tools: Vec<ExternalAgentToolDefinition>,
    pub resume_id: Option<String>,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentSessionInfo {
    pub session_id: String,
    pub runtime: ExternalAgentRuntime,
    pub provider_session_id: Option<String>,
    pub status: String,
    pub model: Option<String>,
    pub permission_summary: String,
    pub created_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentTurnRequest {
    pub session_id: String,
    pub prompt: String,
    #[serde(default)]
    pub attachments: Vec<ExternalAgentAttachment>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentAttachment {
    pub reference_id: String,
    pub title: String,
    pub mime_type: String,
    pub bytes_base64: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentTurnReceipt {
    pub session_id: String,
    pub turn_id: String,
    pub accepted: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentToolResolution {
    pub outcome: String,
    pub result: Option<Value>,
    pub error_code: Option<String>,
    pub message: Option<String>,
    pub revision: Option<u64>,
    pub receipt_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentResolveToolCallRequest {
    pub session_id: String,
    pub call_id: String,
    pub resolution: ExternalAgentToolResolution,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentToolCall {
    pub call_id: String,
    pub name: String,
    pub input: Value,
    pub requires_approval: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExternalAgentEventKind {
    SessionStarted,
    TurnStarted,
    MessageDelta,
    ReasoningSummary,
    Plan,
    ToolRequested,
    ToolResolved,
    Progress,
    Diagnostic,
    Error,
    Completed,
    Canceled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentEvent {
    pub schema_version: u8,
    pub session_id: String,
    pub runtime: ExternalAgentRuntime,
    pub turn_id: Option<String>,
    pub kind: ExternalAgentEventKind,
    pub message: Option<String>,
    pub data: Option<Value>,
    pub tool_call: Option<ExternalAgentToolCall>,
}

impl ExternalAgentEvent {
    pub(crate) fn new(
        session: &ExternalAgentSession,
        kind: ExternalAgentEventKind,
        turn_id: Option<String>,
    ) -> Self {
        Self {
            schema_version: 1,
            session_id: session.id.clone(),
            runtime: session.runtime,
            turn_id,
            kind,
            message: None,
            data: None,
            tool_call: None,
        }
    }

    fn with_message(mut self, message: impl AsRef<str>) -> Self {
        self.message = Some(redact_text(message.as_ref()));
        self
    }

    fn with_data(mut self, data: Value) -> Self {
        self.data = sanitize_json(&data).ok();
        self
    }

    pub(crate) fn with_tool_call(mut self, tool_call: ExternalAgentToolCall) -> Self {
        self.tool_call = Some(tool_call);
        self
    }
}

#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct ExternalAgentCommandError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl ExternalAgentCommandError {
    fn new(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.to_string(),
            message: redact_text(&message.into()),
            retryable,
        }
    }

    pub(crate) fn invalid_request(message: impl Into<String>) -> Self {
        Self::new("invalid_request", message, false)
    }

    pub(crate) fn permission_denied(message: impl Into<String>) -> Self {
        Self::new("permission_denied", message, false)
    }

    pub(crate) fn protocol(message: impl Into<String>) -> Self {
        Self::new("protocol_error", message, false)
    }

    pub(crate) fn process(message: impl Into<String>) -> Self {
        Self::new("process_error", message, true)
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new("runtime_unavailable", message, true)
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new("session_not_found", message, false)
    }

    fn busy(message: impl Into<String>) -> Self {
        Self::new("session_busy", message, true)
    }
}

#[derive(Clone)]
pub(crate) struct BrokerCredentials {
    pub address: String,
    pub token: String,
    pub session_id: String,
}

pub(crate) struct PendingToolCall {
    pub session_id: String,
    pub sender: oneshot::Sender<ExternalAgentToolResolution>,
}

struct ActiveProcess {
    id: String,
    cancel: oneshot::Sender<()>,
    stopped: oneshot::Receiver<()>,
}

#[derive(Debug)]
struct StagedAttachment {
    title: String,
    mime_type: String,
    absolute_path: PathBuf,
    relative_path: String,
}

#[derive(Debug)]
struct StagedTurn {
    workspace: TempDir,
    attachments: Vec<StagedAttachment>,
}

enum SessionWorkspace {
    Temporary(TempDir),
    Persistent(PathBuf),
}

impl SessionWorkspace {
    fn path(&self) -> &Path {
        match self {
            Self::Temporary(workspace) => workspace.path(),
            Self::Persistent(path) => path,
        }
    }
}

pub(crate) struct ExternalAgentSession {
    id: String,
    runtime: ExternalAgentRuntime,
    capability_token: String,
    capability_expires_at: u64,
    broker: BrokerCredentials,
    target: LaunchTarget,
    workspace: StdMutex<Option<SessionWorkspace>>,
    tools: HashMap<String, ExternalAgentToolDefinition>,
    provider_session_id: RwLock<Option<String>>,
    model: Option<String>,
    created_at: u64,
    cancelled: AtomicBool,
    active_turn_id: RwLock<Option<String>>,
    active_process: Mutex<Option<ActiveProcess>>,
    codex_stdin: Mutex<Option<ChildStdin>>,
    next_rpc_id: AtomicU64,
    pending_rpc: Mutex<HashMap<u64, oneshot::Sender<Result<Value, ExternalAgentCommandError>>>>,
    claude_has_history: AtomicBool,
    turn_gate: Mutex<()>,
    turn_workspaces: Mutex<HashMap<String, TempDir>>,
}

impl ExternalAgentSession {
    fn workspace_path(&self) -> Result<PathBuf, ExternalAgentCommandError> {
        self.workspace
            .lock()
            .map_err(|_| ExternalAgentCommandError::process("Workspace lock is poisoned."))?
            .as_ref()
            .map(|workspace| workspace.path().to_path_buf())
            .ok_or_else(|| ExternalAgentCommandError::not_found("Session workspace is closed."))
    }

    async fn info(&self) -> ExternalAgentSessionInfo {
        ExternalAgentSessionInfo {
            session_id: self.id.clone(),
            runtime: self.runtime,
            provider_session_id: self.provider_session_id.read().await.clone(),
            status: if self.cancelled.load(Ordering::SeqCst) {
                "canceled".to_string()
            } else {
                "ready".to_string()
            },
            model: self.model.clone(),
            permission_summary: "Canvas MCP only; shell, arbitrary files, browser, plugins, hooks, and non-provider network tools disabled.".to_string(),
            created_at: self.created_at,
        }
    }
}

pub(crate) struct ExternalAgentInner {
    sessions: RwLock<HashMap<String, Arc<ExternalAgentSession>>>,
    pending_tools: Mutex<HashMap<String, PendingToolCall>>,
    broker_listener: StdMutex<Option<StdTcpListener>>,
    broker_address: Option<SocketAddr>,
    broker_initialization_error: Option<String>,
    broker_started: AtomicBool,
    workspace_root: StdMutex<PathBuf>,
}

#[derive(Clone)]
pub struct ExternalAgentState {
    inner: Arc<ExternalAgentInner>,
}

impl Default for ExternalAgentState {
    fn default() -> Self {
        Self::new()
    }
}

impl ExternalAgentState {
    pub fn new() -> Self {
        let workspace_root = std::env::temp_dir().join(SESSION_ROOT_NAME);
        let initialization_error = std::fs::create_dir_all(&workspace_root)
            .err()
            .map(|error| format!("failed to prepare external Agent workspaces: {error}"));
        cleanup_stale_workspaces(&workspace_root);
        let (listener, address, broker_error) = match mcp::bind_broker_listener() {
            Ok((listener, address)) => (Some(listener), Some(address), initialization_error),
            Err(error) => (None, None, Some(error)),
        };
        Self {
            inner: Arc::new(ExternalAgentInner {
                sessions: RwLock::new(HashMap::new()),
                pending_tools: Mutex::new(HashMap::new()),
                broker_listener: StdMutex::new(listener),
                broker_address: address,
                broker_initialization_error: broker_error,
                broker_started: AtomicBool::new(false),
                workspace_root: StdMutex::new(workspace_root),
            }),
        }
    }

    pub fn start_broker(&self, app: AppHandle) -> Result<(), String> {
        let workspace_root = app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("failed to resolve external Agent cache directory: {error}"))?
            .join(SESSION_ROOT_NAME);
        std::fs::create_dir_all(&workspace_root)
            .map_err(|error| format!("failed to prepare external Agent cache: {error}"))?;
        cleanup_stale_workspaces(&workspace_root);
        *self
            .inner
            .workspace_root
            .lock()
            .map_err(|_| "external Agent workspace root lock is poisoned".to_string())? =
            workspace_root;
        mcp::start_broker_listener(self.inner.clone(), app)
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

pub(crate) fn emit_event(app: &AppHandle, event: ExternalAgentEvent) {
    let _ = app.emit(EXTERNAL_AGENT_EVENT_NAME, event);
}

fn validate_optional_identifier(
    value: Option<String>,
) -> Result<Option<String>, ExternalAgentCommandError> {
    value
        .map(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty()
                || trimmed.len() > 256
                || !trimmed
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                return Err(ExternalAgentCommandError::invalid_request(
                    "Provider session id has an invalid format.",
                ));
            }
            Ok(trimmed.to_string())
        })
        .transpose()
}

fn validate_model(value: Option<String>) -> Result<Option<String>, ExternalAgentCommandError> {
    value
        .map(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() || trimmed.len() > 128 || trimmed.chars().any(char::is_control) {
                return Err(ExternalAgentCommandError::invalid_request(
                    "External Agent model id has an invalid format.",
                ));
            }
            Ok(trimmed.to_string())
        })
        .transpose()
}

#[tauri::command]
pub async fn diagnose_external_agent_runtimes() -> Vec<ExternalAgentRuntimeDiagnostic> {
    let (codex, claude) = tokio::join!(
        diagnose_runtime(ExternalAgentRuntime::Codex),
        diagnose_runtime(ExternalAgentRuntime::Claude)
    );
    vec![codex, claude]
}

#[tauri::command]
pub async fn start_external_agent_session(
    app: AppHandle,
    state: State<'_, ExternalAgentState>,
    request: ExternalAgentStartRequest,
) -> Result<ExternalAgentSessionInfo, ExternalAgentCommandError> {
    if !state.inner.broker_started.load(Ordering::SeqCst) {
        return Err(ExternalAgentCommandError::unavailable(
            state
                .inner
                .broker_initialization_error
                .clone()
                .unwrap_or_else(|| "Canvas MCP broker is not running.".to_string()),
        ));
    }
    let tools = validate_tools(request.tools)?;
    let resume_id = validate_optional_identifier(request.resume_id)?;
    let model = validate_model(request.model)?;
    let diagnostic = diagnose_runtime(request.runtime).await;
    if !diagnostic.installed || !diagnostic.compatible || !diagnostic.authenticated {
        return Err(ExternalAgentCommandError::unavailable(
            diagnostic
                .message
                .unwrap_or_else(|| "External Agent runtime is not ready.".to_string()),
        ));
    }
    let target = discover_runtime(request.runtime).ok_or_else(|| {
        ExternalAgentCommandError::unavailable("External Agent CLI disappeared after detection.")
    })?;
    let executable = std::env::current_exe().map_err(|error| {
        ExternalAgentCommandError::process(format!(
            "Failed to resolve the bundled Canvas MCP executable: {error}"
        ))
    })?;
    let address = state.inner.broker_address.ok_or_else(|| {
        ExternalAgentCommandError::unavailable("Canvas MCP broker address is unavailable.")
    })?;
    let session_id = Uuid::new_v4().to_string();
    let capability_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let workspace_root = state
        .inner
        .workspace_root
        .lock()
        .map_err(|_| ExternalAgentCommandError::process("Workspace root lock is poisoned."))?
        .clone();
    let workspace = create_workspace(&workspace_root, request.runtime, resume_id.as_deref())?;
    let provider_session_id = match request.runtime {
        ExternalAgentRuntime::Codex => resume_id.clone(),
        ExternalAgentRuntime::Claude => Some(
            resume_id
                .clone()
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
        ),
    };
    let broker = BrokerCredentials {
        address: address.to_string(),
        token: capability_token.clone(),
        session_id: session_id.clone(),
    };
    let session = Arc::new(ExternalAgentSession {
        id: session_id.clone(),
        runtime: request.runtime,
        capability_token,
        capability_expires_at: now_millis().saturating_add(CAPABILITY_LIFETIME_MS),
        broker,
        target,
        workspace: StdMutex::new(Some(workspace)),
        tools: tools
            .into_iter()
            .map(|tool| (tool.name.clone(), tool))
            .collect(),
        provider_session_id: RwLock::new(provider_session_id),
        model,
        created_at: now_millis(),
        cancelled: AtomicBool::new(false),
        active_turn_id: RwLock::new(None),
        active_process: Mutex::new(None),
        codex_stdin: Mutex::new(None),
        next_rpc_id: AtomicU64::new(1),
        pending_rpc: Mutex::new(HashMap::new()),
        claude_has_history: AtomicBool::new(resume_id.is_some()),
        turn_gate: Mutex::new(()),
        turn_workspaces: Mutex::new(HashMap::new()),
    });
    state
        .inner
        .sessions
        .write()
        .await
        .insert(session_id.clone(), session.clone());

    if request.runtime == ExternalAgentRuntime::Codex {
        if let Err(error) = start_codex_process(
            state.inner.clone(),
            app.clone(),
            session.clone(),
            &executable,
            resume_id,
        )
        .await
        {
            let failed_workspace = session.workspace_path().ok();
            terminate_session(&state.inner, &app, &session_id, Some(error.clone())).await;
            if let Some(path) = failed_workspace {
                if !path.join(CODEX_THREAD_MARKER).is_file() {
                    let _ = std::fs::remove_dir_all(path);
                }
            }
            return Err(error);
        }
    }

    let info = session.info().await;
    emit_event(
        &app,
        ExternalAgentEvent::new(&session, ExternalAgentEventKind::SessionStarted, None).with_data(
            json!({
                "providerSessionId": info.provider_session_id,
                "permissionSummary": info.permission_summary,
            }),
        ),
    );
    Ok(info)
}

#[tauri::command]
pub async fn send_external_agent_turn(
    app: AppHandle,
    state: State<'_, ExternalAgentState>,
    request: ExternalAgentTurnRequest,
) -> Result<ExternalAgentTurnReceipt, ExternalAgentCommandError> {
    let prompt = validate_prompt(&request.prompt)?;
    let session = state
        .inner
        .sessions
        .read()
        .await
        .get(&request.session_id)
        .cloned()
        .ok_or_else(|| ExternalAgentCommandError::not_found("External Agent session not found."))?;
    if session.cancelled.load(Ordering::SeqCst) {
        return Err(ExternalAgentCommandError::not_found(
            "External Agent session is closed.",
        ));
    }
    let _turn_guard = session.turn_gate.lock().await;
    if session.active_turn_id.read().await.is_some() {
        return Err(ExternalAgentCommandError::busy(
            "External Agent already has an active turn.",
        ));
    }
    let staged = stage_turn_attachments(&session, request.attachments).await?;
    let turn_id = match session.runtime {
        ExternalAgentRuntime::Codex => {
            let turn_id = send_codex_turn(&session, &prompt, staged.as_ref()).await?;
            retain_turn_workspace(&session, &turn_id, staged).await;
            turn_id
        }
        ExternalAgentRuntime::Claude => {
            start_claude_turn(
                state.inner.clone(),
                app.clone(),
                session.clone(),
                prompt,
                staged,
            )
            .await?
        }
    };
    Ok(ExternalAgentTurnReceipt {
        session_id: session.id.clone(),
        turn_id,
        accepted: true,
    })
}

#[tauri::command]
pub async fn cancel_external_agent_session(
    app: AppHandle,
    state: State<'_, ExternalAgentState>,
    session_id: String,
) -> Result<(), ExternalAgentCommandError> {
    let session = state
        .inner
        .sessions
        .read()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| ExternalAgentCommandError::not_found("External Agent session not found."))?;
    if session.runtime == ExternalAgentRuntime::Codex {
        let thread_id = session.provider_session_id.read().await.clone();
        let turn_id = session.active_turn_id.read().await.clone();
        if let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) {
            let _ = codex_rpc(
                &session,
                "turn/interrupt",
                json!({"threadId": thread_id, "turnId": turn_id}),
            )
            .await;
        }
    }
    emit_event(
        &app,
        ExternalAgentEvent::new(
            &session,
            ExternalAgentEventKind::Canceled,
            session.active_turn_id.read().await.clone(),
        ),
    );
    terminate_session(&state.inner, &app, &session_id, None).await;
    Ok(())
}

#[tauri::command]
pub async fn external_agent_resolve_tool_call(
    app: AppHandle,
    state: State<'_, ExternalAgentState>,
    request: ExternalAgentResolveToolCallRequest,
) -> Result<(), ExternalAgentCommandError> {
    if !matches!(
        request.resolution.outcome.as_str(),
        "approved" | "denied" | "error"
    ) {
        return Err(ExternalAgentCommandError::invalid_request(
            "Tool resolution outcome must be approved, denied, or error.",
        ));
    }
    let resolution = validate_tool_resolution(&request.resolution)?;
    let session = state
        .inner
        .sessions
        .read()
        .await
        .get(&request.session_id)
        .cloned()
        .ok_or_else(|| ExternalAgentCommandError::not_found("External Agent session not found."))?;
    let pending = {
        let mut pending = state.inner.pending_tools.lock().await;
        if pending
            .get(&request.call_id)
            .is_some_and(|call| call.session_id != request.session_id)
        {
            return Err(ExternalAgentCommandError::permission_denied(
                "Tool call does not belong to this session.",
            ));
        }
        pending.remove(&request.call_id)
    }
    .ok_or_else(|| {
        ExternalAgentCommandError::not_found("Tool call is no longer pending approval.")
    })?;
    let event_data = json!({
        "callId": request.call_id,
        "outcome": resolution.outcome,
        "revision": resolution.revision,
        "receiptId": resolution.receipt_id,
    });
    pending.sender.send(resolution).map_err(|_| {
        ExternalAgentCommandError::not_found("Tool call session closed before resolution.")
    })?;
    emit_event(
        &app,
        ExternalAgentEvent::new(
            &session,
            ExternalAgentEventKind::ToolResolved,
            session.active_turn_id.read().await.clone(),
        )
        .with_data(event_data),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_reject_paths() {
        let error =
            validate_optional_identifier(Some("/Users/alice/session".to_string())).unwrap_err();
        assert_eq!(error.code, "invalid_request");
    }

    #[test]
    fn dangerous_codex_notifications_fail_closed() {
        for method in [
            "item/commandExecution/outputDelta",
            "item/commandExecution/futureEvent",
            "item/fileChange/patchUpdated",
            "hook/started",
            "process/exited",
            "command/exec/outputDelta",
            "skills/changed",
            "fs/changed",
        ] {
            let error = reject_forbidden_codex_notification(method, &Value::Null).unwrap_err();
            assert_eq!(error.code, "permission_denied", "method: {method}");
        }

        for item_type in ["commandExecution", "fileChange"] {
            let error = reject_forbidden_codex_notification(
                "item/started",
                &json!({"item": {"type": item_type}}),
            )
            .unwrap_err();
            assert_eq!(error.code, "permission_denied", "item type: {item_type}");
        }

        assert!(reject_forbidden_codex_notification(
            "item/started",
            &json!({"item": {"type": "agentMessage"}}),
        )
        .is_ok());
        assert!(
            reject_forbidden_codex_notification("item/mcpToolCall/progress", &Value::Null,).is_ok()
        );
    }

    #[test]
    fn dropping_workspace_removes_isolated_directory() {
        let root = tempfile::tempdir().unwrap();
        let path = {
            let workspace =
                create_workspace(root.path(), ExternalAgentRuntime::Claude, None).unwrap();
            let path = workspace.path().to_path_buf();
            assert!(path.starts_with(root.path()));
            assert!(path.exists());
            path
        };
        assert!(!path.exists());
    }

    #[test]
    fn codex_workspace_can_be_reopened_by_provider_thread_id() {
        let root = tempfile::tempdir().unwrap();
        let workspace = create_workspace(root.path(), ExternalAgentRuntime::Codex, None).unwrap();
        let path = workspace.path().to_path_buf();
        persist_codex_thread_marker(&path, "thread-123").unwrap();
        drop(workspace);

        assert!(path.exists());
        let resumed =
            create_workspace(root.path(), ExternalAgentRuntime::Codex, Some("thread-123")).unwrap();
        assert_eq!(resumed.path(), path);
        assert!(create_workspace(
            root.path(),
            ExternalAgentRuntime::Codex,
            Some("missing-thread"),
        )
        .is_err());
    }

    #[tokio::test]
    async fn attachment_staging_rejects_path_titles() {
        let state = ExternalAgentState::new();
        let target =
            LaunchTarget::from_direct_for_test(PathBuf::from("codex"), ExternalAgentRuntime::Codex);
        let workspace_root = state.inner.workspace_root.lock().unwrap().clone();
        let workspace =
            create_workspace(&workspace_root, ExternalAgentRuntime::Claude, None).unwrap();
        let session = ExternalAgentSession {
            id: Uuid::new_v4().to_string(),
            runtime: ExternalAgentRuntime::Codex,
            capability_token: "token".to_string(),
            capability_expires_at: u64::MAX,
            broker: BrokerCredentials {
                address: "127.0.0.1:1".to_string(),
                token: "token".to_string(),
                session_id: "session".to_string(),
            },
            target,
            workspace: StdMutex::new(Some(workspace)),
            tools: HashMap::new(),
            provider_session_id: RwLock::new(None),
            model: None,
            created_at: 0,
            cancelled: AtomicBool::new(false),
            active_turn_id: RwLock::new(None),
            active_process: Mutex::new(None),
            codex_stdin: Mutex::new(None),
            next_rpc_id: AtomicU64::new(1),
            pending_rpc: Mutex::new(HashMap::new()),
            claude_has_history: AtomicBool::new(false),
            turn_gate: Mutex::new(()),
            turn_workspaces: Mutex::new(HashMap::new()),
        };
        let error = stage_turn_attachments(
            &session,
            vec![ExternalAgentAttachment {
                reference_id: "asset-1".to_string(),
                title: "/Users/alice/private.png".to_string(),
                mime_type: "image/png".to_string(),
                bytes_base64: "aQ==".to_string(),
            }],
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "invalid_request");

        let staged = stage_turn_attachments(
            &session,
            vec![ExternalAgentAttachment {
                reference_id: "asset-2".to_string(),
                title: "reference.png".to_string(),
                mime_type: "image/png".to_string(),
                bytes_base64: "iVBORw0KGgo=".to_string(),
            }],
        )
        .await
        .unwrap()
        .unwrap();
        let staged_path = staged.workspace.path().to_path_buf();
        assert!(staged_path.exists());
        drop(staged);
        assert!(!staged_path.exists());
    }
}

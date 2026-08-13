use std::env;
use std::net::{SocketAddr, TcpListener as StdTcpListener};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::protocol::{
    mcp_tool_result, read_bounded_jsonl_line, sanitize_json, MAX_TOOL_RESULT_BYTES,
};
use super::{
    emit_event, ExternalAgentCommandError, ExternalAgentEvent, ExternalAgentEventKind,
    ExternalAgentInner, ExternalAgentSession, ExternalAgentToolCall, PendingToolCall,
};

const MCP_MODE_ARGUMENT: &str = "--external-agent-mcp";
const TOOL_RESOLUTION_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub(crate) fn bind_broker_listener() -> Result<(StdTcpListener, SocketAddr), String> {
    let listener = StdTcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("failed to bind loopback broker: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("failed to configure loopback broker: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("failed to read loopback broker address: {error}"))?;
    if !address.ip().is_loopback() {
        return Err("external Agent broker must bind to loopback".to_string());
    }
    Ok((listener, address))
}

fn into_async_listener(listener: StdTcpListener) -> Result<TcpListener, String> {
    // `setup` is synchronous and macOS runs it on the AppKit thread. Enter the
    // application runtime while Tokio registers the listener, without nesting
    // a second executor through `block_on` on platforms that already entered it.
    let runtime = tauri::async_runtime::handle();
    let _runtime_guard = runtime.inner().enter();
    TcpListener::from_std(listener)
        .map_err(|error| format!("failed to start loopback broker: {error}"))
}

pub(crate) fn start_broker_listener(
    inner: Arc<ExternalAgentInner>,
    app: AppHandle,
) -> Result<(), String> {
    let listener = inner
        .broker_listener
        .lock()
        .map_err(|_| "external Agent broker lock is poisoned".to_string())?
        .take()
        .ok_or_else(|| {
            if inner
                .broker_started
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                "external Agent broker is already running".to_string()
            } else {
                inner
                    .broker_initialization_error
                    .clone()
                    .unwrap_or_else(|| "external Agent broker is unavailable".to_string())
            }
        })?;
    let listener = into_async_listener(listener)?;
    inner
        .broker_started
        .store(true, std::sync::atomic::Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        loop {
            let Ok((stream, peer)) = listener.accept().await else {
                break;
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            let inner = inner.clone();
            let app = app.clone();
            tokio::spawn(async move {
                let _ = handle_broker_connection(stream, inner, app).await;
            });
        }
    });
    Ok(())
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn capability_request_is_valid(
    expected_session_id: &str,
    requested_session_id: &str,
    expected_token: &str,
    requested_token: &str,
    cancelled: bool,
    expires_at: u64,
    now: u64,
) -> bool {
    !cancelled
        && now < expires_at
        && constant_time_equal(expected_session_id, requested_session_id)
        && constant_time_equal(expected_token, requested_token)
}

async fn authorized_session(
    inner: &Arc<ExternalAgentInner>,
    session_id: &str,
    token: &str,
) -> Option<Arc<ExternalAgentSession>> {
    let sessions = inner.sessions.read().await;
    let session = sessions.get(session_id)?.clone();
    if !capability_request_is_valid(
        &session.id,
        session_id,
        &session.capability_token,
        token,
        session.cancelled.load(std::sync::atomic::Ordering::SeqCst),
        session.capability_expires_at,
        super::now_millis(),
    ) {
        return None;
    }
    Some(session)
}

async fn handle_broker_connection(
    stream: TcpStream,
    inner: Arc<ExternalAgentInner>,
    app: AppHandle,
) -> Result<(), ExternalAgentCommandError> {
    let mut reader = BufReader::new(stream);
    let Some(line) = read_bounded_jsonl_line(&mut reader).await? else {
        return Ok(());
    };
    let request: Value = serde_json::from_slice(&line)
        .map_err(|_| ExternalAgentCommandError::protocol("Malformed broker request."))?;
    let session_id = request
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let token = request
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(session) = authorized_session(&inner, session_id, token).await else {
        let response = json!({"ok": false, "error": {"code": "invalid_capability", "message": "The Canvas capability is invalid or expired."}});
        reader
            .get_mut()
            .write_all(format!("{response}\n").as_bytes())
            .await
            .map_err(|error| ExternalAgentCommandError::protocol(error.to_string()))?;
        return Ok(());
    };

    let action = request
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let response = match action {
        "listTools" => {
            let mut tools = session.tools.values().cloned().collect::<Vec<_>>();
            tools.sort_by(|left, right| left.name.cmp(&right.name));
            json!({"ok": true, "result": {"tools": tools}})
        }
        "callTool" => {
            let name = request
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let Some(tool) = session.tools.get(name).cloned() {
                let input = sanitize_json(request.get("input").unwrap_or(&Value::Null))?;
                let call_id = Uuid::new_v4().to_string();
                let (sender, receiver) = oneshot::channel();
                inner.pending_tools.lock().await.insert(
                    call_id.clone(),
                    PendingToolCall {
                        session_id: session.id.clone(),
                        sender,
                    },
                );
                emit_event(
                    &app,
                    ExternalAgentEvent::new(
                        &session,
                        ExternalAgentEventKind::ToolRequested,
                        session.active_turn_id.read().await.clone(),
                    )
                    .with_tool_call(ExternalAgentToolCall {
                        call_id: call_id.clone(),
                        name: tool.name,
                        input,
                        requires_approval: tool.requires_approval,
                    }),
                );
                match tokio::time::timeout(TOOL_RESOLUTION_TIMEOUT, receiver).await {
                    Ok(Ok(resolution)) => {
                        json!({"ok": true, "result": mcp_tool_result(resolution)})
                    }
                    Ok(Err(_)) => {
                        json!({"ok": false, "error": {"code": "session_closed", "message": "The Canvas session closed before the tool call was resolved."}})
                    }
                    Err(_) => {
                        inner.pending_tools.lock().await.remove(&call_id);
                        json!({"ok": false, "error": {"code": "approval_timeout", "message": "The Canvas approval timed out."}})
                    }
                }
            } else {
                json!({"ok": false, "error": {"code": "tool_not_allowed", "message": "The requested tool is not in this session's Canvas manifest."}})
            }
        }
        _ => {
            json!({"ok": false, "error": {"code": "unsupported_action", "message": "Unsupported Canvas broker action."}})
        }
    };
    let encoded = serde_json::to_vec(&response)
        .map_err(|error| ExternalAgentCommandError::protocol(error.to_string()))?;
    if encoded.len() > MAX_TOOL_RESULT_BYTES + 16 * 1024 {
        return Err(ExternalAgentCommandError::protocol(
            "Canvas broker response exceeds the output limit.",
        ));
    }
    reader
        .get_mut()
        .write_all(&encoded)
        .await
        .map_err(|error| ExternalAgentCommandError::protocol(error.to_string()))?;
    reader
        .get_mut()
        .write_all(b"\n")
        .await
        .map_err(|error| ExternalAgentCommandError::protocol(error.to_string()))?;
    Ok(())
}

async fn broker_request(
    credentials: &ChildBrokerCredentials,
    action: Value,
) -> Result<Value, String> {
    let address: SocketAddr = credentials
        .address
        .parse()
        .map_err(|_| "invalid broker address".to_string())?;
    if !address.ip().is_loopback() {
        return Err("broker address is not loopback".to_string());
    }
    let mut stream = TcpStream::connect(address)
        .await
        .map_err(|error| format!("broker connection failed: {error}"))?;
    let mut request = action;
    request["token"] = Value::String(credentials.token.clone());
    request["sessionId"] = Value::String(credentials.session_id.clone());
    let encoded = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    stream
        .write_all(&encoded)
        .await
        .map_err(|error| error.to_string())?;
    stream
        .write_all(b"\n")
        .await
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(stream);
    let line = read_bounded_jsonl_line(&mut reader)
        .await
        .map_err(|error| error.message)?
        .ok_or_else(|| "broker closed without a response".to_string())?;
    let response: Value = serde_json::from_slice(&line).map_err(|error| error.to_string())?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = response
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Canvas broker rejected the request.");
        return Err(message.to_string());
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

#[derive(Clone)]
struct ChildBrokerCredentials {
    address: String,
    token: String,
    session_id: String,
}

impl ChildBrokerCredentials {
    fn from_env() -> Result<Self, String> {
        let value = |name: &str| {
            env::var(name)
                .ok()
                .filter(|item| !item.trim().is_empty())
                .ok_or_else(|| format!("missing required {name} environment value"))
        };
        Ok(Self {
            address: value("STORYBOARD_EXTERNAL_AGENT_BROKER")?,
            token: value("STORYBOARD_EXTERNAL_AGENT_TOKEN")?,
            session_id: value("STORYBOARD_EXTERNAL_AGENT_SESSION")?,
        })
    }
}

fn jsonrpc_response(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn jsonrpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

async fn run_mcp_stdio(credentials: ChildBrokerCredentials) -> Result<(), String> {
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin);
    let mut stdout = tokio::io::stdout();
    while let Some(line) = read_bounded_jsonl_line(&mut reader)
        .await
        .map_err(|error| error.message)?
    {
        if line.is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_slice(&line) {
            Ok(value) => value,
            Err(_) => {
                let response = jsonrpc_error(Value::Null, -32700, "Parse error");
                stdout
                    .write_all(format!("{response}\n").as_bytes())
                    .await
                    .map_err(|error| error.to_string())?;
                continue;
            }
        };
        let id = request.get("id").cloned();
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let response = match method {
            "initialize" => id.map(|id| {
                let protocol_version = request
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("2025-06-18");
                jsonrpc_response(
                    id,
                    json!({
                        "protocolVersion": protocol_version,
                        "capabilities": {"tools": {"listChanged": false}},
                        "serverInfo": {"name": "storyboard-canvas", "version": "1.0.0"}
                    }),
                )
            }),
            "notifications/initialized" | "notifications/cancelled" => None,
            "ping" => id.map(|id| jsonrpc_response(id, json!({}))),
            "tools/list" => {
                match broker_request(&credentials, json!({"action": "listTools"})).await {
                    Ok(result) => id.map(|id| jsonrpc_response(id, result)),
                    Err(error) => id.map(|id| jsonrpc_error(id, -32001, error)),
                }
            }
            "tools/call" => {
                let name = request
                    .pointer("/params/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let arguments = request
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match broker_request(
                    &credentials,
                    json!({"action": "callTool", "name": name, "input": arguments}),
                )
                .await
                {
                    Ok(result) => id.map(|id| jsonrpc_response(id, result)),
                    Err(error) => id.map(|id| jsonrpc_error(id, -32002, error)),
                }
            }
            _ => id.map(|id| jsonrpc_error(id, -32601, "Method not found")),
        };
        if let Some(response) = response {
            stdout
                .write_all(format!("{response}\n").as_bytes())
                .await
                .map_err(|error| error.to_string())?;
            stdout.flush().await.map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn is_external_agent_mcp_mode() -> bool {
    env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(MCP_MODE_ARGUMENT))
}

pub fn run_external_agent_mcp_mode() -> Result<(), String> {
    let credentials = ChildBrokerCredentials::from_env()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("failed to initialize MCP runtime: {error}"))?;
    runtime.block_on(run_mcp_stdio(credentials))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_comparison_is_exact() {
        assert!(constant_time_equal("abcdef", "abcdef"));
        assert!(!constant_time_equal("abcdef", "abcdeg"));
        assert!(!constant_time_equal("abcdef", "abc"));
    }

    #[test]
    fn capability_requires_exact_session_token_and_unexpired_active_state() {
        assert!(capability_request_is_valid(
            "session-a",
            "session-a",
            "token-a",
            "token-a",
            false,
            101,
            100,
        ));
        assert!(!capability_request_is_valid(
            "session-a",
            "session-b",
            "token-a",
            "token-a",
            false,
            101,
            100,
        ));
        assert!(!capability_request_is_valid(
            "session-a",
            "session-a",
            "token-a",
            "token-b",
            false,
            101,
            100,
        ));
        assert!(!capability_request_is_valid(
            "session-a",
            "session-a",
            "token-a",
            "token-a",
            false,
            100,
            100,
        ));
        assert!(!capability_request_is_valid(
            "session-a",
            "session-a",
            "token-a",
            "token-a",
            true,
            101,
            100,
        ));
    }

    #[test]
    fn loopback_ephemeral_binding_avoids_occupied_ports() {
        let occupied = StdTcpListener::bind("127.0.0.1:0").unwrap();
        let occupied_address = occupied.local_addr().unwrap();
        let (first, first_address) = bind_broker_listener().unwrap();
        let (second, second_address) = bind_broker_listener().unwrap();

        assert_eq!(first_address.ip(), std::net::Ipv4Addr::LOCALHOST);
        assert_eq!(second_address.ip(), std::net::Ipv4Addr::LOCALHOST);
        assert_ne!(first_address.port(), 0);
        assert_ne!(second_address.port(), 0);
        assert_ne!(first_address, occupied_address);
        assert_ne!(second_address, occupied_address);
        assert_ne!(first_address, second_address);

        drop((occupied, first, second));
    }

    #[test]
    fn std_listener_conversion_is_safe_without_a_caller_runtime() {
        let (listener, address) = bind_broker_listener().expect("bind broker");
        let converted = into_async_listener(listener).expect("convert broker listener");
        assert_eq!(converted.local_addr().expect("listener address"), address);
    }
}

use super::*;
use std::process::Stdio;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{ChildStdout, Command};

use super::process::configure_restricted_env;
use super::session::monitor_child_process;

pub(super) fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

pub(super) fn build_codex_command(
    target: &LaunchTarget,
    executable: &Path,
    workspace: &Path,
    codex_home: &Path,
    broker: &BrokerCredentials,
) -> Command {
    let command_literal = toml_string(&executable.to_string_lossy());
    let mcp_config = format!(
        "mcp_servers={{storyboard_canvas={{command={command_literal},args=[\"--external-agent-mcp\"],env_vars=[\"STORYBOARD_EXTERNAL_AGENT_BROKER\",\"STORYBOARD_EXTERNAL_AGENT_TOKEN\",\"STORYBOARD_EXTERNAL_AGENT_SESSION\"],required=true,startup_timeout_sec=10,tool_timeout_sec=3600}}}}"
    );
    let mut command = target.command();
    command
        .args(["app-server", "--listen", "stdio://", "--strict-config"])
        .arg("-c")
        .arg(mcp_config)
        .args([
            "-c",
            "shell_environment_policy.inherit=none",
            "-c",
            "features.shell_tool=false",
            "-c",
            "features.unified_exec=false",
            "-c",
            "features.web_search_cached=false",
            "-c",
            "features.standalone_web_search=false",
            "-c",
            "features.browser_use=false",
            "-c",
            "features.browser_use_external=false",
            "-c",
            "features.browser_use_full_cdp_access=false",
            "-c",
            "features.computer_use=false",
            "-c",
            "features.hooks=false",
            "-c",
            "features.multi_agent=false",
            "-c",
            "features.apps=false",
            "-c",
            "features.auth_elicitation=false",
            "-c",
            "features.goals=false",
            "-c",
            "features.image_generation=false",
            "-c",
            "features.in_app_browser=false",
            "-c",
            "features.plugins=false",
            "-c",
            "features.remote_plugin=false",
            "-c",
            "features.skill_mcp_dependency_install=false",
            "-c",
            "features.workspace_dependencies=false",
        ])
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_restricted_env(&mut command, Some(broker));
    command.env("CODEX_HOME", codex_home);
    command
}

pub(super) async fn start_codex_process(
    inner: Arc<ExternalAgentInner>,
    app: AppHandle,
    session: Arc<ExternalAgentSession>,
    executable: &Path,
    resume_id: Option<String>,
) -> Result<(), ExternalAgentCommandError> {
    let workspace = session.workspace_path()?;
    let codex_home = prepare_isolated_codex_home(&workspace)?;
    let mut command = build_codex_command(
        &session.target,
        executable,
        &workspace,
        &codex_home,
        &session.broker,
    );
    let mut child = command.spawn().map_err(|error| {
        ExternalAgentCommandError::process(format!("Failed to start Codex app-server: {error}"))
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| ExternalAgentCommandError::process("Codex stdin pipe is unavailable."))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ExternalAgentCommandError::process("Codex stdout pipe is unavailable."))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ExternalAgentCommandError::process("Codex stderr pipe is unavailable."))?;
    *session.codex_stdin.lock().await = Some(stdin);
    let process_id = "codex-app-server".to_string();
    let (cancel_sender, mut cancel_receiver) = oneshot::channel();
    set_active_process(&session, process_id.clone(), cancel_sender).await;
    let reader_session = session.clone();
    let reader_app = app.clone();
    let mut stdout_task =
        tokio::spawn(async move { read_codex_stdout(reader_session, reader_app, stdout).await });
    let stderr_task = tokio::spawn(drain_stderr(stderr));
    let monitor_inner = inner.clone();
    let monitor_session = session.clone();
    let monitor_app = app.clone();
    tokio::spawn(async move {
        let outcome =
            monitor_child_process(&mut child, &mut cancel_receiver, &mut stdout_task, "Codex")
                .await;
        let stderr = stderr_task.await.unwrap_or_default();
        clear_active_process(&monitor_session, &process_id).await;
        if !outcome.cancelled && !monitor_session.cancelled.load(Ordering::SeqCst) {
            let error = outcome.reader_result.err().unwrap_or_else(|| {
                ExternalAgentCommandError::process(if stderr.is_empty() {
                    "Codex app-server exited unexpectedly.".to_string()
                } else {
                    format!("Codex app-server exited: {stderr}")
                })
            });
            terminate_session(
                &monitor_inner,
                &monitor_app,
                &monitor_session.id,
                Some(error),
            )
            .await;
        }
    });

    codex_rpc(
        &session,
        "initialize",
        json!({
            "clientInfo": {
                "name": "open-storyboard-canvas",
                "title": "Open Storyboard Canvas",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {"experimentalApi": false}
        }),
    )
    .await?;
    codex_notification(&session, "initialized", json!({})).await?;

    let common = json!({
        "cwd": workspace.to_string_lossy(),
        "approvalPolicy": "never",
        "sandbox": "read-only",
        "baseInstructions": safe_system_prompt(),
        "developerInstructions": safe_system_prompt(),
        "model": session.model,
    });
    let (method, params) = if let Some(thread_id) = resume_id {
        let mut params = common;
        params["threadId"] = Value::String(thread_id);
        ("thread/resume", params)
    } else {
        ("thread/start", common)
    };
    let response = codex_rpc(&session, method, params).await?;
    if response
        .get("instructionSources")
        .and_then(Value::as_array)
        .is_some_and(|sources| !sources.is_empty())
    {
        return Err(ExternalAgentCommandError::permission_denied(
            "Codex attempted to load instructions outside the isolated Canvas session.",
        ));
    }
    let thread_id = response
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ExternalAgentCommandError::protocol(
                "Codex thread response did not include a valid thread id.",
            )
        })?
        .to_string();
    persist_codex_thread_marker(&workspace, &thread_id)?;
    *session.provider_session_id.write().await = Some(thread_id);
    Ok(())
}

pub(super) async fn codex_rpc(
    session: &ExternalAgentSession,
    method: &str,
    params: Value,
) -> Result<Value, ExternalAgentCommandError> {
    let id = session.next_rpc_id.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = oneshot::channel();
    session.pending_rpc.lock().await.insert(id, sender);
    let payload = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    let encoded = serde_json::to_vec(&payload)
        .map_err(|error| ExternalAgentCommandError::protocol(error.to_string()))?;
    let write_result = async {
        let mut stdin = session.codex_stdin.lock().await;
        let stdin = stdin.as_mut().ok_or_else(|| {
            ExternalAgentCommandError::process("Codex app-server stdin is closed.")
        })?;
        stdin
            .write_all(&encoded)
            .await
            .map_err(|error| ExternalAgentCommandError::process(error.to_string()))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| ExternalAgentCommandError::process(error.to_string()))?;
        stdin
            .flush()
            .await
            .map_err(|error| ExternalAgentCommandError::process(error.to_string()))
    }
    .await;
    if let Err(error) = write_result {
        session.pending_rpc.lock().await.remove(&id);
        return Err(error);
    }
    match tokio::time::timeout(RPC_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(ExternalAgentCommandError::process(
            "Codex app-server closed before replying.",
        )),
        Err(_) => {
            session.pending_rpc.lock().await.remove(&id);
            Err(ExternalAgentCommandError::protocol(format!(
                "Codex request '{method}' timed out."
            )))
        }
    }
}

async fn codex_notification(
    session: &ExternalAgentSession,
    method: &str,
    params: Value,
) -> Result<(), ExternalAgentCommandError> {
    let encoded = serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    }))
    .map_err(|error| ExternalAgentCommandError::protocol(error.to_string()))?;
    let mut stdin = session.codex_stdin.lock().await;
    let stdin = stdin
        .as_mut()
        .ok_or_else(|| ExternalAgentCommandError::process("Codex app-server stdin is closed."))?;
    stdin
        .write_all(&encoded)
        .await
        .map_err(|error| ExternalAgentCommandError::process(error.to_string()))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|error| ExternalAgentCommandError::process(error.to_string()))?;
    stdin
        .flush()
        .await
        .map_err(|error| ExternalAgentCommandError::process(error.to_string()))
}

pub(super) async fn send_codex_turn(
    session: &ExternalAgentSession,
    prompt: &str,
    staged: Option<&StagedTurn>,
) -> Result<String, ExternalAgentCommandError> {
    let thread_id = session
        .provider_session_id
        .read()
        .await
        .clone()
        .ok_or_else(|| ExternalAgentCommandError::protocol("Codex thread is not initialized."))?;
    let mut input = vec![json!({"type": "text", "text": prompt, "text_elements": []})];
    if let Some(staged) = staged {
        input.extend(staged.attachments.iter().map(|attachment| {
            json!({
                "type": "localImage",
                "path": attachment.absolute_path.to_string_lossy(),
                "detail": "auto"
            })
        }));
    }
    let response = codex_rpc(
        session,
        "turn/start",
        json!({
            "threadId": thread_id,
            "cwd": session.workspace_path()?.to_string_lossy(),
            "approvalPolicy": "never",
            "input": input,
        }),
    )
    .await?;
    let turn_id = response
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ExternalAgentCommandError::protocol(
                "Codex turn response did not include a valid turn id.",
            )
        })?
        .to_string();
    *session.active_turn_id.write().await = Some(turn_id.clone());
    Ok(turn_id)
}

async fn send_codex_server_error(
    session: &ExternalAgentSession,
    id: Value,
    method: &str,
) -> Result<(), ExternalAgentCommandError> {
    let encoded = serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32601,
            "message": format!("Capability '{method}' is disabled in Canvas mode.")
        }
    }))
    .map_err(|error| ExternalAgentCommandError::protocol(error.to_string()))?;
    let mut stdin = session.codex_stdin.lock().await;
    let stdin = stdin
        .as_mut()
        .ok_or_else(|| ExternalAgentCommandError::process("Codex app-server stdin is closed."))?;
    stdin
        .write_all(&encoded)
        .await
        .map_err(|error| ExternalAgentCommandError::process(error.to_string()))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|error| ExternalAgentCommandError::process(error.to_string()))?;
    stdin
        .flush()
        .await
        .map_err(|error| ExternalAgentCommandError::process(error.to_string()))
}

async fn read_codex_stdout(
    session: Arc<ExternalAgentSession>,
    app: AppHandle,
    stdout: ChildStdout,
) -> Result<(), ExternalAgentCommandError> {
    let mut reader = BufReader::new(stdout);
    while let Some(line) = read_bounded_jsonl_line(&mut reader).await? {
        if line.is_empty() {
            continue;
        }
        let message: Value = serde_json::from_slice(&line)
            .map_err(|_| ExternalAgentCommandError::protocol("Codex emitted malformed JSONL."))?;
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            if message.get("method").is_none() {
                if let Some(sender) = session.pending_rpc.lock().await.remove(&id) {
                    let result = if let Some(error) = message.get("error") {
                        let sanitized = sanitize_json(error).unwrap_or_else(|_| json!({}));
                        Err(ExternalAgentCommandError::protocol(format!(
                            "Codex request failed: {sanitized}"
                        )))
                    } else {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = sender.send(result);
                }
                continue;
            }
        }
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return Err(ExternalAgentCommandError::protocol(
                "Codex emitted an unrecognized protocol record.",
            ));
        };
        if let Some(id) = message.get("id").cloned() {
            send_codex_server_error(&session, id, method).await?;
            emit_event(
                &app,
                ExternalAgentEvent::new(
                    &session,
                    ExternalAgentEventKind::Diagnostic,
                    session.active_turn_id.read().await.clone(),
                )
                .with_message("Codex requested a capability disabled by Canvas mode."),
            );
            continue;
        }
        handle_codex_notification(&session, &app, method, message.get("params")).await?;
    }
    Ok(())
}

async fn handle_codex_notification(
    session: &ExternalAgentSession,
    app: &AppHandle,
    method: &str,
    params: Option<&Value>,
) -> Result<(), ExternalAgentCommandError> {
    let params = params.unwrap_or(&Value::Null);
    reject_forbidden_codex_notification(method, params)?;
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .or_else(|| params.pointer("/turn/id").and_then(Value::as_str))
        .map(str::to_string)
        .or(session.active_turn_id.read().await.clone());
    match method {
        "thread/started" => {
            if let Some(thread_id) = params.pointer("/thread/id").and_then(Value::as_str) {
                *session.provider_session_id.write().await = Some(thread_id.to_string());
            }
        }
        "turn/started" => {
            if let Some(turn_id) = turn_id.clone() {
                *session.active_turn_id.write().await = Some(turn_id.clone());
                emit_event(
                    app,
                    ExternalAgentEvent::new(
                        session,
                        ExternalAgentEventKind::TurnStarted,
                        Some(turn_id),
                    ),
                );
            }
        }
        "item/agentMessage/delta" => {
            if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                emit_event(
                    app,
                    ExternalAgentEvent::new(session, ExternalAgentEventKind::MessageDelta, turn_id)
                        .with_message(delta),
                );
            }
        }
        "item/plan/delta" => {
            if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                emit_event(
                    app,
                    ExternalAgentEvent::new(session, ExternalAgentEventKind::Plan, turn_id)
                        .with_message(delta),
                );
            }
        }
        "item/reasoning/summaryTextDelta" => {
            if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                emit_event(
                    app,
                    ExternalAgentEvent::new(
                        session,
                        ExternalAgentEventKind::ReasoningSummary,
                        turn_id,
                    )
                    .with_message(delta),
                );
            }
        }
        "item/started" | "item/completed" => {
            let item = params.get("item").unwrap_or(&Value::Null);
            let data = json!({
                "itemId": item.get("id").and_then(Value::as_str),
                "itemType": item.get("type").and_then(Value::as_str),
                "status": if method == "item/started" { "started" } else { "completed" }
            });
            emit_event(
                app,
                ExternalAgentEvent::new(session, ExternalAgentEventKind::Progress, turn_id)
                    .with_data(data),
            );
        }
        "turn/completed" => {
            let completed_turn_id = turn_id.clone();
            let status = params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            let kind = match status {
                "failed" => ExternalAgentEventKind::Error,
                "interrupted" => ExternalAgentEventKind::Canceled,
                _ => ExternalAgentEventKind::Completed,
            };
            let message = params
                .pointer("/turn/error/message")
                .and_then(Value::as_str);
            let mut event = ExternalAgentEvent::new(session, kind, turn_id);
            if let Some(message) = message {
                event = event.with_message(message);
            }
            emit_event(app, event.with_data(json!({"status": status})));
            *session.active_turn_id.write().await = None;
            cleanup_turn_workspace(session, completed_turn_id.as_deref()).await;
        }
        "error" => {
            let message = params
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Codex reported a turn error.");
            emit_event(
                app,
                ExternalAgentEvent::new(session, ExternalAgentEventKind::Error, turn_id)
                    .with_message(message),
            );
        }
        "warning" | "configWarning" | "deprecationNotice" | "guardianWarning" => {
            let message = params
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Codex emitted a diagnostic warning.");
            emit_event(
                app,
                ExternalAgentEvent::new(session, ExternalAgentEventKind::Diagnostic, turn_id)
                    .with_message(message),
            );
        }
        "item/reasoning/textDelta"
        | "item/reasoning/summaryPartAdded"
        | "thread/status/changed"
        | "thread/tokenUsage/updated"
        | "turn/diff/updated"
        | "turn/plan/updated"
        | "turn/moderationMetadata"
        | "item/mcpToolCall/progress"
        | "item/autoApprovalReview/started"
        | "item/autoApprovalReview/completed"
        | "mcpServer/startupStatus/updated"
        | "mcpServer/oauthLogin/completed"
        | "serverRequest/resolved"
        | "account/updated"
        | "account/rateLimits/updated"
        | "account/login/completed"
        | "model/rerouted"
        | "model/safetyBuffering/updated"
        | "model/verification"
        | "windows/worldWritableWarning"
        | "windowsSandbox/setupCompleted" => {}
        _ => {
            return Err(ExternalAgentCommandError::protocol(format!(
                "Unsupported Codex protocol notification '{method}'."
            )));
        }
    }
    Ok(())
}

pub(super) fn reject_forbidden_codex_notification(
    method: &str,
    params: &Value,
) -> Result<(), ExternalAgentCommandError> {
    let forbidden_method = [
        "item/commandExecution/",
        "item/fileChange/",
        "hook/",
        "process/",
        "command/exec/",
    ]
    .iter()
    .any(|prefix| method.starts_with(prefix))
        || matches!(method, "skills/changed" | "fs/changed");
    let forbidden_item = matches!(method, "item/started" | "item/completed")
        && params
            .pointer("/item/type")
            .and_then(Value::as_str)
            .is_some_and(|item_type| matches!(item_type, "commandExecution" | "fileChange"));
    if forbidden_method || forbidden_item {
        return Err(ExternalAgentCommandError::permission_denied(format!(
            "Codex attempted disabled command, file, hook, process, skill, or filesystem activity through notification '{method}'."
        )));
    }
    Ok(())
}

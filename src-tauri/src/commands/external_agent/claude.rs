use super::*;
use std::process::Stdio;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{ChildStdout, Command};

use super::process::configure_restricted_env;
use super::process_tree::spawn_process_tree;
use super::session::monitor_child_process;

pub(super) struct ClaudeCommandOptions<'a> {
    pub executable: &'a Path,
    pub workspace: &'a Path,
    pub broker: &'a BrokerCredentials,
    pub provider_session_id: &'a str,
    pub resume: bool,
    pub model: Option<&'a str>,
    pub tool_names: &'a [String],
    pub attachment_root: Option<&'a str>,
}

pub(super) fn build_claude_command(
    target: &LaunchTarget,
    options: ClaudeCommandOptions<'_>,
) -> Result<Command, ExternalAgentCommandError> {
    let mcp_config = serde_json::to_string(&json!({
        "mcpServers": {
            "storyboard_canvas": {
                "command": options.executable.to_string_lossy(),
                "args": ["--external-agent-mcp"]
            }
        }
    }))
    .map_err(|error| ExternalAgentCommandError::process(format!("MCP config failed: {error}")))?;

    let allowed_tools = options
        .tool_names
        .iter()
        .map(|name| format!("mcp__storyboard_canvas__{name}"))
        .collect::<Vec<_>>()
        .join(",");
    let mut command = target.command();
    command.args([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
    ]);
    command.arg(mcp_config);
    command.args(["--tools", ""]);
    let disallowed_tools = if options.attachment_root.is_some() {
        "Bash,Edit,Write,WebFetch,WebSearch,NotebookEdit,Task,TaskOutput,Glob,Grep,LS"
    } else {
        "Bash,Read,Edit,Write,WebFetch,WebSearch,NotebookEdit,Task,TaskOutput,Glob,Grep,LS"
    };
    command.args(["--disallowedTools", disallowed_tools]);
    if !allowed_tools.is_empty() {
        command.args(["--allowedTools", &allowed_tools]);
    }
    if let Some(root) = options.attachment_root {
        command.args(["--allowedTools", &format!("Read({root}/**)")]);
    }
    command.args([
        "--permission-mode",
        "dontAsk",
        "--system-prompt",
        safe_system_prompt(),
    ]);
    if options.resume {
        command.args(["--resume", options.provider_session_id]);
    } else {
        command.args(["--session-id", options.provider_session_id]);
    }
    if let Some(model) = options.model {
        command.args(["--model", model]);
    }
    command
        .current_dir(options.workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_restricted_env(&mut command, Some(options.broker));
    Ok(command)
}

pub(super) async fn start_claude_turn(
    inner: Arc<ExternalAgentInner>,
    app: AppHandle,
    session: Arc<ExternalAgentSession>,
    prompt: String,
    staged: Option<StagedTurn>,
) -> Result<String, ExternalAgentCommandError> {
    let provider_session_id = session
        .provider_session_id
        .read()
        .await
        .clone()
        .ok_or_else(|| ExternalAgentCommandError::protocol("Claude session is not initialized."))?;
    let turn_id = Uuid::new_v4().to_string();
    let workspace = session.workspace_path()?;
    let executable = std::env::current_exe().map_err(|error| {
        ExternalAgentCommandError::process(format!(
            "Failed to resolve the bundled Canvas MCP executable: {error}"
        ))
    })?;
    let tool_names = session.tools.keys().cloned().collect::<Vec<_>>();
    let attachment_root = staged
        .as_ref()
        .and_then(|staged| staged.attachments.first())
        .and_then(|attachment| attachment.relative_path.split('/').next())
        .map(str::to_string);
    let mut command = build_claude_command(
        &session.target,
        ClaudeCommandOptions {
            executable: &executable,
            workspace: &workspace,
            broker: &session.broker,
            provider_session_id: &provider_session_id,
            resume: session.claude_has_history.load(Ordering::SeqCst),
            model: session.model.as_deref(),
            tool_names: &tool_names,
            attachment_root: attachment_root.as_deref(),
        },
    )?;
    let mut child = spawn_process_tree(&mut command).map_err(|error| {
        ExternalAgentCommandError::process(format!("Failed to start Claude Code: {error}"))
    })?;
    let mut stdin = child
        .take_stdin()
        .ok_or_else(|| ExternalAgentCommandError::process("Claude stdin pipe is unavailable."))?;
    let stdout = child
        .take_stdout()
        .ok_or_else(|| ExternalAgentCommandError::process("Claude stdout pipe is unavailable."))?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| ExternalAgentCommandError::process("Claude stderr pipe is unavailable."))?;

    let mut content = vec![json!({"type": "text", "text": prompt})];
    if let Some(staged) = &staged {
        let references = staged
            .attachments
            .iter()
            .map(|attachment| {
                format!(
                    "- {} ({}) at {}",
                    attachment.title, attachment.mime_type, attachment.relative_path
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        content.push(json!({
            "type": "text",
            "text": format!(
                "Explicit image attachments for this turn:\n{references}\nUse Read only for these relative paths. Do not inspect any other file."
            )
        }));
    }
    let input = serde_json::to_vec(&json!({
        "type": "user",
        "message": {"role": "user", "content": content},
        "parent_tool_use_id": Value::Null,
        "session_id": provider_session_id,
    }))
    .map_err(|error| ExternalAgentCommandError::protocol(error.to_string()))?;
    if let Err(error) = async {
        stdin.write_all(&input).await?;
        stdin.write_all(b"\n").await?;
        stdin.shutdown().await
    }
    .await
    {
        let _ = child.terminate_and_wait().await;
        return Err(ExternalAgentCommandError::process(format!(
            "Failed to send Claude turn input: {error}"
        )));
    }

    *session.active_turn_id.write().await = Some(turn_id.clone());
    retain_turn_workspace(&session, &turn_id, staged).await;
    let (cancel_sender, mut cancel_receiver) = oneshot::channel();
    let (stopped_sender, stopped_receiver) = oneshot::channel();
    set_active_process(&session, turn_id.clone(), cancel_sender, stopped_receiver).await;
    emit_event(
        &app,
        ExternalAgentEvent::new(
            &session,
            ExternalAgentEventKind::TurnStarted,
            Some(turn_id.clone()),
        ),
    );

    let reader_session = session.clone();
    let reader_app = app.clone();
    let mut stdout_task =
        tokio::spawn(async move { read_claude_stdout(reader_session, reader_app, stdout).await });
    let stderr_task = tokio::spawn(drain_stderr(stderr));
    let monitor_inner = inner.clone();
    let monitor_session = session.clone();
    let monitor_app = app.clone();
    let monitor_turn_id = turn_id.clone();
    tokio::spawn(async move {
        let outcome =
            monitor_child_process(&mut child, &mut cancel_receiver, &mut stdout_task, "Claude")
                .await;
        let stderr = stderr_task.await.unwrap_or_default();
        clear_active_process(&monitor_session, &monitor_turn_id).await;
        let _ = stopped_sender.send(());
        if !outcome.cancelled && !monitor_session.cancelled.load(Ordering::SeqCst) {
            let active_still_set = monitor_session.active_turn_id.read().await.as_deref()
                == Some(monitor_turn_id.as_str());
            if let Err(error) = outcome.reader_result {
                terminate_session(
                    &monitor_inner,
                    &monitor_app,
                    &monitor_session.id,
                    Some(error),
                )
                .await;
            } else {
                let process_success = outcome
                    .child_status
                    .as_ref()
                    .is_ok_and(|status| status.success());
                let clean_reader_completion = outcome.reader_finished_first && !active_still_set;
                if process_success || clean_reader_completion {
                    return;
                }
                let message = if !stderr.is_empty() {
                    format!("Claude Code turn failed: {stderr}")
                } else if active_still_set {
                    "Claude Code exited without a terminal result event.".to_string()
                } else {
                    "Claude Code process exited unsuccessfully.".to_string()
                };
                terminate_session(
                    &monitor_inner,
                    &monitor_app,
                    &monitor_session.id,
                    Some(ExternalAgentCommandError::process(message)),
                )
                .await;
            }
        }
    });
    Ok(turn_id)
}

async fn read_claude_stdout(
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
            .map_err(|_| ExternalAgentCommandError::protocol("Claude emitted malformed JSONL."))?;
        let message_type = message.get("type").and_then(Value::as_str).ok_or_else(|| {
            ExternalAgentCommandError::protocol("Claude emitted an unrecognized protocol record.")
        })?;
        let turn_id = session.active_turn_id.read().await.clone();
        match message_type {
            "system" => {
                if message.get("subtype").and_then(Value::as_str) == Some("init") {
                    if let Some(provider_id) = message.get("session_id").and_then(Value::as_str) {
                        let expected = session.provider_session_id.read().await.clone();
                        if expected.as_deref() != Some(provider_id) {
                            return Err(ExternalAgentCommandError::protocol(
                                "Claude returned an unexpected session id.",
                            ));
                        }
                    }
                }
            }
            "stream_event" => {
                let event = message.get("event").unwrap_or(&Value::Null);
                if event.get("type").and_then(Value::as_str) == Some("content_block_delta")
                    && event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta")
                {
                    if let Some(delta) = event.pointer("/delta/text").and_then(Value::as_str) {
                        emit_event(
                            &app,
                            ExternalAgentEvent::new(
                                &session,
                                ExternalAgentEventKind::MessageDelta,
                                turn_id,
                            )
                            .with_message(delta),
                        );
                    }
                }
            }
            "assistant" => {
                if let Some(content) = message
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                {
                    for block in content {
                        if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                            emit_event(
                                &app,
                                ExternalAgentEvent::new(
                                    &session,
                                    ExternalAgentEventKind::Progress,
                                    turn_id.clone(),
                                )
                                .with_data(json!({
                                    "itemType": "toolUse",
                                    "itemId": block.get("id").and_then(Value::as_str),
                                    "toolName": block.get("name").and_then(Value::as_str),
                                })),
                            );
                        }
                    }
                }
            }
            "result" => {
                let is_error = message.get("is_error").and_then(Value::as_bool) == Some(true)
                    || message.get("subtype").and_then(Value::as_str) != Some("success");
                let kind = if is_error {
                    ExternalAgentEventKind::Error
                } else {
                    ExternalAgentEventKind::Completed
                };
                let mut event = ExternalAgentEvent::new(&session, kind, turn_id.clone());
                if let Some(result) = message.get("result").and_then(Value::as_str) {
                    event = event.with_message(result);
                }
                emit_event(
                    &app,
                    event.with_data(json!({
                        "subtype": message.get("subtype").and_then(Value::as_str),
                        "durationMs": message.get("duration_ms").and_then(Value::as_u64),
                        "isError": is_error,
                    })),
                );
                if !is_error {
                    session.claude_has_history.store(true, Ordering::SeqCst);
                }
                *session.active_turn_id.write().await = None;
                cleanup_turn_workspace(&session, turn_id.as_deref()).await;
            }
            "tool_progress" | "tool_use_summary" => {
                emit_event(
                    &app,
                    ExternalAgentEvent::new(&session, ExternalAgentEventKind::Progress, turn_id)
                        .with_data(json!({"providerEvent": message_type})),
                );
            }
            "rate_limit_event" => {
                emit_event(
                    &app,
                    ExternalAgentEvent::new(&session, ExternalAgentEventKind::Diagnostic, turn_id)
                        .with_message("Claude Code reported a rate-limit update."),
                );
            }
            "user" | "auth_status" | "prompt_suggestion" => {}
            _ => {
                return Err(ExternalAgentCommandError::protocol(format!(
                    "Unsupported Claude stream event '{message_type}'."
                )));
            }
        }
    }
    Ok(())
}

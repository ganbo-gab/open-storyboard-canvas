use std::future::Future;
use std::process::ExitStatus;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::json;
use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use super::process::concise_process_error;
use super::process_tree::ProcessTree;
use super::{
    emit_event, ActiveProcess, ExternalAgentCommandError, ExternalAgentEvent,
    ExternalAgentEventKind, ExternalAgentInner, ExternalAgentRuntime, ExternalAgentSession,
    ExternalAgentToolResolution, STDERR_RETAIN_BYTES,
};

pub(super) async fn drain_stderr<R>(mut reader: R) -> String
where
    R: AsyncRead + Unpin,
{
    let mut retained = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let remaining = STDERR_RETAIN_BYTES.saturating_sub(retained.len());
                retained.extend_from_slice(&buffer[..count.min(remaining)]);
            }
        }
    }
    concise_process_error(&String::from_utf8_lossy(&retained))
}

enum ProcessMonitorEvent<TChild, TReader> {
    Reader(TReader),
    Cancelled,
    Child(TChild),
}

async fn next_process_monitor_event<TChild, TReader, FChild, FCancel, FReader>(
    child: FChild,
    cancel: FCancel,
    reader: FReader,
) -> ProcessMonitorEvent<TChild, TReader>
where
    FChild: Future<Output = TChild>,
    FCancel: Future,
    FReader: Future<Output = TReader>,
{
    tokio::select! {
        biased;
        reader_result = reader => ProcessMonitorEvent::Reader(reader_result),
        _ = cancel => ProcessMonitorEvent::Cancelled,
        child_status = child => ProcessMonitorEvent::Child(child_status),
    }
}

pub(super) struct ProcessMonitorOutcome {
    pub(super) cancelled: bool,
    pub(super) reader_finished_first: bool,
    pub(super) child_status: std::io::Result<ExitStatus>,
    pub(super) reader_result: Result<(), ExternalAgentCommandError>,
}

fn normalize_reader_result(
    provider: &str,
    result: Result<Result<(), ExternalAgentCommandError>, tokio::task::JoinError>,
) -> Result<(), ExternalAgentCommandError> {
    result.unwrap_or_else(|error| {
        Err(ExternalAgentCommandError::protocol(format!(
            "{provider} output task failed: {error}"
        )))
    })
}

pub(super) async fn monitor_child_process(
    child: &mut ProcessTree,
    cancel_receiver: &mut oneshot::Receiver<()>,
    stdout_task: &mut JoinHandle<Result<(), ExternalAgentCommandError>>,
    provider: &str,
) -> ProcessMonitorOutcome {
    match next_process_monitor_event(child.wait(), cancel_receiver, &mut *stdout_task).await {
        ProcessMonitorEvent::Reader(reader_result) => {
            let reader_result = normalize_reader_result(provider, reader_result);
            let child_status = child.terminate_and_wait().await;
            ProcessMonitorOutcome {
                cancelled: false,
                reader_finished_first: true,
                child_status,
                reader_result,
            }
        }
        ProcessMonitorEvent::Cancelled => {
            let child_status = child.terminate_and_wait().await;
            let reader_result = normalize_reader_result(provider, stdout_task.await);
            ProcessMonitorOutcome {
                cancelled: true,
                reader_finished_first: false,
                child_status,
                reader_result,
            }
        }
        ProcessMonitorEvent::Child(child_status) => {
            let reader_result = normalize_reader_result(provider, stdout_task.await);
            ProcessMonitorOutcome {
                cancelled: false,
                reader_finished_first: false,
                child_status,
                reader_result,
            }
        }
    }
}

pub(super) async fn set_active_process(
    session: &ExternalAgentSession,
    id: String,
    cancel: oneshot::Sender<()>,
    stopped: oneshot::Receiver<()>,
) {
    *session.active_process.lock().await = Some(ActiveProcess {
        id,
        cancel,
        stopped,
    });
}

pub(super) async fn clear_active_process(session: &ExternalAgentSession, id: &str) {
    let mut active = session.active_process.lock().await;
    if active.as_ref().is_some_and(|process| process.id == id) {
        active.take();
    }
}

async fn cancel_active_process(mut process: ActiveProcess) {
    let _ = process.cancel.send(());
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), &mut process.stopped).await;
}

pub(super) async fn terminate_session(
    inner: &Arc<ExternalAgentInner>,
    app: &AppHandle,
    session_id: &str,
    error: Option<ExternalAgentCommandError>,
) {
    let session = inner.sessions.write().await.remove(session_id);
    let Some(session) = session else {
        return;
    };
    if session.user_managed {
        let mut managed_connection_id = inner.managed_connection_id.write().await;
        if managed_connection_id.as_deref() == Some(session_id) {
            *managed_connection_id = None;
        }
    }
    session.cancelled.store(true, Ordering::SeqCst);
    if let Some(descriptor_path) = &session.descriptor_path {
        let _ = std::fs::remove_file(descriptor_path);
    }
    if session.runtime == ExternalAgentRuntime::Codex {
        if let Ok(workspace) = session.workspace_path() {
            let auth_file = workspace.join("codex-home/auth.json");
            if auth_file.is_file() || auth_file.is_symlink() {
                let _ = std::fs::remove_file(auth_file);
            }
        }
    }
    if let Some(error) = error {
        emit_event(
            app,
            ExternalAgentEvent::new(
                &session,
                ExternalAgentEventKind::Error,
                session.active_turn_id.read().await.clone(),
            )
            .with_message(error.message)
            .with_data(json!({"code": error.code, "retryable": error.retryable})),
        );
    }
    let active_process = { session.active_process.lock().await.take() };
    if let Some(process) = active_process {
        cancel_active_process(process).await;
    }
    session.codex_stdin.lock().await.take();
    for (_, sender) in session.pending_rpc.lock().await.drain() {
        let _ = sender.send(Err(ExternalAgentCommandError::process(
            "External Agent session closed.",
        )));
    }
    let pending_ids = {
        let pending = inner.pending_tools.lock().await;
        pending
            .iter()
            .filter_map(|(id, call)| (call.session_id == session_id).then_some(id.clone()))
            .collect::<Vec<_>>()
    };
    let mut pending = inner.pending_tools.lock().await;
    for call_id in pending_ids {
        if let Some(call) = pending.remove(&call_id) {
            let _ = call.sender.send(ExternalAgentToolResolution {
                outcome: "denied".to_string(),
                result: None,
                error_code: Some("session_closed".to_string()),
                message: Some("The Canvas session closed before approval.".to_string()),
                revision: None,
                receipt_id: None,
            });
        }
    }
    drop(pending);
    session.turn_workspaces.lock().await.clear();
    if let Ok(mut workspace) = session.workspace.lock() {
        workspace.take();
    };
}

#[cfg(test)]
mod tests {
    use std::future::{pending, ready};

    use super::*;

    #[tokio::test]
    async fn reader_failure_does_not_wait_for_child_exit() {
        let reader_error = ExternalAgentCommandError::permission_denied("forbidden event");
        let event = next_process_monitor_event(
            pending::<()>(),
            pending::<()>(),
            ready(Err::<(), _>(reader_error)),
        )
        .await;

        let ProcessMonitorEvent::Reader(Err(error)) = event else {
            panic!("reader failure must win while child and cancellation remain pending");
        };
        assert_eq!(error.code, "permission_denied");
    }

    #[tokio::test]
    async fn reader_eof_does_not_wait_for_child_exit() {
        let event = next_process_monitor_event(
            pending::<()>(),
            pending::<()>(),
            ready(Ok::<(), ExternalAgentCommandError>(())),
        )
        .await;

        assert!(matches!(event, ProcessMonitorEvent::Reader(Ok(()))));
    }

    #[tokio::test]
    async fn cancellation_does_not_wait_for_child_or_reader() {
        let event = next_process_monitor_event(
            pending::<()>(),
            ready(()),
            pending::<Result<(), ExternalAgentCommandError>>(),
        )
        .await;

        assert!(matches!(event, ProcessMonitorEvent::Cancelled));
    }

    #[tokio::test]
    async fn active_process_cancellation_waits_for_the_monitor_acknowledgement() {
        let (cancel_sender, cancel_receiver) = oneshot::channel();
        let (stopped_sender, stopped_receiver) = oneshot::channel();
        let acknowledgement = tokio::spawn(async move {
            cancel_receiver.await.unwrap();
            stopped_sender.send(()).unwrap();
        });

        cancel_active_process(ActiveProcess {
            id: "fixture".to_string(),
            cancel: cancel_sender,
            stopped: stopped_receiver,
        })
        .await;

        acknowledgement.await.unwrap();
    }
}

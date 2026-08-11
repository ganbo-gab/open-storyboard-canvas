use base64::Engine;

use super::*;

pub(super) fn cleanup_stale_workspaces(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let is_codex_workspace = name.starts_with(CODEX_WORKSPACE_PREFIX);
        let is_temporary_workspace = name.starts_with("session-");
        if !file_type.is_dir()
            || file_type.is_symlink()
            || (!is_codex_workspace && !is_temporary_workspace)
        {
            continue;
        }
        if is_codex_workspace {
            let auth_file = entry.path().join("codex-home/auth.json");
            if auth_file.is_file() || auth_file.is_symlink() {
                let _ = std::fs::remove_file(auth_file);
            }
        }
        let is_stale = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| {
                age >= if is_codex_workspace {
                    STALE_CODEX_WORKSPACE_AGE
                } else {
                    STALE_WORKSPACE_AGE
                }
            });
        if is_stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn protect_workspace(path: &Path) -> Result<(), ExternalAgentCommandError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                ExternalAgentCommandError::process(format!(
                    "Failed to protect external Agent workspace: {error}"
                ))
            },
        )?;
    }
    Ok(())
}

fn find_codex_workspace(
    root: &Path,
    thread_id: &str,
) -> Result<PathBuf, ExternalAgentCommandError> {
    let entries = std::fs::read_dir(root).map_err(|error| {
        ExternalAgentCommandError::process(format!(
            "Failed to inspect Codex session workspaces: {error}"
        ))
    })?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir()
            || file_type.is_symlink()
            || !entry
                .file_name()
                .to_string_lossy()
                .starts_with(CODEX_WORKSPACE_PREFIX)
        {
            continue;
        }
        let marker = entry.path().join(CODEX_THREAD_MARKER);
        let Ok(marker_metadata) = std::fs::symlink_metadata(&marker) else {
            continue;
        };
        if !marker_metadata.file_type().is_file()
            || marker_metadata.file_type().is_symlink()
            || marker_metadata.len() > 512
        {
            continue;
        }
        let Ok(value) = std::fs::read_to_string(marker) else {
            continue;
        };
        if value.trim() == thread_id {
            return Ok(entry.path());
        }
    }
    Err(ExternalAgentCommandError::not_found(
        "The isolated Codex thread history is unavailable or has expired. Start a new conversation.",
    ))
}

pub(super) fn create_workspace(
    root: &Path,
    runtime: ExternalAgentRuntime,
    resume_id: Option<&str>,
) -> Result<SessionWorkspace, ExternalAgentCommandError> {
    std::fs::create_dir_all(root).map_err(|error| {
        ExternalAgentCommandError::process(format!("Failed to prepare session workspace: {error}"))
    })?;
    if runtime == ExternalAgentRuntime::Codex {
        if let Some(thread_id) = resume_id {
            let path = find_codex_workspace(root, thread_id)?;
            protect_workspace(&path)?;
            return Ok(SessionWorkspace::Persistent(path));
        }
        let path = root.join(format!(
            "{CODEX_WORKSPACE_PREFIX}{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir(&path).map_err(|error| {
            ExternalAgentCommandError::process(format!(
                "Failed to create persistent isolated Codex workspace: {error}"
            ))
        })?;
        protect_workspace(&path)?;
        return Ok(SessionWorkspace::Persistent(path));
    }
    tempfile::Builder::new()
        .prefix("session-")
        .tempdir_in(root)
        .map(SessionWorkspace::Temporary)
        .map_err(|error| {
            ExternalAgentCommandError::process(format!(
                "Failed to create isolated session workspace: {error}"
            ))
        })
}

pub(super) fn persist_codex_thread_marker(
    workspace: &Path,
    thread_id: &str,
) -> Result<(), ExternalAgentCommandError> {
    std::fs::write(workspace.join(CODEX_THREAD_MARKER), thread_id.as_bytes()).map_err(|error| {
        ExternalAgentCommandError::process(format!(
            "Failed to persist isolated Codex thread metadata: {error}"
        ))
    })
}

fn attachment_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn attachment_matches_mime(bytes: &[u8], mime_type: &str) -> bool {
    match mime_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        _ => false,
    }
}

pub(super) async fn stage_turn_attachments(
    session: &ExternalAgentSession,
    attachments: Vec<ExternalAgentAttachment>,
) -> Result<Option<StagedTurn>, ExternalAgentCommandError> {
    if attachments.is_empty() {
        return Ok(None);
    }
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(ExternalAgentCommandError::invalid_request(
            "A turn can include at most 8 image attachments.",
        ));
    }
    let session_workspace = session.workspace_path()?;
    let workspace = tempfile::Builder::new()
        .prefix("turn-")
        .tempdir_in(&session_workspace)
        .map_err(|error| {
            ExternalAgentCommandError::process(format!(
                "Failed to create isolated attachment workspace: {error}"
            ))
        })?;
    let relative_root = workspace
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| ExternalAgentCommandError::process("Attachment workspace name is invalid."))?
        .to_string();
    let mut staged = Vec::with_capacity(attachments.len());
    let mut total_bytes = 0_usize;
    for attachment in attachments {
        let reference_id = attachment.reference_id.trim();
        if reference_id.is_empty()
            || reference_id.len() > 128
            || !reference_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(ExternalAgentCommandError::invalid_request(
                "Attachment reference id has an invalid format.",
            ));
        }
        let title = attachment.title.trim();
        if title.is_empty()
            || title.len() > 256
            || title.chars().any(char::is_control)
            || title.contains('/')
            || title.contains('\\')
        {
            return Err(ExternalAgentCommandError::invalid_request(
                "Attachment title has an invalid format.",
            ));
        }
        let extension = attachment_extension(attachment.mime_type.trim()).ok_or_else(|| {
            ExternalAgentCommandError::invalid_request(
                "Only PNG, JPEG, WebP, and GIF image attachments are supported.",
            )
        })?;
        if attachment.bytes_base64.len() > (MAX_ATTACHMENT_BYTES * 4 / 3) + 8 {
            return Err(ExternalAgentCommandError::invalid_request(
                "An image attachment exceeds 20 MiB.",
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(attachment.bytes_base64.as_bytes())
            .map_err(|_| {
                ExternalAgentCommandError::invalid_request("Attachment bytes are not valid base64.")
            })?;
        if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(ExternalAgentCommandError::invalid_request(
                "An image attachment must contain 1 byte to 20 MiB.",
            ));
        }
        if !attachment_matches_mime(&bytes, attachment.mime_type.trim()) {
            return Err(ExternalAgentCommandError::invalid_request(
                "Attachment bytes do not match the declared image MIME type.",
            ));
        }
        total_bytes = total_bytes.saturating_add(bytes.len());
        if total_bytes > MAX_ATTACHMENTS_TOTAL_BYTES {
            return Err(ExternalAgentCommandError::invalid_request(
                "Turn attachments exceed the 64 MiB total limit.",
            ));
        }
        let file_name = format!("asset-{}.{}", Uuid::new_v4().simple(), extension);
        let absolute_path = workspace.path().join(&file_name);
        tokio::fs::write(&absolute_path, bytes)
            .await
            .map_err(|error| {
                ExternalAgentCommandError::process(format!(
                    "Failed to stage an image attachment: {error}"
                ))
            })?;
        staged.push(StagedAttachment {
            title: title.to_string(),
            mime_type: attachment.mime_type,
            absolute_path,
            relative_path: format!("{relative_root}/{file_name}"),
        });
    }
    Ok(Some(StagedTurn {
        workspace,
        attachments: staged,
    }))
}

pub(super) async fn retain_turn_workspace(
    session: &ExternalAgentSession,
    turn_id: &str,
    staged: Option<StagedTurn>,
) {
    if let Some(staged) = staged {
        session
            .turn_workspaces
            .lock()
            .await
            .insert(turn_id.to_string(), staged.workspace);
    }
}

pub(super) async fn cleanup_turn_workspace(session: &ExternalAgentSession, turn_id: Option<&str>) {
    if let Some(turn_id) = turn_id {
        session.turn_workspaces.lock().await.remove(turn_id);
    }
}

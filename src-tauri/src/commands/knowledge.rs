use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[cfg(unix)]
#[path = "knowledge_attachment_fs.rs"]
mod attachment_fs;
#[cfg(windows)]
#[path = "knowledge_attachment_windows.rs"]
mod attachment_windows;
const MAX_ATTACHMENT_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeError {
    pub code: &'static str,
    pub message: String,
}
impl KnowledgeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl From<std::io::Error> for KnowledgeError {
    fn from(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "NOT_FOUND",
            std::io::ErrorKind::AlreadyExists => "ALREADY_EXISTS",
            std::io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
            _ => "IO_ERROR",
        };
        Self::new(code, error.to_string())
    }
}
type KResult<T> = Result<T, KnowledgeError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeEntry {
    path: String,
    name: String,
    kind: &'static str,
    modified_at: u64,
    size: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeNote {
    path: String,
    content: String,
}

fn validate_vault_root(root: &Path) -> KResult<()> {
    if !root.is_absolute() {
        return Err(KnowledgeError::new(
            "INVALID_VAULT",
            "Vault root must be absolute",
        ));
    }
    #[cfg(unix)]
    {
        attachment_fs::validate_root(root)
    }
    #[cfg(windows)]
    {
        attachment_windows::validate_root(root)
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(KnowledgeError::new(
            "IO_ERROR",
            "Confined vault IO is unavailable on this platform",
        ))
    }
}

/// Access preserves the authorized pathname. Only explicit initialization may resolve aliases.
fn vault_root(root: &str) -> KResult<&Path> {
    let root = Path::new(root);
    validate_vault_root(root)?;
    Ok(root)
}

/// Reject cross-platform absolute paths, traversal, reserved metadata and all symlinks.
/// Existing ancestors are checked even when the final destination does not exist yet.
fn safe_path(root: &Path, relative: &str) -> KResult<PathBuf> {
    resolve_path(root, relative, false)
}
fn resolve_path(root: &Path, relative: &str, allow_trash: bool) -> KResult<PathBuf> {
    // Paths are literal filenames, never URI-decoded. Reject encoded octets (including
    // encoded percent signs) rather than guessing how many decode passes a caller used.
    let encoded = relative
        .as_bytes()
        .windows(3)
        .any(|part| part[0] == b'%' && part[1].is_ascii_hexdigit() && part[2].is_ascii_hexdigit());
    if relative.is_empty()
        || encoded
        || relative
            .chars()
            .any(|value| value.is_control() || "\\\\:<>\"|?*".contains(value))
    {
        return Err(KnowledgeError::new(
            "UNSAFE_PATH",
            "Expected a vault-relative path",
        ));
    }
    let mut path = root.to_path_buf();
    for name in relative.split('/') {
        let lower = name.to_ascii_lowercase();
        if name.is_empty()
            || name == "."
            || name == ".."
            || name.ends_with(['.', ' '])
            || lower == ".obsidian"
            || (!allow_trash && lower == ".trash")
            || lower.starts_with(".knowledge-")
        {
            return Err(KnowledgeError::new(
                "UNSAFE_PATH",
                "Traversal and reserved paths are forbidden",
            ));
        }
        path.push(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(KnowledgeError::new(
                    "UNSAFE_PATH",
                    "Symlink paths are forbidden",
                ));
            }
            Ok(_) => {
                if !fs::canonicalize(&path)?.starts_with(root) {
                    return Err(KnowledgeError::new("UNSAFE_PATH", "Path escapes the vault"));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    if path == root {
        return Err(KnowledgeError::new(
            "UNSAFE_PATH",
            "Vault root cannot be modified",
        ));
    }
    Ok(path)
}
fn is_note(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}
fn require_note(path: &Path) -> KResult<()> {
    if !is_note(path) {
        return Err(KnowledgeError::new(
            "INVALID_NOTE",
            "Notes must use the .md extension",
        ));
    }
    Ok(())
}
fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
fn list_recursive(root: &Path, directory: &Path, entries: &mut Vec<KnowledgeEntry>) -> KResult<()> {
    for child in fs::read_dir(directory)? {
        let child = child?;
        let path = child.path();
        if child
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case(".obsidian")
            || child
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(".trash")
            || child
                .file_name()
                .to_string_lossy()
                .get(..".knowledge-".len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(".knowledge-"))
        {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        // Do not follow symlinks, including directory cycles and external attachments.
        if metadata.file_type().is_symlink() {
            continue;
        }
        let directory = metadata.is_dir();
        if !directory && !metadata.is_file() {
            continue;
        }
        entries.push(KnowledgeEntry {
            path: relative_path(root, &path),
            name: child.file_name().to_string_lossy().into_owned(),
            kind: if directory {
                "folder"
            } else if is_note(&path) {
                "note"
            } else {
                "attachment"
            },
            modified_at: metadata
                .modified()?
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            size: metadata.len(),
        });
        if directory {
            list_recursive(root, &path, entries)?;
        }
    }
    Ok(())
}
fn tree(root: &Path) -> KResult<Vec<KnowledgeEntry>> {
    let mut entries = Vec::new();
    list_recursive(root, root, &mut entries)?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}
fn atomic_write(root: &Path, relative: &str, bytes: &[u8], create_only: bool) -> KResult<()> {
    let path = safe_path(root, relative)?;
    let parent = path
        .parent()
        .ok_or_else(|| KnowledgeError::new("UNSAFE_PATH", "Missing parent"))?;
    fs::create_dir_all(parent)?;
    // Re-check after creating missing parents, before opening the temporary file.
    safe_path(root, relative)?;
    let mut temp = tempfile::Builder::new()
        .prefix(".knowledge-")
        .tempfile_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    if create_only {
        temp.persist_noclobber(&path)
            .map_err(|error| KnowledgeError::from(error.error))?;
    } else {
        temp.persist(&path)
            .map_err(|error| KnowledgeError::from(error.error))?;
    }
    Ok(())
}

#[tauri::command]
pub fn knowledge_init_vault(root: String) -> KResult<String> {
    if !Path::new(&root).is_absolute() {
        return Err(KnowledgeError::new(
            "INVALID_VAULT",
            "Vault root must be absolute",
        ));
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(KnowledgeError::new(
            "IO_ERROR",
            "Confined vault IO is unavailable on this platform",
        ))
    }
    #[cfg(any(unix, windows))]
    {
        fs::create_dir_all(&root)?;
        // This command represents explicit user authorization, including selection of an alias.
        let root = fs::canonicalize(root)?;
        if !root.is_dir() {
            return Err(KnowledgeError::new(
                "INVALID_VAULT",
                "Vault root must be a directory",
            ));
        }
        validate_vault_root(&root)?;
        let attachments = safe_path(&root, "attachments")?;
        fs::create_dir_all(attachments)?;
        Ok(root.to_string_lossy().into_owned())
    }
}
/// Reopening a stored authorization never creates files or resolves a replacement alias.
#[tauri::command]
pub fn knowledge_open_vault(root: String) -> KResult<String> {
    vault_root(&root)?;
    Ok(root)
}
#[tauri::command]
pub fn knowledge_list_tree(root: String) -> KResult<Vec<KnowledgeEntry>> {
    tree(&vault_root(&root)?)
}
#[tauri::command]
pub fn knowledge_read_note(root: String, path: String) -> KResult<String> {
    let path = safe_path(&vault_root(&root)?, &path)?;
    require_note(&path)?;
    Ok(fs::read_to_string(path)?)
}
/// One IPC request for initial indexing or a changed-note batch (5k notes does not mean 5k invokes).
#[tauri::command]
pub fn knowledge_read_notes(root: String, paths: Vec<String>) -> KResult<Vec<KnowledgeNote>> {
    let root = vault_root(&root)?;
    paths
        .into_iter()
        .map(|relative| {
            let path = safe_path(&root, &relative)?;
            require_note(&path)?;
            Ok(KnowledgeNote {
                path: relative,
                content: fs::read_to_string(path)?,
            })
        })
        .collect()
}
#[tauri::command]
pub fn knowledge_write_note(
    root: String,
    path: String,
    content: String,
    create_only: bool,
) -> KResult<()> {
    let root = vault_root(&root)?;
    require_note(&safe_path(&root, &path)?)?;
    atomic_write(&root, &path, content.as_bytes(), create_only)
}
fn attachment_path(root: &Path, relative: &str) -> KResult<PathBuf> {
    let path = safe_path(root, relative)?;
    if !relative.starts_with("attachments/") || is_note(&path) {
        return Err(KnowledgeError::new(
            "INVALID_ATTACHMENT",
            "Attachments must be non-markdown files under attachments/",
        ));
    }
    Ok(path)
}
fn read_attachment(root: &Path, relative: &str) -> KResult<Vec<u8>> {
    attachment_path(root, relative)?;
    #[cfg(unix)]
    {
        attachment_fs::read(root, relative)
    }
    #[cfg(windows)]
    {
        attachment_windows::read(root, relative)
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(KnowledgeError::new(
            "IO_ERROR",
            "Confined attachment IO is unavailable on this platform",
        ))
    }
}
#[tauri::command]
pub fn knowledge_read_attachment(root: String, path: String) -> KResult<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(read_attachment(
        &vault_root(&root)?,
        &path,
    )?))
}
#[tauri::command]
pub fn knowledge_write_attachment(
    root: String,
    path: String,
    bytes: Vec<u8>,
    create_only: bool,
) -> KResult<()> {
    let root = vault_root(&root)?;
    attachment_path(&root, &path)?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(KnowledgeError::new(
            "INVALID_ATTACHMENT",
            "Attachment exceeds 512 MiB",
        ));
    }
    #[cfg(unix)]
    {
        attachment_fs::write(&root, &path, &bytes, create_only)
    }
    #[cfg(windows)]
    {
        attachment_windows::write(&root, &path, &bytes, create_only)
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(KnowledgeError::new(
            "IO_ERROR",
            "Confined attachment IO is unavailable on this platform",
        ))
    }
}
#[tauri::command]
pub fn knowledge_remove_attachment(root: String, path: String) -> KResult<String> {
    let root_path = vault_root(&root)?;
    attachment_path(&root_path, &path)?;
    #[cfg(unix)]
    {
        attachment_fs::trash(&root_path, &path)
    }
    #[cfg(windows)]
    {
        attachment_windows::trash(&root_path, &path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(KnowledgeError::new(
            "IO_ERROR",
            "Confined attachment IO is unavailable on this platform",
        ))
    }
}

fn without_md(path: &str) -> &str {
    if path
        .get(path.len().saturating_sub(3)..)
        .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".md"))
    {
        &path[..path.len() - 3]
    } else {
        path
    }
}
fn resolve_wikilink(target: &str, note: &str, entries: &[KnowledgeEntry]) -> Option<String> {
    let target = target.trim();
    let target = target.strip_prefix("./").unwrap_or(target);
    let parent = note.rsplit_once('/').map(|(parent, _)| parent);
    let near = parent.map(|parent| format!("{parent}/{target}"));
    for candidate in [Some(target), near.as_deref()].into_iter().flatten() {
        if let Some(entry) = entries.iter().find(|entry| {
            entry.kind != "folder"
                && (entry.path == candidate || without_md(&entry.path) == without_md(candidate))
        }) {
            return Some(entry.path.clone());
        }
    }
    let mut candidates = entries
        .iter()
        .filter(|entry| entry.kind != "folder" && without_md(&entry.name) == without_md(target));
    let first = candidates.next()?;
    if candidates.next().is_none() {
        Some(first.path.clone())
    } else {
        None
    }
}
fn rewrite_links(
    content: &str,
    note: &str,
    entries: &[KnowledgeEntry],
    moved: &[(String, String)],
) -> String {
    static WIKI: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\[\[([^\]\r\n]+)\]\]").expect("static wikilink regex")
    });
    WIKI.replace_all(content, |captures: &regex::Captures<'_>| {
        let inside = &captures[1];
        let split = inside.find(['#', '|']).unwrap_or(inside.len());
        let target = &inside[..split];
        let resolved = resolve_wikilink(target, note, entries);
        if let Some((_, destination)) = moved
            .iter()
            .find(|(old, _)| Some(old.as_str()) == resolved.as_deref())
        {
            let destination = if target.to_ascii_lowercase().ends_with(".md") {
                destination.as_str()
            } else {
                without_md(destination)
            };
            format!("[[{}{}]]", destination, &inside[split..])
        } else {
            captures[0].to_string()
        }
    })
    .into_owned()
}
#[tauri::command]
pub fn knowledge_rename(root: String, from: String, to: String) -> KResult<()> {
    let root = vault_root(&root)?;
    let source = safe_path(&root, &from)?;
    let destination = safe_path(&root, &to)?;
    if destination.exists() {
        return Err(KnowledgeError::new(
            "ALREADY_EXISTS",
            "Destination already exists",
        ));
    }
    let metadata = fs::metadata(&source)?;
    if metadata.is_file() && is_note(&source) {
        require_note(&destination)?;
    }
    if destination.starts_with(&source) {
        return Err(KnowledgeError::new(
            "UNSAFE_PATH",
            "Cannot move a folder into itself",
        ));
    }
    let entries = tree(&root)?;
    let prefix = format!("{from}/");
    let moved: Vec<(String, String)> = entries
        .iter()
        .filter(|entry| entry.path == from || entry.path.starts_with(&prefix))
        .map(|entry| {
            (
                entry.path.clone(),
                format!("{to}{}", &entry.path[from.len()..]),
            )
        })
        .collect();
    let mut edits = Vec::new();
    for entry in entries.iter().filter(|entry| entry.kind == "note") {
        let content = fs::read_to_string(safe_path(&root, &entry.path)?)?;
        let rewritten = rewrite_links(&content, &entry.path, &entries, &moved);
        if content != rewritten {
            let path = moved
                .iter()
                .find(|(old, _)| old == &entry.path)
                .map(|(_, new)| new.clone())
                .unwrap_or_else(|| entry.path.clone());
            edits.push((path, content, rewritten));
        }
    }
    fs::create_dir_all(
        destination
            .parent()
            .ok_or_else(|| KnowledgeError::new("UNSAFE_PATH", "Missing parent"))?,
    )?;
    safe_path(&root, &to)?;
    fs::rename(&source, &destination)?;
    for (index, (path, _, content)) in edits.iter().enumerate() {
        if let Err(error) = atomic_write(&root, path, content.as_bytes(), false) {
            let mut rollback_failed = false;
            for (path, original, _) in &edits[..index] {
                rollback_failed |= atomic_write(&root, path, original.as_bytes(), false).is_err();
            }
            rollback_failed |= fs::rename(&destination, &source).is_err();
            if rollback_failed {
                return Err(KnowledgeError::new(
                    "PARTIAL_RENAME",
                    format!("Rename rollback incomplete: {}", error.message),
                ));
            }
            return Err(error);
        }
    }
    Ok(())
}
#[tauri::command]
pub fn knowledge_delete(root: String, path: String) -> KResult<String> {
    let root = vault_root(&root)?;
    let source = safe_path(&root, &path)?;
    fs::metadata(&source)?;
    let original = Path::new(&path);
    let stem = original.file_stem().unwrap_or_default().to_string_lossy();
    let extension = original
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default();
    let parent = original.parent().unwrap_or(Path::new(""));
    let mut candidate = path.clone();
    let mut sequence = 2;
    loop {
        let destination = resolve_path(&root, &format!(".trash/{candidate}"), true)?;
        if !destination.exists() {
            fs::create_dir_all(
                destination
                    .parent()
                    .ok_or_else(|| KnowledgeError::new("UNSAFE_PATH", "Missing trash parent"))?,
            )?;
            resolve_path(&root, &format!(".trash/{candidate}"), true)?;
            fs::rename(source, destination)?;
            return Ok(candidate);
        }
        candidate = parent
            .join(format!("{stem} {sequence}{extension}"))
            .to_string_lossy()
            .replace('\\', "/");
        sequence += 1;
    }
}
#[tauri::command]
pub fn knowledge_list_trash(root: String) -> KResult<Vec<KnowledgeEntry>> {
    let root = vault_root(&root)?;
    let trash = resolve_path(&root, ".trash", true)?;
    if !trash.exists() {
        return Ok(Vec::new());
    }
    tree(&trash)
}
fn validate_restore_target(
    trash_relative: &str,
    destination: &str,
    is_directory: bool,
) -> KResult<()> {
    let in_attachments = |path: &str| {
        path.split('/')
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case("attachments"))
    };
    if is_directory {
        if in_attachments(trash_relative) != in_attachments(destination) {
            return Err(KnowledgeError::new(
                "INVALID_ATTACHMENT",
                "Attachment folders must remain under attachments/",
            ));
        }
    } else if is_note(Path::new(trash_relative)) {
        require_note(Path::new(destination))?;
        if in_attachments(destination) {
            return Err(KnowledgeError::new(
                "INVALID_ATTACHMENT",
                "Notes cannot be restored into attachments/",
            ));
        }
    } else if !trash_relative.starts_with("attachments/")
        || !destination.starts_with("attachments/")
        || is_note(Path::new(destination))
    {
        return Err(KnowledgeError::new(
            "INVALID_ATTACHMENT",
            "Attachments must be non-markdown files under attachments/",
        ));
    }
    Ok(())
}
#[tauri::command]
pub fn knowledge_restore(root: String, trash_path: String, destination: String) -> KResult<()> {
    let root = vault_root(&root)?;
    // Validate independently before prefixing: absolute input must not be hidden by ".trash/".
    safe_path(&root, &trash_path)?;
    resolve_path(&root, &format!(".trash/{trash_path}"), true)?;
    safe_path(&root, &destination)?;
    #[cfg(unix)]
    {
        attachment_fs::restore(&root, &trash_path, &destination)
    }
    #[cfg(windows)]
    {
        attachment_windows::restore(&root, &trash_path, &destination)
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(KnowledgeError::new(
            "IO_ERROR",
            "Confined restore is unavailable on this platform",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = knowledge_init_vault(dir.path().to_string_lossy().into_owned()).unwrap();
        (dir, root)
    }
    fn snapshot_vault(root: &Path) -> Vec<(PathBuf, Option<Vec<u8>>)> {
        fn visit(root: &Path, directory: &Path, entries: &mut Vec<(PathBuf, Option<Vec<u8>>)>) {
            for child in fs::read_dir(directory).unwrap() {
                let path = child.unwrap().path();
                let metadata = fs::symlink_metadata(&path).unwrap();
                assert!(!metadata.file_type().is_symlink());
                let content = if metadata.is_dir() {
                    None
                } else {
                    Some(fs::read(&path).unwrap())
                };
                entries.push((path.strip_prefix(root).unwrap().to_path_buf(), content));
                if metadata.is_dir() {
                    visit(root, &path, entries);
                }
            }
        }
        let mut entries = Vec::new();
        visit(root, root, &mut entries);
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        entries
    }
    #[cfg(unix)]
    #[test]
    fn public_commands_reject_authorized_vault_root_ancestor_swap() {
        let mut failures = Vec::new();
        for swap_root in [false, true] {
            for command in [
                "open_vault",
                "list_tree",
                "read_note",
                "read_notes",
                "read_attachment",
                "write_note",
                "write_attachment",
                "rename",
                "delete",
                "list_trash",
                "remove_attachment",
                "restore_note",
                "restore_attachment",
            ] {
                let sandbox = tempfile::tempdir().unwrap();
                let selected = sandbox.path().join("selected");
                let selected_vault = selected.join("vault");
                let root =
                    knowledge_init_vault(selected_vault.to_string_lossy().into_owned()).unwrap();
                let outside = tempfile::tempdir().unwrap();
                let external_vault = if swap_root {
                    outside.path().to_path_buf()
                } else {
                    outside.path().join("vault")
                };
                let external_root =
                    knowledge_init_vault(external_vault.to_string_lossy().into_owned()).unwrap();
                for (fixture, marker) in [(&root, "authorized"), (&external_root, "external")] {
                    knowledge_write_note(fixture.clone(), "Keep.md".into(), marker.into(), true)
                        .unwrap();
                    knowledge_write_attachment(
                        fixture.clone(),
                        "attachments/keep.bin".into(),
                        marker.as_bytes().to_vec(),
                        true,
                    )
                    .unwrap();
                    knowledge_write_note(fixture.clone(), "Restore.md".into(), marker.into(), true)
                        .unwrap();
                    knowledge_delete(fixture.clone(), "Restore.md".into()).unwrap();
                    knowledge_write_attachment(
                        fixture.clone(),
                        "attachments/restore.bin".into(),
                        marker.as_bytes().to_vec(),
                        true,
                    )
                    .unwrap();
                    knowledge_remove_attachment(fixture.clone(), "attachments/restore.bin".into())
                        .unwrap();
                }
                let authorized_before = snapshot_vault(Path::new(&root));
                let external_before = snapshot_vault(Path::new(&external_root));
                let pinned = sandbox.path().join("pinned");
                let substituted = if swap_root { selected_vault } else { selected };
                fs::rename(&substituted, &pinned).unwrap();
                std::os::unix::fs::symlink(outside.path(), substituted).unwrap();
                let result = match command {
                    "open_vault" => knowledge_open_vault(root.clone()).map(|_| ()),
                    "list_tree" => knowledge_list_tree(root.clone()).map(|_| ()),
                    "read_note" => knowledge_read_note(root.clone(), "Keep.md".into()).map(|_| ()),
                    "read_notes" => {
                        knowledge_read_notes(root.clone(), vec!["Keep.md".into()]).map(|_| ())
                    }
                    "read_attachment" => {
                        knowledge_read_attachment(root.clone(), "attachments/keep.bin".into())
                            .map(|_| ())
                    }
                    "write_note" => {
                        knowledge_write_note(root.clone(), "Keep.md".into(), "unsafe".into(), false)
                    }
                    "write_attachment" => knowledge_write_attachment(
                        root.clone(),
                        "attachments/keep.bin".into(),
                        vec![9],
                        false,
                    ),
                    "rename" => knowledge_rename(root.clone(), "Keep.md".into(), "Moved.md".into()),
                    "delete" => knowledge_delete(root.clone(), "Keep.md".into()).map(|_| ()),
                    "list_trash" => knowledge_list_trash(root.clone()).map(|_| ()),
                    "remove_attachment" => {
                        knowledge_remove_attachment(root.clone(), "attachments/keep.bin".into())
                            .map(|_| ())
                    }
                    "restore_note" => {
                        knowledge_restore(root.clone(), "Restore.md".into(), "Restore.md".into())
                    }
                    "restore_attachment" => knowledge_restore(
                        root.clone(),
                        "attachments/restore.bin".into(),
                        "attachments/restore.bin".into(),
                    ),
                    _ => unreachable!(),
                };
                let error = result.err().map(|error| error.code);
                if error != Some("UNSAFE_PATH") {
                    failures.push(format!(
                        "{command}, root swap {swap_root}: expected UNSAFE_PATH, got {error:?}"
                    ));
                }
                let original_vault = if swap_root {
                    pinned
                } else {
                    pinned.join("vault")
                };
                if snapshot_vault(&original_vault) != authorized_before {
                    failures.push(format!(
                        "{command}, root swap {swap_root}: authorized tree changed"
                    ));
                }
                if snapshot_vault(Path::new(&external_root)) != external_before {
                    failures.push(format!(
                        "{command}, root swap {swap_root}: external tree changed"
                    ));
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
    #[cfg(unix)]
    #[test]
    fn explicit_vault_selection_canonicalizes_alias_but_access_rejects_alias() {
        let sandbox = tempfile::tempdir().unwrap();
        let selected = sandbox.path().join("selected");
        let alias = sandbox.path().join("alias");
        fs::create_dir(&selected).unwrap();
        std::os::unix::fs::symlink(&selected, &alias).unwrap();
        let alias_vault = alias.join("vault");
        let root = knowledge_init_vault(alias_vault.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            Path::new(&root),
            fs::canonicalize(selected.join("vault")).unwrap()
        );
        knowledge_write_note(root.clone(), "Keep.md".into(), "authorized".into(), true).unwrap();
        assert_eq!(
            knowledge_read_note(root.clone(), "Keep.md".into()).unwrap(),
            "authorized"
        );
        assert_eq!(knowledge_open_vault(root.clone()).unwrap(), root);
        let before = snapshot_vault(Path::new(&root));
        assert_eq!(
            knowledge_list_tree(alias_vault.to_string_lossy().into_owned())
                .unwrap_err()
                .code,
            "UNSAFE_PATH"
        );
        assert_eq!(
            knowledge_open_vault(alias_vault.to_string_lossy().into_owned())
                .unwrap_err()
                .code,
            "UNSAFE_PATH"
        );
        assert_eq!(snapshot_vault(Path::new(&root)), before);
    }
    #[test]
    fn reopen_existing_canonical_vault_is_read_only_and_idempotent() {
        let (_dir, root) = setup();
        knowledge_write_note(root.clone(), "Legacy.md".into(), "preserved".into(), true).unwrap();
        // A saved vault from before attachment support remains a valid authorization.
        fs::remove_dir(Path::new(&root).join("attachments")).unwrap();
        let before = snapshot_vault(Path::new(&root));
        let modified = fs::metadata(&root).unwrap().modified().unwrap();
        for _ in 0..2 {
            assert_eq!(knowledge_open_vault(root.clone()).unwrap(), root);
            assert_eq!(snapshot_vault(Path::new(&root)), before);
            assert_eq!(fs::metadata(&root).unwrap().modified().unwrap(), modified);
            assert!(!Path::new(&root).join("attachments").exists());
        }
        assert_eq!(
            knowledge_read_note(root, "Legacy.md".into()).unwrap(),
            "preserved"
        );
    }
    #[test]
    fn reopen_missing_vault_never_creates_parents_or_files() {
        let sandbox = tempfile::tempdir().unwrap();
        let directory = fs::canonicalize(sandbox.path()).unwrap();
        let missing = directory.join("missing/vault");
        let before = snapshot_vault(&directory);
        let modified = fs::metadata(&directory).unwrap().modified().unwrap();
        for _ in 0..2 {
            assert_eq!(
                knowledge_open_vault(missing.to_string_lossy().into_owned())
                    .unwrap_err()
                    .code,
                "NOT_FOUND"
            );
            assert!(!directory.join("missing").exists());
            assert_eq!(snapshot_vault(&directory), before);
            assert_eq!(
                fs::metadata(&directory).unwrap().modified().unwrap(),
                modified
            );
        }
        assert_eq!(
            knowledge_open_vault("relative/vault".into())
                .unwrap_err()
                .code,
            "INVALID_VAULT"
        );
    }
    thread_local! {
        static RESTORE_BEFORE_MOVE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    }
    pub(super) fn before_restore_move() {
        let hook = RESTORE_BEFORE_MOVE.with(|slot| slot.borrow_mut().take());
        if let Some(hook) = hook {
            hook();
        }
    }
    fn on_restore_move(hook: impl FnOnce() + 'static) {
        RESTORE_BEFORE_MOVE.with(|slot| {
            assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
        });
    }
    #[test]
    fn restore_transition_collision_preserves_destination_and_trash_source() {
        let (_dir, root) = setup();
        let path = "attachments/nested/restore.bin";
        knowledge_write_attachment(root.clone(), path.into(), vec![1, 2], true).unwrap();
        let receipt = knowledge_remove_attachment(root.clone(), path.into()).unwrap();
        let destination = Path::new(&root).join(path);
        let collision = destination.clone();
        on_restore_move(move || fs::write(collision, [9, 8]).unwrap());
        let result = knowledge_restore(root.clone(), receipt.clone(), path.into());
        assert_eq!(fs::read(destination).unwrap(), vec![9, 8]);
        assert_eq!(result.unwrap_err().code, "ALREADY_EXISTS");
        assert_eq!(
            fs::read(Path::new(&root).join(".trash").join(receipt)).unwrap(),
            vec![1, 2]
        );
    }
    #[test]
    fn restore_transition_note_collision_retains_original_and_competing_note() {
        let (_dir, root) = setup();
        knowledge_write_note(root.clone(), "Note.md".into(), "original".into(), true).unwrap();
        let receipt = knowledge_delete(root.clone(), "Note.md".into()).unwrap();
        let destination = Path::new(&root).join("notes/Restored.md");
        let collision = destination.clone();
        on_restore_move(move || fs::write(collision, "competing").unwrap());
        assert_eq!(
            knowledge_restore(root.clone(), receipt.clone(), "notes/Restored.md".into())
                .unwrap_err()
                .code,
            "ALREADY_EXISTS"
        );
        assert_eq!(fs::read_to_string(destination).unwrap(), "competing");
        assert_eq!(
            fs::read_to_string(Path::new(&root).join(".trash").join(receipt)).unwrap(),
            "original"
        );
    }
    #[test]
    fn restore_transition_directory_collision_retains_trash_source() {
        let (_dir, root) = setup();
        let path = "attachments/nested/restore.bin";
        knowledge_write_attachment(root.clone(), path.into(), vec![1, 2], true).unwrap();
        let receipt = knowledge_remove_attachment(root.clone(), path.into()).unwrap();
        let destination = Path::new(&root).join(path);
        let collision = destination.clone();
        on_restore_move(move || fs::create_dir(collision).unwrap());
        assert!(knowledge_restore(root.clone(), receipt.clone(), path.into()).is_err());
        assert!(destination.is_dir());
        assert_eq!(fs::read_dir(destination).unwrap().count(), 0);
        assert_eq!(
            fs::read(Path::new(&root).join(".trash").join(receipt)).unwrap(),
            vec![1, 2]
        );
    }
    #[cfg(unix)]
    #[test]
    fn restore_transition_destination_symlink_swap_cannot_escape_vault() {
        let (_dir, root) = setup();
        let outside = tempfile::tempdir().unwrap();
        let path = "attachments/checked/restore.bin";
        knowledge_write_attachment(root.clone(), path.into(), vec![1, 2], true).unwrap();
        let receipt = knowledge_remove_attachment(root.clone(), path.into()).unwrap();
        fs::write(outside.path().join("restore.bin"), [42]).unwrap();
        let checked = Path::new(&root).join("attachments/checked");
        let pinned = Path::new(&root).join("attachments/pinned");
        let pinned_for_hook = pinned.clone();
        let external = outside.path().to_path_buf();
        on_restore_move(move || {
            fs::rename(&checked, pinned_for_hook).unwrap();
            std::os::unix::fs::symlink(external, checked).unwrap();
        });
        let result = knowledge_restore(root.clone(), receipt.clone(), path.into());
        assert_eq!(
            fs::read(outside.path().join("restore.bin")).unwrap(),
            vec![42]
        );
        let source = Path::new(&root).join(".trash").join(receipt);
        match result {
            Ok(()) => {
                assert_eq!(fs::read(pinned.join("restore.bin")).unwrap(), vec![1, 2]);
                assert!(!source.exists());
            }
            Err(_) => assert_eq!(fs::read(source).unwrap(), vec![1, 2]),
        }
    }
    #[cfg(unix)]
    #[test]
    fn restore_transition_symlink_destination_collision_retains_trash_source() {
        let (_dir, root) = setup();
        let outside = tempfile::tempdir().unwrap();
        let external = outside.path().join("external.bin");
        fs::write(&external, [42]).unwrap();
        let path = "attachments/restore.bin";
        knowledge_write_attachment(root.clone(), path.into(), vec![1, 2], true).unwrap();
        let receipt = knowledge_remove_attachment(root.clone(), path.into()).unwrap();
        let destination = Path::new(&root).join(path);
        let collision = destination.clone();
        let link_target = external.clone();
        on_restore_move(move || std::os::unix::fs::symlink(link_target, collision).unwrap());
        assert_eq!(
            knowledge_restore(root.clone(), receipt.clone(), path.into())
                .unwrap_err()
                .code,
            "ALREADY_EXISTS"
        );
        assert!(fs::symlink_metadata(destination)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(external).unwrap(), vec![42]);
        assert_eq!(
            fs::read(Path::new(&root).join(".trash").join(receipt)).unwrap(),
            vec![1, 2]
        );
    }
    #[cfg(unix)]
    #[test]
    fn restore_transition_source_parent_swap_uses_pinned_trash() {
        let (_dir, root) = setup();
        let outside = tempfile::tempdir().unwrap();
        let path = "attachments/checked/restore.bin";
        knowledge_write_attachment(root.clone(), path.into(), vec![1, 2], true).unwrap();
        let receipt = knowledge_remove_attachment(root.clone(), path.into()).unwrap();
        fs::write(outside.path().join("restore.bin"), [42]).unwrap();
        let checked = Path::new(&root).join(".trash/attachments/checked");
        let pinned = Path::new(&root).join(".trash/attachments/pinned");
        let pinned_for_hook = pinned.clone();
        let external = outside.path().to_path_buf();
        on_restore_move(move || {
            fs::rename(&checked, pinned_for_hook).unwrap();
            std::os::unix::fs::symlink(external, checked).unwrap();
        });
        knowledge_restore(root.clone(), receipt, path.into()).unwrap();
        assert_eq!(read_attachment(Path::new(&root), path).unwrap(), vec![1, 2]);
        assert_eq!(
            fs::read(outside.path().join("restore.bin")).unwrap(),
            vec![42]
        );
        assert!(!pinned.join("restore.bin").exists());
    }
    #[cfg(unix)]
    #[test]
    fn restore_rejects_symlink_swaps_before_parent_open_and_retains_source() {
        for source_swap in [false, true] {
            let (_dir, root) = setup();
            let outside = tempfile::tempdir().unwrap();
            let path = "attachments/checked/restore.bin";
            knowledge_write_attachment(root.clone(), path.into(), vec![1, 2], true).unwrap();
            let receipt = knowledge_remove_attachment(root.clone(), path.into()).unwrap();
            let canonical = Path::new(&root);
            safe_path(canonical, path).unwrap();
            resolve_path(canonical, &format!(".trash/{receipt}"), true).unwrap();
            let folder = if source_swap {
                canonical.join(".trash/attachments")
            } else {
                canonical.join("attachments")
            };
            let checked = folder.join("checked");
            let pinned = folder.join("pinned");
            fs::rename(&checked, &pinned).unwrap();
            std::os::unix::fs::symlink(outside.path(), checked).unwrap();
            fs::write(outside.path().join("restore.bin"), [42]).unwrap();
            assert_eq!(
                attachment_fs::restore(canonical, &receipt, path)
                    .unwrap_err()
                    .code,
                "UNSAFE_PATH"
            );
            let source = if source_swap {
                pinned.join("restore.bin")
            } else {
                canonical.join(".trash").join(receipt)
            };
            assert_eq!(fs::read(source).unwrap(), vec![1, 2]);
            assert_eq!(
                fs::read(outside.path().join("restore.bin")).unwrap(),
                vec![42]
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn restore_rejects_swapped_vault_root_ancestor() {
        let sandbox = tempfile::tempdir().unwrap();
        let selected = sandbox.path().join("selected");
        let root =
            knowledge_init_vault(selected.join("vault").to_string_lossy().into_owned()).unwrap();
        let path = "attachments/restore.bin";
        knowledge_write_attachment(root.clone(), path.into(), vec![1, 2], true).unwrap();
        let receipt = knowledge_remove_attachment(root.clone(), path.into()).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(outside.path().join("vault/attachments")).unwrap();
        let pinned = sandbox.path().join("pinned");
        fs::rename(&selected, &pinned).unwrap();
        std::os::unix::fs::symlink(outside.path(), selected).unwrap();
        assert_eq!(
            attachment_fs::restore(Path::new(&root), &receipt, path)
                .unwrap_err()
                .code,
            "UNSAFE_PATH"
        );
        assert_eq!(
            fs::read(pinned.join("vault/.trash").join(receipt)).unwrap(),
            vec![1, 2]
        );
        assert!(!outside
            .path()
            .join("vault/attachments/restore.bin")
            .exists());
    }
    #[test]
    fn restore_preserves_note_and_attachment_type_boundaries() {
        let (_dir, root) = setup();
        knowledge_write_note(root.clone(), "Keep.md".into(), "note".into(), true).unwrap();
        let note = knowledge_delete(root.clone(), "Keep.md".into()).unwrap();
        for destination in [
            "attachments/note.bin",
            "attachments/Note.md",
            "Attachments/Note.MD",
            "NotANote.bin",
        ] {
            assert!(
                knowledge_restore(root.clone(), note.clone(), destination.into()).is_err(),
                "{destination}"
            );
            assert_eq!(
                fs::read_to_string(Path::new(&root).join(".trash").join(&note)).unwrap(),
                "note"
            );
            assert!(!Path::new(&root).join(destination).exists());
        }
        knowledge_restore(root.clone(), note, "notes/Restored.md".into()).unwrap();
        assert_eq!(
            knowledge_read_note(root.clone(), "notes/Restored.md".into()).unwrap(),
            "note"
        );
        let attachment = "attachments/Keep.bin";
        knowledge_write_attachment(root.clone(), attachment.into(), vec![1, 2], true).unwrap();
        let receipt = knowledge_remove_attachment(root.clone(), attachment.into()).unwrap();
        for destination in ["Keep.bin", "Keep.md", "attachments/Keep.md"] {
            assert!(
                knowledge_restore(root.clone(), receipt.clone(), destination.into()).is_err(),
                "{destination}"
            );
            assert_eq!(
                fs::read(Path::new(&root).join(".trash").join(&receipt)).unwrap(),
                vec![1, 2]
            );
            assert!(!Path::new(&root).join(destination).exists());
        }
        knowledge_restore(root.clone(), receipt, attachment.into()).unwrap();
    }
    #[test]
    fn restore_folders_preserves_note_and_attachment_namespaces() {
        let (_dir, root) = setup();
        knowledge_write_note(root.clone(), "notes/Note.md".into(), "note".into(), true).unwrap();
        let receipt = knowledge_delete(root.clone(), "notes".into()).unwrap();
        assert!(
            knowledge_restore(root.clone(), receipt.clone(), "attachments/restored".into())
                .is_err()
        );
        assert!(Path::new(&root)
            .join(".trash")
            .join(&receipt)
            .join("Note.md")
            .is_file());
        knowledge_restore(root.clone(), receipt, "restored/notes".into()).unwrap();
        assert_eq!(
            knowledge_read_note(root.clone(), "restored/notes/Note.md".into()).unwrap(),
            "note"
        );
        knowledge_write_attachment(
            root.clone(),
            "attachments/binary/Keep.bin".into(),
            vec![1, 2],
            true,
        )
        .unwrap();
        let receipt = knowledge_delete(root.clone(), "attachments/binary".into()).unwrap();
        assert!(knowledge_restore(root.clone(), receipt.clone(), "binary".into()).is_err());
        assert_eq!(
            fs::read(
                Path::new(&root)
                    .join(".trash")
                    .join(&receipt)
                    .join("Keep.bin")
            )
            .unwrap(),
            vec![1, 2]
        );
        knowledge_restore(root.clone(), receipt, "attachments/restored".into()).unwrap();
        assert_eq!(
            read_attachment(Path::new(&root), "attachments/restored/Keep.bin").unwrap(),
            vec![1, 2]
        );
    }
    #[test]
    fn restore_validation_and_parent_failures_retain_trash_source() {
        let (_dir, root) = setup();
        let path = "attachments/restore.bin";
        knowledge_write_attachment(root.clone(), path.into(), vec![1, 2], true).unwrap();
        let receipt = knowledge_remove_attachment(root.clone(), path.into()).unwrap();
        for invalid in [
            "../escape.bin",
            "/tmp/escape.bin",
            "C:/escape.bin",
            ".trash/restore.bin",
            "attachments/%2e%2e/escape.bin",
            "attachments//escape.bin",
        ] {
            assert_eq!(
                knowledge_restore(root.clone(), invalid.into(), path.into())
                    .unwrap_err()
                    .code,
                "UNSAFE_PATH"
            );
            assert_eq!(
                knowledge_restore(root.clone(), receipt.clone(), invalid.into())
                    .unwrap_err()
                    .code,
                "UNSAFE_PATH"
            );
            assert_eq!(
                fs::read(Path::new(&root).join(".trash").join(&receipt)).unwrap(),
                vec![1, 2]
            );
        }
        fs::write(Path::new(&root).join("attachments/not-a-directory"), [9]).unwrap();
        assert!(knowledge_restore(
            root.clone(),
            receipt.clone(),
            "attachments/not-a-directory/restore.bin".into()
        )
        .is_err());
        assert_eq!(
            fs::read(Path::new(&root).join(".trash").join(receipt)).unwrap(),
            vec![1, 2]
        );
        assert_eq!(
            fs::read(Path::new(&root).join("attachments/not-a-directory")).unwrap(),
            vec![9]
        );
    }
    #[test]
    fn temporary_vault_smoke_roundtrip_reload_attachments() {
        let sandbox = tempfile::tempdir().unwrap();
        let selected = sandbox.path().join("explicit").join("vault");
        let root = knowledge_init_vault(selected.to_string_lossy().into_owned()).unwrap();
        assert_eq!(Path::new(&root), fs::canonicalize(&selected).unwrap());
        let path = "attachments/场景/day/reference.bin";
        let bytes = vec![0, 255, 128, 10, 0, 13];
        knowledge_write_attachment(root.clone(), path.into(), bytes.clone(), true).unwrap();
        let reopened = knowledge_open_vault(root.clone()).unwrap();
        assert_eq!(reopened, root);
        let entries = knowledge_list_tree(reopened.clone()).unwrap();
        let entry = entries.iter().find(|entry| entry.path == path).unwrap();
        assert_eq!(entry.kind, "attachment");
        assert_eq!(entry.size, bytes.len() as u64);
        assert_eq!(read_attachment(Path::new(&reopened), path).unwrap(), bytes);
        assert_eq!(
            knowledge_write_attachment(root.clone(), path.into(), vec![9], true)
                .unwrap_err()
                .code,
            "ALREADY_EXISTS"
        );
        assert_eq!(read_attachment(Path::new(&root), path).unwrap(), bytes);
        let receipt = knowledge_remove_attachment(root.clone(), path.into()).unwrap();
        assert_eq!(receipt, path);
        assert!(!selected.join(path).exists());
        assert_eq!(
            fs::read(selected.join(".trash").join(&receipt)).unwrap(),
            bytes
        );
        assert!(knowledge_list_tree(root.clone())
            .unwrap()
            .iter()
            .all(|entry| !entry.path.starts_with(".trash")));
        knowledge_restore(root.clone(), receipt, path.into()).unwrap();
        assert_eq!(read_attachment(Path::new(&root), path).unwrap(), bytes);
        println!("temporary-vault smoke: canonical reload, nested binary roundtrip, conflict, trash and restore passed");
    }
    #[test]
    fn attachment_boundaries_reject_notes_directories_and_oversized_reads() {
        let (_dir, root) = setup();
        knowledge_write_note(root.clone(), "Keep.md".into(), "# preserved".into(), true).unwrap();
        fs::create_dir_all(Path::new(&root).join("attachments/folder")).unwrap();
        for path in [
            "Keep.md",
            "attachments/folder",
            "attachments",
            "/tmp/outside.bin",
            "attachments/../Keep.md",
        ] {
            assert!(read_attachment(Path::new(&root), path).is_err(), "{path}");
            assert!(
                knowledge_remove_attachment(root.clone(), path.into()).is_err(),
                "{path}"
            );
        }
        assert_eq!(
            knowledge_read_note(root.clone(), "Keep.md".into()).unwrap(),
            "# preserved"
        );
        let oversized =
            fs::File::create(Path::new(&root).join("attachments/oversized.bin")).unwrap();
        oversized.set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();
        // The Windows reader intentionally refuses an existing writer through its
        // share-access boundary; close the fixture before checking the size limit.
        drop(oversized);
        assert_eq!(
            read_attachment(Path::new(&root), "attachments/oversized.bin")
                .unwrap_err()
                .code,
            "INVALID_ATTACHMENT"
        );
        knowledge_write_attachment(root.clone(), "attachments/empty.bin".into(), vec![], true)
            .unwrap();
        assert!(read_attachment(Path::new(&root), "attachments/empty.bin")
            .unwrap()
            .is_empty());
        knowledge_write_attachment(
            root.clone(),
            "attachments/100% reference.bin".into(),
            vec![7],
            true,
        )
        .unwrap();
        assert_eq!(
            read_attachment(Path::new(&root), "attachments/100% reference.bin").unwrap(),
            vec![7]
        );
    }
    #[test]
    fn concurrent_attachment_create_never_clobbers_and_cleans_staging_files() {
        let (_dir, root) = setup();
        let workers: Vec<_> = (0..8)
            .map(|value| {
                let root = root.clone();
                std::thread::spawn(move || {
                    knowledge_write_attachment(
                        root,
                        "attachments/shared.bin".into(),
                        vec![value],
                        true,
                    )
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.code == "ALREADY_EXISTS"));
        assert_eq!(
            read_attachment(Path::new(&root), "attachments/shared.bin")
                .unwrap()
                .len(),
            1
        );
        assert!(fs::read_dir(Path::new(&root).join("attachments"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".knowledge-")));
    }
    #[test]
    fn attachment_trash_conflicts_are_recoverable_without_overwrite() {
        let (_dir, root) = setup();
        let path = "attachments/nested/sample.bin";
        knowledge_write_attachment(root.clone(), path.into(), vec![1], true).unwrap();
        assert_eq!(
            knowledge_remove_attachment(root.clone(), path.into()).unwrap(),
            path
        );
        knowledge_write_attachment(root.clone(), path.into(), vec![2], true).unwrap();
        let second = knowledge_remove_attachment(root.clone(), path.into()).unwrap();
        assert_eq!(second, "attachments/nested/sample 2.bin");
        assert_eq!(
            fs::read(Path::new(&root).join(".trash").join(path)).unwrap(),
            vec![1]
        );
        assert_eq!(
            fs::read(Path::new(&root).join(".trash").join(&second)).unwrap(),
            vec![2]
        );
        knowledge_restore(root.clone(), path.into(), path.into()).unwrap();
        assert_eq!(
            knowledge_restore(root.clone(), second.clone(), path.into())
                .unwrap_err()
                .code,
            "ALREADY_EXISTS"
        );
        assert_eq!(
            fs::read(Path::new(&root).join(".trash").join(second)).unwrap(),
            vec![2]
        );
    }
    #[cfg(unix)]
    #[test]
    fn attachment_operations_reject_symlink_files_ancestors_and_trash() {
        let (_dir, root) = setup();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.bin"), [42]).unwrap();
        let attachments = Path::new(&root).join("attachments");
        std::os::unix::fs::symlink(outside.path(), attachments.join("linked")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.bin"),
            attachments.join("file.bin"),
        )
        .unwrap();
        for path in ["attachments/linked/secret.bin", "attachments/file.bin"] {
            assert_eq!(
                read_attachment(Path::new(&root), path).unwrap_err().code,
                "UNSAFE_PATH"
            );
            assert_eq!(
                knowledge_remove_attachment(root.clone(), path.into())
                    .unwrap_err()
                    .code,
                "UNSAFE_PATH"
            );
            assert_eq!(
                knowledge_write_attachment(root.clone(), path.into(), vec![1], false)
                    .unwrap_err()
                    .code,
                "UNSAFE_PATH"
            );
        }
        assert_eq!(
            knowledge_write_attachment(
                root.clone(),
                "attachments/linked/new.bin".into(),
                vec![1],
                true
            )
            .unwrap_err()
            .code,
            "UNSAFE_PATH"
        );
        assert!(knowledge_list_tree(root.clone())
            .unwrap()
            .iter()
            .all(|entry| !entry.path.contains("linked") && !entry.path.ends_with("file.bin")));
        knowledge_write_attachment(root.clone(), "attachments/keep.bin".into(), vec![3], true)
            .unwrap();
        std::os::unix::fs::symlink(outside.path(), Path::new(&root).join(".trash")).unwrap();
        assert_eq!(
            knowledge_remove_attachment(root.clone(), "attachments/keep.bin".into())
                .unwrap_err()
                .code,
            "UNSAFE_PATH"
        );
        assert_eq!(
            read_attachment(Path::new(&root), "attachments/keep.bin").unwrap(),
            vec![3]
        );
        assert_eq!(
            fs::read(outside.path().join("secret.bin")).unwrap(),
            vec![42]
        );
        assert!(!outside.path().join("new.bin").exists());
    }
    #[cfg(unix)]
    #[test]
    fn descriptor_attachment_io_rechecks_swapped_ancestors() {
        let (_dir, root) = setup();
        let outside = tempfile::tempdir().unwrap();
        let canonical = Path::new(&root);
        let path = "attachments/checked/secret.bin";
        knowledge_write_attachment(root.clone(), path.into(), vec![1], true).unwrap();
        fs::write(outside.path().join("secret.bin"), [42]).unwrap();
        safe_path(canonical, path).unwrap();
        // Emulate the exact validation/use gap: an external process replaces the
        // checked directory before attachment IO opens any parent descriptor.
        fs::rename(
            canonical.join("attachments/checked"),
            canonical.join("attachments/original"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), canonical.join("attachments/checked")).unwrap();
        assert_eq!(
            attachment_fs::read(canonical, path).unwrap_err().code,
            "UNSAFE_PATH"
        );
        assert_eq!(
            attachment_fs::write(canonical, path, &[9], false)
                .unwrap_err()
                .code,
            "UNSAFE_PATH"
        );
        assert_eq!(
            attachment_fs::trash(canonical, path).unwrap_err().code,
            "UNSAFE_PATH"
        );
        assert_eq!(
            fs::read(outside.path().join("secret.bin")).unwrap(),
            vec![42]
        );
        assert_eq!(
            fs::read(canonical.join("attachments/original/secret.bin")).unwrap(),
            vec![1]
        );
    }
    #[test]
    fn rejects_path_escape_and_reserved_metadata() {
        let (_dir, root) = setup();
        let canonical = vault_root(&root).unwrap();
        for path in [
            "../escape.md",
            "/tmp/escape.md",
            "nested/../../escape.md",
            "C:\\escape.md",
            "C:/escape.md",
            ".obsidian/config",
            ".OBSIDIAN/config",
            "nested/.obsidian/config",
            ".trash/note.md",
            "",
        ] {
            assert_eq!(
                safe_path(&canonical, path).unwrap_err().code,
                "UNSAFE_PATH",
                "{path}"
            );
        }
        assert!(safe_path(&canonical, "notes/valid.md").is_ok());
    }
    #[test]
    fn rejects_encoded_and_noncanonical_attachment_paths() {
        let (_dir, root) = setup();
        for path in [
            "attachments/%2e%2e/private.bin",
            "attachments/%252e%252e/private.bin",
            "attachments/a%2fb.bin",
            "attachments/a%5cb.bin",
            "attachments/./a.bin",
            "attachments//a.bin",
            "attachments/.knowledge-staged.bin",
        ] {
            assert_eq!(
                knowledge_write_attachment(root.clone(), path.into(), vec![0, 255], true)
                    .unwrap_err()
                    .code,
                "UNSAFE_PATH",
                "{path}"
            );
        }
        assert!(knowledge_list_tree(root)
            .unwrap()
            .iter()
            .all(|entry| entry.kind == "folder"));
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_even_for_new_destinations() {
        let (_dir, root) = setup();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), Path::new(&root).join("link")).unwrap();
        assert_eq!(
            knowledge_write_note(root.clone(), "link/new.md".into(), "unsafe".into(), false)
                .unwrap_err()
                .code,
            "UNSAFE_PATH"
        );
        assert!(knowledge_list_tree(root)
            .unwrap()
            .iter()
            .all(|entry| !entry.path.starts_with("link")));
        assert!(!outside.path().join("new.md").exists());
    }
    #[test]
    fn rename_rewrites_wikilinks_and_embeds_preserving_suffixes() {
        let (_dir, root) = setup();
        knowledge_write_note(root.clone(), "Old.md".into(), "# old".into(), true).unwrap();
        knowledge_write_note(
            root.clone(),
            "Other.md".into(),
            "[[Old#Heading|label]] ![[Old.md]] [[Missing]]".into(),
            true,
        )
        .unwrap();
        knowledge_rename(root.clone(), "Old.md".into(), "folder/New.md".into()).unwrap();
        assert_eq!(
            knowledge_read_note(root.clone(), "Other.md".into()).unwrap(),
            "[[folder/New#Heading|label]] ![[folder/New.md]] [[Missing]]"
        );
        assert_eq!(
            knowledge_read_note(root, "folder/New.md".into()).unwrap(),
            "# old"
        );
    }
    #[test]
    fn collision_is_non_destructive_and_trash_can_be_restored() {
        let (_dir, root) = setup();
        knowledge_write_note(root.clone(), "Note.md".into(), "original".into(), true).unwrap();
        assert_eq!(
            knowledge_write_note(root.clone(), "Note.md".into(), "overwrite".into(), true)
                .unwrap_err()
                .code,
            "ALREADY_EXISTS"
        );
        let trashed = knowledge_delete(root.clone(), "Note.md".into()).unwrap();
        assert!(knowledge_list_tree(root.clone())
            .unwrap()
            .iter()
            .all(|entry| !entry.path.contains(".trash")));
        assert_eq!(knowledge_list_trash(root.clone()).unwrap().len(), 1);
        knowledge_restore(root.clone(), trashed, "Note.md".into()).unwrap();
        assert_eq!(
            knowledge_read_note(root, "Note.md".into()).unwrap(),
            "original"
        );
    }
    #[test]
    fn trash_collisions_do_not_overwrite_and_restore_refuses_collisions() {
        let (_dir, root) = setup();
        knowledge_write_note(root.clone(), "Note.md".into(), "first".into(), true).unwrap();
        assert_eq!(
            knowledge_delete(root.clone(), "Note.md".into()).unwrap(),
            "Note.md"
        );
        knowledge_write_note(root.clone(), "Note.md".into(), "second".into(), true).unwrap();
        assert_eq!(
            knowledge_delete(root.clone(), "Note.md".into()).unwrap(),
            "Note 2.md"
        );
        knowledge_restore(root.clone(), "Note.md".into(), "Note.md".into()).unwrap();
        assert_eq!(
            knowledge_restore(root.clone(), "Note 2.md".into(), "Note.md".into())
                .unwrap_err()
                .code,
            "ALREADY_EXISTS"
        );
        knowledge_restore(root.clone(), "Note 2.md".into(), "Second.md".into()).unwrap();
        assert_eq!(
            knowledge_read_note(root.clone(), "Note.md".into()).unwrap(),
            "first"
        );
        assert_eq!(
            knowledge_read_note(root, "Second.md".into()).unwrap(),
            "second"
        );
    }
    #[cfg(unix)]
    #[test]
    fn trash_symlinks_cannot_redirect_deletion_outside_vault() {
        let (_dir, root) = setup();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), Path::new(&root).join(".trash")).unwrap();
        knowledge_write_note(root.clone(), "Note.md".into(), "keep".into(), true).unwrap();
        assert_eq!(
            knowledge_delete(root.clone(), "Note.md".into())
                .unwrap_err()
                .code,
            "UNSAFE_PATH"
        );
        assert_eq!(knowledge_read_note(root, "Note.md".into()).unwrap(), "keep");
        assert!(!outside.path().join("Note.md").exists());
    }
}

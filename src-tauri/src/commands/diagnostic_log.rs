#[cfg(not(target_os = "macos"))]
use directories::ProjectDirs;
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_FILES: usize = 7;
const MAX_INPUT_BYTES: u64 = 1024 * 1024;
const MAX_ENTRIES: usize = 250;
const MAX_MESSAGE_BYTES: usize = 4 * 1024;
const MAX_FILTER_CHARS: usize = 200;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogQueryDto {
    pub severity: Option<String>,
    pub source: Option<String>,
    pub query: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogEntryDto {
    pub id: String,
    pub timestamp: Option<String>,
    pub severity: String,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogResultDto {
    pub available: bool,
    pub entries: Vec<DiagnosticLogEntryDto>,
}

pub fn resolve_log_dir() -> Option<PathBuf> {
    log_dir_candidates()
        .into_iter()
        .find_map(|directory| fs::create_dir_all(&directory).ok().map(|_| directory))
}

fn existing_log_dir() -> Option<PathBuf> {
    log_dir_candidates()
        .into_iter()
        .find(|directory| directory.is_dir())
}

fn log_dir_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(home).join("Library/Logs/open-storyboard-canvas"));
    }

    #[cfg(not(target_os = "macos"))]
    if let Some(project_dirs) =
        ProjectDirs::from("com", "StoryboardCopilot", "open-storyboard-canvas")
    {
        #[cfg(target_os = "linux")]
        candidates.push(
            project_dirs
                .state_dir()
                .unwrap_or_else(|| project_dirs.data_local_dir())
                .join("logs"),
        );
        #[cfg(target_os = "windows")]
        candidates.push(project_dirs.data_local_dir().join("logs"));
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        candidates.push(project_dirs.data_local_dir().join("logs"));
    }

    candidates.push(std::env::temp_dir().join("open-storyboard-canvas/logs"));
    candidates
}

fn tracing_filename_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"^storyboard\.log(?:\.\d{4}-\d{2}-\d{2})?$")
            .expect("diagnostic log filename regex is valid")
    })
}

fn tracing_line_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(
            r"^(?P<timestamp>\d{4}-\d{2}-\d{2}T[^\s]+)\s+(?P<severity>TRACE|DEBUG|INFO|WARN|ERROR)\s+(?P<source>[^:\s]+)(?::\s*|\s+)(?P<message>.*)$",
        )
        .expect("diagnostic log line regex is valid")
    })
}

fn replace_all(regex: &Regex, value: String, replacement: &str) -> String {
    regex.replace_all(value.as_str(), replacement).into_owned()
}

fn redact_text(value: &str) -> String {
    static DATA_URL: OnceLock<Regex> = OnceLock::new();
    static LONG_BASE64: OnceLock<Regex> = OnceLock::new();
    static BEARER: OnceLock<Regex> = OnceLock::new();
    static SENSITIVE_VALUE: OnceLock<Regex> = OnceLock::new();
    static BODY_VALUE: OnceLock<Regex> = OnceLock::new();
    static URL_VALUE: OnceLock<Regex> = OnceLock::new();
    static URL_FRAGMENT: OnceLock<Regex> = OnceLock::new();
    static WINDOWS_PATH: OnceLock<Regex> = OnceLock::new();
    static UNC_PATH: OnceLock<Regex> = OnceLock::new();
    static UNIX_PATH: OnceLock<Regex> = OnceLock::new();

    let mut output = replace_all(
        DATA_URL.get_or_init(|| Regex::new(r#"(?i)data:[^\s\"']+"#).expect("valid regex")),
        value.to_string(),
        "[data-url redacted]",
    );
    output = replace_all(
        LONG_BASE64
            .get_or_init(|| Regex::new(r"\b[A-Za-z0-9+/_-]{120,}={0,2}\b").expect("valid regex")),
        output,
        "[base64 redacted]",
    );
    output = replace_all(
        BEARER.get_or_init(|| Regex::new(r#"(?i)(bearer\s+)[^\s,;\"']+"#).expect("valid regex")),
        output,
        "$1[redacted]",
    );
    output = replace_all(
        SENSITIVE_VALUE.get_or_init(|| {
            Regex::new(
                r#"(?i)((?:[\"']?(?:authorization|proxy-authorization|set-cookie|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|signature|sig)[\"']?\s*[=:]\s*[\"']?))([^\s,;&}\]\"']+)([\"']?)"#,
            )
            .expect("valid regex")
        }),
        output,
        "$1[redacted]$3",
    );
    output = replace_all(
        BODY_VALUE.get_or_init(|| {
            Regex::new(r"(?i)((?:request|response)[ _-]?body\s*[=:]\s*).*$").expect("valid regex")
        }),
        output,
        "$1[redacted]",
    );
    output = URL_VALUE
        .get_or_init(|| {
            Regex::new(r#"([?&][A-Za-z0-9_.~-]{1,64}=)[^&#\s\"']*"#).expect("valid regex")
        })
        .replace_all(output.as_str(), |captures: &Captures<'_>| {
            format!("{}[redacted]", &captures[1])
        })
        .into_owned();
    output = replace_all(
        URL_FRAGMENT.get_or_init(|| Regex::new(r#"#[^\s\"']+"#).expect("valid regex")),
        output,
        "#[redacted]",
    );
    output = replace_all(
        WINDOWS_PATH.get_or_init(|| {
            Regex::new(r#"(?i)\b[A-Z]:\\(?:[^\\\s\"']+\\)*[^\s\"']*"#).expect("valid regex")
        }),
        output,
        "[local-path redacted]",
    );
    output = replace_all(
        UNC_PATH.get_or_init(|| Regex::new(r#"\\\\[^\s\"']+"#).expect("valid regex")),
        output,
        "[local-path redacted]",
    );
    replace_all(
        UNIX_PATH.get_or_init(|| {
            Regex::new(r#"(^|[\s\"'(=])/(?:[^/\s\"']+/)+[^\s\"']*"#).expect("valid regex")
        }),
        output,
        "$1[local-path redacted]",
    )
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut boundary = max_bytes.saturating_sub(3);
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    format!("{}...", &value[..boundary])
}

fn normalize_filter(value: Option<String>) -> Option<String> {
    let trimmed = value?
        .trim()
        .chars()
        .take(MAX_FILTER_CHARS)
        .collect::<String>();
    (!trimmed.is_empty()).then(|| trimmed.to_lowercase())
}

fn matches_query(entry: &DiagnosticLogEntryDto, query: &DiagnosticLogQueryDto) -> bool {
    let severity = normalize_filter(query.severity.clone());
    let source = normalize_filter(query.source.clone());
    let search = normalize_filter(query.query.clone());
    severity
        .as_deref()
        .is_none_or(|value| entry.severity.eq_ignore_ascii_case(value))
        && source
            .as_deref()
            .is_none_or(|value| entry.source.to_lowercase().contains(value))
        && search.as_deref().is_none_or(|value| {
            entry.message.to_lowercase().contains(value)
                || entry.source.to_lowercase().contains(value)
        })
}

fn parse_log_text(file_name: &str, text: &str) -> Vec<DiagnosticLogEntryDto> {
    let mut entries = Vec::<DiagnosticLogEntryDto>::new();
    for (line_index, raw_line) in text.lines().enumerate() {
        let line = truncate_utf8(redact_text(raw_line).trim(), MAX_MESSAGE_BYTES);
        if line.is_empty() {
            continue;
        }
        if let Some(captures) = tracing_line_regex().captures(line.as_str()) {
            entries.push(DiagnosticLogEntryDto {
                id: format!("{file_name}:{line_index}"),
                timestamp: captures
                    .name("timestamp")
                    .map(|value| value.as_str().to_string()),
                severity: captures["severity"].to_ascii_lowercase(),
                source: truncate_utf8(&captures["source"], 160),
                message: truncate_utf8(&captures["message"], MAX_MESSAGE_BYTES),
            });
        } else if let Some(previous) = entries.last_mut() {
            let remaining = MAX_MESSAGE_BYTES.saturating_sub(previous.message.len());
            if remaining > 1 {
                previous.message.push('\n');
                previous
                    .message
                    .push_str(&truncate_utf8(line.as_str(), remaining - 1));
            }
        } else {
            entries.push(DiagnosticLogEntryDto {
                id: format!("{file_name}:{line_index}"),
                timestamp: None,
                severity: "info".to_string(),
                source: "application".to_string(),
                message: line,
            });
        }
    }
    entries
}

fn read_diagnostic_logs_from(
    directory: &Path,
    query: DiagnosticLogQueryDto,
) -> Result<DiagnosticLogResultDto, String> {
    if !directory.is_dir() {
        return Ok(DiagnosticLogResultDto {
            available: false,
            entries: Vec::new(),
        });
    }

    let mut files = fs::read_dir(directory)
        .map_err(|_| "Application logs are temporarily unavailable.".to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if !tracing_filename_regex().is_match(file_name.as_str()) {
                return None;
            }
            let metadata = fs::symlink_metadata(entry.path()).ok()?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return None;
            }
            Some((entry.path(), file_name, metadata.modified().ok()))
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| right.1.cmp(&left.1)));
    files.truncate(MAX_FILES);

    let mut remaining_bytes = MAX_INPUT_BYTES;
    let mut entries = Vec::new();
    for (path, file_name, _) in files {
        if remaining_bytes == 0 || entries.len() >= MAX_ENTRIES {
            break;
        }
        let mut file = File::open(&path)
            .map_err(|_| "Application logs are temporarily unavailable.".to_string())?;
        let file_len = file.metadata().map(|value| value.len()).unwrap_or(0);
        let take = file_len.min(remaining_bytes);
        if file_len > take {
            file.seek(SeekFrom::Start(file_len - take))
                .map_err(|_| "Application logs are temporarily unavailable.".to_string())?;
        }
        let mut bytes = Vec::with_capacity(take as usize);
        file.take(take)
            .read_to_end(&mut bytes)
            .map_err(|_| "Application logs are temporarily unavailable.".to_string())?;
        remaining_bytes -= bytes.len() as u64;
        let mut parsed =
            parse_log_text(file_name.as_str(), String::from_utf8_lossy(&bytes).as_ref());
        parsed.reverse();
        entries.extend(
            parsed
                .into_iter()
                .filter(|entry| matches_query(entry, &query)),
        );
        entries.truncate(MAX_ENTRIES);
    }
    entries.truncate(query.limit.unwrap_or(100).clamp(1, MAX_ENTRIES as u32) as usize);
    Ok(DiagnosticLogResultDto {
        available: true,
        entries,
    })
}

#[tauri::command]
pub fn read_diagnostic_logs(
    query: DiagnosticLogQueryDto,
) -> Result<DiagnosticLogResultDto, String> {
    match existing_log_dir() {
        Some(directory) => read_diagnostic_logs_from(directory.as_path(), query),
        None => Ok(DiagnosticLogResultDto {
            available: false,
            entries: Vec::new(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_log(directory: &Path, name: &str, content: &str) {
        let mut file = File::create(directory.join(name)).expect("create fixture");
        file.write_all(content.as_bytes()).expect("write fixture");
    }

    #[test]
    fn diagnostic_log_redacts_sensitive_classes() {
        let long_payload = "A".repeat(180);
        let input = format!(
            "Authorization: Bearer top-secret cookie=session-secret api_key=key-secret token=token-secret \
/Users/person/private/file.png C:\\Users\\person\\private.png \
https://example.com/result.png?signature=signed-value&x=plain#fragment \
data:image/png;base64,{long_payload} request_body={{\"prompt\":\"private\"}} \
json={{\"api_key\":\"json-key-secret\",\"authorization\":\"json-auth-secret\",\"request_body\":\"json-body-secret\"}}"
        );
        let output = redact_text(input.as_str());
        for secret in [
            "top-secret",
            "session-secret",
            "key-secret",
            "token-secret",
            "signed-value",
            "plain",
            "fragment",
            "private/file.png",
            "private.png",
            "private\"",
            "json-key-secret",
            "json-auth-secret",
            "json-body-secret",
        ] {
            assert!(!output.contains(secret), "leaked {secret}: {output}");
        }
        assert!(output.contains("https://example.com/result.png?signature=[redacted]&x=[redacted]"));
        assert!(output.contains("[data-url redacted]"));
        assert!(output.contains("request_body=[redacted]"));
        assert!(output.contains("[local-path redacted]"));
    }

    #[test]
    fn diagnostic_log_allows_only_tracing_files_and_orders_newest_entries() {
        let directory = tempdir().expect("temp dir");
        write_log(
            directory.path(),
            "storyboard.log.2026-08-12",
            "2026-08-12T09:00:00Z INFO old_source: older\n",
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
        write_log(
            directory.path(),
            "storyboard.log.2026-08-13",
            "2026-08-13T09:00:00Z ERROR new_source: newer\ncontinuation\n",
        );
        write_log(
            directory.path(),
            "unrelated.log",
            "2026-08-14T09:00:00Z ERROR leak: must not appear\n",
        );

        let result = read_diagnostic_logs_from(directory.path(), DiagnosticLogQueryDto::default())
            .expect("read logs");
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[0].message, "newer\ncontinuation");
        assert_eq!(result.entries[1].message, "older");
    }

    #[cfg(unix)]
    #[test]
    fn diagnostic_log_rejects_symlinks() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().expect("temp dir");
        let outside = tempdir().expect("outside dir");
        write_log(
            outside.path(),
            "secret.log",
            "2026-08-13T09:00:00Z ERROR secret: outside\n",
        );
        symlink(
            outside.path().join("secret.log"),
            directory.path().join("storyboard.log.2026-08-13"),
        )
        .expect("create symlink");

        let result = read_diagnostic_logs_from(directory.path(), DiagnosticLogQueryDto::default())
            .expect("read logs");
        assert!(result.entries.is_empty());
    }

    #[test]
    fn diagnostic_log_caps_entries_messages_and_filters_after_redaction() {
        let directory = tempdir().expect("temp dir");
        let content = (0..300)
            .map(|index| {
                format!(
                    "2026-08-13T09:00:{:02}Z INFO module: item {index} token=hidden {}\n",
                    index % 60,
                    "x".repeat(MAX_MESSAGE_BYTES + 200)
                )
            })
            .collect::<String>();
        write_log(
            directory.path(),
            "storyboard.log.2026-08-13",
            content.as_str(),
        );

        let result = read_diagnostic_logs_from(
            directory.path(),
            DiagnosticLogQueryDto {
                severity: Some("info".to_string()),
                source: Some("module".to_string()),
                query: Some("hidden".to_string()),
                limit: Some(500),
            },
        )
        .expect("read logs");
        assert!(result.entries.is_empty(), "filter must run after redaction");

        let result = read_diagnostic_logs_from(directory.path(), DiagnosticLogQueryDto::default())
            .expect("read logs");
        assert!(result.entries.len() <= MAX_ENTRIES);
        assert!(result
            .entries
            .iter()
            .all(|entry| entry.message.len() <= MAX_MESSAGE_BYTES));
        assert!(result
            .entries
            .iter()
            .all(|entry| !entry.message.contains("hidden")));
    }
}

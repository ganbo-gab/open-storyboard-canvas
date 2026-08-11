use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

use super::{ExternalAgentCommandError, ExternalAgentToolDefinition, ExternalAgentToolResolution};

pub(crate) const MAX_JSONL_LINE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_PROMPT_BYTES: usize = 64 * 1024;
pub(crate) const MAX_TOOL_SCHEMA_BYTES: usize = 64 * 1024;
pub(crate) const MAX_TOOL_RESULT_BYTES: usize = 256 * 1024;
pub(crate) const MAX_TOOLS: usize = 64;
pub(crate) const MAX_EVENT_TEXT_CHARS: usize = 16_384;
const UTF8_BOM: &[u8] = b"\xef\xbb\xbf";
const UTF16_LE_BOM: &[u8] = b"\xff\xfe";
const UTF16_BE_BOM: &[u8] = b"\xfe\xff";

fn sensitive_assignment_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(
            r#"(?i)((?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|token|secret|cookie|password)\s*[:=]\s*)[\"']?[^\s,\"'}]+"#,
        )
        .expect("static sensitive assignment regex must compile")
    })
}

fn bearer_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{6,}")
            .expect("static bearer regex must compile")
    })
}

fn provider_key_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:sk|sess|key)-[A-Za-z0-9_*.-]{8,}\b")
            .expect("static provider key regex must compile")
    })
}

fn data_url_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)data:[^;,\s]+(?:;[^,\s]+)*,[A-Za-z0-9+/_=-]{16,}")
            .expect("static data URL regex must compile")
    })
}

fn unix_path_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r#"/(?:Users|home|private|tmp|var|Volumes|opt|etc)/[^\s\"'<>\]\[}{,;]+"#)
            .expect("static Unix path regex must compile")
    })
}

fn windows_path_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r#"(?i)\b[A-Z]:\\[^\r\n\t\"'<>|]+"#)
            .expect("static Windows path regex must compile")
    })
}

pub(crate) fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut result: String = value.chars().take(max_chars).collect();
    result.push_str("...[truncated]");
    result
}

pub(crate) fn redact_text(value: &str) -> String {
    let value = data_url_regex().replace_all(value, "[media omitted]");
    let value = bearer_regex().replace_all(&value, "$1[redacted]");
    let value = sensitive_assignment_regex().replace_all(&value, "$1[redacted]");
    let value = provider_key_regex().replace_all(&value, "[credential omitted]");
    let value = unix_path_regex().replace_all(&value, "[local path omitted]");
    let value = windows_path_regex().replace_all(&value, "[local path omitted]");
    truncate_chars(&value, MAX_EVENT_TEXT_CHARS)
}

pub(crate) fn sanitize_json(value: &Value) -> Result<Value, ExternalAgentCommandError> {
    fn visit(value: &Value, depth: usize) -> Result<Value, ExternalAgentCommandError> {
        if depth > 16 {
            return Err(ExternalAgentCommandError::invalid_request(
                "JSON payload nesting exceeds the external Agent limit.",
            ));
        }
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => Ok(value.clone()),
            Value::String(text) => Ok(Value::String(redact_text(text))),
            Value::Array(items) => {
                if items.len() > 256 {
                    return Err(ExternalAgentCommandError::invalid_request(
                        "JSON array exceeds the external Agent limit.",
                    ));
                }
                items
                    .iter()
                    .map(|item| visit(item, depth + 1))
                    .collect::<Result<Vec<_>, _>>()
                    .map(Value::Array)
            }
            Value::Object(entries) => {
                if entries.len() > 256 {
                    return Err(ExternalAgentCommandError::invalid_request(
                        "JSON object exceeds the external Agent limit.",
                    ));
                }
                let mut sanitized = Map::with_capacity(entries.len());
                for (key, item) in entries {
                    let lower = key.to_ascii_lowercase();
                    if [
                        "apikey",
                        "api_key",
                        "authorization",
                        "cookie",
                        "password",
                        "secret",
                        "token",
                        "accesstoken",
                        "refreshtoken",
                    ]
                    .iter()
                    .any(|candidate| lower.contains(candidate))
                    {
                        sanitized.insert(key.clone(), Value::String("[redacted]".to_string()));
                    } else {
                        sanitized.insert(key.clone(), visit(item, depth + 1)?);
                    }
                }
                Ok(Value::Object(sanitized))
            }
        }
    }

    visit(value, 0)
}

pub(crate) fn validate_prompt(prompt: &str) -> Result<String, ExternalAgentCommandError> {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return Err(ExternalAgentCommandError::invalid_request(
            "External Agent prompt cannot be empty.",
        ));
    }
    if trimmed.len() > MAX_PROMPT_BYTES {
        return Err(ExternalAgentCommandError::invalid_request(
            "External Agent prompt exceeds 64 KiB.",
        ));
    }
    Ok(trimmed.to_string())
}

pub(crate) fn validate_tools(
    tools: Vec<ExternalAgentToolDefinition>,
) -> Result<Vec<ExternalAgentToolDefinition>, ExternalAgentCommandError> {
    if tools.len() > MAX_TOOLS {
        return Err(ExternalAgentCommandError::invalid_request(
            "External Agent tool manifest exceeds 64 tools.",
        ));
    }

    let mut names = std::collections::HashSet::new();
    let forbidden = [
        "bash",
        "shell",
        "exec",
        "terminal",
        "filesystem",
        "file_read",
        "file_write",
        "http",
        "network",
        "fetch",
        "secret",
        "credential",
        "keychain",
        "process",
    ];
    for tool in &tools {
        let name = tool.name.trim();
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        {
            return Err(ExternalAgentCommandError::invalid_request(
                "External Agent tool names must use 1-64 ASCII letters, digits, dots, dashes, or underscores.",
            ));
        }
        let lower = name.to_ascii_lowercase();
        if forbidden.iter().any(|fragment| lower.contains(fragment)) {
            return Err(ExternalAgentCommandError::permission_denied(format!(
                "Tool '{name}' is outside the Canvas-only security manifest."
            )));
        }
        if !names.insert(lower) {
            return Err(ExternalAgentCommandError::invalid_request(format!(
                "Duplicate external Agent tool name '{name}'."
            )));
        }
        if tool.description.trim().is_empty() || tool.description.len() > 4_096 {
            return Err(ExternalAgentCommandError::invalid_request(format!(
                "Tool '{name}' has an invalid description."
            )));
        }
        let schema_bytes = serde_json::to_vec(&tool.input_schema).map_err(|_| {
            ExternalAgentCommandError::invalid_request(format!(
                "Tool '{name}' has an invalid input schema."
            ))
        })?;
        if schema_bytes.len() > MAX_TOOL_SCHEMA_BYTES {
            return Err(ExternalAgentCommandError::invalid_request(format!(
                "Tool '{name}' input schema exceeds 64 KiB."
            )));
        }
    }

    Ok(tools)
}

pub(crate) fn validate_tool_resolution(
    resolution: &ExternalAgentToolResolution,
) -> Result<ExternalAgentToolResolution, ExternalAgentCommandError> {
    let mut normalized = resolution.clone();
    if let Some(result) = &resolution.result {
        let bytes = serde_json::to_vec(result).map_err(|_| {
            ExternalAgentCommandError::invalid_request("Tool result is not serializable.")
        })?;
        if bytes.len() > MAX_TOOL_RESULT_BYTES {
            return Err(ExternalAgentCommandError::invalid_request(
                "Tool result exceeds 256 KiB.",
            ));
        }
        normalized.result = Some(sanitize_json(result)?);
    }
    normalized.message = normalized.message.as_deref().map(redact_text);
    normalized.error_code = normalized
        .error_code
        .as_deref()
        .map(|value| truncate_chars(value, 128));
    normalized.receipt_id = normalized
        .receipt_id
        .as_deref()
        .map(|value| truncate_chars(value, 256));
    Ok(normalized)
}

pub(crate) fn mcp_tool_result(resolution: ExternalAgentToolResolution) -> Value {
    let outcome = resolution.outcome.as_str();
    if outcome == "approved" {
        let result = resolution.result.unwrap_or(Value::Null);
        let text = serde_json::to_string(&result)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"serialization_failed\"}".to_string());
        return json!({
            "content": [{"type": "text", "text": text}],
            "structuredContent": {
                "ok": true,
                "result": result,
                "revision": resolution.revision,
                "receiptId": resolution.receipt_id,
            },
            "isError": false,
        });
    }

    let code = resolution.error_code.unwrap_or_else(|| {
        if outcome == "denied" {
            "canvas_tool_denied"
        } else {
            "canvas_tool_failed"
        }
        .to_string()
    });
    let message = resolution.message.unwrap_or_else(|| {
        if outcome == "denied" {
            "The application denied this Canvas operation.".to_string()
        } else {
            "The Canvas operation failed.".to_string()
        }
    });
    let body = json!({
        "ok": false,
        "error": {
            "code": code,
            "message": message,
        },
        "revision": resolution.revision,
        "receiptId": resolution.receipt_id,
    });
    json!({
        "content": [{"type": "text", "text": body.to_string()}],
        "structuredContent": body,
        "isError": true,
    })
}

pub(crate) async fn read_bounded_jsonl_line<R>(
    reader: &mut R,
) -> Result<Option<Vec<u8>>, ExternalAgentCommandError>
where
    R: AsyncBufRead + Unpin,
{
    let mut output = Vec::new();
    loop {
        let available = reader.fill_buf().await.map_err(|error| {
            ExternalAgentCommandError::protocol(format!("Failed to read Agent output: {error}"))
        })?;
        if available.is_empty() {
            return if output.is_empty() {
                Ok(None)
            } else {
                finish_jsonl_record(output).map(Some)
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map(|index| index + 1).unwrap_or(available.len());
        if output.len().saturating_add(consumed) > MAX_JSONL_LINE_BYTES {
            reader.consume(consumed);
            return Err(ExternalAgentCommandError::protocol(
                "External Agent emitted an oversized JSONL record.",
            ));
        }
        output.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if newline.is_some() {
            return finish_jsonl_record(output).map(Some);
        }
    }
}

fn finish_jsonl_record(mut output: Vec<u8>) -> Result<Vec<u8>, ExternalAgentCommandError> {
    while matches!(output.last(), Some(b'\n' | b'\r')) {
        output.pop();
    }
    if output.starts_with(UTF16_LE_BOM) || output.starts_with(UTF16_BE_BOM) {
        return Err(ExternalAgentCommandError::protocol(
            "External Agent output must use UTF-8, not UTF-16.",
        ));
    }
    if output.starts_with(UTF8_BOM) {
        output.drain(..UTF8_BOM.len());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::io::BufReader;

    use super::*;

    #[test]
    fn redacts_credentials_media_and_absolute_paths() {
        let value = redact_text(
            "Authorization: Bearer abcdef123456 token=secret-value sk-1234567890 /Users/alice/private.png C:\\Users\\Alice\\secret.txt data:image/png;base64,AAAAAAAAAAAAAAAAAAAA",
        );
        assert!(!value.contains("abcdef123456"));
        assert!(!value.contains("secret-value"));
        assert!(!value.contains("sk-1234567890"));
        assert!(!value.contains("/Users/alice"));
        assert!(!value.contains("C:\\Users"));
        assert!(!value.contains("AAAAAAAAAAAAAAAAAAAA"));
    }

    #[test]
    fn rejects_permission_expanding_tool_names() {
        let result = validate_tools(vec![ExternalAgentToolDefinition {
            name: "shell.exec".to_string(),
            description: "Run anything".to_string(),
            input_schema: json!({"type": "object"}),
            requires_approval: true,
        }]);
        assert_eq!(result.unwrap_err().code, "permission_denied");
    }

    #[test]
    fn typed_denial_is_an_mcp_error_result() {
        let result = mcp_tool_result(ExternalAgentToolResolution {
            outcome: "denied".to_string(),
            result: None,
            error_code: None,
            message: None,
            revision: Some(9),
            receipt_id: None,
        });
        assert_eq!(result["isError"], true);
        assert_eq!(
            result["structuredContent"]["error"]["code"],
            "canvas_tool_denied"
        );
        assert_eq!(result["structuredContent"]["revision"], 9);
    }

    #[tokio::test]
    async fn bounded_reader_rejects_large_records() {
        let bytes = vec![b'x'; MAX_JSONL_LINE_BYTES + 1];
        let mut reader = BufReader::new(bytes.as_slice());
        let error = read_bounded_jsonl_line(&mut reader).await.unwrap_err();
        assert_eq!(error.code, "protocol_error");
    }

    #[tokio::test]
    async fn jsonl_reader_handles_utf8_bom_crlf_partial_chunks_and_eof_record() {
        let bytes = b"\xef\xbb\xbf{\"path\":\"\xe5\x88\x86\xe9\x95\x9c \xe5\x8a\xa9\xe6\x89\x8b\"}\r\n{\"ok\":true}";
        let mut reader = BufReader::with_capacity(2, bytes.as_slice());

        let first = read_bounded_jsonl_line(&mut reader).await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&first).unwrap(),
            json!({"path": "分镜 助手"})
        );

        let second = read_bounded_jsonl_line(&mut reader).await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&second).unwrap(),
            json!({"ok": true})
        );
        assert!(read_bounded_jsonl_line(&mut reader)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn jsonl_reader_rejects_utf16_bom() {
        let bytes = b"\xff\xfe{\x00}\x00\r\x00\n\x00";
        let mut reader = BufReader::with_capacity(1, bytes.as_slice());
        let error = read_bounded_jsonl_line(&mut reader).await.unwrap_err();
        assert_eq!(error.code, "protocol_error");
        assert!(error.message.contains("UTF-8"));
    }
}

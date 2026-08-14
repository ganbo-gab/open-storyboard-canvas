use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use reqwest::header::CONTENT_TYPE;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestDto {
    pub url: String,
    pub method: String,
    pub headers: Option<HashMap<String, String>>,
    pub body_mode: Option<String>,
    pub body: Option<Value>,
    pub multipart: Option<MultipartBodyDto>,
    pub timeout_ms: Option<u64>,
    pub network_route: Option<String>,
    pub custom_proxy_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartBodyDto {
    pub fields: Option<Vec<MultipartFieldDto>>,
    pub files: Option<Vec<MultipartFileDto>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartFieldDto {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartFileDto {
    pub name: String,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    pub data_url: Option<String>,
    pub base64: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponseDto {
    pub status: u16,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpStreamResponseDto {
    pub status: u16,
    pub text: String,
    pub byte_length: usize,
    pub chunk_count: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HttpStreamEventDto {
    pub stream_id: String,
    pub kind: String,
    pub status: Option<u16>,
    pub chunk: Option<String>,
    pub error: Option<String>,
}

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static DIRECT_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

#[derive(Debug)]
struct SafeHttpRequestSummary {
    method: String,
    host: String,
    path: String,
    model: String,
    stream: bool,
    message_count: usize,
    tool_count: usize,
    body_bytes: usize,
    network_route: String,
}

fn summarize_http_request(request: &HttpRequestDto) -> SafeHttpRequestSummary {
    let parsed_url = reqwest::Url::parse(&request.url).ok();
    let body = request.body.as_ref();
    SafeHttpRequestSummary {
        method: request.method.trim().to_uppercase(),
        host: parsed_url
            .as_ref()
            .and_then(reqwest::Url::host_str)
            .unwrap_or("[invalid-host]")
            .to_string(),
        path: parsed_url
            .as_ref()
            .map(|url| url.path().to_string())
            .unwrap_or_else(|| "[invalid-path]".to_string()),
        model: body
            .and_then(|value| value.get("model"))
            .and_then(Value::as_str)
            .unwrap_or("[unspecified]")
            .chars()
            .take(160)
            .collect(),
        stream: body
            .and_then(|value| value.get("stream"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        message_count: body
            .and_then(|value| value.get("messages"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0),
        tool_count: body
            .and_then(|value| value.get("tools"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0),
        body_bytes: body
            .and_then(|value| serde_json::to_vec(value).ok())
            .map(|value| value.len())
            .unwrap_or(0),
        network_route: request
            .network_route
            .as_deref()
            .unwrap_or("system")
            .trim()
            .to_string(),
    }
}

fn log_http_request(summary: &SafeHttpRequestSummary, transport: &str) {
    info!(
        target: "custom_provider_http",
        transport,
        method = %summary.method,
        host = %summary.host,
        path = %summary.path,
        model = %summary.model,
        stream = summary.stream,
        message_count = summary.message_count,
        tool_count = summary.tool_count,
        body_bytes = summary.body_bytes,
        network_route = %summary.network_route,
        "custom provider request"
    );
}

fn shared_http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn direct_http_client() -> &'static reqwest::Client {
    DIRECT_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

pub(crate) fn validated_custom_proxy(raw_url: &str) -> Result<reqwest::Proxy, String> {
    let parsed = reqwest::Url::parse(raw_url)
        .map_err(|_| "customProxyUrl must be a valid HTTP or HTTPS URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("customProxyUrl must use http:// or https:// and include a host".to_string());
    }
    reqwest::Proxy::all(parsed).map_err(|_| "customProxyUrl could not be configured".to_string())
}

fn client_for_route(
    route: Option<&str>,
    custom_proxy_url: Option<&str>,
) -> Result<reqwest::Client, String> {
    match route.unwrap_or("system").trim() {
        "" | "system" => Ok(shared_http_client().clone()),
        "direct" => Ok(direct_http_client().clone()),
        "custom-proxy" => {
            let raw_url = custom_proxy_url
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "custom-proxy route requires customProxyUrl".to_string())?;
            let proxy = validated_custom_proxy(raw_url)?;
            reqwest::Client::builder()
                .proxy(proxy)
                .pool_idle_timeout(Duration::from_secs(90))
                .tcp_keepalive(Duration::from_secs(60))
                .build()
                .map_err(|err| format!("Failed to build custom proxy client: {err}"))
        }
        other => Err(format!("Unsupported network route: {other}")),
    }
}

fn parse_data_url(value: &str) -> Result<(Vec<u8>, Option<String>), String> {
    let trimmed = value.trim();
    let Some(rest) = trimmed.strip_prefix("data:") else {
        return Err("multipart file dataUrl must start with data:".to_string());
    };
    let Some((metadata, payload)) = rest.split_once(',') else {
        return Err("multipart file dataUrl is missing comma separator".to_string());
    };
    let mime = metadata
        .split(';')
        .next()
        .filter(|item| !item.trim().is_empty())
        .map(|item| item.trim().to_string());
    if !metadata
        .to_ascii_lowercase()
        .split(';')
        .any(|part| part == "base64")
    {
        return Err("multipart file dataUrl must be base64 encoded".to_string());
    }
    let bytes = BASE64_STANDARD
        .decode(payload.trim())
        .map_err(|err| format!("multipart file dataUrl base64 decode failed: {err}"))?;
    Ok((bytes, mime))
}

fn decode_multipart_file(file: &MultipartFileDto) -> Result<(Vec<u8>, Option<String>), String> {
    if let Some(data_url) = file
        .data_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return parse_data_url(data_url);
    }
    if let Some(base64) = file
        .base64
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let bytes = BASE64_STANDARD
            .decode(base64.trim())
            .map_err(|err| format!("multipart file base64 decode failed: {err}"))?;
        return Ok((bytes, file.mime_type.clone()));
    }
    Err("multipart file must include dataUrl or base64".to_string())
}

fn build_multipart_form(body: MultipartBodyDto) -> Result<Form, String> {
    let mut form = Form::new();
    if let Some(fields) = body.fields {
        for field in fields {
            let name = field.name.trim();
            if name.is_empty() {
                continue;
            }
            form = form.text(name.to_string(), field.value);
        }
    }

    if let Some(files) = body.files {
        for (index, file) in files.into_iter().enumerate() {
            let name = file.name.trim();
            if name.is_empty() {
                continue;
            }
            let (bytes, data_url_mime) = decode_multipart_file(&file)?;
            let file_name = file
                .file_name
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| format!("upload-{}.png", index + 1));
            let mime = file.mime_type.clone().or(data_url_mime);
            let mut part = Part::bytes(bytes).file_name(file_name);
            if let Some(mime_type) = mime.filter(|value| !value.trim().is_empty()) {
                part = part
                    .mime_str(mime_type.trim())
                    .map_err(|err| format!("invalid multipart file mime type: {err}"))?;
            }
            form = form.part(name.to_string(), part);
        }
    }

    Ok(form)
}

fn normalize_body_mode(value: Option<&str>) -> String {
    let token = value.unwrap_or("json").trim().to_ascii_lowercase();
    match token.as_str() {
        "json" => "json".to_string(),
        "multipart" | "multipart/form-data" => "multipart".to_string(),
        "form"
        | "urlencoded"
        | "url-encoded"
        | "form-urlencoded"
        | "form-url-encoded"
        | "x-www-form-urlencoded"
        | "application/x-www-form-urlencoded" => "form-urlencoded".to_string(),
        _ if token.contains("x-www-form-urlencoded")
            || token.contains("form-urlencoded")
            || token.contains("form-url-encoded")
            || token.contains("urlencoded") =>
        {
            "form-urlencoded".to_string()
        }
        _ => token,
    }
}

fn form_value_to_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn push_form_pair(parts: &mut Vec<String>, key: &str, value: &Value) {
    let value = form_value_to_string(value);
    parts.push(format!(
        "{}={}",
        urlencoding::encode(key),
        urlencoding::encode(&value)
    ));
}

fn build_form_urlencoded_body(body: Value) -> Result<String, String> {
    let Value::Object(map) = body else {
        return Err("form-urlencoded bodyMode requires JSON object payload".to_string());
    };

    let mut parts = Vec::new();
    for (key, value) in map {
        let key = key.trim();
        if key.is_empty() || value.is_null() {
            continue;
        }
        if let Value::Array(items) = &value {
            for item in items {
                if !item.is_null() {
                    push_form_pair(&mut parts, key, item);
                }
            }
        } else {
            push_form_pair(&mut parts, key, &value);
        }
    }
    Ok(parts.join("&"))
}

fn build_http_request(
    client: &reqwest::Client,
    request: HttpRequestDto,
) -> Result<reqwest::RequestBuilder, String> {
    let method = request.method.trim().to_uppercase();
    let body_mode = normalize_body_mode(request.body_mode.as_deref());
    if body_mode != "json" && body_mode != "multipart" && body_mode != "form-urlencoded" {
        return Err(format!("Unsupported HTTP bodyMode: {body_mode}"));
    }

    let mut builder = match method.as_str() {
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        other => return Err(format!("Unsupported HTTP method: {other}")),
    }
    .timeout(Duration::from_millis(request.timeout_ms.unwrap_or(180_000)));

    if let Some(headers) = request.headers {
        for (key, value) in headers {
            if key.trim().is_empty() {
                continue;
            }
            if (body_mode == "multipart" || body_mode == "form-urlencoded")
                && (key.eq_ignore_ascii_case("content-type")
                    || key.eq_ignore_ascii_case("content-length"))
            {
                continue;
            }
            builder = builder.header(key, value);
        }
    }

    if method == "POST" {
        if body_mode == "multipart" {
            let multipart = request
                .multipart
                .ok_or_else(|| "multipart bodyMode requires multipart payload".to_string())?;
            builder = builder.multipart(build_multipart_form(multipart)?);
        } else if body_mode == "form-urlencoded" {
            let body = request
                .body
                .map(build_form_urlencoded_body)
                .transpose()?
                .unwrap_or_default();
            builder = builder
                .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(body);
        } else if let Some(body) = request.body {
            builder = builder.json(&body);
        }
    }

    Ok(builder)
}

fn emit_stream_event(app: &AppHandle, event: HttpStreamEventDto) {
    let _ = app.emit("custom-http-stream", event);
}

fn take_decodable_utf8(pending: &mut Vec<u8>, flush: bool) -> Option<String> {
    if pending.is_empty() {
        return None;
    }

    match std::str::from_utf8(pending) {
        Ok(text) => {
            let output = text.to_string();
            pending.clear();
            Some(output)
        }
        Err(error) => {
            let valid_up_to = error.valid_up_to();
            if valid_up_to > 0 {
                let output = String::from_utf8_lossy(&pending[..valid_up_to]).to_string();
                pending.drain(..valid_up_to);
                return Some(output);
            }

            if error.error_len().is_none() && !flush {
                return None;
            }

            if flush {
                let output = String::from_utf8_lossy(pending).to_string();
                pending.clear();
                return Some(output);
            }

            let drain_len = error.error_len().unwrap_or(1).min(pending.len());
            let output = String::from_utf8_lossy(&pending[..drain_len]).to_string();
            pending.drain(..drain_len);
            Some(output)
        }
    }
}

#[tauri::command]
pub async fn custom_http_request(request: HttpRequestDto) -> Result<HttpResponseDto, String> {
    let summary = summarize_http_request(&request);
    let started_at = Instant::now();
    log_http_request(&summary, "buffered");
    let client = client_for_route(
        request.network_route.as_deref(),
        request.custom_proxy_url.as_deref(),
    )?;
    let response = build_http_request(&client, request)?
        .send()
        .await
        .map_err(|err| {
            warn!(
                target: "custom_provider_http",
                transport = "buffered",
                host = %summary.host,
                path = %summary.path,
                model = %summary.model,
                elapsed_ms = started_at.elapsed().as_millis(),
                "custom provider request transport failed: {err}"
            );
            format!("HTTP request failed: {err}")
        })?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|err| format!("HTTP response read failed: {err}"))?;

    info!(
        target: "custom_provider_http",
        transport = "buffered",
        host = %summary.host,
        path = %summary.path,
        model = %summary.model,
        status,
        response_bytes = text.len(),
        elapsed_ms = started_at.elapsed().as_millis(),
        "custom provider response"
    );

    Ok(HttpResponseDto { status, text })
}

#[tauri::command]
pub async fn custom_http_stream_request(
    app: AppHandle,
    request: HttpRequestDto,
    stream_id: String,
) -> Result<HttpStreamResponseDto, String> {
    let normalized_stream_id = stream_id.trim().to_string();
    if normalized_stream_id.is_empty() {
        return Err("streamId is required".to_string());
    }

    let summary = summarize_http_request(&request);
    let started_at = Instant::now();
    log_http_request(&summary, "stream");

    let client = client_for_route(
        request.network_route.as_deref(),
        request.custom_proxy_url.as_deref(),
    )?;
    let mut response = build_http_request(&client, request)?
        .send()
        .await
        .map_err(|err| {
            warn!(
                target: "custom_provider_http",
                transport = "stream",
                host = %summary.host,
                path = %summary.path,
                model = %summary.model,
                elapsed_ms = started_at.elapsed().as_millis(),
                "custom provider request transport failed: {err}"
            );
            let message = format!("HTTP request failed: {err}");
            emit_stream_event(
                &app,
                HttpStreamEventDto {
                    stream_id: normalized_stream_id.clone(),
                    kind: "error".to_string(),
                    status: None,
                    chunk: None,
                    error: Some(message.clone()),
                },
            );
            message
        })?;
    let status = response.status().as_u16();

    info!(
        target: "custom_provider_http",
        transport = "stream",
        host = %summary.host,
        path = %summary.path,
        model = %summary.model,
        status,
        elapsed_ms = started_at.elapsed().as_millis(),
        "custom provider response headers"
    );

    emit_stream_event(
        &app,
        HttpStreamEventDto {
            stream_id: normalized_stream_id.clone(),
            kind: "status".to_string(),
            status: Some(status),
            chunk: None,
            error: None,
        },
    );

    let mut error_bytes: Vec<u8> = Vec::new();
    let mut full_bytes: Vec<u8> = Vec::new();
    let mut pending_utf8: Vec<u8> = Vec::new();
    let mut chunk_count = 0usize;
    while let Some(chunk) = response.chunk().await.map_err(|err| {
        let message = format!("HTTP response stream read failed: {err}");
        emit_stream_event(
            &app,
            HttpStreamEventDto {
                stream_id: normalized_stream_id.clone(),
                kind: "error".to_string(),
                status: Some(status),
                chunk: None,
                error: Some(message.clone()),
            },
        );
        message
    })? {
        chunk_count += 1;
        full_bytes.extend_from_slice(&chunk);
        if status < 200 || status >= 300 {
            error_bytes.extend_from_slice(&chunk);
        }
        pending_utf8.extend_from_slice(&chunk);
        if let Some(text) = take_decodable_utf8(&mut pending_utf8, false) {
            emit_stream_event(
                &app,
                HttpStreamEventDto {
                    stream_id: normalized_stream_id.clone(),
                    kind: "chunk".to_string(),
                    status: Some(status),
                    chunk: Some(text),
                    error: None,
                },
            );
        }
    }

    if let Some(text) = take_decodable_utf8(&mut pending_utf8, true) {
        emit_stream_event(
            &app,
            HttpStreamEventDto {
                stream_id: normalized_stream_id.clone(),
                kind: "chunk".to_string(),
                status: Some(status),
                chunk: Some(text),
                error: None,
            },
        );
    }

    if status < 200 || status >= 300 {
        let error_text = String::from_utf8_lossy(&error_bytes).to_string();
        let preview: String = error_text.chars().take(1000).collect();
        let message = format!("HTTP {status}: {preview}");
        warn!(
            target: "custom_provider_http",
            transport = "stream",
            host = %summary.host,
            path = %summary.path,
            model = %summary.model,
            status,
            response_bytes = full_bytes.len(),
            chunk_count,
            elapsed_ms = started_at.elapsed().as_millis(),
            "custom provider stream failed"
        );
        emit_stream_event(
            &app,
            HttpStreamEventDto {
                stream_id: normalized_stream_id.clone(),
                kind: "error".to_string(),
                status: Some(status),
                chunk: None,
                error: Some(message.clone()),
            },
        );
        return Err(message);
    }

    let byte_length = full_bytes.len();
    let text = String::from_utf8_lossy(&full_bytes).to_string();

    info!(
        target: "custom_provider_http",
        transport = "stream",
        host = %summary.host,
        path = %summary.path,
        model = %summary.model,
        status,
        response_bytes = byte_length,
        chunk_count,
        elapsed_ms = started_at.elapsed().as_millis(),
        "custom provider stream completed"
    );

    emit_stream_event(
        &app,
        HttpStreamEventDto {
            stream_id: normalized_stream_id,
            kind: "done".to_string(),
            status: Some(status),
            chunk: None,
            error: None,
        },
    );

    Ok(HttpStreamResponseDto {
        status,
        text,
        byte_length,
        chunk_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagnostic_request() -> HttpRequestDto {
        HttpRequestDto {
            url: "https://example.com/v1/chat/completions?token=secret".to_string(),
            method: "POST".to_string(),
            headers: Some(HashMap::from([(
                "Authorization".to_string(),
                "Bearer secret".to_string(),
            )])),
            body_mode: Some("json".to_string()),
            body: Some(serde_json::json!({
                "model": "grok-4.6",
                "messages": [{"role": "user", "content": "hello"}],
                "tools": [{"type": "function"}],
                "stream": true
            })),
            multipart: None,
            timeout_ms: Some(30_000),
            network_route: Some("system".to_string()),
            custom_proxy_url: None,
        }
    }

    #[test]
    fn route_clients_accept_supported_modes() {
        assert!(client_for_route(Some("system"), None).is_ok());
        assert!(client_for_route(Some("direct"), None).is_ok());
        assert!(client_for_route(Some("custom-proxy"), Some("http://127.0.0.1:7890")).is_ok());
    }

    #[test]
    fn custom_proxy_rejects_missing_or_unsafe_urls() {
        assert!(client_for_route(Some("custom-proxy"), None).is_err());
        assert!(client_for_route(Some("custom-proxy"), Some("socks5://127.0.0.1:7890")).is_err());
        assert!(client_for_route(Some("custom-proxy"), Some("not a url")).is_err());
        assert!(client_for_route(Some("unexpected"), None).is_err());
    }

    #[test]
    fn request_summary_exposes_only_bounded_transport_metadata() {
        let summary = summarize_http_request(&diagnostic_request());
        assert_eq!(summary.method, "POST");
        assert_eq!(summary.host, "example.com");
        assert_eq!(summary.path, "/v1/chat/completions");
        assert_eq!(summary.model, "grok-4.6");
        assert!(summary.stream);
        assert_eq!(summary.message_count, 1);
        assert_eq!(summary.tool_count, 1);
        assert!(summary.body_bytes > 0);
        assert_eq!(summary.network_route, "system");
        let debug = format!("{summary:?}");
        assert!(!debug.contains("Bearer secret"));
        assert!(!debug.contains("token=secret"));
    }
}

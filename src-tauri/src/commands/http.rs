use std::collections::HashMap;
use std::sync::LazyLock;
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
    /// Optional hard byte limit for documentation/configuration reads. Never truncate silently.
    pub max_response_bytes: Option<usize>,
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

static HTTP_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    custom_http_client_builder()
        .build()
        .map_err(|err| format!("Failed to build system HTTP client: {err}"))
});
static DIRECT_HTTP_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    custom_http_client_builder()
        .no_proxy()
        .build()
        .map_err(|err| format!("Failed to build direct HTTP client: {err}"))
});

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

fn custom_http_client_builder() -> reqwest::ClientBuilder {
    // Credential names are provider-defined (including query auth), so all
    // custom HTTP follows only same-origin redirects, for buffered and SSE
    // requests alike. Never rely on reqwest's standard-header stripping.
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let next = attempt.url();
            let same_origin = attempt.previous().first().is_some_and(|original| {
                original.scheme() == next.scheme()
                    && original.host_str() == next.host_str()
                    && original.port_or_known_default() == next.port_or_known_default()
            });
            if !same_origin || !next.username().is_empty() || next.password().is_some() {
                attempt.error("custom HTTP refused a cross-origin or credential-bearing redirect")
            } else if attempt.previous().len() > 10 {
                attempt.error("custom HTTP redirect limit exceeded")
            } else {
                attempt.follow()
            }
        }))
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(60))
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
        "" | "system" => HTTP_CLIENT.as_ref().map(Clone::clone).map_err(Clone::clone),
        "direct" => DIRECT_HTTP_CLIENT
            .as_ref()
            .map(Clone::clone)
            .map_err(Clone::clone),
        "custom-proxy" => {
            let raw_url = custom_proxy_url
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "custom-proxy route requires customProxyUrl".to_string())?;
            let proxy = validated_custom_proxy(raw_url)?;
            custom_http_client_builder()
                .proxy(proxy)
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

fn resolve_http_credentials(
    request: &mut HttpRequestDto,
    resolve: &mut impl FnMut(&super::secrets::SecretRef) -> Result<String, super::secrets::SecretError>,
) -> Result<super::secrets::SecretRedactor, String> {
    let mut redactor = super::secrets::SecretRedactor::default();
    if let std::borrow::Cow::Owned(value) = redactor
        .resolve_markers_using(&request.url, true, resolve)
        .map_err(|error| error.to_string())?
    {
        request.url = value;
    }
    if let Some(headers) = request.headers.as_mut() {
        for value in headers.values_mut() {
            if let std::borrow::Cow::Owned(resolved) = redactor
                .resolve_markers_using(value, false, resolve)
                .map_err(|error| error.to_string())?
            {
                *value = resolved;
            }
        }
    }
    if let Some(body) = request.body.as_mut() {
        redactor
            .resolve_json_using(body, resolve)
            .map_err(|error| error.to_string())?;
    }
    if let Some(fields) = request
        .multipart
        .as_mut()
        .and_then(|body| body.fields.as_mut())
    {
        for field in fields {
            let url = field.value.starts_with("https://") || field.value.starts_with("http://");
            if let std::borrow::Cow::Owned(value) = redactor
                .resolve_markers_using(&field.value, url, resolve)
                .map_err(|error| error.to_string())?
            {
                field.value = value;
            }
        }
    }
    Ok(redactor)
}

fn build_http_request(
    client: &reqwest::Client,
    request: HttpRequestDto,
) -> Result<(reqwest::RequestBuilder, super::secrets::SecretRedactor), String> {
    build_http_request_with_resolver(client, request, &mut super::secrets::resolve_required)
}

fn build_http_request_with_resolver(
    client: &reqwest::Client,
    mut request: HttpRequestDto,
    resolve: &mut impl FnMut(&super::secrets::SecretRef) -> Result<String, super::secrets::SecretError>,
) -> Result<(reqwest::RequestBuilder, super::secrets::SecretRedactor), String> {
    let redactor = resolve_http_credentials(&mut request, resolve)?;
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

    Ok((builder, redactor))
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
    custom_http_request_with_resolver(request, super::secrets::resolve_required).await
}

// The same transport is exercised with an isolated vault in loopback integration tests.
pub(super) async fn custom_http_request_with_resolver(
    request: HttpRequestDto,
    mut resolve: impl FnMut(&super::secrets::SecretRef) -> Result<String, super::secrets::SecretError>,
) -> Result<HttpResponseDto, String> {
    let summary = summarize_http_request(&request);
    let started_at = Instant::now();
    log_http_request(&summary, "buffered");
    let max_response_bytes = request.max_response_bytes;
    let client = client_for_route(
        request.network_route.as_deref(),
        request.custom_proxy_url.as_deref(),
    )?;
    let (builder, redactor) = build_http_request_with_resolver(&client, request, &mut resolve)?;
    let mut response = builder.send().await.map_err(|err| {
        let err = redactor.redact_owned(err.without_url().to_string());
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
    let text = if let Some(limit) = max_response_bytes {
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err(format!("HTTP response exceeds size limit ({limit} bytes)"));
        }
        let mut bytes = Vec::with_capacity(limit.min(8192));
        while let Some(chunk) = response.chunk().await.map_err(|err| {
            redactor.redact_owned(format!("HTTP response read failed: {}", err.without_url()))
        })? {
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err(format!("HTTP response exceeds size limit ({limit} bytes)"));
            }
            bytes.extend_from_slice(&chunk);
        }
        String::from_utf8(bytes).map_err(|_| "HTTP response is not valid UTF-8 text".to_string())?
    } else {
        response.text().await.map_err(|err| {
            redactor.redact_owned(format!("HTTP response read failed: {}", err.without_url()))
        })?
    };
    let text = redactor.redact_owned(text);

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
    let (builder, redactor) = build_http_request(&client, request)?;
    let mut response = builder.send().await.map_err(|err| {
        let err = redactor.redact_owned(err.without_url().to_string());
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
    let mut pending_secrets = String::new();
    let mut chunk_count = 0usize;
    while let Some(chunk) = response.chunk().await.map_err(|err| {
        let message = redactor.redact_owned(format!(
            "HTTP response stream read failed: {}",
            err.without_url()
        ));
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
            let text = redactor.redact_stream(&mut pending_secrets, &text, false);
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

    let tail = take_decodable_utf8(&mut pending_utf8, true).unwrap_or_default();
    let text = redactor.redact_stream(&mut pending_secrets, &tail, true);
    if !text.is_empty() {
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
        let error_text = redactor.redact_owned(String::from_utf8_lossy(&error_bytes).to_string());
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
    let text = redactor.redact_owned(String::from_utf8_lossy(&full_bytes).to_string());

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
    async fn bounded_response_fixture(
        raw_response: &'static [u8],
        limit: usize,
    ) -> Result<HttpResponseDto, String> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request).await;
            // The caller may reject Content-Length before reading the body.
            let _ = stream.write_all(raw_response).await;
        });
        let mut request = diagnostic_request();
        request.url = format!("http://{address}/docs");
        request.method = "GET".into();
        request.headers = None;
        request.body = None;
        request.body_mode = None;
        request.network_route = Some("direct".into());
        request.max_response_bytes = Some(limit);
        let result = custom_http_request(request).await;
        server.await.unwrap();
        result
    }

    #[tokio::test]
    async fn bounded_response_rejects_content_length_before_body() {
        let error = bounded_response_fixture(
            b"HTTP/1.1 200 OK\r\nContent-Length: 9999\r\nConnection: close\r\n\r\n",
            16,
        )
        .await
        .unwrap_err();
        assert!(error.contains("exceeds size limit (16 bytes)"));
    }

    #[tokio::test]
    async fn bounded_response_rejects_stream_overflow_without_silent_truncation() {
        let error = bounded_response_fixture(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n8\r\n12345678\r\n8\r\nabcdefgh\r\n0\r\n\r\n", 12).await.unwrap_err();
        assert!(error.contains("exceeds size limit (12 bytes)"));
    }

    #[tokio::test]
    async fn bounded_response_returns_complete_valid_document() {
        let response = bounded_response_fixture(
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\ndocument",
            8,
        )
        .await
        .unwrap();
        assert_eq!(response.text, "document");
        assert_eq!(response.status, 200);
    }

    async fn read_local_request(stream: &mut tokio::net::TcpStream) -> String {
        use tokio::io::AsyncReadExt;
        let mut request = Vec::new();
        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let mut chunk = [0u8; 1024];
            let count = stream.read(&mut chunk).await.unwrap();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..count]);
        }
        String::from_utf8(request).unwrap()
    }

    async fn assert_cross_origin_redirect_refused(route: &str, credential: &str) {
        use tokio::io::AsyncWriteExt;
        let origin = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin_address = origin.local_addr().unwrap();
        let destination = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination_address = destination.local_addr().unwrap();
        let origin_server = tokio::spawn(async move {
            let (mut stream, _) = origin.accept().await.unwrap();
            let initial_request = read_local_request(&mut stream).await;
            let response = format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{destination_address}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            drop(stream);
            // A proxy sees every redirected request, even when its URL has
            // changed origin. Capture it instead of letting a refusal masquerade
            // as safety because the proxy closed its listening socket.
            let forwarded =
                match tokio::time::timeout(Duration::from_millis(500), origin.accept()).await {
                    Ok(Ok((mut stream, _))) => {
                        let request = read_local_request(&mut stream).await;
                        stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        )
                        .await
                        .unwrap();
                        Some(request)
                    }
                    _ => None,
                };
            (initial_request, forwarded)
        });
        let destination_server = tokio::spawn(async move {
            match tokio::time::timeout(Duration::from_millis(500), destination.accept()).await {
                Ok(Ok((mut stream, _))) => {
                    let request = read_local_request(&mut stream).await;
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        )
                        .await
                        .unwrap();
                    Some(request)
                }
                _ => None,
            }
        });
        let mut request = diagnostic_request();
        request.url = format!("http://{origin_address}/start");
        request.method = "GET".into();
        request.body = None;
        request.headers = match credential {
            "query" => {
                request.url.push_str("?provider_key=local-test-secret");
                None
            }
            "bearer" => Some(HashMap::from([(
                "Authorization".into(),
                "Bearer local-test-secret".into(),
            )])),
            name => Some(HashMap::from([(name.into(), "local-test-secret".into())])),
        };
        request.network_route = Some(route.into());
        request.custom_proxy_url =
            (route == "custom-proxy").then(|| format!("http://{origin_address}"));
        request.timeout_ms = Some(2_000);
        let result = custom_http_request(request).await;
        let (initial, proxy_forwarded) = origin_server.await.unwrap();
        let destination_forwarded = destination_server.await.unwrap();
        assert!(
            initial.contains("local-test-secret"),
            "fixture did not attach {credential}"
        );
        assert!(
            proxy_forwarded.is_none(),
            "{route} forwarded credentials through its proxy: {proxy_forwarded:?}"
        );
        assert!(
            destination_forwarded.is_none(),
            "{route} reached redirected origin: {destination_forwarded:?}"
        );
        assert!(
            result.is_err(),
            "{route} accepted cross-origin redirect with {credential}"
        );
    }

    #[tokio::test]
    async fn custom_http_redirect_refuses_cross_origin_credentials_on_every_route() {
        for route in ["direct", "system", "custom-proxy"] {
            for credential in ["x-api-key", "x-goog-api-key", "bearer", "query"] {
                assert_cross_origin_redirect_refused(route, credential).await;
            }
        }
    }

    #[tokio::test]
    async fn custom_http_redirect_preserves_same_origin_credentials() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_local_request(&mut stream).await;
            stream.write_all(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /same-origin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            drop(stream);
            let (mut stream, _) = listener.accept().await.unwrap();
            let forwarded = read_local_request(&mut stream).await;
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
            forwarded
        });
        let mut request = diagnostic_request();
        request.url = format!("http://{address}/start");
        request.method = "GET".into();
        request.body = None;
        request.headers = Some(HashMap::from([(
            "x-api-key".into(),
            "local-test-secret".into(),
        )]));
        request.network_route = Some("direct".into());
        request.timeout_ms = Some(2_000);
        let response = custom_http_request(request).await.unwrap();
        let forwarded = server.await.unwrap();
        assert!(forwarded.contains("GET /same-origin HTTP/1.1"));
        assert!(forwarded.contains("x-api-key: local-test-secret"));
        assert_eq!(response.status, 200);
        assert_eq!(response.text, "ok");
    }

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
            max_response_bytes: None,
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

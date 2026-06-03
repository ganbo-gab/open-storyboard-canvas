use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use reqwest::header::CONTENT_TYPE;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn shared_http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
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

#[tauri::command]
pub async fn custom_http_request(request: HttpRequestDto) -> Result<HttpResponseDto, String> {
    let method = request.method.trim().to_uppercase();
    let body_mode = normalize_body_mode(request.body_mode.as_deref());
    if body_mode != "json" && body_mode != "multipart" && body_mode != "form-urlencoded" {
        return Err(format!("Unsupported HTTP bodyMode: {body_mode}"));
    }
    let client = shared_http_client();

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
                && key.eq_ignore_ascii_case("content-type")
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

    let response = builder
        .send()
        .await
        .map_err(|err| format!("HTTP request failed: {err}"))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|err| format!("HTTP response read failed: {err}"))?;

    Ok(HttpResponseDto { status, text })
}

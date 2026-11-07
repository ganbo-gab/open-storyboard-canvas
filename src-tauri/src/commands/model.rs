//! Model assets follow image/video storage: immutable, content-addressed files in app_data_dir.
use std::collections::HashMap;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;

use super::image::MediaNetworkRouteDto;

const MAX_MODEL_BYTES: u64 = 100 * 1024 * 1024;

fn model_extension(path: &Path) -> Result<&str, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if extension.eq_ignore_ascii_case("glb") {
        Ok("glb")
    } else if extension.eq_ignore_ascii_case("gltf") {
        Ok("gltf")
    } else {
        Err("仅支持 .glb / .gltf 模型文件。".to_string())
    }
}

// Keep import and download validation identical: a saved asset must not fetch
// additional files when the renderer opens it.
struct EmbeddedModelUri;

impl<'de> serde::de::Visitor<'de> for EmbeddedModelUri {
    type Value = Self;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("an embedded data URI")
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self, E> {
        if value
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
            && value[5..]
                .split_once(',')
                .is_some_and(|(_, data)| !data.is_empty())
        {
            Ok(Self)
        } else {
            Err(E::custom("external or empty model dependency"))
        }
    }
}

#[derive(Deserialize)]
struct GltfAsset {
    version: String,
}

#[derive(Deserialize)]
struct GltfBuffer {
    #[serde(default, deserialize_with = "deserialize_embedded_model_uri")]
    uri: Option<EmbeddedModelUri>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GltfImage {
    #[serde(default, deserialize_with = "deserialize_embedded_model_uri")]
    uri: Option<EmbeddedModelUri>,
    buffer_view: Option<u64>,
}

fn deserialize_embedded_model_uri<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<EmbeddedModelUri>, D::Error> {
    deserializer.deserialize_str(EmbeddedModelUri).map(Some)
}

#[derive(Deserialize)]
struct GltfDocument {
    asset: GltfAsset,
    #[serde(default)]
    buffers: Vec<GltfBuffer>,
    #[serde(default)]
    images: Vec<GltfImage>,
}

fn validate_gltf_document(document: GltfDocument, has_binary_chunk: bool) -> Result<(), String> {
    if document.asset.version != "2.0" {
        return Err("仅支持 glTF 2.0 模型。".to_string());
    }
    if document
        .buffers
        .iter()
        .enumerate()
        .any(|(index, buffer)| buffer.uri.is_none() && !(index == 0 && has_binary_chunk))
        || document
            .images
            .iter()
            .any(|image| image.uri.is_none() && image.buffer_view.is_none())
    {
        return Err("模型依赖必须内嵌在 GLB 或 data URI 中。".to_string());
    }
    Ok(())
}

fn read_gltf_document(reader: impl Read) -> Result<GltfDocument, String> {
    serde_json::from_reader(reader)
        .map_err(|_| "模型 JSON 无效或包含外部 buffer/image URI。".to_string())
}

fn validate_model_reader(
    reader: &mut (impl Read + Seek),
    size: u64,
    extension: &str,
) -> Result<(), String> {
    if size == 0 || size > MAX_MODEL_BYTES {
        return Err("模型文件不能为空，且不能超过 100 MiB。".to_string());
    }
    if extension == "gltf" {
        return validate_gltf_document(read_gltf_document(reader)?, false);
    }
    if extension != "glb" {
        return Err("仅支持 .glb / .gltf 模型文件。".to_string());
    }
    let invalid_glb = || "GLB 文件头或数据块无效；请导出 glTF 2.0 的 GLB 文件。".to_string();
    let mut header = [0; 12];
    reader.read_exact(&mut header).map_err(|_| invalid_glb())?;
    if &header[..4] != b"glTF"
        || u32::from_le_bytes(header[4..8].try_into().unwrap()) != 2
        || u32::from_le_bytes(header[8..12].try_into().unwrap()) as u64 != size
    {
        return Err(invalid_glb());
    }
    let mut position = 12;
    let mut document = None;
    let mut has_binary_chunk = false;
    while position < size {
        if size - position < 8 {
            return Err(invalid_glb());
        }
        let mut chunk_header = [0; 8];
        reader
            .read_exact(&mut chunk_header)
            .map_err(|_| invalid_glb())?;
        let length = u32::from_le_bytes(chunk_header[..4].try_into().unwrap()) as u64;
        let kind = u32::from_le_bytes(chunk_header[4..].try_into().unwrap());
        if length % 4 != 0 || length > size - position - 8 {
            return Err(invalid_glb());
        }
        match kind {
            0x4e4f534a if position == 12 => {
                document = Some(read_gltf_document((&mut *reader).take(length))?);
            }
            0x004e4942 if document.is_some() && !has_binary_chunk => {
                has_binary_chunk = true;
                reader
                    .seek(SeekFrom::Current(length as i64))
                    .map_err(|_| invalid_glb())?;
            }
            0x4e4f534a | 0x004e4942 => return Err(invalid_glb()),
            _ if document.is_some() => {
                reader
                    .seek(SeekFrom::Current(length as i64))
                    .map_err(|_| invalid_glb())?;
            }
            _ => return Err(invalid_glb()),
        }
        position += 8 + length;
    }
    validate_gltf_document(document.ok_or_else(invalid_glb)?, has_binary_chunk)
}

fn validate_model_bytes(bytes: &[u8], extension: &str) -> Result<(), String> {
    validate_model_reader(
        &mut std::io::Cursor::new(bytes),
        bytes.len() as u64,
        extension,
    )
}

/// Rejections cross IPC as `{ code, message }`; neither field contains request
/// URLs, authentication headers, or unredacted reqwest errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelDownloadErrorCode {
    TooLarge,
    InvalidModel,
    Network,
    Canceled,
    Storage,
    Credential,
}

#[derive(Debug, Serialize)]
pub struct ModelDownloadError {
    code: ModelDownloadErrorCode,
    message: String,
}

impl ModelDownloadError {
    fn new(code: ModelDownloadErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn canceled() -> Self {
        Self::new(ModelDownloadErrorCode::Canceled, "Model download canceled")
    }

    fn too_large() -> Self {
        Self::new(
            ModelDownloadErrorCode::TooLarge,
            "Model exceeds the 100 MiB limit",
        )
    }

    fn network(message: &str) -> Self {
        Self::new(ModelDownloadErrorCode::Network, message)
    }

    fn storage() -> Self {
        Self::new(
            ModelDownloadErrorCode::Storage,
            "Unable to save the model asset",
        )
    }

    fn credential(error: super::secrets::SecretError) -> Self {
        Self::new(ModelDownloadErrorCode::Credential, error.to_string())
    }
}

enum ModelDownloadEntry {
    // Preserve a cancellation which arrives before its download IPC starts.
    CanceledBeforeStart,
    Running(Arc<watch::Sender<bool>>),
}

#[derive(Default)]
struct ModelDownloads(Mutex<HashMap<String, ModelDownloadEntry>>);

static MODEL_DOWNLOADS: LazyLock<ModelDownloads> = LazyLock::new(ModelDownloads::default);

struct ModelDownloadRegistration<'a> {
    registry: &'a ModelDownloads,
    request_id: &'a str,
    canceled: Arc<watch::Sender<bool>>,
}

impl ModelDownloads {
    fn start<'a>(
        &'a self,
        request_id: &'a str,
    ) -> Result<ModelDownloadRegistration<'a>, ModelDownloadError> {
        if request_id.trim().is_empty() {
            return Err(ModelDownloadError::network(
                "A nonempty model download requestId is required",
            ));
        }
        let mut requests = self.0.lock().map_err(|_| ModelDownloadError::storage())?;
        match requests.get(request_id) {
            Some(ModelDownloadEntry::CanceledBeforeStart) => {
                requests.remove(request_id);
                return Err(ModelDownloadError::canceled());
            }
            Some(ModelDownloadEntry::Running(_)) => {
                return Err(ModelDownloadError::network(
                    "Model download requestId is already in use",
                ));
            }
            None => {}
        }
        let (sender, _) = watch::channel(false);
        let canceled = Arc::new(sender);
        requests.insert(
            request_id.to_string(),
            ModelDownloadEntry::Running(Arc::clone(&canceled)),
        );
        Ok(ModelDownloadRegistration {
            registry: self,
            request_id,
            canceled,
        })
    }

    fn cancel(&self, request_id: String) -> Result<(), ModelDownloadError> {
        if request_id.trim().is_empty() {
            return Err(ModelDownloadError::network(
                "A nonempty model download requestId is required",
            ));
        }
        let mut requests = self.0.lock().map_err(|_| ModelDownloadError::storage())?;
        match requests.get(&request_id) {
            Some(ModelDownloadEntry::Running(canceled)) => {
                canceled.send_replace(true);
            }
            _ => {
                requests.insert(request_id, ModelDownloadEntry::CanceledBeforeStart);
            }
        }
        Ok(())
    }
}

impl ModelDownloadRegistration<'_> {
    fn publish(
        &self,
        temporary: tempfile::NamedTempFile,
        path: &Path,
    ) -> Result<String, ModelDownloadError> {
        // Serialize only the atomic publication with cancellation, not network
        // reads, hashing, writes, validation, or fsync. Once cancel wins this
        // gate, neither this attempt nor a duplicate can publish a late result.
        let requests = self
            .registry
            .0
            .lock()
            .map_err(|_| ModelDownloadError::storage())?;
        let is_current = matches!(
            requests.get(self.request_id),
            Some(ModelDownloadEntry::Running(signal)) if Arc::ptr_eq(signal, &self.canceled)
        );
        if !is_current || *self.canceled.borrow() {
            return Err(ModelDownloadError::canceled());
        }
        if let Err(error) = temporary.persist_noclobber(path) {
            if error.error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(ModelDownloadError::storage());
            }
        }
        Ok(path.to_string_lossy().into_owned())
    }
}

impl Drop for ModelDownloadRegistration<'_> {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.registry.0.lock() {
            if matches!(
                requests.get(self.request_id),
                Some(ModelDownloadEntry::Running(signal)) if Arc::ptr_eq(signal, &self.canceled)
            ) {
                requests.remove(self.request_id);
            }
        }
    }
}

fn model_download_client(
    network: Option<&MediaNetworkRouteDto>,
) -> Result<reqwest::Client, ModelDownloadError> {
    let mut builder = reqwest::Client::builder()
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(300))
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .no_deflate()
        .redirect(reqwest::redirect::Policy::none());
    match network.map(|value| value.route.trim()).unwrap_or("system") {
        "" | "system" => {}
        "direct" => builder = builder.no_proxy(),
        "custom-proxy" => {
            let raw_url = network
                .and_then(|value| value.custom_proxy_url.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    ModelDownloadError::network("custom-proxy requires customProxyUrl")
                })?;
            let proxy_url = super::secrets::resolve_url_secret_markers(raw_url)
                .map_err(ModelDownloadError::credential)?;
            let proxy = super::http::validated_custom_proxy(&proxy_url).map_err(|_| {
                ModelDownloadError::network("Invalid model download proxy configuration")
            })?;
            // An explicit proxy must not inherit system/environment proxy rules.
            builder = builder.no_proxy().proxy(proxy);
        }
        _ => {
            return Err(ModelDownloadError::network(
                "Unsupported model download network route",
            ))
        }
    }
    builder
        .build()
        .map_err(|_| ModelDownloadError::network("Unable to configure model download route"))
}

fn parse_model_url(raw: &str) -> Result<reqwest::Url, ModelDownloadError> {
    let url = reqwest::Url::parse(raw)
        .map_err(|_| ModelDownloadError::network("Invalid model download URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ModelDownloadError::network(
            "Model URLs require HTTP(S), a host, and no embedded credentials",
        ));
    }
    Ok(url)
}

fn model_ip_is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.octets()[0] == 0
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|ip| model_ip_is_private(IpAddr::V4(ip)))
        }
    }
}

async fn model_url_is_private(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return true;
    }
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return model_ip_is_private(ip);
    }
    // Match image materialization's configured-local-origin policy. A proxy
    // may resolve a remote hostname itself, so local DNS failure is not a
    // reason to switch route or silently use a direct connection.
    tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(80)))
        .await
        .is_ok_and(|mut addresses| addresses.any(|address| model_ip_is_private(address.ip())))
}

fn model_download_headers(
    headers: Option<&HashMap<String, String>>,
) -> Result<reqwest::header::HeaderMap, ModelDownloadError> {
    let mut result = reqwest::header::HeaderMap::new();
    for (name, value) in headers.into_iter().flatten() {
        let name = reqwest::header::HeaderName::from_bytes(name.trim().as_bytes())
            .map_err(|_| ModelDownloadError::network("Invalid model download header name"))?;
        if matches!(
            name.as_str(),
            "host"
                | "content-length"
                | "connection"
                | "transfer-encoding"
                | "proxy-authorization"
                | "proxy-connection"
                | "keep-alive"
                | "te"
                | "trailer"
                | "upgrade"
                | "accept-encoding"
        ) {
            return Err(ModelDownloadError::network(
                "Model download header cannot override transport routing or framing",
            ));
        }
        let resolved = super::secrets::resolve_secret_markers(value)
            .map_err(ModelDownloadError::credential)?;
        let mut value = reqwest::header::HeaderValue::from_str(&resolved)
            .map_err(|_| ModelDownloadError::network("Invalid model download header value"))?;
        value.set_sensitive(true);
        if result.insert(name, value).is_some() {
            return Err(ModelDownloadError::network(
                "Duplicate model download header name",
            ));
        }
    }
    Ok(result)
}

fn sniff_downloaded_model(
    file: std::fs::File,
    size: u64,
    content_type: &str,
) -> Result<&'static str, ModelDownloadError> {
    let mut reader = BufReader::new(file);
    let mut prefix = [0; 4];
    reader.read_exact(&mut prefix).map_err(|_| {
        ModelDownloadError::new(
            ModelDownloadErrorCode::InvalidModel,
            "Model body is empty or truncated",
        )
    })?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| ModelDownloadError::storage())?;
    let extension = if &prefix == b"glTF" { "glb" } else { "gltf" };
    let mime = content_type.split(';').next().unwrap_or("").trim();
    let mime_matches = mime.is_empty()
        || mime.eq_ignore_ascii_case("application/octet-stream")
        || mime.eq_ignore_ascii_case("binary/octet-stream")
        || (extension == "glb" && mime.eq_ignore_ascii_case("model/gltf-binary"))
        || (extension == "gltf"
            && (mime.eq_ignore_ascii_case("model/gltf+json")
                || mime.eq_ignore_ascii_case("application/json")));
    if !mime_matches {
        return Err(ModelDownloadError::new(
            ModelDownloadErrorCode::InvalidModel,
            "Response MIME type does not match a GLB or GLTF model",
        ));
    }
    validate_model_reader(&mut reader, size, extension).map_err(|message| {
        ModelDownloadError::new(ModelDownloadErrorCode::InvalidModel, message)
    })?;
    Ok(extension)
}

async fn download_model_to_directory(
    registry: &ModelDownloads,
    request_id: &str,
    directory: &Path,
    url: &str,
    headers: Option<&HashMap<String, String>>,
    network: Option<&MediaNetworkRouteDto>,
    byte_limit: u64,
) -> Result<String, ModelDownloadError> {
    let registration = registry.start(request_id)?;
    let mut cancellation = registration.canceled.subscribe();
    let operation =
        async {
            let resolved_url = super::secrets::resolve_url_secret_markers(url)
                .map_err(ModelDownloadError::credential)?;
            let url = parse_model_url(&resolved_url)?;
            let configured_origin = network
                .and_then(|value| value.configured_provider_origin.as_deref())
                .map(parse_model_url)
                .transpose()?;
            let same_configured_origin = configured_origin
                .as_ref()
                .is_some_and(|origin| origin.origin() == url.origin());
            if headers.is_some_and(|values| !values.is_empty())
                && configured_origin.is_some()
                && !same_configured_origin
            {
                return Err(ModelDownloadError::network(
                    "Refusing model authentication headers outside the configured provider origin",
                ));
            }
            if model_url_is_private(&url).await && !same_configured_origin {
                return Err(ModelDownloadError::network(
                    "Local model URLs require the matching configured provider origin",
                ));
            }
            let client = model_download_client(network)?;
            let mut response = client
            .get(url)
            .headers(model_download_headers(headers)?)
            .header(
                reqwest::header::ACCEPT,
                "model/gltf-binary, model/gltf+json, application/octet-stream, application/json",
            )
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|_| ModelDownloadError::network("Model download request failed"))?;
            if !response.status().is_success() {
                return Err(ModelDownloadError::network(
                    "Model download returned a non-success status; redirects are not followed",
                ));
            }
            let byte_limit = byte_limit.min(MAX_MODEL_BYTES);
            if response
                .content_length()
                .is_some_and(|size| size > byte_limit)
            {
                return Err(ModelDownloadError::too_large());
            }
            if response
                .headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .is_some_and(|value| !value.as_bytes().eq_ignore_ascii_case(b"identity"))
            {
                return Err(ModelDownloadError::new(
                    ModelDownloadErrorCode::InvalidModel,
                    "Compressed model responses are not supported",
                ));
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .map(|value| value.to_str().map(str::to_owned))
                .transpose()
                .map_err(|_| {
                    ModelDownloadError::new(
                        ModelDownloadErrorCode::InvalidModel,
                        "Invalid model response MIME type",
                    )
                })?
                .unwrap_or_default();
            tokio::fs::create_dir_all(directory)
                .await
                .map_err(|_| ModelDownloadError::storage())?;
            let temporary = tempfile::NamedTempFile::new_in(directory)
                .map_err(|_| ModelDownloadError::storage())?;
            let mut file = tokio::fs::File::from_std(
                temporary
                    .reopen()
                    .map_err(|_| ModelDownloadError::storage())?,
            );
            let mut size = 0u64;
            let mut digest = Sha256::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| {
                ModelDownloadError::network("Unable to read the model download body")
            })? {
                if chunk.len() as u64 > byte_limit - size {
                    return Err(ModelDownloadError::too_large());
                }
                size += chunk.len() as u64;
                digest.update(&chunk);
                file.write_all(&chunk)
                    .await
                    .map_err(|_| ModelDownloadError::storage())?;
            }
            file.flush()
                .await
                .map_err(|_| ModelDownloadError::storage())?;
            file.sync_all()
                .await
                .map_err(|_| ModelDownloadError::storage())?;
            drop(file);
            let validation_file = temporary
                .reopen()
                .map_err(|_| ModelDownloadError::storage())?;
            let extension = tokio::task::spawn_blocking(move || {
                sniff_downloaded_model(validation_file, size, &content_type)
            })
            .await
            .map_err(|_| ModelDownloadError::storage())??;
            let path = directory.join(format!("{:x}.{extension}", digest.finalize()));
            registration.publish(temporary, &path)
        };
    tokio::select! {
        biased;
        _ = cancellation.wait_for(|canceled| *canceled) => Err(ModelDownloadError::canceled()),
        result = operation => result,
    }
}

/// `requestId` identifies one download attempt. Callers must not reuse it for a
/// different attempt; duplicate active IDs are rejected, never replaced.
#[tauri::command]
pub async fn download_model_asset(
    app: AppHandle,
    request_id: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    network: Option<MediaNetworkRouteDto>,
) -> Result<String, ModelDownloadError> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| ModelDownloadError::storage())?
        .join("models");
    download_model_to_directory(
        &MODEL_DOWNLOADS,
        &request_id,
        &directory,
        &url,
        headers.as_ref(),
        network.as_ref(),
        MAX_MODEL_BYTES,
    )
    .await
}

#[tauri::command]
pub fn cancel_model_download(request_id: String) -> Result<(), ModelDownloadError> {
    MODEL_DOWNLOADS.cancel(request_id)
}

#[tauri::command]
pub fn read_model_file(path: String) -> Result<Response, String> {
    let path = PathBuf::from(path);
    let extension = model_extension(&path)?;
    let file = std::fs::File::open(&path).map_err(|error| format!("无法读取模型文件：{error}"))?;
    let size = file
        .metadata()
        .map_err(|error| format!("无法读取模型大小：{error}"))?
        .len();
    if size == 0 || size > MAX_MODEL_BYTES {
        return Err("模型文件不能为空，且不能超过 100 MiB。".to_string());
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(MAX_MODEL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取模型文件：{error}"))?;
    validate_model_bytes(&bytes, extension)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn persist_model_binary(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let extension = match request
        .headers()
        .get("x-model-extension")
        .and_then(|value| value.to_str().ok())
    {
        Some("glb") => "glb",
        Some("gltf") => "gltf",
        _ => return Err("仅支持 .glb / .gltf 模型文件。".to_string()),
    };
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        _ => return Err("模型导入需要二进制传输。".to_string()),
    };
    validate_model_bytes(bytes, extension)?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join("models");
    std::fs::create_dir_all(&directory).map_err(|error| format!("无法创建模型目录：{error}"))?;
    let path = directory.join(format!("{:x}.{extension}", Sha256::digest(bytes)));
    if !path.exists() {
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)
            .map_err(|error| format!("无法创建模型文件：{error}"))?;
        temporary
            .write_all(bytes)
            .map_err(|error| format!("无法保存模型：{error}"))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| format!("无法持久保存模型：{error}"))?;
        if let Err(error) = temporary.persist_noclobber(&path) {
            if error.error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(format!("无法保存模型：{}", error.error));
            }
        }
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::oneshot;
    use tokio::task::JoinHandle;
    use tokio::time::timeout;

    const TEST_TIMEOUT: Duration = Duration::from_secs(5);
    const MINIMAL_GLTF: &[u8] = br#"{"asset":{"version":"2.0"}}"#;

    #[test]
    fn model_credential_failures_preserve_the_safe_vault_error_for_reauthorization() {
        let error = ModelDownloadError::credential(super::super::secrets::SecretError {
            state: super::super::secrets::SecretErrorState::Locked,
            code: "storage_locked",
        });
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({
                "code": "credential", "message": "{\"state\":\"locked\",\"code\":\"storage_locked\"}"
            })
        );
    }

    struct ModelHttpFixture {
        url: String,
        requests: Arc<Mutex<Vec<String>>>,
        task: JoinHandle<()>,
    }

    impl Drop for ModelHttpFixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn read_http_request(stream: &mut TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let size = stream.read(&mut buffer).await.unwrap();
            assert_ne!(size, 0, "client closed before sending its request");
            request.extend_from_slice(&buffer[..size]);
            assert!(request.len() <= 32 * 1024);
        }
        String::from_utf8(request).unwrap()
    }

    async fn model_http_fixture(response: Vec<u8>) -> ModelHttpFixture {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let server_requests = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut stream).await;
                server_requests.lock().unwrap().push(request);
                let _ = stream.write_all(&response).await;
                let _ = stream.shutdown().await;
            }
        });
        ModelHttpFixture {
            url,
            requests,
            task,
        }
    }

    fn model_http_response(mime: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: {mime}\r\nContent-Length: {}\r\n\r\n",
            body.len()
        ).into_bytes();
        response.extend_from_slice(body);
        response
    }

    fn direct_model_route(url: &str) -> MediaNetworkRouteDto {
        MediaNetworkRouteDto {
            route: "direct".to_string(),
            custom_proxy_url: None,
            configured_provider_origin: Some(url.to_string()),
        }
    }

    fn minimal_glb(json: &[u8], binary: Option<&[u8]>) -> Vec<u8> {
        let json_length = (json.len() + 3) & !3;
        let binary_length = binary.map(|bytes| (bytes.len() + 3) & !3);
        let length = 20 + json_length + binary_length.map_or(0, |length| 8 + length);
        let mut bytes = Vec::with_capacity(length);
        bytes.extend_from_slice(b"glTF");
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&(length as u32).to_le_bytes());
        bytes.extend_from_slice(&(json_length as u32).to_le_bytes());
        bytes.extend_from_slice(&0x4e4f534au32.to_le_bytes());
        bytes.extend_from_slice(json);
        bytes.resize(20 + json_length, b' ');
        if let (Some(binary), Some(binary_length)) = (binary, binary_length) {
            bytes.extend_from_slice(&(binary_length as u32).to_le_bytes());
            bytes.extend_from_slice(&0x004e4942u32.to_le_bytes());
            bytes.extend_from_slice(binary);
            bytes.resize(length, 0);
        }
        bytes
    }

    fn assert_no_model_files(directory: &Path) {
        assert_eq!(std::fs::read_dir(directory).unwrap().count(), 0);
    }

    #[test]
    fn rejects_wrong_magic_and_unsupported_paths() {
        assert!(validate_model_bytes(&[0; 20], "glb").is_err());
        assert!(model_extension(Path::new("secret.txt")).is_err());
        assert_eq!(model_extension(Path::new("模型.GLB")).unwrap(), "glb");
        assert!(validate_model_bytes(MINIMAL_GLTF, "gltf").is_ok());
        assert!(validate_model_bytes(br#"{"asset":{"version":"1.0"}}"#, "gltf").is_err());
    }

    #[test]
    fn model_download_validation_allows_embedded_dependencies_only() {
        let embedded = br#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":3,"uri":"data:application/octet-stream;base64,AAAA"}],"images":[{"uri":"data:image/png;base64,AAAA"}]}"#;
        assert!(validate_model_bytes(embedded, "gltf").is_ok());
        // JSON escapes cannot disguise an external scheme; valid escaped data
        // URIs still work without retaining their payload in the document DTO.
        assert!(validate_model_bytes(
            br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"\u0064ata:application/octet-stream;base64,AAAA"}]}"#,
            "gltf"
        ).is_ok());
        for json in [
            br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"mesh.bin"}]}"#.as_slice(),
            br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"https://example.invalid/mesh.bin"}]}"#,
            br#"{"asset":{"version":"2.0"},"images":[{"uri":"file:///secret.png"}]}"#,
            br#"{"asset":{"version":"2.0"},"images":[{"uri":"\u0068ttps://example.invalid/texture.png"}]}"#,
            br#"{"asset":{"version":"2.0"},"buffers":[{}]}"#,
            br#"{"asset":{"version":"2.0"},"images":[{}]}"#,
        ] {
            assert!(validate_model_bytes(json, "gltf").is_err());
        }
        let binary_document = br#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":4}],"bufferViews":[{"buffer":0,"byteLength":4}],"images":[{"bufferView":0,"mimeType":"image/png"}]}"#;
        assert!(validate_model_bytes(&minimal_glb(binary_document, Some(&[0; 4])), "glb").is_ok());
        assert!(validate_model_bytes(&minimal_glb(binary_document, None), "glb").is_err());
        let external_glb = minimal_glb(
            br#"{"asset":{"version":"2.0"},"images":[{"uri":"texture.png"}]}"#,
            None,
        );
        assert!(validate_model_bytes(&external_glb, "glb").is_err());
        let mut broken_chunk = minimal_glb(MINIMAL_GLTF, None);
        broken_chunk[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(validate_model_bytes(&broken_chunk, "glb").is_err());
    }

    #[tokio::test]
    async fn model_download_mock_success_authenticates_and_deduplicates() {
        let bytes = minimal_glb(MINIMAL_GLTF, None);
        let server =
            model_http_fixture(model_http_response("application/octet-stream", &bytes)).await;
        let directory = tempfile::tempdir().unwrap();
        let registry = ModelDownloads::default();
        let network = direct_model_route(&server.url);
        let headers = HashMap::from([
            (
                "Authorization".to_string(),
                "Bearer local-test-only".to_string(),
            ),
            ("X-Api-Key".to_string(), "local-fixture-key".to_string()),
        ]);
        let expected = directory
            .path()
            .join(format!("{:x}.glb", Sha256::digest(&bytes)));
        for request_id in ["mock-success-1", "mock-success-2"] {
            let path = download_model_to_directory(
                &registry,
                request_id,
                directory.path(),
                &format!("{}/not-a-model-extension", server.url),
                Some(&headers),
                Some(&network),
                MAX_MODEL_BYTES,
            )
            .await
            .unwrap();
            assert_eq!(Path::new(&path), expected.as_path());
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        for request in requests.iter() {
            let request = request.to_ascii_lowercase();
            assert!(request.contains("authorization: bearer local-test-only\r\n"));
            assert!(request.contains("x-api-key: local-fixture-key\r\n"));
            assert!(request.contains("accept-encoding: identity\r\n"));
        }
    }

    #[tokio::test]
    async fn model_download_mock_gltf_accepts_embedded_and_rejects_external() {
        for (body, accepted) in [
            (br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"data:application/octet-stream;base64,AAAA"}]}"#.as_slice(), true),
            (br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"mesh.bin"}]}"#.as_slice(), false),
            (br#"{"asset":{"version":"2.0"},"images":[{"uri":"https://example.invalid/image.png"}]}"#.as_slice(), false),
        ] {
            let server = model_http_fixture(model_http_response("model/gltf+json; charset=utf-8", body)).await;
            let directory = tempfile::tempdir().unwrap();
            let registry = ModelDownloads::default();
            let network = direct_model_route(&server.url);
            let result = download_model_to_directory(
                &registry, "mock-gltf", directory.path(), &server.url, None, Some(&network), MAX_MODEL_BYTES
            ).await;
            if accepted {
                let path = result.unwrap();
                assert!(path.ends_with(".gltf"));
                assert_eq!(std::fs::read(path).unwrap(), body);
            } else {
                assert_eq!(result.unwrap_err().code, ModelDownloadErrorCode::InvalidModel);
                assert_no_model_files(directory.path());
            }
        }
    }

    #[tokio::test]
    async fn model_download_rejects_declared_hard_cap_before_reading() {
        assert_eq!(MAX_MODEL_BYTES, 104_857_600);
        // No body is sent. A reader which ignores Content-Length would report
        // a network/truncation error instead of the required too_large code.
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: model/gltf-binary\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_MODEL_BYTES + 1
        ).into_bytes();
        let server = model_http_fixture(response).await;
        let directory = tempfile::tempdir().unwrap();
        let registry = ModelDownloads::default();
        let network = direct_model_route(&server.url);
        let error = download_model_to_directory(
            &registry,
            "declared-cap",
            directory.path(),
            &server.url,
            None,
            Some(&network),
            u64::MAX,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ModelDownloadErrorCode::TooLarge);
        assert_no_model_files(directory.path());
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({"code": "too_large", "message": "Model exceeds the 100 MiB limit"})
        );
    }

    #[tokio::test]
    async fn model_download_rejects_streaming_over_cap_and_removes_partial_file() {
        // Exercise the same accumulated-byte branch with a small deterministic
        // limit rather than writing 100 MiB on every native unit-test run.
        let response = b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n20\r\n12345678901234567890123456789012\r\n21\r\n123456789012345678901234567890123\r\n0\r\n\r\n".to_vec();
        let server = model_http_fixture(response).await;
        let directory = tempfile::tempdir().unwrap();
        let registry = ModelDownloads::default();
        let network = direct_model_route(&server.url);
        let error = download_model_to_directory(
            &registry,
            "streaming-cap",
            directory.path(),
            &server.url,
            None,
            Some(&network),
            64,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ModelDownloadErrorCode::TooLarge);
        assert_no_model_files(directory.path());
    }

    #[tokio::test]
    async fn model_download_rejects_bad_magic_mime_and_truncation_without_artifacts() {
        let valid_glb = minimal_glb(MINIMAL_GLTF, None);
        for (mime, body) in [
            ("model/gltf-binary", b"not a binary model".as_slice()),
            ("model/gltf-binary", MINIMAL_GLTF),
            ("application/json", valid_glb.as_slice()),
            (
                "text/html",
                b"<!doctype html><title>authentication required</title>".as_slice(),
            ),
            ("application/octet-stream", b"".as_slice()),
        ] {
            let server = model_http_fixture(model_http_response(mime, body)).await;
            let directory = tempfile::tempdir().unwrap();
            let registry = ModelDownloads::default();
            let network = direct_model_route(&server.url);
            let error = download_model_to_directory(
                &registry,
                "bad-model",
                directory.path(),
                &server.url,
                None,
                Some(&network),
                MAX_MODEL_BYTES,
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, ModelDownloadErrorCode::InvalidModel);
            assert_no_model_files(directory.path());
        }
    }

    #[tokio::test]
    async fn model_download_rejects_redirects_without_forwarding_credentials() {
        let target = model_http_fixture(model_http_response("model/gltf+json", MINIMAL_GLTF)).await;
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: {}/model\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            target.url
        ).into_bytes();
        let source = model_http_fixture(response).await;
        let network = direct_model_route(&source.url);
        let headers =
            HashMap::from([("X-Vendor-Secret".to_string(), "fixture-secret".to_string())]);
        let directory = tempfile::tempdir().unwrap();
        let registry = ModelDownloads::default();
        let error = download_model_to_directory(
            &registry,
            "redirect",
            directory.path(),
            &source.url,
            Some(&headers),
            Some(&network),
            MAX_MODEL_BYTES,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ModelDownloadErrorCode::Network);
        assert_eq!(source.requests.lock().unwrap().len(), 1);
        assert_eq!(target.requests.lock().unwrap().len(), 0);
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("fixture-secret"));
        assert_no_model_files(directory.path());
    }

    #[tokio::test]
    async fn model_download_route_and_auth_fail_closed_without_direct_fallback() {
        let target = model_http_fixture(model_http_response("model/gltf+json", MINIMAL_GLTF)).await;
        let proxy = model_http_fixture(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_vec(),
        )
        .await;
        let registry = ModelDownloads::default();
        let directory = tempfile::tempdir().unwrap();
        let mut network = direct_model_route(&target.url);
        network.route = "custom-proxy".to_string();
        network.custom_proxy_url = Some(proxy.url.clone());
        let error = download_model_to_directory(
            &registry,
            "proxy-no-fallback",
            directory.path(),
            &target.url,
            None,
            Some(&network),
            MAX_MODEL_BYTES,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ModelDownloadErrorCode::Network);
        assert_eq!(proxy.requests.lock().unwrap().len(), 1);
        assert_eq!(target.requests.lock().unwrap().len(), 0);

        for route in ["unknown-route", "custom-proxy"] {
            network.route = route.to_string();
            network.custom_proxy_url = None;
            let error = download_model_to_directory(
                &registry,
                route,
                directory.path(),
                &target.url,
                None,
                Some(&network),
                MAX_MODEL_BYTES,
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, ModelDownloadErrorCode::Network);
        }
        network = direct_model_route("http://127.0.0.1:1");
        let headers = HashMap::from([(
            "Authorization".to_string(),
            "Bearer fixture-secret".to_string(),
        )]);
        let error = download_model_to_directory(
            &registry,
            "auth-origin",
            directory.path(),
            &target.url,
            Some(&headers),
            Some(&network),
            MAX_MODEL_BYTES,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ModelDownloadErrorCode::Network);
        assert_eq!(target.requests.lock().unwrap().len(), 0);
        assert_no_model_files(directory.path());
    }

    async fn stalled_model_http_fixture(
        body_started: bool,
    ) -> (
        ModelHttpFixture,
        oneshot::Receiver<()>,
        oneshot::Receiver<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let server_requests = Arc::clone(&requests);
        let (ready, ready_receiver) = oneshot::channel();
        let (closed, closed_receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut stream).await;
            server_requests.lock().unwrap().push(request);
            if body_started {
                stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: model/gltf-binary\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nglTF\r\n"
                ).await.unwrap();
            }
            ready.send(()).unwrap();
            let mut byte = [0];
            let disconnected = match stream.read(&mut byte).await {
                Ok(0) => true,
                Err(error) => matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
                ),
                _ => false,
            };
            if disconnected {
                let _ = closed.send(());
            }
        });
        (
            ModelHttpFixture {
                url,
                requests,
                task,
            },
            ready_receiver,
            closed_receiver,
        )
    }

    #[tokio::test]
    async fn model_download_cancellation_interrupts_request_and_body_reads() {
        for body_started in [false, true] {
            let (server, ready, closed) = stalled_model_http_fixture(body_started).await;
            let registry = Arc::new(ModelDownloads::default());
            let download_registry = Arc::clone(&registry);
            let directory = tempfile::tempdir().unwrap();
            let download_directory = directory.path().to_path_buf();
            let url = server.url.clone();
            let network = direct_model_route(&url);
            let download = tokio::spawn(async move {
                download_model_to_directory(
                    &download_registry,
                    "cancel-inflight",
                    &download_directory,
                    &url,
                    None,
                    Some(&network),
                    MAX_MODEL_BYTES,
                )
                .await
            });
            timeout(TEST_TIMEOUT, ready).await.unwrap().unwrap();
            if body_started {
                // Read the written bytes before canceling the subsequent body
                // read. Windows directory-entry sizes can remain stale while
                // the writer is open, so metadata is not a progress signal.
                timeout(TEST_TIMEOUT, async {
                    loop {
                        let written = std::fs::read_dir(directory.path()).unwrap().any(|entry| {
                            let mut file = std::fs::File::open(entry.unwrap().path()).unwrap();
                            let mut prefix = [0; 4];
                            file.read_exact(&mut prefix).is_ok() && &prefix == b"glTF"
                        });
                        if written {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
            }
            registry.cancel("cancel-inflight".to_string()).unwrap();
            let error = timeout(TEST_TIMEOUT, download)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert_eq!(error.code, ModelDownloadErrorCode::Canceled);
            timeout(TEST_TIMEOUT, closed).await.unwrap().unwrap();
            assert_no_model_files(directory.path());
            assert!(registry.0.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn model_download_request_ids_and_canceled_publication_are_race_safe() {
        let registry = ModelDownloads::default();
        registry
            .cancel("canceled-before-start".to_string())
            .unwrap();
        assert!(matches!(
            registry.start("canceled-before-start"),
            Err(ModelDownloadError {
                code: ModelDownloadErrorCode::Canceled,
                ..
            })
        ));
        let registration = registry.start("active-id").unwrap();
        assert!(matches!(
            registry.start("active-id"),
            Err(ModelDownloadError {
                code: ModelDownloadErrorCode::Network,
                ..
            })
        ));
        registry.cancel("active-id".to_string()).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let temporary = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
        let path = directory.path().join("must-not-publish.glb");
        assert_eq!(
            registration.publish(temporary, &path).unwrap_err().code,
            ModelDownloadErrorCode::Canceled
        );
        assert_no_model_files(directory.path());
        drop(registration);
        assert!(registry.0.lock().unwrap().is_empty());
    }
}

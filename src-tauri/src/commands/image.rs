use ab_glyph::{FontArc, PxScale};
use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose::STANDARD, Engine};
use directories::UserDirs;
use fast_image_resize as fir;
use fast_image_resize::images::Image as FirImage;
use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader, Rgba, RgbaImage};
use imageproc::drawing::{draw_text_mut, text_size};
use md5;
use png::{BitDepth, ColorType, Decoder, Encoder};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Cursor;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::time::sleep;
use tracing::info;

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF};

const STORYBOARD_METADATA_PNG_TEXT_KEY: &str = "StoryboardCopilotMetadata";
const FAST_PREVIEW_BYPASS_MAX_BYTES: usize = 2_000_000;
const FAST_PREVIEW_BYPASS_MAX_DIMENSION: u32 = 2048;
const REMOTE_IMAGE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(45);
const REMOTE_AUDIO_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const REMOTE_VIDEO_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const REMOTE_IMAGE_DOWNLOAD_ATTEMPTS: usize = 3;
const REMOTE_MEDIA_MAX_REDIRECTS: usize = 5;
const REMOTE_IMAGE_MAX_BYTES: usize = 64 * 1024 * 1024;
const REMOTE_VIDEO_MAX_BYTES: usize = 512 * 1024 * 1024;
const REMOTE_AUDIO_MAX_BYTES: usize = 128 * 1024 * 1024;
const GENERATED_MEDIA_COUNTERS_FILE_NAME: &str = "generated-media-counters.json";
static REMOTE_IMAGE_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
static REMOTE_IMAGE_NO_PROXY_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

fn build_remote_media_client(no_proxy: bool) -> Result<reqwest::Client, reqwest::Error> {
    let builder = reqwest::Client::builder()
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(60))
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .no_deflate()
        .redirect(reqwest::redirect::Policy::none());
    let builder = if no_proxy {
        builder.no_proxy()
    } else {
        builder
    };
    builder.build()
}

fn build_custom_proxy_media_client(proxy_url: &str) -> Result<reqwest::Client, String> {
    let proxy = crate::commands::http::validated_custom_proxy(proxy_url)?;
    reqwest::Client::builder()
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(60))
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .no_deflate()
        .redirect(reqwest::redirect::Policy::none())
        .proxy(proxy)
        .build()
        .map_err(|_| "Failed to build custom-proxy media client".to_string())
}

fn remote_image_client() -> Result<&'static reqwest::Client, String> {
    REMOTE_IMAGE_CLIENT
        .get_or_init(|| {
            build_remote_media_client(false)
                .map_err(|error| format!("Failed to build default media client: {}", error))
        })
        .as_ref()
        .map_err(|error| error.clone())
}

fn remote_image_no_proxy_client() -> Result<&'static reqwest::Client, String> {
    REMOTE_IMAGE_NO_PROXY_CLIENT
        .get_or_init(|| {
            build_remote_media_client(true)
                .map_err(|error| format!("Failed to build no-proxy media client: {}", error))
        })
        .as_ref()
        .map_err(|error| error.clone())
}

#[derive(Debug)]
struct RemoteMediaDownload {
    bytes: Vec<u8>,
    content_type: String,
}

#[derive(Debug)]
enum RemoteMediaAttemptFailure {
    Status {
        message: String,
        retryable: bool,
        fallback_allowed: bool,
    },
    Network {
        message: String,
    },
    InvalidContent {
        message: String,
    },
    TooLarge {
        message: String,
    },
}

impl RemoteMediaAttemptFailure {
    fn retryable(&self) -> bool {
        match self {
            Self::Status { retryable, .. } => *retryable,
            Self::Network { .. } | Self::InvalidContent { .. } => true,
            Self::TooLarge { .. } => false,
        }
    }

    fn fallback_allowed(&self) -> bool {
        match self {
            Self::Status {
                fallback_allowed, ..
            } => *fallback_allowed,
            Self::Network { .. } | Self::InvalidContent { .. } => true,
            Self::TooLarge { .. } => false,
        }
    }

    fn into_message(self) -> String {
        match self {
            Self::Status { message, .. }
            | Self::Network { message }
            | Self::InvalidContent { message }
            | Self::TooLarge { message } => message,
        }
    }
}

#[derive(Debug)]
struct RemoteMediaRouteFailure {
    message: String,
    fallback_allowed: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaNetworkRouteDto {
    pub route: String,
    pub custom_proxy_url: Option<String>,
    pub configured_provider_origin: Option<String>,
}

impl MediaNetworkRouteDto {
    fn route(&self) -> Result<&str, String> {
        match self.route.trim() {
            "" | "system" => Ok("system"),
            "direct" => Ok("direct"),
            "custom-proxy" => Ok("custom-proxy"),
            other => Err(format!("Unsupported media network route: {other}")),
        }
    }
}

fn route_allows_direct_fallback(route: &str) -> bool {
    route == "system"
}

fn should_forward_headers_to_url(allowed_origin: &str, target: &reqwest::Url) -> bool {
    url_origin(target) == allowed_origin
}

fn describe_remote_media_url(url: &str) -> String {
    if let Ok(parsed) = reqwest::Url::parse(url) {
        let host = parsed.host_str().unwrap_or("unknown-host");
        let basename = parsed
            .path_segments()
            .and_then(|segments| segments.filter(|segment| !segment.is_empty()).last())
            .unwrap_or("remote-media");
        return format!("{}/{}", host, basename);
    }
    "remote-media".to_string()
}

fn parse_remote_media_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|_| "Remote media URL is malformed".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Remote media URL must use HTTP or HTTPS and include a host".to_string());
    }
    Ok(parsed)
}

fn url_origin(url: &reqwest::Url) -> String {
    url.origin().ascii_serialization()
}

fn ip_is_local_or_private(ip: IpAddr) -> bool {
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
                    .is_some_and(|mapped| ip_is_local_or_private(IpAddr::V4(mapped)))
        }
    }
}

fn host_is_local_or_private(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return true;
    }
    let normalized_host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    normalized_host
        .parse::<IpAddr>()
        .is_ok_and(ip_is_local_or_private)
}

async fn resolves_to_local_or_private(url: &reqwest::Url) -> bool {
    if host_is_local_or_private(url) {
        return true;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let port = url.port_or_known_default().unwrap_or(80);
    tokio::net::lookup_host((host, port))
        .await
        .map(|mut addresses| addresses.any(|address| ip_is_local_or_private(address.ip())))
        .unwrap_or(false)
}

fn media_byte_limit(media_kind: &str) -> usize {
    match media_kind {
        "video" => REMOTE_VIDEO_MAX_BYTES,
        "audio" => REMOTE_AUDIO_MAX_BYTES,
        _ => REMOTE_IMAGE_MAX_BYTES,
    }
}

fn media_download_timeout(media_kind: &str) -> Duration {
    match media_kind {
        "video" => REMOTE_VIDEO_DOWNLOAD_TIMEOUT,
        "audio" => REMOTE_AUDIO_DOWNLOAD_TIMEOUT,
        _ => REMOTE_IMAGE_DOWNLOAD_TIMEOUT,
    }
}

fn describe_reqwest_network_error(error: &reqwest::Error) -> String {
    let mut kinds: Vec<&str> = Vec::new();
    if error.is_connect() {
        kinds.push("connect/tls");
    }
    if error.is_timeout() {
        kinds.push("timeout");
    }
    if error.is_body() {
        kinds.push("body");
    }
    if error.is_decode() {
        kinds.push("decode");
    }
    if kinds.is_empty() {
        kinds.push("send");
    }
    format!("network failure [{}]", kinds.join(","))
}

async fn try_remote_media_request(
    client: &reqwest::Client,
    route_label: &str,
    url: &str,
    accept_header: &str,
    headers: Option<&HashMap<String, String>>,
    media_kind: &str,
    attempt: usize,
    configured_provider_origin: Option<&str>,
) -> Result<RemoteMediaDownload, RemoteMediaAttemptFailure> {
    try_remote_media_request_with_limit(
        client,
        route_label,
        url,
        accept_header,
        headers,
        media_kind,
        attempt,
        configured_provider_origin,
        media_byte_limit(media_kind),
    )
    .await
}

async fn try_remote_media_request_with_limit(
    client: &reqwest::Client,
    route_label: &str,
    url: &str,
    accept_header: &str,
    headers: Option<&HashMap<String, String>>,
    media_kind: &str,
    attempt: usize,
    configured_provider_origin: Option<&str>,
    byte_limit: usize,
) -> Result<RemoteMediaDownload, RemoteMediaAttemptFailure> {
    let mut current_url = parse_remote_media_url(url)
        .map_err(|message| RemoteMediaAttemptFailure::InvalidContent { message })?;
    let initial_origin = url_origin(&current_url);
    let allowed_header_origin = configured_provider_origin
        .and_then(|origin| reqwest::Url::parse(origin).ok())
        .map(|origin| url_origin(&origin))
        .unwrap_or_else(|| initial_origin.clone());
    let configured_local_origin = configured_provider_origin
        .and_then(|origin| reqwest::Url::parse(origin).ok())
        .filter(host_is_local_or_private)
        .map(|origin| url_origin(&origin));
    if resolves_to_local_or_private(&current_url).await
        && configured_local_origin.as_deref() != Some(initial_origin.as_str())
    {
        return Err(RemoteMediaAttemptFailure::Status {
            message: format!(
                "{} route rejected unconfigured local remote {} {}",
                route_label,
                media_kind,
                describe_remote_media_url(current_url.as_str())
            ),
            retryable: false,
            fallback_allowed: false,
        });
    }

    for redirect_count in 0..=REMOTE_MEDIA_MAX_REDIRECTS {
        let url_label = describe_remote_media_url(current_url.as_str());
        let mut request = client
            .get(current_url.clone())
            .timeout(media_download_timeout(media_kind))
            .header(reqwest::header::ACCEPT, accept_header)
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .header(reqwest::header::USER_AGENT, "Open-Storyboard-Canvas/1.0");
        if should_forward_headers_to_url(&allowed_header_origin, &current_url) {
            if let Some(headers) = headers {
                for (key, value) in headers {
                    let trimmed_key = key.trim();
                    if trimmed_key.is_empty() || !should_forward_remote_image_header(trimmed_key) {
                        continue;
                    }
                    request = request.header(trimmed_key, value.as_str());
                }
            }
        }

        let response =
            request
                .send()
                .await
                .map_err(|error| RemoteMediaAttemptFailure::Network {
                    message: format!(
                        "{} route attempt {} failed to send remote {} request for {}: {}",
                        route_label,
                        attempt,
                        media_kind,
                        url_label,
                        describe_reqwest_network_error(&error)
                    ),
                })?;

        let status = response.status();
        if status.is_redirection() {
            if redirect_count >= REMOTE_MEDIA_MAX_REDIRECTS {
                return Err(RemoteMediaAttemptFailure::Status {
                    message: format!(
                        "{} route exceeded redirect limit for remote {} {}",
                        route_label, media_kind, url_label
                    ),
                    retryable: false,
                    fallback_allowed: false,
                });
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| RemoteMediaAttemptFailure::Status {
                    message: format!(
                        "{} route received redirect without Location for remote {} {}",
                        route_label, media_kind, url_label
                    ),
                    retryable: false,
                    fallback_allowed: false,
                })?;
            let next_url =
                current_url
                    .join(location)
                    .map_err(|_| RemoteMediaAttemptFailure::Status {
                        message: format!(
                            "{} route received malformed redirect for remote {} {}",
                            route_label, media_kind, url_label
                        ),
                        retryable: false,
                        fallback_allowed: false,
                    })?;
            parse_remote_media_url(next_url.as_str()).map_err(|message| {
                RemoteMediaAttemptFailure::Status {
                    message: format!(
                        "{} route rejected redirect for remote {} {}: {}",
                        route_label, media_kind, url_label, message
                    ),
                    retryable: false,
                    fallback_allowed: false,
                }
            })?;
            if resolves_to_local_or_private(&next_url).await {
                let next_origin = url_origin(&next_url);
                let local_redirect_is_same_configured_origin = configured_local_origin.as_deref()
                    == Some(initial_origin.as_str())
                    && configured_local_origin.as_deref() == Some(next_origin.as_str());
                if !local_redirect_is_same_configured_origin {
                    return Err(RemoteMediaAttemptFailure::Status {
                        message: format!(
                            "{} route rejected redirect into unconfigured local remote {} {}",
                            route_label, media_kind, url_label
                        ),
                        retryable: false,
                        fallback_allowed: false,
                    });
                }
            }
            current_url = next_url;
            continue;
        }
        if !status.is_success() {
            return Err(RemoteMediaAttemptFailure::Status {
                message: format!(
                    "{} route attempt {} returned HTTP {} for remote {} {}",
                    route_label, attempt, status, media_kind, url_label
                ),
                retryable: status.as_u16() == 408
                    || status.as_u16() == 429
                    || status.is_server_error(),
                fallback_allowed: status.as_u16() == 408 || status.is_server_error(),
            });
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("unknown")
            .to_string();
        let content_encoding = response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("none")
            .to_string();
        if response
            .content_length()
            .is_some_and(|length| length > byte_limit as u64)
        {
            return Err(RemoteMediaAttemptFailure::TooLarge {
                message: format!(
                    "{} route remote {} exceeded {} byte limit for {}",
                    route_label, media_kind, byte_limit, url_label
                ),
            });
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| RemoteMediaAttemptFailure::Network {
        message: format!(
            "{} route attempt {} failed to read remote {} body for {} (content-type={}, content-encoding={}): {}",
            route_label, attempt, media_kind, url_label, content_type, content_encoding,
            describe_reqwest_network_error(&error)
        ),
    })? {
        if bytes.len().saturating_add(chunk.len()) > byte_limit {
            return Err(RemoteMediaAttemptFailure::TooLarge {
                message: format!("{} route remote {} exceeded {} byte limit for {}", route_label, media_kind, byte_limit, url_label),
            });
        }
        bytes.extend_from_slice(&chunk);
    }

        if let Some(message) = remote_media_content_error(media_kind, &content_type, &bytes) {
            return Err(RemoteMediaAttemptFailure::InvalidContent {
                message: format!(
                    "{} route attempt {} returned invalid remote {} content for {}: {}",
                    route_label, attempt, media_kind, url_label, message
                ),
            });
        }

        return Ok(RemoteMediaDownload {
            bytes,
            content_type,
        });
    }
    unreachable!("redirect loop returns or continues within its bounded range")
}

async fn try_remote_media_route(
    client: &reqwest::Client,
    route_label: &str,
    url: &str,
    accept_header: &str,
    headers: Option<&HashMap<String, String>>,
    media_kind: &str,
    configured_provider_origin: Option<&str>,
) -> Result<RemoteMediaDownload, RemoteMediaRouteFailure> {
    for attempt in 1..=REMOTE_IMAGE_DOWNLOAD_ATTEMPTS {
        match try_remote_media_request(
            client,
            route_label,
            url,
            accept_header,
            headers,
            media_kind,
            attempt,
            configured_provider_origin,
        )
        .await
        {
            Ok(download) => return Ok(download),
            Err(failure) => {
                let retryable = failure.retryable();
                let fallback_allowed = failure.fallback_allowed();
                let message = failure.into_message();
                if !retryable || attempt == REMOTE_IMAGE_DOWNLOAD_ATTEMPTS {
                    return Err(RemoteMediaRouteFailure {
                        message,
                        fallback_allowed,
                    });
                }
            }
        }

        sleep(Duration::from_millis(350 * attempt as u64)).await;
    }
    unreachable!("media route loop returns within its bounded attempt count")
}

async fn download_remote_media_bytes(
    url: &str,
    headers: Option<&HashMap<String, String>>,
    accept_header: &str,
    media_kind: &str,
    network: Option<&MediaNetworkRouteDto>,
) -> Result<RemoteMediaDownload, String> {
    let url_label = describe_remote_media_url(url);
    parse_remote_media_url(url).map_err(|error| {
        format!(
            "Remote {} materialize failed via invalid route for {}: {}",
            media_kind, url_label, error
        )
    })?;
    let route = network
        .map(MediaNetworkRouteDto::route)
        .transpose()?
        .unwrap_or("system");
    let provider_origin = network.and_then(|value| value.configured_provider_origin.as_deref());
    let custom_client;
    let first_client = match route {
        "system" => remote_image_client()?,
        "direct" => remote_image_no_proxy_client()?,
        "custom-proxy" => {
            let proxy_url = network
                .and_then(|value| value.custom_proxy_url.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "custom-proxy media route requires customProxyUrl".to_string())?;
            custom_client = build_custom_proxy_media_client(proxy_url)?;
            &custom_client
        }
        _ => unreachable!(),
    };
    let should_try_no_proxy = route_allows_direct_fallback(route);
    let first_failure = match try_remote_media_route(
        first_client,
        route,
        url,
        accept_header,
        headers,
        media_kind,
        provider_origin,
    )
    .await
    {
        Ok(download) => return Ok(download),
        Err(failure) => failure,
    };

    if !should_try_no_proxy || !first_failure.fallback_allowed {
        return Err(format!(
            "Remote {} materialize failed via {} for {}: {}",
            media_kind, route, url_label, first_failure.message
        ));
    }

    let no_proxy_client = remote_image_no_proxy_client().map_err(|error| {
        format!(
            "Remote {} download failed for {}: default route {}; no-proxy route unavailable: {}",
            media_kind, url_label, first_failure.message, error
        )
    })?;

    let no_proxy_failure = match try_remote_media_route(
        no_proxy_client,
        "no-proxy",
        url,
        accept_header,
        headers,
        media_kind,
        provider_origin,
    )
    .await
    {
        Ok(download) => return Ok(download),
        Err(failure) => failure,
    };

    Err(format!(
        "Remote {} download failed for {}: default route {}; no-proxy route {}",
        media_kind, url_label, first_failure.message, no_proxy_failure.message
    ))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardImageMetadata {
    pub grid_rows: u32,
    pub grid_cols: u32,
    pub frame_notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DailyGeneratedMediaCounter {
    date: String,
    sequence: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GeneratedMediaCounters {
    image: DailyGeneratedMediaCounter,
    video: DailyGeneratedMediaCounter,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameLocalMediaFilesPayload {
    pub primary_path: String,
    pub preview_path: Option<String>,
    pub desired_file_name: Option<String>,
    pub media_kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameLocalMediaFilesResult {
    pub primary_path: String,
    pub preview_path: Option<String>,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemClipboardImage {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemClipboardContent {
    pub image: Option<SystemClipboardImage>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalMediaKind {
    Image,
    Video,
}

#[tauri::command]
pub async fn split_image(
    image_base64: String,
    rows: u32,
    cols: u32,
    line_thickness: Option<u32>,
) -> Result<Vec<String>, String> {
    let safe_rows = rows.max(1);
    let safe_cols = cols.max(1);
    let requested_line = line_thickness.unwrap_or(0);

    info!(
        "Splitting image into {}x{}, line thickness={}",
        safe_rows, safe_cols, requested_line
    );

    let image_data = STANDARD
        .decode(&image_base64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    let img =
        image::load_from_memory(&image_data).map_err(|e| format!("Failed to load image: {}", e))?;

    let (width, height) = img.dimensions();
    let resolved_line = resolve_line_thickness(width, height, safe_rows, safe_cols, requested_line);
    let usable_width =
        width.saturating_sub((safe_cols.saturating_sub(1)).saturating_mul(resolved_line));
    let usable_height =
        height.saturating_sub((safe_rows.saturating_sub(1)).saturating_mul(resolved_line));

    if usable_width < safe_cols || usable_height < safe_rows {
        return Err("分割线过粗，无法完成切割".to_string());
    }

    let column_widths = split_sizes(usable_width, safe_cols);
    let row_heights = split_sizes(usable_height, safe_rows);

    let mut x_offsets = Vec::with_capacity(safe_cols as usize);
    let mut cursor_x = 0_u32;
    for col in 0..safe_cols {
        x_offsets.push(cursor_x);
        cursor_x = cursor_x.saturating_add(column_widths[col as usize]);
        if col < safe_cols - 1 {
            cursor_x = cursor_x.saturating_add(resolved_line);
        }
    }

    let mut y_offsets = Vec::with_capacity(safe_rows as usize);
    let mut cursor_y = 0_u32;
    for row in 0..safe_rows {
        y_offsets.push(cursor_y);
        cursor_y = cursor_y.saturating_add(row_heights[row as usize]);
        if row < safe_rows - 1 {
            cursor_y = cursor_y.saturating_add(resolved_line);
        }
    }

    let mut results = Vec::new();

    for row in 0..safe_rows {
        for col in 0..safe_cols {
            let x = x_offsets[col as usize];
            let y = y_offsets[row as usize];
            let width = column_widths[col as usize];
            let height = row_heights[row as usize];

            let cropped = img.crop_imm(x, y, width, height);

            let mut buffer = Cursor::new(Vec::new());
            cropped
                .write_to(&mut buffer, image::ImageFormat::Png)
                .map_err(|e| format!("Failed to encode cropped image: {}", e))?;

            let base64_data = STANDARD.encode(buffer.get_ref());
            results.push(format!("data:image/png;base64,{}", base64_data));
        }
    }

    info!("Split into {} images", results.len());
    Ok(results)
}

#[tauri::command]
pub async fn split_image_source(
    app: AppHandle,
    source: String,
    rows: u32,
    cols: u32,
    line_thickness: Option<u32>,
) -> Result<Vec<String>, String> {
    let started = Instant::now();
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let safe_rows = rows.max(1);
    let safe_cols = cols.max(1);
    let requested_line = line_thickness.unwrap_or(0);

    info!(
        "Splitting source image into {}x{}, line thickness={}",
        safe_rows, safe_cols, requested_line
    );

    let (source_bytes, _source_ext) = resolve_source_bytes(trimmed_source).await?;
    let decode_done = Instant::now();
    let image = image::load_from_memory(&source_bytes)
        .map_err(|e| format!("Failed to decode source image: {}", e))?;

    let (width, height) = image.dimensions();
    let resolved_line = resolve_line_thickness(width, height, safe_rows, safe_cols, requested_line);
    let usable_width =
        width.saturating_sub((safe_cols.saturating_sub(1)).saturating_mul(resolved_line));
    let usable_height =
        height.saturating_sub((safe_rows.saturating_sub(1)).saturating_mul(resolved_line));

    if usable_width < safe_cols || usable_height < safe_rows {
        return Err("分割线过粗，无法完成切割".to_string());
    }

    let column_widths = split_sizes(usable_width, safe_cols);
    let row_heights = split_sizes(usable_height, safe_rows);

    let mut x_offsets = Vec::with_capacity(safe_cols as usize);
    let mut cursor_x = 0_u32;
    for col in 0..safe_cols {
        x_offsets.push(cursor_x);
        cursor_x = cursor_x.saturating_add(column_widths[col as usize]);
        if col < safe_cols - 1 {
            cursor_x = cursor_x.saturating_add(resolved_line);
        }
    }

    let mut y_offsets = Vec::with_capacity(safe_rows as usize);
    let mut cursor_y = 0_u32;
    for row in 0..safe_rows {
        y_offsets.push(cursor_y);
        cursor_y = cursor_y.saturating_add(row_heights[row as usize]);
        if row < safe_rows - 1 {
            cursor_y = cursor_y.saturating_add(resolved_line);
        }
    }

    let mut results = Vec::with_capacity((safe_rows * safe_cols) as usize);

    for row in 0..safe_rows {
        for col in 0..safe_cols {
            let x = x_offsets[col as usize];
            let y = y_offsets[row as usize];
            let width = column_widths[col as usize];
            let height = row_heights[row as usize];
            let cropped = image.crop_imm(x, y, width, height);

            let mut buffer = Cursor::new(Vec::new());
            cropped
                .write_to(&mut buffer, image::ImageFormat::Png)
                .map_err(|e| format!("Failed to encode split image: {}", e))?;

            let persisted = persist_image_bytes(&app, buffer.get_ref(), "png")?;
            results.push(persisted);
        }
    }

    info!(
        "split_image_source done: {} frames, decode={}ms, total={}ms",
        results.len(),
        decode_done.duration_since(started).as_millis(),
        started.elapsed().as_millis()
    );

    Ok(results)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeStoryboardImagesPayload {
    pub frame_sources: Vec<String>,
    pub rows: u32,
    pub cols: u32,
    pub cell_gap: u32,
    pub outer_padding: u32,
    pub note_height: u32,
    pub font_size: u32,
    pub background_color: String,
    pub max_dimension: u32,
    pub show_frame_index: Option<bool>,
    pub show_frame_note: Option<bool>,
    pub note_placement: Option<String>,
    pub image_fit: Option<String>,
    pub frame_index_prefix: Option<String>,
    pub text_color: Option<String>,
    pub frame_notes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeStoryboardImagesResult {
    pub image_path: String,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub cell_width: u32,
    pub cell_height: u32,
    pub gap: u32,
    pub padding: u32,
    pub note_height: u32,
    pub font_size: u32,
    pub text_overlay_applied: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareNodeImageResult {
    pub image_path: String,
    pub preview_image_path: String,
    pub aspect_ratio: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropImageSourcePayload {
    pub source: String,
    pub aspect_ratio: Option<String>,
    pub crop_x: Option<f64>,
    pub crop_y: Option<f64>,
    pub crop_width: Option<f64>,
    pub crop_height: Option<f64>,
}

fn split_sizes(total: u32, segments: u32) -> Vec<u32> {
    let safe_segments = segments.max(1);
    let base = total / safe_segments;
    let remainder = total % safe_segments;

    (0..safe_segments)
        .map(|index| base + if index < remainder { 1 } else { 0 })
        .collect()
}

fn gcd_u32(a: u32, b: u32) -> u32 {
    let mut x = a.max(1);
    let mut y = b.max(1);

    while y != 0 {
        let temp = y;
        y = x % y;
        x = temp;
    }

    x.max(1)
}

fn reduce_aspect_ratio(width: u32, height: u32) -> String {
    let safe_width = width.max(1);
    let safe_height = height.max(1);
    let gcd = gcd_u32(safe_width, safe_height);
    format!("{}:{}", safe_width / gcd, safe_height / gcd)
}

fn parse_aspect_ratio(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.eq_ignore_ascii_case("free") || trimmed.is_empty() {
        return None;
    }

    let (w, h) = trimmed.split_once(':')?;
    let width = w.trim().parse::<f64>().ok()?;
    let height = h.trim().parse::<f64>().ok()?;
    if width <= 0.0 || height <= 0.0 {
        return None;
    }

    Some(width / height)
}

fn resolve_line_thickness(
    image_width: u32,
    image_height: u32,
    rows: u32,
    cols: u32,
    line_thickness: u32,
) -> u32 {
    if line_thickness == 0 {
        return 0;
    }

    let max_by_width = if cols > 1 {
        image_width.saturating_sub(cols) / (cols - 1)
    } else {
        line_thickness
    };
    let max_by_height = if rows > 1 {
        image_height.saturating_sub(rows) / (rows - 1)
    } else {
        line_thickness
    };
    line_thickness.min(max_by_width.min(max_by_height))
}

fn parse_hex_color(color: &str) -> Rgba<u8> {
    let value = color.trim().trim_start_matches('#');
    let parse_pair =
        |start: usize| -> Option<u8> { u8::from_str_radix(value.get(start..start + 2)?, 16).ok() };

    match value.len() {
        6 => {
            let (Some(r), Some(g), Some(b)) = (parse_pair(0), parse_pair(2), parse_pair(4)) else {
                return Rgba([15, 17, 21, 255]);
            };
            Rgba([r, g, b, 255])
        }
        8 => {
            let (Some(r), Some(g), Some(b), Some(a)) =
                (parse_pair(0), parse_pair(2), parse_pair(4), parse_pair(6))
            else {
                return Rgba([15, 17, 21, 255]);
            };
            Rgba([r, g, b, a])
        }
        _ => Rgba([15, 17, 21, 255]),
    }
}

static OVERLAY_FONT: OnceLock<Option<FontArc>> = OnceLock::new();

fn load_overlay_font() -> Option<&'static FontArc> {
    OVERLAY_FONT
        .get_or_init(|| {
            #[cfg(target_os = "windows")]
            let candidate_paths = [
                // Prefer Microsoft YaHei for CJK readability.
                "C:\\Windows\\Fonts\\msyh.ttc",
                "C:\\Windows\\Fonts\\msyhbd.ttc",
                "C:\\Windows\\Fonts\\msyhl.ttc",
                "C:\\Windows\\Fonts\\simhei.ttf",
                // Fallback Latin fonts.
                "C:\\Windows\\Fonts\\segoeui.ttf",
                "C:\\Windows\\Fonts\\arial.ttf",
            ];

            #[cfg(target_os = "macos")]
            let candidate_paths = [
                // Prefer PingFang for CJK readability.
                "/System/Library/Fonts/PingFang.ttc",
                "/System/Library/Fonts/Hiragino Sans GB.ttc",
                "/System/Library/Fonts/STHeiti Medium.ttc",
                // Fallback.
                "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
                "/System/Library/Fonts/Supplemental/Arial.ttf",
            ];

            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            let candidate_paths = [
                "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            ];

            for path in candidate_paths {
                if let Ok(bytes) = std::fs::read(path) {
                    if let Ok(font) = FontArc::try_from_vec(bytes) {
                        info!("Loaded storyboard overlay font from {}", path);
                        return Some(font);
                    }
                }
            }

            info!("No suitable system font found for storyboard text overlay");
            None
        })
        .as_ref()
}

fn trim_text_to_width(font: &FontArc, scale: PxScale, text: &str, max_width: u32) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let safe_text = normalized.trim();
    if safe_text.is_empty() {
        return String::new();
    }

    if text_size(scale, font, safe_text).0 <= max_width {
        return safe_text.to_string();
    }

    let mut content = safe_text.to_string();
    while content.chars().count() > 1 {
        content.pop();
        let with_ellipsis = format!("{}...", content);
        if text_size(scale, font, &with_ellipsis).0 <= max_width {
            return with_ellipsis;
        }
    }

    "...".to_string()
}

fn fill_rect(image: &mut RgbaImage, x: u32, y: u32, width: u32, height: u32, color: Rgba<u8>) {
    if width == 0 || height == 0 {
        return;
    }

    let max_x = (x.saturating_add(width)).min(image.width());
    let max_y = (y.saturating_add(height)).min(image.height());

    for yy in y..max_y {
        for xx in x..max_x {
            image.put_pixel(xx, yy, color);
        }
    }
}

fn blend_pixel(bottom: Rgba<u8>, top: Rgba<u8>) -> Rgba<u8> {
    let top_a = top[3] as u16;
    if top_a == 0 {
        return bottom;
    }
    if top_a == 255 {
        return top;
    }

    let bottom_a = bottom[3] as u16;
    let inv_top_a = 255_u16.saturating_sub(top_a);

    let out_a = top_a + (bottom_a * inv_top_a + 127) / 255;
    if out_a == 0 {
        return Rgba([0, 0, 0, 0]);
    }

    let blend_channel = |bottom_c: u8, top_c: u8| -> u8 {
        let bottom_premul = bottom_c as u32 * bottom_a as u32;
        let top_premul = top_c as u32 * top_a as u32;
        let out_premul = top_premul + ((bottom_premul * inv_top_a as u32 + 127) / 255);
        let out = (out_premul + (out_a as u32 / 2)) / out_a as u32;
        out.min(255) as u8
    };

    Rgba([
        blend_channel(bottom[0], top[0]),
        blend_channel(bottom[1], top[1]),
        blend_channel(bottom[2], top[2]),
        out_a as u8,
    ])
}

fn fill_rect_alpha_blend(
    image: &mut RgbaImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    color: Rgba<u8>,
) {
    if width == 0 || height == 0 {
        return;
    }

    let max_x = (x.saturating_add(width)).min(image.width());
    let max_y = (y.saturating_add(height)).min(image.height());

    for yy in y..max_y {
        for xx in x..max_x {
            let current = *image.get_pixel(xx, yy);
            image.put_pixel(xx, yy, blend_pixel(current, color));
        }
    }
}

fn stroke_right_edge(
    image: &mut RgbaImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    color: Rgba<u8>,
) {
    if width < 1 || height < 1 {
        return;
    }

    let x2 = x.saturating_add(width.saturating_sub(1));
    if x2 >= image.width() {
        return;
    }

    let max_y = y.saturating_add(height).min(image.height());
    for yy in y..max_y {
        if yy < image.height() {
            image.put_pixel(x2, yy, color);
        }
    }
}

fn stroke_bottom_edge(
    image: &mut RgbaImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    color: Rgba<u8>,
) {
    if width < 1 || height < 1 {
        return;
    }

    let y2 = y.saturating_add(height.saturating_sub(1));
    if y2 >= image.height() {
        return;
    }

    let max_x = x.saturating_add(width).min(image.width());
    for xx in x..max_x {
        if xx < image.width() {
            image.put_pixel(xx, y2, color);
        }
    }
}

fn resize_image_fast(
    source: &DynamicImage,
    target_width: u32,
    target_height: u32,
) -> Result<RgbaImage, String> {
    let source_rgba = source.to_rgba8();
    let source_width = source_rgba.width().max(1);
    let source_height = source_rgba.height().max(1);
    let source_pixels = source_rgba.into_raw();

    let source_image = FirImage::from_vec_u8(
        source_width,
        source_height,
        source_pixels,
        fir::PixelType::U8x4,
    )
    .map_err(|e| format!("Failed to create source image for fast resize: {}", e))?;
    let mut target_image = FirImage::new(
        target_width.max(1),
        target_height.max(1),
        fir::PixelType::U8x4,
    );

    let mut resizer = fir::Resizer::new();
    let resize_options = fir::ResizeOptions::new()
        .resize_alg(fir::ResizeAlg::Convolution(fir::FilterType::Bilinear));
    resizer
        .resize(&source_image, &mut target_image, Some(&resize_options))
        .map_err(|e| format!("Failed to run fast image resize: {}", e))?;

    RgbaImage::from_raw(
        target_width.max(1),
        target_height.max(1),
        target_image.into_vec(),
    )
    .ok_or_else(|| "Failed to build RGBA image from resized buffer".to_string())
}

async fn load_dynamic_image_from_source(source: &str) -> Result<DynamicImage, String> {
    let (bytes, _extension) = resolve_source_bytes(source).await?;
    image::load_from_memory(&bytes).map_err(|e| format!("Failed to decode image source: {}", e))
}

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn prepare_node_image_from_bytes(
    app: &AppHandle,
    bytes: &[u8],
    extension: &str,
    safe_max_dimension: u32,
    trace_tag: &str,
) -> Result<PrepareNodeImageResult, String> {
    let started = Instant::now();
    let probe_started = Instant::now();
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| {
            format_image_probe_error("Failed to guess image format", e, bytes, extension)
        })?;
    let guessed_format = reader.format();
    let effective_extension = extension_from_image_format(guessed_format)
        .unwrap_or_else(|| normalize_extension(extension));
    let (raw_width, raw_height) = reader.into_dimensions().map_err(|e| {
        format_image_probe_error(
            "Failed to parse image dimensions",
            e,
            bytes,
            &effective_extension,
        )
    })?;
    let probe_elapsed = probe_started.elapsed().as_millis();
    let width = raw_width.max(1);
    let height = raw_height.max(1);

    let persist_started = Instant::now();
    let should_transcode_original = effective_extension == "avif";
    let mut decoded_original: Option<DynamicImage> = None;
    let image_path = if should_transcode_original {
        let image = image::load_from_memory(bytes).map_err(|e| {
            format_image_probe_error(
                "Failed to decode image source",
                e,
                bytes,
                &effective_extension,
            )
        })?;
        let png_bytes = encode_dynamic_image_as_png(&image)?;
        decoded_original = Some(image);
        persist_image_bytes(app, &png_bytes, "png")?
    } else {
        persist_image_bytes(app, bytes, &effective_extension)?
    };
    let persist_elapsed = persist_started.elapsed().as_millis();
    let longest_side = width.max(height);
    let bypass_preview = longest_side <= safe_max_dimension
        || (bytes.len() <= FAST_PREVIEW_BYPASS_MAX_BYTES
            && longest_side <= FAST_PREVIEW_BYPASS_MAX_DIMENSION);
    if bypass_preview {
        info!(
            "prepare_node_image done [{}]: bytes={}, ext={}, size={}x{}, max_preview={}, probe={}ms, decode=0ms, persist_original={}ms, resize=0ms, bypass_preview=true, total={}ms",
            trace_tag,
            bytes.len(),
            effective_extension,
            width,
            height,
            safe_max_dimension,
            probe_elapsed,
            persist_elapsed,
            started.elapsed().as_millis()
        );
        return Ok(PrepareNodeImageResult {
            image_path: image_path.clone(),
            preview_image_path: image_path,
            aspect_ratio: reduce_aspect_ratio(width, height),
        });
    }

    let decode_started = Instant::now();
    let image = match decoded_original {
        Some(image) => image,
        None => image::load_from_memory(bytes).map_err(|e| {
            format_image_probe_error(
                "Failed to decode image source",
                e,
                bytes,
                &effective_extension,
            )
        })?,
    };
    let decode_elapsed = decode_started.elapsed().as_millis();

    let resize_started = Instant::now();
    let scale = safe_max_dimension as f64 / longest_side as f64;
    let target_width = ((width as f64) * scale).round().max(1.0) as u32;
    let target_height = ((height as f64) * scale).round().max(1.0) as u32;
    let resized_rgba =
        resize_image_fast(&image, target_width, target_height).unwrap_or_else(|_| {
            image
                .resize(
                    target_width,
                    target_height,
                    image::imageops::FilterType::Triangle,
                )
                .to_rgba8()
        });
    let resized = DynamicImage::ImageRgba8(resized_rgba);

    let mut preview_buffer = Cursor::new(Vec::new());
    resized
        .write_to(&mut preview_buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode preview image: {}", e))?;
    let preview_image_path = persist_image_bytes(app, preview_buffer.get_ref(), "png")?;
    let resize_elapsed = resize_started.elapsed().as_millis();

    info!(
        "prepare_node_image done [{}]: bytes={}, ext={}, size={}x{}, max_preview={}, probe={}ms, decode={}ms, persist_original={}ms, resize={}ms, total={}ms",
        trace_tag,
        bytes.len(),
        effective_extension,
        width,
        height,
        safe_max_dimension,
        probe_elapsed,
        decode_elapsed,
        persist_elapsed,
        resize_elapsed,
        started.elapsed().as_millis()
    );

    Ok(PrepareNodeImageResult {
        image_path,
        preview_image_path,
        aspect_ratio: reduce_aspect_ratio(width, height),
    })
}

#[tauri::command]
pub async fn prepare_node_image_source(
    app: AppHandle,
    source: String,
    max_preview_dimension: Option<u32>,
) -> Result<PrepareNodeImageResult, String> {
    let started = Instant::now();
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let safe_max_dimension = max_preview_dimension.unwrap_or(512).clamp(64, 4096);
    let resolve_started = Instant::now();
    let (bytes, extension) = resolve_source_bytes(trimmed).await?;
    let resolve_elapsed = resolve_started.elapsed().as_millis();
    let result =
        prepare_node_image_from_bytes(&app, &bytes, &extension, safe_max_dimension, "source")?;
    info!(
        "prepare_node_image_source resolved: bytes={}, ext={}, resolve_source={}ms, total={}ms",
        bytes.len(),
        extension,
        resolve_elapsed,
        started.elapsed().as_millis()
    );
    Ok(result)
}

#[tauri::command]
pub async fn prepare_node_image_source_with_headers(
    app: AppHandle,
    source: String,
    headers: Option<HashMap<String, String>>,
    network: Option<MediaNetworkRouteDto>,
    max_preview_dimension: Option<u32>,
) -> Result<PrepareNodeImageResult, String> {
    let started = Instant::now();
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let safe_max_dimension = max_preview_dimension.unwrap_or(512).clamp(64, 4096);
    let resolve_started = Instant::now();
    let (bytes, extension) =
        resolve_source_bytes_with_headers(trimmed, headers.as_ref(), network.as_ref()).await?;
    let resolve_elapsed = resolve_started.elapsed().as_millis();
    let result = prepare_node_image_from_bytes(
        &app,
        &bytes,
        &extension,
        safe_max_dimension,
        "source-with-headers",
    )?;
    info!(
        "prepare_node_image_source_with_headers resolved: bytes={}, ext={}, resolve_source={}ms, total={}ms",
        bytes.len(),
        extension,
        resolve_elapsed,
        started.elapsed().as_millis()
    );
    Ok(result)
}

#[tauri::command]
pub async fn prepare_node_image_binary(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: Option<String>,
    max_preview_dimension: Option<u32>,
) -> Result<PrepareNodeImageResult, String> {
    let started = Instant::now();
    if bytes.is_empty() {
        return Err("Image bytes are empty".to_string());
    }

    let safe_max_dimension = max_preview_dimension.unwrap_or(512).clamp(64, 4096);
    let resolved_extension = extension
        .as_deref()
        .map(normalize_extension)
        .unwrap_or_else(|| "png".to_string());

    let result = prepare_node_image_from_bytes(
        &app,
        &bytes,
        &resolved_extension,
        safe_max_dimension,
        "binary",
    )?;
    info!(
        "prepare_node_image_binary resolved: bytes={}, ext={}, total={}ms",
        bytes.len(),
        resolved_extension,
        started.elapsed().as_millis()
    );
    Ok(result)
}

#[tauri::command]
pub async fn crop_image_source(
    app: AppHandle,
    payload: CropImageSourcePayload,
) -> Result<String, String> {
    let trimmed = payload.source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let source_image = load_dynamic_image_from_source(trimmed).await?;
    let source_width = source_image.width() as f64;
    let source_height = source_image.height() as f64;

    let crop_x = payload.crop_x.unwrap_or(f64::NAN);
    let crop_y = payload.crop_y.unwrap_or(f64::NAN);
    let crop_width_option = payload.crop_width.unwrap_or(f64::NAN);
    let crop_height_option = payload.crop_height.unwrap_or(f64::NAN);
    let has_manual_crop = crop_x.is_finite()
        && crop_y.is_finite()
        && crop_width_option.is_finite()
        && crop_height_option.is_finite()
        && crop_width_option > 0.0
        && crop_height_option > 0.0;

    let aspect_ratio = payload
        .aspect_ratio
        .as_deref()
        .unwrap_or("1:1")
        .trim()
        .to_string();
    let target_ratio = parse_aspect_ratio(&aspect_ratio);

    let (offset_x, offset_y, crop_width, crop_height) = if has_manual_crop {
        let safe_x = clamp_f64(crop_x.floor(), 0.0, (source_width - 1.0).max(0.0));
        let safe_y = clamp_f64(crop_y.floor(), 0.0, (source_height - 1.0).max(0.0));
        let safe_width = clamp_f64(crop_width_option.floor(), 1.0, source_width - safe_x);
        let safe_height = clamp_f64(crop_height_option.floor(), 1.0, source_height - safe_y);
        (safe_x, safe_y, safe_width, safe_height)
    } else if aspect_ratio.eq_ignore_ascii_case("free") {
        (0.0, 0.0, source_width, source_height)
    } else if let Some(ratio) = target_ratio {
        let source_ratio = source_width / source_height;
        if source_ratio > ratio {
            let width = source_height * ratio;
            ((source_width - width) / 2.0, 0.0, width, source_height)
        } else {
            let height = source_width / ratio;
            (0.0, (source_height - height) / 2.0, source_width, height)
        }
    } else {
        (0.0, 0.0, source_width, source_height)
    };

    let final_x = offset_x.floor().max(0.0) as u32;
    let final_y = offset_y.floor().max(0.0) as u32;
    let max_crop_width = source_image.width().saturating_sub(final_x).max(1);
    let max_crop_height = source_image.height().saturating_sub(final_y).max(1);
    let final_width = (crop_width.floor().max(1.0) as u32).min(max_crop_width);
    let final_height = (crop_height.floor().max(1.0) as u32).min(max_crop_height);

    let cropped = source_image.crop_imm(final_x, final_y, final_width, final_height);
    let mut buffer = Cursor::new(Vec::new());
    cropped
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode cropped image: {}", e))?;

    persist_image_bytes(&app, buffer.get_ref(), "png")
}

#[tauri::command]
pub async fn merge_storyboard_images(
    app: AppHandle,
    payload: MergeStoryboardImagesPayload,
) -> Result<MergeStoryboardImagesResult, String> {
    let started = Instant::now();
    let rows = payload.rows.max(1);
    let cols = payload.cols.max(1);
    let total_cells = rows.saturating_mul(cols) as usize;

    let mut frames: Vec<Option<DynamicImage>> = Vec::with_capacity(total_cells);
    let mut reference_size: Option<(u32, u32)> = None;

    for index in 0..total_cells {
        let source = payload
            .frame_sources
            .get(index)
            .map(|value| value.trim())
            .unwrap_or("");

        if source.is_empty() {
            frames.push(None);
            continue;
        }

        match load_dynamic_image_from_source(source).await {
            Ok(image) => {
                if reference_size.is_none() {
                    reference_size = Some((image.width().max(1), image.height().max(1)));
                }
                frames.push(Some(image));
            }
            Err(_) => {
                frames.push(None);
            }
        }
    }
    let load_done = Instant::now();

    let (source_cell_width, source_cell_height) =
        reference_size.ok_or_else(|| "没有可导出的图片".to_string())?;

    let raw_gap = payload.cell_gap.min(240);
    let raw_padding = payload.outer_padding.min(360);
    let raw_note_height = payload.note_height.min(360);
    let raw_font_size = payload.font_size.clamp(10, 240);
    let max_dimension = payload.max_dimension.clamp(1024, 8192);
    let show_frame_index = payload.show_frame_index.unwrap_or(false);
    let show_frame_note = payload.show_frame_note.unwrap_or(false);
    let note_placement = payload
        .note_placement
        .as_deref()
        .unwrap_or("overlay")
        .to_ascii_lowercase();
    let image_fit = payload
        .image_fit
        .as_deref()
        .unwrap_or("cover")
        .to_ascii_lowercase();
    let use_cover_fit = image_fit != "contain";
    let frame_index_prefix = payload
        .frame_index_prefix
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("S")
        .to_string();
    let text_color = parse_hex_color(payload.text_color.as_deref().unwrap_or("#f8fafc"));
    let frame_notes = payload.frame_notes.unwrap_or_default();
    let overlay_requested = show_frame_index || show_frame_note;

    let raw_output_width = raw_padding as u64 * 2
        + cols as u64 * source_cell_width as u64
        + cols.saturating_sub(1) as u64 * raw_gap as u64;
    let raw_output_height = raw_padding as u64 * 2
        + rows as u64 * (source_cell_height as u64 + raw_note_height as u64)
        + rows.saturating_sub(1) as u64 * raw_gap as u64;

    let longest_side = raw_output_width.max(raw_output_height).max(1) as f64;
    let scale = (max_dimension as f64 / longest_side).min(1.0);

    let cell_width = ((source_cell_width as f64) * scale).round().max(8.0) as u32;
    let cell_height = ((source_cell_height as f64) * scale).round().max(8.0) as u32;
    let gap = ((raw_gap as f64) * scale).round().max(0.0) as u32;
    let padding = ((raw_padding as f64) * scale).round().max(0.0) as u32;
    let note_height = ((raw_note_height as f64) * scale).round().max(0.0) as u32;
    let font_size = ((raw_font_size as f64) * scale).round().max(9.0) as u32;

    let output_width = padding.saturating_mul(2)
        + cols.saturating_mul(cell_width)
        + cols.saturating_sub(1).saturating_mul(gap);
    let output_height = padding.saturating_mul(2)
        + rows.saturating_mul(cell_height.saturating_add(note_height))
        + rows.saturating_sub(1).saturating_mul(gap);

    let mut canvas = RgbaImage::from_pixel(
        output_width.max(1),
        output_height.max(1),
        parse_hex_color(&payload.background_color),
    );
    let placeholder = Rgba([0, 0, 0, 90]);
    let border = Rgba([255, 255, 255, 56]);
    let overlay_font = if overlay_requested {
        load_overlay_font()
    } else {
        None
    };
    let overlay_scale = PxScale::from(font_size.max(9) as f32);
    let text_overlay_applied = !overlay_requested || overlay_font.is_some();

    for index in 0..total_cells {
        let row = (index as u32) / cols;
        let col = (index as u32) % cols;
        let x = padding + col.saturating_mul(cell_width.saturating_add(gap));
        let y = padding
            + row.saturating_mul(cell_height.saturating_add(note_height).saturating_add(gap));

        fill_rect(&mut canvas, x, y, cell_width, cell_height, placeholder);

        if let Some(frame) = frames.get(index).and_then(|item| item.as_ref()) {
            let src_w = frame.width().max(1) as f64;
            let src_h = frame.height().max(1) as f64;
            let ratio = if use_cover_fit {
                ((cell_width as f64) / src_w).max((cell_height as f64) / src_h)
            } else {
                ((cell_width as f64) / src_w).min((cell_height as f64) / src_h)
            };
            let draw_w = (src_w * ratio).round().max(1.0) as u32;
            let draw_h = (src_h * ratio).round().max(1.0) as u32;

            let mut cell_canvas =
                RgbaImage::from_pixel(cell_width.max(1), cell_height.max(1), placeholder);
            let draw_x = (cell_width as i64 - draw_w as i64) / 2;
            let draw_y = (cell_height as i64 - draw_h as i64) / 2;

            if draw_w == frame.width() && draw_h == frame.height() {
                image::imageops::overlay(&mut cell_canvas, &frame.to_rgba8(), draw_x, draw_y);
            } else if let Ok(resized_rgba) = resize_image_fast(frame, draw_w, draw_h) {
                image::imageops::overlay(&mut cell_canvas, &resized_rgba, draw_x, draw_y);
            } else {
                // Fallback path keeps behavior correct if SIMD resize fails for unexpected input.
                let resized = frame.resize(draw_w, draw_h, image::imageops::FilterType::Triangle);
                image::imageops::overlay(&mut cell_canvas, &resized.to_rgba8(), draw_x, draw_y);
            }

            image::imageops::overlay(&mut canvas, &cell_canvas, x as i64, y as i64);
        }

        // Keep only internal split lines; do not draw an outer frame around the whole storyboard.
        if col < cols.saturating_sub(1) {
            stroke_right_edge(&mut canvas, x, y, cell_width, cell_height, border);
        }
        if row < rows.saturating_sub(1) {
            stroke_bottom_edge(&mut canvas, x, y, cell_width, cell_height, border);
        }

        if let Some(font) = overlay_font {
            if show_frame_index {
                let label = format!("{}{}", frame_index_prefix, index + 1);
                let (label_w, label_h) = text_size(overlay_scale, font, &label);
                let badge_padding_x = (font_size as f32 * 0.35).round().max(6.0) as u32;
                let badge_height = (font_size as f32 * 1.15).round().max(18.0) as u32;
                let badge_width = label_w.saturating_add(badge_padding_x.saturating_mul(2));
                let badge_x = x.saturating_add(6);
                let badge_y = y.saturating_add(6);

                fill_rect_alpha_blend(
                    &mut canvas,
                    badge_x,
                    badge_y,
                    badge_width,
                    badge_height,
                    Rgba([0, 0, 0, 166]),
                );

                let text_x = badge_x.saturating_add(badge_padding_x) as i32;
                let text_y = badge_y
                    .saturating_add(badge_height.saturating_sub(label_h) / 2)
                    .max(0) as i32;
                draw_text_mut(
                    &mut canvas,
                    text_color,
                    text_x,
                    text_y,
                    overlay_scale,
                    font,
                    &label,
                );
            }

            if show_frame_note {
                let note_raw = frame_notes
                    .get(index)
                    .map(|value| value.trim())
                    .unwrap_or("");
                if !note_raw.is_empty() {
                    let note = trim_text_to_width(
                        font,
                        overlay_scale,
                        note_raw,
                        cell_width.saturating_sub(14),
                    );
                    if !note.is_empty() {
                        let (note_w, note_h) = text_size(overlay_scale, font, &note);
                        if note_placement == "bottom" && note_height > 0 {
                            let note_x = x.saturating_add(4) as i32;
                            let note_y = y
                                .saturating_add(cell_height)
                                .saturating_add(note_height.saturating_sub(note_h) / 2)
                                .max(0) as i32;
                            let _ = note_w;
                            draw_text_mut(
                                &mut canvas,
                                text_color,
                                note_x,
                                note_y,
                                overlay_scale,
                                font,
                                &note,
                            );
                        } else {
                            let overlay_height = (font_size as f32 * 1.35).round().max(18.0) as u32;
                            let overlay_y =
                                y.saturating_add(cell_height).saturating_sub(overlay_height);
                            fill_rect_alpha_blend(
                                &mut canvas,
                                x,
                                overlay_y,
                                cell_width,
                                overlay_height,
                                Rgba([0, 0, 0, 153]),
                            );
                            let note_x = x.saturating_add(7) as i32;
                            let note_y = overlay_y
                                .saturating_add(overlay_height.saturating_sub(note_h) / 2)
                                .max(0) as i32;
                            draw_text_mut(
                                &mut canvas,
                                text_color,
                                note_x,
                                note_y,
                                overlay_scale,
                                font,
                                &note,
                            );
                        }
                    }
                }
            }
        }
    }

    let mut buffer = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(canvas)
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode merged storyboard image: {}", e))?;

    let image_path = persist_image_bytes(&app, buffer.get_ref(), "png")?;
    info!(
        "merge_storyboard_images done: {} cells, load={}ms, total={}ms, text_overlay_applied={}",
        total_cells,
        load_done.duration_since(started).as_millis(),
        started.elapsed().as_millis(),
        text_overlay_applied
    );

    Ok(MergeStoryboardImagesResult {
        image_path,
        canvas_width: output_width.max(1),
        canvas_height: output_height.max(1),
        cell_width,
        cell_height,
        gap,
        padding,
        note_height,
        font_size,
        text_overlay_applied,
    })
}

fn resolve_images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    let images_dir = app_data_dir.join("images");
    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Failed to create images dir: {}", e))?;

    Ok(images_dir)
}

fn resolve_generated_media_counters_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data_dir.join(GENERATED_MEDIA_COUNTERS_FILE_NAME))
}

fn read_generated_media_counters(app: &AppHandle) -> Result<GeneratedMediaCounters, String> {
    let counters_path = resolve_generated_media_counters_path(app)?;
    if !counters_path.exists() {
        return Ok(GeneratedMediaCounters::default());
    }

    let content = std::fs::read_to_string(&counters_path)
        .map_err(|e| format!("Failed to read generated media counters: {}", e))?;
    serde_json::from_str::<GeneratedMediaCounters>(&content)
        .map_err(|e| format!("Failed to parse generated media counters: {}", e))
}

fn write_generated_media_counters(
    app: &AppHandle,
    counters: &GeneratedMediaCounters,
) -> Result<(), String> {
    let counters_path = resolve_generated_media_counters_path(app)?;
    let content = serde_json::to_string_pretty(counters)
        .map_err(|e| format!("Failed to serialize generated media counters: {}", e))?;
    std::fs::write(counters_path, content)
        .map_err(|e| format!("Failed to write generated media counters: {}", e))?;
    Ok(())
}

fn resolve_local_media_kind(raw: &str) -> Result<LocalMediaKind, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "image" => Ok(LocalMediaKind::Image),
        "video" => Ok(LocalMediaKind::Video),
        other => Err(format!("Unsupported media kind: {}", other)),
    }
}

fn utc_date_from_unix_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };

    (year, month as u32, day as u32)
}

fn current_utc_date_stamp() -> Result<String, String> {
    let days_since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to resolve current time: {}", e))?
        .as_secs()
        / 86_400;
    let (year, month, day) = utc_date_from_unix_days(days_since_epoch as i64);
    Ok(format!("{:04}{:02}{:02}", year, month, day))
}

fn next_generated_media_file_stem(
    app: &AppHandle,
    media_kind: LocalMediaKind,
) -> Result<String, String> {
    let mut counters = read_generated_media_counters(app).unwrap_or_default();
    let today = current_utc_date_stamp()?;
    let sequence = {
        let counter = match media_kind {
            LocalMediaKind::Image => &mut counters.image,
            LocalMediaKind::Video => &mut counters.video,
        };

        if counter.date == today {
            counter.sequence = counter.sequence.saturating_add(1);
        } else {
            counter.date = today.clone();
            counter.sequence = 1;
        }

        counter.sequence
    };

    write_generated_media_counters(app, &counters)?;

    let prefix = match media_kind {
        LocalMediaKind::Image => "genimg",
        LocalMediaKind::Video => "genvideo",
    };

    Ok(format!("{}_{}_{:04}", prefix, today, sequence))
}

fn sanitize_requested_file_stem(raw: &str, fallback: &str) -> String {
    let stem_candidate = Path::new(raw)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(raw);
    let sanitized = sanitize_file_stem(stem_candidate);
    if sanitized == "storyboard-image" {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn persist_image_bytes(app: &AppHandle, bytes: &[u8], extension: &str) -> Result<String, String> {
    let images_dir = resolve_images_dir(app)?;
    let digest = md5::compute(bytes);
    let filename = format!("{:x}.{}", digest, normalize_extension(extension));
    let output_path = images_dir.join(filename);

    if !output_path.exists() {
        std::fs::write(&output_path, bytes)
            .map_err(|e| format!("Failed to persist generated image: {}", e))?;
    }

    Ok(output_path.to_string_lossy().to_string())
}

fn resolve_videos_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    let videos_dir = app_data_dir.join("videos");
    std::fs::create_dir_all(&videos_dir)
        .map_err(|e| format!("Failed to create videos dir: {}", e))?;

    Ok(videos_dir)
}

fn normalize_video_extension(raw_ext: &str) -> String {
    let ext = raw_ext.trim().trim_start_matches('.').to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "webm" | "mov" | "m4v" | "avi" | "mkv" | "mpeg" | "mpg" | "3gp" | "3gpp" => ext,
        _ => "mp4".to_string(),
    }
}

fn normalize_audio_extension(raw_ext: &str) -> String {
    let ext = raw_ext.trim().trim_start_matches('.').to_ascii_lowercase();
    match ext.as_str() {
        "mp3" | "wav" | "m4a" | "aac" | "ogg" | "opus" | "flac" | "webm" => ext,
        "mpeg" => "mp3".to_string(),
        "x-wav" | "wave" => "wav".to_string(),
        _ => "wav".to_string(),
    }
}

fn audio_mime_from_extension(extension: &str) -> &'static str {
    match normalize_audio_extension(extension).as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "webm" => "audio/webm",
        _ => "audio/wav",
    }
}

fn canonical_local_media_path(
    path: &Path,
    media_dir: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    let canonical_path = std::fs::canonicalize(path)
        .map_err(|e| format!("Failed to resolve {} path {}: {}", label, path.display(), e))?;
    let canonical_media_dir = std::fs::canonicalize(media_dir).map_err(|e| {
        format!(
            "Failed to resolve local media directory {}: {}",
            media_dir.display(),
            e
        )
    })?;
    if !canonical_path.starts_with(&canonical_media_dir) {
        return Err(format!(
            "{} path is outside the local media directory: {}",
            label,
            canonical_path.display()
        ));
    }
    Ok(canonical_path)
}

fn is_content_hash_media_path(path: &Path) -> bool {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(|stem| stem.len() == 32 && stem.chars().all(|ch| ch.is_ascii_hexdigit()))
        .unwrap_or(false)
}

fn rename_local_file_to_stem(path: &Path, target_stem: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path has no parent directory: {}", path.display()))?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let candidate = if extension.is_empty() {
        parent.join(target_stem)
    } else {
        parent.join(format!("{}.{}", target_stem, extension))
    };

    if candidate == path {
        return Ok(path.to_path_buf());
    }

    let output_path = ensure_unique_path(candidate);
    if is_content_hash_media_path(path) {
        std::fs::copy(path, &output_path).map_err(|e| {
            format!(
                "Failed to copy local media file from {} to {}: {}",
                path.display(),
                output_path.display(),
                e
            )
        })?;
    } else {
        std::fs::rename(path, &output_path).map_err(|e| {
            format!(
                "Failed to rename local media file from {} to {}: {}",
                path.display(),
                output_path.display(),
                e
            )
        })?;
    }
    Ok(output_path)
}

fn persist_video_bytes(app: &AppHandle, bytes: &[u8], extension: &str) -> Result<String, String> {
    let videos_dir = resolve_videos_dir(app)?;
    let digest = md5::compute(bytes);
    let filename = format!("{:x}.{}", digest, normalize_video_extension(extension));
    let output_path = videos_dir.join(filename);

    if !output_path.exists() {
        std::fs::write(&output_path, bytes)
            .map_err(|e| format!("Failed to persist generated video: {}", e))?;
    }

    Ok(output_path.to_string_lossy().to_string())
}

fn normalize_extension(raw_ext: &str) -> String {
    let ext = raw_ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if ext.is_empty() {
        return "png".to_string();
    }

    if ext == "jpeg" {
        return "jpg".to_string();
    }

    ext
}

fn extension_from_image_format(format: Option<ImageFormat>) -> Option<String> {
    let ext = match format? {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Gif => "gif",
        ImageFormat::WebP => "webp",
        ImageFormat::Pnm => "pnm",
        ImageFormat::Tiff => "tiff",
        ImageFormat::Tga => "tga",
        ImageFormat::Dds => "dds",
        ImageFormat::Bmp => "bmp",
        ImageFormat::Ico => "ico",
        ImageFormat::Hdr => "hdr",
        ImageFormat::OpenExr => "exr",
        ImageFormat::Farbfeld => "ff",
        ImageFormat::Avif => "avif",
        ImageFormat::Qoi => "qoi",
        _ => return None,
    };
    Some(ext.to_string())
}

fn extension_from_mime(mime: &str) -> String {
    let normalized = mime
        .split(';')
        .next()
        .unwrap_or(mime)
        .trim()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "image/png" => "png".to_string(),
        "image/jpeg" => "jpg".to_string(),
        "image/jpg" => "jpg".to_string(),
        "image/webp" => "webp".to_string(),
        "image/gif" => "gif".to_string(),
        "image/bmp" => "bmp".to_string(),
        "image/avif" => "avif".to_string(),
        "video/mp4" => "mp4".to_string(),
        "video/webm" => "webm".to_string(),
        "video/quicktime" => "mov".to_string(),
        "video/x-m4v" => "m4v".to_string(),
        "video/x-msvideo" => "avi".to_string(),
        "video/x-matroska" => "mkv".to_string(),
        "video/mpeg" => "mpg".to_string(),
        "audio/mpeg" | "audio/mp3" => "mp3".to_string(),
        "audio/wav" | "audio/wave" | "audio/x-wav" => "wav".to_string(),
        "audio/mp4" | "audio/x-m4a" => "m4a".to_string(),
        "audio/aac" => "aac".to_string(),
        "audio/ogg" => "ogg".to_string(),
        "audio/opus" => "opus".to_string(),
        "audio/flac" | "audio/x-flac" => "flac".to_string(),
        "audio/webm" => "webm".to_string(),
        _ => "png".to_string(),
    }
}

fn extension_from_video_mime(mime: &str) -> Option<String> {
    let normalized = mime
        .split(';')
        .next()
        .unwrap_or(mime)
        .trim()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "video/mp4" => Some("mp4".to_string()),
        "video/webm" => Some("webm".to_string()),
        "video/quicktime" => Some("mov".to_string()),
        "video/x-m4v" => Some("m4v".to_string()),
        "video/x-msvideo" => Some("avi".to_string()),
        "video/x-matroska" => Some("mkv".to_string()),
        "video/mpeg" => Some("mpg".to_string()),
        "video/3gpp" => Some("3gp".to_string()),
        "video/3gpp2" => Some("3gpp".to_string()),
        "application/octet-stream" => None,
        _ => None,
    }
}

fn extension_from_audio_mime(mime: &str) -> Option<String> {
    let normalized = mime
        .split(';')
        .next()
        .unwrap_or(mime)
        .trim()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "audio/mpeg" | "audio/mp3" => Some("mp3".to_string()),
        "audio/wav" | "audio/wave" | "audio/x-wav" => Some("wav".to_string()),
        "audio/mp4" | "audio/x-m4a" => Some("m4a".to_string()),
        "audio/aac" => Some("aac".to_string()),
        "audio/ogg" => Some("ogg".to_string()),
        "audio/opus" => Some("opus".to_string()),
        "audio/flac" | "audio/x-flac" => Some("flac".to_string()),
        "audio/webm" => Some("webm".to_string()),
        "application/octet-stream" => None,
        _ => None,
    }
}

fn encode_dynamic_image_as_png(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut buffer = Cursor::new(Vec::new());
    image
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode image as PNG: {}", e))?;
    Ok(buffer.into_inner())
}

fn system_clipboard_image_from_png_bytes(bytes: Vec<u8>) -> SystemClipboardImage {
    SystemClipboardImage {
        bytes,
        mime_type: "image/png".to_string(),
        file_name: "pasted-image.png".to_string(),
    }
}

fn arboard_image_to_system_clipboard_image(
    image_data: ImageData<'_>,
) -> Result<SystemClipboardImage, String> {
    let width = image_data.width as u32;
    let height = image_data.height as u32;
    let pixels = image_data.bytes.into_owned();
    let rgba_image = RgbaImage::from_raw(width, height, pixels)
        .ok_or_else(|| "Failed to decode clipboard image pixels".to_string())?;
    let bytes = encode_dynamic_image_as_png(&DynamicImage::ImageRgba8(rgba_image))?;
    Ok(system_clipboard_image_from_png_bytes(bytes))
}

fn decode_clipboard_encoded_image_as_png(
    bytes: &[u8],
    format: ImageFormat,
) -> Result<Vec<u8>, String> {
    if bytes.is_empty() {
        return Err("Clipboard image payload is empty".to_string());
    }
    let image = image::load_from_memory_with_format(bytes, format)
        .map_err(|e| format!("Failed to decode clipboard image payload: {}", e))?;
    encode_dynamic_image_as_png(&image)
}

#[cfg(target_os = "macos")]
fn read_macos_pasteboard_encoded_image() -> Option<SystemClipboardImage> {
    let pasteboard = NSPasteboard::generalPasteboard();

    if let Some(data) = pasteboard.dataForType(unsafe { NSPasteboardTypePNG }) {
        let bytes = data.to_vec();
        if decode_clipboard_encoded_image_as_png(&bytes, ImageFormat::Png).is_ok() {
            return Some(system_clipboard_image_from_png_bytes(bytes));
        }
    }

    if let Some(data) = pasteboard.dataForType(unsafe { NSPasteboardTypeTIFF }) {
        let bytes = data.to_vec();
        if let Ok(png_bytes) = decode_clipboard_encoded_image_as_png(&bytes, ImageFormat::Tiff) {
            return Some(system_clipboard_image_from_png_bytes(png_bytes));
        }
    }

    None
}

#[cfg(not(target_os = "macos"))]
fn read_macos_pasteboard_encoded_image() -> Option<SystemClipboardImage> {
    None
}

fn compact_text_preview(value: &str, max_chars: usize) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        collapsed
    } else {
        let preview: String = collapsed.chars().take(max_chars).collect();
        format!("{}...", preview)
    }
}

fn bytes_text_preview(bytes: &[u8], max_chars: usize) -> Option<String> {
    let sample_len = bytes.len().min(4096);
    let sample = &bytes[..sample_len];
    let text = std::str::from_utf8(sample).ok()?;
    Some(compact_text_preview(text, max_chars))
}

fn format_image_probe_error(
    label: &str,
    error: impl std::fmt::Display,
    bytes: &[u8],
    extension: &str,
) -> String {
    let mut message = format!(
        "{}: {} (ext={}, bytes={})",
        label,
        error,
        normalize_extension(extension),
        bytes.len()
    );
    if let Some(preview) = bytes_text_preview(bytes, 240) {
        if looks_like_json_text(&preview) {
            message.push_str(&format!("; body looks like JSON: {}", preview));
        } else if looks_like_html_text(&preview) {
            message.push_str(&format!("; body looks like HTML/error page: {}", preview));
        } else if looks_like_textual_error(&preview) {
            message.push_str(&format!("; text preview: {}", preview));
        }
    }
    message
}

fn extension_from_path_like(value: &str) -> Option<String> {
    let cleaned = value
        .split('#')
        .next()
        .unwrap_or(value)
        .split('?')
        .next()
        .unwrap_or(value);
    let ext = Path::new(cleaned)
        .extension()
        .and_then(|item| item.to_str())
        .map(normalize_extension)?;

    Some(ext)
}

fn decode_file_url_path(value: &str) -> String {
    let raw = value.trim_start_matches("file://");
    let decoded = urlencoding::decode(raw)
        .map(|result| result.into_owned())
        .unwrap_or_else(|_| raw.to_string());

    if cfg!(target_os = "windows")
        && decoded.starts_with('/')
        && decoded.len() > 2
        && decoded.as_bytes().get(2) == Some(&b':')
    {
        decoded[1..].to_string()
    } else {
        decoded
    }
}

fn normalize_user_selected_path(value: &str) -> String {
    let trimmed = value.trim().trim_matches('"').trim_matches('\'').trim();
    if trimmed.to_ascii_lowercase().starts_with("file://") {
        decode_file_url_path(trimmed)
    } else {
        trimmed.to_string()
    }
}

fn looks_like_json_text(value: &str) -> bool {
    let trimmed = value.trim_start_matches('\u{feff}').trim_start();
    trimmed.starts_with('{') || trimmed.starts_with('[')
}

fn looks_like_html_text(value: &str) -> bool {
    let trimmed = value
        .trim_start_matches('\u{feff}')
        .trim_start()
        .to_ascii_lowercase();
    trimmed.starts_with("<!doctype html")
        || trimmed.starts_with("<html")
        || trimmed.starts_with("<head")
        || trimmed.starts_with("<body")
}

fn looks_like_textual_error(value: &str) -> bool {
    let trimmed = value.trim_start_matches('\u{feff}').trim_start();
    if trimmed.is_empty() {
        return false;
    }
    let printable = trimmed
        .chars()
        .take(240)
        .filter(|ch| !ch.is_control() || ch.is_whitespace())
        .count();
    printable >= trimmed.chars().take(240).count().saturating_sub(4)
}

fn content_type_primary(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim()
        .to_ascii_lowercase()
}

fn content_type_is_textual_non_image(content_type: &str) -> bool {
    let primary = content_type_primary(content_type);
    primary == "application/json"
        || primary == "application/problem+json"
        || primary.ends_with("+json")
        || primary == "text/html"
        || primary == "application/xhtml+xml"
        || primary.starts_with("text/")
}

fn remote_media_content_error(
    media_kind: &str,
    content_type: &str,
    bytes: &[u8],
) -> Option<String> {
    if media_kind == "image" && extract_wrapped_image_source_from_bytes(bytes).is_some() {
        return None;
    }
    let textual_preview = bytes_text_preview(bytes, 120);
    let is_textual_error = content_type_is_textual_non_image(content_type)
        || textual_preview
            .as_deref()
            .map(|preview| {
                looks_like_json_text(preview)
                    || looks_like_html_text(preview)
                    || looks_like_textual_error(preview)
            })
            .unwrap_or(false);
    if !is_textual_error {
        if media_kind == "image" {
            let image_probe = ImageReader::new(Cursor::new(bytes))
                .with_guessed_format()
                .map_err(|_| ())
                .and_then(|reader| reader.into_dimensions().map_err(|_| ()));
            if image_probe.is_err() {
                return Some(format!(
                    "Remote result did not return decodable image bytes (content-type={}, bytes={})",
                    content_type,
                    bytes.len()
                ));
            }
        }
        return None;
    }
    Some(match media_kind {
        "video" => describe_non_video_remote_body(content_type, bytes),
        "audio" => describe_non_audio_remote_body(content_type, bytes),
        _ => describe_non_image_remote_body(content_type, bytes),
    })
}

fn describe_non_image_remote_body(content_type: &str, bytes: &[u8]) -> String {
    format!(
        "Remote result did not return image bytes (content-type={}, bytes={})",
        content_type,
        bytes.len()
    )
}

fn describe_non_video_remote_body(content_type: &str, bytes: &[u8]) -> String {
    format!(
        "Remote result did not return video bytes (content-type={}, bytes={})",
        content_type,
        bytes.len()
    )
}

fn describe_non_audio_remote_body(content_type: &str, bytes: &[u8]) -> String {
    format!(
        "Remote result did not return audio bytes (content-type={}, bytes={})",
        content_type,
        bytes.len()
    )
}

async fn resolve_video_source_bytes_with_headers(
    source: &str,
    headers: Option<&HashMap<String, String>>,
    network: Option<&MediaNetworkRouteDto>,
) -> Result<(Vec<u8>, String), String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Video source is empty".to_string());
    }

    if trimmed.starts_with("data:") {
        let (bytes, extension) = parse_data_url(trimmed)?;
        return Ok((bytes, normalize_video_extension(&extension)));
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let download = download_remote_media_bytes(
            trimmed,
            headers,
            "video/mp4,video/webm,video/quicktime,video/*,*/*;q=0.8",
            "video",
            network,
        )
        .await?;
        let content_type = download.content_type;
        let mime_ext = extension_from_video_mime(&content_type);
        let bytes = download.bytes;

        if content_type_is_textual_non_image(&content_type)
            || bytes_text_preview(&bytes, 120)
                .map(|preview| looks_like_json_text(&preview) || looks_like_html_text(&preview))
                .unwrap_or(false)
        {
            return Err(describe_non_video_remote_body(&content_type, &bytes));
        }

        let ext = mime_ext
            .or_else(|| extension_from_path_like(trimmed))
            .map(|value| normalize_video_extension(&value))
            .unwrap_or_else(|| "mp4".to_string());

        return Ok((bytes, ext));
    }

    if trimmed.starts_with("file://") {
        let file_path = decode_file_url_path(trimmed);
        let local_path = PathBuf::from(file_path);
        let bytes = std::fs::read(&local_path)
            .map_err(|e| format!("Failed to read file:// video source: {}", e))?;
        let ext = local_path
            .extension()
            .and_then(|value| value.to_str())
            .map(normalize_video_extension)
            .unwrap_or_else(|| "mp4".to_string());
        return Ok((bytes, ext));
    }

    let local_path = PathBuf::from(trimmed);
    let bytes = std::fs::read(&local_path)
        .map_err(|e| format!("Failed to read local video source: {}", e))?;
    let ext = local_path
        .extension()
        .and_then(|value| value.to_str())
        .map(normalize_video_extension)
        .unwrap_or_else(|| "mp4".to_string());
    Ok((bytes, ext))
}

async fn resolve_audio_source_bytes(source: &str) -> Result<(Vec<u8>, String), String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Audio source is empty".to_string());
    }

    if trimmed.starts_with("data:") {
        let (bytes, extension) = parse_data_url(trimmed)?;
        return Ok((bytes, normalize_audio_extension(&extension)));
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let download = download_remote_media_bytes(
            trimmed,
            None,
            "audio/mpeg,audio/wav,audio/ogg,audio/webm,audio/*,*/*;q=0.8",
            "audio",
            None,
        )
        .await?;
        let content_type = download.content_type;
        let mime_ext = extension_from_audio_mime(&content_type);
        let bytes = download.bytes;

        if content_type_is_textual_non_image(&content_type)
            || bytes_text_preview(&bytes, 120)
                .map(|preview| looks_like_json_text(&preview) || looks_like_html_text(&preview))
                .unwrap_or(false)
        {
            return Err(describe_non_audio_remote_body(&content_type, &bytes));
        }

        let ext = mime_ext
            .or_else(|| extension_from_path_like(trimmed))
            .map(|value| normalize_audio_extension(&value))
            .unwrap_or_else(|| "wav".to_string());

        return Ok((bytes, ext));
    }

    if trimmed.starts_with("file://") {
        let file_path = decode_file_url_path(trimmed);
        let local_path = PathBuf::from(file_path);
        let bytes = std::fs::read(&local_path)
            .map_err(|e| format!("Failed to read file:// audio source: {}", e))?;
        let ext = local_path
            .extension()
            .and_then(|value| value.to_str())
            .map(normalize_audio_extension)
            .unwrap_or_else(|| "wav".to_string());
        return Ok((bytes, ext));
    }

    let local_path = PathBuf::from(trimmed);
    let bytes = std::fs::read(&local_path)
        .map_err(|e| format!("Failed to read local audio source: {}", e))?;
    let ext = local_path
        .extension()
        .and_then(|value| value.to_str())
        .map(normalize_audio_extension)
        .unwrap_or_else(|| "wav".to_string());
    Ok((bytes, ext))
}

fn is_likely_non_image_result_key(key_path: &str) -> bool {
    let key = key_path.to_ascii_lowercase();
    key.contains("page_url")
        || key.contains("pageurl")
        || key.contains("web_url")
        || key.contains("weburl")
        || key.contains("request_url")
        || key.contains("requesturl")
        || key.contains("status_url")
        || key.contains("statusurl")
        || key.contains("poll_url")
        || key.contains("pollurl")
        || key.contains("callback")
        || key.contains("webhook")
        || key.contains("submit_url")
        || key.contains("queue_url")
        || key.contains("endpoint")
}

fn is_likely_image_result_key(key_path: &str) -> bool {
    let key = key_path.to_ascii_lowercase();
    key.contains("image")
        || key.contains("img")
        || key.contains("url")
        || key.contains("output")
        || key.contains("result")
        || key.contains("asset")
        || key.contains("file")
        || key.contains("media")
        || key.contains("b64")
        || key.contains("base64")
        || key.contains("data")
}

fn value_has_image_extension(value: &str) -> bool {
    let cleaned = value
        .split('#')
        .next()
        .unwrap_or(value)
        .split('?')
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase();
    [
        "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "tif", "tiff",
    ]
    .iter()
    .any(|ext| cleaned.ends_with(&format!(".{}", ext)))
}

fn looks_like_base64_image_payload(value: &str) -> bool {
    let compact: String = value.chars().filter(|ch| !ch.is_whitespace()).collect();
    compact.len() > 300
        && compact
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/' || ch == '=')
}

fn normalize_wrapped_image_source_candidate(value: &str, key_path: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("data:image/") {
        return Some(trimmed.to_string());
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        if !is_likely_non_image_result_key(key_path)
            && (value_has_image_extension(trimmed) || is_likely_image_result_key(key_path))
        {
            return Some(trimmed.to_string());
        }
        return None;
    }
    if looks_like_base64_image_payload(trimmed) && is_likely_image_result_key(key_path) {
        let compact: String = trimmed.chars().filter(|ch| !ch.is_whitespace()).collect();
        return Some(format!("data:image/png;base64,{}", compact));
    }
    None
}

fn extract_wrapped_image_source_from_json(
    value: &serde_json::Value,
    key_path: &str,
    depth: usize,
) -> Option<String> {
    if depth > 8 {
        return None;
    }
    match value {
        serde_json::Value::String(text) => {
            if let Some(candidate) = normalize_wrapped_image_source_candidate(text, key_path) {
                return Some(candidate);
            }
            let trimmed = text.trim();
            if looks_like_json_text(trimmed) {
                if let Ok(nested) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    return extract_wrapped_image_source_from_json(&nested, key_path, depth + 1);
                }
            }
            None
        }
        serde_json::Value::Array(items) => items.iter().enumerate().find_map(|(index, item)| {
            let child_path = if key_path.is_empty() {
                index.to_string()
            } else {
                format!("{}.{}", key_path, index)
            };
            extract_wrapped_image_source_from_json(item, &child_path, depth + 1)
        }),
        serde_json::Value::Object(map) => map.iter().find_map(|(key, item)| {
            let child_path = if key_path.is_empty() {
                key.to_string()
            } else {
                format!("{}.{}", key_path, key)
            };
            extract_wrapped_image_source_from_json(item, &child_path, depth + 1)
        }),
        _ => None,
    }
}

fn extract_wrapped_image_source_from_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if let Some(candidate) = normalize_wrapped_image_source_candidate(trimmed, "image") {
        return Some(candidate);
    }
    if looks_like_base64_image_payload(trimmed) {
        let compact: String = trimmed.chars().filter(|ch| !ch.is_whitespace()).collect();
        return Some(format!("data:image/png;base64,{}", compact));
    }
    if looks_like_json_text(trimmed) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
            return extract_wrapped_image_source_from_json(&parsed, "", 0);
        }
    }
    None
}

fn extract_wrapped_image_source_from_bytes(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    extract_wrapped_image_source_from_text(text)
}

fn parse_data_url(source: &str) -> Result<(Vec<u8>, String), String> {
    let (meta, payload) = source
        .split_once(',')
        .ok_or_else(|| "Invalid data URL format".to_string())?;

    if !meta.starts_with("data:") || !meta.ends_with(";base64") {
        return Err("Only base64 data URL is supported".to_string());
    }

    let mime = meta
        .strip_prefix("data:")
        .and_then(|v| v.strip_suffix(";base64"))
        .unwrap_or("image/png");

    let bytes = STANDARD
        .decode(payload)
        .map_err(|e| format!("Failed to decode data URL: {}", e))?;

    Ok((bytes, extension_from_mime(mime)))
}

fn read_storyboard_metadata_from_png_bytes(
    bytes: &[u8],
) -> Result<Option<StoryboardImageMetadata>, String> {
    let decoder = Decoder::new(Cursor::new(bytes));
    let reader = decoder
        .read_info()
        .map_err(|e| format!("Failed to decode PNG metadata: {}", e))?;
    let info = reader.info();

    for text_chunk in &info.uncompressed_latin1_text {
        if text_chunk.keyword == STORYBOARD_METADATA_PNG_TEXT_KEY {
            let parsed = serde_json::from_str::<StoryboardImageMetadata>(&text_chunk.text)
                .map_err(|e| format!("Invalid storyboard metadata JSON: {}", e))?;
            return Ok(Some(parsed));
        }
    }

    for text_chunk in &info.utf8_text {
        if text_chunk.keyword == STORYBOARD_METADATA_PNG_TEXT_KEY {
            let text = text_chunk
                .get_text()
                .map_err(|e| format!("Failed to decode iTXt metadata text: {}", e))?;
            let parsed = serde_json::from_str::<StoryboardImageMetadata>(&text)
                .map_err(|e| format!("Invalid storyboard metadata JSON: {}", e))?;
            return Ok(Some(parsed));
        }
    }

    for text_chunk in &info.compressed_latin1_text {
        if text_chunk.keyword == STORYBOARD_METADATA_PNG_TEXT_KEY {
            let text = text_chunk
                .get_text()
                .map_err(|e| format!("Failed to decode zTXt metadata text: {}", e))?;
            let parsed = serde_json::from_str::<StoryboardImageMetadata>(&text)
                .map_err(|e| format!("Invalid storyboard metadata JSON: {}", e))?;
            return Ok(Some(parsed));
        }
    }

    Ok(None)
}

fn encode_png_with_storyboard_metadata(
    image: &DynamicImage,
    metadata: &StoryboardImageMetadata,
) -> Result<Vec<u8>, String> {
    let metadata_json = serde_json::to_string(metadata)
        .map_err(|e| format!("Failed to serialize storyboard metadata: {}", e))?;
    let rgba = image.to_rgba8();
    let width = rgba.width().max(1);
    let height = rgba.height().max(1);
    let mut output = Vec::new();

    {
        let mut encoder = Encoder::new(&mut output, width, height);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        encoder
            .add_itxt_chunk(STORYBOARD_METADATA_PNG_TEXT_KEY.to_string(), metadata_json)
            .map_err(|e| format!("Failed to attach storyboard metadata into PNG: {}", e))?;
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("Failed to write PNG header: {}", e))?;
        writer
            .write_image_data(rgba.as_raw())
            .map_err(|e| format!("Failed to encode PNG pixels: {}", e))?;
    }

    Ok(output)
}

async fn resolve_source_bytes(source: &str) -> Result<(Vec<u8>, String), String> {
    resolve_source_bytes_with_headers(source, None, None).await
}

fn should_forward_remote_image_header(key: &str) -> bool {
    !key.eq_ignore_ascii_case("accept-encoding")
}

async fn resolve_source_bytes_with_headers(
    source: &str,
    headers: Option<&HashMap<String, String>>,
    network: Option<&MediaNetworkRouteDto>,
) -> Result<(Vec<u8>, String), String> {
    let mut current_source = source.trim().to_string();
    let mut unwrap_count = 0usize;

    'resolve_source: loop {
        if current_source.starts_with("data:") {
            return parse_data_url(&current_source);
        }

        if let Some(unwrapped_source) = extract_wrapped_image_source_from_text(&current_source) {
            if unwrapped_source != current_source && unwrap_count < 3 {
                unwrap_count += 1;
                current_source = unwrapped_source;
                continue;
            }
        }

        if current_source.starts_with("http://") || current_source.starts_with("https://") {
            let download = download_remote_media_bytes(
                &current_source,
                headers,
                "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
                "image",
                network,
            )
            .await?;
            let content_type = download.content_type;
            let mime_ext = if content_type == "unknown" {
                None
            } else {
                Some(extension_from_mime(&content_type))
            };
            let bytes = download.bytes;

            if unwrap_count < 3 {
                if let Some(unwrapped_source) = extract_wrapped_image_source_from_bytes(&bytes) {
                    unwrap_count += 1;
                    current_source = unwrapped_source;
                    continue 'resolve_source;
                }
            }

            if content_type_is_textual_non_image(&content_type)
                || bytes_text_preview(&bytes, 120)
                    .map(|preview| looks_like_json_text(&preview) || looks_like_html_text(&preview))
                    .unwrap_or(false)
            {
                return Err(describe_non_image_remote_body(&content_type, &bytes));
            }

            let ext = mime_ext
                .or_else(|| extension_from_path_like(&current_source))
                .unwrap_or_else(|| "png".to_string());

            return Ok((bytes, ext));
        }

        break;
    }

    if current_source.starts_with("file://") {
        let file_path = decode_file_url_path(&current_source);
        let local_path = PathBuf::from(file_path);
        let bytes = std::fs::read(&local_path)
            .map_err(|e| format!("Failed to read file:// image source: {}", e))?;
        let ext = local_path
            .extension()
            .and_then(|item| item.to_str())
            .map(normalize_extension)
            .unwrap_or_else(|| "png".to_string());
        return Ok((bytes, ext));
    }

    let local_path = PathBuf::from(&current_source);
    let bytes = std::fs::read(&local_path)
        .map_err(|e| format!("Failed to read local image source: {}", e))?;
    let ext = local_path
        .extension()
        .and_then(|item| item.to_str())
        .map(normalize_extension)
        .unwrap_or_else(|| "png".to_string());

    Ok((bytes, ext))
}

#[tauri::command]
pub async fn read_storyboard_image_metadata(
    source: String,
) -> Result<Option<StoryboardImageMetadata>, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, extension) = resolve_source_bytes(trimmed).await?;
    if extension != "png" {
        return Ok(None);
    }

    read_storyboard_metadata_from_png_bytes(&bytes)
}

#[tauri::command]
pub async fn embed_storyboard_image_metadata(
    app: AppHandle,
    source: String,
    metadata: StoryboardImageMetadata,
) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, _extension) = resolve_source_bytes(trimmed).await?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to decode image for metadata embedding: {}", e))?;
    let encoded = encode_png_with_storyboard_metadata(&image, &metadata)?;

    persist_image_bytes(&app, &encoded, "png")
}

#[tauri::command]
pub async fn persist_image_source(app: AppHandle, source: String) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, extension) = resolve_source_bytes(trimmed).await?;
    let images_dir = resolve_images_dir(&app)?;
    let digest = md5::compute(&bytes);
    let filename = format!("{:x}.{}", digest, extension);
    let output_path = images_dir.join(filename);

    if !output_path.exists() {
        std::fs::write(&output_path, bytes)
            .map_err(|e| format!("Failed to persist image source: {}", e))?;
    }

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn persist_video_source(
    app: AppHandle,
    source: String,
    headers: Option<HashMap<String, String>>,
    network: Option<MediaNetworkRouteDto>,
) -> Result<String, String> {
    let started = Instant::now();
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Video source is empty".to_string());
    }

    let (bytes, extension) =
        resolve_video_source_bytes_with_headers(trimmed, headers.as_ref(), network.as_ref())
            .await?;
    let output = persist_video_bytes(&app, &bytes, &extension)?;
    info!(
        "persist_video_source done: bytes={}, ext={}, elapsed={}ms",
        bytes.len(),
        extension,
        started.elapsed().as_millis()
    );
    Ok(output)
}

#[tauri::command]
pub async fn persist_image_binary(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: Option<String>,
) -> Result<String, String> {
    let started = Instant::now();
    if bytes.is_empty() {
        return Err("Image bytes are empty".to_string());
    }

    let resolved_extension = extension
        .as_deref()
        .map(normalize_extension)
        .unwrap_or_else(|| "png".to_string());

    let output = persist_image_bytes(&app, &bytes, &resolved_extension)?;
    info!(
        "persist_image_binary done: bytes={}, ext={}, elapsed={}ms",
        bytes.len(),
        resolved_extension,
        started.elapsed().as_millis()
    );
    Ok(output)
}

fn sanitize_file_stem(raw: &str) -> String {
    let trimmed = raw.trim();
    let fallback = "storyboard-image";
    if trimmed.is_empty() {
        return fallback.to_string();
    }

    let mut sanitized = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        let blocked = matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*');
        if blocked || ch.is_control() {
            continue;
        }
        sanitized.push(ch);
    }

    let compact = sanitized.trim().trim_matches('.').to_string();
    let compact_lower = compact.to_ascii_lowercase();
    let is_windows_reserved = matches!(
        compact_lower.as_str(),
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    );
    if compact.is_empty() || is_windows_reserved {
        fallback.to_string()
    } else {
        compact
    }
}

fn ensure_unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }

    let parent = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("storyboard-image");
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png");

    for index in 1..10_000_u32 {
        let candidate = parent.join(format!("{}-{}.{}", stem, index, ext));
        if !candidate.exists() {
            return candidate;
        }
    }

    path
}

fn ensure_output_path_with_extension(path: &Path, extension: &str) -> PathBuf {
    if path.extension().is_some() {
        return path.to_path_buf();
    }

    let mut with_extension = path.to_path_buf();
    with_extension.set_extension(normalize_extension(extension));
    with_extension
}

#[tauri::command]
pub async fn rename_local_media_files(
    app: AppHandle,
    payload: RenameLocalMediaFilesPayload,
) -> Result<RenameLocalMediaFilesResult, String> {
    let primary_raw = payload.primary_path.trim();
    if primary_raw.is_empty() {
        return Err("Primary media path is empty".to_string());
    }

    let media_kind = resolve_local_media_kind(&payload.media_kind)?;
    let media_dir = match media_kind {
        LocalMediaKind::Image => resolve_images_dir(&app)?,
        LocalMediaKind::Video => resolve_videos_dir(&app)?,
    };
    let primary_path =
        canonical_local_media_path(&PathBuf::from(primary_raw), &media_dir, "Primary media")?;

    let default_stem = next_generated_media_file_stem(&app, media_kind)?;
    let requested_stem = payload
        .desired_file_name
        .as_deref()
        .map(|value| sanitize_requested_file_stem(value, &default_stem))
        .filter(|value| !value.is_empty())
        .unwrap_or(default_stem);

    let renamed_primary_path = rename_local_file_to_stem(&primary_path, &requested_stem)?;
    let renamed_preview_path = payload
        .preview_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| {
            let preview_raw_path = PathBuf::from(value);
            if !preview_raw_path.exists() {
                return None;
            }
            Some(
                canonical_local_media_path(&preview_raw_path, &media_dir, "Preview media")
                    .and_then(|preview_path| {
                        if preview_path == primary_path || preview_path == renamed_primary_path {
                            Ok(renamed_primary_path.clone())
                        } else {
                            rename_local_file_to_stem(
                                &preview_path,
                                &format!("{}-preview", requested_stem),
                            )
                        }
                    }),
            )
        })
        .transpose()?;

    let file_name = renamed_primary_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            format!(
                "Failed to resolve renamed file name: {}",
                renamed_primary_path.display()
            )
        })?
        .to_string();

    Ok(RenameLocalMediaFilesResult {
        primary_path: renamed_primary_path.to_string_lossy().to_string(),
        preview_path: renamed_preview_path.map(|path| path.to_string_lossy().to_string()),
        file_name,
    })
}

#[tauri::command]
pub async fn save_image_source_to_downloads(
    source: String,
    suggested_file_name: Option<String>,
) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, extension) = resolve_source_bytes(trimmed).await?;
    let user_dirs = UserDirs::new().ok_or_else(|| "Failed to resolve user dirs".to_string())?;
    let downloads_dir = user_dirs
        .download_dir()
        .or_else(|| user_dirs.desktop_dir())
        .or_else(|| Some(user_dirs.home_dir()))
        .ok_or_else(|| "Failed to resolve downloads dir".to_string())?;
    std::fs::create_dir_all(downloads_dir)
        .map_err(|e| format!("Failed to create downloads dir: {}", e))?;

    let now_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to resolve current time: {}", e))?
        .as_millis();
    let stem = sanitize_file_stem(suggested_file_name.as_deref().unwrap_or(""));
    let default_stem = if stem == "storyboard-image" {
        format!("storyboard-{}", now_millis)
    } else {
        stem
    };

    let output_path = ensure_unique_path(downloads_dir.join(format!(
        "{}.{}",
        default_stem,
        normalize_extension(&extension)
    )));
    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save image into downloads: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_image_source_to_path(
    source: String,
    target_path: String,
) -> Result<String, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let trimmed_target = target_path.trim();
    if trimmed_target.is_empty() {
        return Err("Target path is empty".to_string());
    }

    let (bytes, extension) = resolve_source_bytes(trimmed_source).await?;
    let raw_path = PathBuf::from(normalize_user_selected_path(trimmed_target));
    let output_path = ensure_output_path_with_extension(&raw_path, &extension);

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output dir: {}", e))?;
    }

    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save image to target path: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_image_source_to_directory(
    source: String,
    target_dir: String,
    suggested_file_name: Option<String>,
) -> Result<String, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let trimmed_dir = target_dir.trim();
    if trimmed_dir.is_empty() {
        return Err("Target directory is empty".to_string());
    }

    let (bytes, extension) = resolve_source_bytes(trimmed_source).await?;
    let dir_path = PathBuf::from(normalize_user_selected_path(trimmed_dir));
    std::fs::create_dir_all(&dir_path)
        .map_err(|e| format!("Failed to create target dir: {}", e))?;

    let now_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to resolve current time: {}", e))?
        .as_millis();
    let stem = sanitize_file_stem(suggested_file_name.as_deref().unwrap_or(""));
    let default_stem = if stem == "storyboard-image" {
        format!("storyboard-{}", now_millis)
    } else {
        stem
    };

    let output_path = ensure_unique_path(dir_path.join(format!(
        "{}.{}",
        default_stem,
        normalize_extension(&extension)
    )));
    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save image to target directory: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_video_source_to_path(
    source: String,
    target_path: String,
) -> Result<String, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Video source is empty".to_string());
    }

    let trimmed_target = target_path.trim();
    if trimmed_target.is_empty() {
        return Err("Target path is empty".to_string());
    }

    let (bytes, extension) =
        resolve_video_source_bytes_with_headers(trimmed_source, None, None).await?;
    let raw_path = PathBuf::from(normalize_user_selected_path(trimmed_target));
    let output_path = ensure_output_path_with_extension(&raw_path, &extension);

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output dir: {}", e))?;
    }

    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save video to target path: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_video_source_to_directory(
    source: String,
    target_dir: String,
    suggested_file_name: Option<String>,
) -> Result<String, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Video source is empty".to_string());
    }

    let trimmed_dir = target_dir.trim();
    if trimmed_dir.is_empty() {
        return Err("Target directory is empty".to_string());
    }

    let (bytes, extension) =
        resolve_video_source_bytes_with_headers(trimmed_source, None, None).await?;
    let dir_path = PathBuf::from(normalize_user_selected_path(trimmed_dir));
    std::fs::create_dir_all(&dir_path)
        .map_err(|e| format!("Failed to create target dir: {}", e))?;

    let now_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to resolve current time: {}", e))?
        .as_millis();
    let stem = sanitize_file_stem(suggested_file_name.as_deref().unwrap_or(""));
    let default_stem = if stem == "storyboard-image" {
        format!("storyboard-video-{}", now_millis)
    } else {
        stem
    };

    let output_path = ensure_unique_path(dir_path.join(format!(
        "{}.{}",
        default_stem,
        normalize_video_extension(&extension)
    )));
    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save video to target directory: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_audio_source_to_path(
    source: String,
    target_path: String,
) -> Result<String, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Audio source is empty".to_string());
    }

    let trimmed_target = target_path.trim();
    if trimmed_target.is_empty() {
        return Err("Target path is empty".to_string());
    }

    let (bytes, extension) = resolve_audio_source_bytes(trimmed_source).await?;
    let raw_path = PathBuf::from(normalize_user_selected_path(trimmed_target));
    let output_path = ensure_output_path_with_extension(&raw_path, &extension);

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output dir: {}", e))?;
    }

    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save audio to target path: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn load_audio_source_data_url(source: String) -> Result<String, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Audio source is empty".to_string());
    }

    let (bytes, extension) = resolve_audio_source_bytes(trimmed_source).await?;
    let mime = audio_mime_from_extension(&extension);
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(bytes)))
}

#[tauri::command]
pub async fn save_image_source_to_app_debug_dir(
    app: AppHandle,
    source: String,
    category: Option<String>,
    suggested_file_name: Option<String>,
) -> Result<String, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let normalized_category = sanitize_file_stem(category.as_deref().unwrap_or("grid"));
    let target_dir = app_data_dir.join("debug").join(normalized_category);
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create app debug dir: {}", e))?;

    let (bytes, extension) = resolve_source_bytes(trimmed_source).await?;
    let now_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to resolve current time: {}", e))?
        .as_millis();
    let stem = sanitize_file_stem(suggested_file_name.as_deref().unwrap_or(""));
    let default_stem = if stem == "storyboard-image" {
        format!("debug-{}", now_millis)
    } else {
        stem
    };
    let output_path = ensure_unique_path(target_dir.join(format!(
        "{}.{}",
        default_stem,
        normalize_extension(&extension)
    )));

    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save image to app debug dir: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn copy_image_source_to_clipboard(source: String) -> Result<(), String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, _extension) = resolve_source_bytes(trimmed).await?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to decode image source: {}", e))?
        .to_rgba8();
    let width = image.width() as usize;
    let height = image.height() as usize;
    let pixels = image.into_raw();

    let mut clipboard =
        Clipboard::new().map_err(|e| format!("Failed to access clipboard: {}", e))?;
    clipboard
        .set_image(ImageData {
            width,
            height,
            bytes: Cow::Owned(pixels),
        })
        .map_err(|e| format!("Failed to write image into clipboard: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn read_system_clipboard() -> Result<SystemClipboardContent, String> {
    let mut clipboard =
        Clipboard::new().map_err(|e| format!("Failed to access clipboard: {}", e))?;

    let text = match clipboard.get_text() {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(value)
            }
        }
        Err(_) => None,
    };

    let image = match clipboard.get_image() {
        Ok(image_data) => Some(arboard_image_to_system_clipboard_image(image_data)?),
        Err(_) => read_macos_pasteboard_encoded_image(),
    };

    Ok(SystemClipboardContent { image, text })
}

#[tauri::command]
pub async fn load_image(file_path: String) -> Result<String, String> {
    let normalized_path = normalize_user_selected_path(&file_path);
    info!("Loading image from: {}", normalized_path);

    let image_data =
        std::fs::read(&normalized_path).map_err(|e| format!("Failed to read file: {}", e))?;

    let base64_data = STANDARD.encode(&image_data);

    let mime = if normalized_path.ends_with(".png") {
        "image/png"
    } else if normalized_path.ends_with(".jpg") || normalized_path.ends_with(".jpeg") {
        "image/jpeg"
    } else if normalized_path.ends_with(".gif") {
        "image/gif"
    } else if normalized_path.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    };

    Ok(format!("data:{};base64,{}", mime, base64_data))
}

#[cfg(test)]
mod remote_media_tests {
    use base64::Engine as _;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::{
        build_remote_media_client, describe_non_image_remote_body, describe_remote_media_url,
        host_is_local_or_private, ip_is_local_or_private, media_byte_limit, media_download_timeout,
        parse_remote_media_url, remote_media_content_error, route_allows_direct_fallback,
        should_forward_headers_to_url, try_remote_media_request_with_limit, try_remote_media_route,
        url_origin, MediaNetworkRouteDto, RemoteMediaAttemptFailure, REMOTE_AUDIO_DOWNLOAD_TIMEOUT,
        REMOTE_IMAGE_DOWNLOAD_TIMEOUT, REMOTE_IMAGE_MAX_BYTES, REMOTE_VIDEO_DOWNLOAD_TIMEOUT,
        REMOTE_VIDEO_MAX_BYTES,
    };

    fn minimal_png() -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap()
    }

    async fn spawn_http_fixture<F>(handler: F) -> String
    where
        F: Fn(String, usize) -> Vec<u8> + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            let mut request_number = 0usize;
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                request_number += 1;
                let handler = Arc::clone(&handler);
                tokio::spawn(async move {
                    let mut request = vec![0u8; 16 * 1024];
                    let read = stream.read(&mut request).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&request[..read]).into_owned();
                    let response = handler(request, request_number);
                    let _ = stream.write_all(&response).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        format!("http://{}", address)
    }

    fn http_response(status: &str, headers: &[(&str, String)], body: &[u8]) -> Vec<u8> {
        let mut response = format!("HTTP/1.1 {status}\r\nConnection: close\r\n");
        for (name, value) in headers {
            response.push_str(&format!("{name}: {value}\r\n"));
        }
        response.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
        let mut bytes = response.into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    fn chunked_http_response(
        status: &str,
        headers: &[(&str, String)],
        chunks: &[&[u8]],
    ) -> Vec<u8> {
        let mut response =
            format!("HTTP/1.1 {status}\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n");
        for (name, value) in headers {
            response.push_str(&format!("{name}: {value}\r\n"));
        }
        response.push_str("\r\n");
        let mut bytes = response.into_bytes();
        for chunk in chunks {
            bytes.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
            bytes.extend_from_slice(chunk);
            bytes.extend_from_slice(b"\r\n");
        }
        bytes.extend_from_slice(b"0\r\n\r\n");
        bytes
    }

    #[test]
    fn html_success_body_is_rejected_before_route_is_accepted() {
        let error = remote_media_content_error(
            "image",
            "text/html; charset=utf-8",
            b"<!doctype html><html><body>proxy error</body></html>",
        );
        assert!(error
            .as_deref()
            .unwrap_or_default()
            .contains("did not return image bytes"));
    }

    #[test]
    fn image_content_is_allowed() {
        assert!(remote_media_content_error("image", "image/png", &minimal_png()).is_none());
    }

    #[test]
    fn truncated_image_is_rejected_inside_the_retry_boundary() {
        assert!(
            remote_media_content_error("image", "image/png", b"\x89PNG\r\n\x1a\n")
                .unwrap()
                .contains("decodable image bytes")
        );
    }

    #[test]
    fn json_wrapper_is_allowed_for_outer_image_source_unwrap() {
        assert!(remote_media_content_error(
            "image",
            "application/json",
            br#"{"url":"https://cdn.example.com/result.png"}"#,
        )
        .is_none());
    }

    #[test]
    fn json_error_without_image_source_is_rejected() {
        assert!(remote_media_content_error(
            "image",
            "application/json",
            br#"{"error":{"message":"upstream unavailable"}}"#,
        )
        .is_some());
    }

    #[test]
    fn json_page_url_is_not_treated_as_an_image_wrapper() {
        assert!(remote_media_content_error(
            "image",
            "application/json",
            br#"{"page_url":"https://example.com/results/123"}"#,
        )
        .is_some());
    }

    #[test]
    fn plain_text_body_with_image_content_type_is_rejected_without_echoing_body() {
        let body = b"temporary upstream failure: private-token-value";
        let error = remote_media_content_error("image", "image/png", body).unwrap();
        assert!(error.contains("did not return image bytes"));
        assert!(!error.contains("private-token-value"));
    }

    #[test]
    fn only_system_route_allows_direct_fallback() {
        assert!(route_allows_direct_fallback("system"));
        assert!(!route_allows_direct_fallback("direct"));
        assert!(!route_allows_direct_fallback("custom-proxy"));
    }

    #[test]
    fn media_route_rejects_unknown_values_and_keeps_explicit_routes() {
        for route in ["system", "direct", "custom-proxy"] {
            let dto = MediaNetworkRouteDto {
                route: route.to_string(),
                custom_proxy_url: None,
                configured_provider_origin: None,
            };
            assert_eq!(dto.route().unwrap(), route);
        }
        let invalid = MediaNetworkRouteDto {
            route: "automatic".to_string(),
            custom_proxy_url: None,
            configured_provider_origin: None,
        };
        assert!(invalid.route().is_err());
    }

    #[test]
    fn redirect_origin_drops_provider_headers_cross_origin() {
        let provider = parse_remote_media_url("https://provider.example/v1/result").unwrap();
        let same_origin =
            parse_remote_media_url("https://provider.example/files/image.png").unwrap();
        let cdn = parse_remote_media_url("https://cdn.example/image.png").unwrap();
        let origin = url_origin(&provider);
        assert!(should_forward_headers_to_url(&origin, &same_origin));
        assert!(!should_forward_headers_to_url(&origin, &cdn));
    }

    #[test]
    fn local_and_private_targets_are_detected() {
        for value in [
            "http://localhost/result.png",
            "http://127.0.0.1/result.png",
            "http://10.0.0.4/result.png",
            "http://169.254.1.2/result.png",
            "http://[::1]/result.png",
            "http://[fd00::1]/result.png",
            "http://[fe80::1]/result.png",
            "http://[::ffff:127.0.0.1]/result.png",
        ] {
            assert!(host_is_local_or_private(
                &parse_remote_media_url(value).unwrap()
            ));
        }
        assert!(!host_is_local_or_private(
            &parse_remote_media_url("https://cdn.example/result.png").unwrap()
        ));
        assert!(ip_is_local_or_private("::1".parse().unwrap()));
        assert!(ip_is_local_or_private("fd12:3456::1".parse().unwrap()));
        assert!(ip_is_local_or_private("fe80::1234".parse().unwrap()));
        assert!(ip_is_local_or_private("::ffff:127.0.0.1".parse().unwrap()));
        assert!(!ip_is_local_or_private("::ffff:8.8.8.8".parse().unwrap()));
        assert!(!ip_is_local_or_private(
            "2606:4700:4700::1111".parse().unwrap()
        ));
    }

    #[test]
    fn remote_url_diagnostics_redact_query_credentials() {
        let label = describe_remote_media_url(
            "https://cdn.example/results/image.png?signature=secret&token=hidden",
        );
        assert_eq!(label, "cdn.example/image.png");
        assert!(!label.contains("secret"));
        assert!(!label.contains("token"));
    }

    #[test]
    fn invalid_content_diagnostics_do_not_include_body_preview() {
        let message =
            describe_non_image_remote_body("application/json", br#"{"token":"private-value"}"#);
        assert!(message.contains("application/json"));
        assert!(!message.contains("private-value"));
        assert!(!message.contains("Body preview"));
    }

    #[test]
    fn image_and_video_downloads_have_separate_bounds() {
        assert_eq!(media_byte_limit("image"), REMOTE_IMAGE_MAX_BYTES);
        assert_eq!(media_byte_limit("video"), REMOTE_VIDEO_MAX_BYTES);
        assert!(media_byte_limit("video") > media_byte_limit("image"));
    }

    #[test]
    fn media_download_timeouts_scale_with_expected_payload_size() {
        assert_eq!(
            media_download_timeout("image"),
            REMOTE_IMAGE_DOWNLOAD_TIMEOUT
        );
        assert_eq!(
            media_download_timeout("audio"),
            REMOTE_AUDIO_DOWNLOAD_TIMEOUT
        );
        assert_eq!(
            media_download_timeout("video"),
            REMOTE_VIDEO_DOWNLOAD_TIMEOUT
        );
        assert!(media_download_timeout("video") > media_download_timeout("audio"));
        assert!(media_download_timeout("audio") > media_download_timeout("image"));
    }

    #[test]
    fn media_retry_policy_keeps_429_on_route_and_retries_fallback_failures() {
        let rate_limit = RemoteMediaAttemptFailure::Status {
            message: "rate limited".to_string(),
            retryable: true,
            fallback_allowed: false,
        };
        assert!(rate_limit.retryable());
        assert!(!rate_limit.fallback_allowed());

        let server_failure = RemoteMediaAttemptFailure::Status {
            message: "server unavailable".to_string(),
            retryable: true,
            fallback_allowed: true,
        };
        assert!(server_failure.retryable());
        assert!(server_failure.fallback_allowed());

        let invalid = RemoteMediaAttemptFailure::InvalidContent {
            message: "transient invalid body".to_string(),
        };
        assert!(invalid.retryable());
        assert!(invalid.fallback_allowed());

        let oversized = RemoteMediaAttemptFailure::TooLarge {
            message: "byte limit exceeded".to_string(),
        };
        assert!(!oversized.retryable());
        assert!(!oversized.fallback_allowed());
    }

    #[tokio::test]
    async fn actual_redirect_requests_keep_same_origin_headers_and_drop_cross_origin_headers() {
        let same_origin_header_count = Arc::new(AtomicUsize::new(0));
        let same_origin_header_count_for_server = Arc::clone(&same_origin_header_count);
        let same_origin = spawn_http_fixture(move |request, _| {
            if request.starts_with("GET /redirect ") {
                return http_response("302 Found", &[("Location", "/result".to_string())], b"");
            }
            if request
                .to_ascii_lowercase()
                .contains("authorization: bearer secret")
            {
                same_origin_header_count_for_server.fetch_add(1, Ordering::SeqCst);
            }
            http_response(
                "200 OK",
                &[("Content-Type", "image/png".to_string())],
                &minimal_png(),
            )
        })
        .await;
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), "Bearer secret".to_string());
        let client = build_remote_media_client(true).unwrap();
        let same_download = try_remote_media_request_with_limit(
            &client,
            "direct",
            &format!("{same_origin}/redirect"),
            "image/*",
            Some(&headers),
            "image",
            1,
            Some(&same_origin),
            minimal_png().len() + 1,
        )
        .await
        .unwrap();
        assert_eq!(same_download.bytes, minimal_png());
        assert_eq!(same_origin_header_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn local_provider_cannot_redirect_to_a_different_local_origin() {
        let redirect_target = spawn_http_fixture(|_request, _| {
            http_response(
                "200 OK",
                &[("Content-Type", "image/png".to_string())],
                &minimal_png(),
            )
        })
        .await;
        let redirect_target_for_server = redirect_target.clone();
        let provider = spawn_http_fixture(move |_request, _| {
            http_response(
                "302 Found",
                &[("Location", format!("{redirect_target_for_server}/result"))],
                b"",
            )
        })
        .await;
        let client = build_remote_media_client(true).unwrap();
        let failure = try_remote_media_request_with_limit(
            &client,
            "direct",
            &format!("{provider}/redirect"),
            "image/*",
            None,
            "image",
            1,
            Some(&provider),
            32,
        )
        .await
        .unwrap_err();
        assert!(matches!(
            failure,
            RemoteMediaAttemptFailure::Status {
                retryable: false,
                fallback_allowed: false,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn actual_download_stream_stops_at_limit_and_retries_transient_results() {
        let oversized = spawn_http_fixture(|_request, _| {
            chunked_http_response(
                "200 OK",
                &[("Content-Type", "image/png".to_string())],
                &[b"01234", b"56789"],
            )
        })
        .await;
        let client = build_remote_media_client(true).unwrap();
        let oversized_failure = try_remote_media_request_with_limit(
            &client,
            "direct",
            &format!("{oversized}/result"),
            "image/*",
            None,
            "image",
            1,
            Some(&oversized),
            8,
        )
        .await
        .unwrap_err();
        assert!(matches!(
            oversized_failure,
            RemoteMediaAttemptFailure::TooLarge { .. }
        ));

        let server_failures = Arc::new(AtomicUsize::new(0));
        let server_failures_for_server = Arc::clone(&server_failures);
        let retry_server = spawn_http_fixture(move |_request, request_number| {
            server_failures_for_server.fetch_add(1, Ordering::SeqCst);
            if request_number < 3 {
                return http_response("503 Service Unavailable", &[], b"");
            }
            http_response(
                "200 OK",
                &[("Content-Type", "image/png".to_string())],
                &minimal_png(),
            )
        })
        .await;
        try_remote_media_route(
            &client,
            "no-proxy",
            &format!("{retry_server}/result"),
            "image/*",
            None,
            "image",
            Some(&retry_server),
        )
        .await
        .unwrap();
        assert_eq!(server_failures.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn unconfigured_initial_local_target_is_rejected() {
        let local = spawn_http_fixture(|_request, _| {
            http_response(
                "200 OK",
                &[("Content-Type", "image/png".to_string())],
                &minimal_png(),
            )
        })
        .await;
        let client = build_remote_media_client(true).unwrap();
        let failure = try_remote_media_request_with_limit(
            &client,
            "direct",
            &format!("{local}/result"),
            "image/*",
            None,
            "image",
            1,
            Some("https://provider.example"),
            32,
        )
        .await
        .unwrap_err();
        assert!(matches!(
            failure,
            RemoteMediaAttemptFailure::Status {
                retryable: false,
                fallback_allowed: false,
                ..
            }
        ));
    }
}

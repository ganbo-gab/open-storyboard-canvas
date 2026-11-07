use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tracing::info;
use uuid::Uuid;

use crate::ai::error::AIError;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};
use crate::commands::secrets::{
    credential_ref_from_token, resolve_provider_credential, ResolvedCredential, SecretRef,
};

const TASK_BASE_URL: &str = "https://api.kie.ai";
const FILE_BASE_URL: &str = "https://kieai.redpandaai.co";
const CREATE_TASK_PATH: &str = "/api/v1/jobs/createTask";
const RECORD_INFO_PATH: &str = "/api/v1/jobs/recordInfo";
const FILE_UPLOAD_PATH: &str = "/api/file-stream-upload";
const UPLOAD_PATH: &str = "images/open-storyboard-canvas";
const POLL_INTERVAL_MS: u64 = 2500;

#[derive(Debug, Deserialize)]
struct KieCreateTaskResponse {
    code: i64,
    msg: String,
    data: Option<KieCreateTaskData>,
}

#[derive(Debug, Deserialize)]
struct KieCreateTaskData {
    #[serde(rename = "taskId")]
    task_id: String,
}

#[derive(Debug, Deserialize)]
struct KieTaskInfoResponse {
    code: i64,
    message: Option<String>,
    msg: Option<String>,
    data: Option<KieTaskInfoData>,
}

#[derive(Debug, Deserialize)]
struct KieTaskInfoData {
    state: Option<String>,
    #[serde(rename = "resultJson")]
    result_json: Option<String>,
    #[serde(rename = "failMsg")]
    fail_msg: Option<String>,
}

#[derive(Debug, Deserialize)]
struct KieTaskResultJson {
    #[serde(rename = "resultUrls")]
    result_urls: Option<Vec<String>>,
}

pub struct KieProvider {
    client: Client,
    credential_ref: Arc<RwLock<Option<SecretRef>>>,
}

impl KieProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            credential_ref: Arc::new(RwLock::new(None)),
        }
    }

    fn decode_file_url_path(value: &str) -> String {
        let raw = value.trim_start_matches("file://");
        let decoded = urlencoding::decode(raw)
            .map(|result| result.into_owned())
            .unwrap_or_else(|_| raw.to_string());
        let normalized = if decoded.starts_with('/')
            && decoded.len() > 2
            && decoded.as_bytes().get(2) == Some(&b':')
        {
            &decoded[1..]
        } else {
            &decoded
        };
        normalized.to_string()
    }

    fn sanitize_model(model: &str) -> String {
        model
            .split_once('/')
            .map(|(_, bare)| bare.to_string())
            .unwrap_or_else(|| model.to_string())
    }

    fn max_reference_count_for_model(model: &str) -> usize {
        if model == "nano-banana-pro" {
            8
        } else {
            14
        }
    }

    fn source_to_bytes(source: &str) -> Result<Vec<u8>, String> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Err("source is empty".to_string());
        }

        if let Some((meta, payload)) = trimmed.split_once(',') {
            if meta.starts_with("data:") && meta.ends_with(";base64") && !payload.is_empty() {
                return STANDARD
                    .decode(payload)
                    .map_err(|err| format!("invalid data-url base64 payload: {}", err));
            }
        }

        let likely_base64 = trimmed.len() > 256
            && trimmed
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/' || ch == '=');
        if likely_base64 {
            return STANDARD
                .decode(trimmed)
                .map_err(|err| format!("invalid base64 payload: {}", err));
        }

        if trimmed.starts_with("asset://")
            || trimmed.starts_with("tauri://")
            || trimmed.starts_with("app://")
        {
            return Err(format!("unsupported local protocol source: {}", trimmed));
        }

        let path = if trimmed.starts_with("file://") {
            PathBuf::from(Self::decode_file_url_path(trimmed))
        } else {
            PathBuf::from(trimmed)
        };
        std::fs::read(&path).map_err(|err| {
            format!(
                "failed to read path \"{}\": {}",
                path.to_string_lossy(),
                err
            )
        })
    }

    fn is_http_url(value: &str) -> bool {
        value.starts_with("http://") || value.starts_with("https://")
    }

    fn extract_uploaded_file_url(body: &Value) -> Option<String> {
        let candidates = [
            "/data/downloadUrl",
            "/data/fileUrl",
            "/data/file_url",
            "/data/url",
            "/data/download_url",
            "/fileUrl",
            "/file_url",
            "/url",
            "/downloadUrl",
            "/download_url",
        ];

        for pointer in candidates {
            let value = body.pointer(pointer).and_then(|raw| raw.as_str());
            if let Some(url) = value.filter(|raw| !raw.trim().is_empty()) {
                return Some(url.to_string());
            }
        }

        body.pointer("/data")
            .and_then(|raw| raw.as_str())
            .filter(|raw| !raw.trim().is_empty())
            .map(|url| url.to_string())
    }

    async fn upload_reference_image(
        &self,
        credential: &mut ResolvedCredential,
        source: &str,
        index: usize,
    ) -> Result<String, AIError> {
        let api_key = credential.value.as_str();
        if source.starts_with("http://") || source.starts_with("https://") {
            return Ok(source.to_string());
        }

        let bytes = Self::source_to_bytes(source).map_err(|err| {
            AIError::InvalidRequest(format!(
                "Failed to read reference image for KIE upload: {}; source={}",
                err, source
            ))
        })?;
        let file_name = format!("ref-{}-{}.png", index + 1, Uuid::new_v4());
        let file_part = Part::bytes(bytes).file_name(file_name.clone());
        let form = Form::new()
            .part("file", file_part)
            .text("uploadPath", UPLOAD_PATH.to_string())
            .text("fileName", file_name);

        let endpoint = format!("{}{}", FILE_BASE_URL, FILE_UPLOAD_PATH);
        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .multipart(form)
            .send()
            .await
            .map_err(|error| AIError::Network(error.without_url()))?;

        let status = response.status();
        let raw_response = credential
            .redactor
            .redact_owned(response.text().await.unwrap_or_default());
        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "KIE file upload failed {}: {}",
                status, raw_response
            )));
        }

        let body = serde_json::from_str::<Value>(&raw_response).map_err(|err| {
            AIError::Provider(format!(
                "KIE file upload invalid JSON response: {}; raw={}",
                err, raw_response
            ))
        })?;
        if body.get("success").and_then(|raw| raw.as_bool()) == Some(false)
            || body.get("code").and_then(|raw| raw.as_i64()).unwrap_or(200) >= 400
        {
            return Err(AIError::Provider(format!(
                "KIE file upload rejected: {}",
                body.get("msg")
                    .and_then(|raw| raw.as_str())
                    .unwrap_or("unknown upload error")
            )));
        }

        let uploaded_url = Self::extract_uploaded_file_url(&body).ok_or_else(|| {
            AIError::Provider(format!(
                "KIE file upload missing fileUrl, raw response: {}",
                body
            ))
        })?;

        if !Self::is_http_url(&uploaded_url) {
            return Err(AIError::Provider(format!(
                "KIE upload returned non-http URL: {}, raw response: {}",
                uploaded_url, body
            )));
        }

        Ok(uploaded_url)
    }

    async fn upload_reference_images(
        &self,
        credential: &mut ResolvedCredential,
        model: &str,
        reference_images: &[String],
    ) -> Result<Vec<String>, AIError> {
        let limit = Self::max_reference_count_for_model(model);
        let capped = reference_images.iter().take(limit).collect::<Vec<_>>();
        let mut uploaded_urls = Vec::with_capacity(capped.len());
        for (index, source) in capped.into_iter().enumerate() {
            uploaded_urls.push(
                self.upload_reference_image(credential, source, index)
                    .await?,
            );
        }
        Ok(uploaded_urls)
    }

    async fn create_task(
        &self,
        credential: &mut ResolvedCredential,
        request: &GenerateRequest,
        model: &str,
        uploaded_images: Vec<String>,
    ) -> Result<String, AIError> {
        let api_key = credential.value.as_str();
        if uploaded_images.iter().any(|url| !Self::is_http_url(url)) {
            return Err(AIError::InvalidRequest(
                "KIE image_input contains non-http URL, upload step may have failed".to_string(),
            ));
        }

        info!(
            "[KIE createTask] using uploaded image URLs: count={}",
            uploaded_images.len()
        );

        let enable_web_search = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("enable_web_search"))
            .and_then(|raw| raw.as_bool())
            .unwrap_or(false);

        let mut input = json!({
            "prompt": request.prompt,
            "aspect_ratio": request.aspect_ratio,
            "resolution": request.size,
            "output_format": "png",
            "image_input": uploaded_images
        });
        if model == "nano-banana-2" {
            input["google_search"] = json!(enable_web_search);
        }

        let endpoint = format!("{}{}", TASK_BASE_URL, CREATE_TASK_PATH);
        let body = json!({
            "model": model,
            "input": input
        });
        let mut body = body;
        credential
            .redactor
            .resolve_json(&mut body)
            .map_err(|error| AIError::InvalidRequest(error.to_string()))?;
        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| AIError::Network(error.without_url()))?;

        let status = response.status();
        let raw_response = credential
            .redactor
            .redact_owned(response.text().await.unwrap_or_default());
        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "KIE createTask failed {}: {}",
                status, raw_response
            )));
        }

        let body = serde_json::from_str::<KieCreateTaskResponse>(&raw_response).map_err(|err| {
            AIError::Provider(format!(
                "KIE createTask invalid JSON response: {}; raw={}",
                err, raw_response
            ))
        })?;
        if body.code != 200 {
            return Err(AIError::Provider(format!(
                "KIE createTask rejected: {}",
                body.msg
            )));
        }

        body.data
            .map(|data| data.task_id)
            .ok_or_else(|| AIError::Provider("KIE createTask missing taskId".to_string()))
    }

    fn extract_result_url(result_json_str: &str) -> Option<String> {
        serde_json::from_str::<KieTaskResultJson>(result_json_str)
            .ok()
            .and_then(|data| data.result_urls)
            .and_then(|urls| urls.into_iter().find(|url| !url.is_empty()))
    }

    async fn poll_task_once(
        &self,
        credential: &mut ResolvedCredential,
        task_id: &str,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let api_key = credential.value.as_str();
        let task_id = credential
            .redactor
            .resolve_markers(task_id, false)
            .map_err(|error| AIError::InvalidRequest(error.to_string()))?;
        let endpoint = format!("{}{}", TASK_BASE_URL, RECORD_INFO_PATH);
        let response = self
            .client
            .get(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .query(&[("taskId", task_id.as_ref())])
            .send()
            .await
            .map_err(|error| AIError::Network(error.without_url()))?;

        let status = response.status();
        let raw_response = credential
            .redactor
            .redact_owned(response.text().await.unwrap_or_default());
        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "KIE recordInfo failed {}: {}",
                status, raw_response
            )));
        }

        let body = serde_json::from_str::<KieTaskInfoResponse>(&raw_response).map_err(|err| {
            AIError::Provider(format!(
                "KIE recordInfo invalid JSON response: {}; raw={}",
                err, raw_response
            ))
        })?;
        if body.code != 200 {
            let message = body
                .message
                .or(body.msg)
                .unwrap_or_else(|| "unknown query error".to_string());
            return Err(AIError::Provider(format!(
                "KIE task query rejected: {}",
                message
            )));
        }

        let data = body
            .data
            .ok_or_else(|| AIError::Provider("KIE task query missing data".to_string()))?;
        match data.state.as_deref() {
            Some("success") => {
                let result_json = data.result_json.ok_or_else(|| {
                    AIError::Provider("KIE success response missing resultJson".to_string())
                })?;
                if let Some(url) = Self::extract_result_url(&result_json) {
                    return Ok(ProviderTaskPollResult::Succeeded(url));
                }
                Err(AIError::Provider(
                    "KIE resultJson has no valid result URL".to_string(),
                ))
            }
            Some("fail") => Ok(ProviderTaskPollResult::Failed(
                data.fail_msg
                    .unwrap_or_else(|| "KIE task failed".to_string()),
            )),
            Some("waiting") | Some("queuing") | Some("generating") | None => {
                Ok(ProviderTaskPollResult::Running)
            }
            Some(other) => Err(AIError::Provider(format!(
                "KIE unexpected task state: {}",
                other
            ))),
        }
    }
}

impl Default for KieProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for KieProvider {
    fn name(&self) -> &str {
        "kie"
    }

    fn supports_model(&self, model: &str) -> bool {
        matches!(
            Self::sanitize_model(model).as_str(),
            "nano-banana-2" | "nano-banana-pro"
        )
    }

    fn list_models(&self) -> Vec<String> {
        vec![
            "kie/nano-banana-2".to_string(),
            "kie/nano-banana-pro".to_string(),
        ]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        let reference = credential_ref_from_token(&api_key)
            .map_err(|error| AIError::InvalidRequest(error.to_string()))?;
        *self.credential_ref.write().await = Some(reference);
        Ok(())
    }

    async fn credential_ref(&self) -> Option<SecretRef> {
        self.credential_ref.read().await.clone()
    }

    fn supports_task_resume(&self) -> bool {
        true
    }

    async fn submit_task(
        &self,
        request: GenerateRequest,
    ) -> Result<ProviderTaskSubmission, AIError> {
        let reference = self.credential_ref().await;
        let mut credential = resolve_provider_credential(
            reference.as_ref(),
            request
                .extra_params
                .as_ref()
                .and_then(|params| params.get("credential_ref")),
        )
        .map_err(|error| AIError::InvalidRequest(error.to_string()))?;
        let model = Self::sanitize_model(&request.model);
        let uploaded_images = self
            .upload_reference_images(
                &mut credential,
                &model,
                request.reference_images.as_deref().unwrap_or(&[]),
            )
            .await?;
        let task_id = self
            .create_task(&mut credential, &request, &model, uploaded_images)
            .await?;
        Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
            task_id,
            metadata: Some(json!({
                "credential_ref": request.extra_params.as_ref()
                    .and_then(|params| params.get("credential_ref")).cloned()
                    .or_else(|| reference.as_ref().and_then(|value| serde_json::to_value(value).ok()))
            })),
        }))
    }

    async fn poll_task(
        &self,
        handle: ProviderTaskHandle,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let reference = self.credential_ref().await;
        let mut credential = resolve_provider_credential(
            reference.as_ref(),
            handle
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("credential_ref")),
        )
        .map_err(|error| AIError::InvalidRequest(error.to_string()))?;
        self.poll_task_once(&mut credential, handle.task_id.as_str())
            .await
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let handle = match self.submit_task(request).await? {
            ProviderTaskSubmission::Succeeded(result) => return Ok(result),
            ProviderTaskSubmission::Queued(handle) => handle,
        };
        loop {
            match self.poll_task(handle.clone()).await? {
                ProviderTaskPollResult::Running => {
                    sleep(Duration::from_millis(POLL_INTERVAL_MS)).await
                }
                ProviderTaskPollResult::Succeeded(url) => return Ok(url),
                ProviderTaskPollResult::Failed(message) => {
                    return Err(AIError::TaskFailed(message))
                }
            }
        }
    }
}

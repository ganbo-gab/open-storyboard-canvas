mod adapter;
mod models;
mod registry;

use reqwest::Client;
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::AIProvider;
use crate::commands::secrets::{credential_ref_from_token, resolve_provider_credential, SecretRef};

use registry::PPIOModelRegistry;

pub struct PPIOProvider {
    client: Client,
    credential_ref: Arc<RwLock<Option<SecretRef>>>,
    base_url: String,
    model_registry: PPIOModelRegistry,
}

#[derive(Debug, Deserialize)]
struct ImageResponse {
    image_urls: Vec<String>,
}

impl PPIOProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            credential_ref: Arc::new(RwLock::new(None)),
            base_url: "https://api.ppio.com".to_string(),
            model_registry: PPIOModelRegistry::new(),
        }
    }
}

impl Default for PPIOProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for PPIOProvider {
    fn name(&self) -> &str {
        "ppio"
    }

    fn supports_model(&self, model: &str) -> bool {
        self.model_registry.supports(model)
    }

    fn list_models(&self) -> Vec<String> {
        self.model_registry.list_models()
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

    async fn generate(&self, request: crate::ai::GenerateRequest) -> Result<String, AIError> {
        let reference = self.credential_ref().await;
        let mut credential = resolve_provider_credential(
            reference.as_ref(),
            request
                .extra_params
                .as_ref()
                .and_then(|params| params.get("credential_ref")),
        )
        .map_err(|error| AIError::InvalidRequest(error.to_string()))?;
        let api_key = credential.value.as_str();

        let adapter = self
            .model_registry
            .resolve(&request.model)
            .ok_or_else(|| AIError::ModelNotSupported(request.model.clone()))?;

        let mut prepared = adapter.build_request(&request, &self.base_url)?;
        credential
            .redactor
            .resolve_json(&mut prepared.body)
            .map_err(|error| AIError::InvalidRequest(error.to_string()))?;

        info!("[PPIO Request] {}", prepared.summary);
        info!("[PPIO API] URL: {}", prepared.endpoint);

        let response = self
            .client
            .post(&prepared.endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&prepared.body)
            .send()
            .await
            .map_err(|error| AIError::Network(error.without_url()))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = credential
                .redactor
                .redact_owned(response.text().await.unwrap_or_default());
            return Err(AIError::Provider(format!(
                "API error {}: {}",
                status, error_text
            )));
        }

        let raw = credential.redactor.redact_owned(
            response
                .text()
                .await
                .map_err(|error| AIError::Network(error.without_url()))?,
        );
        let result: ImageResponse = serde_json::from_str(&raw)?;

        if let Some(image_url) = result.image_urls.first() {
            info!("Generated image: {}", image_url);
            Ok(image_url.clone())
        } else {
            Err(AIError::Provider("No image URL in response".to_string()))
        }
    }
}

//! Isolated credential backends and loopback HTTP only; never use the OS store.
use super::*;
use crate::commands::http::{custom_http_request_with_resolver, HttpRequestDto};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TEST_SECRET: &str = "fixture-credential-only";

#[derive(Default)]
struct CountingBackend {
    values: Mutex<HashMap<SecretRef, String>>,
    reads: AtomicUsize,
    deny_reads: AtomicBool,
    deny_mutations: AtomicBool,
    discard_writes: AtomicBool,
}

impl SecretBackend for CountingBackend {
    fn get(&self, reference: &SecretRef) -> Result<Option<String>, SecretError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.deny_reads.load(Ordering::SeqCst) {
            return Err(SecretError::locked());
        }
        Ok(self.values.lock().unwrap().get(reference).cloned())
    }
    fn has(&self, reference: &SecretRef) -> Result<bool, SecretError> {
        Ok(self.values.lock().unwrap().contains_key(reference))
    }
    fn set(&self, reference: &SecretRef, value: &str) -> Result<(), SecretError> {
        if self.deny_mutations.load(Ordering::SeqCst) {
            return Err(SecretError::locked());
        }
        if !self.discard_writes.load(Ordering::SeqCst) {
            self.values
                .lock()
                .unwrap()
                .insert(reference.clone(), value.into());
        }
        Ok(())
    }
    fn delete(&self, reference: &SecretRef) -> Result<(), SecretError> {
        if self.deny_mutations.load(Ordering::SeqCst) {
            return Err(SecretError::locked());
        }
        self.values.lock().unwrap().remove(reference);
        Ok(())
    }
}

fn reference() -> SecretRef {
    SecretRef {
        namespace: "channel".into(),
        id: "isolated-http-fixture".into(),
    }
}

fn vault() -> SecretVault<CountingBackend> {
    let backend = CountingBackend::default();
    backend
        .values
        .lock()
        .unwrap()
        .insert(reference(), TEST_SECRET.into());
    SecretVault::new(backend)
}

fn required(
    vault: &SecretVault<CountingBackend>,
    reference: &SecretRef,
) -> Result<String, SecretError> {
    vault
        .get(reference)?
        .ok_or_else(|| SecretError::error("credential_missing"))
}

fn expire(vault: &SecretVault<CountingBackend>) {
    let mut access = vault.access.lock().unwrap();
    let Some(CredentialAccess::Granted { last_used, .. }) = access.get_mut(&reference()) else {
        panic!("fixture must have authorized access");
    };
    *last_used = SystemTime::now() - CREDENTIAL_IDLE_TIMEOUT;
}

#[test]
fn concurrent_requests_authorize_once_and_reuse_the_process_cache() {
    let vault = vault();
    std::thread::scope(|scope| {
        let vault = &vault;
        for _ in 0..16 {
            scope.spawn(move || assert_eq!(required(vault, &reference()).unwrap(), TEST_SECRET));
        }
    });
    assert_eq!(vault.backend.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn denial_is_sticky_across_reads_and_metadata_until_explicit_retry() {
    let vault = vault();
    vault.backend.deny_reads.store(true, Ordering::SeqCst);
    for _ in 0..5 {
        assert_eq!(vault.get(&reference()), Err(SecretError::locked()));
        assert_eq!(vault.has(&reference()), Ok(true));
    }
    vault.backend.deny_reads.store(false, Ordering::SeqCst);
    assert_eq!(vault.get(&reference()), Err(SecretError::locked()));
    assert_eq!(vault.backend.reads.load(Ordering::SeqCst), 1);
    assert_eq!(vault.retry_access(&reference()), Ok(true));
    assert_eq!(required(&vault, &reference()).unwrap(), TEST_SECRET);
    assert_eq!(vault.backend.reads.load(Ordering::SeqCst), 2);
}

#[test]
fn idle_expiry_blocks_automatic_requests_without_reopening_authorization() {
    let vault = vault();
    required(&vault, &reference()).unwrap();
    expire(&vault);
    assert_eq!(vault.get(&reference()), Err(SecretError::locked()));
    assert_eq!(vault.backend.reads.load(Ordering::SeqCst), 1);
    assert_eq!(vault.retry_access(&reference()), Ok(true));
    assert_eq!(required(&vault, &reference()).unwrap(), TEST_SECRET);
    assert_eq!(vault.backend.reads.load(Ordering::SeqCst), 2);
}

#[test]
fn clock_rollback_cannot_extend_credential_authorization() {
    let vault = vault();
    required(&vault, &reference()).unwrap();
    {
        let mut access = vault.access.lock().unwrap();
        if let Some(CredentialAccess::Granted { last_used, .. }) = access.get_mut(&reference()) {
            *last_used = SystemTime::now() + Duration::from_secs(60);
        }
    }
    assert_eq!(vault.get(&reference()), Err(SecretError::locked()));
    assert_eq!(vault.backend.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn writes_verify_fresh_values_and_failures_never_fall_back_to_stale_cache() {
    let vault = vault();
    required(&vault, &reference()).unwrap();
    vault.set(&reference(), "replacement-fixture").unwrap();
    assert_eq!(
        required(&vault, &reference()).unwrap(),
        "replacement-fixture"
    );
    assert_eq!(vault.backend.reads.load(Ordering::SeqCst), 2);
    vault.backend.deny_mutations.store(true, Ordering::SeqCst);
    assert_eq!(
        vault.set(&reference(), "rejected-fixture"),
        Err(SecretError::locked())
    );
    assert_eq!(vault.get(&reference()), Err(SecretError::locked()));
    vault.backend.deny_mutations.store(false, Ordering::SeqCst);
    vault.retry_access(&reference()).unwrap();
    vault.backend.discard_writes.store(true, Ordering::SeqCst);
    assert_eq!(
        vault.set(&reference(), "not-written"),
        Err(SecretError::error("verification_failed"))
    );
    assert_eq!(
        vault.get(&reference()),
        Err(SecretError::error("verification_failed"))
    );
}

#[test]
fn delete_failures_clear_cached_credentials_and_success_removes_them() {
    let vault = vault();
    required(&vault, &reference()).unwrap();
    vault.backend.deny_mutations.store(true, Ordering::SeqCst);
    assert_eq!(vault.delete(&reference()), Err(SecretError::locked()));
    assert_eq!(vault.get(&reference()), Err(SecretError::locked()));
    vault.backend.deny_mutations.store(false, Ordering::SeqCst);
    vault.delete(&reference()).unwrap();
    assert_eq!(vault.get(&reference()), Ok(None));
    assert_eq!(vault.has(&reference()), Ok(false));
}

#[cfg(target_os = "macos")]
#[test]
fn macos_keyring_platform_denials_remain_recognizable_as_locked() {
    for status in [-128, -25291, -25293, -25308, -25315] {
        let error = keyring::Error::PlatformFailure(Box::new(
            security_framework::base::Error::from_code(status),
        ));
        assert_eq!(map_keyring_error(&error), SecretError::locked());
    }
    let error =
        keyring::Error::PlatformFailure(Box::new(security_framework::base::Error::from_code(-50)));
    assert_eq!(
        map_keyring_error(&error),
        SecretError::error("storage_failed")
    );
}

fn request(url: String, method: &str, body: Option<Value>) -> HttpRequestDto {
    HttpRequestDto {
        url,
        method: method.into(),
        headers: Some(HashMap::from([(
            "Authorization".into(),
            format!("Bearer {}", reference().token().unwrap()),
        )])),
        body_mode: Some("json".into()),
        body,
        multipart: None,
        timeout_ms: Some(2_000),
        network_route: Some("direct".into()),
        custom_proxy_url: None,
        max_response_bytes: None,
    }
}

async fn serve_request(listener: &tokio::net::TcpListener, body: &str) -> String {
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let received = tokio::time::timeout(Duration::from_secs(3), async {
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0u8; 2048];
            let count = stream.read(&mut chunk).await.unwrap();
            assert_ne!(count, 0, "fixture request closed early");
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(boundary) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..boundary]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if bytes.len() >= boundary + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8(bytes).unwrap()
    })
    .await
    .unwrap();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await.unwrap();
    received
}

#[tokio::test]
async fn http_submit_poll_and_authenticated_result_download_read_credentials_once() {
    let vault = vault();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let image = r#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>"#;
    let server = tokio::spawn(async move {
        let responses = [
            r#"{"taskId":"accepted-task"}"#.to_string(),
            r#"{"status":"running"}"#.to_string(),
            serde_json::json!({"status":"succeeded", "url":format!("http://{address}/asset.svg?key={TEST_SECRET}")}).to_string(),
            image.to_string(),
        ];
        let mut received = Vec::new();
        for body in responses {
            received.push(serve_request(&listener, &body).await);
        }
        received
    });
    let submitted = custom_http_request_with_resolver(
        request(
            format!("http://{address}/submit"),
            "POST",
            Some(serde_json::json!({"prompt":"fixture"})),
        ),
        |reference| required(&vault, reference),
    )
    .await
    .unwrap();
    let task: Value = serde_json::from_str(&submitted.text).unwrap();
    assert_eq!(task["taskId"], "accepted-task");
    let mut result_url = String::new();
    for index in 0..2 {
        let response = custom_http_request_with_resolver(
            request(
                format!("http://{address}/result"),
                "POST",
                Some(serde_json::json!({"taskId":task["taskId"]})),
            ),
            |reference| required(&vault, reference),
        )
        .await
        .unwrap();
        assert!(!response.text.contains(TEST_SECRET));
        let result: Value = serde_json::from_str(&response.text).unwrap();
        if index == 0 {
            assert_eq!(result["status"], "running");
        } else {
            result_url = result["url"].as_str().unwrap().into();
        }
    }
    assert!(result_url.contains(&reference().token().unwrap()));
    let downloaded =
        custom_http_request_with_resolver(request(result_url, "GET", None), |reference| {
            required(&vault, reference)
        })
        .await
        .unwrap();
    assert_eq!(downloaded.text, image);
    assert_eq!(vault.backend.reads.load(Ordering::SeqCst), 1);
    let received = server.await.unwrap();
    assert!(received[0].starts_with("POST /submit "));
    for poll in &received[1..3] {
        assert!(poll.starts_with("POST /result "));
        assert!(poll.contains(r#""taskId":"accepted-task""#));
    }
    assert!(received[3].starts_with(&format!("GET /asset.svg?key={TEST_SECRET} ")));
    for raw in received {
        assert!(raw.contains(&format!("authorization: Bearer {TEST_SECRET}")));
    }
}

#[tokio::test]
async fn denied_http_queries_stop_before_network_and_resume_only_after_explicit_access_retry() {
    let vault = vault();
    vault.backend.deny_reads.store(true, Ordering::SeqCst);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    for _ in 0..4 {
        let response = custom_http_request_with_resolver(
            request(
                format!("http://{address}/result"),
                "POST",
                Some(serde_json::json!({"taskId":"already-accepted"})),
            ),
            |reference| required(&vault, reference),
        )
        .await;
        assert_eq!(response.unwrap_err(), SecretError::locked().to_string());
    }
    assert_eq!(vault.backend.reads.load(Ordering::SeqCst), 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
    vault.backend.deny_reads.store(false, Ordering::SeqCst);
    vault.retry_access(&reference()).unwrap();
    let server =
        tokio::spawn(async move { serve_request(&listener, r#"{"status":"succeeded"}"#).await });
    let recovered = custom_http_request_with_resolver(
        request(
            format!("http://{address}/result"),
            "POST",
            Some(serde_json::json!({"taskId":"already-accepted"})),
        ),
        |reference| required(&vault, reference),
    )
    .await
    .unwrap();
    assert_eq!(recovered.status, 200);
    assert!(recovered.text.contains("succeeded"));
    assert_eq!(vault.backend.reads.load(Ordering::SeqCst), 2);
    let recovered_request = server.await.unwrap();
    assert!(recovered_request.starts_with("POST /result "));
    assert!(recovered_request.contains("already-accepted"));
}

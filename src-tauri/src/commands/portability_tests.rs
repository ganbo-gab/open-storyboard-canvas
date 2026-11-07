use super::*;

fn valid_record() -> ProjectRecord {
    ProjectRecord {
        id: "project-1".to_string(),
        name: "Fixture".to_string(),
        created_at: 1,
        updated_at: 2,
        node_count: 0,
        nodes_json: "[]".to_string(),
        edges_json: "[]".to_string(),
        viewport_json: r#"{"x":0,"y":0,"zoom":1}"#.to_string(),
        history_json: r#"{"past":[],"future":[]}"#.to_string(),
        image_pool_json: Some("[]".to_string()),
    }
}

fn valid_manifest_asset() -> ProjectBundleAsset {
    let hash = sha256_hex(b"asset");
    ProjectBundleAsset {
        path: format!("assets/{hash}.png"),
        sha256: hash,
        size: 5,
        media_type: "image".to_string(),
        roles: vec!["nodes[0].data.imageUrl".to_string()],
    }
}

#[test]
fn rejects_path_traversal_and_absolute_paths() {
    assert!(!is_safe_bundle_path("../project.json"));
    assert!(!is_safe_bundle_path("assets/../../secret"));
    assert!(!is_safe_bundle_path("/tmp/secret"));
    assert!(!is_safe_bundle_path("C:/secret"));
    assert!(is_safe_bundle_path("assets/abc.png"));
}

#[test]
fn rejects_future_manifest_schema() {
    let manifest = ProjectBundleManifest {
        format: PROJECT_BUNDLE_FORMAT.to_string(),
        schema_version: PROJECT_BUNDLE_SCHEMA_VERSION + 1,
        app_version: "future".to_string(),
        created_at: "0".to_string(),
        project: ManifestProject {
            id: "id".to_string(),
            name: "name".to_string(),
            node_count: 0,
        },
        assets: vec![],
    };
    assert!(validate_manifest(&manifest)
        .expect_err("future schema must fail")
        .starts_with("future-schema"));
}

#[test]
fn checksum_is_sha256() {
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn validates_project_runtime_shapes_and_node_count() {
    let mut record = valid_record();
    assert!(validate_record(&record).is_ok());

    record.edges_json = "{}".to_string();
    assert!(validate_record(&record)
        .expect_err("object edges must fail")
        .contains("edgesJson"));
    record = valid_record();
    record.viewport_json = r#"{"x":0,"y":0,"zoom":0}"#.to_string();
    assert!(validate_record(&record)
        .expect_err("zero zoom must fail")
        .contains("viewportJson"));
    record = valid_record();
    record.node_count = 1;
    assert!(validate_record(&record)
        .expect_err("node count mismatch must fail")
        .starts_with("summary-mismatch"));
}

#[test]
fn validates_hash_named_assets_and_media_type() {
    let asset = valid_manifest_asset();
    let mut manifest = ProjectBundleManifest {
        format: PROJECT_BUNDLE_FORMAT.to_string(),
        schema_version: PROJECT_BUNDLE_SCHEMA_VERSION,
        app_version: "1.0.0".to_string(),
        created_at: "1".to_string(),
        project: ManifestProject {
            id: "project-1".to_string(),
            name: "Fixture".to_string(),
            node_count: 0,
        },
        assets: vec![asset],
    };
    assert!(validate_manifest(&manifest).is_ok());

    manifest.assets[0].media_type = "document".to_string();
    assert!(validate_manifest(&manifest)
        .expect_err("unknown media type must fail")
        .contains("media type"));
    manifest.assets[0] = valid_manifest_asset();
    manifest.assets[0].path = format!("assets/{}.png", "0".repeat(64));
    assert!(validate_manifest(&manifest)
        .expect_err("path hash mismatch must fail")
        .contains("SHA-256"));
}

#[test]
fn cancellation_requested_before_worker_start_is_not_cleared() {
    let jobs = PortabilityJobs::new();
    jobs.cancel("job-1".to_string()).unwrap();
    assert_eq!(jobs.start("job-1").unwrap_err(), "portability-cancelled");
    assert!(jobs.start("job-1").is_ok());
}

#[test]
fn stale_portable_asset_directories_are_removed_after_replace() {
    let root = std::env::temp_dir().join(format!("portability-cleanup-{}", Uuid::new_v4()));
    let old = root.join("old");
    let keep = root.join("keep");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::create_dir_all(&keep).unwrap();
    std::fs::write(old.join("asset.png"), b"old").unwrap();
    std::fs::write(keep.join("asset.png"), b"keep").unwrap();

    cleanup_portable_project_dirs(&root, Some(&keep)).unwrap();

    assert!(!old.exists());
    assert!(keep.join("asset.png").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn inventories_nested_director_video_audio_and_bundle_references() {
    let mut record = valid_record();
    record.node_count = 1;
    record.nodes_json = serde_json::to_string(&json!([{
        "id": "node",
        "data": {
            "localVideoUrl": "/tmp/video.mp4",
            "localAudioUrl": "/tmp/audio.wav",
            "directorStudioProjects": [{
                "snapshot": {
                    "backgroundPanoramaUrl": "bundle://assets/missing.jpg",
                    "referenceImages": [{ "url": "/tmp/reference.png" }]
                }
            }]
        }
    }]))
    .unwrap();
    let sources = collect_record_sources(&record);
    assert!(sources.contains_key("/tmp/video.mp4"));
    assert!(sources.contains_key("/tmp/audio.wav"));
    assert!(sources.contains_key("/tmp/reference.png"));
    assert!(sources.contains_key("bundle://assets/missing.jpg"));
}

fn legacy_credential_fixture() -> Value {
    json!({
        "providers": [{
            "apiKey": "sentinel-provider-key",
            "baseUrl": "https://sentinel-user:sentinel-userinfo@example.com/v1?api%5Fkey=sentinel-url-key&mode=portable",
            "extraHeaders": { "Authorization": "Bearer sentinel-header", "X-Access-Key": "sentinel-access-key", "Accept": "application/json" },
            "queryParams": { "key": "sentinel-query-key", "access_token": "sentinel-query-token", "vendor_key": "sentinel-legacy-auth-query", "version": "v1" },
            "extraParams": { "comfyOrgKey": "sentinel-comfy-key",
                "auth": { "mode": "query", "name": "vendor_key", "value": "sentinel-legacy-auth-value" } }
        }],
        "imageHost": { "password": "sentinel-image-password", "token": "sentinel-image-token" },
        "agentModels": [{ "apiKey": "sentinel-agent-key", "maxOutputTokens": 4096,
            "credentialRef": { "namespace": "agent-model", "id": "portable-model" } }],
        "oldBackup": "{\"nested\":{\"apiKey\":\"sentinel-encoded-key\",\"password\":\"sentinel-encoded-password\"}}",
        "request": {
            "malformedBackup": "{\"apiKey\":\"sentinel-malformed-backup\"",
            "rawRequest": "Authorization: sentinel-raw-header\nAccept: application/json",
            "formQuery": "api_key=sentinel-form-key&mode=portable",
            "auth": { "type": "query", "name": "vendor_auth", "value": "sentinel-auth-value" },
            "url": "/v1/tasks?vendor_auth=sentinel-custom-query&mode=portable",
            "queryParams": { "vendor_auth": "sentinel-custom-map" },
            "headers": [{ "name": "Authorization", "value": "sentinel-header-entry" }]
        },
        "migrationIssues": [{ "key": "extraParams.apiKey", "value": "sentinel-migration-key", "reason": "Unsupported" }]
    })
}

#[test]
fn project_portability_redacts_legacy_nested_snapshots_and_preserves_refs() {
    let fixture = legacy_credential_fixture();
    let mut record = valid_record();
    record.node_count = 1;
    record.nodes_json = json!([{ "id": "node", "data": { "settings": fixture } }]).to_string();
    record.history_json =
        json!({ "past": [{ "settings": legacy_credential_fixture() }], "future": [] }).to_string();
    record.image_pool_json =
        Some(json!(["https://example.com/image?token=sentinel-media-token"]).to_string());
    let safe = redact_project_credentials(record.clone());
    validate_record(&safe).unwrap();
    // The export writer serializes this record, and the import inspector uses the same sanitizer.
    let export = json!({ "schemaVersion": PROJECT_BUNDLE_SCHEMA_VERSION, "record": safe });
    assert!(!export.to_string().contains("sentinel-"));
    let nodes: Value =
        serde_json::from_str(export["record"]["nodesJson"].as_str().unwrap()).unwrap();
    assert_eq!(
        nodes[0]["data"]["settings"]["agentModels"][0]["credentialRef"],
        json!({ "namespace": "agent-model", "id": "portable-model" })
    );
    assert_eq!(
        nodes[0]["data"]["settings"]["providers"][0]["extraHeaders"],
        json!({ "Accept": "application/json" })
    );
    assert!(record.nodes_json.contains("sentinel-provider-key"));
    let imported = parse_project_payload(
        json!({ "schemaVersion": PROJECT_BUNDLE_SCHEMA_VERSION, "record": record }),
    )
    .unwrap();
    let imported = redact_project_credentials(imported);
    assert!(!serde_json::to_string(&imported)
        .unwrap()
        .contains("sentinel-"));
    let again = redact_project_credentials(imported.clone());
    assert_eq!(
        serde_json::to_value(imported).unwrap(),
        serde_json::to_value(again).unwrap()
    );
}

#[test]
fn settings_text_exports_and_legacy_imports_never_contain_credentials() {
    let legacy = json!({
        "format": "open-storyboard-settings", "schemaVersion": 1,
        "appVersion": "fixture", "createdAt": "1970-01-01T00:00:00.000Z",
        "includesCredentials": true,
        "categories": { "models": { "lastModelConfigByPanel": legacy_credential_fixture() } },
        "credentials": {
            "providerApiKeys": { "old": "sentinel-old-key" },
            "channelApiKeys": { "channel": "sentinel-channel-key" },
            "legacyProviderBackups": { "old": "{\"apiKey\":\"sentinel-archived-key\"}" },
            "imageHost": { "password": "sentinel-old-password" }
        }
    });
    let directory = tempfile::tempdir().unwrap();
    let exported_path = directory.path().join("export.osc-settings.json");
    write_portability_text_file(
        exported_path.to_string_lossy().into_owned(),
        legacy.to_string(),
    )
    .unwrap();
    let exported = std::fs::read_to_string(&exported_path).unwrap();
    assert!(!exported.contains("sentinel-"));
    let exported: Value = serde_json::from_str(&exported).unwrap();
    assert_eq!(exported["includesCredentials"], false);
    assert!(exported.get("credentials").is_none());
    assert_eq!(
        exported["categories"]["models"]["lastModelConfigByPanel"]["agentModels"][0]
            ["credentialRef"],
        json!({ "namespace": "agent-model", "id": "portable-model" })
    );
    let old_path = directory.path().join("old.osc-settings.json");
    std::fs::write(&old_path, legacy.to_string()).unwrap();
    let imported = read_portability_text_file(old_path.to_string_lossy().into_owned()).unwrap();
    assert!(!imported.contains("sentinel-"));
    assert_eq!(serde_json::from_str::<Value>(&imported).unwrap(), exported);
}

#[test]
fn portability_keeps_only_strict_refs_and_opaque_tokens_not_disguised_values() {
    for namespace in [
        "channel",
        "provider",
        "settings",
        "image-host",
        "agent-model",
        "comfyui",
    ] {
        let reference = json!({ "namespace": namespace, "id": "fixture:模型" });
        let token = format!(
            "__SC_SECRET_{}__",
            URL_SAFE_NO_PAD.encode(reference.to_string())
        );
        let mut value = json!({
            "credentialRef": reference, "apiKey": token, "header": format!("Bearer {token}"),
            "url": format!("https://example.com?api_key={token}"), "max_tokens": 2048
        });
        let original = value.clone();
        let mut changed = false;
        redact_portable_value(&mut value, "", &HashSet::new(), &mut changed);
        assert_eq!(value, original);
        assert!(!changed);
    }
    let fake_reference =
        json!({ "namespace": "provider", "id": "fixture", "value": "sentinel-disguised" });
    let fake_token = format!(
        "__SC_SECRET_{}__",
        URL_SAFE_NO_PAD.encode(fake_reference.to_string())
    );
    let mut value = json!({ "credentialRef": fake_reference, "apiKey": fake_token, "passwordRef": "sentinel-fake-ref" });
    redact_portable_value(&mut value, "", &HashSet::new(), &mut false);
    assert_eq!(value, json!({}));
}

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

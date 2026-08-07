use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::project_state::{
    get_project_record_impl, upsert_project_record_impl, ProjectDb, ProjectRecord,
};

const PROJECT_BUNDLE_FORMAT: &str = "open-storyboard-project";
const PROJECT_BUNDLE_SCHEMA_VERSION: u32 = 1;
const MAX_EXPANDED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
const MAX_JSON_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SETTINGS_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

const MEDIA_VALUE_KEYS: &[&str] = &[
    "imageUrl",
    "previewImageUrl",
    "thumbnailUrl",
    "sourceImageUrl",
    "snapshotUrl",
    "backgroundImageUrl",
    "backgroundPanoramaUrl",
    "coverUrl",
    "refImageUrl",
    "videoUrl",
    "localVideoUrl",
    "audioUrl",
    "localAudioUrl",
];
const MEDIA_LIST_KEYS: &[&str] = &["snapshotHistory", "imagePool"];

#[derive(Default)]
pub struct PortabilityJobs(Mutex<HashSet<String>>);

impl PortabilityJobs {
    pub fn new() -> Self {
        Self::default()
    }

    fn start(&self, job_id: &str) -> Result<(), String> {
        let was_cancelled = self
            .0
            .lock()
            .map_err(|error| format!("portability job mutex poisoned: {error}"))?
            .remove(job_id);
        if was_cancelled {
            Err("portability-cancelled".to_string())
        } else {
            Ok(())
        }
    }

    fn cancel(&self, job_id: String) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|error| format!("portability job mutex poisoned: {error}"))?
            .insert(job_id);
        Ok(())
    }

    fn finish(&self, job_id: &str) {
        if let Ok(mut jobs) = self.0.lock() {
            jobs.remove(job_id);
        }
    }

    fn ensure_active(&self, job_id: &str) -> Result<(), String> {
        let cancelled = self
            .0
            .lock()
            .map_err(|error| format!("portability job mutex poisoned: {error}"))?
            .contains(job_id);
        if cancelled {
            Err("portability-cancelled".to_string())
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBundleAsset {
    path: String,
    sha256: String,
    size: u64,
    media_type: String,
    roles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestProject {
    id: String,
    name: String,
    node_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBundleManifest {
    format: String,
    schema_version: u32,
    app_version: String,
    created_at: String,
    project: ManifestProject,
    assets: Vec<ProjectBundleAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBundleWarning {
    code: String,
    message: String,
    path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBundlePreview {
    manifest: ProjectBundleManifest,
    project_name: String,
    node_count: i64,
    asset_count: usize,
    asset_bytes: u64,
    warnings: Vec<ProjectBundleWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImportMode {
    kind: String,
    project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImportSummary {
    id: String,
    name: String,
    created_at: i64,
    updated_at: i64,
    node_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImportResult {
    project: ProjectImportSummary,
    warnings: Vec<ProjectBundleWarning>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortabilityProgress {
    job_id: String,
    stage: String,
    completed: usize,
    total: usize,
}

struct InspectedBundle {
    manifest: ProjectBundleManifest,
    record: ProjectRecord,
    warnings: Vec<ProjectBundleWarning>,
}

fn emit_progress(app: &AppHandle, job_id: &str, stage: &str, completed: usize, total: usize) {
    let _ = app.emit(
        "portability-progress",
        PortabilityProgress {
            job_id: job_id.to_string(),
            stage: stage.to_string(),
            completed,
            total,
        },
    );
}

fn now_millis() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock error: {error}"))?;
    i64::try_from(duration.as_millis()).map_err(|_| "Current time exceeds i64 range".to_string())
}

fn iso_timestamp() -> Result<String, String> {
    let millis = now_millis()?;
    Ok(format!("{millis}"))
}

fn is_safe_bundle_path(path: &str) -> bool {
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path.as_bytes().get(1) == Some(&b':')
    {
        return false;
    }
    Path::new(path)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_nonnegative_safe_i64(value: i64) -> bool {
    value >= 0 && (value as u64) <= MAX_SAFE_INTEGER
}

fn is_finite_json_number(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .map(f64::is_finite)
        .unwrap_or(false)
}

fn validate_record(record: &ProjectRecord) -> Result<(), String> {
    if record.id.trim().is_empty()
        || !is_nonnegative_safe_i64(record.created_at)
        || !is_nonnegative_safe_i64(record.updated_at)
        || !is_nonnegative_safe_i64(record.node_count)
    {
        return Err("invalid-project:project metadata is invalid".to_string());
    }
    if let Some(pool) = &record.image_pool_json {
        let value = serde_json::from_str::<Value>(pool)
            .map_err(|_| "invalid-project:imagePoolJson is invalid".to_string())?;
        if !value
            .as_array()
            .map(|items| items.iter().all(Value::is_string))
            .unwrap_or(false)
        {
            return Err("invalid-project:imagePoolJson must be a string array".to_string());
        }
    }
    let nodes = serde_json::from_str::<Value>(&record.nodes_json)
        .map_err(|_| "invalid-project:nodesJson is not valid JSON".to_string())?;
    let node_count = nodes
        .as_array()
        .ok_or_else(|| "invalid-project:nodesJson must be an array".to_string())?
        .len();
    if i64::try_from(node_count).ok() != Some(record.node_count) {
        return Err("summary-mismatch:project node count does not match nodesJson".to_string());
    }
    let edges = serde_json::from_str::<Value>(&record.edges_json)
        .map_err(|_| "invalid-project:edgesJson is not valid JSON".to_string())?;
    if !edges.is_array() {
        return Err("invalid-project:edgesJson must be an array".to_string());
    }
    let viewport = serde_json::from_str::<Value>(&record.viewport_json)
        .map_err(|_| "invalid-project:viewportJson is not valid JSON".to_string())?;
    let viewport = viewport
        .as_object()
        .ok_or_else(|| "invalid-project:viewportJson must be an object".to_string())?;
    if !is_finite_json_number(viewport.get("x"))
        || !is_finite_json_number(viewport.get("y"))
        || !is_finite_json_number(viewport.get("zoom"))
        || viewport.get("zoom").and_then(Value::as_f64).unwrap_or(0.0) <= 0.0
    {
        return Err("invalid-project:viewportJson is invalid".to_string());
    }
    let history = serde_json::from_str::<Value>(&record.history_json)
        .map_err(|_| "invalid-project:historyJson is not valid JSON".to_string())?;
    let history = history
        .as_object()
        .ok_or_else(|| "invalid-project:historyJson must be an object".to_string())?;
    for field in ["past", "future"] {
        if history.get(field).is_some_and(|value| !value.is_array()) {
            return Err(format!(
                "invalid-project:historyJson.{field} must be an array"
            ));
        }
    }
    Ok(())
}

fn validate_manifest(manifest: &ProjectBundleManifest) -> Result<(), String> {
    if manifest.format != PROJECT_BUNDLE_FORMAT {
        return Err("invalid-format:not an Open Storyboard project bundle".to_string());
    }
    if manifest.schema_version > PROJECT_BUNDLE_SCHEMA_VERSION {
        return Err("future-schema:bundle was created by a newer application version".to_string());
    }
    if manifest.schema_version != PROJECT_BUNDLE_SCHEMA_VERSION {
        return Err("unsupported-schema:project bundle schema is unsupported".to_string());
    }
    if manifest.app_version.trim().is_empty()
        || manifest.created_at.trim().is_empty()
        || manifest.project.id.trim().is_empty()
        || !is_nonnegative_safe_i64(manifest.project.node_count)
    {
        return Err("invalid-manifest:manifest metadata is incomplete".to_string());
    }
    if manifest.assets.len() > MAX_FILES.saturating_sub(2) {
        return Err("file-limit:bundle contains too many files".to_string());
    }
    let mut total = 0_u64;
    let mut paths = HashSet::new();
    for asset in &manifest.assets {
        if !is_safe_bundle_path(&asset.path) || !asset.path.starts_with("assets/") {
            return Err("unsafe-path:manifest contains an unsafe asset path".to_string());
        }
        if asset.size > MAX_FILE_BYTES || asset.size > MAX_SAFE_INTEGER {
            return Err("size-limit:asset exceeds the single-file limit".to_string());
        }
        total = total
            .checked_add(asset.size)
            .ok_or_else(|| "size-limit:bundle size overflow".to_string())?;
        if total > MAX_EXPANDED_BYTES {
            return Err("size-limit:bundle exceeds the expanded-size limit".to_string());
        }
        if asset.sha256.len() != 64
            || !asset
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("invalid-manifest:asset checksum is invalid".to_string());
        }
        let file_name = asset
            .path
            .strip_prefix("assets/")
            .ok_or_else(|| "invalid-manifest:asset path is invalid".to_string())?;
        let (path_hash, extension) = file_name
            .split_once('.')
            .ok_or_else(|| "invalid-manifest:asset path must include an extension".to_string())?;
        if path_hash != asset.sha256
            || extension.is_empty()
            || extension.len() > 8
            || !extension
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
        {
            return Err(
                "invalid-manifest:asset path must use its SHA-256 content hash".to_string(),
            );
        }
        if !matches!(
            asset.media_type.as_str(),
            "image" | "video" | "audio" | "binary"
        ) {
            return Err("invalid-manifest:asset media type is invalid".to_string());
        }
        let mut roles = HashSet::new();
        if asset
            .roles
            .iter()
            .any(|role| role.is_empty() || !roles.insert(role))
        {
            return Err("invalid-manifest:asset roles are invalid".to_string());
        }
        if !paths.insert(asset.path.clone()) {
            return Err("invalid-manifest:duplicate asset path".to_string());
        }
    }
    Ok(())
}

fn preflight_archive(archive: &mut ZipArchive<File>) -> Result<(), String> {
    if archive.len() > MAX_FILES {
        return Err("file-limit:bundle contains too many files".to_string());
    }
    let mut total = 0_u64;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("invalid-zip:{error}"))?;
        let name = entry.name().to_string();
        if !is_safe_bundle_path(&name) {
            return Err(format!("unsafe-path:unsafe ZIP entry {name}"));
        }
        if !names.insert(name) {
            return Err("invalid-zip:duplicate ZIP entry".to_string());
        }
        if entry.size() > MAX_FILE_BYTES {
            return Err("size-limit:ZIP entry exceeds the single-file limit".to_string());
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| "size-limit:bundle size overflow".to_string())?;
        if total > MAX_EXPANDED_BYTES {
            return Err("size-limit:bundle exceeds the expanded-size limit".to_string());
        }
    }
    Ok(())
}

fn validate_declared_entries(
    archive: &mut ZipArchive<File>,
    manifest: &ProjectBundleManifest,
) -> Result<(), String> {
    let mut declared = HashSet::from(["manifest.json".to_string(), "project.json".to_string()]);
    declared.extend(manifest.assets.iter().map(|asset| asset.path.clone()));
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("invalid-zip:{error}"))?;
        if !declared.contains(entry.name()) {
            return Err(format!("undeclared-entry:{}", entry.name()));
        }
    }
    Ok(())
}

fn read_archive_entry(
    archive: &mut ZipArchive<File>,
    path: &str,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, String> {
    let entry = match archive.by_name(path) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(format!("invalid-zip:{error}")),
    };
    if entry.size() > max_bytes {
        return Err(format!("size-limit:{path} exceeds its size limit"));
    }
    let capacity = usize::try_from(entry.size())
        .map_err(|_| format!("size-limit:{path} is too large for this platform"))?;
    let mut bytes = Vec::with_capacity(capacity);
    entry
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read-failed:failed to read {path}: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("size-limit:{path} exceeds its size limit"));
    }
    Ok(Some(bytes))
}

fn parse_project_payload(value: Value) -> Result<ProjectRecord, String> {
    let schema_version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "invalid-project:project schema version is missing".to_string())?;
    if schema_version > PROJECT_BUNDLE_SCHEMA_VERSION as u64 {
        return Err("future-schema:project data uses a newer schema version".to_string());
    }
    let record_value = if schema_version == PROJECT_BUNDLE_SCHEMA_VERSION as u64 {
        value.get("record")
    } else if schema_version == 0 {
        value.get("project")
    } else {
        None
    }
    .cloned()
    .ok_or_else(|| "unsupported-schema:project data schema is unsupported".to_string())?;
    let record = serde_json::from_value::<ProjectRecord>(record_value)
        .map_err(|error| format!("invalid-project:{error}"))?;
    validate_record(&record)?;
    Ok(record)
}

fn inspect_bundle_file(
    app: &AppHandle,
    path: &Path,
    job_id: &str,
) -> Result<InspectedBundle, String> {
    let jobs = app.state::<PortabilityJobs>();
    jobs.ensure_active(job_id)?;
    let file = File::open(path).map_err(|error| format!("read-failed:{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("invalid-zip:{error}"))?;
    preflight_archive(&mut archive)?;
    let manifest_bytes = read_archive_entry(&mut archive, "manifest.json", MAX_JSON_BYTES)?
        .ok_or_else(|| "missing-critical-file:manifest.json".to_string())?;
    let manifest = serde_json::from_slice::<ProjectBundleManifest>(&manifest_bytes)
        .map_err(|error| format!("invalid-manifest:{error}"))?;
    validate_manifest(&manifest)?;
    validate_declared_entries(&mut archive, &manifest)?;
    let project_bytes = read_archive_entry(&mut archive, "project.json", MAX_JSON_BYTES)?
        .ok_or_else(|| "missing-critical-file:project.json".to_string())?;
    let project_value = serde_json::from_slice::<Value>(&project_bytes)
        .map_err(|error| format!("invalid-project:{error}"))?;
    let record = parse_project_payload(project_value)?;
    if manifest.project.id != record.id
        || manifest.project.name != record.name
        || manifest.project.node_count != record.node_count
    {
        return Err("summary-mismatch:manifest and project summary do not match".to_string());
    }
    let mut warnings = Vec::new();
    let declared_assets: HashSet<&str> = manifest
        .assets
        .iter()
        .map(|asset| asset.path.as_str())
        .collect();
    let mut missing_references = HashSet::new();
    for source in collect_record_sources(&record).into_keys() {
        let Some(bundle_path) = source.strip_prefix("bundle://") else {
            continue;
        };
        if !is_safe_bundle_path(bundle_path) || !bundle_path.starts_with("assets/") {
            return Err(format!(
                "unsafe-path:project contains an unsafe bundle reference {bundle_path}"
            ));
        }
        if !declared_assets.contains(bundle_path)
            && missing_references.insert(bundle_path.to_string())
        {
            warnings.push(ProjectBundleWarning {
                code: "missing-asset".to_string(),
                message: format!("Project references an undeclared asset: {bundle_path}"),
                path: Some(bundle_path.to_string()),
            });
        }
    }
    for (index, asset) in manifest.assets.iter().enumerate() {
        jobs.ensure_active(job_id)?;
        emit_progress(
            app,
            job_id,
            "validating",
            index,
            manifest.assets.len().max(1),
        );
        let Some(bytes) = read_archive_entry(&mut archive, &asset.path, MAX_FILE_BYTES)? else {
            warnings.push(ProjectBundleWarning {
                code: "missing-asset".to_string(),
                message: format!("Missing non-critical asset: {}", asset.path),
                path: Some(asset.path.clone()),
            });
            continue;
        };
        if bytes.len() as u64 != asset.size || sha256_hex(&bytes) != asset.sha256 {
            return Err(format!("checksum-mismatch:{}", asset.path));
        }
    }
    Ok(InspectedBundle {
        manifest,
        record,
        warnings,
    })
}

fn preview_from_inspected(inspected: &InspectedBundle) -> ProjectBundlePreview {
    ProjectBundlePreview {
        manifest: inspected.manifest.clone(),
        project_name: inspected.record.name.clone(),
        node_count: inspected.record.node_count,
        asset_count: inspected.manifest.assets.len(),
        asset_bytes: inspected
            .manifest
            .assets
            .iter()
            .map(|asset| asset.size)
            .sum(),
        warnings: inspected.warnings.clone(),
    }
}

fn add_source(source: &str, role: String, sources: &mut HashMap<String, HashSet<String>>) {
    if source.is_empty() || source.starts_with("__img_ref__:") {
        return;
    }
    sources.entry(source.to_string()).or_default().insert(role);
}

fn collect_sources(value: &Value, path: &str, sources: &mut HashMap<String, HashSet<String>>) {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                collect_sources(item, &format!("{path}[{index}]"), sources);
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                let is_blueprint_reference_url =
                    key == "url" && path.contains("referenceImages[") && path.ends_with(']');
                if MEDIA_VALUE_KEYS.contains(&key.as_str()) || is_blueprint_reference_url {
                    if let Some(source) = child.as_str() {
                        add_source(source, child_path, sources);
                    }
                } else if MEDIA_LIST_KEYS.contains(&key.as_str()) {
                    if let Some(items) = child.as_array() {
                        for (index, item) in items.iter().enumerate() {
                            if let Some(source) = item.as_str() {
                                add_source(source, format!("{child_path}[{index}]"), sources);
                            } else {
                                collect_sources(item, &format!("{child_path}[{index}]"), sources);
                            }
                        }
                    }
                } else {
                    collect_sources(child, &child_path, sources);
                }
            }
        }
        _ => {}
    }
}

fn replace_sources(value: &mut Value, replacements: &HashMap<String, String>, path: &str) {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                replace_sources(item, replacements, &format!("{path}[{index}]"));
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                let is_blueprint_reference_url =
                    key == "url" && path.contains("referenceImages[") && path.ends_with(']');
                if MEDIA_VALUE_KEYS.contains(&key.as_str()) || is_blueprint_reference_url {
                    if let Some(source) = child.as_str() {
                        if let Some(replacement) = replacements.get(source) {
                            *child = Value::String(replacement.clone());
                        } else if source.starts_with("bundle://") {
                            *child = Value::String(format!(
                                "bundle-missing://{}",
                                source.trim_start_matches("bundle://")
                            ));
                        }
                    }
                } else if MEDIA_LIST_KEYS.contains(&key.as_str()) {
                    if let Some(items) = child.as_array_mut() {
                        for item in items {
                            if let Some(source) = item.as_str() {
                                if let Some(replacement) = replacements.get(source) {
                                    *item = Value::String(replacement.clone());
                                } else if source.starts_with("bundle://") {
                                    *item = Value::String(format!(
                                        "bundle-missing://{}",
                                        source.trim_start_matches("bundle://")
                                    ));
                                }
                            } else {
                                replace_sources(item, replacements, &child_path);
                            }
                        }
                    }
                } else {
                    replace_sources(child, replacements, &child_path);
                }
            }
        }
        _ => {}
    }
}

fn parse_or_default(raw: &str, fallback: Value) -> Value {
    serde_json::from_str(raw).unwrap_or(fallback)
}

fn collect_record_sources(record: &ProjectRecord) -> HashMap<String, HashSet<String>> {
    let mut sources = HashMap::new();
    collect_sources(
        &parse_or_default(&record.nodes_json, Value::Array(Vec::new())),
        "nodes",
        &mut sources,
    );
    collect_sources(
        &parse_or_default(&record.history_json, Value::Object(Default::default())),
        "history",
        &mut sources,
    );
    if let Some(pool_json) = &record.image_pool_json {
        if let Ok(Value::Array(pool)) = serde_json::from_str::<Value>(pool_json) {
            for (index, source) in pool.iter().enumerate() {
                if let Some(source) = source.as_str() {
                    add_source(source, format!("imagePool[{index}]"), &mut sources);
                }
            }
        }
    }
    sources
}

fn replace_record_sources(
    record: &ProjectRecord,
    replacements: &HashMap<String, String>,
) -> Result<ProjectRecord, String> {
    let mut next = record.clone();
    let mut nodes = parse_or_default(&record.nodes_json, Value::Array(Vec::new()));
    let mut history = parse_or_default(&record.history_json, Value::Object(Default::default()));
    let mut pool = record
        .image_pool_json
        .as_deref()
        .map(|raw| parse_or_default(raw, Value::Array(Vec::new())))
        .unwrap_or_else(|| Value::Array(Vec::new()));
    replace_sources(&mut nodes, replacements, "nodes");
    replace_sources(&mut history, replacements, "history");
    if let Some(items) = pool.as_array_mut() {
        for item in items {
            if let Some(source) = item.as_str() {
                if let Some(replacement) = replacements.get(source) {
                    *item = Value::String(replacement.clone());
                } else if source.starts_with("bundle://") {
                    *item = Value::String(format!(
                        "bundle-missing://{}",
                        source.trim_start_matches("bundle://")
                    ));
                }
            }
        }
    }
    next.nodes_json = serde_json::to_string(&nodes).map_err(|error| error.to_string())?;
    next.history_json = serde_json::to_string(&history).map_err(|error| error.to_string())?;
    next.image_pool_json = Some(serde_json::to_string(&pool).map_err(|error| error.to_string())?);
    Ok(next)
}

fn decode_path_like(source: &str) -> Option<PathBuf> {
    let trimmed = source.trim();
    let raw = if let Some(path) = trimmed.strip_prefix("file://") {
        path
    } else if let Some(path) = trimmed.strip_prefix("asset://localhost/") {
        path
    } else if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("blob:")
    {
        return None;
    } else {
        trimmed
    };
    let decoded = urlencoding::decode(raw).ok()?.into_owned();
    let path = if decoded.starts_with('/') {
        decoded
    } else if raw != trimmed {
        format!("/{decoded}")
    } else {
        decoded
    };
    let path = PathBuf::from(path);
    path.is_absolute().then_some(path)
}

fn materialize_source(source: &str) -> Result<Option<(Vec<u8>, String)>, String> {
    if let Some(rest) = source.strip_prefix("data:") {
        let (metadata, body) = rest
            .split_once(',')
            .ok_or_else(|| "unreadable-source:invalid data URL".to_string())?;
        if !metadata.ends_with(";base64") {
            return Err("unreadable-source:only base64 data URLs are supported".to_string());
        }
        let mime = metadata.trim_end_matches(";base64").to_string();
        let bytes = STANDARD
            .decode(body.as_bytes())
            .map_err(|error| format!("unreadable-source:invalid base64 data URL: {error}"))?;
        return Ok(Some((bytes, mime)));
    }
    let Some(path) = decode_path_like(source) else {
        return Ok(None);
    };
    if !path.is_file() {
        return Ok(None);
    }
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("unreadable-source:{error}"))?;
    if metadata.len() > MAX_FILE_BYTES {
        return Err("size-limit:project asset exceeds the single-file limit".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|error| format!("unreadable-source:{error}"))?;
    Ok(Some((bytes, String::new())))
}

fn extension_for_source(source: &str, mime: &str) -> String {
    let by_mime = match mime.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "audio/mpeg" => Some("mp3"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "audio/mp4" => Some("m4a"),
        "audio/ogg" => Some("ogg"),
        _ => None,
    };
    if let Some(extension) = by_mime {
        return extension.to_string();
    }
    let path = source.split(['?', '#']).next().unwrap_or(source);
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 8
                && value.bytes().all(|b| b.is_ascii_alphanumeric())
        })
        .unwrap_or("bin")
        .to_ascii_lowercase()
}

fn media_type_for(source: &str, mime: &str) -> String {
    let normalized = format!("{};{}", mime, source).to_ascii_lowercase();
    if normalized.contains("image/")
        || [".png", ".jpg", ".jpeg", ".webp", ".gif"]
            .iter()
            .any(|suffix| normalized.contains(suffix))
    {
        "image".to_string()
    } else if normalized.contains("video/")
        || [".mp4", ".mov", ".webm", ".mkv"]
            .iter()
            .any(|suffix| normalized.contains(suffix))
    {
        "video".to_string()
    } else if normalized.contains("audio/")
        || [".mp3", ".wav", ".m4a", ".aac", ".ogg"]
            .iter()
            .any(|suffix| normalized.contains(suffix))
    {
        "audio".to_string()
    } else {
        "binary".to_string()
    }
}

fn export_project_bundle_impl(
    app: &AppHandle,
    project_id: &str,
    destination_path: &Path,
    job_id: &str,
) -> Result<ProjectBundlePreview, String> {
    let jobs = app.state::<PortabilityJobs>();
    jobs.start(job_id)?;
    let result = (|| {
        emit_progress(app, job_id, "reading", 0, 1);
        let db = app.state::<ProjectDb>();
        let record = get_project_record_impl(app, &db, project_id)?
            .ok_or_else(|| "project-not-found".to_string())?;
        let sources = collect_record_sources(&record);
        let mut replacements = HashMap::new();
        let mut asset_bytes: HashMap<String, Vec<u8>> = HashMap::new();
        let mut assets_by_path: HashMap<String, ProjectBundleAsset> = HashMap::new();
        let mut warnings = Vec::new();
        for (index, (source, roles)) in sources.iter().enumerate() {
            jobs.ensure_active(job_id)?;
            emit_progress(app, job_id, "packing", index, sources.len().max(1));
            if source.starts_with("bundle://") {
                warnings.push(ProjectBundleWarning {
                    code: "missing-asset".to_string(),
                    message: format!("Project contains an unresolved bundle asset: {source}"),
                    path: Some(source.trim_start_matches("bundle://").to_string()),
                });
                continue;
            }
            let Some((bytes, mime)) = materialize_source(source)? else {
                let external = source.starts_with("http://") || source.starts_with("https://");
                warnings.push(ProjectBundleWarning {
                    code: if external {
                        "external-source"
                    } else {
                        "unreadable-source"
                    }
                    .to_string(),
                    message: if external {
                        "Remote media remains linked and was not downloaded."
                    } else {
                        "A local media source could not be read."
                    }
                    .to_string(),
                    path: None,
                });
                continue;
            };
            if bytes.len() as u64 > MAX_FILE_BYTES {
                return Err("size-limit:project asset exceeds the single-file limit".to_string());
            }
            let hash = sha256_hex(&bytes);
            let extension = extension_for_source(source, &mime);
            let asset_path = format!("assets/{hash}.{extension}");
            let asset =
                assets_by_path
                    .entry(asset_path.clone())
                    .or_insert_with(|| ProjectBundleAsset {
                        path: asset_path.clone(),
                        sha256: hash,
                        size: bytes.len() as u64,
                        media_type: media_type_for(source, &mime),
                        roles: Vec::new(),
                    });
            for role in roles {
                if !asset.roles.contains(role) {
                    asset.roles.push(role.clone());
                }
            }
            asset_bytes.entry(asset_path.clone()).or_insert(bytes);
            replacements.insert(source.clone(), format!("bundle://{asset_path}"));
        }
        let bundled_record = replace_record_sources(&record, &replacements)?;
        let mut assets: Vec<ProjectBundleAsset> = assets_by_path.into_values().collect();
        assets.sort_by(|left, right| left.path.cmp(&right.path));
        let manifest = ProjectBundleManifest {
            format: PROJECT_BUNDLE_FORMAT.to_string(),
            schema_version: PROJECT_BUNDLE_SCHEMA_VERSION,
            app_version: app.package_info().version.to_string(),
            created_at: iso_timestamp()?,
            project: ManifestProject {
                id: record.id.clone(),
                name: record.name.clone(),
                node_count: record.node_count,
            },
            assets,
        };
        validate_manifest(&manifest)?;
        let parent = destination_path
            .parent()
            .ok_or_else(|| "write-failed:destination has no parent directory".to_string())?;
        std::fs::create_dir_all(parent).map_err(|error| format!("write-failed:{error}"))?;
        let partial_path = parent.join(format!(".{}.partial", Uuid::new_v4()));
        let write_result = (|| {
            let file =
                File::create(&partial_path).map_err(|error| format!("write-failed:{error}"))?;
            let mut writer = ZipWriter::new(file);
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .unix_permissions(0o644);
            writer
                .start_file("manifest.json", options)
                .map_err(|error| format!("write-failed:{error}"))?;
            writer
                .write_all(
                    &serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
                )
                .map_err(|error| format!("write-failed:{error}"))?;
            writer
                .start_file("project.json", options)
                .map_err(|error| format!("write-failed:{error}"))?;
            writer
                .write_all(
                    &serde_json::to_vec(&json!({
                        "schemaVersion": PROJECT_BUNDLE_SCHEMA_VERSION,
                        "record": bundled_record,
                    }))
                    .map_err(|error| error.to_string())?,
                )
                .map_err(|error| format!("write-failed:{error}"))?;
            for (index, asset) in manifest.assets.iter().enumerate() {
                jobs.ensure_active(job_id)?;
                emit_progress(
                    app,
                    job_id,
                    "packing",
                    index + 1,
                    manifest.assets.len().max(1),
                );
                writer
                    .start_file(&asset.path, options)
                    .map_err(|error| format!("write-failed:{error}"))?;
                writer
                    .write_all(
                        asset_bytes
                            .get(&asset.path)
                            .ok_or_else(|| "write-failed:asset buffer missing".to_string())?,
                    )
                    .map_err(|error| format!("write-failed:{error}"))?;
            }
            writer
                .finish()
                .map_err(|error| format!("write-failed:{error}"))?;
            std::fs::rename(&partial_path, destination_path)
                .map_err(|error| format!("write-failed:{error}"))?;
            Ok::<(), String>(())
        })();
        if write_result.is_err() {
            let _ = std::fs::remove_file(&partial_path);
        }
        write_result?;
        Ok(ProjectBundlePreview {
            project_name: record.name,
            node_count: record.node_count,
            asset_count: manifest.assets.len(),
            asset_bytes: manifest.assets.iter().map(|asset| asset.size).sum(),
            manifest,
            warnings,
        })
    })();
    jobs.finish(job_id);
    result
}

fn is_safe_project_storage_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && value != "."
        && value != ".."
}

fn cleanup_portable_project_dirs(
    project_root: &Path,
    keep_directory: Option<&Path>,
) -> Result<(), String> {
    if !project_root.exists() {
        return Ok(());
    }
    for entry in
        std::fs::read_dir(project_root).map_err(|error| format!("cleanup-failed:{error}"))?
    {
        let entry = entry.map_err(|error| format!("cleanup-failed:{error}"))?;
        let path = entry.path();
        if keep_directory.is_some_and(|keep| keep == path) {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("cleanup-failed:{error}"))?;
        if file_type.is_dir() && !file_type.is_symlink() {
            std::fs::remove_dir_all(&path).map_err(|error| format!("cleanup-failed:{error}"))?;
        }
    }
    Ok(())
}

fn import_project_bundle_impl(
    app: &AppHandle,
    path: &Path,
    mode: &ProjectImportMode,
    imported_suffix: &str,
    job_id: &str,
) -> Result<ProjectImportResult, String> {
    let jobs = app.state::<PortabilityJobs>();
    jobs.start(job_id)?;
    let mut moved_dir: Option<PathBuf> = None;
    let result = (|| {
        let inspected = inspect_bundle_file(app, path, job_id)?;
        let db = app.state::<ProjectDb>();
        let now = now_millis()?;
        let mut target = inspected.record.clone();
        if mode.kind == "replace" {
            let target_id = mode.project_id.as_deref().ok_or_else(|| {
                "invalid-import-mode:replacement project id is missing".to_string()
            })?;
            let existing = get_project_record_impl(app, &db, target_id)?.ok_or_else(|| {
                "project-not-found:replacement target no longer exists".to_string()
            })?;
            target.id = existing.id;
            target.name = existing.name;
            target.created_at = existing.created_at;
            target.updated_at = now;
        } else if mode.kind == "new" {
            loop {
                let candidate = Uuid::new_v4().to_string();
                if get_project_record_impl(app, &db, &candidate)?.is_none() {
                    target.id = candidate;
                    break;
                }
            }
            target.name = format!("{}{}", target.name, imported_suffix);
            target.created_at = now;
            target.updated_at = now;
        } else {
            return Err("invalid-import-mode:unknown project import mode".to_string());
        }
        if !is_safe_project_storage_segment(&target.id) {
            return Err(
                "invalid-project:project id is unsafe for portable asset storage".to_string(),
            );
        }

        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("write-failed:{error}"))?;
        let temp_dir = app_data_dir
            .join("portability-tmp")
            .join(Uuid::new_v4().to_string());
        let project_assets_root = app_data_dir.join("portable-assets").join(&target.id);
        let final_dir = project_assets_root.join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&temp_dir).map_err(|error| format!("write-failed:{error}"))?;
        let extraction_result = (|| {
            let file = File::open(path).map_err(|error| format!("read-failed:{error}"))?;
            let mut archive =
                ZipArchive::new(file).map_err(|error| format!("invalid-zip:{error}"))?;
            preflight_archive(&mut archive)?;
            let mut replacements = HashMap::new();
            for (index, asset) in inspected.manifest.assets.iter().enumerate() {
                jobs.ensure_active(job_id)?;
                emit_progress(
                    app,
                    job_id,
                    "extracting",
                    index,
                    inspected.manifest.assets.len().max(1),
                );
                let Some(bytes) = read_archive_entry(&mut archive, &asset.path, MAX_FILE_BYTES)?
                else {
                    replacements.insert(
                        format!("bundle://{}", asset.path),
                        format!("bundle-missing://{}", asset.path),
                    );
                    continue;
                };
                if bytes.len() as u64 != asset.size || sha256_hex(&bytes) != asset.sha256 {
                    return Err(format!("checksum-mismatch:{}", asset.path));
                }
                let file_name = Path::new(&asset.path)
                    .file_name()
                    .ok_or_else(|| "unsafe-path:asset filename is missing".to_string())?;
                let temp_path = temp_dir.join(file_name);
                std::fs::write(&temp_path, bytes)
                    .map_err(|error| format!("write-failed:{error}"))?;
                replacements.insert(
                    format!("bundle://{}", asset.path),
                    final_dir.join(file_name).to_string_lossy().into_owned(),
                );
            }
            target = replace_record_sources(&target, &replacements)?;
            Ok::<(), String>(())
        })();
        if extraction_result.is_err() {
            let _ = std::fs::remove_dir_all(&temp_dir);
        }
        extraction_result?;
        jobs.ensure_active(job_id)?;
        if inspected.manifest.assets.iter().any(|asset| {
            temp_dir
                .join(Path::new(&asset.path).file_name().unwrap_or_default())
                .exists()
        }) {
            let parent = final_dir
                .parent()
                .ok_or_else(|| "write-failed:asset destination has no parent".to_string())?;
            std::fs::create_dir_all(parent).map_err(|error| format!("write-failed:{error}"))?;
            std::fs::rename(&temp_dir, &final_dir)
                .map_err(|error| format!("write-failed:{error}"))?;
            moved_dir = Some(final_dir.clone());
        } else {
            let _ = std::fs::remove_dir_all(&temp_dir);
        }
        emit_progress(app, job_id, "committing", 0, 1);
        jobs.ensure_active(job_id)?;
        if let Err(error) = upsert_project_record_impl(app, &db, target.clone()) {
            if let Some(directory) = &moved_dir {
                let _ = std::fs::remove_dir_all(directory);
            }
            return Err(error);
        }
        let committed_dir = moved_dir.take();
        if let Err(error) =
            cleanup_portable_project_dirs(&project_assets_root, committed_dir.as_deref())
        {
            warn!(
                project_id = %target.id,
                error = %error,
                "failed to clean stale portable project assets after commit"
            );
        }
        emit_progress(app, job_id, "done", 1, 1);
        Ok(ProjectImportResult {
            project: ProjectImportSummary {
                id: target.id,
                name: target.name,
                created_at: target.created_at,
                updated_at: target.updated_at,
                node_count: target.node_count,
            },
            warnings: inspected.warnings,
        })
    })();
    if result.is_err() {
        if let Some(directory) = &moved_dir {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
    jobs.finish(job_id);
    result
}

#[tauri::command]
pub async fn export_project_bundle(
    app: AppHandle,
    project_id: String,
    destination_path: String,
    job_id: String,
) -> Result<ProjectBundlePreview, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        export_project_bundle_impl(
            &worker_app,
            &project_id,
            Path::new(&destination_path),
            &job_id,
        )
    })
    .await
    .map_err(|error| format!("portability-worker-failed:{error}"))?
}

#[tauri::command]
pub async fn inspect_project_bundle(
    app: AppHandle,
    path: String,
    job_id: String,
) -> Result<ProjectBundlePreview, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let jobs = worker_app.state::<PortabilityJobs>();
        jobs.start(&job_id)?;
        let result = inspect_bundle_file(&worker_app, Path::new(&path), &job_id)
            .map(|inspected| preview_from_inspected(&inspected));
        jobs.finish(&job_id);
        result
    })
    .await
    .map_err(|error| format!("portability-worker-failed:{error}"))?
}

#[tauri::command]
pub async fn import_project_bundle(
    app: AppHandle,
    path: String,
    mode: ProjectImportMode,
    imported_suffix: String,
    job_id: String,
) -> Result<ProjectImportResult, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_project_bundle_impl(
            &worker_app,
            Path::new(&path),
            &mode,
            &imported_suffix,
            &job_id,
        )
    })
    .await
    .map_err(|error| format!("portability-worker-failed:{error}"))?
}

#[tauri::command]
pub fn cancel_portability_operation(app: AppHandle, job_id: String) -> Result<(), String> {
    app.state::<PortabilityJobs>().cancel(job_id)
}

#[tauri::command]
pub fn write_portability_text_file(path: String, content: String) -> Result<(), String> {
    if content.len() as u64 > MAX_SETTINGS_BYTES {
        return Err("size-limit:settings file is too large".to_string());
    }
    let destination = PathBuf::from(path);
    let parent = destination
        .parent()
        .ok_or_else(|| "write-failed:destination has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("write-failed:{error}"))?;
    let partial = parent.join(format!(".{}.partial", Uuid::new_v4()));
    let result = (|| {
        std::fs::write(&partial, content.as_bytes())
            .map_err(|error| format!("write-failed:{error}"))?;
        std::fs::rename(&partial, &destination).map_err(|error| format!("write-failed:{error}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(partial);
    }
    result
}

#[tauri::command]
pub fn read_portability_text_file(path: String) -> Result<String, String> {
    let source = PathBuf::from(path);
    let metadata = std::fs::metadata(&source).map_err(|error| format!("read-failed:{error}"))?;
    if metadata.len() > MAX_SETTINGS_BYTES {
        return Err("size-limit:settings file is too large".to_string());
    }
    std::fs::read_to_string(source).map_err(|error| format!("read-failed:{error}"))
}

#[cfg(test)]
#[path = "portability_tests.rs"]
mod tests;

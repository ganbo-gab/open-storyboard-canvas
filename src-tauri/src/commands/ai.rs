use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;
use tracing::info;
use uuid::Uuid;

use super::secrets::{SecretError, SecretRef};
use crate::ai::error::AIError;
use crate::ai::providers::build_default_providers;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderRegistry, ProviderTaskHandle, ProviderTaskPollResult,
    ProviderTaskSubmission,
};

static REGISTRY: std::sync::OnceLock<ProviderRegistry> = std::sync::OnceLock::new();
static ACTIVE_NON_RESUMABLE_JOB_IDS: std::sync::OnceLock<Arc<RwLock<HashSet<String>>>> =
    std::sync::OnceLock::new();

fn get_registry() -> &'static ProviderRegistry {
    REGISTRY.get_or_init(|| {
        let mut registry = ProviderRegistry::new();
        for provider in build_default_providers() {
            registry.register_provider(provider);
        }
        registry
    })
}

fn active_non_resumable_job_ids() -> &'static Arc<RwLock<HashSet<String>>> {
    ACTIVE_NON_RESUMABLE_JOB_IDS.get_or_init(|| Arc::new(RwLock::new(HashSet::new())))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateRequestDto {
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub aspect_ratio: String,
    pub reference_images: Option<Vec<String>>,
    pub extra_params: Option<HashMap<String, Value>>,
}

#[derive(Debug, Serialize)]
pub struct GenerationJobStatusDto {
    pub job_id: String,
    pub status: String,
    pub result: Option<String>,
    pub error: Option<String>,
    pub media_type: String,
    pub provider_id: String,
    pub model_id: Option<String>,
    pub config_fingerprint: Option<String>,
    pub phase: String,
    pub external_task_id: Option<String>,
    pub poll_descriptor: Option<Value>,
    pub result_url: Option<String>,
    pub error_category: Option<String>,
    pub network_route: String,
    pub submit_attempts: u32,
    pub consecutive_network_errors: u32,
    pub last_poll_at: Option<i64>,
    pub resumable: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_result_missing: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGenerationJobDto {
    pub job_id: Option<String>,
    pub media_type: String,
    pub provider_id: String,
    pub model_id: Option<String>,
    pub config_fingerprint: Option<String>,
    pub status: Option<String>,
    pub phase: Option<String>,
    pub external_task_id: Option<String>,
    pub poll_descriptor: Option<Value>,
    pub result_url: Option<String>,
    pub error: Option<String>,
    pub error_category: Option<String>,
    pub network_route: Option<String>,
    pub resumable: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGenerationJobDto {
    pub job_id: String,
    pub status: Option<String>,
    pub phase: Option<String>,
    pub external_task_id: Option<String>,
    pub poll_descriptor: Option<Value>,
    pub result: Option<String>,
    pub result_url: Option<String>,
    pub error: Option<String>,
    pub error_category: Option<String>,
    pub network_route: Option<String>,
    pub resumable: Option<bool>,
    pub last_poll_at: Option<i64>,
    pub consecutive_network_errors: Option<u32>,
}

#[derive(Debug)]
struct GenerationJobRecord {
    job_id: String,
    provider_id: String,
    media_type: String,
    model_id: Option<String>,
    config_fingerprint: Option<String>,
    status: String,
    phase: String,
    resumable: bool,
    external_task_id: Option<String>,
    poll_descriptor_json: Option<String>,
    result: Option<String>,
    result_url: Option<String>,
    error: Option<String>,
    error_category: Option<String>,
    network_route: String,
    submit_attempts: u32,
    consecutive_network_errors: u32,
    last_poll_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

const TERMINAL_STATUSES: [&str; 4] = ["succeeded", "failed", "not_found", "canceled"];

fn is_valid_status(status: &str) -> bool {
    matches!(
        status,
        "queued"
            | "submitting"
            | "running"
            | "recoverable_wait"
            | "materializing"
            | "succeeded"
            | "failed"
            | "not_found"
            | "unknown"
            | "canceled"
    )
}

fn validate_status_transition(
    from: Option<&str>,
    to: &str,
    submit_attempts: u32,
) -> Result<(), String> {
    if !is_valid_status(to) {
        return Err(format!("unsupported generation job status: {to}"));
    }
    if submit_attempts > 1 {
        return Err("generation job submit_attempts cannot exceed 1".to_string());
    }
    let Some(from) = from else {
        return Ok(());
    };
    if from == to {
        return Ok(());
    }
    if TERMINAL_STATUSES.contains(&from) {
        return Err(format!(
            "terminal generation job cannot transition from {from} to {to}"
        ));
    }
    if from == "unknown" && to != "running" && to != "recoverable_wait" && to != "canceled" {
        return Err(
            "unknown generation jobs require an external task id before recovery".to_string(),
        );
    }
    if to == "submitting" && submit_attempts > 0 {
        return Err(
            "generation job submit already attempted; refusing duplicate submission".to_string(),
        );
    }
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data_dir.join("projects.db"))
}

fn ensure_generation_jobs_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_generation_jobs (
          job_id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          media_type TEXT NOT NULL DEFAULT 'image',
          model_id TEXT,
          config_fingerprint TEXT,
          status TEXT NOT NULL,
          phase TEXT NOT NULL DEFAULT 'submit',
          resumable INTEGER NOT NULL DEFAULT 0,
          external_task_id TEXT,
          external_task_meta_json TEXT,
          poll_descriptor_json TEXT,
          result TEXT,
          result_url TEXT,
          error TEXT,
          error_category TEXT,
          network_route TEXT NOT NULL DEFAULT 'system',
          submit_attempts INTEGER NOT NULL DEFAULT 0,
          consecutive_network_errors INTEGER NOT NULL DEFAULT 0,
          last_poll_at INTEGER,
          sensitive_fields_scrubbed INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_status ON ai_generation_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_updated_at ON ai_generation_jobs(updated_at DESC);
        "#,
    )
    .map_err(|e| format!("Failed to initialize ai_generation_jobs table: {}", e))?;

    // Older desktop databases predate the coordinator fields. Add only missing
    // columns so upgrades are safe on both Windows and macOS.
    let columns = [
        ("media_type", "TEXT NOT NULL DEFAULT 'image'"),
        ("model_id", "TEXT"),
        ("config_fingerprint", "TEXT"),
        ("phase", "TEXT NOT NULL DEFAULT 'submit'"),
        ("poll_descriptor_json", "TEXT"),
        ("result_url", "TEXT"),
        ("error_category", "TEXT"),
        ("network_route", "TEXT NOT NULL DEFAULT 'system'"),
        ("submit_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("consecutive_network_errors", "INTEGER NOT NULL DEFAULT 0"),
        ("last_poll_at", "INTEGER"),
        ("sensitive_fields_scrubbed", "INTEGER NOT NULL DEFAULT 0"),
    ];
    let mut statement = conn
        .prepare("PRAGMA table_info(ai_generation_jobs)")
        .map_err(|e| format!("Failed to inspect generation job schema: {e}"))?;
    let existing = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to enumerate generation job schema: {e}"))?
        .collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|e| format!("Failed to read generation job schema: {e}"))?;
    drop(statement);
    for (name, declaration) in columns {
        if !existing.contains(name) {
            conn.execute(
                &format!("ALTER TABLE ai_generation_jobs ADD COLUMN {name} {declaration}"),
                [],
            )
            .map_err(|e| format!("Failed to migrate generation job column {name}: {e}"))?;
        }
    }

    let mut scrub_statement = conn
        .prepare(
            "SELECT job_id, error, error_category, config_fingerprint, \
             COALESCE(poll_descriptor_json, external_task_meta_json), provider_id, external_task_id \
             FROM ai_generation_jobs WHERE sensitive_fields_scrubbed = 0",
        )
        .map_err(|e| format!("Failed to prepare generation job scrub: {e}"))?;
    let scrub_rows = scrub_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(|e| format!("Failed to query generation jobs for scrub: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read generation jobs for scrub: {e}"))?;
    drop(scrub_statement);
    for (
        job_id,
        error,
        error_category,
        config_fingerprint,
        raw_descriptor,
        provider_id,
        external_task_id,
    ) in scrub_rows
    {
        let safe_error = sanitize_optional_diagnostic(error.as_deref());
        let safe_error_category = sanitize_error_category(error_category.as_deref());
        let safe_config_fingerprint = sanitize_config_fingerprint(config_fingerprint.as_deref());
        let safe_descriptor = raw_descriptor
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        let safe_descriptor = sanitize_job_poll_descriptor(
            safe_descriptor,
            &job_id,
            &provider_id,
            external_task_id.as_deref(),
        )
        .unwrap_or(None);
        conn.execute(
            r#"UPDATE ai_generation_jobs SET
              error = ?1,
              error_category = ?2,
              config_fingerprint = ?3,
              poll_descriptor_json = ?4,
              external_task_meta_json = NULL,
              sensitive_fields_scrubbed = 1
            WHERE job_id = ?5"#,
            params![
                safe_error,
                safe_error_category,
                safe_config_fingerprint,
                safe_descriptor,
                job_id
            ],
        )
        .map_err(|e| format!("Failed to scrub generation job {job_id}: {e}"))?;
    }

    Ok(())
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let db_path = resolve_db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open SQLite DB: {}", e))?;

    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("Failed to set journal_mode=WAL: {}", e))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("Failed to set synchronous=NORMAL: {}", e))?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|e| format!("Failed to set temp_store=MEMORY: {}", e))?;
    conn.busy_timeout(Duration::from_millis(3000))
        .map_err(|e| format!("Failed to set busy timeout: {}", e))?;

    ensure_generation_jobs_table(&conn)?;
    Ok(conn)
}

fn insert_generation_job(
    app: &AppHandle,
    job_id: &str,
    provider_id: &str,
    status: &str,
    resumable: bool,
    external_task_id: Option<&str>,
    external_task_meta_json: Option<&str>,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    insert_generation_job_record(
        app,
        job_id,
        provider_id,
        "image",
        None,
        None,
        status,
        if status == "succeeded" {
            "materializing"
        } else {
            "submit"
        },
        resumable,
        external_task_id,
        external_task_meta_json,
        result,
        result,
        error,
        if error.is_some() {
            Some("provider")
        } else {
            None
        },
        "system",
        if status == "running" || status == "succeeded" {
            1
        } else {
            0
        },
        None,
        0,
    )
}

#[allow(clippy::too_many_arguments)]
fn insert_generation_job_record(
    app: &AppHandle,
    job_id: &str,
    provider_id: &str,
    media_type: &str,
    model_id: Option<&str>,
    config_fingerprint: Option<&str>,
    status: &str,
    phase: &str,
    resumable: bool,
    external_task_id: Option<&str>,
    poll_descriptor_json: Option<&str>,
    result: Option<&str>,
    result_url: Option<&str>,
    error: Option<&str>,
    error_category: Option<&str>,
    network_route: &str,
    submit_attempts: u32,
    last_poll_at: Option<i64>,
    consecutive_network_errors: u32,
) -> Result<(), String> {
    validate_status_transition(None, status, submit_attempts)?;
    validate_generation_media_type(media_type)?;
    let config_fingerprint = sanitize_config_fingerprint(config_fingerprint);
    let external_task_id = sanitize_external_task_id(external_task_id);
    let poll_descriptor_json =
        poll_descriptor_json.and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let poll_descriptor_json = sanitize_job_poll_descriptor(
        poll_descriptor_json,
        job_id,
        provider_id,
        external_task_id.as_deref(),
    )?;
    let result = result.filter(|value| is_persistable_result_source(value, false));
    let result_url = result_url.filter(|value| is_persistable_result_source(value, true));
    let error = sanitize_optional_diagnostic(error);
    let error_category = sanitize_error_category(error_category);
    let conn = open_db(app)?;
    let now = now_ms();
    conn.execute(
        r#"
        INSERT INTO ai_generation_jobs (
          job_id,
          provider_id,
          media_type,
          model_id,
          config_fingerprint,
          status,
          phase,
          resumable,
          external_task_id,
          poll_descriptor_json,
          result,
          result_url,
          error,
          error_category,
          network_route,
          submit_attempts,
          consecutive_network_errors,
          last_poll_at,
          sensitive_fields_scrubbed,
          created_at,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 1, ?19, ?20)
        "#,
        params![
            job_id,
            provider_id,
            media_type,
            model_id,
            config_fingerprint,
            status,
            phase,
            if resumable { 1_i64 } else { 0_i64 },
            external_task_id,
            poll_descriptor_json,
            result,
            result_url,
            error,
            error_category,
            network_route,
            i64::from(submit_attempts),
            i64::from(consecutive_network_errors),
            last_poll_at,
            now,
            now
        ],
    )
    .map_err(|e| format!("Failed to insert generation job: {}", e))?;
    Ok(())
}

fn update_generation_job(
    app: &AppHandle,
    job_id: &str,
    status: &str,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let result = result.filter(|value| is_persistable_result_source(value, false));
    let error = sanitize_optional_diagnostic(error);
    let conn = open_db(app)?;
    let current_status = conn
        .query_row(
            "SELECT status, submit_attempts FROM ai_generation_jobs WHERE job_id = ?1",
            params![job_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u32)),
        )
        .map_err(|e| format!("Failed to load generation job before update: {e}"))?;
    validate_status_transition(Some(current_status.0.as_str()), status, current_status.1)?;
    conn.execute(
        r#"
        UPDATE ai_generation_jobs
        SET
          status = ?1,
          result = ?2,
          error = ?3,
          updated_at = ?4
        WHERE job_id = ?5
        "#,
        params![status, result, error, now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to update generation job: {}", e))?;
    Ok(())
}

fn touch_generation_job(app: &AppHandle, job_id: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "UPDATE ai_generation_jobs SET updated_at = ?1 WHERE job_id = ?2",
        params![now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to touch generation job: {}", e))?;
    Ok(())
}

fn get_generation_job(
    app: &AppHandle,
    job_id: &str,
) -> Result<Option<GenerationJobRecord>, String> {
    let conn = open_db(app)?;
    get_generation_job_from_connection(&conn, job_id)
}

fn get_generation_job_from_connection(
    conn: &Connection,
    job_id: &str,
) -> Result<Option<GenerationJobRecord>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              job_id,
              provider_id,
              media_type,
              model_id,
              config_fingerprint,
              status,
              phase,
              resumable,
              external_task_id,
              COALESCE(poll_descriptor_json, external_task_meta_json) AS poll_descriptor_json,
              result,
              result_url,
              error,
              error_category,
              network_route,
              submit_attempts,
              consecutive_network_errors,
              last_poll_at,
              created_at,
              updated_at
            FROM ai_generation_jobs
            WHERE job_id = ?1
            LIMIT 1
            "#,
        )
        .map_err(|e| format!("Failed to prepare generation job query: {}", e))?;

    let result = stmt.query_row(params![job_id], |row| {
        Ok(GenerationJobRecord {
            job_id: row.get(0)?,
            provider_id: row.get(1)?,
            media_type: row.get(2)?,
            model_id: row.get(3)?,
            config_fingerprint: row.get(4)?,
            status: row.get(5)?,
            phase: row.get(6)?,
            resumable: row.get::<_, i64>(7)? != 0,
            external_task_id: row.get(8)?,
            poll_descriptor_json: row.get(9)?,
            result: row.get(10)?,
            result_url: row.get(11)?,
            error: row.get(12)?,
            error_category: row.get(13)?,
            network_route: row.get(14)?,
            submit_attempts: row.get::<_, i64>(15)? as u32,
            consecutive_network_errors: row.get::<_, i64>(16)? as u32,
            last_poll_at: row.get(17)?,
            created_at: row.get(18)?,
            updated_at: row.get(19)?,
        })
    });

    match result {
        Ok(mut record) => {
            record.poll_descriptor_json = record
                .poll_descriptor_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .and_then(|value| {
                    sanitize_job_poll_descriptor(
                        Some(value),
                        &record.job_id,
                        &record.provider_id,
                        record.external_task_id.as_deref(),
                    )
                    .ok()
                    .flatten()
                });
            Ok(Some(record))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("Failed to load generation job: {}", error)),
    }
}

fn dto_from_record(record: &GenerationJobRecord) -> GenerationJobStatusDto {
    GenerationJobStatusDto {
        job_id: record.job_id.clone(),
        status: record.status.clone(),
        result: record.result.clone(),
        error: record.error.clone(),
        media_type: record.media_type.clone(),
        provider_id: record.provider_id.clone(),
        model_id: record.model_id.clone(),
        config_fingerprint: record.config_fingerprint.clone(),
        phase: record.phase.clone(),
        external_task_id: record.external_task_id.clone(),
        poll_descriptor: record
            .poll_descriptor_json
            .as_deref()
            .and_then(|value| serde_json::from_str(value).ok()),
        result_url: record.result_url.clone(),
        error_category: record.error_category.clone(),
        network_route: record.network_route.clone(),
        submit_attempts: record.submit_attempts,
        consecutive_network_errors: record.consecutive_network_errors,
        last_poll_at: record.last_poll_at,
        resumable: record.resumable,
        created_at: record.created_at,
        updated_at: record.updated_at,
        local_result_missing: None,
    }
}

/// Only inspect durable media paths from the accepted v2 snapshot. Text/model
/// identifiers and inaccessible volumes are not evidence of missing bytes.
fn missing_v2_result_bytes(record: &GenerationJobRecord) -> bool {
    if record.status != "succeeded" {
        return false;
    }
    let Some(snapshot) = record
        .poll_descriptor_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
    else {
        return false;
    };
    if snapshot.get("version").and_then(Value::as_u64) != Some(2) {
        return false;
    }
    let Some(assets) = snapshot.get("assets").and_then(Value::as_array) else {
        return false;
    };
    assets.iter().enumerate().any(|(index, value)| {
        let kind = snapshot
            .get("assetKinds")
            .and_then(Value::as_array)
            .and_then(|kinds| kinds.get(index))
            .and_then(Value::as_str)
            .or_else(|| {
                snapshot
                    .get("outputs")
                    .and_then(Value::as_array)
                    .and_then(|outputs| outputs.get(index))
                    .and_then(|output| output.get("kind"))
                    .and_then(Value::as_str)
            })
            .unwrap_or(
                if snapshot.pointer("/input/operation").and_then(Value::as_str) == Some("chat") {
                    "text"
                } else {
                    &record.media_type
                },
            );
        if !matches!(kind, "image" | "video" | "audio") {
            return false;
        }
        let Some(source) = value.as_str() else {
            return false;
        };
        let path = if source.starts_with("file:") {
            let Ok(url) = reqwest::Url::parse(source) else {
                return false;
            };
            let Ok(path) = url.to_file_path() else {
                return false;
            };
            path
        } else {
            std::path::PathBuf::from(source)
        };
        path.is_absolute()
            && std::fs::metadata(path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn permits_missing_result_recovery(
    record: &GenerationJobRecord,
    status: &str,
    task_id: Option<&str>,
) -> bool {
    if record.submit_attempts > 1
        || !matches!(status, "recoverable_wait" | "materializing" | "running")
        || !missing_v2_result_bytes(record)
        || (status == "running" && record.external_task_id.is_none())
        || task_id.is_some_and(|id| Some(id) != record.external_task_id.as_deref())
    {
        return false;
    }
    record.external_task_id.is_some()
        || record
            .poll_descriptor_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|snapshot| {
                snapshot
                    .get("outputs")
                    .and_then(Value::as_array)
                    .map(|outputs| !outputs.is_empty())
            })
            .unwrap_or(false)
}

fn normalize_job_token(value: Option<String>, fallback: &str, max_len: usize) -> String {
    value
        .unwrap_or_else(|| fallback.to_string())
        .trim()
        .chars()
        .take(max_len)
        .collect()
}

fn is_persistable_result_source(value: &str, remote_only: bool) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 4096
        || trimmed.to_ascii_lowercase().starts_with("data:")
        || trimmed.to_ascii_lowercase().starts_with("blob:")
    {
        return false;
    }
    if trimmed.len() > 300
        && trimmed.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'_' | b'-')
        })
    {
        return false;
    }
    !remote_only || trimmed.starts_with("https://") || trimmed.starts_with("http://")
}

fn sanitize_diagnostic_text(value: &str) -> String {
    let mut output = String::with_capacity(value.len().min(2048));
    let mut redact_next = false;
    for token in value.split_whitespace() {
        let lowered = token.to_ascii_lowercase();
        let marker = lowered.trim_matches(|ch: char| matches!(ch, ':' | '=' | ',' | '"' | '\''));
        let is_credential_marker = matches!(
            marker,
            "authorization" | "api_key" | "apikey" | "api-key" | "token" | "secret" | "cookie"
        );
        let is_payload = lowered.starts_with("data:")
            || lowered.starts_with("blob:")
            || (token.len() > 160
                && token.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'_' | b'-')
                }));
        let is_credential = is_credential_marker
            || lowered.starts_with("bearer")
            || lowered.contains("authorization=")
            || lowered.contains("authorization:")
            || lowered.contains("api_key=")
            || lowered.contains("apikey=")
            || lowered.contains("api-key=")
            || lowered.contains("token=")
            || lowered.contains("secret=")
            || lowered.contains("cookie=");
        let safe_token = if is_payload {
            "[payload omitted]"
        } else if redact_next || is_credential {
            "[credential omitted]"
        } else {
            token
        };
        if redact_next {
            redact_next = lowered == "bearer";
        } else if is_credential_marker || lowered == "bearer" {
            redact_next = true;
        }
        if !output.is_empty() {
            output.push(' ');
        }
        output.push_str(safe_token);
        if output.chars().count() >= 2000 {
            break;
        }
    }
    output.chars().take(2000).collect()
}

fn sanitize_config_fingerprint(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() || trimmed.len() > 256 {
        return None;
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.contains("data:")
        || lowered.contains("blob:")
        || lowered.contains("bearer")
        || lowered.contains("api_key")
        || lowered.contains("authorization")
        || lowered.contains("secret")
        || lowered.contains("cookie")
        || trimmed.chars().any(char::is_control)
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn sanitize_external_task_id(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() || trimmed.len() > 256 || trimmed.chars().any(char::is_control) {
        return None;
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.starts_with("data:")
        || lowered.starts_with("blob:")
        || lowered.contains("bearer")
        || lowered.contains("api_key")
        || lowered.contains("authorization")
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn sanitize_optional_diagnostic(value: Option<&str>) -> Option<String> {
    value
        .map(sanitize_diagnostic_text)
        .filter(|value| !value.trim().is_empty())
}

fn sanitize_error_category(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return None;
    }
    Some(value.to_string())
}

fn status_clears_persisted_error(status: &str) -> bool {
    matches!(status, "running" | "materializing" | "succeeded")
}

fn validate_network_route(route: &str) -> Result<(), String> {
    match route {
        "system" | "direct" | "custom-proxy" => Ok(()),
        _ => Err(format!("unsupported network route: {route}")),
    }
}

fn validate_immutable_network_route<'a>(
    current: &'a str,
    requested: Option<&str>,
) -> Result<&'a str, String> {
    validate_network_route(current)?;
    if let Some(requested) = requested {
        validate_network_route(requested)?;
        if requested != current {
            return Err(
                "generation job network route is immutable; create a separately approved migration instead"
                    .to_string(),
            );
        }
    }
    Ok(current)
}

fn validate_generation_media_type(media_type: &str) -> Result<(), String> {
    match media_type {
        "image" | "video" | "audio" | "model" => Ok(()),
        _ => Err(format!("unsupported generation media type: {media_type}")),
    }
}

const SNAPSHOT_OPERATIONS: &[&str] = &[
    "chat",
    "image.generate",
    "image.edit",
    "video.generate",
    "audio.generate",
    "model.generate",
    "models.list",
];
const SNAPSHOT_OUTPUT_KINDS: &[&str] = &["image", "video", "audio", "model"];

fn snapshot_fields<'a>(
    value: &'a Value,
    allowed: &[&str],
    label: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    let fields = value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object"))?;
    if let Some(key) = fields.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("{label} contains an unknown field: {key}"));
    }
    Ok(fields)
}

fn snapshot_text<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a str, String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("{label} must be a nonempty string"))
}

fn snapshot_string_fields(
    fields: &serde_json::Map<String, Value>,
    required: &[&str],
    optional_nonempty: &[&str],
    optional: &[&str],
) -> Result<(), String> {
    for key in required {
        snapshot_text(fields.get(*key), key)?;
    }
    for key in optional_nonempty {
        if let Some(value) = fields.get(*key) {
            snapshot_text(Some(value), key)?;
        }
    }
    for key in optional {
        if fields.get(*key).is_some_and(|value| !value.is_string()) {
            return Err(format!("{key} must be a string"));
        }
    }
    Ok(())
}

fn snapshot_enum(
    value: Option<&Value>,
    allowed: &[&str],
    required: bool,
    label: &str,
) -> Result<(), String> {
    match value {
        None if !required => Ok(()),
        Some(Value::String(value)) if allowed.contains(&value.as_str()) => Ok(()),
        _ => Err(format!("{label} has an unsupported value")),
    }
}

fn snapshot_array<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a [Value], String> {
    value
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("{label} must be an array"))
}

fn snapshot_number(value: &Value, label: &str) -> Result<f64, String> {
    value
        .as_f64()
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("{label} must be a finite number"))
}

fn snapshot_nonnegative_integer(value: &Value, label: &str) -> Result<f64, String> {
    let number = snapshot_number(value, label)?;
    if number < 0.0 || number.fract() != 0.0 || number > 9_007_199_254_740_991.0 {
        return Err(format!("{label} must be a nonnegative safe integer"));
    }
    Ok(number)
}

fn snapshot_declaration_key(value: Option<&Value>, label: &str) -> Result<(), String> {
    let key = snapshot_text(value, label)?;
    if !key
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(format!(
            "{label} must contain only letters, digits, underscores or hyphens"
        ));
    }
    Ok(())
}

fn validate_snapshot_output_spec(value: &Value) -> Result<(), String> {
    if value.get("url").is_some() {
        let fields = snapshot_fields(value, &["url", "kind", "auth"], "URL output declaration")?;
        snapshot_text(fields.get("url"), "output.url")?;
        snapshot_enum(
            fields.get("kind"),
            SNAPSHOT_OUTPUT_KINDS,
            true,
            "output.kind",
        )?;
        if fields.get("auth").is_some_and(|auth| !auth.is_boolean()) {
            return Err("output.auth must be a boolean".to_string());
        }
    } else {
        let fields = snapshot_fields(value, &["path", "as", "kind"], "path output declaration")?;
        snapshot_text(fields.get("path"), "output.path")?;
        snapshot_enum(
            fields.get("as"),
            &["url", "base64", "data-url"],
            true,
            "output.as",
        )?;
        snapshot_enum(
            fields.get("kind"),
            SNAPSHOT_OUTPUT_KINDS,
            false,
            "output.kind",
        )?;
    }
    Ok(())
}

fn validate_snapshot_response(value: &Value) -> Result<(), String> {
    let outputs = match value.get("mode").and_then(Value::as_str) {
        Some("sync") => {
            let fields = snapshot_fields(value, &["mode", "outputs"], "sync response")?;
            snapshot_array(fields.get("outputs"), "response.outputs")?
        }
        Some("async") => {
            let fields = snapshot_fields(value, &["mode", "taskIdPath", "poll"], "async response")?;
            snapshot_text(fields.get("taskIdPath"), "response.taskIdPath")?;
            let poll = snapshot_fields(
                fields.get("poll").ok_or("async response requires poll")?,
                &[
                    "method",
                    "path",
                    "template",
                    "intervalSec",
                    "timeoutMin",
                    "statusPath",
                    "success",
                    "failure",
                    "progressPath",
                    "outputs",
                    "resultRequest",
                ],
                "poll declaration",
            )?;
            snapshot_enum(poll.get("method"), &["GET", "POST"], true, "poll.method")?;
            snapshot_string_fields(poll, &["path"], &["statusPath", "progressPath"], &[])?;
            for key in ["intervalSec", "timeoutMin"] {
                if snapshot_number(
                    poll.get(key)
                        .ok_or_else(|| format!("poll requires {key}"))?,
                    key,
                )? <= 0.0
                {
                    return Err(format!("poll.{key} must be positive"));
                }
            }
            for key in ["success", "failure"] {
                for status in snapshot_array(poll.get(key), key)? {
                    snapshot_text(Some(status), key)?;
                }
            }
            if let Some(request) = poll.get("resultRequest") {
                let request = snapshot_fields(
                    request,
                    &["method", "path", "template"],
                    "poll.resultRequest",
                )?;
                snapshot_enum(
                    request.get("method"),
                    &["GET", "POST"],
                    true,
                    "resultRequest.method",
                )?;
                snapshot_text(request.get("path"), "resultRequest.path")?;
            }
            snapshot_array(poll.get("outputs"), "poll.outputs")?
        }
        _ => return Err("response.mode must be sync or async".to_string()),
    };
    for output in outputs {
        validate_snapshot_output_spec(output)?;
    }
    Ok(())
}

fn validate_snapshot_operation(value: &Value) -> Result<(), String> {
    let fields = snapshot_fields(
        value,
        &[
            "method",
            "path",
            "body",
            "template",
            "files",
            "imageEncoding",
            "response",
            "errorPath",
        ],
        "operation declaration",
    )?;
    snapshot_enum(
        fields.get("method"),
        &["GET", "POST"],
        true,
        "operation.method",
    )?;
    snapshot_enum(
        fields.get("body"),
        &["json", "multipart", "form-urlencoded", "none"],
        true,
        "operation.body",
    )?;
    snapshot_enum(
        fields.get("imageEncoding"),
        &["url", "data-url", "base64"],
        false,
        "operation.imageEncoding",
    )?;
    snapshot_string_fields(fields, &["path"], &["errorPath"], &[])?;
    if (fields.get("body").and_then(Value::as_str) == Some("multipart"))
        != fields.contains_key("files")
    {
        return Err("only multipart operations must declare files".to_string());
    }
    if let Some(files) = fields.get("files") {
        let files = snapshot_fields(files, &["field", "cardinality"], "operation.files")?;
        snapshot_text(files.get("field"), "files.field")?;
        snapshot_enum(
            files.get("cardinality"),
            &["single", "array", "repeat"],
            true,
            "files.cardinality",
        )?;
    }
    validate_snapshot_response(
        fields
            .get("response")
            .ok_or("operation requires response")?,
    )
}

fn validate_snapshot_params(value: &Value) -> Result<(), String> {
    let mut keys = HashSet::new();
    for param in snapshot_array(Some(value), "params")? {
        let fields = snapshot_fields(
            param,
            &[
                "key",
                "label",
                "type",
                "options",
                "min",
                "max",
                "step",
                "default",
                "required",
                "description",
                "group",
                "display",
                "sizeDisplay",
            ],
            "parameter declaration",
        )?;
        snapshot_declaration_key(fields.get("key"), "param.key")?;
        let key = snapshot_text(fields.get("key"), "param.key")?;
        if !keys.insert(key) {
            return Err(format!("duplicate parameter key: {key}"));
        }
        snapshot_string_fields(fields, &["label"], &[], &["description"])?;
        snapshot_enum(
            fields.get("type"),
            &["enum", "number", "boolean", "text"],
            true,
            "param.type",
        )?;
        snapshot_enum(
            fields.get("group"),
            &["basic", "advanced"],
            false,
            "param.group",
        )?;
        snapshot_enum(
            fields.get("display"),
            &["auto", "buttons", "select", "slider", "hidden"],
            false,
            "param.display",
        )?;
        snapshot_enum(
            fields.get("sizeDisplay"),
            &["pixels", "ratio-resolution"],
            false,
            "param.sizeDisplay",
        )?;
        for key in ["min", "max", "step"] {
            if let Some(value) = fields.get(key) {
                let number = snapshot_number(value, key)?;
                if key == "step" && number <= 0.0 {
                    return Err("param.step must be positive".to_string());
                }
            }
        }
        if fields
            .get("required")
            .is_some_and(|required| !required.is_boolean())
        {
            return Err("param.required must be a boolean".to_string());
        }
        if let Some(options) = fields.get("options") {
            for option in snapshot_array(Some(options), "param.options")? {
                let option =
                    snapshot_fields(option, &["label", "value", "size"], "parameter option")?;
                snapshot_text(option.get("label"), "option.label")?;
                if !option.contains_key("value") {
                    return Err("parameter option requires value".to_string());
                }
                if let Some(size) = option.get("size") {
                    let size =
                        snapshot_fields(size, &["ratio", "resolution"], "size presentation")?;
                    snapshot_text(size.get("ratio"), "size.ratio")?;
                    snapshot_text(size.get("resolution"), "size.resolution")?;
                }
            }
        }
    }
    Ok(())
}

fn validate_snapshot_slots(value: &Value) -> Result<(), String> {
    let mut keys = HashSet::new();
    for slot in snapshot_array(Some(value), "slots")? {
        let fields = snapshot_fields(
            slot,
            &["key", "label", "kind", "min", "max", "description"],
            "slot declaration",
        )?;
        snapshot_declaration_key(fields.get("key"), "slot.key")?;
        let key = snapshot_text(fields.get("key"), "slot.key")?;
        if !keys.insert(key) {
            return Err(format!("duplicate slot key: {key}"));
        }
        snapshot_string_fields(fields, &["label"], &[], &["description"])?;
        snapshot_enum(
            fields.get("kind"),
            &["image", "video", "audio"],
            true,
            "slot.kind",
        )?;
        let min = fields
            .get("min")
            .map(|value| snapshot_nonnegative_integer(value, "slot.min"))
            .transpose()?
            .unwrap_or(0.0);
        let max = snapshot_nonnegative_integer(
            fields.get("max").ok_or("slot requires max")?,
            "slot.max",
        )?;
        if max < min {
            return Err("slot.max cannot be less than slot.min".to_string());
        }
    }
    Ok(())
}

/// Match ModelSpec.capabilities exactly; metadata must not become an open config bag.
fn validate_snapshot_capabilities(value: &Value) -> Result<(), String> {
    let fields = snapshot_fields(
        value,
        &[
            "contextWindow",
            "maxOutputTokens",
            "supportsMultimodal",
            "supportsTools",
            "supportsStreaming",
        ],
        "model capabilities",
    )?;
    for key in ["contextWindow", "maxOutputTokens"] {
        if let Some(value) = fields.get(key) {
            if snapshot_nonnegative_integer(value, key)? <= 0.0 {
                return Err(format!(
                    "capabilities.{key} must be a positive safe integer"
                ));
            }
        }
    }
    for key in ["supportsMultimodal", "supportsTools", "supportsStreaming"] {
        if fields.get(key).is_some_and(|value| !value.is_boolean()) {
            return Err(format!("capabilities.{key} must be a boolean"));
        }
    }
    Ok(())
}

struct SnapshotTemplateUsage<'a> {
    model: &'a Value,
    mode: Option<&'a Value>,
}

fn snapshot_has_named_declaration(value: Option<&Value>, key: &str) -> bool {
    value.and_then(Value::as_array).is_some_and(|items| {
        items
            .iter()
            .any(|item| item.get("key").and_then(Value::as_str) == Some(key))
    })
}

fn snapshot_variable_path(variable: &str, prefix: &str, nested: bool) -> bool {
    variable.strip_prefix(prefix).is_some_and(|path| {
        !path.is_empty()
            && (nested || !path.contains('.'))
            && path.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            })
    })
}

fn validate_snapshot_template_value(
    value: &Value,
    kind: &str,
    polling: bool,
    result_request: bool,
    usages: &[SnapshotTemplateUsage<'_>],
    depth: usize,
) -> Result<(), String> {
    if depth > 32 {
        return Err("snapshot template is too deeply nested".to_string());
    }
    match value {
        Value::String(text) => {
            static VARIABLES: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                regex::Regex::new(r"\{\{\s*([^{}]+?)\s*\}\}")
                    .expect("constant template variable pattern")
            });
            for captures in VARIABLES.captures_iter(text) {
                let variable = captures[1].trim();
                if snapshot_variable_path(variable, "param.", true) {
                    let key = variable[6..].split('.').next().unwrap_or("");
                    for usage in usages {
                        if !snapshot_has_named_declaration(usage.model.get("params"), key)
                            && !snapshot_has_named_declaration(
                                usage.mode.and_then(|mode| mode.get("params")),
                                key,
                            )
                        {
                            return Err(format!(
                                "snapshot template references undeclared parameter: {key}"
                            ));
                        }
                    }
                } else if snapshot_variable_path(variable, "slot.", false)
                    || snapshot_variable_path(variable, "slotFirst.", false)
                {
                    let key = variable.split('.').nth(1).unwrap_or("");
                    if usages.is_empty()
                        || usages.iter().any(|usage| {
                            !snapshot_has_named_declaration(
                                usage.mode.and_then(|mode| mode.get("slots")),
                                key,
                            )
                        })
                    {
                        return Err(format!(
                            "snapshot template references undeclared slot: {key}"
                        ));
                    }
                } else if !(polling && snapshot_variable_path(variable, "submit.", true))
                    && !(result_request && snapshot_variable_path(variable, "poll.", true))
                    && !(kind == "chat" && snapshot_variable_path(variable, "chatPayload.", false))
                    && !(kind == "chat" && matches!(variable, "tools" | "toolChoice"))
                    && !(polling && variable == "taskId")
                    && !matches!(
                        variable,
                        "model"
                            | "mode"
                            | "prompt"
                            | "images"
                            | "image"
                            | "firstImageUrl"
                            | "seedanceContent"
                            | "wanMedia"
                            | "videos"
                            | "video"
                            | "audios"
                            | "audio"
                            | "messages"
                            | "openaiImageContent"
                            | "openaiImageInput"
                            | "geminiParts"
                    )
                {
                    return Err(format!(
                        "snapshot template references unsupported variable: {variable}"
                    ));
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_snapshot_template_value(
                    item,
                    kind,
                    polling,
                    result_request,
                    usages,
                    depth + 1,
                )?;
            }
        }
        Value::Object(fields) => {
            for item in fields.values() {
                validate_snapshot_template_value(
                    item,
                    kind,
                    polling,
                    result_request,
                    usages,
                    depth + 1,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_snapshot_operation_templates(
    kind: &str,
    operation: &Value,
    usages: &[SnapshotTemplateUsage<'_>],
) -> Result<(), String> {
    let validate = |value: Option<&Value>, polling, result_request| -> Result<(), String> {
        if let Some(value) = value {
            validate_snapshot_template_value(value, kind, polling, result_request, usages, 0)?;
        }
        Ok(())
    };
    validate(operation.get("path"), false, false)?;
    validate(operation.get("template"), false, false)?;
    let response = operation
        .get("response")
        .ok_or("operation requires response")?;
    let outputs = if response.get("mode").and_then(Value::as_str) == Some("async") {
        let poll = response.get("poll").ok_or("async response requires poll")?;
        validate(poll.get("path"), true, false)?;
        validate(poll.get("template"), true, false)?;
        if let Some(request) = poll.get("resultRequest") {
            validate(request.get("path"), true, true)?;
            validate(request.get("template"), true, true)?;
        }
        poll.get("outputs")
    } else {
        response.get("outputs")
    };
    let outputs = snapshot_array(outputs, "outputs")?;
    if kind == "model.generate"
        && !outputs.iter().any(|output| {
            output.get("kind").is_none()
                || output.get("kind").and_then(Value::as_str) == Some("model")
        })
    {
        return Err("model.generate must declare at least one model output".to_string());
    }
    for output in outputs {
        validate(output.get("url"), true, false)?;
    }
    Ok(())
}

// Keep this boundary aligned with channels/domain/profile.ts: snapshots retain
// complete declarations, including mode-owned endpoints, but never expanded media.
fn validate_snapshot_profile(
    profile: &Value,
    input: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    let fields = snapshot_fields(
        profile,
        &[
            "version",
            "id",
            "name",
            "baseUrl",
            "auth",
            "headers",
            "docsUrl",
            "notes",
            "operations",
            "models",
        ],
        "channel profile",
    )?;
    if fields.get("version").and_then(Value::as_u64) != Some(2) {
        return Err("snapshot profile version must be 2".to_string());
    }
    snapshot_string_fields(fields, &["id", "name", "baseUrl"], &[], &[])?;
    let base = snapshot_text(fields.get("baseUrl"), "profile.baseUrl")?;
    let url = reqwest::Url::parse(base).map_err(|_| "profile.baseUrl must be an HTTP(S) URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.has_host()
        || base.ends_with('/')
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "profile.baseUrl cannot contain credentials, query, fragment or trailing slash"
                .to_string(),
        );
    }
    if let Some(docs) = fields.get("docsUrl") {
        reqwest::Url::parse(snapshot_text(Some(docs), "profile.docsUrl")?)
            .map_err(|_| "profile.docsUrl must be a URL")?;
    }
    if let Some(notes) = fields.get("notes") {
        if snapshot_array(Some(notes), "profile.notes")?
            .iter()
            .any(|note| !note.is_string())
        {
            return Err("profile.notes must contain strings".to_string());
        }
    }
    if let Some(headers) = fields.get("headers") {
        static SECRET_HEADER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"(?i)(authorization|cookie|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|secret|signature|credential|password|passphrase|bearer|token)")
                .expect("constant secret header pattern")
        });
        let headers = headers
            .as_object()
            .ok_or("profile.headers must be an object")?;
        if headers
            .iter()
            .any(|(key, value)| key.is_empty() || SECRET_HEADER.is_match(key) || !value.is_string())
        {
            return Err("profile.headers must contain only non-secret string headers".to_string());
        }
    }
    let auth = fields.get("auth").ok_or("profile requires auth")?;
    let auth_fields = match auth.get("type").and_then(Value::as_str) {
        Some("none" | "bearer") => snapshot_fields(auth, &["type"], "profile.auth")?,
        Some("header") => snapshot_fields(auth, &["type", "name", "prefix"], "profile.auth")?,
        Some("query") => snapshot_fields(auth, &["type", "name"], "profile.auth")?,
        _ => return Err("profile.auth type invalid".to_string()),
    };
    if matches!(
        auth.get("type").and_then(Value::as_str),
        Some("header" | "query")
    ) {
        snapshot_text(auth_fields.get("name"), "auth.name")?;
    }
    snapshot_string_fields(auth_fields, &[], &[], &["prefix"])?;
    let operations = snapshot_fields(
        fields
            .get("operations")
            .ok_or("profile requires operations")?,
        SNAPSHOT_OPERATIONS,
        "profile.operations",
    )?;
    for operation in operations.values() {
        validate_snapshot_operation(operation)?;
    }
    let models = snapshot_array(fields.get("models"), "profile.models")?;
    let mut model_ids = HashSet::new();
    for model in models {
        let model_fields = snapshot_fields(
            model,
            &[
                "id",
                "label",
                "operations",
                "params",
                "refs",
                "mention",
                "modes",
                "capabilities",
            ],
            "model declaration",
        )?;
        snapshot_string_fields(model_fields, &["id"], &["label"], &[])?;
        let id = snapshot_text(model_fields.get("id"), "model.id")?;
        if !model_ids.insert(id) {
            return Err(format!("duplicate model id: {id}"));
        }
        for kind in snapshot_array(model_fields.get("operations"), "model.operations")? {
            snapshot_enum(Some(kind), SNAPSHOT_OPERATIONS, true, "model operation")?;
        }
        validate_snapshot_params(model_fields.get("params").ok_or("model requires params")?)?;
        snapshot_enum(
            model_fields.get("mention"),
            &["zh-at", "en-at", "zh-bare", "natural"],
            false,
            "model.mention",
        )?;
        if let Some(capabilities) = model_fields.get("capabilities") {
            validate_snapshot_capabilities(capabilities)?;
        }
        if let Some(refs) = model_fields.get("refs") {
            for value in snapshot_fields(refs, &["image", "video", "audio"], "model.refs")?.values()
            {
                snapshot_nonnegative_integer(value, "model reference limit")?;
            }
        }
        if let Some(modes) = model_fields.get("modes") {
            let modes = snapshot_array(Some(modes), "model.modes")?;
            if modes.is_empty() {
                return Err("model.modes cannot be empty".to_string());
            }
            let mut mode_ids = HashSet::new();
            for mode in modes {
                let mode_fields = snapshot_fields(
                    mode,
                    &[
                        "id",
                        "label",
                        "description",
                        "operation",
                        "endpoint",
                        "params",
                        "slots",
                    ],
                    "mode declaration",
                )?;
                snapshot_string_fields(mode_fields, &["id", "label"], &[], &["description"])?;
                let id = snapshot_text(mode_fields.get("id"), "mode.id")?;
                if !mode_ids.insert(id) {
                    return Err(format!("duplicate mode id: {id}"));
                }
                snapshot_enum(
                    mode_fields.get("operation"),
                    SNAPSHOT_OPERATIONS,
                    true,
                    "mode.operation",
                )?;
                let kind = snapshot_text(mode_fields.get("operation"), "mode.operation")?;
                if let Some(params) = mode_fields.get("params") {
                    validate_snapshot_params(params)?;
                }
                if let Some(slots) = mode_fields.get("slots") {
                    validate_snapshot_slots(slots)?;
                }
                if let Some(endpoint) = mode_fields.get("endpoint") {
                    validate_snapshot_operation(endpoint)?;
                    validate_snapshot_operation_templates(
                        kind,
                        endpoint,
                        &[SnapshotTemplateUsage {
                            model,
                            mode: Some(mode),
                        }],
                    )?;
                } else if !operations.contains_key(kind) {
                    return Err(format!("mode operation has no endpoint: {kind}"));
                }
            }
        } else {
            for kind in snapshot_array(model_fields.get("operations"), "model.operations")? {
                let kind = snapshot_text(Some(kind), "model operation")?;
                if !operations.contains_key(kind) {
                    return Err(format!("model operation has no endpoint: {kind}"));
                }
            }
        }
    }
    for (kind, operation) in operations {
        let mut usages = Vec::new();
        for model in models {
            if let Some(modes) = model.get("modes").and_then(Value::as_array) {
                for mode in modes {
                    if mode.get("operation").and_then(Value::as_str) == Some(kind.as_str())
                        && mode.get("endpoint").is_none()
                    {
                        usages.push(SnapshotTemplateUsage {
                            model,
                            mode: Some(mode),
                        });
                    }
                }
            } else if model
                .get("operations")
                .and_then(Value::as_array)
                .is_some_and(|kinds| {
                    kinds
                        .iter()
                        .any(|value| value.as_str() == Some(kind.as_str()))
                })
            {
                usages.push(SnapshotTemplateUsage { model, mode: None });
            }
        }
        validate_snapshot_operation_templates(kind, operation, &usages)?;
    }
    let model_id = snapshot_text(input.get("modelId"), "input.modelId")?;
    let model = models
        .iter()
        .find(|model| model.get("id").and_then(Value::as_str) == Some(model_id))
        .ok_or("snapshot input model is not declared")?;
    let kind = snapshot_text(input.get("operation"), "input.operation")?;
    let mode_id = input.get("modeId").and_then(Value::as_str);
    if let Some(modes) = model.get("modes").and_then(Value::as_array) {
        let mode = if let Some(mode_id) = mode_id {
            modes
                .iter()
                .find(|mode| mode.get("id").and_then(Value::as_str) == Some(mode_id))
        } else {
            modes.first()
        }
        .ok_or("snapshot input mode is not declared")?;
        if mode.get("operation").and_then(Value::as_str) != Some(kind) {
            return Err("snapshot input operation does not match selected mode".to_string());
        }
    } else if mode_id.is_some_and(|mode_id| mode_id != "default")
        || !model
            .get("operations")
            .and_then(Value::as_array)
            .is_some_and(|kinds| kinds.iter().any(|value| value.as_str() == Some(kind)))
    {
        return Err("snapshot input operation or implicit mode is not declared".to_string());
    }
    Ok(())
}

fn validate_snapshot_saved_outputs(value: &Value) -> Result<(), String> {
    for output in snapshot_array(Some(value), "snapshot.outputs")? {
        if output.get("kind").and_then(Value::as_str) == Some("text") {
            let fields = snapshot_fields(output, &["kind", "text"], "saved text output")?;
            if !fields.get("text").is_some_and(Value::is_string) {
                return Err("saved text output requires text".to_string());
            }
        } else {
            validate_snapshot_output_spec(output)?;
            if output.get("url").is_none() {
                return Err("saved media output requires a URL".to_string());
            }
        }
    }
    Ok(())
}

fn validate_comfy_snapshot_auth(auth: &Value) -> Result<(), String> {
    let fields = match auth.get("mode").and_then(Value::as_str) {
        Some("none" | "bearer") => snapshot_fields(auth, &["mode"], "ComfyUI auth")?,
        Some("header" | "query") => {
            let fields = snapshot_fields(auth, &["mode", "name"], "ComfyUI auth")?;
            snapshot_text(fields.get("name"), "ComfyUI auth.name")?;
            fields
        }
        _ => return Err("ComfyUI auth mode invalid".to_string()),
    };
    snapshot_text(fields.get("mode"), "ComfyUI auth.mode")?;
    Ok(())
}

fn comfy_recovery_base_url(value: Option<&Value>, label: &str) -> Result<reqwest::Url, String> {
    let text = snapshot_text(value, label)?;
    let url =
        reqwest::Url::parse(text).map_err(|_| format!("{label} must be an HTTP(S) base URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || text.chars().any(char::is_whitespace)
    {
        return Err(format!(
            "{label} cannot contain credentials, query, fragment or whitespace"
        ));
    }
    Ok(url)
}

fn validate_comfy_recovery_route(route: &Value, snapshot: &Value) -> Result<(), String> {
    let fields = snapshot_fields(
        route,
        &[
            "providerId",
            "baseUrl",
            "originalBaseUrl",
            "externalTaskId",
            "auth",
            "authPrefix",
            "headerNames",
            "queryNames",
        ],
        "ComfyUI recovery route",
    )?;
    snapshot_string_fields(
        fields,
        &["providerId", "baseUrl", "originalBaseUrl", "externalTaskId"],
        &[],
        &[],
    )?;
    if !fields.get("authPrefix").is_some_and(Value::is_string) {
        return Err("ComfyUI recovery route requires a string authPrefix".to_string());
    }
    for name in ["headerNames", "queryNames"] {
        if snapshot_array(fields.get(name), name)?
            .iter()
            .any(|value| !value.is_string())
        {
            return Err(format!(
                "ComfyUI recovery route {name} must contain only names"
            ));
        }
    }
    validate_comfy_snapshot_auth(
        fields
            .get("auth")
            .ok_or("ComfyUI recovery route auth missing")?,
    )?;
    let original = comfy_recovery_base_url(
        fields.get("originalBaseUrl"),
        "recoveryRoute.originalBaseUrl",
    )?;
    let selected = comfy_recovery_base_url(fields.get("baseUrl"), "recoveryRoute.baseUrl")?;
    if fields.get("originalBaseUrl") != snapshot.pointer("/urls/base") {
        return Err("ComfyUI recovery route does not match the original snapshot base".to_string());
    }
    if original.scheme() == "https" && selected.scheme() != "https" {
        return Err("ComfyUI recovery route cannot downgrade HTTPS".to_string());
    }
    Ok(())
}

// Route metadata authorizes queries for one existing task; it never changes the
// immutable submission's job, provider, base URL or accepted upstream handle.
fn validate_comfy_recovery_job_binding(
    value: Option<&Value>,
    job_id: &str,
    provider_id: &str,
    external_task_id: Option<&str>,
    previous: Option<&Value>,
) -> Result<(), String> {
    let route = value.and_then(|value| value.get("recoveryRoute"));
    if route.is_none() {
        if previous.is_some_and(|previous| previous.get("recoveryRoute").is_some()) {
            return Err(
                "ComfyUI recovery route cannot discard its original-task binding".to_string(),
            );
        }
        return Ok(());
    }
    let value = value.ok_or("ComfyUI recovery snapshot missing")?;
    let route = route.ok_or("ComfyUI recovery route missing")?;
    if value.get("version").and_then(Value::as_u64) != Some(2)
        || value.get("adapter").and_then(Value::as_str) != Some("comfyui")
        || value.pointer("/input/jobId").and_then(Value::as_str) != Some(job_id)
        || value.pointer("/input/channelId").and_then(Value::as_str) != Some(provider_id)
        || external_task_id.is_none()
        || route.get("externalTaskId").and_then(Value::as_str) != external_task_id
    {
        return Err("ComfyUI recovery route does not match persisted job metadata".to_string());
    }
    if let Some(previous) = previous {
        let base = previous
            .pointer("/input/params/comfyuiSnapshot/urls/base")
            .ok_or("ComfyUI original submission snapshot missing")?;
        if value.pointer("/input/params/comfyuiSnapshot/urls/base") != Some(base)
            || route.get("originalBaseUrl") != Some(base)
        {
            return Err("ComfyUI recovery route cannot rewrite the original base".to_string());
        }
    }
    Ok(())
}

fn sanitize_job_poll_descriptor(
    value: Option<Value>,
    job_id: &str,
    provider_id: &str,
    external_task_id: Option<&str>,
) -> Result<Option<String>, String> {
    validate_comfy_recovery_job_binding(
        value.as_ref(),
        job_id,
        provider_id,
        external_task_id,
        None,
    )?;
    sanitize_poll_descriptor(value)
}

fn validate_comfy_recovery_update(
    value: Option<&Value>,
    current: &GenerationJobRecord,
    external_task_id: Option<&str>,
) -> Result<(), String> {
    let previous = current
        .poll_descriptor_json
        .as_deref()
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|_| "ComfyUI original submission snapshot is invalid")?;
    let effective = value.or(previous.as_ref());
    if effective.is_some_and(|value| value.get("recoveryRoute").is_some())
        && (previous.is_none()
            || current.external_task_id.is_none()
            || current.external_task_id.as_deref() != external_task_id)
    {
        return Err("ComfyUI recovery route must retain the accepted original task".to_string());
    }
    validate_comfy_recovery_job_binding(
        effective,
        &current.job_id,
        &current.provider_id,
        external_task_id,
        previous.as_ref(),
    )
}

fn sanitize_poll_descriptor(value: Option<Value>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    // v2 execution snapshots carry immutable configuration, not expanded HTTP
    // requests. Keep the legacy descriptor sanitizer unchanged below.
    if value.get("version").and_then(Value::as_u64) == Some(2) {
        let root = value
            .as_object()
            .ok_or("v2 poll descriptor must be an object")?;
        let adapter = value
            .get("adapter")
            .and_then(Value::as_str)
            .ok_or("v2 poll descriptor requires adapter type")?;
        let allowed: &[&str] = match adapter {
            "template" => &[
                "version",
                "adapter",
                "credentialSource",
                "profile",
                "input",
                "submit",
                "assets",
                "assetKinds",
                "outputs",
                "failure",
            ],
            "comfyui" => &[
                "version",
                "adapter",
                "input",
                "pollIntervalMs",
                "pollTimeoutMs",
                "authPrefix",
                "headerNames",
                "queryNames",
                "assets",
                "assetKinds",
                "outputs",
                "failure",
                "recoveryRoute",
            ],
            _ => return Err("unsupported v2 snapshot adapter".to_string()),
        };
        if root.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err("v2 snapshot contains an unknown root field".to_string());
        }
        if root
            .get("credentialSource")
            .is_some_and(|source| source.as_str() != Some("transient"))
        {
            return Err("v2 snapshot credentialSource must be transient".to_string());
        }
        let input = value
            .get("input")
            .and_then(Value::as_object)
            .ok_or("v2 snapshot requires job input")?;
        // Keep mode and slot declarations in the immutable profile; recovery
        // selects that mode but never needs the original prompt or media refs.
        let input_fields = [
            "jobId",
            "channelId",
            "modelId",
            "modeId",
            "operation",
            "prompt",
            "params",
            "refs",
            "count",
        ];
        if input
            .keys()
            .any(|key| !input_fields.contains(&key.as_str()))
            || input.get("prompt").and_then(Value::as_str) != Some("")
            || !input
                .get("refs")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
            || !input.get("params").is_some_and(Value::is_object)
        {
            return Err(
                "v2 recovery input must not contain expanded prompts, messages, tools or media"
                    .to_string(),
            );
        }
        for field in ["jobId", "channelId", "modelId", "operation"] {
            if !input
                .get(field)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
            {
                return Err(format!("v2 snapshot is missing input.{field}"));
            }
        }
        if input.get("modeId").is_some_and(|mode| !mode.is_string()) {
            return Err("v2 snapshot input.modeId must be a string".to_string());
        }
        snapshot_enum(
            input.get("operation"),
            SNAPSHOT_OPERATIONS,
            true,
            "input.operation",
        )?;
        snapshot_number(
            input.get("count").ok_or("snapshot input requires count")?,
            "input.count",
        )?;
        if let Some(assets) = root.get("assets") {
            if snapshot_array(Some(assets), "snapshot.assets")?
                .iter()
                .any(|asset| !asset.is_string())
            {
                return Err("snapshot.assets must contain only strings".to_string());
            }
        }
        if let Some(kinds) = root.get("assetKinds") {
            if !kinds.as_array().is_some_and(|kinds| {
                kinds.iter().all(|kind| {
                    kind.as_str()
                        .is_some_and(|kind| kind == "text" || SNAPSHOT_OUTPUT_KINDS.contains(&kind))
                })
            }) {
                return Err(
                    "v2 snapshot assetKinds must contain only image, video, audio, model or text"
                        .to_string(),
                );
            }
        }
        if let Some(outputs) = root.get("outputs") {
            validate_snapshot_saved_outputs(outputs)?;
        }
        if let Some(failure) = root.get("failure") {
            let failure = failure
                .as_object()
                .ok_or("v2 snapshot failure must be an object")?;
            if failure
                .keys()
                .any(|key| !matches!(key.as_str(), "category" | "message" | "raw" | "status"))
                || sanitize_error_category(failure.get("category").and_then(Value::as_str))
                    .is_none()
                || !failure
                    .get("message")
                    .and_then(Value::as_str)
                    .is_some_and(|text| text.chars().count() <= 2000)
                || failure.get("raw").is_some_and(|raw| {
                    !raw.as_str()
                        .is_some_and(|text| text.chars().count() <= 2000)
                })
                || failure.get("status").is_some_and(|status| {
                    !status
                        .as_u64()
                        .is_some_and(|status| (100..=599).contains(&status))
                })
            {
                return Err("v2 snapshot failure requires a safe category, bounded message/raw and optional HTTP status".to_string());
            }
        }
        if adapter == "template" {
            if !root.get("submit").is_some_and(Value::is_object) {
                return Err("template snapshot requires a submit object".to_string());
            }
            validate_snapshot_profile(
                value
                    .get("profile")
                    .ok_or("template snapshot requires profile")?,
                input,
            )?;
        } else {
            let snapshot = value
                .pointer("/input/params/comfyuiSnapshot")
                .ok_or("ComfyUI workflow snapshot missing")?;
            if !snapshot.get("workflow").is_some_and(Value::is_object)
                || !snapshot.get("bindings").is_some_and(Value::is_object)
                || !snapshot.get("urls").is_some_and(Value::is_object)
            {
                return Err("invalid ComfyUI workflow snapshot".to_string());
            }
            validate_comfy_snapshot_auth(
                snapshot
                    .get("auth")
                    .ok_or("ComfyUI snapshot auth missing")?,
            )?;
            if let Some(route) = root.get("recoveryRoute") {
                validate_comfy_recovery_route(route, snapshot)?;
            }
        }
        fn contains_data_url(lower: &str) -> bool {
            // Bare scheme mentions in provider notes are not media. Data URLs
            // need a comma; their MIME header may legitimately contain spaces.
            lower.match_indices("data:").any(|(index, _)| {
                let candidate = lower[index + 5..]
                    .split(['"', '\'', '<', '>'])
                    .next()
                    .unwrap_or("");
                let Some((header, _)) = candidate.split_once(',') else {
                    return false;
                };
                if !header.chars().any(char::is_whitespace) {
                    return true;
                }
                let mime = header.split(';').next().unwrap_or("").trim();
                mime.is_empty()
                    || mime.split_once('/').is_some_and(|(kind, subtype)| {
                        [kind.trim(), subtype.trim()].iter().all(|part| {
                            !part.is_empty()
                                && part.bytes().all(|byte| {
                                    byte.is_ascii_alphanumeric()
                                        || matches!(
                                            byte,
                                            b'!' | b'#'
                                                | b'$'
                                                | b'%'
                                                | b'&'
                                                | b'\''
                                                | b'*'
                                                | b'+'
                                                | b'-'
                                                | b'.'
                                                | b'^'
                                                | b'_'
                                                | b'`'
                                                | b'|'
                                                | b'~'
                                        )
                                })
                        })
                    })
            })
        }
        fn contains_unredacted_diagnostic_credential(lower: &str) -> bool {
            static CREDENTIAL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                regex::Regex::new(
                    r#"(?:\bbearer\s+|["']?\b(?:authorization|api[_-]?key|x[_-]api[_-]key|x[_-]goog[_-]api[_-]key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie)["']?\s*[:=]\s*["']?)((?:bearer\s+)?[^\s,"';&}<>)]+)"#,
                ).expect("constant diagnostic credential pattern")
            });
            CREDENTIAL.captures_iter(lower).any(|capture| {
                let value = &capture[1];
                let value = value
                    .strip_prefix("bearer")
                    .map(str::trim_start)
                    .unwrap_or(value);
                value != "[redacted]"
            })
        }
        fn validate_snapshot(
            value: &Value,
            depth: usize,
            auth_locations: &[Option<&Value>],
            is_failure: bool,
        ) -> Result<(), String> {
            if depth > 32 {
                return Err("v2 snapshot is too deeply nested".to_string());
            }
            match value {
                Value::String(text) => {
                    let lower = text.to_ascii_lowercase();
                    // Failure diagnostics retain upstream wording and redacted
                    // credential labels, never actual credential values.
                    let contains_credential = if is_failure {
                        contains_unredacted_diagnostic_credential(&lower)
                    } else {
                        super::secrets::contains_plaintext_credential_assignment(text)
                    };
                    if text.len() > 65_536
                        || contains_data_url(&lower)
                        || lower.starts_with("blob:")
                        || contains_credential
                    {
                        return Err("v2 snapshot contains credentials, media payload or an oversized string".to_string());
                    }
                    if let Ok(url) = reqwest::Url::parse(text) {
                        if !url.username().is_empty() || url.password().is_some() {
                            return Err("v2 snapshot URL contains credentials".to_string());
                        }
                    }
                }
                Value::Array(items) => {
                    if items.len() > 4096 {
                        return Err("v2 snapshot array exceeds limit".to_string());
                    }
                    for item in items {
                        validate_snapshot(item, depth + 1, auth_locations, is_failure)?;
                    }
                }
                Value::Object(map) => {
                    if map.len() > 4096 {
                        return Err("v2 snapshot object exceeds limit".to_string());
                    }
                    for (key, item) in map {
                        let key = key.to_ascii_lowercase().replace(['-', ' '], "_");
                        if matches!(
                            key.as_str(),
                            "api_key"
                                | "apikey"
                                | "api_key_comfy_org"
                                | "authorization"
                                | "cookie"
                                | "set_cookie"
                                | "access_token"
                                | "refresh_token"
                                | "token"
                                | "secret"
                                | "password"
                                | "credential"
                                | "credentials"
                                | "private_key"
                        ) {
                            return Err(format!("v2 snapshot contains sensitive field: {key}"));
                        }
                        if key == "auth"
                            && !auth_locations
                                .iter()
                                .flatten()
                                .any(|config| std::ptr::eq(item, *config))
                        {
                            // OutputSpec and the executor's saved URL output both
                            // declare auth:boolean, not credential configuration.
                            let is_output = item.is_boolean()
                                && map.get("url").is_some_and(Value::is_string)
                                && map
                                    .get("kind")
                                    .and_then(Value::as_str)
                                    .is_some_and(|kind| SNAPSHOT_OUTPUT_KINDS.contains(&kind))
                                && map
                                    .keys()
                                    .all(|field| matches!(field.as_str(), "url" | "kind" | "auth"));
                            if !is_output {
                                return Err("snapshot auth is only valid at declared configuration or URL-output locations".to_string());
                            }
                        }
                        validate_snapshot(
                            item,
                            depth + 1,
                            auth_locations,
                            is_failure || (depth == 0 && key == "failure"),
                        )?;
                    }
                }
                _ => {}
            }
            Ok(())
        }
        let auth_locations = if adapter == "template" {
            [value.pointer("/profile/auth"), None, None]
        } else {
            [
                None,
                value.pointer("/input/params/comfyuiSnapshot/auth"),
                value.pointer("/recoveryRoute/auth"),
            ]
        };
        validate_snapshot(&value, 0, &auth_locations, false)?;
        let serialized = serde_json::to_string(&value)
            .map_err(|e| format!("failed to serialize v2 snapshot: {e}"))?;
        if serialized.len() > 1_048_576 {
            return Err("v2 snapshot exceeds 1MB size limit".to_string());
        }
        return Ok(Some(serialized));
    }
    fn sanitize(value: &Value, depth: usize) -> Result<Value, String> {
        if depth > 4 {
            return Err("poll descriptor is too deeply nested".to_string());
        }
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => Ok(value.clone()),
            Value::String(text) => {
                if super::secrets::text_len_without_ref_tokens(text)
                    .map_err(|error| error.to_string())?
                    > 512
                {
                    return Err("poll descriptor string is too long".to_string());
                }
                let lowered = text.to_ascii_lowercase();
                if lowered.starts_with("data:")
                    || lowered.starts_with("blob:")
                    || super::secrets::contains_plaintext_credential_assignment(text)
                {
                    return Err("poll descriptor contains credential or payload data".to_string());
                }
                Ok(Value::String(text.to_string()))
            }
            Value::Array(items) => items
                .iter()
                .take(32)
                .map(|item| sanitize(item, depth + 1))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array),
            Value::Object(map) => {
                let mut output = serde_json::Map::new();
                for (key, item) in map.iter().take(32) {
                    if key == "credential_ref" {
                        let reference = serde_json::from_value::<SecretRef>(item.clone())
                            .map_err(|_| SecretError::error("invalid_ref").to_string())?;
                        reference.validate().map_err(|error| error.to_string())?;
                        output.insert(
                            key.clone(),
                            serde_json::to_value(reference)
                                .map_err(|_| SecretError::error("invalid_ref").to_string())?,
                        );
                        continue;
                    }
                    let normalized = key.trim().to_ascii_lowercase();
                    if normalized.contains("key")
                        || normalized.contains("token")
                        || normalized.contains("secret")
                        || normalized.contains("auth")
                        || normalized.contains("cookie")
                        || normalized.contains("header")
                        || normalized.contains("body")
                        || normalized.contains("prompt")
                        || normalized.contains("data")
                    {
                        return Err(format!("poll descriptor contains sensitive field: {key}"));
                    }
                    output.insert(key.clone(), sanitize(item, depth + 1)?);
                }
                Ok(Value::Object(output))
            }
        }
    }
    serde_json::to_string(&sanitize(&value, 0)?)
        .map(Some)
        .map_err(|e| format!("failed to serialize poll descriptor: {e}"))
}

fn missing_job_dto(job_id: String) -> GenerationJobStatusDto {
    let now = now_ms();
    GenerationJobStatusDto {
        job_id,
        status: "not_found".to_string(),
        result: None,
        error: Some("job not found".to_string()),
        media_type: "unknown".to_string(),
        provider_id: "unknown".to_string(),
        model_id: None,
        config_fingerprint: None,
        phase: "unknown".to_string(),
        external_task_id: None,
        poll_descriptor: None,
        result_url: None,
        error_category: Some("not_found".to_string()),
        network_route: "system".to_string(),
        submit_attempts: 0,
        consecutive_network_errors: 0,
        last_poll_at: None,
        resumable: false,
        created_at: now,
        updated_at: now,
        local_result_missing: None,
    }
}

#[tauri::command]
pub fn create_generation_job(
    app: AppHandle,
    request: CreateGenerationJobDto,
) -> Result<GenerationJobStatusDto, String> {
    let job_id = normalize_job_token(request.job_id, &Uuid::new_v4().to_string(), 96);
    let media_type = normalize_job_token(Some(request.media_type), "image", 32);
    let provider_id = normalize_job_token(Some(request.provider_id), "custom", 96);
    let model_id = request
        .model_id
        .map(|value| normalize_job_token(Some(value), "", 160))
        .filter(|v| !v.is_empty());
    let status = normalize_job_token(request.status, "queued", 32);
    let phase = normalize_job_token(request.phase, "submit", 32);
    let route = normalize_job_token(request.network_route, "system", 32);
    validate_network_route(route.as_str())?;
    let poll_descriptor_json = sanitize_job_poll_descriptor(
        request.poll_descriptor,
        &job_id,
        &provider_id,
        sanitize_external_task_id(request.external_task_id.as_deref()).as_deref(),
    )?;
    let submit_attempts = u32::from(
        status == "submitting"
            || status == "running"
            || status == "unknown"
            || status == "materializing"
            || status == "succeeded",
    );
    insert_generation_job_record(
        &app,
        job_id.as_str(),
        provider_id.as_str(),
        media_type.as_str(),
        model_id.as_deref(),
        request.config_fingerprint.as_deref(),
        status.as_str(),
        phase.as_str(),
        request.resumable.unwrap_or(true),
        request.external_task_id.as_deref(),
        poll_descriptor_json.as_deref(),
        None,
        request.result_url.as_deref(),
        request.error.as_deref(),
        request.error_category.as_deref(),
        route.as_str(),
        submit_attempts,
        None,
        0,
    )?;
    get_generation_job(&app, job_id.as_str())?
        .map(|record| dto_from_record(&record))
        .ok_or_else(|| "generation job disappeared after insert".to_string())
}

#[tauri::command]
pub fn update_generation_job_record(
    app: AppHandle,
    request: UpdateGenerationJobDto,
) -> Result<GenerationJobStatusDto, String> {
    let conn = open_db(&app)?;
    let current = get_generation_job(&app, request.job_id.as_str())?
        .ok_or_else(|| "job not found".to_string())?;
    let status = request.status.as_deref().unwrap_or(current.status.as_str());
    let attempts = current.submit_attempts;
    if !permits_missing_result_recovery(&current, status, request.external_task_id.as_deref()) {
        validate_status_transition(Some(current.status.as_str()), status, attempts)?;
    }
    let next_submit_attempts = if current.status != "submitting" && status == "submitting" {
        attempts.saturating_add(1)
    } else {
        attempts
    };
    if next_submit_attempts > 1 {
        return Err(
            "generation job submit already attempted; refusing duplicate submission".to_string(),
        );
    }
    if current.status == "unknown"
        && matches!(status, "running" | "recoverable_wait")
        && request
            .external_task_id
            .as_deref()
            .or(current.external_task_id.as_deref())
            .is_none()
    {
        return Err(
            "unknown generation jobs require an external task id before recovery".to_string(),
        );
    }
    let route = validate_immutable_network_route(
        current.network_route.as_str(),
        request.network_route.as_deref(),
    )?;
    let external_task_id = sanitize_external_task_id(request.external_task_id.as_deref());
    let effective_task_id = external_task_id
        .as_deref()
        .or(current.external_task_id.as_deref());
    validate_comfy_recovery_update(
        request.poll_descriptor.as_ref(),
        &current,
        effective_task_id,
    )?;
    let descriptor = sanitize_job_poll_descriptor(
        request.poll_descriptor,
        &current.job_id,
        &current.provider_id,
        effective_task_id,
    )?;
    let persisted_result = request
        .result
        .filter(|value| is_persistable_result_source(value, false));
    let persisted_result_url = request
        .result_url
        .filter(|value| is_persistable_result_source(value, true));
    let clears_error = status_clears_persisted_error(status);
    let persisted_error = if clears_error {
        None
    } else {
        sanitize_optional_diagnostic(request.error.as_deref()).or_else(|| current.error.clone())
    };
    let persisted_error_category = if clears_error {
        None
    } else {
        sanitize_error_category(request.error_category.as_deref())
            .or_else(|| current.error_category.clone())
    };
    conn.execute(
        r#"UPDATE ai_generation_jobs SET
          status = ?1,
          phase = COALESCE(?2, phase),
          external_task_id = COALESCE(?3, external_task_id),
          poll_descriptor_json = COALESCE(?4, poll_descriptor_json),
          result = COALESCE(?5, result),
          result_url = COALESCE(?6, result_url),
          error = ?7,
          error_category = ?8,
          network_route = ?9,
          submit_attempts = ?10,
          resumable = COALESCE(?11, resumable),
          last_poll_at = COALESCE(?12, last_poll_at),
          consecutive_network_errors = COALESCE(?13, consecutive_network_errors),
          updated_at = ?14
        WHERE job_id = ?15"#,
        params![
            status,
            request.phase,
            external_task_id,
            descriptor,
            persisted_result,
            persisted_result_url,
            persisted_error,
            persisted_error_category,
            route,
            i64::from(next_submit_attempts),
            request.resumable.map(|v| if v { 1_i64 } else { 0_i64 }),
            request.last_poll_at,
            request.consecutive_network_errors.map(i64::from),
            now_ms(),
            request.job_id,
        ],
    )
    .map_err(|e| format!("Failed to update generation job record: {e}"))?;
    get_generation_job(&app, request.job_id.as_str())?
        .map(|record| dto_from_record(&record))
        .ok_or_else(|| "generation job disappeared after update".to_string())
}

#[tauri::command]
pub fn list_generation_jobs(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<GenerationJobStatusDto>, String> {
    let conn = open_db(&app)?;
    let take = i64::from(limit.unwrap_or(100).clamp(1, 500));
    let mut stmt = conn
        .prepare("SELECT job_id FROM ai_generation_jobs ORDER BY updated_at DESC LIMIT ?1")
        .map_err(|e| format!("Failed to prepare generation job list: {e}"))?;
    let ids = stmt
        .query_map(params![take], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to list generation jobs: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read generation job list: {e}"))?;
    let jobs = ids
        .into_iter()
        .filter_map(|job_id| get_generation_job(&app, job_id.as_str()).ok().flatten())
        .map(|record| dto_from_record(&record))
        .collect::<Vec<_>>();
    Ok(jobs)
}

#[tauri::command]
pub fn get_generation_job_record(
    app: AppHandle,
    job_id: String,
) -> Result<GenerationJobStatusDto, String> {
    get_generation_job(&app, job_id.trim())?
        .map(|record| {
            let mut dto = dto_from_record(&record);
            // A specific result read may verify bytes; listing hundreds of jobs
            // must remain a metadata-only operation.
            dto.local_result_missing = missing_v2_result_bytes(&record).then_some(true);
            dto
        })
        .ok_or_else(|| "job not found".to_string())
}

#[tauri::command]
pub fn forget_generation_job(app: AppHandle, job_id: String) -> Result<bool, String> {
    let conn = open_db(&app)?;
    let removed = conn
        .execute(
            "DELETE FROM ai_generation_jobs WHERE job_id = ?1",
            params![job_id.trim()],
        )
        .map_err(|e| format!("Failed to forget generation job: {e}"))?;
    Ok(removed > 0)
}

async fn effective_credential_ref(
    provider: &dyn AIProvider,
    explicit: Option<&Value>,
) -> Result<SecretRef, String> {
    let reference = if let Some(value) = explicit {
        serde_json::from_value::<SecretRef>(value.clone())
            .map_err(|_| SecretError::error("invalid_ref").to_string())?
    } else {
        provider
            .credential_ref()
            .await
            .unwrap_or_else(|| SecretRef {
                namespace: "provider".to_string(),
                id: provider.name().to_string(),
            })
    };
    reference.validate().map_err(|error| error.to_string())?;
    Ok(reference)
}

async fn bind_request_credential(
    provider: &dyn AIProvider,
    request: &mut GenerateRequestDto,
) -> Result<SecretRef, String> {
    let reference = effective_credential_ref(
        provider,
        request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("credential_ref")),
    )
    .await?;
    let value = serde_json::to_value(&reference)
        .map_err(|_| SecretError::error("invalid_ref").to_string())?;
    request
        .extra_params
        .get_or_insert_with(HashMap::new)
        .insert("credential_ref".to_string(), value);
    Ok(reference)
}

fn bind_task_credential(metadata: Option<Value>, reference: &SecretRef) -> Result<Value, String> {
    let mut metadata = metadata.unwrap_or_else(|| serde_json::json!({}));
    let fields = metadata
        .as_object_mut()
        .ok_or_else(|| SecretError::error("invalid_task_metadata").to_string())?;
    fields.insert(
        "credential_ref".to_string(),
        serde_json::to_value(reference)
            .map_err(|_| SecretError::error("invalid_ref").to_string())?,
    );
    Ok(metadata)
}

#[tauri::command]
pub async fn set_api_key(provider: String, api_key: String) -> Result<(), String> {
    info!("Setting API key for provider: {}", provider);

    let registry = get_registry();
    let resolved_provider = registry
        .get_provider(provider.as_str())
        .ok_or_else(|| format!("Unknown provider: {}", provider))?;

    resolved_provider
        .set_api_key(api_key)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn submit_generate_image_job(
    app: AppHandle,
    mut request: GenerateRequestDto,
) -> Result<String, String> {
    info!("Submitting generation job with model: {}", request.model);

    let registry = get_registry();
    let provider = registry
        .resolve_provider_for_model(&request.model)
        .cloned()
        .ok_or_else(|| "Unknown image model; request was not submitted".to_string())?;
    let credential_ref = bind_request_credential(provider.as_ref(), &mut request).await?;

    let req = GenerateRequest {
        prompt: request.prompt,
        model: request.model,
        size: request.size,
        aspect_ratio: request.aspect_ratio,
        reference_images: request.reference_images,
        extra_params: request.extra_params,
    };

    let job_id = Uuid::new_v4().to_string();
    let provider_id = provider.name().to_string();

    if provider.supports_task_resume() {
        match provider.submit_task(req).await.map_err(|e| e.to_string())? {
            ProviderTaskSubmission::Succeeded(image_source) => {
                insert_generation_job(
                    &app,
                    job_id.as_str(),
                    provider_id.as_str(),
                    "succeeded",
                    true,
                    None,
                    None,
                    Some(image_source.as_str()),
                    None,
                )?;
            }
            ProviderTaskSubmission::Queued(handle) => {
                let metadata = bind_task_credential(handle.metadata, &credential_ref)?;
                let meta_json = serde_json::to_string(&metadata)
                    .map_err(|_| SecretError::error("invalid_task_metadata").to_string())?;
                insert_generation_job(
                    &app,
                    job_id.as_str(),
                    provider_id.as_str(),
                    "running",
                    true,
                    Some(handle.task_id.as_str()),
                    Some(meta_json.as_str()),
                    None,
                    None,
                )?;
            }
        }
        return Ok(job_id);
    }

    insert_generation_job(
        &app,
        job_id.as_str(),
        provider_id.as_str(),
        "running",
        false,
        None,
        None,
        None,
        None,
    )?;
    {
        let mut active_set = active_non_resumable_job_ids().write().await;
        active_set.insert(job_id.clone());
    }

    let app_handle = app.clone();
    let spawned_job_id = job_id.clone();
    let spawned_provider = provider.clone();
    tauri::async_runtime::spawn(async move {
        let result = spawned_provider.generate(req).await;
        let update_result = match result {
            Ok(image_source) => update_generation_job(
                &app_handle,
                spawned_job_id.as_str(),
                "succeeded",
                Some(image_source.as_str()),
                None,
            ),
            Err(error) => {
                let message = error.to_string();
                update_generation_job(
                    &app_handle,
                    spawned_job_id.as_str(),
                    "failed",
                    None,
                    Some(message.as_str()),
                )
            }
        };
        if let Err(error) = update_result {
            info!("Failed to update non-resumable generation job: {}", error);
        }
        let mut active_set = active_non_resumable_job_ids().write().await;
        active_set.remove(spawned_job_id.as_str());
    });

    Ok(job_id)
}

#[tauri::command]
pub async fn get_generate_image_job(
    app: AppHandle,
    job_id: String,
) -> Result<GenerationJobStatusDto, String> {
    let maybe_record = get_generation_job(&app, job_id.as_str())?;
    let Some(mut record) = maybe_record else {
        return Ok(missing_job_dto(job_id));
    };

    if record.status == "succeeded" || record.status == "failed" {
        return Ok(dto_from_record(&record));
    }

    if record.status == "unknown" && record.external_task_id.is_none() {
        // The provider may have accepted the non-idempotent request. Keep the
        // ambiguity visible until the user supplies a task id or abandons it.
        return Ok(dto_from_record(&record));
    }

    if !record.resumable {
        let is_active = {
            let active_set = active_non_resumable_job_ids().read().await;
            active_set.contains(record.job_id.as_str())
        };
        if is_active {
            let _ = touch_generation_job(&app, record.job_id.as_str());
            return Ok(dto_from_record(&record));
        }

        let interrupted_message =
            "job interrupted by app restart; no safe recovery handle was persisted".to_string();
        update_generation_job(
            &app,
            record.job_id.as_str(),
            "unknown",
            None,
            Some(interrupted_message.as_str()),
        )?;
        record.status = "unknown".to_string();
        record.error_category = Some("interrupted".to_string());
        record.error = Some(interrupted_message);
        return Ok(dto_from_record(&record));
    }

    let provider = get_registry()
        .get_provider(record.provider_id.as_str())
        .cloned()
        .ok_or_else(|| format!("Provider not found for job: {}", record.provider_id))?;

    let Some(task_id) = record.external_task_id.clone() else {
        if record.status == "unknown" {
            return Ok(dto_from_record(&record));
        }
        let message = "missing external task id".to_string();
        update_generation_job(
            &app,
            record.job_id.as_str(),
            "failed",
            None,
            Some(message.as_str()),
        )?;
        record.status = "failed".to_string();
        record.error = Some(message);
        return Ok(dto_from_record(&record));
    };

    let task_meta = record
        .poll_descriptor_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let credential_ref = effective_credential_ref(
        provider.as_ref(),
        task_meta
            .as_ref()
            .and_then(|metadata| metadata.get("credential_ref")),
    )
    .await?;
    let task_meta = Some(bind_task_credential(task_meta, &credential_ref)?);

    match provider
        .poll_task(ProviderTaskHandle {
            task_id,
            metadata: task_meta,
        })
        .await
    {
        Ok(ProviderTaskPollResult::Running) => {
            let _ = touch_generation_job(&app, record.job_id.as_str());
            Ok(dto_from_record(&record))
        }
        Ok(ProviderTaskPollResult::Succeeded(image_source)) => {
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "succeeded",
                Some(image_source.as_str()),
                None,
            )?;
            get_generation_job(&app, record.job_id.as_str())?
                .map(|updated| dto_from_record(&updated))
                .ok_or_else(|| "generation job disappeared after success".to_string())
        }
        Ok(ProviderTaskPollResult::Failed(message)) => {
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "failed",
                None,
                Some(message.as_str()),
            )?;
            get_generation_job(&app, record.job_id.as_str())?
                .map(|updated| dto_from_record(&updated))
                .ok_or_else(|| "generation job disappeared after failure".to_string())
        }
        Err(AIError::TaskFailed(message)) => {
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "failed",
                None,
                Some(message.as_str()),
            )?;
            get_generation_job(&app, record.job_id.as_str())?
                .map(|updated| dto_from_record(&updated))
                .ok_or_else(|| "generation job disappeared after failure".to_string())
        }
        Err(error) => {
            record.error = Some(error.to_string());
            record.error_category = Some("network".to_string());
            Ok(dto_from_record(&record))
        }
    }
}

#[tauri::command]
pub async fn generate_image(mut request: GenerateRequestDto) -> Result<String, String> {
    info!("Generating image with model: {}", request.model);

    let registry = get_registry();
    let provider = registry
        .resolve_provider_for_model(&request.model)
        .ok_or_else(|| "Unknown image model; request was not submitted".to_string())?;
    bind_request_credential(provider.as_ref(), &mut request).await?;

    let req = GenerateRequest {
        prompt: request.prompt,
        model: request.model,
        size: request.size,
        aspect_ratio: request.aspect_ratio,
        reference_images: request.reference_images,
        extra_params: request.extra_params,
    };

    provider.generate(req).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_models() -> Result<Vec<String>, String> {
    Ok(get_registry().list_models())
}

#[cfg(test)]
#[path = "ai_contract_tests.rs"]
mod contract_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unknown_image_model_is_rejected_before_credential_binding() {
        let result = generate_image(GenerateRequestDto {
            prompt: "Routing fixture".into(),
            model: "unknown-provider/image-model".into(),
            size: "1024x576".into(),
            aspect_ratio: "16:9".into(),
            reference_images: None,
            extra_params: None,
        })
        .await;
        assert_eq!(
            result,
            Err("Unknown image model; request was not submitted".to_string())
        );
    }

    #[test]
    fn missing_result_recovery_requires_missing_bytes_original_handle_and_never_allows_resubmit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("result.png");
        std::fs::write(&path, b"existing bytes").unwrap();
        let mut snapshot = template_snapshot();
        snapshot["assets"] = serde_json::json!([path]);
        snapshot["assetKinds"] = serde_json::json!(["image"]);
        let mut record = GenerationJobRecord {
            job_id: "job".into(),
            provider_id: "relay".into(),
            media_type: "image".into(),
            model_id: None,
            config_fingerprint: None,
            status: "succeeded".into(),
            phase: "done".into(),
            resumable: false,
            external_task_id: Some("accepted-once".into()),
            poll_descriptor_json: Some(snapshot.to_string()),
            result: Some(path.to_string_lossy().into()),
            result_url: None,
            error: None,
            error_category: None,
            network_route: "system".into(),
            submit_attempts: 1,
            consecutive_network_errors: 0,
            last_poll_at: None,
            created_at: 1,
            updated_at: 2,
        };
        assert!(!missing_v2_result_bytes(&record));
        assert!(!permits_missing_result_recovery(&record, "running", None));
        std::fs::remove_file(&path).unwrap();
        assert!(missing_v2_result_bytes(&record));
        assert!(permits_missing_result_recovery(
            &record,
            "running",
            Some("accepted-once")
        ));
        assert!(!permits_missing_result_recovery(
            &record,
            "submitting",
            None
        ));
        assert!(!permits_missing_result_recovery(
            &record,
            "running",
            Some("replacement")
        ));
        record.external_task_id = None;
        assert!(!permits_missing_result_recovery(
            &record,
            "materializing",
            None
        ));
        snapshot["outputs"] = serde_json::json!([{"kind":"image","url":"https://relay.example/original.png","auth":false}]);
        record.poll_descriptor_json = Some(snapshot.to_string());
        assert!(permits_missing_result_recovery(
            &record,
            "materializing",
            None
        ));
        assert!(!permits_missing_result_recovery(&record, "running", None));
        snapshot["assetKinds"] = serde_json::json!(["text"]);
        record.poll_descriptor_json = Some(snapshot.to_string());
        assert!(!missing_v2_result_bytes(&record));
    }

    fn template_snapshot() -> Value {
        serde_json::json!({
            "version": 2, "adapter": "template",
            "profile": { "version": 2, "id": "relay", "name": "Relay", "baseUrl": "https://relay.example", "auth": { "type": "bearer" },
                "operations": { "image.generate": { "method": "POST", "path": "/images", "body": "json", "template": { "model": "{{model}}", "prompt": "{{prompt}}" },
                    "response": { "mode": "async", "taskIdPath": "id", "poll": { "method": "GET", "path": "{{submit.status_url}}", "intervalSec": 3, "timeoutMin": 5,
                        "success": ["completed"], "failure": ["failed"], "outputs": [{ "path": "data[*].url", "as": "url" }] } } } },
                "models": [{ "id": "model", "operations": ["image.generate"], "params": [] }] },
            "input": { "jobId": "job", "channelId": "relay", "modelId": "model", "operation": "image.generate", "prompt": "", "params": {}, "refs": [], "count": 1 },
            "submit": { "status_url": "https://relay.example/tasks/task" }
        })
    }

    fn model_snapshot() -> Value {
        let poll = serde_json::json!({
            "method": "POST", "path": "/tasks/{{taskId}}", "template": { "id": "{{submit.task_id}}" },
            "intervalSec": 0.5, "timeoutMin": 5, "statusPath": "status", "progressPath": "progress",
            "success": ["ready"], "failure": ["failed"],
            "outputs": [{ "url": "/files/{{taskId}}/model.glb", "kind": "model", "auth": true }],
            "resultRequest": { "method": "GET", "path": "/files/{{poll.file_id}}", "template": { "task": "{{submit.task_id}}" } }
        });
        let endpoint = serde_json::json!({
            "method": "POST", "path": "/meshes/{{mode}}", "body": "multipart",
            "files": { "field": "image", "cardinality": "single" }, "imageEncoding": "url", "errorPath": "error.message",
            "template": { "model": "{{model}}", "image": "{{slotFirst.reference}}", "quality": "{{param.quality}}", "seed": "{{param.seed}}" },
            "response": { "mode": "async", "taskIdPath": "task.id", "poll": poll }
        });
        let params = serde_json::json!([{
            "key": "quality", "label": "Quality", "type": "enum", "required": true, "group": "basic",
            "description": "Mesh quality", "options": [{ "label": "High", "value": "high" }], "default": "high"
        }, {
            "key": "seed", "label": "Seed", "type": "number", "min": 0, "max": 100, "step": 1,
            "default": 0, "group": "advanced"
        }]);
        let mode = serde_json::json!({
            "id": "image-to-model", "label": "Image to model", "description": "", "operation": "model.generate",
            "params": params,
            "slots": [{ "key": "reference", "label": "Reference", "kind": "image", "min": 1, "max": 1, "description": "" }],
            "endpoint": endpoint
        });
        let model = serde_json::json!({
            "id": "mesh", "label": "Mesh", "operations": ["model.generate"], "mention": "natural",
            "refs": { "image": 1, "video": 0, "audio": 0 },
            "params": [{ "key": "quality", "label": "Quality", "type": "text", "default": "standard" }],
            "modes": [mode]
        });
        let profile = serde_json::json!({
            "version": 2, "id": "mesh-channel", "name": "Mesh channel", "baseUrl": "https://mesh.example/v1",
            "auth": { "type": "header", "name": "x-api-key", "prefix": "" },
            "headers": { "X-Client": "Storyboard" }, "docsUrl": "https://mesh.example/docs", "notes": ["Image to GLB"],
            "operations": {}, "models": [model]
        });
        serde_json::json!({
            "version": 2, "adapter": "template", "profile": profile,
            "input": {
                "jobId": "model-job", "channelId": "mesh-channel", "modelId": "mesh", "modeId": "image-to-model",
                "operation": "model.generate", "prompt": "", "params": { "quality": "high", "seed": 0 }, "refs": [], "count": 1
            },
            "submit": { "task_id": "remote-task" },
            "outputs": [{ "url": "https://mesh.example/v1/files/remote-task/model.glb", "kind": "model", "auth": true }],
            "assets": ["model-job-output-0"], "assetKinds": ["model"]
        })
    }

    fn comfy_recovery_snapshot() -> Value {
        let base = "https://original.example/proxy";
        serde_json::json!({
            "version": 2, "adapter": "comfyui",
            "input": {
                "jobId": "comfy-recovery-job", "channelId": "original-provider", "modelId": "workflow",
                "operation": "image.generate", "prompt": "", "refs": [], "count": 1,
                "params": { "comfyuiSnapshot": {
                    "workflow": { "9": { "class_type": "SaveImage", "inputs": { "images": ["6", 0] } } },
                    "bindings": {}, "outputNodeIds": ["9"], "auth": { "mode": "none" },
                    "comfyOrgKeyRequired": false, "mediaKind": "image",
                    "urls": {
                        "base": base, "prompt": format!("{base}/prompt"), "history": format!("{base}/history"),
                        "view": format!("{base}/view"), "ws": "wss://original.example/proxy/ws",
                        "objectInfo": format!("{base}/object_info"), "systemStats": format!("{base}/system_stats"),
                        "upload": format!("{base}/upload/image"), "defaultedScheme": false, "strippedPath": null
                    }
                } }
            },
            "pollIntervalMs": 1000, "pollTimeoutMs": 60000, "authPrefix": "", "headerNames": [], "queryNames": [],
            "recoveryRoute": {
                "providerId": "replacement-provider", "baseUrl": "https://replacement.example/tunnel",
                "originalBaseUrl": base, "externalTaskId": "original-prompt",
                "auth": { "mode": "header", "name": "X-API-Key" }, "authPrefix": "Token",
                "headerNames": ["X-Tunnel"], "queryNames": ["client"]
            }
        })
    }

    #[test]
    fn comfy_recovery_route_admission_and_sqlite_reload_preserve_the_original_task() {
        let snapshot = comfy_recovery_snapshot();
        let serialized = sanitize_job_poll_descriptor(
            Some(snapshot.clone()),
            "comfy-recovery-job",
            "original-provider",
            Some("original-prompt"),
        )
        .expect("admit the exact non-secret recovery-route contract")
        .expect("retain the recovery descriptor");
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("jobs.db");
        {
            let conn = Connection::open(&path).unwrap();
            ensure_generation_jobs_table(&conn).unwrap();
            conn.execute(
                "INSERT INTO ai_generation_jobs (job_id, provider_id, status, phase, external_task_id, \
                 poll_descriptor_json, sensitive_fields_scrubbed, created_at, updated_at) \
                 VALUES (?1, ?2, 'recoverable_wait', 'poll', ?3, ?4, 0, 1, 1)",
                params!["comfy-recovery-job", "original-provider", "original-prompt", serialized],
            ).unwrap();
        }
        let conn = Connection::open(path).unwrap();
        ensure_generation_jobs_table(&conn).expect("retain the route during durable-row scrubbing");
        let record = get_generation_job_from_connection(&conn, "comfy-recovery-job")
            .expect("read the reopened native job")
            .expect("retain the persisted job");
        assert_eq!(record.external_task_id.as_deref(), Some("original-prompt"));
        assert_eq!(dto_from_record(&record).poll_descriptor, Some(snapshot));
    }

    #[test]
    fn comfy_recovery_routes_accept_only_the_declared_non_secret_auth_shapes() {
        for auth in [
            serde_json::json!({ "mode": "none" }),
            serde_json::json!({ "mode": "bearer" }),
            serde_json::json!({ "mode": "header", "name": "X-API-Key" }),
            serde_json::json!({ "mode": "query", "name": "access_key" }),
        ] {
            let mut snapshot = comfy_recovery_snapshot();
            snapshot["recoveryRoute"]["auth"] = auth;
            let serialized = sanitize_poll_descriptor(Some(snapshot.clone()))
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&serialized).unwrap(),
                snapshot
            );
        }
        for name in [
            "providerId",
            "baseUrl",
            "originalBaseUrl",
            "externalTaskId",
            "auth",
            "authPrefix",
            "headerNames",
            "queryNames",
        ] {
            let mut snapshot = comfy_recovery_snapshot();
            snapshot["recoveryRoute"]
                .as_object_mut()
                .unwrap()
                .remove(name);
            assert!(
                sanitize_poll_descriptor(Some(snapshot)).is_err(),
                "missing {name}"
            );
        }
        for (pointer, invalid) in [
            ("/recoveryRoute", serde_json::json!(null)),
            ("/recoveryRoute/providerId", serde_json::json!("")),
            ("/recoveryRoute/providerId", serde_json::json!(12)),
            ("/recoveryRoute/externalTaskId", serde_json::json!("")),
            ("/recoveryRoute/externalTaskId", serde_json::json!(false)),
            ("/recoveryRoute/authPrefix", serde_json::json!(null)),
            (
                "/recoveryRoute/authPrefix",
                serde_json::json!("Bearer route-private-key"),
            ),
            (
                "/recoveryRoute/headerNames",
                serde_json::json!({ "X-API-Key": "private" }),
            ),
            ("/recoveryRoute/headerNames", serde_json::json!([1])),
            ("/recoveryRoute/queryNames", serde_json::json!([null])),
            (
                "/recoveryRoute/auth",
                serde_json::json!({ "mode": "header" }),
            ),
            (
                "/recoveryRoute/auth",
                serde_json::json!({ "mode": "query", "name": "" }),
            ),
            (
                "/recoveryRoute/auth",
                serde_json::json!({ "mode": "bearer", "name": "Authorization" }),
            ),
            (
                "/recoveryRoute/auth",
                serde_json::json!({ "mode": "header", "name": "X-API-Key", "prefix": "Token" }),
            ),
            (
                "/recoveryRoute/auth",
                serde_json::json!({ "mode": "bearer", "value": "private" }),
            ),
            (
                "/recoveryRoute/auth",
                serde_json::json!({ "mode": "none", "auth": { "mode": "none" } }),
            ),
        ] {
            let mut snapshot = comfy_recovery_snapshot();
            *snapshot.pointer_mut(pointer).unwrap() = invalid;
            assert!(
                sanitize_poll_descriptor(Some(snapshot)).is_err(),
                "{pointer}"
            );
        }
        let mut unknown = comfy_recovery_snapshot();
        unknown["recoveryRoute"]["invented"] = serde_json::json!(true);
        assert!(sanitize_poll_descriptor(Some(unknown)).is_err());
        let mut nested = comfy_recovery_snapshot();
        nested["input"]["params"]["other"] = serde_json::json!({ "auth": { "mode": "none" } });
        assert!(sanitize_poll_descriptor(Some(nested)).is_err());
        let mut template = template_snapshot();
        template["recoveryRoute"] = comfy_recovery_snapshot()["recoveryRoute"].clone();
        assert!(sanitize_poll_descriptor(Some(template)).is_err());
        let mut template = template_snapshot();
        template["input"]["params"]["comfyuiSnapshot"] =
            serde_json::json!({ "auth": { "mode": "none" } });
        assert!(sanitize_poll_descriptor(Some(template)).is_err());
    }

    #[test]
    fn comfy_recovery_routes_reject_unsafe_urls_downgrades_and_changed_original_bases() {
        for url in [
            "ftp://replacement.example/tunnel",
            "file:///tmp/comfy",
            "javascript:alert(1)",
            "https://user:password@replacement.example/tunnel",
            "https://replacement.example/tunnel?api_key=private",
            "https://replacement.example/tunnel#private",
            "https://replacement.example/\ntunnel",
            "http://replacement.example/tunnel",
        ] {
            let mut snapshot = comfy_recovery_snapshot();
            snapshot["recoveryRoute"]["baseUrl"] = serde_json::json!(url);
            assert!(sanitize_poll_descriptor(Some(snapshot)).is_err(), "{url}");
        }
        for url in [
            "https://other.example",
            "ftp://original.example/proxy",
            "https://original.example/proxy?key=private",
        ] {
            let mut snapshot = comfy_recovery_snapshot();
            snapshot["recoveryRoute"]["originalBaseUrl"] = serde_json::json!(url);
            assert!(sanitize_poll_descriptor(Some(snapshot)).is_err(), "{url}");
        }
        let mut upgraded = comfy_recovery_snapshot();
        upgraded["input"]["params"]["comfyuiSnapshot"]["urls"]["base"] =
            serde_json::json!("http://original.example/proxy");
        upgraded["recoveryRoute"]["originalBaseUrl"] =
            serde_json::json!("http://original.example/proxy");
        assert!(sanitize_poll_descriptor(Some(upgraded)).is_ok());
    }

    #[test]
    fn comfy_recovery_routes_bind_to_native_job_metadata_and_cannot_rebind_an_accepted_task() {
        for (job_id, provider_id, task_id) in [
            (
                "different-job",
                "original-provider",
                Some("original-prompt"),
            ),
            (
                "comfy-recovery-job",
                "different-provider",
                Some("original-prompt"),
            ),
            (
                "comfy-recovery-job",
                "original-provider",
                Some("different-prompt"),
            ),
            ("comfy-recovery-job", "original-provider", None),
        ] {
            assert!(sanitize_job_poll_descriptor(
                Some(comfy_recovery_snapshot()),
                job_id,
                provider_id,
                task_id,
            )
            .is_err());
        }
        let mut original = comfy_recovery_snapshot();
        original.as_object_mut().unwrap().remove("recoveryRoute");
        let conn = Connection::open_in_memory().unwrap();
        ensure_generation_jobs_table(&conn).unwrap();
        conn.execute(
            "INSERT INTO ai_generation_jobs (job_id, provider_id, status, external_task_id, \
             poll_descriptor_json, sensitive_fields_scrubbed, created_at, updated_at) \
             VALUES ('comfy-recovery-job', 'original-provider', 'recoverable_wait', 'original-prompt', ?1, 1, 1, 1)",
            params![serde_json::to_string(&original).unwrap()],
        ).unwrap();
        let mut current = get_generation_job_from_connection(&conn, "comfy-recovery-job")
            .unwrap()
            .unwrap();
        let snapshot = comfy_recovery_snapshot();
        assert!(
            validate_comfy_recovery_update(Some(&snapshot), &current, Some("original-prompt"))
                .is_ok()
        );
        let mut rebound = snapshot.clone();
        rebound["recoveryRoute"]["externalTaskId"] = serde_json::json!("different-prompt");
        assert!(
            validate_comfy_recovery_update(Some(&rebound), &current, Some("different-prompt"))
                .is_err()
        );
        let mut rewritten = snapshot.clone();
        rewritten["input"]["params"]["comfyuiSnapshot"]["urls"]["base"] =
            serde_json::json!("https://rewritten.example");
        rewritten["recoveryRoute"]["originalBaseUrl"] =
            serde_json::json!("https://rewritten.example");
        assert!(sanitize_poll_descriptor(Some(rewritten.clone())).is_ok());
        assert!(validate_comfy_recovery_update(
            Some(&rewritten),
            &current,
            Some("original-prompt")
        )
        .is_err());
        current.poll_descriptor_json = Some(serde_json::to_string(&snapshot).unwrap());
        assert!(validate_comfy_recovery_update(None, &current, Some("original-prompt")).is_ok());
        assert!(validate_comfy_recovery_update(None, &current, Some("different-prompt")).is_err());
        assert!(
            validate_comfy_recovery_update(Some(&original), &current, Some("original-prompt"))
                .is_err()
        );
        current.external_task_id = None;
        assert!(
            validate_comfy_recovery_update(Some(&snapshot), &current, Some("original-prompt"))
                .is_err()
        );
    }

    #[test]
    fn comfy_recovery_routes_drop_mismatched_native_rows_on_read_and_legacy_scrub() {
        let snapshot = serde_json::to_string(&comfy_recovery_snapshot()).unwrap();
        for scrubbed in [0, 1] {
            let conn = Connection::open_in_memory().unwrap();
            ensure_generation_jobs_table(&conn).unwrap();
            conn.execute(
                "INSERT INTO ai_generation_jobs (job_id, provider_id, status, external_task_id, \
                 poll_descriptor_json, sensitive_fields_scrubbed, created_at, updated_at) \
                 VALUES ('comfy-recovery-job', 'original-provider', 'recoverable_wait', 'different-prompt', ?1, ?2, 1, 1)",
                params![snapshot, scrubbed],
            ).unwrap();
            ensure_generation_jobs_table(&conn).unwrap();
            let record = get_generation_job_from_connection(&conn, "comfy-recovery-job")
                .unwrap()
                .unwrap();
            assert!(record.poll_descriptor_json.is_none(), "scrubbed={scrubbed}");
            assert_eq!(record.external_task_id.as_deref(), Some("different-prompt"));
        }
    }

    #[test]
    fn generation_media_type_validation_accepts_model_and_existing_media() {
        for media_type in ["image", "video", "audio", "model"] {
            assert!(
                validate_generation_media_type(media_type).is_ok(),
                "{media_type}"
            );
        }
        for media_type in [
            "",
            "unknown",
            "text",
            "chat",
            "model.generate",
            "executable",
        ] {
            assert!(
                validate_generation_media_type(media_type).is_err(),
                "{media_type}"
            );
        }
    }

    #[test]
    fn typed_v2_snapshots_accept_model_mode_overrides_and_imported_model_assets() {
        let snapshot = model_snapshot();
        let serialized = sanitize_poll_descriptor(Some(snapshot.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&serialized).unwrap(),
            snapshot
        );

        let mut shared = model_snapshot();
        let endpoint = shared["profile"]["models"][0]["modes"][0]
            .as_object_mut()
            .unwrap()
            .remove("endpoint")
            .unwrap();
        shared["profile"]["operations"]["model.generate"] = endpoint;
        let serialized = sanitize_poll_descriptor(Some(shared.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&serialized).unwrap(), shared);

        let mut implicit = shared;
        implicit["input"].as_object_mut().unwrap().remove("modeId");
        assert!(sanitize_poll_descriptor(Some(implicit)).is_ok());
    }

    #[test]
    fn typed_v2_snapshots_accept_sync_model_path_and_url_output_declarations() {
        for output in [
            serde_json::json!({ "path": "mesh.url", "as": "url", "kind": "model" }),
            serde_json::json!({ "path": "mesh.url", "as": "url" }),
            serde_json::json!({ "url": "/mesh.glb", "kind": "model", "auth": false }),
        ] {
            let mut snapshot = model_snapshot();
            snapshot["profile"]["models"][0]["modes"][0]["endpoint"]["response"] =
                serde_json::json!({ "mode": "sync", "outputs": [output] });
            let serialized = sanitize_poll_descriptor(Some(snapshot.clone()))
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&serialized).unwrap(),
                snapshot
            );
        }
    }

    #[test]
    fn typed_v2_snapshots_require_effective_model_outputs_and_allow_preview_outputs() {
        for outputs in [
            serde_json::json!([]),
            serde_json::json!([{ "path": "preview", "as": "url", "kind": "image" }]),
            serde_json::json!([{ "url": "/video.mp4", "kind": "video" }]),
        ] {
            let mut snapshot = model_snapshot();
            snapshot["profile"]["models"][0]["modes"][0]["endpoint"]["response"] =
                serde_json::json!({ "mode": "sync", "outputs": outputs });
            assert!(sanitize_poll_descriptor(Some(snapshot.clone())).is_err());
            let endpoint = snapshot["profile"]["models"][0]["modes"][0]
                .as_object_mut()
                .unwrap()
                .remove("endpoint")
                .unwrap();
            snapshot["profile"]["operations"]["model.generate"] = endpoint;
            assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        }
        let mut snapshot = model_snapshot();
        snapshot["profile"]["models"][0]["modes"][0]["endpoint"]["response"] = serde_json::json!({
            "mode": "sync", "outputs": [
                { "path": "mesh.url", "as": "url" },
                { "path": "preview.url", "as": "url", "kind": "image" }
            ]
        });
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_ok());
    }

    #[test]
    fn typed_v2_snapshots_preserve_legacy_operation_and_result_kinds() {
        for (operation, kind) in [
            ("image.generate", "image"),
            ("image.edit", "image"),
            ("video.generate", "video"),
            ("audio.generate", "audio"),
            ("chat", "text"),
            ("models.list", "text"),
        ] {
            let mut snapshot = template_snapshot();
            let mut endpoint = snapshot["profile"]["operations"]
                .as_object_mut()
                .unwrap()
                .remove("image.generate")
                .unwrap();
            endpoint["response"] = if kind == "text" {
                serde_json::json!({ "mode": "sync", "outputs": [] })
            } else {
                serde_json::json!({ "mode": "sync", "outputs": [{ "path": "data.url", "as": "url", "kind": kind }] })
            };
            snapshot["profile"]["operations"][operation] = endpoint;
            snapshot["profile"]["models"][0]["operations"] = serde_json::json!([operation]);
            snapshot["input"]["operation"] = serde_json::json!(operation);
            snapshot["input"]["modeId"] = serde_json::json!("default");
            snapshot["assetKinds"] = serde_json::json!([kind]);
            snapshot["assets"] = serde_json::json!(["saved-result"]);
            snapshot["outputs"] = if kind == "text" {
                serde_json::json!([{ "kind": "text", "text": "Generated text" }])
            } else {
                serde_json::json!([{ "kind": kind, "url": "https://relay.example/result", "auth": false }])
            };
            let serialized = sanitize_poll_descriptor(Some(snapshot.clone()))
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&serialized).unwrap(),
                snapshot,
                "{operation}"
            );
        }
    }

    #[test]
    fn typed_v2_snapshots_reject_malformed_model_and_mode_declarations() {
        for (pointer, invalid) in [
            ("/input/operation", serde_json::json!("mesh.generate")),
            ("/input/modelId", serde_json::json!("missing-model")),
            ("/input/modeId", serde_json::json!("missing-mode")),
            ("/input/operation", serde_json::json!("image.generate")),
            (
                "/profile/baseUrl",
                serde_json::json!("https://mesh.example/"),
            ),
            (
                "/profile/baseUrl",
                serde_json::json!("https://mesh.example?key=value"),
            ),
            ("/profile/baseUrl", serde_json::json!("ftp://mesh.example")),
            ("/profile/name", serde_json::json!("")),
            ("/profile/docsUrl", serde_json::json!("not a URL")),
            ("/profile/notes", serde_json::json!([1])),
            (
                "/profile/headers",
                serde_json::json!({ "X-API-Key": "private" }),
            ),
            ("/profile/auth/name", serde_json::json!("")),
            (
                "/profile/models/0/operations",
                serde_json::json!(["mesh.generate"]),
            ),
            (
                "/profile/models/0/params/0/key",
                serde_json::json!("invalid.key"),
            ),
            ("/profile/models/0/refs/image", serde_json::json!(-1)),
            ("/profile/models/0/mention", serde_json::json!("unknown")),
            ("/profile/models/0/modes", serde_json::json!([])),
            (
                "/profile/models/0/modes/0/operation",
                serde_json::json!("mesh.generate"),
            ),
            ("/profile/models/0/modes/0/id", serde_json::json!("")),
            ("/profile/models/0/modes/0/label", serde_json::json!(null)),
            (
                "/profile/models/0/modes/0/description",
                serde_json::json!(false),
            ),
            ("/profile/models/0/modes/0/params", serde_json::json!({})),
            (
                "/profile/models/0/modes/0/params/0/type",
                serde_json::json!("integer"),
            ),
            (
                "/profile/models/0/modes/0/params/0/options/0/label",
                serde_json::json!(""),
            ),
            (
                "/profile/models/0/modes/0/params/0/required",
                serde_json::json!("yes"),
            ),
            (
                "/profile/models/0/modes/0/params/0/group",
                serde_json::json!("expert"),
            ),
            (
                "/profile/models/0/modes/0/params/1/min",
                serde_json::json!("0"),
            ),
            (
                "/profile/models/0/modes/0/params/1/step",
                serde_json::json!(0),
            ),
            ("/profile/models/0/modes/0/slots", serde_json::json!({})),
            (
                "/profile/models/0/modes/0/slots/0/key",
                serde_json::json!("reference.image"),
            ),
            (
                "/profile/models/0/modes/0/slots/0/kind",
                serde_json::json!("model"),
            ),
            (
                "/profile/models/0/modes/0/slots/0/min",
                serde_json::json!(2),
            ),
            (
                "/profile/models/0/modes/0/slots/0/min",
                serde_json::json!(-1),
            ),
            (
                "/profile/models/0/modes/0/slots/0/max",
                serde_json::json!(1.5),
            ),
            (
                "/profile/models/0/modes/0/slots/0/max",
                serde_json::json!(-1),
            ),
        ] {
            let mut snapshot = model_snapshot();
            *snapshot.pointer_mut(pointer).unwrap() = invalid;
            assert!(
                sanitize_poll_descriptor(Some(snapshot)).is_err(),
                "{pointer}"
            );
        }
    }

    #[test]
    fn typed_v2_snapshots_reject_malformed_model_endpoint_response_and_poll_specs() {
        for (suffix, invalid) in [
            ("", serde_json::json!(null)),
            ("/method", serde_json::json!("PUT")),
            ("/path", serde_json::json!("")),
            ("/body", serde_json::json!("binary")),
            ("/body", serde_json::json!("json")),
            ("/files", serde_json::json!(null)),
            ("/files/field", serde_json::json!("")),
            ("/files/cardinality", serde_json::json!("many")),
            ("/imageEncoding", serde_json::json!("file")),
            ("/errorPath", serde_json::json!("")),
            (
                "/response",
                serde_json::json!({ "mode": "sync", "outputs": {}, "poll": {} }),
            ),
            ("/response/mode", serde_json::json!("stream")),
            ("/response/taskIdPath", serde_json::json!("")),
            ("/response/poll", serde_json::json!({})),
            ("/response/poll/method", serde_json::json!("DELETE")),
            ("/response/poll/path", serde_json::json!("")),
            ("/response/poll/intervalSec", serde_json::json!(0)),
            ("/response/poll/timeoutMin", serde_json::json!(-1)),
            ("/response/poll/statusPath", serde_json::json!(null)),
            ("/response/poll/progressPath", serde_json::json!(3)),
            ("/response/poll/success", serde_json::json!([""])),
            ("/response/poll/failure", serde_json::json!([false])),
            ("/response/poll/outputs", serde_json::json!({})),
            ("/response/poll/outputs/0/kind", serde_json::json!("text")),
            ("/response/poll/outputs/0/url", serde_json::json!("")),
            ("/response/poll/outputs/0/auth", serde_json::json!("bearer")),
            (
                "/response/poll/resultRequest/method",
                serde_json::json!("PUT"),
            ),
            ("/response/poll/resultRequest/path", serde_json::json!("")),
        ] {
            let mut snapshot = model_snapshot();
            let pointer = format!("/profile/models/0/modes/0/endpoint{suffix}");
            *snapshot.pointer_mut(&pointer).unwrap() = invalid;
            assert!(
                sanitize_poll_descriptor(Some(snapshot)).is_err(),
                "{pointer}"
            );
        }
        for output in [
            serde_json::json!({ "path": "mesh", "as": "file", "kind": "model" }),
            serde_json::json!({ "path": "mesh", "as": "url", "kind": "executable" }),
            serde_json::json!({ "url": "/mesh.glb" }),
            serde_json::json!({ "path": "mesh", "as": "url", "url": "/mesh.glb", "kind": "model" }),
        ] {
            let mut snapshot = model_snapshot();
            snapshot["profile"]["models"][0]["modes"][0]["endpoint"]["response"]["poll"]
                ["outputs"] = serde_json::json!([output]);
            assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        }
    }

    #[test]
    fn typed_v2_snapshots_reject_unknown_model_declaration_fields_at_every_level() {
        for pointer in [
            "",
            "/profile",
            "/profile/auth",
            "/profile/models/0",
            "/profile/models/0/refs",
            "/profile/models/0/params/0",
            "/profile/models/0/modes/0",
            "/profile/models/0/modes/0/params/0",
            "/profile/models/0/modes/0/params/0/options/0",
            "/profile/models/0/modes/0/slots/0",
            "/profile/models/0/modes/0/endpoint",
            "/profile/models/0/modes/0/endpoint/files",
            "/profile/models/0/modes/0/endpoint/response",
            "/profile/models/0/modes/0/endpoint/response/poll",
            "/profile/models/0/modes/0/endpoint/response/poll/resultRequest",
            "/profile/models/0/modes/0/endpoint/response/poll/outputs/0",
            "/outputs/0",
        ] {
            let mut snapshot = model_snapshot();
            snapshot
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("invented".to_string(), serde_json::json!(true));
            assert!(
                sanitize_poll_descriptor(Some(snapshot)).is_err(),
                "{pointer}"
            );
        }
        let mut snapshot = model_snapshot();
        snapshot["profile"]["operations"]["mesh.generate"] = serde_json::json!({});
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        let mut snapshot = model_snapshot();
        snapshot["importedModelIds"] = serde_json::json!(["model-job-output-0"]);
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
    }

    #[test]
    fn typed_v2_snapshots_reject_missing_endpoints_required_fields_and_duplicate_declarations() {
        for (pointer, key) in [
            ("/profile/models/0/modes/0", "endpoint"),
            ("/profile/models/0/modes/0", "operation"),
            ("/profile/models/0/modes/0/endpoint", "response"),
            ("/profile/models/0/modes/0/endpoint", "files"),
            ("/profile/models/0/modes/0/endpoint/response", "poll"),
            (
                "/profile/models/0/modes/0/endpoint/response/poll",
                "outputs",
            ),
            ("/profile/models/0/modes/0/params/0/options/0", "value"),
            ("/profile/models/0/modes/0/slots/0", "max"),
            ("/profile/models/0", "params"),
        ] {
            let mut snapshot = model_snapshot();
            snapshot
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(key)
                .unwrap();
            assert!(
                sanitize_poll_descriptor(Some(snapshot)).is_err(),
                "{pointer}/{key}"
            );
        }
        let mut snapshot = model_snapshot();
        snapshot["profile"]["models"][0]
            .as_object_mut()
            .unwrap()
            .remove("modes");
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        for pointer in [
            "/profile/models",
            "/profile/models/0/params",
            "/profile/models/0/modes",
            "/profile/models/0/modes/0/params",
            "/profile/models/0/modes/0/slots",
        ] {
            let mut snapshot = model_snapshot();
            let declarations = snapshot
                .pointer_mut(pointer)
                .unwrap()
                .as_array_mut()
                .unwrap();
            declarations.push(declarations[0].clone());
            assert!(
                sanitize_poll_descriptor(Some(snapshot)).is_err(),
                "{pointer}"
            );
        }
    }

    #[test]
    fn typed_v2_snapshots_validate_effective_model_template_declarations() {
        for variable in [
            "{{param.missing}}",
            "{{slot.missing}}",
            "{{slotFirst.missing}}",
            "{{unknown}}",
            "{{submit.task_id}}",
            "{{poll.file_id}}",
        ] {
            let mut snapshot = model_snapshot();
            snapshot["profile"]["models"][0]["modes"][0]["endpoint"]["template"] =
                serde_json::json!({ "value": variable });
            assert!(
                sanitize_poll_descriptor(Some(snapshot)).is_err(),
                "{variable}"
            );
        }
        let mut snapshot = model_snapshot();
        snapshot["profile"]["models"][0]["modes"][0]["endpoint"]["response"]["poll"]["template"] =
            serde_json::json!({ "id": "{{poll.file_id}}" });
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        let mut snapshot = model_snapshot();
        let endpoint = snapshot["profile"]["models"][0]["modes"][0]
            .as_object_mut()
            .unwrap()
            .remove("endpoint")
            .unwrap();
        snapshot["profile"]["operations"]["model.generate"] = endpoint;
        snapshot["profile"]["models"][0]["modes"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "text-to-model", "label": "Text to model", "operation": "model.generate"
            }));
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
    }

    #[test]
    fn typed_v2_snapshots_reject_malformed_saved_model_outputs_and_preserve_payload_guards() {
        for outputs in [
            serde_json::json!({ "kind": "model", "url": "https://mesh.example/model.glb" }),
            serde_json::json!([{ "kind": "executable", "url": "https://mesh.example/model.glb", "auth": false }]),
            serde_json::json!([{ "kind": "model", "text": "not a URL" }]),
            serde_json::json!([{ "kind": "model", "url": "https://mesh.example/model.glb", "auth": {} }]),
            serde_json::json!([{ "kind": "model", "url": "data:model/gltf-binary;base64,AAAA", "auth": false }]),
            serde_json::json!([{ "kind": "model", "url": "https://mesh.example/model.glb?token=private", "auth": false }]),
        ] {
            let mut snapshot = model_snapshot();
            snapshot["outputs"] = outputs;
            assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        }
        let mut snapshot = model_snapshot();
        snapshot["profile"]["models"][0]["modes"][0]["endpoint"]["template"] =
            serde_json::json!({ "image": "data:image/png;base64,AAAA" });
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
    }

    #[test]
    fn typed_v2_snapshots_preserve_templates_and_never_truncate_workflows() {
        let snapshot = template_snapshot();
        let serialized = sanitize_poll_descriptor(Some(snapshot.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&serialized).unwrap(),
            snapshot
        );
        let nodes = (0..80).map(|index| (index.to_string(), serde_json::json!({ "class_type": "SaveImage", "inputs": { "images": ["1", 0] } }))).collect::<serde_json::Map<_, _>>();
        let comfy = serde_json::json!({ "version": 2, "adapter": "comfyui", "pollIntervalMs": 1000, "pollTimeoutMs": 60000,
            "authPrefix": "", "headerNames": [], "queryNames": [],
            "input": { "jobId": "job", "channelId": "comfy", "modelId": "workflow", "operation": "image.generate", "prompt": "", "refs": [], "count": 1,
                "params": { "comfyuiSnapshot": { "workflow": nodes, "bindings": { "prompt": { "nodeId": "1", "input": "text" }, "output": { "nodeId": "2", "input": "$output" } },
                    "urls": { "base": "http://127.0.0.1:8188", "prompt": "http://127.0.0.1:8188/prompt" }, "auth": { "mode": "header", "name": "x-api-key" }, "outputNodeIds": ["2", "3"] } } } });
        let saved = sanitize_poll_descriptor(Some(comfy.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), comfy);
    }

    #[test]
    fn typed_v2_snapshots_preserve_transient_credential_ownership_and_reject_other_values() {
        let mut snapshot = template_snapshot();
        snapshot["credentialSource"] = serde_json::json!("transient");
        let saved = sanitize_poll_descriptor(Some(snapshot.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), snapshot);
        for invalid in [
            serde_json::json!("saved"),
            serde_json::json!(null),
            serde_json::json!(42),
        ] {
            snapshot["credentialSource"] = invalid;
            assert!(sanitize_poll_descriptor(Some(snapshot.clone())).is_err());
        }
    }

    #[test]
    fn typed_v2_recovery_input_rejects_ephemeral_chat_payload() {
        let mut snapshot = template_snapshot();
        snapshot["input"]["chatPayload"] =
            serde_json::json!({"messages":[{"role":"user","content":"private prompt"}]});
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
    }

    #[test]
    fn typed_v2_snapshots_accept_boolean_url_output_auth_only_at_output_shapes() {
        for auth in [false, true] {
            let mut snapshot = template_snapshot();
            snapshot["outputs"] = serde_json::json!([{ "url": "https://relay.example/videos/task/content", "kind": "video", "auth": auth }]);
            snapshot["profile"]["operations"]["image.generate"]["response"]["poll"]["outputs"] = serde_json::json!([{ "url": "/videos/{{taskId}}/content", "kind": "video", "auth": auth }]);
            let saved = sanitize_poll_descriptor(Some(snapshot.clone()))
                .unwrap()
                .unwrap();
            assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), snapshot);
        }
        let mut snapshot = template_snapshot();
        snapshot["outputs"] = serde_json::json!([{ "url": "https://relay.example/result", "kind": "image", "auth": { "value": "private" } }]);
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        let mut snapshot = template_snapshot();
        snapshot["input"]["params"]["auth"] =
            serde_json::json!({"type":"bearer","value":"private"});
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
    }

    #[test]
    fn typed_v2_snapshots_preserve_selected_mode_slots_and_full_endpoint_profile() {
        let mut snapshot = template_snapshot();
        snapshot["input"]["modeId"] = serde_json::json!("first-last");
        snapshot["input"]["operation"] = serde_json::json!("video.generate");
        snapshot["profile"]["models"][0]["modes"] = serde_json::json!([{
            "id": "first-last", "label": "First + last frame", "operation": "video.generate",
            "slots": [
                { "key": "first", "label": "First", "kind": "image", "min": 1, "max": 1 },
                { "key": "last", "label": "Last", "kind": "image", "min": 1, "max": 1 }
            ],
            "params": [{ "key": "duration", "label": "Duration", "type": "number", "default": 5 }],
            "endpoint": {
                "method": "POST", "path": "/mode-specific/videos", "body": "json",
                "template": { "first": "{{slotFirst.first}}", "last": "{{slotFirst.last}}" },
                "response": {
                    "mode": "async", "taskIdPath": "task.id",
                    "poll": {
                        "method": "GET", "path": "/mode-specific/tasks/{{taskId}}",
                        "intervalSec": 10, "timeoutMin": 30, "statusPath": "state",
                        "success": ["ready"], "failure": ["rejected"],
                        "outputs": [{ "path": "video.url", "as": "url", "kind": "video" }],
                        "resultRequest": { "method": "GET", "path": "/files/{{poll.file_id}}" }
                    }
                }
            }
        }]);
        let saved = sanitize_poll_descriptor(Some(snapshot.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), snapshot);
    }

    #[test]
    fn typed_v2_snapshots_reject_non_string_mode_and_expanded_slot_media() {
        for mode in [
            Value::Null,
            serde_json::json!(2),
            serde_json::json!({ "id": "first" }),
        ] {
            let mut snapshot = template_snapshot();
            snapshot["input"]["modeId"] = mode;
            assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        }
        let mut snapshot = template_snapshot();
        snapshot["input"]["refs"] = serde_json::json!([{
            "slot": "first", "kind": "image", "path": "https://media.example/private.png",
            "assetId": "private", "mime": "image/png"
        }]);
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
    }

    #[test]
    fn typed_v2_snapshots_accept_safe_result_kinds_and_structured_failure() {
        let mut snapshot = template_snapshot();
        snapshot["assetKinds"] = serde_json::json!(["image", "video", "audio", "model", "text"]);
        snapshot["failure"] = serde_json::json!({
            "category": "upstream", "message": "Upstream request failed",
            "raw": "{\n  \"error\": \"Unsupported duration\"\n}", "status": 422
        });
        let saved = sanitize_poll_descriptor(Some(snapshot.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), snapshot);
    }

    #[test]
    fn typed_v2_snapshot_failures_preserve_redacted_credential_labels_only() {
        for raw in [
            "Bearer [redacted]",
            "api_key=[redacted]",
            "authorization=[redacted]",
            "Authorization: Bearer [redacted]",
            "{\"token\":\"[redacted]\"}",
            "https://relay.example/tasks?api_key=[redacted]&page=2",
        ] {
            let mut snapshot = template_snapshot();
            snapshot["failure"] = serde_json::json!({
                "category": "auth", "message": "Authentication failed", "raw": raw, "status": 401
            });
            let saved = sanitize_poll_descriptor(Some(snapshot.clone()))
                .unwrap()
                .unwrap();
            assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), snapshot);
        }
        for raw in [
            "Bearer private-key",
            "api_key=private-key",
            "authorization=private-key",
            "Authorization: Bearer private-key",
            "{\"token\":\"private-key\"}",
            "Bearer [redacted]private-key",
            "api_key=[redacted]private-key",
        ] {
            let mut snapshot = template_snapshot();
            snapshot["failure"] = serde_json::json!({
                "category": "auth", "message": "Authentication failed", "raw": raw, "status": 401
            });
            assert!(sanitize_poll_descriptor(Some(snapshot)).is_err(), "{raw}");
        }
    }

    #[test]
    fn typed_v2_snapshots_reject_unsafe_result_kinds_and_failure_fields() {
        for kinds in [
            serde_json::json!("video"),
            serde_json::json!(["executable"]),
            serde_json::json!([null]),
        ] {
            let mut snapshot = template_snapshot();
            snapshot["assetKinds"] = kinds;
            assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        }
        for failure in [
            serde_json::json!({ "category": "upstream", "message": "failed", "body": {} }),
            serde_json::json!({ "category": "upstream", "message": 5 }),
            serde_json::json!({ "category": "upstream", "message": "failed", "raw": {} }),
            serde_json::json!({ "category": "upstream", "message": "failed", "status": "422" }),
            serde_json::json!({ "category": "upstream", "message": "failed", "status": 99 }),
            serde_json::json!({ "category": "upstream", "message": "failed", "status": 600 }),
            serde_json::json!({ "category": "upstream", "message": "failed", "raw": "Bearer private-key" }),
            serde_json::json!({ "category": "upstream", "message": "failed", "raw": "data:image/png;base64,AAAA" }),
            serde_json::json!({ "category": "invalid category", "message": "failed" }),
            serde_json::json!({ "category": "upstream", "message": "x".repeat(2001) }),
            serde_json::json!({ "category": "upstream", "message": "failed", "raw": "x".repeat(2001) }),
        ] {
            let mut snapshot = template_snapshot();
            snapshot["failure"] = failure;
            assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        }
    }

    #[test]
    fn typed_v2_snapshots_allow_data_scheme_documentation_but_reject_data_urls() {
        let mut snapshot = template_snapshot();
        snapshot["profile"]["notes"] = serde_json::json!([
            "仅发送原始 base64，不包含 data: MIME 前缀",
            "The data: scheme is documented here, not a submitted image."
        ]);
        let saved = sanitize_poll_descriptor(Some(snapshot.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), snapshot);
        for media in [
            "data:image/png;base64,AAAA",
            "DATA:video/mp4;base64,AAAA",
            "inline (data:audio/wav;base64,AAAA)",
            "data:,private",
            "data:text/plain,private",
            "data:image/png ;base64,AAAA",
            "data: image/png;base64,AAAA",
            "data:; charset=utf-8;base64,AAAA",
            "data:text/plain;\ncharset=utf-8,private",
        ] {
            let mut snapshot = template_snapshot();
            snapshot["profile"]["notes"] = serde_json::json!([media]);
            assert!(sanitize_poll_descriptor(Some(snapshot)).is_err(), "{media}");
        }
    }

    #[test]
    fn typed_v2_snapshots_reject_expanded_inputs_credentials_media_and_overflow() {
        let mut snapshot = template_snapshot();
        snapshot["input"]["prompt"] = Value::String("expanded user prompt".into());
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        let mut snapshot = template_snapshot();
        snapshot["profile"]["auth"]["value"] = Value::String("private".into());
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        let mut snapshot = template_snapshot();
        snapshot["submit"]["token"] = Value::String("private".into());
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        let mut snapshot = template_snapshot();
        snapshot["input"]["params"]["image"] = Value::String("data:image/png;base64,AAAA".into());
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        let mut snapshot = template_snapshot();
        snapshot["assets"] = serde_json::json!(vec!["local"; 4097]);
        assert!(sanitize_poll_descriptor(Some(snapshot)).is_err());
        assert!(sanitize_poll_descriptor(Some(
            serde_json::json!({"taskId":"legacy-task","pollEndpointPath":"/tasks/{taskId}"})
        ))
        .is_ok());
    }

    #[test]
    fn status_machine_refuses_duplicate_or_terminal_submission() {
        assert!(validate_status_transition(Some("queued"), "submitting", 0).is_ok());
        assert!(validate_status_transition(Some("submitting"), "unknown", 1).is_ok());
        assert!(validate_status_transition(Some("unknown"), "submitting", 1).is_err());
        assert!(validate_status_transition(Some("succeeded"), "running", 1).is_err());
        assert!(validate_status_transition(Some("running"), "running", 2).is_err());
    }

    #[test]
    fn unknown_jobs_only_enter_safe_recovery_states() {
        assert!(validate_status_transition(Some("unknown"), "running", 1).is_ok());
        assert!(validate_status_transition(Some("unknown"), "recoverable_wait", 1).is_ok());
        assert!(validate_status_transition(Some("unknown"), "failed", 1).is_err());
    }

    #[test]
    fn schema_migration_adds_coordinator_columns() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(
            "CREATE TABLE ai_generation_jobs (\
             job_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, status TEXT NOT NULL,\
             resumable INTEGER NOT NULL DEFAULT 0, external_task_id TEXT,\
             external_task_meta_json TEXT, result TEXT, error TEXT,\
             error_category TEXT, config_fingerprint TEXT, poll_descriptor_json TEXT,\
             created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);\
             INSERT INTO ai_generation_jobs (\
               job_id, provider_id, status, resumable, external_task_meta_json,\
               error, error_category, config_fingerprint, poll_descriptor_json, created_at, updated_at\
             ) VALUES (\
               'legacy-sensitive', 'custom', 'running', 1,\
               '{\"taskId\":\"task-safe\",\"token\":\"secret-token\"}',\
               'Authorization: Bearer secret api_key=secret data:image/png;base64,AAAA',\
               'api_key=secret', 'api_key=secret', NULL, 1, 1\
             );",
        )
        .expect("create legacy schema");
        ensure_generation_jobs_table(&conn).expect("migrate generation schema");

        let mut statement = conn
            .prepare("PRAGMA table_info(ai_generation_jobs)")
            .expect("prepare table info");
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query columns")
            .collect::<Result<HashSet<_>, _>>()
            .expect("collect columns");
        for column in [
            "media_type",
            "config_fingerprint",
            "phase",
            "poll_descriptor_json",
            "network_route",
            "submit_attempts",
            "consecutive_network_errors",
        ] {
            assert!(columns.contains(column), "missing migrated column {column}");
        }

        let (error, error_category, fingerprint, descriptor, legacy_descriptor, scrubbed) = conn
            .query_row(
                "SELECT error, error_category, config_fingerprint, poll_descriptor_json, \
                 external_task_meta_json, sensitive_fields_scrubbed \
                 FROM ai_generation_jobs WHERE job_id = 'legacy-sensitive'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .expect("read scrubbed legacy row");
        let persisted = format!(
            "{error:?}{error_category:?}{fingerprint:?}{descriptor:?}{legacy_descriptor:?}"
        );
        assert!(!persisted.contains("secret"));
        assert!(!persisted.contains("data:image"));
        assert!(error
            .as_deref()
            .is_some_and(|value| value.contains("[credential omitted]")));
        assert!(error_category.is_none());
        assert!(fingerprint.is_none());
        assert!(descriptor.is_none());
        assert!(legacy_descriptor.is_none());
        assert_eq!(scrubbed, 1);
    }

    #[test]
    fn existing_generation_jobs_cannot_silently_switch_network_routes() {
        assert_eq!(
            validate_immutable_network_route("system", None).expect("keep current route"),
            "system"
        );
        assert_eq!(
            validate_immutable_network_route("direct", Some("direct"))
                .expect("same route remains valid"),
            "direct"
        );
        assert!(validate_immutable_network_route("system", Some("direct")).is_err());
        assert!(validate_immutable_network_route("system", Some("invalid")).is_err());
    }

    #[test]
    fn active_and_success_states_clear_stale_persisted_errors() {
        for status in ["running", "materializing", "succeeded"] {
            assert!(status_clears_persisted_error(status), "status={status}");
        }
        for status in [
            "queued",
            "submitting",
            "recoverable_wait",
            "unknown",
            "failed",
        ] {
            assert!(!status_clears_persisted_error(status), "status={status}");
        }
        assert_eq!(
            sanitize_error_category(Some("submission-unknown")).as_deref(),
            Some("submission-unknown")
        );
        assert!(sanitize_error_category(Some("api_key=secret")).is_none());
    }

    #[test]
    fn poll_descriptor_rejects_credentials_and_payloads() {
        assert!(sanitize_poll_descriptor(Some(serde_json::json!({
            "method": "GET",
            "taskId": "task-123",
            "pathTemplate": "/jobs/{taskId}"
        })))
        .is_ok());
        assert!(sanitize_poll_descriptor(Some(serde_json::json!({
            "Authorization": "Bearer secret"
        })))
        .is_err());
        assert!(sanitize_poll_descriptor(Some(serde_json::json!({
            "requestBody": { "prompt": "secret prompt" }
        })))
        .is_err());
        assert!(sanitize_poll_descriptor(Some(serde_json::json!({
            "pathTemplate": "/jobs?id=1&token=secret"
        })))
        .is_err());
        assert!(!is_persistable_result_source(
            "data:image/png;base64,abc",
            false
        ));
        assert!(!is_persistable_result_source(
            "blob:https://app/result",
            false
        ));
        assert!(is_persistable_result_source(
            "https://cdn.example.com/result.png",
            true
        ));
    }

    #[test]
    fn persisted_diagnostics_and_identifiers_drop_secrets_and_payloads() {
        let diagnostic = sanitize_diagnostic_text(
            "Authorization: Bearer sk-live-secret api_key=top-secret data:image/png;base64,AAAA",
        );
        assert!(!diagnostic.contains("sk-live-secret"));
        assert!(!diagnostic.contains("top-secret"));
        assert!(!diagnostic.contains("data:image"));
        assert!(diagnostic.contains("[credential omitted]"));
        assert!(diagnostic.contains("[payload omitted]"));

        assert_eq!(
            sanitize_config_fingerprint(Some("fnv1a-0123abcd")).as_deref(),
            Some("fnv1a-0123abcd")
        );
        assert!(sanitize_config_fingerprint(Some("Bearer secret")).is_none());
        assert_eq!(
            sanitize_external_task_id(Some("task_123-abc")).as_deref(),
            Some("task_123-abc")
        );
        assert!(sanitize_external_task_id(Some("data:text/plain,secret")).is_none());
    }

    #[test]
    fn builtin_poll_metadata_persists_validated_refs_not_keys() {
        let reference = SecretRef {
            namespace: "provider".into(),
            id: "fal".into(),
        };
        let token = reference.token().unwrap();
        let descriptor = serde_json::json!({
            "credential_ref": reference,
            "status_url": format!("https://queue.example.test/status?api_key={token}"),
        });
        let serialized = sanitize_poll_descriptor(Some(descriptor.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&serialized).unwrap(),
            descriptor
        );
        let long_reference = SecretRef {
            namespace: "provider".into(),
            id: "f".repeat(512),
        };
        let long_token = long_reference.token().unwrap();
        assert!(sanitize_poll_descriptor(Some(serde_json::json!({
            "credential_ref": long_reference,
            "status_url": format!("https://queue.example.test/status?api_key={long_token}")
        })))
        .is_ok());
        assert!(sanitize_poll_descriptor(Some(serde_json::json!({
            "credential_ref": { "namespace": "unknown", "id": "fal" }
        })))
        .is_err());
        assert!(sanitize_poll_descriptor(Some(serde_json::json!({
            "status_url": "https://queue.example.test/status?api_key=plaintext"
        })))
        .is_err());
    }
}

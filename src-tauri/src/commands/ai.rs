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

use crate::ai::error::AIError;
use crate::ai::providers::build_default_providers;
use crate::ai::{
    GenerateRequest, ProviderRegistry, ProviderTaskHandle, ProviderTaskPollResult,
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
             COALESCE(poll_descriptor_json, external_task_meta_json) \
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
            ))
        })
        .map_err(|e| format!("Failed to query generation jobs for scrub: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read generation jobs for scrub: {e}"))?;
    drop(scrub_statement);
    for (job_id, error, error_category, config_fingerprint, raw_descriptor) in scrub_rows {
        let safe_error = sanitize_optional_diagnostic(error.as_deref());
        let safe_error_category = sanitize_error_category(error_category.as_deref());
        let safe_config_fingerprint = sanitize_config_fingerprint(config_fingerprint.as_deref());
        let safe_descriptor = raw_descriptor
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        let safe_descriptor = sanitize_poll_descriptor(safe_descriptor).unwrap_or(None);
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
    let config_fingerprint = sanitize_config_fingerprint(config_fingerprint);
    let external_task_id = sanitize_external_task_id(external_task_id);
    let poll_descriptor_json =
        poll_descriptor_json.and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let poll_descriptor_json = sanitize_poll_descriptor(poll_descriptor_json)?;
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
            poll_descriptor_json: row
                .get::<_, Option<String>>(9)?
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .and_then(|value| sanitize_poll_descriptor(Some(value)).ok().flatten()),
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
        Ok(record) => Ok(Some(record)),
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
    }
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

fn sanitize_poll_descriptor(value: Option<Value>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    fn sanitize(value: &Value, depth: usize) -> Result<Value, String> {
        if depth > 4 {
            return Err("poll descriptor is too deeply nested".to_string());
        }
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => Ok(value.clone()),
            Value::String(text) => {
                if text.len() > 512 {
                    return Err("poll descriptor string is too long".to_string());
                }
                let lowered = text.to_ascii_lowercase();
                if lowered.starts_with("data:")
                    || lowered.starts_with("blob:")
                    || lowered.contains("bearer ")
                    || lowered.contains("authorization=")
                    || lowered.contains("api_key=")
                    || lowered.contains("apikey=")
                    || lowered.contains("token=")
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
    let poll_descriptor_json = sanitize_poll_descriptor(request.poll_descriptor)?;
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
    validate_status_transition(Some(current.status.as_str()), status, attempts)?;
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
    let descriptor = sanitize_poll_descriptor(request.poll_descriptor)?;
    let external_task_id = sanitize_external_task_id(request.external_task_id.as_deref());
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
        .map(|record| dto_from_record(&record))
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
    request: GenerateRequestDto,
) -> Result<String, String> {
    info!("Submitting generation job with model: {}", request.model);

    let registry = get_registry();
    let provider = registry
        .resolve_provider_for_model(&request.model)
        .or_else(|| registry.get_default_provider())
        .cloned()
        .ok_or_else(|| "Provider not found".to_string())?;

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
                let meta_json = handle
                    .metadata
                    .as_ref()
                    .and_then(|value| serde_json::to_string(value).ok());
                insert_generation_job(
                    &app,
                    job_id.as_str(),
                    provider_id.as_str(),
                    "running",
                    true,
                    Some(handle.task_id.as_str()),
                    meta_json.as_deref(),
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
pub async fn generate_image(request: GenerateRequestDto) -> Result<String, String> {
    info!("Generating image with model: {}", request.model);

    let registry = get_registry();
    let provider = registry
        .resolve_provider_for_model(&request.model)
        .or_else(|| registry.get_default_provider())
        .ok_or_else(|| "Provider not found".to_string())?;

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
mod tests {
    use super::*;

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
}

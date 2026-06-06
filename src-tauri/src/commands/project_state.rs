use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummaryRecord {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub node_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub node_count: i64,
    pub nodes_json: String,
    pub edges_json: String,
    pub viewport_json: String,
    pub history_json: String,
    pub image_pool_json: Option<String>,
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

fn ensure_projects_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          node_count INTEGER NOT NULL DEFAULT 0,
          nodes_json TEXT NOT NULL,
          edges_json TEXT NOT NULL,
          viewport_json TEXT NOT NULL,
          history_json TEXT NOT NULL,
          image_pool_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);
        CREATE TABLE IF NOT EXISTS project_image_refs (
          project_id TEXT NOT NULL,
          path TEXT NOT NULL,
          PRIMARY KEY(project_id, path)
        );
        CREATE INDEX IF NOT EXISTS idx_project_image_refs_path ON project_image_refs(path);
        "#,
    )
    .map_err(|e| format!("Failed to initialize projects table: {}", e))?;

    let mut has_node_count = false;
    let mut has_image_pool_json = false;
    let mut stmt = conn
        .prepare("PRAGMA table_info(projects)")
        .map_err(|e| format!("Failed to inspect projects schema: {}", e))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to inspect projects columns: {}", e))?;

    for name_result in rows {
        let column_name =
            name_result.map_err(|e| format!("Failed to read projects column name: {}", e))?;
        match column_name.as_str() {
            "node_count" => has_node_count = true,
            "image_pool_json" => has_image_pool_json = true,
            _ => {}
        }
    }

    if !has_node_count {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN node_count INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("Failed to add node_count column: {}", e))?;
    }

    if !has_image_pool_json {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN image_pool_json TEXT NOT NULL DEFAULT '[]'",
            [],
        )
        .map_err(|e| format!("Failed to add image_pool_json column: {}", e))?;
    }

    Ok(())
}

fn parse_image_pool_from_json(image_pool_json: &str) -> Vec<String> {
    let parsed: serde_json::Value = match serde_json::from_str(image_pool_json) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    parsed
        .as_array()
        .map(|array| {
            array
                .iter()
                .filter_map(|value| value.as_str().map(|item| item.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_image_pool_from_history(history_json: &str) -> Vec<String> {
    let parsed: serde_json::Value = match serde_json::from_str(history_json) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    parsed
        .get("imagePool")
        .and_then(|value| value.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|value| value.as_str().map(|item| item.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_image_pool(history_json: &str, image_pool_json: Option<&str>) -> Vec<String> {
    let top_level_pool = image_pool_json
        .map(parse_image_pool_from_json)
        .unwrap_or_default();
    if !top_level_pool.is_empty() {
        return top_level_pool;
    }

    parse_image_pool_from_history(history_json)
}

fn resolve_image_ref(value: &str, image_pool: &[String]) -> Option<String> {
    const IMAGE_REF_PREFIX: &str = "__img_ref__:";

    if let Some(index_text) = value.strip_prefix(IMAGE_REF_PREFIX) {
        let index = index_text.parse::<usize>().ok()?;
        return image_pool.get(index).cloned();
    }

    if value.trim().is_empty() {
        return None;
    }

    Some(value.to_string())
}

fn value_looks_like_image_reference_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.ends_with("imageurl")
        || lower.ends_with("image")
        || lower.ends_with("thumbnailurl")
        || lower.ends_with("snapshoturl")
        || lower.ends_with("coverurl")
        || lower.ends_with("url")
            && (lower.contains("image")
                || lower.contains("thumbnail")
                || lower.contains("snapshot")
                || lower.contains("cover")
                || lower.contains("panorama"))
}

fn insert_image_ref_value(
    value: &serde_json::Value,
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    if let Some(raw_value) = value.as_str() {
        if let Some(path) = resolve_image_ref(raw_value, image_pool) {
            paths.insert(path);
        }
    }
}

fn insert_image_ref_from_object(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    if let Some(value) = object.get(key) {
        insert_image_ref_value(value, image_pool, paths);
    }
}

fn collect_string_image_refs_under(
    value: &serde_json::Value,
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    match value {
        serde_json::Value::String(_) => insert_image_ref_value(value, image_pool, paths),
        serde_json::Value::Array(array) => {
            for child in array {
                collect_string_image_refs_under(child, image_pool, paths);
            }
        }
        serde_json::Value::Object(object) => {
            for child in object.values() {
                collect_string_image_refs_under(child, image_pool, paths);
            }
        }
        _ => {}
    }
}

fn collect_nested_image_reference_paths(
    value: &serde_json::Value,
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                if value_looks_like_image_reference_key(key) {
                    collect_string_image_refs_under(child, image_pool, paths);
                }
                collect_nested_image_reference_paths(child, image_pool, paths);
            }
        }
        serde_json::Value::Array(array) => {
            for child in array {
                collect_nested_image_reference_paths(child, image_pool, paths);
            }
        }
        _ => {}
    }
}

fn collect_blueprint_item_image_paths(
    items: Option<&Vec<serde_json::Value>>,
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    let Some(items) = items else {
        return;
    };

    for item in items {
        let item_obj = match item.as_object() {
            Some(value) => value,
            None => continue,
        };
        insert_image_ref_from_object(item_obj, "refImageUrl", image_pool, paths);
    }
}

fn collect_blueprint_reference_image_paths(
    refs: Option<&Vec<serde_json::Value>>,
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    let Some(refs) = refs else {
        return;
    };

    for image in refs {
        let img_obj = match image.as_object() {
            Some(value) => value,
            None => continue,
        };
        insert_image_ref_from_object(img_obj, "url", image_pool, paths);
    }
}

fn collect_image_paths_from_array(
    values: Option<&Vec<serde_json::Value>>,
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    let Some(values) = values else {
        return;
    };

    for value in values {
        insert_image_ref_value(value, image_pool, paths);
    }
}

fn collect_director_snapshot_image_paths(
    snapshot: Option<&serde_json::Map<String, serde_json::Value>>,
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    let Some(snapshot) = snapshot else {
        return;
    };

    for key in ["snapshotUrl", "backgroundImageUrl", "backgroundPanoramaUrl"] {
        insert_image_ref_from_object(snapshot, key, image_pool, paths);
    }
    collect_image_paths_from_array(
        snapshot
            .get("snapshotHistory")
            .and_then(|value| value.as_array()),
        image_pool,
        paths,
    );
    collect_blueprint_item_image_paths(
        snapshot.get("items").and_then(|value| value.as_array()),
        image_pool,
        paths,
    );
    collect_blueprint_reference_image_paths(
        snapshot
            .get("referenceImages")
            .and_then(|value| value.as_array()),
        image_pool,
        paths,
    );
}

fn collect_image_paths_from_nodes(
    nodes: &[serde_json::Value],
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    for node in nodes {
        let data = match node.get("data").and_then(|value| value.as_object()) {
            Some(value) => value,
            None => continue,
        };

        if let Some(data_value) = node.get("data") {
            collect_nested_image_reference_paths(data_value, image_pool, paths);
        }

        for key in [
            "imageUrl",
            "previewImageUrl",
            "thumbnailUrl",
            "sourceImageUrl",
            "snapshotUrl",
            "backgroundImageUrl",
            "backgroundPanoramaUrl",
        ] {
            if let Some(raw_value) = data.get(key).and_then(|value| value.as_str()) {
                if let Some(path) = resolve_image_ref(raw_value, image_pool) {
                    paths.insert(path);
                }
            }
        }

        if let Some(frames) = data.get("frames").and_then(|value| value.as_array()) {
            for frame in frames {
                let frame_obj = match frame.as_object() {
                    Some(value) => value,
                    None => continue,
                };
                for key in ["imageUrl", "previewImageUrl"] {
                    insert_image_ref_from_object(frame_obj, key, image_pool, paths);
                }
            }
        }

        // Director Studio / blueprint node specifics are image-ref encoded
        // too, so they need to register against `project_image_refs` for
        // cleanup.
        collect_blueprint_item_image_paths(
            data.get("items").and_then(|value| value.as_array()),
            image_pool,
            paths,
        );
        collect_blueprint_reference_image_paths(
            data.get("referenceImages")
                .and_then(|value| value.as_array()),
            image_pool,
            paths,
        );
        collect_image_paths_from_array(
            data.get("snapshotHistory")
                .and_then(|value| value.as_array()),
            image_pool,
            paths,
        );
        if let Some(projects) = data
            .get("directorStudioProjects")
            .and_then(|value| value.as_array())
        {
            for project in projects {
                let project_obj = match project.as_object() {
                    Some(value) => value,
                    None => continue,
                };
                insert_image_ref_from_object(project_obj, "coverUrl", image_pool, paths);
                collect_director_snapshot_image_paths(
                    project_obj
                        .get("snapshot")
                        .and_then(|value| value.as_object()),
                    image_pool,
                    paths,
                );
            }
        }
    }
}

fn extract_project_image_paths(
    nodes_json: &str,
    history_json: &str,
    image_pool_json: Option<&str>,
) -> HashSet<String> {
    let image_pool = parse_image_pool(history_json, image_pool_json);
    let mut paths = HashSet::new();

    if let Ok(parsed_nodes) = serde_json::from_str::<serde_json::Value>(nodes_json) {
        if let Some(nodes) = parsed_nodes.as_array() {
            collect_image_paths_from_nodes(nodes, &image_pool, &mut paths);
        }
    }

    if let Ok(parsed_history) = serde_json::from_str::<serde_json::Value>(history_json) {
        for timeline_key in ["past", "future"] {
            let Some(timeline) = parsed_history
                .get(timeline_key)
                .and_then(|value| value.as_array())
            else {
                continue;
            };

            for snapshot in timeline {
                let Some(nodes) = snapshot.get("nodes").and_then(|value| value.as_array()) else {
                    continue;
                };
                collect_image_paths_from_nodes(nodes, &image_pool, &mut paths);
            }
        }
    }

    paths
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

fn decode_path_like(value: &str) -> String {
    let trimmed = value.trim();
    let raw = trimmed.strip_prefix("file://").unwrap_or(trimmed);
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

fn normalize_path_for_compare(value: &str) -> Option<String> {
    let decoded = decode_path_like(value);
    let normalized = decoded.replace('\\', "/");
    let trimmed = normalized.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("data:")
        || trimmed.starts_with("blob:")
        || trimmed.starts_with("asset:")
        || trimmed.starts_with("tauri:")
    {
        return None;
    }

    Some(if cfg!(target_os = "windows") {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_string()
    })
}

fn file_name_for_compare(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| {
            if cfg!(target_os = "windows") {
                value.to_ascii_lowercase()
            } else {
                value.to_string()
            }
        })
}

struct ReferencedImageIndex {
    paths: HashSet<String>,
    file_names: HashSet<String>,
}

impl ReferencedImageIndex {
    fn from_raw_paths(raw_paths: HashSet<String>) -> Self {
        let mut paths = HashSet::new();
        let mut file_names = HashSet::new();

        for raw_path in raw_paths {
            if let Some(normalized) = normalize_path_for_compare(&raw_path) {
                paths.insert(normalized.clone());
                if let Some(file_name) = Path::new(&normalized)
                    .file_name()
                    .and_then(|value| value.to_str())
                {
                    file_names.insert(if cfg!(target_os = "windows") {
                        file_name.to_ascii_lowercase()
                    } else {
                        file_name.to_string()
                    });
                }
            }

            let decoded = decode_path_like(&raw_path);
            let path = PathBuf::from(decoded);
            if let Ok(canonical) = std::fs::canonicalize(&path) {
                if let Some(normalized) = normalize_path_for_compare(&canonical.to_string_lossy()) {
                    paths.insert(normalized);
                }
                if let Some(file_name) = file_name_for_compare(&canonical) {
                    file_names.insert(file_name);
                }
            }
        }

        Self { paths, file_names }
    }

    fn is_empty(&self) -> bool {
        self.paths.is_empty() && self.file_names.is_empty()
    }

    fn contains_file(&self, path: &Path) -> bool {
        if let Some(path_string) = path.to_str() {
            if let Some(normalized) = normalize_path_for_compare(path_string) {
                if self.paths.contains(&normalized) {
                    return true;
                }
            }
        }

        if let Ok(canonical) = std::fs::canonicalize(path) {
            if let Some(normalized) = normalize_path_for_compare(&canonical.to_string_lossy()) {
                if self.paths.contains(&normalized) {
                    return true;
                }
            }
        }

        file_name_for_compare(path)
            .map(|file_name| self.file_names.contains(&file_name))
            .unwrap_or(false)
    }
}

fn is_content_hash_image_path(path: &Path) -> bool {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(|stem| stem.len() == 32 && stem.chars().all(|ch| ch.is_ascii_hexdigit()))
        .unwrap_or(false)
}

fn file_is_older_than(path: &Path, min_age: Duration) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(modified_at) = metadata.modified() else {
        return false;
    };
    SystemTime::now()
        .duration_since(modified_at)
        .map(|age| age >= min_age)
        .unwrap_or(false)
}

fn prune_unreferenced_images(app: &AppHandle, conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT path FROM project_image_refs")
        .map_err(|e| format!("Failed to prepare image refs query: {}", e))?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query image refs: {}", e))?;

    let mut referenced = HashSet::new();
    for path_result in rows {
        let path = path_result.map_err(|e| format!("Failed to decode image ref row: {}", e))?;
        referenced.insert(path);
    }
    let referenced = ReferencedImageIndex::from_raw_paths(referenced);
    if referenced.is_empty() {
        return Ok(());
    }

    let images_dir = resolve_images_dir(app)?;
    let entries =
        std::fs::read_dir(&images_dir).map_err(|e| format!("Failed to read images dir: {}", e))?;

    for entry_result in entries {
        let entry = entry_result.map_err(|e| format!("Failed to iterate images dir: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        if !referenced.contains_file(&path)
            && is_content_hash_image_path(&path)
            && file_is_older_than(&path, Duration::from_secs(24 * 60 * 60))
        {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete unreferenced image: {}", e))?;
        }
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

    ensure_projects_table(&conn)?;
    Ok(conn)
}

/// Single SQLite connection shared across all project_state commands so that
/// dispatched-in-parallel JS calls (e.g. closeProject's fire-and-forget upsert
/// followed immediately by openProject's getProjectRecord on a different
/// thread) cannot race past each other.
///
/// Without this serialization, each `#[tauri::command]` function opened its
/// own `Connection`. Tauri runs sync commands via `spawn_blocking` on a
/// thread pool — order of dispatch ≠ order of execution. WAL mode does
/// NOT save us here: a reader's snapshot is taken at the moment its
/// transaction begins, so if the reader's snapshot is taken BEFORE the
/// writer commits, the reader returns the pre-write state. That's exactly
/// the symptom users report ("I edit blueprint, exit, reopen, items gone")
/// — closeProject's upsert is in flight on thread A while openProject's
/// read is dispatched on thread B and snapshots before A's commit.
///
/// Holding a Mutex across the whole command body is sufficient: every
/// `with_db` call executes serially, so the reader's snapshot is always
/// taken AFTER the previous writer's commit.
pub struct ProjectDb(Mutex<Option<Connection>>);

impl ProjectDb {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

impl Default for ProjectDb {
    fn default() -> Self {
        Self::new()
    }
}

fn with_db<F, R>(app: &AppHandle, db: &State<ProjectDb>, f: F) -> Result<R, String>
where
    F: FnOnce(&mut Connection) -> Result<R, String>,
{
    let mut slot =
        db.0.lock()
            .map_err(|err| format!("project DB mutex poisoned: {}", err))?;
    if slot.is_none() {
        *slot = Some(open_db(app)?);
    }
    let conn = slot
        .as_mut()
        .expect("project DB connection just initialized");
    f(conn)
}

#[tauri::command]
pub fn list_project_summaries(
    app: AppHandle,
    db: State<ProjectDb>,
) -> Result<Vec<ProjectSummaryRecord>, String> {
    with_db(&app, &db, |conn| {
        let mut stmt = conn
            .prepare(
                r#"
                SELECT
                  id,
                  name,
                  created_at,
                  updated_at,
                  node_count
                FROM projects
                ORDER BY updated_at DESC
                "#,
            )
            .map_err(|e| format!("Failed to prepare list summaries query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(ProjectSummaryRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    node_count: row.get(4)?,
                })
            })
            .map_err(|e| format!("Failed to query project summaries: {}", e))?;

        let mut projects = Vec::new();
        for row in rows {
            projects.push(row.map_err(|e| format!("Failed to decode summary row: {}", e))?);
        }
        Ok(projects)
    })
}

#[tauri::command]
pub fn get_project_record(
    app: AppHandle,
    db: State<ProjectDb>,
    project_id: String,
) -> Result<Option<ProjectRecord>, String> {
    with_db(&app, &db, |conn| {
        let mut stmt = conn
            .prepare(
                r#"
                SELECT
                  id,
                  name,
                  created_at,
                  updated_at,
                  node_count,
                  nodes_json,
                  edges_json,
                  viewport_json,
                  history_json,
                  image_pool_json
                FROM projects
                WHERE id = ?1
                LIMIT 1
                "#,
            )
            .map_err(|e| format!("Failed to prepare get project query: {}", e))?;

        let result = stmt.query_row(params![project_id], |row| {
            Ok(ProjectRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                node_count: row.get(4)?,
                nodes_json: row.get(5)?,
                edges_json: row.get(6)?,
                viewport_json: row.get(7)?,
                history_json: row.get(8)?,
                image_pool_json: row.get(9)?,
            })
        });

        match result {
            Ok(record) => Ok(Some(record)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(format!("Failed to load project: {}", error)),
        }
    })
}

#[tauri::command]
pub fn upsert_project_record(
    app: AppHandle,
    db: State<ProjectDb>,
    record: ProjectRecord,
) -> Result<(), String> {
    let image_pool_json = record.image_pool_json.clone().unwrap_or_else(|| {
        serde_json::to_string(&parse_image_pool_from_history(&record.history_json))
            .unwrap_or_else(|_| "[]".to_string())
    });
    let image_paths = extract_project_image_paths(
        &record.nodes_json,
        &record.history_json,
        Some(&image_pool_json),
    );
    with_db(&app, &db, |conn| {
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to begin transaction: {}", e))?;

        tx.execute(
            r#"
            INSERT INTO projects (
              id,
              name,
              created_at,
              updated_at,
              node_count,
              nodes_json,
              edges_json,
              viewport_json,
              history_json,
              image_pool_json
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at,
              node_count = excluded.node_count,
              nodes_json = excluded.nodes_json,
              edges_json = excluded.edges_json,
              viewport_json = excluded.viewport_json,
              history_json = excluded.history_json,
              image_pool_json = excluded.image_pool_json
            "#,
            params![
                record.id,
                record.name,
                record.created_at,
                record.updated_at,
                record.node_count,
                record.nodes_json,
                record.edges_json,
                record.viewport_json,
                record.history_json,
                image_pool_json,
            ],
        )
        .map_err(|e| format!("Failed to upsert project: {}", e))?;

        tx.execute(
            "DELETE FROM project_image_refs WHERE project_id = ?1",
            params![record.id],
        )
        .map_err(|e| format!("Failed to clear project image refs: {}", e))?;

        for path in &image_paths {
            tx.execute(
                "INSERT OR IGNORE INTO project_image_refs (project_id, path) VALUES (?1, ?2)",
                params![record.id, path],
            )
            .map_err(|e| format!("Failed to upsert project image ref: {}", e))?;
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit upsert transaction: {}", e))?;

        prune_unreferenced_images(&app, conn)?;
        Ok(())
    })
}

#[tauri::command]
pub fn update_project_viewport_record(
    app: AppHandle,
    db: State<ProjectDb>,
    project_id: String,
    viewport_json: String,
) -> Result<(), String> {
    with_db(&app, &db, |conn| {
        conn.execute(
            "UPDATE projects SET viewport_json = ?1 WHERE id = ?2",
            params![viewport_json, project_id],
        )
        .map_err(|e| format!("Failed to update project viewport: {}", e))?;
        Ok(())
    })
}

#[tauri::command]
pub fn rename_project_record(
    app: AppHandle,
    db: State<ProjectDb>,
    project_id: String,
    name: String,
    updated_at: i64,
) -> Result<(), String> {
    with_db(&app, &db, |conn| {
        conn.execute(
            "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, updated_at, project_id],
        )
        .map_err(|e| format!("Failed to rename project: {}", e))?;
        Ok(())
    })
}

#[tauri::command]
pub fn delete_project_record(
    app: AppHandle,
    db: State<ProjectDb>,
    project_id: String,
) -> Result<(), String> {
    with_db(&app, &db, |conn| {
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to begin delete transaction: {}", e))?;

        tx.execute("DELETE FROM projects WHERE id = ?1", params![project_id])
            .map_err(|e| format!("Failed to delete project: {}", e))?;
        tx.execute(
            "DELETE FROM project_image_refs WHERE project_id = ?1",
            params![project_id],
        )
        .map_err(|e| format!("Failed to delete project image refs: {}", e))?;

        tx.commit()
            .map_err(|e| format!("Failed to commit delete transaction: {}", e))?;

        prune_unreferenced_images(&app, conn)?;
        Ok(())
    })
}

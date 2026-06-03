use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

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
          history_json TEXT NOT NULL
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
    let mut stmt = conn
        .prepare("PRAGMA table_info(projects)")
        .map_err(|e| format!("Failed to inspect projects schema: {}", e))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to inspect projects columns: {}", e))?;

    for name_result in rows {
        let column_name =
            name_result.map_err(|e| format!("Failed to read projects column name: {}", e))?;
        if column_name == "node_count" {
            has_node_count = true;
            break;
        }
    }

    if !has_node_count {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN node_count INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("Failed to add node_count column: {}", e))?;
    }

    Ok(())
}

fn parse_image_pool(history_json: &str) -> Vec<String> {
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

fn insert_image_ref_from_object(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    if let Some(raw_value) = object.get(key).and_then(|value| value.as_str()) {
        if let Some(path) = resolve_image_ref(raw_value, image_pool) {
            paths.insert(path);
        }
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
        if let Some(raw_value) = value.as_str() {
            if let Some(path) = resolve_image_ref(raw_value, image_pool) {
                paths.insert(path);
            }
        }
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

        for key in [
            "imageUrl",
            "previewImageUrl",
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
                    if let Some(raw_value) = frame_obj.get(key).and_then(|value| value.as_str()) {
                        if let Some(path) = resolve_image_ref(raw_value, image_pool) {
                            paths.insert(path);
                        }
                    }
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

fn extract_project_image_paths(nodes_json: &str, history_json: &str) -> HashSet<String> {
    let image_pool = parse_image_pool(history_json);
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

    let images_dir = resolve_images_dir(app)?;
    let entries =
        std::fs::read_dir(&images_dir).map_err(|e| format!("Failed to read images dir: {}", e))?;

    for entry_result in entries {
        let entry = entry_result.map_err(|e| format!("Failed to iterate images dir: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let path_string = path.to_string_lossy().to_string();
        if !referenced.contains(&path_string) {
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
                  history_json
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
    let image_paths = extract_project_image_paths(&record.nodes_json, &record.history_json);
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
              history_json
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at,
              node_count = excluded.node_count,
              nodes_json = excluded.nodes_json,
              edges_json = excluded.edges_json,
              viewport_json = excluded.viewport_json,
              history_json = excluded.history_json
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

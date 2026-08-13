pub mod ai;
pub mod commands;

use std::time::Duration;

use commands::ai as ai_commands;
use commands::diagnostic_log;
use commands::external_agent;
use commands::image;
use commands::portability;
use commands::project_state;
use commands::system;
use commands::update;
use tauri::Manager;
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

const MAIN_WINDOW_LABEL: &str = "main";
const FRONTEND_READY_TIMEOUT_MS: u64 = 3_500;

fn setup_logging() {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "info,open_storyboard_canvas=debug".into());

    if let Some(log_dir) = diagnostic_log::resolve_log_dir() {
        let file_appender = tracing_appender::rolling::daily(log_dir, "storyboard.log");
        let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
        std::mem::forget(_guard);

        tracing_subscriber::registry()
            .with(env_filter)
            .with(tracing_subscriber::fmt::layer().with_writer(non_blocking))
            .init();
    } else {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(tracing_subscriber::fmt::layer())
            .init();
    }

    info!("Open Storyboard Canvas starting...");
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(main_window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(err) = main_window.show() {
            warn!("failed to show main window: {err}");
        }
        if let Err(err) = main_window.set_focus() {
            warn!("failed to focus main window: {err}");
        }
    } else {
        warn!("main window not found while trying to reveal UI");
    }
}

#[tauri::command]
fn frontend_ready(app: tauri::AppHandle) {
    info!("frontend_ready received, revealing main window");
    show_main_window(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    setup_logging();

    let external_agent_state = external_agent::ExternalAgentState::new();

    tauri::Builder::default()
        .manage(project_state::ProjectDb::new())
        .manage(portability::PortabilityJobs::new())
        .manage(external_agent_state)
        .on_page_load(|window, _payload| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }

            info!("main page loaded, revealing main window");
            show_main_window(&window.app_handle());
        })
        .setup(|app| {
            app.state::<external_agent::ExternalAgentState>()
                .start_broker(app.handle().clone())?;

            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == MAIN_WINDOW_LABEL)
                .cloned()
                .ok_or_else(|| "missing main window config".to_string())?;

            #[cfg(not(target_os = "macos"))]
            let main_window =
                tauri::WebviewWindowBuilder::from_config(app, &window_config)?.build()?;

            #[cfg(not(target_os = "macos"))]
            {
                if let Err(err) = main_window.hide() {
                    warn!("failed to hide main window on startup: {err}");
                }
            }

            #[cfg(target_os = "macos")]
            {
                let mut mac_window_config = window_config;
                // Window effects radius only works for transparent windows on macOS.
                mac_window_config.transparent = true;

                let window =
                    tauri::WebviewWindowBuilder::from_config(app, &mac_window_config)?.build()?;

                if let Err(err) = window.hide() {
                    warn!("failed to hide main window on startup: {err}");
                }

                if let Err(err) = window.set_effects(Some(
                    tauri::window::EffectsBuilder::new()
                        .effect(tauri::window::Effect::Titlebar)
                        .radius(10.0)
                        .build(),
                )) {
                    warn!("failed to apply macOS window effects: {err}");
                }
            }

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(FRONTEND_READY_TIMEOUT_MS)).await;

                let is_main_visible = app_handle
                    .get_webview_window(MAIN_WINDOW_LABEL)
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);

                if !is_main_visible {
                    warn!(
                        "frontend_ready timeout after {}ms, forcing main window reveal",
                        FRONTEND_READY_TIMEOUT_MS
                    );
                    show_main_window(&app_handle);
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            commands::check_dreamina_login,
            commands::dreamina_oauth_start,
            commands::dreamina_oauth_check,
            commands::dreamina_session_list,
            commands::dreamina_session_create,
            commands::dreamina_session_rename,
            commands::dreamina_session_delete,
            commands::dreamina_text2image,
            commands::dreamina_image2image,
            commands::dreamina_image_upscale,
            commands::dreamina_text2video,
            commands::dreamina_image2video,
            commands::dreamina_frames2video,
            commands::dreamina_multiframe2video,
            commands::dreamina_multimodal2video,
            commands::dreamina_query_result,
            commands::dreamina_list_task,
            commands::dreamina_stage_reference_image,
            commands::dreamina_stage_reference_media,
            commands::dreamina_network_diagnose,
            external_agent::diagnose_external_agent_runtimes,
            external_agent::start_external_agent_session,
            external_agent::send_external_agent_turn,
            external_agent::cancel_external_agent_session,
            external_agent::external_agent_resolve_tool_call,
            commands::custom_http_request,
            commands::custom_http_stream_request,
            image::split_image,
            image::split_image_source,
            image::prepare_node_image_source,
            image::prepare_node_image_source_with_headers,
            image::prepare_node_image_binary,
            image::crop_image_source,
            image::merge_storyboard_images,
            image::read_storyboard_image_metadata,
            image::embed_storyboard_image_metadata,
            image::load_image,
            image::persist_image_source,
            image::persist_video_source,
            image::persist_image_binary,
            image::rename_local_media_files,
            image::save_image_source_to_downloads,
            image::save_image_source_to_path,
            image::save_image_source_to_directory,
            image::save_video_source_to_path,
            image::save_video_source_to_directory,
            image::save_audio_source_to_path,
            image::load_audio_source_data_url,
            image::save_image_source_to_app_debug_dir,
            image::copy_image_source_to_clipboard,
            image::read_system_clipboard,
            ai_commands::set_api_key,
            ai_commands::submit_generate_image_job,
            ai_commands::get_generate_image_job,
            ai_commands::create_generation_job,
            ai_commands::update_generation_job_record,
            ai_commands::list_generation_jobs,
            ai_commands::get_generation_job_record,
            ai_commands::forget_generation_job,
            diagnostic_log::read_diagnostic_logs,
            ai_commands::generate_image,
            ai_commands::list_models,
            project_state::list_project_summaries,
            project_state::get_project_record,
            project_state::upsert_project_record,
            project_state::update_project_viewport_record,
            project_state::rename_project_record,
            project_state::delete_project_record,
            portability::export_project_bundle,
            portability::inspect_project_bundle,
            portability::import_project_bundle,
            portability::cancel_portability_operation,
            portability::write_portability_text_file,
            portability::read_portability_text_file,
            system::get_runtime_system_info,
            update::check_latest_release_tag,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if open_storyboard_canvas_lib::commands::external_agent::is_external_agent_mcp_mode() {
        if let Err(error) =
            open_storyboard_canvas_lib::commands::external_agent::run_external_agent_mcp_mode()
        {
            eprintln!("external Agent MCP bridge failed: {error}");
            std::process::exit(1);
        }
        return;
    }

    open_storyboard_canvas_lib::run()
}

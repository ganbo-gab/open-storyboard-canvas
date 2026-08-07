use serde::Serialize;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Command;

use super::dreamina_cli::{
    build_image2image_args, build_image_upscale_args, build_multiframe_args, build_multimodal_args,
    build_text2image_args, build_video_args, command_succeeded, parse_cli_output,
    parse_cli_version, parse_credit, parse_oauth_material, parse_sessions, CommandExpectation,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreaminaCliVersion {
    pub version: Option<String>,
    pub commit: Option<String>,
    pub build_time: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreaminaStatus {
    pub installed: bool,
    pub logged_in: bool,
    pub credits: Option<i64>,
    pub error: Option<String>,
    /// True when we successfully detected a logged-in session BUT the credits
    /// endpoint was unreachable (network hiccup rather than auth failure). The
    /// UI surfaces this as an amber "已登录 · 网络不稳定" banner so the user
    /// doesn't get a scary "未登录" when they're actually signed in.
    pub network_degraded: bool,
    /// The actual binary path we ended up invoking, for diagnostic UI.
    pub resolved_path: Option<String>,
    pub version_info: Option<DreaminaCliVersion>,
    pub login_state: String,
    pub vip_level: Option<String>,
    pub user_name: Option<String>,
    pub user_id: Option<String>,
    pub account_error: Option<String>,
    pub sessions_available: bool,
    pub session_error: Option<String>,
}

struct RawCliOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

fn run_cli(binary: &PathBuf, args: &[String]) -> Result<RawCliOutput, String> {
    let mut command = Command::new(binary);
    command.args(args);
    build_cli_env(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("执行 dreamina 失败：{error}"))?;
    Ok(RawCliOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn concise_cli_error(output: &RawCliOutput) -> String {
    let source = if output.stderr.trim().is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    source.chars().take(400).collect()
}

fn read_cli_version(binary: &PathBuf) -> Option<DreaminaCliVersion> {
    let output = run_cli(binary, &["--version".to_string()]).ok()?;
    if !output.success {
        return None;
    }
    let parsed = parse_cli_version(&output.stdout);
    Some(DreaminaCliVersion {
        version: parsed.version,
        commit: parsed.commit,
        build_time: parsed.build_time,
    })
}

/// Look for the `dreamina` binary on PATH plus the well-known install prefixes
/// that Tauri's subprocess environment often DOESN'T inherit (because it skips
/// the user's login shell). This covers Homebrew (Intel + Apple Silicon),
/// the Dreamina one-line installer's default, pip/uv `--user`, and Windows npm.
fn non_empty_env(name: &str) -> Option<OsString> {
    std::env::var_os(name).filter(|value| !value.as_os_str().is_empty())
}

fn dreamina_home_dir() -> Option<PathBuf> {
    if let Some(home) = non_empty_env("HOME") {
        return Some(PathBuf::from(home));
    }

    #[cfg(windows)]
    {
        for key in ["USERPROFILE", "APPDATA", "LOCALAPPDATA"] {
            if let Some(value) = non_empty_env(key) {
                return Some(PathBuf::from(value));
            }
        }
    }

    None
}

fn dreamina_staging_dir() -> Option<PathBuf> {
    if let Some(home) = non_empty_env("HOME") {
        return Some(
            PathBuf::from(home)
                .join("Library/Application Support/open-storyboard-canvas/dreamina-staging"),
        );
    }

    #[cfg(windows)]
    {
        if let Some(appdata) = non_empty_env("APPDATA") {
            return Some(PathBuf::from(appdata).join("open-storyboard-canvas/dreamina-staging"));
        }
        if let Some(local_appdata) = non_empty_env("LOCALAPPDATA") {
            return Some(
                PathBuf::from(local_appdata).join("open-storyboard-canvas/dreamina-staging"),
            );
        }
        if let Some(user_profile) = non_empty_env("USERPROFILE") {
            return Some(
                PathBuf::from(user_profile)
                    .join("AppData/Local/open-storyboard-canvas/dreamina-staging"),
            );
        }
    }

    None
}

fn push_path_once(paths: &mut Vec<PathBuf>, candidate: PathBuf) {
    if candidate.as_os_str().is_empty() || paths.iter().any(|path| path == &candidate) {
        return;
    }
    paths.push(candidate);
}

fn locate_dreamina_binary() -> Option<PathBuf> {
    let home = dreamina_home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();

    // PATH first (may or may not contain it depending on how the app was launched).
    if let Some(path_env) = non_empty_env("PATH") {
        for p in std::env::split_paths(&path_env) {
            candidates.push(p.join("dreamina"));
            #[cfg(windows)]
            candidates.push(p.join("dreamina.exe"));
            #[cfg(windows)]
            candidates.push(p.join("dreamina.cmd"));
            #[cfg(windows)]
            candidates.push(p.join("dreamina.bat"));
        }
    }

    // Well-known install prefixes.
    if let Some(h) = home.as_ref() {
        candidates.push(h.join(".dreamina/bin/dreamina"));
        candidates.push(h.join(".local/bin/dreamina"));
        candidates.push(h.join(".cargo/bin/dreamina"));
        candidates.push(h.join("bin/dreamina"));
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = non_empty_env("APPDATA") {
            let npm_dir = PathBuf::from(appdata).join("npm");
            candidates.push(npm_dir.join("dreamina.cmd"));
            candidates.push(npm_dir.join("dreamina.exe"));
            candidates.push(npm_dir.join("dreamina"));
        }
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/dreamina"));
    candidates.push(PathBuf::from("/usr/local/bin/dreamina"));
    candidates.push(PathBuf::from("/usr/bin/dreamina"));

    candidates.into_iter().find(|p| p.exists())
}

/// Build the env we pass to every `dreamina` subprocess. Tauri strips the
/// login-shell env, so we hand the child a PATH that includes the common
/// install prefixes + carry HOME/USER through so the CLI finds its session.
fn build_cli_env(cmd: &mut Command) {
    if let Some(home) = non_empty_env("HOME") {
        cmd.env("HOME", home);
    } else if let Some(home) = dreamina_home_dir() {
        cmd.env("HOME", home);
    }
    if let Some(user) = non_empty_env("USER") {
        cmd.env("USER", user);
    }
    for key in ["USERPROFILE", "APPDATA", "LOCALAPPDATA"] {
        if let Some(value) = non_empty_env(key) {
            cmd.env(key, value);
        }
    }

    let mut paths = non_empty_env("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();

    #[cfg(windows)]
    {
        if let Some(appdata) = non_empty_env("APPDATA") {
            push_path_once(&mut paths, PathBuf::from(appdata).join("npm"));
        }
        if let Some(local_appdata) = non_empty_env("LOCALAPPDATA") {
            push_path_once(
                &mut paths,
                PathBuf::from(local_appdata).join("Microsoft/WindowsApps"),
            );
        }
        if let Some(home) = dreamina_home_dir() {
            push_path_once(&mut paths, home.join(".dreamina/bin"));
        }
    }

    #[cfg(not(windows))]
    {
        for p in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"] {
            push_path_once(&mut paths, PathBuf::from(p));
        }
    }

    if let Ok(path) = std::env::join_paths(paths) {
        cmd.env("PATH", path);
    }
}

/// Classify a CLI failure message as (network error, explicit auth failure).
/// The CLI's `user_credit` endpoint is flaky — even when logged in, a transient
/// `EOF` / `i/o timeout` / DNS hiccup bubbles up as exit=1. Pre-fix, we read
/// any non-zero exit as "not logged in", which falsely accused real sessions.
/// Now we separate the two so the caller can fall back to `list_task` on pure
/// network errors (which consults the local session token store) before
/// concluding the user isn't logged in.
fn classify_cli_error(combined: &str) -> (bool, bool) {
    let lower = combined.to_lowercase();
    let network_patterns = [
        "do request",
        "eof",
        "i/o timeout",
        "no such host",
        "connection refused",
        "connection reset",
        "dial tcp",
        "tls",
        "context deadline exceeded",
        "network is unreachable",
        "temporary failure in name resolution",
    ];
    let auth_patterns = [
        "login",
        "auth",
        "token",
        "session",
        "未登录",
        "请先登录",
        "unauthor",
    ];
    let is_network = network_patterns.iter().any(|p| lower.contains(p));
    let is_auth = auth_patterns.iter().any(|p| lower.contains(p));
    (is_network, is_auth)
}

/// Inspect account and session capabilities independently. A broken session
/// store must not turn a valid credit response into a false "logged out" state.
#[tauri::command]
pub async fn check_dreamina_login() -> DreaminaStatus {
    let binary = match locate_dreamina_binary() {
        Some(binary) => binary,
        None => {
            let error = "未找到 dreamina CLI 二进制（已检查 PATH / ~/.dreamina / ~/.local/bin / ~/.cargo/bin / /opt/homebrew / /usr/local）".to_string();
            return DreaminaStatus {
                installed: false,
                logged_in: false,
                credits: None,
                error: Some(error.clone()),
                network_degraded: false,
                resolved_path: None,
                version_info: None,
                login_state: "logged_out".to_string(),
                vip_level: None,
                user_name: None,
                user_id: None,
                account_error: Some(error),
                sessions_available: false,
                session_error: Some("Dreamina CLI is not installed.".to_string()),
            };
        }
    };

    let resolved_path = binary.to_string_lossy().to_string();
    let version_info = read_cli_version(&binary);
    let session_probe = run_cli(
        &binary,
        &[
            "session".to_string(),
            "list".to_string(),
            "-n".to_string(),
            "5".to_string(),
        ],
    );
    let (sessions_available, session_error) = match session_probe {
        Ok(output) if output.success => (true, None),
        Ok(output) => (false, Some(concise_cli_error(&output))),
        Err(error) => (false, Some(error)),
    };

    let credit_output = match run_cli(&binary, &["user_credit".to_string()]) {
        Ok(output) => output,
        Err(error) => {
            return DreaminaStatus {
                installed: true,
                logged_in: false,
                credits: None,
                error: Some(error.clone()),
                network_degraded: false,
                resolved_path: Some(resolved_path),
                version_info,
                login_state: "unknown".to_string(),
                vip_level: None,
                user_name: None,
                user_id: None,
                account_error: Some(error),
                sessions_available,
                session_error,
            };
        }
    };

    if credit_output.success {
        let credit = parse_credit(&credit_output.stdout);
        return DreaminaStatus {
            installed: true,
            logged_in: true,
            credits: credit.total_credit,
            error: None,
            network_degraded: false,
            resolved_path: Some(resolved_path),
            version_info,
            login_state: "logged_in".to_string(),
            vip_level: credit.vip_level,
            user_name: credit.user_name,
            user_id: credit.user_id,
            account_error: None,
            sessions_available,
            session_error,
        };
    }

    let credit_error = concise_cli_error(&credit_output);
    let (is_network, is_auth) = classify_cli_error(&credit_error);
    if is_auth && !is_network {
        let error = "检测到 CLI 未登录，请在设置中启动 OAuth Device Flow。".to_string();
        return DreaminaStatus {
            installed: true,
            logged_in: false,
            credits: None,
            error: Some(error.clone()),
            network_degraded: false,
            resolved_path: Some(resolved_path),
            version_info,
            login_state: "logged_out".to_string(),
            vip_level: None,
            user_name: None,
            user_id: None,
            account_error: Some(error),
            sessions_available,
            session_error,
        };
    }

    let task_probe = run_cli(&binary, &["list_task".to_string()]);
    let logged_in = matches!(task_probe, Ok(ref output) if output.success);
    let account_error = if logged_in {
        "已确认本地登录，但积分接口暂不可达。".to_string()
    } else if is_network {
        format!("网络不可达，无法确认账号状态：{credit_error}")
    } else {
        credit_error
    };
    DreaminaStatus {
        installed: true,
        logged_in,
        credits: None,
        error: Some(account_error.clone()),
        network_degraded: is_network,
        resolved_path: Some(resolved_path),
        version_info,
        login_state: if logged_in { "logged_in" } else { "unknown" }.to_string(),
        vip_level: None,
        user_name: None,
        user_id: None,
        account_error: Some(account_error),
        sessions_available,
        session_error,
    }
}

// ============================================================================
// Generation commands — thin shell wrappers around Dreamina CLI media
// commands. They submit synchronously (with --poll so we block until the job
// resolves or N seconds passes) and return raw JSON/text from stdout, which the
// frontend parses to pull out the submit_id / result URLs. The CLI handles auth
// via the local login session that check_dreamina_login already validated.
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreaminaSubmitResult {
    pub ok: bool,
    pub submit_id: Option<String>,
    pub gen_status: Option<String>,
    pub fail_reason: Option<String>,
    pub compliance_required: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
}

impl DreaminaSubmitResult {
    fn failure(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            submit_id: None,
            gen_status: None,
            fail_reason: None,
            compliance_required: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(error.into()),
        }
    }
}

async fn run_dreamina_subcommand(
    args: Vec<String>,
    expectation: CommandExpectation,
) -> DreaminaSubmitResult {
    let binary = match locate_dreamina_binary() {
        Some(p) => p,
        None => return DreaminaSubmitResult::failure("未找到 dreamina CLI 二进制"),
    };

    let mut cmd = Command::new(&binary);
    for arg in &args {
        cmd.arg(arg);
    }
    build_cli_env(&mut cmd);

    // CLI calls can take minutes — we shell out without a deadline and let the
    // caller set --poll explicitly for its own timeout.
    let output = match cmd.output() {
        Ok(o) => o,
        Err(err) => return DreaminaSubmitResult::failure(format!("执行 dreamina 失败：{err}")),
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let parsed = parse_cli_output(&stdout, &stderr);
    let ok = command_succeeded(output.status.success(), expectation, &parsed);
    let error = if ok {
        None
    } else {
        let diagnostic = if let Some(reason) = parsed.fail_reason.as_deref() {
            reason.to_string()
        } else if output.status.success() && expectation == CommandExpectation::Submit {
            "Dreamina CLI 未返回有效的 submit_id + gen_status（querying/success），提交结果未被接受。".to_string()
        } else if stderr.trim().is_empty() {
            stdout.clone()
        } else {
            stderr.clone()
        };
        Some(diagnostic.chars().take(400).collect::<String>())
    };
    DreaminaSubmitResult {
        ok,
        submit_id: parsed.submit_id,
        gen_status: parsed.gen_status,
        fail_reason: parsed.fail_reason,
        compliance_required: parsed.compliance_required,
        exit_code: output.status.code(),
        stdout,
        stderr,
        error,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreaminaOAuthStartResult {
    pub ok: bool,
    pub already_authorized: bool,
    pub verification_uri: Option<String>,
    pub user_code: Option<String>,
    pub device_code: Option<String>,
    pub expires_in: Option<i64>,
    pub interval: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreaminaOAuthCheckResult {
    pub ok: bool,
    pub authorized: bool,
    pub pending: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreaminaSession {
    pub id: i64,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreaminaSessionListResult {
    pub ok: bool,
    pub sessions: Vec<DreaminaSession>,
    pub error: Option<String>,
}

fn default_dreamina_session() -> DreaminaSession {
    DreaminaSession {
        id: 0,
        name: "Default".to_string(),
        is_default: true,
    }
}

#[tauri::command]
pub async fn dreamina_oauth_start() -> DreaminaOAuthStartResult {
    let binary = match locate_dreamina_binary() {
        Some(binary) => binary,
        None => {
            return DreaminaOAuthStartResult {
                ok: false,
                already_authorized: false,
                verification_uri: None,
                user_code: None,
                device_code: None,
                expires_in: None,
                interval: None,
                error: Some("未找到 dreamina CLI 二进制".to_string()),
            };
        }
    };
    let output = match run_cli(&binary, &["login".to_string(), "--headless".to_string()]) {
        Ok(output) => output,
        Err(error) => {
            return DreaminaOAuthStartResult {
                ok: false,
                already_authorized: false,
                verification_uri: None,
                user_code: None,
                device_code: None,
                expires_in: None,
                interval: None,
                error: Some(error),
            };
        }
    };
    let material = parse_oauth_material(&format!("{}\n{}", output.stdout, output.stderr));
    let has_material = material.verification_uri.is_some()
        && material.user_code.is_some()
        && material.device_code.is_some();
    let already_authorized = output.success && !has_material;
    let ok = output.success && (has_material || already_authorized);
    DreaminaOAuthStartResult {
        ok,
        already_authorized,
        verification_uri: material.verification_uri,
        user_code: material.user_code,
        device_code: material.device_code,
        expires_in: material.expires_in,
        interval: material.interval,
        error: if ok {
            None
        } else {
            Some(concise_cli_error(&output))
        },
    }
}

#[tauri::command]
pub async fn dreamina_oauth_check(
    device_code: String,
    poll_seconds: Option<u32>,
) -> DreaminaOAuthCheckResult {
    let device_code = device_code.trim().to_string();
    if device_code.is_empty() {
        return DreaminaOAuthCheckResult {
            ok: false,
            authorized: false,
            pending: false,
            error: Some("OAuth device_code 不能为空".to_string()),
        };
    }
    let binary = match locate_dreamina_binary() {
        Some(binary) => binary,
        None => {
            return DreaminaOAuthCheckResult {
                ok: false,
                authorized: false,
                pending: false,
                error: Some("未找到 dreamina CLI 二进制".to_string()),
            };
        }
    };
    let output = match run_cli(
        &binary,
        &[
            "login".to_string(),
            "checklogin".to_string(),
            format!("--device_code={device_code}"),
            format!("--poll={}", poll_seconds.unwrap_or(0).min(120)),
        ],
    ) {
        Ok(output) => output,
        Err(error) => {
            return DreaminaOAuthCheckResult {
                ok: false,
                authorized: false,
                pending: false,
                error: Some(error),
            };
        }
    };
    if output.success {
        return DreaminaOAuthCheckResult {
            ok: true,
            authorized: true,
            pending: false,
            error: None,
        };
    }
    let diagnostic = concise_cli_error(&output).replace(&device_code, "[redacted]");
    let lower = diagnostic.to_ascii_lowercase();
    let pending = lower.contains("authorization_pending")
        || lower.contains("pending")
        || lower.contains("not authorized")
        || lower.contains("timeout");
    DreaminaOAuthCheckResult {
        ok: pending,
        authorized: false,
        pending,
        error: if pending { None } else { Some(diagnostic) },
    }
}

#[tauri::command]
pub async fn dreamina_session_list(limit: Option<u32>) -> DreaminaSessionListResult {
    let binary = match locate_dreamina_binary() {
        Some(binary) => binary,
        None => {
            return DreaminaSessionListResult {
                ok: false,
                sessions: vec![default_dreamina_session()],
                error: Some("未找到 dreamina CLI 二进制".to_string()),
            };
        }
    };
    let output = match run_cli(
        &binary,
        &[
            "session".to_string(),
            "list".to_string(),
            "-n".to_string(),
            limit.unwrap_or(30).clamp(1, 100).to_string(),
        ],
    ) {
        Ok(output) => output,
        Err(error) => {
            return DreaminaSessionListResult {
                ok: false,
                sessions: vec![default_dreamina_session()],
                error: Some(error),
            };
        }
    };
    if !output.success {
        return DreaminaSessionListResult {
            ok: false,
            sessions: vec![default_dreamina_session()],
            error: Some(concise_cli_error(&output)),
        };
    }
    let sessions = parse_sessions(&output.stdout)
        .into_iter()
        .map(|session| DreaminaSession {
            id: session.id,
            name: session.name,
            is_default: session.id == 0,
        })
        .collect();
    DreaminaSessionListResult {
        ok: true,
        sessions,
        error: None,
    }
}

#[tauri::command]
pub async fn dreamina_session_create(name: Option<String>) -> DreaminaSubmitResult {
    let mut args = vec!["session".to_string(), "create".to_string()];
    if let Some(name) = name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
    {
        args.push(name);
    }
    run_dreamina_subcommand(args, CommandExpectation::Utility).await
}

#[tauri::command]
pub async fn dreamina_session_rename(session_id: i64, name: String) -> DreaminaSubmitResult {
    if session_id <= 0 {
        return DreaminaSubmitResult::failure("默认 session 0 不能重命名");
    }
    if name.trim().is_empty() {
        return DreaminaSubmitResult::failure("Session 名称不能为空");
    }
    run_dreamina_subcommand(
        vec![
            "session".to_string(),
            "rename".to_string(),
            session_id.to_string(),
            name.trim().to_string(),
        ],
        CommandExpectation::Utility,
    )
    .await
}

#[tauri::command]
pub async fn dreamina_session_delete(session_id: i64) -> DreaminaSubmitResult {
    if session_id <= 0 {
        return DreaminaSubmitResult::failure("默认 session 0 不能删除");
    }
    run_dreamina_subcommand(
        vec![
            "session".to_string(),
            "delete".to_string(),
            session_id.to_string(),
        ],
        CommandExpectation::Utility,
    )
    .await
}

#[tauri::command]
pub async fn dreamina_text2image(
    prompt: String,
    model_version: Option<String>,
    ratio: Option<String>,
    resolution_type: Option<String>,
    session_id: Option<i64>,
    poll_seconds: Option<u32>,
) -> DreaminaSubmitResult {
    let args = match build_text2image_args(
        &prompt,
        model_version.as_deref(),
        ratio.as_deref(),
        resolution_type.as_deref(),
        session_id,
        poll_seconds.unwrap_or(60),
    ) {
        Ok(args) => args,
        Err(error) => return DreaminaSubmitResult::failure(error),
    };
    run_dreamina_subcommand(args, CommandExpectation::Submit).await
}

#[tauri::command]
pub async fn dreamina_image2image(
    prompt: String,
    image_paths: Vec<String>,
    model_version: Option<String>,
    ratio: Option<String>,
    resolution_type: Option<String>,
    session_id: Option<i64>,
    poll_seconds: Option<u32>,
) -> DreaminaSubmitResult {
    let args = match build_image2image_args(
        &prompt,
        &image_paths,
        model_version.as_deref(),
        ratio.as_deref(),
        resolution_type.as_deref(),
        session_id,
        poll_seconds.unwrap_or(120),
    ) {
        Ok(args) => args,
        Err(error) => return DreaminaSubmitResult::failure(error),
    };
    run_dreamina_subcommand(args, CommandExpectation::Submit).await
}

#[tauri::command]
pub async fn dreamina_query_result(
    submit_id: String,
    download_dir: Option<String>,
) -> DreaminaSubmitResult {
    let mut args: Vec<String> = vec!["query_result".into(), format!("--submit_id={submit_id}")];
    if let Some(d) = download_dir {
        args.push(format!("--download_dir={d}"));
    }
    run_dreamina_subcommand(args, CommandExpectation::Query).await
}

/// Run `dreamina list_task` and return the full JSON stdout so the caller
/// (frontend gateway) can scan for a specific submit_id + gen_status.
#[tauri::command]
pub async fn dreamina_list_task() -> DreaminaSubmitResult {
    run_dreamina_subcommand(vec!["list_task".into()], CommandExpectation::Utility).await
}

/// Dreamina HD upscale — single input image, optional resolution tier.
/// Non-VIP users are limited to 2k; 4k/8k require VIP.
#[tauri::command]
pub async fn dreamina_image_upscale(
    image_path: String,
    resolution_type: Option<String>,
    session_id: Option<i64>,
    poll_seconds: Option<u32>,
) -> DreaminaSubmitResult {
    let args = match build_image_upscale_args(
        &image_path,
        resolution_type.as_deref(),
        session_id,
        poll_seconds.unwrap_or(120),
    ) {
        Ok(args) => args,
        Err(error) => return DreaminaSubmitResult::failure(error),
    };
    run_dreamina_subcommand(args, CommandExpectation::Submit).await
}

#[tauri::command]
pub async fn dreamina_text2video(
    prompt: String,
    model_version: Option<String>,
    ratio: Option<String>,
    duration: Option<u32>,
    video_resolution: Option<String>,
    session_id: Option<i64>,
    poll_seconds: Option<u32>,
) -> DreaminaSubmitResult {
    let args = match build_video_args(
        "text2video",
        &prompt,
        &[],
        model_version.as_deref(),
        ratio.as_deref(),
        duration,
        video_resolution.as_deref(),
        session_id,
        poll_seconds.unwrap_or(180),
    ) {
        Ok(args) => args,
        Err(error) => return DreaminaSubmitResult::failure(error),
    };
    run_dreamina_subcommand(args, CommandExpectation::Submit).await
}

#[tauri::command]
pub async fn dreamina_image2video(
    prompt: String,
    image_path: String,
    model_version: Option<String>,
    duration: Option<u32>,
    video_resolution: Option<String>,
    session_id: Option<i64>,
    poll_seconds: Option<u32>,
) -> DreaminaSubmitResult {
    let args = match build_video_args(
        "image2video",
        &prompt,
        &[image_path],
        model_version.as_deref(),
        None,
        duration,
        video_resolution.as_deref(),
        session_id,
        poll_seconds.unwrap_or(180),
    ) {
        Ok(args) => args,
        Err(error) => return DreaminaSubmitResult::failure(error),
    };
    run_dreamina_subcommand(args, CommandExpectation::Submit).await
}

#[tauri::command]
pub async fn dreamina_frames2video(
    prompt: String,
    first_path: String,
    last_path: String,
    model_version: Option<String>,
    duration: Option<u32>,
    video_resolution: Option<String>,
    session_id: Option<i64>,
    poll_seconds: Option<u32>,
) -> DreaminaSubmitResult {
    let args = match build_video_args(
        "frames2video",
        &prompt,
        &[first_path, last_path],
        model_version.as_deref(),
        None,
        duration,
        video_resolution.as_deref(),
        session_id,
        poll_seconds.unwrap_or(180),
    ) {
        Ok(args) => args,
        Err(error) => return DreaminaSubmitResult::failure(error),
    };
    run_dreamina_subcommand(args, CommandExpectation::Submit).await
}

#[tauri::command]
pub async fn dreamina_multiframe2video(
    image_paths: Vec<String>,
    prompt: Option<String>,
    duration: Option<f64>,
    transition_prompts: Option<Vec<String>>,
    transition_durations: Option<Vec<String>>,
    video_resolution: String,
    session_id: Option<i64>,
    poll_seconds: Option<u32>,
) -> DreaminaSubmitResult {
    let args = match build_multiframe_args(
        &image_paths,
        prompt.as_deref(),
        duration,
        transition_prompts.as_deref(),
        transition_durations.as_deref(),
        &video_resolution,
        session_id,
        poll_seconds.unwrap_or(240),
    ) {
        Ok(args) => args,
        Err(error) => return DreaminaSubmitResult::failure(error),
    };
    run_dreamina_subcommand(args, CommandExpectation::Submit).await
}

#[tauri::command]
pub async fn dreamina_multimodal2video(
    prompt: String,
    image_paths: Vec<String>,
    video_paths: Vec<String>,
    audio_paths: Vec<String>,
    model_version: Option<String>,
    ratio: Option<String>,
    duration: Option<u32>,
    video_resolution: Option<String>,
    session_id: Option<i64>,
    poll_seconds: Option<u32>,
) -> DreaminaSubmitResult {
    let args = match build_multimodal_args(
        &prompt,
        &image_paths,
        &video_paths,
        &audio_paths,
        model_version.as_deref(),
        ratio.as_deref(),
        duration,
        video_resolution.as_deref(),
        session_id,
        poll_seconds.unwrap_or(240),
    ) {
        Ok(args) => args,
        Err(error) => return DreaminaSubmitResult::failure(error),
    };
    run_dreamina_subcommand(args, CommandExpectation::Submit).await
}

/// Stage a data: URL as a temp file so Dreamina CLI (which only accepts local
/// paths via `--images`) can read it. Returns the absolute file path.
#[tauri::command]
pub async fn dreamina_stage_reference_image(data_url: String) -> Result<String, String> {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    if !data_url.starts_with("data:") {
        return Err("not a data URL".into());
    }
    let comma = data_url
        .find(',')
        .ok_or_else(|| "invalid data URL".to_string())?;
    let payload = &data_url[comma + 1..];

    // base64 decode using a tiny inline decoder to avoid adding a new dep.
    let bytes = base64_decode(payload).map_err(|e| format!("base64 decode failed: {e}"))?;

    let dir = dreamina_staging_dir().ok_or_else(|| "HOME not set".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file = dir.join(format!("ref-{ts}.png"));
    fs::write(&file, &bytes).map_err(|e| format!("write failed: {e}"))?;
    Ok(file.to_string_lossy().to_string())
}

/// Stage a non-image data URL as a temp file so Dreamina CLI can upload it as
/// video/audio reference input. The caller supplies a conservative extension
/// inferred from the data URL MIME type.
#[tauri::command]
pub async fn dreamina_stage_reference_media(
    data_url: String,
    extension: Option<String>,
) -> Result<String, String> {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    if !data_url.starts_with("data:") {
        return Err("not a data URL".into());
    }
    let comma = data_url
        .find(',')
        .ok_or_else(|| "invalid data URL".to_string())?;
    let payload = &data_url[comma + 1..];
    let bytes = base64_decode(payload).map_err(|e| format!("base64 decode failed: {e}"))?;
    let safe_ext = extension
        .as_deref()
        .unwrap_or("bin")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>();
    let resolved_ext = if safe_ext.is_empty() {
        "bin".to_string()
    } else {
        safe_ext
    };

    let dir = dreamina_staging_dir().ok_or_else(|| "HOME not set".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file = dir.join(format!("ref-{ts}.{resolved_ext}"));
    fs::write(&file, &bytes).map_err(|e| format!("write failed: {e}"))?;
    Ok(file.to_string_lossy().to_string())
}

// ============================================================================
// Network diagnose — layered DNS / TCP / TLS / HTTP probe used by the
// Dreamina settings "网络体检" button. When Dreamina generation fails with
// repeated EOFs this command pinpoints WHICH network layer is broken so
// the user can fix their environment (VPN / firewall / ISP) rather than
// assume it's a bug.
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStage {
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiagnoseResult {
    pub dns: NetworkStage,
    pub tcp: NetworkStage,
    pub tls: NetworkStage,
    pub http: NetworkStage,
    pub overall_advice: String,
}

#[tauri::command]
pub async fn dreamina_network_diagnose() -> NetworkDiagnoseResult {
    use std::net::ToSocketAddrs;
    use std::time::Duration;

    let host = "jimeng.jianying.com";
    let port: u16 = 443;

    // 1. DNS
    let dns = match (host, port).to_socket_addrs() {
        Ok(mut it) => match it.next() {
            Some(addr) => NetworkStage {
                ok: true,
                detail: format!("解析到 {}", addr.ip()),
            },
            None => NetworkStage {
                ok: false,
                detail: "域名无可用 IP".into(),
            },
        },
        Err(e) => NetworkStage {
            ok: false,
            detail: format!("DNS 解析失败：{e}"),
        },
    };
    if !dns.ok {
        return NetworkDiagnoseResult {
            dns,
            tcp: NetworkStage { ok: false, detail: "未开始（DNS 失败）".into() },
            tls: NetworkStage { ok: false, detail: "未开始".into() },
            http: NetworkStage { ok: false, detail: "未开始".into() },
            overall_advice: "DNS 无法解析 jimeng.jianying.com。请检查：是否断网 / 是否有 hosts 劫持 / DNS 配置是否正常（尝试切到 223.5.5.5 或 1.1.1.1 重试）。".into(),
        };
    }

    let sock_addr = (host, port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut it| it.next());

    // 2. TCP connect
    let tcp = match sock_addr {
        Some(addr) => match std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
            Ok(_) => NetworkStage {
                ok: true,
                detail: format!("TCP 443 端口连通（{}）", addr.ip()),
            },
            Err(e) => NetworkStage {
                ok: false,
                detail: format!("TCP 连接失败：{e}"),
            },
        },
        None => NetworkStage {
            ok: false,
            detail: "DNS 结果为空".into(),
        },
    };
    if !tcp.ok {
        return NetworkDiagnoseResult {
            dns,
            tcp,
            tls: NetworkStage { ok: false, detail: "未开始（TCP 失败）".into() },
            http: NetworkStage { ok: false, detail: "未开始".into() },
            overall_advice: "TCP 连接到 jimeng.jianying.com:443 失败。可能是防火墙 / 路由器阻止出站，或该 IP 段被运营商屏蔽。建议：切到 4G/5G 手机热点，或暂时关闭 VPN / 代理再试。".into(),
        };
    }

    // 3. TLS handshake + 4. HTTP response — via reqwest. If it fails at
    //    connect/TLS level, reqwest's error carries enough signature to tell.
    let client_result = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .build();

    let (tls, http) = match client_result {
        Err(e) => (
            NetworkStage {
                ok: false,
                detail: format!("reqwest 初始化失败：{e}"),
            },
            NetworkStage {
                ok: false,
                detail: "未开始".into(),
            },
        ),
        Ok(c) => match c.get(format!("https://{host}/")).send().await {
            Ok(resp) => (
                NetworkStage {
                    ok: true,
                    detail: "TLS 握手成功".into(),
                },
                NetworkStage {
                    ok: true,
                    detail: format!("HTTP {}", resp.status().as_u16()),
                },
            ),
            Err(e) => {
                let err_str = format!("{e}");
                let lower = err_str.to_lowercase();
                let looks_like_tls = lower.contains("tls")
                    || lower.contains("ssl")
                    || lower.contains("handshake")
                    || lower.contains("syscall")
                    || lower.contains("eof")
                    || lower.contains("connection reset")
                    || e.is_connect();
                if looks_like_tls {
                    (
                        NetworkStage {
                            ok: false,
                            detail: format!("TLS 握手失败：{err_str}"),
                        },
                        NetworkStage {
                            ok: false,
                            detail: "未开始（TLS 失败）".into(),
                        },
                    )
                } else if e.is_timeout() {
                    (
                        NetworkStage {
                            ok: false,
                            detail: format!("请求超时：{err_str}"),
                        },
                        NetworkStage {
                            ok: false,
                            detail: "未开始（超时）".into(),
                        },
                    )
                } else {
                    (
                        NetworkStage {
                            ok: true,
                            detail: "TLS 握手成功".into(),
                        },
                        NetworkStage {
                            ok: false,
                            detail: format!("HTTP 请求失败：{err_str}"),
                        },
                    )
                }
            }
        },
    };

    let overall_advice = if !tls.ok {
        "TLS 握手被中断 —— 这是即梦 CLI 无法生图的根因。常见原因：\n1. 本机防火墙 / 杀软拦截字节跳动域名；\n2. VPN / 代理未放行 jianying.com；\n3. 当前网络/运营商对该域做 TLS 层干扰。\n建议：关闭 VPN 或代理、切到 4G/5G 手机热点、换一个网络重试；同时在设置中核对 CLI 版本是否为当前发布版。".into()
    } else if !http.ok {
        "TLS 握手通了但 HTTP 层失败。可能是服务端短时维护 / 限流，稍后重试即可。".into()
    } else {
        "网络通畅。若即梦生图仍失败，可能是账号积分不足或账号被限流；请在网页端登录核对。".into()
    };

    NetworkDiagnoseResult {
        dns,
        tcp,
        tls,
        http,
        overall_advice,
    }
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    // Strip whitespace / newlines that often appear in data URL payloads.
    let cleaned: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = cleaned.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for &b in bytes {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return Err(format!("unexpected byte 0x{b:x}")),
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_network_and_login_failures_independently() {
        assert_eq!(
            classify_cli_error("Post image_generate: EOF"),
            (true, false)
        );
        assert_eq!(classify_cli_error("please login first"), (false, true));
        assert_eq!(
            classify_cli_error("auth request failed: TLS handshake EOF"),
            (true, true)
        );
    }

    #[cfg(unix)]
    #[test]
    fn mock_binary_output_obeys_strict_submit_contract() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let directory =
            std::env::temp_dir().join(format!("storyboard-dreamina-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let binary = directory.join("dreamina-mock");
        fs::write(
            &binary,
            "#!/bin/sh\nprintf '%s\\n' '{\"submit_id\":\"be6ad4e0-ecbd-4d70-8ace-5d0995c39832\",\"gen_status\":\"success\"}'\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&binary, permissions).unwrap();

        let output = run_cli(&binary, &["text2image".to_string()]).unwrap();
        let parsed = parse_cli_output(&output.stdout, &output.stderr);
        assert!(command_succeeded(
            output.success,
            CommandExpectation::Submit,
            &parsed
        ));
        assert_eq!(parsed.gen_status.as_deref(), Some("success"));

        fs::remove_dir_all(directory).unwrap();
    }
}

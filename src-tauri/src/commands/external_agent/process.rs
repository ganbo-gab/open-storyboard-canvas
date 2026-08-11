#[cfg(any(windows, test))]
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use super::protocol::{redact_text, truncate_chars};
#[cfg(test)]
use super::{
    claude::{build_claude_command, ClaudeCommandOptions},
    codex::{build_codex_command, toml_string},
};
use super::{
    BrokerCredentials, ExternalAgentCommandError, ExternalAgentRuntime,
    ExternalAgentRuntimeDiagnostic,
};

const DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_DIAGNOSTIC_OUTPUT_BYTES: usize = 32 * 1024;
const SAFE_SYSTEM_PROMPT: &str = "You are the Storyboard Canvas assistant. Use only the storyboard_canvas MCP tools explicitly provided by this application. Never invoke shell, filesystem, network, browser, code-editing, plugin, hook, skill, subagent, or credential-reading capabilities. Canvas writes remain subject to application approval; a denial is authoritative.";

#[derive(Clone, Debug)]
pub(crate) struct LaunchTarget {
    program: PathBuf,
    prefix_args: Vec<OsString>,
    reported_name: String,
}

impl LaunchTarget {
    pub(crate) fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.prefix_args);
        command
    }

    fn from_direct(path: PathBuf, runtime: ExternalAgentRuntime) -> Self {
        Self {
            program: path,
            prefix_args: Vec::new(),
            reported_name: runtime.binary_name().to_string(),
        }
    }

    #[cfg(test)]
    pub(crate) fn from_direct_for_test(path: PathBuf, runtime: ExternalAgentRuntime) -> Self {
        Self::from_direct(path, runtime)
    }
}

struct CapturedOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

fn non_empty_env(name: &str) -> Option<OsString> {
    std::env::var_os(name).filter(|value| !value.is_empty())
}

fn home_dir() -> Option<PathBuf> {
    non_empty_env("HOME").map(PathBuf::from).or_else(|| {
        ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]
            .into_iter()
            .find_map(non_empty_env)
            .map(PathBuf::from)
    })
}

fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !path.as_os_str().is_empty() && !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn candidate_paths(runtime: ExternalAgentRuntime) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let binary = runtime.binary_name();
    if let Some(path_env) = non_empty_env("PATH") {
        for directory in std::env::split_paths(&path_env) {
            push_unique(&mut paths, directory.join(binary));
            #[cfg(windows)]
            {
                push_unique(&mut paths, directory.join(format!("{binary}.exe")));
                push_unique(&mut paths, directory.join(format!("{binary}.cmd")));
            }
        }
    }

    if let Some(home) = home_dir() {
        for relative in [
            ".local/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".cargo/bin",
            "bin",
        ] {
            push_unique(&mut paths, home.join(relative).join(binary));
        }
        if runtime == ExternalAgentRuntime::Codex {
            push_unique(&mut paths, home.join(".codex/bin/codex"));
        }
        if runtime == ExternalAgentRuntime::Claude {
            push_unique(&mut paths, home.join(".local/bin/claude"));
            push_unique(&mut paths, home.join(".claude/local/claude"));
        }
    }

    #[cfg(not(windows))]
    for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        push_unique(&mut paths, PathBuf::from(directory).join(binary));
    }

    #[cfg(windows)]
    {
        if let Some(appdata) = non_empty_env("APPDATA") {
            let directory = PathBuf::from(appdata).join("npm");
            push_unique(&mut paths, directory.join(format!("{binary}.exe")));
            push_unique(&mut paths, directory.join(format!("{binary}.cmd")));
        }
        if let Some(local_appdata) = non_empty_env("LOCALAPPDATA") {
            let local = PathBuf::from(local_appdata);
            push_unique(
                &mut paths,
                local
                    .join("Microsoft/WindowsApps")
                    .join(format!("{binary}.exe")),
            );
            if runtime == ExternalAgentRuntime::Claude {
                push_unique(&mut paths, local.join("Programs/claude/claude.exe"));
            }
        }
    }
    paths
}

#[cfg(any(windows, test))]
fn find_node_executable(shim_directory: &Path) -> Option<PathBuf> {
    let mut candidates = vec![shim_directory.join("node.exe")];
    if let Some(path_env) = non_empty_env("PATH") {
        for directory in std::env::split_paths(&path_env) {
            candidates.push(directory.join("node.exe"));
        }
    }
    if let Some(program_files) = non_empty_env("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("nodejs/node.exe"));
    }
    candidates.into_iter().find(|path| executable_file(path))
}

#[cfg(any(windows, test))]
fn resolve_windows_npm_shim(shim: &Path, runtime: ExternalAgentRuntime) -> Option<LaunchTarget> {
    if !shim
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
    {
        return None;
    }
    let directory = shim.parent()?;
    let script = match runtime {
        ExternalAgentRuntime::Codex => directory.join("node_modules/@openai/codex/bin/codex.js"),
        ExternalAgentRuntime::Claude => {
            directory.join("node_modules/@anthropic-ai/claude-code/cli.js")
        }
    };
    if !script.is_file() {
        return None;
    }
    let node = find_node_executable(directory)?;
    Some(LaunchTarget {
        program: node,
        prefix_args: vec![script.into_os_string()],
        reported_name: format!("{} (npm)", runtime.binary_name()),
    })
}

pub(crate) fn discover_runtime(runtime: ExternalAgentRuntime) -> Option<LaunchTarget> {
    for path in candidate_paths(runtime) {
        #[cfg(windows)]
        {
            let extension = path.extension().and_then(OsStr::to_str);
            if extension.is_none() {
                continue;
            }
            if extension.is_some_and(|value| {
                value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat")
            }) {
                if let Some(target) = resolve_windows_npm_shim(&path, runtime) {
                    return Some(target);
                }
                continue;
            }
        }
        if executable_file(&path) {
            return Some(LaunchTarget::from_direct(path, runtime));
        }
    }
    None
}

fn copy_env(command: &mut Command, name: &str) {
    if let Some(value) = non_empty_env(name) {
        command.env(name, value);
    }
}

pub(crate) fn configure_restricted_env(command: &mut Command, broker: Option<&BrokerCredentials>) {
    command.env_clear();
    for name in [
        "PATH",
        "HOME",
        "USER",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    ] {
        copy_env(command, name);
    }
    command.env("NO_COLOR", "1");
    command.env("TERM", "dumb");
    if let Some(broker) = broker {
        command.env("STORYBOARD_EXTERNAL_AGENT_BROKER", &broker.address);
        command.env("STORYBOARD_EXTERNAL_AGENT_TOKEN", &broker.token);
        command.env("STORYBOARD_EXTERNAL_AGENT_SESSION", &broker.session_id);
    }
}

fn codex_source_home() -> Option<PathBuf> {
    non_empty_env("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".codex")))
}

fn prepare_codex_home_directory(workspace: &Path) -> Result<PathBuf, ExternalAgentCommandError> {
    let isolated_home = workspace.join("codex-home");
    match std::fs::symlink_metadata(&isolated_home) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => {
            return Err(ExternalAgentCommandError::permission_denied(
                "The isolated Codex home path is not a regular directory.",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&isolated_home).map_err(|error| {
                ExternalAgentCommandError::process(format!(
                    "Failed to create isolated Codex home: {error}"
                ))
            })?;
        }
        Err(error) => {
            return Err(ExternalAgentCommandError::process(format!(
                "Failed to inspect isolated Codex home: {error}"
            )))
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&isolated_home, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                ExternalAgentCommandError::process(format!(
                    "Failed to protect isolated Codex home: {error}"
                ))
            },
        )?;
    }
    Ok(isolated_home)
}

fn link_codex_auth_file(
    source_home: &Path,
    isolated_home: &Path,
) -> Result<(), ExternalAgentCommandError> {
    let source_auth = source_home.join("auth.json");
    let metadata = std::fs::symlink_metadata(&source_auth).map_err(|_| {
        ExternalAgentCommandError::unavailable(
            "Codex authentication is not available as an isolated auth.json credential store.",
        )
    })?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(ExternalAgentCommandError::unavailable(
            "Codex auth.json must be a regular non-symlink file before it can be isolated.",
        ));
    }
    let isolated_auth = isolated_home.join("auth.json");
    if isolated_auth.exists() {
        std::fs::remove_file(&isolated_auth).map_err(|error| {
            ExternalAgentCommandError::process(format!(
                "Failed to refresh isolated Codex authentication: {error}"
            ))
        })?;
    }
    std::fs::hard_link(&source_auth, isolated_auth).map_err(|error| {
        ExternalAgentCommandError::unavailable(format!(
            "Codex authentication could not be isolated without copying credentials: {error}"
        ))
    })
}

fn configure_codex_env(command: &mut Command, codex_home: &Path) {
    configure_restricted_env(command, None);
    command.env("CODEX_HOME", codex_home);
}

pub(crate) fn prepare_isolated_codex_home(
    workspace: &Path,
) -> Result<PathBuf, ExternalAgentCommandError> {
    let source_home = codex_source_home().ok_or_else(|| {
        ExternalAgentCommandError::unavailable(
            "Codex authentication home could not be resolved safely.",
        )
    })?;
    prepare_isolated_codex_home_from(&source_home, workspace)
}

fn prepare_isolated_codex_home_from(
    source_home: &Path,
    workspace: &Path,
) -> Result<PathBuf, ExternalAgentCommandError> {
    let isolated_home = prepare_codex_home_directory(workspace)?;
    link_codex_auth_file(source_home, &isolated_home)?;
    Ok(isolated_home)
}

async fn drain_bounded<R>(mut reader: R) -> Vec<u8>
where
    R: AsyncRead + Unpin,
{
    let mut retained = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let remaining = MAX_DIAGNOSTIC_OUTPUT_BYTES.saturating_sub(retained.len());
                retained.extend_from_slice(&chunk[..count.min(remaining)]);
            }
        }
    }
    retained
}

async fn run_bounded_output(mut command: Command) -> Result<CapturedOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "missing stdout pipe".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "missing stderr pipe".to_string())?;
    let stdout_task = tokio::spawn(drain_bounded(stdout));
    let stderr_task = tokio::spawn(drain_bounded(stderr));
    let status = match tokio::time::timeout(DIAGNOSTIC_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => return Err(error.to_string()),
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("diagnostic command timed out".to_string());
        }
    };
    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    Ok(CapturedOutput {
        success: status.success(),
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
    })
}

fn version_from_output(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|token| {
        let trimmed = token.trim_matches(|character: char| {
            !character.is_ascii_alphanumeric() && character != '.' && character != '-'
        });
        if trimmed.chars().any(|character| character.is_ascii_digit())
            && trimmed.contains('.')
            && trimmed.len() <= 64
        {
            Some(trimmed.to_string())
        } else {
            None
        }
    })
}

pub(crate) async fn diagnose_runtime(
    runtime: ExternalAgentRuntime,
) -> ExternalAgentRuntimeDiagnostic {
    let Some(target) = discover_runtime(runtime) else {
        return ExternalAgentRuntimeDiagnostic::unavailable(runtime);
    };

    let codex_probe = if runtime == ExternalAgentRuntime::Codex {
        match tempfile::Builder::new()
            .prefix("storyboard-codex-diagnostic-")
            .tempdir()
        {
            Ok(workspace) => match prepare_codex_home_directory(workspace.path()) {
                Ok(home) => Some((workspace, home)),
                Err(error) => {
                    return ExternalAgentRuntimeDiagnostic::error(
                        runtime,
                        Some(target.reported_name),
                        error.message,
                    )
                }
            },
            Err(error) => {
                return ExternalAgentRuntimeDiagnostic::error(
                    runtime,
                    Some(target.reported_name),
                    format!("Failed to create an isolated Codex diagnostic home: {error}"),
                )
            }
        }
    } else {
        None
    };

    let mut version_command = target.command();
    version_command.arg("--version");
    if let Some((_, codex_home)) = &codex_probe {
        configure_codex_env(&mut version_command, codex_home);
    } else {
        configure_restricted_env(&mut version_command, None);
    }
    let version_output = match run_bounded_output(version_command).await {
        Ok(output) if output.success => output,
        Ok(output) => {
            let message = if output.stderr.trim().is_empty() {
                &output.stdout
            } else {
                &output.stderr
            };
            return ExternalAgentRuntimeDiagnostic::error(
                runtime,
                Some(target.reported_name),
                redact_text(message),
            );
        }
        Err(error) => {
            return ExternalAgentRuntimeDiagnostic::error(
                runtime,
                Some(target.reported_name),
                redact_text(&error),
            );
        }
    };
    let version = version_from_output(&version_output.stdout)
        .or_else(|| version_from_output(&version_output.stderr));

    let mut help_command = target.command();
    match runtime {
        ExternalAgentRuntime::Codex => {
            help_command.args(["app-server", "--help"]);
        }
        ExternalAgentRuntime::Claude => {
            help_command.arg("--help");
        }
    }
    if let Some((_, codex_home)) = &codex_probe {
        configure_codex_env(&mut help_command, codex_home);
    } else {
        configure_restricted_env(&mut help_command, None);
    }
    let compatible = run_bounded_output(help_command)
        .await
        .map(|output| {
            let text = format!("{}\n{}", output.stdout, output.stderr);
            output.success
                && match runtime {
                    ExternalAgentRuntime::Codex => {
                        text.contains("--listen") && text.contains("stdio://")
                    }
                    ExternalAgentRuntime::Claude => {
                        text.contains("stream-json")
                            && text.contains("--strict-mcp-config")
                            && text.contains("--setting-sources")
                    }
                }
        })
        .unwrap_or(false);

    let authenticated = match runtime {
        ExternalAgentRuntime::Codex => {
            let Some((_, codex_home)) = &codex_probe else {
                return ExternalAgentRuntimeDiagnostic::error(
                    runtime,
                    Some(target.reported_name),
                    "Isolated Codex diagnostic home is unavailable.".to_string(),
                );
            };
            let linked = codex_source_home()
                .as_deref()
                .is_some_and(|source_home| link_codex_auth_file(source_home, codex_home).is_ok());
            if !linked {
                false
            } else {
                let mut auth_command = target.command();
                auth_command.args(["login", "status"]);
                configure_codex_env(&mut auth_command, codex_home);
                run_bounded_output(auth_command)
                    .await
                    .map(|output| {
                        output.success
                            && format!("{}\n{}", output.stdout, output.stderr)
                                .to_ascii_lowercase()
                                .contains("logged in")
                    })
                    .unwrap_or(false)
            }
        }
        ExternalAgentRuntime::Claude => {
            let mut auth_command = target.command();
            auth_command.args(["auth", "status", "--json"]);
            configure_restricted_env(&mut auth_command, None);
            run_bounded_output(auth_command)
                .await
                .map(|output| {
                    output.success
                        && serde_json::from_str::<serde_json::Value>(&output.stdout)
                            .ok()
                            .and_then(|value| value.get("loggedIn").and_then(|item| item.as_bool()))
                            .unwrap_or(false)
                })
                .unwrap_or(false)
        }
    };

    ExternalAgentRuntimeDiagnostic::available(
        runtime,
        target.reported_name,
        version,
        compatible,
        authenticated,
    )
}

pub(crate) fn safe_system_prompt() -> &'static str {
    SAFE_SYSTEM_PROMPT
}

pub(crate) fn concise_process_error(value: &str) -> String {
    truncate_chars(&redact_text(value), 1_024)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toml_path_preserves_spaces_and_quotes_without_shell_escaping() {
        let value = toml_string(r#"C:\Program Files\Canvas \"Agent\"\app.exe"#);
        assert_eq!(
            value,
            r#""C:\\Program Files\\Canvas \\\"Agent\\\"\\app.exe""#
        );
    }

    #[test]
    fn windows_cmd_shim_resolves_only_known_node_entrypoint() {
        let directory = tempfile::tempdir().unwrap();
        let shim = directory.path().join("codex.cmd");
        std::fs::write(&shim, "untrusted contents").unwrap();
        assert!(resolve_windows_npm_shim(&shim, ExternalAgentRuntime::Codex).is_none());

        let node = directory.path().join("node.exe");
        std::fs::write(&node, "node placeholder").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&node).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&node, permissions).unwrap();
        }
        let script = directory
            .path()
            .join("node_modules/@openai/codex/bin/codex.js");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "codex placeholder").unwrap();
        let target = resolve_windows_npm_shim(&shim, ExternalAgentRuntime::Codex).unwrap();
        let command = target.command();
        assert_eq!(command.as_std().get_program(), node);
        let mut args = command.as_std().get_args();
        assert_eq!(args.next(), Some(script.as_os_str()));
        assert_eq!(args.next(), None);
    }

    #[test]
    fn launch_target_keeps_arguments_separate() {
        let target = LaunchTarget::from_direct(
            PathBuf::from("/Applications/Agent Tool/codex"),
            ExternalAgentRuntime::Codex,
        );
        let command = target.command();
        assert_eq!(
            command.as_std().get_program(),
            "/Applications/Agent Tool/codex"
        );
        assert_eq!(command.as_std().get_args().count(), 0);
    }

    #[test]
    fn isolated_codex_home_links_only_auth_file() {
        let root = tempfile::tempdir().unwrap();
        let source_home = root.path().join("source-home");
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(source_home.join("skills/private-skill")).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(source_home.join("auth.json"), r#"{"token":"secret"}"#).unwrap();
        std::fs::write(source_home.join("config.toml"), "mcp_servers = {}\n").unwrap();
        std::fs::write(source_home.join("AGENTS.md"), "user instructions").unwrap();
        std::fs::write(
            source_home.join("skills/private-skill/SKILL.md"),
            "private skill",
        )
        .unwrap();

        let isolated_home = prepare_isolated_codex_home_from(&source_home, &workspace).unwrap();
        let mut entries = std::fs::read_dir(&isolated_home)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        entries.sort();

        assert_eq!(entries, vec![OsString::from("auth.json")]);
        assert!(!isolated_home.join("config.toml").exists());
        assert!(!isolated_home.join("AGENTS.md").exists());
        assert!(!isolated_home.join("skills").exists());

        std::fs::write(isolated_home.join("auth.json"), r#"{"token":"refreshed"}"#).unwrap();
        assert_eq!(
            std::fs::read_to_string(source_home.join("auth.json")).unwrap(),
            r#"{"token":"refreshed"}"#
        );
    }

    #[cfg(unix)]
    #[test]
    fn isolated_codex_home_rejects_symlinked_auth() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let source_home = root.path().join("source-home");
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&source_home).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(root.path().join("real-auth.json"), r#"{"token":"secret"}"#).unwrap();
        symlink(
            root.path().join("real-auth.json"),
            source_home.join("auth.json"),
        )
        .unwrap();

        let error = prepare_isolated_codex_home_from(&source_home, &workspace).unwrap_err();
        assert_eq!(error.code, "runtime_unavailable");
        assert!(!workspace.join("codex-home/auth.json").exists());
    }

    #[test]
    fn codex_command_disables_non_canvas_capabilities_and_uses_isolated_home() {
        let target =
            LaunchTarget::from_direct_for_test(PathBuf::from("codex"), ExternalAgentRuntime::Codex);
        let workspace = PathBuf::from("/tmp/storyboard workspace");
        let codex_home = workspace.join("codex-home");
        let command = build_codex_command(
            &target,
            Path::new("/Applications/Storyboard Canvas.app/Contents/MacOS/app"),
            &workspace,
            &codex_home,
            &BrokerCredentials {
                address: "127.0.0.1:1234".to_string(),
                token: "token".to_string(),
                session_id: "session".to_string(),
            },
        );
        let args = command
            .as_std()
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.iter().any(|value| value == "--strict-config"));
        for capability in [
            "features.shell_tool=false",
            "features.browser_use=false",
            "features.computer_use=false",
            "features.image_generation=false",
            "features.plugins=false",
            "features.workspace_dependencies=false",
        ] {
            assert!(args.iter().any(|value| value == capability));
        }
        assert_eq!(
            command.as_std().get_envs().find_map(|(name, value)| {
                (name == "CODEX_HOME").then(|| value.map(PathBuf::from))
            }),
            Some(Some(codex_home))
        );
    }

    #[test]
    fn claude_command_uses_only_explicit_setting_sources_and_tools() {
        let target = LaunchTarget::from_direct_for_test(
            PathBuf::from("claude"),
            ExternalAgentRuntime::Claude,
        );
        let tool_names = vec!["canvas_command".to_string()];
        let command = build_claude_command(
            &target,
            ClaudeCommandOptions {
                executable: Path::new("/Applications/Storyboard Canvas.app/Contents/MacOS/app"),
                workspace: Path::new("/tmp/storyboard workspace"),
                broker: &BrokerCredentials {
                    address: "127.0.0.1:1234".to_string(),
                    token: "token".to_string(),
                    session_id: "session".to_string(),
                },
                provider_session_id: "00000000-0000-4000-8000-000000000000",
                resume: false,
                model: None,
                tool_names: &tool_names,
                attachment_root: None,
            },
        )
        .unwrap();
        let args = command
            .as_std()
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!args.iter().any(|value| value == "--safe-mode"));
        let setting_sources = args
            .windows(2)
            .find(|pair| pair[0] == "--setting-sources")
            .map(|pair| pair[1].as_str());
        assert_eq!(setting_sources, Some(""));
        let tools = args
            .windows(2)
            .find(|pair| pair[0] == "--tools")
            .map(|pair| pair[1].as_str());
        assert_eq!(tools, Some(""));
        assert!(!args
            .iter()
            .any(|value| value == "--dangerously-skip-permissions"));
    }
}

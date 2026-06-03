use serde::Serialize;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Command;

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

/// Run `dreamina user_credit` and infer install / login / remaining-credit state.
#[tauri::command]
pub async fn check_dreamina_login() -> DreaminaStatus {
    // 1) Try to locate the binary. Tauri subprocesses on macOS frequently launch
    //    with a stripped PATH (missing /usr/local/bin, Homebrew, ~/.local/bin),
    //    so letting std::process::Command do its own PATH lookup often fails
    //    even when the user clearly has `dreamina` on their login shell.
    let binary = match locate_dreamina_binary() {
        Some(p) => p,
        None => {
            return DreaminaStatus {
                installed: false,
                logged_in: false,
                credits: None,
                error: Some("未找到 dreamina CLI 二进制（已检查 PATH / ~/.dreamina / ~/.local/bin / ~/.cargo/bin / /opt/homebrew / /usr/local）".into()),
                network_degraded: false,
                resolved_path: None,
            };
        }
    };

    let resolved_path = binary.to_string_lossy().to_string();

    // 2) Try `dreamina user_credit` first — it's the cheapest way to get the
    //    credit balance AND confirm login in one round trip when the backend
    //    cooperates.
    let mut cmd = Command::new(&binary);
    cmd.arg("user_credit");
    build_cli_env(&mut cmd);
    let output = match cmd.output() {
        Ok(o) => o,
        Err(err) => {
            return DreaminaStatus {
                installed: true,
                logged_in: false,
                credits: None,
                error: Some(format!("执行 {resolved_path} 失败：{err}")),
                network_degraded: false,
                resolved_path: Some(resolved_path),
            };
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let combined = if stderr.is_empty() {
            stdout.clone()
        } else {
            stderr.clone()
        };
        let (is_network, is_auth) = classify_cli_error(&combined);

        // Explicit auth failure → not logged in. This is the only branch that
        // should report `logged_in: false` based on a CLI exit.
        if is_auth && !is_network {
            return DreaminaStatus {
                installed: true,
                logged_in: false,
                credits: None,
                error: Some("检测到 CLI 未登录，运行 `dreamina login` 后重试".into()),
                network_degraded: false,
                resolved_path: Some(resolved_path),
            };
        }

        // Network error or ambiguous error → fall back to `list_task` which
        // reads the local login session token; if that succeeds, the session
        // is intact even though the credit endpoint happens to be down.
        let mut list_cmd = Command::new(&binary);
        list_cmd.arg("list_task");
        build_cli_env(&mut list_cmd);
        if let Ok(list_out) = list_cmd.output() {
            if list_out.status.success() {
                return DreaminaStatus {
                    installed: true,
                    logged_in: true,
                    credits: None,
                    error: Some("已登录，但积分接口暂不可达（网络波动）".into()),
                    network_degraded: true,
                    resolved_path: Some(resolved_path),
                };
            }
            // list_task also failed — inspect its error to decide.
            let ls_stderr = String::from_utf8_lossy(&list_out.stderr).to_string();
            let ls_stdout = String::from_utf8_lossy(&list_out.stdout).to_string();
            let ls_combined = if ls_stderr.is_empty() {
                ls_stdout
            } else {
                ls_stderr
            };
            let (_, ls_auth) = classify_cli_error(&ls_combined);
            if ls_auth {
                return DreaminaStatus {
                    installed: true,
                    logged_in: false,
                    credits: None,
                    error: Some("检测到 CLI 未登录，运行 `dreamina login` 后重试".into()),
                    network_degraded: false,
                    resolved_path: Some(resolved_path),
                };
            }
        }

        // Neither endpoint confirmed anything; bubble up the original error
        // but flag it as network-degraded so the UI doesn't cry wolf about
        // login when it can't actually tell.
        return DreaminaStatus {
            installed: true,
            logged_in: false,
            credits: None,
            error: Some(if is_network {
                format!(
                    "网络不可达，无法确认登录状态：{}",
                    combined.chars().take(200).collect::<String>()
                )
            } else {
                combined.chars().take(400).collect()
            }),
            network_degraded: is_network,
            resolved_path: Some(resolved_path),
        };
    }

    // 3) Success path: try to extract a credit number from stdout. The CLI's
    //    human output varies slightly across versions (e.g. "credits: 12345",
    //    "剩余积分: 12,345", "balance 12345"), so we just pick the first
    //    reasonable integer ≥ 0.
    let credits = stdout
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|s| {
            if s.is_empty() {
                None
            } else {
                s.parse::<i64>().ok()
            }
        })
        .find(|v| *v >= 0);

    DreaminaStatus {
        installed: true,
        logged_in: true,
        credits,
        error: None,
        network_degraded: false,
        resolved_path: Some(resolved_path),
    }
}

// ============================================================================
// Generation commands — thin shell wrappers around `dreamina text2image` and
// `dreamina image2image`. They submit synchronously (with --poll so we block
// until the job resolves or 60s passes) and return the raw JSON/text from
// stdout, which the frontend parses to pull out the submit_id / result URLs.
// The CLI handles auth via the local login session that check_dreamina_login
// already validated.
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreaminaSubmitResult {
    pub ok: bool,
    /// The task submit_id (hex) extracted from the CLI output when detectable.
    pub submit_id: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
}

/// Scan the CLI output for the first 12+ hex-char token that looks like a
/// submit_id. The CLI prints "submit_id=<hex>" in success paths.
fn extract_submit_id(text: &str) -> Option<String> {
    // Match key=value style first.
    for line in text.lines() {
        if let Some(idx) = line.find("submit_id") {
            let after = &line[idx + "submit_id".len()..];
            let after =
                after.trim_start_matches(|c: char| c == ':' || c == '=' || c == ' ' || c == '"');
            let id: String = after
                .chars()
                .take_while(|c| c.is_ascii_hexdigit())
                .collect();
            if id.len() >= 12 {
                return Some(id);
            }
        }
    }
    None
}

async fn run_dreamina_subcommand(args: Vec<String>) -> DreaminaSubmitResult {
    let binary = match locate_dreamina_binary() {
        Some(p) => p,
        None => {
            return DreaminaSubmitResult {
                ok: false,
                submit_id: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some("未找到 dreamina CLI 二进制".into()),
            };
        }
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
        Err(err) => {
            return DreaminaSubmitResult {
                ok: false,
                submit_id: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(format!("执行 dreamina 失败：{err}")),
            };
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let submit_id = extract_submit_id(&stdout).or_else(|| extract_submit_id(&stderr));
    let ok = output.status.success();
    let error = if ok {
        None
    } else {
        let combined = if stderr.is_empty() {
            stdout.clone()
        } else {
            stderr.clone()
        };
        Some(combined.chars().take(400).collect::<String>())
    };
    DreaminaSubmitResult {
        ok,
        submit_id,
        stdout,
        stderr,
        error,
    }
}

#[tauri::command]
pub async fn dreamina_text2image(
    prompt: String,
    model_version: Option<String>,
    ratio: Option<String>,
    resolution_type: Option<String>,
    poll_seconds: Option<u32>,
) -> DreaminaSubmitResult {
    let mut args: Vec<String> = vec!["text2image".into(), format!("--prompt={prompt}")];
    if let Some(m) = model_version {
        args.push(format!("--model_version={m}"));
    }
    if let Some(r) = ratio.filter(|s| s != "auto") {
        args.push(format!("--ratio={r}"));
    }
    if let Some(rt) = resolution_type {
        args.push(format!("--resolution_type={rt}"));
    }
    args.push(format!("--poll={}", poll_seconds.unwrap_or(60)));
    run_dreamina_subcommand(args).await
}

#[tauri::command]
pub async fn dreamina_image2image(
    prompt: String,
    image_paths: Vec<String>,
    model_version: Option<String>,
    ratio: Option<String>,
    resolution_type: Option<String>,
    poll_seconds: Option<u32>,
) -> DreaminaSubmitResult {
    if image_paths.is_empty() {
        return DreaminaSubmitResult {
            ok: false,
            submit_id: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some("image2image 需要至少一张本地图片路径".into()),
        };
    }
    let mut args: Vec<String> = vec!["image2image".into(), format!("--prompt={prompt}")];
    // The CLI accepts --images repeated OR comma-joined; comma is simpler.
    args.push(format!("--images={}", image_paths.join(",")));
    if let Some(m) = model_version {
        args.push(format!("--model_version={m}"));
    }
    if let Some(r) = ratio.filter(|s| s != "auto") {
        args.push(format!("--ratio={r}"));
    }
    if let Some(rt) = resolution_type {
        args.push(format!("--resolution_type={rt}"));
    }
    args.push(format!("--poll={}", poll_seconds.unwrap_or(120)));
    run_dreamina_subcommand(args).await
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
    run_dreamina_subcommand(args).await
}

/// Run `dreamina list_task` and return the full JSON stdout so the caller
/// (frontend gateway) can scan for a specific submit_id + gen_status.
#[tauri::command]
pub async fn dreamina_list_task() -> DreaminaSubmitResult {
    run_dreamina_subcommand(vec!["list_task".into()]).await
}

/// Dreamina HD upscale — single input image, optional resolution tier.
/// Non-VIP users are limited to 2k; 4k/8k require VIP.
#[tauri::command]
pub async fn dreamina_image_upscale(
    image_path: String,
    resolution_type: Option<String>,
    poll_seconds: Option<u32>,
) -> DreaminaSubmitResult {
    if image_path.trim().is_empty() {
        return DreaminaSubmitResult {
            ok: false,
            submit_id: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some("image_upscale 需要一张本地图片路径".into()),
        };
    }
    let mut args: Vec<String> = vec!["image_upscale".into(), format!("--image={image_path}")];
    if let Some(rt) = resolution_type {
        args.push(format!("--resolution_type={rt}"));
    }
    args.push(format!("--poll={}", poll_seconds.unwrap_or(120)));
    run_dreamina_subcommand(args).await
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
        "TLS 握手被中断 —— 这是即梦 CLI 无法生图的根因。常见原因：\n1. 本机防火墙 / 杀软拦截字节跳动域名；\n2. VPN / 代理未放行 jianying.com；\n3. 当前网络/运营商对该域做 TLS 层干扰。\n建议：关闭 VPN 或代理、切到 4G/5G 手机热点、换一个网络重试。另外 CLI 版本 4946b9d-dirty 是 dev 构建，可能被服务端 TLS 指纹限制，可考虑重装最新版 Dreamina CLI。".into()
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

use serde_json::Value;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ParsedCliVersion {
    pub version: Option<String>,
    pub commit: Option<String>,
    pub build_time: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ParsedCredit {
    pub total_credit: Option<i64>,
    pub user_id: Option<String>,
    pub user_name: Option<String>,
    pub vip_level: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ParsedOAuthMaterial {
    pub verification_uri: Option<String>,
    pub user_code: Option<String>,
    pub device_code: Option<String>,
    pub expires_in: Option<i64>,
    pub interval: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParsedSession {
    pub id: i64,
    pub name: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CommandExpectation {
    Submit,
    Query,
    Utility,
}

#[derive(Debug, Default, Eq, PartialEq)]
pub(crate) struct ParsedCliOutput {
    pub submit_id: Option<String>,
    pub gen_status: Option<String>,
    pub fail_reason: Option<String>,
    pub compliance_required: bool,
}

fn find_json_value<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    match value {
        Value::Object(map) => {
            for (key, item) in map {
                if keys
                    .iter()
                    .any(|candidate| key.eq_ignore_ascii_case(candidate))
                {
                    return Some(item);
                }
            }
            map.values().find_map(|item| find_json_value(item, keys))
        }
        Value::Array(items) => items.iter().find_map(|item| find_json_value(item, keys)),
        _ => None,
    }
}

fn json_value_as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn json_value_as_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn parse_json_candidates(text: &str) -> Vec<Value> {
    let mut values = Vec::new();
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        values.push(value);
        return values;
    }
    for line in text.lines() {
        if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
            values.push(value);
        }
    }
    if values.is_empty() {
        if let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) {
            if start < end {
                if let Ok(value) = serde_json::from_str::<Value>(&text[start..=end]) {
                    values.push(value);
                }
            }
        }
    }
    values
}

fn extract_text_token(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        let index = lower.find(&key.to_ascii_lowercase())?;
        let after = line[index + key.len()..].trim_start_matches(|character: char| {
            character == ':'
                || character == '='
                || character == ' '
                || character == '\t'
                || character == '"'
                || character == '\''
        });
        let token: String = after
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            })
            .collect();
        if !token.is_empty() {
            return Some(token);
        }
    }
    None
}

fn extract_text_line_value(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(index) = lower.find(&key.to_ascii_lowercase()) {
            let value = line[index + key.len()..]
                .trim_start_matches(|character: char| {
                    character == ':'
                        || character == '='
                        || character == ' '
                        || character == '\t'
                        || character == '"'
                        || character == '\''
                })
                .trim_end_matches(['"', '\''])
                .trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

pub(crate) fn parse_cli_output(stdout: &str, stderr: &str) -> ParsedCliOutput {
    let combined = format!("{stdout}\n{stderr}");
    let values = parse_json_candidates(stdout)
        .into_iter()
        .chain(parse_json_candidates(stderr));
    let mut parsed = ParsedCliOutput::default();
    for value in values {
        if parsed.submit_id.is_none() {
            parsed.submit_id =
                find_json_value(&value, &["submit_id", "submitId"]).and_then(json_value_as_string);
        }
        if parsed.gen_status.is_none() {
            parsed.gen_status = find_json_value(&value, &["gen_status", "genStatus", "status"])
                .and_then(json_value_as_string)
                .map(|status| status.to_ascii_lowercase());
        }
        if parsed.fail_reason.is_none() {
            parsed.fail_reason =
                find_json_value(&value, &["fail_reason", "failReason", "error", "message"])
                    .and_then(json_value_as_string);
        }
    }
    parsed.submit_id = parsed
        .submit_id
        .or_else(|| extract_text_token(&combined, "submit_id"));
    parsed.gen_status = parsed
        .gen_status
        .or_else(|| extract_text_token(&combined, "gen_status"))
        .map(|status| status.to_ascii_lowercase());
    parsed.fail_reason = parsed
        .fail_reason
        .or_else(|| extract_text_line_value(&combined, "fail_reason"));
    parsed.compliance_required = combined.contains("AigcComplianceConfirmationRequired");
    if parsed.compliance_required && parsed.fail_reason.is_none() {
        parsed.fail_reason = Some("AigcComplianceConfirmationRequired".to_string());
    }
    parsed
}

fn first_json_candidate(text: &str) -> Option<Value> {
    parse_json_candidates(text).into_iter().next()
}

pub(crate) fn parse_cli_version(text: &str) -> ParsedCliVersion {
    let value = first_json_candidate(text);
    ParsedCliVersion {
        version: value
            .as_ref()
            .and_then(|value| find_json_value(value, &["version"]))
            .and_then(json_value_as_string),
        commit: value
            .as_ref()
            .and_then(|value| find_json_value(value, &["commit"]))
            .and_then(json_value_as_string),
        build_time: value
            .as_ref()
            .and_then(|value| find_json_value(value, &["build_time", "buildTime"]))
            .and_then(json_value_as_string),
    }
}

pub(crate) fn parse_credit(text: &str) -> ParsedCredit {
    let value = first_json_candidate(text);
    ParsedCredit {
        total_credit: value
            .as_ref()
            .and_then(|value| find_json_value(value, &["total_credit", "totalCredit", "credits"]))
            .and_then(json_value_as_i64),
        user_id: value
            .as_ref()
            .and_then(|value| find_json_value(value, &["user_id", "userId"]))
            .and_then(json_value_as_string),
        user_name: value
            .as_ref()
            .and_then(|value| find_json_value(value, &["user_name", "userName"]))
            .and_then(json_value_as_string),
        vip_level: value
            .as_ref()
            .and_then(|value| find_json_value(value, &["vip_level", "vipLevel"]))
            .and_then(json_value_as_string),
    }
}

pub(crate) fn parse_oauth_material(text: &str) -> ParsedOAuthMaterial {
    let value = first_json_candidate(text);
    let json_string = |keys: &[&str]| {
        value
            .as_ref()
            .and_then(|value| find_json_value(value, keys))
            .and_then(json_value_as_string)
    };
    let json_i64 = |keys: &[&str]| {
        value
            .as_ref()
            .and_then(|value| find_json_value(value, keys))
            .and_then(json_value_as_i64)
    };
    ParsedOAuthMaterial {
        verification_uri: json_string(&["verification_uri", "verificationUri"])
            .or_else(|| extract_text_line_value(text, "verification_uri")),
        user_code: json_string(&["user_code", "userCode"])
            .or_else(|| extract_text_token(text, "user_code")),
        device_code: json_string(&["device_code", "deviceCode"])
            .or_else(|| extract_text_token(text, "device_code")),
        expires_in: json_i64(&["expires_in", "expiresIn"]),
        interval: json_i64(&["interval"]),
    }
}

fn collect_sessions(value: &Value, sessions: &mut Vec<ParsedSession>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_sessions(item, sessions);
            }
        }
        Value::Object(map) => {
            let id = ["session_id", "sessionId", "id"]
                .iter()
                .find_map(|key| map.get(*key))
                .and_then(json_value_as_i64);
            let name = ["session_name", "sessionName", "name", "title"]
                .iter()
                .find_map(|key| map.get(*key))
                .and_then(json_value_as_string);
            if let Some(id) = id {
                sessions.push(ParsedSession {
                    id,
                    name: name.unwrap_or_else(|| {
                        if id == 0 {
                            "Default".to_string()
                        } else {
                            format!("Session {id}")
                        }
                    }),
                });
                return;
            }
            for item in map.values() {
                collect_sessions(item, sessions);
            }
        }
        _ => {}
    }
}

fn collect_table_sessions(text: &str, sessions: &mut Vec<ParsedSession>) {
    for line in text.lines() {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 5 {
            continue;
        }
        let Some(id) = columns.first().and_then(|value| value.parse::<i64>().ok()) else {
            continue;
        };
        let pinned = columns[columns.len() - 3];
        let updated_date = columns[columns.len() - 2];
        let updated_time = columns[columns.len() - 1];
        if !matches!(pinned, "Yes" | "No")
            || updated_date.matches('-').count() != 2
            || !updated_time.contains(':')
        {
            continue;
        }
        let name = columns[1..columns.len() - 3].join(" ");
        sessions.push(ParsedSession {
            id,
            name: if name.is_empty() {
                if id == 0 {
                    "Default".to_string()
                } else {
                    format!("Session {id}")
                }
            } else {
                name
            },
        });
    }
}

pub(crate) fn parse_sessions(text: &str) -> Vec<ParsedSession> {
    let mut sessions = Vec::new();
    for value in parse_json_candidates(text) {
        collect_sessions(&value, &mut sessions);
    }
    collect_table_sessions(text, &mut sessions);
    sessions.sort_by_key(|session| session.id);
    sessions.dedup_by_key(|session| session.id);
    if sessions.iter().all(|session| session.id != 0) {
        sessions.insert(
            0,
            ParsedSession {
                id: 0,
                name: "Default".to_string(),
            },
        );
    }
    sessions
}

pub(crate) fn command_succeeded(
    exit_success: bool,
    expectation: CommandExpectation,
    parsed: &ParsedCliOutput,
) -> bool {
    if !exit_success {
        return false;
    }
    match expectation {
        CommandExpectation::Submit => {
            parsed.submit_id.is_some()
                && matches!(parsed.gen_status.as_deref(), Some("querying" | "success"))
        }
        CommandExpectation::Query => parsed.gen_status.as_deref() != Some("fail"),
        CommandExpectation::Utility => true,
    }
}

fn push_session(args: &mut Vec<String>, session_id: Option<i64>) -> Result<(), String> {
    if let Some(session_id) = session_id {
        if session_id < 0 {
            return Err("Dreamina session id cannot be negative.".to_string());
        }
        args.push(format!("--session={session_id}"));
    }
    Ok(())
}

fn push_nonempty(args: &mut Vec<String>, name: &str, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        args.push(format!("--{name}={value}"));
    }
}

fn clean_paths(paths: &[String]) -> Vec<&str> {
    paths
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .collect()
}

pub(crate) fn build_text2image_args(
    prompt: &str,
    model_version: Option<&str>,
    ratio: Option<&str>,
    resolution_type: Option<&str>,
    session_id: Option<i64>,
    poll_seconds: u32,
) -> Result<Vec<String>, String> {
    let mut args = vec!["text2image".to_string(), format!("--prompt={prompt}")];
    push_nonempty(&mut args, "model_version", model_version);
    push_nonempty(
        &mut args,
        "ratio",
        ratio.filter(|ratio| !ratio.eq_ignore_ascii_case("auto")),
    );
    push_nonempty(&mut args, "resolution_type", resolution_type);
    push_session(&mut args, session_id)?;
    args.push(format!("--poll={poll_seconds}"));
    Ok(args)
}

pub(crate) fn build_image2image_args(
    prompt: &str,
    image_paths: &[String],
    model_version: Option<&str>,
    ratio: Option<&str>,
    resolution_type: Option<&str>,
    session_id: Option<i64>,
    poll_seconds: u32,
) -> Result<Vec<String>, String> {
    let paths: Vec<&str> = image_paths
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .collect();
    if !(1..=10).contains(&paths.len()) {
        return Err("Dreamina image2image requires 1-10 input images.".to_string());
    }
    let mut args = vec![
        "image2image".to_string(),
        format!("--prompt={prompt}"),
        format!("--images={}", paths.join(",")),
    ];
    push_nonempty(&mut args, "model_version", model_version);
    push_nonempty(
        &mut args,
        "ratio",
        ratio.filter(|ratio| !ratio.eq_ignore_ascii_case("auto")),
    );
    push_nonempty(&mut args, "resolution_type", resolution_type);
    push_session(&mut args, session_id)?;
    args.push(format!("--poll={poll_seconds}"));
    Ok(args)
}

pub(crate) fn build_image_upscale_args(
    image_path: &str,
    resolution_type: Option<&str>,
    session_id: Option<i64>,
    poll_seconds: u32,
) -> Result<Vec<String>, String> {
    if image_path.trim().is_empty() {
        return Err("Dreamina image_upscale requires one input image.".to_string());
    }
    let mut args = vec![
        "image_upscale".to_string(),
        format!("--image={}", image_path.trim()),
    ];
    push_nonempty(&mut args, "resolution_type", resolution_type);
    push_session(&mut args, session_id)?;
    args.push(format!("--poll={poll_seconds}"));
    Ok(args)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_video_args(
    command: &str,
    prompt: &str,
    image_paths: &[String],
    model_version: Option<&str>,
    ratio: Option<&str>,
    duration: Option<u32>,
    video_resolution: Option<&str>,
    session_id: Option<i64>,
    poll_seconds: u32,
) -> Result<Vec<String>, String> {
    let mut args = vec![command.to_string()];
    match command {
        "text2video" => {}
        "image2video" if image_paths.len() == 1 && !image_paths[0].trim().is_empty() => {
            args.push(format!("--image={}", image_paths[0].trim()));
        }
        "frames2video"
            if image_paths.len() == 2 && image_paths.iter().all(|path| !path.trim().is_empty()) =>
        {
            args.push(format!("--first={}", image_paths[0].trim()));
            args.push(format!("--last={}", image_paths[1].trim()));
        }
        "image2video" => return Err("Dreamina image2video requires one image.".to_string()),
        "frames2video" => {
            return Err("Dreamina frames2video requires exactly two images.".to_string())
        }
        _ => return Err(format!("Unsupported Dreamina video command: {command}.")),
    }
    args.push(format!("--prompt={prompt}"));
    push_nonempty(&mut args, "model_version", model_version);
    push_nonempty(
        &mut args,
        "ratio",
        ratio.filter(|ratio| !ratio.eq_ignore_ascii_case("auto")),
    );
    if let Some(duration) = duration {
        args.push(format!("--duration={duration}"));
    }
    push_nonempty(&mut args, "video_resolution", video_resolution);
    push_session(&mut args, session_id)?;
    args.push(format!("--poll={poll_seconds}"));
    Ok(args)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_multiframe_args(
    image_paths: &[String],
    prompt: Option<&str>,
    duration: Option<f64>,
    transition_prompts: Option<&[String]>,
    transition_durations: Option<&[String]>,
    video_resolution: &str,
    session_id: Option<i64>,
    poll_seconds: u32,
) -> Result<Vec<String>, String> {
    let paths: Vec<&str> = image_paths
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .collect();
    if !(2..=20).contains(&paths.len()) {
        return Err("Dreamina multiframe2video requires 2-20 images.".to_string());
    }
    if !matches!(video_resolution.trim(), "720p" | "1080p") {
        return Err("Dreamina multiframe2video resolution must be 720p or 1080p.".to_string());
    }
    let mut args = vec![
        "multiframe2video".to_string(),
        format!("--images={}", paths.join(",")),
    ];
    if paths.len() == 2 {
        let prompt = prompt
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
            .ok_or_else(|| "Dreamina two-image multiframe mode requires a prompt.".to_string())?;
        args.push(format!("--prompt={prompt}"));
        if let Some(duration) = duration {
            if !(2.0..=8.0).contains(&duration) {
                return Err(
                    "Dreamina two-image duration must be between 2 and 8 seconds.".to_string(),
                );
            }
            args.push(format!("--duration={duration}"));
        }
    } else {
        let expected = paths.len() - 1;
        let prompts = transition_prompts.unwrap_or_default();
        if prompts.len() != expected || prompts.iter().any(|prompt| prompt.trim().is_empty()) {
            return Err(format!(
                "Dreamina {}-image multiframe mode requires exactly {expected} non-empty transition prompts.",
                paths.len()
            ));
        }
        for prompt in prompts {
            args.push(format!("--transition-prompt={}", prompt.trim()));
        }
        let durations = transition_durations.unwrap_or_default();
        if !durations.is_empty() {
            if durations.len() != expected {
                return Err(format!(
                    "Dreamina {}-image multiframe mode requires exactly {expected} transition durations or none.",
                    paths.len()
                ));
            }
            let mut total = 0.0;
            for raw_duration in durations {
                let duration = raw_duration.trim().parse::<f64>().map_err(|_| {
                    format!("Invalid Dreamina transition duration: {raw_duration}.")
                })?;
                if !(1.0..=8.0).contains(&duration) {
                    return Err(
                        "Dreamina transition durations must be between 1 and 8 seconds."
                            .to_string(),
                    );
                }
                total += duration;
                args.push(format!("--transition-duration={duration}"));
            }
            if total < 2.0 {
                return Err(
                    "Dreamina total transition duration must be at least 2 seconds.".to_string(),
                );
            }
        }
    }
    args.push(format!("--video_resolution={}", video_resolution.trim()));
    push_session(&mut args, session_id)?;
    args.push(format!("--poll={poll_seconds}"));
    Ok(args)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_multimodal_args(
    prompt: &str,
    image_paths: &[String],
    video_paths: &[String],
    audio_paths: &[String],
    model_version: Option<&str>,
    ratio: Option<&str>,
    duration: Option<u32>,
    video_resolution: Option<&str>,
    session_id: Option<i64>,
    poll_seconds: u32,
) -> Result<Vec<String>, String> {
    let images = clean_paths(image_paths);
    let videos = clean_paths(video_paths);
    let audios = clean_paths(audio_paths);
    let model = model_version
        .map(str::trim)
        .filter(|model| !model.is_empty());
    let is_25 = model == Some("seedance2.5");
    let (max_images, max_videos, max_audios, max_total) = if is_25 {
        (30, 10, 10, 50)
    } else {
        (9, 3, 3, 12)
    };
    if images.len() > max_images
        || videos.len() > max_videos
        || audios.len() > max_audios
        || images.len() + videos.len() + audios.len() > max_total
    {
        return Err("Dreamina multimodal reference limits were exceeded.".to_string());
    }
    if is_25 {
        if images.is_empty() && videos.is_empty() && audios.is_empty() {
            return Err("Dreamina Seedance 2.5 requires at least one media reference.".to_string());
        }
    } else if images.is_empty() && videos.is_empty() {
        return Err("Dreamina Seedance 2.0 requires an image or video reference.".to_string());
    }
    let mut args = vec!["multimodal2video".to_string()];
    push_nonempty(&mut args, "prompt", Some(prompt));
    for path in images {
        args.push(format!("--image={path}"));
    }
    for path in videos {
        args.push(format!("--video={path}"));
    }
    for path in audios {
        args.push(format!("--audio={path}"));
    }
    push_nonempty(&mut args, "model_version", model);
    push_nonempty(
        &mut args,
        "ratio",
        ratio.filter(|ratio| !ratio.eq_ignore_ascii_case("auto")),
    );
    if let Some(duration) = duration {
        args.push(format!("--duration={duration}"));
    }
    push_nonempty(&mut args, "video_resolution", video_resolution);
    push_session(&mut args, session_id)?;
    args.push(format!("--poll={poll_seconds}"));
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(count: usize) -> Vec<String> {
        (0..count)
            .map(|index| format!("/tmp/{index}.png"))
            .collect()
    }

    #[test]
    fn parses_uuid_submit_id_and_strict_status() {
        let parsed = parse_cli_output(
            r#"{"submit_id":"be6ad4e0-ecbd-4d70-8ace-5d0995c39832","gen_status":"querying"}"#,
            "",
        );
        assert_eq!(
            parsed.submit_id.as_deref(),
            Some("be6ad4e0-ecbd-4d70-8ace-5d0995c39832")
        );
        assert!(command_succeeded(true, CommandExpectation::Submit, &parsed));
    }

    #[test]
    fn exit_zero_without_submit_contract_is_not_submit_success() {
        let parsed = parse_cli_output("done", "");
        assert!(!command_succeeded(
            true,
            CommandExpectation::Submit,
            &parsed
        ));
        assert!(command_succeeded(
            true,
            CommandExpectation::Utility,
            &parsed
        ));
    }

    #[test]
    fn parses_fail_and_compliance_output() {
        let parsed = parse_cli_output(
            r#"{"submit_id":"abc-12345","gen_status":"fail","fail_reason":"AigcComplianceConfirmationRequired"}"#,
            "",
        );
        assert_eq!(parsed.gen_status.as_deref(), Some("fail"));
        assert!(parsed.compliance_required);
        assert!(!command_succeeded(
            true,
            CommandExpectation::Submit,
            &parsed
        ));
    }

    #[test]
    fn adds_session_to_every_generator_builder() {
        let image =
            build_text2image_args("prompt", Some("5.0Pro"), None, Some("4k"), Some(42), 0).unwrap();
        assert!(image.contains(&"--session=42".to_string()));
        let video = build_video_args(
            "text2video",
            "prompt",
            &[],
            Some("seedance2.5"),
            Some("16:9"),
            Some(30),
            Some("720p"),
            Some(42),
            0,
        )
        .unwrap();
        assert!(video.contains(&"--session=42".to_string()));
        let multiframe = build_multiframe_args(
            &paths(2),
            Some("move"),
            Some(3.0),
            None,
            None,
            "1080p",
            Some(42),
            0,
        )
        .unwrap();
        assert!(multiframe.contains(&"--session=42".to_string()));
        let multimodal = build_multimodal_args(
            "prompt",
            &paths(1),
            &[],
            &[],
            Some("seedance2.5"),
            Some("16:9"),
            Some(30),
            Some("720p"),
            Some(42),
            0,
        )
        .unwrap();
        assert!(multimodal.contains(&"--session=42".to_string()));
    }

    #[test]
    fn validates_multiframe_segment_cardinality_and_resolution() {
        let error = build_multiframe_args(
            &paths(4),
            None,
            None,
            Some(&["a".into(), "b".into()]),
            None,
            "1080p",
            None,
            0,
        )
        .unwrap_err();
        assert!(error.contains("exactly 3"));
        assert!(build_multiframe_args(
            &paths(4),
            None,
            None,
            Some(&["a".into(), "b".into(), "c".into()]),
            Some(&["2".into(), "2".into(), "2".into()]),
            "1080p",
            None,
            0,
        )
        .is_ok());
        assert!(
            build_multiframe_args(&paths(2), Some("move"), None, None, None, "4k", None, 0)
                .is_err()
        );
    }

    #[test]
    fn allows_seedance_25_audio_only_but_not_seedance_20() {
        let audios = vec!["/tmp/ref.mp3".to_string()];
        assert!(build_multimodal_args(
            "prompt",
            &[],
            &[],
            &audios,
            Some("seedance2.5"),
            None,
            Some(4),
            Some("720p"),
            None,
            0
        )
        .is_ok());
        assert!(build_multimodal_args(
            "prompt",
            &[],
            &[],
            &audios,
            Some("seedance2.0"),
            None,
            Some(4),
            Some("720p"),
            None,
            0
        )
        .is_err());
    }

    #[test]
    fn parses_version_credit_oauth_and_sessions_fixtures() {
        assert_eq!(
            parse_cli_version(
                r#"{"version":"a857341-dirty","commit":"a857341","build_time":"2026-07-31T16:28:32Z"}"#
            ),
            ParsedCliVersion {
                version: Some("a857341-dirty".into()),
                commit: Some("a857341".into()),
                build_time: Some("2026-07-31T16:28:32Z".into()),
            }
        );
        assert_eq!(
            parse_credit(
                r#"{"total_credit":9367,"user_id":3323179526007913,"user_name":"director","vip_level":"maestro"}"#
            ),
            ParsedCredit {
                total_credit: Some(9367),
                user_id: Some("3323179526007913".into()),
                user_name: Some("director".into()),
                vip_level: Some("maestro".into()),
            }
        );
        assert_eq!(
            parse_oauth_material(
                r#"{"verification_uri":"https://example.test/device","user_code":"ABCD-EFGH","device_code":"device-123","expires_in":600,"interval":5}"#
            ),
            ParsedOAuthMaterial {
                verification_uri: Some("https://example.test/device".into()),
                user_code: Some("ABCD-EFGH".into()),
                device_code: Some("device-123".into()),
                expires_in: Some(600),
                interval: Some(5),
            }
        );
        assert_eq!(
            parse_sessions(
                r#"{"sessions":[{"id":0,"name":"Default"},{"session_id":42,"session_name":"Shots"}]}"#
            ),
            vec![
                ParsedSession {
                    id: 0,
                    name: "Default".into()
                },
                ParsedSession {
                    id: 42,
                    name: "Shots".into()
                },
            ]
        );
        assert_eq!(
            parse_sessions(
                "ID              NAME                        PINNED  UPDATED_AT\n\
                 --------------  --------------------------  ------  ----------------\n\
                 0               default                     Yes     2026-05-20 21:10\n\
                 18189620084492  Music Video Project         No      2026-08-03 19:23\n\
                 17901661068300  视频主角替换                  No      2026-07-31 20:16"
            ),
            vec![
                ParsedSession {
                    id: 0,
                    name: "default".into()
                },
                ParsedSession {
                    id: 17_901_661_068_300,
                    name: "视频主角替换".into()
                },
                ParsedSession {
                    id: 18_189_620_084_492,
                    name: "Music Video Project".into()
                },
            ]
        );
    }
}

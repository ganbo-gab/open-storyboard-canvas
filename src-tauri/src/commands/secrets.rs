use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::sync::{LazyLock, Mutex};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use keyring::v1 as keyring;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(target_os = "macos")]
#[path = "secrets_macos.rs"]
mod macos;

const SERVICE_PREFIX: &str = "com.storyboard-copilot.credentials";
const TOKEN_PREFIX: &str = "__SC_SECRET_";
const TOKEN_SUFFIX: &str = "__";

/// Public, non-secret identity. Namespace and id are validated before backend access.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SecretRef {
    pub namespace: String,
    pub id: String,
}

impl SecretRef {
    pub fn validate(&self) -> Result<(), SecretError> {
        if !matches!(
            self.namespace.as_str(),
            "channel" | "provider" | "settings" | "image-host" | "agent-model" | "comfyui"
        ) || self.id.is_empty()
            || self.id.len() > 512
            || self.id.trim() != self.id
            || self.id.chars().any(char::is_control)
        {
            return Err(SecretError::error("invalid_ref"));
        }
        Ok(())
    }

    pub fn token(&self) -> Result<String, SecretError> {
        self.validate()?;
        let json = serde_json::to_vec(self).map_err(|_| SecretError::error("invalid_ref"))?;
        Ok(format!(
            "{TOKEN_PREFIX}{}{TOKEN_SUFFIX}",
            URL_SAFE_NO_PAD.encode(json)
        ))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretErrorState {
    Locked,
    Error,
}

/// Only fixed codes cross IPC or enter diagnostics; backend errors can contain secrets.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct SecretError {
    pub state: SecretErrorState,
    pub code: &'static str,
}

impl SecretError {
    pub fn error(code: &'static str) -> Self {
        Self {
            state: SecretErrorState::Error,
            code,
        }
    }

    fn locked() -> Self {
        Self {
            state: SecretErrorState::Locked,
            code: "storage_locked",
        }
    }
}

impl fmt::Display for SecretError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let state = match self.state {
            SecretErrorState::Locked => "locked",
            SecretErrorState::Error => "error",
        };
        write!(
            formatter,
            "{{\"state\":\"{state}\",\"code\":\"{}\"}}",
            self.code
        )
    }
}

impl std::error::Error for SecretError {}

trait SecretBackend: Send + Sync {
    fn get(&self, reference: &SecretRef) -> Result<Option<String>, SecretError>;
    fn has(&self, reference: &SecretRef) -> Result<bool, SecretError> {
        self.get(reference).map(|value| value.is_some())
    }
    fn set(&self, reference: &SecretRef, value: &str) -> Result<(), SecretError>;
    fn delete(&self, reference: &SecretRef) -> Result<(), SecretError>;
}

struct KeyringBackend;

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn map_keyring_error(error: &keyring::Error) -> SecretError {
    map_keyring_error_for_platform(error, cfg!(target_os = "windows"))
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn map_keyring_error_for_platform(error: &keyring::Error, windows_native: bool) -> SecretError {
    match error {
        #[cfg(target_os = "macos")]
        keyring::Error::NoStorageAccess(error) | keyring::Error::PlatformFailure(error)
            if error
                .downcast_ref::<security_framework::base::Error>()
                .is_some_and(|error| macos::is_storage_unavailable_status(error.code())) =>
        {
            SecretError::error("storage_unavailable")
        }
        // windows-native-keyring-store 1.1.0 emits this variant only for
        // ERROR_NO_SUCH_LOGON_SESSION (1312), not an authorization refusal.
        // A temporarily unavailable login session must not poison the process.
        keyring::Error::NoStorageAccess(_) if windows_native => {
            SecretError::error("storage_unavailable")
        }
        keyring::Error::NoStorageAccess(_) => SecretError::locked(),
        #[cfg(target_os = "macos")]
        keyring::Error::PlatformFailure(error)
            if error
                .downcast_ref::<security_framework::base::Error>()
                .is_some_and(|error| macos::is_access_denied_status(error.code())) =>
        {
            SecretError::locked()
        }
        keyring::Error::BadEncoding(_) => SecretError::error("invalid_encoding"),
        keyring::Error::Ambiguous(_) => SecretError::error("ambiguous_entry"),
        keyring::Error::NoDefaultStore => SecretError::error("storage_unavailable"),
        _ => SecretError::error("storage_failed"),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn keyring_entry(reference: &SecretRef) -> Result<keyring::Entry, SecretError> {
    if let Err(error) = keyring::Entry::store_status() {
        return Err(map_keyring_error(error));
    }
    keyring::Entry::new(
        &format!("{SERVICE_PREFIX}.{}", reference.namespace),
        &reference.id,
    )
    .map_err(|error| map_keyring_error(&error))
}

impl SecretBackend for KeyringBackend {
    #[cfg(target_os = "macos")]
    fn has(&self, reference: &SecretRef) -> Result<bool, SecretError> {
        macos::contains(reference)
    }

    fn get(&self, reference: &SecretRef) -> Result<Option<String>, SecretError> {
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        {
            match keyring_entry(reference)?.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(map_keyring_error(&error)),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            let _ = reference;
            Err(SecretError::error("storage_unavailable"))
        }
    }

    fn set(&self, reference: &SecretRef, value: &str) -> Result<(), SecretError> {
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        {
            keyring_entry(reference)?
                .set_password(value)
                .map_err(|error| map_keyring_error(&error))
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            let _ = (reference, value);
            Err(SecretError::error("storage_unavailable"))
        }
    }

    fn delete(&self, reference: &SecretRef) -> Result<(), SecretError> {
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        {
            match keyring_entry(reference)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(map_keyring_error(&error)),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            let _ = reference;
            Err(SecretError::error("storage_unavailable"))
        }
    }
}

// Native process memory only. Neither this state nor its values implement Debug/Serialize.
// Authorization follows this process session, not an application idle timer or wall clock.
// Explicit replacement/deletion/retry clears this ref; real OS denials remain blocked.
enum CredentialAccess {
    Granted { value: String },
    Blocked(SecretError),
}

struct SecretVault<B> {
    backend: B,
    // Serialize native operations, including set + read-back, across commands/jobs.
    access: Mutex<HashMap<SecretRef, CredentialAccess>>,
}

impl<B: SecretBackend> SecretVault<B> {
    fn new(backend: B) -> Self {
        Self {
            backend,
            access: Mutex::new(HashMap::new()),
        }
    }

    fn get(&self, reference: &SecretRef) -> Result<Option<String>, SecretError> {
        reference.validate()?;
        let mut access = self
            .access
            .lock()
            .map_err(|_| SecretError::error("storage_failed"))?;
        match access.get_mut(reference) {
            Some(CredentialAccess::Granted { value }) => Ok(Some(value.clone())),
            Some(CredentialAccess::Blocked(error)) => Err(*error),
            None => self.read_and_remember(reference, &mut access),
        }
    }

    fn read_and_remember(
        &self,
        reference: &SecretRef,
        access: &mut HashMap<SecretRef, CredentialAccess>,
    ) -> Result<Option<String>, SecretError> {
        let result = self.backend.get(reference);
        match &result {
            Ok(Some(value)) => {
                access.insert(
                    reference.clone(),
                    CredentialAccess::Granted {
                        value: value.clone(),
                    },
                );
            }
            Ok(None) => {
                access.remove(reference);
            }
            // A real OS denial is sticky until the user explicitly retries. Other
            // storage failures are transient and must be retried on the next
            // explicit request instead of poisoning this process session.
            Err(error) if error.state == SecretErrorState::Locked => {
                access.insert(reference.clone(), CredentialAccess::Blocked(*error));
            }
            Err(_) => {
                access.remove(reference);
            }
        }
        result
    }

    // Only an explicit user recovery action crosses this boundary after a denial.
    fn retry_access(&self, reference: &SecretRef) -> Result<bool, SecretError> {
        reference.validate()?;
        let mut access = self
            .access
            .lock()
            .map_err(|_| SecretError::error("storage_failed"))?;
        access.remove(reference);
        self.read_and_remember(reference, &mut access)
            .map(|value| value.is_some())
    }

    fn set(&self, reference: &SecretRef, value: &str) -> Result<(), SecretError> {
        reference.validate()?;
        let mut access = self
            .access
            .lock()
            .map_err(|_| SecretError::error("storage_failed"))?;
        access.remove(reference);
        if let Err(error) = self.backend.set(reference, value) {
            if error.state == SecretErrorState::Locked {
                access.insert(reference.clone(), CredentialAccess::Blocked(error));
            } else {
                access.remove(reference);
            }
            return Err(error);
        }
        if self.read_and_remember(reference, &mut access)?.as_deref() != Some(value) {
            let error = SecretError::error("verification_failed");
            // A successful write whose read-back cannot be verified is not safe
            // to use implicitly; require an explicit retry instead.
            access.insert(reference.clone(), CredentialAccess::Blocked(error));
            return Err(error);
        }
        Ok(())
    }

    fn delete(&self, reference: &SecretRef) -> Result<(), SecretError> {
        reference.validate()?;
        let mut access = self
            .access
            .lock()
            .map_err(|_| SecretError::error("storage_failed"))?;
        access.remove(reference);
        let result = self.backend.delete(reference);
        if let Err(error) = result {
            if error.state == SecretErrorState::Locked {
                access.insert(reference.clone(), CredentialAccess::Blocked(error));
            } else {
                access.remove(reference);
            }
        }
        result
    }

    fn has(&self, reference: &SecretRef) -> Result<bool, SecretError> {
        reference.validate()?;
        let access = self
            .access
            .lock()
            .map_err(|_| SecretError::error("storage_failed"))?;
        // Windows' default probe reads the credential. Reuse known session state
        // so metadata refresh cannot re-open access or overwrite a successful
        // read with a transient storage failure. A probe never unblocks a denial.
        match access.get(reference) {
            Some(CredentialAccess::Granted { .. }) => return Ok(true),
            Some(CredentialAccess::Blocked(error)) => return Err(*error),
            None => {}
        }
        self.backend.has(reference)
    }
}

fn native_vault() -> &'static SecretVault<KeyringBackend> {
    static VAULT: LazyLock<SecretVault<KeyringBackend>> =
        LazyLock::new(|| SecretVault::new(KeyringBackend));
    &VAULT
}

/// Resolve only at the native request boundary. Missing credentials fail closed.
pub fn resolve_required(reference: &SecretRef) -> Result<String, SecretError> {
    native_vault()
        .get(reference)?
        .ok_or_else(|| SecretError::error("credential_missing"))
}

pub struct ResolvedCredential {
    pub value: String,
    pub redactor: SecretRedactor,
}

pub fn resolve_provider_credential(
    configured: Option<&SecretRef>,
    explicit: Option<&Value>,
) -> Result<ResolvedCredential, SecretError> {
    let explicit_ref = explicit
        .map(|value| {
            serde_json::from_value::<SecretRef>(value.clone())
                .map_err(|_| SecretError::error("invalid_ref"))
        })
        .transpose()?;
    let reference = explicit_ref
        .as_ref()
        .or(configured)
        .ok_or_else(|| SecretError::error("credential_missing"))?;
    let value = resolve_required(reference)?;
    let mut redactor = SecretRedactor::default();
    redactor.record(reference, &value)?;
    Ok(ResolvedCredential { value, redactor })
}

fn parse_token(input: &str) -> Result<(SecretRef, usize), SecretError> {
    let encoded = input
        .strip_prefix(TOKEN_PREFIX)
        .ok_or_else(|| SecretError::error("invalid_ref"))?;
    // Base64url can itself contain '__'; accept the first suffix yielding a valid ref.
    for (index, pair) in encoded.as_bytes().windows(2).enumerate() {
        if index > 2048 {
            break;
        }
        if pair != TOKEN_SUFFIX.as_bytes() {
            continue;
        }
        let Ok(bytes) = URL_SAFE_NO_PAD.decode(&encoded[..index]) else {
            continue;
        };
        let Ok(reference) = serde_json::from_slice::<SecretRef>(&bytes) else {
            continue;
        };
        reference.validate()?;
        return Ok((reference, TOKEN_PREFIX.len() + index + TOKEN_SUFFIX.len()));
    }
    Err(SecretError::error("invalid_ref"))
}

/// A provider's long-lived credential slot must contain exactly one opaque ref token.
pub fn credential_ref_from_token(input: &str) -> Result<SecretRef, SecretError> {
    let (reference, length) = parse_token(input)?;
    if length != input.len() {
        return Err(SecretError::error("invalid_ref"));
    }
    Ok(reference)
}

pub fn text_len_without_ref_tokens(input: &str) -> Result<usize, SecretError> {
    let mut remaining = input;
    let mut length = 0;
    while let Some(index) = remaining.find(TOKEN_PREFIX) {
        length += index;
        let (_, token_length) = parse_token(&remaining[index..])?;
        remaining = &remaining[index + token_length..];
    }
    Ok(length + remaining.len())
}

/// Persisted descriptors may contain validated opaque refs, never credential values.
/// This is syntactic validation only and never opens a platform credential store.
pub fn contains_plaintext_credential_assignment(input: &str) -> bool {
    static ASSIGNMENT: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r#"(?i)(?:bearer\s+|(?:authorization|api[_-]?key|(?:access|refresh)[_-]?token|token|secret|password|cookie)\s*=\s*)([^\s&#,;"'<>)]*)"#,
        ).expect("constant credential assignment pattern")
    });
    if input.contains(TOKEN_PREFIX) && text_len_without_ref_tokens(input).is_err() {
        return true;
    }
    ASSIGNMENT.captures_iter(input).any(|capture| {
        let value = &capture[1];
        !value.is_empty() && credential_ref_from_token(value).is_err()
    })
}

fn resolve_markers_with<'a>(
    input: &'a str,
    url: bool,
    resolve: &mut impl FnMut(&SecretRef) -> Result<String, SecretError>,
) -> Result<Cow<'a, str>, SecretError> {
    if !input.contains(TOKEN_PREFIX) {
        return Ok(Cow::Borrowed(input));
    }
    if url {
        let _ = reqwest::Url::parse(input).map_err(|_| SecretError::error("invalid_url"))?;
        let authority = input
            .split_once("://")
            .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or(rest))
            .ok_or_else(|| SecretError::error("invalid_url"))?;
        if authority.contains(TOKEN_PREFIX) {
            return Err(SecretError::error("invalid_credential_binding"));
        }
    }
    let mut output = String::with_capacity(input.len());
    let mut remaining = input;
    while let Some(index) = remaining.find(TOKEN_PREFIX) {
        output.push_str(&remaining[..index]);
        let (reference, length) = parse_token(&remaining[index..])?;
        let value = resolve(&reference)?;
        if url {
            output.push_str(&urlencoding::encode(&value));
        } else {
            output.push_str(&value);
        }
        remaining = &remaining[index + length..];
    }
    output.push_str(remaining);
    Ok(Cow::Owned(output))
}

/// Raw interpolation for header values and body fields; never interpolate field names.
pub fn resolve_secret_markers(input: &str) -> Result<Cow<'_, str>, SecretError> {
    resolve_markers_with(input, false, &mut resolve_required)
}

/// URL interpolation percent-encodes only secret values, preventing query/path injection.
pub fn resolve_url_secret_markers(input: &str) -> Result<Cow<'_, str>, SecretError> {
    resolve_markers_with(input, true, &mut resolve_required)
}

fn resolve_json_with(
    value: &mut Value,
    resolve: &mut impl FnMut(&SecretRef) -> Result<String, SecretError>,
) -> Result<(), SecretError> {
    match value {
        Value::String(text) if text.contains(TOKEN_PREFIX) => {
            let url = text.starts_with("https://") || text.starts_with("http://");
            *text = resolve_markers_with(text, url, resolve)?.into_owned();
        }
        Value::Array(values) => {
            for value in values {
                resolve_json_with(value, resolve)?;
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                resolve_json_with(value, resolve)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn resolve_json_secret_markers(value: &mut Value) -> Result<(), SecretError> {
    resolve_json_with(value, &mut resolve_required)
}

struct SecretSubstitution {
    reference: SecretRef,
    token: String,
    value: String,
    pattern: regex::Regex,
}

fn reflected_secret_pattern(value: &str) -> Result<(regex::Regex, usize), SecretError> {
    use std::fmt::Write;
    let mut pattern = String::new();
    let mut longest = 0;
    for character in value.chars() {
        let mut utf8 = [0; 4];
        let raw = character.encode_utf8(&mut utf8);
        let mut utf16 = [0; 2];
        let units = character.encode_utf16(&mut utf16);
        longest += (units.len() * 6).max(raw.len() * 3);
        pattern.push_str("(?:(?i:");
        for unit in units {
            write!(&mut pattern, r"\\u{unit:04x}").expect("writing to String");
        }
        pattern.push_str(")|(?i:");
        for byte in raw.as_bytes() {
            write!(&mut pattern, "%{byte:02x}").expect("writing to String");
        }
        pattern.push(')');
        let short = match character {
            '"' => Some("\\\""),
            '\\' => Some("\\\\"),
            '/' => Some("\\/"),
            '\n' => Some("\\n"),
            '\r' => Some("\\r"),
            '\t' => Some("\\t"),
            '\u{0008}' => Some("\\b"),
            '\u{000c}' => Some("\\f"),
            _ => None,
        };
        if let Some(short) = short {
            pattern.push('|');
            pattern.push_str(&regex::escape(short));
        }
        if character == ' ' {
            pattern.push_str(r"|\+");
        }
        pattern.push('|');
        pattern.push_str(&regex::escape(raw));
        pattern.push(')');
    }
    let pattern =
        regex::Regex::new(&pattern).map_err(|_| SecretError::error("redaction_failed"))?;
    Ok((pattern, longest))
}

/// Request-scoped and intentionally not Debug/Serialize. Restores opaque refs in
/// reflected provider data, so returned authenticated URLs remain executable.
#[derive(Default)]
pub struct SecretRedactor {
    substitutions: Vec<SecretSubstitution>,
    longest: usize,
}

impl SecretRedactor {
    pub fn is_empty(&self) -> bool {
        self.substitutions.is_empty()
    }

    pub fn record(&mut self, reference: &SecretRef, value: &str) -> Result<(), SecretError> {
        if value.is_empty() || self.substitutions.iter().any(|item| item.value == value) {
            return Ok(());
        }
        let (pattern, longest) = reflected_secret_pattern(value)?;
        self.longest = self.longest.max(longest);
        self.substitutions.push(SecretSubstitution {
            reference: reference.clone(),
            token: reference.token()?,
            value: value.to_string(),
            pattern,
        });
        Ok(())
    }

    fn resolve_with(
        &mut self,
        reference: &SecretRef,
        resolve: &mut impl FnMut(&SecretRef) -> Result<String, SecretError>,
    ) -> Result<String, SecretError> {
        if let Some(item) = self
            .substitutions
            .iter()
            .find(|item| &item.reference == reference)
        {
            return Ok(item.value.clone());
        }
        let value = resolve(reference)?;
        self.record(reference, &value)?;
        Ok(value)
    }

    pub fn resolve_markers<'a>(
        &mut self,
        input: &'a str,
        url: bool,
    ) -> Result<Cow<'a, str>, SecretError> {
        self.resolve_markers_using(input, url, &mut resolve_required)
    }

    pub fn resolve_json(&mut self, value: &mut Value) -> Result<(), SecretError> {
        self.resolve_json_using(value, &mut resolve_required)
    }

    pub(super) fn resolve_markers_using<'a>(
        &mut self,
        input: &'a str,
        url: bool,
        resolve: &mut impl FnMut(&SecretRef) -> Result<String, SecretError>,
    ) -> Result<Cow<'a, str>, SecretError> {
        resolve_markers_with(input, url, &mut |reference| {
            self.resolve_with(reference, resolve)
        })
    }

    pub(super) fn resolve_json_using(
        &mut self,
        value: &mut Value,
        resolve: &mut impl FnMut(&SecretRef) -> Result<String, SecretError>,
    ) -> Result<(), SecretError> {
        resolve_json_with(value, &mut |reference| {
            self.resolve_with(reference, resolve)
        })
    }

    pub fn redact_owned(&self, text: String) -> String {
        if !self
            .substitutions
            .iter()
            .any(|item| item.pattern.is_match(&text))
        {
            return text;
        }
        self.redact(&text)
    }

    pub fn redact(&self, text: &str) -> String {
        self.redact_stream(&mut String::new(), text, true)
    }

    /// Keep the possible partial-secret suffix private until the following chunk.
    pub fn redact_stream(&self, pending: &mut String, text: &str, flush: bool) -> String {
        if self.substitutions.is_empty() {
            return text.to_string();
        }
        pending.push_str(text);
        let mut limit = if flush {
            pending.len()
        } else {
            pending.len().saturating_sub(self.longest.saturating_sub(1))
        };
        while !pending.is_char_boundary(limit) {
            limit -= 1;
        }
        let mut output = String::new();
        let mut cursor = 0;
        while cursor < limit {
            let mut found: Option<(usize, usize, &str)> = None;
            for item in &self.substitutions {
                if let Some(matched) = item.pattern.find(&pending[cursor..]) {
                    let start = cursor + matched.start();
                    if found.is_none_or(|(best, length, _)| {
                        start < best || (start == best && matched.len() > length)
                    }) {
                        found = Some((start, matched.len(), &item.token));
                    }
                }
            }
            match found {
                Some((start, length, token)) if start < limit => {
                    output.push_str(&pending[cursor..start]);
                    output.push_str(token);
                    cursor = start + length;
                }
                _ => {
                    output.push_str(&pending[cursor..limit]);
                    cursor = limit;
                }
            }
        }
        pending.drain(..cursor);
        output
    }
}

#[tauri::command]
pub async fn secret_get(secret_ref: SecretRef) -> Result<Option<String>, SecretError> {
    tauri::async_runtime::spawn_blocking(move || native_vault().get(&secret_ref))
        .await
        .map_err(|_| SecretError::error("storage_failed"))?
}

#[tauri::command]
pub async fn secret_retry_access(secret_ref: SecretRef) -> Result<bool, SecretError> {
    tauri::async_runtime::spawn_blocking(move || native_vault().retry_access(&secret_ref))
        .await
        .map_err(|_| SecretError::error("storage_failed"))?
}

#[tauri::command]
pub async fn secret_set(secret_ref: SecretRef, value: String) -> Result<(), SecretError> {
    tauri::async_runtime::spawn_blocking(move || native_vault().set(&secret_ref, &value))
        .await
        .map_err(|_| SecretError::error("storage_failed"))?
}

#[tauri::command]
pub async fn secret_delete(secret_ref: SecretRef) -> Result<(), SecretError> {
    tauri::async_runtime::spawn_blocking(move || native_vault().delete(&secret_ref))
        .await
        .map_err(|_| SecretError::error("storage_failed"))?
}

#[tauri::command]
pub async fn secret_has(secret_ref: SecretRef) -> Result<bool, SecretError> {
    tauri::async_runtime::spawn_blocking(move || native_vault().has(&secret_ref))
        .await
        .map_err(|_| SecretError::error("storage_failed"))?
}

#[cfg(test)]
#[path = "secrets_access_tests.rs"]
mod access_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryBackend {
        values: Mutex<HashMap<SecretRef, String>>,
        failure: Option<SecretError>,
        discard_writes: bool,
    }

    impl SecretBackend for MemoryBackend {
        fn get(&self, reference: &SecretRef) -> Result<Option<String>, SecretError> {
            if let Some(error) = self.failure {
                return Err(error);
            }
            Ok(self.values.lock().unwrap().get(reference).cloned())
        }
        fn set(&self, reference: &SecretRef, value: &str) -> Result<(), SecretError> {
            if let Some(error) = self.failure {
                return Err(error);
            }
            if !self.discard_writes {
                self.values
                    .lock()
                    .unwrap()
                    .insert(reference.clone(), value.to_string());
            }
            Ok(())
        }
        fn delete(&self, reference: &SecretRef) -> Result<(), SecretError> {
            if let Some(error) = self.failure {
                return Err(error);
            }
            self.values.lock().unwrap().remove(reference);
            Ok(())
        }
    }

    fn reference() -> SecretRef {
        SecretRef {
            namespace: "channel".into(),
            id: "test-id".into(),
        }
    }

    #[test]
    fn missing_set_get_has_delete_are_deterministic() {
        let vault = SecretVault::new(MemoryBackend::default());
        let reference = reference();
        assert_eq!(vault.get(&reference), Ok(None));
        assert_eq!(vault.has(&reference), Ok(false));
        assert_eq!(vault.set(&reference, "test-secret"), Ok(()));
        assert_eq!(vault.get(&reference), Ok(Some("test-secret".into())));
        assert_eq!(vault.has(&reference), Ok(true));
        assert_eq!(vault.delete(&reference), Ok(()));
        assert_eq!(vault.delete(&reference), Ok(()));
        assert_eq!(vault.get(&reference), Ok(None));
    }

    #[test]
    fn existence_probes_do_not_require_permission_to_read_passwords() {
        struct MetadataBackend;
        impl SecretBackend for MetadataBackend {
            fn get(&self, _: &SecretRef) -> Result<Option<String>, SecretError> {
                Err(SecretError::locked())
            }
            fn has(&self, _: &SecretRef) -> Result<bool, SecretError> {
                Ok(true)
            }
            fn set(&self, _: &SecretRef, _: &str) -> Result<(), SecretError> {
                unreachable!()
            }
            fn delete(&self, _: &SecretRef) -> Result<(), SecretError> {
                unreachable!()
            }
        }
        let vault = SecretVault::new(MetadataBackend);
        assert_eq!(vault.has(&reference()), Ok(true));
        // Existence does not grant access: request-boundary reads still fail closed.
        assert_eq!(vault.get(&reference()), Err(SecretError::locked()));
        assert_eq!(
            vault.has(&SecretRef {
                namespace: "unknown".into(),
                id: "x".into()
            }),
            Err(SecretError::error("invalid_ref"))
        );
    }

    #[test]
    fn set_requires_read_back_verification() {
        let vault = SecretVault::new(MemoryBackend {
            discard_writes: true,
            ..MemoryBackend::default()
        });
        assert_eq!(
            vault.set(&reference(), "not-stored"),
            Err(SecretError::error("verification_failed"))
        );
    }

    #[test]
    fn errors_are_safe_and_preserve_locked_state() {
        let vault = SecretVault::new(MemoryBackend {
            failure: Some(SecretError::locked()),
            ..MemoryBackend::default()
        });
        let error = vault.set(&reference(), "must-not-appear").unwrap_err();
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({ "state": "locked", "code": "storage_locked" })
        );
        assert_eq!(
            error.to_string(),
            "{\"state\":\"locked\",\"code\":\"storage_locked\"}"
        );
        assert!(!format!("{error:?}").contains("must-not-appear"));
        assert_eq!(vault.get(&reference()), Err(error));
        assert_eq!(vault.has(&reference()), Err(error));
        assert_eq!(vault.delete(&reference()), Err(error));
        let unavailable = SecretVault::new(MemoryBackend {
            failure: Some(SecretError::error("storage_failed")),
            ..MemoryBackend::default()
        });
        assert_eq!(
            unavailable.get(&reference()),
            Err(SecretError::error("storage_failed"))
        );
    }

    #[test]
    fn invalid_refs_are_rejected_before_backend_access() {
        let vault = SecretVault::new(MemoryBackend {
            failure: Some(SecretError::locked()),
            ..MemoryBackend::default()
        });
        for reference in [
            SecretRef {
                namespace: "unknown".into(),
                id: "test".into(),
            },
            SecretRef {
                namespace: "channel".into(),
                id: String::new(),
            },
            SecretRef {
                namespace: "channel".into(),
                id: " test".into(),
            },
            SecretRef {
                namespace: "provider".into(),
                id: "bad\nid".into(),
            },
            SecretRef {
                namespace: "settings".into(),
                id: "a".repeat(513),
            },
        ] {
            assert_eq!(
                vault.get(&reference),
                Err(SecretError::error("invalid_ref"))
            );
            assert_eq!(
                vault.set(&reference, "secret"),
                Err(SecretError::error("invalid_ref"))
            );
            assert_eq!(
                vault.delete(&reference),
                Err(SecretError::error("invalid_ref"))
            );
            assert_eq!(
                vault.has(&reference),
                Err(SecretError::error("invalid_ref"))
            );
        }
    }

    #[test]
    fn tokens_roundtrip_and_interpolate_without_url_injection() {
        let reference = SecretRef {
            namespace: "channel".into(),
            id: "标识/id: one".into(),
        };
        let token = reference.token().unwrap();
        assert_eq!(credential_ref_from_token(&token), Ok(reference.clone()));
        assert_eq!(urlencoding::encode(&token).as_ref(), token);
        let mut resolve = |actual: &SecretRef| {
            assert_eq!(actual, &reference);
            Ok("key&admin=true /?".to_string())
        };
        let header = format!("Bearer {token}");
        assert_eq!(
            resolve_markers_with(&header, false, &mut resolve).unwrap(),
            "Bearer key&admin=true /?"
        );
        let url = format!("https://example.test/run?key={token}&count=1");
        assert_eq!(
            resolve_markers_with(&url, true, &mut resolve).unwrap(),
            "https://example.test/run?key=key%26admin%3Dtrue%20%2F%3F&count=1"
        );
        assert!(credential_ref_from_token("raw-secret").is_err());
        assert!(credential_ref_from_token(&format!("Bearer {token}")).is_err());
        assert!(resolve_markers_with("__SC_SECRET_invalid__", false, &mut resolve).is_err());
    }

    #[test]
    fn marker_resolution_propagates_safe_missing_or_locked_errors() {
        let token = reference().token().unwrap();
        assert_eq!(
            resolve_markers_with(&token, false, &mut |_| Err(SecretError::error(
                "credential_missing"
            ))),
            Err(SecretError::error("credential_missing"))
        );
        assert_eq!(
            resolve_markers_with(&token, false, &mut |_| Err(SecretError::locked())),
            Err(SecretError::locked())
        );
        assert!(matches!(
            resolve_markers_with("no-token", false, &mut |_| unreachable!()).unwrap(),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn nested_json_resolves_values_and_url_components_without_changing_field_names() {
        let token = reference().token().unwrap();
        let mut value = serde_json::json!({
            "nested": [{ "key": token, "url": format!("https://example.test/?key={token}") }],
            (token.clone()): "field-name-must-not-change",
            "count": 2
        });
        resolve_json_with(&mut value, &mut |_| Ok("key&scope=all".into())).unwrap();
        assert_eq!(value["nested"][0]["key"], "key&scope=all");
        assert_eq!(
            value["nested"][0]["url"],
            "https://example.test/?key=key%26scope%3Dall"
        );
        assert_eq!(value[&token], "field-name-must-not-change");
        assert_eq!(value["count"], 2);
    }

    #[test]
    fn reflected_values_restore_refs_in_plain_encoded_and_json_text() {
        let reference = reference();
        let token = reference.token().unwrap();
        let mut redactor = SecretRedactor::default();
        let secret = "test-secret&scope=all \"quoted\"";
        redactor.record(&reference, secret).unwrap();
        let json = serde_json::to_string(secret).unwrap();
        assert_eq!(redactor.redact(secret), token);
        assert_eq!(redactor.redact(&urlencoding::encode(secret)), token);
        assert_eq!(redactor.redact(&json), format!("\"{token}\""));
        assert_eq!(redactor.redact("unrelated text"), "unrelated text");
    }

    #[test]
    fn stream_redaction_covers_every_secret_split_and_multiple_occurrences() {
        let reference = reference();
        let token = reference.token().unwrap();
        let secret = "deterministic-test-secret";
        let mut redactor = SecretRedactor::default();
        redactor.record(&reference, secret).unwrap();
        let text = format!("first {secret} middle {secret} final");
        let expected = format!("first {token} middle {token} final");
        for split in 0..=text.len() {
            let mut pending = String::new();
            let mut output = redactor.redact_stream(&mut pending, &text[..split], false);
            output.push_str(&redactor.redact_stream(&mut pending, &text[split..], false));
            output.push_str(&redactor.redact_stream(&mut pending, "", true));
            assert_eq!(output, expected);
            assert!(pending.is_empty());
        }
    }

    #[test]
    fn secret_refs_cannot_change_url_authority() {
        let token = reference().token().unwrap();
        for url in [
            format!("https://{token}.example.test/"),
            format!("https://user:{token}@example.test/"),
        ] {
            assert_eq!(
                resolve_markers_with(&url, true, &mut |_| unreachable!()),
                Err(SecretError::error("invalid_credential_binding"))
            );
        }
    }

    #[test]
    fn mixed_json_and_url_escaping_cannot_hide_reflected_keys() {
        let reference = reference();
        let token = reference.token().unwrap();
        let mut redactor = SecretRedactor::default();
        redactor.record(&reference, "api-KEY/😀").unwrap();
        let encoded = r"a\u0070%69-\u004bEY\/\uD83D\uDE00";
        assert_eq!(redactor.redact(encoded), token);
        for split in 0..=encoded.len() {
            let mut pending = String::new();
            let mut output = redactor.redact_stream(&mut pending, &encoded[..split], false);
            output.push_str(&redactor.redact_stream(&mut pending, &encoded[split..], true));
            assert_eq!(output, token);
            assert!(pending.is_empty());
        }
    }

    #[test]
    fn persisted_credential_assignments_allow_only_valid_ref_tokens() {
        let token = reference().token().unwrap();
        assert!(!contains_plaintext_credential_assignment(&format!(
            "https://example.test/?api_key={token}&page=1"
        )));
        assert!(!contains_plaintext_credential_assignment(&format!(
            "Bearer {token}"
        )));
        assert!(contains_plaintext_credential_assignment(
            "https://example.test/?api_key=plaintext"
        ));
        assert!(contains_plaintext_credential_assignment("Bearer plaintext"));
        assert!(contains_plaintext_credential_assignment(
            "https://example.test/?api_key=__SC_SECRET_invalid__"
        ));
        assert!(contains_plaintext_credential_assignment(&format!(
            "https://example.test/?api_key={token}extra"
        )));
    }
}

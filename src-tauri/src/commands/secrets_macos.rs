//! Existence probes must never read password data or present authorization UI.
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};
use security_framework_sys::item::*;
use security_framework_sys::keychain_item::SecItemCopyMatching;

use super::{SecretError, SecretRef, SERVICE_PREFIX};

extern "C" {
    // security-framework-sys exposes UISkip, but skipping would misreport locked items as missing.
    static kSecUseAuthenticationUIFail: CFStringRef;
}

fn existence_query(reference: &SecretRef, keychain: CFType) -> CFDictionary<CFString, CFType> {
    let keychains = CFArray::from_CFTypes(&[keychain]);
    // These are immutable process-lifetime Security.framework constants; the dictionary retains them.
    unsafe {
        CFDictionary::from_CFType_pairs(&[
            (
                CFString::wrap_under_get_rule(kSecClass),
                CFString::wrap_under_get_rule(kSecClassGenericPassword).into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecAttrService),
                CFString::new(&format!("{SERVICE_PREFIX}.{}", reference.namespace)).into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecAttrAccount),
                CFString::new(&reference.id).into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecMatchSearchList),
                keychains.into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecMatchLimit),
                CFNumber::from(1_i32).into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecReturnData),
                CFBoolean::false_value().into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecReturnAttributes),
                CFBoolean::false_value().into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecUseAuthenticationUI),
                CFString::wrap_under_get_rule(kSecUseAuthenticationUIFail).into_CFType(),
            ),
        ])
    }
}

pub(super) fn is_access_denied_status(status: i32) -> bool {
    matches!(status, -128 | -25293 | -25308 | -25315)
}

pub(super) fn is_storage_unavailable_status(status: i32) -> bool {
    status == -25291 // errSecNotAvailable is a storage availability error, not a user denial.
}

fn presence_from_status(status: i32) -> Result<bool, SecretError> {
    match status {
        0 => Ok(true),
        -25300 => Ok(false), // errSecItemNotFound
        unavailable if is_storage_unavailable_status(unavailable) => {
            Err(SecretError::error("storage_unavailable"))
        }
        denied if is_access_denied_status(denied) => Err(SecretError::locked()),
        _ => Err(SecretError::error("storage_failed")),
    }
}

pub(super) fn contains(reference: &SecretRef) -> Result<bool, SecretError> {
    reference.validate()?;
    // Match keyring's User domain exactly. Do not search other users/system keychains.
    let keychain =
        SecKeychain::default_for_domain(SecPreferencesDomain::User).map_err(|error| {
            presence_from_status(error.code())
                .err()
                .unwrap_or_else(|| SecretError::error("storage_unavailable"))
        })?;
    let query = existence_query(reference, keychain.into_CFType());
    // No result requested, no password bytes returned. A UI requirement fails closed instead of prompting.
    let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), std::ptr::null_mut()) };
    presence_from_status(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_request_no_secret_and_refuse_interactive_authorization() {
        let reference = SecretRef {
            namespace: "settings".into(),
            id: "fixture".into(),
        };
        // A synthetic keychain value only inspects the query; never calls the OS credential store.
        let query = existence_query(&reference, CFString::new("test-keychain").into_CFType());
        unsafe {
            assert_eq!(
                *query.get(CFString::wrap_under_get_rule(kSecReturnData)),
                CFBoolean::false_value().into_CFType()
            );
            assert_eq!(
                *query.get(CFString::wrap_under_get_rule(kSecUseAuthenticationUI)),
                CFString::wrap_under_get_rule(kSecUseAuthenticationUIFail).into_CFType()
            );
            assert_eq!(
                *query.get(CFString::wrap_under_get_rule(kSecAttrService)),
                CFString::new("com.storyboard-copilot.credentials.settings").into_CFType()
            );
            assert_eq!(
                *query.get(CFString::wrap_under_get_rule(kSecAttrAccount)),
                CFString::new("fixture").into_CFType()
            );
        }
    }

    #[test]
    fn denied_probes_are_locked_not_missing() {
        assert_eq!(presence_from_status(0), Ok(true));
        assert_eq!(presence_from_status(-25300), Ok(false));
        for status in [-128, -25293, -25308, -25315] {
            assert_eq!(presence_from_status(status), Err(SecretError::locked()));
        }
        assert_eq!(
            presence_from_status(-25291),
            Err(SecretError::error("storage_unavailable"))
        );
        assert_eq!(
            presence_from_status(-50),
            Err(SecretError::error("storage_failed"))
        );
    }
}

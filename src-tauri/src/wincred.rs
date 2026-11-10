//! Windows credential storage via the Win32 Credential API (CredWriteW/CredReadW/CredDeleteW), used on
//! Windows in place of the `keyring` crate.
//!
//! Why not keyring on Windows: keyring 3.x hardcodes `CRED_PERSIST_ENTERPRISE` — the small, roaming
//! credential pool. When that pool fills (it is shared across every keyring-rs app on the machine),
//! `CredWriteW` returns `ERROR_NOT_ENOUGH_MEMORY` and the user can no longer create or import accounts
//! ("Keyring store error: Platform secure storage failure: Windows error code 8"). We write with
//! `CRED_PERSIST_LOCAL_MACHINE` — the roomy, non-roaming pool — instead. Same DPAPI, user-scoped
//! protection; just the partition that does not choke.
//!
//! Byte-compatible with keyring's windows-native backend so existing entries read and migrate cleanly:
//!   * target name = "{key}.den-chat"            (keyring's "{user}.{service}")
//!   * CRED_TYPE_GENERIC, UserName = "{key}"
//!   * blob = UTF-16LE, no NUL terminator        (exactly how keyring stores the password)
//! Reads are persistence-agnostic (`CredReadW` matches by target, not by Persist), and a LocalMachine
//! write overwrites any existing Enterprise entry at the same target — migrating it off roaming and
//! freeing that quota, which succeeds even when the roaming pool is full.

use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND, FILETIME};
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_ENTERPRISE,
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};
use zeroize::Zeroize;

const SERVICE_NAME: &str = "den-chat";
/// `CRED_MAX_CREDENTIAL_BLOB_SIZE` = 5 * 512 = 2560 bytes per credential blob. Applies to every
/// persistence, LocalMachine included.
const MAX_BLOB_BYTES: usize = 2560;

/// keyring's target naming: "{user}.{service}".
fn target_name(key: &str) -> String {
    format!("{}.{}", key, SERVICE_NAME)
}

/// UTF-16, NUL-terminated — for the TargetName / UserName C strings.
fn wstr(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// UTF-16LE bytes, NO terminator — matches keyring's blob encoding.
fn blob_from(value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(value.len() * 2);
    for u in value.encode_utf16() {
        out.extend_from_slice(&u.to_le_bytes());
    }
    out
}

/// Decode a UTF-16LE blob back to a String.
fn blob_to(bytes: &[u8]) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i + 1 < bytes.len() {
        units.push(u16::from_le_bytes([bytes[i], bytes[i + 1]]));
        i += 2;
    }
    let s = String::from_utf16_lossy(&units);
    units.zeroize();
    s
}

pub fn set_raw(key: &str, value: &str) -> Result<(), String> {
    let mut blob = blob_from(value);
    if blob.len() > MAX_BLOB_BYTES {
        blob.zeroize();
        return Err(format!(
            "Keyring store error: value is {} bytes, over the {}-byte credential limit",
            blob.len(),
            MAX_BLOB_BYTES
        ));
    }
    let mut target = wstr(&target_name(key));
    let mut user = wstr(key);
    let cred = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        Comment: std::ptr::null_mut(),
        LastWritten: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: std::ptr::null_mut(),
        UserName: user.as_mut_ptr(),
    };
    let ok = unsafe { CredWriteW(&cred, 0) };
    blob.zeroize();
    if ok != 0 {
        Ok(())
    } else {
        Err(format!("Keyring store error: Windows error code {}", unsafe { GetLastError() }))
    }
}

/// Read a value together with its current persistence flag. `Ok(None)` when the entry doesn't exist.
fn read_with_persist(key: &str) -> Result<Option<(String, u32)>, String> {
    let target = wstr(&target_name(key));
    let mut pcred: *mut CREDENTIALW = std::ptr::null_mut();
    let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pcred) };
    if ok == 0 {
        let code = unsafe { GetLastError() };
        if code == ERROR_NOT_FOUND {
            return Ok(None);
        }
        return Err(format!("Keyring retrieve error: Windows error code {}", code));
    }
    let out = unsafe {
        let c = &*pcred;
        let size = c.CredentialBlobSize as usize;
        let value = if size == 0 || c.CredentialBlob.is_null() {
            String::new()
        } else {
            blob_to(std::slice::from_raw_parts(c.CredentialBlob, size))
        };
        (value, c.Persist)
    };
    unsafe { CredFree(pcred as *const core::ffi::c_void) };
    Ok(Some(out))
}

pub fn get_raw(key: &str) -> Result<String, String> {
    match read_with_persist(key)? {
        Some((v, _)) => Ok(v),
        None => Err(format!("Keyring retrieve error: Windows error code {}", ERROR_NOT_FOUND)),
    }
}

pub fn delete_raw(key: &str) -> Result<(), String> {
    let target = wstr(&target_name(key));
    let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    if ok != 0 {
        return Ok(());
    }
    let code = unsafe { GetLastError() };
    if code == ERROR_NOT_FOUND {
        Ok(()) // already gone — not an error
    } else {
        Err(format!("Keyring delete error: Windows error code {}", code))
    }
}

/// One-time migration: re-save any ENTERPRISE (roaming) entries among `keys` as LOCAL_MACHINE, which
/// overwrites them in place and frees their roaming quota. Idempotent — entries already Local or absent
/// are skipped, so repeat launches are a cheap read-only scan. Best-effort (never fails startup).
pub fn migrate_to_local(keys: &[String]) {
    let mut migrated = 0u32;
    for k in keys {
        if let Ok(Some((mut value, persist))) = read_with_persist(k) {
            if persist == CRED_PERSIST_ENTERPRISE && set_raw(k, &value).is_ok() {
                migrated += 1;
            }
            value.zeroize();
        }
    }
    if migrated > 0 {
        tracing::info!("Migrated {} credential(s) from the roaming store to the local store", migrated);
    }
}

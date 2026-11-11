//! At-rest encryption for stored secrets (seed mnemonics and nsec/private keys).
//!
//! Secrets live in the OS keyring, but the OS keyring only protects them at the OS layer (anything
//! that can read the user's keyring reads the raw secret). This module adds an app-level layer so a
//! keyring dump is useless without the account PIN:
//!
//!   KEK = Argon2id(PIN, salt)              (m = 64 MiB, t = 3, p = 1)
//!   value = "denc1:" + base64( header ‖ salt ‖ nonce ‖ AES-256-GCM(KEK, secret, AAD = key name) )
//!
//! The PIN is verified *by the decrypt itself* (a valid GCM tag is proof the PIN is correct), so there
//! is no fast hash of the PIN to brute-force. The blob is self-describing (Argon2 params + salt + nonce
//! are stored inline), so params are tunable without a migration. The AAD binds each ciphertext to its
//! keyring slot (`sk-<pubkey>` / `mnseed-<pubkey>`), so entries cannot be swapped between slots.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use zeroize::Zeroize;

/// Marker prefix on an encrypted keyring value. A value without it is legacy plaintext.
pub const PREFIX: &str = "denc1:";

/// Blob format version (the first header byte).
const VERSION: u8 = 1;

// Argon2id parameters for the at-rest KEK. Native Rust, so we can afford strong settings.
const ARGON_M_KIB: u32 = 64 * 1024; // 64 MiB
const ARGON_T: u32 = 3; // iterations
const ARGON_P: u32 = 1; // lanes

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

/// Is this stored keyring value already encrypted by us (vs legacy plaintext)?
pub fn is_encrypted(value: &str) -> bool {
    value.starts_with(PREFIX)
}

/// Derive a 32-byte AES key from the PIN with Argon2id. Caller zeroizes.
fn derive_kek(pin: &str, salt: &[u8], m_kib: u32, t: u32, p: u32) -> Result<[u8; 32], String> {
    let params = Params::new(m_kib, t, p, Some(32))
        .map_err(|e| format!("Argon2 params error: {}", e))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut kek = [0u8; 32];
    argon
        .hash_password_into(pin.as_bytes(), salt, &mut kek)
        .map_err(|e| format!("Argon2 derivation failed: {}", e))?;
    Ok(kek)
}

/// Encrypt `plaintext` under `pin`, binding it to `aad` (the keyring key name).
/// Returns a `denc1:`-prefixed string safe to store in the keyring.
pub fn encrypt(plaintext: &str, pin: &str, aad: &str) -> Result<String, String> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    let mut rng = rand::thread_rng();
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce_bytes);

    let mut kek = derive_kek(pin, &salt, ARGON_M_KIB, ARGON_T, ARGON_P)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&kek));
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "Encryption failed".to_string());
    kek.zeroize();
    let ct = ct?;

    // header: version(1) ‖ m_kib(4 LE) ‖ t(4 LE) ‖ p(1)
    let mut blob = Vec::with_capacity(1 + 4 + 4 + 1 + SALT_LEN + NONCE_LEN + ct.len());
    blob.push(VERSION);
    blob.extend_from_slice(&ARGON_M_KIB.to_le_bytes());
    blob.extend_from_slice(&ARGON_T.to_le_bytes());
    blob.push(ARGON_P as u8);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ct);

    Ok(format!("{}{}", PREFIX, STANDARD.encode(&blob)))
}

/// Decrypt a `denc1:` blob with `pin`. A wrong PIN fails the GCM tag and returns `Incorrect PIN`.
/// `aad` must match what it was encrypted with (the keyring key name).
pub fn decrypt(blob: &str, pin: &str, aad: &str) -> Result<String, String> {
    let b64 = blob
        .strip_prefix(PREFIX)
        .ok_or_else(|| "Not an encrypted value".to_string())?;
    let bytes = STANDARD
        .decode(b64)
        .map_err(|e| format!("Corrupt encrypted value (base64): {}", e))?;

    // Fixed-size header + salt + nonce, then at least the 16-byte GCM tag.
    let min = 1 + 4 + 4 + 1 + SALT_LEN + NONCE_LEN + 16;
    if bytes.len() < min {
        return Err("Corrupt encrypted value (too short)".to_string());
    }
    if bytes[0] != VERSION {
        return Err(format!("Unsupported encrypted-value version: {}", bytes[0]));
    }
    let mut off = 1;
    let m_kib = u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]]);
    off += 4;
    let t = u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]]);
    off += 4;
    let p = bytes[off] as u32;
    off += 1;
    let salt = &bytes[off..off + SALT_LEN];
    off += SALT_LEN;
    let nonce_bytes = &bytes[off..off + NONCE_LEN];
    off += NONCE_LEN;
    let ct = &bytes[off..];

    let mut kek = derive_kek(pin, salt, m_kib, t, p)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&kek));
    let nonce = Nonce::from_slice(nonce_bytes);
    let pt = cipher
        .decrypt(nonce, Payload { msg: ct, aad: aad.as_bytes() })
        .map_err(|_| "Incorrect PIN".to_string());
    kek.zeroize();
    let pt = pt?;

    String::from_utf8(pt).map_err(|_| "Decrypted value is not valid UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let secret = "abandon ability able about above absent absorb abstract absurd abuse access accident";
        let blob = encrypt(secret, "1234", "sk-abc").unwrap();
        assert!(is_encrypted(&blob));
        assert!(blob.starts_with(PREFIX));
        assert_eq!(decrypt(&blob, "1234", "sk-abc").unwrap(), secret);
    }

    #[test]
    fn empty_and_unicode_secret() {
        for s in ["", "nsec…🔑", "a"] {
            let blob = encrypt(s, "pin-pin", "mnseed-x").unwrap();
            assert_eq!(decrypt(&blob, "pin-pin", "mnseed-x").unwrap(), s);
        }
    }

    #[test]
    fn wrong_pin_fails() {
        let blob = encrypt("secret", "correct", "sk-abc").unwrap();
        assert_eq!(decrypt(&blob, "wrong", "sk-abc").unwrap_err(), "Incorrect PIN");
    }

    #[test]
    fn wrong_aad_fails() {
        // AAD (the keyring slot name) is authenticated: a value can't be moved to another slot.
        let blob = encrypt("secret", "1234", "sk-aaa").unwrap();
        assert_eq!(decrypt(&blob, "1234", "sk-bbb").unwrap_err(), "Incorrect PIN");
    }

    #[test]
    fn distinct_salt_and_nonce_per_call() {
        let a = encrypt("secret", "1234", "sk-abc").unwrap();
        let b = encrypt("secret", "1234", "sk-abc").unwrap();
        assert_ne!(a, b); // random salt + nonce → different ciphertext each time
    }

    #[test]
    fn plaintext_is_not_detected_as_encrypted() {
        assert!(!is_encrypted("a1b2c3deadbeef")); // a legacy plaintext sk hex
        assert!(!is_encrypted("abandon ability able")); // a legacy plaintext mnemonic
    }
}

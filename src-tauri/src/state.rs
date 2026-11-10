use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use sha2::{Sha256, Digest};
use tracing::info;

// ─── Data Structures ────────────────────────────────────────────────────

/// Account metadata — stored in keyring (no secrets here)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    pub pubkey: String,
    pub npub: String,
    pub name: Option<String>,
    /// "seed" or "nsec"
    pub auth_method: String,
    /// If derived from a seed, the seed's UUID
    #[serde(default)]
    pub seed_id: Option<String>,
    /// BIP-32 account index used to derive this keypair
    #[serde(default)]
    pub account_index: Option<u32>,
    pub created_at: u64,
    /// SHA-256 hash of the 8-digit PIN
    pub pin_hash: String,
    /// Optional local hint for PIN
    #[serde(default)]
    pub pin_hint: Option<String>,
}

/// Seed metadata — mnemonic stored separately as "seed-{id}"
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedInfo {
    pub id: String,
    pub name: String,
    /// Pubkeys of accounts derived from this seed
    pub account_pubkeys: Vec<String>,
}

/// Public-facing account info (sent to frontend — no PIN hash)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountListItem {
    pub pubkey: String,
    pub npub: String,
    pub name: Option<String>,
    pub auth_method: String,
    pub seed_id: Option<String>,
    pub account_index: Option<u32>,
    pub created_at: u64,
    pub has_pin: bool,
    pub pin_hint: Option<String>,
}

impl AccountInfo {
    /// Convert to a safe list item (strips PIN hash)
    pub fn to_list_item(&self) -> AccountListItem {
        AccountListItem {
            pubkey: self.pubkey.clone(),
            npub: self.npub.clone(),
            name: self.name.clone(),
            auth_method: self.auth_method.clone(),
            seed_id: self.seed_id.clone(),
            account_index: self.account_index,
            created_at: self.created_at,
            has_pin: !self.pin_hash.is_empty(),
            pin_hint: self.pin_hint.clone(),
        }
    }
}

// ─── App State ──────────────────────────────────────────────────────────

pub struct AppState {
    pub accounts: Mutex<Vec<AccountInfo>>,
    pub seeds: Mutex<Vec<SeedInfo>>,
    pub active_account: Mutex<Option<String>>,
    /// Deep link URL from cold launch (process args), consumed once by the frontend
    pub pending_deep_link: Mutex<Option<String>>,
}

#[cfg_attr(windows, allow(dead_code))] // used only by the non-Windows keyring path
const SERVICE_NAME: &str = "den-chat";
const ACCOUNTS_INDEX_KEY: &str = "accounts-index";
const SEEDS_INDEX_KEY: &str = "seeds-index";
const ACTIVE_ACCOUNT_KEY: &str = "active-account";

impl AppState {
    pub fn new() -> Self {
        // Load account index on startup
        let account_pubkeys = load_from_keyring::<Vec<String>>(ACCOUNTS_INDEX_KEY)
            .unwrap_or_default();

        let accounts: Vec<AccountInfo> = account_pubkeys
            .iter()
            .filter_map(|pk| load_from_keyring::<AccountInfo>(&format!("acct-{}", pk)))
            .collect();

        let seed_ids = load_from_keyring::<Vec<String>>(SEEDS_INDEX_KEY)
            .unwrap_or_default();

        let seeds: Vec<SeedInfo> = seed_ids
            .iter()
            .filter_map(|id| load_from_keyring::<SeedInfo>(&format!("seed-info-{}", id)))
            .collect();

        let active = load_from_keyring::<String>(ACTIVE_ACCOUNT_KEY)
            .filter(|pk| accounts.iter().any(|a| a.pubkey == *pk))
            .or_else(|| accounts.first().map(|a| a.pubkey.clone()));

        info!(
            "Loaded {} accounts, {} seeds from keyring",
            accounts.len(),
            seeds.len()
        );

        // Windows: migrate any roaming (Enterprise) credentials to the LOCAL store. The roaming pool is
        // small and shared, and throws "Windows error code 8" when full; reading is persistence-agnostic,
        // so this just rewrites existing entries as LocalMachine (freeing their roaming quota). Best-effort
        // and idempotent, so repeat launches are a cheap read-only scan once everything is already local.
        #[cfg(windows)]
        {
            let mut keys: Vec<String> = vec![
                ACCOUNTS_INDEX_KEY.to_string(),
                SEEDS_INDEX_KEY.to_string(),
                ACTIVE_ACCOUNT_KEY.to_string(),
            ];
            for a in &accounts {
                keys.push(format!("acct-{}", a.pubkey));
                keys.push(format!("sk-{}", a.pubkey));
            }
            for s in &seeds {
                keys.push(format!("seed-info-{}", s.id));
                keys.push(format!("seed-{}", s.id));
            }
            crate::wincred::migrate_to_local(&keys);
        }

        // Check process args for a cold-launch deep link URL
        let pending_deep_link = std::env::args()
            .find(|a| a.starts_with("denchat://"));

        Self {
            accounts: Mutex::new(accounts),
            seeds: Mutex::new(seeds),
            active_account: Mutex::new(active),
            pending_deep_link: Mutex::new(pending_deep_link),
        }
    }

    pub fn save_accounts(&self) -> Result<(), String> {
        let accounts = self.accounts.lock().unwrap();
        // Load old index to find removed entries
        let old_pks = load_from_keyring::<Vec<String>>(ACCOUNTS_INDEX_KEY)
            .unwrap_or_default();
        let current_pks: Vec<String> = accounts.iter().map(|a| a.pubkey.clone()).collect();
        // Delete removed account entries
        for old_pk in &old_pks {
            if !current_pks.contains(old_pk) {
                let _ = delete_raw_from_keyring(&format!("acct-{}", old_pk));
            }
        }
        // Save index + individual entries
        save_to_keyring(ACCOUNTS_INDEX_KEY, &current_pks)?;
        for acct in accounts.iter() {
            save_to_keyring(&format!("acct-{}", acct.pubkey), acct)?;
        }
        Ok(())
    }

    pub fn save_seeds(&self) -> Result<(), String> {
        let seeds = self.seeds.lock().unwrap();
        let old_ids = load_from_keyring::<Vec<String>>(SEEDS_INDEX_KEY)
            .unwrap_or_default();
        let current_ids: Vec<String> = seeds.iter().map(|s| s.id.clone()).collect();
        for old_id in &old_ids {
            if !current_ids.contains(old_id) {
                let _ = delete_raw_from_keyring(&format!("seed-info-{}", old_id));
            }
        }
        save_to_keyring(SEEDS_INDEX_KEY, &current_ids)?;
        for s in seeds.iter() {
            save_to_keyring(&format!("seed-info-{}", s.id), s)?;
        }
        Ok(())
    }

    pub fn save_active_account(&self) -> Result<(), String> {
        let active = self.active_account.lock().unwrap();
        match active.as_ref() {
            Some(pk) => save_to_keyring(ACTIVE_ACCOUNT_KEY, pk),
            None => {
                let _ = delete_raw_from_keyring(ACTIVE_ACCOUNT_KEY);
                Ok(())
            }
        }
    }
}

// ─── PIN Helper ─────────────────────────────────────────────────────────

pub fn hash_pin(pin: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(pin.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn verify_pin_hash(pin: &str, stored_hash: &str) -> bool {
    if stored_hash.is_empty() {
        return false;
    }
    hash_pin(pin) == stored_hash
}

// ─── Credential Storage Helpers ─────────────────────────────────────────
// On Windows we talk to the Credential Manager directly (see wincred.rs) with LOCAL_MACHINE
// persistence, because the `keyring` crate hardcodes the small roaming/Enterprise pool that fills up
// and throws "Windows error code 8". On macOS/Linux we keep using `keyring`.
//
// Windows caps a single credential blob at 2560 bytes (~1280 UTF-16 units). A value larger than that
// (e.g. a big accounts-index) is transparently SPLIT across `{key}::chunk::{i}` entries with a small
// manifest under `{key}`, reassembled on load. Values that fit are stored as one entry.

/// Max UTF-16 code units per entry, with headroom under the 1280-unit (2560-byte) platform cap.
const KEYRING_CHUNK_LIMIT: usize = 1000;
/// Sentinel prefix marking a chunk manifest. Control chars can't appear in serde_json output.
const KEYRING_CHUNK_SENTINEL: &str = "\u{1}DENCHUNKED\u{1}";

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Split a string into pieces each <= `max` UTF-16 units, never breaking a `char`.
fn split_by_utf16(s: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0usize;
    for ch in s.chars() {
        let clen = ch.len_utf16();
        if cur_len + clen > max && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
            cur_len = 0;
        }
        cur.push(ch);
        cur_len += clen;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Delete leftover chunk entries from a previous (chunked) value at `key`. Best-effort.
fn clear_keyring_chunks(key: &str) {
    if let Ok(raw) = get_raw_from_keyring(key) {
        if let Some(n) = raw.strip_prefix(KEYRING_CHUNK_SENTINEL).and_then(|s| s.parse::<usize>().ok()) {
            for i in 0..n {
                let _ = delete_raw_from_keyring(&format!("{}::chunk::{}", key, i));
            }
        }
    }
}

pub fn save_to_keyring<T: Serialize>(key: &str, value: &T) -> Result<(), String> {
    let json = serde_json::to_string(value)
        .map_err(|e| format!("Serialization failed: {}", e))?;
    // Remove chunks from any prior larger value before rewriting.
    clear_keyring_chunks(key);
    if utf16_len(&json) <= KEYRING_CHUNK_LIMIT {
        return save_raw_to_keyring(key, &json);
    }
    // Too big for one entry — split and store a manifest under `key`.
    let chunks = split_by_utf16(&json, KEYRING_CHUNK_LIMIT);
    for (i, c) in chunks.iter().enumerate() {
        save_raw_to_keyring(&format!("{}::chunk::{}", key, i), c)?;
    }
    save_raw_to_keyring(key, &format!("{}{}", KEYRING_CHUNK_SENTINEL, chunks.len()))
}

pub fn load_from_keyring<T: for<'de> Deserialize<'de>>(key: &str) -> Option<T> {
    let raw = get_raw_from_keyring(key).ok()?;
    // Reassemble if this is a chunk manifest; otherwise the value is stored inline.
    let json = if let Some(n) = raw.strip_prefix(KEYRING_CHUNK_SENTINEL).and_then(|s| s.parse::<usize>().ok()) {
        let mut combined = String::new();
        for i in 0..n {
            combined.push_str(&get_raw_from_keyring(&format!("{}::chunk::{}", key, i)).ok()?);
        }
        combined
    } else {
        raw
    };
    serde_json::from_str(&json).ok()
}

// ── Raw per-entry access: Windows → Credential Manager (local); elsewhere → keyring ──

#[cfg(windows)]
pub fn save_raw_to_keyring(key: &str, value: &str) -> Result<(), String> {
    crate::wincred::set_raw(key, value)
}
#[cfg(windows)]
pub fn get_raw_from_keyring(key: &str) -> Result<String, String> {
    crate::wincred::get_raw(key)
}
#[cfg(windows)]
pub fn delete_raw_from_keyring(key: &str) -> Result<(), String> {
    crate::wincred::delete_raw(key)
}

#[cfg(not(windows))]
pub fn save_raw_to_keyring(key: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, key)
        .map_err(|e| format!("Keyring entry error: {}", e))?;
    entry.set_password(value)
        .map_err(|e| format!("Keyring store error: {}", e))
}
#[cfg(not(windows))]
pub fn get_raw_from_keyring(key: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, key)
        .map_err(|e| format!("Keyring entry error: {}", e))?;
    entry.get_password()
        .map_err(|e| format!("Keyring retrieve error: {}", e))
}
#[cfg(not(windows))]
pub fn delete_raw_from_keyring(key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, key)
        .map_err(|e| format!("Keyring entry error: {}", e))?;
    entry.delete_credential()
        .map_err(|e| format!("Keyring delete error: {}", e))
}

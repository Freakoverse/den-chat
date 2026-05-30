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
}

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

        Self {
            accounts: Mutex::new(accounts),
            seeds: Mutex::new(seeds),
            active_account: Mutex::new(active),
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

// ─── Keyring Helpers ────────────────────────────────────────────────────
// Windows Credential Manager has a ~2560-char UTF-16 limit per entry.
// Collections are stored as individual entries with a lightweight index.

pub fn save_to_keyring<T: Serialize>(key: &str, value: &T) -> Result<(), String> {
    let json = serde_json::to_string(value)
        .map_err(|e| format!("Serialization failed: {}", e))?;
    let entry = keyring::Entry::new(SERVICE_NAME, key)
        .map_err(|e| format!("Keyring entry error: {}", e))?;
    entry.set_password(&json)
        .map_err(|e| format!("Keyring store error: {}", e))?;
    Ok(())
}

pub fn load_from_keyring<T: for<'de> Deserialize<'de>>(key: &str) -> Option<T> {
    let entry = keyring::Entry::new(SERVICE_NAME, key).ok()?;
    let json = entry.get_password().ok()?;
    serde_json::from_str(&json).ok()
}

pub fn save_raw_to_keyring(key: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, key)
        .map_err(|e| format!("Keyring entry error: {}", e))?;
    entry.set_password(value)
        .map_err(|e| format!("Keyring store error: {}", e))?;
    Ok(())
}

pub fn get_raw_from_keyring(key: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, key)
        .map_err(|e| format!("Keyring entry error: {}", e))?;
    entry.get_password()
        .map_err(|e| format!("Keyring retrieve error: {}", e))
}

pub fn delete_raw_from_keyring(key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, key)
        .map_err(|e| format!("Keyring entry error: {}", e))?;
    entry.delete_credential()
        .map_err(|e| format!("Keyring delete error: {}", e))
}

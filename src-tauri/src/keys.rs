use crate::state::{
    AppState, AccountInfo, SeedInfo, AccountListItem,
    verify_pin_hash,
    save_raw_to_keyring, get_raw_from_keyring, delete_raw_from_keyring,
};
use crate::keystore;
use nostr_sdk::prelude::*;
use nostr_sdk::nips::nip06::FromMnemonic;
use tauri::State;
use tracing::info;
use zeroize::Zeroize;

// ─── Helpers ────────────────────────────────────────────────────────────

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn validate_pin(pin: &str) -> Result<(), String> {
    if pin.len() < 4 {
        return Err("PIN must be at least 4 characters".to_string());
    }
    Ok(())
}

// Keyring slot names for an account's secrets.
fn sk_key(pubkey: &str) -> String { format!("sk-{}", pubkey) }
/// Per-account encrypted copy of the seed mnemonic (so divergent-PIN siblings each unlock it).
fn mnseed_key(pubkey: &str) -> String { format!("mnseed-{}", pubkey) }
/// Legacy shared plaintext mnemonic slot (pre at-rest encryption). Read-only / migrated away.
fn seed_key(seed_id: &str) -> String { format!("seed-{}", seed_id) }

/// Read + decrypt an account's secret key, proving the PIN in the process.
///
/// Routed on the ACTUAL stored value, not the account's `encrypted` flag, so an interrupted migration
/// (flag and value momentarily disagreeing) still reads correctly: a `denc1:` value is decrypted with
/// the PIN; a legacy plaintext value is returned after a PIN-hash check. Wrong PIN → `Incorrect PIN`.
fn unlock_sk(pubkey: &str, pin_hash: &str, pin: &str) -> Result<String, String> {
    let raw = get_raw_from_keyring(&sk_key(pubkey))?;
    if keystore::is_encrypted(&raw) {
        keystore::decrypt(&raw, pin, &sk_key(pubkey))
    } else if verify_pin_hash(pin, pin_hash) {
        Ok(raw)
    } else {
        Err("Incorrect PIN".to_string())
    }
}

/// Read + decrypt an account's seed mnemonic (seed accounts only). Prefers the account's own
/// encrypted copy (`mnseed-<pubkey>`); otherwise verifies the PIN hash and reads the legacy shared
/// plaintext `seed-<id>`.
fn unlock_mnemonic(pubkey: &str, seed_id: &str, pin: &str, pin_hash: &str) -> Result<String, String> {
    if let Ok(raw) = get_raw_from_keyring(&mnseed_key(pubkey)) {
        if keystore::is_encrypted(&raw) {
            return keystore::decrypt(&raw, pin, &mnseed_key(pubkey));
        }
    }
    if !verify_pin_hash(pin, pin_hash) {
        return Err("Incorrect PIN".to_string());
    }
    get_raw_from_keyring(&seed_key(seed_id))
}

/// Lazily encrypt a legacy-plaintext account's secrets at rest, after its PIN has been proven correct.
/// Idempotent (no-op if already encrypted). Removes the shared legacy plaintext `seed-<id>` once every
/// sibling of that seed has its own encrypted mnemonic copy.
fn ensure_migrated(state: &AppState, pubkey: &str, pin: &str) -> Result<(), String> {
    let (already, seed_id) = {
        let accounts = state.accounts.lock().unwrap();
        match accounts.iter().find(|a| a.pubkey == pubkey) {
            Some(a) => (a.encrypted, a.seed_id.clone()),
            None => return Ok(()),
        }
    };
    if already {
        return Ok(());
    }

    // Encrypt the secret key (read current plaintext; skip the write if already a denc1 value).
    let mut sk_raw = get_raw_from_keyring(&sk_key(pubkey))?;
    if !keystore::is_encrypted(&sk_raw) {
        let enc = keystore::encrypt(&sk_raw, pin, &sk_key(pubkey))?;
        save_raw_to_keyring(&sk_key(pubkey), &enc)?;
    }
    sk_raw.zeroize();

    // Seed accounts: write this account's own encrypted copy of the mnemonic from the shared plaintext.
    if let Some(ref sid) = seed_id {
        let have_enc_copy = get_raw_from_keyring(&mnseed_key(pubkey))
            .map(|v| keystore::is_encrypted(&v))
            .unwrap_or(false);
        if !have_enc_copy {
            if let Ok(mut mnemonic) = get_raw_from_keyring(&seed_key(sid)) {
                if !keystore::is_encrypted(&mnemonic) {
                    let enc = keystore::encrypt(&mnemonic, pin, &mnseed_key(pubkey))?;
                    save_raw_to_keyring(&mnseed_key(pubkey), &enc)?;
                }
                mnemonic.zeroize();
            }
        }
    }

    // Mark encrypted + drop the legacy PIN hash.
    {
        let mut accounts = state.accounts.lock().unwrap();
        if let Some(a) = accounts.iter_mut().find(|a| a.pubkey == pubkey) {
            a.encrypted = true;
            a.pin_hash = String::new();
        }
    }
    state.save_accounts()?;

    // If every sibling of this seed is now encrypted, drop the shared plaintext mnemonic.
    if let Some(ref sid) = seed_id {
        let all_migrated = {
            let accounts = state.accounts.lock().unwrap();
            accounts.iter()
                .filter(|a| a.seed_id.as_deref() == Some(sid.as_str()))
                .all(|a| a.encrypted)
        };
        if all_migrated {
            let _ = delete_raw_from_keyring(&seed_key(sid));
        }
    }

    Ok(())
}

// ─── List Commands ──────────────────────────────────────────────────────

#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> Vec<AccountListItem> {
    let accounts = state.accounts.lock().unwrap();
    accounts.iter().map(|a| a.to_list_item()).collect()
}

#[tauri::command]
pub fn list_seeds(state: State<'_, AppState>) -> Vec<SeedInfo> {
    state.seeds.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_active_account(state: State<'_, AppState>) -> Option<String> {
    state.active_account.lock().unwrap().clone()
}

// ─── Generate Account (first seed) ─────────────────────────────────────

/// Generate a brand new seed phrase + derive the first keypair.
/// Used when no seeds exist yet, or when the user explicitly wants a new seed.
#[tauri::command]
pub fn generate_account(
    state: State<'_, AppState>,
    name: Option<String>,
    pin: String,
    pin_hint: Option<String>,
) -> Result<serde_json::Value, String> {
    validate_pin(&pin)?;

    use bip39::Mnemonic;
    use rand::RngCore;

    // Generate 256-bit entropy → 24-word mnemonic
    let mut entropy = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut entropy);
    let mnemonic = Mnemonic::from_entropy(&entropy)
        .map_err(|e| format!("Mnemonic generation failed: {}", e))?;
    let mnemonic_str = mnemonic.to_string();

    // Derive keypair at account index 0
    let keys = Keys::from_mnemonic_with_account(mnemonic_str.as_str(), None::<&str>, Some(0))
        .map_err(|e| format!("Key derivation failed: {}", e))?;

    let secret_key = keys.secret_key();
    let public_key = keys.public_key();
    let mut sk_hex = secret_key.to_secret_hex();
    let pubkey_hex = public_key.to_hex();
    let npub = public_key.to_bech32()
        .map_err(|e| format!("Bech32 error: {}", e))?;

    // Check duplicate
    {
        let accounts = state.accounts.lock().unwrap();
        if accounts.iter().any(|a| a.pubkey == pubkey_hex) {
            return Err("This account already exists".to_string());
        }
    }

    let seed_id = uuid::Uuid::new_v4().to_string();
    let seed_name = name.clone().unwrap_or_else(|| "My Seed".to_string());

    // Store secrets ENCRYPTED at rest (born encrypted — no plaintext slot is ever written).
    save_raw_to_keyring(&sk_key(&pubkey_hex), &keystore::encrypt(&sk_hex, &pin, &sk_key(&pubkey_hex))?)?;
    save_raw_to_keyring(&mnseed_key(&pubkey_hex), &keystore::encrypt(&mnemonic_str, &pin, &mnseed_key(&pubkey_hex))?)?;

    // Zeroize the secret key from memory
    sk_hex.zeroize();

    let acct = AccountInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name: Some(name.unwrap_or_else(|| "Account 1".to_string())),
        auth_method: "seed".to_string(),
        seed_id: Some(seed_id.clone()),
        account_index: Some(0),
        created_at: now_secs(),
        pin_hash: String::new(),
        pin_hint: pin_hint.clone(),
        encrypted: true,
    };

    let seed_info = SeedInfo {
        id: seed_id.clone(),
        name: seed_name,
        account_pubkeys: vec![pubkey_hex.clone()],
    };

    {
        let mut accounts = state.accounts.lock().unwrap();
        accounts.push(acct);
    }
    state.save_accounts()?;

    {
        let mut seeds = state.seeds.lock().unwrap();
        seeds.push(seed_info);
    }
    state.save_seeds()?;

    // Auto-activate if first account
    {
        let mut active = state.active_account.lock().unwrap();
        if active.is_none() {
            *active = Some(pubkey_hex.clone());
        }
    }
    state.save_active_account()?;

    info!("Generated new seed + account: {}", &npub[..24]);

    Ok(serde_json::json!({
        "pubkey": pubkey_hex,
        "npub": npub,
        "mnemonic": mnemonic_str,
        "seed_id": seed_id,
    }))
}

// ─── Generate New Seed (advanced) ───────────────────────────────────────

/// Generate a completely new seed (when user already has seeds but wants another).
/// Same logic as generate_account — this is the "Advanced > Generate New Seed" path.
#[tauri::command]
pub fn generate_new_seed(
    state: State<'_, AppState>,
    name: Option<String>,
    pin: String,
    pin_hint: Option<String>,
) -> Result<serde_json::Value, String> {
    // Delegates to the same logic
    generate_account(state, name, pin, pin_hint)
}

// ─── Derive Next Account (sibling from existing seed) ───────────────────

/// Derive the next keypair from an existing seed at the next available index.
#[tauri::command]
pub fn derive_next_account(
    state: State<'_, AppState>,
    seed_id: String,
    pin: String,
    pin_hint: Option<String>,
) -> Result<serde_json::Value, String> {
    validate_pin(&pin)?;

    // Find the seed
    let seed = {
        let seeds = state.seeds.lock().unwrap();
        seeds.iter().find(|s| s.id == seed_id).cloned()
            .ok_or("Seed not found")?
    };

    // Pick an existing sibling to verify the PIN against + source the mnemonic from.
    let (sibling_pubkey, sibling_pin_hash) = {
        let accounts = state.accounts.lock().unwrap();
        let sibling = accounts.iter()
            .find(|a| a.seed_id.as_deref() == Some(&seed_id))
            .ok_or("No existing accounts for this seed")?;
        (sibling.pubkey.clone(), sibling.pin_hash.clone())
    };

    // Retrieve mnemonic (decrypts the sibling's copy, or the legacy plaintext; verifies the PIN).
    let mnemonic = unlock_mnemonic(&sibling_pubkey, &seed_id, &pin, &sibling_pin_hash)
        .map_err(|e| if e == "Incorrect PIN" { "Incorrect PIN".to_string() } else { e })?;

    // Find next account index
    let next_index = {
        let accounts = state.accounts.lock().unwrap();
        let max_idx = accounts.iter()
            .filter(|a| a.seed_id.as_deref() == Some(&seed_id))
            .filter_map(|a| a.account_index)
            .max()
            .unwrap_or(0);
        if seed.account_pubkeys.is_empty() { 0 } else { max_idx + 1 }
    };

    // Derive keypair at next index
    let keys = Keys::from_mnemonic_with_account(mnemonic.as_str(), None::<&str>, Some(next_index))
        .map_err(|e| format!("Key derivation failed: {}", e))?;

    let secret_key = keys.secret_key();
    let public_key = keys.public_key();
    let mut sk_hex = secret_key.to_secret_hex();
    let pubkey_hex = public_key.to_hex();
    let npub = public_key.to_bech32()
        .map_err(|e| format!("Bech32 error: {}", e))?;

    // Check duplicate
    {
        let accounts = state.accounts.lock().unwrap();
        if accounts.iter().any(|a| a.pubkey == pubkey_hex) {
            return Err("This account already exists".to_string());
        }
    }

    // New account is born encrypted: its own sk + its own encrypted mnemonic copy.
    save_raw_to_keyring(&sk_key(&pubkey_hex), &keystore::encrypt(&sk_hex, &pin, &sk_key(&pubkey_hex))?)?;
    save_raw_to_keyring(&mnseed_key(&pubkey_hex), &keystore::encrypt(&mnemonic, &pin, &mnseed_key(&pubkey_hex))?)?;
    sk_hex.zeroize();

    let acct = AccountInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name: Some(format!("Account {}", next_index + 1)),
        auth_method: "seed".to_string(),
        seed_id: Some(seed_id.clone()),
        account_index: Some(next_index),
        created_at: now_secs(),
        pin_hash: String::new(),
        pin_hint: pin_hint.clone(),
        encrypted: true,
    };

    {
        let mut accounts = state.accounts.lock().unwrap();
        accounts.push(acct);
    }
    state.save_accounts()?;

    // Update seed's account list
    {
        let mut seeds = state.seeds.lock().unwrap();
        if let Some(s) = seeds.iter_mut().find(|s| s.id == seed_id) {
            s.account_pubkeys.push(pubkey_hex.clone());
        }
    }
    state.save_seeds()?;

    // Opportunistically migrate the sibling we used, so the shared plaintext mnemonic is cleaned up
    // once every sibling is encrypted. Best-effort — never fails the derive.
    let _ = ensure_migrated(&state, &sibling_pubkey, &pin);

    info!("Derived account #{} from seed '{}': {}", next_index, &seed.name, &npub[..24]);

    Ok(serde_json::json!({
        "pubkey": pubkey_hex,
        "npub": npub,
        "account_index": next_index,
    }))
}

// ─── Import Seed ────────────────────────────────────────────────────────

#[tauri::command]
pub fn import_seed(
    state: State<'_, AppState>,
    mnemonic: String,
    name: Option<String>,
    pin: String,
    pin_hint: Option<String>,
) -> Result<serde_json::Value, String> {
    validate_pin(&pin)?;

    // Validate word count
    let words: Vec<&str> = mnemonic.trim().split_whitespace().collect();
    if words.len() != 12 && words.len() != 24 {
        return Err("Seed phrase must be 12 or 24 words".to_string());
    }

    // Derive first keypair (index 0)
    let keys = Keys::from_mnemonic_with_account(mnemonic.trim(), None::<&str>, Some(0))
        .map_err(|e| format!("Invalid mnemonic: {}", e))?;

    let secret_key = keys.secret_key();
    let public_key = keys.public_key();
    let mut sk_hex = secret_key.to_secret_hex();
    let pubkey_hex = public_key.to_hex();
    let npub = public_key.to_bech32()
        .map_err(|e| format!("Bech32 error: {}", e))?;

    // Check duplicate
    {
        let accounts = state.accounts.lock().unwrap();
        if accounts.iter().any(|a| a.pubkey == pubkey_hex) {
            return Err("An account from this seed already exists".to_string());
        }
    }

    let seed_id = uuid::Uuid::new_v4().to_string();
    let seed_name = name.clone().unwrap_or_else(|| "Imported Seed".to_string());

    // Store secrets encrypted at rest (born encrypted).
    let mnemonic_trim = mnemonic.trim().to_string();
    save_raw_to_keyring(&sk_key(&pubkey_hex), &keystore::encrypt(&sk_hex, &pin, &sk_key(&pubkey_hex))?)?;
    save_raw_to_keyring(&mnseed_key(&pubkey_hex), &keystore::encrypt(&mnemonic_trim, &pin, &mnseed_key(&pubkey_hex))?)?;
    sk_hex.zeroize();

    let acct = AccountInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name: Some(name.unwrap_or_else(|| "Account 1".to_string())),
        auth_method: "seed".to_string(),
        seed_id: Some(seed_id.clone()),
        account_index: Some(0),
        created_at: now_secs(),
        pin_hash: String::new(),
        pin_hint: pin_hint.clone(),
        encrypted: true,
    };

    let seed_info = SeedInfo {
        id: seed_id.clone(),
        name: seed_name,
        account_pubkeys: vec![pubkey_hex.clone()],
    };

    {
        let mut accounts = state.accounts.lock().unwrap();
        accounts.push(acct);
    }
    state.save_accounts()?;

    {
        let mut seeds = state.seeds.lock().unwrap();
        seeds.push(seed_info);
    }
    state.save_seeds()?;

    {
        let mut active = state.active_account.lock().unwrap();
        if active.is_none() {
            *active = Some(pubkey_hex.clone());
        }
    }
    state.save_active_account()?;

    info!("Imported seed: {}", &npub[..24]);

    Ok(serde_json::json!({
        "pubkey": pubkey_hex,
        "npub": npub,
        "seed_id": seed_id,
    }))
}

// ─── Import nsec / Private Key Hex ──────────────────────────────────────

#[tauri::command]
pub fn import_nsec(
    state: State<'_, AppState>,
    nsec_or_hex: String,
    name: Option<String>,
    pin: String,
    pin_hint: Option<String>,
) -> Result<serde_json::Value, String> {
    validate_pin(&pin)?;

    let input = nsec_or_hex.trim();

    // Try bech32 nsec first, then raw hex
    let secret_key = if input.starts_with("nsec1") {
        SecretKey::from_bech32(input)
            .map_err(|e| format!("Invalid nsec: {}", e))?
    } else if input.len() == 64 && input.chars().all(|c| c.is_ascii_hexdigit()) {
        SecretKey::from_hex(input)
            .map_err(|e| format!("Invalid private key hex: {}", e))?
    } else {
        return Err("Invalid key format — provide an nsec or 64-char hex private key".to_string());
    };

    let keys = Keys::new(secret_key);
    let public_key = keys.public_key();
    let mut sk_hex = keys.secret_key().to_secret_hex();
    let pubkey_hex = public_key.to_hex();
    let npub = public_key.to_bech32()
        .map_err(|e| format!("Bech32 error: {}", e))?;

    // Check duplicate
    {
        let accounts = state.accounts.lock().unwrap();
        if accounts.iter().any(|a| a.pubkey == pubkey_hex) {
            return Err("This account already exists".to_string());
        }
    }

    save_raw_to_keyring(&sk_key(&pubkey_hex), &keystore::encrypt(&sk_hex, &pin, &sk_key(&pubkey_hex))?)?;
    sk_hex.zeroize();

    let acct = AccountInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name: name.or(Some("Imported Key".to_string())),
        auth_method: "nsec".to_string(),
        seed_id: None,
        account_index: None,
        created_at: now_secs(),
        pin_hash: String::new(),
        pin_hint: pin_hint.clone(),
        encrypted: true,
    };

    {
        let mut accounts = state.accounts.lock().unwrap();
        accounts.push(acct);
    }
    state.save_accounts()?;

    {
        let mut active = state.active_account.lock().unwrap();
        if active.is_none() {
            *active = Some(pubkey_hex.clone());
        }
    }
    state.save_active_account()?;

    info!("Imported nsec: {}", &npub[..24]);

    Ok(serde_json::json!({
        "pubkey": pubkey_hex,
        "npub": npub,
    }))
}

// ─── PIN Verification ───────────────────────────────────────────────────

#[tauri::command]
pub fn verify_pin(
    state: State<'_, AppState>,
    pubkey: String,
    pin: String,
) -> Result<bool, String> {
    let pin_hash = {
        let accounts = state.accounts.lock().unwrap();
        let acct = accounts.iter().find(|a| a.pubkey == pubkey)
            .ok_or("Account not found")?;
        acct.pin_hash.clone()
    };

    match unlock_sk(&pubkey, &pin_hash, &pin) {
        Ok(mut sk) => {
            sk.zeroize();
            // Correct PIN — migrate the account to at-rest encryption if it's still legacy.
            ensure_migrated(&state, &pubkey, &pin)?;
            Ok(true)
        }
        Err(ref e) if e == "Incorrect PIN" => Ok(false),
        Err(e) => Err(e),
    }
}

// ─── Login (PIN-gated) ─────────────────────────────────────────────────

/// Returns the private key hex after PIN verification.
/// This is the ONLY path that releases the private key to the frontend.
#[tauri::command]
pub fn login_account(
    state: State<'_, AppState>,
    pubkey: String,
    pin: String,
) -> Result<serde_json::Value, String> {
    let pin_hash = {
        let accounts = state.accounts.lock().unwrap();
        let acct = accounts.iter().find(|a| a.pubkey == pubkey)
            .ok_or("Account not found")?;
        acct.pin_hash.clone()
    };

    // Decrypt (or legacy-read) the secret key — proves the PIN.
    let sk_hex = unlock_sk(&pubkey, &pin_hash, &pin)?;

    // Migrate legacy storage to at-rest encryption now that the PIN is proven.
    ensure_migrated(&state, &pubkey, &pin)?;

    // Set as active account
    {
        let mut active = state.active_account.lock().unwrap();
        *active = Some(pubkey.clone());
    }
    state.save_active_account()?;

    info!("Login: {}...", &pubkey[..16]);

    Ok(serde_json::json!({
        "private_key_hex": sk_hex,
    }))
}

// ─── Delete Account (PIN-gated) ─────────────────────────────────────────

#[tauri::command]
pub fn delete_account(
    state: State<'_, AppState>,
    pubkey: String,
    pin: String,
) -> Result<(), String> {
    // Verify PIN + capture seed_id
    let (pin_hash, seed_id) = {
        let accounts = state.accounts.lock().unwrap();
        let acct = accounts.iter().find(|a| a.pubkey == pubkey)
            .ok_or("Account not found")?;
        (acct.pin_hash.clone(), acct.seed_id.clone())
    };
    match unlock_sk(&pubkey, &pin_hash, &pin) {
        Ok(mut sk) => sk.zeroize(),
        Err(e) => return Err(e),
    }

    // Delete this account's secrets from the keyring
    let _ = delete_raw_from_keyring(&sk_key(&pubkey));
    let _ = delete_raw_from_keyring(&mnseed_key(&pubkey));

    // Remove from accounts (lock must be dropped before save_accounts)
    {
        let mut accounts = state.accounts.lock().unwrap();
        accounts.retain(|a| a.pubkey != pubkey);
    } // ← accounts lock dropped
    state.save_accounts()?;

    // Remove from parent seed's account list
    if let Some(ref sid) = seed_id {
        let mut should_delete_seed: Option<String> = None;
        {
            let mut seeds = state.seeds.lock().unwrap();
            if let Some(seed) = seeds.iter_mut().find(|s| s.id == *sid) {
                seed.account_pubkeys.retain(|pk| pk != &pubkey);
                if seed.account_pubkeys.is_empty() {
                    should_delete_seed = Some(seed.id.clone());
                    seeds.retain(|s| s.id != *sid);
                }
            }
        } // ← seeds lock dropped

        // Delete any legacy shared mnemonic from keyring if seed was removed
        if let Some(ref dead_seed_id) = should_delete_seed {
            let _ = delete_raw_from_keyring(&seed_key(dead_seed_id));
        }

        let _ = state.save_seeds();
    }

    // Fix active account
    {
        let new_active = {
            let accounts = state.accounts.lock().unwrap();
            accounts.first().map(|a| a.pubkey.clone())
        }; // ← accounts lock dropped
        let mut active = state.active_account.lock().unwrap();
        if active.as_deref() == Some(&pubkey) {
            *active = new_active;
        }
    } // ← active_account lock dropped
    state.save_active_account()?;

    info!("Deleted account: {}...", &pubkey[..16]);

    Ok(())
}

// ─── Export Seed (PIN-gated) ────────────────────────────────────────────

#[tauri::command]
pub fn export_seed(
    state: State<'_, AppState>,
    pubkey: String,
    pin: String,
) -> Result<String, String> {
    // Find seed_id + pin hash
    let (pin_hash, seed_id) = {
        let accounts = state.accounts.lock().unwrap();
        let acct = accounts.iter().find(|a| a.pubkey == pubkey)
            .ok_or("Account not found")?;
        let sid = acct.seed_id.clone()
            .ok_or("This account has no seed phrase (imported as raw key)")?;
        (acct.pin_hash.clone(), sid)
    };

    let mnemonic = unlock_mnemonic(&pubkey, &seed_id, &pin, &pin_hash)?;
    // Correct PIN proven — migrate if still legacy.
    ensure_migrated(&state, &pubkey, &pin)?;
    Ok(mnemonic)
}

// ─── Export nsec (PIN-gated) ────────────────────────────────────────────

#[tauri::command]
pub fn export_nsec(
    state: State<'_, AppState>,
    pubkey: String,
    pin: String,
) -> Result<String, String> {
    let pin_hash = {
        let accounts = state.accounts.lock().unwrap();
        let acct = accounts.iter().find(|a| a.pubkey == pubkey)
            .ok_or("Account not found")?;
        acct.pin_hash.clone()
    };

    let sk_hex = unlock_sk(&pubkey, &pin_hash, &pin)?;
    ensure_migrated(&state, &pubkey, &pin)?;

    let secret_key = SecretKey::from_hex(&sk_hex)
        .map_err(|e| format!("Invalid stored key: {}", e))?;
    let nsec = secret_key.to_bech32()
        .map_err(|e| format!("Bech32 error: {}", e))?;

    Ok(nsec)
}

// ─── Rename Account ─────────────────────────────────────────────────────

#[tauri::command]
pub fn rename_account(
    state: State<'_, AppState>,
    pubkey: String,
    name: String,
) -> Result<(), String> {
    {
        let mut accounts = state.accounts.lock().unwrap();
        if let Some(acct) = accounts.iter_mut().find(|a| a.pubkey == pubkey) {
            acct.name = Some(name.clone());
        } else {
            return Err("Account not found".to_string());
        }
    }
    state.save_accounts()?;

    info!("Renamed account {}... to '{}'", &pubkey[..16], &name);

    Ok(())
}

// ─── Rename Seed ────────────────────────────────────────────────────────

#[tauri::command]
pub fn rename_seed(
    state: State<'_, AppState>,
    seed_id: String,
    name: String,
) -> Result<(), String> {
    {
        let mut seeds = state.seeds.lock().unwrap();
        if let Some(seed) = seeds.iter_mut().find(|s| s.id == seed_id) {
            seed.name = name.clone();
        } else {
            return Err("Seed not found".to_string());
        }
    }
    state.save_seeds()?;

    info!("Renamed seed {} to '{}'", &seed_id[..8], &name);

    Ok(())
}

// ─── Change PIN ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn change_pin(
    state: State<'_, AppState>,
    pubkey: String,
    current_pin: String,
    new_pin: String,
    new_hint: Option<String>,
) -> Result<(), String> {
    validate_pin(&new_pin)?;

    // Snapshot what we need, then release the lock before any keyring crypto.
    let (pin_hash, seed_id) = {
        let accounts = state.accounts.lock().unwrap();
        let acct = accounts.iter().find(|a| a.pubkey == pubkey)
            .ok_or("Account not found")?;
        (acct.pin_hash.clone(), acct.seed_id.clone())
    };

    // Verify current PIN by unlocking the secret key.
    let mut sk_hex = unlock_sk(&pubkey, &pin_hash, &current_pin)
        .map_err(|e| if e == "Incorrect PIN" { "Current PIN is incorrect".to_string() } else { e })?;

    // Re-encrypt the secret key under the new PIN.
    let sk_enc = keystore::encrypt(&sk_hex, &new_pin, &sk_key(&pubkey))?;
    sk_hex.zeroize();
    save_raw_to_keyring(&sk_key(&pubkey), &sk_enc)?;

    // Seed accounts: re-encrypt this account's mnemonic copy under the new PIN.
    if let Some(ref sid) = seed_id {
        let mut mnemonic = unlock_mnemonic(&pubkey, sid, &current_pin, &pin_hash)?;
        let mn_enc = keystore::encrypt(&mnemonic, &new_pin, &mnseed_key(&pubkey))?;
        mnemonic.zeroize();
        save_raw_to_keyring(&mnseed_key(&pubkey), &mn_enc)?;
    }

    // Update metadata: now encrypted, legacy hash dropped, hint updated.
    {
        let mut accounts = state.accounts.lock().unwrap();
        if let Some(acct) = accounts.iter_mut().find(|a| a.pubkey == pubkey) {
            acct.encrypted = true;
            acct.pin_hash = String::new();
            acct.pin_hint = new_hint;
        }
    }
    state.save_accounts()?;

    // If every sibling of this seed is now encrypted, drop the shared plaintext mnemonic.
    if let Some(ref sid) = seed_id {
        let all_migrated = {
            let accounts = state.accounts.lock().unwrap();
            accounts.iter()
                .filter(|a| a.seed_id.as_deref() == Some(sid.as_str()))
                .all(|a| a.encrypted)
        };
        if all_migrated {
            let _ = delete_raw_from_keyring(&seed_key(sid));
        }
    }

    info!("Changed PIN for account {}...", &pubkey[..16]);

    Ok(())
}

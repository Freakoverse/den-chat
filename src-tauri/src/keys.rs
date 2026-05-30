use crate::state::{
    AppState, AccountInfo, SeedInfo, AccountListItem,
    hash_pin, verify_pin_hash,
    save_raw_to_keyring, get_raw_from_keyring, delete_raw_from_keyring,
};
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

    // Store secrets in OS keyring
    save_raw_to_keyring(&format!("seed-{}", seed_id), &mnemonic_str)?;
    save_raw_to_keyring(&format!("sk-{}", pubkey_hex), &sk_hex)?;

    // Zeroize the secret key from memory
    sk_hex.zeroize();

    let pin_hash = hash_pin(&pin);

    let acct = AccountInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name: Some(name.unwrap_or_else(|| "Account 1".to_string())),
        auth_method: "seed".to_string(),
        seed_id: Some(seed_id.clone()),
        account_index: Some(0),
        created_at: now_secs(),
        pin_hash,
        pin_hint: pin_hint.clone(),
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

    // Verify PIN against an existing sibling account under this seed
    {
        let accounts = state.accounts.lock().unwrap();
        let sibling = accounts.iter()
            .find(|a| a.seed_id.as_deref() == Some(&seed_id))
            .ok_or("No existing accounts for this seed")?;
        if !verify_pin_hash(&pin, &sibling.pin_hash) {
            return Err("Incorrect PIN".to_string());
        }
    }

    // Retrieve mnemonic from keyring
    let mnemonic = get_raw_from_keyring(&format!("seed-{}", seed_id))?;

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

    save_raw_to_keyring(&format!("sk-{}", pubkey_hex), &sk_hex)?;
    sk_hex.zeroize();

    let pin_hash = hash_pin(&pin);

    let acct = AccountInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name: Some(format!("Account {}", next_index + 1)),
        auth_method: "seed".to_string(),
        seed_id: Some(seed_id.clone()),
        account_index: Some(next_index),
        created_at: now_secs(),
        pin_hash,
        pin_hint: pin_hint.clone(),
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

    // Store secrets
    save_raw_to_keyring(&format!("seed-{}", seed_id), mnemonic.trim())?;
    save_raw_to_keyring(&format!("sk-{}", pubkey_hex), &sk_hex)?;
    sk_hex.zeroize();

    let pin_hash = hash_pin(&pin);

    let acct = AccountInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name: Some(name.unwrap_or_else(|| "Account 1".to_string())),
        auth_method: "seed".to_string(),
        seed_id: Some(seed_id.clone()),
        account_index: Some(0),
        created_at: now_secs(),
        pin_hash,
        pin_hint: pin_hint.clone(),
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

    save_raw_to_keyring(&format!("sk-{}", pubkey_hex), &sk_hex)?;
    sk_hex.zeroize();

    let pin_hash = hash_pin(&pin);

    let acct = AccountInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name: name.or(Some("Imported Key".to_string())),
        auth_method: "nsec".to_string(),
        seed_id: None,
        account_index: None,
        created_at: now_secs(),
        pin_hash,
        pin_hint: pin_hint.clone(),
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
    let accounts = state.accounts.lock().unwrap();
    match accounts.iter().find(|a| a.pubkey == pubkey) {
        Some(acct) => Ok(verify_pin_hash(&pin, &acct.pin_hash)),
        None => Err("Account not found".to_string()),
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
    // Verify PIN
    {
        let accounts = state.accounts.lock().unwrap();
        let acct = accounts.iter().find(|a| a.pubkey == pubkey)
            .ok_or("Account not found")?;
        if !verify_pin_hash(&pin, &acct.pin_hash) {
            return Err("Incorrect PIN".to_string());
        }
    }

    // Retrieve secret key from keyring
    let sk_hex = get_raw_from_keyring(&format!("sk-{}", pubkey))?;

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
    // Verify PIN
    let seed_id = {
        let accounts = state.accounts.lock().unwrap();
        let acct = accounts.iter().find(|a| a.pubkey == pubkey)
            .ok_or("Account not found")?;
        if !verify_pin_hash(&pin, &acct.pin_hash) {
            return Err("Incorrect PIN".to_string());
        }
        acct.seed_id.clone()
    };

    // Delete secret key from keyring
    let _ = delete_raw_from_keyring(&format!("sk-{}", pubkey));

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

        // Delete mnemonic from keyring if seed was removed
        if let Some(ref dead_seed_id) = should_delete_seed {
            let _ = delete_raw_from_keyring(&format!("seed-{}", dead_seed_id));
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
    // Verify PIN + find seed_id
    let seed_id = {
        let accounts = state.accounts.lock().unwrap();
        let acct = accounts.iter().find(|a| a.pubkey == pubkey)
            .ok_or("Account not found")?;
        if !verify_pin_hash(&pin, &acct.pin_hash) {
            return Err("Incorrect PIN".to_string());
        }
        acct.seed_id.clone()
            .ok_or("This account has no seed phrase (imported as raw key)")?
    };

    get_raw_from_keyring(&format!("seed-{}", seed_id))
}

// ─── Export nsec (PIN-gated) ────────────────────────────────────────────

#[tauri::command]
pub fn export_nsec(
    state: State<'_, AppState>,
    pubkey: String,
    pin: String,
) -> Result<String, String> {
    // Verify PIN
    {
        let accounts = state.accounts.lock().unwrap();
        let acct = accounts.iter().find(|a| a.pubkey == pubkey)
            .ok_or("Account not found")?;
        if !verify_pin_hash(&pin, &acct.pin_hash) {
            return Err("Incorrect PIN".to_string());
        }
    }

    let sk_hex = get_raw_from_keyring(&format!("sk-{}", pubkey))?;
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

    {
        let mut accounts = state.accounts.lock().unwrap();
        let acct = accounts.iter_mut().find(|a| a.pubkey == pubkey)
            .ok_or("Account not found")?;

        if !verify_pin_hash(&current_pin, &acct.pin_hash) {
            return Err("Current PIN is incorrect".to_string());
        }

        acct.pin_hash = hash_pin(&new_pin);
        acct.pin_hint = new_hint;
    }
    state.save_accounts()?;

    info!("Changed PIN for account {}...", &pubkey[..16]);

    Ok(())
}

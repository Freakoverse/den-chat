use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::Emitter;

/// Progress event payload emitted during download
#[derive(Clone, Serialize)]
pub struct UpdateDownloadProgress {
    pub percent: u8,
    pub downloaded: u64,
    pub total: u64,
    pub speed: u64, // bytes per second
}

/// Result returned from download_update
#[derive(Clone, Serialize)]
pub struct DownloadResult {
    pub path: String,
    pub hash: String, // computed SHA-256
    pub verified: bool,
}

/// Download a file from a URL to a temp directory, emitting progress events.
/// Optionally verifies the SHA-256 hash if `expected_hash` is provided.
/// Returns the path, computed hash, and verification status.
#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    url: String,
    filename: String,
    expected_hash: Option<String>,
) -> Result<DownloadResult, String> {
    // Create temp directory for the update
    let temp_dir = std::env::temp_dir().join("den-chat-update");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {}", e))?;

    let file_path = temp_dir.join(&filename);

    // Start the download
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(600)) // 10 min timeout
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to start download: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let start_time = std::time::Instant::now();
    let mut hasher = Sha256::new();

    // Open file for writing
    let mut file = std::fs::File::create(&file_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;

    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|e| format!("Failed to write file: {}", e))?;
        hasher.update(&chunk);

        downloaded += chunk.len() as u64;

        // Emit progress at most every 100ms to avoid flooding
        if last_emit.elapsed().as_millis() >= 100 {
            let elapsed = start_time.elapsed().as_secs_f64();
            let speed = if elapsed > 0.0 {
                (downloaded as f64 / elapsed) as u64
            } else {
                0
            };
            let percent = if total > 0 {
                ((downloaded as f64 / total as f64) * 100.0) as u8
            } else {
                0
            };

            let _ = app.emit(
                "den-update-progress",
                UpdateDownloadProgress {
                    percent,
                    downloaded,
                    total,
                    speed,
                },
            );
            last_emit = std::time::Instant::now();
        }
    }

    // Final progress emit at 100%
    let elapsed = start_time.elapsed().as_secs_f64();
    let speed = if elapsed > 0.0 {
        (downloaded as f64 / elapsed) as u64
    } else {
        0
    };
    let _ = app.emit(
        "den-update-progress",
        UpdateDownloadProgress {
            percent: 100,
            downloaded,
            total: downloaded,
            speed,
        },
    );

    // Compute final hash
    let computed_hash = format!("{:x}", hasher.finalize());

    // Verify if expected hash was provided
    let verified = match &expected_hash {
        Some(expected) if !expected.is_empty() => {
            if computed_hash != expected.to_lowercase() {
                // Delete the file if hash doesn't match
                let _ = std::fs::remove_file(&file_path);
                return Err(format!(
                    "Hash mismatch! Expected: {}, Got: {}. The file may have been tampered with.",
                    expected, computed_hash
                ));
            }
            true
        }
        _ => false, // No hash to verify against
    };

    Ok(DownloadResult {
        path: file_path.to_string_lossy().to_string(),
        hash: computed_hash,
        verified,
    })
}

/// Launch the downloaded installer and exit the app.
/// On Windows: runs the NSIS installer with /S (silent) flag.
/// On other platforms: returns an error (manual install required).
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err("Installer file not found".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // Launch the NSIS installer in silent mode
        // /S = silent, no user interaction
        std::process::Command::new(&file_path)
            .arg("/S")
            .spawn()
            .map_err(|e| format!("Failed to launch installer: {}", e))?;

        // Give the installer a moment to start before we exit
        std::thread::sleep(std::time::Duration::from_millis(500));

        // Exit the app so the installer can replace files
        app.exit(0);

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On non-Windows, we can't auto-install — the download is already saved
        let _ = app; // suppress unused warning
        Err("Auto-install is only supported on Windows. Please install the update manually.".to_string())
    }
}

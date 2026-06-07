// Prevents an additional console window on Windows in release builds.
// DO NOT REMOVE — this is required for production.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Fix WebKitGTK blank-window-on-alt-tab bug on Linux.
    // Must be set before ANY WebKit/GTK code loads — main() is the earliest point.
    #[cfg(target_os = "linux")]
    {
        // Disable DMA-BUF renderer — fixes blank window after alt-tab on some GPUs
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
        }
        // Disable compositing mode — alternative fix for compositing-related blanking
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            unsafe { std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1") };
        }
    }

    den_chat_lib::run()
}

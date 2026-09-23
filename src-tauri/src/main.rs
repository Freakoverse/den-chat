// Prevents an additional console window on Windows in release builds.
// DO NOT REMOVE — this is required for production.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Fix WebKitGTK blank-window-on-alt-tab bug on Linux.
    // Must be set before ANY WebKit/GTK code loads — main() is the earliest point.
    #[cfg(target_os = "linux")]
    {
        // NVIDIA + Wayland: the driver's explicit-sync path can crash WebKitGTK's web process ("Error
        // 71"), one cause of the blank window (menus render, the web view stays white). This variable is
        // read ONLY by the NVIDIA driver, so it's a no-op on Intel/AMD and on X11, and it carries no
        // performance cost — safe to set unconditionally. Official Tauri guidance
        // (https://v2.tauri.app/develop/debug/linux-graphics/). We never override a user-set value.
        if std::env::var("__NV_DISABLE_EXPLICIT_SYNC").is_err() {
            unsafe { std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1") };
        }
        // Disable the WebKitGTK DMA-BUF renderer — the targeted fix for the blank-window-after-alt-tab
        // bug on many GPUs/drivers (WebKitGTK 2.42+). Crucially this KEEPS accelerated compositing on,
        // so scrolling stays GPU-composited and smooth.
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
        }
        // NOTE: we deliberately do NOT force WEBKIT_DISABLE_COMPOSITING_MODE. It also stops the alt-tab
        // blanking on some setups, but it disables accelerated compositing entirely — which makes
        // scrolling abysmal on WebKitGTK. Disabling the DMA-BUF renderer above already fixes the blank
        // window on virtually all affected GPUs. If a specific setup STILL blanks after alt-tab, the
        // user can opt in by exporting WEBKIT_DISABLE_COMPOSITING_MODE=1 (we leave any pre-set value
        // untouched and never override the user's choice).
        // Strip xapp-gtk3-module from GTK_MODULES — this module only exists on
        // Mint/Debian/Ubuntu. On Arch/CachyOS it's absent, causing GTK critical
        // warnings and potential WebKitWebProcess crashes (blank window).
        if let Ok(modules) = std::env::var("GTK_MODULES") {
            let filtered: Vec<&str> = modules
                .split(':')
                .filter(|m| !m.contains("xapp-gtk3-module"))
                .collect();
            unsafe { std::env::set_var("GTK_MODULES", filtered.join(":")) };
        }
    }

    den_chat_lib::run()
}

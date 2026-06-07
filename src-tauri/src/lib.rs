mod keys;
mod ptt;
mod state;
mod link_preview;

use link_preview::fetch_link_preview;
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Fix WebKitGTK blank-window-on-alt-tab bug on Linux.
    // These must be set before the webview is created.
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // When a second instance is launched, bring the existing window to front
            use tauri::Manager;
            use tauri::Emitter;

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }

            // Forward any denchat:// deep link URLs from argv to the frontend
            let urls: Vec<String> = argv.into_iter()
                .filter(|a| a.starts_with("denchat://"))
                .collect();
            if !urls.is_empty() {
                let _ = app.emit("deep-link://new-url", urls);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState::new())
        .setup(|app| {
            use tauri::Manager;
            use tauri::Listener;

            // ── Deep-link: bring window to front when a deep link activates the app ──
            let handle = app.handle().clone();
            app.listen("deep-link://new-url", move |_event| {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });

            // Register the denchat:// scheme with the OS
            // (In production the installer does this, but this ensures it works in dev too)
            use tauri_plugin_deep_link::DeepLinkExt;
            let _ = app.deep_link().register_all();

            // ── System tray ──
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

                let show_i = MenuItem::with_id(app, "show", "Show DEN Chat", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

                TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .tooltip("DEN Chat")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            // On Windows, auto-grant WebView2 permission requests (microphone, camera, etc.)
            // so the browser-style "wants to use your microphone" popup is suppressed.
            #[cfg(target_os = "windows")]
            {
                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.with_webview(move |webview| {
                        unsafe {
                            use webview2_com::PermissionRequestedEventHandler;
                            use webview2_com::Microsoft::Web::WebView2::Win32::*;

                            let core = webview.controller().CoreWebView2().unwrap();
                            let handler = PermissionRequestedEventHandler::create(Box::new(
                                |_sender, args| {
                                    if let Some(args) = args {
                                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                                    }
                                    Ok(())
                                },
                            ));
                            let mut token = std::mem::zeroed();
                            core.add_PermissionRequested(&handler, &mut token).ok();
                        }
                    });
                }
            }
            Ok(())
        })
        // Hide to tray instead of quitting when the window close button is clicked
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            fetch_link_preview,
            keys::list_accounts,
            keys::list_seeds,
            keys::generate_account,
            keys::generate_new_seed,
            keys::derive_next_account,
            keys::import_seed,
            keys::import_nsec,
            keys::verify_pin,
            keys::login_account,
            keys::delete_account,
            keys::export_seed,
            keys::export_nsec,
            keys::rename_account,
            keys::rename_seed,
            keys::change_pin,
            keys::get_active_account,
            ptt::start_ptt_watch,
            ptt::stop_ptt_watch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DEN Chat");
}

mod keys;
mod ptt;
mod state;
mod link_preview;

use link_preview::fetch_link_preview;
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .setup(|app| {
            use tauri::Manager;

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

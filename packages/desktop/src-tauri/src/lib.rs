mod computer_use;
mod screen;

use tauri::{
    menu::{MenuBuilder, MenuEvent, MenuItemBuilder},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Emitter, Manager,
};

/// Holds the tray icon so it isn't dropped (which would remove it from the menu bar).
struct TrayState(TrayIcon);


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(screen::CaptureSession::new())
        .invoke_handler(tauri::generate_handler![
            screen::capture_screen,
            screen::start_capture,
            screen::stop_capture,
            computer_use::run_shell_command,
        ])
        .setup(|app| {
            // --- System tray with right-click menu ---
            let show = MenuItemBuilder::with_id("show", "Show/Hide Edith").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&menu)
                .on_menu_event(
                    move |app_handle: &AppHandle, event: MenuEvent| match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let visible: bool = window.is_visible().unwrap_or(false);
                                if visible {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                        "quit" => {
                            app_handle.exit(0);
                        }
                        _ => {}
                    },
                )
                .build(app)?;

            // Store tray in managed state so it lives for the app's lifetime
            app.manage(TrayState(tray));

            // Check for updates in background after a short delay
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // 5-second delay so the app finishes initialising first
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                check_for_update(handle).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Edith desktop app");
}

/// Check for a newer release via the configured updater endpoint.
/// If one is found, emit an `update-available` event to the frontend.
async fn check_for_update(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let body = update.body.clone().unwrap_or_default();
                let _ = app.emit(
                    "update-available",
                    serde_json::json!({ "version": version, "notes": body }),
                );
            }
            Ok(None) => {}
            Err(e) => {
                // Non-fatal — offline or endpoint unreachable
                eprintln!("[updater] check failed: {e}");
            }
        },
        Err(e) => {
            eprintln!("[updater] could not build updater: {e}");
        }
    }
}

use tauri::{
    menu::{MenuBuilder, MenuEvent, MenuItemBuilder},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Manager,
};

/// Holds the tray icon so it isn't dropped (which would remove it from the menu bar).
struct TrayState(TrayIcon);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Edith desktop app");
}

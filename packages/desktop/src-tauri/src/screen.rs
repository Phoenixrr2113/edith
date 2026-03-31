/// Screen capture module — uses `xcrun screencapture` via the OS shell.
///
/// Why xcrun screencapture vs screencapturekit-rs:
/// - No native dependency build complexity in CI
/// - Produces identical output (PNG from ScreenCaptureKit under the hood)
/// - Sufficient for 1 FPS context-awareness use case
///
/// Permission: macOS requires Screen Recording permission. The first capture
/// attempt will trigger the system prompt if permission hasn't been granted.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;

// ── CaptureSession ─────────────────────────────────────────────────────────

/// Shared capture state — stored as Tauri managed state.
pub struct CaptureSession {
    /// True while periodic capture is running.
    running: Arc<Mutex<bool>>,
}

impl CaptureSession {
    pub fn new() -> Self {
        CaptureSession {
            running: Arc::new(Mutex::new(false)),
        }
    }

    pub fn is_running(&self) -> bool {
        *self.running.lock().unwrap()
    }

    pub fn set_running(&self, val: bool) {
        *self.running.lock().unwrap() = val;
    }

    pub fn running_flag(&self) -> Arc<Mutex<bool>> {
        Arc::clone(&self.running)
    }
}

// ── Single-shot capture ─────────────────────────────────────────────────────

/// Capture the primary display and return a base64-encoded PNG string.
///
/// Uses a temp file: `xcrun screencapture -x -t png <path>`
/// The `-x` flag suppresses the shutter sound.
pub async fn capture_screen_to_base64(app: &AppHandle) -> Result<String, String> {
    let tmp = tempfile::Builder::new()
        .suffix(".png")
        .tempfile()
        .map_err(|e| format!("Failed to create temp file: {e}"))?;

    let path = tmp.path().to_string_lossy().to_string();

    // Keep the file handle alive until after the capture completes.
    let output = app
        .shell()
        .command("xcrun")
        .args(["screencapture", "-x", "-t", "png", &path])
        .output()
        .await
        .map_err(|e| format!("screencapture command failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("screencapture exited non-zero: {stderr}"));
    }

    let bytes = std::fs::read(tmp.path())
        .map_err(|e| format!("Failed to read captured PNG: {e}"))?;

    if bytes.is_empty() {
        return Err("screencapture produced an empty file — Screen Recording permission may be denied".to_string());
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Tauri command: capture a single screenshot and return it as a base64 PNG.
#[tauri::command]
pub async fn capture_screen(app: AppHandle) -> Result<String, String> {
    capture_screen_to_base64(&app).await
}

/// Tauri command: start periodic screen capture at the given interval.
///
/// Emits a `screen-frame` event to the frontend for each frame:
/// ```json
/// { "data": "<base64-png>", "ts": 1234567890 }
/// ```
#[tauri::command]
pub async fn start_capture(
    app: AppHandle,
    interval_ms: u64,
    session: tauri::State<'_, CaptureSession>,
) -> Result<(), String> {
    if session.is_running() {
        return Ok(()); // already running — idempotent
    }

    let interval_ms = interval_ms.max(500); // floor at 500 ms
    session.set_running(true);
    let running = session.running_flag();
    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        loop {
            {
                let is_running = *running.lock().unwrap();
                if !is_running {
                    break;
                }
            }

            match capture_screen_to_base64(&app_handle).await {
                Ok(b64) => {
                    let payload = serde_json::json!({
                        "data": b64,
                        "ts": std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                    });
                    let _ = app_handle.emit("screen-frame", payload);
                }
                Err(e) => {
                    eprintln!("[screen] capture error: {e}");
                    // Don't stop the loop — may be a transient error.
                }
            }

            // Use std::thread::sleep in a blocking context to avoid tokio dependency.
            // spawn_blocking keeps the async runtime free while we wait.
            let sleep_ms = interval_ms;
            let _ = tauri::async_runtime::spawn_blocking(move || {
                std::thread::sleep(Duration::from_millis(sleep_ms));
            })
            .await;
        }
    });

    Ok(())
}

/// Tauri command: stop periodic screen capture.
#[tauri::command]
pub async fn stop_capture(session: tauri::State<'_, CaptureSession>) -> Result<(), String> {
    session.set_running(false);
    Ok(())
}

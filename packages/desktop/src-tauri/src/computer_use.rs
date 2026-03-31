/// computer_use.rs — Shell-command bridge for desktop automation.
///
/// Exposes a single Tauri command `run_shell_command` that the frontend
/// (computer-use.ts) calls to drive cliclick, osascript, and open.
///
/// Safety notes:
///   - Only a strict allow-list of programs may be executed.
///   - Arguments are passed as a Vec<String> and never interpolated into a shell
///     string, preventing shell-injection attacks.
///   - The Tauri shell plugin handles the actual spawn so macOS sandbox rules apply.
use tauri_plugin_shell::ShellExt;

/// Programs allowed through the allow-list.
const ALLOWED_PROGRAMS: &[&str] = &["cliclick", "osascript", "open", "xcrun"];

/// Result type returned to the frontend.
#[derive(serde::Serialize)]
pub struct ShellCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Tauri command: run an allow-listed shell program with the given arguments.
///
/// Returns stdout/stderr/exit-code so the TypeScript caller can decide what
/// to do with the output (e.g. for `cliclick` there is no meaningful stdout).
#[tauri::command]
pub async fn run_shell_command(
    app: tauri::AppHandle,
    program: String,
    args: Vec<String>,
) -> Result<ShellCommandResult, String> {
    // Allow-list check — only trusted automation tools
    if !ALLOWED_PROGRAMS.contains(&program.as_str()) {
        return Err(format!(
            "Program '{}' is not on the computer-use allow-list",
            program
        ));
    }

    let output = app
        .shell()
        .command(&program)
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("Failed to spawn '{}': {}", program, e))?;

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(ShellCommandResult { stdout, stderr, code })
}

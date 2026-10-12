//! Local shell + PTY domain: shell name/prompt derivation, one-shot command
//! execution (PowerShell on Windows, zsh/bash on Unix) and interactive PTY
//! command/size construction. Pure of app State; used by the local terminal commands.

use std::path::Path;

use portable_pty::{CommandBuilder, PtySize};
use tokio::process::Command;

use crate::local_fs::format_path;
use crate::shell_text::{decode_shell_text, shell_cwd_marker, split_shell_output};

const WINDOWS_CONDA_HOOK: &str = r#"$env:PYTHONIOENCODING = 'utf-8'; $condaHook = (& conda shell.powershell hook 2>$null | Out-String); if (-not [string]::IsNullOrWhiteSpace($condaHook)) { Invoke-Expression $condaHook }"#;

pub(crate) fn local_shell_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "PowerShell"
    } else if cfg!(target_os = "macos") {
        "zsh"
    } else {
        "bash"
    }
}

pub(crate) fn local_prompt(path: &Path) -> String {
    if cfg!(target_os = "windows") {
        format!("PS {}>", format_path(path.to_path_buf()))
    } else {
        format!("{} $", format_path(path.to_path_buf()))
    }
}

pub(crate) fn is_clear_command(command: &str) -> bool {
    matches!(command.trim().to_lowercase().as_str(), "clear" | "cls")
}

pub(crate) async fn run_local_shell_command(
    command: &str,
    cwd: &Path,
) -> Result<(String, Option<String>, bool), String> {
    if cfg!(target_os = "windows") {
        run_windows_shell_command(command, cwd).await
    } else {
        run_unix_shell_command(command, cwd).await
    }
}

async fn run_windows_shell_command(
    command: &str,
    cwd: &Path,
) -> Result<(String, Option<String>, bool), String> {
    let script = format!(
        "& {{ param([string]$workingDirectory, [string]$userCommand) Set-Location -LiteralPath $workingDirectory; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); {}; Invoke-Expression $userCommand; $exitCode = if ($null -ne $LASTEXITCODE) {{ $LASTEXITCODE }} else {{ 0 }}; Write-Output ('{}' + (Get-Location).Path); exit $exitCode }}",
        WINDOWS_CONDA_HOOK,
        shell_cwd_marker()
    );

    let output = Command::new("powershell.exe")
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(script)
        .arg(format_path(cwd.to_path_buf()))
        .arg(command)
        .output()
        .await
        .map_err(|error| error.to_string())?;

    let stdout = decode_shell_text(&output.stdout);
    let stderr = decode_shell_text(&output.stderr);
    let (stdout_body, next_cwd) = split_shell_output(stdout);
    let body = [stdout_body, stderr]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    Ok((body, next_cwd, output.status.success()))
}

async fn run_unix_shell_command(
    command: &str,
    cwd: &Path,
) -> Result<(String, Option<String>, bool), String> {
    let shell = if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/bash"
    };
    let script = format!(
        "cd -- \"$1\" || exit 1\neval \"$2\"\nstatus=$?\nprintf '\n%s%s\n' '{}' \"$PWD\"\nexit $status",
        shell_cwd_marker()
    );

    let output = Command::new(shell)
        .arg("-lc")
        .arg(script)
        .arg("pandaterm")
        .arg(format_path(cwd.to_path_buf()))
        .arg(command)
        .output()
        .await
        .map_err(|error| error.to_string())?;

    let stdout = decode_shell_text(&output.stdout);
    let stderr = decode_shell_text(&output.stderr);
    let (stdout_body, next_cwd) = split_shell_output(stdout);
    let body = [stdout_body, stderr]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    Ok((body, next_cwd, output.status.success()))
}

/// One-shot AI execution remains on the async runtime: dropping this future
/// requests termination of the direct shell child (never a detached spawn_blocking
/// worker). Descendant processes and side effects cannot be rolled back.
pub(crate) async fn run_ai_shell_command(command: &str) -> Result<std::process::Output, String> {
    let mut process = if cfg!(target_os = "windows") {
        let mut process = Command::new("powershell.exe");
        process
            .arg("-NoLogo")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(command);
        process
    } else {
        let mut process = Command::new("/bin/sh");
        process.arg("-lc").arg(command);
        process
    };
    process
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    process
        .output()
        .await
        .map_err(|error| format!("启动本地命令失败：{error}"))
}

pub(crate) fn local_pty_size(cols: Option<u16>, rows: Option<u16>) -> PtySize {
    PtySize {
        rows: rows.unwrap_or(32).max(1),
        cols: cols.unwrap_or(120).max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub(crate) fn local_pty_command(cwd: &Path) -> CommandBuilder {
    if cfg!(target_os = "windows") {
        let mut command = CommandBuilder::new("powershell.exe");
        command.arg("-NoLogo");
        command.arg("-NoExit");
        command.arg("-NoProfile");
        command.arg("-ExecutionPolicy");
        command.arg("Bypass");
        command.arg("-Command");
        command.arg(format!(
            r#"[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); {}; function global:prompt {{ "$(if ($env:CONDA_PROMPT_MODIFIER) {{ $env:CONDA_PROMPT_MODIFIER }})PS $($PWD.Path)>" }}"#,
            WINDOWS_CONDA_HOOK
        ));
        command.cwd(cwd);
        command
    } else {
        let mut command = CommandBuilder::new(if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else {
            "/bin/bash"
        });
        command.cwd(cwd);
        command
    }
}

#[cfg(all(test, target_os = "windows"))]
mod ai_shell_tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn dropping_ai_execution_terminates_the_direct_shell_child() {
        let marker =
            std::env::temp_dir().join(format!("pandaterm-ai-pid-{}.txt", uuid::Uuid::new_v4()));
        let quoted = marker.to_string_lossy().replace('\'', "''");
        let command = format!(
            "[System.IO.File]::WriteAllText('{quoted}', [string]$PID); Start-Sleep -Seconds 30"
        );
        let task = tokio::spawn(async move { run_ai_shell_command(&command).await });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let pid = loop {
            if let Ok(text) = std::fs::read_to_string(&marker) {
                if let Ok(pid) = text.trim().parse::<u32>() {
                    break pid;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                task.abort();
                let _ = task.await;
                let _ = std::fs::remove_file(&marker);
                panic!("test child did not publish its PID");
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        };
        task.abort();
        let _ = task.await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let check = run_ai_shell_command(&format!("if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 1 }} else {{ exit 0 }}")).await.unwrap();
            if check.status.success() {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                let _ = run_ai_shell_command(&format!(
                    "Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue"
                ))
                .await;
                let _ = std::fs::remove_file(&marker);
                panic!("direct AI shell child survived future cancellation");
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let _ = std::fs::remove_file(marker);
    }
}

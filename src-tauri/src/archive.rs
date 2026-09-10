//! 归档解压工具层：跨平台解压命令构建与本地解压执行。

use std::fs;

use crate::shell_quote;

/// Build the shell command for extracting an archive into a destination
/// directory. Returns an empty string for unsupported formats.
pub fn extract_command(archive_path: &str, dest_dir: &str) -> String {
    let lower = archive_path.to_lowercase();
    let q = shell_quote(archive_path);
    let d = shell_quote(dest_dir);
    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        format!("mkdir -p {d} && tar xzf {q} -C {d}")
    } else if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") {
        format!("mkdir -p {d} && tar xjf {q} -C {d}")
    } else if lower.ends_with(".tar.xz") || lower.ends_with(".txz") {
        format!("mkdir -p {d} && tar xJf {q} -C {d}")
    } else if lower.ends_with(".tar") {
        format!("mkdir -p {d} && tar xf {q} -C {d}")
    } else if lower.ends_with(".zip") {
        // Try unzip first, fall back to python3's zipfile module if unzip is missing.
        // python3 extractall 存在 Zip Slip（../ 或绝对路径成员可写出目标目录），先校验成员名。
        format!(
            "mkdir -p {d} && (command -v unzip >/dev/null 2>&1 && unzip -o {q} -d {d} || python3 -c \"import zipfile,sys,posixpath;z=zipfile.ZipFile(sys.argv[1]);[sys.exit('unsafe zip member: '+n) for n in z.namelist() if posixpath.normpath(n).startswith('..') or posixpath.isabs(n)];z.extractall(sys.argv[2])\" {q} {d})"
        )
    } else if lower.ends_with(".gz") {
        format!("gunzip -f {q}")
    } else if lower.ends_with(".bz2") {
        format!("bunzip2 -f {q}")
    } else if lower.ends_with(".xz") {
        format!("unxz -f {q}")
    } else if lower.ends_with(".7z") {
        format!("7z x {q} -o{d} -y")
    } else if lower.ends_with(".rar") {
        format!("unrar x {q} {d}/")
    } else {
        String::new()
    }
}

/// Extract a local archive using platform-appropriate tools.
/// On Windows: PowerShell `Expand-Archive` for zip, `tar` for tar variants.
/// On Unix: standard shell tools via `sh -c`.
pub fn extract_local_archive(archive_path: &str, dest_dir: &str) -> Result<String, String> {
    let lower = archive_path.to_lowercase();

    // Ensure destination exists.
    fs::create_dir_all(dest_dir).map_err(|e| format!("创建目标目录失败: {e}"))?;

    if cfg!(windows) {
        // Use std::process::Command directly (no cmd /C wrapper) so PATH
        // resolution works and we avoid quote-escaping hell.
        // Wrap in try/catch with explicit exit so PowerShell returns non-zero
        // on error (by default Expand-Archive errors don't set $LASTEXITCODE).
        let result = if lower.ends_with(".zip") {
            let ps_script = format!(
                "try {{ Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force -ErrorAction Stop; exit 0 }} catch {{ Write-Error $_.Exception.Message; exit 1 }}",
                archive_path.replace('\'', "''"),
                dest_dir.replace('\'', "''")
            );
            std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &ps_script,
                ])
                .output()
        } else if lower.ends_with(".tar.gz")
            || lower.ends_with(".tgz")
            || lower.ends_with(".tar.bz2")
            || lower.ends_with(".tbz2")
            || lower.ends_with(".tar.xz")
            || lower.ends_with(".txz")
            || lower.ends_with(".tar")
        {
            std::process::Command::new("tar")
                .args(["xf", archive_path, "-C", dest_dir])
                .output()
        } else if lower.ends_with(".7z") {
            std::process::Command::new("7z")
                .args(["x", archive_path, &format!("-o{dest_dir}"), "-y"])
                .output()
        } else if lower.ends_with(".gz") {
            std::process::Command::new("gzip")
                .args(["-d", "-f", archive_path])
                .output()
        } else if lower.ends_with(".bz2") {
            std::process::Command::new("bzip2")
                .args(["-d", "-f", archive_path])
                .output()
        } else if lower.ends_with(".xz") {
            std::process::Command::new("xz")
                .args(["-d", "-f", archive_path])
                .output()
        } else {
            return Err(format!("本地不支持解压此格式: {archive_path}"));
        };

        let output = result.map_err(|e| format!("执行解压失败: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() {
            let detail = if !stderr.is_empty() {
                stderr.to_string()
            } else if !stdout.is_empty() {
                stdout.to_string()
            } else {
                format!("退出码: {:?}", output.status.code())
            };
            return Err(format!("解压失败: {detail}"));
        }
        // PowerShell may return exit 0 even on error — double check stderr.
        if !stderr.is_empty() && stderr.contains("Error") {
            return Err(format!("解压失败: {stderr}"));
        }
    } else {
        let cmd = extract_command(archive_path, dest_dir);
        if cmd.is_empty() {
            return Err(format!("不支持的压缩包格式: {archive_path}"));
        }
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .output()
            .map_err(|e| format!("执行解压失败（sh）: {e}"))?;

        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = if !stderr.is_empty() {
                stderr.to_string()
            } else if !stdout.is_empty() {
                stdout.to_string()
            } else {
                format!("退出码: {:?}", output.status.code())
            };
            return Err(format!("解压失败: {detail}"));
        }
    }
    Ok("解压完成".to_string())
}

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use uuid::Uuid;

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    })
    .map(PathBuf::from)
    .ok_or_else(|| "无法定位用户目录".to_string())
}

pub fn session_store_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".pandaterm").join("ssh-connections.json"))
}

pub fn pandaterm_data_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".pandaterm"))
}

pub fn known_hosts_path() -> Result<PathBuf, String> {
    Ok(pandaterm_data_dir()?.join("known_hosts.json"))
}

pub fn credential_vault_path() -> Result<PathBuf, String> {
    Ok(pandaterm_data_dir()?.join("credentials.json"))
}

pub fn ai_config_path() -> Result<PathBuf, String> {
    Ok(pandaterm_data_dir()?.join("ai-provider.json"))
}

pub fn ai_conversations_path() -> Result<PathBuf, String> {
    Ok(pandaterm_data_dir()?.join("ai-conversations.json"))
}

pub fn atomic_write_bytes(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法定位文件目录：{}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| format!("目录创建失败：{error}"))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("pandaterm-data");
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));

    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("临时文件创建失败：{error}"))?;
        file.write_all(content)
            .map_err(|error| format!("临时文件写入失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("临时文件同步失败：{error}"))?;
        drop(file);
        replace_file(&temporary, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn atomic_write_text(path: &Path, content: &str) -> Result<(), String> {
    atomic_write_bytes(path, content.as_bytes())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let succeeded = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        Err(format!("原子替换失败：{}", std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| format!("原子替换失败：{error}"))
}
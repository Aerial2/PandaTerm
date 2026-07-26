//! 本地文件系统领域：目录列举、文件预览/读取、路径规范化工具。
//! 均为无 State 依赖的自由函数；远程 SSH 变体留在 main.rs。

use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LocalDirectoryEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) entry_type: String,
    pub(crate) size: u64,
    pub(crate) modified_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LocalDirectoryListing {
    pub(crate) path: String,
    pub(crate) parent: Option<String>,
    pub(crate) entries: Vec<LocalDirectoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LocalFilePreview {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) content: String,
    pub(crate) truncated: bool,
}

pub(crate) const LOCAL_FILE_PREVIEW_LIMIT: u64 = 512 * 1024;
pub(crate) const LOCAL_FILE_FULL_LIMIT: u64 = 50 * 1024 * 1024;

pub(crate) fn default_local_path() -> Result<PathBuf, String> {
    let home = std::env::var_os(if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    })
    .map(PathBuf::from)
    .filter(|path| path.is_dir())
    .ok_or_else(|| "无法定位用户目录".to_string())?;

    Ok(home)
}

pub(crate) fn resolve_local_path(path: Option<String>) -> Result<PathBuf, String> {
    match path.filter(|value| !value.trim().is_empty()) {
        Some(value) => Ok(PathBuf::from(value)),
        None => default_local_path(),
    }
}

pub(crate) fn format_path(path: PathBuf) -> String {
    let path_text = path.to_string_lossy();

    if cfg!(target_os = "windows") {
        if let Some(stripped) = path_text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", stripped);
        }

        if let Some(stripped) = path_text.strip_prefix(r"\\?\") {
            return stripped.to_string();
        }
    }

    path_text.to_string()
}

#[tauri::command]
pub async fn list_local_directory(path: Option<String>) -> Result<LocalDirectoryListing, String> {
    // On Windows, a special "root" path lists available drive letters
    // so users can navigate between drives like in File Explorer.
    if cfg!(target_os = "windows") {
        let resolved = resolve_local_path(path.clone())?;
        // If the user navigated to the virtual root (e.g. by going "up" from C:\),
        // list all available drive letters.
        if resolved.to_string_lossy().trim_end_matches('\\').is_empty()
            || resolved.to_string_lossy() == "This PC"
            || resolved.to_string_lossy() == "此电脑"
        {
            return list_windows_drives();
        }
    }

    let directory = resolve_local_path(path)?;
    let canonical_directory = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let mut entries = Vec::new();

    for entry in fs::read_dir(&canonical_directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let entry_type = if metadata.is_dir() {
            "directory"
        } else {
            "file"
        }
        .to_string();
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis());

        entries.push(LocalDirectoryEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: format_path(entry.path()),
            entry_type,
            size: metadata.len(),
            modified_ms,
        });
    }

    entries.sort_by(|left, right| {
        left.entry_type
            .cmp(&right.entry_type)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    // On Windows, when the current directory is a drive root (e.g. C:\),
    // set parent to a virtual "This PC" so users can navigate to other drives.
    let parent_path = if cfg!(target_os = "windows") {
        let canonical_str = canonical_directory.to_string_lossy();
        // e.g. canonical is "\\?\C:\" — parent would be "\\?\C" which is invalid
        // Instead, set parent to the virtual root
        if canonical_str.ends_with(":\\") || canonical_str.ends_with(":\\\\") {
            Some("此电脑".to_string())
        } else {
            canonical_directory
                .parent()
                .map(|parent| format_path(parent.to_path_buf()))
        }
    } else {
        canonical_directory
            .parent()
            .map(|parent| format_path(parent.to_path_buf()))
    };

    Ok(LocalDirectoryListing {
        path: format_path(canonical_directory.clone()),
        parent: parent_path,
        entries,
    })
}

pub(crate) fn windows_drive_letters() -> std::ops::RangeInclusive<char> {
    'A'..='Z'
}

/// List available Windows drive letters as directory entries.
pub(crate) fn list_windows_drives() -> Result<LocalDirectoryListing, String> {
    let mut entries = Vec::new();
    for letter in windows_drive_letters() {
        let drive = format!("{letter}:\\");
        if PathBuf::from(&drive).is_dir() {
            entries.push(LocalDirectoryEntry {
                name: format!("本地磁盘 ({letter}:)"),
                path: drive.clone(),
                entry_type: "directory".to_string(),
                size: 0,
                modified_ms: None,
            });
        }
    }
    Ok(LocalDirectoryListing {
        path: "此电脑".to_string(),
        parent: None,
        entries,
    })
}

#[tauri::command]
pub async fn read_local_file_preview(path: String) -> Result<LocalFilePreview, String> {
    let file_path = PathBuf::from(path);
    let canonical_file = file_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let metadata = fs::metadata(&canonical_file).map_err(|error| error.to_string())?;

    if !metadata.is_file() {
        return Err("只能预览文件".to_string());
    }

    let read_size = metadata.len().min(LOCAL_FILE_PREVIEW_LIMIT) as usize;
    let mut bytes = Vec::with_capacity(read_size);
    fs::File::open(&canonical_file)
        .map_err(|error| error.to_string())?
        .take(LOCAL_FILE_PREVIEW_LIMIT)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let content = String::from_utf8(bytes)
        .map_err(|_| "暂不支持预览二进制文件".to_string())?;

    Ok(LocalFilePreview {
        path: format_path(canonical_file.clone()),
        name: canonical_file
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| format_path(canonical_file.clone())),
        size: metadata.len(),
        content,
        truncated: metadata.len() > LOCAL_FILE_PREVIEW_LIMIT,
    })
}

#[tauri::command]
pub async fn read_local_file_full(path: String) -> Result<LocalFilePreview, String> {
    let file_path = PathBuf::from(path);
    let canonical_file = file_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let metadata = fs::metadata(&canonical_file).map_err(|error| error.to_string())?;

    if !metadata.is_file() {
        return Err("只能读取文件".to_string());
    }

    if metadata.len() > LOCAL_FILE_FULL_LIMIT {
        return Err(format!(
            "文件过大（{} 字节），编辑器最多支持 {} 字节的文件",
            metadata.len(),
            LOCAL_FILE_FULL_LIMIT
        ));
    }

    let bytes = fs::read(&canonical_file).map_err(|error| error.to_string())?;
    let content = String::from_utf8(bytes)
        .map_err(|_| "暂不支持编辑二进制文件".to_string())?;

    Ok(LocalFilePreview {
        path: format_path(canonical_file.clone()),
        name: canonical_file
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| format_path(canonical_file.clone())),
        size: metadata.len(),
        content,
        truncated: false,
    })
}

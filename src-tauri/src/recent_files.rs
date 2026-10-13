//! Persistence for files recently opened through a remote session.

use std::fs;
use std::path::{Path, PathBuf};

use panda_session::Protocol;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::storage::{atomic_write_text, pandaterm_data_dir};

pub const RECENT_FILES_VERSION: u8 = 1;
pub const MAX_FILES_PER_IDENTITY: usize = 100;
pub const MAX_FILES_TOTAL: usize = 1_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecentFile {
    pub session_id: Uuid,
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecentFileStore {
    pub version: u8,
    pub files: Vec<RecentFile>,
}

impl Default for RecentFileStore {
    fn default() -> Self {
        Self {
            version: RECENT_FILES_VERSION,
            files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RecentFilesState {
    pub store: RecentFileStore,
    pub load_error: Option<String>,
}

impl RecentFilesState {
    pub fn load_default() -> Self {
        match recent_files_path().and_then(|path| load(&path)) {
            Ok(store) => Self {
                store,
                load_error: None,
            },
            Err(error) => Self {
                store: RecentFileStore::default(),
                load_error: Some(error),
            },
        }
    }

    fn ensure_available(&self) -> Result<(), String> {
        self.load_error
            .as_ref()
            .map_or(Ok(()), |error| Err(error.clone()))
    }

    fn commit(&mut self, next: RecentFileStore) -> Result<(), String> {
        self.ensure_available()?;
        let path = recent_files_path()?;
        save(&path, &next)?;
        self.store = next;
        Ok(())
    }
}

pub fn recent_files_path() -> Result<PathBuf, String> {
    Ok(pandaterm_data_dir()?.join("recent-files.json"))
}

pub fn load(path: &Path) -> Result<RecentFileStore, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecentFileStore::default())
        }
        Err(error) => return Err(format!("最近文件读取失败：{error}")),
    };
    let store: RecentFileStore = serde_json::from_str(&content)
        .map_err(|error| format!("最近文件数据已损坏，已进入只读保护状态：{error}"))?;
    validate_store(&store)?;
    Ok(store)
}

pub fn save(path: &Path, store: &RecentFileStore) -> Result<(), String> {
    validate_store(store)?;
    let content = serde_json::to_string_pretty(store)
        .map_err(|error| format!("最近文件序列化失败：{error}"))?;
    atomic_write_text(path, &content).map_err(|error| format!("最近文件保存失败：{error}"))
}

fn validate_store(store: &RecentFileStore) -> Result<(), String> {
    if store.version != RECENT_FILES_VERSION {
        return Err(format!("最近文件版本不受支持：{}", store.version));
    }
    if store.files.len() > MAX_FILES_TOTAL {
        return Err("最近文件数量超过上限".to_string());
    }
    for file in &store.files {
        validate_file(file)?;
    }
    Ok(())
}

fn validate_file(file: &RecentFile) -> Result<(), String> {
    if file.host.trim().is_empty()
        || file.username.trim().is_empty()
        || file.path.trim().is_empty()
        || file.name.trim().is_empty()
        || file.kind.trim().is_empty()
        || file.opened_at.trim().is_empty()
    {
        return Err("最近文件记录包含空字段".to_string());
    }
    Ok(())
}

fn same_identity(left: &RecentFile, right: &RecentFile) -> bool {
    left.session_id == right.session_id
        && left.protocol == right.protocol
        && left.host == right.host
        && left.port == right.port
        && left.username == right.username
}

fn same_file_key(left: &RecentFile, right: &RecentFile) -> bool {
    same_identity(left, right) && left.path == right.path
}

fn endpoint_fallback_allowed(
    existing: &RecentFile,
    incoming: &RecentFile,
    current_session_ids: &[Uuid],
) -> bool {
    existing.session_id != incoming.session_id
        && existing.protocol == incoming.protocol
        && existing.host == incoming.host
        && existing.port == incoming.port
        && existing.username == incoming.username
        && !current_session_ids.contains(&existing.session_id)
}

fn trim_limits(files: &mut Vec<RecentFile>, incoming: &RecentFile) {
    let mut per_identity = 0;
    files.retain(|file| {
        if same_identity(file, incoming) {
            per_identity += 1;
            per_identity <= MAX_FILES_PER_IDENTITY
        } else {
            true
        }
    });
    files.truncate(MAX_FILES_TOTAL);
}

impl RecentFileStore {
    pub fn list(&self) -> Vec<RecentFile> {
        self.files.clone()
    }

    pub fn upsert(&mut self, file: RecentFile, current_session_ids: &[Uuid]) -> Result<(), String> {
        validate_file(&file)?;
        self.files.retain(|existing| {
            !(same_file_key(existing, &file)
                || (endpoint_fallback_allowed(existing, &file, current_session_ids)
                    && existing.path == file.path))
        });
        self.files.insert(0, file.clone());
        trim_limits(&mut self.files, &file);
        Ok(())
    }

    pub fn remove(&mut self, file: &RecentFile) -> bool {
        let before = self.files.len();
        self.files.retain(|existing| !same_file_key(existing, file));
        self.files.len() != before
    }

    pub fn clear(&mut self, files: &[RecentFile]) {
        self.files.retain(|existing| !files.contains(existing));
    }
}

#[tauri::command]
pub async fn list_recent_files(
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<Vec<RecentFile>, String> {
    let recent = state.recent_files.lock().await;
    recent.ensure_available()?;
    Ok(recent.store.list())
}

#[tauri::command]
pub async fn upsert_recent_file(
    file: RecentFile,
    current_session_ids: Vec<Uuid>,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<Vec<RecentFile>, String> {
    let mut recent = state.recent_files.lock().await;
    let mut next = recent.store.clone();
    next.upsert(file, &current_session_ids)?;
    recent.commit(next)?;
    Ok(recent.store.list())
}

#[tauri::command]
pub async fn remove_recent_file(
    file: RecentFile,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<Vec<RecentFile>, String> {
    let mut recent = state.recent_files.lock().await;
    let mut next = recent.store.clone();
    next.remove(&file);
    recent.commit(next)?;
    Ok(recent.store.list())
}

#[tauri::command]
pub async fn clear_recent_files(
    files: Vec<RecentFile>,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<Vec<RecentFile>, String> {
    let mut recent = state.recent_files.lock().await;
    let mut next = recent.store.clone();
    next.clear(&files);
    recent.commit(next)?;
    Ok(recent.store.list())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("pandaterm-recent-files-{name}-{}", Uuid::new_v4()))
    }

    fn file(session_id: Uuid, path: &str, opened_at: &str) -> RecentFile {
        RecentFile {
            session_id,
            protocol: Protocol::Ssh,
            host: "host.example".into(),
            port: 22,
            username: "alice".into(),
            path: path.into(),
            name: path.rsplit('/').next().unwrap_or(path).into(),
            kind: "file".into(),
            opened_at: opened_at.into(),
        }
    }

    #[test]
    fn missing_file_loads_empty_store() {
        let path = temp_path("missing");
        let store = load(&path).unwrap();
        assert_eq!(store, RecentFileStore::default());
    }

    #[test]
    fn roundtrip_preserves_schema() {
        let path = temp_path("roundtrip");
        let id = Uuid::new_v4();
        let mut store = RecentFileStore::default();
        store
            .upsert(file(id, "/tmp/a", "2026-01-01T00:00:00Z"), &[])
            .unwrap();
        save(&path, &store).unwrap();
        assert_eq!(load(&path).unwrap(), store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn corrupt_and_unknown_versions_are_rejected() {
        let corrupt = temp_path("corrupt");
        fs::write(&corrupt, "not json").unwrap();
        assert!(load(&corrupt).is_err());
        let versioned = temp_path("version");
        fs::write(&versioned, r#"{"version":99,"files":[]}"#).unwrap();
        assert!(load(&versioned).unwrap_err().contains("版本"));
    }

    #[test]
    fn limits_are_applied_per_identity_and_globally() {
        let session = Uuid::new_v4();
        let mut store = RecentFileStore::default();
        for i in 0..(MAX_FILES_PER_IDENTITY + 5) {
            store
                .upsert(file(session, &format!("/tmp/{i}"), &i.to_string()), &[])
                .unwrap();
        }
        assert_eq!(store.files.len(), MAX_FILES_PER_IDENTITY);
        for i in 0..MAX_FILES_TOTAL {
            let mut item = file(Uuid::new_v4(), &format!("/tmp/{i}"), &i.to_string());
            item.host = format!("host-{i}.example");
            store.upsert(item, &[]).unwrap();
        }
        assert_eq!(store.files.len(), MAX_FILES_TOTAL);
        let oldest = store.files.last().unwrap().path.clone();
        let mut newest = file(Uuid::new_v4(), "/tmp/overflow", "overflow");
        newest.host = "overflow.example".into();
        store.upsert(newest, &[]).unwrap();
        assert_eq!(store.files.len(), MAX_FILES_TOTAL);
        assert!(!store.files.iter().any(|item| item.path == oldest));
    }

    #[test]
    fn failed_persist_leaves_existing_file_untouched() {
        let parent = temp_path("persist-failure");
        fs::write(&parent, "parent is a file").unwrap();
        let path = parent.join("recent-files.json");
        let store = RecentFileStore::default();
        assert!(save(&path, &store).is_err());
        assert_eq!(fs::read_to_string(&parent).unwrap(), "parent is a file");
        let _ = fs::remove_file(parent);
    }

    #[test]
    fn endpoint_fallback_only_uses_absent_old_session_ids() {
        let old_id = Uuid::new_v4();
        let new_id = Uuid::new_v4();
        let mut store = RecentFileStore::default();
        store.upsert(file(old_id, "/tmp/a", "1"), &[]).unwrap();
        store
            .upsert(file(new_id, "/tmp/a", "2"), &[old_id])
            .unwrap();
        assert_eq!(store.files.len(), 2);
        store.upsert(file(new_id, "/tmp/a", "3"), &[]).unwrap();
        assert_eq!(store.files.len(), 1);
        assert_eq!(store.files[0].opened_at, "3");
    }

    #[test]
    fn clear_removes_only_exact_records() {
        let session_id = Uuid::new_v4();
        let selected = file(session_id, "/srv/app/main.rs", "1");
        let mut newer_version = selected.clone();
        newer_version.opened_at = "2".into();
        let mut other_server = file(Uuid::new_v4(), "/srv/other/main.rs", "1");
        other_server.host = "other.example".into();

        let mut store = RecentFileStore {
            version: RECENT_FILES_VERSION,
            files: vec![selected.clone(), newer_version.clone(), other_server.clone()],
        };
        store.clear(std::slice::from_ref(&selected));

        assert_eq!(store.files, vec![newer_version, other_server]);
    }

    #[test]
    fn failed_validation_does_not_change_memory() {
        let mut store = RecentFileStore::default();
        let original = store.clone();
        let invalid = file(Uuid::new_v4(), "", "1");
        assert!(store.upsert(invalid, &[]).is_err());
        assert_eq!(store, original);
    }

    #[test]
    fn concurrent_store_operations_are_serializable() {
        let store = Arc::new(std::sync::Mutex::new(RecentFileStore::default()));
        let mut threads = Vec::new();
        for i in 0..16 {
            let store = Arc::clone(&store);
            threads.push(thread::spawn(move || {
                let mut store = store.lock().unwrap();
                store
                    .upsert(file(Uuid::new_v4(), &format!("/tmp/{i}"), "1"), &[])
                    .unwrap();
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(store.lock().unwrap().files.len(), 16);
    }
}

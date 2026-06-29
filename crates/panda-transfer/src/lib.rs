use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransferTask {
    pub id: Uuid,
    pub session_id: Uuid,
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    pub status: TransferStatus,
    pub progress: TransferProgress,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStatus {
    Pending,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransferProgress {
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub speed_bytes_per_sec: u64,
}

impl TransferProgress {
    pub fn percent(&self) -> u8 {
        if self.bytes_total == 0 {
            return 0;
        }

        ((self.bytes_done.saturating_mul(100) / self.bytes_total).min(100)) as u8
    }
}

#[derive(Debug, Error)]
pub enum TransferError {
    #[error("transfer task not found: {0}")]
    NotFound(Uuid),
    #[error("invalid transfer task: {0}")]
    InvalidTask(String),
}

pub type TransferResult<T> = Result<T, TransferError>;

#[derive(Debug, Default)]
pub struct TransferQueue {
    tasks: Vec<TransferTask>,
}

impl TransferQueue {
    pub fn all(&self) -> &[TransferTask] {
        &self.tasks
    }

    pub fn push(&mut self, task: TransferTask) -> TransferResult<()> {
        if task.local_path.trim().is_empty() || task.remote_path.trim().is_empty() {
            return Err(TransferError::InvalidTask(
                "local_path and remote_path are required".into(),
            ));
        }

        self.tasks.push(task);
        Ok(())
    }
}

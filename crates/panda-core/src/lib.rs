use async_trait::async_trait;
use panda_session::Session;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectRequest {
    pub session: Session,
    pub terminal_size: TerminalSize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self {
            cols: 120,
            rows: 32,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalEvent {
    pub session_id: Uuid,
    pub kind: TerminalEventKind,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalEventKind {
    Connected,
    Output,
    Error,
    Disconnected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Idle,
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
    Failed,
}

#[derive(Debug, Error)]
pub enum SshError {
    #[error("connection failed: {0}")]
    Connect(String),
    #[error("session is not connected")]
    NotConnected,
    #[error("write failed: {0}")]
    Write(String),
}

pub type SshResult<T> = Result<T, SshError>;

#[async_trait]
pub trait SshClient: Send + Sync {
    async fn connect(&mut self, request: ConnectRequest) -> SshResult<TerminalEvent>;
    async fn write(&mut self, data: &str) -> SshResult<TerminalEvent>;
    async fn disconnect(&mut self) -> SshResult<TerminalEvent>;
    fn state(&self) -> ConnectionState;
}

#[derive(Debug, Clone)]
pub struct MockSshClient {
    session_id: Option<Uuid>,
    state: ConnectionState,
}

impl Default for MockSshClient {
    fn default() -> Self {
        Self {
            session_id: None,
            state: ConnectionState::Idle,
        }
    }
}

#[async_trait]
impl SshClient for MockSshClient {
    async fn connect(&mut self, request: ConnectRequest) -> SshResult<TerminalEvent> {
        self.session_id = Some(request.session.id);
        self.state = ConnectionState::Connected;

        Ok(TerminalEvent {
            session_id: request.session.id,
            kind: TerminalEventKind::Connected,
            payload: format!(
                "Connected to {}@{}:{}",
                request.session.username, request.session.host, request.session.port
            ),
        })
    }

    async fn write(&mut self, data: &str) -> SshResult<TerminalEvent> {
        let Some(session_id) = self.session_id else {
            return Err(SshError::NotConnected);
        };

        Ok(TerminalEvent {
            session_id,
            kind: TerminalEventKind::Output,
            payload: format!("$ {}\nmock output: command accepted", data.trim()),
        })
    }

    async fn disconnect(&mut self) -> SshResult<TerminalEvent> {
        let Some(session_id) = self.session_id.take() else {
            return Err(SshError::NotConnected);
        };

        self.state = ConnectionState::Disconnected;

        Ok(TerminalEvent {
            session_id,
            kind: TerminalEventKind::Disconnected,
            payload: "Disconnected".into(),
        })
    }

    fn state(&self) -> ConnectionState {
        self.state.clone()
    }
}

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Session {
    pub id: Uuid,
    pub name: String,
    pub group: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthType,
    pub tags: Vec<String>,
    pub last_connected_at: Option<String>,
    pub reconnect: ReconnectPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthType {
    Password {
        secret_id: String,
    },
    PrivateKey {
        key_id: String,
        passphrase_secret_id: Option<String>,
    },
    KeyboardInteractive {
        response_secret_id: String,
    },
    Gssapi {
        principal: Option<String>,
    },
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReconnectPolicy {
    pub enabled: bool,
    pub max_attempts: u8,
    pub delay_ms: u64,
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            max_attempts: 3,
            delay_ms: 1_500,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionGroup {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("session not found: {0}")]
    NotFound(Uuid),
    #[error("session validation failed: {0}")]
    Validation(String),
}

pub type SessionResult<T> = Result<T, SessionError>;

#[derive(Debug, Clone, Default)]
pub struct SessionCatalog {
    sessions: Vec<Session>,
}

impl SessionCatalog {
    pub fn new(sessions: Vec<Session>) -> Self {
        Self { sessions }
    }

    pub fn all(&self) -> &[Session] {
        &self.sessions
    }

    pub fn search(&self, query: &str) -> Vec<Session> {
        let normalized = query.trim().to_lowercase();
        if normalized.is_empty() {
            return self.sessions.clone();
        }

        self.sessions
            .iter()
            .filter(|session| {
                session.name.to_lowercase().contains(&normalized)
                    || session.host.to_lowercase().contains(&normalized)
                    || session.group.to_lowercase().contains(&normalized)
                    || session
                        .tags
                        .iter()
                        .any(|tag| tag.to_lowercase().contains(&normalized))
            })
            .cloned()
            .collect()
    }

    pub fn upsert(&mut self, session: Session) -> SessionResult<()> {
        validate_session(&session)?;

        if let Some(existing) = self.sessions.iter_mut().find(|item| item.id == session.id) {
            *existing = session;
        } else {
            self.sessions.push(session);
        }

        Ok(())
    }

    pub fn remove(&mut self, id: Uuid) -> SessionResult<()> {
        let before = self.sessions.len();
        self.sessions.retain(|session| session.id != id);
        if self.sessions.len() == before {
            return Err(SessionError::NotFound(id));
        }
        Ok(())
    }

    /// Reorder the catalog to match `ordered_ids` (the user's persisted order).
    /// Sessions absent from `ordered_ids` are appended to the end so a partial
    /// or out-of-date id list never drops data.
    pub fn reorder(&mut self, ordered_ids: &[Uuid]) -> SessionResult<()> {
        use std::collections::HashMap;
        let by_id: HashMap<Uuid, &Session> =
            self.sessions.iter().map(|session| (session.id, session)).collect();
        let mut next = Vec::with_capacity(self.sessions.len());
        for id in ordered_ids {
            if let Some(session) = by_id.get(id) {
                next.push((*session).clone());
            }
        }
        for session in &self.sessions {
            if !ordered_ids.contains(&session.id) {
                next.push(session.clone());
            }
        }
        self.sessions = next;
        Ok(())
    }
}

pub fn validate_session(session: &Session) -> SessionResult<()> {
    if session.name.trim().is_empty() {
        return Err(SessionError::Validation("name is required".into()));
    }

    if session.host.trim().is_empty() {
        return Err(SessionError::Validation("host is required".into()));
    }

    if session.port == 0 {
        return Err(SessionError::Validation(
            "port must be greater than zero".into(),
        ));
    }

    Ok(())
}

pub fn demo_sessions() -> Vec<Session> {
    vec![
        Session {
            id: Uuid::new_v4(),
            name: "Production Gateway".into(),
            group: "Prod".into(),
            host: "prod.example.internal".into(),
            port: 22,
            username: "admin".into(),
            auth: AuthType::Agent,
            tags: vec!["gateway".into(), "critical".into()],
            last_connected_at: None,
            reconnect: ReconnectPolicy::default(),
        },
        Session {
            id: Uuid::new_v4(),
            name: "Test Node".into(),
            group: "Test".into(),
            host: "test.example.internal".into(),
            port: 22,
            username: "dev".into(),
            auth: AuthType::Password {
                secret_id: "demo-password".into(),
            },
            tags: vec!["test".into()],
            last_connected_at: None,
            reconnect: ReconnectPolicy::default(),
        },
    ]
}

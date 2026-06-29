use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretRef {
    pub id: String,
    pub scope: SecretScope,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecretScope {
    Password,
    PrivateKey,
    Passphrase,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretPayload {
    pub value: String,
}

#[derive(Debug, Error)]
pub enum SecretError {
    #[error("secret not found: {0}")]
    NotFound(String),
    #[error("secret backend unavailable: {0}")]
    BackendUnavailable(String),
}

pub type SecretResult<T> = Result<T, SecretError>;

pub trait SecretStore: Send + Sync {
    fn get(&self, secret: &SecretRef) -> SecretResult<SecretPayload>;
    fn put(&self, secret: &SecretRef, payload: SecretPayload) -> SecretResult<()>;
    fn delete(&self, secret: &SecretRef) -> SecretResult<()>;
}

#[derive(Debug, Default)]
pub struct NoopSecretStore;

impl SecretStore for NoopSecretStore {
    fn get(&self, secret: &SecretRef) -> SecretResult<SecretPayload> {
        Err(SecretError::NotFound(secret.id.clone()))
    }

    fn put(&self, _secret: &SecretRef, _payload: SecretPayload) -> SecretResult<()> {
        Ok(())
    }

    fn delete(&self, _secret: &SecretRef) -> SecretResult<()> {
        Ok(())
    }
}

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroize;

const MASTER_SALT_LEN: usize = 16;
const MASTER_NONCE_LEN: usize = 12;
const MASTER_KEY_LEN: usize = 32;
const ARGON2_MEMORY_KIB: u32 = 64 * 1024;
const ARGON2_ITERATIONS: u32 = 3;
const ARGON2_PARALLELISM: u32 = 1;

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProtectionMode {
    Dpapi,
    MasterPassword,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtectedSecret {
    pub version: u8,
    pub mode: ProtectionMode,
    pub ciphertext: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub salt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
}

#[derive(Debug, Error)]
pub enum SecretError {
    #[error("secret not found: {0}")]
    NotFound(String),
    #[error("secret backend unavailable: {0}")]
    BackendUnavailable(String),
    #[error("credential data is invalid: {0}")]
    InvalidData(String),
    #[error("credential protection failed: {0}")]
    Protection(String),
    #[error("master password is required")]
    MasterPasswordRequired,
    #[error("master password is incorrect or credential data was modified")]
    AuthenticationFailed,
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

pub fn protect_secret(
    plaintext: &str,
    mode: ProtectionMode,
    master_password: Option<&str>,
    context: &str,
) -> SecretResult<ProtectedSecret> {
    match mode {
        ProtectionMode::Dpapi => protect_with_dpapi(plaintext, context),
        ProtectionMode::MasterPassword => {
            let password = master_password.ok_or(SecretError::MasterPasswordRequired)?;
            protect_with_master_password(plaintext, password, context)
        }
    }
}

pub fn unprotect_secret(
    protected: &ProtectedSecret,
    master_password: Option<&str>,
    context: &str,
) -> SecretResult<String> {
    if protected.version != 1 {
        return Err(SecretError::InvalidData(format!(
            "unsupported credential version {}",
            protected.version
        )));
    }

    match protected.mode {
        ProtectionMode::Dpapi => unprotect_with_dpapi(protected, context),
        ProtectionMode::MasterPassword => {
            let password = master_password.ok_or(SecretError::MasterPasswordRequired)?;
            unprotect_with_master_password(protected, password, context)
        }
    }
}

fn master_argon2() -> SecretResult<Argon2<'static>> {
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        Some(MASTER_KEY_LEN),
    )
    .map_err(|error| SecretError::Protection(error.to_string()))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

fn derive_master_key(password: &str, salt: &[u8]) -> SecretResult<[u8; MASTER_KEY_LEN]> {
    let mut key = [0u8; MASTER_KEY_LEN];
    master_argon2()?
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|error| SecretError::Protection(error.to_string()))?;
    Ok(key)
}

fn protect_with_master_password(
    plaintext: &str,
    password: &str,
    context: &str,
) -> SecretResult<ProtectedSecret> {
    let mut salt = [0u8; MASTER_SALT_LEN];
    let mut nonce_bytes = [0u8; MASTER_NONCE_LEN];
    rand::rng().fill(&mut salt);
    rand::rng().fill(&mut nonce_bytes);

    let mut key = derive_master_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| SecretError::Protection(error.to_string()))?;
    let nonce = *Nonce::from_slice(nonce_bytes.as_slice());
    let encrypted = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| SecretError::Protection("AES-GCM encryption failed".into()));
    key.zeroize();

    Ok(ProtectedSecret {
        version: 1,
        mode: ProtectionMode::MasterPassword,
        ciphertext: BASE64.encode(encrypted?),
        salt: Some(BASE64.encode(salt)),
        nonce: Some(BASE64.encode(nonce_bytes)),
    })
}

fn unprotect_with_master_password(
    protected: &ProtectedSecret,
    password: &str,
    context: &str,
) -> SecretResult<String> {
    let salt = decode_required(&protected.salt, "salt")?;
    let nonce = decode_required(&protected.nonce, "nonce")?;
    if salt.len() != MASTER_SALT_LEN || nonce.len() != MASTER_NONCE_LEN {
        return Err(SecretError::InvalidData("invalid salt or nonce length".into()));
    }
    let ciphertext = BASE64
        .decode(&protected.ciphertext)
        .map_err(|error| SecretError::InvalidData(error.to_string()))?;

    let mut key = derive_master_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| SecretError::Protection(error.to_string()))?;
    let aes_nonce = *Nonce::from_slice(nonce.as_slice());
    let plaintext = cipher
        .decrypt(
            &aes_nonce,
            Payload {
                msg: &ciphertext,
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| SecretError::AuthenticationFailed);
    key.zeroize();

    String::from_utf8(plaintext?).map_err(|error| SecretError::InvalidData(error.to_string()))
}

fn decode_required(value: &Option<String>, field: &str) -> SecretResult<Vec<u8>> {
    let encoded = value
        .as_deref()
        .ok_or_else(|| SecretError::InvalidData(format!("missing {field}")))?;
    BASE64
        .decode(encoded)
        .map_err(|error| SecretError::InvalidData(error.to_string()))
}

#[cfg(windows)]
fn protect_with_dpapi(plaintext: &str, context: &str) -> SecretResult<ProtectedSecret> {
    let encrypted = dpapi_transform(plaintext.as_bytes(), context.as_bytes(), true)?;
    Ok(ProtectedSecret {
        version: 1,
        mode: ProtectionMode::Dpapi,
        ciphertext: BASE64.encode(encrypted),
        salt: None,
        nonce: None,
    })
}

#[cfg(windows)]
fn unprotect_with_dpapi(protected: &ProtectedSecret, context: &str) -> SecretResult<String> {
    let ciphertext = BASE64
        .decode(&protected.ciphertext)
        .map_err(|error| SecretError::InvalidData(error.to_string()))?;
    let plaintext = dpapi_transform(&ciphertext, context.as_bytes(), false)?;
    String::from_utf8(plaintext).map_err(|error| SecretError::InvalidData(error.to_string()))
}

#[cfg(windows)]
fn dpapi_transform(input: &[u8], entropy: &[u8], protect: bool) -> SecretResult<Vec<u8>> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr() as *mut u8,
    };
    let mut output_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    let succeeded = unsafe {
        if protect {
            CryptProtectData(
                &input_blob,
                ptr::null(),
                &entropy_blob,
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output_blob,
            )
        } else {
            CryptUnprotectData(
                &input_blob,
                ptr::null_mut(),
                &entropy_blob,
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output_blob,
            )
        }
    };

    if succeeded == 0 {
        return Err(SecretError::Protection(std::io::Error::last_os_error().to_string()));
    }

    let output = unsafe {
        let bytes = std::slice::from_raw_parts(output_blob.pbData, output_blob.cbData as usize);
        let result = bytes.to_vec();
        let _ = LocalFree(output_blob.pbData.cast());
        result
    };
    Ok(output)
}

#[cfg(not(windows))]
fn protect_with_dpapi(_plaintext: &str, _context: &str) -> SecretResult<ProtectedSecret> {
    Err(SecretError::BackendUnavailable(
        "DPAPI is only available on Windows".into(),
    ))
}

#[cfg(not(windows))]
fn unprotect_with_dpapi(_protected: &ProtectedSecret, _context: &str) -> SecretResult<String> {
    Err(SecretError::BackendUnavailable(
        "DPAPI is only available on Windows".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn master_password_round_trip_and_context_binding() {
        let protected = protect_secret(
            "correct horse battery staple",
            ProtectionMode::MasterPassword,
            Some("master-password"),
            "session:test",
        )
        .unwrap();

        assert_eq!(
            unprotect_secret(&protected, Some("master-password"), "session:test").unwrap(),
            "correct horse battery staple"
        );
        assert!(unprotect_secret(&protected, Some("wrong"), "session:test").is_err());
        assert!(unprotect_secret(&protected, Some("master-password"), "session:other").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip_and_context_binding() {
        let protected = protect_secret("secret", ProtectionMode::Dpapi, None, "session:test").unwrap();
        assert_eq!(unprotect_secret(&protected, None, "session:test").unwrap(), "secret");
        assert!(unprotect_secret(&protected, None, "session:other").is_err());
    }
}
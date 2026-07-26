//! Legacy secret obfuscation (pterm1 scheme): kept solely to deobfuscate
//! previously stored credentials during one-time migration to the vault.
//! Not used for new writes; the modern path lives in panda_crypto.

use crate::base64::base64_decode;

/// Legacy local obfuscation retained only for one-time migration of pterm1 data.
const SECRET_PREFIX: &str = "pterm1:";

fn secret_obfuscation_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    let material = format!(
        "pandaterm-v1|{}|{}|{}",
        std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "user".into()),
        std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "host".into()),
        std::env::consts::OS,
    );
    let bytes = material.as_bytes();
    for (i, slot) in key.iter_mut().enumerate() {
        let b = bytes.get(i % bytes.len()).copied().unwrap_or(0);
        *slot = b
            .wrapping_mul(31)
            .wrapping_add((i as u8).wrapping_mul(17))
            .wrapping_add(0xA5);
    }
    key
}

pub(crate) fn deobfuscate_secret(stored: &str) -> String {
    let Some(rest) = stored.strip_prefix(SECRET_PREFIX) else {
        return stored.to_string();
    };
    let Ok(bytes) = base64_decode(rest) else {
        return stored.to_string();
    };
    let key = secret_obfuscation_key();
    let mut out = Vec::with_capacity(bytes.len());
    for (i, b) in bytes.iter().enumerate() {
        out.push(b ^ key[i % 32] ^ ((i as u8).wrapping_mul(31)));
    }
    String::from_utf8(out).unwrap_or_else(|_| stored.to_string())
}

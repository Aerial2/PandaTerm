//! base64 编解码工具层：手写实现，避免引入 base64 crate 依赖。

/// Simple base64 encoder (avoids adding the base64 crate dependency).
pub fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Simple base64 decoder.
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 256] = &{
        let mut t = [255u8; 256];
        let mut i = 0;
        while i < 26 { t[(b'A' + i as u8) as usize] = i as u8; i += 1; }
        let mut i = 0;
        while i < 26 { t[(b'a' + i as u8) as usize] = (26 + i) as u8; i += 1; }
        let mut i = 0;
        while i < 10 { t[(b'0' + i as u8) as usize] = (52 + i) as u8; i += 1; }
        t[b'+' as usize] = 62;
        t[b'/' as usize] = 63;
        t
    };
    let filtered: Vec<u8> = input
        .bytes()
        .filter(|&b| b != b'\n' && b != b'\r' && b != b' ')
        .collect();
    if filtered.is_empty() {
        return Ok(Vec::new());
    }
    if !filtered.len().is_multiple_of(4) {
        return Err(format!("无效的 base64 长度: {}", filtered.len()));
    }

    let mut out = Vec::with_capacity(filtered.len() / 4 * 3);
    let last_chunk = filtered.len() / 4 - 1;
    for (chunk_index, chunk) in filtered.chunks(4).enumerate() {
        let v0 = TABLE[chunk[0] as usize];
        let v1 = TABLE[chunk[1] as usize];
        if v0 == 255 || v1 == 255 {
            return Err("无效的 base64 字符或填充位置".to_string());
        }

        let has_pad2 = chunk[2] == b'=';
        let has_pad3 = chunk[3] == b'=';
        if (has_pad2 || has_pad3) && chunk_index != last_chunk {
            return Err("base64 填充只能出现在末尾".to_string());
        }
        if has_pad2 && !has_pad3 {
            return Err("base64 填充位置无效".to_string());
        }

        let v2 = if has_pad2 { 0 } else { TABLE[chunk[2] as usize] };
        let v3 = if has_pad3 { 0 } else { TABLE[chunk[3] as usize] };
        if v2 == 255 || v3 == 255 {
            return Err("无效的 base64 字符".to_string());
        }

        // Reject non-zero unused bits so malformed encodings cannot silently map
        // to the same decoded bytes as a different canonical input.
        if has_pad2 && (v1 & 0x0f) != 0 {
            return Err("base64 填充位无效".to_string());
        }
        if !has_pad2 && has_pad3 && (v2 & 0x03) != 0 {
            return Err("base64 填充位无效".to_string());
        }

        let n = ((v0 as u32) << 18)
            | ((v1 as u32) << 12)
            | ((v2 as u32) << 6)
            | (v3 as u32);
        out.push((n >> 16) as u8);
        if !has_pad2 {
            out.push((n >> 8) as u8);
        }
        if !has_pad3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trip_and_whitespace() {
        let encoded = base64_encode(b"legacy secret");
        assert_eq!(base64_decode(&encoded).unwrap(), b"legacy secret");
        assert_eq!(base64_decode(" YWJj\n").unwrap(), b"abc");
    }

    #[test]
    fn rejects_invalid_padding_and_characters() {
        for invalid in ["AB=C", "=AAA", "A=AA", "AAAA=", "AA=A", "AA!A"] {
            assert!(base64_decode(invalid).is_err(), "accepted {invalid:?}");
        }
        assert!(base64_decode("AB==").is_err());
        assert!(base64_decode("AAA=").is_ok());
    }
}

//! shell 文本解码层：本地 shell 输出的编码解码、换行归一与 cwd 标记切分。

#[cfg(target_os = "windows")]
use encoding_rs::GBK;

pub fn shell_cwd_marker() -> &'static str {
    "__PANDATERM_CWD__"
}

pub fn normalize_shell_text(text: String) -> String {
    text.replace("\r\n", "\n")
}

fn fallback_decode(bytes: &[u8]) -> String {
    #[cfg(target_os = "windows")]
    {
        let (text, _, _) = GBK.decode(bytes);
        text.into_owned()
    }

    #[cfg(not(target_os = "windows"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

pub fn decode_shell_text(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        return normalize_shell_text(text);
    }

    normalize_shell_text(fallback_decode(bytes))
}

/// 跨块流式终端解码器。
///
/// SSH Data 帧与本地 PTY 读缓冲的切分点可能落在多字节 UTF-8 序列中间：
/// 按块独立解码时前后两块都“不是合法 UTF-8”，会双双退化到 GBK 兜底，
/// 造成成片乱码。本解码器把疑似被切断的尾随字节（至多 3 字节）留到下一块
/// 再拼合判定；只有当块内出现确凿的非法字节（真正的非 UTF-8 输出，如 GBK）
/// 时才整块回退兜底，与旧的一次性 [`decode_shell_text`] 行为保持一致。
pub struct StreamDecoder {
    pending: Vec<u8>,
}

impl Default for StreamDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamDecoder {
    pub fn new() -> Self {
        Self { pending: Vec::new() }
    }

    /// 喂入一块原始字节，返回当前可安全上屏的文本（可能为空）。
    pub fn feed(&mut self, bytes: &[u8]) -> String {
        if bytes.is_empty() {
            return String::new();
        }
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(bytes);

        match std::str::from_utf8(&buf) {
            Ok(text) => {
                self.pending.clear();
                text.to_string()
            }
            Err(error) => match error.error_len() {
                // 整块合法、仅末尾是某个多字节字符的“前半个”：留给下一块补全
                None => {
                    let decoded = std::str::from_utf8(&buf[..error.valid_up_to()])
                        .ok()
                        .unwrap_or_default()
                        .to_string();
                    self.pending = buf.split_off(error.valid_up_to());
                    decoded
                }
                // 块中确有非法字节：整块走 GBK 兜底并丢弃残留
                Some(_) => {
                    self.pending.clear();
                    fallback_decode(&buf)
                }
            },
        }
    }

    /// 流结束时调用：丢弃悬挂的未完成序列（截断残片，上屏只会是乱码），
    /// 并复位内部状态以便复用。
    pub fn flush(&mut self) {
        self.pending.clear();
    }
}

pub fn split_shell_output(output: String) -> (String, Option<String>) {
    if let Some(index) = output.rfind(shell_cwd_marker()) {
        let before = output[..index].trim_end_matches(['\n', '\r']).to_string();
        let after = output[index + shell_cwd_marker().len()..].trim();
        let cwd = if after.is_empty() {
            None
        } else {
            Some(after.to_string())
        };
        (before, cwd)
    } else {
        (output.trim_end_matches(['\n', '\r']).to_string(), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multibyte_split_byte_by_byte_round_trips() {
        let full = "中文abc🦀测试";
        let mut decoder = StreamDecoder::new();
        let mut out = String::new();
        for byte in full.as_bytes() {
            out.push_str(&decoder.feed(std::slice::from_ref(byte)));
        }
        decoder.flush();
        assert_eq!(out, full);
    }

    #[test]
    fn multibyte_split_at_arbitrary_offsets_round_trips() {
        let full = "用户目录/etc/主机名，输出正常";
        let bytes = full.as_bytes();
        for cut in [3usize, 5, 11, 17, 25, bytes.len() - 4] {
            let (head, tail) = bytes.split_at(cut);
            let mut decoder = StreamDecoder::new();
            let mut out = decoder.feed(head);
            out.push_str(&decoder.feed(tail));
            decoder.flush();
            assert_eq!(out, full, "cut at byte {cut}");
        }
    }

    #[test]
    fn ascii_passes_through_unchanged() {
        let mut decoder = StreamDecoder::new();
        assert_eq!(decoder.feed(b"hello "), "hello ");
        assert_eq!(decoder.feed(b"world\r\n"), "world\r\n");
        decoder.flush();
    }

    #[cfg(windows)]
    #[test]
    fn hard_invalid_bytes_whole_chunk_fall_back_to_gbk() {
        // GBK 的“你”＝[0xC4, 0xE3]，第二个字节超出 UTF-8 续字节范围，
        // 无论切在哪都会立刻产生确定性非法错误。
        let mut decoder = StreamDecoder::new();
        assert_eq!(decoder.feed([0xC4].as_slice()), "");
        assert_eq!(decoder.pending.len(), 1);
        assert_eq!(decoder.feed([0xE3].as_slice()), "你");
        assert_eq!(decoder.pending.len(), 0);

        // 完整块一次喂入同样走兜底
        let mut decoder = StreamDecoder::new();
        assert_eq!(decoder.feed([0xC4, 0xE3, 0xBA, 0xC3].as_slice()), "你好");
    }

    #[cfg(windows)]
    #[test]
    fn pending_is_discarded_once_block_proves_invalid() {
        let mut decoder = StreamDecoder::new();
        assert_eq!(decoder.feed([0xE4].as_slice()), ""); // “中”的前一个字节
        assert_eq!(decoder.pending.len(), 1);
        // 下一块直接出现确凿非法字节：整块回退且不残留
        let _ = decoder.feed([0xFF].as_slice());
        assert_eq!(decoder.pending.len(), 0);
    }

    #[test]
    fn one_shot_decode_shell_text_still_works() {
        assert_eq!(decode_shell_text("hello".as_bytes()), "hello");
        assert_eq!(decode_shell_text("中文".as_bytes()), "中文");
        assert_eq!(
            normalize_shell_text(decode_shell_text(b"a\r\nb")),
            "a\nb"
        );
    }
}

//! shell 文本解码层：本地 shell 输出的编码解码、换行归一与 cwd 标记切分。

#[cfg(target_os = "windows")]
use encoding_rs::GBK;

pub fn shell_cwd_marker() -> &'static str {
    "__PANDATERM_CWD__"
}

pub fn normalize_shell_text(text: String) -> String {
    text.replace("\r\n", "\n")
}

pub fn decode_shell_text(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        return normalize_shell_text(text);
    }

    #[cfg(target_os = "windows")]
    {
        let (text, _, _) = GBK.decode(bytes);
        normalize_shell_text(text.into_owned())
    }

    #[cfg(not(target_os = "windows"))]
    {
        normalize_shell_text(String::from_utf8_lossy(bytes).into_owned())
    }
}

pub fn decode_terminal_bytes(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        return text;
    }

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

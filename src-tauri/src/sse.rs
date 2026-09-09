//! Server-Sent Events framing: split a byte buffer into complete SSE events
//! and extract the concatenated `data:` payload from a single event.
//! Transport-only, decoupled from any specific AI provider.

pub(crate) fn take_sse_events(buffer: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut events = Vec::new();
    loop {
        // SSE permits LF or CRLF separators. Choose whichever complete separator
        // appears first in the buffer; looking for one style across the whole
        // buffer before the other could merge events in mixed-line-ending streams.
        let lf = buffer
            .windows(2)
            .position(|window| window == b"\n\n")
            .map(|index| (index, 2));
        let crlf = buffer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| (index, 4));
        let separator = match (lf, crlf) {
            (Some(left), Some(right)) if right.0 < left.0 => Some(right),
            (Some(left), _) => Some(left),
            (None, Some(right)) => Some(right),
            (None, None) => None,
        };
        let Some((index, length)) = separator else {
            break;
        };
        let event = buffer.drain(..index).collect::<Vec<_>>();
        buffer.drain(..length);
        events.push(event);
    }
    events
}

pub(crate) fn sse_data(event: &[u8]) -> Result<Option<String>, String> {
    let text = std::str::from_utf8(event).map_err(|_| "AI 流式响应不是有效 UTF-8".to_string())?;
    let data = text
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    Ok((!data.is_empty()).then_some(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_line_endings_use_earliest_separator() {
        let mut buffer = b"data: first\r\n\r\ndata: second\n\n".to_vec();
        let events = take_sse_events(&mut buffer);
        assert_eq!(events.len(), 2);
        assert_eq!(sse_data(&events[0]).unwrap().as_deref(), Some("first"));
        assert_eq!(sse_data(&events[1]).unwrap().as_deref(), Some("second"));
        assert!(buffer.is_empty());
    }

    #[test]
    fn incomplete_separator_stays_buffered() {
        let mut buffer = b"data: partial\r\n".to_vec();
        assert!(take_sse_events(&mut buffer).is_empty());
        buffer.extend_from_slice(b"\r\ndata: next\n\n");
        assert_eq!(take_sse_events(&mut buffer).len(), 2);
    }
}

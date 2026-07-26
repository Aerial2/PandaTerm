//! Server-Sent Events framing: split a byte buffer into complete SSE events
//! and extract the concatenated `data:` payload from a single event.
//! Transport-only, decoupled from any specific AI provider.

pub(crate) fn take_sse_events(buffer: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut events = Vec::new();
    loop {
        let separator = buffer
            .windows(2)
            .position(|window| window == b"\n\n")
            .map(|index| (index, 2))
            .or_else(|| {
                buffer
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|index| (index, 4))
            });
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

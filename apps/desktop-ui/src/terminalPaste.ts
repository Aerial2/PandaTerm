const TERMINAL_PASTE_CONFIRM_BYTES = 100 * 1024;
const TERMINAL_PASTE_MAX_BYTES = 1024 * 1024;
const TERMINAL_PASTE_PREVIEW_CHARS = 4000;

export type PreparedTerminalPaste = {
  text: string;
  preview: string;
  lineCount: number;
  originalBytes: number;
  pasteBytes: number;
  requiresConfirmation: boolean;
  hasControlCharacters: boolean;
  truncated: boolean;
  previewTruncated: boolean;
};

function truncateUtf8(encoded: Uint8Array, maxBytes: number): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = Math.min(encoded.byteLength, maxBytes); end > Math.max(0, maxBytes - 4); end -= 1) {
    try {
      return decoder.decode(encoded.slice(0, end));
    } catch {
      // UTF-8 code points use at most four bytes; retry at the previous boundary.
    }
  }
  return '';
}

function countLines(text: string): number {
  if (!text) return 0;

  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lines += 1;
    } else if (text[index] === '\r') {
      lines += 1;
      if (text[index + 1] === '\n') index += 1;
    }
  }
  return lines;
}

function containsUnsafeControlCharacters(text: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text);
}

function makeVisiblePreview(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (character) => {
    const code = character.charCodeAt(0);
    return code === 0x7f ? '␡' : String.fromCharCode(0x2400 + code);
  });
}

export function prepareTerminalPaste(text: string): PreparedTerminalPaste {
  const encoded = new TextEncoder().encode(text);
  const originalBytes = encoded.byteLength;
  const truncatedText = originalBytes > TERMINAL_PASTE_MAX_BYTES
    ? truncateUtf8(encoded, TERMINAL_PASTE_MAX_BYTES)
    : text;
  const pasteBytes = originalBytes > TERMINAL_PASTE_MAX_BYTES
    ? new TextEncoder().encode(truncatedText).byteLength
    : originalBytes;
  const lineCount = countLines(text);
  const previewSource = truncatedText.slice(0, TERMINAL_PASTE_PREVIEW_CHARS);
  const preview = makeVisiblePreview(previewSource);
  const truncated = originalBytes > pasteBytes;
  const hasControlCharacters = containsUnsafeControlCharacters(text);

  return {
    text: truncatedText,
    preview,
    lineCount,
    originalBytes,
    pasteBytes,
    requiresConfirmation: lineCount > 1 || originalBytes > TERMINAL_PASTE_CONFIRM_BYTES || hasControlCharacters,
    hasControlCharacters,
    truncated,
    previewTruncated: truncated || previewSource.length < truncatedText.length,
  };
}

export function formatTerminalPasteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
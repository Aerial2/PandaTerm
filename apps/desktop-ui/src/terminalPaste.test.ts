import { describe, expect, it } from 'vitest';
import { formatTerminalPasteSize, prepareTerminalPaste } from './terminalPaste';

describe('prepareTerminalPaste', () => {
  it('allows safe single-line text without confirmation', () => {
    const result = prepareTerminalPaste('echo hello');
    expect(result.requiresConfirmation).toBe(false);
    expect(result.lineCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it.each([
    ['LF', 'one\ntwo'],
    ['CRLF', 'one\r\ntwo'],
    ['CR', 'one\rtwo'],
  ])('counts %s line endings once', (_, text) => {
    const result = prepareTerminalPaste(text);
    expect(result.lineCount).toBe(2);
    expect(result.requiresConfirmation).toBe(true);
  });

  it('makes unsafe control characters visible in preview', () => {
    const result = prepareTerminalPaste('echo\u0000\u001b\u007f');
    expect(result.hasControlCharacters).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.preview).toContain('␀');
    expect(result.preview).toContain('␛');
    expect(result.preview).toContain('␡');
    expect(result.text).toBe('echo\u0000\u001b\u007f');
  });

  it('truncates oversized UTF-8 text without splitting a code point', () => {
    const text = `${'a'.repeat(1024 * 1024 - 1)}😀tail`;
    const result = prepareTerminalPaste(text);
    expect(result.truncated).toBe(true);
    expect(result.pasteBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(result.text.endsWith('\ufffd')).toBe(false);
    expect(new TextEncoder().encode(result.text).byteLength).toBe(result.pasteBytes);
  });

  it('marks a long preview as truncated', () => {
    const result = prepareTerminalPaste('x'.repeat(5000));
    expect(result.preview.length).toBe(4000);
    expect(result.previewTruncated).toBe(true);
  });
});

describe('formatTerminalPasteSize', () => {
  it('formats bytes, kilobytes and megabytes', () => {
    expect(formatTerminalPasteSize(12)).toBe('12 B');
    expect(formatTerminalPasteSize(1536)).toBe('1.5 KB');
    expect(formatTerminalPasteSize(2 * 1024 * 1024)).toBe('2.00 MB');
  });
});
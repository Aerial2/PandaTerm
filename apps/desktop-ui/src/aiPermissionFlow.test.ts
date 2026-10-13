import { describe, expect, it } from 'vitest';
import { shouldAutoDispatch, visibleManualApprovalActions } from './aiPermissionFlow';

describe('AI permission dispatch', () => {
  it('keeps Ask manual and only auto-dispatches edits in Edit mode', () => {
    for (const kind of ['terminal', 'file_edit', 'mcp'] as const) {
      expect(shouldAutoDispatch('ask', kind, true)).toBe(false);
    }
    expect(shouldAutoDispatch('edit', 'file_edit', true)).toBe(true);
    expect(shouldAutoDispatch('edit', 'terminal', true)).toBe(false);
    expect(shouldAutoDispatch('edit', 'mcp', true)).toBe(false);
  });

  it('submits every fresh action to the backend in Allowlist and Full modes', () => {
    for (const policy of ['allowlist', 'full'] as const) {
      for (const kind of ['terminal', 'file_edit', 'mcp'] as const) {
        expect(shouldAutoDispatch(policy, kind, true)).toBe(true);
      }
      expect(shouldAutoDispatch(policy, 'terminal', false)).toBe(false);
    }
  });

  it('hides manual approval actions in Allowlist mode', () => {
    expect(visibleManualApprovalActions('allowlist')).toBe(false);
    expect(visibleManualApprovalActions('ask')).toBe(true);
    expect(visibleManualApprovalActions('edit')).toBe(true);
    expect(visibleManualApprovalActions('full')).toBe(true);
  });
});

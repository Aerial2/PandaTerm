export type AiPermissionPolicy = 'ask' | 'edit' | 'allowlist' | 'full';
export type AiToolKind = 'terminal' | 'file_edit' | 'mcp';
export type AiExecutionIntent = 'automatic' | 'approve_once' | 'approve_and_remember';

export function shouldAutoDispatch(
  policy: AiPermissionPolicy,
  kind: AiToolKind,
  isFresh: boolean,
): boolean {
  if (!isFresh) return false;
  if (policy === 'full' || policy === 'allowlist') return true;
  return policy === 'edit' && kind === 'file_edit';
}

export function visibleManualApprovalActions(policy: AiPermissionPolicy): boolean {
  return policy !== 'allowlist';
}

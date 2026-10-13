import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { cancelAiTool, executeAiTool, getAiPermissionSettings, removeAiAllowlistRule, prepareAiFileEdit, sendAiChat, setAiPermissionPolicy, streamAiChat, type AiChatMessage } from './api';

beforeEach(() => vi.mocked(invoke).mockReset());

describe('AI command compatibility', () => {
  it('pins explicit conversation, agent, account and model on the existing stream command', async () => {
    const messages = [{ role: 'user' as const, content: 'task' }];
    await streamAiChat('r', messages, 'agent', { conversation_id: 'c', agent_id: 'a', account_id: 'account', model: 'model' });
    expect(invoke).toHaveBeenCalledWith('ai_chat_stream', { request: { request_id: 'r', messages, mode: 'agent', conversation_id: 'c', agent_id: 'a', step_index: null, account_id: 'account', model: 'model' } });
  });

  it('keeps the legacy stream signature compatible', async () => {
    await streamAiChat('r', []);
    expect(invoke).toHaveBeenCalledWith('ai_chat_stream', { request: { request_id: 'r', messages: [], mode: null, conversation_id: null, agent_id: null, step_index: null, account_id: null, model: null } });
  });

  it.each(['stream', 'chat'] as const)('serializes paired tool history for the %s command without mutating stored calls', async (kind) => {
    const args = JSON.stringify({ command: 'Get-CimInstance Win32_OperatingSystem' });
    const messages: AiChatMessage[] = [
      { role: 'user', content: '查询系统版本' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-os', name: 'run_terminal_command', arguments: args }] },
      { role: 'tool', tool_call_id: 'call-os', content: 'Windows 11 10.0.26200' },
    ];
    if (kind === 'stream') await streamAiChat('r', messages, 'agent');
    else await sendAiChat(messages);
    expect(invoke).toHaveBeenCalledWith(kind === 'stream' ? 'ai_chat_stream' : 'ai_chat', {
      request: expect.objectContaining({ messages: [
        messages[0],
        { role: 'assistant', content: '', tool_calls: [{ id: 'call-os', type: 'function', function: { name: 'run_terminal_command', arguments: args } }] },
        messages[2],
      ] }),
    });
    expect(messages[1].tool_calls).toEqual([{ id: 'call-os', name: 'run_terminal_command', arguments: args }]);
  });

  it('forwards automatic execution intent so the backend can return a paired denial', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      tool_call_id: 'call', name: 'run_terminal_command', status: 'denied', content: '按当前策略拒绝', is_error: true,
    });
    await expect(executeAiTool({
      tool_call_id: 'call', name: 'run_terminal_command', arguments: {}, execution_intent: 'automatic',
    })).resolves.toMatchObject({ status: 'denied', is_error: true });
    expect(invoke).toHaveBeenCalledWith('execute_ai_tool', { request: expect.objectContaining({
      tool_call_id: 'call', execution_intent: 'automatic',
    }) });
  });

  it('forwards explicit approval intent without treating the legacy approved flag as policy', async () => {
    await executeAiTool({
      tool_call_id: 'call-approved', name: 'run_terminal_command', arguments: {}, execution_intent: 'approve_once',
    });
    expect(invoke).toHaveBeenCalledWith('execute_ai_tool', { request: expect.objectContaining({
      tool_call_id: 'call-approved', execution_intent: 'approve_once',
    }) });
  });

  it('preserves remote edit preparation and the complete backend execution request', async () => {
    const request = {
      tool_id: 'edit', tool_call_id: 'provider-edit', path: '/tmp/file', terminal_id: 'remote-session',
      edits: [{ search: 'old', replace: 'new' }], execution_intent: 'automatic' as const,
    };
    const execution = {
      tool_id: 'edit', tool_call_id: 'provider-edit', name: 'propose_file_edit', approved: false,
      execution_intent: 'automatic' as const, timeout_ms: 120000,
      arguments: { path: '/canonical/file', terminal_id: 'remote-session', original_content: 'old', new_content: 'new', edits: request.edits },
    };
    vi.mocked(invoke).mockResolvedValueOnce({ allowed: true, status: 'ready', original_content: 'old', new_content: 'new', request: execution });
    const prepared = await prepareAiFileEdit(request);
    expect(invoke).toHaveBeenLastCalledWith('prepare_ai_file_edit', { request });
    await executeAiTool({ ...prepared.request!, conversation_id: 'conversation', tool_id: prepared.request!.tool_id ?? undefined, timeout_ms: prepared.request!.timeout_ms ?? undefined, agent_id: undefined, step_index: undefined });
    expect(invoke).toHaveBeenLastCalledWith('execute_ai_tool', { request: expect.objectContaining({
      tool_call_id: 'provider-edit', execution_intent: 'automatic', conversation_id: 'conversation', arguments: execution.arguments,
    }) });
  });

  it('exposes backend permission settings and exact-rule removal commands', async () => {
    await getAiPermissionSettings();
    expect(invoke).toHaveBeenLastCalledWith('get_ai_permission_settings');
    await setAiPermissionPolicy('allowlist');
    expect(invoke).toHaveBeenLastCalledWith('set_ai_permission_policy', { request: { policy: 'allowlist' } });
    await removeAiAllowlistRule('rule-1');
    expect(invoke).toHaveBeenLastCalledWith('remove_ai_allowlist_rule', { ruleId: 'rule-1' });
  });

  it('forwards continuation metadata with tool execution and cancellation', async () => {
    await executeAiTool({
      tool_call_id: 'call-2', name: 'run_terminal_command', arguments: {}, approved: true,
      conversation_id: 'conversation', agent_id: 'agent', step_index: 4,
    });
    expect(invoke).toHaveBeenCalledWith('execute_ai_tool', { request: expect.objectContaining({
      tool_call_id: 'call-2', conversation_id: 'conversation', agent_id: 'agent', step_index: 4,
    }) });
    await cancelAiTool('call-2', { conversation_id: 'conversation', agent_id: 'agent', step_index: 4 });
    expect(invoke).toHaveBeenLastCalledWith('cancel_ai_tool', {
      toolCallId: 'call-2', conversationId: 'conversation', agentId: 'agent', stepIndex: 4,
    });
  });
});
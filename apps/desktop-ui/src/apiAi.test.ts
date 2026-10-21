import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { addAiProviderAccount, cancelAiTool, executeAiTool, getAiPermissionSettings, getAiProviderConfig, removeAiAllowlistRule, prepareAiFileEdit, saveAiProviderConfig, sendAiChat, setAiPermissionPolicy, streamAiChat, syncAiProviderModels, testAiProvider, type AiChatMessage } from './api';

beforeEach(() => vi.mocked(invoke).mockReset());

describe('AI command compatibility', () => {
  it('reads a target account without invoking activation and keeps the legacy read call', async () => {
    await getAiProviderConfig();
    expect(invoke).toHaveBeenLastCalledWith('get_ai_provider_config');
    const snapshot = { account_id: 'target', active_account_id: 'active', accounts: [{ id: 'target', models: ['m'], enabled_models: ['m'] }] };
    vi.mocked(invoke).mockResolvedValueOnce(snapshot);
    await expect(getAiProviderConfig('target')).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenLastCalledWith('get_ai_provider_config', { accountId: 'target' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, true, false])('saves a target with activate=%s and preserves the returned target snapshot', async (activate) => {
    const snapshot = { account_id: 'target', active_account_id: activate === false ? 'active' : 'target' };
    vi.mocked(invoke).mockResolvedValueOnce(snapshot);
    await expect(saveAiProviderConfig({ account_id: 'target', base_url: 'https://provider.example/v1', model: 'm', use_api_key: true, activate })).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenLastCalledWith('save_ai_provider_config', { request: {
      account_id: 'target', activate: activate ?? true, account_name: null,
      base_url: 'https://provider.example/v1', model: 'm', models: null, enabled_models: null,
      reasoning_effort: null, api_format: null, context_window: null, max_tokens: null,
      use_api_key: true, api_key: null,
    } });
  });

  it.each([undefined, true, false])('adds an account with activate=%s', async (activate) => {
    await addAiProviderAccount(activate);
    expect(invoke).toHaveBeenLastCalledWith('add_ai_provider_account', { activate: activate ?? true });
  });

  it('syncs the target and passes its snapshot through without invoking activation', async () => {
    const snapshot = { account_id: 'target', active_account_id: 'active', models: ['m', 'synced'] };
    vi.mocked(invoke).mockResolvedValueOnce(snapshot);
    await expect(syncAiProviderModels({ account_id: 'target' })).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('sync_ai_provider_models', { request: {
      account_id: 'target', base_url: null, use_api_key: null, api_key: null, api_format: null,
    } });
  });

  it.each([undefined, 'target'])('tests with account_id=%s and leaves the saved key fallback to the backend', async (account_id) => {
    await testAiProvider({ account_id, base_url: 'https://provider.example/v1', model: 'm' });
    expect(invoke).toHaveBeenLastCalledWith('test_ai_provider', { request: {
      account_id: account_id ?? null, base_url: 'https://provider.example/v1', model: 'm',
      api_format: null, use_api_key: true, api_key: null,
    } });
  });

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
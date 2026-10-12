import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { cancelAiTool, executeAiTool, streamAiChat } from './api';

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

  it('refuses unauthorized execution before invoking the backend', async () => {
    await expect(executeAiTool({ tool_call_id: 'call', name: 'run_terminal_command', arguments: {}, approved: false })).rejects.toThrow('授权');
    expect(invoke).not.toHaveBeenCalled();
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
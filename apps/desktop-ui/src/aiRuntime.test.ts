import { describe, expect, it } from 'vitest';
import type { AiConversation } from './api';
import {
  fromStoredAiConversation,
  toStoredAiConversation,
  type AiConversationState,
} from './aiRuntime';

const conversation = (): AiConversationState => ({
  id: '2e9b8336-8fb7-4268-8eb8-84113cf716a4',
  title: '检查服务',
  mode: 'agent',
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:01:00.000Z',
  messages: [{
    id: 'assistant-1',
    role: 'assistant',
    content: '需要执行以下动作。',
    contexts: [],
    proposals: [{
      id: 'edit-1',
      summary: '更新配置',
      targetSource: 'C:\\app\\config.toml',
      targetLabel: 'config.toml',
      status: 'ready',
      edits: [{ search: 'port = 80', replace: 'port = 8080' }],
      baseContent: 'port = 80',
      nextContent: 'port = 8080',
      createdAt: '2026-07-15T00:00:10.000Z',
    }],
    terminalActions: [{
      id: 'terminal-1',
      summary: '检查端口',
      contextSource: 'terminal:local-1',
      contextLabel: 'PowerShell',
      command: 'Get-NetTCPConnection -LocalPort 8080',
      timeoutMs: 10_000,
      status: 'completed',
      isRemote: false,
      terminalId: 'local-1',
      output: 'LISTEN',
      exitCode: 0,
      truncated: false,
      continued: false,
      toolCallId: 'call-terminal-1',
      createdAt: '2026-07-15T00:00:20.000Z',
    }],
    mcpActions: [{
      id: 'mcp-1',
      summary: '读取服务状态',
      serverId: 'ops',
      toolName: 'service_status',
      arguments: { service: 'web' },
      status: 'completed',
      content: '{"status":"ok"}',
      isError: false,
      continued: true,
      toolCallId: 'call-mcp-1',
      createdAt: '2026-07-15T00:00:30.000Z',
    }],
    createdAt: '2026-07-15T00:00:05.000Z',
    status: 'complete',
  }],
});

describe('AI runtime persistence', () => {
  it('round-trips durable action state without persisting transient file buffers', () => {
    const stored = toStoredAiConversation(conversation());
    expect(stored.messages[0].actions).toHaveLength(3);
    expect(JSON.stringify(stored)).not.toContain('baseContent');
    expect(JSON.stringify(stored)).not.toContain('nextContent');

    const restored = fromStoredAiConversation(stored);
    expect(restored.messages[0].terminalActions[0]).toMatchObject({
      status: 'completed',
      output: 'LISTEN',
      toolCallId: 'call-terminal-1',
    });
    expect(restored.messages[0].mcpActions[0]).toMatchObject({
      status: 'completed',
      content: '{"status":"ok"}',
      continued: true,
    });
    expect(restored.messages[0].proposals[0]).toMatchObject({
      status: 'error',
      error: '文件审阅快照未持久化。请重新读取文件并生成 Diff。',
      edits: [{ search: 'port = 80', replace: 'port = 8080' }],
    });
  });

  it('fails closed when the application stopped during a side effect', () => {
    const stored = toStoredAiConversation(conversation());
    const actions = stored.messages[0].actions!;
    actions.forEach((action) => {
      if (action.kind === 'edit') action.status = 'applying';
      if (action.kind === 'terminal' || action.kind === 'mcp') action.status = 'running';
    });

    const restored = fromStoredAiConversation(stored);
    expect(restored.messages[0].proposals[0].status).toBe('error');
    expect(restored.messages[0].terminalActions[0].status).toBe('error');
    expect(restored.messages[0].mcpActions[0].status).toBe('error');
    expect(restored.messages[0].terminalActions[0].error).toContain('执行结果未知');
  });

  it('loads legacy conversations that do not contain actions', () => {
    const legacy: AiConversation = {
      id: '8657e8df-ae09-46d0-9c5c-9daafdc8fb70',
      title: '旧会话',
      mode: 'ask',
      created_at: '2026-07-14T00:00:00.000Z',
      updated_at: '2026-07-14T00:00:00.000Z',
      messages: [{
        id: 'message-1',
        role: 'assistant',
        content: '历史消息',
        contexts: [],
        created_at: '2026-07-14T00:00:00.000Z',
        status: 'complete',
      }],
    };

    const restored = fromStoredAiConversation(legacy);
    expect(restored.messages[0].proposals).toEqual([]);
    expect(restored.messages[0].terminalActions).toEqual([]);
    expect(restored.messages[0].mcpActions).toEqual([]);
  });
});
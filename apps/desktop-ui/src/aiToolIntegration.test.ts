import { describe, expect, it } from 'vitest';
import type { AiConversationState, AiMessage } from './aiRuntime';
import { aiToolRequestGroup, hasPendingAiTools, resolvedAiToolResults } from './aiToolHistory';
import { prepareAiToolContinuation } from './aiAgentContinuation';
import { buildAiRequestMessages } from './aiChatModel';
import { mapNativeToolCalls } from './aiToolCall';
import { applyExactEdits, parseAiEditResponse } from './aiEditProposal';

const message = (id: string, role: AiMessage['role'] = 'assistant'): AiMessage => ({
  id, role, content: '', contexts: [], proposals: [], terminalActions: [], mcpActions: [],
  createdAt: '2026-10-10T00:00:00Z', status: 'complete', agentId: 'agent', accountId: 'account', model: 'pinned-model',
});
const withActions = (): AiMessage => ({ ...message('a'),
  toolCalls: [{ id: 't', name: 'run_terminal_command', arguments: '{"command":"hostname"}' }, { id: 'm', name: 'call_mcp_tool', arguments: '{}' }, { id: 'e', name: 'propose_file_edit', arguments: '{}' }],
  terminalActions: [{ id: 'ta', toolCallId: 't', summary: 'hostname', contextSource: 'terminal', contextLabel: 'terminal', command: 'hostname', timeoutMs: 10000, status: 'completed', isRemote: false, terminalId: 'terminal', output: 'host', exitCode: 0, createdAt: 'now' }],
  mcpActions: [{ id: 'ma', toolCallId: 'm', summary: 'lookup', serverId: 'server', toolName: 'tool', arguments: {}, status: 'error', content: 'failure', isError: true, createdAt: 'now' }],
  proposals: [{ id: 'ea', toolCallId: 'e', summary: 'edit', targetSource: 'file', targetLabel: 'file', edits: [{ search: 'a', replace: 'b' }], status: 'rejected', createdAt: 'now' }],
});
const conversation = (source = withActions()): AiConversationState => ({
  id: 'c', title: 'c', mode: 'agent', createdAt: 'now', updatedAt: 'now', messages: [{ ...message('u', 'user'), content: 'task', contexts: [{ kind: 'file', label: 'file', source: 'file', preview: 'a' }] }, source],
});

describe('native tool history and continuation', () => {
  it('pairs every call with a native tool role success/error/rejection', () => {
    const group = aiToolRequestGroup(withActions(), 'actions');
    expect(group.map(({ role }) => role)).toEqual(['assistant', 'tool', 'tool', 'tool']);
    expect(group[0].tool_calls?.map(({ id }) => id)).toEqual(['t', 'm', 'e']);
    expect(group.slice(1).map(({ tool_call_id, is_error }) => [tool_call_id, is_error])).toEqual([['t', false], ['m', true], ['e', true]]);
    expect(group[1].content).toContain('host');
  });

  it('preserves explicit native arguments and synthesizes paired failure for invalid/unapproved calls', () => {
    const source = withActions();
    source.terminalActions[0].status = 'proposed';
    source.toolCalls!.push({ id: 'unknown', name: 'invalid', arguments: '{}' });
    const group = aiToolRequestGroup(source, '');
    expect(group[0].tool_calls![0].arguments).toBe('{"command":"hostname"}');
    expect(group.find(({ tool_call_id }) => tool_call_id === 't')).toMatchObject({ role: 'tool', is_error: true });
    expect(group.find(({ tool_call_id }) => tool_call_id === 'unknown')).toMatchObject({ role: 'tool', is_error: true });
  });

  it.each(['proposed', 'reading', 'ready', 'applying'] as const)('waits for edit state %s before continuation', (status) => {
    const source = withActions();
    source.proposals[0].status = status;
    expect(hasPendingAiTools(source)).toBe(true);
    expect(prepareAiToolContinuation(conversation(source), 'a')).toBeNull();
  });

  it.each(['applied', 'error', 'stale', 'rejected'] as const)('continues once after edit state %s with authorization context and pinned model', (status) => {
    const source = withActions();
    source.proposals[0].status = status;
    const current = conversation(source);
    const prepared = prepareAiToolContinuation(current, 'a', () => 'result')!;
    expect(prepared.resultMessage).toMatchObject({ role: 'tool', agentId: 'agent', accountId: 'account', model: 'pinned-model', contexts: current.messages[0].contexts });
    expect(prepared.baseMessages[1].proposals[0].continued).toBe(true);
    expect(prepareAiToolContinuation({ ...current, messages: [...prepared.baseMessages, prepared.resultMessage] }, 'a')).toBeNull();
    expect(resolvedAiToolResults(source).find(({ id }) => id === 'e')?.isError).toBe(status !== 'applied');
  });

  it('returns validation failures for a native call with no accepted UI action', () => {
    const source = message('a');
    source.toolCalls = [{ id: 'bad', name: 'unknown', arguments: '{}' }];
    const prepared = prepareAiToolContinuation(conversation(source), 'a', () => 'result')!;
    expect(JSON.parse(prepared.resultMessage.content)[0]).toMatchObject({ role: 'tool', tool_call_id: 'bad', is_error: true });
  });

  it('does not continue inactive branches, superseded tasks or Ask mode', () => {
    const current = conversation();
    expect(prepareAiToolContinuation(current, 'inactive')).toBeNull();
    expect(prepareAiToolContinuation({ ...current, mode: 'ask' }, 'a')).toBeNull();
    expect(prepareAiToolContinuation({ ...current, messages: [...current.messages, { ...message('next', 'user'), agentId: 'new' }] }, 'a')).toBeNull();
  });

  it('keeps tool history groups atomic during clipping and omits synthetic user instructions', () => {
    const current = conversation();
    const prepared = prepareAiToolContinuation(current, 'a', () => 'result')!;
    const request = buildAiRequestMessages(prepared.baseMessages, prepared.resultMessage, 'agent', '', 0);
    expect(request.map(({ role }) => role)).toEqual(['system', 'assistant', 'tool', 'tool', 'tool']);
    expect(request.slice(2).map(({ tool_call_id }) => tool_call_id)).toEqual(['t', 'm', 'e']);
    expect(request.some(({ role }) => role === 'user')).toBe(false);
  });

  it('caps automatic continuation count', () => {
    const current = conversation();
    const repeated = Array.from({ length: 16 }, (_, index) => [message(`result${index}`, 'tool'), message(`assistant${index}`)]).flat();
    expect(prepareAiToolContinuation({ ...current, messages: [current.messages[0], ...repeated, current.messages[1]] }, 'a')).toBeNull();
  });
});

describe('native editing with fence fallback', () => {
  it('maps native edits without corrupting embedded markdown fences', () => {
    const args = { summary: 'markdown', target_source: 'file', edits: [{ search: '```old```', replace: '```new```' }] };
    const mapped = mapNativeToolCalls([{ id: 'edit-call', name: 'propose_file_edit', arguments: JSON.stringify(args) }]);
    expect(mapped.errors).toEqual([]);
    expect(mapped.proposals[0]).toMatchObject({ toolCallId: 'edit-call', targetSource: 'file', edits: args.edits });
    expect(applyExactEdits('```old```', mapped.proposals[0].edits)).toBe('```new```');
  });

  it('keeps legacy fences valid and rejects malformed native edits', () => {
    const args = { summary: 'edit', target_source: 'file', edits: [{ search: 'a', replace: 'b' }] };
    expect(parseAiEditResponse('```pandaterm-edit\n' + JSON.stringify(args) + '\n```').proposals).toHaveLength(1);
    const mapped = mapNativeToolCalls([{ id: 'edit-call', name: 'propose_file_edit', arguments: '{"summary":"invalid","edits":[]}' }]);
    expect(mapped.proposals).toEqual([]);
    expect(mapped.errors).toHaveLength(1);
  });

  it('requires exact unique search text', () => {
    expect(() => applyExactEdits('a a', [{ search: 'a', replace: 'b' }])).toThrow('不唯一');
    expect(() => applyExactEdits('x', [{ search: 'a', replace: 'b' }])).toThrow('找不到');
  });
});
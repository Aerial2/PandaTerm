import { normalizeTerminalCommand } from './aiTerminalAction';

export type AiNativeToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type MappedNativeTerminalAction = {
  summary: string;
  contextSource: string;
  command: string;
  timeoutMs: number;
  toolCallId?: string;
};

export type MappedNativeMcpAction = {
  summary: string;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  toolCallId?: string;
};

export type MappedNativeToolActions = {
  terminalActions: MappedNativeTerminalAction[];
  mcpActions: MappedNativeMcpAction[];
  errors: string[];
};

const MAX_ACTIONS = 3;
const MAX_COMMAND_LENGTH = 4_000;
const MIN_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 30_000;

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseArgumentsObject(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  const object = asObject(parsed);
  if (!object) throw new Error('arguments 必须是 JSON 对象');
  return object;
}

/**
 * 将 OpenAI-compatible tool_calls 映射为现有 terminal/mcp 动作提案。
 * 兼容 fence 协议；两侧结果在 finish 时合并去重。
 */
export function mapNativeToolCalls(toolCalls: AiNativeToolCall[]): MappedNativeToolActions {
  const terminalActions: MappedNativeTerminalAction[] = [];
  const mcpActions: MappedNativeMcpAction[] = [];
  const errors: string[] = [];

  for (const call of toolCalls) {
    const name = (call.name || '').trim();
    if (!name) {
      errors.push('tool_call 缺少 name');
      continue;
    }
    try {
      const args = parseArgumentsObject(call.arguments || '{}');
      if (name === 'run_terminal_command') {
        if (terminalActions.length + mcpActions.length >= MAX_ACTIONS) {
          errors.push(`单条回复最多允许 ${MAX_ACTIONS} 个工具动作`);
          break;
        }
        const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
        const contextSource = typeof args.context_source === 'string' ? args.context_source.trim() : '';
        const command = typeof args.command === 'string' ? args.command.trim() : '';
        if (!summary) throw new Error('缺少 summary');
        if (!contextSource) throw new Error('缺少 context_source');
        if (!command) throw new Error('缺少 command');
        if (command.length > MAX_COMMAND_LENGTH) throw new Error('command 过长');
        const requestedTimeout = typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms)
          ? Math.round(args.timeout_ms)
          : 10_000;
        terminalActions.push({
          summary: summary.slice(0, 500),
          contextSource,
          command: normalizeTerminalCommand(command),
          timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, requestedTimeout)),
          toolCallId: call.id || undefined,
        });
        continue;
      }
      if (name === 'call_mcp_tool') {
        if (terminalActions.length + mcpActions.length >= MAX_ACTIONS) {
          errors.push(`单条回复最多允许 ${MAX_ACTIONS} 个工具动作`);
          break;
        }
        const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
        const serverId = typeof args.server === 'string' ? args.server.trim() : '';
        const toolName = typeof args.tool === 'string' ? args.tool.trim() : '';
        if (!summary) throw new Error('缺少 summary');
        if (!serverId) throw new Error('缺少 server');
        if (!toolName) throw new Error('缺少 tool');
        let toolArgs: Record<string, unknown> = {};
        if (args.arguments !== undefined && args.arguments !== null) {
          const object = asObject(args.arguments);
          if (!object) throw new Error('arguments 必须是对象');
          toolArgs = object;
        }
        mcpActions.push({
          summary: summary.slice(0, 500),
          serverId,
          toolName,
          arguments: toolArgs,
          toolCallId: call.id || undefined,
        });
        continue;
      }
      errors.push(`不支持的工具：${name}`);
    } catch (error) {
      errors.push(`工具 ${name} 参数无效：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { terminalActions, mcpActions, errors };
}
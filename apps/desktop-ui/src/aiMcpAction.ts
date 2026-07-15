export type AiMcpActionStatus =
  | 'proposed'
  | 'running'
  | 'completed'
  | 'rejected'
  | 'error';

export type AiMcpAction = {
  id: string;
  summary: string;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: AiMcpActionStatus;
  content?: string;
  isError?: boolean;
  error?: string;
  continued?: boolean;
  toolCallId?: string;
  createdAt: string;
};

type ParsedMcpAction = {
  summary?: unknown;
  server?: unknown;
  tool?: unknown;
  arguments?: unknown;
};

export type ParsedAiMcpResponse = {
  visibleContent: string;
  actions: Array<{
    summary: string;
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    toolCallId?: string;
  }>;
  errors: string[];
};

const MCP_BLOCK_PATTERN = /```pandaterm-mcp[ \t]*(?:\r?\n)?([\s\S]*?)```/g;
const MAX_ACTIONS = 3;

export function parseAiMcpResponse(content: string): ParsedAiMcpResponse {
  const actions: ParsedAiMcpResponse['actions'] = [];
  const errors: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = MCP_BLOCK_PATTERN.exec(content)) !== null) {
    if (actions.length >= MAX_ACTIONS) {
      errors.push(`单条回复最多允许 ${MAX_ACTIONS} 个 MCP 动作`);
      break;
    }
    try {
      const parsed = JSON.parse(match[1].trim()) as ParsedMcpAction;
      if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
        throw new Error('缺少 summary');
      }
      if (typeof parsed.server !== 'string' || !parsed.server.trim()) {
        throw new Error('缺少 server');
      }
      if (typeof parsed.tool !== 'string' || !parsed.tool.trim()) {
        throw new Error('缺少 tool');
      }
      let args: Record<string, unknown> = {};
      if (parsed.arguments !== undefined && parsed.arguments !== null) {
        if (typeof parsed.arguments !== 'object' || Array.isArray(parsed.arguments)) {
          throw new Error('arguments 必须是对象');
        }
        args = parsed.arguments as Record<string, unknown>;
      }
      actions.push({
        summary: parsed.summary.trim().slice(0, 500),
        serverId: parsed.server.trim(),
        toolName: parsed.tool.trim(),
        arguments: args,
      });
    } catch (error) {
      errors.push(`MCP 动作格式无效：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    visibleContent: content.replace(MCP_BLOCK_PATTERN, '').trimEnd(),
    actions,
    errors,
  };
}

export function mcpActionIdentity(serverId: string, toolName: string, args: Record<string, unknown>): string {
  return `${serverId}::${toolName}::${JSON.stringify(args)}`;
}
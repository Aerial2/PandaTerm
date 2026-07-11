export type AiTerminalActionStatus =
  | 'proposed'
  | 'running'
  | 'completed'
  | 'rejected'
  | 'timeout'
  | 'error';

export type AiTerminalAction = {
  id: string;
  summary: string;
  contextSource: string;
  contextLabel: string;
  command: string;
  timeoutMs: number;
  status: AiTerminalActionStatus;
  isRemote: boolean;
  terminalId: string;
  output?: string;
  exitCode?: number | null;
  truncated?: boolean;
  error?: string;
  continued?: boolean;
  createdAt: string;
};

type ParsedTerminalAction = {
  summary?: unknown;
  context_source?: unknown;
  command?: unknown;
  timeout_ms?: unknown;
};

export type ParsedAiTerminalResponse = {
  visibleContent: string;
  actions: Array<{
    summary: string;
    contextSource: string;
    command: string;
    timeoutMs: number;
  }>;
  errors: string[];
};

const TERMINAL_BLOCK_PATTERN = /```pandaterm-terminal[ \t]*(?:\r?\n)?([\s\S]*?)```/g;
const MAX_ACTIONS = 3;
const MAX_COMMAND_LENGTH = 4_000;
const MIN_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 30_000;
const HIGH_RISK_PATTERN = /(^|[\s;|&])(rm\s+-rf|del\s+\/|format\b|mkfs\b|shutdown\b|reboot\b|stop-computer\b|remove-item\b[^\n]*-recurse|diskpart\b)/i;

export function parseAiTerminalResponse(content: string): ParsedAiTerminalResponse {
  const actions: ParsedAiTerminalResponse['actions'] = [];
  const errors: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = TERMINAL_BLOCK_PATTERN.exec(content)) !== null) {
    if (actions.length >= MAX_ACTIONS) {
      errors.push(`单条回复最多允许 ${MAX_ACTIONS} 个终端动作`);
      break;
    }
    try {
      const parsed = JSON.parse(match[1].trim()) as ParsedTerminalAction;
      if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) throw new Error('缺少 summary');
      if (typeof parsed.context_source !== 'string' || !parsed.context_source.trim()) {
        throw new Error('缺少 context_source');
      }
      if (typeof parsed.command !== 'string' || !parsed.command.trim()) throw new Error('缺少 command');
      if (parsed.command.length > MAX_COMMAND_LENGTH) throw new Error('command 过长');
      const requestedTimeout = typeof parsed.timeout_ms === 'number' && Number.isFinite(parsed.timeout_ms)
        ? Math.round(parsed.timeout_ms)
        : 10_000;
      actions.push({
        summary: parsed.summary.trim().slice(0, 500),
        contextSource: parsed.context_source.trim(),
        command: normalizeTerminalCommand(parsed.command.trim()),
        timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, requestedTimeout)),
      });
    } catch (error) {
      errors.push(`终端动作格式无效：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    visibleContent: content.replace(TERMINAL_BLOCK_PATTERN, '').trimEnd(),
    actions,
    errors,
  };
}

export function terminalCommandIdentity(command: string): string {
  return command.replace(/\r\n/g, '\n').trim();
}

/**
 * 把 AI 常见「漏空格重定向」拆开，而不是直接拒掉。
 *
 * 例：
 * - `nginx -T2>/dev/null` → `nginx -T 2>/dev/null`
 * - `cat /www/1.txt2>/dev/null` → `cat /www/1.txt 2>/dev/null`  （此前误报 t2>）
 * - `test -f a.txt2>&1` → `test -f a.txt 2>&1`
 * - `echo hello>file` → `echo hello >file`
 *
 * 保留合法：`2>/dev/null`、`1>&2`、`&>file`、空白后的 `>file`
 */
export function normalizeTerminalCommand(command: string): string {
  return command
    // 短选项与 fd 粘连：-T2> → -T 2>
    .replace(/(^|[\s;|&])-([A-Za-z])([12]>{1,2})/g, '$1-$2 $3')
    // 路径/词与 fd 粘连：txt2>/dev/null → txt 2>/dev/null；txt2>&1 → txt 2>&1
    .replace(/([^\s;|&<>])([12]>{1,2})/g, '$1 $2')
    // 普通重定向粘连：hello>file → hello >file（不碰 2> / &>）
    .replace(/([^\s;|&<>12])(>{1,2})(?!&)/g, '$1 $2');
}

/**
 * 规范化后仍存在的「词与重定向粘连」才拒绝。
 * 另：拦下协议泄漏形态 `T2>`（前后是空白/分隔符，不是 -T 选项）。
 */
export function suspiciousShellRedirection(command: string): string | null {
  const toolLeak = command.match(/(?:^|[\s;|&])(T\d+>)/);
  if (toolLeak?.[1]) return toolLeak[1];

  const normalized = normalizeTerminalCommand(command);
  const pattern = /[^\s12](?:[12]?>|>>)(?=\S)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    const index = match.index;
    if (normalized[index] === '&') continue;
    if (index > 0 && normalized[index - 1] === '-' && /[A-Za-z]/u.test(normalized[index] ?? '')) continue;
    return match[0];
  }
  return null;
}

export function isHighRiskTerminalCommand(command: string): boolean {
  return HIGH_RISK_PATTERN.test(command);
}
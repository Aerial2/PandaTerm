export type AiEditOperation = {
  search: string;
  replace: string;
};

export type AiEditProposalStatus =
  | 'proposed'
  | 'reading'
  | 'ready'
  | 'applying'
  | 'applied'
  | 'rejected'
  | 'stale'
  | 'error';

export type AiEditProposal = {
  id: string;
  summary: string;
  targetSource: string;
  targetLabel: string;
  status: AiEditProposalStatus;
  edits: AiEditOperation[];
  baseContent?: string;
  nextContent?: string;
  isRemote?: boolean;
  terminalId?: string;
  error?: string;
  continued?: boolean;
  createdAt: string;
};

type ParsedProposal = {
  summary?: unknown;
  target_source?: unknown;
  edits?: unknown;
};

export type ParsedAiEditResponse = {
  visibleContent: string;
  proposals: Array<{
    summary: string;
    targetSource: string;
    edits: AiEditOperation[];
  }>;
  errors: string[];
};

const EDIT_BLOCK_PATTERN = /```pandaterm-edit[ \t]*(?:\r?\n)?([\s\S]*?)```/g;
const MAX_PROPOSALS = 5;
const MAX_OPERATIONS = 20;
const MAX_BLOCK_LENGTH = 256_000;
const MAX_OPERATION_LENGTH = 100_000;

export function parseAiEditResponse(content: string): ParsedAiEditResponse {
  const proposals: ParsedAiEditResponse['proposals'] = [];
  const errors: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = EDIT_BLOCK_PATTERN.exec(content)) !== null) {
    if (proposals.length >= MAX_PROPOSALS) {
      errors.push(`单条回复最多允许 ${MAX_PROPOSALS} 个修改提案`);
      break;
    }
    const block = match[1].trim();
    if (block.length > MAX_BLOCK_LENGTH) {
      errors.push('修改提案过大，已拒绝解析');
      continue;
    }
    try {
      const parsed = JSON.parse(block) as ParsedProposal;
      if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
        throw new Error('缺少 summary');
      }
      if (typeof parsed.target_source !== 'string' || !parsed.target_source.trim()) {
        throw new Error('缺少 target_source');
      }
      if (!Array.isArray(parsed.edits) || parsed.edits.length === 0 || parsed.edits.length > MAX_OPERATIONS) {
        throw new Error(`edits 数量必须为 1-${MAX_OPERATIONS}`);
      }
      const edits = parsed.edits.map((operation, index) => {
        if (!operation || typeof operation !== 'object') throw new Error(`第 ${index + 1} 个 edit 无效`);
        const candidate = operation as Record<string, unknown>;
        if (typeof candidate.search !== 'string' || candidate.search.length === 0) {
          throw new Error(`第 ${index + 1} 个 edit 缺少 search`);
        }
        if (typeof candidate.replace !== 'string') throw new Error(`第 ${index + 1} 个 edit 缺少 replace`);
        if (candidate.search.length > MAX_OPERATION_LENGTH || candidate.replace.length > MAX_OPERATION_LENGTH) {
          throw new Error(`第 ${index + 1} 个 edit 过大`);
        }
        return { search: candidate.search, replace: candidate.replace };
      });
      proposals.push({
        summary: parsed.summary.trim().slice(0, 500),
        targetSource: parsed.target_source.trim(),
        edits,
      });
    } catch (error) {
      errors.push(`修改提案格式无效：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    visibleContent: content.replace(EDIT_BLOCK_PATTERN, '').trimEnd(),
    proposals,
    errors,
  };
}

export function applyExactEdits(baseContent: string, edits: AiEditOperation[]): string {
  let nextContent = baseContent;
  for (const [index, edit] of edits.entries()) {
    const first = nextContent.indexOf(edit.search);
    if (first < 0) throw new Error(`第 ${index + 1} 处修改找不到原始文本`);
    if (nextContent.indexOf(edit.search, first + edit.search.length) >= 0) {
      throw new Error(`第 ${index + 1} 处修改的原始文本不唯一`);
    }
    nextContent = `${nextContent.slice(0, first)}${edit.replace}${nextContent.slice(first + edit.search.length)}`;
  }
  return nextContent;
}

export function summarizeEditDelta(proposal: AiEditProposal): { added: number; removed: number } {
  return proposal.edits.reduce((summary, edit) => ({
    added: summary.added + edit.replace.split('\n').length,
    removed: summary.removed + edit.search.split('\n').length,
  }), { added: 0, removed: 0 });
}
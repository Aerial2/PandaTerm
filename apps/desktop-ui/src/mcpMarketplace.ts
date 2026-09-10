/**
 * MCP 市场：精选可安装目录（非全网爬取）。
 * 来源：官方 reference servers + 社区高星/常用包，配置为可直接写入草稿的模板。
 */

import type { McpServerConfig, McpTransport } from './api';

export type McpMarketCategoryId =
  | 'all'
  | 'official'
  | 'devtools'
  | 'browser'
  | 'search'
  | 'database'
  | 'cloud'
  | 'knowledge'
  | 'productivity'
  | 'china';

export type McpMarketItem = {
  /** 目录 id，同时作为建议的 server id */
  id: string;
  name: string;
  description: string;
  category: Exclude<McpMarketCategoryId, 'all'>;
  tags: string[];
  /** 文档/仓库 */
  homepage?: string;
  /** 启用前需填写的环境变量名 */
  requiresEnv?: string[];
  /** 启用前需按本机路径改参数 */
  requiresArgs?: boolean;
  /** 安装/使用提示（中文） */
  note?: string;
  config: {
    transport: McpTransport;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
};

export const MCP_MARKET_CATEGORIES: Array<{ id: McpMarketCategoryId; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'official', label: '官方参考' },
  { id: 'devtools', label: '开发工具' },
  { id: 'browser', label: '浏览器' },
  { id: 'search', label: '搜索' },
  { id: 'database', label: '数据库' },
  { id: 'cloud', label: '云与运维' },
  { id: 'knowledge', label: '知识记忆' },
  { id: 'productivity', label: '协作效率' },
  { id: 'china', label: '国内常用' },
];

/** 精选目录：可 npx/uvx/远程 URL 一键生成配置 */
export const MCP_MARKET_CATALOG: McpMarketItem[] = [
  // —— 官方 reference ——
  {
    id: 'filesystem',
    name: '文件系统',
    description: '受控读写本地目录，适合让 Agent 操作工作区文件。',
    category: 'official',
    tags: ['官方', '文件', 'npx'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    requiresArgs: true,
    note: '请把最后一个参数改成允许访问的目录（默认当前目录 .）。',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    },
  },
  {
    id: 'fetch',
    name: '网页抓取 Fetch',
    description: '抓取网页并转为适合模型阅读的文本。',
    category: 'official',
    tags: ['官方', '网页', 'uvx'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    note: '需要已安装 uv / uvx。Windows 建议保留 PYTHONIOENCODING=utf-8。',
    config: {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch'],
      env: {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    },
  },
  {
    id: 'memory',
    name: '知识图谱记忆',
    description: '基于知识图谱的持久记忆，跨会话记住实体与关系。',
    category: 'official',
    tags: ['官方', '记忆', 'npx'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    },
  },
  {
    id: 'sequential-thinking',
    name: '顺序思考',
    description: '通过多步反思式思考拆解复杂问题。',
    category: 'official',
    tags: ['官方', '推理', 'npx'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
  },
  {
    id: 'time',
    name: '时间与时区',
    description: '当前时间查询与时区转换。',
    category: 'official',
    tags: ['官方', '时间', 'uvx'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    note: '需要已安装 uv / uvx。',
    config: {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-time'],
      env: {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    },
  },
  {
    id: 'git',
    name: 'Git 仓库',
    description: '读取、搜索并操作本地 Git 仓库。',
    category: 'official',
    tags: ['官方', 'git', 'uvx'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    requiresArgs: true,
    note: '把 --repository 后的路径改成你的仓库目录。需要 uvx。',
    config: {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-git', '--repository', '.'],
      env: {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    },
  },
  {
    id: 'everything',
    name: 'Everything 测试服',
    description: '官方参考实现：提示词、资源、工具一应俱全，适合联调。',
    category: 'official',
    tags: ['官方', '测试', 'npx'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
    },
  },

  // —— 开发工具 ——
  {
    id: 'context7',
    name: 'Context7 文档',
    description: '拉取库的最新版本文档，减少过时 API 幻觉。',
    category: 'devtools',
    tags: ['文档', 'npx', '热门'],
    homepage: 'https://github.com/upstash/context7',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    description: '仓库、Issue、PR、代码搜索等 GitHub API 能力。',
    category: 'devtools',
    tags: ['github', 'npx'],
    homepage: 'https://github.com/github/github-mcp-server',
    requiresEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    note: '填写 GitHub Personal Access Token 后启用。',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    },
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'GitLab 项目管理与 API 集成。',
    category: 'devtools',
    tags: ['gitlab', 'npx'],
    homepage: 'https://github.com/modelcontextprotocol/servers-archived',
    requiresEnv: ['GITLAB_PERSONAL_ACCESS_TOKEN', 'GITLAB_API_URL'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-gitlab'],
      env: {
        GITLAB_PERSONAL_ACCESS_TOKEN: '',
        GITLAB_API_URL: 'https://gitlab.com/api/v4',
      },
    },
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: '查询与分析 Sentry 错误与 issue。',
    category: 'devtools',
    tags: ['监控', 'npx'],
    requiresEnv: ['SENTRY_AUTH_TOKEN'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sentry'],
      env: { SENTRY_AUTH_TOKEN: '' },
    },
  },
  {
    id: 'task-master',
    name: 'Task Master',
    description: '把需求文档拆成可执行任务并驱动 Agent 推进。',
    category: 'devtools',
    tags: ['任务', 'npx'],
    homepage: 'https://github.com/eyaltoledano/claude-task-master',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'task-master-ai'],
    },
  },
  {
    id: 'markitdown',
    name: 'MarkItDown',
    description: '把 PDF/Office/HTML/图片转为 Markdown，便于模型阅读。',
    category: 'devtools',
    tags: ['文档转换', 'uvx', '热门'],
    homepage: 'https://github.com/microsoft/markitdown',
    note: '需要 uvx；首次运行会拉取 Python 包。',
    config: {
      transport: 'stdio',
      command: 'uvx',
      args: ['markitdown-mcp'],
    },
  },

  // —— 浏览器 ——
  {
    id: 'playwright',
    name: 'Playwright 浏览器',
    description: '微软官方 Playwright MCP：真实浏览器自动化与页面交互。',
    category: 'browser',
    tags: ['浏览器', 'npx', '热门'],
    homepage: 'https://github.com/microsoft/playwright-mcp',
    note: '首次可能自动下载浏览器内核。',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    },
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: '基于 Puppeteer 的网页抓取与浏览器交互。',
    category: 'browser',
    tags: ['浏览器', 'npx'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    },
  },
  {
    id: 'playwright-community',
    name: 'Playwright（社区）',
    description: 'ExecuteAutomation 社区版 Playwright MCP。',
    category: 'browser',
    tags: ['浏览器', 'npx'],
    homepage: 'https://github.com/executeautomation/mcp-playwright',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@executeautomation/playwright-mcp-server'],
    },
  },

  // —— 搜索 ——
  {
    id: 'brave-search',
    name: 'Brave 搜索',
    description: 'Brave Search API：网页与本地搜索。',
    category: 'search',
    tags: ['搜索', 'npx'],
    homepage: 'https://github.com/brave/brave-search-mcp-server',
    requiresEnv: ['BRAVE_API_KEY'],
    note: '在 Brave Search 控制台申请 API Key。',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server'],
      env: { BRAVE_API_KEY: '' },
    },
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo 搜索',
    description: '无需 API Key 的网页搜索（社区实现，稳定性因环境而异）。',
    category: 'search',
    tags: ['搜索', 'npx'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'duckduckgo-mcp-server'],
    },
  },
  {
    id: 'tavily',
    name: 'Tavily 搜索',
    description: '面向 AI 的网页搜索与摘要 API。',
    category: 'search',
    tags: ['搜索', 'npx'],
    requiresEnv: ['TAVILY_API_KEY'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'tavily-mcp'],
      env: { TAVILY_API_KEY: '' },
    },
  },
  {
    id: 'exa',
    name: 'Exa 搜索',
    description: '语义网页搜索，适合研究类任务。',
    category: 'search',
    tags: ['搜索', 'npx'],
    requiresEnv: ['EXA_API_KEY'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'exa-mcp-server'],
      env: { EXA_API_KEY: '' },
    },
  },

  // —— 数据库 ——
  {
    id: 'sqlite',
    name: 'SQLite',
    description: '本地 SQLite 查询与业务分析能力。',
    category: 'database',
    tags: ['sqlite', 'uvx'],
    requiresArgs: true,
    note: '把数据库文件路径换成你的 .db 文件。需要 uvx。',
    config: {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-sqlite', '--db-path', './data.db'],
    },
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: '只读访问 Postgres，带 schema 检查。',
    category: 'database',
    tags: ['postgres', 'npx'],
    requiresArgs: true,
    note: '把连接串换成你的 postgresql://…。',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
    },
  },
  {
    id: 'mysql',
    name: 'MySQL',
    description: 'MySQL 数据库访问（Node 实现）。',
    category: 'database',
    tags: ['mysql', 'npx'],
    requiresEnv: ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@f4ww4z/mcp-mysql-server'],
      env: {
        MYSQL_HOST: '127.0.0.1',
        MYSQL_USER: 'root',
        MYSQL_PASSWORD: '',
        MYSQL_DATABASE: '',
      },
    },
  },
  {
    id: 'redis',
    name: 'Redis',
    description: '与 Redis 键值存储交互。',
    category: 'database',
    tags: ['redis', 'npx'],
    requiresArgs: true,
    note: '按需修改 Redis 连接 URL。',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-redis', 'redis://localhost:6379'],
    },
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    description: 'MongoDB 查询与集合浏览（社区实现）。',
    category: 'database',
    tags: ['mongodb', 'npx'],
    requiresEnv: ['MDB_MCP_CONNECTION_STRING'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mongodb-mcp-server'],
      env: { MDB_MCP_CONNECTION_STRING: 'mongodb://127.0.0.1:27017' },
    },
  },
  {
    id: 'clickhouse',
    name: 'ClickHouse',
    description: 'ClickHouse 官方 MCP，适合分析型查询。',
    category: 'database',
    tags: ['clickhouse', 'uvx'],
    requiresEnv: ['CLICKHOUSE_HOST', 'CLICKHOUSE_USER', 'CLICKHOUSE_PASSWORD'],
    note: '需要 uvx 与可访问的 ClickHouse 实例。',
    config: {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-clickhouse'],
      env: {
        CLICKHOUSE_HOST: 'http://localhost:8123',
        CLICKHOUSE_USER: 'default',
        CLICKHOUSE_PASSWORD: '',
      },
    },
  },

  // —— 云与运维 ——
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    description: '用自然语言操作 K8s 集群资源。',
    category: 'cloud',
    tags: ['k8s', 'npx'],
    homepage: 'https://github.com/Flux159/mcp-server-kubernetes',
    note: '本机需可用的 kubectl 与 kubeconfig。',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-server-kubernetes'],
    },
  },
  {
    id: 'docker',
    name: 'Docker',
    description: '管理容器、镜像与 Docker 资源（社区实现）。',
    category: 'cloud',
    tags: ['docker', 'npx'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-server-docker'],
    },
  },
  {
    id: 'aws',
    name: 'AWS CLI',
    description: '在受控环境中执行 AWS CLI 与常见运维模板。',
    category: 'cloud',
    tags: ['aws', 'uvx'],
    note: '需要本机配置好 AWS 凭证，并安装 uvx。',
    config: {
      transport: 'stdio',
      command: 'uvx',
      args: ['awslabs.core-mcp-server@latest'],
    },
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Workers / KV / R2 / D1 等 Cloudflare 服务集成。',
    category: 'cloud',
    tags: ['cloudflare', 'npx'],
    homepage: 'https://github.com/cloudflare/mcp-server-cloudflare',
    requiresEnv: ['CLOUDFLARE_API_TOKEN'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@cloudflare/mcp-server-cloudflare'],
      env: { CLOUDFLARE_API_TOKEN: '' },
    },
  },

  // —— 知识记忆 ——
  {
    id: 'obsidian',
    name: 'Obsidian',
    description: '访问本地 Obsidian 笔记库（社区实现，路径需自配）。',
    category: 'knowledge',
    tags: ['笔记', 'npx'],
    requiresEnv: ['OBSIDIAN_API_KEY'],
    requiresArgs: true,
    note: '需 Obsidian Local REST API 插件；按文档填写密钥与 vault。',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'obsidian-mcp'],
      env: { OBSIDIAN_API_KEY: '' },
    },
  },
  {
    id: 'notion',
    name: 'Notion',
    description: '读写 Notion 页面与数据库。',
    category: 'knowledge',
    tags: ['notion', 'npx'],
    requiresEnv: ['NOTION_API_KEY'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: { NOTION_API_KEY: '' },
    },
  },
  {
    id: 'rag-web-browser',
    name: 'RAG 网页浏览器',
    description: '搜索并抓取网页内容，供 RAG 类工作流使用。',
    category: 'knowledge',
    tags: ['rag', 'npx'],
    requiresEnv: ['APIFY_TOKEN'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@apify/mcp-server-rag-web-browser'],
      env: { APIFY_TOKEN: '' },
    },
  },

  // —— 协作效率 ——
  {
    id: 'slack',
    name: 'Slack',
    description: '频道管理与消息收发。',
    category: 'productivity',
    tags: ['slack', 'npx'],
    requiresEnv: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
      env: {
        SLACK_BOT_TOKEN: '',
        SLACK_TEAM_ID: '',
      },
    },
  },
  {
    id: 'gmail',
    name: 'Gmail / 日历',
    description: 'Gmail 与 Google 日历集成（社区 gsuite MCP）。',
    category: 'productivity',
    tags: ['gmail', 'google', 'uvx'],
    note: '需按仓库说明完成 Google OAuth 配置。',
    config: {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-gsuite'],
    },
  },
  {
    id: 'google-maps',
    name: 'Google 地图',
    description: '地点、路线与地图详情查询。',
    category: 'productivity',
    tags: ['地图', 'npx'],
    requiresEnv: ['GOOGLE_MAPS_API_KEY'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-google-maps'],
      env: { GOOGLE_MAPS_API_KEY: '' },
    },
  },
  {
    id: 'youtube-transcript',
    name: 'YouTube 字幕',
    description: '获取 YouTube 字幕与文字稿供分析。',
    category: 'productivity',
    tags: ['youtube', 'npx'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@kimtaeyoon83/mcp-server-youtube-transcript'],
    },
  },

  // —— 国内常用 ——
  {
    id: 'antv-chart',
    name: 'AntV 图表',
    description: '基于 AntV 生成数据可视化图表。',
    category: 'china',
    tags: ['图表', 'npx', '国内'],
    homepage: 'https://github.com/antvis/mcp-server-chart',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@antv/mcp-server-chart'],
    },
  },
  {
    id: 'echarts',
    name: 'ECharts 图表',
    description: '动态生成 Apache ECharts 配置与图表。',
    category: 'china',
    tags: ['图表', 'npx', '国内'],
    homepage: 'https://github.com/hustcc/mcp-echarts',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-echarts'],
    },
  },
  {
    id: 'mermaid',
    name: 'Mermaid 图表',
    description: '生成 Mermaid 流程图/时序图等。',
    category: 'china',
    tags: ['图表', 'npx', '国内'],
    homepage: 'https://github.com/hustcc/mcp-mermaid',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-mermaid'],
    },
  },
  {
    id: 'bilibili',
    name: 'B 站搜索',
    description: '搜索 B 站内容的 MCP 服务。',
    category: 'china',
    tags: ['bilibili', 'npx', '国内'],
    homepage: 'https://github.com/34892002/bilibili-mcp-js',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'bilibili-mcp'],
    },
  },
  {
    id: 'feishu',
    name: '飞书文档',
    description: '飞书文档管理与 OAuth 集成（社区实现）。',
    category: 'china',
    tags: ['飞书', 'npx', '国内'],
    homepage: 'https://github.com/ztxtxwd/open-feishu-mcp-server',
    requiresEnv: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
    note: '需在飞书开放平台创建应用并填写凭证。',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'open-feishu-mcp-server'],
      env: {
        FEISHU_APP_ID: '',
        FEISHU_APP_SECRET: '',
      },
    },
  },
  {
    id: 'wecom-bot',
    name: '企业微信机器人',
    description: '向企业微信群机器人发送消息。',
    category: 'china',
    tags: ['企微', 'npx', '国内'],
    requiresEnv: ['WECOM_WEBHOOK_URL'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-server-wecombot'],
      env: { WECOM_WEBHOOK_URL: '' },
    },
  },
  {
    id: 'aliyun-ops',
    name: '阿里云运维',
    description: '运维管理阿里云 ECS、云监控等资源。',
    category: 'china',
    tags: ['阿里云', 'uvx', '国内'],
    homepage: 'https://github.com/aliyun/alibaba-cloud-ops-mcp-server',
    requiresEnv: ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
    note: '需要 uvx 与阿里云 AK/SK。',
    config: {
      transport: 'stdio',
      command: 'uvx',
      args: ['alibaba-cloud-ops-mcp-server'],
      env: {
        ALIBABA_CLOUD_ACCESS_KEY_ID: '',
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: '',
      },
    },
  },
  {
    id: 'qiniu',
    name: '七牛云',
    description: '七牛云存储与智能多媒体服务。',
    category: 'china',
    tags: ['七牛', 'uvx', '国内'],
    homepage: 'https://github.com/qiniu/qiniu-mcp-server',
    requiresEnv: ['QINIU_ACCESS_KEY', 'QINIU_SECRET_KEY'],
    config: {
      transport: 'stdio',
      command: 'uvx',
      args: ['qiniu-mcp-server'],
      env: {
        QINIU_ACCESS_KEY: '',
        QINIU_SECRET_KEY: '',
      },
    },
  },
  {
    id: 'leetcode',
    name: '力扣 / LeetCode',
    description: '获取题目、题解与进度，支持 leetcode.cn。',
    category: 'china',
    tags: ['力扣', 'npx', '国内'],
    homepage: 'https://github.com/jinzcdev/leetcode-mcp-server',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@jinzcdev/leetcode-mcp-server'],
    },
  },
  {
    id: 'baidu-map',
    name: '百度地图',
    description: '百度地图地点检索与路线规划（需开发者 Key）。',
    category: 'china',
    tags: ['地图', 'npx', '国内'],
    requiresEnv: ['BAIDU_MAP_API_KEY'],
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@baidumap/mcp-server-baidu-map'],
      env: { BAIDU_MAP_API_KEY: '' },
    },
  },
];

export function filterMcpMarketItems(
  items: McpMarketItem[],
  query: string,
  category: McpMarketCategoryId,
): McpMarketItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((item) => {
    if (category !== 'all' && item.category !== category) return false;
    if (!q) return true;
    const haystack = [
      item.id,
      item.name,
      item.description,
      item.note ?? '',
      item.tags.join(' '),
      item.config.command ?? '',
      ...(item.config.args ?? []),
      item.config.url ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

/** 目录项 → 可写入草稿的服务器配置（默认不启用，避免缺密钥/路径直接连失败） */
export function marketItemToServerConfig(item: McpMarketItem): McpServerConfig {
  const transport = item.config.transport || 'stdio';
  return {
    id: item.id,
    name: item.name,
    transport,
    command: item.config.command ?? '',
    args: [...(item.config.args ?? [])],
    env: { ...(item.config.env ?? {}) },
    cwd: null,
    url: item.config.url ?? '',
    headers: { ...(item.config.headers ?? {}) },
    enabled: false,
    disabled_tools: [],
  };
}

export function mcpMarketCategoryLabel(category: Exclude<McpMarketCategoryId, 'all'>): string {
  return MCP_MARKET_CATEGORIES.find((item) => item.id === category)?.label ?? category;
}
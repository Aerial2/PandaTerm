import { describe, expect, it } from 'vitest';
import {
  MCP_MARKET_CATALOG,
  filterMcpMarketItems,
  marketItemToServerConfig,
} from './mcpMarketplace';

describe('mcpMarketplace', () => {
  it('catalog has unique ids and chinese names', () => {
    const ids = MCP_MARKET_CATALOG.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of MCP_MARKET_CATALOG) {
      expect(item.name.trim().length).toBeGreaterThan(0);
      expect(item.description.trim().length).toBeGreaterThan(0);
      if (item.config.transport === 'stdio') {
        expect(item.config.command?.trim()).toBeTruthy();
      } else {
        expect(item.config.url?.trim()).toBeTruthy();
      }
    }
  });

  it('filters by category and query', () => {
    const official = filterMcpMarketItems(MCP_MARKET_CATALOG, '', 'official');
    expect(official.every((item) => item.category === 'official')).toBe(true);
    expect(official.length).toBeGreaterThan(0);

    const hit = filterMcpMarketItems(MCP_MARKET_CATALOG, 'playwright', 'all');
    expect(hit.some((item) => item.id.includes('playwright'))).toBe(true);

    const none = filterMcpMarketItems(MCP_MARKET_CATALOG, 'zzz-not-exist-mcp', 'all');
    expect(none).toEqual([]);
  });

  it('converts market item to disabled draft config', () => {
    const item = MCP_MARKET_CATALOG.find((entry) => entry.id === 'memory');
    expect(item).toBeTruthy();
    const config = marketItemToServerConfig(item!);
    expect(config).toMatchObject({
      id: 'memory',
      name: '知识图谱记忆',
      transport: 'stdio',
      command: 'npx',
      enabled: false,
    });
    expect(config.args).toContain('@modelcontextprotocol/server-memory');
  });
});
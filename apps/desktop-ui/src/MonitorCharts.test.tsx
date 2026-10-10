import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SystemMonitorData } from './api';
import { CapacityMonitorCharts, CpuMonitorCharts, NetworkMonitorCharts } from './MonitorCharts';
import type { MonitorSample } from './monitorHistory';

const data: SystemMonitorData = {
  hostname: 'test', os_name: 'Windows', os_version: '11', kernel_version: '', uptime_seconds: 100,
  cpu_count: 2, cpu_usage_percent: 32, cpu_core_usage_percent: [10, 54], cpu_model: 'Test CPU',
  load_avg_1min: 0, load_avg_5min: 0, load_avg_15min: 0, processes: 100,
  memory_total_bytes: 16000, memory_used_bytes: 8000, memory_available_bytes: 8000,
  disk_total_bytes: 100000, disk_used_bytes: 25000, disk_available_bytes: 75000,
  swap_total_bytes: 4000, swap_used_bytes: 1000, network_rx_bytes: 0, network_tx_bytes: 0,
};
const history: MonitorSample[] = [
  { timestamp: 0, cpu: 20, cores: [10, 30], download: 1000, upload: 2000, breakBefore: false },
  { timestamp: 60000, cpu: 32, cores: [10, 54], download: 2000, upload: 3000, breakBefore: false },
];
const formatBytes = (value: number) => `${value} B`;

// Interactive toggling and narrow-panel layout are also checked in the browser.
describe('monitor chart presentation', () => {
  it('defaults to one CPU chart with a clickable view instead of separate view selectors', () => {
    const html = renderToStaticMarkup(<CpuMonitorCharts data={data} history={history} />);
    expect(html.match(/class="monitor-line-chart"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="点击切换为多处理器视图"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('monitor-chart-view');
    expect(html).not.toContain('monitor-cpu-grid');
  });

  it('disables CPU switching when processor samples are unavailable', () => {
    const html = renderToStaticMarkup(<CpuMonitorCharts data={{ ...data, cpu_core_usage_percent: [] }} history={history} />);
    expect(html).toContain('disabled=""');
  });

  it('renders upload and download in a single SVG using separate line series', () => {
    const html = renderToStaticMarkup(<NetworkMonitorCharts history={history} />);
    expect(html.match(/class="monitor-line-chart"/g)).toHaveLength(1);
    expect(html.match(/class="monitor-chart-line"/g)).toHaveLength(2);
    expect(html).toContain('class="monitor-chart-series is-upload"');
    expect(html).not.toContain('class="monitor-chart-area"');
    expect(html).toContain('下载');
    expect(html).toContain('上传');
  });

  it('renders three capacity rings with used capacity in their centers', () => {
    const html = renderToStaticMarkup(<CapacityMonitorCharts data={data} formatBytes={formatBytes} />);
    expect(html.match(/class="monitor-capacity-item"/g)).toHaveLength(3);
    expect(html).toContain('<strong>8000 B</strong>');
    expect(html).toContain('<strong>25000 B</strong>');
    expect(html).toContain('<strong>1000 B</strong>');
    expect(html).toContain('stroke-dasharray="50 100"');
  });

  it('handles disabled swap and unavailable totals without invalid ring geometry', () => {
    const html = renderToStaticMarkup(<CapacityMonitorCharts data={{ ...data, swap_total_bytes: 0, memory_total_bytes: 0 }} formatBytes={formatBytes} />);
    expect(html).toContain('未启用');
    expect(html).toContain('暂无数据');
    expect(html).toContain('stroke-dasharray="0 100"');
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});
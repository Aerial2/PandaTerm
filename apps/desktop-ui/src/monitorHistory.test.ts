import { describe, expect, it } from 'vitest';
import type { SystemMonitorData } from './api';
import {
  appendMonitorSample,
  buildMonitorPaths,
  createMonitorSample,
  formatNetworkRate,
  networkChartMaximum,
  type MonitorSample,
} from './monitorHistory';

const data = {
  cpu_usage_percent: 32,
  cpu_core_usage_percent: [10, 54],
  network_rx_bytes: 6000,
  network_tx_bytes: 3000,
} as SystemMonitorData;
const baseline = { timestamp: 1000, received: 1000, transmitted: 1000 };
const sample = (timestamp: number): MonitorSample => createMonitorSample(data, timestamp, null);

describe('monitor history', () => {
  it('includes the full 60 second window, including its left boundary', () => {
    const result = appendMonitorSample([sample(999), sample(1000), sample(31_000)], sample(61_000));
    expect(result.map((point) => point.timestamp)).toEqual([1000, 31_000, 61_000]);
  });

  it('uses actual elapsed time rather than assuming a one second poll', () => {
    const result = createMonitorSample(data, 3500, baseline);
    expect(result.download).toBe(2000);
    expect(result.upload).toBe(800);
    expect(result.breakBefore).toBe(false);
  });

  it('waits for a second sample and does not treat cumulative traffic as speed', () => {
    const result = createMonitorSample(data, 1000, null);
    expect(result.download).toBeNull();
    expect(result.upload).toBeNull();
  });

  it('resets rates after a polling gap or counter reset', () => {
    expect(createMonitorSample(data, 7000, baseline).download).toBeNull();
    expect(createMonitorSample({ ...data, network_rx_bytes: 10 }, 2000, baseline).download).toBeNull();
    expect(createMonitorSample(data, 1000, baseline).upload).toBeNull();
  });

  it('clamps invalid CPU values and supports older responses without core data', () => {
    const result = createMonitorSample({ ...data, cpu_usage_percent: 120, cpu_core_usage_percent: [-10, NaN, 150] }, 2000, baseline);
    expect(result.cpu).toBe(100);
    expect(result.cores).toEqual([0, 0, 100]);
    expect(createMonitorSample({ ...data, cpu_core_usage_percent: undefined }, 2000, baseline).cores).toEqual([]);
  });

  it('right aligns initial data instead of stretching it across the minute', () => {
    const paths = buildMonitorPaths([{ timestamp: 60_000, value: 50 }], 60_000, 100);
    expect(paths[0].line).toBe('M600.00,50.00');
    expect(paths[0].dot).toEqual({ x: 600, y: 50 });
  });

  it('maps an inclusive 60 second interval from left to right with fixed CPU scale', () => {
    const paths = buildMonitorPaths([{ timestamp: 0, value: 0 }, { timestamp: 60_000, value: 100 }], 60_000, 100);
    expect(paths[0].line).toBe('M0.00,100.00 L600.00,0.00');
  });

  it('does not draw across missing samples or a resumed session', () => {
    const paths = buildMonitorPaths([
      { timestamp: 1000, value: 20 },
      { timestamp: 2000, value: null },
      { timestamp: 3000, value: 30 },
      { timestamp: 4000, value: 40, breakBefore: true },
    ], 4000, 100);
    expect(paths).toHaveLength(3);
  });

  it('scales both network directions above the visible peak', () => {
    const history = [{ ...sample(1000), download: 1000, upload: 500_000 }];
    expect(networkChartMaximum(history)).toBeGreaterThan(500_000);
    expect(networkChartMaximum([])).toBeGreaterThanOrEqual(1024);
  });

  it('formats waiting, idle and active network speed', () => {
    expect(formatNetworkRate(null)).toBe('等待采样');
    expect(formatNetworkRate(0)).toBe('0 B/s');
    expect(formatNetworkRate(1024)).toBe('1.0 KB/s');
    expect(formatNetworkRate(1024 * 1024)).toBe('1.0 MB/s');
  });
});
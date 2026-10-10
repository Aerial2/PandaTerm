import type { SystemMonitorData } from './api';

export const MONITOR_WINDOW_MS = 60_000;
export const MONITOR_GAP_MS = 5_000;

export interface MonitorSample {
  timestamp: number;
  cpu: number;
  cores: number[];
  download: number | null;
  upload: number | null;
  // A resumed poll starts a new segment instead of drawing across missing data.
  breakBefore: boolean;
}

export interface NetworkBaseline {
  timestamp: number;
  received: number;
  transmitted: number;
}

export function clampCpu(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function createMonitorSample(
  data: SystemMonitorData,
  timestamp: number,
  previous: NetworkBaseline | null,
): MonitorSample {
  const elapsed = previous ? timestamp - previous.timestamp : 0;
  const validInterval = previous !== null && elapsed > 0 && elapsed <= MONITOR_GAP_MS;
  const rate = (current: number, before: number): number | null => {
    if (!validInterval || !Number.isFinite(current) || !Number.isFinite(before) || current < before) return null;
    return (current - before) * 1000 / elapsed;
  };
  return {
    timestamp,
    cpu: clampCpu(data.cpu_usage_percent),
    cores: (data.cpu_core_usage_percent ?? []).map(clampCpu),
    download: rate(data.network_rx_bytes, previous?.received ?? 0),
    upload: rate(data.network_tx_bytes, previous?.transmitted ?? 0),
    breakBefore: !validInterval,
  };
}

export function appendMonitorSample(history: MonitorSample[], sample: MonitorSample): MonitorSample[] {
  // Inclusive cutoff: a point exactly 60 seconds old remains on the left edge.
  return [...history.filter((point) => point.timestamp >= sample.timestamp - MONITOR_WINDOW_MS
    && point.timestamp < sample.timestamp), sample];
}

export interface ChartPoint {
  timestamp: number;
  value: number | null;
  breakBefore?: boolean;
}

export function buildMonitorPaths(points: ChartPoint[], now: number, maximum: number) {
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let segment: Array<{ x: number; y: number }> = [];
  const flush = () => {
    if (segment.length) segments.push(segment);
    segment = [];
  };
  for (const point of points) {
    if (point.timestamp < now - MONITOR_WINDOW_MS || point.timestamp > now) continue;
    if (point.breakBefore) flush();
    if (point.value === null || !Number.isFinite(point.value)) {
      flush();
      continue;
    }
    const x = (point.timestamp - (now - MONITOR_WINDOW_MS)) / MONITOR_WINDOW_MS * 600;
    const y = 100 - Math.max(0, Math.min(maximum, point.value)) / Math.max(1, maximum) * 100;
    segment.push({ x, y });
  }
  flush();
  return segments.map((part) => {
    const first = part[0];
    const last = part[part.length - 1];
    const line = part.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
    return {
      line,
      area: `${line} L${last.x.toFixed(2)},100 L${first.x.toFixed(2)},100 Z`,
      dot: part.length === 1 ? first : null,
    };
  });
}

export function networkChartMaximum(history: MonitorSample[]): number {
  const peak = history.reduce((value, point) => Math.max(value, point.download ?? 0, point.upload ?? 0), 0);
  const target = Math.max(1024, peak * 1.1);
  const magnitude = 1024 ** Math.min(3, Math.floor(Math.log(target) / Math.log(1024)));
  const step = 10 ** Math.floor(Math.log10(target / magnitude));
  return Math.ceil(target / magnitude / step) * step * magnitude;
}

export function formatNetworkRate(value: number | null): string {
  if (value === null) return '等待采样';
  const safe = Math.max(0, Number.isFinite(value) ? value : 0);
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const index = safe > 0 ? Math.max(0, Math.min(units.length - 1, Math.floor(Math.log(safe) / Math.log(1024)))) : 0;
  return `${(safe / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
import { memo, useState } from 'react';
import { ArrowDown, ArrowUp, Cpu, Network } from 'lucide-react';
import type { SystemMonitorData } from './api';
import {
  buildMonitorPaths,
  clampCpu,
  formatNetworkRate,
  networkChartMaximum,
  type ChartPoint,
  type MonitorSample,
} from './monitorHistory';

interface ChartSeries {
  points: ChartPoint[];
  upload?: boolean;
}

const MonitorLineChart = memo(function MonitorLineChart({
  series, now, maximum, label, compact = false, linesOnly = false,
}: {
  series: ChartSeries[];
  now: number;
  maximum: number;
  label: string;
  compact?: boolean;
  linesOnly?: boolean;
}) {
  return (
    <svg
      className={`monitor-line-chart${compact ? ' is-compact' : ''}`}
      viewBox="0 0 600 100"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <g className="monitor-chart-grid" shapeRendering="crispEdges">
        {Array.from({ length: 11 }, (_, index) => <line key={`x${index}`} x1={(index + 1) * 50} y1="0" x2={(index + 1) * 50} y2="100" />)}
        {Array.from({ length: 9 }, (_, index) => <line key={`y${index}`} x1="0" y1={(index + 1) * 10} x2="600" y2={(index + 1) * 10} />)}
      </g>
      {series.map(({ points, upload }, seriesIndex) => (
        <g key={seriesIndex} className={upload ? 'monitor-chart-series is-upload' : 'monitor-chart-series'}>
          {buildMonitorPaths(points, now, maximum).map((path, index) => (
            <g key={index}>
              {!linesOnly && <path className="monitor-chart-area" d={path.area} />}
              <path className="monitor-chart-line" d={path.line} vectorEffect="non-scaling-stroke" />
              {path.dot && <line className="monitor-chart-line" x1={Math.max(0, path.dot.x - 1)} x2={path.dot.x} y1={path.dot.y} y2={path.dot.y} vectorEffect="non-scaling-stroke" />}
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
});

function TimeAxis() {
  return <div className="monitor-chart-axis"><span>60 秒</span><span>0</span></div>;
}

export function CpuMonitorCharts({ data, history }: { data: SystemMonitorData; history: MonitorSample[] }) {
  const [showProcessors, setShowProcessors] = useState(false);
  const cores = data.cpu_core_usage_percent ?? [];
  const showCores = showProcessors && cores.length > 0;
  const now = history[history.length - 1]?.timestamp ?? 0;
  const toggleLabel = showCores ? '点击切换为 CPU 总占用图' : '点击切换为多处理器视图';
  return (
    <div className="monitor-section">
      <div className="monitor-section-header">
        <Cpu size={14} /><span>CPU</span>
        <span className="monitor-value">{clampCpu(data.cpu_usage_percent).toFixed(1)}%</span>
      </div>
      <div className="monitor-chart-axis"><span>60 秒内的利用率 %</span><span>100%</span></div>
      <button
        type="button"
        className="monitor-cpu-toggle"
        aria-label={toggleLabel}
        aria-pressed={showCores}
        title={cores.length > 0 ? toggleLabel : '当前未提供处理器数据'}
        disabled={cores.length === 0}
        onClick={() => setShowProcessors((previous) => !previous)}
      >
        {showCores ? (
          <span className="monitor-cpu-grid">
            {cores.map((usage, index) => (
              <span className="monitor-cpu-cell" key={index} title={`CPU ${index} · ${clampCpu(usage).toFixed(1)}% · ${toggleLabel}`}>
                <MonitorLineChart
                  compact
                  series={[{ points: history.map((sample) => ({ timestamp: sample.timestamp, value: sample.cores[index] ?? null, breakBefore: sample.breakBefore })) }]}
                  now={now} maximum={100} label={`CPU ${index}：${clampCpu(usage).toFixed(1)}%，最近 60 秒`}
                />
                <span className="monitor-cpu-label">CPU {index}</span>
              </span>
            ))}
          </span>
        ) : (
          <MonitorLineChart series={[{ points: history.map((sample) => ({ timestamp: sample.timestamp, value: sample.cpu, breakBefore: sample.breakBefore })) }]} now={now} maximum={100} label="CPU 总占用率，最近 60 秒" />
        )}
      </button>
      <TimeAxis />
      <div className="monitor-detail" title={data.cpu_model}>{data.cpu_model}</div>
      <div className="monitor-detail">{data.cpu_count} 个逻辑处理器 · 负载 {data.load_avg_1min.toFixed(2)} / {data.load_avg_5min.toFixed(2)} / {data.load_avg_15min.toFixed(2)}</div>
    </div>
  );
}

export function NetworkMonitorCharts({ history }: { history: MonitorSample[] }) {
  const latest = history[history.length - 1];
  const now = latest?.timestamp ?? 0;
  const maximum = networkChartMaximum(history);
  return (
    <div className="monitor-section">
      <div className="monitor-section-header"><Network size={14} /><span>网络</span></div>
      <div className="monitor-network-chart">
        <div className="monitor-network-legend">
          {(['download', 'upload'] as const).map((direction) => (
            <div className={`monitor-network-header${direction === 'upload' ? ' is-upload' : ''}`} key={direction}>
              <span className="monitor-network-swatch" aria-hidden="true" />
              {direction === 'upload' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
              <span>{direction === 'upload' ? '上传' : '下载'}</span>
              <strong>{formatNetworkRate(latest?.[direction] ?? null)}</strong>
            </div>
          ))}
        </div>
        <div className="monitor-chart-axis"><span>最近 60 秒</span><span>{formatNetworkRate(maximum)}</span></div>
        <MonitorLineChart
          series={(['download', 'upload'] as const).map((direction) => ({
            points: history.map((sample) => ({ timestamp: sample.timestamp, value: sample[direction], breakBefore: sample.breakBefore })),
            upload: direction === 'upload',
          }))}
          now={now} maximum={maximum} label="网络下载（蓝色实线）和上传（紫色虚线）速率，最近 60 秒" linesOnly
        />
        <TimeAxis />
      </div>
    </div>
  );
}

export function CapacityMonitorCharts({ data, formatBytes }: {
  data: SystemMonitorData;
  formatBytes: (bytes: number) => string;
}) {
  const resources = [
    { label: '内存', used: data.memory_used_bytes, total: data.memory_total_bytes, available: data.memory_available_bytes },
    { label: '硬盘', used: data.disk_used_bytes, total: data.disk_total_bytes, available: data.disk_available_bytes },
    { label: '交换空间', used: data.swap_used_bytes, total: data.swap_total_bytes, available: Math.max(0, data.swap_total_bytes - data.swap_used_bytes) },
  ];
  return (
    <div className="monitor-capacity-row">
      {resources.map(({ label, used, total, available }) => {
        const percent = total > 0 ? clampCpu(used / total * 100) : 0;
        const color = percent > 80 ? '#e06c75' : percent > 60 ? '#d19a66' : '#98c379';
        const description = total > 0
          ? `${label}：已用 ${formatBytes(used)}，总容量 ${formatBytes(total)}，可用 ${formatBytes(available)}，使用率 ${percent.toFixed(1)}%`
          : `${label}：${label === '交换空间' ? '未启用' : '暂无容量数据'}`;
        return (
          <div className="monitor-capacity-item" key={label} title={description}>
            <div className="monitor-capacity-label">{label}</div>
            <div className="monitor-capacity-ring" role="img" aria-label={description}>
              <svg viewBox="0 0 100 100" aria-hidden="true">
                <circle className="monitor-capacity-track" cx="50" cy="50" r="43" />
                <circle className="monitor-capacity-progress" cx="50" cy="50" r="43" pathLength="100" stroke={color} strokeDasharray={`${percent} 100`} transform="rotate(-90 50 50)" />
              </svg>
              <div className="monitor-capacity-center">
                <strong>{formatBytes(total > 0 ? used : 0)}</strong>
                <span>已用</span>
              </div>
            </div>
            <div className="monitor-capacity-total">{total > 0 ? `共 ${formatBytes(total)}` : label === '交换空间' ? '未启用' : '暂无数据'}</div>
          </div>
        );
      })}
    </div>
  );
}
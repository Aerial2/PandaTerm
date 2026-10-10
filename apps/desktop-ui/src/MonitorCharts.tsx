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

const MonitorLineChart = memo(function MonitorLineChart({
  points, now, maximum, label, compact = false, upload = false,
}: {
  points: ChartPoint[];
  now: number;
  maximum: number;
  label: string;
  compact?: boolean;
  upload?: boolean;
}) {
  const paths = buildMonitorPaths(points, now, maximum);
  return (
    <svg
      className={`monitor-line-chart${compact ? ' is-compact' : ''}${upload ? ' is-upload' : ''}`}
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
      {paths.map((path, index) => (
        <g key={index}>
          <path className="monitor-chart-area" d={path.area} />
          <path className="monitor-chart-line" d={path.line} vectorEffect="non-scaling-stroke" />
          {path.dot && <line className="monitor-chart-line" x1={Math.max(0, path.dot.x - 1)} x2={path.dot.x} y1={path.dot.y} y2={path.dot.y} vectorEffect="non-scaling-stroke" />}
        </g>
      ))}
    </svg>
  );
});

function TimeAxis() {
  return <div className="monitor-chart-axis"><span>60 秒</span><span>0</span></div>;
}

export function CpuMonitorCharts({ data, history }: { data: SystemMonitorData; history: MonitorSample[] }) {
  const [view, setView] = useState<'total' | 'cores'>('cores');
  const cores = data.cpu_core_usage_percent ?? [];
  const showCores = view === 'cores' && cores.length > 0;
  const now = history[history.length - 1]?.timestamp ?? 0;
  return (
    <div className="monitor-section">
      <div className="monitor-section-header">
        <Cpu size={14} /><span>CPU</span>
        <span className="monitor-value">{clampCpu(data.cpu_usage_percent).toFixed(1)}%</span>
      </div>
      {cores.length > 0 && (
        <div className="monitor-chart-view" role="group" aria-label="CPU 图表视图">
          <button type="button" aria-pressed={view === 'total'} onClick={() => setView('total')}>总体</button>
          <button type="button" aria-pressed={view === 'cores'} onClick={() => setView('cores')}>逻辑处理器</button>
        </div>
      )}
      <div className="monitor-chart-axis"><span>60 秒内的利用率 %</span><span>100%</span></div>
      {showCores ? (
        <div className="monitor-cpu-grid">
          {cores.map((usage, index) => (
            <div className="monitor-cpu-cell" key={index} title={`CPU ${index} · ${clampCpu(usage).toFixed(1)}%`}>
              <MonitorLineChart
                compact
                points={history.map((sample) => ({ timestamp: sample.timestamp, value: sample.cores[index] ?? null, breakBefore: sample.breakBefore }))}
                now={now} maximum={100} label={`CPU ${index}：${clampCpu(usage).toFixed(1)}%，最近 60 秒`}
              />
              <span className="monitor-cpu-label">CPU {index}</span>
            </div>
          ))}
        </div>
      ) : (
        <MonitorLineChart points={history.map((sample) => ({ timestamp: sample.timestamp, value: sample.cpu, breakBefore: sample.breakBefore }))} now={now} maximum={100} label="CPU 总体利用率，最近 60 秒" />
      )}
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
      {(['download', 'upload'] as const).map((direction) => {
        const upload = direction === 'upload';
        const label = upload ? '上传' : '下载';
        return (
          <div className={`monitor-network-chart${upload ? ' is-upload' : ''}`} key={direction}>
            <div className="monitor-network-header">
              {upload ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
              <span>{label}</span><strong>{formatNetworkRate(latest?.[direction] ?? null)}</strong>
            </div>
            <div className="monitor-chart-axis"><span>最近 60 秒</span><span>{formatNetworkRate(maximum)}</span></div>
            <MonitorLineChart points={history.map((sample) => ({ timestamp: sample.timestamp, value: sample[direction], breakBefore: sample.breakBefore }))} now={now} maximum={maximum} label={`网络${label}速率，最近 60 秒`} upload={upload} />
            <TimeAxis />
          </div>
        );
      })}
    </div>
  );
}
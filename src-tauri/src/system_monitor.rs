//! 系统监控领域：纯数据结构、远程采集命令常量与解析、本地 sysinfo 采集。
//! SSH 编排与错误提示留在 main.rs 的薄命令层，本模块零 SSH 依赖。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// System monitor data structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMonitorData {
    hostname: String,
    os_name: String,
    os_version: String,
    kernel_version: String,
    uptime_seconds: u64,
    cpu_count: u32,
    cpu_usage_percent: f64,
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    memory_available_bytes: u64,
    swap_total_bytes: u64,
    swap_used_bytes: u64,
    disk_total_bytes: u64,
    disk_used_bytes: u64,
    disk_available_bytes: u64,
    load_avg_1min: f64,
    load_avg_5min: f64,
    load_avg_15min: f64,
    cpu_model: String,
    network_rx_bytes: u64,
    network_tx_bytes: u64,
    processes: u32,
}

/// Single process info for the process-list panel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pid: u32,
    name: String,
    status: String,
    cpu_usage_percent: f64,
    memory_bytes: u64,
    disk_bytes_per_sec: f64,
    network_bytes_per_sec: f64,
    /// 该进程占用的 TCP 端口（逗号分隔）。采集不到时为空字符串，前端显示为 “-”。
    ports: String,
}

// 进程列表 + 端口映射：先尽力从 ss/netstat 取 “PID→端口”，再随 ps 结果一起输出。
// 端口采集失败（无 ss/netstat、或非 root 看不到 pid）时映射为空，端口列留空，
// 不影响进程本身的输出格式。
pub const PROCESS_LIST_CMD: &str = r#"nproc=$(nproc 2>/dev/null||echo 1);mem_total=$(awk "/^MemTotal/{print \$2*1024}" /proc/meminfo 2>/dev/null||echo 0);portmap=$( (ss -H -tunlp 2>/dev/null || netstat -tunlp 2>/dev/null) | awk '{pid="";port="";for(i=1;i<=NF;i++){if($i ~ /pid=[0-9]+/){p=$i;sub(/.*pid=/,"",p);sub(/[^0-9].*$/,"",p);pid=p};if(pid=="" && $i ~ /^[0-9]+\/[A-Za-z_]/){p=$i;sub(/\/.*$/,"",p);if(p ~ /^[0-9]+$/)pid=p};if(port=="" && $i ~ /:[0-9]+$/){a=$i;sub(/.*:/,"",a);if(a ~ /^[0-9]+$/ && a+0>0)port=a}};if(pid!="" && port!="" && !((pid SUBSEP port) in seen)){seen[pid,port]=1;m[pid]=(pid in m)?m[pid] "," port:port}}END{for(p in m)printf "%s\t%s\n",p,m[p]}');ps -eo pid=,pcpu=,pmem=,stat=,args= --sort=-pcpu 2>/dev/null | head -50 | awk -v nc="$nproc" -v mt="$mem_total" -v pm="$portmap" 'BEGIN{OFS="\t";n=split(pm,lines,"\n");for(i=1;i<=n;i++){if(lines[i]!=""){split(lines[i],kv,"\t");ports[kv[1]]=kv[2]}}}{pid=$1;cpu=$2;mem=$3;stat=substr($4,1,1);cmd=$5;for(i=6;i<=NF;i++)cmd=cmd FS $i;if(length(cmd)>30)cmd=substr(cmd,1,30);printf "P\t%d\t%s\t%s\t%.1f\t%d\t0\t%s\n",pid,cmd,stat,cpu/nc,int(mem*mt/100),(pid in ports?ports[pid]:"")}' && echo END_PROCESS_LIST"#;

pub const SYSTEM_MONITOR_CMD: &str = r#"
HOSTNAME=$(hostname 2>/dev/null || echo unknown)
OS_NAME=$(cat /etc/os-release 2>/dev/null | grep '^NAME=' | head -1 | sed 's/NAME="//;s/"$//' || echo Linux)
OS_VER=$(cat /etc/os-release 2>/dev/null | grep '^VERSION=' | head -1 | sed 's/VERSION="//;s/"$//' || echo unknown)
KERNEL=$(uname -r 2>/dev/null || echo unknown)
UPTIME=$(cat /proc/uptime 2>/dev/null | awk '{print int($1)}' || echo 0)
CPU_COUNT=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)
CPU_MODEL=$(grep '^model name' /proc/cpuinfo 2>/dev/null | head -1 | sed 's/model name.*: //' || echo unknown)

# CPU usage: sample over 1 second
# Use a single awk read per sample point to avoid inconsistent timestamps.
# idle = $5 (idle) + $6 (iowait); total = sum of all numeric columns.
CPU_SAMPLE1=$(awk '/^cpu /{idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print idle" "total}' /proc/stat)
sleep 1
CPU_SAMPLE2=$(awk '/^cpu /{idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print idle" "total}' /proc/stat)
CPU_IDLE1=$(echo "$CPU_SAMPLE1" | awk '{print $1}')
CPU_TOTAL1=$(echo "$CPU_SAMPLE1" | awk '{print $2}')
CPU_IDLE2=$(echo "$CPU_SAMPLE2" | awk '{print $1}')
CPU_TOTAL2=$(echo "$CPU_SAMPLE2" | awk '{print $2}')
DIFF_TOTAL=$((CPU_TOTAL2 - CPU_TOTAL1))
DIFF_IDLE=$((CPU_IDLE2 - CPU_IDLE1))
if [ "$DIFF_TOTAL" -gt 0 ]; then
  CPU_USAGE=$(awk "BEGIN {printf \"%.1f\", (1 - $DIFF_IDLE/$DIFF_TOTAL)*100}")
else
  CPU_USAGE="0.0"
fi

# Memory
MEM_TOTAL=$(awk '/^MemTotal/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
MEM_AVAILABLE=$(awk '/^MemAvailable/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
MEM_USED=$((MEM_TOTAL - MEM_AVAILABLE))

# Swap
SWAP_TOTAL=$(awk '/^SwapTotal/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
SWAP_FREE=$(awk '/^SwapFree/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
SWAP_USED=$((SWAP_TOTAL - SWAP_FREE))

# Disk (root partition)
DISK_TOTAL=$(df --output=size -B1 / 2>/dev/null | tail -1 | tr -d ' ' || echo 0)
DISK_USED=$(df --output=used -B1 / 2>/dev/null | tail -1 | tr -d ' ' || echo 0)
DISK_AVAIL=$(df --output=avail -B1 / 2>/dev/null | tail -1 | tr -d ' ' || echo 0)

# Load average
LOAD=$(cat /proc/loadavg 2>/dev/null || echo "0 0 0")
LOAD1=$(echo "$LOAD" | awk '{print $1}')
LOAD5=$(echo "$LOAD" | awk '{print $2}')
LOAD15=$(echo "$LOAD" | awk '{print $3}')

# Network (first non-lo interface)
NET_IF=$(ls /sys/class/net/ 2>/dev/null | grep -v lo | head -1 || echo eth0)
NET_RX=$(cat /sys/class/net/$NET_IF/statistics/rx_bytes 2>/dev/null || echo 0)
NET_TX=$(cat /sys/class/net/$NET_IF/statistics/tx_bytes 2>/dev/null || echo 0)

# Process count
PROCS=$(ps aux 2>/dev/null | wc -l || echo 0)

echo "MONITOR_RESULT"
echo "hostname=$HOSTNAME"
echo "os_name=$OS_NAME"
echo "os_version=$OS_VER"
echo "kernel=$KERNEL"
echo "uptime=$UPTIME"
echo "cpu_count=$CPU_COUNT"
echo "cpu_usage=$CPU_USAGE"
echo "cpu_model=$CPU_MODEL"
echo "mem_total=$MEM_TOTAL"
echo "mem_available=$MEM_AVAILABLE"
echo "mem_used=$MEM_USED"
echo "swap_total=$SWAP_TOTAL"
echo "swap_used=$SWAP_USED"
echo "disk_total=$DISK_TOTAL"
echo "disk_used=$DISK_USED"
echo "disk_avail=$DISK_AVAIL"
echo "load1=$LOAD1"
echo "load5=$LOAD5"
echo "load15=$LOAD15"
echo "net_rx=$NET_RX"
echo "net_tx=$NET_TX"
echo "procs=$PROCS"
"#;

pub fn parse_process_list(output: &str) -> Vec<ProcessInfo> {
    let mut processes = Vec::new();
    for line in output.lines() {
        if line == "END_PROCESS_LIST" { break; }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 7 || parts[0] != "P" { continue; }
        let pid = parts[1].parse::<u32>().ok().unwrap_or(0);
        let name = parts[2].to_string();
        let status = parts[3].to_string();
        let cpu = parts[4].parse::<f64>().ok().unwrap_or(0.0);
        let mem_bytes = parts[5].parse::<u64>().ok().unwrap_or(0);
        // 第 8 列是端口（可选）：旧服务器/无权限时缺失，留空即可
        let ports = parts.get(7).map(|value| value.to_string()).unwrap_or_default();

        processes.push(ProcessInfo {
            pid,
            name,
            status,
            cpu_usage_percent: cpu.clamp(0.0, 100.0),
            memory_bytes: mem_bytes,
            disk_bytes_per_sec: 0.0,
            network_bytes_per_sec: 0.0,
            ports,
        });
    }
    processes
}

pub fn parse_system_monitor(output: &str) -> SystemMonitorData {
    let mut lines = output.lines().peekable();

    // Find the MONITOR_RESULT marker
    for line in lines.by_ref() {
        if line.trim() == "MONITOR_RESULT" { break; }
    }

    let mut values: HashMap<String, String> = HashMap::new();
    for line in lines {
        if let Some((key, val)) = line.split_once('=') {
            values.insert(key.trim().to_string(), val.trim().to_string());
        }
    }

    SystemMonitorData {
        hostname: values.get("hostname").cloned().unwrap_or_default(),
        os_name: values.get("os_name").cloned().unwrap_or_default(),
        os_version: values.get("os_version").cloned().unwrap_or_default(),
        kernel_version: values.get("kernel").cloned().unwrap_or_default(),
        uptime_seconds: values.get("uptime").and_then(|v| v.parse().ok()).unwrap_or(0),
        cpu_count: values.get("cpu_count").and_then(|v| v.parse().ok()).unwrap_or(1),
        cpu_usage_percent: values.get("cpu_usage").and_then(|v| v.parse::<f64>().ok()).map(|v| v.clamp(0.0, 100.0)).unwrap_or(0.0),
        memory_total_bytes: values.get("mem_total").and_then(|v| v.parse().ok()).unwrap_or(0),
        memory_used_bytes: values.get("mem_used").and_then(|v| v.parse().ok()).unwrap_or(0),
        memory_available_bytes: values.get("mem_available").and_then(|v| v.parse().ok()).unwrap_or(0),
        swap_total_bytes: values.get("swap_total").and_then(|v| v.parse().ok()).unwrap_or(0),
        swap_used_bytes: values.get("swap_used").and_then(|v| v.parse().ok()).unwrap_or(0),
        disk_total_bytes: values.get("disk_total").and_then(|v| v.parse().ok()).unwrap_or(0),
        disk_used_bytes: values.get("disk_used").and_then(|v| v.parse().ok()).unwrap_or(0),
        disk_available_bytes: values.get("disk_avail").and_then(|v| v.parse().ok()).unwrap_or(0),
        load_avg_1min: values.get("load1").and_then(|v| v.parse().ok()).unwrap_or(0.0),
        load_avg_5min: values.get("load5").and_then(|v| v.parse().ok()).unwrap_or(0.0),
        load_avg_15min: values.get("load15").and_then(|v| v.parse().ok()).unwrap_or(0.0),
        cpu_model: values.get("cpu_model").cloned().unwrap_or_default(),
        network_rx_bytes: values.get("net_rx").and_then(|v| v.parse().ok()).unwrap_or(0),
        network_tx_bytes: values.get("net_tx").and_then(|v| v.parse().ok()).unwrap_or(0),
        processes: values.get("procs").and_then(|v| v.parse().ok()).unwrap_or(0),
    }
}

/// 尽力采集「PID → TCP 端口列表」映射：Windows 走 `netstat -ano`，其它走 ss/netstat。
/// 采集失败或无权限时返回空表，端口列留空（前端显示 “-”），不影响进程列表本身。
fn collect_local_pid_ports() -> std::collections::HashMap<u32, String> {
    use std::collections::{HashMap, HashSet};
    use std::process::Command;

    let output = if cfg!(windows) {
        Command::new("netstat").args(["-ano", "-p", "tcp"]).output()
    } else {
        Command::new("sh")
            .arg("-c")
            .arg("ss -H -tunlp 2>/dev/null || netstat -tunlp 2>/dev/null")
            .output()
    };
    let Ok(out) = output else {
        return HashMap::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);

    let mut by_pid: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut seen: HashSet<(u32, u32)> = HashSet::new();

    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 {
            continue;
        }
        let mut pid: Option<u32> = None;
        let mut port: Option<u32> = None;
        for field in &fields {
            // 端口：0.0.0.0:22 / [::]:22 / *:22 —— 取最后一个冒号后的数字
            if port.is_none() {
                if let Some(idx) = field.rfind(':') {
                    let tail = &field[idx + 1..];
                    if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
                        if let Ok(value) = tail.parse::<u32>() {
                            if value > 0 {
                                port = Some(value);
                            }
                        }
                    }
                }
            }
            // PID：ss 的 users:(("sshd",pid=1234,fd=3))
            if pid.is_none() && field.contains("pid=") {
                let digits: String = field
                    .split("pid=")
                    .nth(1)
                    .unwrap_or("")
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(value) = digits.parse::<u32>() {
                    pid = Some(value);
                }
            }
            // PID：netstat(Linux) 的 1234/sshd
            if pid.is_none() && field.contains('/') {
                let head = field.split('/').next().unwrap_or("");
                if !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()) {
                    if let Ok(value) = head.parse::<u32>() {
                        pid = Some(value);
                    }
                }
            }
        }
        // Windows：netstat -ano 的 PID 是最后一列的纯数字
        if pid.is_none() {
            if let Some(last) = fields.last() {
                if !last.is_empty() && last.chars().all(|c| c.is_ascii_digit()) {
                    if let Ok(value) = last.parse::<u32>() {
                        pid = Some(value);
                    }
                }
            }
        }

        if let (Some(pid), Some(port)) = (pid, port) {
            if seen.insert((pid, port)) {
                by_pid.entry(pid).or_default().push(port);
            }
        }
    }

    by_pid
        .into_iter()
        .map(|(pid, mut ports)| {
            ports.sort_unstable();
            let joined = ports
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
                .join(",");
            (pid, joined)
        })
        .collect()
}

pub fn collect_local_processes(slot: &mut Option<sysinfo::System>) -> Vec<ProcessInfo> {
    use sysinfo::{ProcessesToUpdate, ProcessRefreshKind};

    let sys = match slot.as_mut() {
        Some(s) => s,
        None => {
            // 兜底：正常路径由 main.rs 的 ensure_local_sys_monitor 预先播种
            // （不持锁等待）。此处仅处理极端竞态，做两次连续刷新即可，不再睡眠。
            use sysinfo::{System, CpuRefreshKind, RefreshKind};
            let mut s = System::new_with_specifics(
                RefreshKind::nothing().with_cpu(CpuRefreshKind::everything()),
            );
            s.refresh_cpu_usage();
            s.refresh_cpu_usage();
            *slot = Some(s);
            slot.as_mut().unwrap()
        }
    };

    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );

    // sysinfo::Process::cpu_usage() returns % of a *single core* (0-100 per core),
    // so on a multi-core machine values can exceed 100 and sum to >100 across all
    // processes.  Divide by CPU count to get % of *total* CPU, matching what users
    // expect from Task Manager / top.
    let cpu_count = sys.cpus().len() as f64;
    // 端口映射：尽力而为，失败时为空表，端口列留空
    let port_map = collect_local_pid_ports();

    let processes: Vec<ProcessInfo> = sys.processes()
        .values()
        .filter(|p| p.cpu_usage() > 0.01 || p.memory() > 1024 * 1024)
        .map(|p| ProcessInfo {
            pid: p.pid().as_u32(),
            name: p.name().to_string_lossy().to_string(),
            status: {
                let s = p.status();
                match s {
                    sysinfo::ProcessStatus::Run => "Running".to_string(),
                    sysinfo::ProcessStatus::Sleep => "Sleeping".to_string(),
                    sysinfo::ProcessStatus::Idle => "Idle".to_string(),
                    sysinfo::ProcessStatus::Zombie => "Zombie".to_string(),
                    sysinfo::ProcessStatus::Stop => "Stopped".to_string(),
                    _ => "Unknown".to_string(),
                }
            },
            cpu_usage_percent: (p.cpu_usage() as f64 / cpu_count).clamp(0.0, 100.0),
            memory_bytes: p.memory(),
            disk_bytes_per_sec: 0.0,
            network_bytes_per_sec: 0.0,
            ports: port_map.get(&p.pid().as_u32()).cloned().unwrap_or_default(),
        })
        .collect();

    // Sort by CPU usage descending, then memory descending
    let mut sorted = processes;
    sorted.sort_by(|a, b| {
        b.cpu_usage_percent
            .partial_cmp(&a.cpu_usage_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.memory_bytes.cmp(&a.memory_bytes))
    });
    // Keep top 50
    sorted.truncate(50);
    sorted
}

pub fn collect_local_monitor(slot: &mut Option<sysinfo::System>) -> SystemMonitorData {
    use sysinfo::{System, Networks, Disks, CpuRefreshKind, RefreshKind};

    let sys = match slot.as_mut() {
        Some(s) => {
            // Subsequent call: just refresh CPU usage (single delta step).
            s.refresh_cpu_usage();
            s.refresh_memory();
            s
        }
        None => {
            // 兜底：与 collect_local_processes 相同，正常播种在 main.rs 完成
            let mut s = System::new_with_specifics(
                RefreshKind::nothing().with_cpu(CpuRefreshKind::everything()),
            );
            s.refresh_cpu_usage();
            s.refresh_cpu_usage();
            *slot = Some(s);
            slot.as_mut().unwrap()
        }
    };

    let networks = Networks::new_with_refreshed_list();
    let (net_rx, net_tx) = networks.iter().fold((0u64, 0u64), |(rx, tx), (_, data)| {
        (rx + data.received(), tx + data.transmitted())
    });

    let disks = Disks::new_with_refreshed_list();
    let (disk_total, disk_used, disk_avail) = disks.iter().fold((0u64, 0u64, 0u64), |(t, u, a), disk| {
        let total = disk.total_space();
        let avail = disk.available_space();
        let used = total - avail;
        (t + total, u + used, a + avail)
    });

    SystemMonitorData {
        hostname: System::host_name().unwrap_or_default(),
        os_name: System::name().unwrap_or_default(),
        os_version: System::os_version().unwrap_or_default(),
        kernel_version: System::kernel_version().unwrap_or_default(),
        uptime_seconds: System::uptime(),
        cpu_count: sys.cpus().len() as u32,
        cpu_usage_percent: sys.global_cpu_usage().clamp(0.0_f32, 100.0_f32) as f64,
        memory_total_bytes: sys.total_memory(),
        memory_used_bytes: sys.used_memory(),
        memory_available_bytes: sys.available_memory(),
        swap_total_bytes: sys.total_swap(),
        swap_used_bytes: sys.used_swap(),
        disk_total_bytes: disk_total,
        disk_used_bytes: disk_used,
        disk_available_bytes: disk_avail,
        load_avg_1min: 0.0, // sysinfo doesn't provide load avg on Windows
        load_avg_5min: 0.0,
        load_avg_15min: 0.0,
        cpu_model: sys.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default(),
        network_rx_bytes: net_rx,
        network_tx_bytes: net_tx,
        processes: sys.processes().len() as u32,
    }
}

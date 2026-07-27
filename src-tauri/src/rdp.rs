//! 嵌入式 RDP 客户端（阶段 1 PoC）。
//!
//! 采用 IronRDP 的阻塞式 API（`ironrdp-blocking`），在独立 OS 线程上跑完整
//! 连接握手（TCP → TLS → CredSSP/NLA）与 ActiveStage 图形循环，解码出的 RGBA
//! 帧通过 `tauri::ipc::Channel` 以二进制形式推给前端，避开 JSON 序列化开销。
//!
//! 与官方 `screenshot.rs` 范例的关键差异：范例是截图工具，读超时即退出；本模块
//! 是常驻会话，读超时（Windows 上是 `TimedOut`、Unix 上是 `WouldBlock`）时检查
//! 关闭标志再决定继续轮询，从而既能常驻收帧又能优雅关闭。

use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use ironrdp::connector::{
    self, ClientConnector, Credentials, DesktopSize,
};
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::pdu::geometry::{InclusiveRectangle, Rectangle as _};
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::pdu::rdp::client_info::PerformanceFlags;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{
    ActiveStage, ActiveStageBuilder, ActiveStageOutput, GracefulDisconnectReason,
};
use ironrdp::input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp::pdu::input::fast_path::FastPathInputEvent;
use serde::{Deserialize, Serialize};
use sspi::network_client::reqwest_network_client::ReqwestNetworkClient;
use tauri::ipc::{Channel, InvokeResponseBody};

/// 建连握手阶段的 socket 读超时：给 TLS/CredSSP 往返留足余量（与 SSH 15s 对齐）。
const CONNECT_READ_TIMEOUT: Duration = Duration::from_secs(15);
/// ActiveStage 常驻阶段的 socket 读超时：短超时以便及时响应关闭信号。
const ACTIVE_READ_TIMEOUT: Duration = Duration::from_millis(16);

/// PoC 默认请求分辨率；服务器可能协商出不同尺寸，以 ConnectionResult 为准。
const DEFAULT_WIDTH: u16 = 1280;
const DEFAULT_HEIGHT: u16 = 1024;

// ── 帧二进制协议 ──────────────────────────────────────────────────────────
// 所有多字节字段小端。前端按同一布局解析。
//
//   DesktopInit (type=0)：桌面尺寸，前端据此初始化/重建 WebGL 纹理
//     [0]      u8   frame_type = 0
//     [1..3]   u16  width
//     [3..5]   u16  height
//
//   Tile (type=1)：一块脏矩形的紧密打包 RGBA（无行间空隙）
//     [0]      u8   frame_type = 1
//     [1..3]   u16  x
//     [3..5]   u16  y
//     [5..7]   u16  width
//     [7..9]   u16  height
//     [9..]    RGBA 像素，长度 = width*height*4
//
//   Video (type=2)：预留给后续 H.264/EGFX 直通，本阶段不产生。
const FRAME_DESKTOP_INIT: u8 = 0;
const FRAME_TILE: u8 = 1;
// type=2 预留给 Video/EGFX 直通；type=3 承载运行期错误/断开原因（UTF-8 文本）。
const FRAME_ERROR: u8 = 3;
// type=4 承载优雅断开（用户/服务器主动结束会话），前端切到中性提示并给出重连入口。
const FRAME_DISCONNECT: u8 = 4;

const TILE_HEADER_LEN: usize = 9;
const DESKTOP_INIT_LEN: usize = 5;
const BYTES_PER_PIXEL: usize = 4;

/// RDP 建连参数（凭据已由 resolved_session 解出明文）。
pub struct RdpConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    pub width: u16,
    pub height: u16,
}

impl RdpConnectParams {
    /// 用前端传入的面板尺寸建连；width/height 经 clamp_desktop_size 规整。
    /// 传入 0 视为未知，回退到默认分辨率，保证 desktop_size 恒为合法值。
    pub fn new(
        host: String,
        port: u16,
        username: String,
        password: String,
        domain: Option<String>,
        width: u16,
        height: u16,
    ) -> Self {
        let (width, height) = clamp_desktop_size(
            if width == 0 { DEFAULT_WIDTH } else { width },
            if height == 0 { DEFAULT_HEIGHT } else { height },
        );
        Self {
            host,
            port,
            username,
            password,
            domain,
            width,
            height,
        }
    }
}

/// 把请求分辨率规整到 RDP/DisplayControl 合法范围：两维 clamp 到 200..=8192，
/// 宽度取偶数（DisplayControl 规范要求宽度为偶数）。建连与动态 resize 统一走此约束。
fn clamp_desktop_size(width: u16, height: u16) -> (u16, u16) {
    let w = width.clamp(200, 8192) & !1;
    let h = height.clamp(200, 8192);
    (w, h)
}

/// rdp_connect 命令的返回体：告知前端连接成功及服务器协商出的桌面尺寸。
#[derive(Debug, Clone, Serialize)]
pub struct RdpConnectResult {
    pub width: u16,
    pub height: u16,
}

/// 存入 AppState 的会话句柄：持关闭标志，disconnect 时置位即可让线程优雅退出。
pub struct RdpSession {
    pub closed: Arc<AtomicBool>,
    pub input_tx: mpsc::Sender<RdpInputEvent>,
}

/// 前端回传的输入事件（鼠标/键盘/滚轮/resize）。internally-tagged，
/// kind 字段与前端 RdpInputEvent 严格对齐；后端据此还原为 ironrdp Operation。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RdpInputEvent {
    MouseMove { x: u16, y: u16 },
    MouseButton { button: u8, pressed: bool },
    Wheel { vertical: bool, delta: i16 },
    Key { scancode: u16, pressed: bool },
    Unicode { ch: String, pressed: bool },
    ReleaseAll,
    Resize { width: u16, height: u16 },
}

type UpgradedStream = native_tls::TlsStream<TcpStream>;
type UpgradedFramed = ironrdp_blocking::Framed<UpgradedStream>;

/// 构造 IronRDP 连接配置：仅本地账户 NLA（enable_tls=false + enable_credssp=true）。
/// 服务器据此走 CredSSP/NLA，其底层仍是 TLS，故 connect_begin 后需 TLS 升级。
fn build_config(params: &RdpConnectParams) -> connector::Config {
    connector::Config {
        credentials: Credentials::UsernamePassword {
            username: params.username.clone(),
            password: params.password.clone(),
        },
        domain: params.domain.clone(),
        enable_tls: false,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: DesktopSize {
            width: params.width,
            height: params.height,
        },
        bitmap: None,
        client_build: 0,
        client_name: "pandaterm".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        platform: MajorPlatformType::WINDOWS,
        enable_server_pointer: false,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        compression_type: None,
        pointer_software_rendering: true,
        multitransport_flags: None,
        performance_flags: PerformanceFlags::default(),
        desktop_scale_factor: 0,
        hardware_id: None,
        license_cache: None,
        timezone_info: Default::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    }
}

/// 阻塞式完整建连：DNS → TCP → connect_begin → TLS 升级 → connect_finalize（CredSSP/NLA）。
/// 返回协商结果与已升级的 Framed（供 ActiveStage 循环使用）。
fn connect(
    config: connector::Config,
    server_name: String,
    port: u16,
) -> Result<(connector::ConnectionResult, UpgradedFramed), String> {
    use std::net::ToSocketAddrs as _;

    eprintln!("[RDP] 开始建连 {server_name}:{port}");

    let server_addr = (server_name.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("解析主机地址失败: {e}"))?
        .next()
        .ok_or_else(|| "未解析到主机地址".to_string())?;

    let tcp_stream = TcpStream::connect(server_addr).map_err(|e| format!("TCP 连接失败: {e}"))?;
    tcp_stream
        .set_read_timeout(Some(CONNECT_READ_TIMEOUT))
        .map_err(|e| format!("设置读超时失败: {e}"))?;

    let client_addr = tcp_stream
        .local_addr()
        .map_err(|e| format!("获取本地地址失败: {e}"))?;

    let mut framed = ironrdp_blocking::Framed::new(tcp_stream);
    let mut connector = ClientConnector::new(config, client_addr);

    eprintln!("[RDP] TCP 已连接，开始 X.224 协商 (请求 HYBRID/NLA)");
    let should_upgrade = ironrdp_blocking::connect_begin(&mut framed, &mut connector)
        .map_err(|e| format!("建连初始阶段失败: {e}"))?;

    eprintln!("[RDP] X.224 协商完成，服务器同意升级，开始 TLS 握手");
    let initial_stream = framed.into_inner_no_leftover();
    let (upgraded_stream, server_public_key) =
        tls_upgrade(initial_stream, server_name.clone()).map_err(|e| format!("TLS 升级失败: {e}"))?;

    eprintln!("[RDP] TLS 握手成功，开始 CredSSP/NLA 认证");
    let upgraded = ironrdp_blocking::mark_as_upgraded(should_upgrade, &mut connector);
    let mut upgraded_framed = ironrdp_blocking::Framed::new(upgraded_stream);

    let mut network_client = ReqwestNetworkClient;
    let connection_result = ironrdp_blocking::connect_finalize(
        upgraded,
        connector,
        &mut upgraded_framed,
        &mut network_client,
        server_name.into(),
        server_public_key,
        None,
    )
    .map_err(|e| format!("CredSSP/NLA 认证失败: {e}"))?;

    eprintln!(
        "[RDP] 建连成功，桌面 {}x{}",
        connection_result.desktop_size.width, connection_result.desktop_size.height
    );
    Ok((connection_result, upgraded_framed))
}

/// TLS 升级：走 Windows 原生 schannel（native-tls 后端），使 ClientHello 与 mstsc 同源，
/// 规避云端 RDP 网关按 TLS 指纹拒绝非 schannel 握手的问题（rustls 握手曾被 RST）。
/// 证书/主机名验证放行（RDP 常用自签证书），且对 IP 目标禁用 SNI 以对齐 mstsc。
/// 返回 TLS 流与服务器公钥（CredSSP 通道绑定用）。
fn tls_upgrade(
    stream: TcpStream,
    server_name: String,
) -> Result<(UpgradedStream, Vec<u8>), String> {
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .use_sni(false)
        .build()
        .map_err(|e| format!("构建 TLS 连接器失败: {e}"))?;

    let tls_stream = connector
        .connect(&server_name, stream)
        .map_err(|e| format!("TLS 握手失败: {e}"))?;

    let cert = tls_stream
        .peer_certificate()
        .map_err(|e| format!("读取服务器证书失败: {e}"))?
        .ok_or_else(|| "缺少服务器证书".to_string())?;
    let cert_der = cert
        .to_der()
        .map_err(|e| format!("服务器证书转 DER 失败: {e}"))?;
    let server_public_key = extract_tls_server_public_key(&cert_der)?;

    Ok((tls_stream, server_public_key))
}

fn extract_tls_server_public_key(cert: &[u8]) -> Result<Vec<u8>, String> {
    use x509_cert::der::Decode as _;

    let cert = x509_cert::Certificate::from_der(cert).map_err(|e| format!("解析证书失败: {e}"))?;
    let key = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| "公钥 BIT STRING 未字节对齐".to_string())?
        .to_owned();
    Ok(key)
}

/// 把一块脏矩形从 DecodedImage 的带 stride 缓冲中逐行紧密拷出（去掉行间空隙），
/// 组装成 [9 字节头 + RGBA] 的 Tile 帧字节。
fn encode_tile_frame(image: &DecodedImage, rect: &InclusiveRectangle) -> Vec<u8> {
    let x = rect.left;
    let y = rect.top;
    let w = rect.width();
    let h = rect.height();

    let stride = image.stride();
    let src = image.data();
    let row_bytes = usize::from(w) * BYTES_PER_PIXEL;

    let mut out = Vec::with_capacity(TILE_HEADER_LEN + usize::from(w) * usize::from(h) * BYTES_PER_PIXEL);
    out.push(FRAME_TILE);
    out.extend_from_slice(&x.to_le_bytes());
    out.extend_from_slice(&y.to_le_bytes());
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());

    for row in 0..usize::from(h) {
        let src_row_start = (usize::from(y) + row) * stride + usize::from(x) * BYTES_PER_PIXEL;
        out.extend_from_slice(&src[src_row_start..src_row_start + row_bytes]);
    }
    out
}

fn encode_desktop_init_frame(width: u16, height: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(DESKTOP_INIT_LEN);
    out.push(FRAME_DESKTOP_INIT);
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out
}

/// 运行期错误/断开帧：type + UTF-8 文本，供前端切到错误态显示原因。
fn encode_error_frame(message: &str) -> Vec<u8> {
    let bytes = message.as_bytes();
    let mut out = Vec::with_capacity(1 + bytes.len());
    out.push(FRAME_ERROR);
    out.extend_from_slice(bytes);
    out
}

/// 优雅断开帧：type + UTF-8 文本。与错误帧区分，前端不显示为故障。
fn encode_disconnect_frame(message: &str) -> Vec<u8> {
    let bytes = message.as_bytes();
    let mut out = Vec::with_capacity(1 + bytes.len());
    out.push(FRAME_DISCONNECT);
    out.extend_from_slice(bytes);
    out
}

/// 把 IronRDP 的优雅断开原因翻译成用户可读的中文。
/// LOGOFF_BY_USER 等 ERROR_INFO 码本质是良性结束，不应呈现为错误。
fn describe_disconnect(reason: &GracefulDisconnectReason) -> String {
    match reason {
        GracefulDisconnectReason::UserInitiated => "已断开：本地请求结束了会话".to_owned(),
        GracefulDisconnectReason::ServerInitiated => "已断开：服务器结束了会话".to_owned(),
        GracefulDisconnectReason::Other(desc) => {
            let lower = desc.to_lowercase();
            if lower.contains("logging off") || lower.contains("logoff") || lower.contains("log off")
            {
                "已断开：远程用户在服务器上注销了该会话".to_owned()
            } else if lower.contains("idle") {
                "已断开：会话空闲超时".to_owned()
            } else if lower.contains("replaced") || lower.contains("another connection") {
                "已断开：该账户在别处发起了新的远程桌面连接".to_owned()
            } else {
                format!("已断开：{desc}")
            }
        }
    }
}

fn send_frame(channel: &Channel<InvokeResponseBody>, bytes: Vec<u8>) -> Result<(), String> {
    channel
        .send(InvokeResponseBody::Raw(bytes))
        .map_err(|e| format!("帧发送失败: {e}"))
}

/// 把已升级流的读超时改短，用于 ActiveStage 常驻阶段及时响应关闭信号。
fn set_active_timeout(framed: &mut UpgradedFramed) {
    let (stream, _) = framed.get_inner_mut();
    let _ = stream.get_ref().set_read_timeout(Some(ACTIVE_READ_TIMEOUT));
}

/// ActiveStage 常驻循环：处理图形 PDU，脏矩形逐块编码经 Channel 推给前端；
/// 读超时不退出，而是检查关闭标志决定是否继续轮询。
fn active_stage_loop(
    connection_result: connector::ConnectionResult,
    mut framed: UpgradedFramed,
    channel: Channel<InvokeResponseBody>,
    closed: Arc<AtomicBool>,
    input_rx: mpsc::Receiver<RdpInputEvent>,
) -> Result<(), String> {
    let mut image = DecodedImage::new(
        PixelFormat::RgbA32,
        connection_result.desktop_size.width,
        connection_result.desktop_size.height,
    );

    let mut active_stage = ActiveStageBuilder {
        static_channels: connection_result.static_channels,
        user_channel_id: connection_result.user_channel_id,
        io_channel_id: connection_result.io_channel_id,
        message_channel_id: connection_result.message_channel_id,
        share_id: connection_result.share_id,
        compression_type: connection_result.compression_type,
        enable_server_pointer: connection_result.enable_server_pointer,
        pointer_software_rendering: connection_result.pointer_software_rendering,
    }
    .build();

    set_active_timeout(&mut framed);

    let mut input_db = Database::new();

    while !closed.load(Ordering::SeqCst) {
        drain_input(&input_rx, &mut input_db, &mut active_stage, &mut image, &mut framed, &channel)?;

        let (action, payload) = match framed.read_pdu() {
            Ok(frame) => frame,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(e) => return Err(format!("读取 PDU 失败: {e}")),
        };

        let outputs = active_stage
            .process(&mut image, action, &payload)
            .map_err(|e| format!("处理 PDU 失败: {e}"))?;

        for out in outputs {
            match out {
                ActiveStageOutput::ResponseFrame(frame) => framed
                    .write_all(&frame)
                    .map_err(|e| format!("回写响应帧失败: {e}"))?,
                ActiveStageOutput::GraphicsUpdate(region) => {
                    send_frame(&channel, encode_tile_frame(&image, &region))?;
                }
                ActiveStageOutput::Terminate(reason) => {
                    let _ = send_frame(&channel, encode_disconnect_frame(&describe_disconnect(&reason)));
                    return Ok(());
                }
                _ => {}
            }
        }
    }
    Ok(())
}

/// 线程入口：先建连，成功后经 oneshot 回传结果并进入常驻循环。
pub fn run_session(
    params: RdpConnectParams,
    channel: Channel<InvokeResponseBody>,
    closed: Arc<AtomicBool>,
    ready: tokio::sync::oneshot::Sender<Result<RdpConnectResult, String>>,
    input_rx: mpsc::Receiver<RdpInputEvent>,
) {
    let config = build_config(&params);
    let (connection_result, framed) = match connect(config, params.host.clone(), params.port) {
        Ok(result) => result,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };

    // 握手期间标签可能已被关闭（StrictMode 双触发 / 用户提前关标签）。
    // 此时立刻丢弃 framed 关闭 TCP，让服务器尽快回收会话，避免残留。
    if closed.load(Ordering::SeqCst) {
        drop(framed);
        let _ = ready.send(Err("RDP 连接已取消".to_string()));
        return;
    }

    let width = connection_result.desktop_size.width;
    let height = connection_result.desktop_size.height;

    if ready.send(Ok(RdpConnectResult { width, height })).is_err() {
        return;
    }

    if send_frame(&channel, encode_desktop_init_frame(width, height)).is_err() {
        return;
    }

    let error_channel = channel.clone();
    if let Err(error) = active_stage_loop(connection_result, framed, channel, closed, input_rx) {
        let _ = send_frame(&error_channel, encode_error_frame(&error));
        eprintln!("[RDP] 会话循环结束: {error}");
    }
}

/// 把单个输入事件转成 ironrdp 的 Operation；ReleaseAll/Resize 由 drain_input 单独处理。
fn to_operation(event: RdpInputEvent) -> Option<Operation> {
    match event {
        RdpInputEvent::MouseMove { x, y } => Some(Operation::MouseMove(MousePosition { x, y })),
        RdpInputEvent::MouseButton { button, pressed } => {
            let button = MouseButton::from_web_button(button)?;
            Some(if pressed {
                Operation::MouseButtonPressed(button)
            } else {
                Operation::MouseButtonReleased(button)
            })
        }
        RdpInputEvent::Wheel { vertical, delta } => Some(Operation::WheelRotations(WheelRotations {
            is_vertical: vertical,
            rotation_units: delta,
        })),
        RdpInputEvent::Key { scancode, pressed } => {
            let scancode = Scancode::from_u16(scancode);
            Some(if pressed {
                Operation::KeyPressed(scancode)
            } else {
                Operation::KeyReleased(scancode)
            })
        }
        RdpInputEvent::Unicode { ch, pressed } => {
            let c = ch.chars().next()?;
            Some(if pressed {
                Operation::UnicodeKeyPressed(c)
            } else {
                Operation::UnicodeKeyReleased(c)
            })
        }
        RdpInputEvent::ReleaseAll | RdpInputEvent::Resize { .. } => None,
    }
}

/// 把一批输入产生的 FastPathInputEvent 交给 ActiveStage 编码，回写响应帧；
/// 客户端渲染指针时可能产生 GraphicsUpdate，同样编码成 Tile 帧推给前端。
fn write_input_outputs(
    active_stage: &mut ActiveStage,
    image: &mut DecodedImage,
    framed: &mut UpgradedFramed,
    channel: &Channel<InvokeResponseBody>,
    events: &[FastPathInputEvent],
) -> Result<(), String> {
    if events.is_empty() {
        return Ok(());
    }
    let outputs = active_stage
        .process_fastpath_input(image, events)
        .map_err(|e| format!("编码输入事件失败: {e}"))?;
    for out in outputs {
        match out {
            ActiveStageOutput::ResponseFrame(frame) => framed
                .write_all(&frame)
                .map_err(|e| format!("回写输入响应帧失败: {e}"))?,
            ActiveStageOutput::GraphicsUpdate(region) => {
                send_frame(channel, encode_tile_frame(image, &region))?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// 排空输入队列：常规事件批量走 Database，遇 ReleaseAll/Resize 先刷已累积批次再单独处理，
/// 以严格保持事件顺序。非阻塞，队列空即返回。
fn drain_input(
    input_rx: &mpsc::Receiver<RdpInputEvent>,
    input_db: &mut Database,
    active_stage: &mut ActiveStage,
    image: &mut DecodedImage,
    framed: &mut UpgradedFramed,
    channel: &Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let mut pending: Vec<Operation> = Vec::new();

    loop {
        match input_rx.try_recv() {
            Ok(RdpInputEvent::ReleaseAll) => {
                let events = input_db.apply(pending.drain(..));
                write_input_outputs(active_stage, image, framed, channel, &events)?;
                let events = input_db.release_all();
                write_input_outputs(active_stage, image, framed, channel, &events)?;
            }
            Ok(RdpInputEvent::Resize { width, height }) => {
                let events = input_db.apply(pending.drain(..));
                write_input_outputs(active_stage, image, framed, channel, &events)?;
                let (w, h) = clamp_desktop_size(width, height);
                if let Some(result) =
                    active_stage.encode_resize(u32::from(w), u32::from(h), None, None)
                {
                    let frame = result.map_err(|e| format!("编码 resize 失败: {e}"))?;
                    framed
                        .write_all(&frame)
                        .map_err(|e| format!("回写 resize 帧失败: {e}"))?;
                }
            }
            Ok(event) => {
                if let Some(op) = to_operation(event) {
                    pending.push(op);
                }
            }
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => break,
        }
    }

    let events = input_db.apply(pending);
    write_input_outputs(active_stage, image, framed, channel, &events)?;
    Ok(())
}


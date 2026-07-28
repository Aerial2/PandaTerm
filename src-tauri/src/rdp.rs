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

use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FileDescriptor, FormatDataRequest, FormatDataResponse, LockDataId,
    OwnedFormatDataResponse,
};
use ironrdp::cliprdr::CliprdrClient;
use ironrdp::connector::connection_activation::{
    ConnectionActivationFactory, ConnectionActivationState,
};
use ironrdp::connector::Sequence;
use ironrdp::connector::{self, BitmapConfig, ClientConnector, Credentials, DesktopSize};
use ironrdp::core::{IntoOwned as _, WriteBuf};
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::geometry::{InclusiveRectangle, Rectangle as _};
use ironrdp::pdu::input::fast_path::FastPathInputEvent;
use ironrdp::pdu::rdp::capability_sets::client_codecs_capabilities;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::pdu::rdp::client_info::PerformanceFlags;
use ironrdp::rdpsnd::client::{Rdpsnd, RdpsndClientHandler};
use ironrdp::rdpsnd::pdu::{AudioFormat, PitchPdu, VolumePdu, WaveFormat};
use ironrdp::session::fast_path;
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{
    ActiveStage, ActiveStageBuilder, ActiveStageOutput, GracefulDisconnectReason,
};
use serde::{Deserialize, Serialize};
use sspi::network_client::reqwest_network_client::ReqwestNetworkClient;
use tauri::ipc::{Channel, InvokeResponseBody};
use zeroize::Zeroize;

/// 建连握手阶段的 socket 读超时：给 TLS/CredSSP 往返留足余量（与 SSH 15s 对齐）。
const CONNECT_READ_TIMEOUT: Duration = Duration::from_secs(15);
/// ActiveStage 常驻阶段的 socket 读超时。画面静止时循环节奏由本超时决定：
/// 每次超时后回到循环顶部再 drain_input，故此值即静止画面下输入拾取的最坏延迟上界。
/// 取 8ms 在输入响应与空闲唤醒频率间平衡（前端 rAF 本就约 16ms 一批，再低收益递减）。
const ACTIVE_READ_TIMEOUT: Duration = Duration::from_millis(8);

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
//   Tile 子记录：批次帧内部一块脏矩形的紧密打包 RGBA（无行间空隙）
//     [0..2]   u16  x
//     [2..4]   u16  y
//     [4..6]   u16  width
//     [6..8]   u16  height
//     [8..]    RGBA 像素，长度 = width*height*4
//
//   Batch (type=5)：把一次 process() 产生的多块脏矩形合并成单条 IPC 消息，
//   payload 可选 LZ4 block 压缩（flags bit0），减少消息条数与序列化/调度开销。
//     [0]      u8   frame_type = 5
//     [1]      u8   flags（bit0=1 表示 payload 经 LZ4 block 压缩）
//     [2..4]   u16  tile_count
//     [4..8]   u32  raw_len（解压后 payload 字节数；供前端预分配与解压）
//     [8..]    payload = flags&1 ? LZ4_block(tiles) : tiles
//              tiles = 依次 tile_count 个上述 Tile 子记录
const FRAME_DESKTOP_INIT: u8 = 0;
// type=1 曾用于单块 Tile 帧，现已并入 Batch(type=5)；保留编号语义避免与旧协议冲突。
// type=2 预留给 Video/EGFX 直通；type=3 承载运行期错误/断开原因（UTF-8 文本）。
const FRAME_ERROR: u8 = 3;
// type=4 承载优雅断开（用户/服务器主动结束会话），前端切到中性提示并给出重连入口。
const FRAME_DISCONNECT: u8 = 4;
// type=5 承载合帧批次（多脏矩形 + 可选 LZ4），是常驻阶段图形下行的唯一热路径帧。
const FRAME_BATCH: u8 = 5;
// type=6 承载远端剪贴板 UTF-8 文本，前端收到后写入 OS 剪贴板。
const FRAME_CLIPBOARD: u8 = 6;
// type=7 承载远端音频 PCM：定长头(声道/采样率/位深) + 交织小端样本，前端经 Web Audio 播放。
const FRAME_AUDIO: u8 = 7;

/// 单次剪贴板文本传输上限，防止不可信远端通过超大 PDU/字符串造成内存峰值。
const MAX_CLIPBOARD_BYTES: usize = 4 * 1024 * 1024;
/// 单个音频 wave 块上限，防止不可信远端用超大 PDU 造成内存峰值（正常 wave 仅数 KB）。
const MAX_AUDIO_CHUNK_BYTES: usize = 1024 * 1024;
/// FRAME_AUDIO 定长头：type(1) + 声道(2) + 采样率(4) + 位深(2)。
const AUDIO_HEADER_LEN: usize = 9;

/// 唯一对外通告的音频格式：44.1kHz / 16bit / 立体声 PCM。仅通告一个格式，
/// 使协商交集至多含此一项，从而 Wave2 的 format_no 无歧义，前端可用固定头解码。
fn advertised_audio_format() -> AudioFormat {
    let n_channels: u16 = 2;
    let n_samples_per_sec: u32 = 44_100;
    let bits_per_sample: u16 = 16;
    let n_block_align = n_channels * (bits_per_sample / 8);
    AudioFormat {
        format: WaveFormat::PCM,
        n_channels,
        n_samples_per_sec,
        n_avg_bytes_per_sec: n_samples_per_sec * u32::from(n_block_align),
        n_block_align,
        bits_per_sample,
        data: None,
    }
}

/// Batch 帧头长度：type(1) + flags(1) + tile_count(2) + raw_len(4)。
const BATCH_HEADER_LEN: usize = 8;
/// Batch 内单个 tile 子记录头：x(2) + y(2) + w(2) + h(2)，其后紧跟 RGBA。
const BATCH_TILE_HEADER_LEN: usize = 8;
/// flags bit0：payload 经 LZ4 block 压缩。
const BATCH_FLAG_LZ4: u8 = 0x01;
const DESKTOP_INIT_LEN: usize = 5;
const BYTES_PER_PIXEL: usize = 4;

/// 画质档位（前端下拉传入）。三档共享 remotefx 编解码路径，差异只体现在
/// 色深、有损位图压缩、视觉效果三个真旋钮上，与分辨率维度正交。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RdpQuality {
    /// 标准：16bpp + 有损压缩 + 关闭壁纸/主题/动画等视效，最省带宽。
    Standard,
    /// 高清：32bpp + 无损 + 默认视效（禁用窗口拖动内容与菜单动画）。
    Hd,
    /// 超清：32bpp + 无损 + 开启桌面合成与字体平滑，不禁用任何视效。
    Uhd,
}

impl Default for RdpQuality {
    fn default() -> Self {
        RdpQuality::Hd
    }
}

/// 把画质档位翻译成 IronRDP 的 bitmap 配置与性能标志。
/// codecs 统一取 client_codecs_capabilities(&[])（remotefx 默认开），保持已验证的解码路径。
fn quality_profile(quality: RdpQuality) -> (BitmapConfig, PerformanceFlags) {
    let codecs = client_codecs_capabilities(&[]).unwrap_or_else(|_| {
        client_codecs_capabilities(&["remotefx:off"]).expect("empty codec list never panics")
    });
    match quality {
        RdpQuality::Standard => (
            BitmapConfig {
                lossy_compression: true,
                color_depth: 16,
                codecs,
            },
            PerformanceFlags::DISABLE_WALLPAPER
                | PerformanceFlags::DISABLE_FULLWINDOWDRAG
                | PerformanceFlags::DISABLE_MENUANIMATIONS
                | PerformanceFlags::DISABLE_THEMING
                | PerformanceFlags::DISABLE_CURSOR_SHADOW,
        ),
        RdpQuality::Hd => (
            BitmapConfig {
                lossy_compression: false,
                color_depth: 32,
                codecs,
            },
            PerformanceFlags::default(),
        ),
        RdpQuality::Uhd => (
            BitmapConfig {
                lossy_compression: false,
                color_depth: 32,
                codecs,
            },
            PerformanceFlags::ENABLE_DESKTOP_COMPOSITION | PerformanceFlags::ENABLE_FONT_SMOOTHING,
        ),
    }
}

/// RDP 建连参数（凭据已由 resolved_session 解出明文）。
pub struct RdpConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    pub width: u16,
    pub height: u16,
    pub quality: RdpQuality,
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
        quality: RdpQuality,
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
            quality,
        }
    }
}

/// 会话线程结束时清零密码明文的堆缓冲，缩小敏感数据在内存中的驻留窗口。
/// 注：ironrdp 内部另持一份凭据副本不在此掌控内，此处仅负责我方持有的这份。
impl Drop for RdpConnectParams {
    fn drop(&mut self) {
        self.password.zeroize();
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
    Clipboard { text: String },
}

type UpgradedStream = native_tls::TlsStream<TcpStream>;
type UpgradedFramed = ironrdp_blocking::Framed<UpgradedStream>;

#[derive(Debug)]
enum ClipboardAction {
    AdvertiseLocal,
    RequestRemote(ClipboardFormatId),
    Respond(OwnedFormatDataResponse),
}

/// CLIPRDR 仅维护协议态与待发送动作；系统剪贴板由前端 Tauri 插件负责。
/// 回调发生在 `ActiveStage::process` 内，不能重入借用 Cliprdr，因此先记录动作，
/// 待当前 PDU 处理结束后由会话循环统一编码并写回网络。
struct PandaClipboardBackend {
    channel: Channel<InvokeResponseBody>,
    temporary_directory: String,
    local_text: Option<String>,
    pending_remote_format: Option<ClipboardFormatId>,
    actions: std::collections::VecDeque<ClipboardAction>,
}

impl std::fmt::Debug for PandaClipboardBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PandaClipboardBackend")
            .field("temporary_directory", &self.temporary_directory)
            .field("has_local_text", &self.local_text.is_some())
            .field("pending_remote_format", &self.pending_remote_format)
            .field("pending_actions", &self.actions.len())
            .finish_non_exhaustive()
    }
}

impl PandaClipboardBackend {
    fn new(channel: Channel<InvokeResponseBody>) -> Self {
        Self {
            channel,
            temporary_directory: std::env::temp_dir().to_string_lossy().into_owned(),
            local_text: None,
            pending_remote_format: None,
            actions: std::collections::VecDeque::new(),
        }
    }

    fn set_local_text(&mut self, text: String) {
        if text.len() > MAX_CLIPBOARD_BYTES || self.local_text.as_deref() == Some(text.as_str()) {
            return;
        }
        self.local_text = Some(text);
        self.actions.push_back(ClipboardAction::AdvertiseLocal);
    }

    fn encode_local_text(&self, format: ClipboardFormatId) -> OwnedFormatDataResponse {
        let Some(text) = self.local_text.as_deref() else {
            return FormatDataResponse::new_error().into_owned();
        };
        if text
            .encode_utf16()
            .count()
            .saturating_mul(2)
            .saturating_add(2)
            > MAX_CLIPBOARD_BYTES
        {
            return FormatDataResponse::new_error().into_owned();
        }
        if format == ClipboardFormatId::CF_UNICODETEXT {
            FormatDataResponse::new_unicode_string(text).into_owned()
        } else if format == ClipboardFormatId::CF_TEXT {
            FormatDataResponse::new_string(text).into_owned()
        } else {
            FormatDataResponse::new_error().into_owned()
        }
    }

    fn decode_remote_text(&self, response: &FormatDataResponse<'_>) -> Option<String> {
        if response.is_error() || response.data().len() > MAX_CLIPBOARD_BYTES {
            return None;
        }
        match self.pending_remote_format {
            Some(ClipboardFormatId::CF_UNICODETEXT) => response.to_unicode_string().ok(),
            Some(ClipboardFormatId::CF_TEXT) => response.to_string().ok(),
            _ => None,
        }
    }

    fn publish_remote_text(&self, text: &str) {
        let mut frame = Vec::with_capacity(1 + text.len());
        frame.push(FRAME_CLIPBOARD);
        frame.extend_from_slice(text.as_bytes());
        let _ = send_frame(&self.channel, frame);
    }
}

ironrdp::core::impl_as_any!(PandaClipboardBackend);

impl CliprdrBackend for PandaClipboardBackend {
    fn temporary_directory(&self) -> &str {
        &self.temporary_directory
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::empty()
    }

    fn on_ready(&mut self) {}

    fn on_request_format_list(&mut self) {
        self.actions.push_back(ClipboardAction::AdvertiseLocal);
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        _capabilities: ClipboardGeneralCapabilityFlags,
    ) {
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        let format = available_formats
            .iter()
            .map(ClipboardFormat::id)
            .find(|id| *id == ClipboardFormatId::CF_UNICODETEXT)
            .or_else(|| {
                available_formats
                    .iter()
                    .map(ClipboardFormat::id)
                    .find(|id| *id == ClipboardFormatId::CF_TEXT)
            });
        if let Some(format) = format {
            self.pending_remote_format = Some(format);
            self.actions
                .push_back(ClipboardAction::RequestRemote(format));
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let response = self.encode_local_text(request.format);
        self.actions.push_back(ClipboardAction::Respond(response));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if let Some(text) = self.decode_remote_text(&response) {
            self.local_text = Some(text.clone());
            self.publish_remote_text(&text);
        }
        self.pending_remote_format = None;
    }

    fn on_file_contents_request(&mut self, _request: FileContentsRequest) {}

    fn on_file_contents_response(&mut self, _response: FileContentsResponse<'_>) {}

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}

    fn on_remote_file_list(&mut self, _files: &[FileDescriptor], _clip_data_id: Option<u32>) {}
}

/// rdpsnd 音频后端：只处理 RDP 协议侧，把服务器下发的 PCM wave 通过 Channel 直推前端播放。
/// 单向流，无需回发协议（wave_confirm 由 Rdpsnd::process 自动生成）。
struct PandaAudioBackend {
    channel: Channel<InvokeResponseBody>,
    formats: Vec<AudioFormat>,
}

impl std::fmt::Debug for PandaAudioBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PandaAudioBackend")
            .field("formats", &self.formats.len())
            .finish_non_exhaustive()
    }
}

impl PandaAudioBackend {
    fn new(channel: Channel<InvokeResponseBody>) -> Self {
        Self {
            channel,
            formats: vec![advertised_audio_format()],
        }
    }
}

impl RdpsndClientHandler for PandaAudioBackend {
    fn get_formats(&self) -> &[AudioFormat] {
        &self.formats
    }

    /// 服务器音频块回调：仅接受唯一通告格式，封 FRAME_AUDIO 定长头 + 交织 PCM 推前端。
    /// format_no 因单格式协商而无歧义，故用固定通告参数封头，不依赖其索引。
    fn wave(&mut self, _format_no: usize, _ts: u32, data: std::borrow::Cow<'_, [u8]>) {
        if data.is_empty() || data.len() > MAX_AUDIO_CHUNK_BYTES {
            return;
        }
        let format = advertised_audio_format();
        let mut frame = Vec::with_capacity(AUDIO_HEADER_LEN + data.len());
        frame.push(FRAME_AUDIO);
        frame.extend_from_slice(&format.n_channels.to_le_bytes());
        frame.extend_from_slice(&format.n_samples_per_sec.to_le_bytes());
        frame.extend_from_slice(&format.bits_per_sample.to_le_bytes());
        frame.extend_from_slice(&data);
        let _ = send_frame(&self.channel, frame);
    }

    fn set_volume(&mut self, _volume: VolumePdu) {}

    fn set_pitch(&mut self, _pitch: PitchPdu) {}

    fn close(&mut self) {}
}

/// 构造 IronRDP 连接配置：仅本地账户 NLA（enable_tls=false + enable_credssp=true）。
/// 服务器据此走 CredSSP/NLA，其底层仍是 TLS，故 connect_begin 后需 TLS 升级。
fn build_config(params: &RdpConnectParams) -> connector::Config {
    let (bitmap, performance_flags) = quality_profile(params.quality);
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
        bitmap: Some(bitmap),
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
        performance_flags,
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
    channel: Channel<InvokeResponseBody>,
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
    let drdynvc =
        DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new())));
    let cliprdr = CliprdrClient::new(Box::new(PandaClipboardBackend::new(channel.clone())));
    let rdpsnd = Rdpsnd::new(Box::new(PandaAudioBackend::new(channel)));
    let mut connector = ClientConnector::new(config, client_addr)
        .with_static_channel(drdynvc)
        .with_static_channel(cliprdr)
        .with_static_channel(rdpsnd);

    eprintln!("[RDP] TCP 已连接，开始 X.224 协商 (请求 HYBRID/NLA)");
    let should_upgrade = ironrdp_blocking::connect_begin(&mut framed, &mut connector)
        .map_err(|e| format!("建连初始阶段失败: {e}"))?;

    eprintln!("[RDP] X.224 协商完成，服务器同意升级，开始 TLS 握手");
    let initial_stream = framed.into_inner_no_leftover();
    let (upgraded_stream, server_public_key) = tls_upgrade(initial_stream, server_name.clone())
        .map_err(|e| format!("TLS 升级失败: {e}"))?;

    // TOFU 证书 pinning：TLS 为兼容自签证书放行了校验，握手后改用服务器公钥指纹在
    // known_hosts 做首信/防篡改比对，在把凭据交给 CredSSP 之前拦截 MITM。
    // 键加 "rdp:" 前缀与 SSH 记录分区；公钥变更（含服务器重装）将中止建连。
    let fingerprint = public_key_fingerprint(&server_public_key);
    let host_key = format!("rdp:{server_name}:{port}");
    crate::known_hosts::verify_or_trust_fingerprint(&host_key, &fingerprint, "RDP")?;

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

/// 对服务器公钥（SPKI 的 subject_public_key 字节）算 SHA-256，格式化为 sha256:hex 指纹。
/// 公钥 pinning 比证书 pinning 更稳定：证书轮换而密钥不变时指纹不变，减少误报。
fn public_key_fingerprint(public_key: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(public_key);
    use std::fmt::Write as _;
    let hex = digest.iter().fold(String::with_capacity(64), |mut acc, b| {
        let _ = write!(acc, "{b:02x}");
        acc
    });
    format!("sha256:{hex}")
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

/// 合帧累积器：把一次 process()/process_fastpath_input() 产生的多块脏矩形
/// 收进单个 payload 缓冲，最终编码成一条 FRAME_BATCH。相比逐块 send_frame，
/// 把 N 条 IPC 消息压成 1 条，省去每条消息的序列化与调度固定开销。
struct TileBatch {
    payload: Vec<u8>,
    tile_count: u16,
    /// 跨帧复用的 LZ4 压缩输出缓冲：按最大输出上界 resize 后复用，避免每帧 alloc/free。
    compress_scratch: Vec<u8>,
}

impl TileBatch {
    fn new() -> Self {
        TileBatch {
            payload: Vec::new(),
            tile_count: 0,
            compress_scratch: Vec::new(),
        }
    }

    fn is_empty(&self) -> bool {
        self.tile_count == 0
    }

    /// 清空累积但保留 payload 已分配容量，供下一帧复用，避免热路径反复扩容。
    fn clear(&mut self) {
        self.payload.clear();
        self.tile_count = 0;
    }

    /// 追加一块脏矩形：写 8 字节 tile 头，再从带 stride 的源缓冲逐行紧密拷出 RGBA。
    fn push(&mut self, image: &DecodedImage, rect: &InclusiveRectangle) {
        let x = rect.left;
        let y = rect.top;
        let w = rect.width();
        let h = rect.height();

        let stride = image.stride();
        let src = image.data();
        let row_bytes = usize::from(w) * BYTES_PER_PIXEL;

        self.payload
            .reserve(BATCH_TILE_HEADER_LEN + usize::from(w) * usize::from(h) * BYTES_PER_PIXEL);
        self.payload.extend_from_slice(&x.to_le_bytes());
        self.payload.extend_from_slice(&y.to_le_bytes());
        self.payload.extend_from_slice(&w.to_le_bytes());
        self.payload.extend_from_slice(&h.to_le_bytes());

        for row in 0..usize::from(h) {
            let src_row_start = (usize::from(y) + row) * stride + usize::from(x) * BYTES_PER_PIXEL;
            self.payload
                .extend_from_slice(&src[src_row_start..src_row_start + row_bytes]);
        }

        self.tile_count = self.tile_count.saturating_add(1);
    }

    /// 组装成 FRAME_BATCH 字节：尝试 LZ4 block 压缩，仅当压缩后确实更小才启用，
    /// 否则回退明文（flags 清零）。压缩走 compress_scratch 跨帧复用缓冲，不新分配。
    fn encode_frame(&mut self) -> Vec<u8> {
        let raw_len = self.payload.len() as u32;

        let mut flags = 0u8;
        let max = lz4_flex::block::get_maximum_output_size(self.payload.len());
        if self.compress_scratch.len() < max {
            self.compress_scratch.resize(max, 0);
        }

        let body: &[u8] =
            match lz4_flex::block::compress_into(&self.payload, &mut self.compress_scratch) {
                Ok(n) if n < self.payload.len() => {
                    flags |= BATCH_FLAG_LZ4;
                    &self.compress_scratch[..n]
                }
                _ => &self.payload,
            };

        let mut out = Vec::with_capacity(BATCH_HEADER_LEN + body.len());
        out.push(FRAME_BATCH);
        out.push(flags);
        out.extend_from_slice(&self.tile_count.to_le_bytes());
        out.extend_from_slice(&raw_len.to_le_bytes());
        out.extend_from_slice(body);
        out
    }
}

/// 把已拼好的 tiles payload 封成 FRAME_BATCH 帧。独立成函数便于单元测试往返验证；
/// 内部走 TileBatch 的复用编码路径，与热路径产出字节完全一致。热路径本身直接用
/// TileBatch::encode_frame，故此包装仅测试使用。
#[cfg(test)]
fn encode_batch_frame(payload: &[u8], tile_count: u16) -> Vec<u8> {
    let mut batch = TileBatch::new();
    batch.payload.extend_from_slice(payload);
    batch.tile_count = tile_count;
    batch.encode_frame()
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
            if lower.contains("logging off")
                || lower.contains("logoff")
                || lower.contains("log off")
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
/// 把底层 socket 读超时临时调回连接期的长超时（15s）。重激活是多步握手，
/// 若沿用 ActiveStage 的 16ms 短超时会在序列中途 TimedOut 打断，导致状态机卡死。
fn set_connect_timeout(framed: &mut UpgradedFramed) {
    let (stream, _) = framed.get_inner_mut();
    let _ = stream
        .get_ref()
        .set_read_timeout(Some(CONNECT_READ_TIMEOUT));
}

/// 处理服务器发起的 Deactivation-Reactivation 序列（DisplayControl 动态 resize 后触发）。
/// 期间临时恢复长读超时，逐步驱动 ConnectionActivationSequence 到 Finalized：
/// 据新桌面尺寸重建 image、重建 fast-path 处理器、更新 share_id/指针配置，
/// 恢复 16ms 短超时后向前端推新的 DesktopInit 帧以重建 WebGL 纹理（免整会话重连）。
fn reactivate(
    framed: &mut UpgradedFramed,
    active_stage: &mut ActiveStage,
    image: &mut DecodedImage,
    activation_factory: &ConnectionActivationFactory,
    channel: &Channel<InvokeResponseBody>,
) -> Result<(), String> {
    set_connect_timeout(framed);

    let mut activation = activation_factory.create();
    let mut buf = WriteBuf::new();

    let (width, height) = loop {
        drive_activation_step(framed, &mut activation, &mut buf)?;

        if let ConnectionActivationState::Finalized {
            desktop_size,
            share_id,
            enable_server_pointer,
            pointer_software_rendering,
        } = activation.connection_activation_state()
        {
            *image =
                DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
            active_stage.set_fastpath_processor(
                fast_path::ProcessorBuilder {
                    io_channel_id: activation.io_channel_id(),
                    user_channel_id: activation.user_channel_id(),
                    share_id,
                    enable_server_pointer,
                    pointer_software_rendering,
                    bulk_decompressor: None,
                }
                .build(),
            );
            active_stage.set_share_id(share_id);
            active_stage.set_enable_server_pointer(enable_server_pointer);
            break (desktop_size.width, desktop_size.height);
        }
    };

    set_active_timeout(framed);
    send_frame(channel, encode_desktop_init_frame(width, height))?;
    Ok(())
}

/// blocking 版泛型单步驱动：对标 ironrdp-blocking 的 single_sequence_step，但该官方函数
/// 对 ClientConnector 写死，这里泛型到任意 Sequence（用于驱动 ConnectionActivationSequence）。
fn drive_activation_step<S: Sequence>(
    framed: &mut UpgradedFramed,
    sequence: &mut S,
    buf: &mut WriteBuf,
) -> Result<(), String> {
    buf.clear();

    let written = if let Some(next_pdu_hint) = sequence.next_pdu_hint() {
        let pdu = framed
            .read_by_hint(next_pdu_hint)
            .map_err(|e| format!("读取重激活 PDU 失败: {e}"))?;
        sequence
            .step(&pdu, buf)
            .map_err(|e| format!("重激活步进失败: {e}"))?
    } else {
        sequence
            .step_no_input(buf)
            .map_err(|e| format!("重激活步进失败: {e}"))?
    };

    if let Some(response_len) = written.size() {
        framed
            .write_all(&buf[..response_len])
            .map_err(|e| format!("回写重激活帧失败: {e}"))?;
    }
    Ok(())
}

fn set_active_timeout(framed: &mut UpgradedFramed) {
    let (stream, _) = framed.get_inner_mut();
    let _ = stream.get_ref().set_read_timeout(Some(ACTIVE_READ_TIMEOUT));
}

fn queue_local_clipboard(active_stage: &mut ActiveStage, text: String) {
    if let Some(cliprdr) = active_stage.get_svc_processor_mut::<CliprdrClient>() {
        if let Some(backend) = cliprdr.downcast_backend_mut::<PandaClipboardBackend>() {
            backend.set_local_text(text);
        }
    }
}

/// 排空 CLIPRDR backend 回调记录的动作。动作编码必须在 `ActiveStage::process`
/// 返回后执行，避免 backend 回调期间对同一个 Cliprdr 处理器发生可变借用重入。
fn flush_clipboard_actions(
    active_stage: &mut ActiveStage,
    framed: &mut UpgradedFramed,
) -> Result<(), String> {
    loop {
        let action = active_stage
            .get_svc_processor_mut::<CliprdrClient>()
            .and_then(|cliprdr| cliprdr.downcast_backend_mut::<PandaClipboardBackend>())
            .and_then(|backend| backend.actions.pop_front());
        let Some(action) = action else {
            return Ok(());
        };

        let messages = {
            let cliprdr = active_stage
                .get_svc_processor_mut::<CliprdrClient>()
                .ok_or_else(|| "CLIPRDR 通道处理器不可用".to_string())?;
            match action {
                ClipboardAction::AdvertiseLocal => {
                    let has_text = cliprdr
                        .downcast_backend::<PandaClipboardBackend>()
                        .and_then(|backend| backend.local_text.as_ref())
                        .is_some();
                    let formats = if has_text {
                        vec![
                            ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
                            ClipboardFormat::new(ClipboardFormatId::CF_TEXT),
                        ]
                    } else {
                        Vec::new()
                    };
                    cliprdr.initiate_copy(&formats)
                }
                ClipboardAction::RequestRemote(format) => cliprdr.initiate_paste(format),
                ClipboardAction::Respond(response) => cliprdr.submit_format_data(response),
            }
            .map_err(|e| format!("生成 CLIPRDR 消息失败: {e}"))?
        };

        let frame = active_stage
            .process_svc_processor_messages::<CliprdrClient>(messages)
            .map_err(|e| format!("编码 CLIPRDR 消息失败: {e}"))?;
        if !frame.is_empty() {
            framed
                .write_all(&frame)
                .map_err(|e| format!("回写 CLIPRDR 消息失败: {e}"))?;
        }
    }
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

    let activation_factory = connection_result.activation_factory;

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
    // 合帧累积器提到循环外：图形与输入两条产帧路径共用同一 TileBatch，
    // 跨帧复用 payload/compress 缓冲。两路时序不重叠（drain_input 结束即 flush 清空）。
    let mut batch = TileBatch::new();

    while !closed.load(Ordering::SeqCst) {
        drain_input(
            &input_rx,
            &mut input_db,
            &mut active_stage,
            &mut image,
            &mut framed,
            &channel,
            &mut batch,
        )?;
        flush_clipboard_actions(&mut active_stage, &mut framed)?;

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

        // 把本批 outputs 里的多块 GraphicsUpdate 合并成一条 FRAME_BATCH（复用外层 batch）。
        // DeactivateAll/Terminate 同为下行 IPC，必须在其之前 flush 已累积批次以保序。
        for out in outputs {
            match out {
                ActiveStageOutput::ResponseFrame(frame) => framed
                    .write_all(&frame)
                    .map_err(|e| format!("回写响应帧失败: {e}"))?,
                ActiveStageOutput::GraphicsUpdate(region) => {
                    batch.push(&image, &region);
                }
                ActiveStageOutput::DeactivateAll => {
                    flush_batch(&channel, &mut batch)?;
                    reactivate(
                        &mut framed,
                        &mut active_stage,
                        &mut image,
                        &activation_factory,
                        &channel,
                    )?;
                }
                ActiveStageOutput::Terminate(reason) => {
                    flush_batch(&channel, &mut batch)?;
                    let _ = send_frame(
                        &channel,
                        encode_disconnect_frame(&describe_disconnect(&reason)),
                    );
                    return Ok(());
                }
                _ => {}
            }
        }
        flush_clipboard_actions(&mut active_stage, &mut framed)?;
        flush_batch(&channel, &mut batch)?;
    }
    Ok(())
}

/// 若批次非空则编码成 FRAME_BATCH 推给前端，并清空累积器（保留容量复用）；空批次直接跳过。
fn flush_batch(channel: &Channel<InvokeResponseBody>, batch: &mut TileBatch) -> Result<(), String> {
    if batch.is_empty() {
        return Ok(());
    }
    let frame = batch.encode_frame();
    batch.clear();
    send_frame(channel, frame)
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
    let (connection_result, framed) =
        match connect(config, params.host.clone(), params.port, channel.clone()) {
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
        RdpInputEvent::Wheel { vertical, delta } => {
            Some(Operation::WheelRotations(WheelRotations {
                is_vertical: vertical,
                rotation_units: delta,
            }))
        }
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
        RdpInputEvent::ReleaseAll
        | RdpInputEvent::Resize { .. }
        | RdpInputEvent::Clipboard { .. } => None,
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
    batch: &mut TileBatch,
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
                batch.push(image, &region);
            }
            _ => {}
        }
    }
    flush_batch(channel, batch)?;
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
    batch: &mut TileBatch,
) -> Result<(), String> {
    let mut pending: Vec<Operation> = Vec::new();

    loop {
        match input_rx.try_recv() {
            Ok(RdpInputEvent::ReleaseAll) => {
                let events = input_db.apply(pending.drain(..));
                write_input_outputs(active_stage, image, framed, channel, &events, batch)?;
                let events = input_db.release_all();
                write_input_outputs(active_stage, image, framed, channel, &events, batch)?;
            }
            Ok(RdpInputEvent::Resize { width, height }) => {
                let events = input_db.apply(pending.drain(..));
                write_input_outputs(active_stage, image, framed, channel, &events, batch)?;
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
            Ok(RdpInputEvent::Clipboard { text }) => {
                let events = input_db.apply(pending.drain(..));
                write_input_outputs(active_stage, image, framed, channel, &events, batch)?;
                queue_local_clipboard(active_stage, text);
                flush_clipboard_actions(active_stage, framed)?;
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
    write_input_outputs(active_stage, image, framed, channel, &events, batch)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 校验 FRAME_BATCH 头部布局，并对压缩路径做 LZ4 往返（模拟前端解码），
    // 确认后端产出的是可被标准 LZ4 block 解码器还原的字节。
    #[test]
    fn batch_frame_compresses_and_roundtrips() {
        // 高度可压缩的 payload（重复字节），必然走 LZ4 分支。
        let payload = vec![7u8; 8192];
        let frame = encode_batch_frame(&payload, 3);

        assert_eq!(frame[0], FRAME_BATCH);
        let flags = frame[1];
        assert_eq!(
            flags & BATCH_FLAG_LZ4,
            BATCH_FLAG_LZ4,
            "大重复 payload 应被压缩"
        );
        let tile_count = u16::from_le_bytes([frame[2], frame[3]]);
        assert_eq!(tile_count, 3);
        let raw_len = u32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]) as usize;
        assert_eq!(raw_len, payload.len());

        let body = &frame[BATCH_HEADER_LEN..];
        let mut restored = vec![0u8; raw_len];
        let n = lz4_flex::block::decompress_into(body, &mut restored).expect("解压失败");
        assert_eq!(n, raw_len);
        assert_eq!(restored, payload);
    }

    // 难压缩的小 payload 应回退明文（flags 清零，body 原样），前端据此直接读取。
    #[test]
    fn batch_frame_falls_back_to_plain() {
        let payload = vec![1u8, 2, 3, 4, 5];
        let frame = encode_batch_frame(&payload, 1);

        assert_eq!(frame[0], FRAME_BATCH);
        assert_eq!(
            frame[1] & BATCH_FLAG_LZ4,
            0,
            "小 payload 压缩无收益应回退明文"
        );
        let raw_len = u32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]) as usize;
        assert_eq!(raw_len, payload.len());
        assert_eq!(&frame[BATCH_HEADER_LEN..], &payload[..]);
    }
}

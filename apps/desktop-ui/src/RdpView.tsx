import { useEffect, useRef, useState } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { rdpConnect, rdpDisconnect, rdpInputBatch } from './api';
import type { RdpInputEvent, RdpQuality } from './api';
import { FileUp, FolderUp, Volume2, VolumeX } from 'lucide-react';
import { codeToScancode } from './scancode';

// 帧二进制协议常量：必须与后端 src-tauri/src/rdp.rs 完全一致（多字节小端）。
//   DesktopInit(type=0): [0]=0 [1..3]=width [3..5]=height
//   Batch(type=5):       [0]=5 [1]=flags [2..4]=tileCount [4..8]=rawLen [8..]=payload
//     payload = flags&1 ? LZ4_block(tiles) : tiles
//     tile 子记录: [0..2]=x [2..4]=y [4..6]=w [6..8]=h [8..]=RGBA(w*h*4)
const FRAME_DESKTOP_INIT = 0;
const FRAME_ERROR = 3;
const FRAME_DISCONNECT = 4;
const FRAME_BATCH = 5;
const FRAME_CLIPBOARD = 6;
const FRAME_AUDIO = 7;
const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024;
// FRAME_AUDIO 定长头：type(1) + 声道(2) + 采样率(4) + 位深(2)，与后端 rdp.rs 严格一致。
const AUDIO_HEADER_LEN = 9;

type AudioPlayer = {
  push: (channels: number, sampleRate: number, bitsPerSample: number, pcm: Uint8Array) => void;
  setVolume: (value: number) => void;
  close: () => void;
};

// 基于 Web Audio 的 PCM 播放器：把后端推来的交织 16bit 小端样本去交织为 planar float32，
// 按 AudioContext 时间线无缝排队。欠载（长时间无音频后又来）时把起播点贴到 now+prebuffer
// 重新对齐，避免与陈旧的 nextStartTime 之间产生静音撕裂或抢跑爆音。
function createAudioPlayer(initialGain: number): AudioPlayer {
  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  // 期望增益缓存在闭包：ctx 尚未建立（首个音频块到达前）时也能记住，建立后即时套用，
  // 避免「先拖动音量条、后来音频」时设置丢失。
  let desiredGain = Math.max(0, initialGain);
  let nextStartTime = 0;
  const PREBUFFER = 0.03;

  const ensureCtx = (): AudioContext => {
    if (!ctx) {
      ctx = new AudioContext();
      gain = ctx.createGain();
      gain.gain.value = desiredGain;
      gain.connect(ctx.destination);
      nextStartTime = 0;
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  };

  const push = (channels: number, sampleRate: number, bitsPerSample: number, pcm: Uint8Array) => {
    if (bitsPerSample !== 16 || channels < 1 || sampleRate <= 0) return;
    const bytesPerSample = 2;
    const stride = channels * bytesPerSample;
    const frameCount = Math.floor(pcm.byteLength / stride);
    if (frameCount === 0) return;

    const c = ensureCtx();
    const buffer = c.createBuffer(channels, frameCount, sampleRate);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let ch = 0; ch < channels; ch++) {
      const out = buffer.getChannelData(ch);
      let off = ch * bytesPerSample;
      for (let i = 0; i < frameCount; i++) {
        out[i] = view.getInt16(off, true) / 32768;
        off += stride;
      }
    }

    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(gain ?? c.destination);
    const startAt = Math.max(c.currentTime + PREBUFFER, nextStartTime);
    src.start(startAt);
    nextStartTime = startAt + buffer.duration;
  };

  const setVolume = (value: number) => {
    desiredGain = Math.max(0, value);
    if (gain && ctx) {
      // 短坡道过渡，避免增益突变产生咔哒声。
      gain.gain.setTargetAtTime(desiredGain, ctx.currentTime, 0.015);
    }
  };

  const close = () => {
    if (ctx) {
      void ctx.close();
      ctx = null;
      gain = null;
    }
    nextStartTime = 0;
  };

  return { push, setVolume, close };
}
const BATCH_HEADER_LEN = 8;
const BATCH_TILE_HEADER_LEN = 8;
const BATCH_FLAG_LZ4 = 0x01;

// WebGL2 全屏四边形着色器。用数组 join 拼接（本文件规避反引号模板串）。
const VERTEX_SHADER_SRC = [
  '#version 300 es',
  'in vec2 a_pos;',
  'in vec2 a_uv;',
  'out vec2 v_uv;',
  'void main() {',
  '  v_uv = a_uv;',
  '  gl_Position = vec4(a_pos, 0.0, 1.0);',
  '}',
].join('\n');

const FRAGMENT_SHADER_SRC = [
  '#version 300 es',
  'precision mediump float;',
  'in vec2 v_uv;',
  'uniform sampler2D u_tex;',
  'out vec4 outColor;',
  'void main() {',
  '  outColor = texture(u_tex, v_uv);',
  '}',
].join('\n');

// 顶点数据 [clipX, clipY, u, v]。RDP 原点在左上、GL 纹理 v=0 对应首行数据，
// 这里让屏幕顶部(clipY=+1)采样纹理 v=0，从而画面正立，tile 上传无需翻转 Y。
const QUAD_VERTS = new Float32Array([
  -1, 1, 0, 0,
  -1, -1, 0, 1,
  1, 1, 1, 0,
  1, -1, 1, 1,
]);

type Renderer = {
  resize: (w: number, h: number) => void;
  uploadTile: (x: number, y: number, w: number, h: number, px: Uint8Array) => void;
  draw: () => void;
  dispose: () => void;
};

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader 失败');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '';
    gl.deleteShader(sh);
    throw new Error('着色器编译失败: ' + log);
  }
  return sh;
}

function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false, alpha: false });
  if (!gl) throw new Error('当前环境不支持 WebGL2，无法渲染 RDP 画面');

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram 失败');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + (gl.getProgramInfoLog(program) || ''));
  }
  gl.useProgram(program);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, 'a_pos');
  const uvLoc = gl.getAttribLocation(program, 'a_uv');
  const stride = 4 * 4;
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(uvLoc);
  gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, stride, 2 * 4);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
  gl.clearColor(0, 0, 0, 1);

  let texW = 0;
  let texH = 0;

  const resize = (w: number, h: number) => {
    if (w <= 0 || h <= 0 || (w === texW && h === texH)) return;
    texW = w;
    texH = h;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  };

  const uploadTile = (x: number, y: number, w: number, h: number, px: Uint8Array) => {
    if (w <= 0 || h <= 0) return;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  };

  const draw = () => {
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const dispose = () => {
    gl.deleteTexture(tex);
    gl.deleteBuffer(buf);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
  };

  return { resize, uploadTile, draw, dispose };
}

// Channel 在后端用 InvokeResponseBody::Raw(Vec<u8>) 时，前端回调可能拿到
// ArrayBuffer / TypedArray / 普通数字数组，这里统一归一为 ArrayBuffer。
function toArrayBuffer(msg: unknown): ArrayBuffer | null {
  if (msg instanceof ArrayBuffer) return msg;
  if (ArrayBuffer.isView(msg)) {
    const v = msg as ArrayBufferView;
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(msg)) return new Uint8Array(msg).buffer;
  return null;
}

// LZ4 block 格式解码（与后端 lz4_flex block API 产出一致）。src 为压缩数据，
// rawLen 为解压后字节数（后端在帧头给出，用于精确预分配）。返回填满的 dst。
// 标准布局：token(高4=literal长/低4=match长) → [扩展字节] → literals → offset(u16 LE)
//   → [扩展字节]，match 长需 +4（最小匹配）。match 拷贝允许与输出重叠，故逐字节拷。
function lz4DecompressBlock(src: Uint8Array, rawLen: number): Uint8Array {
  const dst = new Uint8Array(rawLen);
  let sp = 0;
  let dp = 0;
  const sn = src.length;

  while (sp < sn) {
    const token = src[sp++];

    let litLen = token >>> 4;
    if (litLen === 15) {
      let b = 255;
      while (b === 255 && sp < sn) {
        b = src[sp++];
        litLen += b;
      }
    }

    if (litLen > 0) {
      dst.set(src.subarray(sp, sp + litLen), dp);
      sp += litLen;
      dp += litLen;
    }

    // 末段 sequence 可能只有 literals、无 match（offset 读不满即结束）。
    if (sp >= sn) break;

    const offset = src[sp] | (src[sp + 1] << 8);
    sp += 2;

    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let b = 255;
      while (b === 255 && sp < sn) {
        b = src[sp++];
        matchLen += b;
      }
    }
    matchLen += 4;

    let mp = dp - offset;
    for (let i = 0; i < matchLen; i++) {
      dst[dp++] = dst[mp++];
    }
  }

  return dst;
}

// 解析单帧并驱动渲染器。返回 true 表示画面有变化、需要重绘。
function applyFrame(renderer: Renderer, buf: ArrayBuffer): boolean {
  const view = new DataView(buf);
  const frameType = view.getUint8(0);
  if (frameType === FRAME_DESKTOP_INIT) {
    renderer.resize(view.getUint16(1, true), view.getUint16(3, true));
    return true;
  }
  if (frameType === FRAME_BATCH) {
    const flags = view.getUint8(1);
    const tileCount = view.getUint16(2, true);
    const rawLen = view.getUint32(4, true);

    const body = new Uint8Array(buf, BATCH_HEADER_LEN);
    const tiles =
      (flags & BATCH_FLAG_LZ4) !== 0 ? lz4DecompressBlock(body, rawLen) : body;

    // 顺序读取 tileCount 个 tile 子记录：8 字节头 + 紧密 RGBA。
    const td = new DataView(tiles.buffer, tiles.byteOffset, tiles.byteLength);
    let off = 0;
    for (let i = 0; i < tileCount; i++) {
      const x = td.getUint16(off, true);
      const y = td.getUint16(off + 2, true);
      const w = td.getUint16(off + 4, true);
      const h = td.getUint16(off + 6, true);
      off += BATCH_TILE_HEADER_LEN;
      const byteLen = w * h * 4;
      const px = tiles.subarray(off, off + byteLen);
      off += byteLen;
      renderer.uploadTile(x, y, w, h, px);
    }
    return tileCount > 0;
  }
  return false;
}

type RdpStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

type RdpViewProps = {
  sessionId: string;
  terminalId: string;
  onError?: (message: string) => void;
};

// 分辨率维度：决定请求给服务器的 desktop_size。'adaptive' 跟随面板物理像素（吸收原 supersampling），
// 固定档直接用档位像素（canvas objectFit:contain 缩放，非 16:9 面板会有黑边）。
type RdpResolution = 'adaptive' | '1k' | '2k' | '3k' | '4k';

const RESOLUTION_OPTIONS: { value: RdpResolution; label: string }[] = [
  { value: 'adaptive', label: '自适应屏幕' },
  { value: '1k', label: '1K (1280×720)' },
  { value: '2k', label: '2K (1920×1080)' },
  { value: '3k', label: '3K (2560×1440)' },
  { value: '4k', label: '4K (3840×2160)' },
];

const FIXED_RESOLUTIONS: Record<Exclude<RdpResolution, 'adaptive'>, { width: number; height: number }> = {
  '1k': { width: 1280, height: 720 },
  '2k': { width: 1920, height: 1080 },
  '3k': { width: 2560, height: 1440 },
  '4k': { width: 3840, height: 2160 },
};

// 画质维度：决定 codec/位深/视觉效果，纯后端职责，value 与后端 RdpQuality 一一对应。
const QUALITY_OPTIONS: { value: RdpQuality; label: string }[] = [
  { value: 'standard', label: '标准' },
  { value: 'hd', label: '高清' },
  { value: 'uhd', label: '超清' },
];

// 按分辨率档位算请求尺寸：adaptive=面板 CSS 尺寸×dpr（物理像素，最清晰）；固定档=档位像素。
// 两者都按后端 clamp_desktop_size 同步约束（200..=8192、宽取偶数）预处理，避免无谓往返。
function resolutionToDesktopSize(el: HTMLElement, resolution: RdpResolution): { width: number; height: number } {
  const clamp = (v: number) => Math.max(200, Math.min(8192, Math.round(v)));
  if (resolution === 'adaptive') {
    const dpr = window.devicePixelRatio || 1;
    return { width: clamp(el.clientWidth * dpr) & ~1, height: clamp(el.clientHeight * dpr) };
  }
  const fixed = FIXED_RESOLUTIONS[resolution];
  return { width: clamp(fixed.width) & ~1, height: clamp(fixed.height) };
}

export function RdpView({ sessionId, terminalId, onError }: RdpViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<RdpStatus>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [resolution, setResolution] = useState<RdpResolution>('adaptive');
  const [quality, setQuality] = useState<RdpQuality>('hd');
  const [fileDropMessage, setFileDropMessage] = useState('');
  const [volume, setVolume] = useState<number>(() => {
    const raw = Number(localStorage.getItem('pandaterm.rdpVolume'));
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 1;
  });
  const [muted, setMuted] = useState<boolean>(() => localStorage.getItem('pandaterm.rdpMuted') === '1');

  // 活动播放器句柄与「期望增益」都放 ref：音量/静音变化只经独立 effect 施加到现有播放器，
  // 绝不进入连接 effect 的依赖，否则拖动音量会误触发整条 RDP 会话重建。
  const audioPlayerRef = useRef<AudioPlayer | null>(null);
  const effectiveGainRef = useRef(muted ? 0 : volume);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const gain = muted ? 0 : volume;
    effectiveGainRef.current = gain;
    audioPlayerRef.current?.setVolume(gain);
    try {
      localStorage.setItem('pandaterm.rdpVolume', String(volume));
      localStorage.setItem('pandaterm.rdpMuted', muted ? '1' : '0');
    } catch {
      // 隐私模式等存储失败可忽略，音量仍在本会话内生效。
    }
  }, [volume, muted]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    setStatus('connecting');
    setErrorMsg('');

    let renderer: Renderer;
    try {
      renderer = createRenderer(canvas);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus('error');
      setErrorMsg(msg);
      onErrorRef.current?.(msg);
      return;
    }

    let disposed = false;
    let dirty = false;
    let connected = false;
    let rafId = 0;
    let pendingInputs: RdpInputEvent[] = [];
    let clipboardPollTimer = 0;
    let clipboardEpoch = 0;
    let lastClipboardText: string | null = null;
    const audioPlayer = createAudioPlayer(effectiveGainRef.current);
    audioPlayerRef.current = audioPlayer;

    // 输入入队而非逐事件 invoke：事件按发生顺序进队，连续 mouseMove 做队尾合并只留最新一条，
    // 整队在 rAF 里一次性批量上行。与下行画面的 Channel 批量对称，把 N 次 invoke 压成 1 次。
    const queueInput = (event: RdpInputEvent) => {
      if (disposed || !connected) return;
      if (event.kind === 'mouseMove') {
        const tail = pendingInputs[pendingInputs.length - 1];
        if (tail && tail.kind === 'mouseMove') {
          pendingInputs[pendingInputs.length - 1] = event;
          return;
        }
      }
      pendingInputs.push(event);
    };

    const flushInputs = () => {
      if (pendingInputs.length === 0) return;
      const batch = pendingInputs;
      pendingInputs = [];
      void rdpInputBatch(terminalId, batch).catch(() => undefined);
    };

    /** 把本地剪贴板送往远程。force=true 用于用户主动粘贴（允许重复发送同一内容）。
     *  不再做后台定时轮询：否则在用户无感知的情况下，本地复制的密码/令牌会被自动推送给远程主机。 */
    const sendLocalClipboard = async (force: boolean) => {
      if (disposed || !connected) return;
      const startedAtEpoch = clipboardEpoch;
      try {
        const text = await readText();
        if (disposed || !connected || startedAtEpoch !== clipboardEpoch) return;
        if (text.length * 2 + 2 > MAX_CLIPBOARD_BYTES) return;
        if (!force && text === lastClipboardText) return;
        lastClipboardText = text;
        queueInput({ kind: 'clipboard', text });
      } catch {
        // 系统剪贴板可能被其他进程短暂占用，忽略本次
      }
    };

    const applyRemoteClipboard = (text: string) => {
      if (text === lastClipboardText) return;
      // 使已在途的本地 readText 结果失效，避免旧内容覆盖刚收到的远端文本。
      clipboardEpoch += 1;
      lastClipboardText = text;
      void writeText(text).catch(() => undefined);
    };

    const loop = () => {
      if (disposed) return;
      flushInputs();
      if (dirty) {
        dirty = false;
        renderer.draw();
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    const channel = new Channel<unknown>();
    channel.onmessage = (msg) => {
      if (disposed) return;
      const buf = toArrayBuffer(msg);
      if (!buf) return;
      const frameType = new DataView(buf).getUint8(0);
      if (frameType === FRAME_ERROR) {
        const text = new TextDecoder().decode(new Uint8Array(buf, 1));
        connected = false;
        setStatus('error');
        setErrorMsg(text);
        onErrorRef.current?.(text);
        return;
      }
      if (frameType === FRAME_DISCONNECT) {
        const text = new TextDecoder().decode(new Uint8Array(buf, 1));
        connected = false;
        setStatus('disconnected');
        setErrorMsg(text);
        return;
      }
      if (frameType === FRAME_CLIPBOARD) {
        const text = new TextDecoder().decode(new Uint8Array(buf, 1));
        applyRemoteClipboard(text);
        return;
      }
      if (frameType === FRAME_AUDIO) {
        if (buf.byteLength <= AUDIO_HEADER_LEN) return;
        const head = new DataView(buf);
        const channels = head.getUint16(1, true);
        const sampleRate = head.getUint32(3, true);
        const bitsPerSample = head.getUint16(7, true);
        audioPlayer.push(channels, sampleRate, bitsPerSample, new Uint8Array(buf, AUDIO_HEADER_LEN));
        return;
      }
      if (applyFrame(renderer, buf)) dirty = true;
    };

    // 客户端坐标 -> 桌面像素。canvas 走 objectFit:contain 会 letterbox，
    // 按等比缩放后的实际绘制矩形反算，并裁剪到桌面范围内。
    const toDesktop = (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      const dw = canvas.width;
      const dh = canvas.height;
      if (rect.width <= 0 || rect.height <= 0 || dw <= 0 || dh <= 0) {
        return { x: 0, y: 0 };
      }
      const scale = Math.min(rect.width / dw, rect.height / dh);
      const drawW = dw * scale;
      const drawH = dh * scale;
      const offX = (rect.width - drawW) / 2;
      const offY = (rect.height - drawH) / 2;
      const px = (clientX - rect.left - offX) / scale;
      const py = (clientY - rect.top - offY) / scale;
      return {
        x: Math.max(0, Math.min(dw - 1, Math.round(px))),
        y: Math.max(0, Math.min(dh - 1, Math.round(py))),
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      const pos = toDesktop(e.clientX, e.clientY);
      queueInput({ kind: 'mouseMove', x: pos.x, y: pos.y });
    };
    const onPointerDown = (e: PointerEvent) => {
      canvas.focus();
      const pos = toDesktop(e.clientX, e.clientY);
      queueInput({ kind: 'mouseMove', x: pos.x, y: pos.y });
      queueInput({ kind: 'mouseButton', button: e.button, pressed: true });
    };
    const onPointerUp = (e: PointerEvent) => {
      queueInput({ kind: 'mouseButton', button: e.button, pressed: false });
    };
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
      const raw = vertical ? e.deltaY : e.deltaX;
      if (raw === 0) return;
      // web 向下/右为正，RDP 相反；一个 notch≈120 单位，clamp 到 i16。
      const units = Math.max(-32768, Math.min(32767, Math.round(-raw / 100) * 120));
      if (units === 0) return;
      queueInput({ kind: 'wheel', vertical, delta: units });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // 粘贴：仅在用户主动按下 Ctrl/Cmd+V（或 Shift+Insert）时才把本地剪贴板送往远程；
      // 按键本身照常下发，由远程应用决定如何粘贴。
      const isPaste = ((e.ctrlKey || e.metaKey) && !e.altKey
        && (e.code === 'KeyV' || e.key === 'v' || e.key === 'V'))
        || (e.shiftKey && e.code === 'Insert');
      if (isPaste) void sendLocalClipboard(true);

      const scancode = codeToScancode(e.code);
      if (scancode === undefined) return;
      e.preventDefault();
      queueInput({ kind: 'key', scancode, pressed: true });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const scancode = codeToScancode(e.code);
      if (scancode === undefined) return;
      e.preventDefault();
      queueInput({ kind: 'key', scancode, pressed: false });
    };
    const onBlur = () => {
      queueInput({ kind: 'releaseAll' });
    };

    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('blur', onBlur);

    // 动态 resize：面板尺寸变化时防抖发 Resize 事件。后端注册 DisplayControl DVC 后
    // 会驱动重激活并回推新 DesktopInit 帧；未注册时 encode_resize 返回 None，安全空操作。
    let resizeTimer = 0;
    let lastW = 0;
    let lastH = 0;
    const observer = new ResizeObserver(() => {
      if (disposed || !connected) return;
      const { width, height } = resolutionToDesktopSize(container, resolution);
      if (width === lastW && height === lastH) return;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (disposed || !connected) return;
        lastW = width;
        lastH = height;
        queueInput({ kind: 'resize', width, height });
      }, 300);
    });

    const initial = resolutionToDesktopSize(container, resolution);
    rdpConnect(sessionId, terminalId, initial.width, initial.height, quality, channel)
      .then((result) => {
        if (disposed) return;
        renderer.resize(result.width, result.height);
        dirty = true;
        connected = true;
        lastW = result.width;
        lastH = result.height;
        setStatus('connected');
        observer.observe(container);
      })
      .catch((e) => {
        if (disposed) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus('error');
        setErrorMsg(msg);
        onErrorRef.current?.(msg);
      });

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(resizeTimer);
      window.clearInterval(clipboardPollTimer);
      audioPlayer.close();
      audioPlayerRef.current = null;
      cancelAnimationFrame(rafId);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('blur', onBlur);
      void rdpDisconnect(terminalId).catch(() => undefined);
      renderer.dispose();
    };
  }, [sessionId, terminalId, reconnectNonce, resolution, quality]);

  const sendFilePaths = (paths: string[]) => {
    const acceptedPaths = paths.filter(Boolean).slice(0, 256);
    if (status !== 'connected' || acceptedPaths.length === 0) return;

    canvasRef.current?.focus();
    const pasteEvents: RdpInputEvent[] = [{ kind: 'fileDrop', paths: acceptedPaths }];
    const ctrl = codeToScancode('ControlLeft');
    const keyV = codeToScancode('KeyV');
    if (ctrl !== undefined && keyV !== undefined) {
      pasteEvents.push(
        { kind: 'key', scancode: ctrl, pressed: true },
        { kind: 'key', scancode: keyV, pressed: true },
        { kind: 'key', scancode: keyV, pressed: false },
        { kind: 'key', scancode: ctrl, pressed: false },
      );
    }
    setFileDropMessage(`正在传输 ${acceptedPaths.length} 个所选项目到远程当前焦点位置`);
    void rdpInputBatch(terminalId, pasteEvents)
      .then(() => window.setTimeout(() => setFileDropMessage(''), 2500))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setFileDropMessage(`文件传输失败：${message}`);
        onErrorRef.current?.(message);
      });
  };

  const chooseRemotePaths = async (directory: boolean) => {
    if (status !== 'connected') return;
    try {
      const selected = await openFileDialog({
        multiple: true,
        directory,
        title: directory ? '选择要发送到远程桌面的目录' : '选择要发送到远程桌面的文件（可多选）',
      });
      const paths = selected === null ? [] : Array.isArray(selected) ? selected : [selected];
      sendFilePaths(paths);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileDropMessage(`选择${directory ? '目录' : '文件'}失败：${message}`);
      onErrorRef.current?.(message);
    }
  };

  return (
    <div className="rdp-view" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="rdp-canvas"
        tabIndex={0}
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', outline: 'none' }}
      />
      <div className="rdp-toolbar">
        <label>
          分辨率
          <select value={resolution} onChange={(e) => setResolution(e.target.value as RdpResolution)}>
            {RESOLUTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          画质
          <select value={quality} onChange={(e) => setQuality(e.target.value as RdpQuality)}>
            {QUALITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="rdp-file-send-button"
          title="选择一个或多个文件发送到远程桌面"
          onClick={() => void chooseRemotePaths(false)}
          disabled={status !== 'connected'}
        >
          <FileUp size={15} />
          发送文件
        </button>
        <button
          type="button"
          className="rdp-file-send-button"
          title="选择目录并保留目录结构发送到远程桌面"
          onClick={() => void chooseRemotePaths(true)}
          disabled={status !== 'connected'}
        >
          <FolderUp size={15} />
          发送目录
        </button>
        <div className="rdp-volume">
          <button
            type="button"
            className="rdp-volume-toggle"
            title={muted ? '取消静音' : '静音'}
            aria-label={muted ? '取消静音' : '静音'}
            onClick={() => setMuted((m) => !m)}
          >
            {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round((muted ? 0 : volume) * 100)}
            title="音量"
            aria-label="音量"
            onChange={(e) => {
              const next = Number(e.target.value) / 100;
              setVolume(next);
              if (next > 0 && muted) setMuted(false);
            }}
          />
        </div>
      </div>
      {fileDropMessage && (
        <div className="rdp-file-drop-message">{fileDropMessage}</div>
      )}
      {status !== 'connected' && (
        <div className="rdp-overlay">
          {status === 'connecting' && <span>正在连接远程桌面…</span>}
          {status === 'error' && (
            <div className="rdp-disconnect">
              <span>远程桌面已停止：{errorMsg}</span>
              <button type="button" onClick={() => setReconnectNonce((n) => n + 1)}>重新连接</button>
            </div>
          )}
          {status === 'disconnected' && (
            <div className="rdp-disconnect">
              <span>远程桌面会话已断开{errorMsg ? '：' + errorMsg : ''}</span>
              <button type="button" onClick={() => setReconnectNonce((n) => n + 1)}>重新连接</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default RdpView;
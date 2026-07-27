import { useEffect, useRef, useState } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { rdpConnect, rdpDisconnect, rdpInput } from './api';
import type { RdpInputEvent } from './api';
import { codeToScancode } from './scancode';

// 帧二进制协议常量：必须与后端 src-tauri/src/rdp.rs 完全一致（多字节小端）。
//   DesktopInit(type=0): [0]=0 [1..3]=width [3..5]=height
//   Tile(type=1):        [0]=1 [1..3]=x [3..5]=y [5..7]=w [7..9]=h [9..]=RGBA
const FRAME_DESKTOP_INIT = 0;
const FRAME_TILE = 1;
const FRAME_ERROR = 3;
const FRAME_DISCONNECT = 4;
const TILE_HEADER_LEN = 9;

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

// 解析单帧并驱动渲染器。返回 true 表示画面有变化、需要重绘。
function applyFrame(renderer: Renderer, buf: ArrayBuffer): boolean {
  const view = new DataView(buf);
  const frameType = view.getUint8(0);
  if (frameType === FRAME_DESKTOP_INIT) {
    renderer.resize(view.getUint16(1, true), view.getUint16(3, true));
    return true;
  }
  if (frameType === FRAME_TILE) {
    const x = view.getUint16(1, true);
    const y = view.getUint16(3, true);
    const w = view.getUint16(5, true);
    const h = view.getUint16(7, true);
    const px = new Uint8Array(buf, TILE_HEADER_LEN, w * h * 4);
    renderer.uploadTile(x, y, w, h, px);
    return true;
  }
  return false;
}

type RdpStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

type RdpViewProps = {
  sessionId: string;
  terminalId: string;
  onError?: (message: string) => void;
};

// 把面板 CSS 尺寸换算成请求给服务器的桌面像素：乘 devicePixelRatio 取物理像素以求最清晰，
// 再按后端 clamp_desktop_size 同样的约束（200..=8192，宽度偶数）预规整，避免无谓往返。
function panelToDesktopSize(el: HTMLElement): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  const clamp = (v: number) => Math.max(200, Math.min(8192, Math.round(v)));
  const width = clamp(el.clientWidth * dpr) & ~1;
  const height = clamp(el.clientHeight * dpr);
  return { width, height };
}

export function RdpView({ sessionId, terminalId, onError }: RdpViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<RdpStatus>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

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
    let pendingMove: { x: number; y: number } | null = null;

    const sendInput = (event: RdpInputEvent) => {
      if (disposed || !connected) return;
      void rdpInput(terminalId, event).catch(() => undefined);
    };

    const loop = () => {
      if (disposed) return;
      if (pendingMove) {
        const { x, y } = pendingMove;
        pendingMove = null;
        sendInput({ kind: 'mouseMove', x, y });
      }
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
      if (new DataView(buf).getUint8(0) === FRAME_ERROR) {
        const text = new TextDecoder().decode(new Uint8Array(buf, 1));
        connected = false;
        setStatus('error');
        setErrorMsg(text);
        onErrorRef.current?.(text);
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
      pendingMove = toDesktop(e.clientX, e.clientY);
    };
    const onPointerDown = (e: PointerEvent) => {
      canvas.focus();
      const pos = toDesktop(e.clientX, e.clientY);
      pendingMove = null;
      sendInput({ kind: 'mouseMove', x: pos.x, y: pos.y });
      sendInput({ kind: 'mouseButton', button: e.button, pressed: true });
    };
    const onPointerUp = (e: PointerEvent) => {
      sendInput({ kind: 'mouseButton', button: e.button, pressed: false });
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
      sendInput({ kind: 'wheel', vertical, delta: units });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const scancode = codeToScancode(e.code);
      if (scancode === undefined) return;
      e.preventDefault();
      sendInput({ kind: 'key', scancode, pressed: true });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const scancode = codeToScancode(e.code);
      if (scancode === undefined) return;
      e.preventDefault();
      sendInput({ kind: 'key', scancode, pressed: false });
    };
    const onBlur = () => {
      sendInput({ kind: 'releaseAll' });
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
      const { width, height } = panelToDesktopSize(container);
      if (width === lastW && height === lastH) return;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (disposed || !connected) return;
        lastW = width;
        lastH = height;
        sendInput({ kind: 'resize', width, height });
      }, 300);
    });

    const initial = panelToDesktopSize(container);
    rdpConnect(sessionId, terminalId, initial.width, initial.height, channel)
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
  }, [sessionId, terminalId]);

  return (
    <div className="rdp-view" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="rdp-canvas"
        tabIndex={0}
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', outline: 'none' }}
      />
      {status !== 'connected' && (
        <div className="rdp-overlay">
          {status === 'connecting' && <span>正在连接远程桌面…</span>}
          {status === 'error' && <span>远程桌面已停止：{errorMsg}</span>}
        </div>
      )}
    </div>
  );
}

export default RdpView;
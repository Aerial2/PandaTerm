# PandaTerm 长期记忆 / 项目约定

跨会话稳定约定，避免重复踩坑。具体细节与每日进展见 `YYYY-MM-DD.md`。

## 1. Tauri 应用禁止 HTML5 原生 drag-and-drop
- 页面内元素拖拽（终端 tab/面板、连接列表行、表头列宽 resize）：一律用 **pointer events 自行实现**（pointerdown/move/up + setPointerCapture），勿用 `draggable`/`onDragStart`。Tauri webview 下原生拖拽会显示禁止光标且拖不动。
- 从系统拖文件进窗口：已在 `tauri.conf.json` 设 `dragDropEnabled: false` + 顶层 `onDragOver` preventDefault 消除 forbidden-cursor。
- 连接列表行拖拽里"当前悬停目标"这类随移动变化的值必须放 ref（如 `connectionDragRef.current.targetId`），不能在 `onUp` 闭包里读过期 state。

## 2. SSH 写入通道必须 split + 并发排空输出窗口（大文件上传死锁）
- 现象：>~2MB 文件上传卡死在约 2.0MB（`data()` 永久挂起）。
- 根因：OpenSSH 在 ~2MB 初始窗口处，若 server→client 输出窗口不被消费，会停止通告输入 WINDOW_ADJUST，导致 `data()` 挂起。
- 修复模式（所有 `cat > path` 写入通道都必须遵守，新增时也务必沿用）：
  1. `let (mut reader, writer) = channel.split();`
  2. `tokio::spawn` 一个 reader 任务，`while let Some(msg) = reader.wait().await` 循环里**丢弃** `Data`/`ExtendedData`、捕获 `ExitStatus`、遇 `Close` break。
  3. 上传循环用 `writer.data(chunk).await`，结束 `writer.eof()` + `writer.close()`，再 `read_task.await` 取 exit_code。
- 涉及函数：`stream_upload_file`（流式上传，已修）、`write_remote_file_content`（base64 降级路径 / 编辑器保存，曾漏修，已补）。`write_remote_file_content` 用内存 `content` 分块写，`stream_upload_file` 从本地文件读分块写。
- 前端 `uploadFiles` 仅 `!local && terminalId && localPath` 时走流式 `uploadLocalFile`；其它（拖放无本地路径文件）走 `uploadFile` base64 降级 → 同样必须健壮。

## 3. 连接管理表格（ConnectionWindow.tsx）
- 列宽用 localStorage 持久化（key=`pandaterm.connColumnWidths`），属纯 UI 偏好不进后端；最新值放 `connColumnWidthsRef`，`onUp` 松手时一次性写入。

## 4. 构建 / 运行（重要，已因此误判过"修复无效"）
- 改 **Rust 后端（src-tauri）** 后必须重启 `npm run tauri dev`（会重新 `cargo build` Rust）才生效。
- `npm run dev` 只热更新前端 Vite，**不触及 Rust**；只重启前端 = 后端还是旧 binary，改了也白改（曾因此误以为上传死锁修复无效，实则没重编）。
- 若 `tauri dev` 未自动重编，彻底 `Ctrl+C` 关掉再重跑，确认编译日志出现 `Compiling pandaterm` / `Finished`。
- 判断"改动是否真生效"的快捷法：看运行时是否用了新 binary；必要时在 `src-tauri` 跑 `cargo build` 显式编译验证。
- **cargo target 目录**：项目 `.cargo/config.toml` 设 `target-dir = "F:/cargo-targets/PandaTerm"`（按项目隔离，用户 2026-09-09 确认保持此方案）。
  - 旧缓存（2026-08-28 编译，含 `pandaterm.exe`）在 `F:/cargo-targets/debug`，**无 PandaTerm 子层，不会被复用** → 2026-09-09 起首次编译为全量重编，之后增量正常。
  - F 盘剩余约 335GB，空间充足，不必担心编译产物体积。
- **助手侧跑 cargo 的正确姿势（2026-09-09 实测）**：`C:\Users\24901\.cargo\bin\cargo.exe` 是 **ReparsePoint 符号链接**（Length=0），沙箱执行它报 "untrusted mount point"（cmd 报 cannot execute）。**并非不能编译**。
  - 绕过：直接执行真实二进制 `C:\Users\24901\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin\cargo.exe`（cargo 1.95.0，正常可用）。
  - 前提：先把该 toolchain bin 加进 PATH。项目启用了 sccache（RUSTC_WRAPPER），PATH 里没有 rustc 会报 `sccache: cannot find binary path`。
  - 长任务会被自动转后台/跳过：改用 `Start-Process` 重定向输出到日志文件，再用 read_file 轮询结果。
- **编译前必须关闭运行中的 pandaterm.exe**：否则 `error: failed to remove file F:/cargo-targets\debug\pandaterm.exe … 拒绝访问 (os error 5)`（代码其实已编译过，只卡在替换二进制）。用 `taskkill /F /IM pandaterm.exe`。
- **target-dir 实际由环境变量决定**：存在用户级 `CARGO_TARGET_DIR=F:/cargo-targets`，**优先级高于**项目 `.cargo/config.toml` 的 `F:/cargo-targets/PandaTerm`，故产物仍落在 `F:/cargo-targets/debug`，可复用 2026-08-28 缓存（增量很快：check 2.2s、build 6.6s）。
- **rustup shim 损坏 + PATH 修复（2026-09-09）**：`C:\Users\24901\.cargo\bin` 下 13 个 shim（`cargo.exe`/`rustc.exe`/`rustfmt.exe`/`rust-analyzer.exe` 等）**全是 0 字节坏符号链接**（`Archive, ReparsePoint`），只有 `rustup.exe`、`sccache.exe` 是真实文件。
  - 症状：`npm run tauri dev` 报 `failed to run 'cargo metadata' … program not found`（重启应用无效，这是环境问题）。
  - 已修：把真实的 `C:\Users\24901\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin` 加到**用户 PATH 首位**（cargo/rustc 1.95.0 实测可用）。
  - 注意：`.cargo\bin` 不可依赖；IDE 的 rust-analyzer 若失效，根源是同目录 `rust-analyzer.exe` 坏链接，需硬链接到 toolchain 或重装 rustup。
  - 改完用户 PATH 后**必须重开终端**才生效（环境变量在进程启动时读取）。
- **`tauri dev` 与手动 `cargo build` 的 target 目录、features 都不同（2026-09-09 实测）**：
  - `tauri dev` 走 `cargo run --no-default-features`，产物落在 `F:/cargo-targets/PandaTerm/debug`（项目 `.cargo/config.toml` 的隔离目录**确实生效**）。
  - 手动 `cargo build` 走默认 features 且受 `CARGO_TARGET_DIR=F:/cargo-targets` 影响，产物落在 `F:/cargo-targets/debug`。
  - 两者**缓存不通用**：手动编译只要几秒，不代表 `tauri dev` 快——首次 `tauri dev` 会全量编译（实测 757 crates，2 分 36 秒）；之后该目录有缓存就变增量。
  - 验证"改动能否跑起来"必须以 `tauri dev` 实际启动为准，不能只看手动 `cargo check/build`。
- **PowerShell profile 已修（2026-09-09）**：`C:\Users\24901\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1` 原本只有一行 `fnm env --use-on-cd ...`，而 fnm 不存在 → 每次开终端必报错。
  - 已改为：`fnm` 加 `Get-Command` 存在性判断（不再报错）+ 自动把 `C:\Users\24901\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin` 加进 `$env:Path`（带 `-notlike` 判断避免重复累加）。
  - 原文件备份为同目录 `.bak`。
  - **关键坑**：改用户级 PATH 后，若 IDE 未重启，它新建的终端标签页仍继承 IDE 的旧环境（继续报 `program not found`）。**改 profile 可绕过此限制，无需重启 IDE**。

## 5. Monaco 编辑器 model 必须全局共享复用（分屏多实例）
- `EditorPanel` 的 model URI 只由 `tabId` 决定（`tabModelUri()`，scheme `pandaterm-tab`），**全局唯一**。
- 分屏时 App.tsx 的 `showWorkspaceChips = isWorkspacePane || (showEditor && activePaneId === node.tabId)` 会让**两个 pane 同时挂载 EditorPanel**，共享同一份 `editorTabs` / `activeEditorTabId` → 同一 tabId → 同一 URI。
- **禁止**在 `ensureModel` 里 dispose 已存在的同 URI model（旧代码把它当 stale 销毁）：会销毁另一个面板正在使用的 model，导致那个面板**空白**。
- 正确做法：`monaco.editor.getModel(uri)` 命中且未 dispose 就**直接复用**并记入本实例 `modelsRef`；仅当不存在时才 `createModel`。多实例共享同一 model，内容天然同步。
- 模块级 `editorViewStateByTabId` 同为全局共享，多实例下滚动/光标位置会互相覆盖（目前按"同步视图"接受）。

## 6. UI 配色 / 圆角约定（用户偏好，2026-09-10）
- **选中态禁止蓝色**：应用整体是灰系（`--ai-fg: #B3B4B4`、`--ai-fg-rgb: 179, 180, 180`，`--ai-bg: #1D2025`）。选中/激活一律用中性灰：
  - 轻量项（左侧导航、账号 chip）：`background: rgba(var(--ai-fg-rgb), 0.14)` + 文字 `var(--text-primary)`；
  - 带边框项（ghost 按钮）：`border-color: rgba(var(--ai-fg-rgb), 0.35)` + `background: rgba(var(--ai-fg-rgb), 0.1)`；
  - 分段控件（MCP pane tab）：容器 `#` 圆角 9px + `rgba(255,255,255,0.04)`，选中项 `background: #303640; color: #B3B4B4`。
  - 禁止使用 `rgba(88, 166, 255, ...)`（GitHub 蓝）之类的高亮色。
- **圆角"一点点"**：控件 8px（输入框/按钮/nav 项/chip/图标按钮）、容器 9-10px；不用 999px 胶囊，除非设计上明确要胶囊（如 MCP 策略标签）。
- 相关文件：`apps/desktop-ui/src/styles.css`（`:root` 变量 + `.ai-settings-*` 系列）。

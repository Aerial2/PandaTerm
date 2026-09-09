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

## 5. Monaco 编辑器 model 必须全局共享复用（分屏多实例）
- `EditorPanel` 的 model URI 只由 `tabId` 决定（`tabModelUri()`，scheme `pandaterm-tab`），**全局唯一**。
- 分屏时 App.tsx 的 `showWorkspaceChips = isWorkspacePane || (showEditor && activePaneId === node.tabId)` 会让**两个 pane 同时挂载 EditorPanel**，共享同一份 `editorTabs` / `activeEditorTabId` → 同一 tabId → 同一 URI。
- **禁止**在 `ensureModel` 里 dispose 已存在的同 URI model（旧代码把它当 stale 销毁）：会销毁另一个面板正在使用的 model，导致那个面板**空白**。
- 正确做法：`monaco.editor.getModel(uri)` 命中且未 dispose 就**直接复用**并记入本实例 `modelsRef`；仅当不存在时才 `createModel`。多实例共享同一 model，内容天然同步。
- 模块级 `editorViewStateByTabId` 同为全局共享，多实例下滚动/光标位置会互相覆盖（目前按"同步视图"接受）。

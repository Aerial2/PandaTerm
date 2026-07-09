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

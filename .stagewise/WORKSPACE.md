# PandaTerm Workspace

## SNAPSHOT

type: monorepo  
langs: Rust, TypeScript  
runtimes: Rust, Node.js  
pkgManager: cargo, npm  
deliverables: Desktop app (Tauri), local/remote terminal, SSH client  
rootConfigs: `Cargo.toml`, `Cargo.lock`, `package.json`, `src-tauri/tauri.conf.json`

---

## PACKAGES

| name | path | type | deps | usedBy | role |
|------|------|------|------|--------|------|
| panda-core | crates/panda-core | lib | panda-session | pandaterm | SSH client trait, terminal events, size |
| panda-session | crates/panda-session | lib | — | panda-core,pandaterm | Session data, auth types, validation |
| panda-crypto | crates/panda-crypto | lib | — | (future) | Secret/credential store (stub) |
| pandaterm | src-tauri | app | panda-core,panda-session | desktop-ui | Tauri backend, SSH conn, local PTY |
| desktop-ui | apps/desktop-ui | app | @tauri-apps/api,xterm,React | — | Terminal UI, file browser, session mgr |

---

## DEPENDENCY GRAPH

pandaterm → panda-core, panda-session  
panda-core → panda-session  
desktop-ui → @tauri-apps/api, @xterm/xterm

---

## ARCHITECTURE

### pandaterm (`src-tauri/src/main.rs`)

entry: `fn main()` (line 1119)  
terminal: local PTY (portable-pty, platform-specific cmd/bash), remote SSH2 (ssh2 crate)  
sessions: persistent JSON store (XDirState), XShell ini import  
api: Tauri commands (async) → ipc to desktop-ui  
state: `Arc<AppState>` holds active sessions map (uuid → RemoteTerminalSession or LocalTerminalSession)  
auth: SSH auth methods (password, private key, keyboard-interactive, gssapi, agent)  
dirs:  
  `src-tauri/src/` → main backend  
  `src-tauri/build.rs` → Tauri build script  
  `src-tauri/icons/` → app icons  

key commands (Tauri):  
  `local_terminal_start|input|resize|stop|write` → PTY management  
  `list_sessions|save_session|connect_session|disconnect_session|terminal_write|terminal_resize` → SSH management  
  `list_local_directory|read_local_file_preview` → file browsing  

### panda-core (`crates/panda-core/src/lib.rs`)

exports:  
  `SshClient` trait (async connect|write|disconnect, state query)  
  `TerminalEvent` (session_id, kind: Connected|Output|Error|Disconnected, payload)  
  `ConnectRequest`, `TerminalSize` (cols, rows)  
  `MockSshClient` for testing  
  `ConnectionState` enum  

### panda-session (`crates/panda-session/src/lib.rs`)

exports:  
  `Session` (id, name, group, host, port, username, auth, tags, last_connected_at, reconnect)  
  `AuthType` (Password, PrivateKey, KeyboardInteractive, Gssapi, Agent)  
  `ReconnectPolicy` (enabled, max_attempts, delay_ms)  
  `SessionCatalog` (in-memory: search, upsert, all)  
  `validate_session()`, `demo_sessions()`  

### panda-crypto (`crates/panda-crypto/src/lib.rs`)

exports:  
  `SecretRef` (id, scope: Password|PrivateKey|Passphrase)  
  `SecretStore` trait (get, put, delete)  
  `NoopSecretStore` stub implementation  

### desktop-ui (`apps/desktop-ui/`)

entry: `src/main.tsx` → ReactDOM.render(App)  
framework: React 19, Vite 6, TypeScript 5.7  
routing: tab-based (local terminal, remote terminals, create connection)  
state: React hooks (tabs, sessions, activeTab, resources, forms)  
ui: xterm.js terminal emulator, file browser panel, session manager  
styling: Tailwind CSS, custom xterm theme (oneDarkProTerminal)  
api: `api.ts` wraps Tauri invocations (list_sessions, connect_session, startLocalTerminal, etc.)  
dirs:  
  `src/App.tsx` → main component (1398 lines, terminal + file browser + session mgr)  
  `src/api.ts` → Tauri IPC wrappers  
  `src/main.tsx` → React root  
  `src/styles.css` → global styling  

key ui features:  
  terminal tab management (local, per-session remote)  
  file browser: list dir, preview file, sort (name|size|time), search  
  connection form: host, port, username, auth method dropdown  
  breadcrumb nav, cwd tracking, command history  

---

## STACK

`pandaterm` → framework: Tauri 2.2.5, terminal: ssh2 + portable-pty, auth: ssh2, runtime: tokio, logging: tracing  
`panda-core` → async: async-trait, serialize: serde  
`panda-session` → serialize: serde, error: thiserror, time: chrono  
`desktop-ui` → framework: React 19, bundler: Vite 6, terminal-ui: xterm.js 0.11, icons: lucide-react, style: Tailwind CSS 3.4  

shared workspace deps: async-trait, chrono, serde, serde_json, thiserror, tokio (multi-thread+macros+sync+time), tracing, uuid (v4+serde)

---

## STYLE

- error: Rust uses `thiserror` + `SshError`/`SessionError`/`TransferError` enums; IPC returns `Result<T, String>` (String on error)
- serialization: `#[derive(Serialize, Deserialize)]` on all public types, `serde_json` for IPC payloads
- async: `async fn` + `await` pervasive; `tokio` runtime; `async-trait` for trait methods
- naming: snake_case functions, CamelCase types, UUID for all IDs
- imports: workspace deps resolved via `[workspace.dependencies]`, local crates path-based
- state: arc-wrapped (pandaterm), React hooks (desktop-ui)
- types: strong enums for status/direction/auth, Option/Result everywhere
- logging: `tracing` macros, no println in release
- testing: `MockSshClient` in panda-core; no test files present yet

---

## STRUCTURE

`src-tauri/` → Tauri backend app  
`apps/desktop-ui/` → React frontend app  
`crates/panda-core/` → SSH abstraction + types  
`crates/panda-session/` → session model + catalog  
`crates/panda-crypto/` → secret management stubs  
`target/` → Rust build artifacts (excluded)  
`node_modules/` → npm deps (excluded)  

---

## BUILD

workspaceScripts:
  `npm run dev` → Tauri dev (frontend dev server + Tauri runtime)  
  `npm run build` → Tauri build (tsc + vite build desktop-ui, bundle app)  
  `npm run tauri` → Tauri CLI proxy  

desktop-ui scripts:
  `npm run dev` → `vite --host 127.0.0.1 --port 1420`  
  `npm run build` → `tsc && vite build`  
  `npm run preview` → preview built output  

envFiles: .env (listed in .gitignore, not in repo)  
envPrefixes: none observed  
ci: src-tauri/tauri.conf.json (window 1280×820, icons, frontendDist=../apps/desktop-ui/dist)  
docker: none  

---

## LOOKUP

add remote SSH endpoint → `src-tauri/src/main.rs::connect_session`, `crates/panda-core/src/lib.rs::SshClient`  
add local shell command → `src-tauri/src/main.rs::run_local_shell_command`, `run_windows_shell_command`, `run_unix_shell_command`  
add terminal output event → `src-tauri/src/main.rs::emit_terminal_output`, `panda-core::TerminalEvent`  
add session auth type → `crates/panda-session/src/lib.rs::AuthType`  
add UI tab → `apps/desktop-ui/src/App.tsx::WorkspaceTab`, terminal state hooks  
add Tauri command → `src-tauri/src/main.rs::fn command_name()` + `#[tauri::command]`  
add frontend route → `apps/desktop-ui/src/App.tsx` tab switch logic  

---

## KEY FILES

`src-tauri/src/main.rs` → Tauri backend entry, SSH2 connection, local PTY, session persistence, IPC handlers | read for: core command flow, terminal I/O, session management | affects: all IPC | related: panda-core, panda-session

`apps/desktop-ui/src/App.tsx` → React main component, terminal emulator, file browser, session manager UI | read for: tab management, terminal rendering, IPC call patterns, state hooks | affects: all UI | related: api.ts

`crates/panda-core/src/lib.rs` → SshClient trait, TerminalEvent, type defs | read for: connection abstraction, event shapes | affects: pandaterm, desktop-ui IPC contracts | related: panda-session

`crates/panda-session/src/lib.rs` → Session struct, AuthType, SessionCatalog | read for: session model, validation, auth enum variants | affects: pandaterm session load/save, desktop-ui forms | related: panda-core

`apps/desktop-ui/src/api.ts` → Tauri IPC wrappers, fallback values | read for: available commands, payload shapes, error handling | affects: App.tsx remote calls | related: src-tauri main.rs commands

`src-tauri/tauri.conf.json` → window config, bundle targets, icon paths | read to adjust: window size, app title, bundle settings | affects: desktop builds | related: Cargo.toml (version)

`package.json` (root) → npm workspace, Tauri CLI config | read for: build scripts, dev flow | affects: all builds | related: src-tauri/tauri.conf.json

`Cargo.toml` (root) → workspace members, shared dependencies | read for: crate versions, members list | affects: all Rust builds | related: each member Cargo.toml

`apps/desktop-ui/package.json` → frontend deps (React, xterm, Tailwind) | read for: frontend library versions | affects: desktop-ui build | related: apps/desktop-ui/src/

`src-tauri/Cargo.toml` → pandaterm deps (ssh2, portable-pty, encoding_rs) | read for: backend library versions | affects: src-tauri build | related: crates/ and shared workspace deps

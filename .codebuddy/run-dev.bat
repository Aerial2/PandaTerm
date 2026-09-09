@echo off
set "PATH=C:\Users\24901\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;%PATH%"
cd /d e:\Project\Rust\PandaTerm
call npm run tauri dev > "e:\Project\Rust\PandaTerm\.codebuddy\dev.log" 2>&1

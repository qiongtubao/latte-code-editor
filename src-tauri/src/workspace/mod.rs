//! 多工作区（multi-workspace）支持
//!
//! 设计目标：
//! - 单 Tauri 窗口内可同时打开多个 workspace（每个 workspace 对应一个项目根目录）
//! - 每个 workspace 拥有独立的：project_root、BufferManager、文件监听器、打开的 tab 列表
//! - 不同窗口可拥有不同的活动 workspace（支持「分离到新窗口」）
//! - workspace 列表持久化到 app_data_dir/state.json
//!
//! 隔离核心：所有需要按 workspace 隔离的命令，通过 `window: tauri::Window` 参数取
//! `window.label()`，在 WorkspaceRegistry 中查找当前窗口激活的 workspace id，再做路由。

pub mod commands;
pub mod persistence;
pub mod registry;
pub mod watcher;

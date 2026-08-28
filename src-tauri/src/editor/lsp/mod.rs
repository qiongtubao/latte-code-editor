//! LSP (Language Server Protocol) 客户端管理模块
//!
//! 负责：
//! - 管理 LSP 进程（启动、通信、关闭）
//! - 实现休眠/唤醒机制（核心特性）
//! - 提供补全、诊断、悬停、跳转等 LSP 功能
//! - 多语言 LSP 服务器支持

//! **当前整模块未接线**：命令未注册、client 仍是占位实现（见 client.rs 的
//! TODO）。编译器因此把其中多数条目报成 dead code；统一 allow 并说明原因，
//! 避免噪音淹没其它真实警告。打通 LSP 时应连同这条 allow 一起去掉。
#![allow(dead_code)]

pub mod client;
pub mod manager;
pub mod process;
pub mod languages;

// Re-exports for convenience
pub use manager::LspManager;

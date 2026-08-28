//! LSP (Language Server Protocol) 客户端管理模块
//!
//! 负责：
//! - 管理 LSP 进程（启动、通信、关闭）
//! - 实现休眠/唤醒机制（核心特性）
//! - 提供补全、诊断、悬停、跳转等 LSP 功能
//! - 多语言 LSP 服务器支持

pub mod client;
pub mod manager;
pub mod process;
pub mod languages;

// Re-exports for convenience
pub use manager::LspManager;

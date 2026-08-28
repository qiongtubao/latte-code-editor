//! LSP 进程管理
//!
//! 负责：
//! - 启动和管理 LSP 服务器进程
//! - 通过 stdio 与 LSP 服务器通信
//! - 进程生命周期管理（启动、停止、重启）

use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use tokio::sync::RwLock;

use super::languages::LspConfig;

/// LSP 进程状态
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LspProcessState {
    /// 未启动
    Stopped,
    /// 正在初始化
    Initializing,
    /// 正常运行中
    Running,
    /// 休眠态（内存压缩）
    Hibernated,
    /// 已停止（错误或手动关闭）
    Error(String),
}

/// LSP 进程实例（简化实现）
pub struct LspProcess {
    /// 配置
    config: LspConfig,
    /// 子进程
    process: Option<Child>,
    /// 当前状态
    state: Arc<RwLock<LspProcessState>>,
}

impl LspProcess {
    /// 创建新的 LSP 进程实例（尚未启动）
    pub fn new(config: LspConfig) -> Self {
        Self {
            config,
            process: None,
            state: Arc::new(RwLock::new(LspProcessState::Stopped)),
        }
    }
    
    /// 启动 LSP 服务器（简化实现）
    pub async fn start(&mut self, _project_root: &std::path::Path) -> Result<(), String> {
        // 更新状态为初始化中
        *self.state.write().await = LspProcessState::Initializing;
        
        // 构建命令
        let mut cmd = Command::new(&self.config.command[0]);
        if self.config.command.len() > 1 {
            cmd.args(&self.config.command[1..]);
        }
        
        // 设置 stdio
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        
        // 启动进程
        let process = cmd.spawn()
            .map_err(|e| format!("Failed to start LSP server '{}': {}", self.config.command[0], e))?;
        
        self.process = Some(process);
        
        // 更新状态为运行中
        *self.state.write().await = LspProcessState::Running;
        
        Ok(())
    }
    
    /// 获取当前状态
    pub async fn state(&self) -> LspProcessState {
        self.state.read().await.clone()
    }
    
    /// 停止 LSP 服务器
    pub async fn stop(&mut self) -> Result<(), String> {
        if let Some(mut process) = self.process.take() {
            process.kill().map_err(|e| format!("Failed to kill LSP process: {}", e))?;
        }
        *self.state.write().await = LspProcessState::Stopped;
        Ok(())
    }
    
    /// 休眠 LSP（释放内存但保持进程）
    pub async fn hibernate(&mut self) -> Result<(), String> {
        if !self.config.supports_hibernation {
            return Err("This LSP does not support hibernation".to_string());
        }
        
        // TODO: 实现实际的休眠逻辑
        *self.state.write().await = LspProcessState::Hibernated;
        Ok(())
    }
    
    /// 唤醒 LSP（从休眠态恢复）
    pub async fn wake(&mut self) -> Result<(), String> {
        if *self.state.read().await != LspProcessState::Hibernated {
            return Ok(());
        }
        
        // TODO: 实现实际的唤醒逻辑
        *self.state.write().await = LspProcessState::Running;
        Ok(())
    }
}

impl Drop for LspProcess {
    fn drop(&mut self) {
        // 确保进程被清理
        if let Some(mut process) = self.process.take() {
            let _ = process.kill();
        }
    }
}

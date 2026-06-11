//! LSP 管理器
//!
//! 职责：
//! - 管理多个语言的 LSP 客户端
//! - 按需启动/停止 LSP 服务器
//! - 实现休眠策略（长时间不使用自动休眠）
//! - 提供统一的 LSP 功能接口

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use lsp_types::{CompletionItem, Diagnostic, Hover, Location};

use super::client::LspClient;
use super::languages::{detect_language, get_lsp_config, Language};

/// LSP 状态信息（用于状态查询）
#[derive(Debug, Clone, serde::Serialize)]
pub struct LspStatus {
    /// 语言类型
    language: String,
    /// 当前状态
    state: String,
    /// 项目根目录
    project_root: String,
    /// 是否支持休眠
    supports_hibernation: bool,
}

impl LspStatus {
    pub fn language(&self) -> &str { &self.language }
    pub fn state(&self) -> &str { &self.state }
    pub fn project_root(&self) -> &str { &self.project_root }
    pub fn supports_hibernation(&self) -> bool { self.supports_hibernation }
}

/// LSP 管理器
pub struct LspManager {
    /// LSP 客户端映射（语言 -> 客户端）
    clients: Arc<RwLock<HashMap<Language, Arc<LspClient>>>>,
    /// 工作区根目录
    workspace_root: PathBuf,
}

impl LspManager {
    /// 创建新的 LSP 管理器
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            workspace_root,
        }
    }
    
    /// 为指定语言启动 LSP 服务器
    pub async fn start_for_language(&self, language: Language) -> Result<(), String> {
        let config = get_lsp_config(&language)
            .ok_or_else(|| format!("No LSP config for language: {:?}", language))?;
        
        // 检查是否已启动
        let clients = self.clients.read().await;
        if clients.contains_key(&language) {
            return Ok(()); // 已存在，无需重复启动
        }
        
        // 创建并启动客户端
        let client = Arc::new(LspClient::new(language.clone(), config, self.workspace_root.clone()));
        client.start().await?;
        
        // 注册到映射
        self.clients.write().await.insert(language, client);
        
        Ok(())
    }
    
    /// 为指定文件启动合适的 LSP 服务器
    pub async fn start_for_file(&self, file_path: &Path) -> Result<(), String> {
        let language = detect_language(file_path);
        if language == Language::Unknown {
            return Err("Unknown language, cannot start LSP".to_string());
        }
        
        self.start_for_language(language).await
    }
    
    /// 停止指定语言的 LSP 服务器
    pub async fn stop_for_language(&self, language: &Language) -> Result<(), String> {
        let clients = self.clients.read().await;
        let client = clients.get(language)
            .ok_or_else(|| format!("LSP for {:?} not running", language))?;
        
        client.stop().await?;
        self.clients.write().await.remove(language);
        
        Ok(())
    }
    
    /// 停止所有 LSP 服务器
    pub async fn stop_all(&self) -> Result<(), String> {
        let clients = self.clients.read().await;
        for (_, client) in clients.iter() {
            client.stop().await?;
        }
        self.clients.write().await.clear();
        Ok(())
    }
    
    /// 获取补全列表
    pub async fn completion(
        &self,
        file_path: &Path,
        line: u32,
        character: u32,
    ) -> Result<Vec<CompletionItem>, String> {
        let language = detect_language(file_path);
        
        // 确保 LSP 已启动
        self.start_for_file(file_path).await?;
        
        let clients = self.clients.read().await;
        let client = clients.get(&language)
            .ok_or_else(|| format!("LSP for {:?} not running", language))?;
        
        client.completion(file_path, line, character).await
    }
    
    /// 获取悬停信息
    pub async fn hover(
        &self,
        file_path: &Path,
        line: u32,
        character: u32,
    ) -> Result<Option<Hover>, String> {
        let language = detect_language(file_path);
        
        // 确保 LSP 已启动
        self.start_for_file(file_path).await?;
        
        let clients = self.clients.read().await;
        let client = clients.get(&language)
            .ok_or_else(|| format!("LSP for {:?} not running", language))?;
        
        client.hover(file_path, line, character).await
    }
    
    /// 跳转到定义
    pub async fn goto_definition(
        &self,
        file_path: &Path,
        line: u32,
        character: u32,
    ) -> Result<Option<Location>, String> {
        let language = detect_language(file_path);
        
        // 确保 LSP 已启动
        self.start_for_file(file_path).await?;
        
        let clients = self.clients.read().await;
        let client = clients.get(&language)
            .ok_or_else(|| format!("LSP for {:?} not running", language))?;
        
        client.goto_definition(file_path, line, character).await
    }
    
    /// 休眠指定语言的 LSP
    pub async fn hibernate(&self, language: &Language) -> Result<(), String> {
        let clients = self.clients.read().await;
        let client = clients.get(language)
            .ok_or_else(|| format!("LSP for {:?} not running", language))?;
        
        client.hibernate().await
    }
    
    /// 唤醒指定语言的 LSP
    pub async fn wake(&self, language: &Language) -> Result<(), String> {
        let clients = self.clients.read().await;
        let client = clients.get(language)
            .ok_or_else(|| format!("LSP for {:?} not running", language))?;
        
        client.wake().await
    }
    /// 获取所有 LSP 的状态
    pub async fn status(&self) -> Vec<LspStatus> {
        let clients = self.clients.read().await;
        let mut status_list = Vec::new();
        
        for (lang, client) in clients.iter() {
            let state = client.state().await;
            status_list.push(LspStatus {
                language: super::languages::language_display_name(lang).to_string(),
                state: match state {
                    super::process::LspProcessState::Stopped => "stopped".to_string(),
                    super::process::LspProcessState::Initializing => "initializing".to_string(),
                    super::process::LspProcessState::Running => "running".to_string(),
                    super::process::LspProcessState::Hibernated => "hibernated".to_string(),
                    super::process::LspProcessState::Error(_) => "error".to_string(),
                },
                project_root: client.project_root().to_string_lossy().to_string(),
                supports_hibernation: true, // TODO: 从配置中获取
            });
        }
        
        status_list
    }
    
    /// 通知文件打开
    pub async fn did_open(&self, file_path: &Path, content: &str) -> Result<(), String> {
        let language = detect_language(file_path);
        
        // 确保 LSP 已启动
        self.start_for_file(file_path).await?;
        
        let clients = self.clients.read().await;
        if let Some(client) = clients.get(&language) {
            client.did_open(file_path, content).await?;
        }
        
        Ok(())
    }
    
    /// 通知文件变更
    pub async fn did_change(
        &self,
        file_path: &Path,
        content: &str,
        version: u32,
    ) -> Result<(), String> {
        let language = detect_language(file_path);
        
        let clients = self.clients.read().await;
        if let Some(client) = clients.get(&language) {
            client.did_change(file_path, content, version).await?;
        }
        
        Ok(())
    }
    
    /// 通知文件保存
    pub async fn did_save(&self, file_path: &Path) -> Result<(), String> {
        let language = detect_language(file_path);
        
        let clients = self.clients.read().await;
        if let Some(client) = clients.get(&language) {
            client.did_save(file_path).await?;
        }
        
        Ok(())
    }
    
    /// 通知文件关闭
    pub async fn did_close(&self, file_path: &Path) -> Result<(), String> {
        let language = detect_language(file_path);
        
        let clients = self.clients.read().await;
        if let Some(client) = clients.get(&language) {
            client.did_close(file_path).await?;
        }
        
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    #[tokio::test]
    async fn test_lsp_manager_creation() {
        let manager = LspManager::new(PathBuf::from("/tmp/test"));
        assert!(manager.clients.read().await.is_empty());
    }
}
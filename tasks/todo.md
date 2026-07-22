# 编译错误修复计划

- [x] 复现并定位 `ChatEvent` 字段变更
- [x] 对两个错误模式做最小兼容修复
- [x] 运行 Rust 编译与相关测试
- [x] 记录验证结果与审查结论

## 审查

- 根因：外部 `ChatEvent::Error` 新增可选 `sub_id`，两个旧的字段解构模式未覆盖新字段。
- 修复：持久化分支使用 `..` 忽略关联字段；Tauri 序列化分支保留 `message` 并在有值时输出 `subId`。
- 回归测试覆盖 `sessionId`、`kind`、`message`、`subId` 存在与缺省省略行为。
- 独立代码审查：无 Critical/Important；已补强审查指出的可选字段缺省断言。
- 验证：`cargo check --all-targets` 通过；`cargo test --lib` 通过（142 个）；`git diff --check` 通过。
- 构建仍有既有依赖与项目警告；LSP 诊断服务退出，未产生可用诊断，编译结果作为类型检查证据。
- 外部 `latte-agent-core` 工作树含用户未提交改动，本次未触碰。

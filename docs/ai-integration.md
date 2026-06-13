# AI 集成 (latte-rs-model-router)

DocViewer 右上角 **AI Review** 按钮调用 `latte-tune` 产生 AI 评论。

## 调用链

```
DocViewer (button)
  └─→ src/api/ai.ts :: aiReview(prompt)
        └─→ Tauri command `ai_review`
              ├─ 1st try:  $ latte-tune review --prompt <content>
              └─ fallback:  本地 stub（统计 + 启发式建议）
```

## 使用真 AI (推荐)

1. 构建 latte-tune:
   ```bash
   cd ../latte-rs-model-router
   cargo build --release
   ```
2. 把 `target/release/latte-tune` 放到 `$PATH`:
   ```bash
   cp target/release/latte-tune ~/.local/bin/
   chmod +x ~/.local/bin/latte-tune
   ```
3. 重启 editor，按 **AI Review** —— 现在调用真二进制。

## 使用 stub (开箱即用)

stub 总是能跑：自动检测 `latte-tune` 不在 PATH 时，本地 Rust fallback
(`stub_review`) 输出 word/heading/wikilink 统计 + 启发式建议。

也可以直接用 shell 脚本 stub：
```bash
cp scripts/latte-tune-stub.sh ~/.local/bin/latte-tune
chmod +x ~/.local/bin/latte-tune
```

## 配置模型

latte-tune 读 `~/.latte/models.yaml` 配置模型。详情见
[latte-rs-model-router README](../latte-rs-model-router/README.md)。

## 当前限制

- v1 只暴露 `ai_review` 一个命令（无 context/summarize）
- Tauri command 通过 `Command::new` 直接调 OS shell，不走 Tauri shell plugin
- prompt 截到 4000 字符（避免长 doc 拖慢响应）

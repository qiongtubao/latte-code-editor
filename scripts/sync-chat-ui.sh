#!/usr/bin/env bash
# 构建最新 agent chat UI 并同步产物 + 编辑器深色皮肤到 public/chat-ui/。
#
# 设计：latte-rs-agents/docs/ui-embedding-design.md §2
# （path 引用 + 构建时同步，与 src-tauri 的 Cargo path dep 同哲学）。
# 挂接：package.json 的 frontend:dev / frontend:build 前置步骤，
# tauri.conf.json 的 beforeDevCommand/beforeBuildCommand 已走这两个脚本。
set -euo pipefail

EDITOR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_DIR="$EDITOR_ROOT/../latte-rs-agents/latte-agent-cli/ui"

# 1. 构建最新 UI（ui 的 build 内含 clean，~0.5s，每次全量即可）
pnpm --dir "$UI_DIR" build

# 2. 同步产物（含 index.html / assets / skin.css 占位）到 public/chat-ui/
mkdir -p "$EDITOR_ROOT/public/chat-ui"
rsync -a --delete "$UI_DIR/dist/" "$EDITOR_ROOT/public/chat-ui/"

# 3. 编辑器深色皮肤覆盖占位 skin.css（换肤只改 skins/ 下这一个文件）
cp "$EDITOR_ROOT/skins/chat-ui-vscode-dark.css" "$EDITOR_ROOT/public/chat-ui/skin.css"

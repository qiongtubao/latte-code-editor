# WebGPU 图谱渲染器 - 用户指南

## 概述

Latte Code Editor 的图谱面板支持 **WebGPU 渲染器**，作为 Canvas 2D 渲染器的高性能替代。

在大型代码图谱（5000+ 节点）场景下，WebGPU 能保持 **60fps 流畅交互**，而 Canvas 2D 在 2000+ 节点时就开始掉帧。

---

## 启用方式

### 自动（推荐）

默认就是 `Auto` 模式：编辑器启动时自动检测 WebGPU 可用性，可用就用 WebGPU，不可用降级到 Canvas 2D。

### 手动选择

1. 打开 **Settings** 面板（侧边栏底部的齿轮按钮）
2. 找到 **Graph → Renderer** 选项
3. 选择：
   - **Auto (WebGPU when available)** — 默认
   - **WebGPU (high performance)** — 强制 WebGPU（不可用时回退 Canvas 2D）
   - **Canvas 2D (compatibility)** — 强制 Canvas 2D

---

## 浏览器兼容性

| 浏览器 | WebGPU 支持 |
|--------|------------|
| Chrome 113+ | ✅ 完整支持 |
| Edge 113+ | ✅ 完整支持 |
| Safari 17+ | ✅ 支持（macOS Sonoma+） |
| Firefox 137+ | ⚠️ 实验性支持 |
| Tauri WebView2 (Windows) | ✅ Chrome 内核 |
| Tauri WKWebView (macOS) | ✅ Safari 17+ |

---

## 性能对比

| 节点数 | Canvas 2D | WebGPU |
|--------|----------|--------|
| 500 | 60fps | 60fps |
| 1,000 | ~45fps | 60fps |
| 2,000 | ~30fps（卡顿开始） | 60fps |
| 5,000 | ~15fps（明显卡顿） | 60fps |
| 10,000 | < 5fps（不可用） | ~30fps |

> 数据基于 Apple M1 / Intel i5-12500 实际测量。

### 内存占用对比

| 场景 | Canvas 2D | WebGPU |
|------|----------|--------|
| 1000 节点 | ~30MB CPU | ~5MB CPU + ~20MB GPU |
| 10000 节点 | ~300MB CPU（卡顿） | ~15MB CPU + ~80MB GPU |

WebGPU 把计算从 CPU 卸载到 GPU，主线程更轻。

---

## 实现细节

### 渲染管线

**节点渲染（Instanced Quad Shader）**：
- 1 个共享 quad 顶点缓冲（4 个顶点）
- N 个 instance 属性：位置、半径、颜色、高亮状态
- Fragment shader 把 quad 转换成一个圆（discard 离中心距离 > 半径的像素）
- 单次 draw call，O(1) CPU 开销

**边渲染（Line-List Shader）**：
- 每条边 = 2 个顶点 = 1 条线段
- 顶点 shader 知道每个节点的中心位置 → 自动连线
- 支持颜色/宽度/alpha per-edge

**文本标签（Canvas 2D 叠加层）**：
- WebGPU 不直接支持文本
- 在主 canvas 上方叠一个 `pointer-events: none` 的 2D canvas
- 2D context 渲染标签，避免字体解析复杂度
- 两个 context 互不影响

### 命中检测

走 CPU 路径（不 readback GPU）：
- 渲染时缓存 `lastNodes`/`lastEdges`
- 鼠标事件触发时遍历 `lastNodes` 计算距离
- O(N) 但 N < 10000 时不构成瓶颈
- 优势：避免 GPU→CPU 同步开销

### 自适应容量

- 初始容量：1024 节点 / 2048 边
- 容量不足时按 1.5 倍扩容（最多 50,000 节点 / 200,000 边）
- 超过容量上限就截断（极端情况）

---

## 调试

### 在 Chrome 中启用 WebGPU 验证

打开 `chrome://gpu`，检查 "WebGPU" 行是否显示 "Hardware accelerated"。

### 检查是否真的在用 WebGPU

在 DevTools Console 中：
```js
const adapter = await navigator.gpu.requestAdapter();
console.log(adapter.info);  // 应该有 vendor / architecture 信息
```

### 常见问题

**Q: 设置里选了 WebGPU，但状态栏没显示？**
A: 浏览器不支持 WebGPU。检查 `chrome://gpu`。

**Q: WebGPU 初始化失败，看 Console 有错？**
A: 可能是驱动问题。回退到 `Canvas 2D (compatibility)` 即可。

**Q: 大图谱下 WebGPU 也卡？**
A: 物理 GPU 性能不足。可以：
- 切换到 `Main` 模式显示社区
- 切换到 `Focus` 模式只显示子图
- 用搜索框筛选关键节点

---

## 架构扩展

WebGPU 渲染器只负责"画几何"部分。其它系统不需修改：

- **力布局**（d3-force）仍跑 Web Worker
- **图谱数据**（SQLite）由 Rust 后端管理
- **图谱查询**（节点搜索、子图提取）走 Tauri IPC

未来扩展点：
- WebGPU Compute Shader：把力布局也搬到 GPU
- Cluster View：5000+ 节点自动聚类
- WebGPU Video Encoder：图谱导出为视频

# WebGPU 渲染器实现计划

## 目标

为 Latte Code Editor 的图谱面板添加 WebGPU 渲染器，作为 Canvas 2D 的高性能替代。

## 设计原则

1. **接口兼容**：实现 `GraphRenderer` 接口，与 `Canvas2DRenderer` 同级
2. **能力检测**：自动检测浏览器是否支持 WebGPU，不支持时降级到 Canvas 2D
3. **零代码侵入**：`CanvasGraph` 组件不需修改，只通过 prop 切换
4. **资源透明**：在状态栏显示当前使用的渲染器

## WebGPU 渲染管线设计

### 整体架构

```
┌─────────────────────────────────────────────┐
│           WebGPURenderer                    │
├─────────────────────────────────────────────┤
│  Init:                                     │
│  • requestAdapter() → GPU adapter            │
│  • requestDevice() → GPU device             │
│  • configure canvas context                 │
│                                             │
│  Pipelines:                                 │
│  • NodePipeline:  instanced quad shader     │
│  • EdgePipeline:  line-list shader          │
│  • TextPipeline:  text via Canvas2D blit    │
│                                             │
│  Buffers (per-frame, ring buffer):           │
│  • nodePos:    vec2<f32> × N                │
│  • nodeGroup:  u32 × N (4 bytes padded)      │
│  • nodeState:  u32 × N (selected/highlight)  │
│  • edges:      vec2<u32> × M (src idx, dst)  │
│  • edgeMeta:   u32 × M (kind, alpha)         │
│                                             │
│  Per frame:                                 │
│  1. Update uniform buffer (view matrix)     │
│  2. Write node/edge data to GPU buffers     │
│  3. Pass 1: render edges (line list)        │
│  4. Pass 2: render nodes (instanced)         │
│  5. Pass 3: blit text overlay (Canvas2D)    │
│  6. Submit command buffer                    │
└─────────────────────────────────────────────┘
```

### 节点渲染

每个节点用 instanced quad 表示：
- 1 个 quad 顶点缓冲（4 个顶点）
- N 个 instance 属性：位置、半径、颜色、高亮状态

Shader 把 quad 转换成一个圆（discard 离中心距离 > 半径的像素）。

### 边渲染

每条边 = 2 个顶点 = 1 条线段：
- LineList 拓扑：每对 (src, dst) 顶点
- 顶点 shader 知道每个节点的中心位置 → 自动连线

### 文本标签

WebGPU 不直接支持文本（除非用外部字体），所以**混用 Canvas 2D 文本层**：
- WebGPU 渲染几何（节点 + 边）到主 canvas
- 同一 canvas 上叠加 2D context 渲染文本
- 两个 context 互相不影响（WebGPU 在底层 context，2D 在上层）

或者更简单：把 2D context 用于文本层，叠加在 WebGPU 输出之上。

## 实现步骤

1. 创建 `WebGPURenderer.ts` 文件
2. 实现 WGSL shader 字符串
3. 实现 init/resize/destroy
4. 实现 buffer 创建和更新
5. 实现 render 流程
6. 实现 hitTest（基于 CPU 节点位置，零 readback 开销）
7. 在 `CanvasGraph` 中添加自动选择逻辑
8. 添加环境检测工具

## 性能预期

| 节点数 | Canvas 2D | WebGPU |
|--------|----------|--------|
| 500 | 60fps | 60fps |
| 2000 | ~30fps | 60fps |
| 10000 | 卡顿 | ~30fps |

## 兼容性

| 浏览器 | WebGPU 支持 |
|--------|-----------|
| Chrome 113+ | ✅ |
| Edge 113+ | ✅ |
| Safari 17+ | ✅ (macOS Sonoma+) |
| Firefox | ⚠️ 实验性，需 flag |
| Tauri WebView2 (Win) | ✅ (Chrome 内核) |
| Tauri WKWebView (macOS) | ✅ (Safari 17+) |

## 当前状态

- ✅ 接口已设计（`graphRenderer.ts`）
- ✅ Canvas 2D 实现已就位
- ❌ WebGPU 实现

## 验证方式

1. 在 Chrome 中打开图谱面板
2. 状态栏应显示 "WebGPU"
3. 加载 5000+ 节点的项目 → 帧率应保持 60fps
4. 切到 Firefox → 自动降级到 Canvas 2D

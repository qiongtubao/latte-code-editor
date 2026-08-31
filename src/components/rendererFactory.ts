/**
 * 渲染器工厂：根据环境和设置选择合适的图谱渲染器
 *
 * 选择逻辑：
 * 1. 用户手动选择（settings 里有 graph.renderer 选项）
 * 2. 环境检测：WebGPU 可用 → 选 WebGPU；否则 Canvas 2D
 * 3. 始终有 fallback：Canvas2DRenderer
 */
import { Canvas2DRenderer } from "./Canvas2DRenderer";
import { isWebGPUAvailable } from "../utils/webgpuDetect";
import type { GraphRenderer } from "./graphRenderer";

export type RendererKind = "auto" | "webgpu" | "canvas2d";

export async function createRenderer(
  kind: RendererKind,
  options: Parameters<GraphRenderer["init"]>[0],
): Promise<GraphRenderer> {
  let useWebGPU = false;
  if (kind === "webgpu" || kind === "auto") {
    useWebGPU = await isWebGPUAvailable();
  }

  if (useWebGPU) {
    try {
      // 按需加载：WebGPURenderer 是最大的单个模块，而在不支持 WebGPU 的
      // 环境（或用户选了 canvas2d）里它一次都不会被用到。工厂本就是 async，
      // 动态导入不需要改调用方。
      const { WebGPURenderer } = await import("./WebGPURenderer");
      const r = new WebGPURenderer();
      await r.init(options);
      return r;
    } catch (e) {
      console.warn("[createRenderer] WebGPU init failed, fallback to Canvas 2D:", e);
    }
  }

  // fallback
  const r = new Canvas2DRenderer();
  r.init(options);
  return r;
}

/** 当前实际使用的渲染器类型（用于状态栏显示） */
export function rendererKindOf(renderer: GraphRenderer): "webgpu" | "canvas2d" {
  return renderer.kind;
}

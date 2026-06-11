/**
 * 环境检测：检查浏览器/WebView 是否支持 WebGPU
 *
 * 不要在模块加载时调用此函数，要在用户交互时再探测
 * （因为 navigator.gpu.requestAdapter() 在某些环境会显示 consent prompt）
 */

let cached: boolean | null = null;

export async function isWebGPUAvailable(): Promise<boolean> {
  if (cached !== null) return cached;

  // 1. 基础检查：navigator.gpu 存在
  if (typeof navigator === "undefined" || !("gpu" in navigator)) {
    cached = false;
    return false;
  }

  // 2. requestAdapter 必须成功返回
  try {
    const gpu = (navigator as Navigator & { gpu: GPU }).gpu;
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      cached = false;
      return false;
    }
    cached = true;
    return true;
  } catch {
    cached = false;
    return false;
  }
}

/**
 * 重置缓存（用于单元测试或用户重新探测）
 */
export function resetWebGPUCache(): void {
  cached = null;
}

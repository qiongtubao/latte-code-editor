/**
 * 环境检测：检查浏览器/WebView 是否支持 WebGPU
 *
 * 不要在模块加载时调用此函数，要在用户交互时再探测
 * （因为 navigator.gpu.requestAdapter() 在某些环境会显示 consent prompt）
 */

let cached: boolean | null = null;
/**
 * 进行中的探测。
 *
 * 只缓存结果不够：两个并发调用都会看到 `cached === null`，于是各自跑一遍
 * `requestAdapter()`（在某些环境还会重复弹 consent prompt），并且都在 await
 * 之后才写 `cached` —— 写入依据是 await 之前读到的过期值。
 * 缓存 in-flight promise 让并发调用共享同一次探测，竞态随之消失。
 */
let inFlight: Promise<boolean> | null = null;

/** requestAdapter 超时时间（毫秒），防止在某些 WebView 中 hang 导致 Canvas 2D 兜底失效 */
const ADAPTER_TIMEOUT_MS = 2000;

export function isWebGPUAvailable(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  inFlight ??= probe().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function probe(): Promise<boolean> {
  // 1. 基础检查：navigator.gpu 存在
  if (typeof navigator === "undefined" || !("gpu" in navigator)) {
    cached = false;
    return false;
  }

  // 2. requestAdapter 必须成功返回（带超时保护，防止 WebView hang）
  try {
    const gpu = (navigator as Navigator & { gpu: GPU }).gpu;
    const adapter = await Promise.race([
      gpu.requestAdapter(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ADAPTER_TIMEOUT_MS)),
    ]);
    cached = !!adapter;
    return cached;
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
  inFlight = null;
}

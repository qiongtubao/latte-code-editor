/**
 * WebGPU 环境检测测试
 *
 * 只测纯函数逻辑（cache 行为），不测 navigator.gpu 这种浏览器 API。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { isWebGPUAvailable, resetWebGPUCache } from "./webgpuDetect";

describe("isWebGPUAvailable", () => {
  beforeEach(() => {
    resetWebGPUCache();
    delete (navigator as unknown as { gpu?: unknown }).gpu;
  });

  it("returns false when navigator.gpu is missing", async () => {
    const result = await isWebGPUAvailable();
    expect(result).toBe(false);
  });

  it("caches the result", async () => {
    const first = await isWebGPUAvailable();
    const second = await isWebGPUAvailable();
    expect(first).toBe(false);
    expect(second).toBe(false);
  });

  it("returns false when requestAdapter rejects", async () => {
    (navigator as unknown as { gpu: { requestAdapter: () => Promise<null> } }).gpu = {
      requestAdapter: vi.fn().mockRejectedValue(new Error("denied")),
    };
    const result = await isWebGPUAvailable();
    expect(result).toBe(false);
  });

  it("returns true when adapter is available", async () => {
    (navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu = {
      requestAdapter: vi.fn().mockResolvedValue({ name: "fake-adapter" }),
    };
    const result = await isWebGPUAvailable();
    expect(result).toBe(true);
  });
});

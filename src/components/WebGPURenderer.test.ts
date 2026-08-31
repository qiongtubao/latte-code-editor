import { afterEach, describe, expect, it, vi } from "vitest";
import { WebGPURenderer } from "./WebGPURenderer";
import { WEBGPU_NODE_INSTANCE_LAYOUT } from "./webgpuUploadBuffer";
import type { SimRenderNode } from "./graphRenderer";

interface FakeWebGPU {
  device: GPUDevice;
  bindGroupLayout: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  createBindGroupLayout: ReturnType<typeof vi.fn>;
  createPipelineLayout: ReturnType<typeof vi.fn>;
  createRenderPipeline: ReturnType<typeof vi.fn>;
  createBindGroup: ReturnType<typeof vi.fn>;
  writeBuffer: ReturnType<typeof vi.fn>;
  buffers: Array<{ destroy: ReturnType<typeof vi.fn> }>;
  resolveLost: (info: GPUDeviceLostInfo) => void;
}

function createFakeDevice(): FakeWebGPU {
  const bindGroupLayout = {} as GPUBindGroupLayout;
  const pipelineLayout = {} as GPUPipelineLayout;
  const buffers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  let resolveLost = (_info: GPUDeviceLostInfo) => {};
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
    resolveLost = resolve;
  });
  const renderPass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  };
  const commandEncoder = {
    beginRenderPass: vi.fn(() => renderPass),
    finish: vi.fn(() => ({})),
  };
  const createBindGroupLayout = vi.fn(() => bindGroupLayout);
  const createPipelineLayout = vi.fn(() => pipelineLayout);
  const createRenderPipeline = vi.fn(() => ({} as GPURenderPipeline));
  const createBindGroup = vi.fn(() => ({} as GPUBindGroup));
  const writeBuffer = vi.fn();
  const device = {
    lost,
    queue: {
      writeBuffer,
      submit: vi.fn(),
    },
    createBindGroupLayout,
    createPipelineLayout,
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline,
    createBuffer: vi.fn(() => {
      const buffer = { destroy: vi.fn() };
      buffers.push(buffer);
      return buffer;
    }),
    createBindGroup,
    createCommandEncoder: vi.fn(() => commandEncoder),
    destroy: vi.fn(),
  } as unknown as GPUDevice;

  return {
    device,
    bindGroupLayout,
    pipelineLayout,
    createBindGroupLayout,
    createPipelineLayout,
    createRenderPipeline,
    createBindGroup,
    writeBuffer,
    buffers,
    resolveLost,
  };
}

function node(index: number): SimRenderNode {
  return {
    id: `n${index}`,
    x: index,
    y: index,
    vx: 0,
    vy: 0,
    group: 1,
  };
}

function uploadedNodeColor(
  writeBuffer: ReturnType<typeof vi.fn>,
  nodeIndex: number,
): number[] {
  const data = writeBuffer.mock.calls[0]?.[2] as ArrayBuffer;
  const f32 = new Float32Array(data);
  const offset =
    nodeIndex * WEBGPU_NODE_INSTANCE_LAYOUT.wordStride
    + WEBGPU_NODE_INSTANCE_LAYOUT.colorWordOffset;
  return Array.from(f32.subarray(offset, offset + 4));
}

function expectColor(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(4);
  for (let index = 0; index < 4; index++) {
    expect(actual[index]).toBeCloseTo(expected[index]);
  }
}

interface WebGPURendererInternals {
  res: unknown;
  uploadNodes: (
    resources: unknown,
    nodes: SimRenderNode[],
    selectedNodeId: string | null,
    hoveredNodeId: string | null,
    highlightedNodeIds: Set<string>,
    hoveredNeighbors: Set<string>,
  ) => void;
}

describe("WebGPURenderer initialization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shares one pipeline layout, applies initial DPR size, and reuses the bind layout on growth", async () => {
    const fake = createFakeDevice();
    const gpuContext = {
      configure: vi.fn(),
      getCurrentTexture: vi.fn(() => ({ createView: vi.fn(() => ({})) })),
    };
    const gpu = {
      requestAdapter: vi.fn(async () => ({
        requestDevice: vi.fn(async () => fake.device),
      })),
      getPreferredCanvasFormat: vi.fn(() => "bgra8unorm"),
    };
    vi.stubGlobal("navigator", { gpu });
    vi.stubGlobal("GPUShaderStage", { VERTEX: 1 });
    vi.stubGlobal("GPUBufferUsage", {
      VERTEX: 1,
      COPY_DST: 2,
      STORAGE: 4,
      UNIFORM: 8,
    });
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);

    const parent = document.createElement("div");
    const canvas = document.createElement("canvas");
    parent.appendChild(canvas);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function getContext(this: HTMLCanvasElement, type: "webgpu") {
        if (this === canvas && type === "webgpu") {
          return gpuContext as unknown as GPUCanvasContext;
        }
        return null;
      },
    );
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      width: 640,
      height: 480,
    } as DOMRect);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const renderer = new WebGPURenderer();
    await renderer.init({ canvas, getNodes: () => [] });

    expect(renderer.initialized).toBe(true);
    expect(fake.createBindGroupLayout).toHaveBeenCalledTimes(1);
    expect(fake.createPipelineLayout).toHaveBeenCalledWith({
      bindGroupLayouts: [fake.bindGroupLayout],
    });
    expect(fake.createRenderPipeline).toHaveBeenCalledTimes(2);
    for (const [descriptor] of fake.createRenderPipeline.mock.calls) {
      expect(descriptor.layout).toBe(fake.pipelineLayout);
    }
    expect(fake.createBindGroup).toHaveBeenCalledTimes(1);
    expect(fake.createBindGroup.mock.calls[0]?.[0].layout).toBe(fake.bindGroupLayout);
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(960);
    const overlay = parent.querySelector<HTMLCanvasElement>(
      "canvas[data-webgpu-text-overlay]",
    );
    expect(overlay?.width).toBe(1280);
    expect(overlay?.height).toBe(960);

    const largeNodes = Array.from({ length: 1025 }, (_, index) => node(index));
    renderer.render({
      simNodes: largeNodes,
      simEdges: [],
      selectedNodeId: null,
      hoveredNodeId: null,
      highlightedNodeIds: new Set(),
      pan: { x: 0, y: 0 },
      zoom: 1,
    });
    expect(fake.createBindGroup).toHaveBeenCalledTimes(2);
    expect(fake.createBindGroup.mock.calls[1]?.[0].layout).toBe(fake.bindGroupLayout);

    const internals = renderer as unknown as WebGPURendererInternals;
    const parseIntSpy = vi.spyOn(globalThis, "parseInt");
    fake.writeBuffer.mockClear();
    internals.uploadNodes(
      internals.res,
      largeNodes,
      null,
      null,
      new Set(),
      new Set(),
    );
    expect(parseIntSpy).not.toHaveBeenCalled();
    expectColor(uploadedNodeColor(fake.writeBuffer, 0), [
      0x6a / 255,
      0x87 / 255,
      0x59 / 255,
      1,
    ]);

    fake.writeBuffer.mockClear();
    internals.uploadNodes(
      internals.res,
      largeNodes.slice(0, 4),
      "n0",
      "n1",
      new Set(["n2"]),
      new Set(["n1"]),
    );
    expect(parseIntSpy).not.toHaveBeenCalled();
    expectColor(uploadedNodeColor(fake.writeBuffer, 0), [1, 0xcc / 255, 0, 1]);
    expectColor(uploadedNodeColor(fake.writeBuffer, 1), [0x4f / 255, 0xc3 / 255, 1, 1]);
    expectColor(uploadedNodeColor(fake.writeBuffer, 2), [1, 0x8a / 255, 0x65 / 255, 1]);
    expectColor(uploadedNodeColor(fake.writeBuffer, 3), [0.27, 0.27, 0.27, 0.4]);

    renderer.destroy();
    expect(renderer.initialized).toBe(false);
    expect(parent.querySelector("canvas[data-webgpu-text-overlay]")).toBeNull();
    expect(fake.buffers.every((buffer) => buffer.destroy.mock.calls.length > 0)).toBe(true);
    expect(fake.device.destroy).toHaveBeenCalledTimes(1);

    fake.resolveLost({ message: "stale", reason: "destroyed" } as GPUDeviceLostInfo);
    await Promise.resolve();
    expect(renderer.error).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import {
  ReusableUploadBuffer,
  WEBGPU_EDGE_RECORD_LAYOUT,
  WEBGPU_NODE_INSTANCE_LAYOUT,
  WEBGPU_UNIFORM_BYTE_LENGTH,
  growBufferCapacity,
} from "./webgpuUploadBuffer";

describe("WebGPU upload layouts", () => {
  it("matches WGSL storage alignment for node and edge arrays", () => {
    expect(WEBGPU_NODE_INSTANCE_LAYOUT.byteStride).toBe(48);
    expect(WEBGPU_NODE_INSTANCE_LAYOUT.wordStride).toBe(12);
    expect(WEBGPU_NODE_INSTANCE_LAYOUT.colorWordOffset * 4).toBe(16);
    expect(WEBGPU_NODE_INSTANCE_LAYOUT.flagsWordOffset * 4).toBe(32);
    expect(WEBGPU_NODE_INSTANCE_LAYOUT.byteStride % 16).toBe(0);

    expect(WEBGPU_EDGE_RECORD_LAYOUT.byteStride).toBe(48);
    expect(WEBGPU_EDGE_RECORD_LAYOUT.wordStride).toBe(12);
    expect(WEBGPU_EDGE_RECORD_LAYOUT.colorWordOffset * 4).toBe(16);
    expect(WEBGPU_EDGE_RECORD_LAYOUT.widthWordOffset * 4).toBe(32);
    expect(WEBGPU_EDGE_RECORD_LAYOUT.alphaWordOffset * 4).toBe(36);
    expect(WEBGPU_EDGE_RECORD_LAYOUT.byteStride % 16).toBe(0);

    expect(WEBGPU_UNIFORM_BYTE_LENGTH).toBe(40);
  });
});

describe("ReusableUploadBuffer", () => {
  it("reuses buffer and typed views until aligned capacity must grow", () => {
    const upload = new ReusableUploadBuffer();
    const first = upload.acquire(36);
    first.f32[0] = 12.5;

    const smaller = upload.acquire(20);
    expect(smaller).toBe(first);
    expect(smaller.buffer).toBe(first.buffer);
    expect(smaller.f32).toBe(first.f32);
    expect(smaller.u32).toBe(first.u32);
    expect(smaller.f32[0]).toBe(12.5);

    const grown = upload.acquire(40);
    expect(grown).not.toBe(first);
    expect(grown.buffer).not.toBe(first.buffer);
    expect(upload.capacity).toBeGreaterThanOrEqual(40);
    expect(upload.capacity % Uint32Array.BYTES_PER_ELEMENT).toBe(0);
    expect(upload.acquire(41)).toBe(grown);
  });

  it("aligns odd byte requests and releases retained storage on clear", () => {
    const upload = new ReusableUploadBuffer();
    const first = upload.acquire(5);
    expect(upload.capacity).toBe(8);

    upload.clear();
    expect(upload.capacity).toBe(0);
    expect(upload.acquire(5)).not.toBe(first);
  });
});

describe("growBufferCapacity", () => {
  it("uses geometric growth without under-allocating large jumps", () => {
    expect(growBufferCapacity(1024, 1000, 50_000)).toBe(1024);
    expect(growBufferCapacity(1024, 1100, 50_000)).toBe(1536);
    expect(growBufferCapacity(1024, 10_000, 50_000)).toBe(10_000);
    expect(growBufferCapacity(150_000, 200_000, 200_000)).toBe(200_000);
    expect(() => growBufferCapacity(1024, 50_001, 50_000)).toThrow(RangeError);
  });
});

export const WEBGPU_NODE_INSTANCE_LAYOUT = {
  byteStride: 48,
  wordStride: 12,
  positionWordOffset: 0,
  radiusWordOffset: 2,
  colorWordOffset: 4,
  flagsWordOffset: 8,
} as const;

export const WEBGPU_EDGE_RECORD_LAYOUT = {
  byteStride: 48,
  wordStride: 12,
  sourceIndexWordOffset: 0,
  targetIndexWordOffset: 1,
  colorWordOffset: 4,
  widthWordOffset: 8,
  alphaWordOffset: 9,
} as const;

export const WEBGPU_UNIFORM_BYTE_LENGTH = 40;

export interface UploadBufferViews {
  buffer: ArrayBuffer;
  f32: Float32Array;
  u32: Uint32Array;
}

function alignToU32(byteLength: number): number {
  return Math.ceil(byteLength / Uint32Array.BYTES_PER_ELEMENT)
    * Uint32Array.BYTES_PER_ELEMENT;
}

function createViews(byteLength: number): UploadBufferViews {
  const buffer = new ArrayBuffer(byteLength);
  return {
    buffer,
    f32: new Float32Array(buffer),
    u32: new Uint32Array(buffer),
  };
}

export function growBufferCapacity(
  current: number,
  required: number,
  maximum: number,
): number {
  if (required > maximum) {
    throw new RangeError(`required capacity ${required} exceeds maximum ${maximum}`);
  }
  if (required <= current) return current;
  return Math.min(maximum, Math.max(required, Math.ceil(current * 1.5)));
}

export class ReusableUploadBuffer {
  private views = createViews(0);

  get capacity(): number {
    return this.views.buffer.byteLength;
  }

  acquire(requiredByteLength: number): UploadBufferViews {
    const alignedRequired = alignToU32(requiredByteLength);
    if (alignedRequired <= this.capacity) return this.views;

    const grown = Math.max(alignedRequired, Math.ceil(this.capacity * 1.5));
    this.views = createViews(alignToU32(grown));
    return this.views;
  }

  clear(): void {
    this.views = createViews(0);
  }
}

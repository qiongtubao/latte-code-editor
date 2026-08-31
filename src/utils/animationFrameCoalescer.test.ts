import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnimationFrameCoalescer } from "./animationFrameCoalescer";

describe("createAnimationFrameCoalescer", () => {
  let nextFrameId: number;
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    nextFrameId = 1;
    frames = new Map();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const runFrame = () => {
    const entry = frames.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    expect(entry).toBeDefined();
    if (!entry) return;
    frames.delete(entry[0]);
    entry[1](performance.now());
  };

  it("publishes only the latest value from a burst", () => {
    const publish = vi.fn();
    const coalescer = createAnimationFrameCoalescer(publish);

    coalescer.schedule({ tick: 1 });
    coalescer.schedule({ tick: 2 });
    coalescer.schedule({ tick: 3 });

    expect(frames.size).toBe(1);
    expect(publish).not.toHaveBeenCalled();
    runFrame();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({ tick: 3 });

    coalescer.schedule({ tick: 4 });
    expect(frames.size).toBe(1);
    runFrame();
    expect(publish).toHaveBeenLastCalledWith({ tick: 4 });
  });

  it("drops a pending value when cancelled", () => {
    const publish = vi.fn();
    const coalescer = createAnimationFrameCoalescer(publish);

    coalescer.schedule("stale");
    coalescer.cancel();

    expect(frames.size).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });
});

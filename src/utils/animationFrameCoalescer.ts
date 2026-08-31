export interface AnimationFrameCoalescer<T> {
  schedule: (value: T) => void;
  cancel: () => void;
}

/**
 * Publish at most once per animation frame while always retaining the newest
 * value received during that frame. Cancellation drops any pending value.
 */
export function createAnimationFrameCoalescer<T>(
  publish: (value: T) => void,
): AnimationFrameCoalescer<T> {
  let frameId: number | null = null;
  let hasPendingValue = false;
  let latestValue: T;

  return {
    schedule(value) {
      latestValue = value;
      hasPendingValue = true;
      if (frameId !== null) return;

      frameId = requestAnimationFrame(() => {
        frameId = null;
        if (!hasPendingValue) return;
        hasPendingValue = false;
        publish(latestValue);
      });
    },
    cancel() {
      hasPendingValue = false;
      if (frameId === null) return;
      cancelAnimationFrame(frameId);
      frameId = null;
    },
  };
}

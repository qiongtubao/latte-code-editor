// Polyfill matchMedia for jsdom (Monaco's StandaloneThemeService expects it).
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Polyfill Worker for jsdom (GraphView's useEffect constructs a Worker).
// Tests don't exercise the worker, so this stub just no-ops message passing.
if (typeof globalThis.Worker === "undefined") {
  class WorkerStub {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    postMessage(_msg: unknown): void {}
    terminate(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean { return true; }
  }
  (globalThis as unknown as { Worker: typeof Worker }).Worker =
    WorkerStub as unknown as typeof Worker;
}

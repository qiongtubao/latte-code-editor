import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileResult } from "../api/commands";
import {
  calculateViewWindow,
  LARGE_FILE_LINE_HEIGHT,
  LargeFileViewer,
} from "./LargeFileViewer";

const apiMocks = vi.hoisted(() => ({
  statTextFile: vi.fn(),
  readFileRange: vi.fn(),
}));

vi.mock("../api/commands", () => ({
  statTextFile: apiMocks.statTextFile,
  readFileRange: apiMocks.readFileRange,
}));

class ResizeObserverMock {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { height: 220 } as DOMRectReadOnly } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }

  disconnect() {}
  unobserve() {}
}

function file(path: string): FileResult {
  return {
    path,
    content: "",
    line_count: 0,
    is_large_file: true,
    is_modified: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("LargeFileViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(performance.now()), 0);
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    apiMocks.statTextFile.mockResolvedValue({ total_lines: 1000, byte_size: 12_345 });
    apiMocks.readFileRange.mockImplementation(
      async (_path: string, startLine: number, maxLines: number) => ({
        start_line: startLine,
        lines: Array.from({ length: maxLines }, (_, i) => `line ${startLine + i}`),
        eof: false,
      }),
    );
  });

  it("maps ordinary scrolling to logical lines and keeps overscan", () => {
    const view = calculateViewWindow(800 * LARGE_FILE_LINE_HEIGHT, 220, 1000);
    expect(view.firstVisible).toBe(800);
    expect(view.start).toBe(770);
    expect(view.end).toBe(840);
  });

  it("maps the bottom of a compressed scroll track to the final viewport", () => {
    const totalLines = 10_000_000;
    const containerHeight = 220;
    const maxScrollTop = 16_000_000 - containerHeight;
    const view = calculateViewWindow(maxScrollTop, containerHeight, totalLines);
    expect(view.firstVisible).toBe(totalLines - 10);
    expect(view.end).toBe(totalLines);
    expect(view.scrollHeight).toBe(16_000_000);
  });

  it("loads only the page covering the visible range, then pages on scroll", async () => {
    render(<LargeFileViewer file={file("/repo/big.log")} />);

    await waitFor(() => {
      expect(apiMocks.readFileRange).toHaveBeenCalledWith("/repo/big.log", 0, 256);
    });
    expect(await screen.findByText("line 0")).toBeTruthy();

    const scroller = screen.getByTestId("large-file-scroll");
    scroller.scrollTop = 800 * LARGE_FILE_LINE_HEIGHT;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(apiMocks.readFileRange).toHaveBeenCalledWith("/repo/big.log", 768, 256);
    });
    expect(await screen.findByText("line 800")).toBeTruthy();
  });

  it("ignores metadata from a tab that finished after a newer tab", async () => {
    const oldStat = deferred<{ total_lines: number; byte_size: number }>();
    apiMocks.statTextFile.mockImplementation((path: string) =>
      path === "/repo/old.log"
        ? oldStat.promise
        : Promise.resolve({ total_lines: 7, byte_size: 70 }),
    );

    const { rerender } = render(<LargeFileViewer file={file("/repo/old.log")} />);
    rerender(<LargeFileViewer file={file("/repo/new.log")} />);

    expect(await screen.findByText("7 lines · 70 B")).toBeTruthy();
    await act(async () => {
      oldStat.resolve({ total_lines: 999_999, byte_size: 9_999_999 });
      await oldStat.promise;
    });
    expect(screen.getByText("7 lines · 70 B")).toBeTruthy();
    expect(screen.queryByText(/999,999 lines/)).toBeNull();
  });

  it("ignores an old range response after the same path is refreshed", async () => {
    const oldRange = deferred<{
      start_line: number;
      lines: string[];
      eof: boolean;
    }>();
    let rangeCall = 0;
    apiMocks.readFileRange.mockImplementation(() => {
      rangeCall += 1;
      return rangeCall === 1
        ? oldRange.promise
        : Promise.resolve({ start_line: 0, lines: ["fresh content"], eof: true });
    });

    const original = file("/repo/same.log");
    const { rerender } = render(<LargeFileViewer file={original} />);
    await waitFor(() => expect(apiMocks.readFileRange).toHaveBeenCalledTimes(1));

    // A refresh produces a new FileResult object even when path/size are equal.
    rerender(<LargeFileViewer file={{ ...original }} />);
    expect(await screen.findByText("fresh content")).toBeTruthy();

    await act(async () => {
      oldRange.resolve({ start_line: 0, lines: ["stale content"], eof: true });
      await oldRange.promise;
    });
    expect(screen.queryByText("stale content")).toBeNull();
    expect(screen.getByText("fresh content")).toBeTruthy();
  });
});

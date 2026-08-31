import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileResult } from "../api/commands";
import type { ComponentLoader } from "./LazyFeatureBoundary";
import {
  LazyLargeFileMode,
  LazyMarkdownPreview,
  type LargeFileModeProps,
  type MarkdownPreviewProps,
} from "./LazyEditorViewers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function Preview({ content, filePath }: MarkdownPreviewProps) {
  return <div>preview:{filePath}:{content}</div>;
}

function LargeMode({ file }: LargeFileModeProps) {
  return <div>large:{file.path}</div>;
}

function largeFile(path: string): FileResult {
  return {
    path,
    content: "",
    line_count: 0,
    is_large_file: true,
    is_modified: false,
  };
}

describe("lazy editor viewers", () => {
  it("loads Markdown preview once and keeps forwarding current content", async () => {
    const pending = deferred<Awaited<ReturnType<ComponentLoader<MarkdownPreviewProps>>>>();
    const loader = vi.fn(() => pending.promise);
    const { rerender } = render(
      <LazyMarkdownPreview content="first" filePath="/repo/a.md" loader={loader} />,
    );

    expect(screen.getByLabelText("Loading Markdown preview")).toBeTruthy();
    pending.resolve(Preview);
    expect(await screen.findByText("preview:/repo/a.md:first")).toBeTruthy();

    rerender(
      <LazyMarkdownPreview content="second" filePath="/repo/a.md" loader={loader} />,
    );
    expect(await screen.findByText("preview:/repo/a.md:second")).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("lets large-file mode retry a failed chunk load", async () => {
    const loader = vi
      .fn<ComponentLoader<LargeFileModeProps>>()
      .mockRejectedValueOnce(new Error("viewer chunk unavailable"))
      .mockResolvedValueOnce(LargeMode);

    render(<LazyLargeFileMode file={largeFile("/repo/big.log")} loader={loader} />);

    expect(await screen.findByText("large-file viewer failed to load")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("viewer chunk unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("large:/repo/big.log")).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

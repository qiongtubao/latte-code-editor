import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileResult } from "../api/commands";
import type { CodeMirrorProps } from "./CodeMirrorEditor";
import type { ComponentLoader } from "./LazyFeatureBoundary";
import {
  LazyCodeEditor,
  LazyLargeFileMode,
  LazyMarkdownPreview,
  shouldPreloadCodeEditor,
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

function CodeEditor({ content, filePath, onChange }: CodeMirrorProps) {
  return <button onClick={() => onChange(`edited:${content}`)}>code:{filePath}:{content}</button>;
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
  it("preloads only known code extensions", () => {
    expect(shouldPreloadCodeEditor("/repo/src/main.ts")).toBe(true);
    expect(shouldPreloadCodeEditor("C:\\repo\\lib.RS")).toBe(true);
    expect(shouldPreloadCodeEditor("/repo/readme.md")).toBe(false);
    expect(shouldPreloadCodeEditor("/repo/server.log")).toBe(false);
    expect(shouldPreloadCodeEditor("/repo/Makefile")).toBe(false);
  });

  it("loads CodeMirror once and keeps callbacks and file props current", async () => {
    const pending = deferred<Awaited<ReturnType<ComponentLoader<CodeMirrorProps>>>>();
    const loader = vi.fn(() => pending.promise);
    const firstChange = vi.fn();
    const secondChange = vi.fn();
    const { rerender } = render(
      <LazyCodeEditor
        content="first"
        filePath="/repo/a.ts"
        onChange={firstChange}
        loader={loader}
      />,
    );

    expect(screen.getByLabelText("Loading code editor")).toBeTruthy();
    // The active file can change while the large CodeMirror chunk is in flight.
    rerender(
      <LazyCodeEditor
        content="second"
        filePath="/repo/b.ts"
        onChange={secondChange}
        loader={loader}
      />,
    );
    pending.resolve(CodeEditor);

    const editor = await screen.findByRole("button", { name: "code:/repo/b.ts:second" });
    fireEvent.click(editor);
    expect(firstChange).not.toHaveBeenCalled();
    expect(secondChange).toHaveBeenCalledWith("edited:second");
    expect(loader).toHaveBeenCalledTimes(1);
  });

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

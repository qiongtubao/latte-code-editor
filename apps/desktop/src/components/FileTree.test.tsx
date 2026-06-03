import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";

// Mock the Tauri invoke so FileTree can be tested without a real runtime.
// Each test sets up its own `mockInvoke` implementation via `mockResolvedValueOnce`
// etc. (see vi.mocked below).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { FileTree, type FsEntry } from "./FileTree.js";

const mockInvoke = vi.mocked(invoke);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FileTree", () => {
  it("renders nothing when workspace is null", () => {
    const onFileOpen = vi.fn();
    const { container } = render(
      <FileTree workspace={null} onFileOpen={onFileOpen} />,
    );
    expect(container.firstChild).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("triggers a root cmd_list_dir fetch on mount when workspace is set", async () => {
    const onFileOpen = vi.fn();
    mockInvoke.mockResolvedValueOnce([] as FsEntry[]);

    render(<FileTree workspace="/ws" onFileOpen={onFileOpen} />);

    // Args: command name, then the params object. We pass `{ path: null }`
    // to mean "list the workspace root".
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("cmd_list_dir", { path: null });
    });
  });

  it("fetches and shows a directory's children when its toggle is clicked", async () => {
    const onFileOpen = vi.fn();
    // First call: root listing with one directory child.
    mockInvoke.mockResolvedValueOnce([
      { name: "src", path: "src", isDir: true },
    ] as FsEntry[]);
    // Second call: the inside of `src` — what gets fetched when the user
    // expands it.
    mockInvoke.mockResolvedValueOnce([
      { name: "index.ts", path: "src/index.ts", isDir: false },
    ] as FsEntry[]);

    const { getByText, queryByText } = render(
      <FileTree workspace="/ws" onFileOpen={onFileOpen} />,
    );

    // Wait for the root listing to render.
    await waitFor(() => {
      expect(getByText("src")).toBeTruthy();
    });
    // The leaf file should NOT be visible yet — we haven't expanded `src`.
    expect(queryByText("src/index.ts")).toBeNull();

    // Click the toggle next to `src`. The toggle is the `▸` glyph button
    // sitting next to the directory name; clicking the row as a whole
    // also works because the entire row is clickable.
    fireEvent.click(getByText("▸"));

    // After the click, the loader should show `…` and the inner listing
    // should be requested.
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("cmd_list_dir", { path: "src" });
    });
    // The leaf should appear once the second invoke resolves.
    await waitFor(() => {
      expect(getByText("index.ts")).toBeTruthy();
    });
  });

  it("calls onFileOpen with the file's path and name when a file is clicked", async () => {
    const onFileOpen = vi.fn();
    mockInvoke.mockResolvedValueOnce([
      { name: "readme.md", path: "readme.md", isDir: false },
    ] as FsEntry[]);

    const { getByText } = render(
      <FileTree workspace="/ws" onFileOpen={onFileOpen} />,
    );

    await waitFor(() => {
      expect(getByText("readme.md")).toBeTruthy();
    });
    fireEvent.click(getByText("readme.md"));

    expect(onFileOpen).toHaveBeenCalledTimes(1);
    expect(onFileOpen).toHaveBeenCalledWith("readme.md", "readme.md");
  });
});

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

/** Build a right-click mouse event with sensible viewport coords. */
function rightClick(target: Element) {
  // jsdom doesn't compute bounding rects for our tree reliably, so we
  // just dispatch a contextmenu on the element directly. The handler
  // reads `e.clientX/Y` and clamps; any non-negative pair works.
  return fireEvent.contextMenu(target, { clientX: 10, clientY: 10 });
}

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

  it("right-clicking a directory and choosing New File invokes cmd_create_file with the joined path", async () => {
    const onFileOpen = vi.fn();
    // 1) root listing with one directory
    mockInvoke.mockResolvedValueOnce([
      { name: "src", path: "src", isDir: true },
    ] as FsEntry[]);
    // 2) refresh of `src` after creation
    mockInvoke.mockResolvedValueOnce([] as FsEntry[]);

    const { getByTestId, queryByTestId } = render(
      <FileTree workspace="/ws" onFileOpen={onFileOpen} />,
    );

    // Wait for the root row to appear, then right-click it.
    await waitFor(() => {
      expect(getByTestId("tree-row-src")).toBeTruthy();
    });
    rightClick(getByTestId("tree-row-src"));

    // Context menu appears; click "New File".
    await waitFor(() => {
      expect(getByTestId("file-tree-contextmenu")).toBeTruthy();
    });
    fireEvent.click(getByTestId("ctx-item-new-file"));

    // Modal opens, type a name, submit.
    const input = getByTestId("prompt-modal-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "foo.ts" } });
    fireEvent.click(getByTestId("prompt-modal-submit"));

    // Verify the create IPC and the parent refresh.
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("cmd_create_file", {
        path: "src/foo.ts",
      });
    });
    await waitFor(() => {
      // The "refresh of src" mock was the second mockResolvedValueOnce;
      // the cmd_list_dir call for `src` is what consumes it.
      expect(mockInvoke).toHaveBeenCalledWith("cmd_list_dir", { path: "src" });
    });
    // The modal should have closed on success.
    expect(queryByTestId("prompt-modal")).toBeNull();
  });

  it("right-clicking a file and confirming delete invokes both cmd_confirm_delete and cmd_delete_entry", async () => {
    const onFileOpen = vi.fn();
    mockInvoke.mockResolvedValueOnce([
      { name: "a.ts", path: "a.ts", isDir: false },
    ] as FsEntry[]);
    // 1) confirm → true
    mockInvoke.mockResolvedValueOnce(true as never);
    // 2) parent refresh of root
    mockInvoke.mockResolvedValueOnce([] as FsEntry[]);

    const { getByTestId } = render(
      <FileTree workspace="/ws" onFileOpen={onFileOpen} />,
    );

    await waitFor(() => {
      expect(getByTestId("tree-row-a.ts")).toBeTruthy();
    });
    rightClick(getByTestId("tree-row-a.ts"));
    await waitFor(() => {
      expect(getByTestId("ctx-item-delete")).toBeTruthy();
    });
    fireEvent.click(getByTestId("ctx-item-delete"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("cmd_confirm_delete", {
        path: "a.ts",
      });
    });
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("cmd_delete_entry", {
        path: "a.ts",
      });
    });
  });

  it("right-clicking a file and cancelling delete does NOT call cmd_delete_entry", async () => {
    const onFileOpen = vi.fn();
    mockInvoke.mockResolvedValueOnce([
      { name: "a.ts", path: "a.ts", isDir: false },
    ] as FsEntry[]);
    // confirm → false (user clicked Cancel)
    mockInvoke.mockResolvedValueOnce(false as never);

    const { getByTestId } = render(
      <FileTree workspace="/ws" onFileOpen={onFileOpen} />,
    );

    await waitFor(() => {
      expect(getByTestId("tree-row-a.ts")).toBeTruthy();
    });
    rightClick(getByTestId("tree-row-a.ts"));
    fireEvent.click(getByTestId("ctx-item-delete"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("cmd_confirm_delete", {
        path: "a.ts",
      });
    });
    // Wait one tick to give the (should-not-happen) cmd_delete_entry a
    // chance to be called. waitFor with a tiny timeout ensures we don't
    // race the React state update.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "cmd_delete_entry",
      expect.objectContaining({ path: "a.ts" }),
    );
  });

  it("keeps the create modal open and shows the error when cmd_create_file throws", async () => {
    const onFileOpen = vi.fn();
    mockInvoke.mockResolvedValueOnce([
      { name: "src", path: "src", isDir: true },
    ] as FsEntry[]);
    // The create call rejects. The list_dir refresh is never reached
    // because the modal stays open.
    mockInvoke.mockRejectedValueOnce(new Error("target already exists: src/dup.ts"));

    const { getByTestId, getByText, queryByTestId } = render(
      <FileTree workspace="/ws" onFileOpen={onFileOpen} />,
    );

    await waitFor(() => {
      expect(getByTestId("tree-row-src")).toBeTruthy();
    });
    rightClick(getByTestId("tree-row-src"));
    fireEvent.click(getByTestId("ctx-item-new-file"));

    const input = getByTestId("prompt-modal-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "dup.ts" } });
    fireEvent.click(getByTestId("prompt-modal-submit"));

    await waitFor(() => {
      expect(getByTestId("prompt-modal-error")).toBeTruthy();
    });
    // The error string is the message we rejected with.
    expect(getByText(/target already exists: src\/dup\.ts/)).toBeTruthy();
    // Modal must still be on screen so the user can correct the input.
    expect(queryByTestId("prompt-modal")).not.toBeNull();
  });

  it("dismisses the context menu when clicking outside it", async () => {
    const onFileOpen = vi.fn();
    mockInvoke.mockResolvedValueOnce([
      { name: "a.ts", path: "a.ts", isDir: false },
    ] as FsEntry[]);

    const { getByTestId, queryByTestId } = render(
      <div>
        <FileTree workspace="/ws" onFileOpen={onFileOpen} />
        <button data-testid="outside" type="button">Outside</button>
      </div>,
    );

    await waitFor(() => {
      expect(getByTestId("tree-row-a.ts")).toBeTruthy();
    });
    rightClick(getByTestId("tree-row-a.ts"));
    await waitFor(() => {
      expect(getByTestId("file-tree-contextmenu")).toBeTruthy();
    });

    // Click outside — jsdom dispatches the mousedown listener we
    // installed on `document` and the menu should be gone after the
    // next render. fireEvent's `mousedown` mirrors a real click's
    // pointer→mousedown sequence.
    fireEvent.mouseDown(getByTestId("outside"));
    await waitFor(() => {
      expect(queryByTestId("file-tree-contextmenu")).toBeNull();
    });
  });

  it("removes a deleted directory from the expanded set so its stale children are not re-rendered", async () => {
    const onFileOpen = vi.fn();
    // 1) root listing with one directory `sub`
    mockInvoke.mockResolvedValueOnce([
      { name: "sub", path: "sub", isDir: true },
    ] as FsEntry[]);
    // 2) inside `sub`
    mockInvoke.mockResolvedValueOnce([
      { name: "x.ts", path: "sub/x.ts", isDir: false },
    ] as FsEntry[]);
    // 3) confirm → true
    mockInvoke.mockResolvedValueOnce(true as never);
    // 4) delete succeeds
    mockInvoke.mockResolvedValueOnce(undefined as never);
    // 5) refresh of root
    mockInvoke.mockResolvedValueOnce([] as FsEntry[]);

    const { getByTestId, queryByTestId } = render(
      <FileTree workspace="/ws" onFileOpen={onFileOpen} />,
    );

    await waitFor(() => {
      expect(getByTestId("tree-row-sub")).toBeTruthy();
    });
    // Expand `sub` so it ends up in the `expanded` set.
    fireEvent.click(getByTestId("tree-row-sub"));
    await waitFor(() => {
      expect(getByTestId("tree-row-sub/x.ts")).toBeTruthy();
    });

    // Right-click `sub` and delete it.
    rightClick(getByTestId("tree-row-sub"));
    fireEvent.click(getByTestId("ctx-item-delete"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("cmd_delete_entry", {
        path: "sub",
      });
    });
    // After delete + refresh, `sub` should no longer be in the DOM and
    // the stale `sub/x.ts` row should also be gone (it was dropped
    // along with `sub` because we collapsed the deleted dir).
    await waitFor(() => {
      expect(queryByTestId("tree-row-sub")).toBeNull();
      expect(queryByTestId("tree-row-sub/x.ts")).toBeNull();
    });
  });

  it("renders a virtual workspace root row using the last path segment as its name", async () => {
    const onFileOpen = vi.fn();
    mockInvoke.mockResolvedValueOnce([] as FsEntry[]);

    const { getByTestId } = render(
      <FileTree workspace="/path/to/my-project" onFileOpen={onFileOpen} />,
    );

    await waitFor(() => {
      expect(getByTestId("tree-row-root")).toBeTruthy();
    });
    // The name in the row should be the basename of the workspace path.
    expect(getByTestId("tree-row-root").textContent).toContain("my-project");
  });

  it("falls back to 'workspace' as the root name when the workspace path has no usable segment", async () => {
    const onFileOpen = vi.fn();
    mockInvoke.mockResolvedValueOnce([] as FsEntry[]);

    // Path consisting only of slashes — deriveWorkspaceName should
    // walk past the empty segments and fall back to the literal
    // "workspace" string.
    const { getByTestId } = render(
      <FileTree workspace="//" onFileOpen={onFileOpen} />,
    );

    await waitFor(() => {
      expect(getByTestId("tree-row-root")).toBeTruthy();
    });
    expect(getByTestId("tree-row-root").textContent).toContain("workspace");
  });

  it("root context menu has New File / New Folder but no Delete item", async () => {
    const onFileOpen = vi.fn();
    mockInvoke.mockResolvedValueOnce([] as FsEntry[]);

    const { getByTestId, queryByTestId } = render(
      <FileTree workspace="/ws" onFileOpen={onFileOpen} />,
    );

    await waitFor(() => {
      expect(getByTestId("tree-row-root")).toBeTruthy();
    });
    rightClick(getByTestId("tree-row-root"));

    await waitFor(() => {
      expect(getByTestId("file-tree-contextmenu")).toBeTruthy();
    });
    expect(getByTestId("ctx-item-new-file")).toBeTruthy();
    expect(getByTestId("ctx-item-new-dir")).toBeTruthy();
    // Root must NOT offer Delete — `cmd_delete_entry` would reject it
    // anyway, so the UI shouldn't even surface the option.
    expect(queryByTestId("ctx-item-delete")).toBeNull();
  });

  it("creating a file from the root context menu uses the bare name as the workspace-relative path", async () => {
    const onFileOpen = vi.fn();
    // 1) initial root listing
    mockInvoke.mockResolvedValueOnce([] as FsEntry[]);
    // 2) refresh of root after creation
    mockInvoke.mockResolvedValueOnce([] as FsEntry[]);

    const { getByTestId } = render(
      <FileTree workspace="/ws" onFileOpen={onFileOpen} />,
    );

    await waitFor(() => {
      expect(getByTestId("tree-row-root")).toBeTruthy();
    });
    rightClick(getByTestId("tree-row-root"));
    fireEvent.click(getByTestId("ctx-item-new-file"));

    const input = getByTestId("prompt-modal-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello.ts" } });
    fireEvent.click(getByTestId("prompt-modal-submit"));

    // parentPathOf("") returns "" so the joined path is just the
    // name — no leading slash, no "root/" prefix.
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("cmd_create_file", {
        path: "hello.ts",
      });
    });
    // And the parent refresh should target the root (path: null).
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("cmd_list_dir", { path: null });
    });
  });
});

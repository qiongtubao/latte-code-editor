import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileTree } from "../src/FileTree.js";

afterEach(cleanup);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([
    { name: "src", path: "src", isDir: true },
    { name: "index.ts", path: "index.ts", isDir: false },
  ]),
}));

describe("FileTree", () => {
  it("renders entries from invoke with their file-type icons", async () => {
    render(<FileTree onOpen={() => {}} />);
    // The list item renders the emoji, a space, and the filename as three
    // separate text nodes, so we match by a function that joins textContent.
    // This still asserts the *whole* row's content, including the icon.
    const fileRow = await screen.findByText(
      (_content, el) => el?.tagName === "LI" && el.textContent === "📄 index.ts"
    );
    expect(fileRow).toBeTruthy();
    expect(screen.getByText(
      (_content, el) => el?.tagName === "LI" && el.textContent === "📁 src"
    )).toBeTruthy();
  });

  it("invokes onOpen when a file row is clicked and skips directories", async () => {
    const onOpen = vi.fn();
    render(<FileTree onOpen={onOpen} />);
    const file = await screen.findByText(
      (_content, el) => el?.tagName === "LI" && el.textContent === "📄 index.ts"
    );
    const dir = screen.getByText(
      (_content, el) => el?.tagName === "LI" && el.textContent === "📁 src"
    );
    fireEvent.click(file);
    fireEvent.click(dir);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("index.ts");
  });

  it("renders an empty list when invoke rejects", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    render(<FileTree onOpen={() => {}} />);
    await waitFor(() => {
      expect(
        screen.queryByText(
          (_content, el) => !!el && el.textContent === "📄 index.ts"
        )
      ).toBeNull();
    });
  });
});

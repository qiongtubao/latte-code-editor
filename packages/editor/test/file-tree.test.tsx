import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileTree } from "../src/FileTree.js";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([
    { name: "src", path: "src", is_dir: true },
    { name: "index.ts", path: "index.ts", is_dir: false },
  ]),
}));

describe("FileTree", () => {
  it("renders entries from invoke", async () => {
    render(<FileTree onOpen={() => {}} />);
    expect(await screen.findByText(/index\.ts/)).toBeTruthy();
  });
});

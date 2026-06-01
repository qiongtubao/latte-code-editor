import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { CommandPalette } from "../src/CommandPalette.js";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([{ kind: "file", label: "src/foo.ts" }]),
}));
describe("CommandPalette", () => {
  it("searches on input", async () => {
    render(<CommandPalette onPick={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/type to search/), { target: { value: "foo" } });
    expect(await screen.findByText("src/foo.ts")).toBeTruthy();
  });
});

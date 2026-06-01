import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Drawer } from "../src/Drawer.js";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([
    { name: "foo", file: "a.ts", line: 5, role: "caller" },
    { name: "foo", file: "b.ts", line: 12, role: "callee" },
  ]),
}));

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });

describe("Drawer", () => {
  it("renders the call hierarchy header and entries from invoke", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mock = invoke as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue([
      { name: "foo", file: "a.ts", line: 5, role: "caller" },
      { name: "foo", file: "b.ts", line: 12, role: "callee" },
    ]);
    render(<Drawer symbol="foo" onClose={() => {}} onJump={() => {}} />);
    expect(await screen.findByText(/Call Hierarchy · foo/)).toBeTruthy();
    await waitFor(() => expect(mock).toHaveBeenCalledWith("cmd_call_hierarchy", { symbol: "foo" }));
    expect(screen.getByText("caller")).toBeTruthy();
    expect(screen.getByText("callee")).toBeTruthy();
  });

  it("renders nothing when symbol is null", () => {
    const { container } = render(<Drawer symbol={null} onClose={() => {}} onJump={() => {}} />);
    expect(container.querySelector('[data-testid="drawer"]')).toBeNull();
  });

  it("invokes onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<Drawer symbol="foo" onClose={onClose} onJump={() => {}} />);
    fireEvent.click(screen.getByText("✕"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invokes onJump with the node when a row is clicked", async () => {
    const onJump = vi.fn();
    render(<Drawer symbol="foo" onClose={() => {}} onJump={onJump} />);
    const row = await screen.findByText((_c, el) =>
      !!el && el.textContent === "↑ caller foo (a.ts:5)"
    );
    fireEvent.click(row);
    expect(onJump).toHaveBeenCalledWith({ name: "foo", file: "a.ts", line: 5, role: "caller" });
  });
});

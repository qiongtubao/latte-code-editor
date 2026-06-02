import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CommandPalette, CLOSE_HIT } from "../src/CommandPalette.js";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

describe("CommandPalette", () => {
  it("searches on input and renders hits", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { kind: "file", label: "src/foo.ts" },
    ]);
    render(<CommandPalette onPick={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/type to search/), { target: { value: "foo" } });
    expect(await screen.findByTestId("palette-hit")).toBeTruthy();
    expect(screen.getByText("src/foo.ts")).toBeTruthy();
  });

  it("sends mode='cmd' and stripped term when the query starts with '>'", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mock = invoke as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue([{ kind: "cmd", label: "> build" }]);
    render(<CommandPalette onPick={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/type to search/), { target: { value: ">build" } });
    await waitFor(() => expect(mock).toHaveBeenCalled());
    const call = mock.mock.calls.at(-1)!;
    expect(call[0]).toBe("palette_search");
    expect(call[1]).toEqual({ mode: "cmd", term: "build", limit: 20 });
  });

  it("sends mode='symbol' when the query starts with '@'", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mock = invoke as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue([]);
    render(<CommandPalette onPick={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/type to search/), { target: { value: "@mySym" } });
    await waitFor(() => expect(mock).toHaveBeenCalled());
    const call = mock.mock.calls.at(-1)!;
    expect(call[1]).toEqual({ mode: "symbol", term: "mySym", limit: 20 });
  });

  it("ArrowDown / ArrowUp move the active highlight and clamp at the ends", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { kind: "file", label: "a.ts" },
      { kind: "file", label: "b.ts" },
      { kind: "file", label: "c.ts" },
    ]);
    render(<CommandPalette onPick={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/type to search/), { target: { value: "x" } });
    const items = await screen.findAllByTestId("palette-hit");
    expect(items).toHaveLength(3);
    const input = screen.getByPlaceholderText(/type to search/);
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(items[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(items[2].getAttribute("aria-selected")).toBe("true");
    // Past the end: clamps.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(items[2].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(items[1].getAttribute("aria-selected")).toBe("true");
  });

  it("Enter invokes onPick with the active hit", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { kind: "file", label: "first.ts" },
      { kind: "file", label: "second.ts" },
    ]);
    const onPick = vi.fn();
    render(<CommandPalette onPick={onPick} />);
    fireEvent.change(screen.getByPlaceholderText(/type to search/), { target: { value: "x" } });
    // Wait for debounce + IPC + render so the hit list exists.
    await screen.findAllByTestId("palette-hit");
    const input = screen.getByPlaceholderText(/type to search/);
    fireEvent.keyDown(input, { key: "ArrowDown" }); // active = 1
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({ kind: "file", label: "second.ts" });
  });

  it("Escape invokes onPick with the close sentinel", () => {
    const onPick = vi.fn();
    render(<CommandPalette onPick={onPick} />);
    fireEvent.keyDown(screen.getByPlaceholderText(/type to search/), { key: "Escape" });
    expect(onPick).toHaveBeenCalledWith(CLOSE_HIT);
  });

  it("empty query does not invoke palette_search", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mock = invoke as unknown as ReturnType<typeof vi.fn>;
    mock.mockClear();
    render(<CommandPalette onPick={() => {}} />);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("CommandPalette (semantic)", () => {
  it("uses semantic search when toggled and query starts with '@'", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mock = invoke as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue([
      { name: "login", file: "a.ts", line: 1, score: 0.9 },
    ]);
    render(<CommandPalette onPick={() => {}} semantic />);
    fireEvent.change(screen.getByPlaceholderText(/type to search/), {
      target: { value: "@login" },
    });
    await waitFor(() => expect(mock).toHaveBeenCalled());
    const call = mock.mock.calls.find((c) => c[0] === "cmd_semantic_search");
    expect(call).toBeDefined();
    expect(call![1]).toEqual({ query: "login", k: 20 });
  });
});

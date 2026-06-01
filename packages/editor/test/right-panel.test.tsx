import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RightPanel } from "../src/RightPanel.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });

describe("RightPanel", () => {
  it("renders the outline tab with the supplied nodes by default", () => {
    render(
      <RightPanel
        outline={[
          { name: "foo", kind: "function", line: 1 },
          { name: "Bar", kind: "class", line: 12 },
          { name: "baz", kind: "variable", line: 20 },
        ]}
        onSelect={() => {}}
      />
    );
    expect(screen.getByText("Outline")).toBeTruthy();
    // The function/class/variable glyphs each prefix the name in its <li>.
    expect(screen.getByText("ƒ foo")).toBeTruthy();
    expect(screen.getByText("◇ Bar")).toBeTruthy();
    expect(screen.getByText("· baz")).toBeTruthy();
    // Line numbers are also rendered.
    expect(screen.getByText(":1")).toBeTruthy();
  });

  it("invokes onSelect with the clicked outline node", () => {
    const onSelect = vi.fn();
    render(
      <RightPanel
        outline={[{ name: "foo", kind: "function", line: 1 }]}
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByText("ƒ foo"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ name: "foo", kind: "function", line: 1 });
  });

  it("switches to the Graph tab and mounts the GraphView", () => {
    const { container } = render(
      <RightPanel
        outline={[{ name: "foo", kind: "function", line: 1 }]}
        onSelect={() => {}}
      />
    );
    // Before click: outline is visible, GraphView is not.
    expect(screen.getByText("ƒ foo")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();

    fireEvent.click(screen.getByText(/Graph/));

    // After click: outline is gone, the GraphView's svg is mounted.
    expect(screen.queryByText("ƒ foo")).toBeNull();
    const svg = container.querySelector("svg.bg-zinc-900");
    expect(svg).toBeTruthy();
  });
});

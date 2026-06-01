import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RightPanel } from "../src/RightPanel.js";

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

  it("switches to the Graph tab and shows the T15 placeholder", () => {
    render(
      <RightPanel
        outline={[{ name: "foo", kind: "function", line: 1 }]}
        onSelect={() => {}}
      />
    );
    // Before click: outline is visible, placeholder is not.
    expect(screen.getByText("ƒ foo")).toBeTruthy();
    expect(screen.queryByTestId("graph-placeholder")).toBeNull();

    fireEvent.click(screen.getByText(/Graph/));

    // After click: outline is gone, placeholder is mounted.
    expect(screen.queryByText("ƒ foo")).toBeNull();
    const placeholder = screen.getByTestId("graph-placeholder");
    expect(placeholder).toBeTruthy();
    // The stub echoes the center name so we can also verify the prop wires through.
    expect(placeholder.textContent).toContain("foo");
  });
});

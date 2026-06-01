import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { GraphView } from "../src/GraphView.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });

describe("GraphView", () => {
  it("renders an svg", () => {
    const { container } = render(<GraphView center="foo" />);
    expect(container.querySelector("svg")).toBeTruthy();
  });
});

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { GraphView } from "../src/GraphView.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });

describe("GraphView", () => {
  // The Worker polyfill in setup.ts silently no-ops postMessage, so we
  // can only smoke-test that the component mounts and renders its svg.
  // Position-mapping is exercised in the right-panel integration test.
  it("renders an svg", () => {
    const { container } = render(<GraphView center="foo" />);
    expect(container.querySelector("svg")).toBeTruthy();
  });
});

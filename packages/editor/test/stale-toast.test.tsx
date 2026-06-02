import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StaleToast } from "../src/StaleToast.js";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

describe("StaleToast", () => {
  it("renders when dirty", () => {
    render(<StaleToast dirtyCount={3} onRebuild={() => {}} />);
    expect(screen.getByTestId("stale-toast")).toBeTruthy();
    expect(screen.getByText("3 files changed · graph out of date")).toBeTruthy();
  });

  it("does not render when clean", () => {
    render(<StaleToast dirtyCount={0} onRebuild={() => {}} />);
    expect(screen.queryByTestId("stale-toast")).toBeNull();
  });

  it("calls onRebuild when the Rebuild button is clicked", () => {
    const onRebuild = vi.fn();
    render(<StaleToast dirtyCount={3} onRebuild={onRebuild} />);
    fireEvent.click(screen.getByText("Rebuild"));
    expect(onRebuild).toHaveBeenCalledTimes(1);
  });

  it("hides the toast when the dismiss button is clicked", () => {
    render(<StaleToast dirtyCount={3} onRebuild={() => {}} />);
    expect(screen.getByTestId("stale-toast")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("dismiss"));
    expect(screen.queryByTestId("stale-toast")).toBeNull();
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { EmptyState } from "./EmptyState.js";
import { SAMPLES } from "../samples.js";

afterEach(cleanup);

describe("EmptyState", () => {
  it("renders one chip per sample", () => {
    const onOpen = vi.fn();
    const { getAllByRole } = render(<EmptyState onOpen={onOpen} />);
    // Buttons named after the file
    const buttons = getAllByRole("button").filter((b) =>
      b.textContent?.endsWith(".ts"),
    );
    expect(buttons).toHaveLength(SAMPLES.length);
  });

  it("fires onOpen with the sample when its chip is clicked", () => {
    const onOpen = vi.fn();
    const { getByText } = render(<EmptyState onOpen={onOpen} />);
    fireEvent.click(getByText("index.ts"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(SAMPLES[0]);
  });
});

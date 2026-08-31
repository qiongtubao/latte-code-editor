import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  LazyFeatureBoundary,
  type ComponentLoader,
} from "./LazyFeatureBoundary";

interface DemoProps {
  value: string;
}

function Demo({ value }: DemoProps) {
  return <div>loaded:{value}</div>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("LazyFeatureBoundary", () => {
  it("shows a stable loading state and forwards component props", async () => {
    const pending = deferred<Awaited<ReturnType<ComponentLoader<DemoProps>>>>();
    const loader = vi.fn(() => pending.promise);

    render(
      <LazyFeatureBoundary
        loader={loader}
        componentProps={{ value: "first" }}
        label="demo"
      />,
    );

    expect(screen.getByLabelText("Loading demo").getAttribute("aria-busy")).toBe("true");
    pending.resolve(Demo);
    expect(await screen.findByText("loaded:first")).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("shows the import error and can close or retry", async () => {
    const onClose = vi.fn();
    const loader = vi
      .fn<ComponentLoader<DemoProps>>()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockResolvedValueOnce(Demo);

    render(
      <LazyFeatureBoundary
        loader={loader}
        componentProps={{ value: "retry" }}
        label="Demo panel"
        onClose={onClose}
      />,
    );

    expect(await screen.findByText("Demo panel failed to load")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("chunk unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("loaded:retry")).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("updates props without reloading the already imported component", async () => {
    const loader = vi.fn<ComponentLoader<DemoProps>>().mockResolvedValue(Demo);
    const { rerender } = render(
      <LazyFeatureBoundary
        loader={loader}
        componentProps={{ value: "one" }}
        label="demo"
      />,
    );
    expect(await screen.findByText("loaded:one")).toBeTruthy();

    rerender(
      <LazyFeatureBoundary
        loader={loader}
        componentProps={{ value: "two" }}
        label="demo"
      />,
    );
    expect(await screen.findByText("loaded:two")).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

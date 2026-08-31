import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GraphRevealRequest } from "../hooks/graphTypes";
import {
  LazyGraphPanel,
  type GraphPanelLoader,
  type GraphPanelProps,
} from "./LazyGraphPanel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function FakeGraphPanel({ folderRoot, revealRequest }: GraphPanelProps) {
  return (
    <div>
      loaded:{folderRoot}:{revealRequest?.nodeId}:{revealRequest?.requestId}
    </div>
  );
}

describe("LazyGraphPanel", () => {
  it("shows a stable fallback and forwards a reveal queued while loading", async () => {
    const pending = deferred<Awaited<ReturnType<GraphPanelLoader>>>();
    const loader = vi.fn(() => pending.promise);
    const revealRequest: GraphRevealRequest = { nodeId: "node-a", requestId: 3 };

    render(
      <LazyGraphPanel
        folderRoot="/repo"
        revealRequest={revealRequest}
        loader={loader}
      />,
    );

    expect(screen.getByLabelText("Loading graph").getAttribute("aria-busy")).toBe("true");
    expect(loader).toHaveBeenCalledTimes(1);

    pending.resolve({ GraphPanel: FakeGraphPanel });
    expect(await screen.findByText("loaded:/repo:node-a:3")).toBeTruthy();
  });

  it("surfaces chunk failures and retries with the same loader", async () => {
    const loader = vi
      .fn<GraphPanelLoader>()
      .mockRejectedValueOnce(new Error("chunk offline"))
      .mockResolvedValueOnce({ GraphPanel: FakeGraphPanel });

    render(<LazyGraphPanel folderRoot="/repo" loader={loader} />);

    expect(await screen.findByText("Graph failed to load")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("chunk offline");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("loaded:/repo::")).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("forwards repeated requests for the same node when requestId changes", async () => {
    const loader = vi.fn<GraphPanelLoader>().mockResolvedValue({ GraphPanel: FakeGraphPanel });
    const { rerender } = render(
      <LazyGraphPanel
        revealRequest={{ nodeId: "same-node", requestId: 1 }}
        loader={loader}
      />,
    );
    expect(await screen.findByText("loaded::same-node:1")).toBeTruthy();

    rerender(
      <LazyGraphPanel
        revealRequest={{ nodeId: "same-node", requestId: 2 }}
        loader={loader}
      />,
    );
    expect(await screen.findByText("loaded::same-node:2")).toBeTruthy();
    // Changing only reveal state must not reload the code chunk.
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

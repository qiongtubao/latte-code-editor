import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { usePersistWorkspace } from "../src/hooks/useSession.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);
describe("usePersistWorkspace", () => {
  it("calls invoke when path changes", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    renderHook(() => usePersistWorkspace("/ws/a"));
    expect(invoke).toHaveBeenCalledWith("cmd_set_last_workspace", { path: "/ws/a" });
  });
});

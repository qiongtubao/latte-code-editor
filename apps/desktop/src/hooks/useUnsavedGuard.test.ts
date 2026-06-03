import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { requestFileSwitch } from "./useUnsavedGuard.js";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => { vi.clearAllMocks(); });

describe("requestFileSwitch", () => {
  it("runs the thunk immediately when not dirty", () => {
    const thunk = vi.fn();
    requestFileSwitch(false, thunk);
    expect(thunk).toHaveBeenCalledTimes(1);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("when dirty, asks plugin:dialog|message and runs thunk on non-Cancel", async () => {
    mockInvoke.mockResolvedValue("Discard");
    const thunk = vi.fn();
    await new Promise<void>((r) => {
      requestFileSwitch(true, () => { thunk(); r(); });
    });
    expect(mockInvoke).toHaveBeenCalledWith("plugin:dialog|message", expect.objectContaining({
      message: "Discard unsaved changes?",
      buttons: { OkCancelCustom: ["Discard", "Cancel"] },
    }));
    expect(thunk).toHaveBeenCalledTimes(1);
  });

  it("when dirty and user picks Cancel, thunk is not called", async () => {
    mockInvoke.mockResolvedValue("Cancel");
    const thunk = vi.fn();
    // The Cancel branch never invokes the swap, so the `r()` inside
    // the swap wrapper would never fire. Flush the dialog's .then
    // via a microtask tick instead, then assert.
    requestFileSwitch(true, () => { thunk(); });
    await Promise.resolve();
    expect(mockInvoke).toHaveBeenCalled();
    expect(thunk).not.toHaveBeenCalled();
  });
});

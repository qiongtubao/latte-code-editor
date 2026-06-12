import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDebugLogger } from "./logger";
import { useDebugStore } from "./store";

describe("createDebugLogger", () => {
  beforeEach(() => {
    useDebugStore.setState({ isOn: true, verbose: false });
    localStorage.removeItem("latte.debug.verbose");
  });

  it("suppresses level=debug when verbose is off", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = createDebugLogger("editor");
    log.debug("file.content", "typing", { path: "/a" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("emits level=debug when verbose is on", () => {
    useDebugStore.setState({ verbose: true });
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = createDebugLogger("editor");
    log.debug("file.content", "typing", { path: "/a" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
  it("emits a JSON line via console when isOn", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = createDebugLogger("lsp");
    log.info("lsp.start", "starting rust-analyzer", { language: "rust" });
    const call = spy.mock.calls[0]?.[0] as string;
    expect(call).toMatch(/^latte:/);
    const json = call.replace(/^latte:/, "");
    const parsed = JSON.parse(json);
    expect(parsed.event).toBe("lsp.start");
    expect(parsed.module).toBe("lsp");
    expect(parsed.ctx.language).toBe("rust");
    spy.mockRestore();
  });

  it("redacts secret keys", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = createDebugLogger("ipc");
    log.info("ipc.invoke", "auth", { password: "p", token: "t", safe: "ok" });
    const call = (spy.mock.calls[0]?.[0] as string).replace(/^latte:/, "");
    const parsed = JSON.parse(call);
    expect(parsed.ctx.password).toBe("***");
    expect(parsed.ctx.token).toBe("***");
    expect(parsed.ctx.safe).toBe("ok");
    spy.mockRestore();
  });

  it("throttles by (event+traceId) within 100ms", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = createDebugLogger("graph", { throttleMs: 100 });
    log.info("graph.nodeClick", "x", { traceId: "abc" });
    log.info("graph.nodeClick", "x", { traceId: "abc" });
    log.info("graph.nodeClick", "x", { traceId: "abc" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("does not emit when isOn is false (errors still pass)", () => {
    useDebugStore.setState({ isOn: false });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createDebugLogger("editor");
    log.info("file.open", "x", { path: "/a" });
    log.error("file.error", "boom", { path: "/a" });
    expect(spy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    errSpy.mockRestore();
  });
});

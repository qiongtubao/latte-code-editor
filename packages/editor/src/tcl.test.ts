import { describe, it, expect, vi, beforeEach } from "vitest";

const register = vi.fn();
const setMonarchTokensProvider = vi.fn();
const setLanguageConfiguration = vi.fn();

vi.mock("monaco-editor", () => ({
  languages: {
    register,
    setMonarchTokensProvider,
    setLanguageConfiguration,
  },
}));

import { registerTcl } from "./tcl.js";

beforeEach(() => {
  register.mockClear();
  setMonarchTokensProvider.mockClear();
  setLanguageConfiguration.mockClear();
});

describe("registerTcl", () => {
  it("registers the language and tokens exactly once across multiple calls", () => {
    const monaco = { languages: { register, setMonarchTokensProvider, setLanguageConfiguration } };
    registerTcl(monaco as never);
    registerTcl(monaco as never);
    registerTcl(monaco as never);
    expect(register).toHaveBeenCalledTimes(1);
    expect(setMonarchTokensProvider).toHaveBeenCalledTimes(1);
    expect(setLanguageConfiguration).toHaveBeenCalledTimes(1);
    // The first arg of register must be the tcl id.
    // (Monaco's `languages.register` takes a single language-descriptor
    // argument; the plan's original `expect.anything()` second-arg
    // matcher contradicted that and was dropped — the spirit of the
    // assertion is preserved.)
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tcl" }),
    );
  });
});

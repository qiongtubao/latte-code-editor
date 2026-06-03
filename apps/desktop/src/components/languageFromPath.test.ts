import { describe, it, expect } from "vitest";
import { languageFromPath } from "./languageFromPath.js";

describe("languageFromPath", () => {
  it("maps .tcl and .tk to tcl", () => {
    expect(languageFromPath("foo.tcl")).toBe("tcl");
    expect(languageFromPath("widgets.tk")).toBe("tcl");
    expect(languageFromPath("nested/path/foo.TCL")).toBe("tcl");
  });
});

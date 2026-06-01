import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBar } from "../src/StatusBar.js";
describe("StatusBar", () => {
  it("shows dirty dot when dirty=true", () => {
    render(<StatusBar language="typescript" dirty indexing indexed={0} />);
    expect(screen.getByTitle("uncommitted changes")).toBeTruthy();
  });
  it("shows file count when idle", () => {
    render(<StatusBar language="typescript" dirty={false} indexing={false} indexed={42} />);
    expect(screen.getByText("42 files indexed")).toBeTruthy();
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusBar } from "../src/StatusBar.js";

afterEach(cleanup);

describe("StatusBar", () => {
  it("shows dirty dot when dirty=true", () => {
    render(<StatusBar language="typescript" dirty indexing indexed={0} />);
    expect(screen.getByTitle("uncommitted changes")).toBeTruthy();
  });

  it("shows file count when idle", () => {
    render(<StatusBar language="typescript" dirty={false} indexing={false} indexed={42} />);
    expect(screen.getByText("42 files indexed")).toBeTruthy();
  });

  it("hides the dirty dot when dirty=false", () => {
    render(<StatusBar language="typescript" dirty={false} indexing={false} indexed={0} />);
    expect(screen.queryByTitle("uncommitted changes")).toBeNull();
  });

  it("shows 'indexing…' instead of file count while indexing", () => {
    render(<StatusBar language="typescript" dirty={false} indexing indexed={42} />);
    expect(screen.getByText("indexing…")).toBeTruthy();
    expect(screen.queryByText("42 files indexed")).toBeNull();
  });
});

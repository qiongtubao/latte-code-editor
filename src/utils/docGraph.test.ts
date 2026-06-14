import { describe, it, expect } from "vitest";
import { buildDocSim } from "./docGraph";

describe("buildDocSim", () => {
  it("returns empty for no files", async () => {
    const sim = await buildDocSim([], async () => "");
    expect(sim.nodes).toEqual([]);
    expect(sim.edges).toEqual([]);
  });

  it("skips non-md files", async () => {
    const sim = await buildDocSim(
      [{ name: "a.txt", path: "/a.txt", is_dir: false }],
      async () => "",
    );
    expect(sim.nodes).toEqual([]);
  });

  it("builds nodes from .md files", async () => {
    const sim = await buildDocSim(
      [
        { name: "a.md", path: "/dir/a.md", is_dir: false },
        { name: "b.md", path: "/dir/b.md", is_dir: false },
      ],
      async () => "---\ntype: entity\ntitle: A\n---\n",
    );
    expect(sim.nodes.length).toBe(2);
    expect(sim.nodes.every((n) => n.group === 0)).toBe(true); // entity
  });
  it("builds edges from wikilinks using path-form", async () => {
    // The doc IDs are full paths; the wikilink resolver matches against those
    // IDs via several candidate forms including the last path segment.
    const sim = await buildDocSim(
      [
        { name: "a.md", path: "/dir/a.md", is_dir: false },
        { name: "b.md", path: "/dir/b.md", is_dir: false },
      ],
      async (p) => p.endsWith("a.md")
        ? "---\ntype: entity\ntitle: A\n---\nSee [[b]]."
        : "---\ntype: entity\ntitle: B\n---\n",
    );
    // Wikilink resolution uses basename match for IDs like "/dir/b" → matches "b"
    // so we should get a wikilink edge here.
    const wikilinkEdges = sim.edges.filter((e) => e.kind === "wikilink");
    expect(wikilinkEdges.length).toBeGreaterThan(0);
  });

  it("builds same-group chain edges", async () => {
    const sim = await buildDocSim(
      [
        { name: "a.md", path: "/entities/a.md", is_dir: false },
        { name: "b.md", path: "/entities/b.md", is_dir: false },
        { name: "c.md", path: "/entities/c.md", is_dir: false },
      ],
      async () => "---\ntype: entity\ntitle: A\n---\n",
    );
    // a-b and b-c (chain)
    expect(sim.edges.length).toBe(2);
    expect(sim.edges.every((e) => e.kind === "same-group")).toBe(true);
  });

  it("builds source-shared edges", async () => {
    const sim = await buildDocSim(
      [
        { name: "a.md", path: "/dir/a.md", is_dir: false },
        { name: "b.md", path: "/dir/b.md", is_dir: false },
      ],
      async (p) => p.endsWith("a.md")
        ? "---\ntype: entity\ntitle: A\nsources:\n  - src/shared.c\n---\n"
        : "---\ntype: entity\ntitle: B\nsources:\n  - src/shared.c\n---\n",
    );
    expect(sim.edges.some((e) => e.kind === "source-shared")).toBe(true);
  });
});

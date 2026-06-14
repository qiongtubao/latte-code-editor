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
    expect(sim.nodes.every((n) => n.group === 0)).toBe(true);
  });

  it("builds wikilink edges via basename resolution", async () => {
    const sim = await buildDocSim(
      [
        { name: "a.md", path: "/dir/a.md", is_dir: false },
        { name: "b.md", path: "/dir/b.md", is_dir: false },
      ],
      async (p) => p.endsWith("a.md")
        ? "---\ntype: entity\ntitle: A\n---\nSee [[b]]."
        : "---\ntype: entity\ntitle: B\n---\n",
    );
    const wikilink = sim.edges.find((e) => e.kind === "wikilink");
    expect(wikilink).toBeDefined();
    expect(wikilink!.source).toBe("/dir/a");
    expect(wikilink!.target).toBe("/dir/b");
    expect(wikilink!.weight).toBeCloseTo(0.75, 2);
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
    const sameGroup = sim.edges.filter((e) => e.kind === "same-group");
    expect(sameGroup.length).toBe(2);
    expect(sameGroup.every((e) => e.weight < 0.5)).toBe(true);
  });

  it("builds source-shared edges with weight 1.0", async () => {
    const sim = await buildDocSim(
      [
        { name: "a.md", path: "/dir/a.md", is_dir: false },
        { name: "b.md", path: "/dir/b.md", is_dir: false },
      ],
      async (p) => p.endsWith("a.md")
        ? "---\ntype: entity\ntitle: A\nsources:\n  - src/shared.c\n---\n"
        : "---\ntype: entity\ntitle: B\nsources:\n  - src/shared.c\n---\n",
    );
    const shared = sim.edges.find((e) => e.kind === "source-shared");
    expect(shared).toBeDefined();
    expect(shared!.weight).toBe(1.0);
  });

  it("weights order: source-shared > wikilink > same-group", async () => {
    // Build three docs: a, b, c with same group + a↔b wikilink + a↔c source-shared
    const sim = await buildDocSim(
      [
        { name: "a.md", path: "/dir/a.md", is_dir: false },
        { name: "b.md", path: "/dir/b.md", is_dir: false },
        { name: "c.md", path: "/dir/c.md", is_dir: false },
      ],
      async (p) => {
        if (p.endsWith("a.md")) {
          return "---\ntype: entity\ntitle: A\nsources:\n  - src/shared.c\n---\nSee [[b]].";
        }
        if (p.endsWith("b.md")) {
          return "---\ntype: entity\ntitle: B\n---\n";
        }
        return "---\ntype: entity\ntitle: C\nsources:\n  - src/shared.c\n---\n";
      },
    );
    const shared = sim.edges.find((e) => e.kind === "source-shared")!;
    const wiki = sim.edges.find((e) => e.kind === "wikilink")!;
    const same = sim.edges.find((e) => e.kind === "same-group")!;
    expect(shared.weight).toBeGreaterThan(wiki.weight);
    expect(wiki.weight).toBeGreaterThan(same.weight);
  });
});

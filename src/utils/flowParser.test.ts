import { describe, it, expect } from "vitest";
import { parseFlowDiagrams, renderFlowSvg } from "./flowParser";

describe("parseFlowDiagrams", () => {
  it("parses a single flow diagram", () => {
    const md = `# My Doc

Here is a flow:

\`\`\`flow:auth
title: Auth Flow

node start label="Start" {type: endpoint}
node login label="Login" {type: process}
edge start -> login
\`\`\`
`;
    const diagrams = parseFlowDiagrams(md);
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0].nodes).toHaveLength(2);
    expect(diagrams[0].nodes[0].label).toBe("Start");
    expect(diagrams[0].nodes[0].type).toBe("endpoint");
    expect(diagrams[0].edges[0].from).toBe("start");
    expect(diagrams[0].edges[0].to).toBe("login");
  });

  it("parses codeRef on nodes", () => {
    const md = `\`\`\`flow:test
node login label="Login" {type: process, codeRef: {file: src/auth.ts, lineStart: 10, lineEnd: 25}}
\`\`\``;
    const diagrams = parseFlowDiagrams(md);
    expect(diagrams[0].nodes[0].codeRef).toEqual({
      file: "src/auth.ts",
      lineStart: 10,
      lineEnd: 25,
    });
  });

  it("returns empty for non-flow content", () => {
    expect(parseFlowDiagrams("# Just markdown\n\nno flows here.\n")).toHaveLength(0);
  });
});

describe("renderFlowSvg", () => {
  it("returns valid SVG for a simple diagram", () => {
    const svg = renderFlowSvg({
      id: "test",
      title: "Test",
      nodes: [
        { id: "a", label: "A", type: "process" },
        { id: "b", label: "B", type: "endpoint" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("A");
    expect(svg).toContain("B");
  });

  it("returns empty for empty diagram", () => {
    expect(renderFlowSvg({ id: "x", title: "", nodes: [], edges: [] })).toBe("");
  });
});

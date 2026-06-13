/**
 * Parse flow diagrams from markdown and render to inline SVG.
 */
export interface FlowNode {
  id: string;
  label: string;
  type: "process" | "decision" | "endpoint";
  codeRef?: { file: string; lineStart: number; lineEnd: number };
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
}

export interface FlowDiagram {
  id: string;
  title: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export function parseFlowDiagrams(markdown: string): FlowDiagram[] {
  const diagrams: FlowDiagram[] = [];
  const fenceRe = /^```flow:(\S+)\s*\n([\s\S]*?)^```$/gm;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(markdown)) !== null) {
    const d = parseFlowBody(m[1], m[2]);
    if (d) diagrams.push(d);
  }
  return diagrams;
}

function parseFlowBody(id: string, body: string): FlowDiagram | null {
  const diagram: FlowDiagram = { id, title: id, nodes: [], edges: [] };
  const lines = body.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const titleM = /^title:\s*(.+)$/.exec(trimmed);
    if (titleM) { diagram.title = titleM[1].trim(); continue; }

    const nodeM = /^node\s+(\S+)\s+label="([^"]*)"/.exec(trimmed);
    if (nodeM) {
      const opts = parseOpts(trimmed);
      diagram.nodes.push({
        id: nodeM[1],
        label: nodeM[2],
        type: (opts.type as FlowNode["type"]) ?? "process",
        codeRef: opts.codeRef as FlowNode["codeRef"] | undefined,
      });
      continue;
    }

    const edgeM = /^edge\s+(\S+)\s*->\s*(\S+)/.exec(trimmed);
    if (edgeM) {
      const opts = parseOpts(trimmed);
      diagram.edges.push({
        from: edgeM[1],
        to: edgeM[2],
        label: opts.label as string | undefined,
      });
      continue;
    }
  }
  return diagram.nodes.length > 0 ? diagram : null;
}

function parseOpts(line: string): Record<string, unknown> {
  const braces = extractBraces(line);
  if (!braces) return {};
  try {
    return JSON.parse(jsObjToJson(braces));
  } catch {
    return {};
  }
}

function jsObjToJson(raw: string): string {
  // Quote keys
  let s = raw.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
  // Single-quoted values
  s = s.replace(/:\s*'([^']*)'/g, ': "$1"');
  // Double-quoted values
  s = s.replace(/:\s*"([^"]*)"/g, ': "$1"');
  // Numbers
  s = s.replace(/:\s*(\d+\.?\d*)\s*([,}])/g, ': $1$2');
  // Bare words (identifiers)
  s = s.replace(/:\s*([a-zA-Z_]\w*)\s*([,}])/g, ': "$1"$2');
  // Path-like values (contain / or .): quote them
  s = s.replace(/:\s*([\w./-]+)\s*([,}])/g, (_m: string, p1: string, p2: string) => {
    // Don't re-quote already-quoted values or numbers
    if (p1.startsWith('"') || /^\d+\.?\d*$/.test(p1)) return `: ${p1}${p2}`;
    return `: "${p1}"${p2}`;
  });
  // Recursively handle nested { }
  s = s.replace(/: \{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (_full: string, inner: string) => {
    return `: {${jsObjToJson(inner)}}`;
  });
  return s;
}

function extractBraces(line: string): string | null {
  const start = line.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < line.length; i++) {
    if (line[i] === "{") depth++;
    if (line[i] === "}") depth--;
    if (depth === 0) return line.slice(start, i + 1);
  }
  return null;
}

export function renderFlowSvg(diagram: FlowDiagram): string {
  const { nodes, edges } = diagram;
  if (nodes.length === 0) return "";

  const positions = layoutFlow(nodes);
  const w = 640;
  const h = Math.max(60, positions.size * 56);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" style="max-width:640px;font:12px sans-serif;">`;
  const arrow = `<marker id="ar-${diagram.id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="#9ca3af"/></marker>`;
  svg += `<defs>${arrow}</defs>`;

  for (const e of edges) {
    const from = positions.get(e.from);
    const to = positions.get(e.to);
    if (!from || !to) continue;
    const x1 = from.x + 60, y1 = from.y + 24;
    const x2 = to.x, y2 = to.y + 24;
    svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#6b7280" stroke-width="1.5" marker-end="url(#ar-${diagram.id})"/>`;
    if (e.label) {
      svg += `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" text-anchor="middle" fill="#9ca3af" font-size="10">${esc(e.label)}</text>`;
    }
  }

  const colors: Record<string, string> = { process: "#3b82f6", decision: "#eab308", endpoint: "#22c55e" };
  for (const n of nodes) {
    const pos = positions.get(n.id);
    if (!pos) continue;
    const fill = colors[n.type] ?? "#6b7280";
    let shape: string;
    if (n.type === "decision") {
      shape = `<polygon points="${pos.x + 30},${pos.y} ${pos.x + 60},${pos.y + 24} ${pos.x + 30},${pos.y + 48} ${pos.x},${pos.y + 24}" fill="${fill}" stroke="#d1d5db" stroke-width="1"/>`;
    } else if (n.type === "endpoint") {
      shape = `<ellipse cx="${pos.x + 30}" cy="${pos.y + 24}" rx="40" ry="20" fill="${fill}" stroke="#d1d5db" stroke-width="1"/>`;
    } else {
      shape = `<rect x="${pos.x}" y="${pos.y}" width="60" height="48" rx="6" fill="${fill}" stroke="#d1d5db" stroke-width="1"/>`;
    }
    const labelEl = `<text x="${pos.x + 30}" y="${pos.y + 24}" fill="white" text-anchor="middle" dominant-baseline="central" font-size="11">${esc(n.label)}</text>`;
    if (n.codeRef) {
      svg += `<a href="#" class="flow-node-link" data-file="${escAttr(n.codeRef.file)}" data-line="${n.codeRef.lineStart}">${shape}${labelEl}</a>`;
    } else {
      svg += shape + labelEl;
    }
  }

  svg += `</svg>`;
  return svg;
}

function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function escAttr(s: string): string { return s.replace(/"/g, "&quot;"); }

interface Point { x: number; y: number }

function layoutFlow(nodes: FlowNode[]): Map<string, Point> {
  const map = new Map<string, Point>();
  let x = 40, y = 8, col = 0;
  for (const n of nodes) {
    map.set(n.id, { x, y });
    y += 56; col++;
    if (col >= 4) { col = 0; y = 8; x += 160; }
  }
  return map;
}

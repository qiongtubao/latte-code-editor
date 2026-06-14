export interface DocSimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  group: number;
  label: string;
  docType: string;
  path: string;
}

export interface DocSimEdge {
  source: string;
  target: string;
  kind: string;
}

interface DocFile {
  name: string;
  path: string;
  outLinks?: string[];
  docType?: string;
  title?: string;
}

const TYPE_GROUP: Record<string, number> = {
  entity: 0, concept: 1, feature: 2, spec: 3, task: 4,
  bug: 5, component: 6, query: 7, synthesis: 8, reference: 9,
  meeting: 10, template: 11, other: 12,
};

export async function buildDocSim(
  docs: { name: string; path: string; is_dir: boolean }[],
  readFileContent: (path: string) => Promise<string>,
): Promise<{ nodes: DocSimNode[]; edges: DocSimEdge[] }> {
  const mdFiles = docs.filter((d) => !d.is_dir && d.name.endsWith(".md"));
  if (mdFiles.length === 0) return { nodes: [], edges: [] };

  const parsed = new Map<string, DocFile>();
  const ids = new Set<string>();

  for (const f of mdFiles) {
    const id = f.path.replace(/\.md$/, "").replace(/\\/g, "/");
    ids.add(id);
    try {
      const content = await readFileContent(f.path).catch(() => "");
      const fm = parseFm(content);
      const links = content.match(/\[\[([^\]\n|]+?)(?:\|[^\n\]]+?)?\]\]/g)?.map((m) => m.replace(/^\[\[|\]\]$/g, "").replace(/\|.*$/, "").trim()) ?? [];
      parsed.set(id, { name: f.name, path: f.path, outLinks: links, docType: fm.type ?? "other", title: fm.title ?? f.name });
    } catch {
      parsed.set(id, { name: f.name, path: f.path, outLinks: [], docType: "other", title: f.name });
    }
  }

  const nodes: DocSimNode[] = [];
  for (const [id, doc] of parsed) {
    nodes.push({ id, x: 300 + Math.random() * 200, y: 200 + Math.random() * 200, vx: 0, vy: 0, group: TYPE_GROUP[doc.docType ?? "other"] ?? 12, label: doc.title ?? id, docType: doc.docType ?? "other", path: doc.path });
  }

  const edges: DocSimEdge[] = [];
  const seen = new Set<string>();
  for (const [fromId, doc] of parsed) {
    if (!doc.outLinks) continue;
    for (const target of doc.outLinks) {
      for (const c of [target, `${target}.md`, target.replace(/\.md$/, "")]) {
        if (ids.has(c)) {
          const key = `${fromId}→${c}`;
          if (!seen.has(key)) { seen.add(key); edges.push({ source: fromId, target: c, kind: "wikilink" }); }
          break;
        }
      }
    }
  }

  return { nodes, edges };
}

function parseFm(content: string): { type?: string; title?: string } {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = content.slice(3, end);
  const result: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^(type|title)\s*:\s*(.+)$/.exec(line.trim());
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

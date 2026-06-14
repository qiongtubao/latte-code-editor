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
  /** Strength 0..1. Drives line thickness + alpha. Higher = stronger association. */
  weight: number;
}

const KIND_WEIGHT: Record<string, number> = {
  "source-shared": 1.0,  // strongest: actual code dependency
  wikilink: 0.75,        // explicit [[link]]
  "same-group": 0.4,     // weakest: same dir only
};
interface DocFile {
  name: string;
  path: string;
  outLinks?: string[];
  docType?: string;
  title?: string;
  sources?: string[];
}

const TYPE_GROUP: Record<string, number> = {
  entity: 0, concept: 1, feature: 2, spec: 3, task: 4,
  bug: 5, component: 6, query: 7, synthesis: 8, reference: 9,
  meeting: 10, template: 11, other: 12,
};

function topGroup(id: string): string {
  const parts = id.split("/");
  return parts.length > 1 ? parts[0] : "(root)";
}

function basename(id: string): string {
  return id.split("/").filter(Boolean).pop() ?? id;
}

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
      const links = content.match(/\[\[([^\]\n|]+?)(?:\|[^\n\]]+?)?\]\]/g)
        ?.map((m) => m.replace(/^\[\[|\]\]$/g, "").replace(/\|.*$/, "").trim()) ?? [];
      const sources = fm.sources ?? [];
      parsed.set(id, { name: f.name, path: f.path, outLinks: links, docType: fm.type ?? "other", title: fm.title ?? f.name, sources });
    } catch {
      parsed.set(id, { name: f.name, path: f.path, outLinks: [], docType: "other", title: f.name, sources: [] });
    }
  }

  const nodes: DocSimNode[] = [];
  for (const [id, doc] of parsed) {
    nodes.push({
      id,
      x: 300 + Math.random() * 200,
      y: 200 + Math.random() * 200,
      vx: 0, vy: 0,
      group: TYPE_GROUP[doc.docType ?? "other"] ?? 12,
      label: doc.title ?? id,
      docType: doc.docType ?? "other",
      path: doc.path,
    });
  }

  const edges: DocSimEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (from: string, to: string, kind: string) => {
    if (from === to) return;
    const key = `${from}→${to}#${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source: from, target: to, kind, weight: KIND_WEIGHT[kind] ?? 0.5 });
  };


  // Index by basename for relative wikilink resolution
  const byBasename = new Map<string, string[]>();
  for (const id of ids) {
    const b = basename(id);
    const arr = byBasename.get(b) ?? [];
    arr.push(id);
    byBasename.set(b, arr);
  }

  // 1. Wikilink edges: explicit [[links]] in doc body
  for (const [fromId, doc] of parsed) {
    if (!doc.outLinks) continue;
    for (const target of doc.outLinks) {
      let resolved: string | null = null;
      for (const c of [target, `${target}.md`, target.replace(/\.md$/, "")]) {
        if (ids.has(c)) { resolved = c; break; }
      }
      if (!resolved) {
        const list = byBasename.get(target);
        if (list && list.length === 1) { resolved = list[0]; }
      }
      if (resolved) addEdge(fromId, resolved, "wikilink");
    }
  }

  // 2. Same-group chain: docs in the same top-level dir get sequential edges
  const byGroup = new Map<string, string[]>();
  for (const id of ids) {
    const g = topGroup(id);
    const list = byGroup.get(g) ?? [];
    list.push(id);
    byGroup.set(g, list);
  }
  for (const [, list] of byGroup) {
    list.sort();
    for (let i = 0; i < list.length - 1; i++) {
      addEdge(list[i], list[i + 1], "same-group");
    }
  }

  // 3. Source-overlap: two docs sharing a source basename get an edge
  const bySource = new Map<string, string[]>();
  for (const [id, doc] of parsed) {
    if (!doc.sources) continue;
    for (const src of doc.sources) {
      const base = basename(src.replace(/\.md$/, "").replace(/\\/g, "/"));
      const list = bySource.get(base) ?? [];
      list.push(id);
      bySource.set(base, list);
    }
  }
  for (const [, list] of bySource) {
    if (list.length < 2) continue;
    const unique = Array.from(new Set(list)).sort();
    for (let i = 0; i < unique.length - 1; i++) {
      addEdge(unique[i], unique[i + 1], "source-shared");
    }
  }

  return { nodes, edges };
}

function parseFm(content: string): { type?: string; title?: string; sources?: string[] } {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = content.slice(3, end);
  const result: { type?: string; title?: string; sources?: string[] } = {};
  let inList = false;
  for (const line of block.split("\n")) {
    const t = line.trim();
    if (t.startsWith("type:")) result.type = t.slice(5).trim();
    else if (t.startsWith("title:")) result.title = t.slice(6).trim();
    else if (t === "sources:") inList = true;
    else if (inList && t.startsWith("- ")) {
      (result.sources ??= []).push(t.slice(2).trim());
    } else {
      inList = false;
    }
  }
  return result;
}

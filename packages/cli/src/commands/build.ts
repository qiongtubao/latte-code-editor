import { writeEvent } from "../ndjson.js";
export async function build(workspace: string) {
  writeEvent({ type: "start", job: "build" });
  const t0 = Date.now();
  // Stub: real impl delegates to @latte-graph/cli when --json is supported.
  // For now emit one progress per fake file.
  const files = await fakeWalk(workspace);
  for (let i = 0; i < files.length; i++) {
    writeEvent({ type: "progress", file: files[i], pct: Math.round(((i+1)/files.length)*100) });
  }
  writeEvent({ type: "done", stats: { files: files.length, nodes: 0, edges: 0, ms: Date.now() - t0 } });
}
async function fakeWalk(_ws: string): Promise<string[]> { return ["a.ts","b.ts"]; }

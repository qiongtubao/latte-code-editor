export type BuildEvent =
  | { type: "start"; job: string }
  | { type: "progress"; file: string; pct: number }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string }
  | { type: "done"; stats: { files: number; nodes: number; edges: number; ms: number } }
  | { type: "error"; message: string };

export function writeEvent(e: BuildEvent) {
  process.stdout.write(JSON.stringify(e) + "\n");
}

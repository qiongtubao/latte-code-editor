import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";

describe("latte build", () => {
  it("emits NDJSON start, progress*, done", async () => {
    const cli = join(__dirname, "../src/index.ts");
    const out: string[] = [];
    await new Promise<void>((res, rej) => {
      const p = spawn("node", ["--import", "tsx", cli, "build", "."], { stdio: ["ignore", "pipe", "pipe"] });
      p.stdout.on("data", d => out.push(d.toString()));
      p.on("exit", code => code === 0 ? res() : rej(new Error("exit "+code)));
    });
    const events = out.join("").trim().split("\n").map(JSON.parse);
    expect(events[0].type).toBe("start");
    expect(events.at(-1).type).toBe("done");
    expect(events.filter((e:any) => e.type === "progress").length).toBeGreaterThan(0);
  }, 15000);
});

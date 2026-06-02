// Two hardcoded TS samples used by the EmptyState welcome panel. These are
// inlined (not read from disk) per the P0 spec: the goal is to give a
// first-run user something to click without requiring them to open a
// folder or install a sample bundle. Keep them in sync with the real
// files in `samples/minimal-ts/` only if you intend to demonstrate
// the build/graph features against them.

export interface Sample {
  /** Display name (the chip label). */
  name: string;
  /** Synthetic path shown in the status bar (no on-disk existence implied). */
  path: string;
  /** The full file content loaded into Monaco. */
  content: string;
  /** Monaco language id. */
  language: "typescript";
}

export const SAMPLES: Sample[] = [
  {
    name: "index.ts",
    path: "samples/minimal-ts/index.ts",
    content: `import { login } from "./auth";
login("alice", "secret");
`,
    language: "typescript",
  },
  {
    name: "auth.ts",
    path: "samples/minimal-ts/auth.ts",
    content: `export function login(user: string, pass: string): boolean {
  return verify(user, pass);
}
function verify(user: string, pass: string): boolean {
  return user.length > 0 && pass.length >= 4;
}
`,
    language: "typescript",
  },
];

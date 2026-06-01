// Computes sha256 of a single schema.sql file OR all *.sql files in a directory (sorted),
// then writes the result to crates/latte-graph-adapter/SCHEMA_HASH.txt
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

const input = process.argv[2];
const out = process.argv[3] || "./crates/latte-graph-adapter/SCHEMA_HASH.txt";

const st = statSync(input);
let h = createHash("sha256");
if (st.isDirectory()) {
  const files = readdirSync(input).filter(f => f.endsWith(".sql")).sort();
  for (const f of files) {
    h.update(readFileSync(join(input, f), "utf8"));
    h.update(f);
  }
  console.log(`hashed ${files.length} .sql files from ${input}`);
} else if (st.isFile()) {
  h.update(readFileSync(input, "utf8"));
  h.update(basename(input));
  console.log(`hashed single file ${input}`);
} else {
  throw new Error(`not a file or directory: ${input}`);
}

writeFileSync(out, h.digest("hex") + "\n");
console.log("wrote", out);

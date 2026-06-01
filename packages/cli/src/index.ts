#!/usr/bin/env node
import { build } from "./commands/build.js";
const [, , cmd, ...rest] = process.argv;
if (cmd === "build") {
  await build(rest[0] ?? ".");
} else {
  console.error("usage: latte <build> [workspace]");
  process.exit(2);
}

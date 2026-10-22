// Runs one shard of a package.json node:test script, for parallel CI jobs:
//   node scripts/ci-node-tests.mjs test:identity 1/3
// The script's own file list stays the single source of truth.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [name, shard] = process.argv.slice(2);
const script = JSON.parse(readFileSync("package.json", "utf8")).scripts[name];
if (!script || !/^\d+\/\d+$/.test(shard ?? "")) {
  console.error(
    "Usage: node scripts/ci-node-tests.mjs <script> <index>/<total>",
  );
  process.exit(64);
}
const files = script.split(/\s+/).filter((part) => part.endsWith(".node.ts"));
if (!files.length) {
  console.error(`${name} names no .node.ts files.`);
  process.exit(64);
}
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    `--test-shard=${shard}`,
    // A hung test fails with its name instead of the job's time limit.
    "--test-timeout=480000",
    ...files,
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);

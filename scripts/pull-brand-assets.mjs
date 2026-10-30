import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--refresh")) {
  throw new Error("Usage: node scripts/pull-brand-assets.mjs [--refresh]");
}
// A normal pull is an intentional dependency update. Builds restore the reviewed
// snapshots; the CLI reads the local login or VARDUM_API_KEY from the environment.
const mode = args.includes("--refresh") ? [] : ["--frozen"];
for (const directory of ["../", "../assets/brand/"]) {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "exec",
      "--yes",
      "--package=@vardum/cli@0.8.3",
      "--",
      "vardum",
      "pull",
      ...mode,
      "--json",
    ],
    {
      cwd: fileURLToPath(new URL(directory, import.meta.url)),
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

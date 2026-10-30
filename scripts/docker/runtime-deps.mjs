// Build-stage helper for the Dockerfile: copies only the installed packages the
// server needs at runtime into <out>/node_modules.
//
//   node scripts/docker/runtime-deps.mjs <out>
//
// The roots are the bare imports of apps/reference-server/cli.ts (traced with
// esbuild, as installed from the frozen lockfile) plus tsx, which runs the
// TypeScript sources. Their dependency closure (dependencies, installed
// optional and peer dependencies) is copied from node_modules as installed, so
// the versions are exactly the lockfile's. The mobile app, Expo, React Native
// and build tools stay out of the runtime image.
import { build } from "esbuild";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: runtime-deps.mjs <out>");
const root = process.cwd();
const RUNTIME_EXTRA = ["tsx"];

const traced = await build({
  entryPoints: ["apps/reference-server/cli.ts", "scripts/storage-check.ts", "scripts/storage-bootstrap.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  metafile: true,
  write: false,
  logLevel: "error",
  outdir: "runtime-trace",
});
const name = (specifier) =>
  specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
const roots = new Set(RUNTIME_EXTRA);
for (const output of Object.values(traced.metafile.outputs))
  for (const item of output.imports)
    if (item.external && !item.path.startsWith("node:"))
      roots.add(name(item.path));

/** Node's lookup: the nearest node_modules/<name> from a directory upwards. */
function locate(pkg, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", pkg);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === root || dir === dirname(dir)) return null;
  }
}

const packages = new Set();
const queue = [...roots].map((pkg) => ({ pkg, from: root, required: true }));
while (queue.length) {
  const { pkg, from, required } = queue.shift();
  const dir = locate(pkg, from);
  if (!dir) {
    if (required) throw new Error(`Runtime dependency not installed: ${pkg}`);
    continue;
  }
  if (packages.has(dir)) continue;
  packages.add(dir);
  const real = realpathSync(dir);
  const manifest = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
  for (const dep of Object.keys(manifest.dependencies ?? {}))
    queue.push({ pkg: dep, from: real, required: true });
  // Platform binaries arrive as optional dependencies; optional peers (React,
  // TypeScript, other frameworks' adapters) are left to whoever uses them.
  const optionalPeers = manifest.peerDependenciesMeta ?? {};
  for (const dep of [
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}).filter(
      (peer) => !optionalPeers[peer]?.optional,
    ),
  ])
    queue.push({ pkg: dep, from: real, required: false });
}

const copied = [];
for (const dir of [...packages].sort()) {
  const path = relative(root, dir);
  // A package nested inside one already copied came along with it.
  if (copied.some((parent) => path.startsWith(parent + sep))) continue;
  const target = join(out, path);
  mkdirSync(dirname(target), { recursive: true });
  if (lstatSync(dir).isSymbolicLink())
    // Workspace packages (apps/server-agent) are linked; their sources are copied separately.
    symlinkSync(readlinkSync(dir), target);
  else cpSync(dir, target, { recursive: true, verbatimSymlinks: true });
  copied.push(path);
}
console.log(
  `Runtime dependencies: ${roots.size} roots, ${packages.size} packages copied to ${out}`,
);

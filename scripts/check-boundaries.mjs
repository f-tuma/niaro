import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const rules = {
  protocol: [/from ['"]react/, /from ['"].*(ui|design-tokens)/],
  "client-core": [/from ['"]react/, /from ['"].*(ui-catalog|\/ui)/],
  ui: [/from ['"].*(client-core|protocol)/, /\bfetch\(/],
  "ui-catalog": [/from ['"].*client-core/, /\bfetch\(/],
};
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(path, e.name))
      : /\.tsx?$/.test(e.name)
        ? [join(path, e.name)]
        : [],
  );
}
const errors = [];
const serverPackageImport =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](?:@niaro\/server-agent(?:\/[^'"]*)?|@mastra\/[^'"]+)['"]/;
for (const [layer, patterns] of Object.entries(rules))
  for (const file of files(`packages/${layer}`)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of patterns)
      if (pattern.test(source)) errors.push(`${file}: boundary ${pattern}`);
    if (
      (layer === "ui" || layer === "ui-catalog") &&
      /#[0-9a-fA-F]{6}\b/.test(source)
    )
      errors.push(`${file}: raw color outside tokens`);
  }
for (const directory of [
  "apps/mobile",
  "apps/server-admin/web",
  "packages/client-core",
  "packages/ui-catalog",
  "packages/ui",
  "packages/protocol",
])
  for (const file of files(directory)) {
    const source = readFileSync(file, "utf8");
    if (
      /from ['"][^'"]*(?:fixture-server|reference-server|server-sdk|server-tools|server-plugins|server-hosting|server-agent)[^'"]*['"]/.test(
        source,
      ) ||
      serverPackageImport.test(source)
    )
      errors.push(`${file}: server implementation imported into client`);
  }
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log("Dependency and UI token boundaries passed.");

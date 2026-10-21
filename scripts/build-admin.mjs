import { build } from "vite";
import { readFile, writeFile } from "node:fs/promises";
await build({ configFile: "apps/server-admin/vite.config.ts" });
// Preserve the bundled font's OFL notice without introducing an external asset request.
const license = await readFile(
  "node_modules/@fontsource-variable/manrope/LICENSE",
  "utf8",
);
const css = await readFile("dist-admin/app.css", "utf8");
await writeFile("dist-admin/app.css", `/* ${license} */\n${css}`);

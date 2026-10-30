import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scanner = fileURLToPath(
  new URL("../scripts/check-boundaries.mjs", import.meta.url),
);
const clientLayers = [
  "apps/mobile",
  "apps/server-admin/web",
  "packages/client-core",
  "packages/ui-catalog",
  "packages/ui",
  "packages/protocol",
];
const serverPaths = [
  "fixture-server",
  "reference-server",
  "server-sdk",
  "server-tools",
  "server-plugins",
  "server-hosting",
  "server-agent",
  "server-storage",
  "server-attachments",
];
const forms: [string, (path: string) => string][] = [
  [
    "static-from",
    (p) => `import { ConversionClient } from ${JSON.stringify(p)};`,
  ],
  [
    "type-from",
    (p) => `import type { ConversionClient } from ${JSON.stringify(p)};`,
  ],
  ["side-effect", (p) => `import ${JSON.stringify(p)};`],
  ["dynamic", (p) => `export const lazy = () => import(${JSON.stringify(p)});`],
  ["require", (p) => `export const client = require(${JSON.stringify(p)});`],
  [
    "module-require",
    (p) => `export const client = module.require(${JSON.stringify(p)});`,
  ],
  [
    "module-bracket",
    (p) => `export const client = module["require"](${JSON.stringify(p)});`,
  ],
  [
    "parenthesized-require",
    (p) => `export const client = (require)(${JSON.stringify(p)});`,
  ],
  ["template-import", (p) => "export const lazy = () => import(`" + p + "`);"],
  ["template-require", (p) => "export const client = require(`" + p + "`);"],
  ["export-from", (p) => `export * from ${JSON.stringify(p)};`],
  [
    "export-type",
    (p) => `export type { ConversionClient } from ${JSON.stringify(p)};`,
  ],
  ["import-equals", (p) => `import client = require(${JSON.stringify(p)});`],
  [
    "import-type",
    (p) =>
      `export type Client = typeof import(${JSON.stringify(p)}).ConversionClient;`,
  ],
  [
    "commented-layout",
    (p) =>
      `export const lazy = () => import /* comment */ (\n${JSON.stringify(p)}\n);`,
  ],
  [
    "escaped-path",
    (p) =>
      `export const lazy = () => import(${JSON.stringify(p).replace("server-attachments", "server-\\u0061ttachments")});`,
  ],
  [
    "nested-import-argument",
    (p) => `export const lazy = () => import((${JSON.stringify(p)}));`,
  ],
  [
    "nested-require-argument",
    (p) => `export const client = require(((${JSON.stringify(p)})));`,
  ],
  [
    "nested-module-argument",
    (p) => `export const client = module.require((${JSON.stringify(p)}));`,
  ],
  [
    "nested-template-argument",
    (p) => "export const lazy = () => import((`" + p + "`));",
  ],
  [
    "asserted-import-literal",
    (p) => `export const lazy = () => import(${JSON.stringify(p)} as string);`,
  ],
  [
    "type-asserted-require-literal",
    (p) => `export const client = require(<string>${JSON.stringify(p)});`,
  ],
  [
    "non-null-import-literal",
    (p) => `export const lazy = () => import(${JSON.stringify(p)}!);`,
  ],
  [
    "satisfies-import-literal",
    (p) =>
      `export const lazy = () => import(${JSON.stringify(p)} satisfies string);`,
  ],
  [
    "asserted-require-callee",
    (p) =>
      `export const client = (require as NodeRequire)(${JSON.stringify(p)});`,
  ],
  [
    "type-asserted-require-callee",
    (p) =>
      `export const client = (<NodeRequire>require)(${JSON.stringify(p)});`,
  ],
  [
    "non-null-require-callee",
    (p) => `export const client = require!(${JSON.stringify(p)});`,
  ],
  [
    "satisfies-require-callee",
    (p) =>
      `export const client = (require satisfies NodeRequire)(${JSON.stringify(p)});`,
  ],
  [
    "parenthesized-module-receiver",
    (p) => `export const client = (module).require(${JSON.stringify(p)});`,
  ],
  [
    "asserted-module-receiver",
    (p) =>
      `export const client = (module as NodeJS.Module).require(${JSON.stringify(p)});`,
  ],
  [
    "type-asserted-module-receiver",
    (p) =>
      `export const client = (<NodeJS.Module>module).require(${JSON.stringify(p)});`,
  ],
  [
    "non-null-module-receiver",
    (p) => `export const client = module!.require(${JSON.stringify(p)});`,
  ],
  [
    "satisfies-module-receiver",
    (p) =>
      `export const client = (module satisfies NodeJS.Module).require(${JSON.stringify(p)});`,
  ],
  [
    "parenthesized-module-key",
    (p) => `export const client = module[("require")](${JSON.stringify(p)});`,
  ],
  [
    "asserted-module-key",
    (p) =>
      `export const client = module["require" as const](${JSON.stringify(p)});`,
  ],
  [
    "nested-mixed-wrappers",
    (p) =>
      `export const client = ((require as NodeRequire)!)(((${JSON.stringify(p)} as string) satisfies string));`,
  ],
];
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "niaro-conversion-imports-"));
  for (const directory of [
    ...clientLayers,
    "packages/openui-library",
    "packages/plugin-sdk",
    "plugins",
  ])
    mkdirSync(join(root, directory), { recursive: true });
  return root;
}
function probe(root: string, file: string, source: string) {
  writeFileSync(join(root, file), source + "\n");
}
function scan(root: string) {
  return spawnSync(process.execPath, [scanner], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}
const portableDiagnostic = (value: string) => value.replaceAll("\\", "/");

test("server-only guard rejects every direct literal form in every client/shared layer", () => {
  const root = tree(),
    expected: string[] = [];
  try {
    for (const layer of clientLayers)
      for (const [name, form] of forms) {
        const file = join(layer, `conversion-${name}.ts`);
        probe(
          root,
          file,
          form("../../apps/server-attachments/conversion-client"),
        );
        expected.push(file);
      }
    for (const server of serverPaths)
      for (const [name, form] of forms.slice(0, 5)) {
        const file = join(
          "packages/client-core",
          `legacy-${server}-${name}.ts`,
        );
        probe(root, file, form(`../../apps/${server}/module`));
        expected.push(file);
      }
    for (const server of ["@niaro/server-agent", "@mastra/core"])
      for (const [name, form] of forms.slice(0, 5)) {
        const file = join(
          "packages/client-core",
          `named-${server.replace(/\W/g, "_")}-${name}.ts`,
        );
        probe(root, file, form(server));
        expected.push(file);
      }
    const jsx = join("apps/mobile", "conversion-nested.tsx");
    probe(
      root,
      jsx,
      'export const view = <Button onPress={() => import("../../apps/server-attachments/conversion-client")} />;',
    );
    expected.push(jsx);
    const result = scan(root);
    assert.equal(result.status, 1, result.stderr || result.error?.message);
    const lines = result.stderr.trim().split(/\r?\n/).map(portableDiagnostic);
    for (const file of expected)
      assert.ok(
        lines.includes(
          portableDiagnostic(
            `${file}: server implementation imported into client`,
          ),
        ),
        `missed dependency: ${file}\n${result.stderr}`,
      );
    assert.equal(
      lines.length,
      expected.length,
      "unexpected/missing guard diagnostics",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard preserves allowed module forms and does not treat comments or path text as imports", () => {
  const root = tree();
  try {
    for (const layer of clientLayers)
      for (const [name, form] of forms)
        probe(root, join(layer, `allowed-${name}.ts`), form("./local-types"));
    probe(
      root,
      "packages/client-core/path-text.ts",
      `
      // import "../../apps/server-attachments/conversion-client";
      /* export * from "../../apps/server-storage/runtime"; */
      export const sample = "require('../../apps/server-attachments/conversion-client')";
      export const fromExample = "from '../../apps/server-storage/runtime'";
      export const path = "../../apps/server-attachments/conversion-client";
      export const value = other.require("../../apps/server-attachments/conversion-client");
      export const wrapped = (other as Loader).require(("../../apps/server-attachments/conversion-client" as string));
      export const literal = ("../../apps/server-attachments/conversion-client" satisfies string)!;
      import type { Message } from "../../packages/protocol/index";
    `,
    );
    probe(
      root,
      "apps/mobile/allowed-react.tsx",
      'import React from "react"; export const view = <Button />;',
    );
    probe(
      root,
      "plugins/allowed.ts",
      'import type { SkillContext } from "@niaro/plugin-sdk"; import { join } from "node:path";',
    );
    const result = scan(root);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /boundaries passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

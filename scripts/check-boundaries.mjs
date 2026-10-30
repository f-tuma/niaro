import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
const rules = {
  protocol: [
    /from ['"]react/,
    /from ['"][^'"]*\/(?:ui|ui-catalog|design-tokens)(?:\/|['"])/,
  ],
  "client-core": [/from ['"]react/, /from ['"].*(ui-catalog|\/ui)/],
  ui: [/from ['"].*(client-core|protocol)/, /\bfetch\(/],
  "ui-catalog": [/from ['"].*client-core/, /\bfetch\(/],
  // The shared generated-UI spec: no renderer, no network.
  "openui-library": [
    /from ['"]react/,
    /from ['"][^'"]*\/(?:ui|ui-catalog|design-tokens|client-core)(?:\/|['"])/,
    /\bfetch\(/,
  ],
  // Types and helpers only: a plugin never reaches server internals through it.
  "plugin-sdk": [/from ['"](?:\.\.\/)+(?:apps|plugins)\//, /from ['"]react/],
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
const serverImplementationPath =
  /(?:fixture-server|reference-server|server-sdk|server-tools|server-plugins|server-hosting|server-agent|server-storage|server-attachments)/;
// Inspect direct literal dependencies with the existing TypeScript compiler.
// Syntax traversal handles comments, escaped specifiers, TSX and type imports;
// ordinary path strings are not dependencies. This is not alias/eval resolution.
function serverPathImport(file, source) {
  // These nodes are transparent at runtime; do not evaluate other expressions.
  function directExpression(node) {
    while (
      node &&
      (ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isSatisfiesExpression(node))
    )
      node = node.expression;
    return node;
  }
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      specifier = node.moduleReference.expression;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      specifier = node.argument.literal;
    else if (ts.isCallExpression(node)) {
      const callee = directExpression(node.expression);
      const requireCall = ts.isIdentifier(callee) && callee.text === "require";
      const moduleAccess =
        ts.isPropertyAccessExpression(callee) ||
        ts.isElementAccessExpression(callee);
      const receiver = moduleAccess && directExpression(callee.expression);
      const key =
        ts.isElementAccessExpression(callee) &&
        directExpression(callee.argumentExpression);
      const moduleRequire =
        receiver &&
        ts.isIdentifier(receiver) &&
        receiver.text === "module" &&
        ((ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "require") ||
          (key && ts.isStringLiteralLike(key) && key.text === "require"));
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        requireCall ||
        moduleRequire
      )
        specifier = node.arguments[0];
    }
    specifier = directExpression(specifier);
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      serverImplementationPath.test(specifier.text)
    )
      return true;
    return ts.forEachChild(node, visit);
  }
  return !!visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest));
}
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
    if (serverPathImport(file, source) || serverPackageImport.test(source))
      errors.push(`${file}: server implementation imported into client`);
  }
// A plugin runs from any directory (also <identity>/plugins), where packages
// and repository paths do not resolve: it imports the SDK as a type only, and
// at runtime nothing but Node built-ins.
for (const file of files("plugins")) {
  const source = readFileSync(file, "utf8");
  for (const [, statement, specifier] of source.matchAll(
    /^\s*(import(?!\s+type\b)[^'"]*?|export[^'"]*?from\s*)['"]([^'"]+)['"]/gm,
  ))
    if (!specifier.startsWith("node:"))
      errors.push(
        `${file}: plugins import only types and node: built-ins (${statement.trim()} "${specifier}")`,
      );
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log("Dependency and UI token boundaries passed.");

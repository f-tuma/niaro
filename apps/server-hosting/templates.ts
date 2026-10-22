import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  HostedDefinition,
  type HostedBuiltinId,
} from "../../packages/protocol/hosted";

/** A definition shipped with the server. An npm one's directory also holds package.json
 * and a committed package-lock.json, installed with npm ci --ignore-scripts. */
export type HostedBuiltin = {
  id: HostedBuiltinId;
  definition: HostedDefinition;
  /** Directory with definition.json (and for npm, the lockfile). */
  source: string;
};
// Like dist-admin, resolved from the repository root the server starts in.
export const HOSTED_TEMPLATES_DIRECTORY = resolve(
  process.cwd(),
  "apps/server-hosting/templates",
);
let loaded: Map<HostedBuiltinId, HostedBuiltin> | undefined;
/** Every templates/<id>/definition.json, validated like a custom definition. */
export function hostedBuiltins(
  directory = HOSTED_TEMPLATES_DIRECTORY,
): Map<HostedBuiltinId, HostedBuiltin> {
  if (directory === HOSTED_TEMPLATES_DIRECTORY && loaded) return loaded;
  const builtins = new Map<HostedBuiltinId, HostedBuiltin>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(directory, entry.name);
    const definition = HostedDefinition.parse(
      JSON.parse(readFileSync(join(source, "definition.json"), "utf8")),
    );
    builtins.set(entry.name, { id: entry.name, definition, source });
  }
  if (directory === HOSTED_TEMPLATES_DIRECTORY) loaded = builtins;
  return builtins;
}

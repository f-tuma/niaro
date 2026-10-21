import { resolve } from "node:path";
import type { HostedTemplateId } from "../../packages/protocol/hosted";

export type HostedTemplate = {
  id: HostedTemplateId;
  name: string;
  /** Exact version; the committed lockfile pins every dependency by integrity. */
  package: string;
  version: string;
  /** Directory with package.json and package-lock.json, installed with npm ci --ignore-scripts. */
  source: string;
  entry: string;
  /** {port} is the listening port inside the sandbox. */
  args: string[];
  /** Fixed, non-secret settings of the hosted program. */
  env?: { name: string; value: string }[];
  memoryMb: number;
};
// Like dist-admin, resolved from the repository root the server starts in.
const templates = resolve(process.cwd(), "apps/server-hosting/templates");
export const HOSTED_TEMPLATES: Record<HostedTemplateId, HostedTemplate> = {
  "microsoft-365": {
    id: "microsoft-365",
    name: "Microsoft 365",
    package: "@softeria/ms-365-mcp-server",
    version: "0.156.2",
    source: resolve(templates, "microsoft-365"),
    entry: "node_modules/@softeria/ms-365-mcp-server/dist/index.js",
    // Each request carries the person's own Microsoft token; tool listing needs none,
    // so actions can be discovered before anyone has connected.
    args: [
      "--http",
      "0.0.0.0:{port}",
      "--preset",
      "calendar,mail",
      "--allow-unauthenticated-discovery",
    ],
    // Mail bodies as HTML: the app renders them itself (links, lists, tables).
    env: [{ name: "MS365_MCP_BODY_FORMAT", value: "html" }],
    memoryMb: 512,
  },
};

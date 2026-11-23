import { McpAdminState } from "../../../../packages/protocol/mcp-admin";
import { api } from "./api";

/** One cache for External AI apps and the Overview's waiting requests. */
export const mcpAdminKey = (principalId: string | null, workspaceId: string) =>
  ["admin", "mcp", "admin", principalId, workspaceId] as const;

/** Members' external AI apps of a workspace; owners and administrators only. */
export async function loadMcpAdmin(
  target: { organizationId: string; workspaceId: string },
  signal?: AbortSignal,
) {
  return McpAdminState.parse(
    await api("identity/mcp/admin/list", target, signal),
  );
}

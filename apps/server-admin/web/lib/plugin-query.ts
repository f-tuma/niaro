import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { WorkspacePlugins } from "../../../../packages/protocol/workspace-plugins";

/** A poll started before this save must never restore the previous revision. */
export async function publishPluginSettings(
  client: QueryClient,
  key: QueryKey,
  value: WorkspacePlugins,
) {
  await client.cancelQueries({ queryKey: key, exact: true });
  client.setQueryData<WorkspacePlugins>(key, (current) =>
    current && current.revision > value.revision ? current : value,
  );
}

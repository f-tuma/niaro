import { QueryClient } from "@tanstack/react-query";
import { publishPluginSettings } from "../apps/server-admin/web/lib/plugin-query";
import type { WorkspacePlugins } from "../packages/protocol/workspace-plugins";
const base: WorkspacePlugins = {
  profile: "agent-workspace-plugins/1",
  organizationId: "TEST-org",
  workspaceId: "TEST-workspace",
  canManage: true,
  revision: 0,
  source: "server",
  defaults: { enabled: ["datetime"], timeZone: "Europe/Prague" },
  settings: { enabled: ["datetime"], timeZone: "Europe/Prague" },
  plugins: [
    {
      id: "datetime",
      version: 1,
      effect: "pure",
      available: true,
      tools: ["internal_datetime_resolve"],
    },
  ],
};
test("a polling response started before save cannot overwrite the saved plugin revision", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const key = [
    "admin",
    "plugins",
    "TEST-user",
    "TEST-org",
    "TEST-workspace",
    true,
  ];
  let release!: (value: WorkspacePlugins) => void;
  let aborted = false;
  try {
    client.setQueryData(key, base);
    const pending = client
      .fetchQuery({
        queryKey: key,
        queryFn: ({ signal }) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return new Promise<WorkspacePlugins>((resolve) => {
            release = resolve;
          });
        },
      })
      .catch(() => undefined);
    const updated = {
      ...base,
      revision: 1,
      source: "workspace" as const,
      settings: { enabled: [] as "datetime"[], timeZone: "UTC" },
    };
    await publishPluginSettings(client, key, updated);
    release(base);
    await pending;
    expect(aborted).toBe(true);
    expect(client.getQueryData(key)).toEqual(updated);
  } finally {
    client.clear();
  }
});
test("a newer revision and another workspace cache stay intact", async () => {
  const client = new QueryClient();
  const key = ["admin", "plugins", "TEST-one"],
    other = ["admin", "plugins", "TEST-two"];
  try {
    client.setQueryData(key, { ...base, revision: 3 });
    client.setQueryData(other, base);
    await publishPluginSettings(client, key, { ...base, revision: 2 });
    expect(client.getQueryData<WorkspacePlugins>(key)?.revision).toBe(3);
    expect(client.getQueryData(other)).toEqual(base);
  } finally {
    client.clear();
  }
});

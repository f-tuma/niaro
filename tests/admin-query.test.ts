import { QueryClient } from "@tanstack/react-query";
import {
  ApiError,
  api,
  loadOverview,
  overviewKey,
} from "../apps/server-admin/web/lib/api";

const inventory = {
  profile: "agent-server-admin/2",
  server: {
    name: "TEST console",
    workflowProfile: "agent-client/0.4-fixture",
    startedAt: "2026-09-25T00:00:00Z",
    sessionSeconds: 1800,
  },
  observedAt: "2026-09-25T00:00:00Z",
  services: [
    { id: "model", provider: "fixture", state: "demo" },
    { id: "voice", provider: "disabled", state: "disabled" },
    { id: "crm", provider: "disabled", state: "disabled" },
    { id: "calendar", provider: "simulated", state: "demo" },
  ],
  tools: [],
  authentication: {
    current: "admin-key",
    identityEnabled: false,
    principalId: null,
    oauth: "not_configured",
    backupKey: true,
    console: true,
    expiresAt: "2026-09-25T01:00:00Z",
  },
};
const response = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;
afterEach(() => jest.restoreAllMocks());

test("revoked administrator session clears previously cached inventory", async () => {
  jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response(200, inventory))
    .mockResolvedValueOnce(response(401, {}));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const query = {
    queryKey: overviewKey,
    queryFn: ({ signal }: { signal: AbortSignal }) => loadOverview(signal),
    staleTime: 0,
  };
  try {
    await client.fetchQuery(query);
    expect(client.getQueryData(overviewKey)).toEqual(inventory);
    await client.fetchQuery(query);
    expect(client.getQueryData(overviewKey)).toBeNull();
  } finally {
    client.clear();
  }
});

test("temporary failure preserves last inventory; unsupported data cannot replace it", async () => {
  jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response(200, inventory))
    .mockResolvedValueOnce(response(503, {}))
    .mockResolvedValueOnce(
      response(200, { ...inventory, providerKey: "unexpected" }),
    );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const query = {
    queryKey: overviewKey,
    queryFn: ({ signal }: { signal: AbortSignal }) => loadOverview(signal),
    staleTime: 0,
  };
  try {
    await client.fetchQuery(query);
    await expect(client.fetchQuery(query)).rejects.toEqual(new ApiError(503));
    expect(client.getQueryData(overviewKey)).toEqual(inventory);
    await expect(client.fetchQuery(query)).rejects.toEqual(new ApiError(422));
    expect(client.getQueryData(overviewKey)).toEqual(inventory);
  } finally {
    client.clear();
  }
});

test("requests combine caller cancellation with a bounded timeout", async () => {
  const deadline = new AbortController();
  const timeout = jest
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  const fetch = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(response(200, {}));
  const caller = new AbortController();
  await api("overview", undefined, caller.signal);
  const first = fetch.mock.calls[0]![1]!.signal!;
  caller.abort();
  expect(first.aborted).toBe(true);
  await api("overview");
  const second = fetch.mock.calls[1]![1]!.signal!;
  deadline.abort();
  expect(second.aborted).toBe(true);
  expect(timeout).toHaveBeenCalledWith(10_000);
});

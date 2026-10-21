import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createReferenceServer } from "../apps/reference-server/runtime";
import {
  loadServerConfig,
  ServerConfigSchema,
} from "../apps/reference-server/config";
import { issuePairingCode, FixtureAuth } from "../apps/fixture-server/auth";
import { ClientSession } from "../packages/client-core/session";
import { messageCommand } from "../packages/client-core/commands";
import { AUTH_PROFILE, PROFILE, CredentialSchema } from "../packages/protocol";
import { ServerInfoSchema } from "../packages/protocol/server-info";

const http = (url: string, init: RequestInit = {}) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? "GET",
        agent: false,
        headers: init.headers as Record<string, string>,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode!, text }));
      },
    );
    req.on("error", reject);
    req.end(init.body ?? undefined);
  });
const transport: typeof fetch = async (url, init) => {
  const response = await http(String(url), init);
  return {
    status: response.status,
    ok: response.status < 400,
    text: async () => response.text,
  } as Response;
};

test("two configured servers use the unchanged client contract, isolate tokens/state and restore the same server identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "reference-servers-"));
  const configs = ["personal", "team"].map((name) => {
    const file = join(root, `${name}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        name,
        listen: { port: 8794 },
        dataDirectory: `./${name}`,
        allowedOrigins: ["http://localhost:8085"],
        adapters: {
          model: { provider: "fixture" },
          voice: { provider: "disabled" },
          crm: { provider: "disabled" },
          calendar: { provider: "simulated" },
        },
      }),
    );
    return loadServerConfig(file);
  });
  const servers = configs.map((c) => createReferenceServer(c));
  const sessions: ClientSession[] = [];
  const cache = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => cache.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      cache.set(key, value);
    },
  };
  const close = async (i: number) =>
    new Promise<void>((resolve) => servers[i]!.close(() => resolve()));
  try {
    await Promise.all(
      servers.map(
        (server) => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
      ),
    );
    const urls = servers.map(
      (server) =>
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/a`,
    );
    const credentials = [];
    for (const [i, url] of urls.entries()) {
      expect((await http(`${url}/server`)).status).toBe(401);
      const pair = await http(`${url}/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authProfile: AUTH_PROFILE,
          profile: PROFILE,
          code: issuePairingCode(configs[i]!.dataDirectory, "alice", "a"),
        }),
      });
      const credential = CredentialSchema.parse(JSON.parse(pair.text));
      credentials.push(credential);
      const headers = { Authorization: `Bearer ${credential.accessToken}` };
      const infoResponse = await http(`${url}/server`, { headers });
      const info = ServerInfoSchema.parse(JSON.parse(infoResponse.text));
      expect(info.name).toBe(configs[i]!.name);
      expect(info.scope).toEqual(credential.scope);
      expect(info.workflowProfile).toBe("agent-client/0.8-fixture");
      expect(info.componentCatalog["service.action"]).toBe(2);
      expect(info.configuredServices).toEqual({
        interpretation: "demo-phrases",
        voice: false,
        contacts: "disabled",
        calendar: "simulated",
      });
      expect(infoResponse.text).not.toMatch(
        /apiKey|configFile|dataDirectory|accessToken/,
      );
      expect(
        (await http(`${url}/server`, { method: "POST", headers })).status,
      ).toBe(405);
      expect(
        (
          await http(`${url}/server`, {
            headers: { ...headers, Origin: "https://foreign.test" },
          })
        ).status,
      ).toBe(403);
      expect(
        (await http(`${url.replace("/a", "/b")}/server`, { headers })).status,
      ).toBe(403);
      const client = new ClientSession(url, storage, credential, transport);
      sessions.push(client);
      await client.start(false);
      expect(client.getSnapshot().status).toBe("online");
      expect(Object.keys(client.getSnapshot().store!.workItems)).toHaveLength(
        0,
      );
      await client.send(
        messageCommand("Choose Peter", "en", "same-command-id"),
      );
      expect(client.getSnapshot().commandStates.chat).toBe("accepted");
      expect(
        client.getSnapshot().store!.workItems["work-1"]!.presentation.type,
      ).toBe("workflow.progress");
    }
    expect(credentials[0]!.scope.serverId).not.toBe(
      credentials[1]!.scope.serverId,
    );
    expect(sessions[0]!.identityKey).not.toBe(sessions[1]!.identityKey);
    const foreign = { Authorization: `Bearer ${credentials[0]!.accessToken}` };
    expect((await http(`${urls[1]}/server`, { headers: foreign })).status).toBe(
      401,
    );
    expect(
      (await http(`${urls[1]}/snapshot`, { headers: foreign })).status,
    ).toBe(401);
    expect(() => createReferenceServer(configs[0]!)).toThrow("already in use");
    sessions[0]!.stop();
    await close(0);
    configs[0]!.name = "Renamed personal assistant";
    servers[0] = createReferenceServer(configs[0]!);
    const port = new URL(urls[0]!).port;
    await new Promise<void>((r) =>
      servers[0]!.listen(Number(port), "127.0.0.1", r),
    );
    const restored = new ClientSession(
      urls[0]!,
      storage,
      credentials[0]!,
      transport,
    );
    sessions.push(restored);
    await restored.start(false);
    expect(restored.getSnapshot().status).toBe("online");
    expect(Object.keys(restored.getSnapshot().store!.workItems)).toHaveLength(
      1,
    );
    await restored.send(
      messageCommand("Choose Peter", "en", "same-command-id"),
    );
    expect(Object.keys(restored.getSnapshot().store!.workItems)).toHaveLength(
      1,
    );
    expect(restored.getSnapshot().store!.scope).toEqual(credentials[0]!.scope);
    const renamed = await http(`${urls[0]}/server`, { headers: foreign });
    expect(ServerInfoSchema.parse(JSON.parse(renamed.text)).name).toBe(
      "Renamed personal assistant",
    );
  } finally {
    sessions.forEach((session) => session.stop());
    await Promise.all(servers.map((_, i) => close(i)));
    rmSync(root, { recursive: true, force: true });
  }
});

test("server-owned adapter customization remains declarative and calendar discovery respects the authenticated scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reference-adapters-"));
  const { serverId } = new FixtureAuth(directory);
  const scope = {
    connectionId: "fixture-a",
    serverId,
    userId: "alice",
    workspaceId: "a",
  };
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "Custom assistant",
    listen: { port: 8794 },
    dataDirectory: directory,
    allowedOrigins: [],
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });
  const decide = jest.fn(async () => ({
    kind: "reply" as const,
    contactId: null,
    title: null,
    localStart: null,
    durationMinutes: null,
    reply: "Custom server reply",
  }));
  const list = jest.fn(async () => []);
  const server = createReferenceServer(config, {
    model: { timeZone: "Europe/Prague", decide },
    crm: { list },
    calendar: {
      scope,
      target: {
        provider: "caldav",
        integrationId: "test-calendar",
        label: "TEST calendar",
        collectionUrl: "http://127.0.0.1:9/test/",
        invitations: "none",
      },
      username: "test-user",
      password: "synthetic-private-calendar-password",
    },
  });
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/a`;
    for (const user of ["alice", "bob"]) {
      const paired = await http(`${url}/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authProfile: AUTH_PROFILE,
          profile: PROFILE,
          code: issuePairingCode(directory, user, "a"),
        }),
      });
      const credential = CredentialSchema.parse(JSON.parse(paired.text));
      const headers = {
        Authorization: `Bearer ${credential.accessToken}`,
        "Content-Type": "application/json",
      };
      const info = ServerInfoSchema.parse(
        JSON.parse((await http(`${url}/server`, { headers })).text),
      );
      expect(info.configuredServices).toMatchObject({
        interpretation: "model",
        contacts: "test-read-only",
        calendar: user === "alice" ? "caldav-test" : "simulated",
      });
      const result = await http(`${url}/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify(messageCommand("Hello", "en", "hello")),
      });
      expect(result.status).toBe(202);
      expect(
        JSON.parse(result.text).snapshot.conversations[0].messages.at(-1).text,
      ).toBe("Custom server reply");
      expect(JSON.parse(result.text).snapshot.operations).toEqual([]);
    }
    expect(decide).toHaveBeenCalledTimes(2);
    expect(list).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
});

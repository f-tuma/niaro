import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { issuePairingCode } from "../apps/fixture-server/auth";
import { createFixtureServer } from "../apps/fixture-server/http";
import {
  messageCommand,
  answerCommand,
} from "../packages/client-core/commands";
import {
  AUTH_PROFILE,
  PROFILE,
  CredentialSchema,
  SnapshotSchema,
  CommandResultSchema,
} from "../packages/protocol";

function json(
  port: number,
  path: string,
  body?: unknown,
  origin?: string,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: body ? "POST" : "GET",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(origin ? { Origin: origin } : {}),
        },
      },
      (response) => {
        let text = "";
        response.on("data", (c) => {
          text += c.toString();
        });
        response.on("end", () =>
          resolve({ status: response.statusCode!, body: JSON.parse(text) }),
        );
      },
    );
    r.on("error", reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}
test("real HTTP scenario persists across server restart; invalid origin and foreign scope are rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-fixture-"));
  let server = createFixtureServer(dir);
  const listen = async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return (server.address() as AddressInfo).port;
  };
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  try {
    let port = await listen();
    const pair = async (workspace: string) =>
      CredentialSchema.parse(
        (
          await json(port, `/v1/${workspace}/auth/pair`, {
            authProfile: AUTH_PROFILE,
            profile: PROFILE,
            code: issuePairingCode(dir, "alice", workspace),
          })
        ).body,
      ).accessToken;
    const a = await pair("a"),
      b = await pair("b");
    const created = await json(
      port,
      "/v1/a/commands",
      messageCommand("Choose Peter", "en", "http-start"),
      "http://localhost:8081",
      a,
    );
    expect(created.status).toBe(202);
    const first = CommandResultSchema.parse(created.body).snapshot;
    expect(
      (
        await json(
          port,
          "/v1/a/snapshot",
          undefined,
          "https://untrusted.example",
          a,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await json(
          port,
          "/v1/b/commands",
          answerCommand(first.inputRequests[0]!, "peter-novak", "wrong-scope"),
          undefined,
          b,
        )
      ).status,
    ).toBe(422);
    await close();
    server = createFixtureServer(dir);
    port = await listen();
    const restored = SnapshotSchema.parse(
      (await json(port, "/v1/a/snapshot", undefined, undefined, a)).body,
    );
    expect(restored).toEqual(first);
    const answered = await json(
      port,
      "/v1/a/commands",
      messageCommand(
        "Choose Peter Svoboda",
        "en",
        "http-reply",
        first.inputRequests[0]!,
      ),
      undefined,
      a,
    );
    expect(
      CommandResultSchema.parse(answered.body).snapshot.workItems[0]?.status,
    ).toBe("running");
    expect(
      (
        await json(
          port,
          "/v1/a/commands",
          {
            ...messageCommand("Choose Peter", "en", "bad"),
            scope: { workspaceId: "b" },
          },
          undefined,
          a,
        )
      ).status,
    ).toBe(400);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

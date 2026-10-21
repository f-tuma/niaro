import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createFixtureServer } from "../apps/fixture-server/http";
import { FixtureAuth, issuePairingCode } from "../apps/fixture-server/auth";
import { FixtureStorage } from "../apps/fixture-server/storage";
import {
  AUTH_PROFILE,
  PROFILE,
  CredentialSchema,
  SnapshotSchema,
  CommandResultSchema,
} from "../packages/protocol";
import { messageCommand } from "../packages/client-core/commands";
const json = (
  port: number,
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
) =>
  new Promise<{ status: number; value: unknown }>((resolve, reject) => {
    const r = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c.toString();
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            value: text ? JSON.parse(text) : null,
          }),
        );
      },
    );
    r.on("error", reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
test("HTTP protects all routes, single-use pairing binds user/workspace, and revocation survives restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-auth-http-"));
  let now = Date.now();
  let server = createFixtureServer(dir, undefined, {
    now: () => now,
    sessionTtlMs: 60_000,
  });
  const listen = async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  };
  const close = () =>
    new Promise<void>((r, reject) =>
      server.close((e) => (e ? reject(e) : r())),
    );
  let port = await listen();
  try {
    for (const route of [
      "snapshot",
      "events?after=0",
      "auth/session",
      "commands",
    ])
      expect(
        (
          await json(
            port,
            `/v1/a/${route}`,
            route === "commands" ? "POST" : "GET",
            route === "commands"
              ? messageCommand("Choose Peter", "en", "unauth")
              : undefined,
          )
        ).status,
      ).toBe(401);
    const code = issuePairingCode(dir, "alice", "a", now);
    const pairBody = { authProfile: AUTH_PROFILE, profile: PROFILE, code };
    expect((await json(port, "/v1/b/auth/pair", "POST", pairBody)).status).toBe(
      401,
    );
    const alice = CredentialSchema.parse(
      (await json(port, "/v1/a/auth/pair", "POST", pairBody)).value,
    );
    expect((await json(port, "/v1/a/auth/pair", "POST", pairBody)).status).toBe(
      401,
    );
    expect(
      (await json(port, "/v1/b/snapshot", "GET", undefined, alice.accessToken))
        .status,
    ).toBe(403);
    expect(
      (
        await json(
          port,
          "/v1/b/commands",
          "POST",
          messageCommand("Choose Peter", "en", "foreign"),
          alice.accessToken,
        )
      ).status,
    ).toBe(403);
    const first = CommandResultSchema.parse(
      (
        await json(
          port,
          "/v1/a/commands",
          "POST",
          messageCommand("Choose Peter", "en", "same-command"),
          alice.accessToken,
        )
      ).value,
    ).snapshot;
    expect(first.scope.userId).toBe("alice");
    const bob = CredentialSchema.parse(
      (
        await json(port, "/v1/a/auth/pair", "POST", {
          ...pairBody,
          code: issuePairingCode(dir, "bob", "a", now),
        })
      ).value,
    );
    expect(
      SnapshotSchema.parse(
        (await json(port, "/v1/a/snapshot", "GET", undefined, bob.accessToken))
          .value,
      ).workItems,
    ).toHaveLength(0);
    const second = CommandResultSchema.parse(
      (
        await json(
          port,
          "/v1/a/commands",
          "POST",
          messageCommand("Choose Peter", "en", "same-command"),
          bob.accessToken,
        )
      ).value,
    ).snapshot;
    expect(second.workItems[0]?.id).toBe(first.workItems[0]?.id);
    expect(second.scope.userId).toBe("bob");
    expect(
      (
        await json(
          port,
          "/v1/a/commands",
          "POST",
          {
            ...messageCommand("Choose Peter", "en", "inject"),
            scope: alice.scope,
          },
          bob.accessToken,
        )
      ).status,
    ).toBe(400);
    const stored = readFileSync(join(dir, "auth/sessions.json"), "utf8");
    expect(stored).not.toContain(alice.accessToken);
    expect(stored).not.toContain(bob.accessToken);
    expect(stored).not.toContain(code);
    expect(
      (
        await json(
          port,
          "/v1/a/auth/session",
          "DELETE",
          undefined,
          alice.accessToken,
        )
      ).status,
    ).toBe(204);
    await close();
    server = createFixtureServer(dir, undefined, { now: () => now });
    port = await listen();
    expect(
      (await json(port, "/v1/a/snapshot", "GET", undefined, alice.accessToken))
        .status,
    ).toBe(401);
    expect(
      SnapshotSchema.parse(
        (await json(port, "/v1/a/snapshot", "GET", undefined, bob.accessToken))
          .value,
      ).workItems,
    ).toHaveLength(1);
    now += 60_001;
    expect(
      (
        await json(
          port,
          "/v1/a/commands",
          "POST",
          messageCommand("Choose Peter", "en", "expired"),
          bob.accessToken,
        )
      ).status,
    ).toBe(401);
    const persisted = new FixtureStorage(dir, bob.scope.serverId);
    try {
      expect(persisted.snapshot(bob.scope).workItems).toHaveLength(1);
    } finally {
      persisted.close();
    }
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("expired grants, rate limit, and failed session persistence never grant access", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-auth-"));
  let now = Date.now();
  try {
    const auth = new FixtureAuth(dir, () => now);
    const code = issuePairingCode(dir, "alice", "a", now);
    now += 300_001;
    expect(() => auth.pair(code, "a")).toThrow("pairing_invalid");
    for (let n = 0; n < 10; n++) auth.rateLimit("local");
    expect(() => auth.rateLimit("local")).toThrow("pairing_rate_limited");
    now += 60_001;
    expect(() => auth.rateLimit("local")).not.toThrow();
    const fresh = issuePairingCode(dir, "alice", "a", now);
    mkdirSync(join(dir, "auth/sessions.json.tmp"));
    expect(() => auth.pair(fresh, "a")).toThrow();
    expect(
      readdirSync(join(dir, "auth/pairing")).some((f) =>
        f.endsWith(".consumed"),
      ),
    ).toBe(false);
    rmSync(join(dir, "auth/sessions.json.tmp"), { recursive: true });
    const issued = auth.pair(fresh, "a");
    expect(
      auth.authenticate(`Bearer ${issued.accessToken}`, "a").scope.userId,
    ).toBe("alice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

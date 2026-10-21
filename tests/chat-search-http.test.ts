import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { createFixtureServer } from "../apps/fixture-server/http";
import { issuePairingCode } from "../apps/fixture-server/auth";
import type { Decision } from "../apps/fixture-server/decision";
import {
  AUTH_PROFILE,
  PROFILE,
  CONVERSATION_PROJECTION_PROFILE,
  CredentialSchema,
} from "../packages/protocol";
import {
  CHAT_SEARCH_PROFILE,
  ChatSearchPageSchema,
} from "../packages/protocol/chat-search";

const call = (
  port: number,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: body ? "POST" : "GET",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => {
          text += String(c);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: JSON.parse(text) }),
        );
      },
    );
    req.setTimeout(4000, () => req.destroy(new Error(`TEST timeout ${path}`)));
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });

const reply = (text: string): Decision => ({
  kind: "reply",
  contactId: null,
  localStart: null,
  title: null,
  durationMinutes: null,
  reply: text,
});

async function start(
  directory: string,
  decide?: () => Promise<Decision>,
  now?: () => number,
) {
  const server = createFixtureServer(directory, undefined, {
    ...(now ? { now } : {}),
    ...(decide ? { model: { timeZone: "UTC", decide } } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const pair = async (user: string) =>
    CredentialSchema.parse(
      (
        await call(port, "/v1/a/auth/pair", undefined, {
          authProfile: AUTH_PROFILE,
          profile: PROFILE,
          code: issuePairingCode(directory, user, "a"),
        })
      ).body,
    ).accessToken;
  return { server, port, pair };
}

const commands = `/v1/a/commands?chats=${CONVERSATION_PROJECTION_PROFILE}`;
const search = (q: string, extra = "", workspace = "a") =>
  `/v1/${workspace}/search?profile=${CHAT_SEARCH_PROFILE}&q=${encodeURIComponent(q)}${extra}`;
const send = (id: string, conversationId: string, text: string) => ({
  type: "message.send",
  commandId: id,
  idempotencyKey: id,
  conversationId,
  text,
  language: "en",
});
const create = (id: string) => ({
  type: "conversation.create",
  conversationId: id,
  commandId: `TEST-create-${id}`,
  idempotencyKey: `TEST-create-${id}`,
});

test("the search route finds the person's own chats only, strictly and without leftovers after deletion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-chat-search-http-"));
  const decide = jest.fn(async () => reply("Schůzka je v kalendáři."));
  const { server, port, pair } = await start(directory, decide);
  try {
    const alice = await pair("alice");
    const bob = await pair("bob");
    expect(
      (await call(port, commands, alice, create("chat-TEST-a"))).status,
    ).toBe(202);
    expect(
      (
        await call(
          port,
          commands,
          alice,
          send("TEST-1", "chat-TEST-a", "Naplánuj schůzku s Petrem"),
        )
      ).status,
    ).toBe(202);
    expect(
      (await call(port, commands, bob, create("chat-TEST-b"))).status,
    ).toBe(202);
    expect(
      (
        await call(
          port,
          commands,
          bob,
          send("TEST-2", "chat-TEST-b", "Bobova tajná schůzka"),
        )
      ).status,
    ).toBe(202);

    const indexText = () => {
      const db = new DatabaseSync(join(directory, "workflow.sqlite"));
      try {
        return db
          .prepare("SELECT block FROM chat_search_fts_data")
          .all()
          .map((r) => Buffer.from(r.block as Uint8Array).toString("latin1"))
          .join("|");
      } finally {
        db.close();
      }
    };
    const found = await call(port, search("schuzka"), alice);
    expect(indexText()).toContain("petrem");
    expect(found.status).toBe(200);
    const page = ChatSearchPageSchema.parse(found.body);
    expect(page.results.map((r) => r.conversation.id)).toEqual(["chat-TEST-a"]);
    const [result] = page.results;
    expect(result!.matches.map((m) => [m.role, m.snippet])).toEqual([
      ["user", "Naplánuj schůzku s Petrem"],
      ["assistant", "Schůzka je v kalendáři."],
    ]);
    expect(result!.matches[0]!.createdAt).toMatch(/^2\d{3}-/);
    expect(JSON.stringify(found.body)).not.toContain("Bobova");
    expect(
      ChatSearchPageSchema.parse(
        (await call(port, search("schuzka", "&role=assistant"), alice)).body,
      ).results[0]!.matches.map((m) => m.role),
    ).toEqual(["assistant"]);

    // Strict requests; no token, no search.
    expect((await call(port, search("  "), alice)).status).toBe(400);
    expect((await call(port, `${search("x")}&limit=50`, alice)).status).toBe(
      400,
    );
    expect((await call(port, `${search("x")}&foo=1`, alice)).status).toBe(400);
    expect(
      (await call(port, `/v1/a/search?profile=agent-chat-search/9&q=x`, alice))
        .status,
    ).toBe(406);
    expect((await call(port, search("schuzka"))).status).toBe(401);
    // Another workspace's token is not this workspace's.
    expect((await call(port, search("schuzka", "", "b"), alice)).status).toBe(
      403,
    );

    const removed = await call(port, commands, alice, {
      type: "conversation.delete",
      conversationId: "chat-TEST-a",
      commandId: "TEST-delete",
      idempotencyKey: "TEST-delete",
    });
    expect(removed.status).toBe(202);
    expect(
      ChatSearchPageSchema.parse(
        (await call(port, search("schuzka", "&include=archived"), alice)).body,
      ).results,
    ).toEqual([]);
    // Nothing of the chat stays in the index, while Bob's words do.
    expect((await call(port, search("tajna"), bob)).status).toBe(200);
    const index = indexText();
    expect(index).not.toContain("petrem");
    expect(index).toContain("bobova");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a typing search is rate limited per person", async () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-chat-search-limit-"));
  const { server, port, pair } = await start(directory);
  try {
    const alice = await pair("alice");
    const bob = await pair("bob");
    const statuses: number[] = [];
    for (let i = 0; i < 41; i++)
      statuses.push((await call(port, search(`dotaz ${i}`), alice)).status);
    expect(statuses.slice(0, 40).every((s) => s === 200)).toBe(true);
    expect(statuses[40]).toBe(429);
    expect((await call(port, search("dotaz"), bob)).status).toBe(200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

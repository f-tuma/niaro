import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureAuth, issuePairingCode } from "../apps/fixture-server/auth";
import { createFixtureServer } from "../apps/fixture-server/http";
import { FixtureStorage } from "../apps/fixture-server/storage";
import type { Interpretation } from "../apps/fixture-server/engine";
import type { Decision, ModelInput } from "../apps/fixture-server/decision";
import { serviceCard } from "../apps/server-cards/adapters";
import { messageCommand } from "../packages/client-core/commands";
import {
  CommandResultSchema,
  CredentialSchema,
  EventsResponseSchema,
  SnapshotSchema,
  type Snapshot,
} from "../packages/protocol";
import { CARD_PROFILE } from "../packages/protocol/card-document";
import { snapshotForClient } from "../packages/protocol/reply-correlation";
import { ServerInfoSchema } from "../packages/protocol/server-info";
import type { ServiceResult } from "../packages/protocol/service-result";
import { MESSAGE_TIME_PROFILE } from "../packages/protocol/message-delivery";
import { GENERATIVE_UI_PROFILE } from "../packages/protocol/generative-ui";

const reply: Decision = {
  kind: "reply",
  contactId: null,
  title: null,
  localStart: null,
  durationMinutes: null,
  reply: "TEST answer received",
};
const ui = {
  type: "openui.program",
  version: 1,
  library: "niaro-ui@1",
  program: 'root = Stack([Heading("TEST Review"), Metric("TEST Items", 3)])',
} as const;

function json(
  port: number,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; value: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, value: JSON.parse(text) });
          } catch (error) {
            reject(error);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function seed(directory: string) {
  const auth = new FixtureAuth(directory);
  const credential = CredentialSchema.parse(
    auth.pair(issuePairingCode(directory, "alice", "a"), "a"),
  );
  const foreign = CredentialSchema.parse(
    auth.pair(issuePairingCode(directory, "alice", "b"), "b"),
  );
  const store = new FixtureStorage(directory, auth.serverId);
  const { scope } = credential;
  const interpretation = (
    extra: Partial<Interpretation> = {},
  ): Interpretation => ({
    decision: reply,
    expectedCursor: store.snapshot(scope).cursor,
    timeZone: "UTC",
    ...extra,
  });
  const service: ServiceResult = {
    type: "service.action",
    version: 1,
    operationId: "TEST-proposed-operation",
    title: "Create a review",
    service: "TEST calendar",
    status: "awaiting_approval",
    effect: "write",
    fields: [{ label: "Recipient", value: "reviewer@example.test" }],
    inputJson: '{"recipient":"reviewer@example.test"}',
    reviewTruncated: false,
    summary: "",
  };
  service.card = serviceCard(service, "en");
  const creation = messageCommand(
    "TEST summarize the review",
    "en",
    "TEST-seed-ui",
  );
  try {
    expect(
      store.execute(
        scope,
        messageCommand("Choose Peter", "en", "TEST-seed-work"),
      ).status,
    ).toBe("accepted");
    expect(
      store.execute(
        scope,
        messageCommand("TEST display the proposal", "en", "TEST-seed-service"),
        interpretation({ serviceResult: service }),
      ).status,
    ).toBe("accepted");
    const receipt = store.execute(scope, creation, interpretation({ ui }));
    expect(receipt.status).toBe("accepted");
    expect(receipt.snapshot.conversations[0]!.messages.at(-1)!.ui).toEqual(ui);
    return {
      credential,
      foreign,
      scope,
      creation,
      snapshot: receipt.snapshot,
    };
  } finally {
    store.close();
  }
}

function serviceResult(snapshot: Snapshot) {
  return snapshot.conversations[0]!.messages.find(
    (message) => message.result?.type === "service.action",
  )?.result;
}
function expectLegacy(snapshot: Snapshot) {
  expect(snapshot.workItems).toHaveLength(1);
  expect(snapshot.workItems[0]).not.toHaveProperty("card");
  const service = serviceResult(snapshot);
  expect(service).toMatchObject({
    status: "awaiting_approval",
    fields: [{ label: "Recipient", value: "reviewer@example.test" }],
    inputJson: '{"recipient":"reviewer@example.test"}',
  });
  expect(service).not.toHaveProperty("card");
  const assistant = snapshot.conversations[0]!.messages.at(-1)!;
  expect(assistant).toMatchObject({
    role: "assistant",
    text: "TEST answer received",
  });
  expect(assistant).not.toHaveProperty("result");
  expect(assistant).not.toHaveProperty("ui");
  expect(assistant).not.toHaveProperty("createdAt");
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "card-http-"));
  const seeded = seed(directory);
  const decide = jest.fn<Promise<Decision>, [ModelInput, AbortSignal]>(
    async () => reply,
  );
  let server = createFixtureServer(directory, undefined, {
    serverName: "TEST card server",
    model: { timeZone: "UTC", decide },
  });
  let port = 0;
  const listen = async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    port = (server.address() as AddressInfo).port;
  };
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await listen();
  const call = (
    path: string,
    value?: unknown,
    token = seeded.credential.accessToken,
  ) => json(port, path, token, value);
  const restart = async () => {
    await close();
    server = createFixtureServer(directory, undefined, {
      serverName: "TEST card server",
      model: { timeZone: "UTC", decide },
    });
    await listen();
  };
  const dispose = async () => {
    try {
      await close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  return { ...seeded, call, restart, dispose, decide };
}

test("real HTTP negotiates passive cards and generated UI on snapshots, events, receipts and catalog while preserving the old wire", async () => {
  const f = await fixture();
  // This client also shows message times, so it receives the stored wire.
  const negotiated = `cards=${encodeURIComponent(CARD_PROFILE)}&messages=${encodeURIComponent(MESSAGE_TIME_PROFILE)}&ui=${encodeURIComponent(GENERATIVE_UI_PROFILE)}`;
  try {
    const snapshot = SnapshotSchema.parse(
      (await f.call(`/v1/a/snapshot?${negotiated}`)).value,
    );
    expect(snapshot).toEqual(snapshotForClient(f.snapshot, false));
    expect(snapshot.workItems[0]?.card).toBeDefined();
    expect(serviceResult(snapshot)).toHaveProperty("card");
    expect(snapshot.conversations[0]!.messages.at(-1)?.ui).toEqual(ui);
    expect(
      SnapshotSchema.parse(
        (
          await f.call(
            `/v1/a/snapshot?cards=${encodeURIComponent(CARD_PROFILE)}`,
          )
        ).value,
      ).conversations[0]!.messages.at(-1),
    ).not.toHaveProperty("ui");
    expectLegacy(SnapshotSchema.parse((await f.call("/v1/a/snapshot")).value));
    expectLegacy(
      SnapshotSchema.parse(
        (await f.call("/v1/a/snapshot?cards=agent-card%2F999")).value,
      ),
    );

    const catalog = ServerInfoSchema.parse(
      (await f.call(`/v1/a/server?${negotiated}`)).value,
    );
    expect(catalog.componentCatalog["card.document"]).toBe(1);
    const oldCatalog = ServerInfoSchema.parse(
      (await f.call("/v1/a/server")).value,
    );
    expect(oldCatalog.componentCatalog).not.toHaveProperty("card.document");

    const events = EventsResponseSchema.parse(
      (await f.call(`/v1/a/events?after=0&${negotiated}`)).value,
    ).events;
    expect(
      events.some(
        (event) => event.type === "work_item.upserted" && !!event.entity.card,
      ),
    ).toBe(true);
    const latest = events
      .filter((event) => event.type === "conversation.upserted")
      .at(-1)!;
    if (latest.type !== "conversation.upserted")
      throw new Error("Expected conversation event");
    expect(latest.entity.messages.at(-1)?.ui).toEqual(ui);
    const oldEvents = EventsResponseSchema.parse(
      (await f.call("/v1/a/events?after=0")).value,
    ).events;
    expect(
      oldEvents.some(
        (event) =>
          event.type === "work_item.upserted" && "card" in event.entity,
      ),
    ).toBe(false);
    const oldConversation = oldEvents
      .filter((event) => event.type === "conversation.upserted")
      .at(-1)!;
    if (oldConversation.type !== "conversation.upserted")
      throw new Error("Expected conversation event");
    expect(oldConversation.entity.messages.at(-1)).not.toHaveProperty("ui");

    const receipt = await f.call(`/v1/a/commands?${negotiated}`, f.creation);
    expect(receipt.status).toBe(202);
    expect(CommandResultSchema.parse(receipt.value).snapshot).toEqual(snapshot);
    const oldReceipt = await f.call("/v1/a/commands", f.creation);
    expect(oldReceipt.status).toBe(202);
    expectLegacy(CommandResultSchema.parse(oldReceipt.value).snapshot);
    expect(f.decide).not.toHaveBeenCalled();
    await f.restart();
    expect(
      SnapshotSchema.parse(
        (await f.call(`/v1/a/snapshot?${negotiated}`)).value,
      ),
    ).toEqual(snapshot);
    expect(
      CommandResultSchema.parse(
        (await f.call(`/v1/a/commands?${negotiated}`, f.creation)).value,
      ).snapshot,
    ).toEqual(snapshot);
    expect(f.decide).not.toHaveBeenCalled();
  } finally {
    await f.dispose();
  }
});

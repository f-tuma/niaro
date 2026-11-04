import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { IdentityStateSchema } from "../packages/protocol/identity";
import { PetMemoryPageSchema } from "../packages/protocol/work-pet";
import { connectorRequestId } from "../apps/server-identity/mcp-connector";
import { mcpScope } from "../apps/server-identity/mcp-access";
import type { MeetingStore } from "../apps/server-identity/meeting-store";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";

type Fixture = Awaited<ReturnType<typeof coordinatorHttpFixture>>;
const fixture = coordinatorHttpFixture({
  allowOrdinaryRuntime: true,
  testSavedMemory: true,
}).then(async (h) => {
  // Background profile learning would call the model on its own schedule;
  // stopped here so every model call below would come from MCP.
  await h.identity["profileLearner"]?.close();
  return h;
});
after(async () => {
  await (await fixture).close();
});

const DATA_TOOLS = [
  "niaro_meeting_get",
  "niaro_memory_list",
  "niaro_search",
  "niaro_tasks_list",
];

async function issue(h: Fixture, scopes: string[], label = "TEST router app") {
  const result = await h.request("owner", "api/identity/mcp/access/issue", {
    workspaceId: h.target.workspaceId,
    label,
    scopes,
    expiresAt: Date.now() + 3_600_000,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const data = h.record(result.data);
  return {
    accessToken: String(data.accessToken),
    grantId: String(h.record(data.grant).id),
  };
}
async function connect(h: Fixture, token: string) {
  const client = new Client({ name: "TEST router client", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(h.origin + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
    }),
  );
  return client;
}
type Value = Record<string, unknown> & {
  error?: { code: string; message: string };
};
async function call(client: Client, name: string, input: object) {
  const result = await client.callTool({ name, arguments: { ...input } });
  return {
    isError: result.isError ?? false,
    value: result.structuredContent as Value,
  };
}

/** A finished meeting of the owner, as the meeting pipeline leaves it. */
async function seedMeeting(h: Fixture) {
  const owner = IdentityStateSchema.parse(
    (await h.request("owner", "api/identity")).data,
  ).user!.id;
  const scope = mcpScope({
    workspaceId: h.target.workspaceId,
    serverId: h.identity["workflowServerId"]!,
    userId: owner,
  });
  const store = h.identity["meetings"] as MeetingStore;
  const id = randomUUID();
  store.create(scope, {
    profile: "niaro-meetings/1",
    id,
    title: "TEST Quasar planning",
    recordedAt: new Date().toISOString(),
    language: "en",
    mimeType: "audio/wav",
    bytes: 1,
    speakerChannels: "self-others",
  });
  store.update(scope, id, { durationSeconds: 60, status: "analyzing" });
  const own = "TEST I will send the quasar budget on Friday.",
    other = "TEST We decided to launch the quasar pilot in March.";
  store.putTranscript(
    scope,
    id,
    [
      {
        index: 0,
        startSeconds: 0,
        endSeconds: 60,
        text: `${own} ${other}`,
        reviewReasons: [],
        transcriber: "TEST",
        analyzer: null,
        analysis: null,
      },
    ],
    [
      { start: 0, end: 20, speaker: "me", text: own },
      { start: 20, end: 40, speaker: "others", text: other },
    ],
  );
  store.publishRecord(
    scope,
    id,
    {
      summary: "TEST The team planned the quasar pilot.",
      summarySources: [{ segment: 0, quote: other }],
      points: [],
      decisions: [
        {
          text: "TEST Launch the quasar pilot in March.",
          sources: [{ segment: 0, quote: other }],
        },
      ],
      tasks: [
        {
          text: "TEST Send the quasar budget",
          owner: "me",
          assignee: null,
          due: null,
          sources: [{ segment: 0, quote: own }],
        },
      ],
      overflow: false,
    },
    "TEST-model",
  );
  return id;
}

test("tools follow the grant's scopes and the server tells the app how to use Niaro", async () => {
  const h = await fixture;
  const read = await connect(h, (await issue(h, ["data.read"])).accessToken);
  const write = await connect(
    h,
    (await issue(h, ["memory.write"])).accessToken,
  );
  const services = await connect(
    h,
    (await issue(h, ["services.call"])).accessToken,
  );
  try {
    assert.deepEqual(
      (await read.listTools()).tools.map((tool) => tool.name).sort(),
      DATA_TOOLS,
    );
    assert.deepEqual(
      (await write.listTools()).tools.map((tool) => tool.name),
      ["niaro_memory_save"],
    );
    const connector = (await services.listTools()).tools.map((t) => t.name);
    assert(connector.includes("niaro_call_status"), connector.join());
    assert(!connector.some((name) => DATA_TOOLS.includes(name)));
    assert(!connector.some((name) => name.startsWith("task_")));

    const instructions = read.getInstructions() ?? "";
    assert.match(instructions, /niaro_search/);
    assert.match(instructions, /niaro_memory_save/);
    assert(instructions.length <= 4_000, String(instructions.length));
    assert.equal(read.getServerVersion()?.name, "niaro");
    assert.match(read.getServerVersion()?.version ?? "", /^\d+\.\d+\.\d+/);

    const search = (await read.listTools()).tools.find(
      (tool) => tool.name === "niaro_search",
    )!;
    assert.equal(search.annotations?.readOnlyHint, true);
    assert.equal(search.annotations?.openWorldHint, false);

    // A data tool outside the grant's scopes is refused, never run.
    const refused = await call(write, "niaro_search", { query: "TEST" });
    assert.equal(refused.isError, true);
    assert.equal(refused.value.error?.code, "insufficient_scope");
  } finally {
    await Promise.all([read.close(), write.close(), services.close()]);
  }
});

test("search, meetings, tasks and memory read the person's data and save memory without a model call", async () => {
  const h = await fixture;
  const meetingId = await seedMeeting(h);
  const grant = await issue(h, ["data.read", "memory.write"]);
  const client = await connect(h, grant.accessToken);
  const models = h.modelCount();
  try {
    const found = await call(client, "niaro_search", {
      query: "quasar budget",
    });
    assert.equal(found.isError, false, JSON.stringify(found.value));
    const hits = found.value.hits as Record<string, unknown>[];
    const meeting = hits.find((hit) => hit.kind === "meetings");
    assert.equal(meeting?.id, meetingId, JSON.stringify(hits));
    assert.equal(meeting?.title, "TEST Quasar planning");
    assert(
      hits.some((hit) => hit.kind === "tasks"),
      "The meeting's action item is a task: " + JSON.stringify(hits),
    );
    // Another form of the word still finds the meeting (NIAR-290).
    const inflected = await call(client, "niaro_search", {
      query: "Quasars",
      kinds: ["meetings"],
    });
    assert.deepEqual(
      (inflected.value.hits as { id: string }[]).map((hit) => hit.id),
      [meetingId],
    );

    // The meeting as the app shows it, its transcript paged with speakers.
    const first = await call(client, "niaro_meeting_get", {
      meetingId,
      limit: 1,
    });
    assert.equal(first.isError, false, JSON.stringify(first.value));
    assert.equal(
      first.value.summary,
      "TEST The team planned the quasar pilot.",
    );
    assert.deepEqual(first.value.decisions, [
      "TEST Launch the quasar pilot in March.",
    ]);
    assert.deepEqual(
      (first.value.actionItems as { text: string; owner: string }[]).map(
        ({ text, owner }) => ({ text, owner }),
      ),
      [{ text: "TEST Send the quasar budget", owner: "Me" }],
    );
    const page = first.value.transcript as {
      turns: { speaker: string; text: string; at: string }[];
      nextCursor: string | null;
      total: number;
    };
    assert.equal(page.total, 2);
    assert.deepEqual(page.turns, [
      {
        at: "0:00",
        speaker: "Me",
        text: "TEST I will send the quasar budget on Friday.",
      },
    ]);
    assert(page.nextCursor);
    const second = await call(client, "niaro_meeting_get", {
      meetingId,
      limit: 1,
      cursor: page.nextCursor,
    });
    const next = second.value.transcript as typeof page;
    assert.equal(next.turns[0]!.speaker, "Others");
    assert.equal(next.nextCursor, null);

    const tasks = await call(client, "niaro_tasks_list", {});
    assert.equal(tasks.isError, false, JSON.stringify(tasks.value));
    assert.deepEqual(
      (tasks.value.tasks as { title: string }[]).map((task) => task.title),
      ["TEST Send the quasar budget"],
    );

    // Saved at once into the person's profile, attributed to the app.
    const saved = await call(client, "niaro_memory_save", {
      facts: [
        { text: "TEST Prefers quasar updates on Mondays.", kind: "preference" },
        { text: "TEST Works with Jana Nováková on the pilot." },
      ],
    });
    assert.equal(saved.isError, false, JSON.stringify(saved.value));
    assert.deepEqual(
      (saved.value.results as { status: string }[]).map((r) => r.status),
      ["saved", "saved"],
    );
    const query = new URLSearchParams({
      ...h.target,
      profile: "work-pet/1",
    });
    const profile = PetMemoryPageSchema.parse(
      (await h.request("owner", `api/identity/pet/memory?${query}`)).data,
    );
    const shown = profile.items.find(
      (item) => item.content === "TEST Prefers quasar updates on Mondays.",
    );
    assert(shown, JSON.stringify(profile.items));
    assert.deepEqual(shown.source, {
      type: "external_app",
      grantId: grant.grantId,
      name: "TEST router app",
    });
    assert.equal(shown.status, "active");

    // A repeat is recognized, a secret is refused, nothing is saved twice.
    const again = await call(client, "niaro_memory_save", {
      facts: [{ text: "test prefers quasar updates on mondays" }],
    });
    assert.deepEqual(
      (again.value.results as { status: string }[]).map((r) => r.status),
      ["already_saved"],
    );
    const secret = await call(client, "niaro_memory_save", {
      facts: [{ text: "TEST My password is hunter2" }],
    });
    assert.equal(secret.isError, true);
    assert.equal(secret.value.error?.code, "secret_refused");
    assert.match(secret.value.error?.message ?? "", /facts\[0\]\.text/);
    const invalid = await call(client, "niaro_memory_save", {
      facts: [{ text: "x".repeat(501) }],
    });
    assert.equal(invalid.value.error?.code, "invalid_input");
    assert.match(invalid.value.error?.message ?? "", /facts\[0\]\.text/);
    assert.match(
      invalid.value.error?.message ?? "",
      /A correct call looks like/,
    );

    const memory = await call(client, "niaro_search", {
      query: "quasar Mondays",
      kinds: ["memory"],
    });
    assert.deepEqual(
      (memory.value.hits as { kind: string; title: string }[]).map(
        (hit) => hit.title,
      ),
      ["TEST Prefers quasar updates on Mondays."],
    );
    const listed = await call(client, "niaro_memory_list", {});
    assert.equal(
      (listed.value.memories as { text: string }[]).filter((m) =>
        m.text.startsWith("TEST "),
      ).length,
      2,
    );

    assert.equal(h.modelCount(), models, "MCP data tools never call a model");
    const audit = h.identity["db"]
      .prepare(
        "SELECT count(*) AS n FROM agent_audit WHERE source='mcp' AND action='mcp.data_read'",
      )
      .get() as { n: number };
    assert(Number(audit.n) >= 5, JSON.stringify(audit));
  } finally {
    await client.close();
  }
});

test("a keyed connector write retried after a lost response keeps one receipt", async () => {
  const h = await fixture;
  const grant = await issue(h, ["services.call"]);
  const client = await connect(h, grant.accessToken);
  const models = h.modelCount();
  try {
    const write = (await client.listTools()).tools.find((tool) =>
      tool.annotations?.title?.startsWith("TEST confirmed write"),
    )!;
    const properties = write.inputSchema.properties as Record<
      string,
      { description?: string }
    >;
    assert.match(properties.requestId?.description ?? "", /retrying/);
    const lookup = (await client.listTools()).tools.find((tool) =>
      tool.annotations?.title?.startsWith("TEST lookup"),
    )!;
    assert.equal(
      (lookup.inputSchema.properties as Record<string, unknown>).requestId,
      undefined,
    );

    const receipts = () =>
      Number(
        (
          h.identity["db"]
            .prepare("SELECT count(*) AS n FROM agent_service_invocation")
            .get() as { n: number }
        ).n,
      );
    const before = receipts();
    const input = { name: "TEST keyed write", requestId: "TEST-write-1" };
    const first = await call(client, write.name, input);
    assert.equal(first.value.status, "awaiting_approval");
    assert.equal(first.value.requestId, "TEST-write-1");
    const retry = await call(client, write.name, input);
    assert.equal(retry.value.status, "awaiting_approval");
    assert.equal(retry.value.requestId, "TEST-write-1");
    assert.equal(receipts(), before + 1);

    // The same key for other input is a conflict, never a second call.
    const conflict = await call(client, write.name, {
      name: "TEST other write",
      requestId: "TEST-write-1",
    });
    assert.equal(conflict.isError, true);
    assert.equal(conflict.value.error?.code, "mcp_request_id_conflict");
    assert.equal(receipts(), before + 1);

    // The person approves it once; the retried call reads the same result.
    const receiptId = connectorRequestId(grant.grantId, "TEST-write-1");
    const shown = await h.request(
      "owner",
      "api/identity/mcp/access/connector-call",
      { workspaceId: h.target.workspaceId, requestId: receiptId },
    );
    assert.equal(shown.status, 200, JSON.stringify(shown.data));
    const receipt = h.record(h.record(shown.data).call);
    assert.deepEqual(receipt.input, { name: "TEST keyed write" });
    const dispatched = h.dispatches.length;
    const approved = await h.request("owner", "api/identity/catalog/invoke", {
      organizationId: receipt.organizationId,
      workspaceId: receipt.workspaceId,
      serviceId: receipt.serviceId,
      actionId: receipt.actionId,
      revision: receipt.actionRevision,
      serviceRevision: receipt.serviceRevision,
      input: receipt.input,
      requestId: receipt.requestId,
      approve: true,
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    const status = await call(client, "niaro_call_status", {
      requestId: "TEST-write-1",
    });
    assert.equal(status.value.status, "succeeded");
    const replay = await call(client, write.name, input);
    assert.equal(replay.value.status, "succeeded");
    assert.equal(h.dispatches.length, dispatched + 1);
    assert.equal(receipts(), before + 1);

    // Without a key every call is a new one.
    const unkeyed = await call(client, write.name, { name: "TEST unkeyed" });
    assert.notEqual(unkeyed.value.requestId, "TEST-write-1");
    assert.equal(receipts(), before + 2);
    assert.equal(h.modelCount(), models);
  } finally {
    await client.close();
  }
});

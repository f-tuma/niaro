import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  NativeTestDetailSchema,
  NativeTestToolsSchema,
  NativeTestToolsQuerySchema,
} from "../packages/protocol/process-native-testing";
import { mastraActionToolName } from "../apps/server-identity/mastra-domain";
import {
  processAgentToolName,
  PROCESS_ROOT_AGENT_NODE_ID,
} from "../apps/server-agent/process-agent-tools";
import { nativeScriptedInitialToolNames } from "../apps/server-identity/process-native-tools";
import {
  nativeHttpFixture,
  nativeHttpPath as base,
} from "./helpers/process-native-http";

type Fixture = Awaited<ReturnType<typeof nativeHttpFixture>>;
let ready: Promise<Fixture> | undefined;
async function fixture(run: (h: Fixture) => Promise<void>) {
  ready ??= nativeHttpFixture();
  await run(await ready);
}
after(async () => {
  if (ready) await (await ready).close();
});
function error(
  h: Fixture,
  response: { status: number; data: unknown },
  status: number,
  code: string,
) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  assert.equal(h.record(response.data).error, code);
}

test("native detail HTTP retrieves original suite by request/test IDs after the real isolated runner and two reopens", () =>
  fixture(async (h) => {
    const input = await h.fresh(),
      before = h.production();
    const response = await h.request("owner", base, input);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const job = h.job(response.data);
    for (let i = 0; i < 3; i++) {
      const identifiers: Record<string, string>[] = [
        { requestId: input.requestId },
        { testId: job.testId },
      ];
      for (const identifier of identifiers) {
        const read = await h.request(
          "owner",
          base + "/detail?" + h.query(identifier),
        );
        assert.equal(read.status, 200, JSON.stringify(read.data));
        const detail = NativeTestDetailSchema.parse(read.data);
        assert.deepEqual(detail, { job, request: input });
        assert.deepEqual(Object.keys(h.record(read.data)).sort(), [
          "job",
          "request",
        ]);
        assert(!JSON.stringify(read.data).includes('"environment"'));
        assert(!JSON.stringify(read.data).includes('"catalog"'));
      }
      assert.deepEqual(h.production(), before);
      if (i < 2) await h.restart();
    }
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);
  }));

test("native detail HTTP preserves account-private scope and rejects duplicate/unknown/XOR queries", () =>
  fixture(async (h) => {
    const input = await h.fresh();
    const started = await h.request("owner", base, input);
    assert.equal(started.status, 200, JSON.stringify(started.data));
    const job = h.job(started.data);
    assert.equal((await h.loginOperator()).status, 200);
    const path = base + "/detail?" + h.query({ requestId: input.requestId });
    // Request IDs are creator-private; members may own personal test commands.
    for (const [role, status] of [
      ["admin", 404],
      ["member", 404],
      ["operator", 403],
      ["anonymous", 401],
    ] as const)
      assert.equal((await h.request(role, path)).status, status, role);
    for (const suffix of [
      h.query(),
      h.query({ testId: job.testId, requestId: input.requestId }),
      h.query({ testId: job.testId }) + "&testId=" + job.testId,
      h.query({ requestId: input.requestId }) + "&requestId=" + input.requestId,
      h.query({ testId: job.testId }) + "&userId=TEST-forged",
      h.query({ testId: job.testId }) + "&processId=" + input.processId,
    ])
      error(
        h,
        await h.request("owner", base + "/detail?" + suffix),
        400,
        "identity_invalid_input",
      );
    error(
      h,
      await h.request(
        "owner",
        base + "/detail?" + h.query({ testId: "TEST-absent" }),
      ),
      404,
      "process_test_not_found",
    );
    error(
      h,
      await h.request(
        "owner",
        base + "/detail?" + h.query({ requestId: "TEST-absent" }),
      ),
      404,
      "process_test_not_found",
    );
  }));

test("native tools HTTP projects actual shared names without live credentials, inference, runner jobs or source annotations", () =>
  fixture(async (h) => {
    const input = await h.fresh(),
      before = h.production();
    const beforeJobs = h.identity["db"]
      .prepare("SELECT COUNT(*) AS n FROM agent_process_contract_test")
      .get()!.n;
    const path =
      base +
      "/tools?" +
      h.query({
        processId: input.processId,
        version: input.version,
        genericModelId: input.suite.genericModelId!,
      });
    const catalog = h.identity["catalog"].store,
      credential = catalog.credential;
    catalog.credential = () => {
      throw Error("TEST metadata read live credential");
    };
    try {
      const response = await h.request("owner", path);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      const tools = NativeTestToolsSchema.parse(response.data);
      assert.equal(tools.artifactDigest, input.artifactDigest);
      assert.equal(tools.genericModelId, input.suite.genericModelId);
      assert.deepEqual(tools.configured, [
        {
          nodeId: PROCESS_ROOT_AGENT_NODE_ID,
          modelId: h.modelId,
          tools: [
            {
              name: processAgentToolName(0),
              serviceId: h.serviceId,
              actionId: h.actionId,
            },
          ],
        },
      ]);
      assert.deepEqual(tools.generic, [
        ...nativeScriptedInitialToolNames().map((name) => ({ name })),
        {
          name: mastraActionToolName(h.actionId),
          serviceId: h.serviceId,
          actionId: h.actionId,
        },
      ]);
      for (const hidden of [
        '"catalog"',
        '"environment"',
        '"inputSchema"',
        '"binding"',
        '"instructions"',
        '"auth"',
        "TEST-HTTP-provider-key",
        "models.example.test",
        "services.example.test",
      ])
        assert(!JSON.stringify(response.data).includes(hidden), hidden);
    } finally {
      catalog.credential = credential;
    }
    assert.equal(
      h.identity["db"]
        .prepare("SELECT COUNT(*) AS n FROM agent_process_contract_test")
        .get()!.n,
      beforeJobs,
    );
    assert.deepEqual(h.production(), before);
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);
    for (const [role, status] of [
      ["member", 403],
      ["operator", 403],
      ["anonymous", 401],
    ] as const)
      assert.equal((await h.request(role, path)).status, status, role);
    const baseQuery = {
      ...h.target,
      profile: input.profile,
      processId: input.processId,
      version: String(input.version),
      genericModelId: input.suite.genericModelId!,
    };
    const malformed: Record<string, string>[] = [
      { version: "0" },
      { version: "1.5" },
      { genericModelId: "TEST?" },
      { userId: "TEST-forged" },
      { profile: "agent-process-tests/1" },
    ];
    for (const extra of malformed) {
      assert.equal(
        NativeTestToolsQuerySchema.safeParse({ ...baseQuery, ...extra })
          .success,
        false,
      );
      error(
        h,
        await h.request(
          "owner",
          base + "/tools?" + new URLSearchParams({ ...baseQuery, ...extra }),
        ),
        400,
        "identity_invalid_input",
      );
    }
    error(
      h,
      await h.request("owner", path + "&version=" + input.version),
      400,
      "identity_invalid_input",
    );
    h.identity["db"]
      .prepare("UPDATE agent_catalog SET revision=revision+1 WHERE id=?")
      .run(h.actionId);
    error(h, await h.request("owner", path), 409, "process_sources_changed");
    assert.deepEqual(h.production(), before);
  }));

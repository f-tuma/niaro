import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { IncomingMessage } from "node:http";
import { ProcessRecordSchema } from "../packages/protocol/service-processes";
import {
  PROCESS_VERSION_PROFILE,
  ProcessFreezeCommandSchema,
  ProcessFreezeReceiptSchema,
  ProcessVersionListSchema,
} from "../packages/protocol/process-versions";
import { designHttpFixture } from "./helpers/process-design-http";

const base = "api/identity/catalog/processes/versions",
  freeze = base + "/freeze";
type Fixture = Awaited<ReturnType<typeof build>>;
let ready: Promise<Fixture> | undefined;
async function fixture(run: (h: Fixture) => Promise<void>) {
  ready ??= build();
  await run(await ready);
}
after(async () => {
  if (ready) await (await ready).close();
});
async function build() {
  const h = await designHttpFixture(freeze);
  let sequence = 0;
  const query = (input: Record<string, string | number> = {}) =>
    new URLSearchParams({
      ...h.target,
      profile: PROCESS_VERSION_PROFILE,
      ...Object.fromEntries(
        Object.entries(input).map(([key, value]) => [key, String(value)]),
      ),
    }).toString();
  const process = async (id: string) => {
    const response = await h.request(
      "owner",
      "api/identity/catalog/processes?" +
        new URLSearchParams({ ...h.target, id }),
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return ProcessRecordSchema.parse(h.record(response.data).process);
  };
  const fresh = async () => {
    const response = await h.request(
      "owner",
      "api/identity/catalog/processes/command",
      {
        ...h.target,
        type: "saveDraft",
        revision: 0,
        serviceId: h.serviceId,
        definition: { ...h.workflow(), name: "TEST freeze HTTP " + ++sequence },
      },
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const draft = ProcessRecordSchema.parse(h.record(response.data).process);
    const command = ProcessFreezeCommandSchema.parse({
      ...h.target,
      profile: PROCESS_VERSION_PROFILE,
      requestId: "TEST-HTTP-freeze-" + sequence,
      processId: draft.id,
      revision: draft.revision,
    });
    return { draft, command };
  };
  const receipt = (data: unknown) =>
    ProcessFreezeReceiptSchema.parse(h.record(data).receipt);
  const counts = (id: string) =>
    Object.fromEntries(
      [
        [
          "versions",
          "SELECT COUNT(*) AS n FROM agent_service_process_version WHERE process_id=?",
        ],
        [
          "receipts",
          "SELECT COUNT(*) AS n FROM agent_process_freeze_command WHERE process_id=?",
        ],
        [
          "audits",
          "SELECT COUNT(*) AS n FROM agent_audit WHERE target_id=? AND json_extract(details,'$.processEvent')='version_frozen'",
        ],
      ].map(([name, sql]) => [name, h.identity["db"].prepare(sql!).get(id)!.n]),
    );
  return {
    ...h,
    query,
    process,
    fresh,
    receipt,
    counts,
    get identity() {
      return h.identity;
    },
  };
}
function error(
  h: Fixture,
  response: { status: number; data: unknown },
  status: number,
  code: string,
) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  assert.equal(h.record(response.data).error, code);
}

test("freeze HTTP returns one durable receipt through reads, exact replay and two reopens without live effects", () =>
  fixture(async (h) => {
    const { command } = await h.fresh();
    const response = await h.request("owner", freeze, command);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const receipt = h.receipt(response.data),
      original = await h.process(command.processId);
    for (let i = 0; i < 3; i++) {
      const read = await h.request(
        "owner",
        freeze + "?" + h.query({ requestId: command.requestId }),
      );
      assert.equal(read.status, 200, JSON.stringify(read.data));
      assert.deepEqual(h.receipt(read.data), receipt);
      const replay = await h.request("owner", freeze, command);
      assert.equal(replay.status, 200, JSON.stringify(replay.data));
      assert.deepEqual(h.receipt(replay.data), receipt);
      const list = await h.request(
        "owner",
        base + "?" + h.query({ processId: command.processId, limit: 1 }),
      );
      assert.equal(list.status, 200, JSON.stringify(list.data));
      const history = ProcessVersionListSchema.parse(list.data);
      assert.equal(history.versions[0]!.digest, receipt.artifactDigest);
      assert.equal(history.nextBefore, null);
      assert.deepEqual(await h.process(command.processId), original);
      assert.deepEqual(h.counts(command.processId), {
        versions: 1,
        receipts: 1,
        audits: 1,
      });
      if (i < 2) await h.restart();
    }
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);
  }));

test("freeze/history HTTP enforces human account roles, private receipts and strict command/query shape", () =>
  fixture(async (h) => {
    const { command } = await h.fresh();
    assert.equal((await h.loginOperator()).status, 200);
    for (const [role, status] of [
      ["member", 403],
      ["operator", 403],
      ["anonymous", 401],
    ] as const) {
      assert.equal(
        (await h.request(role, freeze, command)).status,
        status,
        role,
      );
      assert.equal(
        (
          await h.request(
            role,
            base + "?" + h.query({ processId: command.processId }),
          )
        ).status,
        status,
        role,
      );
    }
    assert.equal((await h.request("owner", freeze, command)).status, 200);
    const receiptPath =
      freeze + "?" + h.query({ requestId: command.requestId });
    error(
      h,
      await h.request("admin", receiptPath),
      404,
      "process_freeze_not_found",
    );
    const adminCommand = {
      ...command,
      requestId: "TEST-admin-freeze",
      revision: (await h.process(command.processId)).revision,
    };
    const saved = await h.request("admin", freeze, adminCommand);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    error(
      h,
      await h.request(
        "owner",
        freeze + "?" + h.query({ requestId: adminCommand.requestId }),
      ),
      404,
      "process_freeze_not_found",
    );
    error(
      h,
      await h.request("owner", freeze, {
        ...command,
        revision: command.revision + 1,
      }),
      409,
      "process_freeze_conflict",
    );
    for (const path of [
      receiptPath + "&requestId=" + command.requestId,
      receiptPath + "&userId=TEST-forged",
      base + "?" + h.query({ processId: command.processId }) + "&limit=21",
      base + "?" + h.query({ processId: command.processId }) + "&before=0",
      base + "?" + h.query({ processId: command.processId }) + "&before=1.5",
      base +
        "?" +
        h.query({ processId: command.processId }) +
        "&limit=1&limit=1",
      base + "?" + h.query({ processId: command.processId }) + "&version=1",
    ])
      error(h, await h.request("owner", path), 400, "identity_invalid_input");
    error(
      h,
      await h.request("owner", freeze + "?extra=1", command),
      400,
      "identity_invalid_input",
    );
    error(
      h,
      await h.request("owner", freeze, { ...command, userId: "TEST-forged" }),
      400,
      "identity_invalid_input",
    );
    error(
      h,
      await h.request("owner", freeze, command, {
        headers: { "Content-Type": "text/plain" },
      }),
      403,
      "admin_origin_denied",
    );
  }));

test("freeze HTTP request/session revocation and body-end disconnect cannot write metadata", () =>
  fixture(async (h) => {
    const { command, draft } = await h.fresh();
    for (const change of ["fingerprint", "session"] as const) {
      const identity = h.identity,
        getSession = identity["getSession"];
      let calls = 0;
      identity["getSession"] = async function (req: IncomingMessage) {
        calls++;
        if (change === "session" && calls === 2)
          await identity["auth"].api.signOut({
            headers: identity["headers"](req),
          });
        const session = await getSession.call(identity, req);
        if (change === "fingerprint" && calls === 1)
          h.mutateTurnHeader("origin", "https://hostile.example.test");
        return session;
      };
      try {
        error(
          h,
          await h.request("owner", freeze, {
            ...command,
            requestId: "TEST-revoked-freeze-" + change,
          }),
          change === "session" ? 401 : 403,
          change === "session" ? "identity_unauthorized" : "identity_forbidden",
        );
      } finally {
        identity["getSession"] = getSession;
      }
      if (change === "session")
        assert.equal(
          (
            await h.request("owner", "auth/sign-in/email", {
              email: "owner@example.test",
              password: "TEST-design-HTTP-password-only-2026",
            })
          ).status,
          200,
        );
      assert.deepEqual(await h.process(command.processId), draft);
      assert.deepEqual(h.counts(command.processId), {
        versions: 0,
        receipts: 0,
        audits: 0,
      });
    }
    h.disconnectNextTurnAtBodyEnd();
    await assert.rejects(h.request("owner", freeze, command));
    await delay(20);
    assert.deepEqual(await h.process(command.processId), draft);
    assert.deepEqual(h.counts(command.processId), {
      versions: 0,
      receipts: 0,
      audits: 0,
    });
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);
  }));

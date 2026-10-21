import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { IncomingMessage } from "node:http";
import { ActionSettings } from "../packages/protocol/service-catalog";
import { ProcessVersionSchema } from "../packages/protocol/service-processes";
import { NativeTestRequestSchema } from "../packages/protocol/process-native-testing";
import { nativeHttpPath } from "./helpers/process-native-http";
import {
  activationHttpFixture,
  activationHttpPath as base,
} from "./helpers/process-activation-http";

type Fixture = Awaited<ReturnType<typeof activationHttpFixture>>;
let fixtureReady: Promise<Fixture> | undefined;
async function fixture(run: (h: Fixture) => Promise<void>) {
  // Retain the real BetterAuth per-IP limiter without repeated bootstrap/logins.
  fixtureReady ??= activationHttpFixture();
  await run(await fixtureReady);
}
after(async () => {
  if (fixtureReady) await (await fixtureReady).close();
});
const error = (
  h: Fixture,
  response: { status: number; data: unknown },
  status: number,
  code: string,
) => {
  assert.equal(response.status, status, JSON.stringify(response.data));
  assert.equal(h.record(response.data).error, code);
};
async function readReview(
  h: Fixture,
  input: Awaited<ReturnType<Fixture["fresh"]>>,
  testId: string,
) {
  const response = await h.request(
    "owner",
    base +
      "/review?" +
      h.query({
        processId: input.processId,
        version: input.version,
        testId,
      }),
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return h.review(response.data);
}
async function version(h: Fixture, processId: string, selected: number) {
  const response = await h.request(
    "owner",
    "api/identity/catalog/processes?" +
      new URLSearchParams({
        ...h.target,
        id: processId,
        version: String(selected),
      }).toString(),
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return ProcessVersionSchema.parse(h.record(response.data).version);
}
function decisions(h: Fixture, processId: string) {
  return h.identity["db"]
    .prepare(
      "SELECT COUNT(*) AS n FROM agent_process_activation_command WHERE process_id=?",
    )
    .get(processId)!.n;
}

test("activation HTTP consumes actual six-scenario native qualification and preserves one private receipt across two reopens", () =>
  fixture(async (h) => {
    const input = await h.fresh(),
      before = h.production();
    const original = await h.process(input.processId);
    const result = await h.runNative(input);
    assert.equal(
      result.qualification?.status,
      "qualified",
      JSON.stringify(result),
    );
    assert.equal(result.qualification.liveAcceptance, false);
    assert.equal(result.report?.observations.length, 12);
    assert.equal(result.report?.comparison.cases, 6);
    assert.equal(result.report?.comparison.configuredPassed, 6);
    assert.equal(result.report?.comparison.genericPassed, 6);
    assert(
      result.report?.observations
        .filter((item) => item.scenario === "restart")
        .every((item) => item.reopened),
    );
    assert.deepEqual(await h.process(input.processId), original);
    assert.equal(
      (await version(h, input.processId, input.version)).testStatus,
      "untested",
    );
    const review = await readReview(h, input, result.testId);
    assert.equal(review.canActivate, true);
    assert.equal(review.canRollback, false);
    assert.equal(review.activeVersion, null);
    assert.equal(
      review.qualification.qualificationDigest,
      result.qualification.qualificationDigest,
    );
    assert.deepEqual(h.production(), before);
    const command = h.command(input, result),
      response = await h.request("owner", base, command);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const receipt = h.receipt(response.data);
    assert.equal(receipt.activeVersion, input.version);
    assert(receipt.resultingRevision > input.revision);
    assert.equal(receipt.qualification.liveAcceptance, false);
    const activated = await h.process(input.processId);
    assert.equal(activated.activeVersion, input.version);
    assert.equal(activated.revision, receipt.resultingRevision);
    assert.equal(
      (await version(h, input.processId, input.version)).testStatus,
      "passed",
    );
    const audits = () =>
      h.identity["db"]
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_audit WHERE target_id=? AND json_extract(details,'$.processEvent')='native_version_activated'",
        )
        .get(input.processId)!.n;
    for (let reopen = 0; reopen < 3; reopen++) {
      const stored = await h.request(
        "owner",
        base + "?" + h.query({ requestId: command.requestId }),
      );
      assert.equal(stored.status, 200, JSON.stringify(stored.data));
      assert.deepEqual(h.receipt(stored.data), receipt);
      const replay = await h.request("owner", base, command);
      assert.equal(replay.status, 200, JSON.stringify(replay.data));
      assert.deepEqual(h.receipt(replay.data), receipt);
      assert.deepEqual(await h.process(input.processId), activated);
      assert.equal(decisions(h, input.processId), 1);
      assert.equal(audits(), 1);
      assert.deepEqual(h.production(), {
        ...before,
        agent_service_process_test:
          Number(before.agent_service_process_test) + 1,
      });
      if (reopen < 2) await h.restart();
    }
    error(
      h,
      await h.request("owner", base, { ...command, type: "rollback" }),
      409,
      "process_activation_conflict",
    );
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);
  }));

test("activation HTTP refuses an actually passing read subset with missing qualification families", () =>
  fixture(async (h) => {
    const input = await h.fresh(),
      before = h.production();
    input.suite.cases = [input.suite.cases[0]!];
    const result = await h.runNative(input);
    assert.equal(result.qualification?.status, "failed");
    assert(result.qualification?.reasons.includes("missing_scenario"));
    const command = h.command(input, result);
    error(
      h,
      await h.request("owner", base, command),
      409,
      "process_qualification_required",
    );
    error(
      h,
      await h.request(
        "owner",
        base +
          "/review?" +
          h.query({
            processId: input.processId,
            version: input.version,
            testId: result.testId,
          }),
      ),
      409,
      "process_qualification_required",
    );
    assert.equal((await h.process(input.processId)).activeVersion, null);
    assert.equal(
      (await version(h, input.processId, input.version)).testStatus,
      "untested",
    );
    assert.equal(decisions(h, input.processId), 0);
    assert.deepEqual(h.production(), before);
  }));

test("activation HTTP binds evidence and receipts to the creator while allowing an admin's own qualified decision", () =>
  fixture(async (h) => {
    const input = await h.fresh(),
      before = h.production(),
      result = await h.runNative(input);
    const command = h.command(input, result);
    assert.equal((await h.loginOperator()).status, 200);
    const reviewPath =
      base +
      "/review?" +
      h.query({
        processId: input.processId,
        version: input.version,
        testId: result.testId,
      });
    // Test evidence is creator-private (404 for anyone else, members included,
    // since members can now own personal tests); a member still cannot decide
    // on a workspace process (403 from the registry).
    for (const [role, review, decide] of [
      ["admin", 404, 404],
      ["member", 404, 403],
      ["operator", 403, 403],
      ["anonymous", 401, 401],
    ] as const) {
      assert.equal((await h.request(role, reviewPath)).status, review, role);
      assert.equal((await h.request(role, base, command)).status, decide, role);
    }
    const adminInput = NativeTestRequestSchema.parse({
      ...input,
      requestId: "TEST-admin-native-private",
    });
    const adminResult = await h.runNative(adminInput, "admin");
    assert.equal(adminResult.qualification?.status, "qualified");
    const adminCommand = h.command(
      adminInput,
      adminResult,
      "TEST-admin-activation-private",
    );
    const saved = await h.request("admin", base, adminCommand);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const receipt = h.receipt(saved.data);
    const receiptPath =
      base + "?" + h.query({ requestId: adminCommand.requestId });
    assert.deepEqual(
      h.receipt((await h.request("admin", receiptPath)).data),
      receipt,
    );
    // Members can hold their own receipts (personal processes), so another
    // person's request ID is simply not theirs, exactly as for the owner.
    for (const [role, status] of [
      ["owner", 404],
      ["member", 404],
      ["operator", 403],
      ["anonymous", 401],
    ] as const)
      assert.equal((await h.request(role, receiptPath)).status, status, role);
    assert.equal(decisions(h, input.processId), 1);
    assert.deepEqual(h.production(), {
      ...before,
      agent_service_process_test: Number(before.agent_service_process_test) + 1,
    });
  }));

test("activation HTTP rejects forged fields, acknowledgement, scope, profile, duplicate queries and hostile headers", () =>
  fixture(async (h) => {
    const input = await h.fresh(),
      result = await h.runNative(input),
      command = h.command(input, result);
    for (const patch of [
      { extra: true },
      { actor: { userId: "TEST-forged-owner", role: "owner" } },
      { report: result.report },
      { qualification: result.qualification },
      { acknowledgement: "live_accepted" },
      { acknowledgement: undefined },
      { profile: "agent-process-native-tests/1" },
    ])
      error(
        h,
        await h.request("owner", base, { ...command, ...patch }),
        400,
        "identity_invalid_input",
      );
    for (const patch of [
      { organizationId: "TEST-foreign-org" },
      { workspaceId: "TEST-foreign-workspace" },
    ])
      assert(
        [403, 404].includes(
          (await h.request("owner", base, { ...command, ...patch })).status,
        ),
      );
    const reviewPath =
      base +
      "/review?" +
      h.query({
        processId: input.processId,
        version: input.version,
        testId: result.testId,
      });
    const receiptPath = base + "?" + h.query({ requestId: command.requestId });
    for (const extra of [
      "&extra=1",
      "&__proto__=x",
      "&profile=agent-process-activation%2F1",
    ])
      for (const path of [reviewPath, receiptPath])
        error(
          h,
          await h.request("owner", path + extra),
          400,
          "identity_invalid_input",
        );
    error(
      h,
      await h.request("owner", reviewPath + "&testId=TEST-duplicate"),
      400,
      "identity_invalid_input",
    );
    error(
      h,
      await h.request("owner", receiptPath + "&requestId=TEST-duplicate"),
      400,
      "identity_invalid_input",
    );
    error(
      h,
      await h.request("owner", base + "?extra=1", command),
      400,
      "identity_invalid_input",
    );
    for (const headers of [
      { Origin: "https://hostile.example.test" },
      { Host: "hostile.example.test" },
      { "Sec-Fetch-Site": "cross-site" },
    ] as Record<string, string>[])
      assert.equal(
        (await h.request("owner", reviewPath, undefined, { headers })).status,
        403,
      );
    assert.equal(
      (
        await h.request("owner", base, command, {
          headers: { "Content-Type": "text/plain" },
        })
      ).status,
      403,
    );
    error(
      h,
      await h.request("owner", base, undefined, { raw: "{invalid" }),
      400,
      "identity_invalid_input",
    );
    assert.equal((await h.process(input.processId)).activeVersion, null);
    assert.equal(decisions(h, input.processId), 0);
  }));

test("activation HTTP checks revision, active-version CAS and both server-owned digests without writing metadata", () =>
  fixture(async (h) => {
    const input = await h.fresh(),
      result = await h.runNative(input),
      command = h.command(input, result);
    const original = await h.process(input.processId),
      before = h.production();
    for (const [patch, expected] of [
      [{ revision: command.revision + 1 }, "process_conflict"],
      [{ expectedActiveVersion: 1 }, "process_conflict"],
      [{ artifactDigest: "0".repeat(64) }, "process_activation_conflict"],
      [
        { qualificationDigest: "0".repeat(64) },
        "process_qualification_required",
      ],
    ] as const)
      error(
        h,
        await h.request("owner", base, { ...command, ...patch }),
        409,
        expected,
      );
    assert.deepEqual(await h.process(input.processId), original);
    assert.equal(
      (await version(h, input.processId, input.version)).testStatus,
      "untested",
    );
    assert.equal(decisions(h, input.processId), 0);
    assert.deepEqual(h.production(), before);
  }));

test("activation HTTP rejects fresh decisions after source or policy drift while historical replay cannot reactivate an older version", () =>
  fixture(async (h) => {
    const first = await h.fresh(),
      firstResult = await h.runNative(first);
    const firstCommand = h.command(
      first,
      firstResult,
      "TEST-replay-old-activation",
    );
    const firstSaved = await h.request("owner", base, firstCommand);
    assert.equal(firstSaved.status, 200, JSON.stringify(firstSaved.data));
    const firstReceipt = h.receipt(firstSaved.data);
    const second = await h.fresh(first.processId),
      secondResult = await h.runNative(second);
    const current = await h.process(first.processId);
    const secondCommand = {
      ...h.command(second, secondResult),
      expectedActiveVersion: current.activeVersion,
    };
    const secondSaved = await h.request("owner", base, secondCommand);
    assert.equal(secondSaved.status, 200, JSON.stringify(secondSaved.data));
    const secondReceipt = h.receipt(secondSaved.data),
      active = await h.process(first.processId),
      before = h.production();
    assert.equal(active.activeVersion, 2);
    const activeInput = NativeTestRequestSchema.parse({
      ...second,
      requestId: "TEST-explicit-active-retest",
      revision: active.revision,
    });
    error(
      h,
      await h.request("owner", nativeHttpPath, activeInput),
      409,
      "process_test_active_version",
    );
    let retested = await h.runNative(
      NativeTestRequestSchema.parse({ ...activeInput, retestActive: true }),
    );
    assert.equal(retested.qualification?.status, "qualified");
    assert.equal(
      (await readReview(h, second, retested.testId)).canRollback,
      true,
    );
    assert.equal(
      (
        await h.request(
          "owner",
          base +
            "/review?" +
            h.query({
              processId: second.processId,
              version: second.version,
              testId: secondResult.testId,
            }),
        )
      ).status,
      409,
    );
    assert.deepEqual(await h.process(first.processId), active);
    assert.deepEqual(h.production(), before);
    for (const change of ["policy", "source"] as const) {
      if (change === "source") {
        // Refresh through the actual native runner after the epoch change, so
        // this refusal proves source drift independently of it.
        retested = await h.runNative(
          NativeTestRequestSchema.parse({
            ...activeInput,
            requestId: "TEST-retest-current-policy",
            retestActive: true,
          }),
        );
        assert.equal(retested.qualification?.status, "qualified");
        await readReview(h, second, retested.testId);
        const service = h.identity["catalog"].store.service(
          h.target.workspaceId,
          h.serviceId,
        );
        const action = service.actions.find((item) => item.id === h.actionId)!;
        const {
          id: _id,
          revision: _revision,
          sourceKey: _key,
          ...settings
        } = action;
        await h.catalog({
          type: "saveAction",
          id: action.id,
          serviceId: h.serviceId,
          serviceRevision: service.revision,
          revision: action.revision,
          settings: ActionSettings.parse({
            ...settings,
            description: "TEST post-qualification source drift",
          }),
        });
      } else {
        // The organization-wide epoch also moves for unrelated people and
        // services; on its own it no longer stales a process qualification.
        h.identity["connections"].changePolicy(h.target.organizationId);
        assert.equal(
          (
            await h.request(
              "owner",
              base +
                "/review?" +
                h.query({
                  processId: second.processId,
                  version: second.version,
                  testId: retested.testId,
                }),
            )
          ).status,
          200,
        );
        continue;
      }
      const freshDecision: ReturnType<Fixture["command"]> = {
        ...secondCommand,
        requestId: "TEST-drift-refused-" + change,
        revision: active.revision,
        expectedActiveVersion: active.activeVersion,
        testId: retested.testId,
        qualificationDigest: retested.qualification!.qualificationDigest,
      };
      assert.equal((await h.request("owner", base, freshDecision)).status, 409);
      assert.equal(
        (
          await h.request(
            "owner",
            base +
              "/review?" +
              h.query({
                processId: second.processId,
                version: second.version,
                testId: retested.testId,
              }),
          )
        ).status,
        409,
      );
      for (const [command, receipt] of [
        [firstCommand, firstReceipt],
        [secondCommand, secondReceipt],
      ] as const) {
        const replay = await h.request("owner", base, command);
        assert.equal(replay.status, 200, JSON.stringify(replay.data));
        assert.deepEqual(h.receipt(replay.data), receipt);
        const stored = await h.request(
          "owner",
          base + "?" + h.query({ requestId: command.requestId }),
        );
        assert.equal(stored.status, 200, JSON.stringify(stored.data));
        assert.deepEqual(h.receipt(stored.data), receipt);
      }
      assert.deepEqual(await h.process(first.processId), active);
      assert.equal(decisions(h, first.processId), 2);
      assert.deepEqual(h.production(), before);
    }
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);
  }));

test("activation HTTP revalidates its genuine account session and request fingerprint before the metadata transaction", () =>
  fixture(async (h) => {
    const input = await h.fresh(),
      result = await h.runNative(input),
      command = h.command(input, result);
    const original = await h.process(input.processId);
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
        const rejected = await h.request("owner", base, {
          ...command,
          requestId: "TEST-revoked-" + change,
        });
        error(
          h,
          rejected,
          change === "session" ? 401 : 403,
          change === "session" ? "identity_unauthorized" : "identity_forbidden",
        );
      } finally {
        identity["getSession"] = getSession;
      }
      if (change === "session") {
        assert.equal(
          (
            await h.request(
              "owner",
              base + "?" + h.query({ requestId: command.requestId }),
            )
          ).status,
          401,
        );
        assert.equal(
          (
            await h.request("owner", "auth/sign-in/email", {
              email: "owner@example.test",
              password: "TEST-design-HTTP-password-only-2026",
            })
          ).status,
          200,
        );
      }
      assert.deepEqual(await h.process(input.processId), original);
      assert.equal(decisions(h, input.processId), 0);
    }
  }));

test("activation HTTP disconnect at body end never writes activation metadata", () =>
  fixture(async (h) => {
    const input = await h.fresh(),
      result = await h.runNative(input),
      command = h.command(input, result);
    const original = await h.process(input.processId),
      before = h.production();
    h.disconnectNextTurnAtBodyEnd();
    await assert.rejects(h.request("owner", base, command));
    await delay(20);
    assert.deepEqual(await h.process(input.processId), original);
    assert.equal(decisions(h, input.processId), 0);
    assert.deepEqual(h.production(), before);
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);
  }));

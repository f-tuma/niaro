import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createFixtureServer } from "../apps/fixture-server/http";
import { issuePairingCode } from "../apps/fixture-server/auth";
import {
  ModelError,
  type Decision,
  type ModelInput,
} from "../apps/fixture-server/decision";
import {
  AUTH_PROFILE,
  PROFILE,
  CredentialSchema,
  CommandResultSchema,
  SnapshotSchema,
} from "../packages/protocol";
import { messageCommand } from "../packages/client-core/commands";
import {
  ACTIVITY_PROFILE,
  TOOL_ACTIVITY_PROFILE,
  LEGACY_ACTIVITY_PROFILE,
  ActivityResponseSchema,
} from "../packages/protocol/activity";
import { ModelService } from "../apps/fixture-server/model-service";
import { workflowActivity, pluginActivity } from "../packages/test-fixtures";

const reply: Decision = {
  kind: "reply",
  contactId: null,
  localStart: null,
  title: null,
  durationMinutes: null,
  reply: "Kdy má schůzka proběhnout?",
};
test("HTTP model calls require auth, recheck expiry after inference, return safe failures and replay without another call", async () => {
  const directory = mkdtempSync(join(tmpdir(), "model-http-"));
  let now = Date.now();
  const decide = jest.fn<Promise<Decision>, [ModelInput, AbortSignal]>(
    async () => reply,
  );
  const server = createFixtureServer(directory, undefined, {
    now: () => now,
    sessionTtlMs: 30000,
    model: { timeZone: "Europe/Prague", decide },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, value?: unknown, token?: string) =>
    new Promise<{ status: number; value: unknown }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/v1/a/${path}`,
          method: value === undefined ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode!, value: JSON.parse(text) }),
          );
        },
      );
      req.on("error", reject);
      req.end(value === undefined ? undefined : JSON.stringify(value));
    });
  try {
    const command = messageCommand("Připrav mi schůzku.", "cs", "one");
    expect((await call("commands", command)).status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
    const credential = CredentialSchema.parse(
      (
        await call("auth/pair", {
          authProfile: AUTH_PROFILE,
          profile: PROFILE,
          code: issuePairingCode(directory, "alice", "a", now),
        })
      ).value,
    );
    const first = await call("commands", command, credential.accessToken);
    expect(first.status).toBe(202);
    expect((await call("activity?commandId=one")).status).toBe(401);
    expect(
      ActivityResponseSchema.parse(
        (
          await call(
            "activity?commandId=one",
            undefined,
            credential.accessToken,
          )
        ).value,
      ).activity?.status,
    ).toBe("succeeded");
    const activity = {
      ...workflowActivity({ step: 2, stage: "execute" }),
      commandId: command.commandId,
      tools: pluginActivity("succeeded").tools,
    };
    const activityRead = jest.spyOn(ModelService.prototype, "activity");
    try {
      for (const profile of [
        ACTIVITY_PROFILE,
        TOOL_ACTIVITY_PROFILE,
        LEGACY_ACTIVITY_PROFILE,
      ]) {
        activityRead.mockReturnValueOnce(activity);
        const progress = ActivityResponseSchema.parse(
          (
            await call(
              `activity?commandId=one&profile=${encodeURIComponent(profile)}`,
              undefined,
              credential.accessToken,
            )
          ).value,
        );
        expect(progress.profile).toBe(profile);
        expect(progress.activity).toHaveProperty("commandId", "one");
        if (profile === ACTIVITY_PROFILE)
          expect(progress.activity).toHaveProperty(
            "workflow",
            activity.workflow,
          );
        else expect(progress.activity).not.toHaveProperty("workflow");
        if (profile !== LEGACY_ACTIVITY_PROFILE)
          expect(progress.activity).toHaveProperty("tools", activity.tools);
        else expect(progress.activity).not.toHaveProperty("tools");
      }
    } finally {
      activityRead.mockRestore();
    }
    expect(
      (
        await call(
          "activity?commandId=%2Fbad",
          undefined,
          credential.accessToken,
        )
      ).status,
    ).toBe(400);
    const other = CredentialSchema.parse(
      (
        await call("auth/pair", {
          authProfile: AUTH_PROFILE,
          profile: PROFILE,
          code: issuePairingCode(directory, "bob", "a", now),
        })
      ).value,
    );
    expect(
      ActivityResponseSchema.parse(
        (await call("activity?commandId=one", undefined, other.accessToken))
          .value,
      ).activity,
    ).toBeNull();
    expect(
      CommandResultSchema.parse(first.value).snapshot.conversations[0]!
        .messages[1]!.text,
    ).toBe(reply.reply);
    await call("commands", command, credential.accessToken);
    expect(decide).toHaveBeenCalledTimes(1);
    const before = SnapshotSchema.parse(
      (await call("snapshot", undefined, credential.accessToken)).value,
    );
    decide.mockRejectedValueOnce(new ModelError("model_invalid_response"));
    expect(
      await call(
        "commands",
        messageCommand("again", "en", "bad"),
        credential.accessToken,
      ),
    ).toEqual({ status: 503, value: { error: "model_invalid_response" } });
    expect(
      SnapshotSchema.parse(
        (await call("snapshot", undefined, credential.accessToken)).value,
      ),
    ).toEqual(before);
    decide.mockImplementationOnce(async () => {
      now += 30001;
      return reply;
    });
    expect(
      (
        await call(
          "commands",
          messageCommand("again", "en", "expired"),
          credential.accessToken,
        )
      ).status,
    ).toBe(401);
    const fresh = CredentialSchema.parse(
      (
        await call("auth/pair", {
          authProfile: AUTH_PROFILE,
          profile: PROFILE,
          code: issuePairingCode(directory, "alice", "a", now),
        })
      ).value,
    );
    expect(
      SnapshotSchema.parse(
        (await call("snapshot", undefined, fresh.accessToken)).value,
      ),
    ).toEqual(before);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
});

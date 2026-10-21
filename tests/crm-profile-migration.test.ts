import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureAuth, issuePairingCode } from "../apps/fixture-server/auth";
import { FixtureEngine } from "../apps/fixture-server/engine";
import {
  PROFILE,
  CredentialSchema,
  SnapshotSchema,
} from "../packages/protocol";
import { migrateStoredWorkflowProfile } from "../packages/client-core/migrate";
import { credential } from "./auth-fixtures";
import {
  answerCommand,
  messageCommand,
} from "../packages/client-core/commands";

test.each([
  "agent-client/0.3-fixture",
  "agent-client/0.4-fixture",
  "agent-client/0.5-fixture",
  "agent-client/0.6-fixture",
  "agent-client/0.7-fixture",
])(
  "profile %s work, pending jobs and receipts migrate without inventing data",
  (previousProfile) => {
    const original = new FixtureEngine();
    const command = messageCommand("Choose Peter", "en", "before-upgrade");
    original.execute(command);
    original.execute(
      answerCommand(
        original.snapshot().inputRequests[0]!,
        "peter-novak",
        "before-upgrade-answer",
      ),
    );
    expect(original.data.pending).toHaveLength(1);
    const data = structuredClone(original.data);
    Object.assign(data.snapshot, { profile: previousProfile });
    const reopened = new FixtureEngine("a", data);
    expect(reopened.snapshot()).toEqual(original.snapshot());
    expect(reopened.snapshot().profile).toBe(PROFILE);
    expect(reopened.replay(command)?.status).toBe("accepted");
    expect(reopened.data.pending).toEqual(original.data.pending);
    expect(
      reopened.snapshot().conversations[0]!.messages.every((m) => !m.result),
    ).toBe(true);
  },
);

test.each([
  "agent-client/0.3-fixture",
  "agent-client/0.4-fixture",
  "agent-client/0.5-fixture",
  "agent-client/0.6-fixture",
  "agent-client/0.7-fixture",
])(
  "profile %s preserves the identity, permissions and expiry of stored server sessions",
  (previousProfile) => {
    const dir = mkdtempSync(join(tmpdir(), "crm-profile-"));
    try {
      const auth = new FixtureAuth(dir);
      const original = auth.pair(issuePairingCode(dir, "test-user", "a"), "a");
      const file = join(dir, "auth", "sessions.json");
      const sessions = JSON.parse(readFileSync(file, "utf8"));
      for (const s of Object.values(sessions) as Record<string, unknown>[])
        s.profile = previousProfile;
      writeFileSync(file, JSON.stringify(sessions), { mode: 0o600 });
      const restored = new FixtureAuth(dir).authenticate(
        `Bearer ${original.accessToken}`,
        "a",
      );
      const { accessToken: _token, ...identity } = original;
      expect(restored).toEqual(identity);
      expect(restored.profile).toBe(PROFILE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("0.5 service results retain their original data without inventing presentation", () => {
  const original = new FixtureEngine();
  original.execute(messageCommand("Choose Peter", "en", "legacy-service"));
  const conversation = original.data.snapshot.conversations[0]!;
  conversation.messages.push({
    id: "legacy-service-result",
    role: "assistant",
    text: "TEST action completed",
    result: {
      type: "service.action",
      version: 1,
      operationId: "legacy-operation",
      title: "TEST action",
      service: "TEST service",
      status: "succeeded",
      effect: "read",
      fields: [{ label: "TEST field", value: "TEST value" }],
      inputJson: "{}",
      reviewTruncated: false,
      summary: "TEST action completed",
    },
  });
  const data = structuredClone(original.data);
  Object.assign(data.snapshot, { profile: "agent-client/0.5-fixture" });
  const reopened = new FixtureEngine("a", data);
  expect(reopened.data).toEqual(original.data);
  expect(
    reopened.snapshot().conversations[0]!.messages.at(-1)!.result,
  ).not.toHaveProperty("presentation");
});

test("unknown stored workflow profiles are rejected instead of silently upgraded", () => {
  const data = structuredClone(new FixtureEngine().data);
  Object.assign(data.snapshot, { profile: "agent-client/99-fixture" });
  expect(() => new FixtureEngine("a", data)).toThrow();
});

test("0.7 device cache and credentials upgrade locally while preserving scope, history and secrets", () => {
  const engine = new FixtureEngine();
  engine.execute(messageCommand("Choose Peter", "en", "cached-before-upgrade"));
  const snapshot = engine.snapshot();
  const originalCredential = credential();
  const oldSnapshot = { ...snapshot, profile: "agent-client/0.7-fixture" };
  const oldCredential = {
    ...originalCredential,
    profile: "agent-client/0.7-fixture",
  };
  expect(
    SnapshotSchema.parse(migrateStoredWorkflowProfile(oldSnapshot)),
  ).toEqual(snapshot);
  expect(
    CredentialSchema.parse(migrateStoredWorkflowProfile(oldCredential)),
  ).toEqual(originalCredential);
  expect(oldSnapshot.profile).toBe("agent-client/0.7-fixture");
  expect(oldCredential.profile).toBe("agent-client/0.7-fixture");
  expect(() =>
    CredentialSchema.parse(
      migrateStoredWorkflowProfile({
        ...originalCredential,
        profile: "agent-client/99-fixture",
      }),
    ),
  ).toThrow();
});

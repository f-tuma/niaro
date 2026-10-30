import { DatabaseSync } from "node:sqlite";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import { IdentityName } from "../packages/protocol/identity";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { MemoryStore } from "../apps/server-identity/memory";
import { ProfileCursorStore } from "../apps/server-identity/profile-cursor";
import { ProfileInference } from "../apps/server-identity/profile-inference";
import {
  ProfileLearner,
  type ProfileLearnerPorts,
} from "../apps/server-identity/profile-learner";
import { MemorySettingsSchema } from "../packages/protocol/memory";
import {
  budgetTarget,
  budgetSelection,
  budgetSettings,
  openBudget,
} from "./helpers/inference-budget";
import type { IntegrationTransport } from "../apps/server-integrations/transport";
import type { ProfileSourceRef } from "../apps/server-identity/profile-material";
const output = {
  add: [
    {
      statement: "TEST works on a green project",
      section: "projects",
      personal: false,
      evidence: ["e1"],
    },
  ],
  refresh: [],
  update: [],
};
const answer = (value: unknown = output) => ({
  status: 200,
  headers: {},
  text: JSON.stringify({
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(value) },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 100, cost: 0.0003 },
  }),
});
function fixture(
  transport: IntegrationTransport,
  existingRoot?: string,
  existingRef?: ProfileSourceRef,
) {
  const root =
    existingRoot ?? mkdtempSync(join(tmpdir(), "TEST-profile-learner-"));
  const f = openBudget(join(root, "identity.sqlite"));
  f.db.exec(
    "CREATE TABLE IF NOT EXISTS organization(id TEXT PRIMARY KEY);CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY);INSERT OR IGNORE INTO organization VALUES('TEST-org');INSERT OR IGNORE INTO user VALUES('TEST-alice');",
  );
  if (
    !f.store.policy(budgetTarget.organizationId, budgetTarget.workspaceId)
      .revision
  )
    f.store.savePolicy(
      budgetTarget.organizationId,
      budgetTarget.workspaceId,
      0,
      {
        ...budgetSettings,
        maxTokens: 24000,
        maxCostMicros: 100000,
        prices: budgetSettings.prices.map((price) => ({
          ...price,
          maxInputTokens: 14000,
          maxOutputTokens: 2000,
        })),
      },
    );
  let now = Date.now(),
    allowed = true,
    available = true;
  const actor = { ...budgetTarget, canManageShared: false },
    scope = {
      connectionId: `account-${actor.workspaceId}`,
      serverId: "TEST-server",
      workspaceId: actor.workspaceId,
      userId: actor.userId,
    };
  const cursor = new ProfileCursorStore(f.db, "TEST secret", () => now);
  const memory = new MemoryStore(f.db, {
    secret: "TEST secret",
    now: () => now,
    onMutation: (principal) => cursor.privacyMutation(principal),
  });
  const inference = new ProfileInference(f.store, cursor, transport, () => now),
    settings = MemorySettingsSchema.parse({});
  const text = "TEST I work on a green project.",
    ref: ProfileSourceRef = existingRef ?? {
      type: "chat",
      sequence: 1,
      sourceId: randomUUID(),
      sourceVersion: 1,
      digest: createHash("sha256").update(text).digest("hex"),
      at: new Date(now).toISOString(),
      messageId: "TEST-message",
    };
  const refs = [ref],
    codes: string[] = [];
  const check = () => {
    if (!allowed || memory.readPreferences(actor).optOut)
      throw Error("TEST revoked");
  };
  const ports: ProfileLearnerPorts = {
    serial: async (fn) => fn(),
    discover: (type) =>
      type === "chat"
        ? [{ key: "TEST-owner", actor, sequence: refs.at(-1)!.sequence }]
        : [],
    access: (currentActor) => {
      if (currentActor.userId !== actor.userId)
        throw Error("TEST denied person");
      check();
      return {
        scope,
        settings,
        inference: {
          selected: budgetSelection,
          settingsRevision: 0,
          policyVersion: 0,
          budgetRevision: 1,
          retentionDays: 30,
          check,
          useProvider: () => {},
          serial: async (fn) => fn(),
        },
      };
    },
    refs: (_scope, type, after) =>
      type === "chat" ? refs.filter((ref) => ref.sequence > after) : [],
    chat: (_scope, source) =>
      available &&
      source.sourceVersion ===
        refs.find((ref) => ref.sourceId === source.sourceId)?.sourceVersion
        ? {
            ref: source,
            scope,
            text,
            commandId: "TEST-command",
            conversationId: "TEST-chat",
          }
        : null,
    meeting: () => null,
    valid: (_scope, source) =>
      available &&
      source.sourceVersion ===
        refs.find((ref) => ref.sourceId === source.sourceId)?.sourceVersion,
    usedActions: () => [],
    log: (code) => codes.push(code),
  };
  const learner = new ProfileLearner(memory, cursor, inference, ports);
  return {
    ...f,
    root,
    actor,
    scope,
    cursor,
    memory,
    inference,
    learner,
    settings,
    ref,
    refs,
    codes,
    ports,
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      allowed = false;
    },
    deleteSource: () => {
      available = false;
    },
    shutdown: async () => {
      await learner.close();
      await memory.close();
      f.db.close();
    },
    close: async () => {
      await learner.close();
      await memory.close();
      f.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

if (!process.env.NIARO_TEST_PROFILE_CRASH_ROOT) {
  test("actual learner: missed dirty notification discovered, atomic cursor/profile, no clean repeat", async () => {
    let calls = 0;
    const f = fixture(async (request) => {
      await request.beforeDispatch!(() => calls++);
      return answer();
    });
    try {
      await f.learner.tick();
      assert.equal(calls, 1);
      assert.equal(f.cursor.read(f.actor).progress.chat, 1);
      const items = await f.memory.observations(f.actor);
      assert.equal(items.items.length, 1);
      assert.equal(items.items[0]!.content, output.add[0]!.statement);
      assert.equal(f.memory.version(f.actor), 1);
      assert.equal(f.cursor.pending(f.actor), null);
      assert(f.codes.includes("profile_committed"));
      await f.learner.tick();
      f.advance(86400000);
      await f.learner.tick();
      assert.equal(calls, 1);
    } finally {
      await f.close();
    }
  });

  for (const race of [
    "delete",
    "revoke",
    "forget",
    "optout",
    "deadline",
    "lease",
  ] as const)
    test(`actual learner late ${race}: no profile or cursor publication, paid root retained`, async () => {
      let calls = 0,
        started!: () => void,
        release!: () => void;
      const entered = new Promise<void>((resolve) => {
          started = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
      const f = fixture(async (request) => {
        await request.beforeDispatch!(() => {
          calls++;
          started();
        });
        await gate;
        return answer();
      });
      try {
        const tick = f.learner.tick();
        await entered;
        const root = f.cursor.pending(f.actor)!.root;
        if (race === "delete") f.deleteSource();
        if (race === "revoke") f.revoke();
        if (race === "forget")
          await f.memory.forgetAll(f.actor, { requestId: "TEST-erase-all" });
        if (race === "optout")
          f.memory.setOptOut(f.actor, {
            requestId: "TEST-opt-out",
            optOut: true,
          });
        if (race === "deadline") f.advance(120001);
        if (race === "lease") {
          f.advance(600001);
          f.cursor.markDirty(f.actor);
          assert(f.cursor.acquire(f.actor));
        }
        release();
        await tick;
        assert.equal((await f.memory.list(f.actor)).length, 0);
        assert.equal(f.cursor.read(f.actor).progress.chat, 0);
        assert.equal(f.cursor.pending(f.actor)!.root, root);
        assert.equal(calls, 1);
        f.advance(86400000);
        await f.learner.tick();
        assert.equal(calls, 1);
        if (["delete", "revoke", "forget", "optout"].includes(race))
          assert(
            f.cursor
              .calls(f.cursor.pending(f.actor)!)
              .every((call) => call.ciphertext === null),
          );
      } finally {
        release();
        await f.close();
      }
    });

  test("actual learner: observe/unpriced admission defers before material and no provider dispatch", async () => {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return answer();
    });
    try {
      f.db
        .prepare(
          "UPDATE agent_inference_policy SET settings=json_set(settings,'$.mode','observe')",
        )
        .run();
      await f.learner.tick();
      assert.equal(calls, 0);
      assert.equal(f.cursor.pending(f.actor), null);
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM agent_inference_attempt").get()!
          .n,
        0,
      );
    } finally {
      await f.close();
    }
  });

  test("actual learner real-file restart reuses a received checkpoint before publication", async () => {
    let calls = 0;
    const transport: IntegrationTransport = async (request) => {
      await request.beforeDispatch!(() => calls++);
      return answer();
    };
    const f = fixture(transport);
    let restarted: ReturnType<typeof fixture> | undefined;
    try {
      f.memory.observe = async () => {
        throw Error("TEST crash after received checkpoint before observation");
      };
      await f.learner.tick();
      assert.equal(calls, 1);
      const root = f.cursor.pending(f.actor)!.root;
      assert.equal(
        f.cursor.calls(f.cursor.pending(f.actor)!)[0]!.state,
        "received",
      );
      await f.shutdown();
      restarted = fixture(transport, f.root, f.ref);
      restarted.advance(3600001);
      await restarted.learner.tick();
      assert.equal(calls, 1);
      assert.equal(restarted.cursor.pending(f.actor), null);
      assert.equal(restarted.cursor.read(f.actor).progress.chat, 1);
      assert.equal(
        (await restarted.memory.observations(f.actor)).items.length,
        1,
      );
      assert.equal(restarted.store.summary(root).calls, 1);
    } finally {
      if (restarted) await restarted.close();
      else await f.close();
    }
  });

  test("actual learner unknown outcome retains original window/root across dirty input and reopened files", async () => {
    let calls = 0;
    const transport: IntegrationTransport = async (request) => {
      await request.beforeDispatch!(() => calls++);
      return { status: 504, headers: {}, text: "TEST unknown" };
    };
    const f = fixture(transport);
    let restarted: ReturnType<typeof fixture> | undefined;
    try {
      await f.learner.tick();
      const root = f.cursor.pending(f.actor)!.root;
      assert.equal(calls, 1);
      await f.shutdown();
      restarted = fixture(transport, f.root, f.ref);
      restarted.advance(3600001);
      restarted.refs.push({
        ...f.ref,
        sequence: 2,
        sourceId: randomUUID(),
        messageId: "TEST-new-dirty",
      });
      restarted.cursor.markDirty(restarted.actor);
      await restarted.learner.tick();
      assert.equal(calls, 1);
      assert.equal(restarted.cursor.pending(f.actor)!.root, root);
      assert.equal(restarted.cursor.read(f.actor).progress.chat, 0);
      assert.equal((await restarted.memory.list(f.actor)).length, 0);
      assert.equal(restarted.store.summary(root).unknownCalls, 1);
    } finally {
      if (restarted) await restarted.close();
      else await f.close();
    }
  });

  test("actual learner archive relocation retries the received answer against the new locator without another charge", async () => {
    let calls = 0,
      entered!: () => void,
      release!: () => void;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const f = fixture(async (request) => {
      await request.beforeDispatch!(() => {
        calls++;
        entered();
      });
      await gate;
      return answer();
    });
    try {
      const tick = f.learner.tick();
      await ready;
      const root = f.cursor.pending(f.actor)!.root;
      f.refs[0] = { ...f.ref, sourceVersion: 2 };
      release();
      await tick;
      assert.equal((await f.memory.list(f.actor)).length, 0);
      assert.equal(f.cursor.read(f.actor).progress.chat, 0);
      assert.equal(
        f.cursor.calls(f.cursor.pending(f.actor)!)[0]!.state,
        "received",
      );
      f.advance(3600001);
      await f.learner.tick();
      assert.equal(calls, 1);
      assert.equal((await f.memory.observations(f.actor)).items.length, 1);
      assert.equal(f.cursor.read(f.actor).progress.chat, 1);
      assert.equal(f.store.summary(root).calls, 1);
    } finally {
      release();
      await f.close();
    }
  });

  test("SIGKILL after actual learner dispatch preserves original paid root on reopen without a second network call", async () => {
    const root = mkdtempSync(join(tmpdir(), "TEST-profile-kill-"));
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(process.cwd(), "tests/profile-learner.node.ts")],
      {
        env: { ...process.env, NIARO_TEST_PROFILE_CRASH_ROOT: root },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let failure = "";
    child.stderr?.on("data", (value) => {
      failure += String(value).slice(0, 2000);
    });
    let reopened: ReturnType<typeof fixture> | undefined;
    try {
      const checkpoint = await new Promise<{
        ref: ProfileSourceRef;
        root: string;
      }>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error("TEST crash worker timeout " + failure)),
          20000,
        );
        child.once("message", (value) => {
          clearTimeout(timeout);
          resolve(value as { ref: ProfileSourceRef; root: string });
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(Error("TEST crash worker exited " + code + " " + failure));
        });
      });
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill("SIGKILL");
      await exited;
      let calls = 0;
      reopened = fixture(
        async (request) => {
          await request.beforeDispatch!(() => calls++);
          return answer();
        },
        root,
        checkpoint.ref,
      );
      reopened.advance(3600001);
      await reopened.learner.tick();
      assert.equal(calls, 0);
      assert.equal(
        reopened.cursor.pending(reopened.actor)!.root,
        checkpoint.root,
      );
      assert.equal(reopened.cursor.read(reopened.actor).progress.chat, 0);
      assert.equal((await reopened.memory.list(reopened.actor)).length, 0);
      assert.equal(reopened.store.summary(checkpoint.root).unknownCalls, 1);
      reopened.advance(21600001);
      reopened.cursor.markDirty(reopened.actor);
      await reopened.learner.tick();
      assert.equal(calls, 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      if (reopened) await reopened.close();
      else rmSync(root, { recursive: true, force: true });
    }
  });
  test("scheduler defers four unauthorized people and lets the next eligible person progress", async () => {
    let calls = 0;
    const f = fixture(async (request) => {
      await request.beforeDispatch!(() => calls++);
      return answer();
    });
    try {
      for (let i = 0; i < 4; i++)
        f.cursor.markDirty({ ...f.actor, userId: `AAA-denied-${i}` });
      await f.learner.tick();
      assert.equal(calls, 0);
      await f.learner.tick();
      assert.equal(calls, 1);
      assert.equal(f.cursor.read(f.actor).progress.chat, 1);
    } finally {
      await f.close();
    }
  });

  for (const change of ["erase", "correct", "version"] as const)
    test(`MIR-01 pre-dispatch ${change} prevents stale private material reaching provider`, async () => {
      let starts = 0,
        changed = false;
      let f: ReturnType<typeof fixture>;
      let observed: { id: string; revision: number };
      f = fixture(async (request) => {
        if (change === "erase")
          await f.memory.forgetAll(f.actor, { requestId: "TEST-MIR-erase" });
        if (change === "correct")
          await f.memory.revise(f.actor, {
            requestId: "TEST-MIR-correct",
            id: observed.id,
            revision: observed.revision,
            content: "TEST owner corrected project",
            source: { type: "user_note" },
            explicitIntent: true,
            settings: f.settings,
          });
        if (change === "version") {
          f.db.prepare("INSERT INTO user VALUES(?)").run("TEST-bob");
          await f.memory.remember(
            { ...f.actor, userId: "TEST-bob" },
            {
              requestId: "TEST-other-version",
              content: "TEST other owner note",
              kind: "fact",
              source: { type: "user_note" },
              explicitIntent: true,
              settings: f.settings,
            },
          );
        }
        changed = true;
        await request.beforeDispatch!(() => starts++);
        return answer();
      });
      try {
        const seeded = await f.memory.observe(
          f.actor,
          {
            batchId: randomUUID(),
            expectedVersion: f.memory.version(f.actor),
            deadline: Date.now() + 120000,
            settings: f.settings,
            add: [
              {
                statement: "TEST private blue project",
                section: "projects",
                personal: false,
                sources: [
                  {
                    type: "chat",
                    sourceId: f.ref.sourceId,
                    messageId: f.ref.messageId!,
                    at: f.ref.at,
                    digest: f.ref.digest,
                  },
                ],
              },
            ],
            refresh: [],
            update: [],
          },
          { observationSourceAccess: () => true },
        );
        observed = seeded.items[0]!;
        await f.learner.tick();
        assert.equal(changed, true);
        assert.equal(starts, 0);
        const batch = f.cursor.pending(f.actor)!;
        assert.equal(f.cursor.read(f.actor).progress.chat, 0);
        const calls = f.cursor.calls(batch);
        assert.equal(calls[0]!.state, "unpaid");
        assert.equal(
          f.store.attemptStatus(batch.root, f.actor, calls[0]!.attemptId),
          "cancelled",
        );
      } finally {
        await f.close();
      }
    });

  test("MIR-02 proven-never-dispatched settings/policy replan retains old cancelled metadata and makes progress", async () => {
    let starts = 0,
      refuse = true;
    const f = fixture(async (request) => {
      if (refuse) throw Error("TEST local refusal");
      await request.beforeDispatch!(() => starts++);
      return answer();
    });
    try {
      await f.learner.tick();
      const old = f.cursor.pending(f.actor)!,
        oldCall = f.cursor.calls(old)[0]!;
      assert.equal(
        f.store.attemptStatus(old.root, f.actor, oldCall.attemptId),
        "cancelled",
      );
      refuse = false;
      const policy = f.store.policy(
        f.actor.organizationId,
        f.actor.workspaceId,
      );
      f.store.savePolicy(
        f.actor.organizationId,
        f.actor.workspaceId,
        policy.revision,
        policy.settings,
      );
      const original = f.ports.access;
      f.ports.access = (actor) => {
        const value = original(actor);
        value.inference.settingsRevision = 1;
        value.inference.budgetRevision = policy.revision + 1;
        return value;
      };
      f.advance(3600001);
      await f.learner.tick();
      assert.equal(starts, 1);
      assert.equal(f.cursor.read(f.actor).progress.chat, 1);
      assert.equal(f.cursor.pending(f.actor), null);
      assert.equal(
        f.store.attemptStatus(old.root, f.actor, oldCall.attemptId),
        "cancelled",
      );
      assert.equal(f.store.summary(old.root).accountedTokens, 0);
    } finally {
      await f.close();
    }
  });

  test("MIR-02 repeated pre-dispatch cancellations never consume the first actual paid dispatch", async () => {
    let starts = 0,
      refuses = 2;
    const f = fixture(async (request) => {
      if (refuses-- > 0) throw Error("TEST local refusal");
      await request.beforeDispatch!(() => starts++);
      return answer();
    });
    try {
      for (let i = 0; i < 4; i++) {
        await f.learner.tick();
        f.advance(21600001);
      }
      assert.equal(starts, 1);
      assert.equal(f.cursor.read(f.actor).progress.chat, 1);
      assert.equal(f.cursor.pending(f.actor), null);
      const rows = f.db
        .prepare("SELECT status FROM agent_inference_attempt")
        .all();
      assert.equal(rows.filter((row) => row.status === "cancelled").length, 2);
      assert.equal(rows.filter((row) => row.status === "settled").length, 1);
    } finally {
      await f.close();
    }
  });

  for (const denial of ["observe", "signedout"] as const)
    test(`MIR-04 expired response ciphertext is scrubbed under ${denial} admission without releasing unknown hold`, async () => {
      let starts = 0;
      const f = fixture(async (request) => {
        await request.beforeDispatch!(() => starts++);
        const raw = answer();
        const body = JSON.parse(raw.text);
        delete body.usage;
        return { ...raw, text: JSON.stringify(body) };
      });
      try {
        f.memory.observe = async () => {
          throw Error("TEST pause after received checkpoint");
        };
        await f.learner.tick();
        const batch = f.cursor.pending(f.actor)!;
        assert(f.cursor.calls(batch)[0]!.ciphertext);
        assert.equal(f.store.summary(batch.root).unknownCalls, 1);
        if (denial === "observe")
          f.db
            .prepare(
              "UPDATE agent_inference_policy SET settings=json_set(settings,'$.mode','observe')",
            )
            .run();
        else f.revoke();
        f.advance(2 * 86400000);
        await f.learner.tick();
        assert.equal(starts, 1);
        assert.equal(f.cursor.calls(batch)[0]!.ciphertext, null);
        assert.equal(f.cursor.calls(batch)[0]!.state, "received");
        assert.equal(f.cursor.pending(f.actor)!.root, batch.root);
        assert.equal(f.store.summary(batch.root).unknownCalls, 1);
        assert.equal(f.cursor.read(f.actor).progress.chat, 0);
      } finally {
        await f.close();
      }
    });

  test("MIR-01 captured version is checked before reservation as well as held start", async () => {
    let starts = 0,
      erased = false;
    const f = fixture(async (request) => {
      await request.beforeDispatch!(() => starts++);
      return answer();
    });
    try {
      await f.memory.observe(
        f.actor,
        {
          batchId: randomUUID(),
          expectedVersion: f.memory.version(f.actor),
          deadline: Date.now() + 120000,
          settings: f.settings,
          add: [
            {
              statement: "TEST private prior",
              section: "work",
              personal: false,
              sources: [
                {
                  type: "chat",
                  sourceId: f.ref.sourceId,
                  messageId: f.ref.messageId!,
                  at: f.ref.at,
                  digest: f.ref.digest,
                },
              ],
            },
          ],
          refresh: [],
          update: [],
        },
        { observationSourceAccess: () => true },
      );
      const original = f.ports.access;
      f.ports.access = (actor) => {
        const access = original(actor),
          serial = access.inference.serial;
        let count = 0;
        access.inference.serial = async (fn) => {
          if (++count === 2) {
            await f.memory.forgetAll(f.actor, {
              requestId: "TEST-before-reserve",
            });
            erased = true;
          }
          return serial(fn);
        };
        return access;
      };
      await f.learner.tick();
      assert.equal(erased, true);
      assert.equal(starts, 0);
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM agent_inference_attempt").get()!
          .n,
        0,
      );
      assert.equal(f.cursor.read(f.actor).progress.chat, 0);
    } finally {
      await f.close();
    }
  });

  test("MIR-02 an atomic refusal before reservation can replan after a feasible priced policy change", async () => {
    let starts = 0;
    const f = fixture(async (request) => {
      await request.beforeDispatch!(() => starts++);
      return answer();
    });
    try {
      const policy = f.store.policy(
        f.actor.organizationId,
        f.actor.workspaceId,
      );
      f.store.savePolicy(
        f.actor.organizationId,
        f.actor.workspaceId,
        policy.revision,
        {
          ...policy.settings,
          prices: policy.settings.prices.map((price) => ({
            ...price,
            maxInputTokens: 2048,
          })),
        },
      );
      const original = f.ports.access;
      f.ports.access = (actor) => {
        const access = original(actor);
        access.inference.budgetRevision = f.store.policy(
          actor.organizationId,
          actor.workspaceId,
        ).revision;
        return access;
      };
      await f.learner.tick();
      const old = f.cursor.pending(f.actor)!;
      assert(old);
      assert.equal(starts, 0);
      assert.equal(f.cursor.calls(old).length, 0);
      assert.equal(
        f.db
          .prepare("SELECT count(*) AS n FROM agent_inference_run WHERE id=?")
          .get(old.root)!.n,
        0,
      );
      const current = f.store.policy(
        f.actor.organizationId,
        f.actor.workspaceId,
      );
      f.store.savePolicy(
        f.actor.organizationId,
        f.actor.workspaceId,
        current.revision,
        policy.settings,
      );
      f.advance(3600001);
      await f.learner.tick();
      assert.equal(starts, 1);
      assert.equal(f.cursor.read(f.actor).progress.chat, 1);
      assert.equal(f.cursor.pending(f.actor), null);
      assert.equal(
        f.db
          .prepare(
            "SELECT count(*) AS n FROM agent_profile_unpaid_root WHERE root=?",
          )
          .get(old.root)!.n,
        1,
      );
    } finally {
      await f.close();
    }
  });

  test("MIR-02 unpaid recovery cannot reset repeated unknown holds and bounded backoff", async () => {
    let starts = 0;
    const f = fixture(async (request) => {
      await request.beforeDispatch!(() => starts++);
      return { status: 504, headers: {}, text: "TEST unknown completion" };
    });
    try {
      await f.learner.tick();
      const root = f.cursor.pending(f.actor)!.root;
      for (let attempt = 0; attempt < 4; attempt++) {
        f.advance(21600001);
        await f.learner.tick();
      }
      assert.equal(starts, 1);
      assert.equal(f.cursor.pending(f.actor)!.root, root);
      assert.equal(f.cursor.read(f.actor).progress.chat, 0);
      assert.equal(f.cursor.read(f.actor).failures, 2);
      assert.equal(f.store.summary(root).unknownCalls, 1);
    } finally {
      await f.close();
    }
  });

  for (const variant of ["ascii", "unicode", "escaped"] as const)
    test(`MIR-03-R3 real bound ${variant} action names resume with prior and sustained meetings without omission`, async () => {
      const names = Array.from({ length: 20 }, (_, i) => ({
        service: IdentityName.parse(
          (
            `TEST service ${i} ` +
            (variant === "ascii"
              ? "s"
              : variant === "unicode"
                ? "界"
                : "\\"
            ).repeat(100)
          ).slice(0, 100),
        ),
        action: IdentityName.parse(
          (
            `TEST action ${i} ` +
            (variant === "ascii"
              ? "a"
              : variant === "unicode"
                ? "語"
                : 'x"\\'
            ).repeat(100)
          ).slice(0, 100),
        ),
      }));
      const chatText = "TEST chat own project reports.",
        meetingText = "TEST meeting own weekly review.";
      const emitted: { service: string; action: string }[] = [],
        textParts: string[] = [],
        bodies: number[] = [];
      const transport: IntegrationTransport = async (request) => {
        await request.beforeDispatch!(() => {
          bodies.push(Buffer.byteLength(JSON.stringify(request.body)));
          const body = request.body as {
            messages: { role: string; content: string }[];
          };
          const payload = JSON.parse(
            body.messages.find((message) => message.role === "user")!.content,
          ) as {
            evidence: {
              text: string;
              usedActions: { service: string; action: string }[];
            }[];
          };
          for (const item of payload.evidence)
            if (item.text !== meetingText) {
              textParts.push(item.text);
              emitted.push(...item.usedActions);
            }
        });
        return answer({ add: [], refresh: [], update: [] });
      };
      let f = fixture(transport);
      const receiptDb = new DatabaseSync(":memory:");
      receiptDb.exec(
        "CREATE TABLE organization(id TEXT PRIMARY KEY);CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT);INSERT INTO organization VALUES('TEST-org');INSERT INTO agent_workspace VALUES('TEST-workspace','TEST-org');",
      );
      const catalog = new ServiceCatalogStore(receiptDb, "TEST secret", []),
        at = new Date().toISOString();
      const chat = { ...f.ref, messageId: "TEST-chat" },
        meetings = Array.from({ length: 20 }, (_, i) => ({
          type: "meeting" as const,
          sequence: i + 1,
          sourceId: randomUUID(),
          sourceVersion: 1,
          digest: "b".repeat(64),
          at,
          meetingId: randomUUID(),
        }));
      const configure = () => {
        let queue: Promise<unknown> = Promise.resolve();
        const serial = <T>(run: () => T | Promise<T>): Promise<T> => {
          const job = queue.then(run);
          queue = job.catch(() => undefined);
          return job;
        };
        const original = f.ports.access;
        f.ports.access = (actor) => {
          const access = original(actor);
          access.inference.serial = serial;
          return access;
        };
        f.ports.serial = serial;
        f.ports.refs = (_scope, type, after) =>
          type === "chat"
            ? [chat].filter((ref) => ref.sequence > after)
            : meetings.filter((ref) => ref.sequence > after).slice(0, 1);
        f.ports.chat = (_scope, ref) => ({
          scope: f.scope,
          ref,
          text: chatText,
          commandId: "TEST-command",
          conversationId: "TEST-chat",
        });
        f.ports.meeting = (_scope, ref) => ({
          scope: f.scope,
          ref,
          ownText: [meetingText],
          ownTasks: [],
        });
        f.ports.valid = () => true;
        f.ports.usedActions = () =>
          catalog.profileUsedActions(
            f.actor.organizationId,
            f.actor.workspaceId,
            f.actor.userId,
            "TEST-command",
            "TEST-chat",
          );
      };
      try {
        catalog.saveTurn("TEST-turn", f.actor.workspaceId, f.actor.userId, {
          commandId: "TEST-command",
          conversationId: "TEST-chat",
        });
        for (const [i, name] of names.entries()) {
          const id = `TEST-receipt-${String(i).padStart(2, "0")}`;
          catalog.saveInvocation({
            id,
            organizationId: f.actor.organizationId,
            workspaceId: f.actor.workspaceId,
            userId: f.actor.userId,
            serviceId: "TEST-service",
            actionId: `TEST-action-${i}`,
            serviceRevision: 1,
            actionRevision: 1,
            policyRevision: 1,
            input: {},
            status: "succeeded",
            completedAt: Date.now(),
            title: name.action,
            serviceName: name.service,
            effect: "read",
            result: { omitted: "TEST never extract result" },
          });
          catalog.linkTurnOperation(
            "TEST-turn",
            id,
            f.actor.workspaceId,
            f.actor.userId,
          );
        }
        assert.deepEqual(
          catalog.profileUsedActions(
            f.actor.organizationId,
            f.actor.workspaceId,
            f.actor.userId,
            "TEST-command",
            "TEST-chat",
          ),
          names,
        );
        await f.memory.observe(
          f.actor,
          {
            batchId: randomUUID(),
            expectedVersion: f.memory.version(f.actor),
            deadline: Date.now() + 120000,
            settings: f.settings,
            add: [
              {
                statement: "TEST blue prior project",
                section: "projects",
                personal: false,
                sources: [
                  {
                    type: "chat",
                    sourceId: chat.sourceId,
                    messageId: chat.messageId,
                    at: chat.at,
                    digest: chat.digest,
                  },
                ],
              },
            ],
            refresh: [],
            update: [],
          },
          { observationSourceAccess: () => true },
        );
        configure();
        let previous = { chat: 0, chatOffset: 0, meeting: 0, meetingOffset: 0 };
        for (let attempt = 0; attempt < 16; attempt++) {
          await f.learner.tick();
          const progress = f.cursor.read(f.actor).progress;
          assert(
            progress.chat > previous.chat ||
              progress.chatOffset > previous.chatOffset,
          );
          assert.equal(progress.meeting, previous.meeting + 1);
          if (progress.chat === 1) {
            assert.deepEqual(emitted, names);
            break;
          }
          assert(emitted.length < names.length);
          assert(progress.chatProjection);
          previous = progress;
          if (variant === "unicode" && attempt === 0) {
            const root = f.root,
              source = f.ref;
            await f.shutdown();
            f = fixture(transport, root, source);
            configure();
            assert.deepEqual(f.cursor.read(f.actor).progress, progress);
            f.advance(1200001);
          } else f.advance(600001);
        }
        assert.equal(f.cursor.read(f.actor).progress.chat, 1);
        assert.deepEqual(emitted, names);
        assert.equal(textParts.join(""), chatText);
        assert(bodies.length > 1 && bodies.every((bytes) => bytes <= 24576));
      } finally {
        receiptDb.close();
        await f.close();
      }
    });
} else {
  const root = process.env.NIARO_TEST_PROFILE_CRASH_ROOT;
  let fixtureValue: ReturnType<typeof fixture>;
  fixtureValue = fixture(async (request) => {
    await request.beforeDispatch!(() => {
      process.send!({
        ref: fixtureValue.ref,
        root: fixtureValue.cursor.pending(fixtureValue.actor)!.root,
      });
    });
    await new Promise<void>(() => {});
    return answer();
  }, root);
  void fixtureValue.learner.tick();
}

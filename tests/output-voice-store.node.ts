import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import { IdentityError } from "../apps/server-identity/error";
import {
  OUTPUT_VOICE_PROFILE,
  type OutputVoiceChoice,
  type OutputVoiceSnapshot,
  type OutputVoiceUpdate,
} from "../packages/protocol/output-voice";
import {
  speechVoiceCompatibility,
  voiceDigest,
  type OutputVoiceActor,
} from "../apps/server-integrations/speech-voices";

const org = randomUUID(),
  otherOrg = randomUUID(),
  ws = randomUUID(),
  otherWs = randomUUID(),
  farWs = randomUUID();
const owner = "owner",
  member = "person",
  farUser = "far-person";
const actor: OutputVoiceActor = {
  organizationId: org,
  workspaceId: ws,
  userId: owner,
};
const scope = (a: OutputVoiceActor = actor) => ({
  connectionId: "connection",
  serverId: "server",
  workspaceId: a.workspaceId,
  userId: a.userId,
});
const defaultChoice = { kind: "server-default" } as const;
function harness(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS organization(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS member(id TEXT PRIMARY KEY,"organizationId" TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,"userId" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS agent_workspace_member(workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,PRIMARY KEY(workspace_id,member_id));`);
  if (!db.prepare("SELECT 1 FROM organization").get()) {
    for (const id of [org, otherOrg])
      db.prepare("INSERT INTO organization VALUES (?)").run(id);
    for (const id of [owner, member, farUser])
      db.prepare("INSERT INTO user VALUES (?)").run(id);
    for (const [id, o, u, role] of [
      ["m-owner", org, owner, "owner"],
      ["m-person", org, member, "member"],
      ["m-far", otherOrg, farUser, "admin"],
    ])
      db.prepare("INSERT INTO member VALUES (?,?,?,?)").run(id!, o!, u!, role!);
    for (const [id, o] of [
      [ws, org],
      [otherWs, org],
      [farWs, otherOrg],
    ])
      db.prepare("INSERT INTO agent_workspace VALUES (?,?)").run(id!, o!);
    db.prepare("INSERT INTO agent_workspace_member VALUES (?,?)").run(
      ws,
      "m-person",
    );
  }
  const catalog = new ServiceCatalogStore(
    db,
    "TEST-only-output-voice-secret",
    [],
  );
  const store = catalog.outputVoice;
  const command = (
    input: object,
    target = { organizationId: org, workspaceId: ws },
  ) => catalog.command(CatalogCommand.parse({ ...target, ...input }));
  const read = (a = actor) =>
    store.read(
      a,
      scope(a),
      catalog.speechVoiceRoute(a.organizationId, a.workspaceId),
    );
  const body = (
    s: OutputVoiceSnapshot,
    choice: OutputVoiceChoice,
    requestId = randomUUID(),
  ): OutputVoiceUpdate => ({
    profile: OUTPUT_VOICE_PROFILE,
    requestId,
    expectedRevision: s.revision,
    catalogueRevision: s.catalogueRevision,
    choice,
  });
  const save = (input: OutputVoiceUpdate, a = actor) =>
    store.save(
      a,
      scope(a),
      catalog.speechVoiceRoute(a.organizationId, a.workspaceId),
      input,
    );
  const choose = (s = read(), index = 0) =>
    body(s, { kind: "catalogue", optionId: s.options[index]!.optionId });
  const route = (patch: object = {}) => {
    const before = catalog.routing(ws);
    return command({ type: "saveRouting", routing: { ...before, ...patch } });
  };
  const setup = () => {
    const provider = command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST provider",
        url: "https://openrouter.ai/api/v1",
        enabled: true,
        dailyRequestLimit: 10,
      },
      apiKey: "TEST synthetic credential",
    })!;
    const settings = {
      providerId: provider,
      name: "TEST reader",
      model: "openai/gpt-audio-mini",
      enabled: true,
      tools: false,
      audioOutput: true,
    };
    const model = command({ type: "saveModel", revision: 0, settings })!;
    const secondModel = command({
      type: "saveModel",
      revision: 0,
      settings: {
        ...settings,
        model: "openai/gpt-audio",
        name: "TEST alternate",
      },
    })!;
    route({
      speech: {
        modelId: model,
        method: "reader",
        voice: "cedar",
        zeroDataRetention: false,
      },
    });
    return { provider, model, secondModel, settings };
  };
  return {
    db,
    catalog,
    store,
    command,
    read,
    body,
    save,
    choose,
    route,
    setup,
  };
}
function error(code: string, fn: () => unknown) {
  assert.throws(
    fn,
    (e: unknown) => e instanceof IdentityError && e.code === code,
    code,
  );
}

test("absent preference returns a complete default snapshot and initializes no actor rows", () => {
  const h = harness();
  try {
    let s = h.read();
    assert.equal(s.revision, 0);
    assert.equal(s.saved, null);
    assert.equal(s.availability, "speech-unavailable");
    assert.deepEqual(h.save(h.body(s, defaultChoice)), s);
    h.setup();
    s = h.read();
    assert.equal(s.serverDefault?.label, "Cedar");
    assert.equal(s.effective.label, "Cedar");
    assert.equal(s.options.length, 3);
    assert.equal(
      h.db.prepare("SELECT count(*) n FROM agent_personal_output_voice").get()!
        .n,
      0,
    );
    assert.deepEqual(h.save(h.body(s, defaultChoice)), s);
  } finally {
    h.db.close();
  }
});

test("personal catalogue intent survives reopening SQLite and connection changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "output-voice-store-"));
  const file = join(dir, "identity.sqlite");
  let h = harness(file);
  try {
    h.setup();
    const saved = h.save(h.choose());
    assert.equal(saved.revision, 1);
    assert.equal(saved.saved?.label, "Alloy");
    const identity = saved.route!.identity;
    h.db.close();
    h = harness(file);
    assert.deepEqual(h.read(), saved);
    assert.equal(
      h.store.read(
        actor,
        { ...scope(), connectionId: "browser" },
        h.catalog.speechVoiceRoute(org, ws),
      ).route?.identity,
      identity,
    );
    assert.equal(
      h.store.resolve(actor, scope(), h.catalog.speechVoiceRoute(org, ws))
        .voice,
      "alloy",
    );
  } finally {
    h.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scope, user, workspace and organization isolate tokens, rows and authorized operations", () => {
  const h = harness();
  try {
    h.setup();
    const saved = h.save(h.choose());
    for (const a of [
      { ...actor, userId: member },
      { ...actor, workspaceId: otherWs },
      { organizationId: otherOrg, workspaceId: farWs, userId: farUser },
    ]) {
      const s = h.read(a);
      assert.equal(s.saved, null);
      assert.notEqual(s.catalogueRevision, saved.catalogueRevision);
      error("output_voice_catalogue_changed", () =>
        h.save({ ...h.choose(saved), expectedRevision: 0 }, a),
      );
    }
    const another = { ...actor, userId: member };
    const own = h.read(another);
    error("output_voice_choice_unavailable", () =>
      h.save(h.body(own, saved.saved!.choice), another),
    );
    error("identity_forbidden", () =>
      h.store.read(actor, scope(another), h.catalog.speechVoiceRoute(org, ws)),
    );
    error("identity_forbidden", () =>
      h.read({ ...actor, organizationId: otherOrg }),
    );
    assert.equal(h.read().saved?.label, "Alloy");
  } finally {
    h.db.close();
  }
});

test("CAS, exact last committed replay, collision and delayed old mutations preserve newer intent", () => {
  const h = harness();
  try {
    h.setup();
    const initial = h.read(),
      first = h.choose(initial),
      competing = h.choose(initial, 1);
    const saved = h.save(first);
    assert.equal(saved.revision, 1);
    error("output_voice_conflict", () => h.save(competing));
    assert.deepEqual(h.save(first), saved);
    error("output_voice_conflict", () =>
      h.save({ ...first, choice: defaultChoice }),
    );
    const noop = h.save(h.body(saved, saved.saved!.choice));
    assert.equal(noop.revision, 1);
    assert.equal(
      h.db
        .prepare("SELECT last_request_id FROM agent_personal_output_voice")
        .get()!.last_request_id,
      first.requestId,
    );
    const secondRequest = h.choose(noop, 1);
    const second = h.save(secondRequest);
    assert.equal(second.revision, 2);
    error("output_voice_conflict", () => h.save(first));
    assert.equal(h.read().saved?.label, "Echo");
    h.route({ speech: { ...h.catalog.routing(ws).speech, voice: "shimmer" } });
    const replay = h.save(secondRequest);
    assert.equal(replay.revision, 2);
    assert.equal(replay.serverDefault?.label, "Shimmer");
    assert.equal(h.save(h.body(replay, defaultChoice)).revision, 3);
  } finally {
    h.db.close();
  }
});

test("same saved intent is a no-op but Reset clears a stale custom intent already falling back", () => {
  const h = harness();
  try {
    h.setup();
    const first = h.choose();
    h.save(first);
    h.route({ speech: { ...h.catalog.routing(ws).speech, modelId: null } });
    const stale = h.read();
    assert.equal(stale.effective.choice.kind, "server-default");
    assert.equal(stale.saved?.choice.kind, "catalogue");
    assert.equal(h.save(first).revision, 1); // Known committed receipt, even under changed routing.
    const reset = h.save(h.body(stale, defaultChoice));
    assert.equal(reset.revision, 2);
    assert.deepEqual(reset.saved, { choice: defaultChoice, label: "" });
    assert.equal(h.save(h.body(reset, defaultChoice)).revision, 2);
    h.route({ speech: { ...h.catalog.routing(ws).speech, voice: "echo" } });
    assert.equal(h.read().effective.reason, "speech-unavailable");
  } finally {
    h.db.close();
  }
});

test("default-only and unrelated routing edits change tokens without invalidating compatible selection", () => {
  const h = harness();
  try {
    h.setup();
    const before = h.save(h.choose());
    const identity = before.route!.identity;
    h.route({ speech: { ...h.catalog.routing(ws).speech, voice: "echo" } });
    let next = h.read();
    assert.equal(next.route!.identity, identity);
    assert.notEqual(next.catalogueRevision, before.catalogueRevision);
    assert.equal(next.effective.reason, "selected");
    error("output_voice_catalogue_changed", () =>
      h.save(h.body(before, defaultChoice)),
    );
    const token = next.catalogueRevision;
    h.route({ planner: "model" });
    next = h.read();
    assert.equal(next.catalogueRevision, token);
    assert.equal(next.effective.label, "Alloy");
    const reset = h.save(h.body(next, defaultChoice));
    assert.equal(reset.effective.label, "Echo");
    h.route({ speech: { ...h.catalog.routing(ws).speech, voice: "shimmer" } });
    assert.equal(h.read().effective.label, "Shimmer");
  } finally {
    h.db.close();
  }
});

test("catalogue command hook observes model A to B to A between reads and disable to enable", () => {
  const h = harness();
  try {
    const { model, secondModel } = h.setup();
    const selected = h.save(h.choose());
    const original = h.catalog.routing(ws).speech;
    h.route({ speech: { ...original, modelId: secondModel } });
    h.route({ speech: { ...original, modelId: model } });
    let s = h.read();
    assert.equal(s.effective.reason, "saved-choice-unavailable");
    assert.notEqual(s.route!.identity, selected.route!.identity);
    s = h.save(h.choose(s));
    assert.equal(s.effective.reason, "selected");
    h.route({ speech: { ...original, modelId: null } });
    h.route({ speech: original });
    assert.equal(h.read().effective.reason, "saved-choice-unavailable");
  } finally {
    h.db.close();
  }
});

test("provider A to B to A between reads cannot resurrect a saved option", () => {
  const h = harness();
  try {
    const { settings } = h.setup();
    const selected = h.save(h.choose());
    const original = h.catalog.routing(ws).speech;
    const provider = h.command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST second provider",
        url: "https://openrouter.ai/api/v1",
        enabled: true,
        dailyRequestLimit: 10,
      },
      apiKey: "TEST second synthetic credential",
    })!;
    const model = h.command({
      type: "saveModel",
      revision: 0,
      settings: { ...settings, providerId: provider },
    })!;
    h.route({ speech: { ...original, modelId: model } });
    h.route({ speech: original });
    const current = h.read();
    assert.equal(current.effective.reason, "saved-choice-unavailable");
    assert.notEqual(current.route!.identity, selected.route!.identity);
  } finally {
    h.db.close();
  }
});

test("privacy, provider/model revisions invalidate but failed commands roll back epoch metadata", () => {
  const h = harness();
  try {
    const { provider, model, settings } = h.setup();
    const selected = h.save(h.choose());
    const epoch = () =>
      h.db
        .prepare(
          "SELECT epoch FROM agent_output_voice_route_epoch WHERE workspace_id=?",
        )
        .get(ws)!.epoch;
    const originalEpoch = epoch();
    error("catalog_conflict", () =>
      h.command({
        type: "saveRouting",
        routing: { ...h.catalog.routing(ws), revision: 0 },
      }),
    );
    assert.equal(epoch(), originalEpoch);
    assert.equal(h.read().effective.reason, "selected");
    h.route({
      speech: { ...h.catalog.routing(ws).speech, zeroDataRetention: true },
    });
    assert.equal(h.read().effective.reason, "saved-choice-unavailable");
    h.save(h.choose());
    h.command({
      type: "saveModel",
      id: model,
      revision: 1,
      settings: { ...settings, name: "TEST renamed reader" },
    });
    assert.equal(h.read().effective.reason, "saved-choice-unavailable");
    h.save(h.choose());
    h.command({
      type: "saveProvider",
      id: provider,
      revision: 1,
      settings: {
        name: "TEST provider",
        url: "https://openrouter.ai/api/v1",
        enabled: false,
        dailyRequestLimit: 10,
      },
    });
    assert.equal(h.read().availability, "speech-unavailable");
    h.command({
      type: "saveProvider",
      id: provider,
      revision: 2,
      settings: {
        name: "TEST provider",
        url: "https://openrouter.ai/api/v1",
        enabled: true,
        dailyRequestLimit: 10,
      },
    });
    assert.equal(h.read().effective.reason, "saved-choice-unavailable");
    assert.notEqual(h.read().route!.identity, selected.route!.identity);
  } finally {
    h.db.close();
  }
});

test("corrupt and old personal data safely fall back without mutating the saved row", () => {
  const h = harness();
  try {
    h.setup();
    h.save(h.choose());
    const original = h.db
      .prepare(
        "SELECT choice_json,saved_label,binding_json FROM agent_personal_output_voice",
      )
      .get()!;
    for (const [column, value] of [
      ["binding_json", "not json"],
      ["choice_json", '{"version":0,"choice":{"kind":"catalogue"}}'],
      ["saved_label", "<script>bad</script>"],
    ]) {
      h.db
        .prepare(
          "UPDATE agent_personal_output_voice SET choice_json=?,saved_label=?,binding_json=?",
        )
        .run(
          original.choice_json!,
          original.saved_label!,
          original.binding_json!,
        );
      h.db
        .prepare(`UPDATE agent_personal_output_voice SET ${column}=?`)
        .run(value!);
      const before = h.db
        .prepare("SELECT * FROM agent_personal_output_voice")
        .get();
      const s = h.read();
      assert.equal(s.effective.reason, "saved-choice-unavailable");
      assert.equal(s.effective.label, "Cedar");
      assert.deepEqual(
        h.db.prepare("SELECT * FROM agent_personal_output_voice").get(),
        before,
      );
    }
  } finally {
    h.db.close();
  }
});

test("a registry revision change is reconciled lazily without reviving the earlier saved binding", () => {
  const h = harness();
  try {
    h.setup();
    h.save(h.choose());
    const compatibility = speechVoiceCompatibility(
      h.catalog.speechVoiceRoute(org, ws),
    );
    assert.equal(
      compatibility.at(-1),
      "openrouter-gpt-audio-mini-reader-20261030-1",
    );
    // Persisted metadata from a prior binary: only its registry policy differs.
    const previousDigest = voiceDigest([
      ...compatibility.slice(0, -1),
      "previous-reviewed-policy",
    ]);
    h.db
      .prepare(
        "UPDATE agent_output_voice_route_epoch SET binding_digest=? WHERE workspace_id=?",
      )
      .run(previousDigest, ws);
    const s = h.read();
    assert.equal(s.effective.reason, "saved-choice-unavailable");
    assert.equal(s.saved?.label, "Alloy");
  } finally {
    h.db.close();
  }
});

test("passive metadata never decrypts keys; missing credentials and unreviewed speech routes degrade safely", () => {
  const h = harness();
  try {
    const { provider, secondModel } = h.setup();
    const originalProvider = h.catalog.provider;
    h.catalog.provider = () => {
      throw Error("TEST forbidden credential decryption");
    };
    assert.equal(h.read().availability, "selectable");
    h.db
      .prepare("UPDATE agent_catalog SET secret=NULL WHERE id=?")
      .run(provider);
    assert.equal(h.read().availability, "speech-unavailable");
    h.db
      .prepare(
        "UPDATE agent_catalog SET secret='TEST unneeded sealed value' WHERE id=?",
      )
      .run(provider);
    assert.equal(h.read().availability, "selectable");
    h.catalog.provider = originalProvider;
    h.db
      .prepare(
        "UPDATE agent_catalog_routing SET data=json_set(data,'$.speech.modelId',?) WHERE workspace_id=?",
      )
      .run(secondModel, ws);
    assert.equal(h.read().availability, "server-default-only");
    assert.deepEqual(h.read().options, []);
  } finally {
    h.db.close();
  }
});

test("write failure rolls back preference and committed receipt, allowing deliberate exact retry", () => {
  const h = harness();
  try {
    h.setup();
    const saved = h.save(h.choose());
    const update = h.choose(saved, 1);
    const before = h.db
      .prepare("SELECT * FROM agent_personal_output_voice")
      .get();
    h.db.exec(
      "CREATE TRIGGER fail_output_voice AFTER UPDATE ON agent_personal_output_voice BEGIN SELECT RAISE(ABORT,'TEST storage failure'); END",
    );
    assert.throws(() => h.save(update), /TEST storage failure/);
    assert.deepEqual(
      h.db.prepare("SELECT * FROM agent_personal_output_voice").get(),
      before,
    );
    h.db.exec("DROP TRIGGER fail_output_voice");
    const after = h.save(update);
    assert.equal(after.revision, 2);
    assert.equal(after.saved?.label, "Echo");
  } finally {
    h.db.close();
  }
});

test("workspace revocation blocks reads and writes; organization rejoin starts from default", () => {
  const h = harness();
  try {
    h.setup();
    const a = { ...actor, userId: member };
    const s = h.read(a);
    h.save(h.choose(s), a);
    h.db
      .prepare("DELETE FROM agent_workspace_member WHERE member_id=?")
      .run("m-person");
    error("identity_forbidden", () => h.read(a));
    error("identity_forbidden", () => h.save(h.body(s, defaultChoice), a));
    h.db
      .prepare("INSERT INTO agent_workspace_member VALUES (?,?)")
      .run(ws, "m-person");
    assert.equal(h.read(a).effective.reason, "selected");
    h.db.prepare("DELETE FROM member WHERE id=?").run("m-person");
    assert.equal(
      h.db.prepare("SELECT count(*) n FROM agent_personal_output_voice").get()!
        .n,
      0,
    );
    h.db
      .prepare("INSERT INTO member VALUES (?,?,?,?)")
      .run("m-rejoined", org, member, "member");
    h.db
      .prepare("INSERT INTO agent_workspace_member VALUES (?,?)")
      .run(ws, "m-rejoined");
    assert.equal(h.read(a).saved, null);
  } finally {
    h.db.close();
  }
});

test("organization, workspace and user foreign keys cascade preference cleanup", () => {
  for (const [table, id] of [
    ["organization", org],
    ["agent_workspace", ws],
    ["user", owner],
  ]) {
    const h = harness();
    try {
      h.setup();
      h.save(h.choose());
      h.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id!);
      assert.equal(
        h.db
          .prepare("SELECT count(*) n FROM agent_personal_output_voice")
          .get()!.n,
        0,
        table,
      );
    } finally {
      h.db.close();
    }
  }
});

for (const availability of [
  "selectable",
  "server-default-only",
  "speech-unavailable",
] as const) {
  for (const corruption of [
    "malformed JSON",
    "old version",
    "invalid saved label",
  ] as const) {
    test(`deliberate Reset repairs ${corruption} in ${availability} with valid default intent and a replayable receipt`, () => {
      const h = harness();
      try {
        const { secondModel } = h.setup();
        const first = h.choose();
        const saved = h.save(first);
        if (corruption === "malformed JSON")
          h.db
            .prepare("UPDATE agent_personal_output_voice SET choice_json=?")
            .run("{broken");
        else if (corruption === "old version")
          h.db
            .prepare("UPDATE agent_personal_output_voice SET choice_json=?")
            .run(JSON.stringify({ version: 0, choice: saved.saved!.choice }));
        else
          h.db
            .prepare("UPDATE agent_personal_output_voice SET saved_label=?")
            .run("<invalid>");
        if (availability !== "selectable")
          h.route({
            speech: {
              ...h.catalog.routing(ws).speech,
              modelId:
                availability === "speech-unavailable" ? null : secondModel,
            },
          });
        const row = () =>
          h.db.prepare("SELECT * FROM agent_personal_output_voice").get()!;
        const corrupt = row();
        const current = h.read();
        assert.equal(current.availability, availability);
        assert.equal(current.saved, null);
        assert.equal(current.revision, 1);
        assert.deepEqual(
          row(),
          corrupt,
          "passive read must retain the unreadable row and prior receipt",
        );
        const request = h.body(current, defaultChoice);
        const reset = h.save(request);
        assert.equal(
          reset.revision,
          2,
          "existing unreadable intent is a change, not absent-default no-op",
        );
        assert.deepEqual(reset.saved, { choice: defaultChoice, label: "" });
        assert.equal(
          reset.effective.reason,
          availability === "speech-unavailable"
            ? "speech-unavailable"
            : "server-default",
        );
        const committed = row();
        assert.deepEqual(JSON.parse(String(committed.choice_json)), {
          version: 1,
          choice: defaultChoice,
        });
        assert.equal(committed.saved_label, "");
        assert.equal(committed.binding_json, null);
        assert.equal(committed.revision, 2);
        assert.equal(committed.last_write_revision, 2);
        assert.equal(committed.last_request_id, request.requestId);
        assert.match(String(committed.last_request_digest), /^[a-f0-9]{64}$/);
        assert.notEqual(
          committed.last_request_digest,
          corrupt.last_request_digest,
        );
        assert.deepEqual(
          h.save(request),
          reset,
          "exact committed Reset replay does not write again",
        );
        assert.deepEqual(row(), committed);
        assert.deepEqual(
          h.save(h.body(reset, defaultChoice)),
          reset,
          "valid explicit default remains a no-op",
        );
        assert.deepEqual(
          row(),
          committed,
          "same-intent no-op retains the committed Reset receipt",
        );
        error("output_voice_conflict", () =>
          h.save({ ...request, expectedRevision: 2 }),
        );
        h.route({ speech: { ...h.catalog.routing(ws).speech, voice: "echo" } });
        assert.equal(
          h.save(request).revision,
          2,
          "known Reset receipt replays even after routing changes",
        );
        assert.deepEqual(row(), committed);
      } finally {
        h.db.close();
      }
    });
  }
}

test("failed Reset of an unreadable row keeps its corrupt intent and receipt atomically until deliberate exact retry", () => {
  const h = harness();
  try {
    h.setup();
    h.save(h.choose());
    h.db
      .prepare("UPDATE agent_personal_output_voice SET choice_json=?")
      .run("{broken");
    const row = () =>
      h.db.prepare("SELECT * FROM agent_personal_output_voice").get()!;
    const before = row();
    const request = h.body(h.read(), defaultChoice);
    h.db.exec(
      "CREATE TRIGGER fail_corrupt_reset AFTER UPDATE ON agent_personal_output_voice BEGIN SELECT RAISE(ABORT,'TEST Reset storage failure'); END",
    );
    assert.throws(() => h.save(request), /TEST Reset storage failure/);
    assert.deepEqual(row(), before);
    h.db.exec("DROP TRIGGER fail_corrupt_reset");
    const reset = h.save(request);
    assert.equal(reset.revision, 2);
    assert.deepEqual(reset.saved, { choice: defaultChoice, label: "" });
    assert.equal(row().last_request_id, request.requestId);
    assert.deepEqual(h.save(request), reset);
  } finally {
    h.db.close();
  }
});

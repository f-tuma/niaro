import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { LoopsStore } from "../apps/server-identity/loops";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import {
  startLoopToolDetails,
  finishLoopToolDetails,
} from "../apps/server-identity/loop-tool-details";

const at = "2026-10-02T08:00:00.000Z";
const runId = (name: string) =>
  createHash("sha256").update(`TEST-mastra-loop-${name}`).digest("hex");

function fixture(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS organization(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY,name TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,name TEXT NOT NULL) STRICT;
    INSERT OR IGNORE INTO organization VALUES('org-a'),('org-b');
    INSERT OR IGNORE INTO user VALUES('alice','TEST Alice'),('bob','TEST Bob');
    INSERT OR IGNORE INTO agent_workspace VALUES('workspace-a','org-a','TEST One'),('workspace-b','org-b','TEST Foreign');`);
  const catalog = new ServiceCatalogStore(db, "TEST-mastra-loops-secret", []);
  const loops = new LoopsStore(db, catalog);
  const save = (name: string, value: unknown, foreign = false) => {
    const id = runId(name);
    catalog.saveTurn(
      id,
      foreign ? "workspace-b" : "workspace-a",
      foreign ? "bob" : "alice",
      value,
    );
    return id;
  };
  return { db, catalog, loops, save };
}

function nativeTurn(changes: Record<string, unknown> = {}) {
  return {
    kind: "mastra-1",
    text: "TEST find a contact",
    modelCalls: 1,
    inference: 1,
    operations: [],
    receipts: [],
    answer: { reply: "TEST result is ready" },
    trace: {
      startedAt: at,
      finishedAt: at,
      status: "succeeded",
      truncated: false,
      steps: [
        {
          id: "native-model",
          kind: "model",
          label: "Model request",
          status: "succeeded",
          startedAt: at,
          finishedAt: at,
          details: [],
        },
        {
          id: "native-tool",
          kind: "tool",
          label: "find_service",
          callId: "TEST-native-call",
          status: "succeeded",
          startedAt: at,
          finishedAt: at,
          details: [],
        },
      ],
    },
    ...changes,
  };
}

test("Mastra recorded loops remain organization scoped and preserve native trace", () => {
  const f = fixture();
  try {
    const own = f.save("own", nativeTurn());
    const foreign = f.save("foreign", nativeTurn(), true);
    f.save("unsupported", nativeTurn({ kind: "future-runtime" }));

    const page = f.loops.page({ organizationId: "org-a" });
    assert.deepEqual(
      page.entries.map((entry) => entry.id),
      [own],
    );
    assert.equal(page.entries[0]?.toolCalls, 1);
    assert.equal(page.entries[0]?.traceMode, "recorded");
    assert.deepEqual(
      f.loops.page({ organizationId: "org-a", workspaceId: "workspace-b" })
        .entries,
      [],
    );
    assert.equal(f.loops.detail("org-a", foreign), null);
    assert.equal(f.loops.detail("org-b", own), null);
    assert.equal(f.loops.detail("org-a", runId("unsupported")), null);
    assert.deepEqual(
      f.loops.detail("org-a", own)?.nodes.map((node) => node.id),
      ["request", "native-model", "native-tool", "reply"],
    );
  } finally {
    f.db.close();
  }
});

test("opening Loops does not infer retirement from a persisted native running trace", () => {
  const f = fixture();
  try {
    const running = nativeTurn({
      answer: undefined,
      trace: {
        startedAt: at,
        finishedAt: null,
        status: "running",
        truncated: false,
        steps: [
          {
            id: "native-running-model",
            kind: "model",
            label: "Model request",
            status: "running",
            startedAt: at,
            finishedAt: null,
            details: [],
          },
        ],
      },
    });
    const id = f.save("native-running", running);
    const reopened = new LoopsStore(f.db, f.catalog);
    const detail = reopened.detail("org-a", id)!;
    assert.equal(detail.run.status, "running");
    assert.equal(detail.run.statusEvidence, "last_saved_unverified");
    assert.equal(detail.run.finishedAt, null);
    assert.equal(
      detail.nodes.find((node) => node.kind === "model")?.status,
      "running",
    );
    assert.deepEqual(
      f.catalog.turn(id, "workspace-a", "alice"),
      JSON.parse(JSON.stringify(running)),
      "Passive Loops construction cannot replace native retirement proof",
    );
    assert.equal(
      reopened.page({ organizationId: "org-a", status: "running" }).entries[0]
        ?.id,
      id,
    );
    assert.equal(
      f.loops.detail("org-a", id)?.run.statusEvidence,
      undefined,
      "a run created after this store started has no restart warning",
    );
  } finally {
    f.db.close();
  }
});

test("diagnostic-only terminal candidates are shown as unconfirmed without raw diagnostics", () => {
  const f = fixture();
  try {
    const id = f.save(
      "unconfirmed-candidate",
      nativeTurn({
        answer: undefined,
        terminalCandidate: "execution",
        providerDiagnostic: "TEST PRIVATE PROVIDER DIAGNOSTIC",
        trace: {
          startedAt: at,
          finishedAt: null,
          status: "running",
          truncated: false,
          steps: [],
        },
      }),
    );
    const detail = f.loops.detail("org-a", id)!;
    assert.equal(detail.run.unconfirmedFailure, true);
    assert.equal(detail.run.status, "running");
    assert.deepEqual(detail.nodes.at(-1), {
      id: "unconfirmed-outcome",
      kind: "error",
      label: "Unconfirmed outcome",
      status: "unknown",
      startedAt: null,
      finishedAt: null,
      details: [
        {
          label: "Outcome",
          value: "unconfirmed_failure",
        },
      ],
    });
    assert(
      !JSON.stringify(detail).includes("TEST PRIVATE PROVIDER DIAGNOSTIC"),
    );

    const unknownId = f.save(
      "unknown-candidate",
      nativeTurn({
        answer: undefined,
        terminalCandidate: "TEST PRIVATE RAW DIAGNOSTIC",
        trace: {
          startedAt: at,
          finishedAt: null,
          status: "running",
          truncated: false,
          steps: [],
        },
      }),
    );
    const unknown = f.loops.detail("org-a", unknownId)!;
    assert.equal(unknown.run.unconfirmedFailure, undefined);
    assert(!unknown.nodes.some((node) => node.id === "unconfirmed-outcome"));
    assert(!JSON.stringify(unknown).includes("TEST PRIVATE RAW DIAGNOSTIC"));
  } finally {
    f.db.close();
  }
});

test("Mastra missing trace never reconstructs historical transcripts", () => {
  const f = fixture();
  try {
    const id = f.save(
      "no-trace",
      nativeTurn({
        trace: undefined,
        clock: { referenceNow: at },
        transcript: [
          {
            role: "assistant",
            content: "TEST PRIVATE REASONING",
            tool_calls: [
              {
                id: "TEST-impostor-call",
                function: { name: "find_service", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "TEST-impostor-call",
            content: '{"status":"succeeded"}',
          },
        ],
      }),
    );
    const detail = f.loops.detail("org-a", id)!;
    assert.equal(detail.run.toolCalls, 0);
    assert.deepEqual(
      detail.nodes.map((node) => node.kind),
      ["request", "reply"],
    );
    assert(!JSON.stringify(detail).includes("TEST PRIVATE REASONING"));
  } finally {
    f.db.close();
  }
});

test("native turns without a trace remain unconfirmed after restart", () => {
  const f = fixture();
  try {
    const id = f.save(
      "missing-trace-no-result",
      nativeTurn({
        answer: undefined,
        trace: undefined,
        terminalCandidate: undefined,
      }),
    );
    const reopened = new LoopsStore(f.db, f.catalog);
    const detail = reopened.detail("org-a", id)!;
    assert.equal(detail.run.status, "unknown");
    assert.equal(detail.run.statusEvidence, "last_saved_unverified");
    assert.equal(detail.run.finishedAt, null);
    assert.equal(detail.run.traceMode, "reconstructed");
  } finally {
    f.db.close();
  }
});

test("Mastra safe tool evidence survives persistence and API projection without private payloads", () => {
  const f = fixture();
  try {
    const value = nativeTurn();
    const tool = finishLoopToolDetails(
      startLoopToolDetails("find_actions", {
        service: "TEST CRM",
        need: "contacts",
      }),
      {
        status: "succeeded",
        output: {
          service: "TEST CRM",
          actions: [
            {
              name: "Find contact",
              tool: "action_TEST_lookup",
              effect: "read",
              description: "TEST PRIVATE DESCRIPTION",
            },
          ],
        },
      },
    );
    const step = { ...value.trace.steps[1]!, tool };
    const id = f.save("tool-evidence", {
      ...value,
      trace: { ...value.trace, steps: [value.trace.steps[0], step] },
    });
    const detail = f.loops.detail("org-a", id)!;
    const exposed = detail.nodes.find((node) => node.id === step.id)?.tool;
    assert.deepEqual(exposed, tool);
    assert.equal(exposed?.name, "find_actions");
    assert.equal(exposed?.outputRecorded, true);
    assert(!JSON.stringify(detail).includes("TEST PRIVATE DESCRIPTION"));
    assert.equal(f.loops.detail("org-b", id), null);

    const poisoned = {
      ...tool,
      output: [
        ...tool.output,
        { label: "Payload", value: "TEST STORED RAW BODY" },
      ],
    };
    const poisonedId = f.save("poisoned-evidence", {
      ...value,
      trace: { ...value.trace, steps: [{ ...step, tool: poisoned }] },
    });
    assert(
      !JSON.stringify(f.loops.detail("org-a", poisonedId)).includes(
        "TEST STORED RAW BODY",
      ),
    );
  } finally {
    f.db.close();
  }
});

test("invalid trace metadata is reported as unavailable evidence rather than a recorded graph", () => {
  const f = fixture();
  try {
    const id = f.save(
      "invalid-trace",
      nativeTurn({
        trace: {
          status: "succeeded",
          steps: [{ tool: { payload: "TEST PRIVATE RAW" } }],
        },
      }),
    );
    const detail = f.loops.detail("org-a", id)!;
    assert.equal(detail.run.traceMode, "reconstructed");
    assert.deepEqual(
      detail.nodes.map((node) => node.kind),
      ["request", "reply"],
    );
    assert(!JSON.stringify(detail).includes("TEST PRIVATE RAW"));
  } finally {
    f.db.close();
  }
});

test("native storage stays adjacent to the same persistent identity database", () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-mastra-loops-"));
  const file = join(directory, "identity with spaces.sqlite");
  try {
    const first = fixture(file);
    const expected = pathToFileURL(`${file}.mastra.sqlite`).href;
    assert.equal(first.catalog.nativeStorageUrl, expected);
    const saved = first.save("retained", nativeTurn());
    first.db.close();

    const reopened = fixture(file);
    try {
      assert.equal(reopened.catalog.nativeStorageUrl, expected);
      assert.equal(reopened.loops.detail("org-a", saved)?.run.id, saved);
    } finally {
      reopened.db.close();
    }
    const memory = fixture();
    try {
      assert.equal(memory.catalog.nativeStorageUrl, ":memory:");
    } finally {
      memory.db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

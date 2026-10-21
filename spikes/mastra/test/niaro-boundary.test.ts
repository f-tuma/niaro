import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNiaroBoundary, TEST_SCOPE } from "../src/niaro-boundary.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "niaro-mastra-boundary-"));
  let boundary = createNiaroBoundary(directory);
  return {
    get boundary() {
      return boundary;
    },
    restart() {
      boundary.close();
      boundary = createNiaroBoundary(directory);
    },
    close() {
      boundary.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("real Niaro proposal survives restart; exact approval and replay dispatch once", async () => {
  const h = fixture();
  try {
    const prepared = await h.boundary.prepare(TEST_SCOPE, "TEST-create-1", {
      name: "TEST Ada",
    });
    assert.equal(prepared.status, "awaiting_approval");
    assert.equal(h.boundary.dispatchCount(), 0);
    assert.deepEqual(h.boundary.verify(TEST_SCOPE, prepared.id), {
      found: false,
    });
    h.restart();
    assert.deepEqual(h.boundary.read(TEST_SCOPE, prepared.id), prepared);
    const approved = await h.boundary.approve(TEST_SCOPE, prepared.id);
    assert.equal(approved.status, "succeeded");
    assert.equal(h.boundary.dispatchCount(), 1);
    assert.equal(
      h.boundary.verify(TEST_SCOPE, prepared.id).person?.name,
      "TEST Ada",
    );
    h.restart();
    assert.deepEqual(
      await h.boundary.approve(TEST_SCOPE, prepared.id),
      approved,
    );
    assert.deepEqual(
      await h.boundary.prepare(TEST_SCOPE, prepared.id, { name: "TEST Ada" }),
      approved,
    );
    await assert.rejects(
      h.boundary.prepare(TEST_SCOPE, prepared.id, { name: "TEST Different" }),
      { code: "catalog_conflict" },
    );
    assert.equal(h.boundary.dispatchCount(), 1);
  } finally {
    h.close();
  }
});

test("a dispatched lost response stays unknown and restart/replay cannot resend it", async () => {
  const h = fixture();
  try {
    const prepared = await h.boundary.prepare(
      TEST_SCOPE,
      "TEST-lost-response",
      { name: "TEST Jana" },
    );
    h.boundary.setLoseResponse(true);
    const unknown = await h.boundary.approve(TEST_SCOPE, prepared.id);
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.result, undefined);
    assert.equal(unknown.failure?.retry, "verify_first");
    assert.equal(h.boundary.dispatchCount(), 1);
    assert.equal(
      h.boundary.verify(TEST_SCOPE, prepared.id).person?.name,
      "TEST Jana",
    );
    h.restart();
    assert.deepEqual(
      await h.boundary.approve(TEST_SCOPE, prepared.id),
      unknown,
    );
    assert.deepEqual(
      await h.boundary.prepare(TEST_SCOPE, prepared.id, { name: "TEST Jana" }),
      unknown,
    );
    assert.equal(h.boundary.dispatchCount(), 1);
  } finally {
    h.close();
  }
});

test("decline is durable and neither approval nor command replay can execute it", async () => {
  const h = fixture();
  try {
    const prepared = await h.boundary.prepare(TEST_SCOPE, "TEST-declined", {
      name: "TEST Declined Person",
    });
    const rejected = await h.boundary.reject(TEST_SCOPE, prepared.id);
    assert.equal(rejected.status, "rejected");
    assert.equal(h.boundary.dispatchCount(), 0);
    h.restart();
    assert.deepEqual(h.boundary.read(TEST_SCOPE, prepared.id), rejected);
    assert.deepEqual(
      await h.boundary.reject(TEST_SCOPE, prepared.id),
      rejected,
    );
    assert.deepEqual(
      await h.boundary.approve(TEST_SCOPE, prepared.id),
      rejected,
    );
    assert.deepEqual(
      await h.boundary.prepare(TEST_SCOPE, prepared.id, {
        name: "TEST Declined Person",
      }),
      rejected,
    );
    assert.deepEqual(h.boundary.verify(TEST_SCOPE, prepared.id), {
      found: false,
    });
    assert.equal(h.boundary.dispatchCount(), 0);
  } finally {
    h.close();
  }
});

test("foreign scopes and durable revocation cannot approve or inspect an operation", async () => {
  const h = fixture();
  try {
    const prepared = await h.boundary.prepare(TEST_SCOPE, "TEST-revoked", {
      name: "TEST Person",
    });
    const foreign = { ...TEST_SCOPE, userId: "TEST-other-user" };
    assert.throws(() => h.boundary.read(foreign, prepared.id), {
      code: "identity_forbidden",
    });
    assert.throws(() => h.boundary.verify(foreign, prepared.id), {
      code: "identity_forbidden",
    });
    await assert.rejects(h.boundary.approve(foreign, prepared.id), {
      code: "identity_forbidden",
    });
    h.boundary.revoke();
    h.restart();
    await assert.rejects(h.boundary.approve(TEST_SCOPE, prepared.id), {
      code: "identity_forbidden",
    });
    await assert.rejects(
      h.boundary.prepare(TEST_SCOPE, "TEST-after-revoke", {
        name: "TEST Person",
      }),
      { code: "identity_forbidden" },
    );
    assert.equal(h.boundary.dispatchCount(), 0);
  } finally {
    h.close();
  }
});

test("actual Niaro input validator refuses extra fields before receipt or dispatch", async () => {
  const h = fixture();
  try {
    await assert.rejects(
      h.boundary.prepare(TEST_SCOPE, "TEST-extra-field", {
        name: "TEST Person",
        approve: true,
      } as { name: string }),
      { code: "integration_input_invalid" },
    );
    assert.equal(h.boundary.read(TEST_SCOPE, "TEST-extra-field"), undefined);
    assert.equal(h.boundary.dispatchCount(), 0);
  } finally {
    h.close();
  }
});

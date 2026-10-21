import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { openIdentity } from "../apps/server-identity/service";
import { CatalogCommand } from "../packages/protocol/service-catalog";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "niaro-identity-restore-"));
  const directory = join(root, "identity");
  return {
    root,
    secret: join(directory, "secret"),
    database: join(directory, "identity.sqlite"),
    config: ServerConfigSchema.parse({
      version: 1,
      name: "TEST identity restore preflight",
      listen: { port: 42371 },
      dataDirectory: join(root, "workflow"),
      allowedOrigins: [],
      administration: {
        keyFile: join(root, "key"),
        identity: { directory, baseURL: "http://127.0.0.1:42371" },
      },
      adapters: {
        model: { provider: "fixture" },
        voice: { provider: "disabled" },
        crm: { provider: "disabled" },
        calendar: { provider: "simulated" },
      },
    }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
const digest = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

test("existing identity database cannot regenerate a missing secret; original key restores the same database and releases the failed owner lock", async () => {
  const h = fixture();
  try {
    const original = await openIdentity(h.config);
    await original.close();
    const key = readFileSync(h.secret);
    const before = digest(h.database);
    unlinkSync(h.secret);

    await assert.rejects(async () => {
      const unexpected = await openIdentity(h.config);
      await unexpected.close();
    }, /Existing identity database requires its original secret/);
    assert.equal(existsSync(h.secret), false);
    assert.equal(digest(h.database), before);

    writeFileSync(h.secret, key, { mode: 0o600, flag: "wx" });
    const restored = await openIdentity(h.config);
    await restored.close();
    assert.deepEqual(readFileSync(h.secret), key);
  } finally {
    h.close();
  }
});

test("fresh identity seeds its OAuth resource and retains configuration and its private secret across normal reopen", async () => {
  const h = fixture();
  try {
    const first = await openIdentity(h.config);
    const resources = first["db"]
      .prepare('SELECT * FROM "oauthResource" ORDER BY identifier')
      .all();
    assert.equal(
      resources.length,
      1,
      "OAuth configuration must exist on first boot",
    );
    assert.equal(resources[0]!.identifier, "http://127.0.0.1:42371/mcp");
    assert.deepEqual(JSON.parse(String(resources[0]!.allowedScopes)), [
      "native.view",
      "native.run",
      "services.call",
    ]);
    await first.close();
    const key = readFileSync(h.secret);
    const databaseBytes = readFileSync(h.database);
    assert.match(key.toString(), /^[A-Za-z0-9_-]{64}$/);
    assert.equal(statSync(h.secret).mode & 0o077, 0);
    const reopened = await openIdentity(h.config);
    assert.deepEqual(
      reopened["db"]
        .prepare('SELECT * FROM "oauthResource" ORDER BY identifier')
        .all(),
      resources,
    );
    assert.equal(
      existsSync(h.database + "-wal") ? statSync(h.database + "-wal").size : 0,
      0,
      "Unchanged reopen must not write delayed configuration into the WAL",
    );
    await reopened.close();
    assert.deepEqual(readFileSync(h.secret), key);
    assert.deepEqual(readFileSync(h.database), databaseBytes);
  } finally {
    h.close();
  }
});

test("an OAuth resource created before connector mode gains its scope on reopen", async () => {
  const h = fixture();
  try {
    const first = await openIdentity(h.config);
    first["db"]
      .prepare('UPDATE "oauthResource" SET "allowedScopes"=?')
      .run(JSON.stringify(["native.view", "native.run"]));
    await first.close();
    const reopened = await openIdentity(h.config);
    const [resource] = reopened["db"]
      .prepare('SELECT "allowedScopes" FROM "oauthResource"')
      .all();
    assert.deepEqual(JSON.parse(String(resource!.allowedScopes)), [
      "native.view",
      "native.run",
      "services.call",
    ]);
    await reopened.close();
  } finally {
    h.close();
  }
});

test("malformed restored secret is rejected without replacing it or mutating the database", async () => {
  const h = fixture();
  try {
    const original = await openIdentity(h.config);
    await original.close();
    const before = digest(h.database);
    writeFileSync(h.secret, "TEST incomplete restored secret", { mode: 0o600 });
    await assert.rejects(openIdentity(h.config), /Invalid identity secret/);
    assert.equal(
      readFileSync(h.secret, "utf8"),
      "TEST incomplete restored secret",
    );
    assert.equal(digest(h.database), before);
  } finally {
    h.close();
  }
});

test("valid-format wrong key is not bootstrap proof: synthetic provider decryption fails without credential replacement and the original key recovers it", async () => {
  const h = fixture();
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  try {
    const original = await openIdentity(h.config);
    const providerId = original["catalog"].store.command(
      CatalogCommand.parse({
        organizationId,
        workspaceId,
        type: "saveProvider",
        revision: 0,
        apiKey: "TEST-original-encrypted-provider-key",
        settings: {
          name: "TEST restore crypto canary",
          url: "https://models.example.test/v1",
          enabled: true,
          dailyRequestLimit: 10,
        },
      }),
    );
    const row = original["db"]
      .prepare("SELECT secret FROM agent_catalog WHERE id=?")
      .get(providerId)!.secret;
    await original.close();
    const key = readFileSync(h.secret);
    const wrongKey =
      "A".repeat(64) === key.toString() ? "B".repeat(64) : "A".repeat(64);
    writeFileSync(h.secret, wrongKey, { mode: 0o600 });
    const wrong = await openIdentity(h.config);
    try {
      assert.throws(() =>
        wrong["catalog"].store.provider(organizationId, providerId),
      );
      assert.equal(
        wrong["db"]
          .prepare("SELECT secret FROM agent_catalog WHERE id=?")
          .get(providerId)!.secret,
        row,
      );
      assert.equal(readFileSync(h.secret, "utf8"), wrongKey);
    } finally {
      await wrong.close();
    }
    writeFileSync(h.secret, key, { mode: 0o600 });
    const recovered = await openIdentity(h.config);
    try {
      assert.equal(
        recovered["catalog"].store.provider(organizationId, providerId).key,
        "TEST-original-encrypted-provider-key",
      );
      assert.equal(
        recovered["db"]
          .prepare("SELECT secret FROM agent_catalog WHERE id=?")
          .get(providerId)!.secret,
        row,
      );
    } finally {
      await recovered.close();
    }
  } finally {
    h.close();
  }
});

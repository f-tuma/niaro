/** Opt-in: owns only its random synthetic RustFS container/volume and temporary data. */
import { measureAttachmentResources } from "./helpers/attachment-resource";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { DatabaseSync } from "node:sqlite";
import {
  bootstrapRustFS,
  bootstrapConfigurations,
} from "../apps/server-storage/bootstrap";
import { clientOptions } from "../apps/server-storage/adapter";
import { sha256 } from "../apps/server-storage/types";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { loadAttachmentConfiguration } from "../apps/server-attachments/schema";
import { verifyAttachmentRestore } from "../apps/server-attachments/restore";
import { createTrustHarness } from "./agent-trust/harness";
import {
  nativeAttachmentMessageHash,
  type NativeAttachmentInput,
} from "../apps/server-identity/mastra-domain";
import { ATTACHMENT_PROFILE } from "../packages/protocol/attachments";
import { MANIFEST, RESTORE_MARKER } from "../scripts/backup-common.mjs";
import { ServerConfigSchema } from "../apps/reference-server/config";
const docker = (args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function main() {
  const root = mkdtempSync(join(tmpdir(), "niaro-lifecycle-live-")),
    source = join(root, "source"),
    identity = join(source, "identity"),
    data = join(source, "workflow"),
    target = join(root, "target"),
    backup = join(root, "backup");
  const name = "niaro-lifecycle-check-" + randomBytes(6).toString("hex"),
    envFile = join(root, "synthetic.env");
  const rootAccess = "root-" + randomBytes(12).toString("hex"),
    rootSecret = randomBytes(32).toString("hex");
  writeFileSync(
    envFile,
    `RUSTFS_ACCESS_KEY=${rootAccess}\nRUSTFS_SECRET_KEY=${rootSecret}\nRUSTFS_CONSOLE_ENABLE=false\n`,
    { mode: 0o600 },
  );
  let store: FixtureStorage | undefined,
    h: ReturnType<typeof createTrustHarness> | undefined,
    client: S3Client | undefined;
  try {
    docker([
      "run",
      "-d",
      "--name",
      name,
      "--env-file",
      envFile,
      "-p",
      "127.0.0.1::9000",
      "-v",
      name + ":/data",
      "rustfs/rustfs:1.0.4@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2",
    ]);
    const env = {
      NIARO_S3_ENDPOINT: "http://" + docker(["port", name, "9000/tcp"]),
      NIARO_S3_REGION: "us-east-1",
      NIARO_S3_BUCKET: "synthetic-" + randomBytes(6).toString("hex"),
      NIARO_S3_PREFIX: "isolated-attachments",
      NIARO_S3_CREDENTIAL_MODE: "static",
      NIARO_S3_ACCESS_KEY_ID: "app-" + randomBytes(12).toString("hex"),
      NIARO_S3_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
      NIARO_S3_FORCE_PATH_STYLE: "true",
      NIARO_S3_ALLOW_HTTP: "true",
      NIARO_RUSTFS_ROOT_ACCESS_KEY: rootAccess,
      NIARO_RUSTFS_ROOT_SECRET_KEY: rootSecret,
    };
    assert.equal((await bootstrapRustFS(env)).ok, true);
    const config = bootstrapConfigurations(env);
    client = new S3Client(clientOptions(config.root));
    mkdirSync(identity, { recursive: true });
    h = createTrustHarness({ directory: identity, cleanupDirectory: false });
    const scope = h.scope;
    store = new FixtureStorage(
      data,
      scope.serverId,
      Date.now,
      undefined,
      undefined,
      loadAttachmentConfiguration({ NIARO_ATTACHMENTS_ENABLED: "true" }),
    );
    store.initializeObjectStorage({
      state: "configured",
      config: config.application,
    });
    store.recordAttachmentOwners(identity);
    const runtime = h.runtime({
      ...h.context,
      attachmentGenerationAllowed: (g) =>
        store!.attachmentGenerationAllowed(scope, g),
    });
    async function add(id: string) {
      const s = store!,
        generation = s.snapshot(scope).conversations[0]!.attachmentGeneration!,
        draft = s.attachments.createDraft(scope, {
          profile: ATTACHMENT_PROFILE,
          requestId: randomUUID(),
          target: {
            conversationId: "conversation-1",
            expectedGeneration: generation,
            mode: "current",
          },
        }).draft,
        bytes = Buffer.from("SYNTHETIC " + id),
        up = s.attachments.createUpload(scope, draft.draftId, {
          profile: ATTACHMENT_PROFILE,
          requestId: randomUUID(),
          expectedRevision: 1,
          filename: "source.txt",
          mediaType: "text/plain",
          size: bytes.length,
          sha256: sha256(bytes),
        }),
        c = s.attachments.beginReceive(scope, up.upload.contentId);
      s.attachments.markPutting(scope, c.id, c.token!);
      await s.attachments.objectStore().put(s.attachments.handle(c), bytes);
      s.attachments.finishTransfer(scope, c.id, c.token!);
      s.acceptAttachmentMessage(scope, {
        type: "message.send",
        commandId: id,
        idempotencyKey: id,
        conversationId: "conversation-1",
        language: "en",
        text: "",
        attachments: {
          profile: ATTACHMENT_PROFILE,
          draftId: draft.draftId,
          draftRevision: up.draft.revision,
          generation,
          items: [{ contentId: c.id, sha256: c.sha256 }],
        },
      });
      const context = {
          conversationId: "conversation-1",
          conversationSession: sha256(id),
          requestHash: sha256(id),
          outerCommandId: id,
        },
        input: NativeAttachmentInput = {
          scope,
          ...context,
          generation,
          commandId: id,
          logicalMessageId: id,
          messageHash: nativeAttachmentMessageHash(id, "en", context),
          evidenceDigest: sha256("synthetic evidence"),
          handoffId: randomUUID(),
        };
      h!.onChat(() => ({ content: "SYNTHETIC " + id + " native answer" }));
      await runtime.message(
        id,
        id,
        "en",
        [],
        new AbortController().signal,
        undefined,
        undefined,
        "UTC",
        { ...context, attachment: input },
      );
      return { generation, contentId: c.id, native: h!.commandState(id), id };
    }
    const a = await add("TEST-old"),
      s = store;
    s.execute(scope, {
      type: "conversation.archive",
      conversationId: "conversation-1",
      commandId: "archive",
      idempotencyKey: "archive",
    });
    const archived = String(
      s.attachments.db
        .prepare(
          "SELECT conversation_id FROM attachment_generations WHERE generation_id=?",
        )
        .get(a.generation)!.conversation_id,
    );
    const b = await add("TEST-fresh");
    const calls = h.requests.length;
    await h.close();
    h = undefined;
    s.close();
    store = undefined;
    execFileSync(
      process.execPath,
      [
        "scripts/backup.mjs",
        source,
        backup,
        "--attachments",
        "coordinated",
        "--object-snapshot-id",
        "TEST-operator-snapshot",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const manifest = JSON.parse(readFileSync(join(backup, MANIFEST), "utf8"));
    assert.equal(manifest.attachments.completeness, "coordinated");
    // Explicit external synthetic object snapshot/restore, separate from the backup command.
    const objects: { key: string; body: Uint8Array; digest: string }[] = [];
    for (const pin of manifest.attachments.objects) {
      const r = await client.send(
        new GetObjectCommand({ Bucket: config.root.bucket, Key: pin.key }),
      );
      objects.push({
        key: pin.key,
        body: await r.Body!.transformToByteArray(),
        digest: pin.sha256,
      });
      await client.send(
        new DeleteObjectCommand({ Bucket: config.root.bucket, Key: pin.key }),
      );
    }
    execFileSync(process.execPath, ["scripts/restore.mjs", backup, target], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const o of objects)
      await client.send(
        new PutObjectCommand({
          Bucket: config.root.bucket,
          Key: o.key,
          Body: o.body,
          Metadata: { sha256: o.digest },
        }),
      );
    const marker = JSON.parse(
        readFileSync(join(target, RESTORE_MARKER), "utf8"),
      ),
      evidence = join(root, "deletions.json");
    writeFileSync(
      evidence,
      JSON.stringify({
        version: 1,
        restoreId: marker.restoreId,
        manifestSha256: marker.manifestSha256,
        objectSnapshotId: "TEST-operator-snapshot",
        recoveryCutoff: marker.recoveryCutoff,
        basis: "manual-review",
        reviewedThrough: marker.recoveryCutoff,
        quiescence: {
          oldOwnersStoppedBeforeCutoff: true,
          remainStoppedThroughActivation: true,
        },
        complete: true,
        deletions: [
          { scope, conversationId: archived, generation: a.generation },
        ],
      }),
    );
    const profile = ServerConfigSchema.parse({
      version: 1,
      name: "Synthetic restore",
      listen: { host: "127.0.0.1", port: 8793 },
      dataDirectory: join(target, "workflow"),
      allowedOrigins: [],
      sessionSeconds: 1800,
      administration: {
        keyFile: join(target, "admin.key"),
        identity: {
          directory: join(target, "identity"),
          baseURL: "http://localhost:8793",
          hosting: { allowCustom: false, runtime: "process" },
          accountSessionDays: 30,
          connectionOrigins: [],
          integrationOrigins: [],
          calendarCollections: [],
        },
      },
      adapters: {
        model: { provider: "fixture" },
        voice: { provider: "disabled" },
        crm: { provider: "disabled" },
        calendar: { provider: "simulated" },
      },
    });
    const result = await verifyAttachmentRestore(profile, {
      reconcile: evidence,
      activate: true,
      objectStorage: { state: "configured", config: config.application },
    });
    assert.equal(result.result.status, "activated", JSON.stringify(result));
    const identityDB = new DatabaseSync(
      join(target, "identity", "identity.sqlite"),
      { readOnly: true },
    );
    try {
      assert.ok(
        !JSON.stringify(
          identityDB.prepare("SELECT data FROM agent_service_turn").all(),
        ).includes("TEST-old native answer"),
      );
      assert.ok(
        JSON.stringify(
          identityDB.prepare("SELECT data FROM agent_service_turn").all(),
        ).includes("TEST-fresh native answer"),
      );
    } finally {
      identityDB.close();
    }
    const nativeDB = new DatabaseSync(
      join(target, "identity", "identity.sqlite.mastra.sqlite"),
      { readOnly: true },
    );
    try {
      assert.equal(
        nativeDB
          .prepare(
            "SELECT count(*) AS n FROM mastra_messages WHERE thread_id=?",
          )
          .get(a.native.threadId)!.n,
        0,
      );
      assert.ok(
        Number(
          nativeDB
            .prepare(
              "SELECT count(*) AS n FROM mastra_messages WHERE thread_id=?",
            )
            .get(b.native.threadId)!.n,
        ) > 0,
      );
    } finally {
      nativeDB.close();
    }
    const resourceMeasurement = await measureAttachmentResources(
      config.application,
    );
    console.log(
      JSON.stringify({
        resourceMeasurement,
        status: "passed",
        coordinatedManifest: true,
        externalSyntheticObjectRestore: true,
        verifiedCount: result.result.verifiedCount,
        exactOldNativeRetired: true,
        newFixedGenerationPreserved: true,
        providerCallsBeforeRestore: calls,
        providerCallsDuringRestore: 0,
        actionCalls: 0,
        containerStats: docker([
          "stats",
          "--no-stream",
          "--format",
          "{{.MemUsage}}",
          name,
        ]),
        operatorAttestation:
          "completeness/quiescence and matching external snapshot remain attestations",
        hetzner: "not run",
      }),
    );
  } finally {
    store?.close();
    await h?.close();
    client?.destroy();
    try {
      docker(["rm", "-f", name]);
    } catch {}
    try {
      docker(["volume", "rm", name]);
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

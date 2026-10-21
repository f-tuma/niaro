import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import {
  CHAT_SEARCH_FTS,
  CHAT_SEARCH_FTS_SHADOW,
  CHAT_SEARCH_FTS_SQL,
} from "../fixture-server/chat-search-schema";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CommandSchema, ScopeSchema, sameScope } from "../../packages/protocol";
import { IdentityId } from "../../packages/protocol/identity";
import {
  legacyQuestionCandidate,
  legacyQuestionConsumedRoot,
  LegacyQuestionSchema,
} from "./legacy-question";
import { processDigest } from "./process-validation";
import { JournalSchema } from "./service-process-journal";

/** Offline observation only. This module never constructs or resumes a runtime. */
export const LEGACY_INVENTORY_LIMITS = Object.freeze({
  entries: 10_000,
  tupleBytes: 1024 * 1024 * 1024,
  rows: 1000,
  rowBytes: 1024 * 1024,
  payloadBytes: 64 * 1024 * 1024,
  schemaEntries: 1000,
  schemaColumns: 256,
});
const NATIVE_MASTRA_STORAGE_PROFILE =
  "@mastra/core@1.74.0+@mastra/libsql@1.25.0" as const;
// Mastra initializes ancillary memory, tracing, and admin tables alongside the
// two run stores we count. Keep the pinned writer allowlist explicit so a new
// or application-owned table cannot silently pass as a complete inventory.
const NATIVE_MASTRA_KNOWN_TABLES = new Set([
  "mastra_agent_versions",
  "mastra_agents",
  "mastra_ai_spans",
  "mastra_background_tasks",
  "mastra_channel_config",
  "mastra_channel_installations",
  "mastra_dataset_items",
  "mastra_dataset_versions",
  "mastra_datasets",
  "mastra_experiment_results",
  "mastra_experiments",
  "mastra_favorites",
  "mastra_harness_sessions",
  "mastra_knowledge_activity",
  "mastra_knowledge_cursors",
  "mastra_knowledge_mentions",
  "mastra_knowledge_nodes",
  "mastra_knowledge_records",
  "mastra_knowledge_semantic_outbox",
  "mastra_mcp_client_versions",
  "mastra_mcp_clients",
  "mastra_mcp_server_versions",
  "mastra_mcp_servers",
  "mastra_messages",
  "mastra_notifications",
  "mastra_observational_memory",
  "mastra_prompt_block_versions",
  "mastra_prompt_blocks",
  "mastra_resources",
  "mastra_schedule_triggers",
  "mastra_schedules",
  "mastra_scorer_definition_versions",
  "mastra_scorer_definitions",
  "mastra_scorers",
  "mastra_skill_blobs",
  "mastra_skill_versions",
  "mastra_skills",
  "mastra_thread_state",
  "mastra_threads",
  "mastra_tool_provider_connections",
  "mastra_workflow_definitions",
  "mastra_workflow_snapshot",
  "mastra_workspace_versions",
  "mastra_workspaces",
]);
const NATIVE_MASTRA_TABLE_COLUMNS = {
  mastra_workflow_snapshot: [
    "workflow_name",
    "run_id",
    "resourceId",
    "snapshot",
    "createdAt",
    "updatedAt",
  ],
  mastra_background_tasks: [
    "id",
    "tool_call_id",
    "tool_name",
    "agent_id",
    "run_id",
    "thread_id",
    "resource_id",
    "status",
    "args",
    "result",
    "error",
    "suspend_payload",
    "retry_count",
    "max_retries",
    "timeout_ms",
    "createdAt",
    "startedAt",
    "suspendedAt",
    "completedAt",
    "ownerId",
    "leaseExpiresAt",
  ],
} as const;
const NATIVE_MASTRA_TABLE_SCHEMA = {
  mastra_workflow_snapshot: {
    types: ["TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT"],
    notNull: [],
    primaryKey: [],
    unique: [["workflow_name", "run_id"]],
  },
  mastra_background_tasks: {
    types: [
      "TEXT",
      "TEXT",
      "TEXT",
      "TEXT",
      "TEXT",
      "TEXT",
      "TEXT",
      "TEXT",
      "TEXT",
      "TEXT",
      "TEXT",
      "TEXT",
      "INTEGER",
      "INTEGER",
      "INTEGER",
      "TEXT",
      "TEXT",
      "TEXT",
      "TEXT",
      "TEXT",
      "TEXT",
    ],
    notNull: [
      "id",
      "tool_call_id",
      "tool_name",
      "agent_id",
      "run_id",
      "status",
      "args",
      "retry_count",
      "max_retries",
      "timeout_ms",
      "createdAt",
    ],
    primaryKey: ["id"],
    unique: [["id"]],
  },
} as const;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const RelativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  );
const Sidecar = z.discriminatedUnion("presence", [
  z.strictObject({ presence: z.literal("absent") }),
  z.strictObject({ presence: z.literal("present"), path: RelativePath }),
]);
export const LegacyInventoryManifestSchema = z.strictObject({
  profile: z.literal("niaro-legacy-inventory-snapshot/1"),
  tupleRoot: z.string().max(4096).refine(isAbsolute),
  roles: z.strictObject({
    identityDatabase: RelativePath,
    workflowDatabase: RelativePath,
    workflowServerId: RelativePath,
    originalSecret: RelativePath,
    configuration: RelativePath,
    administrationKey: RelativePath,
    nativeDatabases: z.array(RelativePath).max(32),
    ownerLocks: z.array(RelativePath).min(1).max(32),
  }),
  files: z
    .array(
      z.strictObject({
        path: RelativePath,
        sha256: Hash,
        size: z.number().int().nonnegative(),
        mode: z.number().int().min(0).max(0o777),
      }),
    )
    .max(LEGACY_INVENTORY_LIMITS.entries),
  directories: z
    .array(
      z.strictObject({
        path: z.union([z.literal("."), RelativePath]),
        mode: z.number().int().min(0).max(0o777),
      }),
    )
    .max(LEGACY_INVENTORY_LIMITS.entries),
  sqliteFamilies: z
    .array(z.strictObject({ main: RelativePath, wal: Sidecar, shm: Sidecar }))
    .max(64),
});
export type LegacyInventoryManifest = z.infer<
  typeof LegacyInventoryManifestSchema
>;
export type InventoryFailureCode =
  | "manifest_invalid"
  | "tuple_changed"
  | "tuple_limit"
  | "database_invalid"
  | "inventory_failed";
export class LegacyInventoryFailure extends Error {
  constructor(readonly code: InventoryFailureCode) {
    super(code);
  }
}
function requireCondition(
  value: unknown,
  code: InventoryFailureCode,
): asserts value {
  if (!value) throw new LegacyInventoryFailure(code);
}
function unchangedFile(a: Stats, b: Stats) {
  return (
    a.isFile() &&
    b.isFile() &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.ino === b.ino &&
    a.dev === b.dev &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function fileHash(file: string, expected: Stats) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    requireCondition(unchangedFile(expected, fstatSync(fd)), "tuple_changed");
    const buffer = Buffer.alloc(64 * 1024);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < expected.size) {
      const length = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, expected.size - offset),
        offset,
      );
      requireCondition(length > 0, "tuple_changed");
      hash.update(buffer.subarray(0, length));
      offset += length;
    }
    requireCondition(unchangedFile(expected, fstatSync(fd)), "tuple_changed");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
function copyBoundedFile(source: string, destination: string, size: number) {
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationFd: number | undefined;
  try {
    const before = fstatSync(sourceFd);
    requireCondition(
      before.isFile() &&
        before.size === size &&
        size <= LEGACY_INVENTORY_LIMITS.tupleBytes,
      "tuple_changed",
    );
    destinationFd = openSync(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < size) {
      const length = readSync(
        sourceFd,
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      requireCondition(length > 0, "tuple_changed");
      let written = 0;
      while (written < length)
        written += writeSync(
          destinationFd,
          buffer,
          written,
          length - written,
          offset + written,
        );
      offset += length;
    }
    requireCondition(
      unchangedFile(before, fstatSync(sourceFd)),
      "tuple_changed",
    );
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
  }
}
/** Enumerates regular files, including every explicit WAL/SHM absence. */
export function observeLegacyTuple(
  tupleRoot: string,
  roles: LegacyInventoryManifest["roles"],
): LegacyInventoryManifest {
  requireCondition(isAbsolute(tupleRoot), "manifest_invalid");
  requireCondition(
    tupleRoot === resolve(tupleRoot) && realpathSync(tupleRoot) === tupleRoot,
    "manifest_invalid",
  );
  const files: LegacyInventoryManifest["files"] = [];
  const directories: LegacyInventoryManifest["directories"] = [];
  let bytes = 0;
  const walk = (relative = ".") => {
    requireCondition(
      relative === "." || RelativePath.safeParse(relative).success,
      "manifest_invalid",
    );
    const path = relative === "." ? tupleRoot : join(tupleRoot, relative);
    const stat = lstatSync(path);
    requireCondition(!stat.isSymbolicLink(), "manifest_invalid");
    requireCondition(
      files.length + directories.length < LEGACY_INVENTORY_LIMITS.entries,
      "tuple_limit",
    );
    if (stat.isDirectory()) {
      directories.push({ path: relative, mode: stat.mode & 0o777 });
      const directory = opendirSync(path);
      try {
        let child;
        while ((child = directory.readSync()))
          walk(relative === "." ? child.name : relative + "/" + child.name);
      } finally {
        directory.closeSync();
      }
    } else {
      requireCondition(stat.isFile(), "manifest_invalid");
      bytes += stat.size;
      requireCondition(
        bytes <= LEGACY_INVENTORY_LIMITS.tupleBytes,
        "tuple_limit",
      );
      files.push({
        path: relative,
        size: stat.size,
        mode: stat.mode & 0o777,
        sha256: fileHash(path, stat),
      });
    }
  };
  walk();
  const byPath = (a: { path: string }, b: { path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  files.sort(byPath);
  directories.sort(byPath);
  const names = new Set(files.map((file) => file.path));
  const sqliteFamilies = files
    .filter((file) => file.path.toLowerCase().endsWith(".sqlite"))
    .map((file) => ({
      main: file.path,
      wal: names.has(file.path + "-wal")
        ? { presence: "present" as const, path: file.path + "-wal" }
        : { presence: "absent" as const },
      shm: names.has(file.path + "-shm")
        ? { presence: "present" as const, path: file.path + "-shm" }
        : { presence: "absent" as const },
    }));
  return LegacyInventoryManifestSchema.parse({
    profile: "niaro-legacy-inventory-snapshot/1",
    tupleRoot,
    roles,
    files,
    directories,
    sqliteFamilies,
  });
}
function validateManifest(value: unknown) {
  const parsed = LegacyInventoryManifestSchema.safeParse(value);
  requireCondition(parsed.success, "manifest_invalid");
  const manifest = parsed.data;
  requireCondition(
    manifest.tupleRoot === resolve(manifest.tupleRoot),
    "manifest_invalid",
  );
  const entries = [...manifest.files, ...manifest.directories];
  requireCondition(
    entries.length <= LEGACY_INVENTORY_LIMITS.entries,
    "tuple_limit",
  );
  requireCondition(
    new Set(entries.map((entry) => entry.path.toLowerCase())).size ===
      entries.length,
    "manifest_invalid",
  );
  requireCondition(
    manifest.directories.some((entry) => entry.path === "."),
    "manifest_invalid",
  );
  requireCondition(
    manifest.files.reduce((sum, file) => sum + file.size, 0) <=
      LEGACY_INVENTORY_LIMITS.tupleBytes,
    "tuple_limit",
  );
  const names = new Set(manifest.files.map((file) => file.path));
  const rolePaths = [
    manifest.roles.identityDatabase,
    manifest.roles.workflowDatabase,
    manifest.roles.workflowServerId,
    manifest.roles.originalSecret,
    manifest.roles.configuration,
    manifest.roles.administrationKey,
    ...manifest.roles.nativeDatabases,
    ...manifest.roles.ownerLocks,
  ];
  requireCondition(
    new Set(rolePaths).size === rolePaths.length &&
      rolePaths.every((path) => names.has(path)),
    "manifest_invalid",
  );
  const databaseRoles = [
    manifest.roles.identityDatabase,
    manifest.roles.workflowDatabase,
    ...manifest.roles.nativeDatabases,
    ...manifest.roles.ownerLocks,
  ];
  requireCondition(
    databaseRoles.every((path) => path.endsWith(".sqlite")) &&
      ![...names].some(
        (path) =>
          /\.(?:db|sqlite3?)$/i.test(path) && !databaseRoles.includes(path),
      ),
    "manifest_invalid",
  );
  const canonicalNativeDatabase =
    manifest.roles.identityDatabase + ".mastra.sqlite";
  requireCondition(
    !names.has(canonicalNativeDatabase) ||
      manifest.roles.nativeDatabases.includes(canonicalNativeDatabase),
    "manifest_invalid",
  );
  const main = manifest.files
    .filter((file) => file.path.toLowerCase().endsWith(".sqlite"))
    .map((file) => file.path)
    .sort();
  requireCondition(
    JSON.stringify(main) ===
      JSON.stringify(
        manifest.sqliteFamilies.map((family) => family.main).sort(),
      ) && JSON.stringify(main) === JSON.stringify([...databaseRoles].sort()),
    "manifest_invalid",
  );
  for (const family of manifest.sqliteFamilies)
    for (const suffix of ["wal", "shm"] as const) {
      const part = family[suffix];
      requireCondition(
        part.presence === "present"
          ? part.path === family.main + "-" + suffix && names.has(part.path)
          : !names.has(family.main + "-" + suffix),
        "manifest_invalid",
      );
    }
  requireCondition(
    [...names]
      .filter((path) => /-(?:wal|shm)$/.test(path))
      .every((path) => main.includes(path.slice(0, -4))),
    "manifest_invalid",
  );
  return manifest;
}
function sameManifest(a: LegacyInventoryManifest, b: LegacyInventoryManifest) {
  const normalized = (manifest: LegacyInventoryManifest) => ({
    files: [...manifest.files].sort((x, y) => x.path.localeCompare(y.path)),
    directories: [...manifest.directories].sort((x, y) =>
      x.path.localeCompare(y.path),
    ),
    sqliteFamilies: [...manifest.sqliteFamilies].sort((x, y) =>
      x.main.localeCompare(y.main),
    ),
  });
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

/** Schema metadata is bounded before any integrity/FK check or selected data query. */
export function ordinarySchema(
  db: DatabaseSync,
  selected: Record<string, readonly string[]>,
) {
  const fields = ["type", "name", "tbl_name", "sql"]
    .map((field) => `coalesce(length(CAST(${field} AS BLOB)),0)`)
    .join("+");
  const meta = db
    .prepare(
      `SELECT count(*) AS n,max(${fields}) AS largest,sum(${fields}) AS bytes FROM sqlite_schema`,
    )
    .get()!;
  requireCondition(
    Number(meta.n) <= LEGACY_INVENTORY_LIMITS.schemaEntries &&
      Number(meta.largest ?? 0) <= LEGACY_INVENTORY_LIMITS.rowBytes &&
      Number(meta.bytes ?? 0) <= LEGACY_INVENTORY_LIMITS.payloadBytes,
    "database_invalid",
  );
  const tables = new Set<string>();
  const searchObjects = new Set<string>();
  for (const row of db
    .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY rowid")
    .iterate()) {
    requireCondition(
      typeof row.name === "string" &&
        Buffer.byteLength(row.name) <= 256 &&
        row.type !== "view",
      "database_invalid",
    );
    if (row.type === "table") {
      // The chat search index (built-in FTS5) is the one virtual table a
      // workflow database may hold, with exactly its own definition.
      const searchIndex =
        row.name === CHAT_SEARCH_FTS
          ? row.sql === CHAT_SEARCH_FTS_SQL
          : Object.hasOwn(CHAT_SEARCH_FTS_SHADOW, row.name)
            ? row.sql === CHAT_SEARCH_FTS_SHADOW[row.name]
            : undefined;
      requireCondition(
        typeof row.sql === "string" &&
          (searchIndex ?? !/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(row.sql)),
        "database_invalid",
      );
      if (searchIndex) searchObjects.add(row.name);
      else tables.add(row.name);
    }
  }
  // Its shadow tables never stand without it.
  requireCondition(
    !searchObjects.size || searchObjects.has(CHAT_SEARCH_FTS),
    "database_invalid",
  );
  let tableCount = 0;
  for (const row of db
    .prepare(
      "SELECT name,type,ncol FROM pragma_table_list WHERE schema='main' LIMIT ?",
    )
    .iterate(LEGACY_INVENTORY_LIMITS.schemaEntries + 1)) {
    const searchIndex =
      typeof row.name === "string" && searchObjects.has(row.name);
    requireCondition(
      ++tableCount <= LEGACY_INVENTORY_LIMITS.schemaEntries &&
        (row.type === "table" ||
          (searchIndex &&
            row.type ===
              (row.name === CHAT_SEARCH_FTS ? "virtual" : "shadow"))) &&
        typeof row.name === "string" &&
        Buffer.byteLength(row.name) <= 256 &&
        Number(row.ncol) <= LEGACY_INVENTORY_LIMITS.schemaColumns,
      "database_invalid",
    );
    // Its definition is pinned above; FTS5 adds hidden columns of its own.
    if (row.type === "virtual") continue;
    const columns = new Set<string>();
    let count = 0;
    for (const column of db
      .prepare("SELECT name,hidden FROM pragma_table_xinfo(?) LIMIT ?")
      .iterate(row.name, LEGACY_INVENTORY_LIMITS.schemaColumns + 1)) {
      requireCondition(
        ++count <= LEGACY_INVENTORY_LIMITS.schemaColumns &&
          column.hidden === 0 &&
          typeof column.name === "string" &&
          Buffer.byteLength(column.name) <= 256,
        "database_invalid",
      );
      columns.add(column.name);
    }
    if (selected[row.name])
      requireCondition(
        selected[row.name]!.every((column) => columns.has(column)),
        "database_invalid",
      );
  }
  requireCondition(
    Object.keys(selected).every((name) => tables.has(name)),
    "database_invalid",
  );
}

export type InventoryRows = {
  serverId: string;
  turns: Record<string, unknown>[];
  invocations: Record<string, unknown>[];
  links: Record<string, unknown>[];
  workspaces: Record<string, unknown>[];
  workflows: Record<string, unknown>[];
  receipts: Record<string, unknown>[];
};
const RecordSchema = z.record(z.string(), z.unknown());
const StringId = z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/);
const JournalRow = z.object({
  id: Hash,
  workspace_id: IdentityId,
  user_id: IdentityId,
  data: z.string(),
});
const Invocation = z.object({
  id: StringId,
  workspaceId: IdentityId,
  userId: IdentityId,
  organizationId: IdentityId,
  status: z.enum([
    "awaiting_approval",
    "running",
    "succeeded",
    "failed",
    "unknown",
    "rejected",
  ]),
  effect: z.enum(["read", "write"]),
});
const Link = z.object({
  operation_id: StringId,
  turn_id: Hash,
  workspace_id: IdentityId,
  user_id: IdentityId,
});
const Terminal = new Set(["succeeded", "failed", "unknown", "rejected"]);
const SettledNativeReceipt = new Set(["succeeded", "failed", "rejected"]);
const ControlResult = z.object({
  operationId: StringId,
  status: z.enum([
    "awaiting_approval",
    "running",
    "succeeded",
    "failed",
    "unknown",
    "rejected",
  ]),
  type: z.literal("service.action").optional(),
  effect: z.enum(["read", "write"]).optional(),
});
type NativeJournalClaim = {
  classification: "terminal_candidate" | "waiting" | "unclassified";
  status?: "succeeded" | "failed" | "cancelled" | "waiting";
  blocker?: string;
};
/**
 * Classify only a self-consistent saved service-process journal and its exact
 * invocation receipts. This describes a persisted claim, not owner exit or drain.
 */
function classifyServiceProcessJournal(
  journal: z.infer<typeof JournalSchema>,
  invocations: z.infer<typeof Invocation>[],
): NativeJournalClaim {
  const unclassified = (blocker: string): NativeJournalClaim => ({
    classification: "unclassified",
    blocker,
  });
  const trace = journal.trace;
  if (
    trace.status !== journal.status ||
    trace.finishedAt === null ||
    trace.steps.some(
      (step) => step.status === "running" || step.status === "unknown",
    )
  )
    return unclassified("native_lifecycle_invalid");

  const noUncertainReceipt = invocations.every((receipt) =>
    SettledNativeReceipt.has(receipt.status),
  );
  const traceActionsMatchReceipts = trace.steps.every((step) => {
    const action = step.action;
    if (!action) return true;
    const receipt = journal.receipts.find(
      (candidate) => candidate.operationId === action.operationId,
    );
    const invocation = invocations.find(
      (candidate) => candidate.id === action.operationId,
    );
    return (
      !!receipt &&
      !!invocation &&
      invocation.status === action.status &&
      invocation.effect === action.effect &&
      (!step.callId || receipt.callId === step.callId)
    );
  });
  const noUnsettledTraceAction = trace.steps.every(
    (step) =>
      !step.action ||
      !["running", "awaiting_approval", "unknown"].includes(step.action.status),
  );

  if (
    journal.status === "succeeded" ||
    journal.status === "failed" ||
    journal.status === "cancelled"
  ) {
    if (
      journal.pending ||
      !noUncertainReceipt ||
      !traceActionsMatchReceipts ||
      !noUnsettledTraceAction ||
      (journal.status === "succeeded" &&
        (journal.failure ||
          invocations.some((receipt) => receipt.status !== "succeeded") ||
          trace.steps.some(
            (step) =>
              step.action?.status === "failed" ||
              step.action?.status === "rejected",
          ))) ||
      (journal.status !== "succeeded" && !journal.failure)
    )
      return unclassified("native_lifecycle_invalid");
    if (
      journal.failure?.operationId &&
      !invocations.some(
        (receipt) =>
          receipt.id === journal.failure!.operationId &&
          (journal.status === "cancelled"
            ? receipt.status === "rejected"
            : receipt.status === "failed"),
      )
    )
      return unclassified("native_lifecycle_invalid");
    return { classification: "terminal_candidate", status: journal.status };
  }

  if (journal.status !== "waiting" || !journal.pending || journal.failure)
    return unclassified(
      journal.status === "unknown"
        ? "native_status_unknown"
        : "native_lifecycle_invalid",
    );

  const approvalReceipts = invocations.filter(
    (receipt) => receipt.status === "awaiting_approval",
  );
  if ("kind" in journal.pending) {
    const question = journal.pending;
    const parentRunId = processDigest([
      "service-process-1",
      journal.scopeDigest,
      journal.runId,
    ]);
    const matchingChildren = Object.entries(journal.agents).filter(
      ([nodeId, agent]) =>
        nodeId === question.nodeId &&
        agent.runId === question.childRunId &&
        agent.threadId === question.childThreadId &&
        agent.pending?.kind === "question" &&
        agent.questionRevision === question.questionRevision &&
        agent.pending.toolCallId === question.toolCallId &&
        agent.pending.question === question.question &&
        processDigest(agent.pending.questionProof) === processDigest(question),
    );
    if (
      question.parentRunId !== parentRunId ||
      question.resourceId !== journal.scopeDigest ||
      question.artifactDigest !== journal.artifactDigest ||
      question.compilerVersion !== journal.compilerVersion ||
      question.inputDigest !== journal.inputDigest ||
      question.issuedWorkRevision > journal.revision ||
      question.questionDigest !== processDigest(question.question) ||
      question.childRunId !==
        processDigest([parentRunId, "agent", question.nodeId]) ||
      question.childThreadId !==
        processDigest([
          parentRunId,
          journal.scopeDigest,
          "agent-thread",
          question.nodeId,
        ]) ||
      question.questionId !==
        processDigest([
          parentRunId,
          "question",
          question.nodeId,
          question.childRunId,
          question.toolCallId,
        ]) ||
      approvalReceipts.length ||
      !noUncertainReceipt ||
      !traceActionsMatchReceipts ||
      !noUnsettledTraceAction ||
      matchingChildren.length !== 1
    )
      return unclassified("native_lifecycle_invalid");
  } else {
    const approval = journal.pending;
    const matching = invocations.filter(
      (receipt) => receipt.id === approval.operationId,
    );
    const matchingTrace = trace.steps.some(
      (step) =>
        step.status === "waiting" &&
        step.action?.operationId === approval.operationId &&
        step.action.status === "awaiting_approval" &&
        step.action.effect === "write",
    );
    const uncertainTraceAction = trace.steps.some(
      (step) =>
        step.action?.status === "running" || step.action?.status === "unknown",
    );
    const awaitingTraceActions = trace.steps.filter(
      (step) => step.action?.status === "awaiting_approval",
    );
    if (
      approvalReceipts.length !== 1 ||
      !traceActionsMatchReceipts ||
      matching.length !== 1 ||
      matching[0]!.status !== "awaiting_approval" ||
      matching[0]!.effect !== "write" ||
      !matchingTrace ||
      awaitingTraceActions.length !== 1 ||
      uncertainTraceAction ||
      invocations.some(
        (receipt) =>
          receipt.id !== approval.operationId &&
          !SettledNativeReceipt.has(receipt.status),
      )
    )
      return unclassified("native_lifecycle_invalid");
  }
  return {
    classification: "waiting",
    status: "waiting",
    blocker: "native_waiting",
  };
}
const Bool = z.boolean();
const OptionalBool = (value: unknown) =>
  value === undefined || Bool.safeParse(value).success;
const ids = (value: unknown) => z.array(StringId).max(64).safeParse(value);
export type LegacyInventoryEntry = {
  id: string | null;
  kind: "agent-1" | "progressive-1" | "legacy" | "unsupported";
  active: boolean;
  passive: boolean;
  blockers: string[];
};
export type NativeInventoryEntry = {
  id: string | null;
  kind: "mastra-1" | "service-process-1";
  /** A persisted journal claim; never proof that the owner stopped or drained. */
  classification: "terminal_candidate" | "waiting" | "unclassified";
  status?: "succeeded" | "failed" | "cancelled" | "waiting";
};
export type LegacyInventoryClassification = {
  classificationComplete: boolean;
  counts: {
    activeTurns: number;
    passiveTurns: number;
    blockingTurns: number;
    passiveReceipts: number;
    awaitingReceipts: number;
    runningReceipts: number;
  };
  entries: LegacyInventoryEntry[];
  /** Native identity rows observed in the bounded scan; never a lifecycle claim. */
  nativeRuns: NativeInventoryEntry[];
  blockers: string[];
};
/** Conservative decisive-field projection, not a second historical interpreter. */
export function classifyLegacyInventory(
  input: InventoryRows,
): LegacyInventoryClassification {
  const entries: LegacyInventoryEntry[] = [];
  const nativeRuns: NativeInventoryEntry[] = [];
  const blockers = new Set<string>();
  const counts = {
    activeTurns: 0,
    passiveTurns: 0,
    blockingTurns: 0,
    passiveReceipts: 0,
    awaitingReceipts: 0,
    runningReceipts: 0,
  };
  const parse = (value: unknown): Record<string, unknown> | undefined => {
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value) > LEGACY_INVENTORY_LIMITS.rowBytes
    )
      return undefined;
    try {
      const result = RecordSchema.safeParse(JSON.parse(value));
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  };
  const boundFailure = (reason: "row_limit" | "payload_limit") => ({
    classificationComplete: false,
    counts,
    entries,
    nativeRuns,
    blockers: [reason],
  });
  const arrays = Object.values(input).filter(Array.isArray);
  if (arrays.some((rows) => rows.length > LEGACY_INVENTORY_LIMITS.rows))
    return boundFailure("row_limit");
  let aggregateBytes = 0;
  // Flat SQLite projections are bounded before serialization or JSON parsing.
  for (const rows of arrays)
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row))
        return boundFailure("row_limit");
      let rowBytes = 0;
      for (const field in row)
        if (Object.hasOwn(row, field)) {
          const column: unknown = row[field];
          if (
            field.length > LEGACY_INVENTORY_LIMITS.rowBytes ||
            (typeof column === "string" &&
              column.length > LEGACY_INVENTORY_LIMITS.rowBytes)
          )
            return boundFailure("row_limit");
          if (
            column !== null &&
            !["string", "number", "boolean"].includes(typeof column)
          )
            return boundFailure("row_limit");
          rowBytes +=
            Buffer.byteLength(field) +
            (typeof column === "string"
              ? Buffer.byteLength(column)
              : column === null
                ? 0
                : 32);
          if (rowBytes > LEGACY_INVENTORY_LIMITS.rowBytes)
            return boundFailure("row_limit");
        }
      aggregateBytes += rowBytes;
      if (aggregateBytes > LEGACY_INVENTORY_LIMITS.payloadBytes)
        return boundFailure("payload_limit");
    }
  const organizations = new Map<string, string>();
  for (const row of input.workspaces) {
    if (
      !IdentityId.safeParse(row.id).success ||
      !IdentityId.safeParse(row.organization_id).success ||
      organizations.has(String(row.id))
    )
      blockers.add("workspace_invalid");
    else organizations.set(String(row.id), String(row.organization_id));
  }
  const turns = input.turns.map((row) => ({
    row,
    value: parse(row.data),
    checked: JournalRow.safeParse(row),
  }));
  if (turns.some((item) => !item.value || !item.checked.success))
    blockers.add("journal_invalid");
  const journalIds = new Set<string>();
  for (const item of turns)
    if (item.checked.success) {
      if (journalIds.has(item.checked.data.id))
        blockers.add("journal_identity_ambiguous");
      journalIds.add(item.checked.data.id);
    }
  const operations = new Map<string, z.infer<typeof Invocation>>();
  const operationValues = new Map<string, Record<string, unknown>>();
  for (const row of input.invocations) {
    const value = parse(row.data),
      parsed = Invocation.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.id !== row.id ||
      parsed.data.workspaceId !== row.workspace_id ||
      parsed.data.userId !== row.user_id ||
      organizations.get(parsed.data.workspaceId) !==
        parsed.data.organizationId ||
      operations.has(String(row.id))
    ) {
      blockers.add("receipt_invalid");
      continue;
    }
    operations.set(parsed.data.id, parsed.data);
    operationValues.set(parsed.data.id, value!);
    if (Terminal.has(parsed.data.status)) counts.passiveReceipts++;
    else if (parsed.data.status === "awaiting_approval")
      counts.awaitingReceipts++;
    else counts.runningReceipts++;
  }
  const referenced = new Set<string>();
  const nativeReceiptClaims = new Map<string, string[]>();
  for (const item of turns)
    if (
      item.value?.kind === "mastra-1" ||
      item.value?.kind === "service-process-1"
    ) {
      nativeRuns.push({
        id: Hash.safeParse(item.row.id).success ? String(item.row.id) : null,
        kind: item.value.kind,
        classification: "unclassified",
      });
      blockers.add("native_unclassified");
      // Attribute exact native receipts without interpreting native run status.
      // Ownership evidence never establishes settlement or safe drain.
      if (item.value.kind === "service-process-1") {
        const parsed = JournalSchema.safeParse(item.value);
        const own = JournalRow.safeParse(item.row);
        const organizationId = organizations.get(String(item.row.workspace_id));
        if (!parsed.success || !own.success || !organizationId) {
          blockers.add("native_origin_invalid");
          continue;
        }
        const journal = parsed.data;
        if (
          turns.filter((candidate) => candidate.row.id === own.data.id)
            .length !== 1 ||
          own.data.id !==
            processDigest([
              "service-process-1",
              journal.scopeDigest,
              journal.runId,
            ]) ||
          journal.scopeDigest !==
            processDigest([
              input.serverId,
              organizationId,
              own.data.workspace_id,
              own.data.user_id,
            ])
        ) {
          blockers.add("native_origin_invalid");
          continue;
        }
        const operationIds = new Set(journal.operations);
        const receiptIds = new Set(
          journal.receipts.map((receipt) => receipt.operationId),
        );
        const callIds = new Set(
          journal.receipts.map((receipt) => receipt.callId),
        );
        if (
          operationIds.size !== journal.operations.length ||
          receiptIds.size !== journal.receipts.length ||
          callIds.size !== journal.receipts.length ||
          journal.operations.length !== journal.receipts.length ||
          !journal.receipts.every(
            (receipt) =>
              StringId.safeParse(receipt.callId).success &&
              operationIds.has(receipt.operationId) &&
              receipt.operationId ===
                processDigest([own.data.id, "action", receipt.callId]),
          )
        ) {
          blockers.add("native_receipt_invalid");
          continue;
        }
        let validReceipts = true;
        for (const receipt of journal.receipts) {
          const invocation = operations.get(receipt.operationId);
          const links = input.links.filter(
            (link) => link.operation_id === receipt.operationId,
          );
          const link =
            links.length === 1 && Link.safeParse(links[0]).success
              ? Link.parse(links[0])
              : undefined;
          if (
            !invocation ||
            invocation.workspaceId !== own.data.workspace_id ||
            invocation.userId !== own.data.user_id ||
            invocation.organizationId !== organizationId ||
            !link ||
            link.turn_id !== own.data.id ||
            link.workspace_id !== own.data.workspace_id ||
            link.user_id !== own.data.user_id
          ) {
            blockers.add("native_receipt_unproven");
            validReceipts = false;
          }
        }
        if (validReceipts)
          for (const operationId of journal.operations) {
            const owners = nativeReceiptClaims.get(operationId) ?? [];
            owners.push(own.data.id);
            nativeReceiptClaims.set(operationId, owners);
          }
        if (validReceipts) {
          const claim = classifyServiceProcessJournal(
            journal,
            journal.operations.flatMap((operationId) => {
              const receipt = operations.get(operationId);
              return receipt ? [receipt] : [];
            }),
          );
          const observed = nativeRuns[nativeRuns.length - 1]!;
          observed.classification = claim.classification;
          if (claim.status) observed.status = claim.status;
          if (claim.blocker) blockers.add(claim.blocker);
        }
        continue;
      }
      const rootId = item.value.kind === "mastra-1" ? Hash : IdentityId;
      const aliases =
        item.value.kind === "mastra-1"
          ? z
              .array(
                z.object({
                  commandId: StringId,
                  hash: Hash,
                  requestHash: Hash,
                }),
              )
              .min(1)
              .max(32)
              .safeParse(item.value.aliases)
          : undefined;
      if (
        !item.checked.success ||
        !rootId.safeParse(item.value.runId).success ||
        !organizations.has(String(item.row.workspace_id)) ||
        !ids(item.value.operations).success ||
        (item.value.kind === "mastra-1" &&
          (!aliases?.success ||
            item.value.runId !==
              digest([
                input.serverId,
                item.row.workspace_id,
                item.row.user_id,
                aliases.data[0]!.commandId,
              ]) ||
            !aliases.data.some(
              (alias) =>
                item.row.id ===
                digest([
                  input.serverId,
                  item.row.workspace_id,
                  item.row.user_id,
                  alias.commandId,
                ]),
            ) ||
            (item.value.legacyQuestion !== undefined &&
              !LegacyQuestionSchema.safeParse(item.value.legacyQuestion)
                .success)))
      )
        blockers.add("native_origin_invalid");
    } else if (
      item.value?.kind !== undefined &&
      item.value.kind !== "agent-1" &&
      item.value.kind !== "progressive-1"
    )
      blockers.add("unsupported_journal");
  if (nativeRuns.every((run) => run.classification !== "unclassified"))
    blockers.delete("native_unclassified");
  const nativeReceiptOwners = new Map<string, string>();
  for (const [operationId, owners] of nativeReceiptClaims) {
    if (owners.length !== 1) {
      blockers.add("native_receipt_ambiguous");
      continue;
    }
    referenced.add(operationId);
    nativeReceiptOwners.set(operationId, owners[0]!);
  }
  const outer = input.receipts.flatMap((row) => {
    const value = parse(row.payload),
      command = CommandSchema.safeParse(value?.command);
    let scope: z.infer<typeof ScopeSchema> | undefined;
    try {
      const key: unknown =
        typeof row.scope_key === "string" ? JSON.parse(row.scope_key) : null;
      if (Array.isArray(key) && key.length === 4) {
        const parsed = ScopeSchema.safeParse({
          connectionId: key[0],
          serverId: key[1],
          userId: key[2],
          workspaceId: key[3],
        });
        if (parsed.success) scope = parsed.data;
      }
    } catch {
      /* report a finite reason */
    }
    if (
      !command.success ||
      !scope ||
      scope.serverId !== input.serverId ||
      row.command_id !== command.data.commandId ||
      row.idempotency_key !== command.data.idempotencyKey ||
      !["accepted", "rejected", "conflict"].includes(String(value?.status))
    ) {
      blockers.add("outer_proof_invalid");
      return [];
    }
    return [
      {
        command: command.data,
        scope,
        status: String(value!.status),
        scopeKey: row.scope_key,
      },
    ];
  });
  const publicProof = (key: string, workspaceId: string, userId: string) => {
    const matches = outer.filter(
      (entry) =>
        entry.command.idempotencyKey === key &&
        entry.scope.workspaceId === workspaceId &&
        entry.scope.userId === userId,
    );
    return matches.length === 1 && matches[0]!.status === "accepted"
      ? matches[0]
      : undefined;
  };
  const workflow = (scope: z.infer<typeof ScopeSchema>) => {
    const matches = input.workflows.filter(
      (row) =>
        row.scope_key ===
        JSON.stringify([
          scope.connectionId,
          scope.serverId,
          scope.userId,
          scope.workspaceId,
        ]),
    );
    const value = matches.length === 1 ? parse(matches[0]!.state) : undefined;
    const snapshot = value && RecordSchema.safeParse(value.snapshot);
    const savedScope =
      snapshot && snapshot.success
        ? ScopeSchema.safeParse(snapshot.data.scope)
        : undefined;
    return snapshot &&
      snapshot.success &&
      savedScope?.success &&
      sameScope(savedScope.data, scope)
      ? snapshot.data
      : undefined;
  };
  const hasReply = (
    proof: NonNullable<ReturnType<typeof publicProof>>,
    question?: string,
    expectedResult?: { operationId: string; status: string },
    completedOperations?: readonly string[],
  ) => {
    const snapshot = workflow(proof.scope);
    if (!snapshot || !Array.isArray(snapshot.conversations)) return false;
    const conversations = snapshot.conversations.filter(
      (value) =>
        value &&
        typeof value === "object" &&
        (value as Record<string, unknown>).id === proof.command.conversationId,
    );
    if (conversations.length !== 1) return false;
    const messages = (conversations[0] as Record<string, unknown>).messages;
    if (!Array.isArray(messages)) return false;
    const replies = messages.filter(
      (value) =>
        value &&
        typeof value === "object" &&
        (value as Record<string, unknown>).role === "assistant" &&
        (value as Record<string, unknown>).replyToCommandId ===
          proof.command.commandId,
    );
    const result =
      replies.length === 1
        ? RecordSchema.safeParse((replies[0] as Record<string, unknown>).result)
        : undefined;
    if (
      completedOperations !== undefined &&
      (replies[0] as Record<string, unknown> | undefined)?.result !== undefined
    ) {
      const control = ControlResult.safeParse(
        (replies[0] as Record<string, unknown>).result,
      );
      if (
        !control.success ||
        !Terminal.has(control.data.status) ||
        !completedOperations.includes(control.data.operationId)
      )
        return false;
      const canonical = operations.get(control.data.operationId);
      if (
        !canonical ||
        canonical.status !== control.data.status ||
        (control.data.effect !== undefined &&
          canonical.effect !== control.data.effect)
      )
        return false;
    }
    return (
      replies.length === 1 &&
      (question === undefined ||
        (replies[0] as Record<string, unknown>).text === question) &&
      (!expectedResult ||
        (result?.success &&
          result.data.operationId === expectedResult.operationId &&
          result.data.status === expectedResult.status))
    );
  };
  const consumed = (
    old: (typeof turns)[number],
    proof: NonNullable<ReturnType<typeof publicProof>>,
  ) => {
    const candidate = legacyQuestionCandidate(old.value);
    const roots = turns.filter(
      (item) =>
        item.value?.kind === "mastra-1" &&
        item.row.id === item.value.runId &&
        (item.value.legacyQuestion as Record<string, unknown> | undefined)
          ?.turnId === old.row.id,
    );
    if (
      !candidate ||
      roots.length !== 1 ||
      [...blockers].some((reason) => reason !== "native_unclassified")
    )
      return false;
    const rawResult = (old.value!.answer as Record<string, unknown>).result;
    const oldControl =
      rawResult === undefined ? undefined : ControlResult.safeParse(rawResult);
    if (oldControl && !oldControl.success) return false;
    if (oldControl?.success) {
      const canonical = operations.get(oldControl.data.operationId);
      if (
        !canonical ||
        !Terminal.has(oldControl.data.status) ||
        !candidate.operations.includes(oldControl.data.operationId) ||
        canonical.status !== oldControl.data.status ||
        (oldControl.data.effect !== undefined &&
          canonical.effect !== oldControl.data.effect)
      )
        return false;
    }
    const root = roots[0]!,
      origin = root.value!.legacyQuestion as Record<string, unknown>;
    if (
      !root.checked.success ||
      root.row.workspace_id !== old.row.workspace_id ||
      root.row.user_id !== old.row.user_id ||
      !legacyQuestionConsumedRoot(
        root.value,
        String(root.row.id),
        String(old.row.id),
        old.value,
        proof.scope,
      ) ||
      origin.scopeHash !==
        digest([proof.scope, organizations.get(proof.scope.workspaceId)]) ||
      origin.requestHash !== digest(proof.command) ||
      origin.commandId !== proof.command.commandId ||
      proof.command.type !== "message.send" ||
      proof.command.text !== candidate.goal ||
      proof.command.language !== candidate.language ||
      !hasReply(
        proof,
        candidate.question,
        oldControl?.success ? oldControl.data : undefined,
        candidate.operations,
      ) ||
      !Array.isArray(root.value!.aliases)
    )
      return false;
    const sources = z
      .array(z.object({ id: StringId, hash: Hash }))
      .max(32)
      .safeParse(origin.sources);
    if (
      !sources.success ||
      new Set(sources.data.map((source) => source.id)).size !==
        sources.data.length ||
      digest(sources.data.map((source) => source.id).sort()) !==
        digest([...candidate.sources].sort())
    )
      return false;
    for (const id of candidate.operations) {
      const receipt = operations.get(id);
      if (
        !receipt ||
        receipt.workspaceId !== old.row.workspace_id ||
        receipt.userId !== old.row.user_id ||
        receipt.effect !== "read" ||
        receipt.status !== "succeeded"
      )
        return false;
    }
    for (const source of sources.data) {
      const parsed = z.object({ id: StringId, hash: Hash }).safeParse(source);
      if (
        !parsed.success ||
        parsed.data.hash !== digest(operationValues.get(parsed.data.id))
      )
        return false;
    }
    const aliasKeys = new Set<string>();
    for (const item of root.value!.aliases) {
      const parsed = z
        .object({ commandId: StringId, hash: Hash, requestHash: Hash })
        .safeParse(item);
      if (!parsed.success) return false;
      const alias = parsed.data,
        key = digest([
          input.serverId,
          root.row.workspace_id,
          root.row.user_id,
          alias.commandId,
        ]);
      if (aliasKeys.has(key)) return false;
      aliasKeys.add(key);
      const owned = turns.filter((item) => item.row.id === key);
      const aliasProof = publicProof(
        alias.commandId,
        String(root.row.workspace_id),
        String(root.row.user_id),
      );
      if (
        owned.length !== 1 ||
        !owned[0]!.checked.success ||
        owned[0]!.row.workspace_id !== root.row.workspace_id ||
        owned[0]!.row.user_id !== root.row.user_id ||
        digest(owned[0]!.value) !== digest(root.value) ||
        !aliasProof ||
        !sameScope(aliasProof.scope, proof.scope) ||
        aliasProof.command.type !== "message.send" ||
        aliasProof.command.conversationId !== root.value!.conversationId ||
        alias.requestHash !== digest(aliasProof.command) ||
        alias.hash !==
          digest([aliasProof.command.text, aliasProof.command.language])
      )
        return false;
    }
    return (
      aliasKeys.size > 0 &&
      turns
        .filter(
          (item) =>
            item.value?.kind === "mastra-1" && item.value.runId === root.row.id,
        )
        .every((item) => aliasKeys.has(String(item.row.id)))
    );
  };
  for (const item of turns) {
    const value = item.value;
    if (value?.kind === "mastra-1" || value?.kind === "service-process-1")
      continue;
    const kind =
      value?.kind === "agent-1" || value?.kind === "progressive-1"
        ? value.kind
        : value && value.kind === undefined
          ? "legacy"
          : "unsupported";
    const entry: LegacyInventoryEntry = {
      id: item.checked.success ? item.checked.data.id : null,
      kind,
      active: false,
      passive: false,
      blockers: [],
    };
    entries.push(entry);
    const block = (reason: string) => {
      if (!entry.blockers.includes(reason)) entry.blockers.push(reason);
    };
    if (!item.checked.success || !value || kind === "unsupported") {
      block("journal_invalid");
      continue;
    }
    const own = item.checked.data;
    let commandId =
      typeof value.commandId === "string" &&
      StringId.safeParse(value.commandId).success
        ? value.commandId
        : undefined;
    if (kind === "legacy") {
      const matches = outer.filter(
        (proof) =>
          proof.scope.workspaceId === own.workspace_id &&
          proof.scope.userId === own.user_id &&
          digest([
            input.serverId,
            own.workspace_id,
            own.user_id,
            proof.command.idempotencyKey,
          ]) === own.id,
      );
      if (matches.length === 1) commandId = matches[0]!.command.idempotencyKey;
    }
    const proof = commandId
      ? publicProof(commandId, own.workspace_id, own.user_id)
      : undefined;
    if (
      !commandId ||
      own.id !==
        digest([input.serverId, own.workspace_id, own.user_id, commandId]) ||
      !proof ||
      proof.command.type !== "message.send" ||
      value.hash !== digest([proof.command.text, proof.command.language]) ||
      (value.requestHash !== undefined &&
        value.requestHash !== digest(proof.command)) ||
      (kind !== "legacy" &&
        (value.text !== proof.command.text ||
          value.language !== proof.command.language))
    )
      block("proof_missing_or_conflicting");
    const operationIds: string[] = [];
    if (kind === "agent-1") {
      const parsed = ids(value.operations);
      if (!parsed.success) block("operations_invalid");
      else operationIds.push(...parsed.data);
      if (!Array.isArray(value.pendingCalls)) block("batch_invalid");
      else if (value.pendingCalls.length) entry.active = true;
      if (value.pending !== undefined) {
        if (!StringId.safeParse(value.pending).success)
          block("pending_invalid");
        else operationIds.push(String(value.pending));
        entry.active = true;
      }
      if (
        !Bool.safeParse(value.paused).success ||
        !Bool.safeParse(value.continuityPending).success
      )
        block("continuation_invalid");
      if (
        value.paused === true ||
        value.continuityPending === true ||
        value.plan !== undefined ||
        value.batchMemory !== undefined
      )
        entry.active = true;
      if (value.plan !== undefined || value.batchMemory !== undefined)
        block("continuation_unclassified");
      if (value.working !== undefined) {
        const working = RecordSchema.safeParse(value.working);
        if (!working.success) block("working_invalid");
        else if (working.data.question !== undefined) {
          if (typeof working.data.question !== "string")
            block("working_invalid");
          entry.active = true;
        }
      }
      if (value.receipts !== undefined) {
        const receipts = z
          .array(z.object({ callId: StringId, operationId: StringId }))
          .max(64)
          .safeParse(value.receipts);
        if (!receipts.success) block("receipts_invalid");
        else
          for (const receipt of receipts.data)
            if (!operationIds.includes(receipt.operationId)) {
              operationIds.push(receipt.operationId);
              block("unclaimed_receipt");
            }
      }
    } else if (kind === "progressive-1") {
      if (!Array.isArray(value.steps) || value.steps.length > 20)
        block("steps_invalid");
      else
        for (const step of value.steps) {
          const parsed = RecordSchema.safeParse(step);
          if (!parsed.success) block("steps_invalid");
          else if (parsed.data.plan !== undefined) {
            const plan = RecordSchema.safeParse(parsed.data.plan);
            if (
              !plan.success ||
              !StringId.safeParse(plan.data.operationId).success
            )
              block("plan_invalid");
            else operationIds.push(String(plan.data.operationId));
          }
        }
      if (
        !Bool.safeParse(value.paused).success ||
        !Bool.safeParse(value.pendingInput).success
      )
        block("continuation_invalid");
      if (value.carriedSteps !== undefined && value.carriedSteps !== 0)
        block("continuation_unclassified");
      if (value.pendingInput === true) entry.active = true;
      // Historical prose also set paused: its presence alone cannot prove continuation.
      if (value.paused === true && value.pendingInput !== true)
        block("continuation_unclassified");
    } else {
      if (!OptionalBool(value.delegate)) block("delegate_invalid");
      if (value.delegate === true) {
        entry.active = true;
        block("delegate_unclassified");
      }
      if (value.plan !== undefined) {
        const plan = RecordSchema.safeParse(value.plan);
        if (!plan.success || !StringId.safeParse(plan.data.operationId).success)
          block("plan_invalid");
        else operationIds.push(String(plan.data.operationId));
      }
    }
    const links = input.links.filter((row) => row.turn_id === own.id);
    for (const row of links) {
      const parsed = Link.safeParse(row);
      if (
        !parsed.success ||
        parsed.data.workspace_id !== own.workspace_id ||
        parsed.data.user_id !== own.user_id
      )
        block("link_invalid");
      else if (!operationIds.includes(parsed.data.operation_id)) {
        operationIds.push(parsed.data.operation_id);
        block("unclaimed_operation_link");
      }
    }
    for (const id of new Set(operationIds)) {
      referenced.add(id);
      const nativeOwner = nativeReceiptOwners.get(id);
      if (nativeOwner && nativeOwner !== own.id) {
        referenced.delete(id);
        blockers.add("native_receipt_ambiguous");
        block("receipt_ownership_ambiguous");
      }
      const receipt = operations.get(id);
      if (
        !receipt ||
        receipt.workspaceId !== own.workspace_id ||
        receipt.userId !== own.user_id
      ) {
        block("receipt_missing_or_conflicting");
        continue;
      }
      if (!Terminal.has(receipt.status)) {
        entry.active = true;
        if (receipt.status === "running") block("running_outcome_unresolved");
      }
    }
    const question = legacyQuestionCandidate(value);
    const didConsume = question && proof ? consumed(item, proof) : false;
    const executableActive =
      operationIds.some((id) =>
        ["awaiting_approval", "running"].includes(
          operations.get(id)?.status ?? "",
        ),
      ) ||
      (kind === "agent-1" &&
        ((Array.isArray(value.pendingCalls) && value.pendingCalls.length > 0) ||
          value.pending !== undefined ||
          value.plan !== undefined ||
          value.batchMemory !== undefined ||
          value.continuityPending === true)) ||
      (kind === "legacy" && value.delegate === true);
    if (question && didConsume) entry.active = executableActive;
    else if (question) {
      entry.active = true;
      if (!proof || !hasReply(proof, question.question))
        block("question_proof_missing");
      if (
        turns.some(
          (native) =>
            native.value?.kind === "mastra-1" &&
            (native.value.legacyQuestion as Record<string, unknown> | undefined)
              ?.turnId === own.id,
        )
      )
        block("question_consumption_conflicting");
    }
    const answer = z
      .object({ reply: z.string().max(2000) })
      .safeParse(value.answer);
    if (
      !entry.active &&
      !didConsume &&
      (!answer.success ||
        !proof ||
        !hasReply(proof, answer.data.reply, undefined, operationIds))
    )
      block("completed_control_unproven");
    if (
      !entry.active &&
      !didConsume &&
      value.answer &&
      typeof value.answer === "object"
    ) {
      const result = (value.answer as Record<string, unknown>).result;
      if (result !== undefined) {
        const parsed = z
          .object({
            operationId: StringId,
            status: z.enum([
              "awaiting_approval",
              "succeeded",
              "failed",
              "unknown",
              "rejected",
            ]),
          })
          .safeParse(result);
        if (
          !parsed.success ||
          !operationIds.includes(parsed.data.operationId) ||
          operations.get(parsed.data.operationId)?.status !==
            parsed.data.status ||
          !Terminal.has(parsed.data.status) ||
          !proof ||
          !hasReply(
            proof,
            answer.success ? answer.data.reply : undefined,
            parsed.data,
            operationIds,
          )
        )
          block("completed_control_unproven");
      }
    }
    if (
      entry.active &&
      !question &&
      !operationIds.length &&
      !(Array.isArray(value.pendingCalls) && value.pendingCalls.length)
    )
      block("continuation_unclassified");
    entry.passive = !entry.active && !entry.blockers.length;
  }
  for (const row of input.links) {
    const parsed = Link.safeParse(row);
    if (
      !parsed.success ||
      !turns.some(
        (item) =>
          item.row.id === parsed.data.turn_id &&
          item.row.workspace_id === parsed.data.workspace_id &&
          item.row.user_id === parsed.data.user_id,
      )
    )
      blockers.add("orphan_operation_link");
  }
  // Native-only ownership is outside this legacy projection. A matching field
  // on another journal does not prove authoritative ownership of an orphan.
  for (const receipt of operations.values())
    if (!referenced.has(receipt.id)) blockers.add("unowned_receipt");
  if ([...blockers].some((reason) => reason !== "native_unclassified"))
    for (const entry of entries) {
      entry.passive = false;
      if (!entry.blockers.includes("global_ownership_unproven"))
        entry.blockers.push("global_ownership_unproven");
    }
  for (const entry of entries) {
    if (entry.active) counts.activeTurns++;
    if (entry.passive) counts.passiveTurns++;
    if (entry.blockers.length) counts.blockingTurns++;
  }
  return {
    classificationComplete:
      !blockers.size && entries.every((entry) => !entry.blockers.length),
    counts,
    entries,
    nativeRuns: nativeRuns.sort(
      (a, b) =>
        (a.id ?? "").localeCompare(b.id ?? "") || a.kind.localeCompare(b.kind),
    ),
    blockers: [...blockers].sort(),
  };
}

export type LegacyInventoryReport = {
  profile: "niaro-legacy-inventory/4";
  status: "incomplete";
  scanComplete: boolean;
  classificationComplete: boolean;
  fingerprint: string;
  provenance: {
    ownerStop: "unverified";
    commonCheckpoint: "unverified";
    basis: "offline_manifest_only";
  };
  counts: LegacyInventoryClassification["counts"];
  entries: LegacyInventoryEntry[];
  nativeRuns: NativeInventoryEntry[];
  nativeStorage: {
    profile: typeof NATIVE_MASTRA_STORAGE_PROFILE;
    databaseCount: number;
    workflowSnapshots: number | null;
    backgroundTasks: number | null;
    scan: "not_declared" | "complete" | "incomplete";
  };
  blockers: string[];
};
/** Manifest declarations establish bytes only, never owner exit/common provenance. */
export function inventoryLegacyTuple(value: unknown): LegacyInventoryReport {
  const manifest = validateManifest(value);
  requireCondition(
    realpathSync(manifest.tupleRoot) === manifest.tupleRoot,
    "manifest_invalid",
  );
  const tempParent = realpathSync(tmpdir());
  const tempRelative = relative(manifest.tupleRoot, tempParent);
  requireCondition(
    tempRelative === ".." ||
      tempRelative.startsWith(".." + sep) ||
      isAbsolute(tempRelative),
    "manifest_invalid",
  );
  const before = observeLegacyTuple(manifest.tupleRoot, manifest.roles);
  requireCondition(sameManifest(manifest, before), "tuple_changed");
  const outerTemp = mkdtempSync(join(tempParent, "niaro-legacy-inventory-"));
  chmodSync(outerTemp, 0o700);
  const temp = join(outerTemp, "tuple");
  mkdirSync(temp, { mode: 0o700 });
  let payloadBytes = 0;
  let limited = false;
  let nativeSchemaUnrecognized = false;
  let workflowSnapshots = 0;
  let backgroundTasks = 0;
  let nativeRows = 0;
  let nativePayloadBytes = 0;
  const raw: InventoryRows = {
    serverId: "",
    turns: [],
    invocations: [],
    links: [],
    workspaces: [],
    workflows: [],
    receipts: [],
  };
  try {
    for (const directory of [...manifest.directories].sort(
      (a, b) => a.path.length - b.path.length,
    )) {
      const path = directory.path === "." ? temp : join(temp, directory.path);
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chmodSync(path, directory.mode);
    }
    for (const file of manifest.files) {
      const destination = join(temp, file.path);
      copyBoundedFile(
        join(manifest.tupleRoot, file.path),
        destination,
        file.size,
      );
      chmodSync(destination, file.mode);
    }
    requireCondition(
      sameManifest(manifest, observeLegacyTuple(temp, manifest.roles)),
      "tuple_changed",
    );
    const read = (path: string, fn: (db: DatabaseSync) => void) => {
      const db = new DatabaseSync(join(temp, path), { readOnly: true });
      try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
        const selected: Record<string, readonly string[]> =
          path === manifest.roles.identityDatabase
            ? {
                agent_service_turn: ["id", "workspace_id", "user_id", "data"],
                agent_service_invocation: [
                  "id",
                  "workspace_id",
                  "user_id",
                  "data",
                ],
                agent_service_turn_operation: [
                  "operation_id",
                  "turn_id",
                  "workspace_id",
                  "user_id",
                ],
                agent_workspace: ["id", "organization_id"],
              }
            : path === manifest.roles.workflowDatabase
              ? {
                  metadata: ["key", "value"],
                  workflows: ["scope_key", "state"],
                  receipts: [
                    "scope_key",
                    "command_id",
                    "idempotency_key",
                    "payload",
                  ],
                }
              : {};
        ordinarySchema(db, selected);
        requireCondition(
          db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check ===
            "ok" &&
            db.prepare("PRAGMA foreign_key_check").iterate().next().done ===
              true,
          "database_invalid",
        );
        fn(db);
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    };
    const table = (db: DatabaseSync, name: string, columns: string[]) => {
      // Metadata bounds precede any payload iterator/materialization or JSON.parse.
      const rowLength = columns
        .map((column) => `coalesce(length(CAST(${column} AS BLOB)),0)`)
        .join("+");
      const lengths = `max(${rowLength}) AS largest,sum(${rowLength}) AS bytes`;
      const meta = db
        .prepare(`SELECT count(*) AS n,${lengths} FROM ${name}`)
        .get()!;
      const bytes = Number(meta.bytes ?? 0);
      if (
        Number(meta.n) > LEGACY_INVENTORY_LIMITS.rows ||
        Number(meta.largest ?? 0) > LEGACY_INVENTORY_LIMITS.rowBytes ||
        payloadBytes + bytes > LEGACY_INVENTORY_LIMITS.payloadBytes
      ) {
        limited = true;
        return [];
      }
      payloadBytes += bytes;
      return [
        ...db
          .prepare(`SELECT ${columns.join(",")} FROM ${name} ORDER BY rowid`)
          .iterate(),
      ] as Record<string, unknown>[];
    };
    const exactNativeSchema = (db: DatabaseSync) => {
      const names = Object.keys(
        NATIVE_MASTRA_TABLE_COLUMNS,
      ) as (keyof typeof NATIVE_MASTRA_TABLE_COLUMNS)[];
      const tables = [
        ...db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND substr(name,1,7) <> 'sqlite_' ORDER BY name",
          )
          .iterate(),
      ].map((row) => String(row.name));
      if (
        names.some((name) => !tables.includes(name)) ||
        tables.some((name) => !NATIVE_MASTRA_KNOWN_TABLES.has(name))
      ) {
        return false;
      }
      for (const name of names) {
        const columns = [
          ...db
            .prepare(
              'SELECT name,type,"notnull",pk,hidden FROM pragma_table_xinfo(?) ORDER BY cid',
            )
            .iterate(name),
        ];
        const expectedColumns = NATIVE_MASTRA_TABLE_COLUMNS[name];
        const expectedSchema = NATIVE_MASTRA_TABLE_SCHEMA[name];
        if (
          columns.length !== expectedColumns.length ||
          columns.some(
            (column, index) =>
              column.name !== expectedColumns[index] ||
              String(column.type).toUpperCase() !==
                expectedSchema.types[index] ||
              Number(column.hidden) !== 0 ||
              Number(column.pk) !==
                (expectedSchema.primaryKey.includes(
                  String(column.name) as never,
                )
                  ? 1
                  : 0) ||
              Number(column.notnull) !==
                (expectedSchema.notNull.includes(String(column.name) as never)
                  ? 1
                  : 0),
          )
        ) {
          return false;
        }
        const indexes = [
          ...db
            .prepare(
              'SELECT name,"unique",origin,partial FROM pragma_index_list(?) ORDER BY seq',
            )
            .iterate(name),
        ].map((index) => ({
          unique: Number(index.unique) === 1,
          origin: String(index.origin),
          partial: Number(index.partial),
          columns: [
            ...db
              .prepare(
                "SELECT name,desc,coll,key FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno",
              )
              .iterate(String(index.name)),
          ].map((column) => ({
            name: String(column.name),
            descending: Number(column.desc),
            collation: String(column.coll).toUpperCase(),
          })),
        }));
        const expectedIndexes = expectedSchema.unique.map((columns) => ({
          unique: true,
          origin:
            JSON.stringify(columns) ===
            JSON.stringify(expectedSchema.primaryKey)
              ? "pk"
              : "u",
          partial: 0,
          columns: columns.map((column) => ({
            name: column,
            descending: 0,
            collation: "BINARY",
          })),
        }));
        if (JSON.stringify(indexes) !== JSON.stringify(expectedIndexes)) {
          return false;
        }
      }
      return true;
    };
    const boundedNativeCount = (
      db: DatabaseSync,
      name: keyof typeof NATIVE_MASTRA_TABLE_COLUMNS,
    ) => {
      const columns = NATIVE_MASTRA_TABLE_COLUMNS[name];
      const select = columns
        .map((column, index) => `length(CAST(${column} AS BLOB)) AS c${index}`)
        .join(",");
      let count = 0;
      for (const row of db
        .prepare(`SELECT ${select} FROM ${name} LIMIT ?`)
        .iterate(LEGACY_INVENTORY_LIMITS.rows + 1)) {
        if (
          ++count > LEGACY_INVENTORY_LIMITS.rows ||
          ++nativeRows > LEGACY_INVENTORY_LIMITS.rows
        )
          return undefined;
        const rowBytes = columns.reduce((sum, _column, index) => {
          const value = Number(row[`c${index}`]);
          return Number.isSafeInteger(value) && value >= 0
            ? sum + value
            : LEGACY_INVENTORY_LIMITS.rowBytes + 1;
        }, 0);
        nativePayloadBytes += rowBytes;
        if (
          rowBytes > LEGACY_INVENTORY_LIMITS.rowBytes ||
          nativePayloadBytes > LEGACY_INVENTORY_LIMITS.payloadBytes
        )
          return undefined;
      }
      return count;
    };
    read(manifest.roles.identityDatabase, (db) => {
      raw.turns = table(db, "agent_service_turn", [
        "id",
        "workspace_id",
        "user_id",
        "data",
      ]);
      raw.invocations = table(db, "agent_service_invocation", [
        "id",
        "workspace_id",
        "user_id",
        "data",
      ]);
      raw.links = table(db, "agent_service_turn_operation", [
        "operation_id",
        "turn_id",
        "workspace_id",
        "user_id",
      ]);
      raw.workspaces = table(db, "agent_workspace", ["id", "organization_id"]);
    });
    read(manifest.roles.workflowDatabase, (db) => {
      const serverLength = db
        .prepare(
          "SELECT length(CAST(value AS BLOB)) AS n FROM metadata WHERE key='server_id'",
        )
        .get();
      requireCondition(Number(serverLength?.n) <= 200, "database_invalid");
      const row = db
        .prepare("SELECT value FROM metadata WHERE key='server_id'")
        .get();
      const server = z
        .string()
        .regex(/^fixture-[a-f0-9]{24}$/)
        .safeParse(row?.value);
      requireCondition(server.success, "database_invalid");
      raw.serverId = server.data;
      raw.workflows = table(db, "workflows", ["scope_key", "state"]);
      raw.receipts = table(db, "receipts", [
        "scope_key",
        "command_id",
        "idempotency_key",
        "payload",
      ]);
    });
    // Read just this bounded public identifier, never the secret/configuration.
    const serverFile = manifest.files.find(
      (file) => file.path === manifest.roles.workflowServerId,
    )!;
    requireCondition(serverFile.size <= 200, "database_invalid");
    const fd = openSync(
      join(temp, serverFile.path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const buffer = Buffer.alloc(200);
      const n = readSync(fd, buffer, 0, buffer.length, 0);
      requireCondition(
        buffer.subarray(0, n).toString("utf8") === raw.serverId,
        "database_invalid",
      );
    } finally {
      closeSync(fd);
    }
    for (const family of manifest.sqliteFamilies)
      if (
        ![
          manifest.roles.identityDatabase,
          manifest.roles.workflowDatabase,
          ...manifest.roles.nativeDatabases,
        ].includes(family.main)
      )
        read(family.main, () => {});
    for (const nativeDatabase of manifest.roles.nativeDatabases) {
      try {
        read(nativeDatabase, (db) => {
          if (!exactNativeSchema(db)) {
            nativeSchemaUnrecognized = true;
            return;
          }
          const snapshots = boundedNativeCount(db, "mastra_workflow_snapshot");
          const tasks = boundedNativeCount(db, "mastra_background_tasks");
          if (snapshots === undefined || tasks === undefined) {
            limited = true;
            return;
          }
          workflowSnapshots += snapshots;
          backgroundTasks += tasks;
        });
      } catch (error) {
        if (
          error instanceof LegacyInventoryFailure &&
          error.code !== "database_invalid"
        )
          throw error;
        nativeSchemaUnrecognized = true;
      }
    }
    const classification = classifyLegacyInventory(raw);
    requireCondition(
      sameManifest(
        manifest,
        observeLegacyTuple(manifest.tupleRoot, manifest.roles),
      ),
      "tuple_changed",
    );
    return {
      profile: "niaro-legacy-inventory/4",
      status: "incomplete",
      scanComplete: !limited && !nativeSchemaUnrecognized,
      classificationComplete:
        !limited &&
        !nativeSchemaUnrecognized &&
        !manifest.roles.nativeDatabases.length &&
        classification.classificationComplete,
      fingerprint: digest({
        files: before.files,
        directories: before.directories,
        sqliteFamilies: before.sqliteFamilies,
        roles: {
          ...manifest.roles,
          nativeDatabases: [...manifest.roles.nativeDatabases].sort(),
          ownerLocks: [...manifest.roles.ownerLocks].sort(),
        },
      }),
      provenance: {
        ownerStop: "unverified",
        commonCheckpoint: "unverified",
        basis: "offline_manifest_only",
      },
      counts: classification.counts,
      entries: classification.entries,
      nativeRuns: classification.nativeRuns,
      nativeStorage: {
        profile: NATIVE_MASTRA_STORAGE_PROFILE,
        databaseCount: manifest.roles.nativeDatabases.length,
        workflowSnapshots:
          nativeSchemaUnrecognized || limited ? null : workflowSnapshots,
        backgroundTasks:
          nativeSchemaUnrecognized || limited ? null : backgroundTasks,
        scan: !manifest.roles.nativeDatabases.length
          ? "not_declared"
          : limited || nativeSchemaUnrecognized
            ? "incomplete"
            : "complete",
      },
      blockers: [
        ...new Set([
          "owner_stop_unverified",
          "common_checkpoint_unverified",
          ...(limited ? ["payload_limit"] : []),
          ...(nativeSchemaUnrecognized ? ["native_schema_unrecognized"] : []),
          ...(manifest.roles.nativeDatabases.length
            ? ["native_store_unclassified"]
            : []),
          ...classification.blockers,
        ]),
      ].sort(),
    };
  } catch (error) {
    if (error instanceof LegacyInventoryFailure) throw error;
    throw new LegacyInventoryFailure("inventory_failed");
  } finally {
    rmSync(outerTemp, { recursive: true, force: true });
  }
}

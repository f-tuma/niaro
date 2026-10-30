// Pure restore-instance contracts shared by the workflow owner and plain Node operator scripts.
const { createHash } = require("node:crypto");
const RESTORE_MARKER = ".attachment-restore.json";
const SNAPSHOT_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const hashBytes = (value) => createHash("sha256").update(value).digest("hex");
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const utcTime = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
function validateAttachmentManifest(a) {
  if (
    !exact(a, [
      "version",
      "completeness",
      "serverId",
      "owners",
      "locations",
      "objects",
      "pendingPurgeCount",
      "blockedUncertainCount",
      "objectSnapshotId",
    ]) ||
    a.version !== 1 ||
    !["metadata-only", "coordinated"].includes(a.completeness) ||
    typeof a.serverId !== "string" ||
    !SNAPSHOT_ID.test(a.serverId) ||
    !exact(a.owners, ["workflowDirectory", "identityDirectory"]) ||
    ![".", "workflow"].includes(a.owners.workflowDirectory) ||
    ![null, "identity"].includes(a.owners.identityDirectory) ||
    !Array.isArray(a.locations) ||
    a.locations.length > 5000 ||
    !Array.isArray(a.objects) ||
    a.objects.length > 5000 ||
    !Number.isSafeInteger(a.pendingPurgeCount) ||
    a.pendingPurgeCount < 0 ||
    !Number.isSafeInteger(a.blockedUncertainCount) ||
    a.blockedUncertainCount < 0 ||
    (a.completeness === "coordinated"
      ? typeof a.objectSnapshotId !== "string" ||
        !SNAPSHOT_ID.test(a.objectSnapshotId ?? "")
      : a.objectSnapshotId !== null)
  )
    throw Error("attachment manifest invalid");
  const locations = new Map();
  for (const location of a.locations) {
    const d = location.descriptor;
    if (
      !exact(location, ["id", "descriptor"]) ||
      !digest.test(location.id) ||
      !Array.isArray(d) ||
      d.length !== 6 ||
      d[0] !== 1 ||
      ![d[1], d[2], d[3], d[4]].every((v) => typeof v === "string") ||
      typeof d[5] !== "boolean" ||
      hashBytes(JSON.stringify(d)) !== location.id ||
      locations.has(location.id)
    )
      throw Error("attachment location invalid");
    const url = new URL(d[1]);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !/^([A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(d[4])
    )
      throw Error("attachment location invalid");
    locations.set(location.id, d);
  }
  const handles = new Set();
  let size = 0;
  for (const object of a.objects) {
    if (
      !exact(object, [
        "handleId",
        "locationId",
        "key",
        "owner",
        "contentId",
        "generation",
        "kind",
        "size",
        "sha256",
        "state",
      ]) ||
      !uuid.test(object.handleId) ||
      !uuid.test(object.owner) ||
      !uuid.test(object.contentId) ||
      !uuid.test(object.generation) ||
      object.owner !== object.generation ||
      !digest.test(object.sha256) ||
      !Number.isSafeInteger(object.size) ||
      object.size < 1 ||
      object.size > 26214400 ||
      !["original", "preview", "model", "extracted"].includes(object.kind) ||
      !["never-uploaded", "retained", "deleting", "quarantined"].includes(
        object.state,
      ) ||
      handles.has(object.handleId)
    )
      throw Error("attachment object invalid");
    const d = locations.get(object.locationId);
    if (
      !d ||
      object.key !==
        `${d[4]}/objects/${hashBytes(object.owner)}/${object.handleId}`
    )
      throw Error("attachment key invalid");
    handles.add(object.handleId);
    size += object.size;
  }
  if (size > 10 * 1024 * 1024 * 1024)
    throw Error("attachment inventory too large");
  return a;
}
function validateRestoreMarker(value) {
  if (
    !exact(value, [
      "version",
      "restoreId",
      "manifestSha256",
      "recoveryCutoff",
    ]) ||
    value.version !== 1 ||
    !uuid.test(value.restoreId) ||
    !(value.manifestSha256 === null || digest.test(value.manifestSha256)) ||
    !utcTime(value.recoveryCutoff)
  )
    throw Error("restore marker invalid");
  return value;
}

function validateDeletionEvidence(e) {
  if (
    !e ||
    !utcTime(e.recoveryCutoff) ||
    !utcTime(e.reviewedThrough) ||
    !exact(e.quiescence, [
      "oldOwnersStoppedBeforeCutoff",
      "remainStoppedThroughActivation",
    ]) ||
    e.quiescence.oldOwnersStoppedBeforeCutoff !== true ||
    e.quiescence.remainStoppedThroughActivation !== true
  )
    throw Error("deletion_gap");
  if (
    !exact(e, [
      "version",
      "restoreId",
      "manifestSha256",
      "objectSnapshotId",
      "recoveryCutoff",
      "basis",
      "reviewedThrough",
      "quiescence",
      "complete",
      "deletions",
    ]) ||
    e.version !== 1 ||
    !uuid.test(e.restoreId) ||
    !digest.test(e.manifestSha256) ||
    !(
      e.objectSnapshotId === null ||
      (typeof e.objectSnapshotId === "string" &&
        SNAPSHOT_ID.test(e.objectSnapshotId))
    ) ||
    !["current-owner-records", "manual-review"].includes(e.basis) ||
    e.complete !== true ||
    !Array.isArray(e.deletions) ||
    e.deletions.length > 10000
  )
    throw Error("reconciliation_conflict");
  const seen = new Set();
  for (const entry of e.deletions) {
    if (
      !exact(entry, ["scope", "conversationId", "generation"]) ||
      !exact(entry.scope, [
        "connectionId",
        "serverId",
        "userId",
        "workspaceId",
      ]) ||
      !Object.values(entry.scope).every(
        (v) => typeof v === "string" && SNAPSHOT_ID.test(v),
      ) ||
      typeof entry.conversationId !== "string" ||
      !SNAPSHOT_ID.test(entry.conversationId) ||
      !uuid.test(entry.generation)
    )
      throw Error("reconciliation_conflict");
    const s = entry.scope,
      key = JSON.stringify([
        s.connectionId,
        s.serverId,
        s.userId,
        s.workspaceId,
        entry.conversationId,
        entry.generation,
      ]);
    if (seen.has(key)) throw Error("reconciliation_conflict");
    seen.add(key);
  }
  return e;
}
function deletionCoverage(e, marker, source, now = Date.now()) {
  validateDeletionEvidence(e);
  validateRestoreMarker(marker);
  if (
    e.restoreId !== marker.restoreId ||
    e.manifestSha256 !== marker.manifestSha256 ||
    e.objectSnapshotId !== source.attachments.objectSnapshotId
  )
    throw Error("reconciliation_conflict");
  if (
    e.recoveryCutoff !== marker.recoveryCutoff ||
    !utcTime(source.createdAt) ||
    Date.parse(source.createdAt) > Date.parse(marker.recoveryCutoff) ||
    Date.parse(e.reviewedThrough) < Date.parse(marker.recoveryCutoff) ||
    Date.parse(e.reviewedThrough) > now
  )
    throw Error("deletion_gap");
  return e;
}
function validRestoreActivation(marker, row) {
  try {
    validateRestoreMarker(marker);
    if (
      !row ||
      row.restore_id !== marker.restoreId ||
      row.manifest_sha256 !== marker.manifestSha256 ||
      row.recovery_cutoff !== marker.recoveryCutoff ||
      row.state !== "serving" ||
      !utcTime(row.activated_at) ||
      !row.source_manifest ||
      !row.reconciliation_evidence ||
      !row.reconciliation_digest ||
      !row.last_verification ||
      !row.verification_digest ||
      hashBytes(String(row.source_manifest)) !== marker.manifestSha256 ||
      hashBytes(String(row.last_verification)) !== row.verification_digest
    )
      return false;
    const source = JSON.parse(String(row.source_manifest));
    validateAttachmentManifest(source.attachments);
    const e = deletionCoverage(
      JSON.parse(String(row.reconciliation_evidence)),
      marker,
      source,
      Date.parse(row.activated_at),
    );
    if (hashBytes(JSON.stringify(e)) !== row.reconciliation_digest)
      return false;
    const v = JSON.parse(String(row.last_verification));
    return (
      exact(v, [
        "version",
        "status",
        "restoreId",
        "barrier",
        "verifiedCount",
        "missingCount",
        "corruptCount",
        "blockedUncertainCount",
        "pendingPurgeCount",
        "deletionGap",
        "code",
      ]) &&
      v.version === 1 &&
      v.status === "activated" &&
      v.restoreId === marker.restoreId &&
      v.barrier === "serving" &&
      v.deletionGap === "reconciled" &&
      v.code === null &&
      v.missingCount === 0 &&
      v.corruptCount === 0 &&
      v.blockedUncertainCount === 0 &&
      Number.isSafeInteger(v.verifiedCount) &&
      v.verifiedCount >= 0 &&
      Number.isSafeInteger(v.pendingPurgeCount) &&
      v.pendingPurgeCount >= 0
    );
  } catch {
    return false;
  }
}

module.exports = {
  RESTORE_MARKER,
  SNAPSHOT_ID,
  validateAttachmentManifest,
  validateRestoreMarker,
  validateDeletionEvidence,
  deletionCoverage,
  validRestoreActivation,
};

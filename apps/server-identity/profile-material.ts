import { createHash } from "node:crypto";
import { ObservationStatementSchema } from "../../packages/protocol/memory";
import type {
  ObservationSource,
  MemoryItem,
} from "../../packages/protocol/memory";
import type { Scope } from "../../packages/protocol";

export type ProfileSourceRef = {
  type: "chat" | "meeting";
  sequence: number;
  sourceId: string;
  sourceVersion: number;
  digest: string;
  at: string;
  messageId?: string;
  meetingId?: string;
  /** Server-computed eligible projection binding; never model-selected. */
  projectionDigest?: string;
};
export type ProfileChatSource = {
  ref: ProfileSourceRef;
  scope: Scope;
  text: string;
  commandId: string;
  conversationId: string;
};
export type ProfileMeetingSource = {
  ref: ProfileSourceRef;
  scope: Scope;
  ownText: string[];
  ownTasks: string[];
};
export type ProfileProgress = {
  chat: number;
  chatOffset: number;
  meeting: number;
  meetingOffset: number;
  chatProjection?: string;
  meetingProjection?: string;
};
export type ProfileEvidence = {
  id: string;
  source: ObservationSource;
  sourceVersion: number;
  text: string;
  usedActions: { service: string; action: string }[];
};
export type ProfileMaterial = {
  evidence: ProfileEvidence[];
  prior: {
    id: string;
    revision: number;
    statement: string;
    section: string;
    personal: boolean;
  }[];
  next: ProfileProgress;
  refs: ProfileSourceRef[];
  userPayload: string;
  inputDigest: string;
};

/** Private learning projections; no service I/O or model-selected authority. */
export const normalizeObservation = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const folded = (text: string) =>
  normalizeObservation(text.normalize("NFKD").replace(/[\p{M}\p{Cf}]/gu, ""));

/** Quotes/code are evidence about a quotation, never about the author. */
export function stripQuotedText(text: string) {
  const lines = text
    .replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote\s*>/gi, "")
    .replace(/<blockquote\b[\s\S]*$/gi, "")
    .split(/\r?\n/);
  const result: string[] = [];
  let fence: string | undefined, end: string | undefined;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence || /^\s*>/.test(line)) continue;
    if (
      /^\s*(?:-{2,}\s*(?:original|forwarded|puvodni)|begin forwarded message:|on .{0,200}wrote:|dne .{0,200}napsal.{0,10}:|from:|od:)/i.test(
        folded(line),
      )
    )
      break;
    const pairs: Record<string, string> = {
      '"': '"',
      "“": "”",
      "„": "“",
      "«": "»",
      "‘": "’",
      "'": "'",
      "`": "`",
    };
    let clean = "";
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      if (end) {
        if (char === "\\") {
          i++;
          continue;
        }
        if (char === end) end = undefined;
      } else if (
        pairs[char] &&
        !(
          char === "'" &&
          /[\p{L}\p{N}]/u.test(line[i - 1] ?? "") &&
          /[\p{L}\p{N}]/u.test(line[i + 1] ?? "")
        )
      ) {
        end = pairs[char];
      } else clean += char;
    }
    // Ambiguous, unfinished quotation: discard the line conservatively.
    if (!end) result.push(clean);
  }
  return result.join("\n").trim();
}

const sensitive = [
  /\b(?:health|medical|doctor|diagnos\w*|diabet\w*|cancer|illness|medication|therapy|pregnan\w*|lekar\w*|zdravi|zdravotni|nemoc\w*|cukrov\w*|lecba|leky|tehot\w*)\b/,
  /\b(?:ethnic\w*|racial|race|etnic\w*|rasa|politic\w*|politick\w*|religio\w*|faith|belief\w*|nabozen\w*|vira|philosoph\w*|filozof\w*)\b/,
  /\b(?:trade union|union membership|odbory|odborove\w*|sexual\w*|sex life|sexu\w*|biometric\w*|biometr\w*|voiceprint|genetic\w*|genetick\w*|dna)\b/,
];
const credentials = [
  /\b(?:password|passwd|heslo|api[ _-]?key|secret|credential\w*|access token|bearer)\b/,
  /\b(?:sk[-_][a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{12,}|akia[a-z0-9]{16})\b/i,
  /\b[a-z]{2}\d{2}(?:[ ]?[a-z0-9]){11,30}\b/i,
  /\b\d(?:[ -]?\d){11,18}\b/,
  /\b(?:\d{1,6}-)?\d{2,10}\/\d{4}\b/,
];
const instructions = [
  /\b(?:ignore|override|disregard|bypass|disable|grant|approve|authorize)\b.{0,60}\b(?:instruction\w*|permission\w*|approval\w*|safeguard\w*|access|transfer\w*)\b/,
  /\b(?:always|must)\b.{0,40}\b(?:execute|send|delete|pay|transfer|bypass|approve)\b/,
  /\b(?:administrator|admin|root)\b.{0,12}\b(?:access|privileges|rights)\b/,
  /\b(?:ignoruj|obejdi|schval|udel|vypni)\b.{0,60}\b(?:instrukce|pokyny|pravidla|souhlas|schvaleni|opravneni)\b/,
  /\badministratorsk\w*\s+opravneni\b/,
];
export function isSafeObservation(text: string) {
  if (!ObservationStatementSchema.safeParse(text).success) return false;
  return isSafeProfileText(text);
}
export function isSafeProfileText(text: string) {
  const value = folded(text);
  return ![...sensitive, ...credentials, ...instructions].some((pattern) =>
    pattern.test(value),
  );
}
export function isPersonalObservation(text: string) {
  return /\b(?:kids|children|family|spouse|wife|husband|hobb\w*|football|soccer|deti|rodin\w*|manzel\w*|fotbal\w*|konick\w*)\b/.test(
    folded(text),
  );
}

/** Deterministic byte-bounded projection with code-point continuation and no result bodies. */
export function buildProfileMaterial(input: {
  scope: Scope;
  progress: ProfileProgress;
  chat: ProfileSourceRef[];
  meetings: ProfileSourceRef[];
  chatSource: (ref: ProfileSourceRef) => ProfileChatSource | null;
  meetingSource: (ref: ProfileSourceRef) => ProfileMeetingSource | null;
  usedActions: (
    commandId: string,
    conversationId: string,
  ) => { service: string; action: string }[];
  observations: MemoryItem[];
  personalThings: "keep" | "drop";
}): ProfileMaterial {
  const next = { ...input.progress },
    evidence: ProfileEvidence[] = [],
    refs: ProfileSourceRef[] = [];
  const sameOwner = (scope: Scope) =>
    JSON.stringify(scope) === JSON.stringify(input.scope) ||
    (scope.connectionId === input.scope.connectionId &&
      scope.serverId === input.scope.serverId &&
      scope.workspaceId === input.scope.workspaceId &&
      scope.userId === input.scope.userId);
  const payload = (prior: ProfileMaterial["prior"]) =>
    JSON.stringify({
      evidence: evidence.map(({ id, text, usedActions }) => ({
        id,
        text,
        usedActions,
      })),
      prior,
    });
  // The user payload becomes a JSON string inside the actual provider request.
  const payloadBytes = (prior: ProfileMaterial["prior"]) =>
    Buffer.byteLength(JSON.stringify(payload(prior)));
  const evidenceBytes = input.observations.length ? 6 * 1024 : 12 * 1024;
  const streams = {
    chat: input.chat.slice(0, 32),
    meeting: input.meetings.slice(0, 32),
  };
  const available = (["chat", "meeting"] as const).filter((type) =>
    streams[type].some((ref) => ref.sequence > next[type]),
  );
  const perStreamBytes = Math.floor(
    evidenceBytes / Math.max(1, available.length),
  );
  const fullStreams = new Set<"chat" | "meeting">();
  const ordered: ProfileSourceRef[] = [];
  for (
    let index = 0;
    index < Math.max(streams.chat.length, streams.meeting.length);
    index++
  )
    for (const type of ["chat", "meeting"] as const)
      if (streams[type][index]) ordered.push(streams[type][index]!);
  const streamBytes = (type: ProfileSourceRef["type"]) =>
    Buffer.byteLength(
      JSON.stringify(
        JSON.stringify(
          evidence
            .filter((item) => item.source.type === type)
            .map(({ id, text, usedActions }) => ({ id, text, usedActions })),
        ),
      ),
    );
  const outerBytes = () =>
    Buffer.byteLength(
      JSON.stringify({
        evidence,
        prior: [],
        next,
        refs,
        inputDigest: "a".repeat(64),
      }),
    );
  const outerAllowance = (input.observations.length ? 18 : 24) * 1024 - 256;
  for (const ref of ordered) {
    if (fullStreams.has(ref.type)) continue;
    const sequenceKey = ref.type === "chat" ? "chat" : "meeting",
      offsetKey = ref.type === "chat" ? "chatOffset" : "meetingOffset",
      projectionKey =
        ref.type === "chat" ? "chatProjection" : "meetingProjection";
    if (ref.sequence <= next[sequenceKey]) continue;
    const source =
      ref.type === "chat" ? input.chatSource(ref) : input.meetingSource(ref);
    const own = source && sameOwner(source.scope);
    if (!own) {
      next[sequenceKey] = ref.sequence;
      next[offsetKey] = 0;
      delete next[projectionKey];
      continue;
    }
    const raw = own
      ? "text" in source
        ? source.text
        : [...source.ownText, ...source.ownTasks].join("\n")
      : "";
    // A prohibited source fragment is discarded before the model, never redacted into a new assertion.
    const text = stripQuotedText(raw)
      .split(/\n|(?<=[.!?])\s+/u)
      .filter(
        (part) =>
          isSafeProfileText(part) &&
          !(input.personalThings === "drop" && isPersonalObservation(part)),
      )
      .join("\n");
    const usedActions =
      ref.type === "chat" && source && "commandId" in source
        ? input
            .usedActions(source.commandId, source.conversationId)
            .slice(0, 20)
            .map((action) => ({
              service: action.service.slice(0, 160),
              action: action.action.slice(0, 160),
            }))
            .filter((action) =>
              isSafeProfileText(action.service + " " + action.action),
            )
        : [];
    const chars = Array.from(text),
      units = usedActions.map(
        (action) => Array.from(JSON.stringify(action)).length + 1,
      );
    const projection = profileDigest({
      version: "profile-eligible/2",
      type: ref.type,
      sourceId: ref.sourceId,
      digest: ref.digest,
      text,
      usedActions,
    });
    const total = chars.length + units.reduce((sum, length) => sum + length, 0);
    let start = next[projectionKey] === projection ? next[offsetKey] : 0;
    if (start > chars.length) {
      let boundary = chars.length;
      for (const length of units) {
        if (boundary >= start) break;
        boundary += length;
      }
      if (boundary !== start) start = 0;
    }
    if (start >= total) {
      next[sequenceKey] = ref.sequence;
      next[offsetKey] = 0;
      delete next[projectionKey];
      continue;
    }
    const provenance =
      ref.type === "chat"
        ? {
            type: "chat" as const,
            sourceId: ref.sourceId,
            messageId: ref.messageId!,
            at: ref.at,
            digest: ref.digest,
          }
        : {
            type: "meeting" as const,
            sourceId: ref.sourceId,
            meetingId: ref.meetingId!,
            at: ref.at,
            digest: ref.digest,
          };
    const item: ProfileEvidence = {
      id: `e${evidence.length + 1}`,
      source: provenance,
      sourceVersion: ref.sourceVersion,
      text: "",
      usedActions: [],
    };
    evidence.push(item);
    refs.push({ ...ref, projectionDigest: projection });
    const fits = () =>
      payloadBytes([]) <= evidenceBytes &&
      streamBytes(ref.type) <= perStreamBytes &&
      outerBytes() <= outerAllowance;
    let lo = 0,
      hi = Math.max(0, chars.length - start);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      item.text = chars.slice(start, start + mid).join("");
      if (fits()) lo = mid;
      else hi = mid - 1;
    }
    item.text = chars.slice(start, start + lo).join("");
    let end = start + lo;
    if (end >= chars.length) {
      let boundary = chars.length,
        index = 0;
      while (boundary < end && index < units.length)
        boundary += units[index++]!;
      for (; index < usedActions.length; index++) {
        item.usedActions.push(usedActions[index]!);
        if (!fits()) {
          item.usedActions.pop();
          break;
        }
        end += units[index]!;
      }
    }
    if (end === start) {
      evidence.pop();
      refs.pop();
      fullStreams.add(ref.type);
      continue;
    }
    if (end === total) {
      next[sequenceKey] = ref.sequence;
      next[offsetKey] = 0;
      delete next[projectionKey];
    } else {
      next[offsetKey] = end;
      next[projectionKey] = projection;
      fullStreams.add(ref.type);
    }
  }
  const terms = new Set(
    normalizeObservation(evidence.map((item) => item.text).join(" ")).match(
      /[\p{L}\p{N}]{3,}/gu,
    ) ?? [],
  );
  const prior: ProfileMaterial["prior"] = [];
  for (const item of input.observations
    .filter(
      (item) => item.origin === "observed" && item.source?.type === "observed",
    )
    .map((item) => ({
      item,
      score: [...terms].reduce(
        (score, term) =>
          score +
          Number(normalizeObservation(item.content ?? "").includes(term)),
        0,
      ),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.item.seenAt ?? "").localeCompare(a.item.seenAt ?? "") ||
        a.item.id.localeCompare(b.item.id),
    )) {
    if (prior.length === 24) break;
    if (item.item.source?.type !== "observed") continue;
    const row = {
      id: item.item.id,
      revision: item.item.revision,
      statement: item.item.content!,
      section: item.item.source.section,
      personal: item.item.source.personal,
    };
    if (
      Buffer.byteLength(JSON.stringify([...prior, row])) <= 6 * 1024 &&
      payloadBytes([...prior, row]) <= 12 * 1024
    )
      prior.push(row);
  }
  const userPayload = payload(prior);
  const result = { evidence, prior, next, refs, userPayload, inputDigest: "" };
  // Locator movement alone changes no model evidence; current versions are fenced separately.
  result.inputDigest = profileDigest({
    userPayload,
    refs: refs.map(({ sourceVersion: _, ...ref }) => ref),
    priorRevisions: input.observations
      .map((item) => [item.id, item.revision])
      .sort(),
  });
  if (
    Buffer.byteLength(
      JSON.stringify({
        evidence,
        prior,
        next,
        refs,
        inputDigest: result.inputDigest,
      }),
    ) >
    24 * 1024
  )
    throw Error("profile_material_limit");
  return result;
}

export const profileDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const MAX_METADATA = 4096;
export const MAX_INPUT = 26_214_400;
export const MAX_RESULT = 2_097_152;
export const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
export const IDLE_MS = 15_000;
export const TRANSFER_MS = 120_000;
export const BUFFER_BYTES = 65_536;

export type BootRef = { epoch: string; counter: number };
export type Identity = {
  protocol: 1;
  processorVersion: string;
  imageBuildSha: string;
  gatePolicySha: string;
  enginePolicySha: string;
  assetsSha: string;
  probeSuiteSha: string;
  platformSha: string;
  deploymentSha: string;
};
export type Boot = BootRef & { identity: Identity };
export type Format =
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "csv"
  | "tsv"
  | "txt"
  | "md"
  | "png"
  | "jpg";
export type Job = {
  jobId: string;
  attempt: number;
  generation: string;
  attemptVersion: number;
  contentId: string;
  sha256: string;
  inputBytes: number;
  format: Format;
  processorVersion: string;
  limitsProfile: "conversion-v1";
};
export type Request =
  | { version: 1; op: "status"; query: "readiness" }
  | { version: 1; op: "status"; query: "job"; job: Job }
  | { version: 1; op: "submit" | "cancel"; job: Job }
  | { version: 1; op: "ack"; job: Job; outcomeSha256: string };
export type FailureReason =
  | "input_limit"
  | "malformed"
  | "timeout"
  | "cancelled"
  | "resource_unknown"
  | "interrupted"
  | "invalid_result"
  | "output_limit"
  | "scratch_limit"
  | "unavailable";
export type Outcome =
  | { kind: "result"; bytes: number; sha256: string }
  | { kind: "failure"; reason: FailureReason };
type Base = { version: 1; op: Request["op"] | null; boot: Boot };
export type Response = Base &
  (
    | {
        kind: "readiness";
        state:
          | "starting"
          | "ready"
          | "running"
          | "restarting"
          | "retained"
          | "unavailable";
        slot: "empty" | "occupied";
        qualificationKey: string | null;
        probe: BootRef | null;
        reason:
          | "none"
          | "startup"
          | "busy"
          | "restarting"
          | "qualification_required"
          | "qualification_failed"
          | "unavailable";
        retryAfterMs: number | null;
      }
    | {
        kind: "job";
        job: Job;
        state: "receiving" | "running";
        origin: BootRef;
        retryAfterMs: number;
      }
    | {
        kind: "outcome";
        job: Job;
        origin: BootRef;
        outcome: Outcome;
        outcomeSha256: string;
      }
    | {
        kind: "cancel";
        job: Job;
        origin: BootRef;
        disposition: "requested" | "already_requested" | "terminal";
      }
    | {
        kind: "ack";
        job: Job;
        disposition: "cleared" | "already_cleared" | "absent";
      }
    | { kind: "absent"; job: Job; disposition: "absent" | "already_acked" }
    | {
        kind: "error";
        job: Job | null;
        code:
          | "invalid_request"
          | "unsupported_version"
          | "busy"
          | "conflict"
          | "restarting"
          | "unavailable"
          | "not_terminal"
          | "not_recycled"
          | "already_acked";
        retryAfterMs: number | null;
      }
  );
export type Qualification = {
  version: 1;
  key: string;
  phase: "probing" | "passed" | "blocked";
  tries: 1 | 2;
  probe: BootRef;
  testDigest: string | null;
  firstServing: BootRef | null;
};
export type Source = {
  kind:
    | "page"
    | "sheet"
    | "slide"
    | "slideShape"
    | "documentBlock"
    | "table"
    | "row"
    | "image";
  ordinal: number;
  parent?: number;
  name?: string;
  visibility?: "visible" | "hidden" | "veryHidden";
  region?: [number, number, number, number];
};
export type Block = {
  source: number;
  ordinal: number;
  method: "native" | "ocr";
  text: string;
};
export type Cell = {
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  type: "text" | "number" | "boolean" | "date" | "formula" | "empty";
  value: string | null;
  display: string;
  numberFormat?: string;
};
export type Table = {
  source: number;
  ordinal: number;
  rows: number;
  columns: number;
  cells: Cell[];
};
export type Omitted = {
  source?: number;
  kind: "page" | "sheet" | "slide" | "block" | "image" | "table" | "unknown";
  ordinal?: number;
  reason:
    | "unsupported_feature"
    | "embedded_resource"
    | "layout_unverified"
    | "formula_not_evaluated"
    | "cache_unknown"
    | "limit_reached"
    | "coverage_unknown";
};
export type Warning = {
  code:
    | "ocr_requires_review"
    | "low_confidence"
    | "mixed_raster"
    | "layout_unverified"
    | "embedded_omitted"
    | "formula_not_evaluated"
    | "cache_unknown"
    | "hidden_content"
    | "coverage_unknown"
    | "limit_reached";
  source?: number;
};
export type ResultReason =
  | "none"
  | "ocr_review"
  | "coverage_incomplete"
  | "unsupported"
  | "protected"
  | "malformed"
  | "empty"
  | "input_limit"
  | "page_limit"
  | "pixel_limit"
  | "office_expansion_limit"
  | "cell_limit"
  | "output_limit"
  | "scratch_limit"
  | "timeout"
  | "cancelled"
  | "resource_unknown"
  | "interrupted"
  | "invalid_result"
  | "unavailable";
export type ConversionResultV1 = {
  version: 1;
  processorVersion: string;
  status: "complete" | "partial" | "failed";
  reason: ResultReason;
  sources: Source[];
  blocks: Block[];
  tables: Table[];
  coverage: { totalUnits: number; visitedUnits: number; omitted: Omitted[] };
  warnings: Warning[];
};

export class ConversionWireError extends Error {
  constructor() {
    super("invalid conversion wire");
  }
}
function check(ok: unknown): asserts ok {
  if (!ok) throw new ConversionWireError();
}
type Obj = Record<string, unknown>;
const words = (s: string) => (s ? s.split(" ") : []);
function object(v: unknown, required: string, optional = ""): Obj {
  check(typeof v === "object" && v !== null && !Array.isArray(v));
  const m = v as Obj,
    keys = words(required),
    allowed = [...keys, ...words(optional)];
  check(
    keys.every((k) => Object.hasOwn(m, k)) &&
      Object.keys(m).every((k) => allowed.includes(k)),
  );
  return m;
}
function str(v: unknown, max: number): string {
  check(typeof v === "string" && Buffer.byteLength(v, "utf8") <= max);
  return v;
}
function choice(v: unknown, options: string): string {
  const s = str(v, 128);
  check(words(options).includes(s));
  return s;
}
function int(v: unknown, min: number, max: number): number {
  check(
    typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max,
  );
  return v;
}
function arr(v: unknown, max: number): unknown[] {
  check(Array.isArray(v) && v.length <= max);
  return v;
}
function opt(m: Obj, k: string, f: (v: unknown) => unknown) {
  if (Object.hasOwn(m, k)) f(m[k]);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const EPOCH = /^[0-9a-f]{32}$/;
const PROCESSOR = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const FORMATS = "pdf docx xlsx pptx csv tsv txt md png jpg";
const FAILURES =
  "input_limit malformed timeout cancelled resource_unknown interrupted invalid_result output_limit scratch_limit unavailable";
const IDENTITY_KEYS =
  "protocol processorVersion imageBuildSha gatePolicySha enginePolicySha assetsSha probeSuiteSha platformSha deploymentSha";
const JOB_KEYS =
  "jobId attempt generation attemptVersion contentId sha256 inputBytes format processorVersion limitsProfile";
function match(v: unknown, re: RegExp): string {
  const s = str(v, 128);
  check(whole(re, s));
  return s;
}
function whole(re: RegExp, s: string): boolean {
  return re.exec(s)?.[0] === s;
}

// Independent byte parser: no JSON.parse/reviver duplicate-key blind spot. Byte,
// depth, count and decoded string bounds are checked before appending/decoding.
export function strictJSON(bytes: Uint8Array, max: number): unknown {
  check(bytes.byteLength >= 2 && bytes.byteLength <= max);
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    throw new ConversionWireError();
  }
  let i = 0,
    nodes = 0;
  const ws = () => {
    while (i < b.length && [32, 9, 10, 13].includes(b[i]!)) i++;
  };
  const take = (c: number) => {
    ws();
    if (b[i] === c) {
      i++;
      return true;
    }
    return false;
  };
  const hex4 = () => {
    const s = b.subarray(i, i + 4).toString("ascii");
    check(s.length === 4 && /^[0-9a-fA-F]{4}$/.test(s));
    i += 4;
    return parseInt(s, 16);
  };
  const string = (limit: number): string => {
    ws();
    check(b[i] === 34);
    const start = i++;
    let size = 0;
    while (i < b.length) {
      const c = b[i++]!;
      if (c === 34) {
        try {
          return JSON.parse(b.subarray(start, i).toString("utf8")) as string;
        } catch {
          throw new ConversionWireError();
        }
      }
      check(c >= 32);
      if (c === 92) {
        const e = b[i++];
        if (e === 117) {
          const n = hex4();
          check(n < 0xdc00 || n > 0xdfff);
          if (n >= 0xd800 && n <= 0xdbff) {
            check(b[i++] === 92 && b[i++] === 117);
            const lo = hex4();
            check(lo >= 0xdc00 && lo <= 0xdfff);
            size += 4;
          } else size += n < 128 ? 1 : n < 2048 ? 2 : 3;
        } else {
          check(
            e !== undefined && [34, 92, 47, 98, 102, 110, 114, 116].includes(e),
          );
          size++;
        }
      } else size++;
      check(size <= limit);
    }
    throw new ConversionWireError();
  };
  const value = (depth: number, field?: string): unknown => {
    ws();
    check(++nodes <= 220_000 && i < b.length);
    const c = b[i];
    if (c === 123 || c === 91) check(depth < 10);
    if (take(123)) {
      const m: Obj = Object.create(null);
      if (take(125)) return m;
      let count = 0;
      for (;;) {
        check(count++ < 16);
        const k = string(64);
        check(!Object.hasOwn(m, k) && take(58));
        m[k] = value(depth + 1, k);
        if (take(125)) return m;
        check(take(44));
      }
    }
    if (take(91)) {
      const limit =
        field === "region"
          ? 4
          : field && ["tables", "warnings", "omitted"].includes(field)
            ? 256
            : 20_000;
      const a: unknown[] = [];
      if (take(93)) return a;
      for (;;) {
        check(a.length < limit);
        a.push(value(depth + 1));
        if (take(93)) return a;
        check(take(44));
      }
    }
    if (c === 34)
      return string(
        !field || field === "text"
          ? 256 * 1024
          : field === "value" || field === "display"
            ? 4096
            : field === "name"
              ? 256
              : 128,
      );
    for (const [s, v] of [
      ["null", null],
      ["true", true],
      ["false", false],
    ] as const) {
      if (b.subarray(i, i + s.length).toString("ascii") === s) {
        i += s.length;
        return v;
      }
    }
    const start = i;
    while (i < b.length && /[0-9eE+.\-]/.test(String.fromCharCode(b[i]!))) {
      i++;
    }
    const raw = b.subarray(start, i).toString("ascii");
    const n = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(
      raw,
    );
    check(n);
    const digits = (n[2]! + (n[3] ?? "")).replace(/^0+/, "");
    if (!digits) return 0;
    check(!n[1]);
    const core = digits.replace(/0+$/, "");
    const exponent = Number(n[4] ?? 0);
    const shift = exponent - (n[3]?.length ?? 0) + digits.length - core.length;
    check(shift >= 0 && core.length + shift <= 16);
    const exact = BigInt(core + "0".repeat(shift));
    check(exact <= BigInt(MAX_COUNTER));
    return Number(exact);
  };
  const result = value(0);
  ws();
  check(i === b.length);
  return result;
}

function identity(v: unknown): Identity {
  const m = object(v, IDENTITY_KEYS);
  int(m.protocol, 1, 1);
  match(m.processorVersion, PROCESSOR);
  for (const k of words(IDENTITY_KEYS).slice(2)) match(m[k], SHA);
  return m as Identity;
}
function bootRef(v: unknown): BootRef {
  const m = object(v, "epoch counter");
  match(m.epoch, EPOCH);
  int(m.counter, 1, MAX_COUNTER);
  return m as BootRef;
}
function boot(v: unknown): Boot {
  const m = object(v, "epoch counter identity");
  match(m.epoch, EPOCH);
  int(m.counter, 1, MAX_COUNTER);
  identity(m.identity);
  return m as Boot;
}
function job(v: unknown): Job {
  const m = object(v, JOB_KEYS);
  for (const k of ["jobId", "generation", "contentId"]) match(m[k], UUID);
  for (const k of ["attempt", "attemptVersion"]) int(m[k], 1, 2_147_483_647);
  match(m.sha256, SHA);
  int(m.inputBytes, 1, MAX_INPUT);
  choice(m.format, FORMATS);
  match(m.processorVersion, PROCESSOR);
  choice(m.limitsProfile, "conversion-v1");
  return m as Job;
}
function outcome(v: unknown): Outcome {
  const m = object(v, "kind", "bytes sha256 reason");
  const k = choice(m.kind, "result failure");
  if (k === "result") {
    object(m, "kind bytes sha256");
    int(m.bytes, 1, MAX_RESULT);
    match(m.sha256, SHA);
  } else {
    object(m, "kind reason");
    choice(m.reason, FAILURES);
  }
  return m as Outcome;
}
export const decodeIdentity = (b: Uint8Array) =>
  identity(strictJSON(b, MAX_METADATA));
export const decodeJob = (b: Uint8Array) => job(strictJSON(b, MAX_METADATA));
export function decodeQualification(b: Uint8Array): Qualification {
  const m = object(
    strictJSON(b, MAX_METADATA),
    "version key phase tries probe testDigest firstServing",
  );
  int(m.version, 1, 1);
  match(m.key, SHA);
  const phase = choice(m.phase, "probing passed blocked");
  int(m.tries, 1, 2);
  const p = bootRef(m.probe);
  if (phase === "passed") {
    match(m.testDigest, SHA);
    if (m.firstServing !== null) check(recycled(bootRef(m.firstServing), p));
  } else check(m.testDigest === null && m.firstServing === null);
  return m as Qualification;
}
export function decodeRequest(b: Uint8Array): Request {
  const m = object(
    strictJSON(b, MAX_METADATA),
    "version op",
    "query job outcomeSha256",
  );
  int(m.version, 1, 1);
  const op = choice(m.op, "status submit cancel ack");
  if (op === "status") {
    const q = choice(m.query, "readiness job");
    if (q === "readiness") {
      object(m, "version op query");
      return m as Request;
    }
    object(m, "version op query job");
  } else if (op === "ack") {
    object(m, "version op job outcomeSha256");
    match(m.outcomeSha256, SHA);
  } else object(m, "version op job");
  job(m.job);
  return m as Request;
}
export function recycled(current: BootRef, origin: BootRef): boolean {
  return current.epoch !== origin.epoch && current.counter > origin.counter;
}
function sameBoot(a: BootRef, b: BootRef) {
  return a.epoch === b.epoch && a.counter === b.counter;
}
function retry(v: unknown, required: boolean) {
  if (required) int(v, 1000, 10000);
  else check(v === null);
}
export function decodeResponse(b: Uint8Array): Response {
  const m = object(
    strictJSON(b, MAX_METADATA),
    "version op boot kind",
    "state slot qualificationKey probe reason retryAfterMs job origin outcome outcomeSha256 disposition code",
  );
  int(m.version, 1, 1);
  const current = boot(m.boot);
  if (m.op !== null) choice(m.op, "submit status cancel ack");
  const k = choice(m.kind, "readiness job outcome cancel ack absent error"),
    prefix = "version op boot kind ";
  if (k === "readiness") {
    object(m, prefix + "state slot qualificationKey probe reason retryAfterMs");
    check(m.op === "status");
    const state = choice(
        m.state,
        "starting ready running restarting retained unavailable",
      ),
      slot = choice(m.slot, "empty occupied"),
      reason = choice(
        m.reason,
        "none startup busy restarting qualification_required qualification_failed unavailable",
      );
    check((m.qualificationKey === null) === (m.probe === null));
    if (m.probe !== null) {
      check(
        match(m.qualificationKey, SHA) ===
          sha256(qualificationBytes(current.identity)) &&
          (sameBoot(current, bootRef(m.probe)) ||
            recycled(current, bootRef(m.probe))),
      );
    }
    switch (state) {
      case "ready":
        check(
          slot === "empty" &&
            reason === "none" &&
            m.probe !== null &&
            recycled(current, bootRef(m.probe)),
        );
        break;
      case "starting":
        check(reason === "startup" || reason === "qualification_required");
        break;
      case "running":
      case "retained":
        check(slot === "occupied" && reason === "busy");
        break;
      case "restarting":
        check(slot === "occupied" && reason === "restarting");
        break;
      case "unavailable":
        check(reason === "qualification_failed" || reason === "unavailable");
    }
    retry(m.retryAfterMs, state !== "ready" && state !== "unavailable");
    return m as Response;
  }
  if (k === "error") {
    object(m, prefix + "job code retryAfterMs");
    const c = choice(
      m.code,
      "invalid_request unsupported_version busy conflict restarting unavailable not_terminal not_recycled already_acked",
    );
    if (m.job !== null) {
      check(m.op !== null);
      job(m.job);
    }
    retry(m.retryAfterMs, c === "busy" || c === "restarting");
    return m as Response;
  }
  const j = job(m.job);
  switch (k) {
    case "job":
      object(m, prefix + "job state origin retryAfterMs");
      check(m.op === "status" || m.op === "submit");
      choice(m.state, "receiving running");
      check(sameBoot(current, bootRef(m.origin)));
      retry(m.retryAfterMs, true);
      break;
    case "outcome": {
      object(m, prefix + "job origin outcome outcomeSha256");
      check(m.op === "status" || m.op === "submit");
      const o = bootRef(m.origin),
        d = outcome(m.outcome);
      check(sameBoot(current, o) || recycled(current, o));
      check(match(m.outcomeSha256, SHA) === sha256(outcomeBytes(j, o, d)));
      break;
    }
    case "cancel": {
      object(m, prefix + "job origin disposition");
      check(m.op === "cancel");
      const o = bootRef(m.origin),
        d = choice(m.disposition, "requested already_requested terminal");
      check(sameBoot(current, o) || (d === "terminal" && recycled(current, o)));
      break;
    }
    case "ack":
      object(m, prefix + "job disposition");
      check(m.op === "ack");
      choice(m.disposition, "cleared already_cleared absent");
      break;
    case "absent":
      object(m, prefix + "job disposition");
      check(m.op === "status" || m.op === "cancel");
      choice(m.disposition, "absent already_acked");
      break;
  }
  return m as Response;
}

const quote = (s: string) => `"${s}"`;
function qualificationBytes(id: Identity): Buffer {
  return Buffer.from(
    `[${[
      quote("conversion-qualification/1"),
      "1",
      quote(id.processorVersion),
      ...words(IDENTITY_KEYS)
        .slice(2)
        .map((k) => quote(id[k as keyof Identity] as string)),
    ].join(",")}]`,
    "ascii",
  );
}
function outcomeBytes(j: Job, o: BootRef, d: Outcome): Buffer {
  const fields = words(JOB_KEYS)
    .map(
      (k) =>
        `${quote(k)}:${typeof j[k as keyof Job] === "number" ? String(j[k as keyof Job]) : quote(j[k as keyof Job] as string)}`,
    )
    .join(",");
  const descriptor =
    d.kind === "result"
      ? `{"kind":"result","bytes":${d.bytes},"sha256":${quote(d.sha256)}}`
      : `{"kind":"failure","reason":${quote(d.reason)}}`;
  return Buffer.from(
    `["conversion-outcome/1",{${fields}},{"epoch":${quote(o.epoch)},"counter":${o.counter}},${descriptor}]`,
    "ascii",
  );
}
export function hashInput(
  bytes: Uint8Array,
  kind: "qualification" | "outcome",
): Buffer {
  const v = strictJSON(bytes, MAX_METADATA);
  if (kind === "qualification") return qualificationBytes(identity(v));
  check(kind === "outcome");
  const m = object(v, "job origin outcome");
  return outcomeBytes(job(m.job), bootRef(m.origin), outcome(m.outcome));
}
export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export function validateReply(
  req: Request,
  res: Response,
  expected: Identity,
  ackOrigin?: BootRef,
): void {
  identity(expected);
  check(
    sha256(qualificationBytes(expected)) ===
      sha256(qualificationBytes(res.boot.identity)) && res.op === req.op,
  );
  const requested = "job" in req ? req.job : null,
    returned = "job" in res ? res.job : null;
  if (!requested)
    check(
      returned === null && (res.kind === "readiness" || res.kind === "error"),
    );
  else {
    check(res.kind !== "readiness");
    if (res.kind !== "error" || returned !== null)
      check(returned !== null && jobEqual(requested, returned));
  }
  if (res.kind === "ack" && res.disposition !== "absent")
    check(ackOrigin && recycled(res.boot, bootRef(ackOrigin)));
}
function jobEqual(a: Job, b: Job) {
  return words(JOB_KEYS).every((k) => a[k as keyof Job] === b[k as keyof Job]);
}

export function decodeResult(bytes: Uint8Array): ConversionResultV1 {
  const m = object(
    strictJSON(bytes, MAX_RESULT),
    "version processorVersion status reason sources blocks tables coverage warnings",
  );
  int(m.version, 1, 1);
  match(m.processorVersion, PROCESSOR);
  const status = choice(m.status, "complete partial failed"),
    reason = choice(
      m.reason,
      "none ocr_review coverage_incomplete unsupported protected malformed empty input_limit page_limit pixel_limit office_expansion_limit cell_limit output_limit scratch_limit timeout cancelled resource_unknown interrupted invalid_result unavailable",
    );
  const sources = arr(m.sources, 20_000),
    blocks = arr(m.blocks, 20_000),
    tables = arr(m.tables, 256),
    warnings = arr(m.warnings, 256);
  const source = (v: unknown) => int(v, 0, sources.length - 1),
    sourceIDs = new Set<string>();
  sources.forEach((v, index) => {
    const s = object(v, "kind ordinal", "parent name visibility region"),
      kind = choice(
        s.kind,
        "page sheet slide slideShape documentBlock table row image",
      ),
      ordinal = int(
        s.ordinal,
        1,
        kind === "page" || kind === "slide" ? 100 : 20_000,
      );
    let parent = -1;
    opt(s, "parent", (v) => (parent = int(v, 0, index - 1)));
    opt(s, "name", (v) => str(v, 256));
    opt(s, "visibility", (v) => {
      check(kind === "sheet");
      choice(v, "visible hidden veryHidden");
    });
    const id = `${kind}:${parent}:${ordinal}`;
    check(!sourceIDs.has(id));
    sourceIDs.add(id);
    opt(s, "region", (v) => {
      const a = arr(v, 4);
      check(a.length === 4);
      const ns = a.map((v) => int(v, 0, 1_000_000));
      check(ns[0]! <= ns[2]! && ns[1]! <= ns[3]!);
      const pk = parent < 0 ? kind : (sources[parent] as Obj).kind;
      check(pk === "page" || pk === "slide" || pk === "image");
    });
  });
  const blockIDs = new Set<string>(),
    tableIDs = new Set<string>();
  let totalText = 0,
    totalCells = 0,
    hasOCR = false,
    hasFormula = false;
  for (const v of blocks) {
    const b = object(v, "source ordinal method text"),
      s = source(b.source),
      n = int(b.ordinal, 1, MAX_COUNTER),
      id = `${s}:${n}`;
    check(!blockIDs.has(id));
    blockIDs.add(id);
    const method = choice(b.method, "native ocr");
    hasOCR ||= method === "ocr";
    totalText += Buffer.byteLength(str(b.text, 256 * 1024));
    check(totalText <= 1024 * 1024);
  }
  for (const v of tables) {
    const t = object(v, "source ordinal rows columns cells"),
      s = source(t.source),
      n = int(t.ordinal, 1, MAX_COUNTER),
      id = `${s}:${n}`;
    check(!tableIDs.has(id));
    tableIDs.add(id);
    const rows = int(t.rows, 0, 20_000),
      columns = int(t.columns, 0, 256),
      cells = arr(t.cells, 20_000);
    totalCells += cells.length;
    check(totalCells <= 20_000);
    const rectangles: {
      row: number;
      col: number;
      height: number;
      width: number;
    }[] = [];
    for (const v of cells) {
      const c = object(
          v,
          "row column rowSpan columnSpan type value display",
          "numberFormat",
        ),
        row = int(c.row, 0, rows - 1),
        col = int(c.column, 0, columns - 1),
        height = int(c.rowSpan, 1, rows - row),
        width = int(c.columnSpan, 1, columns - col);
      rectangles.push({ row, col, height, width });
      const kind = choice(c.type, "text number boolean date formula empty");
      str(c.display, 4096);
      opt(c, "numberFormat", (v) => str(v, 128));
      if (kind === "empty") check(c.value === null);
      else {
        const value = str(c.value, 4096);
        switch (kind) {
          case "number":
            check(
              whole(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/, value),
            );
            break;
          case "boolean":
            check(value === "true" || value === "false");
            break;
          case "date":
            check(isoDate(value));
            break;
          case "formula":
            check(value.startsWith("="));
            hasFormula = true;
            break;
        }
      }
    }
    rectangles.sort((a, b) => a.row - b.row);
    const ends = new Array<number>(256).fill(0);
    for (const r of rectangles)
      for (let col = r.col; col < r.col + r.width; col++) {
        check(ends[col]! <= r.row);
        ends[col] = r.row + r.height;
      }
  }
  const c = object(m.coverage, "totalUnits visitedUnits omitted"),
    total = int(c.totalUnits, 0, 20_000),
    visited = int(c.visitedUnits, 0, total),
    omitted = arr(c.omitted, 256);
  for (const v of omitted) {
    const o = object(v, "kind reason", "source ordinal");
    choice(o.kind, "page sheet slide block image table unknown");
    choice(
      o.reason,
      "unsupported_feature embedded_resource layout_unverified formula_not_evaluated cache_unknown limit_reached coverage_unknown",
    );
    opt(o, "source", source);
    opt(o, "ordinal", (v) => int(v, 1, 20_000));
  }
  const codes = new Set<string>();
  for (const v of warnings) {
    const w = object(v, "code", "source");
    codes.add(
      choice(
        w.code,
        "ocr_requires_review low_confidence mixed_raster layout_unverified embedded_omitted formula_not_evaluated cache_unknown hidden_content coverage_unknown limit_reached",
      ),
    );
    opt(w, "source", source);
  }
  if (status === "failed")
    check(
      reason !== "none" &&
        reason !== "ocr_review" &&
        reason !== "coverage_incomplete" &&
        sources.length === 0 &&
        blocks.length === 0 &&
        tables.length === 0 &&
        visited === 0,
    );
  else {
    check(sources.length > 0 && blocks.length + totalCells > 0 && visited > 0);
    if (status === "complete") {
      check(
        reason === "none" &&
          visited === total &&
          omitted.length === 0 &&
          !hasOCR &&
          !hasFormula,
      );
      for (const code of codes) check(code === "hidden_content");
    } else check(reason !== "none" && omitted.length > 0);
  }
  if (hasOCR) check(status === "partial" && codes.has("ocr_requires_review"));
  if (hasFormula)
    check(status === "partial" && codes.has("formula_not_evaluated"));
  return m as ConversionResultV1;
}
function isoDate(value: string): boolean {
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:T(.*))?$/.exec(value);
  if (date && date[0] !== value) return false;
  let clock: string;
  if (date) {
    const year = Number(date[1]),
      month = Number(date[2]),
      day = Number(date[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!)
      return false;
    if (date[4] === undefined) return true;
    clock = date[4];
  } else clock = value;
  const t =
    /^(\d{2}):(\d{2}):(\d{2})(?:\.[0-9]{1,9})?(Z|[+-]\d{2}:\d{2})?$/.exec(
      clock,
    );
  if (
    !t ||
    t[0] !== clock ||
    Number(t[1]) > 23 ||
    Number(t[2]) > 59 ||
    Number(t[3]) > 59
  )
    return false;
  if (date && t[4] === undefined) return false;
  if (t[4] && t[4] !== "Z")
    return Number(t[4].slice(1, 3)) <= 23 && Number(t[4].slice(4)) <= 59;
  return true;
}

export type Reply = {
  metadata: Buffer;
  response: Response;
  body: Buffer;
  result: ConversionResultV1 | null;
};

// Incremental frame decoder stores only bounded metadata/result buffers. It
// returns nothing until end() proves EOF; extra chunks always invalidate it.
export class ResponseDecoder {
  private header = Buffer.alloc(4);
  private headerUsed = 0;
  private phase: "metadata-size" | "metadata" | "body-size" | "body" | "eof" =
    "metadata-size";
  private metadata = Buffer.alloc(0);
  private body = Buffer.alloc(0);
  private used = 0;
  private response: Response | null = null;
  private failed = false;
  private ended = false;
  push(bytes: Uint8Array): void {
    try {
      check(!this.failed && !this.ended);
      let offset = 0;
      while (offset < bytes.byteLength) {
        check(this.phase !== "eof");
        if (this.phase === "metadata-size" || this.phase === "body-size") {
          const n = Math.min(4 - this.headerUsed, bytes.byteLength - offset);
          this.header.set(bytes.subarray(offset, offset + n), this.headerUsed);
          offset += n;
          this.headerUsed += n;
          if (this.headerUsed < 4) continue;
          const size = this.header.readUInt32BE();
          this.headerUsed = 0;
          if (this.phase === "metadata-size") {
            check(size >= 2 && size <= MAX_METADATA);
            this.metadata = Buffer.alloc(size);
            this.phase = "metadata";
          } else {
            const expected =
              this.response?.kind === "outcome" &&
              this.response.outcome.kind === "result"
                ? this.response.outcome.bytes
                : 0;
            check(size <= MAX_RESULT && size === expected);
            this.body = Buffer.alloc(size);
            this.phase = size ? "body" : "eof";
          }
          this.used = 0;
        } else {
          const target = this.phase === "metadata" ? this.metadata : this.body,
            n = Math.min(target.length - this.used, bytes.byteLength - offset);
          target.set(bytes.subarray(offset, offset + n), this.used);
          offset += n;
          this.used += n;
          if (this.used === target.length) {
            if (this.phase === "metadata") {
              this.response = decodeResponse(this.metadata);
              this.phase = "body-size";
            } else this.phase = "eof";
          }
        }
      }
    } catch {
      this.failed = true;
      throw new ConversionWireError();
    }
  }
  end(): Reply {
    check(!this.failed && !this.ended && this.phase === "eof" && this.response);
    this.ended = true;
    let result: ConversionResultV1 | null = null;
    if (
      this.response.kind === "outcome" &&
      this.response.outcome.kind === "result"
    ) {
      check(sha256(this.body) === this.response.outcome.sha256);
      result = decodeResult(this.body);
      check(result.processorVersion === this.response.job.processorVersion);
    }
    return {
      metadata: this.metadata,
      response: this.response,
      body: this.body,
      result,
    };
  }
}

export function encodeRequest(metadata: Uint8Array, body: Uint8Array): Buffer {
  const request = decodeRequest(metadata),
    expected = request.op === "submit" ? request.job.inputBytes : 0;
  check(body.byteLength === expected);
  if (request.op === "submit") check(sha256(body) === request.job.sha256);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(metadata.byteLength);
  return Buffer.concat([prefix, metadata, body]);
}

export class RequestDecoder {
  private header = Buffer.alloc(4);
  private headerUsed = 0;
  private metadata = Buffer.alloc(0);
  private used = 0;
  private request: Request | null = null;
  private received = 0;
  private hash = createHash("sha256");
  private failed = false;
  private ended = false;
  push(bytes: Uint8Array): void {
    try {
      check(!this.failed && !this.ended);
      let offset = 0;
      if (this.headerUsed < 4) {
        const n = Math.min(4 - this.headerUsed, bytes.byteLength);
        this.header.set(bytes.subarray(0, n), this.headerUsed);
        this.headerUsed += n;
        offset += n;
        if (this.headerUsed < 4) return;
        const size = this.header.readUInt32BE();
        check(size >= 2 && size <= MAX_METADATA);
        this.metadata = Buffer.alloc(size);
      }
      if (!this.request) {
        const n = Math.min(
          this.metadata.length - this.used,
          bytes.byteLength - offset,
        );
        this.metadata.set(bytes.subarray(offset, offset + n), this.used);
        this.used += n;
        offset += n;
        if (this.used < this.metadata.length) return;
        this.request = decodeRequest(this.metadata);
      }
      const expected =
          this.request.op === "submit" ? this.request.job.inputBytes : 0,
        n = bytes.byteLength - offset;
      check(n <= expected - this.received);
      this.hash.update(bytes.subarray(offset));
      this.received += n;
    } catch {
      this.failed = true;
      throw new ConversionWireError();
    }
  }
  end(): Request {
    check(!this.failed && !this.ended && this.request);
    this.ended = true;
    const expected =
      this.request.op === "submit" ? this.request.job.inputBytes : 0;
    check(this.received === expected);
    if (this.request.op === "submit")
      check(this.hash.digest("hex") === this.request.job.sha256);
    return this.request;
  }
}

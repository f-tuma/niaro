import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import {
  BUFFER_BYTES,
  ConversionWireError,
  decodeIdentity,
  decodeQualification,
  decodeRequest,
  decodeResponse,
  decodeResult,
  encodeRequest,
  hashInput,
  MAX_METADATA,
  MAX_RESULT,
  RequestDecoder,
  ResponseDecoder,
  sha256,
  strictJSON,
  validateReply,
  type Identity,
  type Request,
} from "../apps/server-attachments/conversion-schema";
import { ConversionClient } from "../apps/server-attachments/conversion-client";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/conversion-v1/${name}`, import.meta.url),
      "utf8",
    ),
  );
type Vector = {
  name: string;
  direction: string;
  valid: boolean;
  wireHex: string;
  bodyHex: string;
  metadata: Record<string, unknown>;
};
const wire: { vectors: Vector[]; identity: Identity } = fixture(
  "wire-fixtures.v2.json",
);
const vector = (name: string) => {
  const v = wire.vectors.find((v) => v.name === name);
  assert.ok(v);
  return v;
};
const raw = (name: string) => Buffer.from(vector(name).wireHex, "hex");
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function* empty() {}

test("77 reviewed frames through actual incremental production decoders", () => {
  assert.equal(wire.vectors.length, 77);
  for (const v of wire.vectors) {
    const b = Buffer.from(v.wireHex, "hex"),
      decoder =
        v.direction === "request"
          ? new RequestDecoder()
          : new ResponseDecoder();
    const decode = () => {
      for (let i = 0; i < b.length; i += 7) decoder.push(b.subarray(i, i + 7));
      return decoder.end();
    };
    if (v.valid) assert.doesNotThrow(decode, v.name);
    else assert.throws(decode, ConversionWireError, v.name);
  }
});
test("100 exact hash inputs reconstruct ordered ASCII with no newline", () => {
  const hashes: {
    vectors: {
      name: string;
      hash: "qualification" | "outcome";
      valid: boolean;
      inputHex: string;
      canonicalHex: string;
      sha256: string;
    }[];
  } = fixture("hash-vectors.v2.json");
  assert.equal(hashes.vectors.length, 100);
  for (const v of hashes.vectors) {
    const decode = () => hashInput(Buffer.from(v.inputHex, "hex"), v.hash);
    if (!v.valid) assert.throws(decode, ConversionWireError, v.name);
    else {
      const preimage = decode();
      assert.equal(preimage.toString("hex"), v.canonicalHex, v.name);
      assert.equal(sha256(preimage), v.sha256, v.name);
      assert.notEqual(preimage.at(-1), 10);
    }
  }
});
test("source-linked typed cells, dates, spans, OCR and coverage constraints", () => {
  const results: { cases: { name: string; valid: boolean; value: unknown }[] } =
    fixture("result-cases.json");
  for (const v of results.cases) {
    const decode = () => decodeResult(Buffer.from(JSON.stringify(v.value)));
    if (v.valid) assert.doesNotThrow(decode, v.name);
    else assert.throws(decode, ConversionWireError, v.name);
  }
});
test("all frame truncations, overlong sizes, second frames and raw-body corruption", () => {
  for (const name of ["readiness", "submit", "outcome-complete"]) {
    const bytes = raw(name),
      response = name === "outcome-complete";
    for (let cut = 0; cut < bytes.length; cut++) {
      const decoder = response ? new ResponseDecoder() : new RequestDecoder();
      assert.throws(
        () => {
          decoder.push(bytes.subarray(0, cut));
          decoder.end();
        },
        ConversionWireError,
        `${name}:${cut}`,
      );
    }
    for (const extra of [Buffer.from([0]), bytes]) {
      const decoder = response ? new ResponseDecoder() : new RequestDecoder();
      assert.throws(() => {
        decoder.push(Buffer.concat([bytes, extra]));
        decoder.end();
      }, ConversionWireError);
    }
    const decoder = response ? new ResponseDecoder() : new RequestDecoder(),
      corrupt = Buffer.from(bytes);
    corrupt[corrupt.length - 1] = 0xff;
    if (name !== "readiness")
      assert.throws(() => {
        decoder.push(corrupt);
        decoder.end();
      }, ConversionWireError);
  }
  for (const n of [0, 1, MAX_METADATA + 1, 0xffffffff]) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    for (const decoder of [new RequestDecoder(), new ResponseDecoder()])
      assert.throws(() => decoder.push(b), ConversionWireError);
  }
  const overlong = raw("outcome-complete"),
    offset = 4 + overlong.readUInt32BE();
  overlong.writeUInt32BE(MAX_RESULT + 1, offset);
  assert.throws(
    () => new ResponseDecoder().push(overlong),
    ConversionWireError,
  );
  assert.throws(
    () =>
      encodeRequest(
        Buffer.from(JSON.stringify(vector("readiness").metadata)),
        Buffer.from("x"),
      ),
    ConversionWireError,
  );
});
test("delayed extra bytes grant no request/control or response observation", async () => {
  for (const name of ["submit", "readiness", "outcome-complete"]) {
    const decoder =
      name === "outcome-complete"
        ? new ResponseDecoder()
        : new RequestDecoder();
    let observed = 0;
    decoder.push(raw(name));
    await pause(20);
    assert.equal(observed, 0);
    assert.throws(() => {
      decoder.push(Buffer.from([0xff]));
      decoder.end();
      observed++;
    }, ConversionWireError);
    assert.equal(observed, 0);
  }
  const valid = new RequestDecoder();
  valid.push(raw("submit"));
  let launches = 0;
  valid.end();
  launches++;
  assert.equal(launches, 1);
});
test("strict UTF-8, duplicate decoded keys, depth and preallocation limits", () => {
  const invalid = [
    Buffer.from([0xff, 0xff]),
    Buffer.from("\ufeff{}"),
    Buffer.from('{"a":1,"\\u0061":2}'),
    Buffer.from('{"a":"\\ud800"}'),
    Buffer.from('{"a":"\\udc00"}'),
    Buffer.from('{"a":9007199254740991.1}'),
    Buffer.from('{"a":1e99999999999999999}'),
    Buffer.from('{"a":-1}'),
    Buffer.from("[".repeat(11) + "0" + "]".repeat(11)),
    Buffer.from("[" + "0,".repeat(20_000) + "0]"),
    Buffer.from('{"a":"' + "x".repeat(256 * 1024 + 1) + '"}'),
  ];
  for (const b of invalid)
    assert.throws(() => strictJSON(b, MAX_RESULT), ConversionWireError);
  assert.throws(
    () => strictJSON(Buffer.alloc(MAX_RESULT + 1), MAX_RESULT),
    ConversionWireError,
  );
  for (const n of ["1.0", "1e0"])
    assert.doesNotThrow(() =>
      decodeRequest(
        Buffer.from(`{"version":${n},"op":"status","query":"readiness"}`),
      ),
    );
});
test("qualification and ACK require both epoch change and advanced counter", () => {
  const origin = { epoch: "1".repeat(32), counter: 1 },
    record = {
      version: 1,
      key: "a".repeat(64),
      phase: "passed",
      tries: 1,
      probe: origin,
      testDigest: "b".repeat(64),
      firstServing: null,
    };
  decodeQualification(Buffer.from(JSON.stringify(record)));
  for (const firstServing of [
    origin,
    { ...origin, counter: 2 },
    { epoch: "2".repeat(32), counter: 1 },
  ])
    assert.throws(
      () =>
        decodeQualification(
          Buffer.from(JSON.stringify({ ...record, firstServing })),
        ),
      ConversionWireError,
    );
  const req = decodeRequest(
      Buffer.from(JSON.stringify(vector("ack").metadata)),
    ),
    res = decodeResponse(
      Buffer.from(JSON.stringify(vector("ack-cleared").metadata)),
    );
  validateReply(req, res, wire.identity, origin);
  for (const proof of [undefined, res.boot, { ...origin, counter: 2 }])
    assert.throws(
      () => validateReply(req, res, wire.identity, proof),
      ConversionWireError,
    );
  assert.throws(
    () =>
      validateReply(
        req,
        res,
        { ...wire.identity, processorVersion: "different" },
        origin,
      ),
    ConversionWireError,
  );
});

test("Node client fixed spawn, independent identity, complete EOF and exit checks", async (t) => {
  const spawn = childProcess.spawn;
  let code = "",
    launches = 0;
  const children: childProcess.ChildProcessWithoutNullStreams[] = [];
  t.mock.method(childProcess, "spawn", ((...args: unknown[]) => {
    assert.equal(args[0], "/usr/local/libexec/niaro-conversion-ipc-bridge");
    assert.deepEqual(args[1], []);
    assert.deepEqual(args[2], {
      shell: false,
      env: {} as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    launches++;
    const c = spawn(process.execPath, ["-e", code], {
      env: {} as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(c);
    return c;
  }) as unknown as typeof childProcess.spawn);
  const client = new ConversionClient(wire.identity),
    req = vector("readiness").metadata as unknown as Request,
    response = raw("readiness-ready-none").toString("hex");
  code = `process.stdin.resume();process.stdin.on('end',()=>process.stdout.end(Buffer.from('${response}','hex')))`;
  const reply = await client.exchange(req, empty());
  assert.equal(reply.response.kind, "readiness");
  assert.equal(launches, 1);
  const wrong = new ConversionClient({
    ...wire.identity,
    processorVersion: "wrong",
  });
  await assert.rejects(wrong.exchange(req, empty()), ConversionWireError);
  for (const tail of [
    "process.exitCode=1",
    "process.stdout.write(Buffer.from([255]))",
    "process.stdout.write(Buffer.alloc(0))",
  ]) {
    const hex = tail.includes("alloc") ? response.slice(0, -2) : response;
    code = `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(Buffer.from('${hex}','hex'));${tail}})`;
    await assert.rejects(client.exchange(req, empty()), ConversionWireError);
  }
  code = `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(Buffer.from('${response}','hex'));setTimeout(()=>process.stdout.write(Buffer.from([255])),30)})`;
  await assert.rejects(client.exchange(req, empty()), ConversionWireError);
  await client.shutdown();
  await assert.rejects(client.exchange(req, empty()), ConversionWireError);
  assert.ok(
    children.every((c) => c.exitCode !== null || c.signalCode !== null),
  );
});

test("Node child caps, cancellation, uncooperative source and clean reaping", async (t) => {
  const spawn = childProcess.spawn,
    children: childProcess.ChildProcessWithoutNullStreams[] = [];
  t.mock.method(childProcess, "spawn", (() => {
    const c = spawn(
      process.execPath,
      ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
      { env: {} as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] },
    );
    children.push(c);
    return c;
  }) as unknown as typeof childProcess.spawn);
  const client = new ConversionClient(wire.identity),
    readiness = vector("readiness").metadata as unknown as Request;
  const pending = Array.from({ length: 4 }, () =>
    client.exchange(readiness, empty()).catch((e) => e),
  );
  await assert.rejects(
    client.exchange(readiness, empty()),
    ConversionWireError,
  );
  assert.equal(children.length, 4);
  await client.shutdown();
  for (const result of await Promise.all(pending))
    assert.ok(result instanceof ConversionWireError);
  const other = new ConversionClient(wire.identity),
    controller = new AbortController();
  const stuck: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  };
  const interrupted = other.exchange(
    vector("submit").metadata as unknown as Request,
    stuck,
    { signal: controller.signal },
  );
  await assert.rejects(
    other.exchange(vector("submit").metadata as unknown as Request, empty()),
    ConversionWireError,
  );
  controller.abort();
  await assert.rejects(interrupted, ConversionWireError);
  await other.shutdown();
  assert.ok(
    children.every((c) => c.exitCode !== null || c.signalCode !== null),
  );
  assert.equal(BUFFER_BYTES, 64 * 1024);
  decodeIdentity(Buffer.from(JSON.stringify(wire.identity)));
});

test("DTO byte/count maxima and exact integer/ASCII edge spellings", () => {
  const base = () =>
    JSON.parse(
      Buffer.from(vector("outcome-complete").bodyHex, "hex").toString("utf8"),
    );
  const atLimit = base();
  atLimit.blocks = Array.from({ length: 4 }, (_, i) => ({
    source: 0,
    ordinal: i + 1,
    method: "native",
    text: "x".repeat(256 * 1024),
  }));
  decodeResult(Buffer.from(JSON.stringify(atLimit)));
  atLimit.blocks.push({ source: 0, ordinal: 5, method: "native", text: "x" });
  assert.throws(
    () => decodeResult(Buffer.from(JSON.stringify(atLimit))),
    ConversionWireError,
  );
  const text = base();
  text.blocks[0].text = "x".repeat(256 * 1024 + 1);
  assert.throws(
    () => decodeResult(Buffer.from(JSON.stringify(text))),
    ConversionWireError,
  );
  const name = base();
  name.sources[0].name = "é".repeat(128);
  decodeResult(Buffer.from(JSON.stringify(name)));
  name.sources[0].name += "é";
  assert.throws(
    () => decodeResult(Buffer.from(JSON.stringify(name))),
    ConversionWireError,
  );
  for (const field of ["tables", "warnings"]) {
    const m = base();
    m[field] = Array.from({ length: 257 }, () => ({}));
    assert.throws(
      () => decodeResult(Buffer.from(JSON.stringify(m))),
      ConversionWireError,
    );
  }
  const sources = base();
  sources.sources = Array.from({ length: 20_001 }, (_, i) => ({
    kind: "documentBlock",
    ordinal: i + 1,
  }));
  assert.throws(
    () => decodeResult(Buffer.from(JSON.stringify(sources))),
    ConversionWireError,
  );
  for (const ending of ["\n", "\r", "\u2028", "\u2029"]) {
    const m = { ...wire.identity, processorVersion: "safe" + ending };
    assert.throws(
      () => decodeIdentity(Buffer.from(JSON.stringify(m))),
      ConversionWireError,
    );
    const n = { ...wire.identity, assetsSha: wire.identity.assetsSha + ending };
    assert.throws(
      () => decodeIdentity(Buffer.from(JSON.stringify(n))),
      ConversionWireError,
    );
  }
  for (const n of [
    "1." + "0".repeat(100),
    "10e-1",
    "0e99999999999999999999999999999",
    "-0",
  ])
    assert.doesNotThrow(() =>
      strictJSON(Buffer.from(`{"x":${n}}`), MAX_METADATA),
    );
  for (const n of [
    "9007199254740991.0000000001",
    "1e99999999999999999",
    "1e-9999999999999999",
  ])
    assert.throws(
      () => strictJSON(Buffer.from(`{"x":${n}}`), MAX_METADATA),
      ConversionWireError,
    );
});

test("Node bridge idle and absolute timers kill and reap synthetic children", async (t) => {
  const spawn = childProcess.spawn,
    children: childProcess.ChildProcessWithoutNullStreams[] = [];
  t.mock.method(childProcess, "spawn", (() => {
    const c = spawn(
      process.execPath,
      ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
      { env: {} as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] },
    );
    children.push(c);
    return c;
  }) as unknown as typeof childProcess.spawn);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new ConversionClient(wire.identity),
    req = vector("readiness").metadata as unknown as Request;
  const idle = assert.rejects(
    client.exchange(req, empty()),
    ConversionWireError,
  );
  t.mock.timers.tick(15_000);
  await idle;
  const absolute = assert.rejects(
    client.exchange(req, empty()),
    ConversionWireError,
  );
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(10_000);
    if (i < 11) children.at(-1)!.stdout.emit("data", Buffer.alloc(0));
  }
  await absolute;
  await client.shutdown();
  assert.ok(
    children.every((c) => c.exitCode !== null || c.signalCode !== null),
  );
});

test("actual Go decoder and deadlines work on Node 22 child stdio pipes", async () => {
  const temp = mkdtempSync(join(tmpdir(), "niaro-conversion-a-stdio-"));
  try {
    const binary = join(temp, "stdio-probe");
    const build = childProcess.spawnSync(
      "go",
      [
        "-C",
        "services/conversion",
        "test",
        "-c",
        "-o",
        binary,
        "./internal/bridge",
      ],
      {
        env: {
          ...process.env,
          GOTOOLCHAIN: "local",
          GOPROXY: "off",
          GOSUMDB: "off",
          CGO_ENABLED: "0",
        },
        encoding: "utf8",
      },
    );
    assert.equal(build.status, 0, build.stderr);
    for (const mode of [
      "normal",
      "extra",
      "truncated",
      "input",
      "output",
      "cancel",
    ]) {
      const child = childProcess.spawn(
        binary,
        ["-test.run=^TestNodeStdioProbe$"],
        {
          cwd: "services/conversion/internal/bridge",
          env: {
            NIARO_CONVERSION_STDIO_TEST: mode,
            NIARO_CONVERSION_STDIO_TEST_DIR: temp,
          } as unknown as NodeJS.ProcessEnv,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const decoder = new ResponseDecoder();
      let bytes = 0,
        diagnostics = "";
      const ready = new Promise<void>((resolve) =>
        child.stderr.on("data", (b: Buffer) => {
          diagnostics += b.toString();
          if (diagnostics.includes("synthetic ready")) resolve();
        }),
      );
      let decodeError: unknown = null;
      child.stdout.on("data", (b: Buffer) => {
        bytes += b.length;
        try {
          decoder.push(b);
        } catch (e) {
          decodeError = e;
        }
      });
      if (mode === "output") child.stdout.pause();
      const closed = once(child, "close"),
        exited = once(child, "exit");
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 2500);
      child.stdin.on("error", () => {});
      try {
        const request = raw(mode === "output" ? "job-status" : "readiness");
        if (mode !== "input")
          child.stdin.write(
            mode === "truncated" ? request.subarray(0, -1) : request,
          );
        if (mode === "extra") {
          await pause(20);
          assert.equal(bytes, 0);
          child.stdin.write(Buffer.from([255]));
        }
        if (mode === "cancel") {
          await ready;
          child.kill("SIGTERM");
        } else if (mode !== "input") child.stdin.end();
        const [exitCode, signal] = await exited;
        if (mode === "output") {
          child.stdout.resume();
        }
        const [code] = await closed;
        assert.equal(signal, null, diagnostics);
        assert.equal(exitCode, code);
        assert.equal(
          decodeError,
          null,
          `${mode}: incomplete body must retain a valid frame prefix`,
        );
        if (mode === "normal") {
          assert.equal(code, 0, diagnostics);
          assert.equal(decoder.end().response.kind, "readiness");
        } else {
          assert.equal(code, 1, diagnostics);
          if (mode === "output") {
            assert.ok(bytes > 0);
            assert.throws(() => decoder.end(), ConversionWireError);
          } else assert.equal(bytes, 0);
          if (mode === "input" || mode === "output")
            assert.match(diagnostics, /timeout/);
        }
      } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          child.stdout.resume();
          await closed;
        }
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

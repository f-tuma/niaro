import childProcess, {
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  BUFFER_BYTES,
  ConversionWireError,
  decodeIdentity,
  decodeRequest,
  IDLE_MS,
  ResponseDecoder,
  TRANSFER_MS,
  validateReply,
  type BootRef,
  type Identity,
  type Reply,
  type Request,
} from "./conversion-schema";

const BRIDGE = "/usr/local/libexec/niaro-conversion-ipc-bridge";
let submits = 0,
  controls = 0;

// Unregistered port for phase D. No instance, identity, runtime capability or
// workflow hook is created here. There is no caller-selected executable,
// socket, UID, environment, URL, shell or worker launcher.
export class ConversionClient {
  private expected: Identity;
  private active = new Map<
    ChildProcessWithoutNullStreams,
    Promise<number | null>
  >();
  private closed = false;
  constructor(expected: Identity) {
    this.expected = decodeIdentity(Buffer.from(JSON.stringify(expected)));
  }

  async exchange(
    request: Request,
    body: AsyncIterable<Uint8Array>,
    options: { signal?: AbortSignal; ackOrigin?: BootRef } = {},
  ): Promise<Reply> {
    if (this.closed || options.signal?.aborted) throw new ConversionWireError();
    const metadata = Buffer.from(JSON.stringify(request)),
      req = decodeRequest(metadata),
      submit = req.op === "submit";
    if (submit ? submits >= 1 : controls >= 4) throw new ConversionWireError();
    if (submit) submits++;
    else controls++;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = childProcess.spawn(BRIDGE, [], {
        shell: false,
        env: {} as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      if (submit) submits--;
      else controls--;
      throw new ConversionWireError();
    }
    const decoder = new ResponseDecoder();
    const stopWriting = new AbortController();
    let stderr = 0,
      ended = false,
      sent = false,
      failure = false,
      idle: ReturnType<typeof setTimeout>;
    const fail = () => {
      failure = true;
      stopWriting.abort();
      child.kill("SIGKILL");
    };
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(fail, IDLE_MS);
      idle.unref();
    };
    const absolute = setTimeout(fail, TRANSFER_MS);
    absolute.unref();
    touch();
    const onAbort = () => fail();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      touch();
      try {
        decoder.push(chunk);
      } catch {
        fail();
      }
    });
    child.stdout.once("end", () => {
      ended = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.length;
      if (stderr > 4096) fail();
    });
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    // Install listeners before starting any write; only close after all stdio
    // EOF and process reaping may produce a successful transport result.
    const closed = new Promise<number | null>((resolve) => {
      child.once("error", fail);
      child.once("close", (code) => resolve(code));
    });
    this.active.set(child, closed);
    const write = async (b: Uint8Array) => {
      for (let i = 0; i < b.byteLength; i += BUFFER_BYTES) {
        if (failure || child.stdin.destroyed) throw new ConversionWireError();
        if (!child.stdin.write(b.subarray(i, i + BUFFER_BYTES)))
          await once(child.stdin, "drain", { signal: stopWriting.signal });
        touch();
      }
    };
    child.stdin.on("error", fail);
    const sending = (async () => {
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(metadata.length);
      await write(prefix);
      await write(metadata);
      let received = 0;
      const hash = createHash("sha256"),
        expected = submit && "job" in req ? req.job.inputBytes : 0;
      const iterator = body[Symbol.asyncIterator]();
      const stopped = new Promise<never>((_, reject) => {
        stopWriting.signal.addEventListener(
          "abort",
          () => reject(new ConversionWireError()),
          { once: true },
        );
      });
      // The rejection is also handled when the source completes first.
      void stopped.catch(() => {});
      for (;;) {
        const next = await Promise.race([iterator.next(), stopped]);
        if (next.done) break;
        const chunk = next.value;
        if (
          !(chunk instanceof Uint8Array) ||
          chunk.byteLength > expected - received
        )
          throw new ConversionWireError();
        received += chunk.byteLength;
        hash.update(chunk);
        await write(chunk);
      }
      if (
        received !== expected ||
        (submit && "job" in req && hash.digest("hex") !== req.job.sha256)
      )
        throw new ConversionWireError();
      sent = true;
      child.stdin.end();
    })().catch(fail);
    try {
      const code = await closed;
      // A malicious/nonterminating body iterator must not retain a bridge slot
      // after the child has been reaped. Its writes are fenced by failure.
      if (code !== 0 || !ended || failure || !sent) {
        fail();
        throw new ConversionWireError();
      }
      await sending;
      if (failure) throw new ConversionWireError();
      const reply = decoder.end();
      validateReply(req, reply.response, this.expected, options.ackOrigin);
      return reply;
    } finally {
      failure = true;
      stopWriting.abort();
      clearTimeout(idle!);
      clearTimeout(absolute);
      options.signal?.removeEventListener("abort", onAbort);
      this.active.delete(child);
      if (submit) submits--;
      else controls--;
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.active].map(([child, done]) => {
        child.kill("SIGKILL");
        return done;
      }),
    );
  }
}

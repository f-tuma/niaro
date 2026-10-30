import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { ClientSession } from "../packages/client-core/session";
import { messageCommand } from "../packages/client-core/commands";
import { attachmentClientHttp } from "./helpers/attachment-client-http";
import { AttachmentSelectionFlow } from "../packages/client-core/attachment-selection";
import { identifyAttachment } from "../packages/client-core/attachment-files";
import type { AttachmentSelection } from "../packages/client-core/attachments";
const digest = async (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const memory = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
};
const candidate = (
  bytes = new TextEncoder().encode("TEST synthetic attachment"),
): AttachmentSelection => ({
  filename: "TEST.txt",
  mediaType: "text/plain",
  size: bytes.length,
  read: async () => bytes,
  release: () => {},
});
async function setup(request: typeof fetch = fetch) {
  const h = await attachmentClientHttp();
  const storage = memory();
  const session = new ClientSession(
    h.address,
    storage,
    h.actor,
    request,
    undefined,
    undefined,
    false,
    { attachments: true, attachmentId: randomUUID },
  );
  await session.start(false);
  session.attachments.select({
    conversationId: "conversation-1",
    expectedGeneration: h.generation,
    mode: "current",
  });
  return {
    h,
    storage,
    session,
    runtime: session.attachments,
    close: async () => {
      session.stop();
      await h.close();
    },
  };
}
test("actual session file-only send preserves negotiated history and independently downloads retained original", async () => {
  const f = await setup();
  try {
    assert.equal(await f.runtime.add(candidate(), digest), true);
    assert.equal(f.runtime.ready, true);
    const attachments = f.runtime.takeForSend();
    const command = messageCommand(
      "",
      "cs",
      randomUUID(),
      undefined,
      attachments,
    );
    await f.session.send(command);
    assert.equal(f.h.commands, 1);
    assert.equal(f.runtime.getSnapshot().entries.length, 0);
    const message =
      f.session.getSnapshot().store!.conversations["conversation-1"]!
        .messages[0]!;
    const history = await f.session.readConversation("conversation-1");
    assert.equal(
      history.messages[0]!.attachments![0]!.contentId,
      message.attachments![0]!.contentId,
    );
    assert(
      f.h.calls
        .find((call) => call.path.includes("conversations/messages"))!
        .path.includes("attachments=agent-attachments%2F1"),
    );
    assert.equal(message.processing?.state, "blocked_capability");
    assert.equal(message.text, "");
    let saved: Uint8Array | undefined;
    await f.runtime.download(
      message.attachments![0]!,
      digest,
      async (bytes) => {
        saved = bytes;
      },
    );
    assert.equal(new TextDecoder().decode(saved), "TEST synthetic attachment");
    for (const call of f.h.calls.filter((call) =>
      /\/(?:snapshot|commands|events)\?/.test(call.path),
    ))
      assert(call.path.includes("attachments=agent-attachments%2F1"));
    assert(!JSON.stringify(f.runtime.getSnapshot()).includes("Bearer"));
  } finally {
    await f.close();
  }
});
test("404 and disabled capabilities retain text transport and never create uploads", async () => {
  for (const supported of [false, true]) {
    const h = await attachmentClientHttp();
    h.setSupported(supported);
    h.setEnabled(false);
    const session = new ClientSession(
      h.address,
      memory(),
      h.actor,
      fetch,
      undefined,
      undefined,
      false,
      { attachments: true, attachmentId: randomUUID },
    );
    try {
      await session.start(false);
      session.attachments.select({
        conversationId: "conversation-1",
        expectedGeneration: h.generation,
        mode: "current",
      });
      assert.equal(session.attachments.available, false);
      assert.equal(await session.attachments.add(candidate(), digest), false);
      await session.send(
        messageCommand("TEST text remains", "en", randomUUID()),
      );
      assert.equal(session.getSnapshot().commandStates.chat, "accepted");
      assert.equal(h.puts, 0);
    } finally {
      session.stop();
      await h.close();
    }
  }
});
test("lost create/PUT responses recover exact identity by passive status and do not send chat", async () => {
  let loseCreate = true,
    losePut = true;
  const f = await setup(async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).includes("/uploads?") && loseCreate) {
      loseCreate = false;
      await response.text();
      throw Error("TEST lost create reply");
    }
    if (init?.method === "PUT" && losePut) {
      losePut = false;
      await response.text();
      throw Error("TEST lost PUT reply");
    }
    return response;
  });
  try {
    const original = new TextEncoder().encode("TEST frozen bytes");
    await f.runtime.add(candidate(original), digest);
    original.fill(0);
    assert.equal(f.runtime.getSnapshot().entries[0]!.state, "failed");
    await f.runtime.retry(f.runtime.getSnapshot().entries[0]!.id);
    assert.equal(f.runtime.ready, true);
    assert.equal(f.h.puts, 1);
    assert.equal(f.h.commands, 0);
    const creates = f.h.calls.filter((call) => call.path.includes("/uploads?"));
    assert.deepEqual(creates[0]!.body, creates[1]!.body);
    assert.equal(f.h.uploads.size, 1);
  } finally {
    await f.close();
  }
});
test("quarantine stays uncertain across status, explicit retry and reconnect without another PUT", async () => {
  const f = await setup();
  try {
    f.h.setPutState("quarantined");
    await f.runtime.add(candidate(), digest);
    const entry = f.runtime.getSnapshot().entries[0]!;
    assert.equal(entry.state, "uncertain");
    assert.equal(entry.retryable, false);
    await f.runtime.retry(entry.id);
    await f.runtime.refresh(entry.id);
    await f.session.refresh();
    await f.session.sync();
    assert.equal(f.h.puts, 1);
    assert.equal(f.h.commands, 0);
    assert.equal(f.runtime.ready, false);
  } finally {
    await f.close();
  }
});
test("uncertain command survives reconnect without resend and explicit retry reuses the receipt", async () => {
  let loseCommand = true;
  const f = await setup(async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).includes("/commands?") && loseCommand) {
      loseCommand = false;
      await response.text();
      throw Error("TEST lost acceptance");
    }
    return response;
  });
  try {
    await f.runtime.add(candidate(), digest);
    const attachments = f.runtime.takeForSend();
    const command = messageCommand(
      "TEST caption",
      "en",
      randomUUID(),
      undefined,
      attachments,
    );
    await f.session.send(command);
    assert.deepEqual(f.session.getSnapshot().pending, command);
    await f.session.send(command);
    await f.runtime.remove(f.runtime.getSnapshot().entries[0]!.id);
    assert.equal(f.runtime.getSnapshot().entries.length, 1);
    assert.equal(f.runtime.ready, false);
    await f.session.refresh();
    await f.session.sync();
    assert.equal(f.h.commands, 1);
    await f.session.retry();
    assert.equal(f.h.commands, 2);
    const posts = f.h.calls.filter((call) => call.path.includes("/commands?"));
    assert.deepEqual(posts[0]!.body, posts[1]!.body);
    assert.equal(f.h.snapshot.conversations[0]!.messages.length, 1);
    assert.equal(f.runtime.getSnapshot().entries.length, 0);
  } finally {
    await f.close();
  }
});
test("scope changes abort in-flight work, release owned selection and ignore late server success", async () => {
  const f = await setup();
  let release!: () => void;
  let released = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.h.holdPut(held);
  try {
    const selected = candidate();
    selected.release = () => {
      released++;
    };
    const pending = f.runtime.add(selected, digest);
    while (!f.h.calls.some((call) => call.method === "PUT"))
      await new Promise((resolve) => setTimeout(resolve, 5));
    f.runtime.select({
      conversationId: "chat-other",
      expectedGeneration: null,
      mode: "current",
    });
    release();
    await pending;
    assert.equal(f.runtime.getSnapshot().entries.length, 0);
    assert.equal(f.runtime.getSnapshot().draft, null);
    assert(released > 0);
    assert.equal(f.runtime.ready, false);
  } finally {
    release();
    await f.close();
  }
});
test("selection cancel preserves draft; rotated confirmation identifies only the finalized bytes", async () => {
  const f = await setup();
  let released = 0;
  try {
    const flow = new AttachmentSelectionFlow(f.runtime, digest);
    const original = candidate();
    const rotated = candidate(
      new TextEncoder().encode("TEST rotated synthetic bytes"),
    );
    await flow.choose(async () => ({
      selection: original,
      raster: { uri: "blob:TEST", mediaType: "image/png" },
      release: () => {
        released++;
      },
      confirm: async (angle) => {
        assert.equal(angle, 90);
        return rotated;
      },
    }));
    assert.equal(f.h.puts, 0);
    flow.cancel();
    assert.equal(released, 1);
    assert.equal(f.runtime.getSnapshot().entries.length, 0);
    await flow.choose(async () => ({
      selection: original,
      raster: { uri: "blob:TEST", mediaType: "image/png" },
      release: () => {},
      confirm: async (angle) => {
        assert.equal(angle, 90);
        return rotated;
      },
    }));
    flow.rotate();
    await flow.confirm();
    const upload = [...f.h.uploads.values()][0]!;
    assert.equal(upload.sha256, await digest(await rotated.read()));
    assert.equal(f.h.commands, 0);
  } finally {
    await f.close();
  }
});
test("byte checks reject renamed active/binary content independently of extensions", () => {
  assert.throws(() =>
    identifyAttachment(new Uint8Array([77, 90, 0, 0]), "application/pdf"),
  );
  assert.throws(() =>
    identifyAttachment(
      new TextEncoder().encode("<svg onload=alert(1)>"),
      "text/plain",
    ),
  );
  assert.equal(
    identifyAttachment(
      new TextEncoder().encode("TEST valid text"),
      "text/plain",
    ),
    "text/plain",
  );
});

test("Edit pins a new draft, removal preserves history, and Again creates a new logical binding", async () => {
  const f = await setup();
  try {
    await f.runtime.add(candidate(), digest);
    await f.session.send(
      messageCommand(
        "TEST original",
        "en",
        randomUUID(),
        undefined,
        f.runtime.takeForSend(),
      ),
    );
    const first = f.h.snapshot.conversations[0]!.messages[0]!;
    await f.runtime.reuse({
      conversationId: "conversation-1",
      messageId: first.id,
      files: first.attachments!,
    });
    assert.equal(f.runtime.ready, true);
    await f.runtime.remove(f.runtime.getSnapshot().entries[0]!.id);
    assert.equal(first.attachments![0]!.availability, "available");
    assert.equal(f.runtime.getSnapshot().entries.length, 0);
    f.runtime.clear();
    await f.runtime.reuse({
      conversationId: "conversation-1",
      messageId: first.id,
      files: first.attachments!,
    });
    const again = messageCommand(
      first.text,
      "en",
      randomUUID(),
      undefined,
      f.runtime.takeForSend(),
    );
    assert.equal(again.retryOf, undefined);
    await f.session.send(again);
    assert.equal(f.h.snapshot.conversations[0]!.messages.length, 2);
    assert.equal(f.h.puts, 1);
  } finally {
    await f.close();
  }
});
test("a lost reference response retries the identical membership mutation", async () => {
  let lose = true;
  const f = await setup(async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).includes("/references?") && lose) {
      lose = false;
      await response.text();
      throw Error("TEST lost reference");
    }
    return response;
  });
  try {
    await f.runtime.add(candidate(), digest);
    await f.session.send(
      messageCommand(
        "TEST original",
        "en",
        randomUUID(),
        undefined,
        f.runtime.takeForSend(),
      ),
    );
    const first = f.h.snapshot.conversations[0]!.messages[0]!;
    await assert.rejects(
      f.runtime.reuse({
        conversationId: "conversation-1",
        messageId: first.id,
        files: first.attachments!,
      }),
    );
    await f.runtime.retry(f.runtime.getSnapshot().entries[0]!.id);
    const requests = f.h.calls.filter((call) =>
      call.path.includes("/references?"),
    );
    assert.deepEqual(requests[0]!.body, requests[1]!.body);
    assert.equal(f.runtime.getSnapshot().draft!.items.length, 1);
    assert.equal(f.runtime.ready, true);
  } finally {
    await f.close();
  }
});

test("middle reference loss retains the complete ordered Again intent and resumes the same mutation", async () => {
  let referencing = false;
  let references = 0;
  const f = await setup(async (url, init) => {
    const response = await fetch(url, init);
    if (
      referencing &&
      String(url).includes("/references?") &&
      ++references === 2
    ) {
      await response.text();
      throw Error("TEST lost middle reference reply");
    }
    return response;
  });
  try {
    for (const name of ["A", "B", "C"])
      await f.runtime.add({ ...candidate(), filename: `${name}.txt` }, digest);
    await f.session.send(
      messageCommand(
        "TEST all three",
        "en",
        randomUUID(),
        undefined,
        f.runtime.takeForSend(),
      ),
    );
    const source = f.h.snapshot.conversations[0]!.messages[0]!;
    referencing = true;
    await assert.rejects(
      f.runtime.reuse({
        conversationId: "conversation-1",
        messageId: source.id,
        files: source.attachments!,
      }),
    );
    assert.deepEqual(
      f.runtime.getSnapshot().entries.map((entry) => entry.filename),
      ["A.txt", "B.txt", "C.txt"],
    );
    assert.equal(f.runtime.ready, false);
    const failed = f.runtime
      .getSnapshot()
      .entries.find((entry) => entry.state === "failed")!;
    await f.runtime.retry(failed.id);
    assert.equal(f.runtime.ready, true);
    const calls = f.h.calls.filter((call) =>
      call.path.includes("/references?"),
    );
    assert.deepEqual(calls[1]!.body, calls[2]!.body);
    await f.session.send(
      messageCommand(
        "TEST all three again",
        "en",
        randomUUID(),
        undefined,
        f.runtime.takeForSend(),
      ),
    );
    assert.deepEqual(
      f.h.snapshot.conversations[0]!.messages[1]!.attachments!.map(
        (file) => file.filename,
      ),
      ["A.txt", "B.txt", "C.txt"],
    );
    assert.equal(f.h.puts, 3);
  } finally {
    await f.close();
  }
});

test("never-dispatched storage failure unlocks uploaded files for explicit removal", async () => {
  const f = await setup();
  try {
    await f.runtime.add(candidate(), digest);
    const write = f.storage.setItem;
    f.storage.setItem = async (key, value) => {
      if (key.startsWith("agent-client.command.v2:"))
        throw Error("TEST local storage failure");
      await write(key, value);
    };
    await f.session.send(
      messageCommand(
        "",
        "en",
        randomUUID(),
        undefined,
        f.runtime.takeForSend(),
      ),
    );
    assert.equal(f.h.commands, 0);
    assert.equal(f.session.getSnapshot().pending, null);
    assert.equal(f.session.getSnapshot().error, "storage_error");
    assert.equal(f.runtime.ready, true);
    f.storage.setItem = write;
    await f.runtime.remove(f.runtime.getSnapshot().entries[0]!.id);
    assert.equal(f.runtime.getSnapshot().entries.length, 0);
    assert.equal(f.h.puts, 1);
  } finally {
    await f.close();
  }
});

test("HTTP rejected middle reference removes locally and retains the remaining ordered intent", async () => {
  const f = await setup();
  try {
    for (const name of ["A", "B", "C"])
      await f.runtime.add({ ...candidate(), filename: `${name}.txt` }, digest);
    await f.session.send(
      messageCommand(
        "TEST original",
        "en",
        randomUUID(),
        undefined,
        f.runtime.takeForSend(),
      ),
    );
    const source = f.h.snapshot.conversations[0]!.messages[0]!;
    const intended = source.attachments!.map((file) => ({ ...file }));
    // The client still has its earlier source view; the HTTP authority no longer authorizes B.
    source.attachments = intended.filter((file) => file.filename !== "B.txt");
    await assert.rejects(
      f.runtime.reuse({
        conversationId: "conversation-1",
        messageId: source.id,
        files: intended,
      }),
    );
    assert.deepEqual(
      f.runtime.getSnapshot().entries.map((entry) => entry.filename),
      ["A.txt", "B.txt", "C.txt"],
    );
    const rejected = f.runtime
      .getSnapshot()
      .entries.find((entry) => entry.filename === "B.txt")!;
    assert.equal(rejected.retryable, false);
    assert.equal(f.runtime.ready, false);
    await f.runtime.remove(rejected.id);
    assert.deepEqual(
      f.runtime.getSnapshot().entries.map((entry) => entry.filename),
      ["A.txt", "C.txt"],
    );
    assert.equal(f.runtime.ready, true);
    const pins = f.h.calls.filter((call) => call.path.includes("/references?"));
    assert.equal(pins.length, 3);
    assert.equal(
      pins.filter(
        (call) =>
          (call.body as { source: { contentId: string } }).source.contentId ===
          intended[1]!.contentId,
      ).length,
      1,
    );
    await f.session.send(
      messageCommand(
        "",
        "en",
        randomUUID(),
        undefined,
        f.runtime.takeForSend(),
      ),
    );
    assert.deepEqual(
      f.h.snapshot.conversations[0]!.messages[1]!.attachments!.map(
        (file) => file.filename,
      ),
      ["A.txt", "C.txt"],
    );
    assert.equal(f.h.puts, 3);
  } finally {
    await f.close();
  }
});

for (const recoveryFailure of [
  "uncertain",
  "uncorrelated404",
  "serverFailure",
] as const) {
  test(`unknown accepted reference survives ${recoveryFailure} and Remove recovers the identical mutation`, async () => {
    let referenceCalls = 0;
    const f = await setup(async (url, init) => {
      if (String(url).includes("/references?")) {
        referenceCalls++;
        if (referenceCalls === 2)
          return new Response(
            JSON.stringify(
              recoveryFailure === "uncorrelated404"
                ? { error: "not_found" }
                : {
                    error:
                      recoveryFailure === "uncertain"
                        ? "attachment_uncertain"
                        : "attachment_unavailable",
                    retryable: false,
                    retryAfterSeconds: null,
                  },
            ),
            {
              status:
                recoveryFailure === "uncorrelated404"
                  ? 404
                  : recoveryFailure === "uncertain"
                    ? 409
                    : 503,
              headers: { "Content-Type": "application/json" },
            },
          );
        const response = await fetch(url, init);
        if (referenceCalls === 1) {
          await response.text();
          throw Error("TEST lost accepted reference reply");
        }
        return response;
      }
      return fetch(url, init);
    });
    try {
      await f.runtime.add(candidate(), digest);
      await f.session.send(
        messageCommand(
          "TEST source",
          "en",
          randomUUID(),
          undefined,
          f.runtime.takeForSend(),
        ),
      );
      const source = f.h.snapshot.conversations[0]!.messages[0]!;
      await assert.rejects(
        f.runtime.reuse({
          conversationId: "conversation-1",
          messageId: source.id,
          files: source.attachments!,
        }),
      );
      const entry = f.runtime.getSnapshot().entries[0]!;
      await f.runtime.remove(entry.id);
      assert.equal(f.runtime.getSnapshot().entries.length, 1);
      assert.equal(f.runtime.ready, false);
      await f.runtime.remove(entry.id);
      assert.equal(f.runtime.getSnapshot().entries.length, 0);
      const requests = f.h.calls.filter((call) =>
        call.path.includes("/references?"),
      );
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0]!.body, requests[1]!.body);
      assert.equal(f.h.puts, 1);
      assert.equal(f.h.commands, 1);
    } finally {
      await f.close();
    }
  });
}

test("lost fresh-draft reply during Edit recovers the same reference intent without creating an upload", async () => {
  let loseDraft = false;
  const f = await setup(async (url, init) => {
    const response = await fetch(url, init);
    if (
      String(url).includes("/attachment-drafts?") &&
      init?.method === "POST" &&
      loseDraft
    ) {
      loseDraft = false;
      await response.text();
      throw Error("TEST lost Edit draft");
    }
    return response;
  });
  try {
    await f.runtime.add(candidate(), digest);
    await f.session.send(
      messageCommand(
        "TEST source",
        "en",
        randomUUID(),
        undefined,
        f.runtime.takeForSend(),
      ),
    );
    const first = f.h.snapshot.conversations[0]!.messages[0]!;
    loseDraft = true;
    await assert.rejects(
      f.runtime.reuse({
        conversationId: "conversation-1",
        messageId: first.id,
        files: first.attachments!,
      }),
    );
    await f.runtime.retry(f.runtime.getSnapshot().entries[0]!.id);
    assert.equal(f.runtime.ready, true);
    assert.equal(f.h.puts, 1);
    assert.equal(f.h.uploads.size, 1);
  } finally {
    await f.close();
  }
});
test("local limits refuse bytes before reading and disposed scope cannot start another selection", async () => {
  const f = await setup();
  let reads = 0,
    released = 0;
  try {
    const oversized = {
      ...candidate(),
      size: 26 * 1024 * 1024,
      read: async () => {
        reads++;
        return new Uint8Array();
      },
      release: () => {
        released++;
      },
    };
    assert.equal(await f.runtime.add(oversized, digest), false);
    assert.equal(reads, 0);
    assert.equal(released, 1);
    assert.equal(f.h.puts, 0);
    f.session.stop();
    assert.equal(f.runtime.available, false);
    assert.equal(await f.runtime.add(candidate(), digest), false);
  } finally {
    await f.close();
  }
});

test("passive capability network failure stays quiet and does not invent availability or block text", async () => {
  let discoveries = 0;
  const f = await setup(async (url, init) => {
    if (String(url).includes("/attachments/capabilities?")) {
      discoveries++;
      throw Error("TEST capability network unavailable");
    }
    return fetch(url, init);
  });
  try {
    assert(discoveries > 0);
    assert.equal(f.runtime.getSnapshot().capabilities, null);
    assert.equal(
      f.runtime.getSnapshot().error,
      null,
      "passive discovery must not create an action failure",
    );
    assert.equal(f.runtime.available, false);
    await f.session.refresh();
    assert.equal(f.runtime.getSnapshot().error, null);
    await f.session.send(
      messageCommand("TEST text remains", "en", randomUUID()),
    );
    assert.equal(f.session.getSnapshot().commandStates.chat, "accepted");
    assert.equal(f.h.puts, 0);
  } finally {
    await f.close();
  }
});

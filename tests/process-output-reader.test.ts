import {
  freezeProcessOutputRequest,
  parseProcessOutputPage,
} from "../packages/client-core/process-output-reader";
import {
  processOutputFixture,
  outputPage,
  outputResponse,
  outputWork,
} from "./helpers/process-output-client";
import { WorkItemSchema } from "../packages/protocol";

test.each(["old", "malformed", "wrongScope"] as const)(
  "%s capability keeps approval delivery and refuses full output",
  async (capability) => {
    const h = processOutputFixture();
    h.capability = capability;
    const session = h.open();
    await session.start(false);
    expect(session.getSnapshot().status).toBe("online");
    expect(
      new URL(
        h.requests.find((url) => url.includes("/snapshot"))!,
      ).searchParams.get("tasks"),
    ).toBe("agent-process-work/3");
    await expect(
      session.loadProcessOutputPage({
        reference: outputWork().native!.process!.output!,
        path: [],
        cursor: null,
      }),
    ).rejects.toThrow("process_output_unsupported");
    expect(h.writes).toHaveLength(0);
    session.stop();
  },
);
test("all pages and scalar types are readable, including fields beyond eight, without writes or output persistence", async () => {
  const h = processOutputFixture(),
    session = h.open();
  await session.start(false);
  const request = {
    reference: h.snapshot.workItems[0]!.native!.process!.output!,
    path: [],
    cursor: null,
  };
  let cursor: string | null = null,
    offset = 0;
  const children = [];
  do {
    const page = await session.loadProcessOutputPage(
      { ...request, cursor },
      offset,
    );
    children.push(...page.children);
    offset += page.children.length;
    cursor = page.nextCursor;
  } while (cursor);
  expect(children).toHaveLength(20);
  expect(children[18]!.node).toEqual({
    kind: "string",
    value: "TEST-meeting-after-eight",
  });
  for (const child of children) {
    const page = await session.loadProcessOutputPage({
      ...request,
      path: [{ kind: "property", index: child.index }],
    });
    expect(page.node).toEqual(child.node);
    expect(page.nextCursor).toBeNull();
  }
  expect(h.writes).toHaveLength(0);
  expect([...h.cache.values()].join(" ")).not.toContain(
    "TEST-meeting-after-eight",
  );
  session.stop();
  const reopened = h.open();
  await reopened.start(false);
  expect((await reopened.loadProcessOutputPage(request)).offset).toBe(0);
  expect(h.writes).toHaveLength(0);
  reopened.stop();
});
test.each(["reference", "path", "offset", "cursor", "repeated", "skipped"])(
  "rejects a mixed or nonprogressing %s page",
  (kind) => {
    const request = freezeProcessOutputRequest({
      reference: outputWork().native!.process!.output!,
      path: [],
      cursor: null,
    });
    const page = outputPage(request);
    if (kind === "reference")
      page.reference = { ...page.reference, nativeRevision: 8 };
    if (kind === "path") page.path = [{ kind: "property", index: 1 }];
    if (kind === "offset") page.offset = 1;
    if (kind === "cursor") page.cursor = page.nextCursor;
    if (kind === "repeated") page.nextCursor = `0.${"b".repeat(64)}`;
    if (kind === "skipped") page.children[1]!.index = 3;
    expect(() => parseProcessOutputPage(page, request, 0)).toThrow(
      "process_output_invalid",
    );
  },
);
test("hostile accessors and a cross-bound work reference never become a read selection", () => {
  let accessed = false;
  const hostile = Object.defineProperty({}, "reference", {
    enumerable: true,
    get: () => {
      accessed = true;
      return outputWork().native!.process!.output;
    },
  });
  expect(() => freezeProcessOutputRequest(hostile)).toThrow(
    "process_output_invalid",
  );
  expect(accessed).toBe(false);
  const work = outputWork();
  work.native!.process!.output!.parentRunId = "TEST-other";
  expect(WorkItemSchema.safeParse(work).success).toBe(false);
});
test("a late successful response cannot publish after the current native revision changes", async () => {
  const h = processOutputFixture(),
    session = h.open();
  await session.start(false);
  let release!: (value: Response) => void;
  h.handlers.output = () =>
    new Promise((done) => {
      release = done;
    });
  const request = {
    reference: h.snapshot.workItems[0]!.native!.process!.output!,
    path: [],
    cursor: null,
  };
  const read = session.loadProcessOutputPage(request);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  h.snapshot = {
    ...h.snapshot,
    cursor: h.snapshot.cursor + 1,
    workItems: [outputWork(8)],
  };
  await session.refresh();
  release(outputResponse(outputPage(request)));
  await expect(read).rejects.toThrow("process_output_changed");
  expect(h.writes).toHaveLength(0);
  session.stop();
});
test("context-forbidden output remains a clear read error without expiring the authenticated connection", async () => {
  const h = processOutputFixture(),
    session = h.open();
  await session.start(false);
  h.handlers.output = async () =>
    outputResponse({ error: "process_output_unavailable" }, 403);
  await expect(
    session.loadProcessOutputPage({
      reference: h.snapshot.workItems[0]!.native!.process!.output!,
      path: [],
      cursor: null,
    }),
  ).rejects.toThrow("process_output_unavailable");
  expect(session.getSnapshot().status).toBe("online");
  expect(h.writes).toHaveLength(0);
  session.stop();
});
test("oversized wire JSON is rejected even when its multibyte text has fewer characters", async () => {
  const h = processOutputFixture(),
    session = h.open();
  await session.start(false);
  h.handlers.output = async (request) =>
    outputResponse({ ...outputPage(request), note: "界".repeat(24000) });
  await expect(
    session.loadProcessOutputPage({
      reference: h.snapshot.workItems[0]!.native!.process!.output!,
      path: [],
      cursor: null,
    }),
  ).rejects.toThrow("process_output_limit");
  session.stop();
});

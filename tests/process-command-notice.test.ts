import {
  captureProcessResolveTarget,
  processResolveCommand,
  processStartCommand,
} from "../packages/client-core/process-commands";
import {
  captureProcessNoticeOwner,
  processNoticeCopy,
  selectProcessCommandNotice,
} from "../packages/client-core/process-command-notice";
import {
  processApprovalFixture,
  approvalResponse,
  processApprovalWork,
} from "./helpers/process-approval-client";
import { processLaunchFixture } from "./helpers/process-launch-client";
import { translate } from "../packages/i18n";
import { ClientSession } from "../packages/client-core/session";
import { credential, authInfo } from "./auth-fixtures";

const context = {
  conversationId: "conversation-1",
  chatGeneration: 1,
  language: "en" as const,
};

test("legacy context refusal directs EN/CS recovery to an explicit new chat", () => {
  expect(translate("en")("legacy_context_unavailable")).toMatch(
    /Start a new chat to check current data\.$/,
  );
  expect(translate("cs")("legacy_context_unavailable")).toMatch(
    /Začni nový chat pro ověření aktuálních dat\.$/,
  );
});
async function fixture(
  status: "failed" | "unknown" | "cancelled",
  code = "action_failed",
  approved = true,
) {
  const h = processApprovalFixture(),
    session = h.open();
  await session.start(false);
  const owner = captureProcessNoticeOwner(session, context)!;
  const target = captureProcessResolveTarget(
    session.getSnapshot().store!,
    "TEST-parent",
  );
  const command = processResolveCommand(session.getSnapshot().store!, target, {
    commandId: "TEST-notice",
    idempotencyKey: "TEST-notice",
    approved,
    language: "en",
  });
  h.handlers.command = async (sent) => {
    const result = h.runtime(sent);
    return approvalResponse(
      {
        ...result,
        process: {
          ...result.process,
          approval: undefined,
          status,
          failure: { code },
        },
      },
      202,
    );
  };
  return {
    h,
    session,
    owner,
    target,
    command,
    send: () => session.send(command, false, target, owner),
  };
}

test.each(["failed", "unknown"] as const)(
  "the same raw action_failed code retains the authoritative %s outcome",
  async (status) => {
    const f = await fixture(status);
    try {
      await f.send();
      const state = f.session.getSnapshot();
      expect(state.error).toBe("action_failed");
      expect(state.pending).toBeNull();
      expect(state.processNotice?.notice.result).toMatchObject({
        kind: "process",
        status,
        revision: 8,
      });
      expect(selectProcessCommandNotice(state, f.owner).notice?.kind).toBe(
        status,
      );
      expect(f.h.commands).toHaveLength(1);
      expect(f.h.commands[0]).toBe(JSON.stringify(f.command));
      expect(
        state.store!.workItems["TEST-parent"]!.native!.process!.receipts[0]!
          .status,
      ).toBe("succeeded");
      expect(JSON.stringify(state.processNotice?.notice)).not.toContain(
        "inputJson",
      );
    } finally {
      f.session.stop();
    }
  },
);

test.each(
  (["failed", "unknown"] as const).flatMap((status) =>
    [
      "auth_expired",
      "storage_error",
      "network_error",
      "connection_failed",
      "requestInterruptFailed",
    ].map((code) => [status, code] as const),
  ),
)(
  "validated %s owns the reserved runtime code %s; owner churn suppresses its correlated fallback",
  async (status, code) => {
    const f = await fixture(status, code);
    try {
      await f.send();
      const state = f.session.getSnapshot();
      expect(state.error).toBe(code);
      expect(state.status).toBe("online");
      expect(state.pending).toBeNull();
      expect(state.processNotice?.errorSource).toEqual({ kind: "runtime" });
      expect(selectProcessCommandNotice(state, f.owner).notice?.kind).toBe(
        status,
      );
      expect(
        selectProcessCommandNotice(state, {
          ...f.owner,
          chatGeneration: 2,
        }),
      ).toEqual({ notice: null, suppressError: true });
      expect(f.h.commands).toHaveLength(1);
    } finally {
      f.session.stop();
    }
  },
);

test.each(["storage", "network"] as const)(
  "a later actual local %s failure owns a colliding scalar code and survives owner churn",
  async (failure) => {
    const rawCode = failure === "storage" ? "storage_error" : "network_error";
    const localCode =
      failure === "storage" ? "storage_error" : "connection_failed";
    const f = await fixture("unknown", rawCode);
    const write = f.h.storage.setItem;
    try {
      await f.send();
      expect(
        selectProcessCommandNotice(f.session.getSnapshot(), f.owner).notice
          ?.kind,
      ).toBe("unknown");
      if (failure === "storage")
        f.h.storage.setItem = async (key, value) => {
          if (key.includes("agent-client.snapshot.v2:"))
            throw Error("TEST actual cache persistence failure");
          return write(key, value);
        };
      else f.h.offline(true);
      await f.session.refresh();
      const state = f.session.getSnapshot();
      expect(state.error).toBe(rawCode);
      expect(state.processNotice?.errorSource).toEqual({
        kind: "local",
        code: localCode,
      });
      for (const owner of [f.owner, { ...f.owner, chatGeneration: 2 }])
        expect(selectProcessCommandNotice(state, owner)).toEqual({
          notice: null,
          suppressError: false,
          localError: localCode,
        });
      f.h.storage.setItem = write;
      f.h.offline(false);
      await f.session.refresh();
      expect(
        selectProcessCommandNotice(f.session.getSnapshot(), f.owner).notice
          ?.kind,
      ).toBe("unknown");
      expect(f.h.commands).toHaveLength(1);
    } finally {
      f.h.storage.setItem = write;
      f.h.offline(false);
      f.session.stop();
    }
  },
);

test("actual authentication expiry replaces a colliding runtime auth_expired code", async () => {
  const h = processApprovalFixture(),
    c = credential();
  const session = new ClientSession(
    h.address,
    h.storage,
    c,
    async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/auth/session")) return approvalResponse(authInfo(c));
      if (path.endsWith("/snapshot")) return approvalResponse(h.snapshot);
      if (path.endsWith("/processes/commands")) {
        h.commands.push(String(init?.body));
        const runtime = h.runtime(JSON.parse(String(init?.body)));
        return approvalResponse(
          {
            ...runtime,
            process: {
              ...runtime.process,
              approval: undefined,
              status: "unknown",
              failure: { code: "auth_expired" },
            },
          },
          202,
        );
      }
      throw Error(`TEST unexpected request ${path}`);
    },
    undefined,
    undefined,
    false,
    { processApprovals: true },
  );
  try {
    await session.start(false);
    const owner = captureProcessNoticeOwner(session, context)!;
    const target = captureProcessResolveTarget(
      session.getSnapshot().store!,
      "TEST-parent",
    );
    const command = processResolveCommand(
      session.getSnapshot().store!,
      target,
      {
        commandId: "TEST-auth-collision",
        idempotencyKey: "TEST-auth-collision",
        approved: true,
        language: "en",
      },
    );
    await session.send(command, false, target, owner);
    expect(
      selectProcessCommandNotice(session.getSnapshot(), owner).notice?.kind,
    ).toBe("unknown");
    c.expiresAt = "2000-01-01T00:00:00.000Z";
    await session.refresh();
    expect(session.getSnapshot().status).toBe("unauthorized");
    expect(session.getSnapshot().error).toBe("auth_expired");
    expect(session.getSnapshot().processNotice).toBeNull();
    expect(selectProcessCommandNotice(session.getSnapshot(), owner)).toEqual({
      notice: null,
      suppressError: false,
    });
    expect(h.commands).toHaveLength(1);
  } finally {
    session.stop();
  }
});

test.each(["failed", "unknown"] as const)(
  "%s with an empty failure code still has a clear announcement",
  async (status) => {
    const f = await fixture(status, "");
    try {
      await f.send();
      expect(f.session.getSnapshot().error).toBeNull();
      expect(
        selectProcessCommandNotice(f.session.getSnapshot(), f.owner).notice
          ?.kind,
      ).toBe(status);
    } finally {
      f.session.stop();
    }
  },
);

test("human decline preserves earlier receipts and cannot be mistaken for a configuration refusal", async () => {
  const f = await fixture("cancelled", "process_action_rejected", false);
  try {
    await f.send();
    expect(f.session.getSnapshot().error).toBe("process_action_rejected");
    expect(
      selectProcessCommandNotice(f.session.getSnapshot(), f.owner).notice,
    ).toMatchObject({
      kind: "declined",
      key: "processDecisionDeclined",
      error: false,
    });
    const interrupted = {
      ...f.session.getSnapshot().processNotice!,
      notice: {
        ...f.session.getSnapshot().processNotice!.notice,
        rawCode: "process_cancelled",
      },
    };
    expect(
      selectProcessCommandNotice(
        {
          ...f.session.getSnapshot(),
          error: "process_cancelled",
          processNotice: interrupted,
        },
        f.owner,
      ).notice?.kind,
    ).toBe("interrupted");
  } finally {
    f.session.stop();
  }
});

test.each(["session", "scope", "conversation", "chat", "language", "command"])(
  "a different %s owner suppresses only the old correlated fallback",
  async (change) => {
    const f = await fixture("unknown");
    const other = change === "session" ? f.h.open() : f.session;
    try {
      await f.send();
      const owner = {
        ...f.owner,
        session: other,
        scope:
          change === "scope"
            ? { ...f.owner.scope, userId: "TEST-other" }
            : f.owner.scope,
        conversationId:
          change === "conversation" ? "TEST-other" : context.conversationId,
        chatGeneration: change === "chat" ? 2 : 1,
        language: change === "language" ? ("cs" as const) : ("en" as const),
      };
      expect(
        selectProcessCommandNotice(
          f.session.getSnapshot(),
          owner,
          change === "command" ? "TEST-later" : undefined,
        ),
      ).toEqual({ notice: null, suppressError: true });
      for (const error of [
        "storage_error",
        "auth_expired",
        "network_error",
        "requestInterruptFailed",
        "catalog_not_found",
      ])
        expect(
          selectProcessCommandNotice(
            { ...f.session.getSnapshot(), error },
            owner,
          ),
        ).toEqual({ notice: null, suppressError: false });
    } finally {
      f.session.stop();
      if (other !== f.session) other.stop();
    }
  },
);

test("only the exact pinned native generation can promote an unknown receipt", async () => {
  const f = await fixture("failed");
  try {
    await f.send();
    const state = f.session.getSnapshot(),
      original = state.store!.workItems["TEST-parent"]!;
    const foreign = processApprovalWork();
    foreign.id = "TEST-foreign";
    foreign.native!.process!.receipts[0]!.status = "unknown";
    let store = {
      ...state.store!,
      workItems: { ...state.store!.workItems, [foreign.id]: foreign },
    };
    expect(
      selectProcessCommandNotice({ ...state, store }, f.owner).notice?.kind,
    ).toBe("failed");
    const work = JSON.parse(JSON.stringify(original)) as typeof original;
    work.native!.revision = 8;
    work.native!.process!.receipts[0]!.status = "unknown";
    store = { ...store, workItems: { ...store.workItems, [work.id]: work } };
    expect(
      selectProcessCommandNotice({ ...state, store }, f.owner).notice?.kind,
    ).toBe("unknown");
    work.native!.revision = 9;
    expect(selectProcessCommandNotice({ ...state, store }, f.owner)).toEqual({
      notice: null,
      suppressError: true,
    });
    work.native!.revision = 8;
    work.native!.process!.provenance.artifactDigest = "b".repeat(64);
    expect(selectProcessCommandNotice({ ...state, store }, f.owner)).toEqual({
      notice: null,
      suppressError: true,
    });
  } finally {
    f.session.stop();
  }
});

test("reopened known outbox has no old UI owner; explicit saving rebinds display without another POST", async () => {
  const f = await fixture("unknown");
  const write = f.h.storage.setItem;
  f.h.storage.setItem = async (key, value) => {
    if (key.includes("agent-client.command.v2:") && value === "null")
      throw Error("TEST cleanup failed");
    return write(key, value);
  };
  let reopened: ReturnType<typeof f.h.open> | undefined;
  try {
    await f.send();
    expect(f.session.getSnapshot().processPending?.outcome).toBe("accepted");
    f.session.stop();
    reopened = f.h.open();
    await reopened.start(false);
    const owner = captureProcessNoticeOwner(reopened, {
      ...context,
      chatGeneration: 2,
    })!;
    expect(selectProcessCommandNotice(reopened.getSnapshot(), owner)).toEqual({
      notice: null,
      suppressError: true,
    });
    f.h.storage.setItem = write;
    await reopened.retry(owner);
    expect(
      selectProcessCommandNotice(reopened.getSnapshot(), owner).notice?.kind,
    ).toBe("unknown");
    expect(reopened.getSnapshot().pending).toBeNull();
    expect(f.h.commands).toHaveLength(1);
  } finally {
    f.h.storage.setItem = write;
    f.session.stop();
    reopened?.stop();
  }
});

test("the next command clears native metadata even when its diagnostic repeats the same code", async () => {
  const f = await fixture("failed");
  try {
    await f.send();
    f.h.snapshot.workItems[0] = processApprovalWork("B", 9);
    await f.session.refresh();
    const store = f.session.getSnapshot().store!;
    const target = captureProcessResolveTarget(store, "TEST-parent");
    const command = processResolveCommand(store, target, {
      commandId: "TEST-D",
      idempotencyKey: "TEST-D",
      approved: true,
      language: "en",
    });
    const owner = captureProcessNoticeOwner(f.session, {
      ...context,
      chatGeneration: 2,
    })!;
    f.h.handlers.command = async (sent) => {
      const result = f.h.runtime(sent);
      return approvalResponse({
        ...result,
        process: {
          ...result.process,
          revision: 10,
          status: "failed",
          failure: { code: "action_failed" },
        },
      });
    };
    const delivery = f.session.send(command, false, target, owner);
    expect(f.session.getSnapshot().processNotice).toBeNull();
    await delivery;
    expect(f.session.getSnapshot().error).toBe("action_failed");
    expect(f.session.getSnapshot().processNotice?.notice.commandId).toBe(
      "TEST-D",
    );
    expect(
      selectProcessCommandNotice(f.session.getSnapshot(), owner).notice?.kind,
    ).toBe("failed");
    expect(f.h.commands).toHaveLength(2);
  } finally {
    f.session.stop();
  }
});

test.each([
  "requestRejected",
  "auth_expired",
  "model_invalid_response",
  "constructor",
])(
  "a translated or inherited %s key is not a native failure diagnosis",
  async (code) => {
    const f = await fixture("failed", code);
    try {
      await f.send();
      const notice = f.session.getSnapshot().processNotice!.notice;
      expect(processNoticeCopy(notice)).toEqual({
        kind: "failed",
        key: "processResultFailed",
        error: true,
      });
    } finally {
      f.session.stop();
    }
  },
);

test("a known safe runtime cause keeps its specific next step; unknown always wins", async () => {
  const f = await fixture("failed", "catalog_budget_exhausted");
  try {
    await f.send();
    const notice = f.session.getSnapshot().processNotice!.notice;
    expect(processNoticeCopy(notice)).toMatchObject({
      key: "processResultFailed",
      detailKey: "catalog_budget_exhausted",
    });
    expect(processNoticeCopy(notice, true)).toEqual({
      kind: "unknown",
      key: "processResultUnknown",
      error: false,
    });
  } finally {
    f.session.stop();
  }
});

test.each(["scope", "digest"])(
  "an uncorrelated %s response cannot create display evidence or retire its original pending",
  async (damage) => {
    const f = await fixture("unknown");
    f.h.handlers.command = async (command) => {
      const result = f.h.runtime(command);
      if (damage === "scope") result.scope.userId = "TEST-other";
      else result.admission.artifactDigest = "b".repeat(64);
      return approvalResponse({
        ...result,
        process: {
          ...result.process,
          status: "unknown",
          failure: { code: "action_failed" },
        },
      });
    };
    try {
      await f.send();
      expect(f.session.getSnapshot().processNotice).toBeNull();
      expect(f.session.getSnapshot().pending).toEqual(f.command);
      expect(f.session.getSnapshot().processPending?.outcome).toBe("unknown");
      expect(f.session.getSnapshot().error).toBe("process_response_mismatch");
    } finally {
      f.session.stop();
    }
  },
);

test("a correlated admission refusal keeps its typed existing reason", async () => {
  const h = processLaunchFixture(),
    session = h.open();
  h.outcome("rejected");
  try {
    await session.start(false);
    const entries = await session.loadProcessInventory();
    const entry = entries.processes[0]!;
    if (entry.availability !== "ready")
      throw Error("TEST ready entry required");
    const target = await session.prepareProcessInput(
      {
        processId: entry.processId,
        version: entry.version,
        artifactDigest: entry.artifactDigest,
        language: "en",
        origin: {
          type: "command",
          conversationId: context.conversationId,
          requestId: "TEST-refusal",
        },
      },
      entry,
    );
    const command = processStartCommand(target, {
      commandId: "TEST-refusal",
      idempotencyKey: "TEST-refusal",
      language: "en",
      input: { name: "TEST" },
    });
    const owner = captureProcessNoticeOwner(session, context)!;
    await session.send(command, false, target, owner);
    expect(session.getSnapshot().error).toBe("process_active_version_changed");
    expect(
      selectProcessCommandNotice(session.getSnapshot(), owner).notice,
    ).toMatchObject({ kind: "refused", key: "process_active_version_changed" });
    expect(h.commands).toHaveLength(1);
    await session.retry(owner);
    expect(h.commands).toHaveLength(1);
  } finally {
    session.stop();
  }
});

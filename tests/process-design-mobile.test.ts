import {
  dispatchMobileDesignCommand,
  isRejectedMobileDesignCommand,
  loadMobileDesignPending,
  mobileDesignTurnMatchesPending,
  mobileDesignRecoveryKey,
  type AsyncDesignStorage,
  type MobileDesignPending,
} from "../packages/client-core/process-design-mobile";
import { ProcessDesignApiError } from "../packages/client-core/session";
import { designUiTurn } from "./admin-design-fixtures";

const scope = {
  connectionId: "connection-a",
  serverId: "server-a",
  userId: "user-a",
  workspaceId: "workspace-a",
};
const command: MobileDesignPending = {
  version: 1,
  workspaceId: "workspace-a",
  sessionId: "design-a",
  command: {
    action: "turn",
    query: { sessionId: "design-a" },
    payload: {
      requestId: "request-a",
      sessionId: "design-a",
      revision: 4,
      text: "Add a review step",
    },
  },
};

function memoryStorage(): AsyncDesignStorage {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => void values.set(key, value),
    removeItem: async (key) => void values.delete(key),
  };
}

describe("mobile process-design recovery", () => {
  test("preserves the outbox after ambiguous throttling and timeout responses", () => {
    expect(
      isRejectedMobileDesignCommand(new ProcessDesignApiError(400, "invalid")),
    ).toBe(true);
    for (const status of [408, 425, 429, 500, 503])
      expect(
        isRejectedMobileDesignCommand(
          new ProcessDesignApiError(status, "unavailable"),
        ),
      ).toBe(false);
  });

  test("reconciles a turn only when its echoed request revision also matches", () => {
    const pending: MobileDesignPending = {
      ...command,
      sessionId: designUiTurn.sessionId,
      command: {
        action: "turn",
        query: { sessionId: designUiTurn.sessionId },
        payload: {
          requestId: designUiTurn.requestId,
          revision: designUiTurn.requestRevision,
          modelId: designUiTurn.model.id,
          text: designUiTurn.userText,
          language: designUiTurn.language,
        },
      },
    };
    const binding = {
      organizationId: designUiTurn.organizationId,
      workspaceId: designUiTurn.workspaceId,
    };

    expect(mobileDesignTurnMatchesPending(pending, designUiTurn, binding)).toBe(
      true,
    );
    expect(
      mobileDesignTurnMatchesPending(
        {
          ...pending,
          command: {
            ...pending.command,
            payload: {
              ...pending.command.payload,
              revision: designUiTurn.requestRevision! + 1,
            },
          },
        },
        designUiTurn,
        binding,
      ),
    ).toBe(false);
  });

  test("persists the immutable command before dispatch and reloads it", async () => {
    const storage = memoryStorage();
    const key = mobileDesignRecoveryKey("identity-a", scope);
    let savedDuringDispatch: MobileDesignPending | null = null;

    await dispatchMobileDesignCommand(storage, key, command, async (saved) => {
      savedDuringDispatch = await loadMobileDesignPending(
        storage,
        key,
        scope.workspaceId,
      );
      expect(savedDuringDispatch).toEqual(saved);
    });

    expect(savedDuringDispatch).toEqual(command);
    expect(
      await loadMobileDesignPending(storage, key, scope.workspaceId),
    ).toEqual(command);
  });

  test("does not dispatch when durable storage fails", async () => {
    const storage: AsyncDesignStorage = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error("disk unavailable");
      },
      removeItem: async () => undefined,
    };
    const send = jest.fn(async () => "sent");

    await expect(
      dispatchMobileDesignCommand(storage, "recovery", command, send),
    ).rejects.toThrow("disk unavailable");
    expect(send).not.toHaveBeenCalled();
  });

  test("separates recovery data by account, server, and workspace", () => {
    expect(mobileDesignRecoveryKey("identity-a", scope)).not.toBe(
      mobileDesignRecoveryKey("identity-b", scope),
    );
    expect(
      mobileDesignRecoveryKey("identity-a", {
        ...scope,
        workspaceId: "workspace-b",
      }),
    ).not.toBe(mobileDesignRecoveryKey("identity-a", scope));
    expect(
      mobileDesignRecoveryKey("identity-a", {
        ...scope,
        serverId: "server-b",
      }),
    ).not.toBe(mobileDesignRecoveryKey("identity-a", scope));
  });

  test("rejects a journal bound to a different workspace", async () => {
    const storage = memoryStorage();
    const key = mobileDesignRecoveryKey("identity-a", scope);
    await dispatchMobileDesignCommand(
      storage,
      key,
      command,
      async () => undefined,
    );

    await expect(
      loadMobileDesignPending(storage, key, "workspace-b"),
    ).rejects.toThrow("process_design_scope_changed");
  });
});

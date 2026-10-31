import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { OutputVoiceSettings } from "../apps/server-admin/web/app/output-voice-settings";
import { ClientSession } from "../packages/client-core/session";
import { credential } from "./auth-fixtures";
import {
  OUTPUT_VOICE_PROFILE,
  type OutputVoiceSnapshot,
} from "../packages/protocol/output-voice";
import type { AppContextValue } from "../apps/server-admin/web/app/context";
import { translate } from "../packages/i18n";
let mockContext: AppContextValue;
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => mockContext,
}));
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/select", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/console/page", () => host(), { virtual: true });
const snapshot = (): OutputVoiceSnapshot => ({
  profile: OUTPUT_VOICE_PROFILE,
  scope: credential().scope,
  revision: 0,
  catalogueRevision: "a".repeat(64),
  availability: "selectable",
  route: { identity: "b".repeat(64), model: "Reader", method: "reader" },
  serverDefault: { label: "Cedar" },
  options: [{ optionId: `ov_${"c".repeat(64)}`, label: "Echo" }],
  saved: null,
  effective: {
    choice: { kind: "server-default" },
    label: "Cedar",
    reason: "server-default",
  },
});
const response = (value: unknown, status = 200) =>
  ({
    status,
    ok: status === 200,
    text: async () => JSON.stringify(value),
  }) as Response;
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function setup(value = snapshot()) {
  let current = value;
  const transport = jest.fn(
    async (
      _url: Parameters<typeof fetch>[0],
      _init?: RequestInit,
    ): Promise<Response> => response(current),
  );
  const session = new ClientSession(
    "https://fixture/v1/a",
    { getItem: async () => null, setItem: async () => {} },
    credential(),
    transport,
  );
  mockContext = {
    language: "en",
    session,
    workspace: {
      workspaceId: credential().scope.workspaceId,
      organizationId: "org",
    },
    identity: { user: { id: credential().scope.userId } },
  } as AppContextValue;
  return {
    session,
    transport,
    set: (v: OutputVoiceSnapshot) => {
      current = v;
    },
  };
}
beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => "93ff8b48-19a7-469b-a9a3-8a9b2d9fecbd" },
  });
});
let view: TestRenderer.ReactTestRenderer;
afterEach(() => {
  if (view) act(() => view.unmount());
});
const nodes = (name: string) =>
  view.root.findAll(
    (n) => typeof n.type === "string" && n.props["data-host"] === name,
  );
const text = (node: ReactTestInstance = view.root): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join(" ");
const button = (label: string) =>
  nodes("Button").find((n) => text(n) === label)!;
test("web stale fallback keeps explicit Reset reachable independently of Select same-value events", async () => {
  const h = setup({
    ...snapshot(),
    revision: 2,
    saved: {
      choice: { kind: "catalogue", optionId: `ov_${"d".repeat(64)}` },
      label: "Old voice",
    },
    effective: { ...snapshot().effective, reason: "saved-choice-unavailable" },
  });
  await act(async () => {
    view = TestRenderer.create(<OutputVoiceSettings />);
    await flush();
  });
  expect(button("Reset")).toBeTruthy();
  expect(nodes("Select")[0]!.props.value).toBe("server-default");
  h.session.stop();
});
function selected(value = snapshot(), revision = 1): OutputVoiceSnapshot {
  const option = value.options[0]!;
  return {
    ...value,
    revision,
    saved: {
      choice: { kind: "catalogue", optionId: option.optionId },
      label: option.label,
    },
    effective: {
      choice: { kind: "catalogue", optionId: option.optionId },
      label: option.label,
      reason: "selected",
    },
  };
}
const posts = (h: ReturnType<typeof setup>) =>
  h.transport.mock.calls.filter(([, init]) => init?.method === "POST");
async function mount() {
  await act(async () => {
    view = TestRenderer.create(<OutputVoiceSettings />);
    await flush();
  });
}
async function choose(value: string) {
  await act(async () => {
    nodes("Select")[0]!.props.onValueChange(value);
    await flush();
  });
}
test("normal Select-change immediately POSTs once and retains acknowledged display disabled until ACK", async () => {
  const h = setup();
  await mount();
  let finish!: (value: Response) => void;
  h.transport.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await choose(snapshot().options[0]!.optionId);
  expect(posts(h)).toHaveLength(1);
  expect(nodes("Select")[0]!.props).toMatchObject({
    value: "server-default",
    disabled: true,
  });
  await choose(snapshot().options[0]!.optionId);
  expect(posts(h)).toHaveLength(1);
  expect(button("Save")).toBeUndefined();
  await act(async () => {
    finish(response(selected()));
    await flush();
  });
  expect(nodes("Select")[0]!.props).toMatchObject({
    value: snapshot().options[0]!.optionId,
    disabled: false,
  });
  expect(
    h.transport.mock.calls.every(([url]) =>
      String(url).includes("voice/output-settings"),
    ),
  ).toBe(true);
  h.session.stop();
});
test.each(["stale", "corrupt"])(
  "conditional Reset clears %s intent and disappears after ACK",
  async (kind) => {
    const old = {
      ...snapshot(),
      revision: 2,
      saved:
        kind === "stale"
          ? {
              choice: {
                kind: "catalogue" as const,
                optionId: `ov_${"d".repeat(64)}`,
              },
              label: "Old",
            }
          : null,
      effective: {
        ...snapshot().effective,
        reason: "saved-choice-unavailable" as const,
      },
    };
    const h = setup(old);
    await mount();
    let finish!: (value: Response) => void;
    h.transport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      button("Reset").props.onClick();
      await flush();
    });
    expect(posts(h)).toHaveLength(1);
    expect(button("Reset").props.disabled).toBe(true);
    expect(JSON.parse(posts(h)[0]![1]!.body as string).choice).toEqual({
      kind: "server-default",
    });
    await act(async () => {
      finish(
        response({
          ...snapshot(),
          revision: 3,
          saved: { choice: { kind: "server-default" }, label: "" },
        }),
      );
      await flush();
    });
    expect(button("Reset")).toBeUndefined();
    h.session.stop();
  },
);
test("same acknowledged intent does not POST and valid selected voice has no duplicate Reset", async () => {
  const h = setup(selected());
  await mount();
  await choose(snapshot().options[0]!.optionId);
  expect(posts(h)).toHaveLength(0);
  expect(button("Reset")).toBeUndefined();
  h.session.stop();
});
test("known failure retains prior display and shows concise error", async () => {
  const h = setup();
  await mount();
  h.transport.mockImplementationOnce(async () =>
    response({ error: "invalid_payload" }, 400),
  );
  await choose(snapshot().options[0]!.optionId);
  expect(nodes("Select")[0]!.props.value).toBe("server-default");
  expect(text()).toContain("Couldn't save your voice. Try again.");
  expect(posts(h)).toHaveLength(1);
  h.session.stop();
});
test("lost response reconciles GET before explicit exact-body retry", async () => {
  const h = setup();
  await mount();
  h.transport.mockImplementationOnce(async () => {
    throw Error("lost");
  });
  await choose(snapshot().options[0]!.optionId);
  expect(posts(h)).toHaveLength(1);
  expect(h.transport.mock.calls.at(-1)![1]?.method).not.toBe("POST");
  const body = posts(h)[0]![1]!.body;
  h.set(selected());
  await act(async () => {
    button("Retry save").props.onClick();
    await flush();
  });
  expect(posts(h)).toHaveLength(2);
  expect(posts(h)[1]![1]!.body).toBe(body);
  expect(nodes("Select")[0]!.props.value).toBe(snapshot().options[0]!.optionId);
  h.session.stop();
});
test.each(["en", "cs"] as const)(
  "%s held recovery GET reports loading and uncertainty, preserves Cedar and permits only explicit exact retry",
  async (language) => {
    const value = {
      ...snapshot(),
      options: [{ ...snapshot().options[0]!, label: "Shimmer" }],
    };
    const h = setup(value);
    mockContext.language = language;
    const tr = translate(language);
    let finishPost: ((value: Response) => void) | undefined;
    let finishRead: ((value: Response) => void) | undefined;
    const statuses = () =>
      nodes("FieldDescription")
        .filter((node) => node.props.role === "status")
        .map((node) => text(node));
    try {
      await mount();
      h.transport
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishPost = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishRead = resolve;
            }),
        );
      await choose(value.options[0]!.optionId);
      expect(posts(h)).toHaveLength(1);
      expect(statuses()).toEqual([tr("outputVoiceSaving")]);
      expect(text()).not.toContain(tr("outputVoiceUnknown"));
      const originalBody = posts(h)[0]![1]!.body;

      await act(async () => {
        finishPost!(response({ error: "service_unavailable" }, 503));
        await flush();
      });
      expect(finishRead).toBeDefined();
      expect(h.transport).toHaveBeenCalledTimes(3);
      expect(h.transport.mock.calls.at(-1)![1]?.method).not.toBe("POST");
      expect(nodes("Select")[0]!.props).toMatchObject({
        value: "server-default",
        disabled: true,
      });
      expect(text(nodes("SelectValue")[0]!)).toBe(
        `${tr("outputVoiceDefault")} (Cedar)`,
      );
      expect(nodes("SelectTrigger")[0]!.props["aria-busy"]).toBe(true);
      expect(text()).toContain(tr("outputVoiceUnknown"));
      expect(statuses()).toEqual([tr("outputVoiceLoading")]);
      expect(text()).not.toContain(tr("outputVoiceSaving"));
      expect(button(tr("outputVoiceRetry"))).toBeUndefined();
      await choose(value.options[0]!.optionId);
      expect(posts(h)).toHaveLength(1);

      await act(async () => {
        finishRead!(response(value));
        await flush();
      });
      expect(statuses()).toEqual([]);
      expect(nodes("Select")[0]!.props).toMatchObject({
        value: "server-default",
        disabled: true,
      });
      expect(text()).toContain(tr("outputVoiceUnknown"));
      expect(button(tr("outputVoiceRetry"))).toBeTruthy();
      expect(posts(h)).toHaveLength(1);

      h.set(selected(value));
      await act(async () => {
        button(tr("outputVoiceRetry")).props.onClick();
        await flush();
      });
      expect(posts(h)).toHaveLength(2);
      expect(posts(h)[1]![1]!.body).toBe(originalBody);
      expect(nodes("Select")[0]!.props).toMatchObject({
        value: value.options[0]!.optionId,
        disabled: false,
      });
      expect(text(nodes("SelectValue")[0]!)).toBe("Shimmer");
      expect(text()).not.toContain(tr("outputVoiceUnknown"));
      expect(statuses()).toEqual([]);
      expect(button(tr("outputVoiceRetry"))).toBeUndefined();
    } finally {
      await act(async () => {
        h.session.stop();
        finishPost?.(response({ error: "service_unavailable" }, 503));
        finishRead?.(response(value));
        await flush();
      });
    }
  },
);
test("lost ACK resolved by GET applies committed snapshot with no Retry or extra POST", async () => {
  const h = setup();
  await mount();
  h.transport.mockImplementationOnce(async () => {
    h.set(selected());
    throw Error("lost");
  });
  await choose(snapshot().options[0]!.optionId);
  expect(posts(h)).toHaveLength(1);
  expect(button("Retry save")).toBeUndefined();
  expect(nodes("Select")[0]!.props.value).toBe(snapshot().options[0]!.optionId);
  h.session.stop();
});
test.each([
  "output_voice_conflict",
  "output_voice_catalogue_changed",
  "output_voice_choice_unavailable",
])("%s refetches without reapply", async (error) => {
  const h = setup();
  await mount();
  h.transport.mockImplementationOnce(async () =>
    response({ error }, error.endsWith("unavailable") ? 422 : 409),
  );
  await choose(snapshot().options[0]!.optionId);
  expect(posts(h)).toHaveLength(1);
  expect(text()).toContain("Voice settings changed. Choose again.");
  expect(button("Retry save")).toBeUndefined();
  expect(h.transport.mock.calls.at(-1)![1]?.method).not.toBe("POST");
  h.session.stop();
});
test.each(["server-default-only", "speech-unavailable"] as const)(
  "%s uses contextual detail without inert Select and keeps corrupt Reset",
  async (availability) => {
    const h = setup({
      ...snapshot(),
      revision: 3,
      availability,
      options: [],
      effective: {
        ...snapshot().effective,
        reason:
          availability === "speech-unavailable"
            ? "speech-unavailable"
            : "saved-choice-unavailable",
      },
    });
    mockContext.language = "cs";
    await mount();
    expect(nodes("Select")).toHaveLength(0);
    expect(button("Obnovit výchozí")).toBeTruthy();
    h.session.stop();
  },
);
test("unsupported omits editor; malformed read remains an error", async () => {
  const h = setup();
  h.transport.mockImplementationOnce(async () => response({}, 404));
  await mount();
  expect(text()).toBe("");
  await act(async () => view.unmount());
  const next = setup();
  next.transport.mockImplementationOnce(async () =>
    response({ ...snapshot(), extra: true }),
  );
  await mount();
  expect(text()).toContain("Couldn't load your voice. Try again.");
  h.session.stop();
  next.session.stop();
});
test.each(["session", "user", "workspace"])(
  "%s replacement clears old ownership and rejects ignored-abort late saves",
  async (kind) => {
    const h = setup();
    await mount();
    let finish!: (value: OutputVoiceSnapshot) => void;
    jest.spyOn(h.session, "saveOutputVoiceSettings").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await choose(snapshot().options[0]!.optionId);
    if (kind === "session") setup();
    if (kind === "user")
      mockContext = {
        ...mockContext,
        identity: {
          ...mockContext.identity,
          user: { ...mockContext.identity.user!, id: "other" },
        },
      };
    if (kind === "workspace")
      mockContext = {
        ...mockContext,
        workspace: { ...mockContext.workspace, workspaceId: "other" },
      };
    await act(async () => {
      view.update(<OutputVoiceSettings />);
      await flush();
      finish(selected());
      await flush();
    });
    expect(nodes("Select")[0]?.props.value).not.toBe(
      snapshot().options[0]!.optionId,
    );
    h.session.stop();
    mockContext.session?.stop();
  },
);
test("earlier ignored-abort GET cannot rewind later acknowledged save; hidden page never polls", async () => {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (_name: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) =>
      listeners.delete(listener),
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: doc,
  });
  try {
    const h = setup();
    await mount();
    let finish!: (value: OutputVoiceSnapshot) => void;
    jest.spyOn(h.session, "outputVoiceSettings").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      for (const listener of listeners) listener();
      await flush();
    });
    h.set(selected());
    await choose(snapshot().options[0]!.optionId);
    await act(async () => {
      finish(snapshot());
      await flush();
    });
    expect(nodes("Select")[0]!.props.value).toBe(
      snapshot().options[0]!.optionId,
    );
    await act(async () => {
      doc.visibilityState = "hidden";
      for (const listener of listeners) listener();
      await flush();
    });
    expect(nodes("Select")).toHaveLength(0);
    const calls = h.transport.mock.calls.length;
    await act(flush);
    expect(h.transport).toHaveBeenCalledTimes(calls);
    await act(async () => {
      doc.visibilityState = "visible";
      for (const listener of listeners) listener();
      await flush();
    });
    expect(nodes("Select")[0]!.props.value).toBe(
      snapshot().options[0]!.optionId,
    );
    h.session.stop();
    await act(async () => view.unmount());
  } finally {
    Reflect.deleteProperty(globalThis, "document");
  }
});
test("stopping the actual ClientSession while saving clears acknowledged options instead of false success", async () => {
  const h = setup();
  await mount();
  let finish!: (value: Response) => void;
  h.transport.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await choose(snapshot().options[0]!.optionId);
  await act(async () => {
    h.session.stop();
    finish(response(selected()));
    await flush();
  });
  expect(nodes("Select")).toHaveLength(0);
  expect(text()).toContain("Couldn't load your voice. Try again.");
});

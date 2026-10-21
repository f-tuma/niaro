import React, { useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { ProcessDesign } from "../apps/mobile/ProcessDesign";
import { ClientSession } from "../packages/client-core/session";
import { cs, en } from "../packages/i18n";
import { mobileDesignRecoveryKey } from "../packages/client-core/process-design-mobile";
import {
  DesignServiceDraftListSchema,
  DesignSessionListSchema,
} from "../packages/protocol/process-design";
import { mobileHttpChildFixture } from "./helpers/process-mobile-http-child";

// Each test starts a child HTTP server; slower CI runners need more than 5 s.
jest.setTimeout(30_000);

const mockStorageValues = new Map<string, string>();
let mockRequestSequence = 0;

jest.mock("expo-crypto", () => ({
  randomUUID: () => `TEST-real-mobile-design-${++mockRequestSequence}`,
}));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async (key: string) => mockStorageValues.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStorageValues.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    mockStorageValues.delete(key);
  }),
}));

const nodeFetch = require("node-fetch") as (
  url: string,
  init?: unknown,
) => Promise<Response>;
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockStorageValues.clear();
  mockRequestSequence = 0;
});

test("authenticated mobile designer loads the workspace profile and starts a proposal", async () => {
  const fixture = await mobileHttpChildFixture();
  let session: ClientSession | undefined;
  try {
    const setup = await fixture.configure({ questions: 0, writes: 0 });
    session = new ClientSession(
      setup.endpoint,
      { getItem: async () => null, setItem: async () => {} },
      setup.credential,
      (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        nodeFetch(String(url), init)) as typeof fetch,
      undefined,
      undefined,
      false,
    );
    await session.start(false);
    render(<ProcessDesign session={session} language="en" />);

    const start = await screen.findByRole("button", {
      name: en.processDesignStart,
    });
    await act(async () => {
      fireEvent.press(start);
      await flush();
    });
    await waitFor(() =>
      expect(screen.getByText(en.processDesignReview)).toBeTruthy(),
    );
    await expect(session.loadProcessInventory()).rejects.toMatchObject({
      message: "process_profile_unsupported",
    });

    const capabilitiesRead = (await fixture.inspect()).requests.find(
      (request) =>
        request.path.includes("/process-design/capabilities") &&
        request.method === "GET",
    );
    expect(capabilitiesRead?.status).toBe(200);
  } finally {
    if (session) await act(async () => session?.stop());
    await fixture.close();
  }
});

test.each(["en", "cs"] as const)(
  "mobile designer starts a service-owned proposal and loads only its history and drafts (%s)",
  async (language) => {
    const copy = language === "en" ? en : cs;
    const fixture = await mobileHttpChildFixture();
    let session: ClientSession | undefined;
    try {
      const setup = await fixture.configure({ questions: 0, writes: 0 });
      await fixture.enableDesignerProposal();
      session = new ClientSession(
        setup.endpoint,
        { getItem: async () => null, setItem: async () => {} },
        setup.credential,
        (async (
          url: RequestInfo | URL,
          init?: RequestInit,
        ): Promise<Response> => nodeFetch(String(url), init)) as typeof fetch,
        undefined,
        undefined,
        false,
      );
      await session.start(false);
      function Harness() {
        const [serviceId, setServiceId] = useState<string | null>(null);
        return (
          <ProcessDesign
            session={session!}
            language={language}
            serviceId={serviceId}
            onServiceChange={setServiceId}
          />
        );
      }
      const view = render(<Harness />);
      await screen.findByText(copy.processDesignTarget);
      await act(async () => {
        fireEvent.press(screen.getByText("TEST design service"));
        await flush();
      });
      await screen.findByText(copy.processDesignNoHistory);
      await screen.findByText("TEST integrated native mobile process");
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", { name: copy.processDesignStart }),
        );
        await flush();
      });
      await waitFor(() =>
        expect(screen.getByText(copy.processDesignReview)).toBeTruthy(),
      );
      fireEvent.changeText(
        await screen.findByLabelText(copy.processDesignPrompt),
        "Create a service-owned process that looks up a contact.",
      );
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", { name: copy.processDesignSend }),
        );
        await flush();
      });
      await screen.findByText("TEST proposal is ready for review.");
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", {
            name: copy.processDesignReviewBeforeSave,
          }),
        );
        await flush();
      });
      const save = await screen.findByRole("button", {
        name: copy.processDesignSaveInactive,
      });
      await act(async () => {
        fireEvent.press(save);
        await flush();
      });
      await screen.findByText(copy.processDesignSavedInactive);
      const scope = session.getSnapshot().store?.scope;
      if (!scope) throw new Error("TEST paired session has no scope");
      const key = mobileDesignRecoveryKey(
        session.identityKey,
        scope,
        setup.serviceId,
      );
      expect(await AsyncStorage.getItem(key)).toBeNull();
      const firstSessionId = await AsyncStorage.getItem(`${key}:session`);
      expect(firstSessionId).toBeTruthy();
      const acceptedReview = (await session.requestProcessDesign("review", {
        profile: "agent-process-design/1",
        sessionId: firstSessionId!,
      })) as {
        review: { acceptedProcessId: string | null };
      };
      expect(acceptedReview.review.acceptedProcessId).toBeTruthy();
      const acceptedProcessId = acceptedReview.review.acceptedProcessId!;

      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", { name: copy.processDesignNew }),
        );
        await flush();
      });
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", { name: copy.processDesignStart }),
        );
        await flush();
      });
      await waitFor(() =>
        expect(screen.getByText(copy.processDesignReview)).toBeTruthy(),
      );
      const secondSessionId = await AsyncStorage.getItem(`${key}:session`);
      expect(secondSessionId).toBeTruthy();
      expect(secondSessionId).not.toBe(firstSessionId);
      const priorSession = screen.getByText(
        new RegExp(` · ${firstSessionId!.slice(0, 8)}$`),
      );
      await act(async () => {
        fireEvent.press(priorSession);
        await flush();
      });
      await waitFor(() =>
        expect(screen.getByText(copy.processDesignReview)).toBeTruthy(),
      );
      const requests = (await fixture.inspect()).requests;
      expect(
        requests.some(
          (request) =>
            request.path.includes("/process-design/sessions/list?") &&
            request.path.includes(`serviceId=${setup.serviceId}`),
        ),
      ).toBe(true);
      const inspection = await fixture.inspect();
      expect(inspection.serviceDispatches).toEqual([]);
      expect(
        inspection.requests.some(
          (request) =>
            request.method === "POST" &&
            request.path.includes("/process-design/accept?") &&
            request.path.includes("profile=agent-process-design%2F1"),
        ),
      ).toBe(true);
      expect(
        requests.some(
          (request) =>
            request.path.includes("/process-design?") &&
            request.path.includes(`sessionId=${firstSessionId}`),
        ),
      ).toBe(true);
      expect(
        requests.some(
          (request) =>
            request.path.includes("/process-design/drafts/list?") &&
            request.path.includes(`serviceId=${setup.serviceId}`),
        ),
      ).toBe(true);
      const seeded = await fixture.seedDesignerPages(setup.serviceId, 102);
      const readAll = async (action: "sessions/list" | "drafts/list") => {
        const items: { id: string; serviceId: string }[] = [];
        const cursors = new Set<string>();
        let after: string | undefined;
        do {
          const raw = await session!.requestProcessDesign(action, {
            profile: "agent-process-design/1",
            serviceId: setup.serviceId,
            ...(after ? { after } : {}),
          });
          const page =
            action === "sessions/list"
              ? (() => {
                  const parsed = DesignSessionListSchema.parse(raw);
                  return {
                    serviceId: parsed.serviceId,
                    items: parsed.sessions,
                    nextAfter: parsed.nextAfter,
                  };
                })()
              : (() => {
                  const parsed = DesignServiceDraftListSchema.parse(raw);
                  return {
                    serviceId: parsed.serviceId,
                    items: parsed.drafts,
                    nextAfter: parsed.nextAfter,
                  };
                })();
          expect(page.serviceId).toBe(setup.serviceId);
          items.push(...page.items);
          after = page.nextAfter ?? undefined;
          if (after) {
            expect(cursors.has(after)).toBe(false);
            cursors.add(after);
          }
        } while (after);
        return items;
      };
      const serviceSessions = await readAll("sessions/list");
      const serviceDrafts = await readAll("drafts/list");
      expect(serviceSessions.length).toBeGreaterThan(100);
      expect(new Set(serviceSessions.map((item) => item.id)).size).toBe(
        serviceSessions.length,
      );
      expect(serviceSessions.map((item) => item.id).sort()).toEqual(
        [...seeded.pageSessionIds, firstSessionId!, secondSessionId!].sort(),
      );
      expect(serviceSessions.map((item) => item.id)).not.toContain(
        seeded.foreignSessionId,
      );
      expect(serviceSessions.map((item) => item.id)).not.toContain(
        seeded.foreignActorSessionId,
      );
      expect(serviceDrafts.length).toBeGreaterThan(100);
      expect(new Set(serviceDrafts.map((item) => item.id)).size).toBe(
        serviceDrafts.length,
      );
      expect(serviceDrafts.map((item) => item.id).sort()).toEqual(
        [
          ...seeded.pageDraftIds,
          ...(await fixture.serviceDraftIds(setup.serviceId)),
        ]
          .filter((id, index, all) => all.indexOf(id) === index)
          .sort(),
      );
      expect(serviceDrafts.map((item) => item.id)).not.toContain(
        "zz-foreign-service-draft",
      );
      const otherServiceSessions = (await session.requestProcessDesign(
        "sessions/list",
        {
          profile: "agent-process-design/1",
          serviceId: seeded.foreignServiceId,
        },
      )) as { sessions: { id: string }[] };
      const otherServiceDrafts = (await session.requestProcessDesign(
        "drafts/list",
        {
          profile: "agent-process-design/1",
          serviceId: seeded.foreignServiceId,
        },
      )) as { drafts: { id: string }[] };
      expect(otherServiceSessions.sessions.map((item) => item.id)).toContain(
        seeded.foreignSessionId,
      );
      expect(otherServiceDrafts.drafts.map((item) => item.id)).toContain(
        "zz-foreign-service-draft",
      );

      view.unmount();
      const paginatedView = render(
        <ProcessDesign
          session={session}
          language={language}
          serviceId={setup.serviceId}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getAllByText(
            new RegExp(` · ${seeded.pageSessionIds[101]!.slice(0, 8)}$`),
          ).length,
        ).toBeGreaterThan(0),
      );
      expect(screen.getByText("TEST page draft 101")).toBeTruthy();
      expect(
        (await fixture.inspect()).requests.some(
          (request) =>
            request.path.includes("/process-design/sessions/list?") &&
            request.path.includes("after=zz-page-session-097"),
        ),
      ).toBe(true);
      expect(
        (await fixture.inspect()).requests.some(
          (request) =>
            request.path.includes("/process-design/drafts/list?") &&
            request.path.includes("after=zz-page-draft-097"),
        ),
      ).toBe(true);
      paginatedView.unmount();

      const modelCallsBeforeRestart = inspection.modelCalls;
      await act(async () => session?.stop());
      await fixture.restart();
      session = new ClientSession(
        setup.endpoint,
        {
          getItem: async (itemKey) => AsyncStorage.getItem(itemKey),
          setItem: async (itemKey, value) =>
            AsyncStorage.setItem(itemKey, value),
        },
        setup.credential,
        (async (
          url: RequestInfo | URL,
          init?: RequestInit,
        ): Promise<Response> => nodeFetch(String(url), init)) as typeof fetch,
        undefined,
        undefined,
        false,
      );
      await session.start(false);
      render(
        <ProcessDesign
          session={session}
          language={language}
          serviceId={setup.serviceId}
        />,
      );
      await screen.findByText(copy.processDesignHistory);
      expect(
        await screen.findByText(copy.processDesignSavedServiceProcesses),
      ).toBeTruthy();
      expect(
        await screen.findByText("TEST integrated native mobile process"),
      ).toBeTruthy();
      expect((await fixture.inspect()).modelCalls).toBe(
        modelCallsBeforeRestart,
      );
      const persistedReview = (await session.requestProcessDesign("review", {
        profile: "agent-process-design/1",
        sessionId: firstSessionId!,
      })) as { review: { acceptedProcessId: string | null } };
      expect(persistedReview.review.acceptedProcessId).toBe(acceptedProcessId);
      const persistedDrafts = (await session.requestProcessDesign(
        "drafts/list",
        {
          profile: "agent-process-design/1",
          serviceId: setup.serviceId,
        },
      )) as {
        drafts: { id: string; name: string; activeVersion: number | null }[];
      };
      const acceptedDraft = persistedDrafts.drafts.find(
        (item) => item.id === acceptedProcessId,
      );
      expect(acceptedDraft?.activeVersion).toBeNull();
      expect(acceptedDraft).toBeTruthy();
      await waitFor(() =>
        expect(
          screen.getAllByRole("button", { name: acceptedDraft!.name }).at(-1)
            ?.props.accessibilityState,
        ).toMatchObject({ disabled: false }),
      );
      await act(async () => {
        fireEvent.press(
          screen.getAllByRole("button", { name: acceptedDraft!.name }).at(-1)!,
        );
        await flush();
      });
      await waitFor(async () =>
        expect(await AsyncStorage.getItem(`${key}:session`)).not.toBe(
          firstSessionId,
        ),
      );
      const editedSessionId = await AsyncStorage.getItem(`${key}:session`);
      expect(editedSessionId).toBeTruthy();
      await screen.findByText(copy.processDesignBaselineDefinition);
      const reopenedDraftReview = (await session.requestProcessDesign(
        "review",
        {
          profile: "agent-process-design/1",
          sessionId: editedSessionId!,
        },
      )) as {
        review: {
          baseline: { processId: string; version: number | null } | null;
        };
      };
      expect(reopenedDraftReview.review.baseline).toMatchObject({
        processId: acceptedProcessId,
        version: null,
      });
      const afterRestart = await fixture.inspect();
      expect(afterRestart.modelCalls).toBe(modelCallsBeforeRestart);
      expect(afterRestart.serviceDispatches).toEqual([]);
    } finally {
      if (session) await act(async () => session?.stop());
      await fixture.close();
    }
  },
  30_000,
);

test("paired mobile designer sends, restores, reviews and saves an inactive draft end to end", async () => {
  const fixture = await mobileHttpChildFixture();
  let session: ClientSession | undefined;
  try {
    const setup = await fixture.configure({ questions: 0, writes: 0 });
    await fixture.enableDesignerProposal();
    session = new ClientSession(
      setup.endpoint,
      {
        getItem: async () => null,
        setItem: async () => {},
      },
      setup.credential,
      (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        nodeFetch(String(url), init)) as typeof fetch,
      undefined,
      undefined,
      false,
    );
    await session.start(false);

    const view = render(<ProcessDesign session={session} language="en" />);
    const start = await screen.findByRole("button", {
      name: en.processDesignStart,
    });
    await act(async () => {
      fireEvent.press(start);
      await flush();
    });
    const prompt = await screen.findByLabelText(en.processDesignPrompt);
    const exactPrompt =
      "Set the contact lookup:\n- read the record\n- do not change it 🧪";
    fireEvent.changeText(prompt, exactPrompt);
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: en.processDesignSend }),
      );
      await flush();
    });
    expect(await screen.findByText(exactPrompt)).toBeTruthy();
    expect(
      await screen.findByText("TEST proposal is ready for review."),
    ).toBeTruthy();
    expect(screen.getByText(en.processDesignFullDefinition)).toBeTruthy();

    const scope = session.getSnapshot().store?.scope;
    if (!scope) throw new Error("TEST paired session has no scope");
    const key = mobileDesignRecoveryKey(session.identityKey, scope);
    expect(await AsyncStorage.getItem(key)).toBeNull();
    const afterTurn = await fixture.inspect();
    const turnPosts = afterTurn.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.path.includes("/process-design/turns?"),
    );
    expect(turnPosts).toHaveLength(1);
    expect(afterTurn.serviceDispatches).toEqual([]);
    const modelCallsAfterTurn = afterTurn.modelCalls;

    view.unmount();
    render(<ProcessDesign session={session} language="en" />);
    expect(await screen.findByText(exactPrompt)).toBeTruthy();
    expect(
      await screen.findByText("TEST proposal is ready for review."),
    ).toBeTruthy();
    expect((await fixture.inspect()).modelCalls).toBe(modelCallsAfterTurn);

    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", {
          name: en.processDesignReviewBeforeSave,
        }),
      );
      await flush();
    });
    const save = await screen.findByRole("button", {
      name: en.processDesignSaveInactive,
    });
    await act(async () => {
      fireEvent.press(save);
      await flush();
    });
    expect(await screen.findByText(en.processDesignSavedInactive)).toBeTruthy();
    const send = screen.getByRole("button", { name: en.processDesignSend });
    expect(send.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByLabelText(en.processDesignPrompt).props.editable).toBe(
      false,
    );

    const final = await fixture.inspect();
    expect(final.serviceDispatches).toEqual([]);
    expect(
      final.requests.some(
        (request) =>
          request.method === "POST" &&
          /\/(processes|services)\//.test(request.path),
      ),
    ).toBe(false);
  } finally {
    if (session) await act(async () => session?.stop());
    await fixture.close();
  }
}, 30_000);

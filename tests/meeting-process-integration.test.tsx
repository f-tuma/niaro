import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { processLaunchDetails } from "./helpers/process-launch-details";
import { MeetingLibrary } from "../apps/mobile/MeetingLibrary";
import { ClientSession } from "../packages/client-core/session";
import { HUMAN_TASK_PROFILE } from "../packages/protocol/human-tasks";
import { en } from "../packages/i18n";
import type { ProcessData } from "../packages/protocol/service-processes";
import { processInputCopy } from "../packages/ui-catalog/process-input-copy";
import { mobileHttpChildFixture } from "./helpers/process-mobile-http-child";
import { processObject } from "./helpers/service-process";

// Each test starts a child HTTP server; slower CI runners need more than 5 s.
jest.setTimeout(30_000);

jest.mock("../apps/mobile/meeting-device", () => ({
  useMeetingDevice: () => ({ capture: null, durationMillis: 0 }),
}));
jest.mock("expo-crypto", () => {
  let sequence = 0;
  return { randomUUID: () => `TEST-meeting-process-${++sequence}` };
});

const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const conversationId = "TEST-meeting-process-conversation";
const meetingTaskInput = processObject({
  proposal: processObject({
    text: { type: "string" },
    assignee: { type: "string" },
    due: { type: "string" },
    sources: {
      type: "array",
      items: processObject({
        segment: { type: "integer" },
        quote: { type: "string" },
      }),
    },
  }),
});
const nodeFetch = require("node-fetch") as (
  url: string,
  init?: unknown,
) => Promise<Response>;

async function prepareReviewedMeetingLaunch({
  writes = 0,
  dropFirstProcessAck = false,
  writeApproval,
  inputSchema = meetingTaskInput,
  selectTaskSource = true,
  stopBeforePrepare = false,
}: {
  writes?: number;
  dropFirstProcessAck?: boolean;
  writeApproval?: "always" | "never";
  inputSchema?: Extract<ProcessData, { type: "object" }>;
  selectTaskSource?: boolean;
  stopBeforePrepare?: boolean;
} = {}) {
  const fixture = await mobileHttpChildFixture();
  let session: ClientSession | undefined;
  try {
    const setup = await fixture.configure({
      questions: 0,
      writes,
      inputSchema,
      writeApproval,
    });
    const meeting = await fixture.seedMeeting();
    let shouldDropProcessAck = dropFirstProcessAck;
    const fetchWithLostAck: typeof fetch = async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const response = await nodeFetch(String(url), init);
      if (shouldDropProcessAck && String(url).includes("/processes/commands")) {
        shouldDropProcessAck = false;
        throw Error("TEST simulate lost process command ACK");
      }
      return response;
    };
    session = new ClientSession(
      setup.endpoint,
      { getItem: async () => null, setItem: async () => {} },
      setup.credential,
      fetchWithLostAck,
      undefined,
      undefined,
      false,
      { processApprovals: true },
    );
    await session.start(false);
    await session.send({
      type: "conversation.create",
      conversationId,
      commandId: "TEST-meeting-process-conversation-create",
      idempotencyKey: "TEST-meeting-process-conversation-create",
    });
    await waitFor(() =>
      expect(JSON.stringify(session?.getSnapshot().store)).toContain(
        conversationId,
      ),
    );
    await expect(session.readMeetings()).resolves.toMatchObject({
      meetings: [expect.objectContaining({ id: meeting.meetingId })],
    });

    const meetingView = render(
      <MeetingLibrary
        session={session}
        language="en"
        visible
        conversationId={conversationId}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId(`meeting-${meeting.meetingId}`)).toBeTruthy(),
    );
    fireEvent.press(screen.getByTestId(`meeting-${meeting.meetingId}`));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: en.meetingProcessSelectTask }),
      ).toBeTruthy(),
    );
    fireEvent.press(
      screen.getByRole("button", { name: en.meetingProcessSelectTask }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: en.meetingProcessTaskSelected }),
      ).toBeTruthy(),
    );

    const record = await session.readMeetingRecord(meeting.meetingId);
    const task = await session.readHumanTask(meeting.taskId);
    expect(task.status).toBe("open");
    expect(task.origin).toMatchObject({
      kind: "meeting",
      meetingId: meeting.meetingId,
      recordDigest: meeting.recordDigest,
    });
    // MeetingLibrary owns ProcessLaunch; keep it mounted through review and start.
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: en.processesLoad }));
      await flush();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("radio", {
          name: `${en.processesSelect}: TEST integrated native mobile process`,
        }),
      ).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.press(
        screen.getByRole("radio", {
          name: `${en.processesSelect}: TEST integrated native mobile process`,
        }),
      );
      await flush();
    });
    if (selectTaskSource) {
      await waitFor(() =>
        expect(screen.getByTestId("meeting-source-map-proposal")).toBeTruthy(),
      );
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", {
            name: en.meetingProcessSourceSelectedTask,
          }),
        );
        await flush();
      });
    }
    if (stopBeforePrepare)
      return { fixture, session, setup, meeting, task, record, meetingView };
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: en.processesPrepare }),
      );
      await flush();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: processInputCopy("en", "prepare"),
        }).props.accessibilityState?.disabled,
      ).toBe(false),
    );
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", {
          name: processInputCopy("en", "prepare"),
        }),
      );
      await flush();
    });
    await waitFor(() =>
      expect(screen.getByTestId("process-launch-review")).toBeTruthy(),
    );
    expect(processLaunchDetails().props.children).toBe(
      JSON.stringify(
        {
          proposal: {
            text: "Anna will prepare the prototype before Friday.",
            assignee: "Anna",
            due: "Friday",
            sources: [
              {
                segment: 0,
                quote: "Anna will prepare the prototype before Friday.",
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    const beforeStart = await fixture.inspect();
    expect(beforeStart.commandPosts).toBe(0);
    expect(beforeStart.processStarts).toHaveLength(0);
    return { fixture, session, setup, meeting, task, record, meetingView };
  } catch (error) {
    if (session) await act(async () => session?.stop());
    await fixture.close();
    throw error;
  }
}

test("MeetingLibrary task selection reaches a reviewed native process over paired HTTP", async () => {
  const h = await prepareReviewedMeetingLaunch();
  try {
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: en.processesStart }));
      await flush();
    });
    await waitFor(() =>
      expect(screen.getByText(en.processesAccepted)).toBeTruthy(),
    );

    const evidence = await h.fixture.inspect();
    expect(evidence.commandPosts).toBe(1);
    expect(evidence.serviceDispatches).toHaveLength(0);
    const commandRequest = evidence.requests.find((request) =>
      request.path.includes("/processes/commands"),
    );
    expect(commandRequest?.status).toBe(202);
    const body = JSON.parse(commandRequest?.body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ conversationId });
    expect(body.input).toEqual({
      proposal: {
        text: "Anna will prepare the prototype before Friday.",
        assignee: "Anna",
        due: "Friday",
        sources: [
          {
            segment: 0,
            quote: "Anna will prepare the prototype before Friday.",
          },
        ],
      },
    });
    expect(evidence.processStarts).toHaveLength(1);
    expect(evidence.processStarts[0]).toMatchObject({
      status: "admitted",
      origin: {
        type: "meeting",
        meetingId: h.meeting.meetingId,
        recordDigest: h.meeting.recordDigest,
        selectedTask: { id: h.meeting.taskId, revision: h.task.revision },
        sourceBindings: { proposal: "selectedTask" },
      },
    });
    expect(evidence.processJournals).toHaveLength(1);
    expect(evidence.processJournals[0]?.status).toBe("succeeded");
  } finally {
    h.meetingView.unmount();
    await act(async () => h.session.stop());
    await h.fixture.close();
  }
});

test("closing the selected task after review keeps the explanation and blocks native admission", async () => {
  const h = await prepareReviewedMeetingLaunch({ writes: 1 });
  try {
    const closed = await h.session.submitHumanTask(h.task.id, {
      profile: HUMAN_TASK_PROFILE,
      commandId: "TEST-close-selected-meeting-task",
      idempotencyKey: "TEST-close-selected-meeting-task-key",
      expectedRevision: h.task.revision,
      decision: "complete",
    });
    expect(closed).toMatchObject({
      id: h.task.id,
      status: "done",
      revision: h.task.revision + 1,
    });

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: en.processesStart }));
      await flush();
    });
    await waitFor(() =>
      expect(screen.getByText(en.process_origin_changed)).toBeTruthy(),
    );
    expect(processLaunchDetails().props.children).toBe(
      JSON.stringify(
        {
          proposal: {
            text: "Anna will prepare the prototype before Friday.",
            assignee: "Anna",
            due: "Friday",
            sources: [
              {
                segment: 0,
                quote: "Anna will prepare the prototype before Friday.",
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const evidence = await h.fixture.inspect();
    expect(evidence.commandPosts).toBe(1);
    expect(evidence.processStarts).toHaveLength(1);
    expect(evidence.processStarts[0]).toMatchObject({
      status: "rejected",
      reason: "process_origin_changed",
      origin: {
        type: "meeting",
        meetingId: h.meeting.meetingId,
        recordDigest: h.meeting.recordDigest,
        selectedTask: { id: h.task.id, revision: h.task.revision },
      },
    });
    expect(h.setup.artifact.definition.kind).toBe("agent");
    if (h.setup.artifact.definition.kind === "agent")
      expect(h.setup.artifact.definition.capabilities).toHaveLength(1);
    expect(evidence.processJournals).toHaveLength(0);
    expect(evidence.serviceDispatches).toHaveLength(0);
  } finally {
    h.meetingView.unmount();
    await act(async () => h.session.stop());
    await h.fixture.close();
  }
});

test("a meeting that loses paired-user access after review is rejected before admission", async () => {
  const h = await prepareReviewedMeetingLaunch({ writes: 1 });
  try {
    await h.fixture.moveMeetingOutsidePairedUserScope(h.meeting.meetingId);
    await act(async () => {
      await expect(
        h.session.readMeetingRecord(h.meeting.meetingId),
      ).rejects.toThrow("meeting_not_found");
    });

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: en.processesStart }));
      await flush();
    });
    await waitFor(() =>
      expect(screen.getByText(en.process_origin_changed)).toBeTruthy(),
    );
    expect(processLaunchDetails().props.children).toBe(
      JSON.stringify(
        {
          proposal: {
            text: "Anna will prepare the prototype before Friday.",
            assignee: "Anna",
            due: "Friday",
            sources: [
              {
                segment: 0,
                quote: "Anna will prepare the prototype before Friday.",
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const evidence = await h.fixture.inspect();
    expect(evidence.commandPosts).toBe(1);
    expect(evidence.processStarts).toHaveLength(1);
    expect(evidence.processStarts[0]).toMatchObject({
      status: "rejected",
      reason: "process_origin_changed",
      origin: {
        type: "meeting",
        meetingId: h.meeting.meetingId,
        recordDigest: h.meeting.recordDigest,
        selectedTask: { id: h.task.id, revision: h.task.revision },
      },
    });
    expect(evidence.processJournals).toHaveLength(0);
    expect(evidence.serviceDispatches).toHaveLength(0);
  } finally {
    h.meetingView.unmount();
    await act(async () => h.session.stop());
    await h.fixture.close();
  }
});

test("incompatible meeting sources are explained and leave a manual input path", async () => {
  const h = await prepareReviewedMeetingLaunch({
    inputSchema: processObject({ proposal: { type: "integer" } }),
    selectTaskSource: false,
    stopBeforePrepare: true,
  });
  try {
    expect(screen.getByText(en.meetingProcessNoCompatibleSources)).toBeTruthy();
    expect((await h.fixture.inspect()).commandPosts).toBe(0);

    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: en.processesPrepare }),
      );
      await flush();
    });
    await waitFor(() =>
      expect(screen.getByTestId("process-input-card")).toBeTruthy(),
    );
    const proposalField = screen.getByLabelText("proposal");
    expect(proposalField.props.editable).toBe(true);
    await act(async () => {
      fireEvent.changeText(proposalField, "7");
      await flush();
    });
    await waitFor(() =>
      expect(screen.getByLabelText("proposal").props.value).toBe("7"),
    );
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", {
          name: processInputCopy("en", "prepare"),
        }),
      );
      await flush();
    });
    await waitFor(() =>
      expect(screen.getByTestId("process-launch-review")).toBeTruthy(),
    );
    expect(processLaunchDetails().props.children).toBe(
      JSON.stringify({ proposal: 7 }, null, 2),
    );
    expect((await h.fixture.inspect()).commandPosts).toBe(0);
  } finally {
    h.meetingView.unmount();
    await act(async () => h.session.stop());
    await h.fixture.close();
  }
});

test("retrying a process command after losing its ACK reuses the same run", async () => {
  const h = await prepareReviewedMeetingLaunch({
    writes: 1,
    dropFirstProcessAck: true,
    writeApproval: "never",
  });
  try {
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: en.processesStart }));
      await flush();
    });
    await waitFor(() =>
      expect(screen.getByText(en.processesUnknown)).toBeTruthy(),
    );

    await waitFor(
      async () => {
        const evidence = await h.fixture.inspect();
        expect(evidence.processJournals[0]?.status).toBe("succeeded");
        expect(evidence.serviceDispatches).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    const afterLostAck = await h.fixture.inspect();
    expect(afterLostAck.commandPosts).toBe(1);
    expect(afterLostAck.processStarts).toHaveLength(1);
    expect(afterLostAck.processStarts[0]?.status).toBe("admitted");
    expect(afterLostAck.processJournals).toHaveLength(1);
    expect(afterLostAck.serviceDispatches).toHaveLength(1);

    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: en.processesRetrySame }),
      );
      await flush();
    });
    await waitFor(() =>
      expect(screen.getByText(en.processesAccepted)).toBeTruthy(),
    );

    const afterRetry = await h.fixture.inspect();
    expect(afterRetry.commandPosts).toBe(2);
    const commandBodies = afterRetry.requests
      .filter((request) => request.path.includes("/processes/commands"))
      .map((request) => request.body);
    expect(commandBodies).toHaveLength(2);
    expect(commandBodies[1]).toBe(commandBodies[0]);
    expect(afterRetry.processStarts).toHaveLength(1);
    expect(afterRetry.processStarts[0]?.input).toEqual({
      proposal: {
        text: "Anna will prepare the prototype before Friday.",
        assignee: "Anna",
        due: "Friday",
        sources: [
          {
            segment: 0,
            quote: "Anna will prepare the prototype before Friday.",
          },
        ],
      },
    });
    expect(afterRetry.processJournals).toHaveLength(1);
    expect(afterRetry.serviceDispatches).toHaveLength(1);
  } finally {
    h.meetingView.unmount();
    await act(async () => h.session.stop());
    await h.fixture.close();
  }
}, 20_000);

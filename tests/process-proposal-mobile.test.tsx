import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ProcessProposalCard } from "../apps/mobile/ProcessProposal";
import type { ClientSession } from "../packages/client-core/session";
import type {
  ProcessProposalResult,
  ProcessProposalStatus,
} from "../packages/protocol/process-proposal";

let mockPress = 0;
jest.mock("expo-crypto", () => ({
  randomUUID: () => `TEST-press-${++mockPress}`,
}));
jest.mock("../apps/mobile/feedback", () => ({
  feedback: () => 0,
  setFeedbackEnabled: jest.fn(),
}));

const sessionId = "6f0c3f43-2d4b-4b8e-9a51-6d1d6c1e2f10";
const proposal: ProcessProposalResult = {
  type: "process.proposal",
  version: 1,
  sessionId,
  revision: 2,
  reviewDigest: "a".repeat(64),
  status: "ready",
  name: "TEST Deals this week",
  description: "TEST open deals as one line",
  kind: "workflow",
  steps: [
    {
      type: "action",
      service: "TEST CRM",
      action: "TEST find deals",
      effect: "read",
      approval: false,
    },
    { type: "return", fields: ["summary"] },
  ],
  inputs: [],
  outputs: ["summary"],
  services: [
    { name: "TEST CRM", reads: true, writes: false },
    { name: "TEST Calendar", reads: true, writes: false },
  ],
  assumptions: [
    {
      id: "source",
      text: "TEST deals come from the CRM",
      digest: "b".repeat(64),
    },
  ],
  questions: [],
  hubEligible: true,
  addToHub: true,
};
const status = (
  patch: Partial<ProcessProposalStatus>,
): ProcessProposalStatus => ({
  profile: "agent-process-proposal/1",
  sessionId,
  state: "open",
  services: [
    { serviceId: "TEST-crm", name: "TEST CRM", signIn: "needed" },
    { serviceId: "TEST-calendar", name: "TEST Calendar", signIn: "connected" },
  ],
  ...patch,
});
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
function sessionWith(reads: ProcessProposalStatus[]) {
  const queue = [...reads];
  return {
    address: "https://niaro.test/v1/workspace-a",
    readProcessProposal: jest.fn(async () => queue.shift() ?? reads.at(-1)!),
    acceptProcessProposal: jest.fn(async () =>
      status({ state: "running", phase: "testing" }),
    ),
    serviceConnection: jest.fn(async (action: string, serviceId: string) =>
      action === "status"
        ? { serviceId, status: "disconnected", ready: true }
        : {
            serviceId,
            attemptId: "A".repeat(43),
            authorizationUrl: `https://niaro.test/admin/service-connect#${"A".repeat(43)}`,
            expiresAt: Date.now() + 60_000,
          },
    ),
  };
}
const view = (session: ReturnType<typeof sessionWith>, card = proposal) =>
  render(
    <ProcessProposalCard
      session={session as unknown as ClientSession}
      language="en"
      proposal={card}
      disabled={false}
      online
    />,
  );

beforeEach(() => {
  mockPress = 0;
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

test("Save and turn on sends what the card shows and follows the save until it is on", async () => {
  const session = sessionWith([
    status({}),
    status({ state: "running", phase: "testing" }),
    status({
      state: "done",
      processId: "TEST-process",
      version: 1,
      hub: "added",
    }),
  ]);
  view(session);
  await act(flush);
  expect(
    screen.getByText("TEST deals come from the CRM", { exact: false }),
  ).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Save and turn on" }));
    await flush();
  });
  expect(session.acceptProcessProposal).toHaveBeenCalledWith(
    {
      sessionId,
      requestId: "TEST-press-1",
      revision: 2,
      reviewDigest: "a".repeat(64),
      assumptions: [{ id: "source", digest: "b".repeat(64) }],
      addToHub: true,
    },
    "en",
  );
  expect(screen.getByText("Testing…")).toBeTruthy();
  await act(async () => {
    jest.advanceTimersByTime(1500);
    await flush();
  });
  expect(screen.getByText("On, and on your overview")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save and turn on" })).toBeNull();
  // Editing stays in the web app.
  expect(
    screen.getByRole("button", { name: "Open in the web app" }),
  ).toBeTruthy();
});

test("a press whose answer was lost is sent again with the same request id", async () => {
  const session = sessionWith([status({})]);
  session.acceptProcessProposal.mockRejectedValueOnce(
    new Error("connection_failed"),
  );
  view(session);
  await act(flush);
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Save and turn on" }));
    await flush();
  });
  expect(screen.getByText("It didn't work.")).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await flush();
  });
  expect(
    session.acceptProcessProposal.mock.calls.map(
      (call) => (call as unknown as [{ requestId: string }])[0].requestId,
    ),
  ).toEqual(["TEST-press-1", "TEST-press-1"]);
});

test("each service says whether the person is signed in, and Sign in starts the service's sign-in", async () => {
  const session = sessionWith([status({})]);
  view(session);
  await act(flush);
  const rows = screen.getAllByTestId("process-proposal-service");
  expect(rows).toHaveLength(2);
  expect(screen.getByText("Not signed in")).toBeTruthy();
  expect(screen.getByText("Signed in")).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Sign in: TEST CRM" }));
    await flush();
  });
  expect(session.serviceConnection).toHaveBeenCalledWith(
    "start",
    "TEST-crm",
    expect.anything(),
  );
  expect(screen.getByText("Waiting for sign-in…")).toBeTruthy();
});

test("a card with open questions cannot be saved from the phone", async () => {
  const session = sessionWith([status({ services: undefined })]);
  view(session, {
    ...proposal,
    status: "questions",
    questions: ["TEST which pipeline?"],
  });
  await act(flush);
  expect(screen.getByText("• TEST which pipeline?")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save and turn on" })).toBeNull();
  // Before a status says otherwise, the services are only named.
  expect(screen.queryByText("Not signed in")).toBeNull();
});

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ProcessLaunch } from "../apps/mobile/ProcessLaunch";
import { MobileWorkItemCard } from "../apps/mobile/MobileWorkItemCard";
import { translate } from "../packages/i18n";
import { processInputCopy as copy } from "../packages/ui-catalog/process-input-copy";
import { processFailure } from "../packages/protocol/process-failure";
import type { WorkItem } from "../packages/protocol";
import { processLaunchFixture } from "./helpers/process-launch-client";

jest.mock("expo-crypto", () => {
  let id = 0;
  return { randomUUID: () => `TEST-rerun-${++id}` };
});
jest.mock("../apps/mobile/feedback", () => ({
  feedback: () => 0,
  setFeedbackEnabled: jest.fn(),
}));

const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const press = async (name: string) => {
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name }));
    await flush();
  });
};

test("Run again on the phone opens the current form with the earlier input and starts only after review", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en");
  await session.start(false);
  h.runs.set("TEST-earlier", {
    processId: "TEST-process-A",
    version: 1,
    input: { name: "TEST earlier name" },
  });
  render(
    <ProcessLaunch
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
      rerun={{ parentRunId: "TEST-earlier", processId: "TEST-process-A" }}
    />,
  );
  await act(flush);
  expect(h.runReads).toEqual(["TEST-earlier"]);
  expect(h.inputRequests).toHaveLength(1);
  expect(screen.getByLabelText("name").props.value).toBe("TEST earlier name");
  expect(h.commands).toHaveLength(0);
  await press(copy("en", "prepare"));
  expect(h.commands).toHaveLength(0);
  await press(tr("processesStart"));
  expect(h.commands).toHaveLength(1);
  expect(JSON.parse(h.commands[0]!).input).toEqual({
    name: "TEST earlier name",
  });
  session.stop();
});

test("Run again with input the form no longer accepts shows field errors and sends nothing", async () => {
  const h = processLaunchFixture(),
    session = h.open();
  await session.start(false);
  h.runs.set("TEST-changed", {
    processId: "TEST-process-A",
    version: 1,
    // The form's "name" is text now; "region" is gone.
    input: { name: 42, region: "TEST north" },
  });
  render(
    <ProcessLaunch
      session={session}
      language="cs"
      conversationId="conversation-1"
      chatGeneration={0}
      rerun={{ parentRunId: "TEST-changed", processId: "TEST-process-A" }}
    />,
  );
  await act(flush);
  expect(screen.getByText(copy("cs", "errors"))).toBeTruthy();
  expect(
    screen.getByText(`name: ${copy("cs", "errorChanged")}`),
  ).toBeTruthy();
  expect(
    screen.getByText(`${copy("cs", "root")}: ${copy("cs", "errorDropped")}`),
  ).toBeTruthy();
  await press(copy("cs", "prepare"));
  // Review refuses the empty field; nothing is sent.
  expect(h.commands).toHaveLength(0);
  expect(screen.queryByText(translate("cs")("processesStart"))).toBeNull();
  session.stop();
});

test("Run again of a process that can't start now says so and opens no form", async () => {
  const h = processLaunchFixture(),
    session = h.open();
  await session.start(false);
  h.runs.set("TEST-blocked", {
    processId: "TEST-process-C",
    version: 2,
    input: {},
  });
  render(
    <ProcessLaunch
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
      rerun={{ parentRunId: "TEST-blocked", processId: "TEST-process-C" }}
    />,
  );
  await act(flush);
  expect(
    screen.getByText(translate("en")("processRunAgainUnavailable")),
  ).toBeTruthy();
  expect(h.inputRequests).toHaveLength(0);
  // The list explains the blocked process with the shared sentence.
  expect(
    screen.getByText(
      `${translate("en")("processesBlocked")}: ${processFailure("model_unavailable", "en").sentence}`,
    ),
  ).toBeTruthy();
  session.stop();
});

const failedRun = (failureCode: string): WorkItem =>
  ({
    id: "TEST-earlier",
    revision: 2,
    conversationId: "conversation-1",
    title: "TEST process A",
    context: "The process failed.",
    status: "failed",
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    demo: false,
    native: {
      runId: "TEST-earlier",
      revision: 2,
      process: {
        kind: "service-process-1",
        provenance: {
          runId: "TEST-run-earlier",
          processId: "TEST-process-A",
          version: 1,
          artifactDigest: "a".repeat(64),
          actorId: "TEST-user",
          conversationId: "conversation-1",
        },
        status: "failed",
        journalStatus: "failed",
        detailsAvailable: true,
        failureCode,
        receipts: [],
      },
    },
    result: "The process failed.",
    presentation: {
      type: "workflow.progress",
      version: 1,
      variant: "default",
    },
  }) as unknown as WorkItem;

test("a failed run's card offers Sign in when it stopped for a sign-in, and Run again", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en"),
    onSignIn = jest.fn();
  await session.start(false);
  h.runs.set("TEST-earlier", {
    processId: "TEST-process-A",
    version: 1,
    input: { name: "TEST earlier name" },
  });
  render(
    <MobileWorkItemCard
      session={session}
      conversationId="conversation-1"
      chatGeneration={0}
      work={failedRun("connection_required")}
      language="en"
      onAnswer={jest.fn()}
      onSignIn={onSignIn}
    />,
  );
  await press(tr("signIn"));
  expect(onSignIn).toHaveBeenCalledTimes(1);
  expect(h.runReads).toEqual([]);
  await press(tr("processRunAgain"));
  await act(flush);
  expect(h.runReads).toEqual(["TEST-earlier"]);
  expect(screen.getByLabelText("name").props.value).toBe("TEST earlier name");
  expect(h.commands).toHaveLength(0);
  session.stop();
});

test("without a sign-in handler, or for another failure, the card offers no Sign in", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en");
  await session.start(false);
  const { rerender } = render(
    <MobileWorkItemCard
      session={session}
      conversationId="conversation-1"
      chatGeneration={0}
      work={failedRun("connection_required")}
      language="en"
      onAnswer={jest.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: tr("signIn") })).toBeNull();
  rerender(
    <MobileWorkItemCard
      session={session}
      conversationId="conversation-1"
      chatGeneration={0}
      work={failedRun("process_step_limit")}
      language="en"
      onAnswer={jest.fn()}
      onSignIn={jest.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: tr("signIn") })).toBeNull();
  expect(
    screen.getByRole("button", { name: tr("processRunAgain") }),
  ).toBeTruthy();
  session.stop();
});

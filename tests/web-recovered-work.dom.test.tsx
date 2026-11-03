/**
 * NIAR-281: a run that delivered its answer after a failed read shows the
 * person the answer, not an "Action failed" card. Failed steps are for
 * administrators (Runs). A failed write still shows its card.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import type {
  ClientSession,
  SessionState,
} from "../packages/client-core/session";
import type { WorkItem } from "../packages/protocol";
import type { ServiceResult } from "../packages/protocol/service-result";
import { WorkCard } from "../apps/server-admin/web/app/chat-work";
import { translate } from "../packages/i18n";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({ language: "en" }),
  useAppSession: () => {
    throw new Error("Pass the session directly");
  },
}));

const action = (
  status: ServiceResult["status"],
  effect: ServiceResult["effect"],
): ServiceResult => ({
  type: "service.action",
  version: 1,
  operationId: "op-1",
  title: "List mail messages",
  service: "Microsoft 365",
  status,
  effect,
  fields: [],
  inputJson: "",
  reviewTruncated: false,
  summary: "",
});
const work = (status: WorkItem["status"], result: ServiceResult): WorkItem => ({
  id: "run-1",
  revision: 3,
  conversationId: "conv-1",
  title: "How many unread mails?",
  context: "How many unread mails?",
  status,
  inputRequestIds: [],
  actionProposalIds: [],
  operationIds: [],
  demo: false,
  native: { runId: "run-1", revision: 3, action: result },
  result: "You have 4 unread mails.",
  presentation: {
    type: "workflow.progress",
    version: 1,
    variant: "default",
  },
});
const state = {
  store: null,
  status: "online",
  commandStates: {},
  pending: null,
  processPending: null,
  answerAttempts: [],
  answerRecoveryBlocked: false,
  error: null,
  processNotice: null,
  activity: null,
  activityConnection: "waiting",
} as unknown as SessionState;
const session = {
  canRetryNativeWork: () => false,
  getRetrySource: () => undefined,
  send: jest.fn(),
} as unknown as ClientSession;

let root: Root | undefined;
async function renderWork(item: WorkItem) {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <WorkCard
        session={session}
        state={state}
        work={item}
        conversationId="conv-1"
        stale={false}
        blocked={false}
      />,
    ),
  );
  return within(container);
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const failedLabel = translate("en")("serviceFailed");

test("a succeeded run shows its answer, not the failed read it got past", async () => {
  const view = await renderWork(work("succeeded", action("failed", "read")));
  expect(view.queryByText(failedLabel)).toBeNull();
  expect(view.queryByText("List mail messages")).toBeNull();
  expect(view.getByText("You have 4 unread mails.")).toBeTruthy();
});

test("a failed write keeps its failure card", async () => {
  const view = await renderWork(work("failed", action("failed", "write")));
  expect(view.getByText(failedLabel)).toBeTruthy();
});

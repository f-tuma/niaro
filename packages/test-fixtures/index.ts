import {
  PROFILE,
  WorkItemSchema,
  type Scope,
  type Snapshot,
  type Language,
  type WorkItem,
  type InputRequest,
  type CrmContactResult,
} from "../protocol";
import type { ActivityWorkflow, RequestActivity } from "../protocol/activity";
export const requestActivity = (): RequestActivity => ({
  commandId: "test-progress",
  conversationId: "conversation-1",
  status: "running",
  steps: [
    { id: "understanding", status: "succeeded" },
    { id: "crm", status: "running" },
    { id: "preparing", status: "pending" },
  ],
});
export const pluginActivity = (
  status: NonNullable<RequestActivity["tools"]>[number]["status"] = "running",
): RequestActivity => ({
  ...requestActivity(),
  steps: [
    { id: "understanding", status: "running" },
    { id: "preparing", status: "pending" },
  ],
  tools: [{ id: "datetime", status, calls: 1 }],
});
export const workflowActivity = (
  workflow: ActivityWorkflow = { step: 1, stage: "service" },
): RequestActivity => ({
  ...requestActivity(),
  steps: [
    { id: "understanding", status: "running" },
    { id: "preparing", status: "pending" },
  ],
  workflow,
});
export const crmContactResult = (): CrmContactResult => ({
  type: "crm.contacts",
  version: 1,
  source: "twenty",
  hasMore: false,
  contacts: [
    {
      id: "test-alex-novak",
      name: "TEST Alex Novák",
      jobTitle: "Product designer",
      phone: "+1 202 555 0147",
      email: "alex.novak@example.test",
    },
  ],
});
export const scopeFor = (workspaceId = "a"): Scope => ({
  connectionId: `fixture-${workspaceId}`,
  serverId: "fixture-local",
  userId: "demo-user",
  workspaceId,
});
export const emptySnapshot = (scope = scopeFor()): Snapshot => ({
  profile: PROFILE,
  scope,
  cursor: 0,
  conversations: [{ id: "conversation-1", revision: 1, messages: [] }],
  workItems: [],
  inputRequests: [],
  actionProposals: [],
  operations: [],
});
export function choosePeter(
  language: Language = "en",
  suffix = "1",
): { work: WorkItem; input: InputRequest } {
  const cs = language === "cs";
  return {
    work: {
      id: `work-${suffix}`,
      conversationId: "conversation-1",
      revision: 1,
      title: cs ? "Schůzka s Peterem" : "Meeting with Peter",
      context: cs
        ? "Příští týden · výběr kontaktu · ukázkový scénář"
        : "Next week · contact selection · demo scenario",
      status: "waiting_input",
      inputRequestIds: [`input-${suffix}`],
      actionProposalIds: [],
      operationIds: [],
      demo: true,
      presentation: {
        type: "workflow.progress",
        version: 1,
        variant: "default",
      },
    },
    input: {
      id: `input-${suffix}`,
      workItemId: `work-${suffix}`,
      conversationId: "conversation-1",
      revision: 1,
      question: cs
        ? "Našel jsem dva kontakty. Kterého Petera máš na mysli?"
        : "I found two contacts. Which Peter do you mean?",
      status: "open",
      options: [
        {
          id: "peter-novak",
          label: "Peter Novák",
          detail: "Acme · Product design",
        },
        {
          id: "peter-svoboda",
          label: "Peter Svoboda",
          detail: "Northstar · Engineering",
        },
      ],
      presentation: { type: "input.choice", version: 1, variant: "contacts" },
    },
  };
}
export const openSnapshot = (language: Language = "en"): Snapshot => {
  const { work, input } = choosePeter(language);
  return {
    ...emptySnapshot(),
    cursor: 3,
    workItems: [work],
    inputRequests: [input],
    conversations: [
      {
        id: "conversation-1",
        revision: 2,
        messages: [
          {
            id: "message-1",
            role: "assistant",
            text: input.question,
            workItemId: work.id,
            inputRequestId: input.id,
          },
        ],
      },
    ],
  };
};

export function meetingProposal(
  language: Language = "en",
): import("../protocol").ActionProposal {
  return {
    id: "proposal-work-1",
    revision: 1,
    workItemId: "work-1",
    conversationId: "conversation-1",
    status: "awaiting_approval",
    operationType: "calendar.create",
    demo: true,
    parameters: {
      title: language === "cs" ? "Schůzka s Peterem" : "Meeting with Peter",
      participant: {
        id: "peter-novak",
        label: "Peter Novák",
        email: "peter-novak@example.test",
      },
      startsAt: "2026-09-29T12:00:00.000Z",
      endsAt: "2026-09-29T12:30:00.000Z",
      timeZone: "UTC",
    },
    presentation: { type: "action.approval", version: 1, variant: "meeting" },
  };
}

/** Offline native task stories use the same typed projection as the server. */
export function nativeTaskQuestion(
  language: Language = "en",
): import("../protocol").WorkItem {
  const id = "TEST-native-work";
  return {
    id,
    revision: 4,
    conversationId: "conversation-1",
    title:
      language === "cs"
        ? "Připravit schůzku s Janou"
        : "Prepare a meeting with Jane",
    context:
      language === "cs" ? "Čekám na upřesnění dne." : "Waiting for the day.",
    status: "waiting_input",
    demo: false,
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    native: {
      runId: id,
      revision: 4,
      question: {
        runtime: "mastra",
        id: "TEST-native-question",
        revision: 1,
        workItemId: id,
        conversationId: "conversation-1",
        status: "open",
        question:
          language === "cs"
            ? "Který den se má schůzka konat?"
            : "Which day should the meeting take place?",
      },
    },
    presentation: { type: "workflow.progress", version: 1, variant: "default" },
  };
}
export function nativeTaskApproval(
  language: Language = "en",
): import("../protocol").WorkItem {
  const work = nativeTaskQuestion(language);
  return {
    ...work,
    status: "waiting_approval",
    native: {
      runId: work.id,
      revision: 4,
      action: {
        type: "service.action",
        version: 1,
        operationId: "TEST-native-operation",
        title: language === "cs" ? "Vytvořit schůzku" : "Create a meeting",
        service: "TEST Calendar",
        status: "awaiting_approval",
        effect: "write",
        fields: [
          {
            label: language === "cs" ? "Účastník" : "Attendee",
            value: "jane@example.test",
          },
          {
            label: language === "cs" ? "Začátek" : "Starts",
            value: "2026-10-05 10:00 Europe/Prague",
          },
        ],
        inputJson:
          '{"attendee":"jane@example.test","start":"2026-10-05T08:00:00Z"}',
        reviewTruncated: false,
        summary: "",
      },
    },
  };
}

/** Public native question with independent projection and parent journal generations. */
export function processTaskQuestion(
  language: Language = "en",
  withCard = true,
): WorkItem {
  const cs = language === "cs",
    id = "TEST-process-parent";
  const question = cs
    ? "TEST Který den se má schůzka konat?"
    : "TEST Which day should the meeting take place?";
  const context = cs
    ? "Čekám na odpověď na otázku."
    : "Waiting for an answer to the question.";
  return WorkItemSchema.parse({
    ...nativeTaskQuestion(language),
    id,
    revision: 99,
    context,
    native: {
      runId: id,
      revision: 7,
      process: {
        kind: "service-process-1",
        status: "waiting",
        journalStatus: "waiting",
        journalRevision: 7,
        detailsAvailable: true,
        receipts: [],
        provenance: {
          runId: "TEST-process-run",
          processId: "TEST-process",
          version: 1,
          artifactDigest: "a".repeat(64),
          actorId: "demo-user",
          conversationId: "conversation-1",
          commandId: "TEST-start",
          admissionId: "TEST-admission",
        },
        question: {
          nodeId: "agent",
          childRunId: "TEST-child",
          toolCallId: "TEST-call-A",
          questionId: "TEST-question-A",
          questionRevision: 1,
          question,
        },
      },
    },
    ...(withCard
      ? {
          card: {
            id: "TEST-process-question-card",
            revision: 7,
            title: cs ? "TEST Otázka procesu" : "TEST Process question",
            icon: "tasks",
            root: ["context", "question"],
            actions: [],
            nodes: [
              { id: "context", type: "notice", tone: "info", text: context },
              { id: "question", type: "text", text: question },
            ],
          },
        }
      : {}),
  });
}

/** Synthetic, passive process outcomes for rendering and accessibility checks. */
export function processTaskResult(
  language: Language = "en",
  status: "failed" | "unknown" | "cancelled" | "succeeded" = "failed",
): WorkItem {
  const cs = language === "cs",
    id = "b".repeat(64);
  const explanation =
    status === "unknown"
      ? cs
        ? "Výsledek není potvrzený. Zápis již mohl proběhnout; před opakováním ověř stav ve službě."
        : "The result is not confirmed. A write may already have happened; check the service before retrying."
      : status === "failed"
        ? cs
          ? "Proces se nepodařilo dokončit. Dřívější zápis se podařil; toto selhání ho nevrací zpět."
          : "The process could not be completed. An earlier write succeeded; this failure does not undo it."
        : status === "cancelled"
          ? cs
            ? "Proces byl přerušen. Uložené výsledky akcí zůstávají níže."
            : "The process was interrupted. Recorded action outcomes remain below."
          : cs
            ? "Proces byl dokončen."
            : "The process completed.";
  const writeStatus =
    status === "unknown"
      ? "unknown"
      : status === "cancelled"
        ? "rejected"
        : "succeeded";
  return WorkItemSchema.parse({
    ...nativeTaskQuestion(language),
    id,
    title: cs ? "TEST Založení osoby" : "TEST Create a person",
    context: explanation,
    status: status === "unknown" ? "waiting_system" : status,
    result: explanation,
    native: {
      runId: id,
      revision: 4,
      process: {
        kind: "service-process-1",
        provenance: {
          runId: "TEST-process-alias",
          processId: "TEST-person-process",
          version: 2,
          artifactDigest: "a".repeat(64),
          actorId: "TEST-person",
          conversationId: "conversation-1",
          commandId: "TEST-original-command",
          admissionId: "TEST-admission",
        },
        status,
        journalStatus: status,
        detailsAvailable: true,
        receipts: [
          {
            operationId: "TEST-read",
            title: cs ? "Najít osobu" : "Find a person",
            service: "TEST CRM",
            effect: "read",
            status: "succeeded",
            summary: cs ? "Osoba nalezena." : "Person found.",
          },
          {
            operationId: "TEST-write",
            title: cs ? "Založit osobu" : "Create a person",
            service: "TEST CRM",
            effect: "write",
            status: writeStatus,
            summary: "TEST canonical receipt",
          },
        ],
      },
    },
    card: {
      id: "TEST-process-card",
      revision: 4,
      title: cs ? "TEST Založení osoby" : "TEST Create a person",
      icon: "tasks",
      root: ["outcome", "actions"],
      actions: [],
      nodes: [
        {
          id: "outcome",
          type: "notice",
          tone:
            status === "unknown" || status === "failed" ? "warning" : "info",
          text: explanation,
        },
        {
          id: "actions",
          type: "disclosure",
          label: cs ? "Uložené akce (2)" : "Recorded actions (2)",
          children: ["read", "write"],
        },
        {
          id: "read",
          type: "field",
          label: cs ? "Čtení · Dokončeno" : "Read · Completed",
          value: cs ? "TEST CRM · Osoba nalezena." : "TEST CRM · Person found.",
        },
        {
          id: "write",
          type: "field",
          label: cs ? "Zápis" : "Write",
          value:
            writeStatus === "unknown"
              ? cs
                ? "Nepotvrzeno"
                : "Unconfirmed"
              : writeStatus === "rejected"
                ? cs
                  ? "Odmítnuto"
                  : "Rejected"
                : cs
                  ? "Dokončeno"
                  : "Completed",
        },
      ],
    },
  });
}

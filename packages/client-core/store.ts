import {
  PROFILE,
  EventSchema,
  SnapshotSchema,
  sameScope,
  type Scope,
  type Snapshot,
  type Conversation,
  type WorkItem,
  type InputRequest,
  type ReplyInput,
  type ActionProposal,
  type Operation,
} from "../protocol";
export type Store = {
  connectionKey: string;
  scope: Scope;
  cursor: number;
  conversations: Record<string, Conversation>;
  workItems: Record<string, WorkItem>;
  inputRequests: Record<string, InputRequest>;
  actionProposals: Record<string, ActionProposal>;
  operations: Record<string, Operation>;
  seen: string[];
  stale: boolean;
  needsSnapshot: boolean;
};
const index = <T extends { id: string }>(items: T[]): Record<string, T> =>
  Object.fromEntries(items.map((v) => [v.id, v]));
export function fromSnapshot(
  connectionKey: string,
  trustedScope: Scope,
  raw: unknown,
): Store {
  const s = SnapshotSchema.parse(raw);
  if (!sameScope(s.scope, trustedScope)) throw new Error("scope_mismatch");
  return {
    connectionKey,
    scope: trustedScope,
    cursor: s.cursor,
    conversations: index(s.conversations),
    workItems: index(s.workItems),
    inputRequests: index(s.inputRequests),
    actionProposals: index(s.actionProposals),
    operations: index(s.operations),
    seen: [],
    stale: false,
    needsSnapshot: false,
  };
}
export function applyEvent(
  state: Store,
  connectionKey: string,
  raw: unknown,
): Store {
  const event = EventSchema.parse(raw);
  if (
    connectionKey !== state.connectionKey ||
    !sameScope(event.scope, state.scope)
  )
    return state;
  if (
    state.needsSnapshot ||
    state.seen.includes(event.eventId) ||
    event.sequence <= state.cursor
  )
    return state;
  if (event.sequence !== state.cursor + 1)
    return { ...state, stale: true, needsSnapshot: true };
  const key =
    event.type === "conversation.upserted"
      ? "conversations"
      : event.type === "work_item.upserted"
        ? "workItems"
        : event.type === "input_request.upserted"
          ? "inputRequests"
          : event.type === "action_proposal.upserted"
            ? "actionProposals"
            : "operations";
  const current = state[key][event.entity.id];
  return {
    ...state,
    cursor: event.sequence,
    seen: [...state.seen.slice(-499), event.eventId],
    [key]:
      current && current.revision >= event.entity.revision
        ? state[key]
        : { ...state[key], [event.entity.id]: event.entity },
  };
}
export function mergeSnapshot(state: Store, key: string, raw: unknown): Store {
  if (key !== state.connectionKey) return state;
  const next = fromSnapshot(key, state.scope, raw);
  return next.cursor < state.cursor ? state : next;
}
export function toSnapshot(state: Store): Snapshot {
  return SnapshotSchema.parse({
    profile: PROFILE,
    scope: state.scope,
    cursor: state.cursor,
    conversations: Object.values(state.conversations),
    workItems: Object.values(state.workItems),
    inputRequests: Object.values(state.inputRequests),
    actionProposals: Object.values(state.actionProposals),
    operations: Object.values(state.operations),
  });
}
export function selectTasks(
  state: Store,
  tab: "allTasks" | "needsInput" | "upcoming" | "completed",
) {
  return Object.values(state.workItems).filter((w) => {
    if (tab === "allTasks") return true;
    const terminal = [
      "succeeded",
      "failed",
      "cancelled",
      "expired",
      "superseded",
    ].includes(w.status);
    if (tab === "completed") return terminal;
    if (terminal) return false;
    const waiting =
      w.status === "waiting_approval" ||
      w.status === "waiting_input" ||
      w.inputRequestIds.some(
        (id) => state.inputRequests[id]?.status === "open",
      );
    return tab === "needsInput" ? waiting : !waiting;
  });
}
export function selectConversationWork(state: Store, conversationId: string) {
  return Object.values(state.workItems).filter(
    (w) => w.conversationId === conversationId,
  );
}

/** One live card per work item, next to its latest assistant response. Earlier text stays historical. */
export function selectWorkMessageAnchors(
  state: Store,
  conversationId: string,
  messages = state.conversations[conversationId]?.messages ?? [],
) {
  const anchors = new Map<string, string>();
  const presentedOperations = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" && message.result?.type === "service.action"
        ? [message.result.operationId]
        : [],
    ),
  );
  for (const message of messages) {
    if (
      message.role === "assistant" &&
      message.workItemId &&
      state.workItems[message.workItemId]?.conversationId === conversationId
    ) {
      const work = state.workItems[message.workItemId]!;
      // A service result already owns this card. Keep later text as history,
      // rather than replacing it with another live copy of the task.
      if (
        work.native &&
        ((!work.native.process && isTerminalNativeWork(work)) ||
          (work.native.action &&
            presentedOperations.has(work.native.action.operationId)))
      )
        continue;
      anchors.set(message.workItemId, message.id);
    }
  }
  return anchors;
}

export const isTerminalNativeWork = (work: WorkItem) =>
  !!work.native && ["succeeded", "failed", "cancelled"].includes(work.status);

/** Only visible results suppress fallback cards; opening an older task still works. */
export function selectPresentedWork(
  state: Store,
  conversationId: string,
  messages: Conversation["messages"],
) {
  const operations = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" && message.result?.type === "service.action"
        ? [message.result.operationId]
        : [],
    ),
  );
  return new Set(
    selectConversationWork(state, conversationId)
      .filter(
        (work) =>
          work.native?.action && operations.has(work.native.action.operationId),
      )
      .map((work) => work.id),
  );
}

/** One lookup for chat, Tasks and frozen voice contexts. */
export function selectReplyInput(
  state: Store | null | undefined,
  input: ReplyInput | undefined,
): ReplyInput | undefined {
  if (!state || !input) return undefined;
  const question =
    state.inputRequests[input.id] ??
    state.workItems[input.workItemId]?.native?.question;
  return question?.id === input.id ? question : undefined;
}

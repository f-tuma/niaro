import { createContext, useContext, type PropsWithChildren } from "react";
import {
  MessagePrimitive,
  useAuiState,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { Check, CircleAlert } from "lucide-react";
import { Spinner } from "@admin/components/ui/spinner";
import { Markdown } from "@admin/components/ui/markdown";
import type {
  ClientSession,
  SessionState,
} from "../../../../../packages/client-core/session";
import type {
  CrmContactResult,
  NativeQuestion,
  WorkItem,
} from "../../../../../packages/protocol";
import type { AnswerStreamStep } from "../../../../../packages/protocol/answer-stream";
import type { ServiceResult } from "../../../../../packages/protocol/service-result";
import type { ServiceConnectionCard as ConnectionResult } from "../../../../../packages/protocol/service-oauth";
import type { ProcessOfferResult } from "../../../../../packages/protocol/process-offer";
import type { SkillProposalResult } from "../../../../../packages/protocol/skills";
import type { ProcessProposalResult } from "../../../../../packages/protocol/process-proposal";
import {
  cardDocumentText,
  type CardDocument,
} from "../../../../../packages/protocol/card-document";
import {
  ContactList,
  ProcessOfferView,
  ProcessProposalView,
  ServiceActionView,
  ServiceConnectionView,
} from "../chat-cards";
import { SkillProposalView } from "../skill-proposal-card";
import { WorkCard, liveStepText } from "../chat-work";
import { GeneratedUi } from "../generative-ui";
import { loopsCopy } from "../../loops-copy";
import { useApp } from "../context";
import { useChatCopy } from "../chat-copy";
import { TOOL } from "./transport";

/**
 * What the parts need from the chat: the session, the chat's state and the
 * commands the page sends. The thread renders each part through assistant-ui;
 * the page owns the commands.
 */
export type NextChat = {
  session: ClientSession;
  state: SessionState;
  conversationId: string;
  online: boolean;
  busy: boolean;
  readOnly: boolean;
  stale: boolean;
  rememberTarget?: { organizationId: string; workspaceId: string };
  decide: (operationId: string, approved: boolean) => Promise<boolean>;
  /** A generated answer's follow-up goes to the composer, never sent. */
  followUp: (text: string) => void;
  /** A sign-in card's "Continue": the message that goes on. */
  continueWith: (text: string) => void;
  declineOffer: (requestText: string) => void;
  reviewOffer: (offer: ProcessOfferResult) => void;
  work: (id: string) => WorkItem | undefined;
  replyToWork: (work: WorkItem) => void;
  answerQuestion: (question: NativeQuestion, answer: string) => void;
  /** The newest open question with offered answers takes the digit keys. */
  shortcutQuestion?: string;
  /** "Again": the request before the last answer, sent once more. */
  again: (requestText: string) => void;
  /** "Edit": the text back in the composer; history stays as it was. */
  edit: (text: string) => void;
  /** Resends the pending request when its delivery is uncertain. */
  retry?: () => void;
};
const NextChatContext = createContext<NextChat | null>(null);
export const NextChatProvider = NextChatContext.Provider;
export function useNextChat() {
  const chat = useContext(NextChatContext);
  if (!chat) throw new Error("NextChatProvider missing");
  return chat;
}

/** An answer's text, as Markdown. */
export function AssistantText({ text }: { text: string }) {
  return <Markdown text={text} />;
}
/** The person's text, as written. */
export function UserText({ text }: { text: string }) {
  return <>{text}</>;
}

/** One streamed tool step, as one line like the Runs page names it. */
function StepPart({
  args,
}: ToolCallMessagePartProps<{ step: AnswerStreamStep }>) {
  const loops = loopsCopy[useApp().language];
  const step = args.step;
  return (
    <div
      data-testid="live-step"
      data-status={step.status}
      className="flex items-center gap-1.5 text-xs text-muted-foreground data-[status=running]:text-foreground"
    >
      {step.status === "running" ? (
        <Spinner data-icon="inline-start" />
      ) : step.status === "failed" || step.status === "cancelled" ? (
        <CircleAlert aria-hidden="true" className="size-3" />
      ) : (
        <Check aria-hidden="true" className="size-3" />
      )}
      <span>{liveStepText(step, loops)}</span>
    </div>
  );
}

function ApprovalPart({
  args,
}: ToolCallMessagePartProps<{ result: ServiceResult }>) {
  const chat = useNextChat();
  return (
    <ServiceActionView
      result={args.result}
      disabled={chat.busy || !chat.online || chat.readOnly}
      rememberTarget={chat.rememberTarget}
      onDecide={(approved) => chat.decide(args.result.operationId, approved)}
    />
  );
}

function OpenUiPart({
  args,
}: ToolCallMessagePartProps<{ program: string; streaming?: boolean }>) {
  const chat = useNextChat();
  return (
    <GeneratedUi
      program={args.program}
      streaming={!!args.streaming}
      disabled={chat.readOnly || !!args.streaming}
      onFollowUp={chat.followUp}
    />
  );
}

function WorkPart({ args }: ToolCallMessagePartProps<{ workId: string }>) {
  const chat = useNextChat();
  const work = chat.work(args.workId);
  if (!work) return null;
  return <NextWorkCard work={work} />;
}

/** The assistant's own work as the classic card, with the chat's commands. */
export function NextWorkCard({ work }: { work: WorkItem }) {
  const chat = useNextChat();
  const { language } = useChatCopy();
  const question = work.native?.question;
  return (
    <WorkCard
      key={`${work.id}:${language}`}
      session={chat.session}
      state={chat.state}
      work={work}
      conversationId={chat.conversationId}
      stale={chat.stale}
      blocked={chat.busy}
      onReply={
        question ||
        chat.state.store?.inputRequests[work.inputRequestIds[0] ?? ""]
          ? () => chat.replyToWork(work)
          : undefined
      }
      onAnswerQuestion={
        question?.options
          ? (answer) => chat.answerQuestion(question, answer)
          : undefined
      }
      questionShortcuts={work.id === chat.shortcutQuestion && !chat.readOnly}
    />
  );
}

function SigninPart({
  args,
}: ToolCallMessagePartProps<{ result: ConnectionResult }>) {
  const chat = useNextChat();
  return (
    <ServiceConnectionView
      session={chat.session}
      result={args.result}
      disabled={chat.busy || !chat.online || chat.readOnly}
      online={chat.online}
      onContinue={chat.continueWith}
    />
  );
}

function OfferPart({
  args,
}: ToolCallMessagePartProps<{
  offer: ProcessOfferResult;
  requestText: string;
}>) {
  const chat = useNextChat();
  const last = useAuiState((s) => s.message.isLast);
  return (
    <ProcessOfferView
      offer={args.offer}
      disabled={chat.busy || !chat.online || !last || chat.readOnly}
      onReview={() => chat.reviewOffer(args.offer)}
      onDecline={() => chat.declineOffer(args.requestText)}
    />
  );
}

function SkillPart({
  args,
}: ToolCallMessagePartProps<{ proposal: SkillProposalResult }>) {
  const chat = useNextChat();
  return (
    <SkillProposalView
      session={chat.session}
      proposal={args.proposal}
      disabled={!chat.online || chat.readOnly}
    />
  );
}

function ProposalPart({
  args,
}: ToolCallMessagePartProps<{ proposal: ProcessProposalResult }>) {
  const chat = useNextChat();
  return (
    <ProcessProposalView
      session={chat.session}
      proposal={args.proposal}
      disabled={!chat.online || chat.readOnly}
    />
  );
}

function ContactsPart({
  args,
}: ToolCallMessagePartProps<Pick<CrmContactResult, "contacts" | "hasMore">>) {
  return <ContactList contacts={args.contacts} hasMore={args.hasMore} />;
}

function DocumentPart({
  args,
}: ToolCallMessagePartProps<{ document: CardDocument }>) {
  return (
    <p className="break-words whitespace-pre-wrap">
      {cardDocumentText(args.document)}
    </p>
  );
}

/** Consecutive system parts stack like the classic answer's views. */
function ToolGroup({ children }: PropsWithChildren) {
  return <div className="flex min-w-0 flex-col gap-3">{children}</div>;
}

const toolUis = {
  [TOOL.step]: StepPart,
  [TOOL.approval]: ApprovalPart,
  [TOOL.openui]: OpenUiPart,
  [TOOL.work]: WorkPart,
  [TOOL.signin]: SigninPart,
  [TOOL.offer]: OfferPart,
  [TOOL.skill]: SkillPart,
  [TOOL.proposal]: ProposalPart,
  [TOOL.contacts]: ContactsPart,
  [TOOL.document]: DocumentPart,
};
/** Reasoning is never shown; only what the answer says and does. */
const Hidden = () => null;
export const assistantParts = {
  Text: AssistantText,
  Reasoning: Hidden,
  ToolGroup,
  tools: { by_name: toolUis },
} satisfies MessagePrimitive.Parts.Props["components"];
export const userParts = {
  Text: UserText,
} satisfies MessagePrimitive.Parts.Props["components"];

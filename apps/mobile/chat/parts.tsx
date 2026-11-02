import React, { createContext, useContext } from "react";
import { Linking, View } from "react-native";
import type { ClientSession } from "../../../packages/client-core/session";
import type { Language, WorkItem } from "../../../packages/protocol";
import type { ProcessOfferResult } from "../../../packages/protocol/process-offer";
import { processProposalWebUrl } from "../../../packages/protocol/process-proposal";
import { cardDocumentText } from "../../../packages/protocol/card-document";
import { translate } from "../../../packages/i18n";
import { tokens as t } from "../../../packages/design-tokens";
import { Button, Icon, Row, Text } from "../../../packages/ui";
import { MarkdownText } from "../../../packages/ui-catalog/MarkdownText";
import { GenerativeUiView } from "../../../packages/ui-catalog/GenerativeUiView";
import { ProcessOfferCard } from "../../../packages/ui-catalog/ProcessOfferCard";
import { ServiceActionCard } from "../../../packages/ui-catalog/ServiceActionCard";
import { CrmContactResults } from "../../../packages/ui-catalog/CrmContactCard";
import { splitDraft } from "../../../packages/openui-library/program";
import { chrome as styles, AssistantMessage } from "../ScreenChrome";
import { ServiceConnection } from "../ServiceConnection";
import { MobileMessageAttachments } from "../AttachmentControls";
import type { ChatMessage, ThreadEntry, ThreadPart } from "./thread";

/**
 * What the parts need from the chat: the session, its state and the
 * commands the workspace sends. The workspace owns the commands; each part
 * only renders one kind of message.
 */
export type MobileChat = {
  session: ClientSession | null;
  language: Language;
  busy: boolean;
  online: boolean;
  /** An archived chat: shown, never acted on. */
  readOnly: boolean;
  /** A generated answer's follow-up goes to the composer, never sent. */
  followUp: (text: string) => void;
  /** A sign-in card's "Continue": the message that goes on. */
  continueWith: (text: string) => void;
  reviewOffer: (offer: ProcessOfferResult) => void;
  /** Declining an offer sends the request again, without a process. */
  declineOffer: (requestText: string) => void;
  /** A message with files back in the composer (`send`: and sent again). */
  reuseAttachments: (message: ChatMessage, send: boolean) => void;
  decide: (operationId: string, approved: boolean) => void;
  renderWork: (work: WorkItem) => React.ReactNode;
  work: (id: string) => WorkItem | undefined;
  /** Scrolls to a work card opened from Tasks once it is laid out. */
  locateWork: (id: string, y: number) => void;
};
const MobileChatContext = createContext<MobileChat | null>(null);
export const MobileChatProvider = MobileChatContext.Provider;
export function useMobileChat() {
  const chat = useContext(MobileChatContext);
  if (!chat) throw new Error("MobileChatProvider is missing");
  return chat;
}

type PartProps = { entry: ThreadEntry };

/** An answer's text, then its generated UI; system cards follow it. */
export function AnswerBody({
  message: m,
  text = true,
}: {
  message: ChatMessage;
  text?: boolean;
}) {
  const chat = useMobileChat();
  return (
    <>
      {text && m.text ? (
        <View style={styles.answer}>
          <MarkdownText text={m.text} />
        </View>
      ) : null}
      {m.role === "assistant" && m.ui ? (
        <GenerativeUiView
          program={m.ui.program}
          language={chat.language}
          disabled={chat.readOnly}
          onFollowUp={chat.followUp}
        />
      ) : null}
    </>
  );
}

function UserPart({ entry: { message: m } }: PartProps) {
  const chat = useMobileChat();
  const tr = translate(chat.language);
  const editable = !chat.readOnly && !chat.busy && chat.online;
  return (
    <View
      style={[styles.message, m.attachments?.length ? { width: "85%" } : null]}
    >
      {m.humanTask ? (
        <Row
          accessible
          accessibilityLabel={`${tr("humanTaskAttached")}: ${m.humanTask.title}`}
          style={{ gap: 6 }}
        >
          <Icon name="tasks" size={14} color={t.color.text.secondary} />
          <Text
            role="caption"
            tone="secondary"
            numberOfLines={1}
            style={{ flexShrink: 1 }}
          >
            {m.humanTask.title}
          </Text>
        </Row>
      ) : null}
      {m.text ? <Text selectable>{m.text}</Text> : null}
      {chat.session && m.attachments?.length ? (
        <MobileMessageAttachments
          session={chat.session}
          language={chat.language}
          files={m.attachments}
          processing={m.processing}
          onEdit={editable ? () => chat.reuseAttachments(m, false) : undefined}
          onAgain={editable ? () => chat.reuseAttachments(m, true) : undefined}
        />
      ) : null}
    </View>
  );
}

function ConnectionPart({ entry: { message: m } }: PartProps) {
  const chat = useMobileChat();
  if (m.result?.type !== "service.connection") return null;
  return (
    <AssistantMessage>
      <AnswerBody message={m} />
      {chat.session ? (
        <ServiceConnection
          key={`${chat.session.identityKey}:${m.result.serviceId}:${m.id}`}
          session={chat.session}
          result={m.result}
          language={chat.language}
          disabled={chat.busy || !chat.online}
          online={chat.online}
          onContinue={chat.continueWith}
        />
      ) : null}
    </AssistantMessage>
  );
}

function OfferPart({ entry: { message: m, request, current } }: PartProps) {
  const chat = useMobileChat();
  if (m.result?.type !== "process.offer") return null;
  const offer = m.result;
  return (
    <AssistantMessage>
      <AnswerBody message={m} />
      <ProcessOfferCard
        offer={offer}
        language={chat.language}
        disabled={chat.busy || !chat.online || !current || chat.readOnly}
        onReview={() => chat.reviewOffer(offer)}
        onDecline={() => request?.text && chat.declineOffer(request.text)}
      />
    </AssistantMessage>
  );
}

/** A process drafted in chat is reviewed and saved in the web app. */
function ProposalPart({ entry: { message: m } }: PartProps) {
  const chat = useMobileChat();
  if (m.result?.type !== "process.proposal") return null;
  const tr = translate(chat.language);
  const web = chat.session
    ? processProposalWebUrl(chat.session.address, m.result)
    : null;
  return (
    <AssistantMessage>
      <AnswerBody message={m} />
      <Text role="caption" tone="secondary">
        {`${tr("processProposalTitle")}: ${m.result.name}`}
      </Text>
      {web ? (
        <Button
          label={tr("processProposalOpenWeb")}
          variant="secondary"
          size="small"
          onPress={() => void Linking.openURL(web).catch(() => {})}
        />
      ) : null}
    </AssistantMessage>
  );
}

/** A skill drafted in chat is saved in the web app; here it is only named. */
function SkillPart({ entry: { message: m } }: PartProps) {
  const chat = useMobileChat();
  if (m.result?.type !== "skill.proposal") return null;
  const tr = translate(chat.language);
  return (
    <AssistantMessage>
      <AnswerBody message={m} />
      <Text role="caption" tone="secondary">
        {`${tr("skillProposalTitle")}: ${m.result.name}. ${tr("skillProposalMobile")}`}
      </Text>
    </AssistantMessage>
  );
}

/** Answers no longer compose cards; a stored one reads as its text. */
function DocumentPart({ entry: { message: m } }: PartProps) {
  if (m.result?.type !== "card.document") return null;
  return (
    <AssistantMessage>
      <AnswerBody message={m} />
      <Text selectable>{cardDocumentText(m.result.document)}</Text>
    </AssistantMessage>
  );
}

/** A write waiting for the person's decision. */
function ApprovalPart({ entry: { message: m } }: PartProps) {
  const chat = useMobileChat();
  if (m.result?.type !== "service.action") return null;
  const result = m.result;
  return (
    <AssistantMessage>
      <AnswerBody message={m} />
      <ServiceActionCard
        result={result}
        language={chat.language}
        disabled={chat.busy || !chat.online || chat.readOnly}
        onDecide={(approved) => chat.decide(result.operationId, approved)}
      />
    </AssistantMessage>
  );
}

function ContactsPart({ entry: { message: m } }: PartProps) {
  const chat = useMobileChat();
  if (m.result?.type !== "crm.contacts") return null;
  return (
    <AssistantMessage>
      <AnswerBody message={m} text={false} />
      <CrmContactResults result={m.result} language={chat.language} />
    </AssistantMessage>
  );
}

/** The message that anchors a work card shows the card in its place. */
function WorkPart({ entry: { message: m } }: PartProps) {
  const chat = useMobileChat();
  const work = m.workItemId ? chat.work(m.workItemId) : undefined;
  if (!work) return null;
  return (
    <View onLayout={(e) => chat.locateWork(work.id, e.nativeEvent.layout.y)}>
      <AssistantMessage>
        <AnswerBody message={m} text={false} />
        {chat.renderWork(work)}
      </AssistantMessage>
    </View>
  );
}

function AnswerPart({ entry: { message: m } }: PartProps) {
  return (
    <AssistantMessage>
      <AnswerBody message={m} />
    </AssistantMessage>
  );
}

const Hidden = () => null;

/** One view per part; a new kind of message is added here once. */
export const threadParts: Record<ThreadPart, React.ComponentType<PartProps>> = {
  hidden: Hidden,
  user: UserPart,
  connection: ConnectionPart,
  offer: OfferPart,
  proposal: ProposalPart,
  skill: SkillPart,
  document: DocumentPart,
  answer: AnswerPart,
  approval: ApprovalPart,
  contacts: ContactsPart,
  work: WorkPart,
};

export function ThreadMessage({ entry }: PartProps) {
  const Part = threadParts[entry.part];
  return <Part entry={entry} />;
}

/**
 * The answer while it is written. It is not the answer yet: the stored
 * message replaces it, and nothing in it can be acted on.
 */
export function AnswerDraft({
  draft,
  language,
}: {
  draft: string;
  language: Language;
}) {
  const { text, program } = splitDraft(draft);
  return (
    <View testID="answer-draft">
      {text ? (
        <View style={styles.answer}>
          <MarkdownText text={text} />
        </View>
      ) : null}
      {program ? (
        <GenerativeUiView
          program={program}
          streaming
          disabled
          language={language}
          onFollowUp={noFollowUp}
        />
      ) : null}
    </View>
  );
}
const noFollowUp = () => {};

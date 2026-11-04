import React, { createContext, useContext, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { ClientSession } from "../../../packages/client-core/session";
import type { Language, WorkItem } from "../../../packages/protocol";
import type { ProcessOfferResult } from "../../../packages/protocol/process-offer";
import { cardDocumentText } from "../../../packages/protocol/card-document";
import { translate } from "../../../packages/i18n";
import {
  dayLabel,
  messageMoment,
  messageTime,
} from "../../../packages/client-core/chat-days";
import { tokens as t } from "../../../packages/design-tokens";
import { Icon, Row, Text, type IconName } from "../../../packages/ui";
import { MarkdownText } from "../../../packages/ui-catalog/MarkdownText";
import { GenerativeUiView } from "../../../packages/ui-catalog/GenerativeUiView";
import { ProcessOfferCard } from "../../../packages/ui-catalog/ProcessOfferCard";
import { ServiceActionCard } from "../../../packages/ui-catalog/ServiceActionCard";
import { CrmContactResults } from "../../../packages/ui-catalog/CrmContactCard";
import { splitDraft } from "../../../packages/openui-library/program";
import { chrome as styles, AssistantMessage } from "../ScreenChrome";
import { ServiceConnection } from "../ServiceConnection";
import { MobileMessageAttachments } from "../AttachmentControls";
import { copyText } from "../clipboard";
import { ProcessProposalCard } from "../ProcessProposal";
import type { ChatMessage, ThreadEntry, ThreadPart } from "./thread";
import { MemorySaveLines, type ChatMemorySaves } from "./memory-saves";

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
  /** **Edit**: the request back in the composer; nothing is sent. */
  edit: (message: ChatMessage) => void;
  /** **Again**: the request sent once more as a new message. */
  again: (request: ChatMessage) => void;
  /** Files wait in the composer; Again would take them along. */
  againBlocked: boolean;
  /** The message a search opened, outlined for a moment. */
  highlight?: string;
  /** Scrolls to the message a search opened once it is laid out. */
  locateMessage: (id: string, y: number) => void;
  /** This chat's saves to memory, shown under the replies that made them. */
  memorySaves?: ChatMemorySaves;
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

      {m.role === "assistant" ? (
        <MemorySaveLines
          saves={chat.memorySaves}
          commandId={m.replyToCommandId}
          language={chat.language}
          disabled={chat.readOnly || !chat.online}
        />
      ) : null}
    </>
  );
}

function UserPart({ entry }: PartProps) {
  const m = entry.message;
  const chat = useMobileChat();
  const tr = translate(chat.language);
  const editable = !chat.readOnly && !chat.busy && chat.online;
  return (
    <View style={{ gap: 2 }}>
      <View
        style={[
          styles.message,
          m.attachments?.length ? { width: "85%" } : null,
        ]}
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
            onEdit={
              editable ? () => chat.reuseAttachments(m, false) : undefined
            }
            onAgain={
              editable ? () => chat.reuseAttachments(m, true) : undefined
            }
          />
        ) : null}
      </View>
      <MessageMeta entry={entry} align="end" />
    </View>
  );
}

function ConnectionPart({ entry }: PartProps) {
  const m = entry.message;
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
      <MessageMeta entry={entry} align="start" />
    </AssistantMessage>
  );
}

function OfferPart({ entry }: PartProps) {
  const { message: m, request, current } = entry;
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
      <MessageMeta entry={entry} align="start" />
    </AssistantMessage>
  );
}

/** A process drafted in chat: saved and turned on here, edited on the web. */
function ProposalPart({ entry }: PartProps) {
  const m = entry.message;
  const chat = useMobileChat();
  if (m.result?.type !== "process.proposal") return null;
  return (
    <AssistantMessage>
      <AnswerBody message={m} />
      {chat.session ? (
        <ProcessProposalCard
          session={chat.session}
          language={chat.language}
          proposal={m.result}
          disabled={chat.busy || !chat.online || chat.readOnly}
          online={chat.online}
        />
      ) : null}
      <MessageMeta entry={entry} align="start" />
    </AssistantMessage>
  );
}

/** A skill drafted in chat is saved in the web app; here it is only named. */
function SkillPart({ entry }: PartProps) {
  const m = entry.message;
  const chat = useMobileChat();
  if (m.result?.type !== "skill.proposal") return null;
  const tr = translate(chat.language);
  return (
    <AssistantMessage>
      <AnswerBody message={m} />
      <Text role="caption" tone="secondary">
        {`${tr("skillProposalTitle")}: ${m.result.name}. ${tr("skillProposalMobile")}`}
      </Text>
      <MessageMeta entry={entry} align="start" />
    </AssistantMessage>
  );
}

/** Answers no longer compose cards; a stored one reads as its text. */
function DocumentPart({ entry }: PartProps) {
  const m = entry.message;
  if (m.result?.type !== "card.document") return null;
  return (
    <AssistantMessage>
      <AnswerBody message={m} />
      <Text selectable>{cardDocumentText(m.result.document)}</Text>
      <MessageMeta entry={entry} align="start" />
    </AssistantMessage>
  );
}

/** A write waiting for the person's decision. */
function ApprovalPart({ entry }: PartProps) {
  const m = entry.message;
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
      <MessageMeta entry={entry} align="start" />
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
    <AssistantMessage>
      <AnswerBody message={m} text={false} />
      {chat.renderWork(work)}
    </AssistantMessage>
  );
}

function AnswerPart({ entry }: PartProps) {
  const m = entry.message;
  return (
    <AssistantMessage>
      <AnswerBody message={m} />
      <MessageMeta entry={entry} align="start" />
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

/**
 * One stored message: the day it starts, then its part. The wrapper reports
 * where the message is, for a search jump and for work opened from Tasks.
 */
export function ThreadMessage({ entry }: PartProps) {
  const chat = useMobileChat();
  if (entry.part === "hidden") return null;
  const Part = threadParts[entry.part];
  const m = entry.message;
  const highlighted = chat.highlight === m.id;
  return (
    <>
      {entry.day !== undefined ? <DaySeparator day={entry.day} /> : null}
      <View
        testID={highlighted ? "message-highlight" : undefined}
        onLayout={(e) => {
          const y = e.nativeEvent.layout.y;
          chat.locateMessage(m.id, y);
          if (entry.part === "work" && m.workItemId)
            chat.locateWork(m.workItemId, y);
        }}
      >
        <Part entry={entry} />
        {highlighted ? (
          <View pointerEvents="none" style={meta.highlight} />
        ) : null}
      </View>
    </>
  );
}

/** A quiet divider where a new calendar day starts. */
function DaySeparator({ day }: { day: number }) {
  const chat = useMobileChat();
  const tr = translate(chat.language);
  const label = dayLabel(day, chat.language, {
    today: tr("chatsToday"),
    yesterday: tr("chatsYesterday"),
  });
  return (
    <Row
      testID="day-separator"
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={{ gap: 12 }}
    >
      <View style={meta.rule} />
      <Text role="meta" tone="secondary">
        {label}
      </Text>
      <View style={meta.rule} />
    </Row>
  );
}

function MetaAction({
  icon,
  label,
  disabled = false,
  onPress,
}: {
  icon: IconName;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        meta.action,
        pressed && { backgroundColor: t.color.pressed },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Icon name={icon} size={18} color={t.color.text.secondary} />
    </Pressable>
  );
}

/**
 * Quiet actions under a message, always visible on a touch screen: the time,
 * Copy (the message as written, an answer's Markdown too), Edit on the latest
 * request and Again on the latest answer. History never changes.
 */
function MessageMeta({
  entry,
  align,
}: {
  entry: ThreadEntry;
  align: "start" | "end";
}) {
  const chat = useMobileChat();
  const tr = translate(chat.language);
  const m = entry.message;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const text = m.text.trim() ? m.text : "";
  // A request with files offers Edit and Again on its files already.
  const edit = entry.editable && m.role === "user" && !m.attachments?.length;
  const again = entry.again;
  const disabled = chat.busy || !chat.online || chat.readOnly;
  if (!text && !m.createdAt) return null;
  return (
    <Row
      testID="message-meta"
      style={[
        { gap: 2 },
        align === "end"
          ? { alignSelf: "flex-end" }
          : { alignSelf: "flex-start" },
      ]}
    >
      {m.createdAt ? (
        <Text
          role="meta"
          tone="secondary"
          accessibilityLabel={messageMoment(m.createdAt, chat.language)}
          style={meta.time}
        >
          {messageTime(m.createdAt, chat.language)}
        </Text>
      ) : null}
      {text ? (
        <MetaAction
          icon={copied ? "check" : "copy"}
          label={tr(copied ? "messageCopied" : "messageCopy")}
          onPress={() =>
            void copyText(text).then((done) => {
              if (done) setCopied(true);
            })
          }
        />
      ) : null}
      {edit ? (
        <MetaAction
          icon="edit"
          label={tr("messageEdit")}
          disabled={disabled}
          onPress={() => chat.edit(m)}
        />
      ) : null}
      {again ? (
        <MetaAction
          icon="refresh"
          label={tr("messageAgain")}
          disabled={disabled || chat.againBlocked}
          onPress={() => chat.again(again)}
        />
      ) : null}
    </Row>
  );
}
const meta = StyleSheet.create({
  action: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  time: { paddingHorizontal: 4, fontVariant: ["tabular-nums"] },
  rule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: t.color.hairline,
  },
  // A search hit is outlined for a moment, without moving anything.
  highlight: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    margin: -6,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: t.color.action.link,
    opacity: 0.5,
  },
});

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

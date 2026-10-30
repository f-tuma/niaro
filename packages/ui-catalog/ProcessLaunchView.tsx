import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Language } from "../protocol";
import type {
  ProcessExecutionEntry,
  ProcessInputCard,
} from "../protocol/process-execution";
import type { MeetingRecord } from "../protocol/meeting-record";
import type { MeetingProcessSource } from "../protocol/process-start";
import { translate, type TranslationKey } from "../i18n";
import { tokens as t } from "../design-tokens";
import {
  Button,
  Disclosure,
  Group,
  Icon,
  IconTile,
  ListBlock,
  ListRow,
  Notice,
  Row,
  SectionLabel,
  StatusPill,
  Surface,
  Text,
  ui,
} from "../ui";
import { ProcessInputCardView } from "./ProcessInputCardView";
import type { ProcessFormInput } from "./process-input-form";
import { meetingProcessSourceOptions } from "../protocol/meeting-process-input";
import { FieldRows } from "./FieldRows";
import { displayFields } from "./field-format";

export type ProcessLaunchViewProps = {
  language: Language;
  entries: readonly ProcessExecutionEntry[] | null;
  selected: ProcessExecutionEntry | null;
  sourceBindings?: Partial<Record<string, MeetingProcessSource>>;
  selectedTaskId?: string;
  meetingRecord?: MeetingRecord;
  loading: boolean;
  phase:
    | "selection"
    | "preparing"
    | "editing"
    | "review"
    | "sending"
    | "accepted"
    | "rejected";
  card: ProcessInputCard | null;
  reviewedInput: ProcessFormInput | null;
  error?: TranslationKey | null;
  notice?: TranslationKey | null;
  disabled: boolean;
  /** Hidden where the surrounding screen already names Processes. */
  showTitle?: boolean;
  onLoad: () => void;
  onSelect: (entry: ProcessExecutionEntry) => void;
  onSourceBinding?: (
    field: string,
    source: MeetingProcessSource | null,
  ) => void;
  onPrepare: () => void;
  onReview: (input: ProcessFormInput) => void;
  onEdit: () => void;
  onStart: () => void;
  /** Leaves the launcher after a start, where the run continues in chat. */
  onDone?: () => void;
  recovery?: {
    name: string;
    version: number;
    kind?: "agent" | "workflow";
    conversationId: string;
    language: Language;
    input: unknown;
    outcome: "unknown" | "accepted" | "rejected";
    sending: boolean;
    error: TranslationKey | null;
    canRetry: boolean;
    onRetry: () => void;
  };
};

const blockedReasons: Record<
  Extract<ProcessExecutionEntry, { availability: "blocked" }>["reason"],
  TranslationKey
> = {
  service_unavailable: "process_service_unavailable",
  model_unavailable: "process_model_unavailable",
  source_changed: "process_source_changed",
  connection_required: "process_connection_required",
  qualification_required: "process_qualification_required",
  budget_unavailable: "process_budget_unavailable",
};

/** Top-level inputs as label-value rows; the exact JSON stays in Details. */
function inputFields(input: unknown, language: Language) {
  const text = (value: unknown) =>
    typeof value === "string" ? value : JSON.stringify(value);
  const pairs =
    input && typeof input === "object" && !Array.isArray(input)
      ? Object.entries(input).map(([label, value]) => ({
          label,
          value: text(value),
        }))
      : [{ label: translate(language)("processesInputs"), value: text(input) }];
  return displayFields(pairs, language);
}

/** Presentation and local draft editing only; commands belong to the adapter. */
export function ProcessLaunchView(props: ProcessLaunchViewProps) {
  const tr = translate(props.language);
  const selecting = props.phase === "selection" || props.phase === "preparing";
  const editing = props.phase === "editing";
  const preparing = props.phase === "preparing";
  const input = props.reviewedInput;
  const card = props.card;
  const inactive = props.disabled || props.loading || preparing;
  const reviewVisible =
    !props.recovery &&
    card !== null &&
    !editing &&
    !selecting &&
    input !== null;
  // Inside a meeting the surrounding "Continue with a process" names the list.
  const listTitle = props.meetingRecord ? undefined : tr("processesTitle");
  const refresh = (
    <Button
      variant="quiet"
      size="small"
      label={tr(props.loading ? "processesLoading" : "refresh")}
      disabled={inactive}
      style={styles.refresh}
      onPress={() => {
        if (!inactive) props.onLoad();
      }}
    />
  );
  const status =
    props.phase === "sending"
      ? "processesSending"
      : props.phase === "accepted"
        ? "processesAccepted"
        : props.phase === "rejected"
          ? "processesRejected"
          : null;

  return (
    <View style={styles.stack} testID="process-launch-view">
      {props.showTitle !== false ? (
        <Text role="sheetTitle" accessibilityRole="header">
          {tr("processesTitle")}
        </Text>
      ) : null}
      {props.error ? <Notice error>{tr(props.error)}</Notice> : null}
      {props.notice ? <Notice>{tr(props.notice)}</Notice> : null}
      {props.recovery ? (
        <RecoveryView language={props.language} recovery={props.recovery} />
      ) : null}
      {selecting ? (
        <View style={styles.stack}>
          {props.entries === null ? (
            // Reading the server's processes stays an explicit choice.
            <Group title={listTitle}>
              <ListRow
                icon="refresh"
                label={tr(props.loading ? "processesLoading" : "processesLoad")}
                disabled={inactive}
                chevron={false}
                onPress={() => {
                  if (!inactive) props.onLoad();
                }}
              />
            </Group>
          ) : (
            <View style={styles.group}>
              {/* Embedded (meeting) lists reload by closing and reopening. */}
              {listTitle ? (
                <SectionLabel trailing={refresh}>{listTitle}</SectionLabel>
              ) : null}
              {props.entries.length === 0 ? (
                <View style={ui.group}>
                  <ListBlock>
                    <Text tone="secondary">{tr("processesEmpty")}</Text>
                  </ListBlock>
                </View>
              ) : (
                <View
                  style={ui.group}
                  accessibilityRole="radiogroup"
                  accessibilityLabel={tr("processesSelect")}
                >
                  {props.entries.map((entry, index) => (
                    <ProcessRow
                      key={entry.processId}
                      entry={entry}
                      first={index === 0}
                      language={props.language}
                      checked={
                        props.selected?.processId === entry.processId &&
                        props.selected.version === entry.version &&
                        props.selected.artifactDigest === entry.artifactDigest
                      }
                      disabled={props.disabled || props.loading}
                      onSelect={props.onSelect}
                    />
                  ))}
                </View>
              )}
            </View>
          )}
          {props.selected ? (
            <>
              {props.meetingRecord &&
              props.selected.availability === "ready" ? (
                <MeetingSourceMapping
                  language={props.language}
                  record={props.meetingRecord}
                  schema={props.selected.inputSchema}
                  selectedTaskId={props.selectedTaskId}
                  bindings={props.sourceBindings ?? {}}
                  disabled={inactive}
                  onSelect={props.onSourceBinding}
                />
              ) : null}
              <Button
                label={tr(
                  preparing ? "processesPreparing" : "processesPrepare",
                )}
                loading={preparing}
                disabled={inactive || props.selected.availability !== "ready"}
                onPress={() => {
                  if (!inactive && props.selected?.availability === "ready")
                    props.onPrepare();
                }}
              />
            </>
          ) : null}
        </View>
      ) : null}
      {card ? (
        <View
          testID="process-launch-editor"
          style={!editing ? styles.hidden : undefined}
          importantForAccessibility={editing ? "auto" : "no-hide-descendants"}
          accessibilityElementsHidden={!editing}
        >
          <ProcessInputCardView
            card={card}
            language={card.form.language}
            initialInput={props.reviewedInput ?? undefined}
            disabled={props.disabled || !editing}
            onSubmit={(value) => {
              if (editing && !props.disabled) props.onReview(value);
            }}
          />
        </View>
      ) : null}
      {reviewVisible ? (
        <View style={styles.stack} testID="process-launch-review">
          <View style={styles.heading}>
            <Text role="sheetTitle" accessibilityRole="header" selectable>
              {card.form.name}
            </Text>
            <Text tone="secondary">{tr("processesReviewHint")}</Text>
          </View>
          <View style={[ui.group, styles.fields]}>
            <FieldRows fields={inputFields(input, props.language)} />
          </View>
          <Disclosure label={tr("processesDetails")}>
            <ProcessContext
              uiLanguage={props.language}
              version={card.form.version}
              kind={card.form.kind}
              conversationId={card.form.origin.conversationId}
              language={card.form.language}
              meetingRecord={props.meetingRecord}
              selectedTaskId={props.selectedTaskId}
              sourceBindings={
                card.form.origin.type === "meeting"
                  ? card.form.origin.sourceBindings
                  : undefined
              }
            />
            <Text selectable style={styles.json} testID="process-launch-input">
              {JSON.stringify(input, null, 2)}
            </Text>
          </Disclosure>
          {status ? (
            <Notice
              error={props.phase === "rejected"}
              icon={props.phase === "accepted" ? "check" : undefined}
            >
              {tr(status)}
            </Notice>
          ) : null}
          {props.phase === "review" ? (
            <Button
              label={tr("processesStart")}
              disabled={props.disabled}
              onPress={() => {
                if (!props.disabled) props.onStart();
              }}
            />
          ) : null}
          {props.phase === "accepted" && props.onDone ? (
            <Button label={tr("processesBackToChat")} onPress={props.onDone} />
          ) : null}
          {props.phase === "review" || props.phase === "rejected" ? (
            <Button
              variant={props.phase === "review" ? "quiet" : "secondary"}
              label={tr("processesEdit")}
              disabled={props.disabled}
              onPress={() => {
                if (!props.disabled) props.onEdit();
              }}
            />
          ) : null}
        </View>
      ) : status && !props.recovery ? (
        <Notice error={props.phase === "rejected"}>{tr(status)}</Notice>
      ) : null}
      {!props.recovery &&
      (props.phase === "editing" ||
        props.phase === "review" ||
        props.phase === "accepted" ||
        props.phase === "rejected") ? (
        <Button
          variant="quiet"
          label={tr("processesChooseAnother")}
          disabled={props.disabled}
          onPress={() => {
            if (!props.disabled) props.onLoad();
          }}
        />
      ) : null}
    </View>
  );
}

/** One selectable process: name, one line of description, a check when chosen. */
function ProcessRow({
  entry,
  first,
  language,
  checked,
  disabled: inactive,
  onSelect,
}: {
  entry: ProcessExecutionEntry;
  first: boolean;
  language: Language;
  checked: boolean;
  disabled: boolean;
  onSelect: (entry: ProcessExecutionEntry) => void;
}) {
  const tr = translate(language);
  const blocked = entry.availability === "blocked";
  const disabled = inactive || blocked;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${tr("processesSelect")}: ${entry.name}`}
      accessibilityState={{ checked, disabled }}
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => {
        if (!disabled) onSelect(entry);
      }}
      style={({ pressed }) => [
        ui.listRow,
        styles.processRow,
        {
          backgroundColor: pressed
            ? t.color.pressed
            : checked
              ? t.color.accent.softBlue
              : "transparent",
        },
      ]}
    >
      {first ? null : <View style={[ui.separator, { left: 68 }]} />}
      <View style={blocked ? styles.dimmed : undefined}>
        <IconTile
          icon={entry.kind === "agent" ? "sparkle" : "bolt"}
          tone={entry.kind === "agent" ? "violet" : "blue"}
          size={38}
        />
      </View>
      <View style={styles.flex}>
        <Text
          role="rowTitle"
          selectable
          numberOfLines={2}
          tone={blocked ? "secondary" : "primary"}
        >
          {entry.name}
        </Text>
        {entry.description ? (
          <Text role="meta" tone="secondary" numberOfLines={2} selectable>
            {entry.description}
          </Text>
        ) : null}
        {blocked ? (
          <Text role="meta" style={{ color: t.color.status.warning }}>
            {tr("processesBlocked")}: {tr(blockedReasons[entry.reason])}
          </Text>
        ) : null}
      </View>
      {checked ? (
        <Icon name="check" size={20} color={t.color.action.link} />
      ) : null}
    </Pressable>
  );
}

function MeetingSourceMapping({
  language,
  record,
  schema,
  selectedTaskId,
  bindings,
  disabled,
  onSelect,
}: {
  language: Language;
  record: MeetingRecord;
  schema: Extract<
    ProcessExecutionEntry,
    { availability: "ready" }
  >["inputSchema"];
  selectedTaskId?: string;
  bindings: Partial<Record<string, MeetingProcessSource>>;
  disabled: boolean;
  onSelect?: ProcessLaunchViewProps["onSourceBinding"];
}) {
  const tr = translate(language);
  const options = meetingProcessSourceOptions(record, schema, selectedTaskId);
  const labels: Record<MeetingProcessSource, TranslationKey> = {
    summary: "meetingProcessSourceSummary",
    points: "meetingProcessSourcePoints",
    tasks: "meetingProcessSourceTasks",
    selectedTask: "meetingProcessSourceSelectedTask",
    transcript: "meetingProcessSourceTranscript",
  };
  const fields = Object.entries(options);
  const transcriptAvailable = Object.values(options).some((sources) =>
    sources?.includes("transcript"),
  );
  return (
    <View style={styles.stack} testID="meeting-process-source-mapping">
      <View style={styles.heading}>
        <Text role="label" accessibilityRole="header">
          {tr("meetingProcessMapTitle")}
        </Text>
        <Text role="meta" tone="secondary">
          {tr("meetingProcessMapHint")}
        </Text>
      </View>
      {!transcriptAvailable ? (
        <View style={styles.tight}>
          <Notice>{tr("meetingProcessTranscriptLimitHint")}</Notice>
          <Text role="meta" tone="secondary">
            {tr("meetingProcessTranscriptLength")} {record.transcript.length}
          </Text>
        </View>
      ) : null}
      {!fields.length ? (
        <Notice>{tr("meetingProcessNoCompatibleSources")}</Notice>
      ) : null}
      {fields.map(([field, sources]) => (
        <View
          key={field}
          style={styles.tight}
          testID={`meeting-source-map-${field}`}
        >
          <Text role="meta" tone="secondary" selectable>
            {field}
          </Text>
          <Row style={styles.wrap}>
            {sources?.map((source) => (
              <Button
                key={source}
                size="small"
                variant={bindings[field] === source ? "primary" : "secondary"}
                label={tr(labels[source])}
                disabled={disabled}
                onPress={() => onSelect?.(field, source)}
              />
            ))}
            {bindings[field] ? (
              <Button
                size="small"
                variant="quiet"
                label={tr("meetingProcessSourceNone")}
                disabled={disabled}
                onPress={() => onSelect?.(field, null)}
              />
            ) : null}
          </Row>
        </View>
      ))}
    </View>
  );
}

/** Version, conversation and language behind Details; support needs them, people rarely do. */
function ProcessContext({
  uiLanguage,
  version,
  kind,
  conversationId,
  language,
  meetingRecord,
  selectedTaskId,
  sourceBindings,
}: {
  uiLanguage: Language;
  version: number;
  kind?: "agent" | "workflow";
  conversationId: string;
  language: Language;
  meetingRecord?: MeetingRecord;
  selectedTaskId?: string;
  sourceBindings?: Record<string, MeetingProcessSource>;
}) {
  const tr = translate(uiLanguage);
  const sourceLabels: Record<MeetingProcessSource, TranslationKey> = {
    summary: "meetingProcessSourceSummary",
    points: "meetingProcessSourcePoints",
    tasks: "meetingProcessSourceTasks",
    selectedTask: "meetingProcessSourceSelectedTask",
    transcript: "meetingProcessSourceTranscript",
  };
  return (
    <View style={styles.tight}>
      <Text role="meta" tone="secondary" selectable>
        {tr("processesVersion")}: {version}
        {kind
          ? ` · ${tr(kind === "agent" ? "processesAgent" : "processesWorkflow")}`
          : ""}
      </Text>
      {meetingRecord ? (
        <>
          <Text role="meta" tone="secondary" selectable>
            {tr("meetingProcessContext")}: {meetingRecord.meeting.title} ·{" "}
            {new Date(meetingRecord.meeting.recordedAt).toLocaleDateString(
              uiLanguage === "cs" ? "cs-CZ" : "en-US",
            )}
          </Text>
          {selectedTaskId ? (
            <Text role="meta" tone="secondary" selectable>
              {tr("meetingProcessSelectedTask")}:{" "}
              {meetingRecord.analysis?.tasks[
                meetingRecord.humanTaskIds.indexOf(selectedTaskId)
              ]?.text ?? selectedTaskId}
            </Text>
          ) : null}
          {sourceBindings
            ? Object.entries(sourceBindings).map(([field, source]) => (
                <Text key={field} role="meta" tone="secondary" selectable>
                  {field}: {tr(sourceLabels[source])}
                </Text>
              ))
            : null}
        </>
      ) : null}
      <Text role="meta" tone="secondary" selectable>
        {tr("language")}: {tr(language === "cs" ? "czech" : "english")}
      </Text>
      <Text role="meta" tone="secondary" selectable>
        {tr("processesConversation")}: {conversationId}
      </Text>
    </View>
  );
}

function RecoveryView({
  language,
  recovery,
}: {
  language: Language;
  recovery: NonNullable<ProcessLaunchViewProps["recovery"]>;
}) {
  const tr = translate(language);
  const tone =
    recovery.outcome === "rejected"
      ? "error"
      : recovery.outcome === "accepted"
        ? "success"
        : "warning";
  return (
    <Surface style={styles.stack} testID="process-launch-recovery">
      <View style={styles.heading}>
        <StatusPill
          tone={tone}
          label={tr(
            recovery.outcome === "unknown"
              ? "processUnknown"
              : recovery.outcome === "accepted"
                ? "processesAcceptedShort"
                : "processesRejectedShort",
          )}
        />
        <Text role="cardTitle" selectable>
          {recovery.name}
        </Text>
      </View>
      <Text tone="secondary">
        {tr(
          recovery.outcome === "unknown"
            ? "processesUnknown"
            : recovery.outcome === "accepted"
              ? "processesAccepted"
              : "processesRejected",
        )}
      </Text>
      {recovery.error ? <Notice error>{tr(recovery.error)}</Notice> : null}
      {recovery.outcome !== "unknown" &&
      !recovery.sending &&
      recovery.error !== "processesSavingFailed" ? (
        <Text role="meta" tone="secondary">
          {tr("processesSavingPending")}
        </Text>
      ) : null}
      <Disclosure label={tr("processesDetails")}>
        <ProcessContext
          uiLanguage={language}
          version={recovery.version}
          kind={recovery.kind}
          conversationId={recovery.conversationId}
          language={recovery.language}
        />
        <Text
          selectable
          style={styles.json}
          testID="process-launch-recovery-input"
        >
          {JSON.stringify(recovery.input, null, 2)}
        </Text>
      </Disclosure>
      <Button
        label={tr(
          recovery.sending
            ? "processesSending"
            : recovery.outcome === "unknown"
              ? "processesRetrySame"
              : "processesRetrySaving",
        )}
        loading={recovery.sending}
        disabled={!recovery.canRetry || recovery.sending}
        onPress={() => {
          if (recovery.canRetry && !recovery.sending) recovery.onRetry();
        }}
      />
    </Surface>
  );
}

const styles = StyleSheet.create({
  stack: { minWidth: 0, gap: t.spacing.md },
  tight: { minWidth: 0, gap: t.spacing.xs },
  heading: { minWidth: 0, gap: t.spacing.xs },
  group: { minWidth: 0, gap: t.spacing.sm },
  wrap: { flexWrap: "wrap", gap: t.spacing.sm },
  flex: { flex: 1, minWidth: 0, flexShrink: 1, gap: 2 },
  processRow: { minHeight: t.control.rowTall },
  dimmed: { opacity: 0.5 },
  refresh: { minHeight: 28, paddingHorizontal: 8, marginVertical: -6 },
  fields: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.xs },
  json: {
    minWidth: 0,
    flexShrink: 1,
    padding: t.spacing.md,
    borderRadius: t.radius.small,
    backgroundColor: t.color.fill,
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 17,
    color: t.color.text.secondary,
  },
  hidden: { display: "none" },
});

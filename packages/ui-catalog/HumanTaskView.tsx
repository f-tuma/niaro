import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Language } from "../protocol";
import {
  HumanTaskSchema,
  type HumanTask,
  type HumanTaskCommand,
} from "../protocol/human-tasks";
import { translate } from "../i18n";
import { tokens as t } from "../design-tokens";
import {
  Button,
  Group,
  Icon,
  ListRow,
  Row,
  StatusPill,
  Text,
  type IconName,
} from "../ui";

function StatusOf({
  task,
  pending,
  language,
}: {
  task: HumanTask;
  pending?: HumanTaskCommand["decision"];
  language: Language;
}) {
  const tr = translate(language);
  if (pending)
    return (
      <StatusPill compact tone="unknown" busy label={tr("humanTaskSaving")} />
    );
  if (task.status === "open") return null;
  return (
    <StatusPill
      compact
      tone={task.status === "done" ? "success" : "unknown"}
      icon={task.status === "done" ? "check" : "close"}
      label={tr(task.status === "done" ? "humanTaskDone" : "humanTaskRemoved")}
    />
  );
}
function closedByAgent(task: HumanTask, language: Language) {
  const tr = translate(language);
  const resolution = task.resolution;
  if (resolution?.by !== "agent") return null;
  return resolution.reason
    ? `${tr("humanTaskClosedByAgent")}: ${resolution.reason}`
    : tr("humanTaskClosedByAgent");
}

/**
 * One item still to be resolved, as a list row: title and one meta line.
 * Tapping it opens the task, where talking it through, marking it done or
 * removing it live.
 */
export function HumanTaskCard({
  task,
  language,
  disabled = false,
  pending,
  separator = false,
  onMore,
}: {
  task: HumanTask;
  language: Language;
  disabled?: boolean;
  /** The decision being saved for this item. */
  pending?: HumanTaskCommand["decision"];
  /** A hairline above the row, inset to the text (rows after the first). */
  separator?: boolean;
  /** Opens the task with its details and actions. */
  onMore?(): void;
}) {
  HumanTaskSchema.parse(task);
  const tr = translate(language);
  const origin = task.origin;
  const open = task.status === "open";
  const meta = [
    task.due,
    task.assignee,
    origin.kind === "meeting" ? origin.meetingTitle : tr("humanTaskFromAgent"),
  ]
    .filter(Boolean)
    .join(" · ");
  const agent = closedByAgent(task, language);
  const content = (
    <>
      {separator ? <View style={styles.separator} /> : null}
      <View
        style={[
          styles.well,
          !open && task.status === "done"
            ? { backgroundColor: t.color.statusSoft.success }
            : null,
        ]}
      >
        <Icon
          name={
            !open
              ? task.status === "done"
                ? "check"
                : "close"
              : origin.kind === "meeting"
                ? "waveform"
                : "chat"
          }
          size={18}
          color={
            task.status === "done"
              ? t.color.status.success
              : t.color.text.secondary
          }
        />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          role="rowTitle"
          numberOfLines={2}
          tone={open ? "primary" : "secondary"}
        >
          {task.title}
        </Text>
        <Text role="meta" tone="secondary" numberOfLines={1}>
          {meta}
        </Text>
        {agent ? (
          <Text role="meta" tone="secondary" numberOfLines={2}>
            {agent}
          </Text>
        ) : null}
      </View>
      {pending || !open ? (
        <View style={{ alignSelf: "center" }}>
          <StatusOf task={task} pending={pending} language={language} />
        </View>
      ) : null}
      {onMore ? (
        <Icon name="chevron" size={18} color={t.color.text.disabled} />
      ) : null}
    </>
  );
  if (!onMore)
    return (
      <View testID={`human-task-${task.id}`} style={styles.row}>
        {content}
      </View>
    );
  return (
    <View testID={`human-task-${task.id}`}>
      <Pressable
        testID={`human-task-more-${task.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${tr("humanTaskMore")}: ${task.title}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onMore}
        style={({ pressed }) => [
          styles.row,
          pressed && { backgroundColor: t.color.pressed },
          disabled && { opacity: 0.5 },
        ]}
      >
        {content}
      </Pressable>
    </View>
  );
}

function Fact({
  icon,
  label,
  value,
}: {
  icon: IconName;
  label: string;
  value: string;
}) {
  return (
    <ListRow
      icon={icon}
      label={label}
      value={value}
      accessibilityLabel={`${label}: ${value}`}
    />
  );
}
/** What the task is and where it came from: the body of the task sheet. */
export function HumanTaskDetail({
  task,
  language,
  pending,
  onOpenMeeting,
}: {
  task: HumanTask;
  language: Language;
  pending?: HumanTaskCommand["decision"];
  /** Opens the meeting this item came from. */
  onOpenMeeting?(meetingId: string): void;
}) {
  HumanTaskSchema.parse(task);
  const tr = translate(language);
  const origin = task.origin;
  const agent = closedByAgent(task, language);
  const quote = origin.kind === "meeting" ? origin.sources[0] : undefined;
  return (
    <View testID={`human-task-detail-${task.id}`} style={{ gap: t.spacing.lg }}>
      {pending || task.status !== "open" ? (
        <StatusOf task={task} pending={pending} language={language} />
      ) : null}
      {task.detail ? <Text selectable>{task.detail}</Text> : null}
      {agent ? (
        <Text role="caption" tone="secondary">
          {agent}
        </Text>
      ) : null}
      {quote ? (
        <View style={styles.quote}>
          <Text
            testID={`human-task-source-${task.id}`}
            tone="secondary"
            selectable
            accessibilityLabel={`${tr("humanTaskSource")}: ${quote.quote}`}
          >
            “{quote.quote}”
          </Text>
          {origin.kind === "meeting" && origin.sources.length > 1 ? (
            <Text role="meta" tone="secondary">
              {tr("humanTaskMoreSources")}
            </Text>
          ) : null}
        </View>
      ) : null}
      <Group>
        {origin.kind === "meeting" ? (
          <ListRow
            icon="waveform"
            label={origin.meetingTitle}
            accessibilityLabel={`${tr("humanTaskFromMeeting")}: ${origin.meetingTitle}`}
            onPress={
              onOpenMeeting ? () => onOpenMeeting(origin.meetingId) : undefined
            }
          />
        ) : (
          <ListRow icon="chat" label={tr("humanTaskFromAgent")} />
        )}
        {task.due ? (
          <Fact icon="clock" label={tr("humanTaskDue")} value={task.due} />
        ) : null}
        {task.assignee ? (
          <Fact
            icon="person"
            label={tr("humanTaskAssignee")}
            value={task.assignee}
          />
        ) : null}
      </Group>
    </View>
  );
}
/**
 * The task sheet's action area: talking it through is the one primary
 * action; done and remove sit under it (reopen for a closed task).
 */
export function HumanTaskActions({
  task,
  language,
  disabled = false,
  resolveDisabled = false,
  onResolve,
  onDecide,
}: {
  task: HumanTask;
  language: Language;
  disabled?: boolean;
  /** Only talking it through is unavailable right now. */
  resolveDisabled?: boolean;
  /** Opens a chat with this item attached. */
  onResolve?(): void;
  onDecide(decision: HumanTaskCommand["decision"]): void;
}) {
  const tr = translate(language);
  if (task.status !== "open")
    return (
      <Button
        variant="secondary"
        icon="refresh"
        label={tr("humanTaskReopen")}
        disabled={disabled}
        onPress={() => onDecide("reopen")}
      />
    );
  return (
    <View testID="human-task-menu" style={{ gap: t.spacing.sm }}>
      {onResolve ? (
        <Button
          icon="chat"
          label={tr("humanTaskResolve")}
          disabled={disabled || resolveDisabled}
          onPress={onResolve}
        />
      ) : null}
      <Row style={{ gap: t.spacing.sm }}>
        <Button
          variant="secondary"
          icon="check"
          label={tr("humanTaskComplete")}
          disabled={disabled}
          onPress={() => onDecide("complete")}
          style={{ flex: 1 }}
        />
        <Button
          variant="danger"
          icon="trash"
          label={tr("humanTaskRemove")}
          disabled={disabled}
          onPress={() => onDecide("remove")}
          style={{ flex: 1 }}
        />
      </Row>
    </View>
  );
}
const styles = StyleSheet.create({
  row: {
    minHeight: t.control.rowTall,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: t.spacing.md,
  },
  well: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.color.fill,
  },
  separator: {
    position: "absolute",
    top: 0,
    right: 0,
    left: t.spacing.lg + 36 + t.spacing.md,
    height: StyleSheet.hairlineWidth,
    backgroundColor: t.color.border,
    pointerEvents: "none",
  },
  quote: {
    paddingLeft: t.spacing.md,
    gap: 4,
    borderLeftWidth: 2,
    borderLeftColor: t.color.border,
  },
});

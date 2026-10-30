import React, { useEffect, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import type { Language } from "../protocol";
import type { RequestActivity } from "../protocol/activity";
import { translate } from "../i18n";
import { tokens as t } from "../design-tokens";
import { Button, Icon, Text, ui } from "../ui";
import { nativeMotion, useReducedMotion } from "../ui/motion";

type StepStatus =
  | "running"
  | "pending"
  | "succeeded"
  | "failed"
  | "unknown"
  | "needs_input";

/** "Thinking" that breathes while the assistant works; still otherwise. */
function ThinkingLabel({
  live,
  children,
}: {
  live: boolean;
  children: string;
}) {
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    opacity.setValue(1);
    if (!live || reduced) return;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.4,
          duration: 800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: nativeMotion,
          isInteraction: false,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: nativeMotion,
          isInteraction: false,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [live, reduced, opacity]);
  return (
    <Animated.View
      testID={live ? "progress-thinking" : undefined}
      style={{ opacity }}
    >
      <Text role="rowLabel" tone="secondary">
        {children}
      </Text>
    </Animated.View>
  );
}

/**
 * What the assistant is doing, as one "Thinking" line like an AI chat. The
 * server selects known stages only; they open beneath it on request, and this
 * view owns every label.
 */
export function RequestProgressCard({
  activity,
  language,
  connection = "live",
  interrupted = false,
  failed = false,
  onRetry,
  retryDisabled = false,
  onInterrupt,
  interruptAvailable = false,
  interruptLabel,
  interruptDisabled = false,
  voice = false,
}: {
  activity: RequestActivity | null;
  language: Language;
  connection?: "waiting" | "live" | "unavailable";
  interrupted?: boolean;
  failed?: boolean;
  onRetry?: () => void;
  retryDisabled?: boolean;
  /** Explicitly retire the current request; does not resubmit its payload. */
  onInterrupt?: () => void;
  /** A command is pending even if the server has not sent its first activity update. */
  interruptAvailable?: boolean;
  interruptLabel?: string;
  interruptDisabled?: boolean;
  /** The answer is ready and waits for its spoken reply. */
  voice?: boolean;
}) {
  const tr = translate(language);
  const [open, setOpen] = useState(false);
  const unknown = interrupted || connection === "unavailable";
  const stopped = unknown || failed || activity?.status === "failed";
  const live = !stopped && (voice || activity?.status !== "succeeded");
  const title =
    failed || activity?.status === "failed"
      ? "progressFailed"
      : unknown
        ? "progressUnknown"
        : voice
          ? "progressVoice"
          : "progressThinking";
  const labels = {
    understanding: "progressUnderstanding",
    crm: "progressCrm",
    preparing: "progressPreparing",
    datetime: "progressDatetime",
  } as const;
  const statuses = {
    running: "progressRunning",
    pending: "progressPending",
    succeeded: "progressDone",
    failed: "progressStopped",
    unknown: "progressUnconfirmed",
    needs_input: "progressNeedsInput",
  } as const;
  const workflowLabels = {
    service: "progressService",
    action: "progressAction",
    inputs: "progressInputs",
    execute: "progressExecute",
  } as const;
  const rows =
    activity?.steps.flatMap((step) => [
      { ...step, calls: 1 },
      ...(step.id === "understanding" ? (activity.tools ?? []) : []),
    ]) ?? [];
  return (
    <View testID="request-progress" style={styles.card}>
      <Pressable
        testID="progress-toggle"
        accessibilityRole="button"
        accessibilityState={{ expanded: open, busy: live }}
        accessibilityLiveRegion="polite"
        disabled={!rows.length}
        onPress={() => setOpen((value) => !value)}
        style={styles.title}
      >
        {stopped ? (
          <Icon name="alert" size={16} color={t.color.text.secondary} />
        ) : null}
        <ThinkingLabel live={live}>{tr(title)}</ThinkingLabel>
        {rows.length ? (
          <View style={open ? styles.chevronOpen : undefined}>
            <Icon name="chevron" size={14} color={t.color.text.secondary} />
          </View>
        ) : null}
      </Pressable>
      {open && rows.length ? (
        <View style={styles.steps}>
          {rows.map((step) => {
            const status: StepStatus =
              unknown && step.status === "running" ? "unknown" : step.status;
            const workflow =
              step.id === "understanding" ? activity?.workflow : undefined;
            const label = workflow
              ? tr(workflowLabels[workflow.stage])
              : `${tr(labels[step.id])}${step.calls > 1 ? ` · ${step.calls}×` : ""}`;
            return (
              <View key={step.id} style={styles.step}>
                <Icon
                  name={
                    status === "succeeded"
                      ? "check"
                      : status === "failed"
                        ? "alert"
                        : "record"
                  }
                  size={14}
                  color={
                    status === "running"
                      ? t.color.action.link
                      : t.color.text.secondary
                  }
                />
                <Text
                  key={step.id}
                  testID={`progress-step-${step.id}-${status}`}
                  role="caption"
                  tone={status === "running" ? undefined : "secondary"}
                  accessibilityLabel={`${label}. ${tr(statuses[status])}`}
                  style={[
                    { flex: 1 },
                    status === "pending" ? styles.pending : undefined,
                  ]}
                >
                  {`${label} · ${tr(statuses[status])}`}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
      {unknown ? (
        <Text role="caption" tone="secondary">
          {tr(failed ? "progressFailedHint" : "progressUnavailable")}
        </Text>
      ) : null}
      {(live || interruptAvailable) &&
      activity?.status !== "succeeded" &&
      activity?.status !== "failed" &&
      onInterrupt ? (
        <Button
          variant="quiet"
          size="small"
          style={styles.action}
          label={interruptLabel ?? tr("progressInterrupt")}
          onPress={onInterrupt}
          disabled={interruptDisabled}
        />
      ) : null}
      {onRetry ? (
        <Button
          variant="quiet"
          size="small"
          style={styles.action}
          label={tr("progressRetry")}
          onPress={onRetry}
          disabled={retryDisabled}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...ui.surface, gap: t.spacing.sm },
  title: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    flexWrap: "wrap",
  },
  chevronOpen: { transform: [{ rotate: "90deg" }] },
  steps: {
    gap: t.spacing.md,
    paddingVertical: t.spacing.sm,
  },
  step: { flexDirection: "row", alignItems: "flex-start", gap: t.spacing.sm },
  pending: { opacity: 0.6 },
  action: { alignSelf: "flex-start", marginLeft: -14, marginVertical: -4 },
});

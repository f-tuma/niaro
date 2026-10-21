import React, { useEffect, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import type { Language } from "../protocol";
import type { RequestActivity } from "../protocol/activity";
import { translate } from "../i18n";
import { tokens as t } from "../design-tokens";
import { Button, Icon, Row, Surface, Text } from "../ui";
import { nativeMotion, useReducedMotion } from "../ui/motion";

type StepStatus =
  | "running"
  | "pending"
  | "succeeded"
  | "failed"
  | "unknown"
  | "needs_input";
function StepIcon({ status }: { status: StepStatus }) {
  const reduced = useReducedMotion();
  const [rotation] = useState(() => new Animated.Value(0));
  useEffect(() => {
    rotation.setValue(0);
    if (status !== "running" || reduced) return;
    const animation = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: nativeMotion,
        isInteraction: false,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [status, reduced, rotation]);
  return (
    <View
      style={styles.icon}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {status === "succeeded" ? (
        <View style={styles.done}>
          <Icon name="check" size={12} color={t.color.text.inverse} />
        </View>
      ) : status === "failed" ? (
        <Icon name="close" size={18} color={t.color.status.error} />
      ) : status === "needs_input" ? (
        <Icon name="info" size={18} color={t.color.action.primary} />
      ) : (
        <Animated.View
          testID={`progress-icon-${status}`}
          style={[
            styles.ring,
            status === "running" && {
              borderColor: t.color.accent.softBlue,
              borderTopColor: t.color.action.primary,
              borderRightColor: t.color.action.primary,
            },
            {
              transform: [
                {
                  rotate: rotation.interpolate({
                    inputRange: [0, 1],
                    outputRange: ["0deg", "360deg"],
                  }),
                },
              ],
            },
          ]}
        />
      )}
    </View>
  );
}

/** The server selects known stages only; this card owns every label and visual. */
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
  const unknown = interrupted || connection === "unavailable";
  const live = !unknown && activity?.status === "running";
  const title =
    failed || activity?.status === "failed"
      ? "progressFailed"
      : unknown
        ? "progressUnknown"
        : activity?.status === "succeeded" && !voice
          ? "progressComplete"
          : "progressTitle";
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
  const rows = activity?.steps.flatMap((step) => [
    { ...step, calls: 1 },
    ...(step.id === "understanding" ? (activity.tools ?? []) : []),
  ]);
  return (
    <Surface testID="request-progress" style={styles.card}>
      <Text role="rowTitle" accessibilityRole="header">
        {tr(title)}
      </Text>
      <View
        style={styles.steps}
        accessibilityLiveRegion="polite"
        accessibilityState={{ busy: !!live }}
      >
        {activity ? (
          rows!.map((step) => {
            const status: StepStatus =
              unknown && step.status === "running" ? "unknown" : step.status;
            const workflow =
              step.id === "understanding" ? activity.workflow : undefined;
            const label = workflow
              ? tr(workflowLabels[workflow.stage])
              : `${tr(labels[step.id])}${step.calls > 1 ? ` · ${step.calls}×` : ""}`;
            return (
              <Row
                key={step.id}
                testID={`progress-step-${step.id}-${status}`}
                style={styles.step}
                accessible
                accessibilityLabel={`${label}. ${tr(statuses[status])}`}
              >
                <StepIcon status={status} />
                <Text role="caption" style={styles.label}>
                  {label}
                </Text>
                <Text
                  role="caption"
                  style={{
                    color:
                      status === "succeeded"
                        ? t.color.status.success
                        : status === "running"
                          ? t.color.action.primary
                          : t.color.text.secondary,
                  }}
                >
                  {tr(statuses[status])}
                </Text>
              </Row>
            );
          })
        ) : voice ? null : (
          <Row style={styles.step}>
            <StepIcon status={unknown ? "unknown" : "running"} />
            <Text role="caption" style={styles.label}>
              {tr("progressWaiting")}
            </Text>
          </Row>
        )}
        {voice ? (
          <Row
            testID="progress-step-voice-running"
            style={styles.step}
            accessible
            accessibilityLabel={`${tr("progressVoice")}. ${tr("progressRunning")}`}
          >
            <StepIcon status="running" />
            <Text role="caption" style={styles.label}>
              {tr("progressVoice")}
            </Text>
            <Text role="caption" style={{ color: t.color.action.primary }}>
              {tr("progressRunning")}
            </Text>
          </Row>
        ) : null}
      </View>
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
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { gap: t.spacing.md },
  steps: { gap: 10 },
  action: { alignSelf: "flex-start", marginLeft: -14, marginVertical: -4 },
  step: { gap: t.spacing.sm, alignItems: "center" },
  label: { flex: 1, minWidth: 0 },
  icon: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    width: 17,
    height: 17,
    borderRadius: t.radius.pill,
    borderWidth: 2,
    borderColor: t.color.text.disabled,
  },
  done: {
    width: 18,
    height: 18,
    borderRadius: t.radius.pill,
    backgroundColor: t.color.status.success,
    alignItems: "center",
    justifyContent: "center",
  },
});

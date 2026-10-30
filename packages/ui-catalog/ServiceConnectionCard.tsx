import React from "react";
import { View } from "react-native";
import type { Language } from "../protocol";
import type { ServiceConnectionCard as ConnectionResult } from "../protocol/service-oauth";
import { tokens as t } from "../design-tokens";
import { translate } from "../i18n";
import { Button, Icon, Row, Surface, Text } from "../ui";

export type ServiceConnectionPhase =
  | "loading"
  | "disconnected"
  | "starting"
  | "pending"
  | "cancelling"
  | "connected"
  | "expired"
  | "cancelled"
  | "error"
  | "unavailable";

export function ServiceConnectionCard({
  result,
  language,
  phase,
  disabled = false,
  openFailed = false,
  statusFailed = false,
  cancelFailed = false,
  onConnect,
  onOpen,
  onCancel,
  onContinue,
}: {
  result: ConnectionResult;
  language: Language;
  phase: ServiceConnectionPhase;
  disabled?: boolean;
  openFailed?: boolean;
  statusFailed?: boolean;
  cancelFailed?: boolean;
  onConnect: () => void;
  onOpen: () => void;
  onCancel: () => void;
  onContinue?: () => void;
}) {
  const tr = translate(language);
  const descriptions = {
    loading: "serviceConnectionChecking",
    disconnected: "serviceConnectionHint",
    starting: "serviceConnectionStarting",
    pending: "serviceConnectionWaiting",
    cancelling: "serviceConnectionCancelling",
    connected: "serviceConnectionConnected",
    expired: "serviceConnectionExpired",
    cancelled: "serviceConnectionCancelled",
    error: "serviceConnectionError",
    unavailable: "serviceConnectionUnavailable",
  } as const;
  const canConnect = ["disconnected", "expired", "cancelled", "error"].includes(
    phase,
  );
  const pending = phase === "pending" || phase === "cancelling";
  return (
    <Surface style={{ gap: t.spacing.md }}>
      <Row>
        <Icon
          name={phase === "connected" ? "check" : "info"}
          size={20}
          color={t.color.action.link}
        />
        <View style={{ flex: 1, gap: 3 }}>
          <Text role="label">{tr("serviceConnectionTitle")}</Text>
          <Text role="caption" tone="secondary">
            {result.service}
          </Text>
        </View>
      </Row>
      <Text role="caption" tone="secondary" accessibilityLiveRegion="polite">
        {tr(descriptions[phase])}
      </Text>
      {pending ? (
        <>
          <Text role="caption" tone="secondary">
            {tr(
              openFailed
                ? "serviceConnectionOpenFailed"
                : "serviceConnectionOpenHint",
            )}
          </Text>
          {statusFailed || cancelFailed ? (
            <Text role="caption" tone="secondary">
              {tr(
                cancelFailed
                  ? "serviceConnectionCancelFailed"
                  : "serviceConnectionStatusFailed",
              )}
            </Text>
          ) : null}
          <Button
            label={tr("serviceConnectionOpen")}
            disabled={disabled || phase === "cancelling"}
            onPress={onOpen}
          />
          <Button
            label={tr("cancel")}
            variant="quiet"
            disabled={disabled}
            loading={phase === "cancelling"}
            onPress={onCancel}
          />
        </>
      ) : null}
      {canConnect || phase === "starting" ? (
        <Button
          label={tr("serviceConnectionConnect")}
          disabled={disabled}
          loading={phase === "starting"}
          onPress={onConnect}
        />
      ) : null}
      {phase === "connected" && result.resumeText && onContinue ? (
        <>
          <Text role="caption" tone="secondary">
            {tr("serviceConnectionResumeHint")}
          </Text>
          <Text selectable>{result.resumeText}</Text>
          <Button
            label={tr("serviceConnectionContinue")}
            disabled={disabled}
            onPress={onContinue}
          />
        </>
      ) : null}
    </Surface>
  );
}

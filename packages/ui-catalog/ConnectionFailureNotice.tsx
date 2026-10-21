import React from "react";
import type { ConnectionDiagnostic } from "../protocol/connection-diagnostic";
import type { Language } from "../protocol";
import { translate, type TranslationKey } from "../i18n";
import { View } from "react-native";
import { Disclosure, Notice, Text } from "../ui";

const reasons: Record<ConnectionDiagnostic["reason"], TranslationKey> = {
  network: "connectionNetworkFailed",
  timeout: "connectionTimedOut",
  http: "connectionHttpFailed",
  response: "connectionResponseInvalid",
  protocol: "connectionProtocolMismatch",
  schema: "connectionSchemaMismatch",
  scope: "connectionScopeMismatch",
  payload: "connectionPayloadLimit",
  unknown: "connectionReadFailed",
};
const phases: Record<ConnectionDiagnostic["phase"], TranslationKey> = {
  authentication: "connectionStageAuthentication",
  capabilities: "connectionStageCapabilities",
  snapshot: "connectionStageSnapshot",
  events: "connectionStageEvents",
};
export function ConnectionFailureNotice({
  language,
  diagnostic,
}: {
  language: Language;
  diagnostic: ConnectionDiagnostic;
}) {
  const tr = translate(language);
  // One line says what happened; the diagnostics sit behind a disclosure.
  const lines = [`${tr("connectionStage")}: ${tr(phases[diagnostic.phase])}`];
  if (diagnostic.httpStatus !== undefined)
    lines.push(`HTTP ${diagnostic.httpStatus}`);
  if (diagnostic.expectedProfile) {
    lines.push(
      `${tr("connectionExpectedProfile")}: ${diagnostic.expectedProfile}`,
    );
    lines.push(
      `${tr("connectionReceivedProfile")}: ${diagnostic.receivedProfile ?? tr("connectionUnknownProfile")}`,
    );
  }
  if (diagnostic.fields?.length)
    lines.push(
      `${tr("connectionInvalidFields")}: ${diagnostic.fields.join(", ")}`,
    );
  return (
    <View>
      <Notice error>{tr(reasons[diagnostic.reason])}</Notice>
      <Disclosure label={tr("technicalDetails")}>
        <Text role="caption" tone="secondary" selectable>
          {lines.join("\n")}
        </Text>
      </Disclosure>
    </View>
  );
}

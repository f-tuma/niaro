import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AppState, View } from "react-native";
import type { ClientSession } from "../../packages/client-core/session";
import type {
  AttachmentTarget,
  AttachmentState,
} from "../../packages/client-core/attachments";
import { AttachmentSelectionFlow } from "../../packages/client-core/attachment-selection";
import {
  attachmentInterpretation,
  attachmentRuntimeCopy,
  draftAttachmentViews,
  persistedAttachmentViews,
} from "../../packages/client-core/attachment-presentation-adapter";
import type {
  AttachmentProcessing as Processing,
  AttachmentPublicFile,
} from "../../packages/protocol/attachments";
import {
  AttachmentTray,
  PersistedAttachments,
  AttachmentProcessing,
} from "../../packages/ui-catalog/AttachmentTray";
import { AttachmentPreview } from "../../packages/ui-catalog/AttachmentPreview";
import { Button, Notice, Text } from "../../packages/ui";
import { DetailSheet } from "./ScreenChrome";
import {
  pickAttachment,
  attachmentDigest,
  saveAttachment,
} from "./attachment-device";
const empty: AttachmentState = {
  capabilities: null,
  discovering: false,
  target: null,
  draft: null,
  entries: [],
  busy: false,
  error: null,
};
const idle = { rotation: 0 as const, busy: false, error: null };
const noopSubscribe = () => () => {};
export function useMobileAttachments(
  session: ClientSession | null,
  target: AttachmentTarget,
  localGeneration: number,
  language: "en" | "cs",
) {
  const runtime = session?.attachments;
  const flow = useMemo(
    () =>
      runtime
        ? new AttachmentSelectionFlow(runtime, attachmentDigest)
        : undefined,
    [runtime],
  );
  const state = useSyncExternalStore(
    runtime?.subscribe ?? noopSubscribe,
    runtime?.getSnapshot ?? (() => empty),
  );
  const selection = useSyncExternalStore(
    flow?.subscribe ?? noopSubscribe,
    flow?.getSnapshot ?? (() => idle),
  );
  useEffect(() => {
    if (!runtime) return;
    runtime.select(target, localGeneration);
    void runtime.discover();
    flow?.cancel();
    return () => {
      flow?.cancel();
    };
    // The primitive scope fields fence resources without resetting on object render identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    runtime,
    flow,
    target.conversationId,
    target.expectedGeneration,
    target.mode,
    localGeneration,
  ]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active" && flow?.getSnapshot().candidate) flow.cancel();
    });
    return () => {
      subscription.remove();
      flow?.cancel();
    };
  }, [flow]);
  const choose = (kind: "camera" | "photos" | "file") => {
    if (flow && runtime?.available)
      void flow.choose((signal) =>
        pickAttachment(kind, state.capabilities!.limits.maxFileBytes, signal),
      );
  };
  return {
    runtime,
    state,
    flow,
    selection,
    choose,
    available: !!runtime?.available,
    ready: !!runtime?.ready,
    language,
  };
}
export type MobileAttachments = ReturnType<typeof useMobileAttachments>;
export function MobileAttachmentDraft({ value }: { value: MobileAttachments }) {
  const copy = attachmentRuntimeCopy(value.language);
  return (
    <View>
      {value.runtime ? (
        <AttachmentTray
          language={value.language}
          files={draftAttachmentViews(value.runtime, value.state.entries)}
        />
      ) : null}
      {value.state.entries
        .filter((entry) => ["uncertain", "verifying"].includes(entry.state))
        .map((entry) => (
          <Button
            key={entry.id}
            label={copy.check}
            variant="quiet"
            disabled={value.state.busy}
            onPress={() => {
              void value.runtime?.refresh(entry.id);
            }}
          />
        ))}
      {value.state.error || value.selection.error ? (
        <Notice error>
          {value.selection.error === "attachment_permission"
            ? copy.permission
            : copy.failed}
        </Notice>
      ) : null}
    </View>
  );
}
export function MobileAttachmentPreview({
  value,
}: {
  value: MobileAttachments;
}) {
  const candidate = value.selection.candidate;
  if (!candidate || !value.flow) return null;
  return (
    <DetailSheet
      language={value.language}
      title={candidate.selection.filename}
      onClose={value.flow.cancel}
    >
      <AttachmentPreview
        language={value.language}
        filename={candidate.selection.filename}
        raster={candidate.raster}
        rotation={value.selection.rotation}
        loading={value.selection.busy}
        rotate={{ onPress: value.flow.rotate }}
        retake={{
          onPress: () => {
            value.flow?.cancel();
            value.choose("camera");
          },
        }}
        confirm={{
          onPress: () => {
            void value.flow?.confirm();
          },
        }}
      />
      <Text role="caption" tone="secondary">
        {attachmentRuntimeCopy(value.language).conversion}
      </Text>
    </DetailSheet>
  );
}
export function MobileMessageAttachments({
  session,
  language,
  files,
  processing,
  onAgain,
  onEdit,
}: {
  session: ClientSession;
  language: "en" | "cs";
  files: readonly AttachmentPublicFile[];
  processing?: Processing;
  onAgain?: () => void;
  onEdit?: () => void;
}) {
  const [error, setError] = useState(false);
  const download = (file: AttachmentPublicFile) => {
    setError(false);
    void session.attachments
      .download(file, attachmentDigest, saveAttachment)
      .catch(() => setError(true));
  };
  const interpretation = attachmentInterpretation(processing);
  return (
    <View>
      <PersistedAttachments
        language={language}
        files={persistedAttachmentViews(files, download)}
      />
      {interpretation ? (
        <AttachmentProcessing language={language} value={interpretation} />
      ) : null}
      <View style={{ flexDirection: "row", gap: 6 }}>
        {onEdit ? (
          <Button
            variant="quiet"
            size="small"
            label={attachmentRuntimeCopy(language).edit}
            onPress={onEdit}
          />
        ) : null}
        {onAgain ? (
          <Button
            variant="quiet"
            size="small"
            label={attachmentRuntimeCopy(language).again}
            onPress={onAgain}
          />
        ) : null}
      </View>
      {error ? (
        <Notice error>{attachmentRuntimeCopy(language).failed}</Notice>
      ) : null}
    </View>
  );
}

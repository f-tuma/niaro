import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { View, ScrollView } from "react-native";
import { Button, Icon, Notice, Row, Text } from "../../packages/ui";
import { tokens as t } from "../../packages/design-tokens";
import { translate, en, type TranslationKey } from "../../packages/i18n";
import type { Language, WorkItem } from "../../packages/protocol";
import type {
  ProcessOutputPath,
  ProcessOutputPage,
  ProcessOutputReference,
} from "../../packages/protocol/process-output";
import type { ClientSession } from "../../packages/client-core/session";
import { assertCurrentProcessOutput } from "../../packages/client-core/process-output-reader";
import { canonicalProcessJson } from "../../packages/client-core/process-command-digest";
import { ProcessOutputView } from "../../packages/ui-catalog/ProcessOutputView";
import { DetailSheet } from "./ScreenChrome";

/** Mount a fresh owner only while the exact visible work still authorizes its reference. */
export function ProcessOutputInspector({
  session,
  work,
  language,
}: {
  session: ClientSession;
  work: WorkItem;
  language: Language;
}) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const reference = work.native?.process?.output;
  if (
    !state.store ||
    state.status !== "online" ||
    state.store.stale ||
    state.store.needsSnapshot
  )
    return null;
  if (!reference)
    return work.native?.process?.status === "succeeded" &&
      session.getProcessOutputSupport() === "unsupported" ? (
      <Notice>{translate(language)("process_output_unsupported")}</Notice>
    ) : null;
  try {
    assertCurrentProcessOutput(
      state.store,
      session.address,
      state.store.scope,
      { reference, path: [], cursor: null },
    );
  } catch {
    return null;
  }
  return (
    <OwnedInspector
      key={canonicalProcessJson(reference)}
      session={session}
      reference={reference}
      language={language}
      title={work.title}
      redacted={!!work.native?.process?.outputSummary?.redacted}
    />
  );
}
function OwnedInspector({
  session,
  reference,
  language,
  title,
  redacted,
}: {
  session: ClientSession;
  reference: ProcessOutputReference;
  language: Language;
  title: string;
  redacted: boolean;
}) {
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const tr = translate(language);
  return (
    <>
      <Button
        variant="secondary"
        size="small"
        icon="transcript"
        style={{ alignSelf: "flex-start" }}
        label={tr("processOutputOpen")}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <DetailSheet
          fullHeight
          scrollRef={scrollRef}
          title={tr("processOutputTitle")}
          language={language}
          onClose={() => setOpen(false)}
        >
          <Text role="cardTitle">{title}</Text>
          {redacted ? (
            <Text role="meta" tone="secondary">
              {tr("processOutputRedacted")}
            </Text>
          ) : null}
          <OutputBrowser
            session={session}
            reference={reference}
            language={language}
            scrollRef={scrollRef}
          />
        </DetailSheet>
      ) : null}
    </>
  );
}
type Frame = {
  path: ProcessOutputPath;
  label: string;
  pages: { cursor: string | null; offset: number }[];
  pageIndex: number;
};
function OutputBrowser({
  session,
  reference,
  language,
  scrollRef,
}: {
  session: ClientSession;
  reference: ProcessOutputReference;
  language: Language;
  scrollRef: React.RefObject<ScrollView | null>;
}) {
  const tr = translate(language);
  const [frames, setFrames] = useState<Frame[]>([
    {
      path: [],
      label: tr("processOutputRoot"),
      pages: [{ cursor: null, offset: 0 }],
      pageIndex: 0,
    },
  ]);
  const frame = frames[frames.length - 1]!;
  const position = frame.pages[frame.pageIndex]!;
  const request = useMemo(
    () => ({ reference, path: frame.path, cursor: position.cursor }),
    [reference, frame.path, position.cursor],
  );
  const requestKey = canonicalProcessJson(request);
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<{
    key: string;
    attempt: number;
    page?: ProcessOutputPage;
    error?: TranslationKey;
  }>();
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    let active = true;
    const controller = new AbortController();
    void session
      .loadProcessOutputPage(request, position.offset, controller.signal)
      .then(
        (page) => {
          if (active && !controller.signal.aborted)
            setRead({ key: requestKey, attempt, page });
        },
        (error) => {
          if (active && !controller.signal.aborted)
            setRead({
              key: requestKey,
              attempt,
              error:
                error instanceof Error && error.message in en
                  ? (error.message as TranslationKey)
                  : "process_output_unavailable",
            });
        },
      );
    return () => {
      active = false;
      controller.abort();
    };
  }, [session, request, requestKey, position.offset, attempt, scrollRef]);
  const current =
    read?.key === requestKey && read.attempt === attempt ? read : undefined;
  const page = current?.page;
  const replaceFrame = (next: Frame) =>
    setFrames([...frames.slice(0, -1), next]);
  return (
    <View style={{ gap: t.spacing.md }}>
      {/* A breadcrumb: Output › field › item; earlier steps are tappable. */}
      <Row style={{ flexWrap: "wrap", gap: 2 }}>
        {frames.map((item, index) => (
          <Row key={index} style={{ gap: 2 }}>
            {index ? (
              <Icon name="chevron" size={14} color={t.color.text.disabled} />
            ) : null}
            {index === frames.length - 1 ? (
              <Text role="label" selectable style={{ paddingHorizontal: 4 }}>
                {item.label}
              </Text>
            ) : (
              <Button
                variant="quiet"
                size="small"
                label={item.label}
                style={{ minHeight: 28, paddingHorizontal: 4 }}
                onPress={() => setFrames(frames.slice(0, index + 1))}
              />
            )}
          </Row>
        ))}
      </Row>
      {!current ? (
        <Text role="meta" tone="secondary">
          {tr("processOutputLoading")}
        </Text>
      ) : current.error ? (
        <>
          <Notice error>{tr(current.error)}</Notice>
          <Button
            variant="secondary"
            size="small"
            style={{ alignSelf: "flex-start" }}
            label={tr("processOutputRetry")}
            onPress={() => setAttempt(attempt + 1)}
          />
        </>
      ) : page ? (
        <ProcessOutputView
          page={page}
          language={language}
          onOpen={(index, label) =>
            setFrames([
              ...frames,
              {
                path: [
                  ...frame.path,
                  {
                    kind: page.node.kind === "array" ? "item" : "property",
                    index,
                  },
                ],
                label,
                pages: [{ cursor: null, offset: 0 }],
                pageIndex: 0,
              },
            ])
          }
          onNext={
            page.nextCursor
              ? () =>
                  replaceFrame({
                    ...frame,
                    pages: [
                      ...frame.pages.slice(0, frame.pageIndex + 1),
                      {
                        cursor: page.nextCursor,
                        offset: page.offset + page.children.length,
                      },
                    ],
                    pageIndex: frame.pageIndex + 1,
                  })
              : undefined
          }
          onPrevious={
            frame.pageIndex > 0
              ? () => replaceFrame({ ...frame, pageIndex: frame.pageIndex - 1 })
              : undefined
          }
        />
      ) : null}
    </View>
  );
}

import { useRef, useState, useSyncExternalStore } from "react";
import {
  AudioLines,
  ChevronDown,
  Download,
  FileAudio,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Card, CardContent } from "@admin/components/ui/card";
import { Progress } from "@admin/components/ui/progress";
import { Spinner } from "@admin/components/ui/spinner";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@admin/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import { SidebarMenuBadge } from "@admin/components/ui/sidebar";
import { Section } from "@admin/components/console/page";
import { StatusDot } from "@admin/components/console/status";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { ConfirmAction, MoreActions } from "@admin/components/console/forms";
import type { ClientSession } from "../../../../packages/client-core/session";
import type { Meeting } from "../../../../packages/protocol/meetings";
import { translate } from "../../../../packages/i18n";
import { meetingTime } from "../../../../packages/ui-catalog/meeting-format";
import { useApp } from "./context";
import {
  IMPORT_ACCEPT,
  captureFileName,
  captureSupport,
  meetingCaptureStore,
  type CaptureSource,
  type LocalCapture,
  type MeetingCaptureStore,
} from "./meeting-capture";
import {
  meetingErrorText,
  useMeetingsCopy,
  type MeetingsCopy,
} from "./meetings-copy";

/** The provisional name the server replaces from the finished summary. */
export function automaticMeetingTitle(language: "en" | "cs", now = new Date()) {
  return `${translate(language)("meetingDefaultTitle")} · ${now.toLocaleString(
    language,
    { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" },
  )}`;
}

export function useMeetingCapture(store = meetingCaptureStore()) {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

const megabytes = (bytes: number) =>
  `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/**
 * The header actions of Meetings: add a recording made elsewhere, and record
 * (the microphone, or the microphone and a call shared from another tab).
 */
export function MeetingCaptureActions({
  session,
  store = meetingCaptureStore(),
  onUploaded,
}: {
  session: ClientSession;
  store?: MeetingCaptureStore;
  onUploaded(meeting: Meeting): void;
}) {
  const { language } = useApp();
  const copy = useMeetingsCopy();
  const state = useMeetingCapture(store);
  const file = useRef<HTMLInputElement>(null);
  const support = captureSupport();
  const busy = state.phase !== "idle";
  // Required before every recording: the others know.
  const [consent, setConsent] = useState(false);
  const record = (source: CaptureSource) => {
    if (!consent) return;
    store.clearError();
    setConsent(false);
    void store.start(
      source,
      session.identityKey,
      language,
      automaticMeetingTitle(language),
      { at: new Date().toISOString(), by: session.userId },
    );
  };
  return (
    <>
      <input
        ref={file}
        type="file"
        accept={IMPORT_ACCEPT}
        className="hidden"
        aria-label={copy.addFile}
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = "";
          if (!picked) return;
          void store
            .addFile(
              picked,
              session.identityKey,
              language,
              automaticMeetingTitle(language, new Date(picked.lastModified)),
            )
            .then(async (id) => {
              const meeting = id ? await store.upload(id, session) : null;
              if (meeting) onUploaded(meeting);
            });
        }}
      />
      <Button variant="outline" onClick={() => file.current?.click()}>
        <Upload data-icon="inline-start" aria-hidden="true" />
        {copy.addFile}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={busy || !support.microphone}>
            <Mic data-icon="inline-start" aria-hidden="true" />
            {copy.record}
            <ChevronDown data-icon="inline-end" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuCheckboxItem
            checked={consent}
            onCheckedChange={(checked) => setConsent(checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            {copy.consentCheck}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!consent}
            onSelect={() => record("microphone")}
          >
            <Mic aria-hidden="true" />
            <div className="flex min-w-0 flex-col">
              <span>{copy.recordMicrophone}</span>
              <span className="text-xs text-muted-foreground">
                {copy.recordMicrophoneHint}
              </span>
            </div>
          </DropdownMenuItem>
          {support.meeting && (
            <DropdownMenuItem
              disabled={!consent}
              onSelect={() => record("meeting")}
            >
              <AudioLines aria-hidden="true" />
              <div className="flex min-w-0 flex-col">
                <span>{copy.recordCall}</span>
                <span className="text-xs text-muted-foreground">
                  {copy.recordCallHint}
                </span>
              </div>
            </DropdownMenuItem>
          )}
          {support.meeting && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>
                <span className="text-xs font-normal text-muted-foreground">
                  {copy.callGuide}
                </span>
              </DropdownMenuLabel>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** The live recording: time, both tracks' levels, pause and stop. */
export function MeetingRecordingPanel({
  session,
  store = meetingCaptureStore(),
  onUploaded,
}: {
  session: ClientSession;
  store?: MeetingCaptureStore;
  onUploaded(meeting: Meeting): void;
}) {
  const { language } = useApp();
  const copy = useMeetingsCopy();
  const state = useMeetingCapture(store);
  if (state.phase === "idle")
    return state.error ? (
      <Alert variant="destructive">
        <AlertDescription>
          {meetingErrorText(state.error, copy, language)}
        </AlertDescription>
      </Alert>
    ) : null;
  const live = state.phase === "recording" || state.phase === "paused";
  const stop = async () => {
    const id = await store.stop();
    const meeting = id ? await store.upload(id, session) : null;
    if (meeting) onUploaded(meeting);
  };
  return (
    <Card aria-label={copy.recording}>
      <CardContent>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {state.phase === "recording" ? (
                <StatusDot tone="danger">{copy.recording}</StatusDot>
              ) : state.phase === "paused" ? (
                <StatusDot tone="warning">{copy.paused}</StatusDot>
              ) : (
                <span className="flex items-center gap-2 text-sm">
                  <Spinner />
                  {state.phase === "preparing" ? copy.preparing : copy.stopping}
                </span>
              )}
              <span
                role="timer"
                aria-live="off"
                className="font-mono text-lg tabular-nums"
              >
                {meetingTime(state.elapsedMs / 1000)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {state.phase === "paused" ? (
                <Button variant="outline" onClick={() => store.resume()}>
                  <Play data-icon="inline-start" aria-hidden="true" />
                  {copy.resume}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={state.phase !== "recording"}
                  onClick={() => store.pause()}
                >
                  <Pause data-icon="inline-start" aria-hidden="true" />
                  {copy.pause}
                </Button>
              )}
              <Button disabled={!live} onClick={() => void stop()}>
                <Square data-icon="inline-start" aria-hidden="true" />
                {copy.stop}
              </Button>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Meter label={copy.levelSelf} value={state.levels.self} />
            {state.levels.others !== null && (
              <Meter label={copy.levelOthers} value={state.levels.others} />
            )}
          </div>
          {state.meetingAudioLost && (
            <Alert>
              <AlertDescription>{copy.callAudioLost}</AlertDescription>
            </Alert>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="w-10 shrink-0">{label}</span>
      <Progress
        value={Math.round(value * 100)}
        aria-label={label}
        className="flex-1"
      />
    </div>
  );
}

/**
 * Recordings the server doesn't have yet: sending, or kept after a failure
 * to send again, save or discard. Nothing leaves this page by itself.
 */
export function UnsentMeetings({
  session,
  store = meetingCaptureStore(),
  onUploaded,
}: {
  session: ClientSession;
  store?: MeetingCaptureStore;
  onUploaded(meeting: Meeting): void;
}) {
  const copy = useMeetingsCopy();
  const state = useMeetingCapture(store);
  const captures = state.captures.filter(
    (capture) => capture.identityKey === session.identityKey,
  );
  if (!captures.length) return null;
  return (
    <Section title={copy.unsent} count={captures.length}>
      <Card variant="list">
        {captures.map((capture) => (
          <UnsentRow
            key={capture.id}
            capture={capture}
            copy={copy}
            onSend={async () => {
              const meeting = await store.upload(capture.id, session);
              if (meeting) onUploaded(meeting);
            }}
            onDiscard={() => store.discard(capture.id)}
          />
        ))}
      </Card>
    </Section>
  );
}

function UnsentRow({
  capture,
  copy,
  onSend,
  onDiscard,
}: {
  capture: LocalCapture;
  copy: MeetingsCopy;
  onSend(): Promise<void>;
  onDiscard(): void;
}) {
  const { language } = useApp();
  const [confirm, setConfirm] = useState(false);
  const size = capture.blob.size;
  const sending = capture.phase === "uploading";
  const save = () => {
    const url = URL.createObjectURL(capture.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = captureFileName(capture);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <Item variant="row" size="row">
      <ItemMedia>
        <EntityIcon size="sm" tone="muted">
          {capture.origin === "file" ? <FileAudio /> : <Mic />}
        </EntityIcon>
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{capture.input.title}</ItemTitle>
        <ItemDescription>
          {sending
            ? `${copy.uploading} ${megabytes(capture.uploaded)} / ${megabytes(size)}`
            : capture.error
              ? meetingErrorText(capture.error, copy, language)
              : megabytes(size)}
        </ItemDescription>
        {sending && (
          <Progress
            value={Math.round((capture.uploaded / size) * 100)}
            aria-label={copy.uploading}
            className="mt-1"
          />
        )}
      </ItemContent>
      <ItemActions>
        {sending ? (
          <Spinner />
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={() => void onSend()}>
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              {copy.sendAgain}
            </Button>
            <MoreActions label={copy.more} size="sm">
              <DropdownMenuItem onSelect={save}>
                <Download aria-hidden="true" />
                {copy.saveFile}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setConfirm(true)}
              >
                <Trash2 aria-hidden="true" />
                {copy.discard}
              </DropdownMenuItem>
            </MoreActions>
            <ConfirmAction
              open={confirm}
              onOpenChange={setConfirm}
              title={copy.discardConfirm}
              confirmLabel={copy.discard}
              cancelLabel={copy.cancel}
              onConfirm={onDiscard}
            />
          </>
        )}
      </ItemActions>
    </Item>
  );
}

/** Beside "Meetings" in the sidebar: a recording runs while you're elsewhere. */
export function MeetingRecordingBadge({
  store = meetingCaptureStore(),
}: {
  store?: MeetingCaptureStore;
}) {
  const copy = useMeetingsCopy();
  const state = useMeetingCapture(store);
  if (state.phase !== "recording" && state.phase !== "paused") return null;
  return (
    <SidebarMenuBadge
      aria-label={state.phase === "recording" ? copy.recording : copy.paused}
    >
      <StatusDot
        size="sm"
        tone={state.phase === "recording" ? "danger" : "warning"}
      >
        {meetingTime(state.elapsedMs / 1000)}
      </StatusDot>
    </SidebarMenuBadge>
  );
}

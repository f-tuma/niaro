import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bot, Workflow } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@admin/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@admin/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@admin/components/ui/radio-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import type { ClientSession } from "../../../../packages/client-core/session";
import type { MeetingRecord } from "../../../../packages/protocol/meeting-record";
import type { MeetingProcessSource } from "../../../../packages/protocol/process-start";
import { meetingProcessSourceOptions } from "../../../../packages/protocol/meeting-process-input";
import { translate, type TranslationKey } from "../../../../packages/i18n";
import { fieldLabel } from "../../../../packages/ui-catalog/field-format";
import { useApp } from "./context";
import { useMenuCopy } from "./menu-copy";
import { useSessionState } from "./menu-page";
import { LaunchSheet } from "./processes-page";
import { ProcessLauncher, sessionFresh } from "./process-launch";
import { useMeetingsCopy } from "./meetings-copy";

const sourceCopy: Record<MeetingProcessSource, TranslationKey> = {
  summary: "meetingProcessSourceSummary",
  points: "meetingProcessSourcePoints",
  tasks: "meetingProcessSourceTasks",
  selectedTask: "meetingProcessSourceSelectedTask",
  transcript: "meetingProcessSourceTranscript",
};

/**
 * "Continue with a process" from one open meeting task: choose a process and
 * which parts of the meeting fill its fields, then the usual form, review and
 * start. The start is bound to this record and the task's open revision.
 */
export function MeetingProcessSheet({
  session,
  record,
  task,
  onClose,
}: {
  session: ClientSession;
  record: MeetingRecord;
  task: { id: string; revision: number; text: string };
  onClose(): void;
}) {
  const { language } = useApp();
  const copy = useMeetingsCopy();
  const menuCopy = useMenuCopy();
  const tr = translate(language);
  const navigate = useNavigate();
  const state = useSessionState(session);
  const [launcher] = useState(
    () =>
      new ProcessLauncher(
        session,
        language,
        `chat-${crypto.randomUUID()}`,
        null,
      ),
  );
  const model = useSyncExternalStore(
    launcher.subscribe,
    launcher.getSnapshot,
    launcher.getSnapshot,
  );
  useEffect(() => () => launcher.dispose(), [launcher]);
  const fresh = sessionFresh(state);
  useEffect(() => {
    if (fresh && !model.inventory && !model.loading && !model.error)
      void launcher.load();
  }, [fresh, launcher, model.inventory, model.loading, model.error]);
  const ready = (model.inventory?.processes ?? []).filter(
    (entry) => entry.availability === "ready",
  );
  const [processId, setProcessId] = useState<string | null>(null);
  const [bindings, setBindings] = useState<
    Partial<Record<string, MeetingProcessSource>>
  >({});
  const entry = ready.find((value) => value.processId === processId) ?? null;
  const options = entry
    ? meetingProcessSourceOptions(record, entry.inputSchema, task.id)
    : {};
  const choose = (id: string) => {
    setProcessId(id);
    setBindings({});
  };
  const open = () => {
    if (!entry) return;
    void launcher.open(entry, false, {
      record,
      selectedTask: { id: task.id, revision: task.revision },
      sourceBindings: bindings,
    });
  };
  return (
    <>
      <Sheet
        open={!model.selected}
        onOpenChange={(value) => {
          if (!value) onClose();
        }}
      >
        <SheetContent size="lg">
          <SheetHeader>
            <SheetTitle className="mr-8">{copy.continueProcess}</SheetTitle>
            <SheetDescription>{task.text}</SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
            {model.error && (
              <Alert variant="destructive">
                <AlertDescription>{tr(model.error)}</AlertDescription>
              </Alert>
            )}
            {!model.inventory ? (
              !model.error && (
                <div role="status" aria-label={copy.chooseProcess}>
                  <Skeleton className="h-24 w-full" />
                </div>
              )
            ) : !ready.length ? (
              <p className="text-sm text-muted-foreground">
                {copy.noProcesses}
              </p>
            ) : (
              <FieldSet>
                <FieldLegend>{copy.chooseProcess}</FieldLegend>
                <RadioGroup value={processId ?? ""} onValueChange={choose}>
                  {ready.map((value) => {
                    const Icon = value.kind === "agent" ? Bot : Workflow;
                    return (
                      <Field key={value.processId} orientation="horizontal">
                        <RadioGroupItem
                          id={`meeting-process-${value.processId}`}
                          value={value.processId}
                        />
                        <FieldLabel
                          htmlFor={`meeting-process-${value.processId}`}
                        >
                          <Icon
                            aria-hidden="true"
                            className="size-4 text-muted-foreground"
                          />
                          {value.name}
                        </FieldLabel>
                      </Field>
                    );
                  })}
                </RadioGroup>
              </FieldSet>
            )}
            {entry && Object.keys(options).length > 0 && (
              <FieldSet>
                <FieldLegend>{copy.fillFrom}</FieldLegend>
                <FieldGroup>
                  {Object.entries(options).map(([field, sources]) => (
                    <Field key={field}>
                      <FieldLabel htmlFor={`meeting-source-${field}`}>
                        {fieldLabel(field, language)}
                      </FieldLabel>
                      <NativeSelect
                        id={`meeting-source-${field}`}
                        value={bindings[field] ?? ""}
                        onChange={(event) =>
                          setBindings({
                            ...bindings,
                            [field]:
                              (event.target.value as MeetingProcessSource) ||
                              undefined,
                          })
                        }
                      >
                        <NativeSelectOption value="">
                          {copy.fillNone}
                        </NativeSelectOption>
                        {sources!.map((source) => (
                          <NativeSelectOption key={source} value={source}>
                            {tr(sourceCopy[source])}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
            )}
          </div>
          <SheetFooter>
            <Button variant="outline" onClick={onClose}>
              {copy.cancel}
            </Button>
            <Button disabled={!entry || !fresh} onClick={open}>
              {copy.openForm}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <LaunchSheet
        model={model}
        copy={menuCopy}
        language={language}
        disabled={!fresh || model.retrying}
        onClose={() => {
          launcher.close();
          if (model.phase === "accepted") onClose();
        }}
        onReview={(input) => launcher.review(input)}
        onEdit={() => launcher.edit()}
        onStart={() => void launcher.start()}
        onOpenChat={() => {
          const id = model.submission?.conversationId;
          launcher.close();
          onClose();
          if (id)
            void navigate({
              to: "/chat/$conversationId",
              params: { conversationId: id },
            });
        }}
      />
    </>
  );
}

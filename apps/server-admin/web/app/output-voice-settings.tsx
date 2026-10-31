import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Button } from "@admin/components/ui/button";
import { Card, CardContent } from "@admin/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Section } from "@admin/components/console/page";
import { translate, type TranslationKey } from "../../../../packages/i18n";
import {
  OUTPUT_VOICE_PROFILE,
  type OutputVoiceChoice,
  type OutputVoiceSnapshot,
  type OutputVoiceUpdate,
} from "../../../../packages/protocol/output-voice";
import type { ClientSession } from "../../../../packages/client-core/session";
import { useApp } from "./context";

export function OutputVoiceSettings() {
  const { session, identity, workspace, language } = useApp();
  const userId = identity.user?.id,
    workspaceId = workspace.workspaceId;
  const owner = useMemo(
    () =>
      new WebOutputVoiceEditor(
        session,
        userId,
        workspaceId,
        workspace.organizationId,
      ),
    [session, userId, workspaceId, workspace.organizationId],
  );
  useSyncExternalStore(owner.subscribe, owner.getVersion, owner.getVersion);
  useEffect(() => owner.mount(), [owner]);
  const tr = translate(language),
    snapshot = owner.snapshot;
  if (!session || snapshot === null) return null;
  const defaultLabel = `${tr("outputVoiceDefault")}${snapshot?.serverDefault ? ` (${snapshot.serverDefault.label})` : ""}`;
  const selected =
    snapshot?.effective.choice.kind === "catalogue"
      ? snapshot.effective.choice.optionId
      : "server-default";
  const label =
    snapshot?.effective.choice.kind === "catalogue"
      ? snapshot.effective.label
      : defaultLabel;
  const clearable =
    snapshot &&
    ((snapshot.saved?.choice.kind === "catalogue" &&
      snapshot.effective.reason !== "selected") ||
      (!snapshot.saved &&
        snapshot.revision > 0 &&
        ["saved-choice-unavailable", "speech-unavailable"].includes(
          snapshot.effective.reason,
        )));
  const detail =
    snapshot?.availability === "speech-unavailable"
      ? "outputVoiceUnavailable"
      : snapshot?.effective.reason === "saved-choice-unavailable"
        ? "outputVoiceFallback"
        : snapshot?.availability === "server-default-only"
          ? "outputVoiceDefaultOnly"
          : undefined;
  const disabled = owner.busy || owner.reading || !!owner.pending;
  return (
    <Section title={tr("outputVoice")}>
      <Card>
        <CardContent>
          <FieldGroup>
            <Field data-disabled={disabled} data-invalid={!!owner.issue}>
              {snapshot?.availability === "selectable" ? (
                <>
                  <FieldLabel htmlFor="account-output-voice">
                    {tr("outputVoice")}
                  </FieldLabel>
                  <Select
                    value={selected}
                    disabled={disabled}
                    onValueChange={(value) => {
                      if (value === "server-default")
                        void owner.save({ kind: "server-default" });
                      else if (
                        snapshot.options.some(
                          (option) => option.optionId === value,
                        )
                      )
                        void owner.save({ kind: "catalogue", optionId: value });
                    }}
                  >
                    <SelectTrigger
                      id="account-output-voice"
                      aria-label={tr("outputVoice")}
                      aria-invalid={!!owner.issue}
                      aria-busy={owner.saving || owner.reading}
                    >
                      <SelectValue>{label}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="server-default">
                          {defaultLabel}
                        </SelectItem>
                        {snapshot.options.map((option) => (
                          <SelectItem
                            key={option.optionId}
                            value={option.optionId}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </>
              ) : snapshot ? (
                <FieldLabel>{label}</FieldLabel>
              ) : (
                <div role="status" aria-label={tr("outputVoiceLoading")}>
                  <Skeleton className="h-8 w-full" />
                </div>
              )}
              {detail ? (
                <FieldDescription>{tr(detail)}</FieldDescription>
              ) : null}
              {snapshot && (owner.saving || owner.reading) ? (
                <FieldDescription role="status">
                  {tr(
                    owner.saving ? "outputVoiceSaving" : "outputVoiceLoading",
                  )}
                </FieldDescription>
              ) : null}
              {owner.issue ? <FieldError>{tr(owner.issue)}</FieldError> : null}
              {clearable ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={disabled}
                  onClick={() => void owner.save({ kind: "server-default" })}
                >
                  {tr("outputVoiceReset")}
                </Button>
              ) : null}
              {owner.pending && !owner.busy && !owner.reading ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() =>
                    void owner.save(owner.pending!.choice, owner.pending)
                  }
                >
                  {tr("outputVoiceRetry")}
                </Button>
              ) : null}
              {owner.issue && !owner.pending ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={owner.busy || owner.reading}
                  onClick={owner.reload}
                >
                  {tr("outputVoiceRefresh")}
                </Button>
              ) : null}
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
    </Section>
  );
}
class WebOutputVoiceEditor {
  constructor(
    readonly session: ClientSession | null,
    readonly userId: string | undefined,
    readonly workspaceId: string,
    readonly organizationId: string,
  ) {}
  alive = false;
  foreground = true;
  generation = 0;
  write = 0;
  reading = false;
  snapshot: OutputVoiceSnapshot | null | undefined;
  issue: TranslationKey | undefined;
  busy = false;
  /** Only the POST wait; busy also spans passive reconciliation. */
  saving = false;
  pending: OutputVoiceUpdate | undefined;
  read: AbortController | undefined;
  saveRequest: AbortController | undefined;
  private version = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getVersion = () => this.version;
  notify = () => {
    this.version++;
    for (const listener of this.listeners) listener();
  };
  reload = () => {
    this.issue = undefined;
    void this.refresh();
  };
  owns = (generation: number) =>
    this.alive && this.foreground && this.generation === generation;
  refresh = async () => {
    if (!this.session || !this.alive || !this.foreground) return;
    this.read?.abort();
    const controller = new AbortController();
    this.read = controller;
    const generation = this.generation,
      write = this.write;
    this.reading = true;
    this.notify();
    try {
      const value = await this.session.outputVoiceSettings(controller.signal);
      if (
        !this.owns(generation) ||
        controller.signal.aborted ||
        write !== this.write
      )
        return;
      if (
        value &&
        (value.scope.userId !== this.userId ||
          value.scope.workspaceId !== this.workspaceId)
      )
        throw Error("output_voice_context_changed");
      if (value && this.snapshot && value.revision < this.snapshot.revision)
        return;
      this.snapshot = value;
      if (
        this.pending &&
        value &&
        (sameIntent(value, this.pending.choice) ||
          value.revision > this.pending.expectedRevision ||
          value.catalogueRevision !== this.pending.catalogueRevision)
      ) {
        this.pending = undefined;
        this.issue = undefined;
      }
    } catch (error) {
      if (this.owns(generation) && !controller.signal.aborted) {
        if (
          error instanceof Error &&
          [
            "session_stopped",
            "auth_expired",
            "output_voice_context_changed",
          ].includes(error.message)
        ) {
          this.snapshot = undefined;
          this.pending = undefined;
        }
        this.issue = this.pending
          ? "outputVoiceSaveFailed"
          : "outputVoiceLoadFailed";
      }
    } finally {
      if (this.owns(generation) && this.read === controller) {
        this.reading = false;
        this.notify();
      }
    }
  };
  abandon = () => {
    this.generation++;
    this.saving = false;
    this.read?.abort();
    this.saveRequest?.abort();
    this.pending = undefined;
  };
  mount = () => {
    this.alive = true;
    this.foreground =
      typeof document === "undefined" || document.visibilityState !== "hidden";
    void this.refresh();
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        this.foreground = false;
        this.abandon();
        this.snapshot = undefined;
        this.busy = false;
        this.notify();
      } else {
        this.foreground = true;
        void this.refresh();
      }
    };
    if (typeof document !== "undefined") {
      if (document.visibilityState === "hidden") {
        this.foreground = false;
        this.abandon();
      }
      document.addEventListener("visibilitychange", visibility);
    }
    const unsubscribe = this.session?.subscribe(() => {
      if (this.session?.getSnapshot().status === "unauthorized") {
        this.abandon();
        this.snapshot = undefined;
        this.busy = false;
        this.issue = "outputVoiceLoadFailed";
        this.notify();
      }
    });
    return () => {
      this.alive = false;
      this.abandon();
      unsubscribe?.();
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visibility);
    };
  };
  async save(choice: OutputVoiceChoice, retry?: OutputVoiceUpdate) {
    const snapshot = this.snapshot;
    if (
      !this.session ||
      !snapshot ||
      this.busy ||
      !this.alive ||
      !this.foreground ||
      (this.pending && !retry)
    )
      return;
    if (!retry && sameIntent(snapshot, choice)) return;
    const update = retry ?? {
      profile: OUTPUT_VOICE_PROFILE,
      requestId: crypto.randomUUID(),
      expectedRevision: snapshot.revision,
      catalogueRevision: snapshot.catalogueRevision,
      choice,
    };
    const generation = ++this.generation;
    this.write++;
    this.read?.abort();
    this.reading = false;
    const controller = new AbortController();
    this.saveRequest = controller;
    this.busy = true;
    this.saving = true;
    this.pending = update;
    this.issue = undefined;
    this.notify();
    try {
      const value = await this.session.saveOutputVoiceSettings(
        update,
        controller.signal,
      );
      if (!this.owns(generation) || controller.signal.aborted) return;
      if (
        value.scope.userId !== this.userId ||
        value.scope.workspaceId !== this.workspaceId
      )
        throw Error("output_voice_context_changed");
      if (value.revision < (this.snapshot?.revision ?? 0)) return;
      this.snapshot = value;
      this.pending = undefined;
    } catch (error) {
      if (!this.owns(generation) || controller.signal.aborted) return;
      this.saving = false;
      const message = error instanceof Error ? error.message : "";
      if (
        [
          "session_stopped",
          "auth_expired",
          "output_voice_context_changed",
        ].includes(message)
      ) {
        this.snapshot = undefined;
        this.pending = undefined;
        this.issue = "outputVoiceLoadFailed";
      } else if (
        [
          "output_voice_conflict",
          "output_voice_catalogue_changed",
          "output_voice_choice_unavailable",
        ].includes(message)
      ) {
        this.pending = undefined;
        this.issue = "outputVoiceConflict";
        await this.refresh();
      } else if (
        [
          "invalid_payload",
          "output_voice_profile_unsupported",
          "auth_expired",
        ].includes(message)
      ) {
        this.pending = undefined;
        this.issue = "outputVoiceSaveFailed";
      } else {
        this.issue = "outputVoiceUnknown";
        await this.refresh();
      }
    } finally {
      if (this.owns(generation)) {
        this.busy = false;
        this.saving = false;
        this.notify();
      }
    }
  }
}

function sameIntent(snapshot: OutputVoiceSnapshot, choice: OutputVoiceChoice) {
  if (
    !snapshot.saved &&
    snapshot.revision > 0 &&
    ["saved-choice-unavailable", "speech-unavailable"].includes(
      snapshot.effective.reason,
    )
  )
    return false;
  const saved = snapshot.saved?.choice ?? { kind: "server-default" };
  return (
    saved.kind === choice.kind &&
    (saved.kind === "server-default" ||
      (choice.kind === "catalogue" && saved.optionId === choice.optionId))
  );
}

import { useId, useState } from "react";
import { Button } from "@admin/components/ui/button";
import { Checkbox } from "@admin/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@admin/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@admin/components/ui/field";
import { Input } from "@admin/components/ui/input";
import type { MeetingsCopy } from "./meetings-copy";

export type SpeakerChoice = {
  name: string | null;
  self: boolean;
  rememberVoice: boolean;
};

/**
 * Names one diarized voice of a meeting, or marks it as the owner's own.
 * Mount it keyed by the voice, so each opening starts from that voice.
 * Only then can the owner also have Niaro recognize their voice later; a
 * kept fingerprint can be forgotten here too.
 */
export function MeetingSpeakerDialog({
  voice,
  label,
  name,
  self,
  remembered,
  diarization,
  copy,
  formatDate,
  onSave,
  onForget,
  onClose,
}: {
  /** The voice being named, or null when the dialog is closed. */
  voice: number | null;
  /** How the voice reads now ("Speaker 2"). */
  label: string;
  name: string | null;
  self: boolean;
  /** When the owner's voice fingerprint was kept; null without one. */
  remembered: string | null;
  /** Remembering needs the diarizer and the meeting's sound. */
  diarization: boolean;
  copy: MeetingsCopy;
  formatDate(iso: string): string;
  onSave(choice: SpeakerChoice): Promise<void>;
  onForget(): Promise<void>;
  onClose(): void;
}) {
  const id = useId();
  const [value, setValue] = useState(name ?? "");
  const [isSelf, setSelf] = useState(self);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name: isSelf ? null : value.trim() || null,
        self: isSelf,
        rememberVoice: isSelf && remember,
      });
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error &&
          failure.message === "meeting_voice_too_short"
          ? copy.speakerTooShort
          : copy.speakerFailed,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={voice !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.speakerTitle}</DialogTitle>
          <DialogDescription>
            {label} · {copy.speakerHint}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {!isSelf && (
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>{copy.speakerName}</FieldLabel>
              <Input
                id={`${id}-name`}
                autoFocus
                value={value}
                maxLength={80}
                disabled={busy}
                onChange={(event) => setValue(event.target.value)}
              />
            </Field>
          )}
          <Field orientation="horizontal">
            <Checkbox
              id={`${id}-self`}
              checked={isSelf}
              disabled={busy}
              onCheckedChange={(checked) => setSelf(checked === true)}
            />
            <FieldLabel htmlFor={`${id}-self`}>{copy.speakerIsMe}</FieldLabel>
          </Field>
          {isSelf && diarization && (
            <Field orientation="horizontal">
              <Checkbox
                id={`${id}-remember`}
                checked={remember}
                disabled={busy}
                onCheckedChange={(checked) => setRemember(checked === true)}
              />
              <FieldContent>
                <FieldLabel htmlFor={`${id}-remember`}>
                  {copy.speakerRemember}
                </FieldLabel>
                <FieldDescription>{copy.speakerRememberHint}</FieldDescription>
              </FieldContent>
            </Field>
          )}
          {remembered && (
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              {copy.speakerRemembered(formatDate(remembered))}
              <Button
                type="button"
                variant="link"
                size="xs"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onForget().finally(() => setBusy(false));
                }}
              >
                {copy.speakerForget}
              </Button>
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy ? copy.speakerSaving : copy.speakerSave}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { Copy } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
import { DetailList, SubmitButton } from "@admin/components/console/forms";
import { api, ApiError } from "./lib/api";
import { useMcpCopy } from "./mcp-copy";
import { validMcpCallback } from "./mcp-consent";

const RegisteredSchema = z.object({
  clientId: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  redirectUris: z.array(z.url().max(2048)).min(1).max(10),
});
export function McpOAuthClient() {
  const copy = useMcpCopy();
  const id = useId();
  const [name, setName] = useState("");
  const [callback, setCallback] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [registered, setRegistered] = useState<z.infer<
    typeof RegisteredSchema
  > | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const nameValid = name.trim().length > 0 && name.trim().length <= 100;
  const callbackValid =
    callback.trim().length <= 2048 && validMcpCallback(callback.trim());
  async function register(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!nameValid || !callbackValid || pending || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    setRegistered(null);
    setCopied(null);
    try {
      const value = RegisteredSchema.parse(
        await api(
          "identity/mcp/oauth/client/register",
          { name: name.trim(), redirectUris: [callback.trim()] },
          controller.signal,
        ),
      );
      if (!controller.signal.aborted) {
        setRegistered(value);
        setName("");
        setCallback("");
        setSubmitted(false);
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof ApiError && cause.status === 401
            ? copy.authError
            : cause instanceof ApiError && cause.status === 403
              ? copy.registerForbidden
              : copy.failed,
        );
    } finally {
      if (!controller.signal.aborted) {
        setPending(false);
        request.current = null;
      }
    }
  }
  return (
    <div className="flex flex-col gap-4 pt-1 pb-2">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {registered ? (
        <div className="flex flex-col gap-3">
          <DetailList
            stacked
            items={[
              { label: copy.label, value: registered.name },
              {
                label: copy.clientId,
                value: (
                  <code className="break-all font-mono text-xs">
                    {registered.clientId}
                  </code>
                ),
              },
              { label: copy.callback, value: registered.redirectUris[0] },
            ]}
          />
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(registered.clientId);
                setCopied(copy.copied);
              } catch {
                setCopied(copy.copyFailed);
              }
            }}
          >
            <Copy data-icon="inline-start" aria-hidden="true" />
            {copy.copyClientId}
          </Button>
          {copied ? (
            <p role="status" className="text-sm text-muted-foreground">
              {copied}
            </p>
          ) : null}
        </div>
      ) : null}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => void register(event)}
      >
        <FieldGroup>
          <Field data-invalid={submitted && !nameValid} data-disabled={pending}>
            <FieldLabel htmlFor={`${id}-name`}>{copy.label}</FieldLabel>
            <Input
              id={`${id}-name`}
              autoComplete="off"
              value={name}
              maxLength={100}
              disabled={pending}
              aria-invalid={submitted && !nameValid}
              onChange={(event) => setName(event.target.value)}
            />
            {submitted && !nameValid ? (
              <FieldError>{copy.labelInvalid}</FieldError>
            ) : null}
          </Field>
          <Field
            data-invalid={submitted && !callbackValid}
            data-disabled={pending}
          >
            <FieldLabel htmlFor={`${id}-callback`}>{copy.callback}</FieldLabel>
            <Input
              id={`${id}-callback`}
              type="url"
              autoComplete="off"
              value={callback}
              maxLength={2048}
              disabled={pending}
              aria-invalid={submitted && !callbackValid}
              onChange={(event) => setCallback(event.target.value)}
            />
            <FieldDescription>{copy.callbackHint}</FieldDescription>
            {submitted && !callbackValid ? (
              <FieldError>{copy.callbackInvalid}</FieldError>
            ) : null}
          </Field>
        </FieldGroup>
        <SubmitButton
          pending={pending}
          variant="outline"
          className="self-start"
        >
          {copy.register}
        </SubmitButton>
      </form>
    </div>
  );
}

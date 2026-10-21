import { useId, useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@admin/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@admin/components/ui/input-group";

/** A one-time link the administrator passes on by hand: read-only, with copy. */
export function CopyLinkField({
  label,
  value,
  description,
  copy,
}: {
  label: string;
  value: string;
  description?: string;
  copy: { copy: string; copied: string; copyFailed: string };
}) {
  const id = useId();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function write() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          value={value}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={state === "copied" ? copy.copied : copy.copy}
            onClick={() => void write()}
          >
            {state === "copied" ? <Check /> : <Copy />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <span className="sr-only" role="status">
        {state === "copied" ? copy.copied : ""}
      </span>
      {state === "failed" ? (
        <FieldError>{copy.copyFailed}</FieldError>
      ) : (
        description && <FieldDescription>{description}</FieldDescription>
      )}
    </Field>
  );
}

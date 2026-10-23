import { Fragment, useEffect, useId, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  FormNameContext,
  FormValidationContext,
  useCreateFormValidation,
  useFormName,
  useFormValidation,
  useGetFieldValue,
  useIsStreaming,
  useSetDefaultValue,
  useSetFieldValue,
  useStateField,
  useTriggerAction,
  type ActionPlan,
} from "@openuidev/react-lang";
import { Button as ActionButton } from "@admin/components/ui/button";
import { Checkbox as CheckboxControl } from "@admin/components/ui/checkbox";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
import { Input } from "@admin/components/ui/input";
import {
  Select as SelectControl,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import {
  followUpKey,
  type FollowUpField,
} from "../../../../../packages/openui-library/follow-up";
import { GENERATIVE_UI_LIMITS } from "../../../../../packages/openui-library/spec";
import { useChatCopy } from "../chat-copy";
import { elements, text, useGeneratedUiScope, type View } from "./scope";

const plan = (action: unknown): ActionPlan | undefined =>
  action &&
  typeof action === "object" &&
  Array.isArray((action as ActionPlan).steps)
    ? (action as ActionPlan)
    : undefined;
/** Runs a button's steps as react-lang's own components do. A follow-up in a
 * form first checks its required fields. Nothing runs in a read-only chat. */
function useAction(label: string, action: unknown) {
  const trigger = useTriggerAction();
  const formName = useFormName();
  const validation = useFormValidation();
  const streaming = useIsStreaming();
  const { disabled } = useGeneratedUiScope();
  const steps = plan(action);
  const off = disabled || streaming;
  const run = () => {
    if (off) return;
    const followUp =
      !steps ||
      steps.steps.some((step) => step.type === "continue_conversation");
    if (followUp && validation && !validation.validateForm()) return;
    void trigger(label, formName, steps);
  };
  return { off, run };
}

export const Button: View<{
  label: string;
  action: unknown;
  variant: "primary" | "secondary";
}> = ({ props }) => {
  const label = text(props.label);
  const { off, run } = useAction(label, props.action);
  if (!label) return null;
  return (
    <ActionButton
      type="button"
      variant={props.variant === "primary" ? "default" : "outline"}
      disabled={off}
      className="self-start"
      onClick={run}
    >
      {label}
    </ActionButton>
  );
};
/** A row of buttons; only the first primary one stays primary. */
export const Buttons: View<{ buttons: unknown[] }> = ({
  props,
  renderNode,
}) => {
  const buttons = elements(props.buttons);
  const primary = buttons.findIndex(
    (button) => button.props.variant === "primary",
  );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {buttons.map((button, index) => (
        <Fragment key={index}>
          {renderNode({
            ...button,
            props: {
              ...button.props,
              variant: index === primary ? "primary" : "secondary",
            },
          })}
        </Fragment>
      ))}
    </div>
  );
};
/** A list row's action: a quiet button named by the row. */
export function ItemAction({
  label,
  action,
}: {
  label: string;
  action: unknown;
}) {
  const { off, run } = useAction(label, action);
  return (
    <ActionButton
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      disabled={off}
      onClick={run}
    >
      <ChevronRight aria-hidden="true" />
    </ActionButton>
  );
}

/** The person's answers stay local; a button's follow-up quotes them. */
export const Form: View<{
  name: string;
  fields: unknown[];
  buttons: unknown;
}> = ({ props, renderNode }) => {
  const validation = useCreateFormValidation();
  return (
    <FormNameContext.Provider value={text(props.name) || undefined}>
      <FormValidationContext.Provider value={validation}>
        <form
          noValidate
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => event.preventDefault()}
        >
          <FieldGroup>{renderNode(props.fields)}</FieldGroup>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {renderNode(props.buttons)}
          </div>
        </form>
      </FormValidationContext.Provider>
    </FormNameContext.Provider>
  );
};

/**
 * One form value: a `$variable` binding or the form's own state. Bound
 * values are mirrored into the form so a follow-up quotes them; the label
 * is registered for the same reason.
 */
function useFormField<T>(
  name: string,
  label: string,
  kind: FollowUpField["kind"],
  value: unknown,
  required: boolean,
) {
  const formName = useFormName();
  const field = useStateField<unknown>(name, value);
  const getFieldValue = useGetFieldValue();
  const setFieldValue = useSetFieldValue();
  const validation = useFormValidation();
  const streaming = useIsStreaming();
  const { disabled, fields } = useGeneratedUiScope();
  const key = followUpKey(formName, name);
  useEffect(() => {
    fields.set(key, { label, kind });
    return () => {
      fields.delete(key);
    };
  }, [fields, key, label, kind]);
  useSetDefaultValue({
    formName,
    componentType: kind,
    name,
    existingValue: getFieldValue(formName, name),
    // An unticked box is an answer too: "no".
    defaultValue: field.value ?? (kind === "checkbox" ? false : undefined),
  });
  const register = validation?.registerField;
  const unregister = validation?.unregisterField;
  useEffect(() => {
    if (!register || !unregister || !required) return;
    register(name, [{ type: "required" }], () => getFieldValue(formName, name));
    return () => unregister(name);
  }, [register, unregister, required, name, formName, getFieldValue]);
  return {
    value: field.value as T | undefined,
    set: (next: T) => {
      field.setValue(next);
      if (field.isReactive) setFieldValue(formName, kind, name, next, false);
      validation?.clearFieldError(name);
    },
    off: disabled || streaming,
    invalid: !!validation?.getFieldError(name),
  };
}

type InputProps = {
  name: string;
  label: string;
  value: unknown;
  required: boolean;
};
function FieldFrame({
  id,
  label,
  required,
  invalid,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  invalid: boolean;
  children: ReactNode;
}) {
  const { copy } = useChatCopy();
  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {required && <span aria-hidden="true">*</span>}
      </FieldLabel>
      {children}
      {invalid && <FieldError>{copy.required}</FieldError>}
    </Field>
  );
}

export const TextField: View<InputProps & { placeholder: string }> = ({
  props,
}) => {
  const id = useId();
  const label = text(props.label);
  const field = useFormField<string>(
    text(props.name),
    label,
    "text",
    props.value,
    !!props.required,
  );
  return (
    <FieldFrame
      id={id}
      label={label}
      required={props.required}
      invalid={field.invalid}
    >
      <Input
        id={id}
        value={typeof field.value === "string" ? field.value : ""}
        placeholder={text(props.placeholder) || undefined}
        maxLength={GENERATIVE_UI_LIMITS.text}
        required={!!props.required}
        aria-invalid={field.invalid || undefined}
        disabled={field.off}
        onChange={(event) => field.set(event.target.value)}
      />
    </FieldFrame>
  );
};
export const DateField: View<InputProps> = ({ props }) => {
  const id = useId();
  const label = text(props.label);
  const field = useFormField<string>(
    text(props.name),
    label,
    "date",
    props.value,
    !!props.required,
  );
  return (
    <FieldFrame
      id={id}
      label={label}
      required={props.required}
      invalid={field.invalid}
    >
      <Input
        id={id}
        type="date"
        value={typeof field.value === "string" ? field.value : ""}
        required={!!props.required}
        aria-invalid={field.invalid || undefined}
        disabled={field.off}
        onChange={(event) => field.set(event.target.value)}
      />
    </FieldFrame>
  );
};
export const Select: View<InputProps & { options: string[] }> = ({ props }) => {
  const id = useId();
  const label = text(props.label);
  const field = useFormField<string>(
    text(props.name),
    label,
    "select",
    props.value,
    !!props.required,
  );
  // An empty choice cannot be an item; it reads as "nothing chosen".
  const options = [...new Set((props.options ?? []).map(text))].filter(Boolean);
  return (
    <FieldFrame
      id={id}
      label={label}
      required={props.required}
      invalid={field.invalid}
    >
      <SelectControl
        value={typeof field.value === "string" ? field.value : ""}
        disabled={field.off}
        onValueChange={field.set}
      >
        <SelectTrigger
          id={id}
          aria-invalid={field.invalid || undefined}
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectControl>
    </FieldFrame>
  );
};
export const Checkbox: View<Omit<InputProps, "required">> = ({ props }) => {
  const id = useId();
  const label = text(props.label);
  const field = useFormField<boolean>(
    text(props.name),
    label,
    "checkbox",
    props.value,
    false,
  );
  return (
    <Field orientation="horizontal">
      <CheckboxControl
        id={id}
        checked={field.value === true}
        disabled={field.off}
        onCheckedChange={(checked) => field.set(checked === true)}
      />
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
    </Field>
  );
};

import type { FormEvent } from "react";
import { Input } from "@admin/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@admin/components/ui/field";
import type { Copy } from "./i18n";
import { ApiError, errorMessage } from "./lib/api";

/** The copy key for a failed account or organization request. */
export function issue(error: unknown): keyof Copy {
  if (error instanceof ApiError) {
    if (error.code === "workspace_role_in_use") return "workspaceRoleInUse";
    if (error.code === "catalog_conflict") return "workspaceRoleConflict";
    if (error.code === "workspace_role_exists") return "workspaceRoleExists";
    if (error.code === "identity_last_owner") return "lastOwnerError";
    if (error.status === 403) return "forbiddenError";
    if (error.status === 409) return "conflictError";
    if (error.status === 400) return "inputError";
  }
  return errorMessage(error);
}
/** Name, email and password; with `setup`, the organization name first. */
export function AccountInputs({
  copy,
  setup = false,
}: {
  copy: Copy;
  setup?: boolean;
}) {
  return (
    <>
      {setup && (
        <Field>
          <FieldLabel htmlFor="organization-name">
            {copy.organizationName}
          </FieldLabel>
          <Input
            id="organization-name"
            name="organizationName"
            maxLength={100}
            required
          />
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="account-name">{copy.name}</FieldLabel>
        <Input
          id="account-name"
          name="name"
          autoComplete="name"
          maxLength={100}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="account-email">{copy.email}</FieldLabel>
        <Input
          id="account-email"
          name="email"
          type="email"
          autoComplete="username"
          maxLength={254}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="account-password">{copy.password}</FieldLabel>
        <Input
          id="account-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          aria-describedby="password-hint"
          required
        />
        <FieldDescription id="password-hint">
          {copy.passwordHint}
        </FieldDescription>
      </Field>
    </>
  );
}
export function formValues(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const password = event.currentTarget.elements.namedItem("password");
  if (password instanceof HTMLInputElement) password.value = "";
  return values;
}

import { useQuery } from "@tanstack/react-query";
import { Checkbox } from "@admin/components/ui/checkbox";
import { Field, FieldLabel } from "@admin/components/ui/field";
import { PersonalApprovalOption } from "../../../../packages/protocol/service-oauth";
import { api } from "../lib/api";
import { useChatCopy } from "./chat-copy";

export type RememberTarget = { organizationId: string; workspaceId: string };

/**
 * "Don't ask next time" beside an approval, only for a change the person makes
 * under their own account in a personal-sign-in service. The server decides
 * from the operation; the card carries no service or action of its own.
 */
export function RememberApproval({
  target,
  operationId,
  checked,
  disabled,
  onCheckedChange,
}: {
  target: RememberTarget;
  operationId: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange(checked: boolean): void;
}) {
  const { copy } = useChatCopy();
  const option = useQuery({
    queryKey: [
      "app",
      "approval-option",
      target.organizationId,
      target.workspaceId,
      operationId,
    ],
    queryFn: async ({ signal }) =>
      PersonalApprovalOption.parse(
        await api(
          "identity/catalog/oauth/approval",
          {
            organizationId: target.organizationId,
            workspaceId: target.workspaceId,
            operationId,
          },
          signal,
        ),
      ),
    retry: false,
    staleTime: 60_000,
  });
  if (!option.data?.available) return null;
  const id = `remember-${operationId}`;
  return (
    <Field orientation="horizontal" className="w-auto">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <FieldLabel htmlFor={id}>{copy.serviceRemember}</FieldLabel>
    </Field>
  );
}

/** Saves the choice once the approval itself was sent. */
export function rememberApproval(target: RememberTarget, operationId: string) {
  return api("identity/catalog/oauth/approval/remember", {
    organizationId: target.organizationId,
    workspaceId: target.workspaceId,
    operationId,
  });
}

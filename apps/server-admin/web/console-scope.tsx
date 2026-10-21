import { useId } from "react";
import { Field, FieldGroup, FieldLabel } from "@admin/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import { useShellCopy } from "./shell-copy";
import { useQuery } from "@tanstack/react-query";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../../../packages/protocol/identity";
import { useAdmin } from "./context";
import { api } from "./lib/api";
export function useConsoleScope() {
  const { data, selectedOrganization, selectedWorkspace } = useAdmin();
  const identity = useQuery({
    queryKey: [
      "admin",
      "identity",
      data.authentication.current,
      data.authentication.principalId,
    ],
    queryFn: async ({ signal }) =>
      IdentityStateSchema.parse(await api("identity", undefined, signal)),
    enabled: data.authentication.identityEnabled,
    staleTime: 15000,
    refetchInterval: 15000,
  });
  const organization =
    identity.data?.organizations.find((o) => o.id === selectedOrganization) ??
    identity.data?.organizations[0];
  const detail = useQuery({
    queryKey: [
      "admin",
      "organization",
      identity.data?.user?.id,
      organization?.id,
    ],
    queryFn: async ({ signal }) =>
      OrganizationDetailSchema.parse(
        await api(
          `identity/organization?id=${encodeURIComponent(organization!.id)}`,
          undefined,
          signal,
        ),
      ),
    enabled: !!organization && !identity.isError,
    staleTime: 15000,
    refetchInterval: 15000,
  });
  const workspace =
    detail.data?.workspaces.find((w) => w.id === selectedWorkspace) ??
    detail.data?.workspaces[0];
  return {
    identity,
    detail,
    organization,
    workspace,
    ready:
      !!organization && !!workspace && !identity.isError && !detail.isError,
  };
}

/** Organization + workspace choice for standalone pages outside the shell. */
export function ScopePicker() {
  const scope = useConsoleScope();
  const copy = useShellCopy();
  const { setSelectedOrganization, setSelectedWorkspace } = useAdmin();
  const id = useId();
  if (!scope.organization) return null;
  const organizations = scope.identity.data?.organizations ?? [];
  const workspaces = scope.detail.data?.workspaces ?? [];
  return (
    <FieldGroup>
      {organizations.length > 1 && (
        <Field>
          <FieldLabel htmlFor={`${id}-org`}>
            {copy.groupOrganization}
          </FieldLabel>
          <Select
            value={scope.organization.id}
            onValueChange={setSelectedOrganization}
          >
            <SelectTrigger id={`${id}-org`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {organizations.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {scope.workspace && (
        <Field>
          <FieldLabel htmlFor={`${id}-workspace`}>
            {copy.groupWorkspace}
          </FieldLabel>
          <Select
            value={scope.workspace.id}
            onValueChange={setSelectedWorkspace}
          >
            <SelectTrigger id={`${id}-workspace`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {workspaces.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
    </FieldGroup>
  );
}

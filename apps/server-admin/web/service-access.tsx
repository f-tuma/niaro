import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@admin/components/ui/button";
import { Checkbox } from "@admin/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@admin/components/ui/field";
import { SaveBar, SubmitButton } from "@admin/components/console/forms";
import { Card, CardContent } from "@admin/components/ui/card";
import { Section } from "@admin/components/console/page";
import { StatusBadge } from "@admin/components/console/status";
import { WorkspaceRolePicker } from "./workspace-roles";
import { useAdmin } from "./context";
import { serviceSettings, type CatalogState } from "./catalog-shared";
import type { Service } from "../../../packages/protocol/service-catalog";

export function ServiceAccess({
  state,
  service,
  personal = false,
}: {
  state: CatalogState;
  service: Service;
  /** People use it with their own account: this gate decides who may connect. */
  personal?: boolean;
}) {
  const { language } = useAdmin();
  const cs = language === "cs";
  const [initial] = useState<NonNullable<Service["access"]>>(
    () =>
      service.access ?? {
        roles: ["owner", "admin", "member"],
        workspaceRoles: [],
      },
  );
  const [access, setAccess] = useState(initial);
  const dirty = JSON.stringify(access) !== JSON.stringify(initial);
  const roles = state.scope.workspace?.roles ?? [];
  const manage = state.query.data?.canManage === true;
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={async (event) => {
        event.preventDefault();
        await state.mutate("command", {
          type: "saveService",
          id: service.id,
          revision: service.revision,
          settings: { ...serviceSettings(service), access },
        });
      }}
    >
      <Section
        title={
          personal
            ? state.copy.whoCanConnect
            : cs
              ? "Kdo může službu používat"
              : "Who can use this service"
        }
        actions={
          manage &&
          roles.length > 0 && (
            <Button asChild variant="ghost" size="sm">
              <Link to="/workspaces">
                {cs ? "Spravovat role" : "Manage roles"}
              </Link>
            </Button>
          )
        }
      >
        <Card>
          <CardContent>
            <fieldset
              disabled={!manage || state.busy}
              className="flex flex-col gap-6"
            >
              <FieldSet>
                <FieldLegend>
                  {cs ? "Role organizace" : "Organization roles"}
                </FieldLegend>
                <FieldGroup className="sm:flex-row sm:flex-wrap">
                  {(["owner", "admin", "member"] as const).map((role) => (
                    <Field
                      key={role}
                      orientation="horizontal"
                      className="w-auto"
                    >
                      <Checkbox
                        id={`service-access-${role}`}
                        checked={access.roles.includes(role)}
                        onCheckedChange={(checked) =>
                          setAccess({
                            ...access,
                            roles:
                              checked === true
                                ? [...access.roles, role]
                                : access.roles.filter((r) => r !== role),
                          })
                        }
                      />
                      <FieldLabel htmlFor={`service-access-${role}`}>
                        {state.copy[role]}
                      </FieldLabel>
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
              <WorkspaceRolePicker
                roles={roles}
                value={access.workspaceRoles}
                onChange={(workspaceRoles) =>
                  setAccess({ ...access, workspaceRoles })
                }
              />
              {!access.roles.length && !access.workspaceRoles.length && (
                <StatusBadge tone="warning">
                  {cs ? "Zablokováno pro všechny" : "Blocked for everyone"}
                </StatusBadge>
              )}
            </fieldset>
          </CardContent>
        </Card>
      </Section>
      {manage && (dirty || state.busy) && (
        <SaveBar status={state.copy.unsavedChanges}>
          <Button
            type="button"
            variant="ghost"
            disabled={state.busy}
            onClick={() => setAccess(initial)}
          >
            {state.copy.discardChanges}
          </Button>
          <SubmitButton
            pending={state.busy}
            disabled={state.conflict || state.query.isError}
          >
            {state.copy.save}
          </SubmitButton>
        </SaveBar>
      )}
    </form>
  );
}

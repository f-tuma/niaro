import { useEffect, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Pencil, Workflow } from "lucide-react";
import type {
  Service,
  ServiceAction,
} from "../../../packages/protocol/service-catalog";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import { Progress } from "@admin/components/ui/progress";
import { Textarea } from "@admin/components/ui/textarea";
import { Field, FieldLabel } from "@admin/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@admin/components/ui/empty";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Section } from "@admin/components/console/page";
import { DetailList, SubmitButton } from "@admin/components/console/forms";
import { StatusDot } from "@admin/components/console/status";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { serviceSettings, type CatalogState } from "./catalog-shared";
import { ModelSelect } from "./catalog-providers";
import { useAdmin } from "./context";
import { designCs, designEn } from "./process-design-copy";
import { useWorkspaceProcesses } from "./service-process-overview";
import { useServiceSetupCopy, serviceTabSchema } from "./service-setup-copy";
import { ServiceChecklist } from "./service-checklist";

/** How many actions and processes the overview previews before "View all". */
const preview = 5;

export function ServiceSetupOverview({
  state,
  service,
  onTab,
  onAction,
  onEditConnection,
  onDiscover,
  onCreateProcess,
}: {
  state: CatalogState;
  service: Service;
  onTab: (tab: z.infer<typeof serviceTabSchema>) => void;
  onAction: (action: ServiceAction) => void;
  onEditConnection: () => void;
  onDiscover: () => void;
  onCreateProcess: () => void;
}) {
  const copy = useServiceSetupCopy(),
    { copy: catalog } = state,
    processCopy = useAdmin().language === "cs" ? designCs : designEn,
    canManage = !!state.query.data?.canManage;
  const [editing, setEditing] = useState(false);
  const processes = useWorkspaceProcesses(state).data?.filter(
    (p) => p.serviceId === service.id,
  );
  const enabled = service.actions
    .filter((a) => a.enabled)
    .sort((a, b) => a.name.localeCompare(b.name));
  const workspaceRoles = state.scope.workspace?.roles ?? [];
  const access = service.access ?? {
    roles: ["owner", "admin", "member"] as const,
    workspaceRoles: [],
  };
  const accessLabel =
    access.roles.length === 3
      ? catalog.everyone
      : [
          ...access.roles.map((r) => catalog[r]),
          ...access.workspaceRoles.map(
            (id) => workspaceRoles.find((r) => r.id === id)?.name ?? id,
          ),
        ].join(", ") || catalog.noAccess;
  // The setup checklist covers the connection; then the first process.
  const next =
    canManage &&
    service.enabled &&
    enabled.length &&
    processes &&
    !processes.length
      ? {
          icon: <Workflow />,
          title: copy.stepProcess,
          label: copy.createProcess,
          run: onCreateProcess,
          // The header's assistant button turns secondary once actions are on.
          primary: true,
        }
      : null;
  return (
    <div
      data-service-overview
      className="grid min-w-0 gap-8 xl:grid-cols-3 xl:gap-12"
    >
      <div className="flex min-w-0 flex-col gap-8 xl:col-span-2">
        {canManage && (
          <ServiceChecklist
            state={state}
            service={service}
            who={accessLabel}
            onEditConnection={onEditConnection}
            onDiscover={onDiscover}
            onTab={onTab}
          />
        )}
        {next && <NextStep {...next} />}
        <Section
          title={copy.purpose}
          actions={
            canManage && (
              <EditButton
                label={copy.editPurpose}
                onClick={() => {
                  state.setError(null);
                  setEditing(true);
                }}
              >
                {catalog.edit}
              </EditButton>
            )
          }
        >
          {service.description ? (
            <p className="text-sm text-pretty break-words">
              {service.description}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{copy.noPurpose}</p>
          )}
        </Section>
        <Section
          title={catalog.actions}
          actions={
            service.actions.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onTab("actions")}
              >
                {copy.viewAll}
                <ChevronRight data-icon="inline-end" aria-hidden="true" />
              </Button>
            )
          }
        >
          {service.actions.length ? (
            <Card variant="list">
              <div className="flex min-h-11 items-center gap-3 px-4 py-2">
                <span className="text-sm tabular-nums">
                  <span className="font-medium">{enabled.length}</span>{" "}
                  {copy.enabledOf} {service.actions.length} {copy.enabledSuffix}
                </span>
                <Progress
                  className="ml-auto w-24"
                  aria-label={catalog.actions}
                  value={Math.round(
                    (enabled.length / service.actions.length) * 100,
                  )}
                />
              </div>
              {enabled.slice(0, preview).map((action) => (
                <Item key={action.id} asChild variant="row" size="row">
                  <button type="button" onClick={() => onAction(action)}>
                    <ItemContent>
                      <ItemTitle>{action.name}</ItemTitle>
                      {action.description && (
                        <ItemDescription>{action.description}</ItemDescription>
                      )}
                    </ItemContent>
                    {action.effect === "write" && (
                      <ItemActions>
                        <span className="text-xs text-muted-foreground">
                          {catalog.write}
                        </span>
                      </ItemActions>
                    )}
                  </button>
                </Item>
              ))}
            </Card>
          ) : (
            <Empty variant="outline">
              <EmptyHeader>
                <EmptyTitle>{catalog.noActions}</EmptyTitle>
              </EmptyHeader>
              {canManage && (
                <EmptyContent>
                  <Button variant="outline" onClick={onDiscover}>
                    {catalog.discover}
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          )}
        </Section>
        {processes && (
          <Section
            title={processCopy.processes}
            count={processes.length}
            actions={
              processes.length > preview && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onTab("processes")}
                >
                  {copy.viewAll}
                  <ChevronRight data-icon="inline-end" aria-hidden="true" />
                </Button>
              )
            }
          >
            {processes.length ? (
              <Card variant="list">
                {processes.slice(0, preview).map((process) => (
                  <Item key={process.id} asChild variant="row" size="row">
                    <Link
                      to="/services/$serviceId/processes/$processId"
                      params={{ serviceId: service.id, processId: process.id }}
                    >
                      <ItemContent>
                        <ItemTitle>{process.name}</ItemTitle>
                        <ItemDescription>
                          {processCopy[process.kind]}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        {!process.activeVersion && (
                          <StatusDot tone="neutral">
                            {processCopy.draft}
                          </StatusDot>
                        )}
                        <ChevronRight
                          aria-hidden="true"
                          className="size-4 text-muted-foreground"
                        />
                      </ItemActions>
                    </Link>
                  </Item>
                ))}
              </Card>
            ) : (
              <Empty variant="outline">
                <EmptyHeader>
                  <EmptyTitle>{processCopy.noProcesses}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
          </Section>
        )}
      </div>
      <Section
        title={copy.details}
        actions={
          canManage && (
            <EditButton label={copy.editConnection} onClick={onEditConnection}>
              {catalog.edit}
            </EditButton>
          )
        }
      >
        <DetailList
          stacked
          items={[
            {
              label: copy.address,
              value: (
                <span className="font-mono text-xs break-all">
                  {service.url}
                </span>
              ),
            },
            {
              label: catalog.protocol,
              value: service.protocol === "openapi" ? "OpenAPI" : "MCP",
            },
            {
              label: copy.credential,
              value:
                service.auth.type === "none" ? (
                  copy.notRequired
                ) : service.hasCredential ? (
                  copy.stored
                ) : (
                  <StatusDot tone="warning">{copy.missing}</StatusDot>
                ),
            },
            {
              label: catalog.model,
              value: <ServiceModel state={state} service={service} />,
            },
            { label: catalog.access, value: accessLabel },
          ]}
        />
      </Section>
      {canManage && (
        <PurposeSheet
          state={state}
          service={service}
          open={editing}
          onOpenChange={setEditing}
        />
      )}
    </div>
  );
}

/** The one edit affordance of a section: a quiet pencil button. */
export function EditButton({
  label,
  onClick,
  children,
}: {
  /** Full name of the edit for assistive technology ("Edit purpose"). */
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant="ghost" size="sm" aria-label={label} onClick={onClick}>
      <Pencil data-icon="inline-start" aria-hidden="true" />
      {children}
    </Button>
  );
}

function NextStep({
  icon,
  title,
  label,
  run,
  primary = false,
}: {
  icon: ReactNode;
  title: string;
  label: string;
  run: () => void;
  primary?: boolean;
}) {
  return (
    <Item variant="outline" data-service-next-step>
      <ItemMedia>
        <EntityIcon>{icon}</EntityIcon>
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <Button
          size="sm"
          variant={primary ? "default" : "outline"}
          onClick={run}
        >
          {label}
        </Button>
      </ItemActions>
    </Item>
  );
}

/** Saves on choice: one field needs no save bar. */
function ServiceModel({
  state,
  service,
}: {
  state: CatalogState;
  service: Service;
}) {
  const { copy } = state;
  const routing = state.query.data!.routing;
  return (
    <ModelSelect
      state={state}
      hideLabel
      id="service-model"
      label={copy.model}
      fallback={copy.useDefault}
      value={service.modelId ?? ""}
      inheritedModelId={routing.modelId}
      showDefaultWarning
      onChange={(modelId) =>
        void state.mutate("command", {
          type: "saveRouting",
          routing: {
            ...routing,
            services: [
              ...routing.services.filter((s) => s.serviceId !== service.id),
              { serviceId: service.id, modelId: modelId || null },
            ],
          },
        })
      }
    />
  );
}

function PurposeSheet({
  state,
  service,
  open,
  onOpenChange,
}: {
  state: CatalogState;
  service: Service;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const copy = useServiceSetupCopy();
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!state.busy) onOpenChange(next);
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{copy.editPurpose}</SheetTitle>
        </SheetHeader>
        {open && (
          <PurposeForm
            state={state}
            service={service}
            close={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function PurposeForm({
  state,
  service,
  close,
}: {
  state: CatalogState;
  service: Service;
  close: () => void;
}) {
  const { copy: catalog } = state;
  const [value, setValue] = useState(service.description ?? "");
  const error = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.error) error.current?.focus();
  }, [state.error]);
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        const { description: _old, ...settings } = serviceSettings(service);
        void state
          .mutate("command", {
            type: "saveService",
            id: service.id,
            revision: service.revision,
            settings: value.trim()
              ? { ...settings, description: value.trim() }
              : settings,
          })
          .then((result) => {
            if (result) close();
          });
      }}
    >
      <fieldset
        disabled={state.busy}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4"
      >
        {state.error && (
          <Alert ref={error} tabIndex={-1} variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="service-purpose">
            {catalog.serviceDescription}
          </FieldLabel>
          <Textarea
            id="service-purpose"
            rows={5}
            maxLength={500}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
      </fieldset>
      <SheetFooter>
        <Button
          type="button"
          variant="outline"
          disabled={state.busy}
          onClick={() => close()}
        >
          {catalog.cancel}
        </Button>
        <SubmitButton
          pending={state.busy}
          disabled={value.trim() === (service.description ?? "")}
        >
          {catalog.save}
        </SubmitButton>
      </SheetFooter>
    </form>
  );
}

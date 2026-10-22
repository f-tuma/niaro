import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  ClipboardList,
  Plus,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@admin/components/ui/card";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
import { Input } from "@admin/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Textarea } from "@admin/components/ui/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import { EntityIcon } from "@admin/components/console/entity-icon";
import type { ClientSession } from "../../../../packages/client-core/session";
import {
  HUB_BRIEF_MAX,
  HUB_ITEM_LIMIT,
  HUB_SOURCES_MAX,
  HUB_TITLE_MAX,
  HubRefreshSchema,
  hubEligibleInput,
  type HubCard,
  type HubDashboardV3,
  type HubRefresh,
} from "../../../../packages/protocol/hub";
import {
  HUB_WIDGET_PRESETS,
  HUB_WIDGET_TYPES,
  hubWidgetConfig,
  hubWidgetDefinition,
  type HubWidgetDefinition,
  type HubWidgetPreset,
} from "../../../../packages/protocol/widgets";
import { useApp } from "./context";
import { useHubCopy, type HubCopy } from "./hub-copy";
import { widgetRenderer } from "./widgets";

/** What the gallery adds: a typed widget, Tasks or a process. */
export type HubAddChoice =
  | {
      kind: "widget";
      type: string;
      title?: string;
      brief?: string;
      config: Record<string, unknown>;
      sources: string[];
    }
  | { kind: "tasks" }
  | { kind: "process"; processId: string };
/** A typed widget's changes; only what differs from the item. */
export type HubWidgetEdit = {
  title?: string;
  refresh?: HubRefresh;
  brief?: string;
  config?: Record<string, unknown>;
  sources?: string[];
};

type Step =
  | { kind: "pick" }
  | { kind: "widget"; type: string; preset?: HubWidgetPreset }
  | { kind: "process" };

/**
 * Edit mode's "Add widget": the widget types with a preview of sample data,
 * ready-made requests, Tasks and processes. Choosing a type asks what to
 * show (its brief) and its few settings; the server then fills it.
 */
export function HubGallery({
  open,
  session,
  hub,
  disabled,
  onClose,
  onAdd,
}: {
  open: boolean;
  session: ClientSession;
  hub: HubDashboardV3;
  disabled: boolean;
  onClose: () => void;
  onAdd: (choice: HubAddChoice) => void;
}) {
  const copy = useHubCopy();
  const { language } = useApp();
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const close = () => {
    setStep({ kind: "pick" });
    onClose();
  };
  const add = (choice: HubAddChoice) => {
    setStep({ kind: "pick" });
    onAdd(choice);
  };
  const definition =
    step.kind === "widget" ? hubWidgetDefinition(step.type) : undefined;
  const hasTasks = hub.items.some((item) => item.kind === "tasks");
  const full = hub.items.length >= HUB_ITEM_LIMIT;
  const back = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={copy.back}
      onClick={() => setStep({ kind: "pick" })}
    >
      <ArrowLeft aria-hidden="true" />
    </Button>
  );
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <div className="flex items-center gap-1">
            {step.kind !== "pick" && back}
            <SheetTitle>
              {step.kind === "widget" && definition
                ? (step.preset?.name ?? definition.name)[language]
                : step.kind === "process"
                  ? copy.fromProcess
                  : copy.addTitle}
            </SheetTitle>
          </div>
        </SheetHeader>
        {step.kind === "pick" && (
          <div
            data-testid="hub-gallery"
            className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4"
          >
            <GallerySection label={copy.widgets}>
              {HUB_WIDGET_TYPES.map((type) => (
                <GalleryCard
                  key={type.type}
                  testId="gallery-type"
                  value={type.type}
                  definition={type}
                  name={type.name[language]}
                  description={type.description[language]}
                  disabled={disabled || full}
                  onPick={() => setStep({ kind: "widget", type: type.type })}
                />
              ))}
            </GallerySection>
            <GallerySection label={copy.presets}>
              {HUB_WIDGET_PRESETS.map((preset) => {
                const type = hubWidgetDefinition(preset.type)!;
                return (
                  <GalleryCard
                    key={preset.id}
                    testId="gallery-preset"
                    value={preset.id}
                    definition={type}
                    config={preset.config}
                    name={preset.name[language]}
                    description={preset.description[language]}
                    disabled={disabled || full}
                    onPick={() =>
                      setStep({ kind: "widget", type: preset.type, preset })
                    }
                  />
                );
              })}
            </GallerySection>
            <GallerySection label={copy.builtIn} list>
              {!hasTasks && (
                <PickRow
                  icon={ClipboardList}
                  title={copy.tasks}
                  disabled={disabled || full}
                  onPick={() => add({ kind: "tasks" })}
                />
              )}
              <PickRow
                icon={Workflow}
                title={copy.fromProcess}
                description={copy.fromProcessHint}
                disabled={disabled || full}
                onPick={() => setStep({ kind: "process" })}
              />
            </GallerySection>
          </div>
        )}
        {step.kind === "widget" && definition && (
          <WidgetForm
            key={step.preset?.id ?? step.type}
            definition={definition}
            session={session}
            disabled={disabled}
            initial={{
              title: step.preset?.name[language] ?? "",
              brief: (step.preset?.brief ?? definition.brief)?.[language] ?? "",
              config:
                hubWidgetConfig(definition.type, step.preset?.config ?? {}) ??
                (definition.defaultConfig as Record<string, unknown>),
              sources: [],
              refresh: definition.refresh,
            }}
            submitLabel={copy.addAction}
            onCancel={() => setStep({ kind: "pick" })}
            onSubmit={(value) =>
              add({
                kind: "widget",
                type: definition.type,
                ...(step.preset ? { title: step.preset.name[language] } : {}),
                ...(definition.fill === "ai" ? { brief: value.brief } : {}),
                config: value.config,
                sources: value.sources,
              })
            }
          />
        )}
        {step.kind === "process" && (
          <ProcessList
            session={session}
            hub={hub}
            disabled={disabled || full}
            copy={copy}
            onAdd={(processId) => add({ kind: "process", processId })}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function GallerySection({
  label,
  list,
  children,
}: {
  label: string;
  list?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-xs text-muted-foreground">
        {label}
      </h2>
      {list ? (
        <Card variant="list">{children}</Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">{children}</div>
      )}
    </section>
  );
}

/** One type: its icon, name, a line about it and a preview of sample data. */
function GalleryCard({
  testId,
  value,
  definition,
  config,
  name,
  description,
  disabled,
  onPick,
}: {
  testId: string;
  value: string;
  definition: HubWidgetDefinition;
  config?: Record<string, unknown>;
  name: string;
  description: string;
  disabled: boolean;
  onPick: () => void;
}) {
  const { language } = useApp();
  const renderer = widgetRenderer(definition.type);
  const Icon = renderer?.icon ?? Plus;
  const Body = renderer?.Body;
  return (
    <Card
      variant="interactive"
      size="sm"
      data-testid={testId}
      data-type={value}
    >
      <CardHeader>
        <div className="flex min-w-0 items-center gap-2">
          <EntityIcon size="sm" tone="glyph">
            <Icon />
          </EntityIcon>
          <CardTitle>
            <button
              type="button"
              disabled={disabled}
              className="truncate text-left outline-none after:absolute after:inset-0"
              onClick={onPick}
            >
              {name}
            </button>
          </CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {Body && (
        <CardContent>
          <div
            aria-hidden="true"
            inert
            data-testid="gallery-preview"
            className="pointer-events-none max-h-36 overflow-hidden"
          >
            <Body
              preview
              item={null}
              language={language}
              ask={() => {}}
              data={definition.sample(language)}
              config={
                hubWidgetConfig(definition.type, config ?? {}) ??
                (definition.defaultConfig as Record<string, unknown>)
              }
            />
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function PickRow({
  icon: Icon,
  title,
  description,
  disabled,
  onPick,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <Item asChild variant="row" size="row">
      <button
        type="button"
        className="text-left"
        disabled={disabled}
        onClick={onPick}
      >
        <ItemMedia>
          <EntityIcon size="sm" tone="glyph">
            <Icon />
          </EntityIcon>
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{title}</ItemTitle>
          {description && <ItemDescription>{description}</ItemDescription>}
        </ItemContent>
        <ItemActions>
          <Plus aria-hidden="true" className="size-4 text-muted-foreground" />
        </ItemActions>
      </button>
    </Item>
  );
}

/** Processes the person can start without input and that aren't shown yet. */
function ProcessList({
  session,
  hub,
  disabled,
  copy,
  onAdd,
}: {
  session: ClientSession;
  hub: HubDashboardV3;
  disabled: boolean;
  copy: HubCopy;
  onAdd: (processId: string) => void;
}) {
  const inventory = useQuery({
    queryKey: ["app", "hub-inventory", session.identityKey],
    staleTime: 0,
    queryFn: ({ signal }) => session.loadProcessInventory(signal),
  });
  const eligible = (inventory.data?.processes ?? []).filter(
    (entry) =>
      entry.availability === "ready" &&
      hubEligibleInput(entry.inputSchema) &&
      !hub.items.some((item) => item.processId === entry.processId),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-4">
      {inventory.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : inventory.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{copy.loadFailed}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void inventory.refetch()}
            >
              {copy.retry}
            </Button>
          </AlertAction>
        </Alert>
      ) : eligible.length ? (
        <Card variant="list">
          {eligible.map((entry) => (
            <PickRow
              key={entry.processId}
              icon={entry.kind === "agent" ? Bot : Workflow}
              title={entry.name}
              description={entry.description || undefined}
              disabled={disabled}
              onPick={() => onAdd(entry.processId)}
            />
          ))}
        </Card>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{copy.addEmpty}</p>
          <Button variant="outline" size="sm" asChild>
            <Link to="/processes">{copy.openProcesses}</Link>
          </Button>
        </div>
      )}
    </div>
  );
}

type FormValue = {
  title: string;
  brief: string;
  config: Record<string, unknown>;
  sources: string[];
  refresh: HubRefresh;
};

/**
 * What a typed widget shows: the request in the person's words (AI types),
 * the type's settings, optional services to read from and, when editing,
 * its name and schedule.
 */
function WidgetForm({
  definition,
  session,
  disabled,
  initial,
  editing,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  definition: HubWidgetDefinition;
  session: ClientSession;
  disabled: boolean;
  initial: FormValue;
  /** Editing an existing widget: name and schedule too. */
  editing?: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (value: FormValue) => void;
}) {
  const copy = useHubCopy();
  const { language, isAdmin } = useApp();
  const formId = useId();
  const [value, setValue] = useState(initial);
  const ai = definition.fill === "ai";
  const Config = widgetRenderer(definition.type)?.Config;
  // Only services the overview can read: choosing another one is refused.
  const services = useQuery({
    queryKey: ["app", "hub-sources", session.identityKey],
    enabled: ai,
    retry: false,
    staleTime: 60_000,
    queryFn: ({ signal }) => session.readMentions(signal, "hub"),
  });
  const choices = (services.data?.items ?? []).filter(
    (item) => item.kind === "service",
  );
  const valid =
    (!ai || !!value.brief.trim()) && (!editing || !!value.title.trim());
  return (
    <form
      id={formId}
      data-testid="hub-widget-form"
      data-type={definition.type}
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid)
          onSubmit({
            ...value,
            title: value.title.trim(),
            brief: value.brief.trim(),
          });
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <FieldGroup>
          {editing && (
            <Field>
              <FieldLabel htmlFor={`${formId}-name`}>
                {copy.nameLabel}
              </FieldLabel>
              <Input
                id={`${formId}-name`}
                value={value.title}
                maxLength={HUB_TITLE_MAX}
                disabled={disabled}
                onChange={(event) =>
                  setValue({ ...value, title: event.target.value })
                }
              />
            </Field>
          )}
          {ai && (
            <Field>
              <FieldLabel htmlFor={`${formId}-brief`}>
                {copy.briefLabel}
              </FieldLabel>
              <Textarea
                id={`${formId}-brief`}
                value={value.brief}
                maxLength={HUB_BRIEF_MAX}
                disabled={disabled}
                autoFocus
                onChange={(event) =>
                  setValue({ ...value, brief: event.target.value })
                }
              />
            </Field>
          )}
          {Config && (
            <Config
              config={value.config}
              disabled={disabled}
              language={language}
              onChange={(config) => setValue({ ...value, config })}
            />
          )}
          {ai && choices.length > 0 && (
            <Field>
              <FieldLabel>{copy.sourcesLabel}</FieldLabel>
              <ToggleGroup
                type="multiple"
                variant="outline"
                size="sm"
                spacing={1}
                className="flex-wrap"
                aria-label={copy.sourcesLabel}
                value={value.sources}
                disabled={disabled}
                onValueChange={(ids: string[]) =>
                  setValue({
                    ...value,
                    sources: ids.slice(0, HUB_SOURCES_MAX),
                  })
                }
              >
                {choices.map((service) => (
                  <ToggleGroupItem
                    key={service.id}
                    value={service.id}
                    disabled={
                      !value.sources.includes(service.id) &&
                      value.sources.length >= HUB_SOURCES_MAX
                    }
                  >
                    {service.name}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldDescription>{copy.sourcesHint}</FieldDescription>
            </Field>
          )}
          {ai && services.isSuccess && !choices.length && (
            <Field data-testid="hub-sources-none">
              <FieldLabel>{copy.sourcesLabel}</FieldLabel>
              <FieldDescription>{copy.sourcesNone}</FieldDescription>
              {isAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  asChild
                >
                  <a href="/admin/services">{copy.fix.servicesAction}</a>
                </Button>
              )}
            </Field>
          )}
          {editing && ai && (
            <RefreshField
              value={value.refresh}
              disabled={disabled}
              copy={copy}
              onChange={(refresh) => setValue({ ...value, refresh })}
            />
          )}
        </FieldGroup>
      </div>
      <SheetFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {copy.cancel}
        </Button>
        <Button type="submit" disabled={disabled || !valid}>
          {submitLabel}
        </Button>
      </SheetFooter>
    </form>
  );
}

function RefreshField({
  value,
  disabled,
  copy,
  onChange,
}: {
  value: HubRefresh;
  disabled: boolean;
  copy: HubCopy;
  onChange: (value: HubRefresh) => void;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{copy.policyLabel}</FieldLabel>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => onChange(HubRefreshSchema.parse(next))}
      >
        <SelectTrigger id={id} aria-label={copy.policyLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {HubRefreshSchema.options.map((policy) => (
            <SelectItem key={policy} value={policy}>
              {copy.policy[policy]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Changes the request, settings, sources, name or schedule of a typed widget. */
export function HubWidgetEditSheet({
  item,
  session,
  disabled,
  onClose,
  onSave,
}: {
  item: HubCard | null;
  session: ClientSession;
  disabled: boolean;
  onClose: () => void;
  onSave: (changes: HubWidgetEdit) => void | Promise<void>;
}) {
  const copy = useHubCopy();
  const widget = item?.widget;
  const definition = widget ? hubWidgetDefinition(widget.type) : undefined;
  return (
    <Sheet
      open={!!item}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {definition?.fill === "ai" ? copy.editBrief : copy.editWidget}
          </SheetTitle>
        </SheetHeader>
        {item && widget && definition && (
          <WidgetForm
            key={item.id}
            editing
            definition={definition}
            session={session}
            disabled={disabled}
            initial={{
              title: item.title,
              brief: widget.brief,
              config:
                hubWidgetConfig(widget.type, widget.config) ??
                (definition.defaultConfig as Record<string, unknown>),
              sources: widget.sources.map((source) => source.id),
              refresh: item.refresh,
            }}
            submitLabel={copy.save}
            onCancel={onClose}
            onSubmit={(value) => {
              const config =
                hubWidgetConfig(widget.type, widget.config) ??
                definition.defaultConfig;
              const sources = widget.sources.map((source) => source.id);
              const changes: HubWidgetEdit = {
                ...(value.title !== item.title ? { title: value.title } : {}),
                ...(value.refresh !== item.refresh
                  ? { refresh: value.refresh }
                  : {}),
                ...(definition.fill === "ai" && value.brief !== widget.brief
                  ? { brief: value.brief }
                  : {}),
                ...(JSON.stringify(value.config) !== JSON.stringify(config)
                  ? { config: value.config }
                  : {}),
                ...(JSON.stringify([...value.sources].sort()) !==
                JSON.stringify([...sources].sort())
                  ? { sources: value.sources }
                  : {}),
              };
              if (!Object.keys(changes).length) return onClose();
              void onSave(changes);
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

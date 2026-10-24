import { useId, useState, type ReactNode } from "react";
import {
  AlignLeft,
  ChartColumn,
  Hash,
  LayoutList,
  List,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@admin/components/ui/field";
import { Input } from "@admin/components/ui/input";
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
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import {
  HUB_TITLE_MAX,
  HubChartKindSchema,
  HubRefreshSchema,
  type HubChartKind,
  type HubField,
  type HubCard,
  type HubRefresh,
  type HubWidgetType,
  type HubWidgetView,
} from "../../../../packages/protocol/hub";
import {
  hubResolveView,
  hubViewChoices,
  hubViewFor,
} from "../../../../packages/protocol/hub-dashboard";
import { useHubCopy, type HubCopy } from "./hub-copy";

export type HubWidgetChange = {
  title?: string;
  refresh?: HubRefresh;
  view?: HubWidgetView;
};
const NONE = "__none";
const ICONS: Record<HubWidgetType, LucideIcon> = {
  number: Hash,
  chart: ChartColumn,
  list: List,
  table: Table2,
  text: AlignLeft,
  summary: LayoutList,
  tasks: LayoutList,
  widget: LayoutList,
};

/**
 * One widget's settings: its name, how its data is shown (the views its
 * output allows, with the fields mapped) and how often it refreshes. Only
 * what changed is sent.
 */
export function HubWidgetSheet({
  item,
  focus,
  disabled,
  error,
  onClose,
  onSave,
}: {
  item: HubCard | null;
  focus: "name" | "view";
  disabled: boolean;
  /** A refused save; the sheet stays open with the edits. */
  error?: ReactNode;
  onClose: () => void;
  onSave: (changes: HubWidgetChange) => void | Promise<void>;
}) {
  const copy = useHubCopy();
  return (
    <Sheet
      open={!!item}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{copy.sheetTitle}</SheetTitle>
        </SheetHeader>
        {item && error && <div className="px-4">{error}</div>}
        {item && (
          <WidgetForm
            key={item.id}
            item={item}
            focus={focus}
            disabled={disabled}
            copy={copy}
            onClose={onClose}
            onSave={onSave}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function WidgetForm({
  item,
  focus,
  disabled,
  copy,
  onClose,
  onSave,
}: {
  item: HubCard;
  focus: "name" | "view";
  disabled: boolean;
  copy: HubCopy;
  onClose: () => void;
  onSave: (changes: HubWidgetChange) => void | Promise<void>;
}) {
  const formId = useId();
  const nameId = useId();
  const [title, setTitle] = useState(item.title);
  const [refresh, setRefresh] = useState(item.refresh);
  const [view, setView] = useState<HubWidgetView>(item.view);
  const fields = item.fields;
  const kind = item.kind === "tasks" ? "tasks" : "process";
  const choices = hubViewChoices(kind, fields);
  const resolved = hubResolveView(view, kind, fields);
  const valid = "view" in resolved && !!title.trim();
  const changes: HubWidgetChange = {
    ...(title.trim() !== item.title ? { title: title.trim() } : {}),
    ...(refresh !== item.refresh ? { refresh } : {}),
    ...(JSON.stringify(view) !== JSON.stringify(item.view) ? { view } : {}),
  };
  const field = (key: string) => fields?.find((value) => value.key === key);
  /** The first fitting view of this type on one field. */
  const onField = (type: HubWidgetType, key: string) =>
    hubViewFor(
      type,
      (fields ?? []).filter((value) => value.key === key),
    );
  const select = (
    label: string,
    value: string,
    options: { value: string; label: string }[],
    onChange: (value: string) => void,
  ) => (
    <Choice
      label={label}
      value={value}
      options={options}
      disabled={disabled}
      onChange={onChange}
    />
  );
  const fieldOptions = (filter: (field: HubField) => boolean) =>
    (fields ?? [])
      .filter(filter)
      .map((value) => ({ value: value.key, label: value.label }));
  const innerOptions = (key: string, types?: string[]) =>
    (field(key)?.fields ?? [])
      .filter((value) => !types || types.includes(value.type))
      .map((value) => ({ value: value.key, label: value.label }));
  const dataField = (type: HubWidgetType, filter: (f: HubField) => boolean) =>
    "field" in view &&
    select(copy.dataLabel, view.field, fieldOptions(filter), (key) => {
      const next = onField(type, key);
      if (!next) return;
      setView(
        next.type === "chart" && view.type === "chart"
          ? { ...next, chart: view.chart }
          : next,
      );
    });

  let mapping: ReactNode = null;
  switch (view.type) {
    case "number": {
      const compare = view.compare;
      mapping = (
        <>
          {dataField("number", (value) => value.type === "number")}
          <Field>
            <FieldLabel htmlFor={`${formId}-label`}>
              {copy.labelLabel}
            </FieldLabel>
            <Input
              id={`${formId}-label`}
              value={view.label ?? ""}
              maxLength={80}
              disabled={disabled}
              onChange={(event) => {
                const label = event.target.value;
                const { label: _, ...rest } = view;
                setView(label.trim() ? { ...rest, label } : rest);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${formId}-unit`}>{copy.unitLabel}</FieldLabel>
            <Input
              id={`${formId}-unit`}
              value={view.unit ?? ""}
              maxLength={16}
              disabled={disabled}
              onChange={(event) => {
                const unit = event.target.value;
                const { unit: _, ...rest } = view;
                setView(unit.trim() ? { ...rest, unit } : rest);
              }}
            />
          </Field>
          {select(
            copy.compareLabel,
            !compare
              ? NONE
              : compare === "previous"
                ? "previous"
                : compare.field,
            [
              { value: NONE, label: copy.compareNone },
              { value: "previous", label: copy.comparePrevious },
              ...fieldOptions(
                (value) => value.type === "number" && value.key !== view.field,
              ),
            ],
            (value) => {
              const { compare: _, ...rest } = view;
              setView(
                value === NONE
                  ? rest
                  : {
                      ...rest,
                      compare:
                        value === "previous" ? "previous" : { field: value },
                    },
              );
            },
          )}
        </>
      );
      break;
    }
    case "chart":
      mapping = (
        <>
          <Field>
            <FieldLabel>{copy.chartLabel}</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={view.chart}
              disabled={disabled}
              onValueChange={(value) => {
                const chart = HubChartKindSchema.safeParse(value);
                if (chart.success) setView({ ...view, chart: chart.data });
              }}
            >
              {HubChartKindSchema.options.map((kind: HubChartKind) => (
                <ToggleGroupItem key={kind} value={kind}>
                  {copy.charts[kind]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          {dataField("chart", (value) => value.type === "array")}
          {select(
            copy.xLabel,
            view.x ?? "",
            innerOptions(view.field, ["string", "number"]),
            (x) => setView({ ...view, x }),
          )}
          {select(
            copy.yLabel,
            view.y ?? "",
            innerOptions(view.field, ["number"]),
            (y) => setView({ ...view, y }),
          )}
        </>
      );
      break;
    case "list": {
      const inner = innerOptions(view.field);
      mapping = (
        <>
          {dataField("list", (value) => value.type === "array")}
          {inner.length > 0 && (
            <>
              {select(copy.titleField, view.title ?? "", inner, (title) =>
                setView({ ...view, title }),
              )}
              {select(
                copy.subtitleField,
                view.subtitle ?? NONE,
                [{ value: NONE, label: copy.none }, ...inner],
                (subtitle) => {
                  const { subtitle: _, ...rest } = view;
                  setView(subtitle === NONE ? rest : { ...rest, subtitle });
                },
              )}
            </>
          )}
        </>
      );
      break;
    }
    case "table":
      mapping = (
        <>
          {dataField(
            "table",
            (value) => value.type === "array" && !!value.fields?.length,
          )}
          <Field>
            <FieldLabel>{copy.columnsLabel}</FieldLabel>
            <ToggleGroup
              type="multiple"
              variant="outline"
              size="sm"
              spacing={1}
              className="flex-wrap"
              value={view.columns.map((column) => column.key)}
              disabled={disabled}
              onValueChange={(keys: string[]) => {
                // Columns keep the output's own order; six at most.
                const order = innerOptions(view.field).map(
                  (value) => value.value,
                );
                const columns = order
                  .filter((key) => keys.includes(key))
                  .slice(0, 6)
                  .map((key) => ({ key }));
                if (columns.length) setView({ ...view, columns });
              }}
            >
              {innerOptions(view.field).map((value) => (
                <ToggleGroupItem key={value.value} value={value.value}>
                  {value.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        </>
      );
      break;
    case "text":
      mapping = dataField("text", (value) => value.type === "string");
      break;
  }

  return (
    <form
      id={formId}
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        if (!Object.keys(changes).length) return onClose();
        void onSave(
          changes.view && "view" in resolved
            ? { ...changes, view: resolved.view }
            : changes,
        );
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={nameId}>{copy.nameLabel}</FieldLabel>
            <Input
              id={nameId}
              value={title}
              maxLength={HUB_TITLE_MAX}
              disabled={disabled}
              autoFocus={focus === "name"}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          {item.kind === "process" && (
            <>
              <Field>
                <FieldLabel>{copy.viewLabel}</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  spacing={1}
                  className="flex-wrap"
                  value={view.type}
                  disabled={disabled}
                  onValueChange={(value) => {
                    const next = hubViewFor(value as HubWidgetType, fields);
                    if (next) setView(next);
                  }}
                >
                  {choices.map((type) => {
                    const Icon = ICONS[type];
                    return (
                      <ToggleGroupItem key={type} value={type}>
                        <Icon aria-hidden="true" />
                        {copy.views[type]}
                      </ToggleGroupItem>
                    );
                  })}
                </ToggleGroup>
                {!fields && (
                  <p className="text-xs text-muted-foreground">
                    {copy.fieldsUnknown}
                  </p>
                )}
              </Field>
              {mapping}
              {select(
                copy.policyLabel,
                refresh,
                HubRefreshSchema.options.map((policy) => ({
                  value: policy,
                  label: copy.policy[policy],
                })),
                (value) => setRefresh(HubRefreshSchema.parse(value)),
              )}
            </>
          )}
        </FieldGroup>
      </div>
      <SheetFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {copy.cancel}
        </Button>
        <Button type="submit" disabled={disabled || !valid}>
          {copy.save}
        </Button>
      </SheetFooter>
    </form>
  );
}

function Choice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, Bot, ChevronRight, Flag, Split } from "lucide-react";
import { Badge } from "@admin/components/ui/badge";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import { EntityIcon, initials } from "@admin/components/console/entity-icon";
import type {
  DesignCapabilities,
  DesignCapabilityAction,
  DesignCapabilityService,
} from "../../../packages/protocol/process-design";
import type { ProcessStep } from "../../../packages/protocol/service-processes";
import type { ActionRef } from "./lib/process-editor";
import type { EditorCopy } from "./process-editor-copy";
import { readableName } from "./process-editor-canvas";

type Flow = Exclude<ProcessStep["type"], "action">;
type Option =
  | { kind: "flow"; type: Flow }
  | { kind: "service"; service: DesignCapabilityService; count: number }
  | {
      kind: "action";
      service: DesignCapabilityService;
      action: DesignCapabilityAction;
    };
const flowIcons = { agent: Bot, branch: Split, return: Flag };
function FlowIcon({ type }: { type: Flow }) {
  const Icon = flowIcons[type];
  return <Icon />;
}
const usable = (action: DesignCapabilityAction) =>
  action.enabled && action.status === "configured" && !action.schemaUnavailable;
const words = (text: string) =>
  text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Choose what a new step does: flow steps first, then a service and one of
 * its actions; typing searches every action across services. */
export function ProcessStepPicker({
  capabilities,
  copy,
  disabled,
  allowAgent,
  onPick,
}: {
  capabilities: DesignCapabilities;
  copy: EditorCopy;
  disabled: boolean;
  allowAgent: boolean;
  onPick(type: ProcessStep["type"], action?: ActionRef): void;
}) {
  const [query, setQuery] = useState("");
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const list = useId();
  const rows = useRef(new Map<number, HTMLElement>());
  const services = capabilities.services
    .filter((service) => service.enabled)
    .map((service) => ({ service, actions: service.actions.filter(usable) }))
    .filter((entry) => entry.actions.length > 0);
  const opened = services.find((entry) => entry.service.id === serviceId);
  const terms = words(query).split(/\s+/).filter(Boolean);
  const matches = (...texts: string[]) => {
    const text = words(texts.join(" "));
    return terms.every((term) => text.includes(term));
  };
  const flows: Flow[] = ["agent", "branch", "return"];
  const flowOptions = flows
    .filter((type) => !terms.length || matches(copy[type], copy[`${type}Hint`]))
    .map((type): Option => ({ kind: "flow", type }));
  const actionsOf = (entry: (typeof services)[number]) =>
    entry.actions.map(
      (action): Option => ({ kind: "action", service: entry.service, action }),
    );
  // Searching ranks name matches above description-only matches.
  const searched = terms.length
    ? services
        .flatMap((entry) =>
          entry.actions
            .filter((action) =>
              matches(
                entry.service.name,
                action.name,
                readableName(action.name),
                action.description,
              ),
            )
            .map((action) => ({
              option: {
                kind: "action",
                service: entry.service,
                action,
              } as Option,
              rank: matches(
                entry.service.name,
                action.name,
                readableName(action.name),
              )
                ? 0
                : 1,
            })),
        )
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 60)
        .map((item) => item.option)
    : [];
  const sections: { title: string; options: Option[] }[] = opened
    ? terms.length
      ? [
          {
            title: opened.service.name,
            options: actionsOf(opened).filter(
              (option) =>
                option.kind === "action" &&
                matches(
                  option.action.name,
                  readableName(option.action.name),
                  option.action.description,
                ),
            ),
          },
        ]
      : [
          {
            title: copy.reads,
            options: actionsOf(opened).filter(
              (option) =>
                option.kind === "action" && option.action.effect === "read",
            ),
          },
          {
            title: copy.writes,
            options: actionsOf(opened).filter(
              (option) =>
                option.kind === "action" && option.action.effect === "write",
            ),
          },
        ]
    : terms.length
      ? [
          { title: copy.flow, options: flowOptions },
          { title: copy.actions, options: searched },
        ]
      : [
          { title: copy.flow, options: flowOptions },
          {
            title: copy.services,
            options: services.map(
              (entry): Option => ({
                kind: "service",
                service: entry.service,
                count: entry.actions.length,
              }),
            ),
          },
        ];
  const visible = sections.filter((section) => section.options.length);
  const options = visible.flatMap((section) => section.options);
  const current = Math.min(active, Math.max(0, options.length - 1));
  useEffect(() => {
    rows.current.get(current)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  const blocked = (option: Option) =>
    disabled ||
    (option.kind === "flow" && option.type === "agent" && !allowAgent);
  function choose(option: Option | undefined) {
    if (!option || blocked(option)) return;
    if (option.kind === "service") {
      setServiceId(option.service.id);
      setQuery("");
      setActive(0);
    } else if (option.kind === "flow") onPick(option.type);
    else
      onPick("action", {
        serviceId: option.service.id,
        actionId: option.action.id,
      });
  }
  function back() {
    setServiceId(null);
    setQuery("");
    setActive(0);
  }
  let index = -1;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
      {opened && (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copy.back}
            onClick={back}
          >
            <ArrowLeft />
          </Button>
          <EntityIcon size="sm">{initials(opened.service.name)}</EntityIcon>
          <span className="min-w-0 truncate text-sm font-medium">
            {opened.service.name}
          </span>
        </div>
      )}
      <Input
        type="search"
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls={list}
        aria-activedescendant={
          options.length ? `${list}-${current}` : undefined
        }
        aria-label={copy.pickerSearch}
        placeholder={
          opened
            ? `${copy.searchActions}: ${opened.service.name}`
            : copy.pickerSearch
        }
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive(
              options.length
                ? (current + step + options.length) % options.length
                : 0,
            );
          } else if (event.key === "Enter") {
            event.preventDefault();
            choose(options[current]);
          } else if (
            event.key === "ArrowRight" &&
            options[current]?.kind === "service"
          ) {
            event.preventDefault();
            choose(options[current]);
          } else if (
            opened &&
            !query &&
            (event.key === "Backspace" || event.key === "ArrowLeft")
          ) {
            event.preventDefault();
            back();
          }
        }}
      />
      {opened?.service.description && !query && (
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {opened.service.description}
        </p>
      )}
      <div
        id={list}
        role="listbox"
        aria-label={copy.add}
        className="-mx-2 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2"
      >
        {!options.length && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {terms.length ? copy.noResults : copy.capability}
          </p>
        )}
        {visible.map((section) => (
          <div
            key={section.title}
            role="group"
            aria-label={section.title}
            className="flex flex-col gap-0.5"
          >
            <span className="px-3 pb-1 text-xs font-medium text-muted-foreground">
              {section.title}
            </span>
            {section.options.map((option) => {
              const position = ++index;
              const selected = position === current;
              const label =
                option.kind === "flow"
                  ? copy[option.type]
                  : option.kind === "service"
                    ? option.service.name
                    : `${readableName(option.action.name)} · ${option.service.name}`;
              return (
                <Item
                  key={
                    option.kind === "flow"
                      ? option.type
                      : option.kind === "service"
                        ? option.service.id
                        : `${option.service.id}/${option.action.id}`
                  }
                  asChild
                  size="xs"
                  variant="option"
                >
                  <button
                    type="button"
                    id={`${list}-${position}`}
                    ref={(element) => {
                      if (element) rows.current.set(position, element);
                      else rows.current.delete(position);
                    }}
                    role="option"
                    aria-selected={selected}
                    aria-label={label}
                    disabled={blocked(option)}
                    onPointerMove={() => {
                      if (!selected) setActive(position);
                    }}
                    onClick={() => choose(option)}
                  >
                    <ItemMedia>
                      {option.kind === "flow" ? (
                        <EntityIcon size="sm" tone="muted">
                          <FlowIcon type={option.type} />
                        </EntityIcon>
                      ) : (
                        <EntityIcon size="sm">
                          {initials(option.service.name)}
                        </EntityIcon>
                      )}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {option.kind === "flow"
                          ? copy[option.type]
                          : option.kind === "service"
                            ? option.service.name
                            : readableName(option.action.name)}
                      </ItemTitle>
                      {(option.kind !== "service" ||
                        option.service.description) && (
                        <ItemDescription>
                          {option.kind === "flow"
                            ? copy[`${option.type}Hint`]
                            : option.kind === "service"
                              ? option.service.description
                              : opened
                                ? option.action.description
                                : [
                                    option.service.name,
                                    option.action.description,
                                  ]
                                    .filter(Boolean)
                                    .join(" — ")}
                        </ItemDescription>
                      )}
                    </ItemContent>
                    <ItemActions>
                      {option.kind === "service" && (
                        <>
                          <Badge variant="outline">{option.count}</Badge>
                          <ChevronRight aria-hidden="true" />
                        </>
                      )}
                      {option.kind === "action" &&
                        option.action.approval === "always" && (
                          <Badge variant="outline">{copy.needsApproval}</Badge>
                        )}
                    </ItemActions>
                  </button>
                </Item>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

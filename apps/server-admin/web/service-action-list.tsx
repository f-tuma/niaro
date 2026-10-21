import { WorkspaceRolePicker } from "./workspace-roles";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Pencil, Search, X } from "lucide-react";
import type {
  Service,
  ServiceAction,
} from "../../../packages/protocol/service-catalog";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import { Checkbox } from "@admin/components/ui/checkbox";
import { Switch } from "@admin/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@admin/components/ui/input-group";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@admin/components/ui/field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@admin/components/ui/tooltip";
import {
  AlertAction,
  Alert,
  AlertDescription,
} from "@admin/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle } from "@admin/components/ui/empty";
import { StatusBadge, StatusDot } from "@admin/components/console/status";
import { SubmitButton } from "@admin/components/console/forms";
import { actionAccess, type CatalogState } from "./catalog-shared";
import { personallyManaged, type PersonalMode } from "./service-personal";

const pageSize = 25;
/** The technical call behind an action: an HTTP route or an MCP tool name. */
export function bindingLabel(action: ServiceAction) {
  return action.binding.type === "http"
    ? `${action.binding.method} ${action.binding.path}`
    : (action.binding.catalogTool ?? action.binding.name);
}
type Selection = { id: string; revision: number }[];
export function ServiceActionList({
  state,
  service,
  personal = null,
  onOpen,
  actions,
}: {
  state: CatalogState;
  service: Service;
  /** Personal sign-in: people manage these actions; here only the ceiling. */
  personal?: PersonalMode;
  onOpen: (action: ServiceAction) => void;
  /** Toolbar actions shown after search and filter (discover, add). */
  actions?: ReactNode;
}) {
  const { copy } = state;
  const [search, setSearch] = useState("");
  // Long catalogs open on what the assistant actually uses.
  const [status, setStatus] = useState(() =>
    service.actions.length > pageSize && service.actions.some((a) => a.enabled)
      ? "enabled"
      : "all",
  );
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<Selection>([]);
  const [batch, setBatch] = useState<{
    serviceRevision: number;
    actions: Selection;
  } | null>(null);
  const bulkTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const canManage = state.query.data!.canManage;
  const selected = (canManage ? selection : []).filter((item) =>
    service.actions.some((a) => a.id === item.id),
  );
  const filtered = [...service.actions]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(
      (a) =>
        (status === "all" || a.enabled === (status === "enabled")) &&
        `${a.name} ${a.description} ${bindingLabel(a)}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
    );
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const has = (id: string) => selected.some((a) => a.id === id);
  const allPage = visible.length > 0 && visible.every((a) => has(a.id));
  function togglePage(checked: boolean) {
    setSelection((old) =>
      checked
        ? [
            ...old.filter((a) => !visible.some((v) => a.id === v.id)),
            ...visible.map(({ id, revision }) => ({ id, revision })),
          ]
        : old.filter((a) => !visible.some((v) => a.id === v.id)),
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {personal && (
        <p className="text-sm text-muted-foreground">
          {personal === "all" ? copy.personalActions : copy.personalWrites}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="w-full sm:w-auto sm:max-w-sm sm:min-w-60 sm:flex-1">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchInput}
            id="action-list-search"
            type="search"
            aria-label={copy.searchActions}
            placeholder={copy.searchActions}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </InputGroup>
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPage(0);
          }}
        >
          <SelectTrigger aria-label={copy.filterStatus}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{copy.all}</SelectItem>
            <SelectItem value="enabled">{copy.filterEnabled}</SelectItem>
            <SelectItem value="paused">{copy.filterDisabled}</SelectItem>
          </SelectContent>
        </Select>
        {actions && (
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            {actions}
          </div>
        )}
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 py-1.5 pr-1.5 pl-3">
          <span role="status" className="text-sm tabular-nums">
            {copy.selectedActions}: <strong>{selected.length}</strong>
          </span>
          {filtered.some((a) => !has(a.id)) && (
            <Button
              variant="link"
              size="sm"
              onClick={() =>
                setSelection((old) => [
                  ...old.filter((a) => !filtered.some((f) => f.id === a.id)),
                  ...filtered.map(({ id, revision }) => ({ id, revision })),
                ])
              }
            >
              {copy.selectAllActions} ({filtered.length})
            </Button>
          )}
          <span className="flex-1" />
          <Button
            ref={bulkTrigger}
            size="sm"
            variant="outline"
            onClick={() =>
              setBatch({
                serviceRevision: service.revision,
                actions: selected,
              })
            }
          >
            <Pencil data-icon="inline-start" aria-hidden="true" />
            {copy.editSelected}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={copy.clearSelection}
                onClick={() => setSelection([])}
              >
                <X aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copy.clearSelection}</TooltipContent>
          </Tooltip>
        </div>
      )}
      {visible.length > 0 ? (
        <Card variant="flush">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                {canManage && (
                  <TableHead className="w-11">
                    <Checkbox
                      aria-label={copy.selectPage}
                      checked={
                        allPage
                          ? true
                          : visible.some((a) => has(a.id))
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={(value) => togglePage(value === true)}
                    />
                  </TableHead>
                )}
                <TableHead>{copy.name}</TableHead>
                <TableHead className="hidden w-44 lg:table-cell">
                  {copy.access}
                </TableHead>
                <TableHead className="w-24 text-right">
                  {copy.enabled}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((a) => (
                <TableRow
                  key={a.id}
                  data-state={has(a.id) ? "selected" : undefined}
                  data-muted={!a.enabled}
                >
                  {canManage && (
                    <TableCell>
                      <Checkbox
                        aria-label={`${copy.selectedActions}: ${a.name}`}
                        checked={has(a.id)}
                        onCheckedChange={(checked) =>
                          setSelection((old) =>
                            checked === true
                              ? [
                                  ...old.filter((v) => v.id !== a.id),
                                  { id: a.id, revision: a.revision },
                                ]
                              : old.filter((v) => v.id !== a.id),
                          )
                        }
                      />
                    </TableCell>
                  )}
                  <TableCell className="whitespace-normal">
                    <button
                      type="button"
                      className="w-full rounded text-left font-medium break-words outline-offset-4 hover:underline focus-visible:outline-2"
                      onClick={() => onOpen(a)}
                    >
                      {a.name}
                    </button>
                    {bindingLabel(a) !== a.name && (
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        {bindingLabel(a)}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="hidden whitespace-normal lg:table-cell">
                    {personallyManaged(personal, a) ? (
                      <StatusDot tone="neutral">
                        {copy.personalManaged}
                      </StatusDot>
                    ) : (
                      <StatusDot tone={actionAccess(a, copy).tone}>
                        {actionAccess(a, copy).label}
                      </StatusDot>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Switch
                      aria-label={`${copy.enabled}: ${a.name}`}
                      checked={a.enabled}
                      disabled={!canManage || state.busy}
                      onCheckedChange={(enabled) =>
                        void state.mutate("command", {
                          type: "updateActions",
                          serviceId: service.id,
                          serviceRevision: service.revision,
                          actions: [{ id: a.id, revision: a.revision }],
                          patch: { enabled },
                        })
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyTitle>
              {service.actions.length ? copy.noMatchingActions : copy.noActions}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {filtered.length > pageSize && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            {currentPage * pageSize + 1}–
            {Math.min((currentPage + 1) * pageSize, filtered.length)} {copy.of}{" "}
            {filtered.length}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              aria-label={copy.previousPage}
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <span className="text-xs tabular-nums">
              {currentPage + 1} / {pages}
            </span>
            <Button
              variant="outline"
              size="icon"
              aria-label={copy.nextPage}
              disabled={currentPage + 1 >= pages}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
      <Sheet
        open={canManage && !!batch}
        onOpenChange={(open) => {
          if (!open && !state.busy) setBatch(null);
        }}
      >
        <SheetContent
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            (bulkTrigger.current?.isConnected
              ? bulkTrigger.current
              : searchInput.current
            )?.focus();
          }}
        >
          <SheetHeader>
            <SheetTitle>{copy.bulkEdit}</SheetTitle>
            <SheetDescription>
              {copy.selectedActions}: {batch?.actions.length ?? 0}
            </SheetDescription>
          </SheetHeader>
          {batch && (
            <BulkActionForm
              state={state}
              service={service}
              personal={personal === "all"}
              batch={batch}
              close={() => setBatch(null)}
              saved={() => {
                setBatch(null);
                setSelection([]);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function BulkActionForm({
  state,
  service,
  personal,
  batch,
  close,
  saved,
}: {
  state: CatalogState;
  service: Service;
  /** Every action is the person's own: only available/blocked applies here. */
  personal: boolean;
  batch: { serviceRevision: number; actions: Selection };
  close: () => void;
  saved: () => void;
}) {
  const { copy } = state;
  const [enabled, setEnabled] = useState("keep");
  const [approval, setApproval] = useState("keep");
  const [changeRoles, setChangeRoles] = useState(false);
  const [workspaceRoles, setWorkspaceRoles] = useState<string[]>([]);
  const [roles, setRoles] = useState<ServiceAction["policy"]["roles"]>([]);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state.error]);
  const dirty = enabled !== "keep" || approval !== "keep" || changeRoles;
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void state
          .mutate("command", {
            type: "updateActions",
            serviceId: service.id,
            ...batch,
            patch: {
              ...(enabled !== "keep" ? { enabled: enabled === "enabled" } : {}),
              ...(approval !== "keep" ? { approval } : {}),
              ...(changeRoles ? { roles, workspaceRoles } : {}),
            },
          })
          .then((result) => {
            if (result) saved();
          });
      }}
    >
      <fieldset
        disabled={state.busy}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4"
      >
        {state.error && (
          <Alert ref={errorRef} tabIndex={-1} variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
            {state.conflict && (
              <AlertAction>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void state.resetDrafts()}
                >
                  {copy.reloadSaved}
                </Button>
              </AlertAction>
            )}
          </Alert>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="bulk-status">{copy.status}</FieldLabel>
            <Select value={enabled} onValueChange={setEnabled}>
              <SelectTrigger id="bulk-status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="keep">{copy.keepUnchanged}</SelectItem>
                <SelectItem value="enabled">{copy.active}</SelectItem>
                <SelectItem value="paused">{copy.paused}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field hidden={personal}>
            <FieldLabel htmlFor="bulk-approval">{copy.approval}</FieldLabel>
            <Select value={approval} onValueChange={setApproval}>
              <SelectTrigger id="bulk-approval" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="keep">{copy.keepUnchanged}</SelectItem>
                <SelectItem value="always">{copy.always}</SelectItem>
                <SelectItem value="never">{copy.never}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal" hidden={personal}>
            <FieldLabel htmlFor="bulk-roles">{copy.changeRoles}</FieldLabel>
            <Switch
              id="bulk-roles"
              checked={changeRoles}
              onCheckedChange={setChangeRoles}
            />
          </Field>
          {changeRoles && (
            <FieldSet>
              <FieldLegend variant="label" className="sr-only">
                {copy.changeRoles}
              </FieldLegend>
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                {(["owner", "admin", "member"] as const).map((role) => (
                  <Field key={role} orientation="horizontal" className="w-auto">
                    <Checkbox
                      id={`bulk-role-${role}`}
                      checked={roles.includes(role)}
                      onCheckedChange={(v) =>
                        setRoles((old) =>
                          v === true
                            ? [...old, role]
                            : old.filter((r) => r !== role),
                        )
                      }
                    />
                    <FieldLabel htmlFor={`bulk-role-${role}`}>
                      {copy[role]}
                    </FieldLabel>
                  </Field>
                ))}
              </div>
              <WorkspaceRolePicker
                roles={state.scope.workspace?.roles ?? []}
                value={workspaceRoles}
                onChange={setWorkspaceRoles}
              />
              {!roles.length && !workspaceRoles.length && (
                <StatusBadge tone="warning">{copy.noAccess}</StatusBadge>
              )}
            </FieldSet>
          )}
        </FieldGroup>
      </fieldset>
      <SheetFooter>
        <Button
          type="button"
          variant="outline"
          onClick={close}
          disabled={state.busy}
        >
          {copy.cancel}
        </Button>
        <SubmitButton pending={state.busy} disabled={!dirty}>
          {copy.save} ({batch.actions.length})
        </SubmitButton>
      </SheetFooter>
    </form>
  );
}

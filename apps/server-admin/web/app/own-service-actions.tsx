import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search, Trash2 } from "lucide-react";
import { Badge } from "@admin/components/ui/badge";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import { Checkbox } from "@admin/components/ui/checkbox";
import { Input } from "@admin/components/ui/input";
import { Textarea } from "@admin/components/ui/textarea";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Spinner } from "@admin/components/ui/spinner";
import { RadioGroup, RadioGroupItem } from "@admin/components/ui/radio-group";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@admin/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@admin/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@admin/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@admin/components/ui/item";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import { ConfirmAction } from "@admin/components/console/forms";
import {
  PersonalActionChoices,
  type PersonalServiceSummaryValue,
} from "../../../../packages/protocol/service-catalog";
import type { PersonalActionPermission } from "../../../../packages/protocol/service-oauth";
import { api } from "../lib/api";
import type { AppWorkspace } from "./context";
import type { MenuCopy } from "./menu-copy";
import type { useOwnServices } from "./own-services";

type Own = ReturnType<typeof useOwnServices>;

/**
 * Everything the owner's service offers, read from it when the sheet opens:
 * the owner ticks what the assistant may use and adds it. Nothing changes
 * until they add.
 */
export function FindActionsSheet({
  service,
  own,
  workspace,
  copy,
  open,
  onOpenChange,
}: {
  service: PersonalServiceSummaryValue;
  own: Own;
  workspace: AppWorkspace;
  copy: MenuCopy;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: [
      "app",
      "own-service-choices",
      workspace.workspaceId,
      service.id,
      service.revision,
    ],
    enabled: open,
    retry: false,
    gcTime: 0,
    queryFn: async ({ signal }) =>
      PersonalActionChoices.parse(
        await api(
          "identity/catalog/personal/command",
          {
            organizationId: workspace.organizationId,
            workspaceId: workspace.workspaceId,
            type: "findActions",
            id: service.id,
            revision: service.revision,
          },
          signal,
        ),
      ),
  });
  const term = search.trim().toLocaleLowerCase();
  const choices = (query.data?.choices ?? []).filter((choice) =>
    `${choice.name} ${choice.description}`.toLocaleLowerCase().includes(term),
  );
  const fresh = query.data?.choices.filter((choice) => !choice.added) ?? [];
  const busy = own.busy === service.id;
  const close = () => {
    setSelected([]);
    setSearch("");
    onOpenChange(false);
  };
  return (
    <Sheet open={open} onOpenChange={(value) => !value && close()}>
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>
            {copy.actionsFindTitle.replace("{name}", service.name)}
          </SheetTitle>
          <SheetDescription>{copy.actionsFindHint}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          {query.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{copy.actionsFindFailed}</AlertDescription>
              <AlertAction>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void query.refetch()}
                >
                  <RefreshCw data-icon="inline-start" aria-hidden="true" />
                  {copy.retry}
                </Button>
              </AlertAction>
            </Alert>
          ) : query.isPending ? (
            <div role="status" aria-label={copy.actionsFind}>
              <Skeleton className="h-64 w-full" />
            </div>
          ) : !fresh.length ? (
            <Empty variant="outline">
              <EmptyHeader>
                <EmptyDescription>{copy.actionsNone}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              {query.data.choices.length >= 8 && (
                <InputGroup>
                  <InputGroupAddon>
                    <Search aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    aria-label={copy.permissionsSearch}
                    placeholder={copy.permissionsSearch}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </InputGroup>
              )}
              <Card variant="list">
                {choices.map((choice) => {
                  const id = `choice-${choice.key}`;
                  const checked = choice.added || selected.includes(choice.key);
                  return (
                    <Item key={choice.key} variant="row" size="row">
                      <Checkbox
                        id={id}
                        checked={checked}
                        disabled={choice.added || busy}
                        onCheckedChange={(value) =>
                          setSelected((current) =>
                            value === true
                              ? [...current, choice.key]
                              : current.filter((key) => key !== choice.key),
                          )
                        }
                      />
                      <ItemContent>
                        <ItemTitle>
                          <label htmlFor={id}>{choice.name}</label>
                        </ItemTitle>
                        {choice.description && (
                          <ItemDescription>
                            {choice.description}
                          </ItemDescription>
                        )}
                      </ItemContent>
                      <ItemActions>
                        <Badge variant="outline">
                          {choice.added
                            ? copy.actionsAdded
                            : choice.effect === "read"
                              ? copy.actionReads
                              : copy.actionWrites}
                        </Badge>
                      </ItemActions>
                    </Item>
                  );
                })}
              </Card>
              {term && !choices.length && (
                <p className="text-sm text-muted-foreground">
                  {copy.permissionsNoMatch}
                </p>
              )}
            </>
          )}
          {own.error && (
            <Alert variant="destructive">
              <AlertDescription>{copy[own.error]}</AlertDescription>
            </Alert>
          )}
        </div>
        <SheetFooter>
          <Button
            disabled={!selected.length || busy}
            onClick={() =>
              void own.addActions(service, selected).then((saved) => {
                if (saved) close();
              })
            }
          >
            {busy && <Spinner data-icon="inline-start" />}
            {copy.actionsAdd.replace("{n}", String(selected.length))}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/**
 * How the assistant sees one action of the owner's service: its name, what
 * it is for, and whether it only reads (runs without asking) or changes
 * something (asks first unless the owner says otherwise).
 */
export function EditActionSheet({
  service,
  action,
  own,
  copy,
  onClose,
}: {
  service: PersonalServiceSummaryValue;
  action: PersonalActionPermission;
  own: Own;
  copy: MenuCopy;
  onClose(): void;
}) {
  const formId = useId();
  const [name, setName] = useState(action.name);
  const [description, setDescription] = useState(action.description);
  const [effect, setEffect] = useState(action.effect);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const busy = own.busy === service.id;
  const target = { id: action.id, revision: action.revision ?? 0 };
  return (
    <Sheet open onOpenChange={(value) => !value && onClose()}>
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || busy) return;
            void own
              .editAction(service, target, {
                name: name.trim(),
                description: description.trim(),
                effect,
              })
              .then((saved) => {
                if (saved) onClose();
              });
          }}
        >
          <SheetHeader>
            <SheetTitle>{copy.actionEditTitle}</SheetTitle>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
            <Field>
              <FieldLabel htmlFor={`${formId}-name`}>
                {copy.actionName}
              </FieldLabel>
              <Input
                id={`${formId}-name`}
                maxLength={100}
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-description`}>
                {copy.actionDescription}
              </FieldLabel>
              <Textarea
                id={`${formId}-description`}
                maxLength={2000}
                rows={4}
                value={description}
                disabled={busy}
                onChange={(event) => setDescription(event.target.value)}
              />
              <FieldDescription>{copy.actionDescriptionHint}</FieldDescription>
            </Field>
            <FieldSet>
              <FieldLegend variant="label">{copy.actionEffect}</FieldLegend>
              <RadioGroup
                value={effect}
                disabled={busy}
                onValueChange={(value) =>
                  setEffect(value === "read" ? "read" : "write")
                }
              >
                {(["read", "write"] as const).map((value) => (
                  <Field key={value} orientation="horizontal">
                    <RadioGroupItem id={`${formId}-${value}`} value={value} />
                    <FieldContent>
                      <FieldLabel htmlFor={`${formId}-${value}`}>
                        {value === "read"
                          ? copy.actionReads
                          : copy.actionWrites}
                      </FieldLabel>
                      <FieldDescription>
                        {value === "read"
                          ? copy.actionReadsHint
                          : copy.actionWritesHint}
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>
            {own.error && (
              <Alert variant="destructive">
                <AlertDescription>{copy[own.error]}</AlertDescription>
              </Alert>
            )}
          </div>
          <SheetFooter className="flex-row justify-between">
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
            >
              <Trash2 data-icon="inline-start" aria-hidden="true" />
              {copy.actionRemove}
            </Button>
            <Button type="submit" disabled={!name.trim() || busy}>
              {busy && <Spinner data-icon="inline-start" />}
              {copy.ownServiceSave}
            </Button>
          </SheetFooter>
        </form>
        <ConfirmAction
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          title={`${copy.actionRemove}?`}
          confirmLabel={copy.actionRemove}
          cancelLabel={copy.cancel}
          onConfirm={() =>
            own.removeAction(service, target).then((saved) => {
              if (saved) onClose();
            })
          }
        />
      </SheetContent>
    </Sheet>
  );
}

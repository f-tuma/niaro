import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Plus, RotateCcw, X } from "lucide-react";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import { Input } from "@admin/components/ui/input";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Textarea } from "@admin/components/ui/textarea";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@admin/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
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
import { Disclosure } from "@admin/components/console/disclosure";
import { SubmitButton } from "@admin/components/console/forms";
import { RelativeTime } from "@admin/components/console/time";
import {
  INSTRUCTIONS_LIMITS,
  INSTRUCTIONS_PROFILE,
  InstructionsAdminViewSchema,
  InstructionsContentSchema,
  PROMPT_VARIABLES,
  type InstructionsAdminView,
  type InstructionsContent,
  type InstructionsScope,
} from "../../../packages/protocol/workspace-instructions";
import { api, ApiError } from "./lib/api";
import { useAdmin } from "./context";

const copy = {
  en: {
    title: "Instructions",
    organizationDefault: "Organization default",
    instructions: "Instructions",
    inherited: "Empty: the organization default applies.",
    starters: "Starters",
    starter: "Starter",
    addStarter: "Add starter",
    removeStarter: "Remove starter",
    variables: "Variables",
    history: "History",
    restore: "Restore",
    restored: "Restored revision {revision}",
    saved: "Saved",
    unknownAuthor: "Unknown",
    cancel: "Cancel",
    save: "Save changes",
    loadFailed: "Instructions didn't load.",
    retry: "Try again",
    conflict: "It changed in the meantime. Reopen it.",
    invalid: "Check the text and the starters.",
    failed: "Saving failed.",
  },
  cs: {
    title: "Pokyny",
    organizationDefault: "Výchozí pro organizaci",
    instructions: "Pokyny",
    inherited: "Prázdné: platí výchozí pro organizaci.",
    starters: "Úvodní dotazy",
    starter: "Úvodní dotaz",
    addStarter: "Přidat dotaz",
    removeStarter: "Odebrat dotaz",
    variables: "Proměnné",
    history: "Historie",
    restore: "Obnovit",
    restored: "Obnovena revize {revision}",
    saved: "Uloženo",
    unknownAuthor: "Neznámý",
    cancel: "Zrušit",
    save: "Uložit změny",
    loadFailed: "Pokyny se nenačetly.",
    retry: "Zkusit znovu",
    conflict: "Mezitím se změnily. Otevři je znovu.",
    invalid: "Zkontroluj text a úvodní dotazy.",
    failed: "Uložení se nepovedlo.",
  },
};
const VARIABLE_MEANING = {
  en: [
    "the person's name",
    "their confirmed job title",
    "the workspace",
    "the organization",
    "today's date in their time zone",
    "their app language",
  ],
  cs: [
    "jméno člověka",
    "jeho potvrzená pozice",
    "prostor",
    "organizace",
    "dnešní datum v jeho časovém pásmu",
    "jazyk jeho aplikace",
  ],
};

export const instructionsKey = (
  organizationId: string,
  scope: InstructionsScope,
) =>
  [
    "admin",
    "instructions",
    organizationId,
    scope.type === "workspace" ? scope.workspaceId : "organization",
  ] as const;

/**
 * Instructions and starters for one workspace or the organization default,
 * with their history. Owners and administrators only: the console renders it
 * only for people who manage workspaces.
 */
export function WorkspaceInstructions({
  organizationId,
  scope,
  name,
  open,
  onOpenChange,
}: {
  organizationId: string;
  scope: InstructionsScope;
  /** The workspace's name, or nothing for the organization default. */
  name?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { language } = useAdmin();
  const words = copy[language];
  const view = useQuery({
    queryKey: instructionsKey(organizationId, scope),
    queryFn: async ({ signal }) =>
      InstructionsAdminViewSchema.parse(
        await api(
          "identity/instructions/get",
          { organizationId, scope },
          signal,
        ),
      ),
    enabled: open,
    retry: false,
    staleTime: 0,
  });
  const [pending, setPending] = useState(false);
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!pending) onOpenChange(value);
      }}
    >
      <SheetContent size="wide">
        <SheetHeader>
          <SheetTitle>{words.title}</SheetTitle>
          <SheetDescription>
            {name ?? words.organizationDefault}
          </SheetDescription>
        </SheetHeader>
        {view.isError ? (
          <div className="flex flex-col gap-3 px-4">
            <Alert variant="destructive">
              <AlertDescription>{words.loadFailed}</AlertDescription>
            </Alert>
            <Button
              variant="outline"
              className="self-start"
              onClick={() => void view.refetch()}
            >
              {words.retry}
            </Button>
          </div>
        ) : !view.data ? (
          <div className="px-4">
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <InstructionsForm
            key={view.data.revision}
            organizationId={organizationId}
            view={view.data}
            pending={pending}
            setPending={setPending}
            onClose={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function InstructionsForm({
  organizationId,
  view,
  pending,
  setPending,
  onClose,
}: {
  organizationId: string;
  view: InstructionsAdminView;
  pending: boolean;
  setPending: (pending: boolean) => void;
  onClose: () => void;
}) {
  const { language } = useAdmin();
  const words = copy[language];
  const client = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<InstructionsContent>(view.content);
  const [error, setError] = useState<string | null>(null);
  const key = instructionsKey(organizationId, view.scope);
  const starters = draft.starters;
  const inherits =
    view.scope.type === "workspace" &&
    !draft.text.trim() &&
    !!view.organizationDefault?.text.trim();
  async function send(command: Record<string, unknown>) {
    if (pending) return false;
    setPending(true);
    setError(null);
    try {
      await api("identity/instructions/command", {
        organizationId,
        ...command,
      });
      await client.invalidateQueries({ queryKey: key });
      return true;
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.code === "instructions_conflict"
          ? words.conflict
          : failure instanceof ApiError && failure.status === 400
            ? words.invalid
            : words.failed,
      );
      return false;
    } finally {
      setPending(false);
    }
  }
  const content = {
    text: draft.text,
    starters: starters.map((starter) => starter.trim()).filter(Boolean),
  };
  const valid = InstructionsContentSchema.safeParse(content).success;
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      data-profile={INSTRUCTIONS_PROFILE}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) {
          setError(words.invalid);
          return;
        }
        if (
          await send({
            type: "save",
            scope: view.scope,
            revision: view.revision,
            content,
          })
        )
          onClose();
      }}
    >
      <fieldset
        disabled={pending}
        className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4"
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-text`}>{words.instructions}</FieldLabel>
            <Textarea
              id={`${id}-text`}
              rows={10}
              value={draft.text}
              maxLength={INSTRUCTIONS_LIMITS.text}
              placeholder={
                view.scope.type === "workspace"
                  ? view.organizationDefault?.text.slice(0, 400)
                  : undefined
              }
              onChange={(event) =>
                setDraft({ ...draft, text: event.target.value })
              }
            />
            <FieldDescription>
              {inherits ? `${words.inherited} ` : ""}
              <span className="tabular-nums">
                {draft.text.length} / {INSTRUCTIONS_LIMITS.text}
              </span>
            </FieldDescription>
          </Field>
          <Disclosure title={words.variables}>
            <ul className="flex flex-col gap-1 text-sm">
              {PROMPT_VARIABLES.map((variable, index) => (
                <li key={variable}>
                  <code className="font-mono text-xs">{variable}</code>{" "}
                  <span className="text-muted-foreground">
                    {VARIABLE_MEANING[language][index]}
                  </span>
                </li>
              ))}
            </ul>
          </Disclosure>
          <FieldSet>
            <FieldLegend>{words.starters}</FieldLegend>
            <FieldGroup>
              {starters.map((starter, index) => (
                <Field key={index} orientation="horizontal">
                  <Input
                    aria-label={`${words.starter} ${index + 1}`}
                    value={starter}
                    maxLength={INSTRUCTIONS_LIMITS.starter}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        starters: starters.map((value, at) =>
                          at === index ? event.target.value : value,
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${words.removeStarter} ${index + 1}`}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        starters: starters.filter((_, at) => at !== index),
                      })
                    }
                  >
                    <X aria-hidden="true" />
                  </Button>
                </Field>
              ))}
              {starters.length < INSTRUCTIONS_LIMITS.starters && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() =>
                    setDraft({ ...draft, starters: [...starters, ""] })
                  }
                >
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  {words.addStarter}
                </Button>
              )}
            </FieldGroup>
          </FieldSet>
        </FieldGroup>
        {view.history.length > 0 && (
          <Disclosure title={words.history}>
            <Card variant="list" role="list" aria-label={words.history}>
              {view.history.map((version) => (
                <Item
                  key={version.revision}
                  variant="row"
                  size="row"
                  role="listitem"
                >
                  <ItemMedia variant="icon">
                    <History aria-hidden="true" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      <span className="tabular-nums">#{version.revision}</span>{" "}
                      {version.authorName ?? words.unknownAuthor}
                    </ItemTitle>
                    <ItemDescription>
                      <RelativeTime value={version.createdAt} />
                      {version.restoredFrom
                        ? `, ${words.restored.replace(
                            "{revision}",
                            String(version.restoredFrom),
                          )}`
                        : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {version.revision !== view.revision && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`${words.restore} #${version.revision}`}
                        onClick={() =>
                          void send({
                            type: "restore",
                            scope: view.scope,
                            revision: view.revision,
                            version: version.revision,
                          })
                        }
                      >
                        <RotateCcw
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        {words.restore}
                      </Button>
                    )}
                  </ItemActions>
                </Item>
              ))}
            </Card>
          </Disclosure>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </fieldset>
      <SheetFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={onClose}
        >
          {words.cancel}
        </Button>
        <SubmitButton pending={pending}>{words.save}</SubmitButton>
      </SheetFooter>
    </form>
  );
}

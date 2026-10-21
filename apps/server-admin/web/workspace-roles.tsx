import { useId, useState, type ReactNode } from "react";
import { Plus, ShieldCheck, Pencil, Trash2 } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Checkbox } from "@admin/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
  FieldDescription,
} from "@admin/components/ui/field";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@admin/components/ui/sheet";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@admin/components/ui/empty";
import {
  ConfirmAction,
  MoreActions,
  SearchField,
} from "@admin/components/console/forms";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
import { plural } from "./lib/plural";
import { useShellCopy } from "./shell-copy";
import { Card } from "@admin/components/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import type { OrganizationDetail } from "../../../packages/protocol/identity";
import { useAdmin } from "./context";

type Workspace = OrganizationDetail["workspaces"][number];
type Role = NonNullable<Workspace["roles"]>[number];
export function WorkspaceRolePicker({
  roles,
  value,
  onChange,
  disabled = false,
}: {
  roles: readonly { id: string; name: string }[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const { language } = useAdmin();
  if (!roles.length) return null;
  return (
    <FieldSet disabled={disabled}>
      <FieldLegend>
        {language === "cs" ? "Role v prostoru" : "Workspace roles"}
      </FieldLegend>
      <FieldGroup className="sm:flex-row sm:flex-wrap">
        {roles.map((role) => (
          <Field key={role.id} orientation="horizontal" className="w-auto">
            <Checkbox
              id={`${id}-${role.id}`}
              checked={value.includes(role.id)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(
                  checked === true
                    ? [...value, role.id]
                    : value.filter((item) => item !== role.id),
                )
              }
            />
            <FieldLabel htmlFor={`${id}-${role.id}`}>{role.name}</FieldLabel>
          </Field>
        ))}
      </FieldGroup>
    </FieldSet>
  );
}

export function WorkspaceRoles({
  workspace,
  detail,
  pending,
  mutate,
  feedback,
  open,
  onOpenChange,
}: {
  workspace: Workspace;
  detail: OrganizationDetail;
  pending: boolean;
  mutate: (input: Record<string, unknown>) => Promise<boolean>;
  feedback: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { language, copy } = useAdmin();
  const shell = useShellCopy();
  const cs = language === "cs";
  const [draft, setDraft] = useState<Role | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [search, setSearch] = useState("");
  const roles = workspace.roles ?? [];
  const eligible = detail.members.filter(
    (member) =>
      member.role !== "member" || workspace.members.includes(member.id),
  );
  const visible = eligible.filter((member) =>
    `${member.name} ${member.email}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase()),
  );
  const target = {
    organizationId: detail.organizationId,
    workspaceId: workspace.id,
  };
  const edit = (role: Role) => {
    setSearch("");
    setDraft(role);
  };
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!pending) {
          onOpenChange(value);
          setDraft(null);
          setDeleting(null);
        }
      }}
    >
      <SheetContent size="lg">
        <SheetHeader>
          <SheetTitle>
            {draft
              ? draft.id
                ? cs
                  ? "Upravit roli"
                  : "Edit role"
                : cs
                  ? "Přidat roli"
                  : "Add role"
              : cs
                ? "Role v prostoru"
                : "Workspace roles"}
          </SheetTitle>
          <SheetDescription>{workspace.name}</SheetDescription>
        </SheetHeader>
        {draft ? (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                await mutate({
                  ...target,
                  type: "saveWorkspaceRole",
                  ...draft,
                  id: draft.id || undefined,
                })
              )
                setDraft(null);
            }}
          >
            <fieldset
              disabled={pending}
              className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4"
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="workspace-role-name">
                    {cs ? "Název" : "Name"}
                  </FieldLabel>
                  <Input
                    id="workspace-role-name"
                    value={draft.name}
                    maxLength={100}
                    required
                    onChange={(event) =>
                      setDraft({ ...draft, name: event.target.value })
                    }
                  />
                </Field>
                <FieldSet>
                  <FieldLegend>
                    {cs ? "Členové" : "Members"}{" "}
                    <span className="font-normal text-muted-foreground tabular-nums">
                      {draft.memberIds.length}
                    </span>
                  </FieldLegend>
                  <SearchField
                    placeholder={cs ? "Hledat členy…" : "Search members…"}
                    value={search}
                    onChange={setSearch}
                  />
                  <FieldGroup>
                    {visible.map((member) => (
                      <Field key={member.id} orientation="horizontal">
                        <Checkbox
                          id={`role-member-${member.id}`}
                          checked={draft.memberIds.includes(member.id)}
                          onCheckedChange={(checked) =>
                            setDraft({
                              ...draft,
                              memberIds:
                                checked === true
                                  ? [...draft.memberIds, member.id]
                                  : draft.memberIds.filter(
                                      (id) => id !== member.id,
                                    ),
                            })
                          }
                        />
                        <FieldLabel htmlFor={`role-member-${member.id}`}>
                          {member.name}
                          <span className="font-normal text-muted-foreground">
                            {member.email}
                          </span>
                        </FieldLabel>
                      </Field>
                    ))}
                    {!visible.length && (
                      <FieldDescription>
                        {cs
                          ? "Žádní odpovídající členové."
                          : "No matching members."}
                      </FieldDescription>
                    )}
                  </FieldGroup>
                </FieldSet>
              </FieldGroup>
              {feedback}
            </fieldset>
            <SheetFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => setDraft(null)}
              >
                {copy.cancel}
              </Button>
              <Button type="submit" disabled={pending || !draft.name.trim()}>
                {draft.id ? copy.saveChanges : cs ? "Přidat roli" : "Add role"}
              </Button>
            </SheetFooter>
          </form>
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
              {!roles.length ? (
                <Empty variant="outline">
                  <EmptyHeader>
                    <EmptyTitle>
                      {cs ? "Zatím žádné role" : "No roles yet"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {cs
                        ? "Například Obchod nebo Podpora."
                        : "For example Sales or Support."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <Card variant="list">
                  {roles.map((role) => (
                    <Item key={role.id} variant="row" size="row">
                      <ItemMedia variant="icon">
                        <ShieldCheck aria-hidden="true" />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{role.name}</ItemTitle>
                        <ItemDescription>
                          {plural(
                            language,
                            role.memberIds.length,
                            shell.membersCount,
                          )}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <MoreActions
                          size="sm"
                          label={`${copy.moreActions}: ${role.name}`}
                        >
                          <DropdownMenuItem
                            disabled={pending}
                            onSelect={() => edit(role)}
                          >
                            <Pencil aria-hidden="true" />
                            {cs ? "Upravit" : "Edit"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={pending}
                            onSelect={() => setDeleting(role)}
                          >
                            <Trash2 aria-hidden="true" />
                            {cs ? "Smazat" : "Delete"}
                          </DropdownMenuItem>
                        </MoreActions>
                      </ItemActions>
                    </Item>
                  ))}
                </Card>
              )}
              {feedback}
            </div>
            <SheetFooter>
              <Button
                disabled={pending}
                onClick={() => {
                  setSearch("");
                  setDraft({ id: "", revision: 0, name: "", memberIds: [] });
                }}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                {cs ? "Přidat roli" : "Add role"}
              </Button>
            </SheetFooter>
          </>
        )}
        {deleting && (
          <ConfirmAction
            open
            onOpenChange={(value) => !value && setDeleting(null)}
            title={cs ? "Smazat roli?" : "Delete role?"}
            description={deleting.name}
            confirmLabel={cs ? "Smazat" : "Delete"}
            cancelLabel={copy.cancel}
            onConfirm={async () => {
              if (
                await mutate({
                  ...target,
                  type: "removeWorkspaceRole",
                  id: deleting.id,
                  revision: deleting.revision,
                })
              )
                setDeleting(null);
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

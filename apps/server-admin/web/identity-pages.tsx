import { WorkspaceRoles } from "./workspace-roles";
import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  Boxes,
  Building2,
  Check,
  KeyRound,
  Mail,
  Plus,
  ShieldCheck,
  UserMinus,
  Users,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@admin/components/ui/field";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@admin/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Avatar, AvatarFallback } from "@admin/components/ui/avatar";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/components/ui/table";
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
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
  type OrganizationDetail,
} from "../../../packages/protocol/identity";
import { PageHeader } from "@admin/components/console/page";
import {
  ConfirmAction,
  MoreActions,
  SearchField,
  SubmitButton,
} from "@admin/components/console/forms";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@admin/components/ui/tooltip";
import { EntityIcon, initials } from "@admin/components/console/entity-icon";
import { useAdmin } from "./context";
import { useConsoleScope } from "./console-scope";
import { api, ApiError, overviewKey } from "./lib/api";
import { AccountInputs, formValues, issue } from "./account-inputs";
import type { Copy } from "./i18n";
import { WorkspaceInvitations } from "./workspace-invitations";
import { PasswordResetSheet } from "./password-reset-sheet";
import { useShellCopy } from "./shell-copy";
import { plural } from "./lib/plural";

type Member = OrganizationDetail["members"][number];
type Workspace = OrganizationDetail["workspaces"][number];
const roles = ["owner", "admin", "member"] as const;

function Nothing({
  title,
  description,
  icon = <Building2 />,
  children,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Empty variant="outline">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
function AccountFields({ setup = false }: { setup?: boolean }) {
  const { copy } = useAdmin();
  return <AccountInputs copy={copy} setup={setup} />;
}
export function Accounts() {
  return <IdentityPage page="accounts" />;
}
export function Workspaces() {
  return <IdentityPage page="workspaces" />;
}
/**
 * Loads identity + organization detail and handles every pre-content state.
 * `content` pages (audit) render their own header once detail is available.
 */
export function IdentityPage({
  page,
  title,
  content,
  preserveDraft = false,
}: {
  page: "accounts" | "workspaces";
  title?: string;
  content?: (detail: OrganizationDetail, refreshFailed: boolean) => ReactNode;
  preserveDraft?: boolean;
}) {
  const { data, copy, selectedOrganization } = useAdmin();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<keyof Copy | null>(null);
  const [notice, setNotice] = useState<keyof Copy | null>(null);
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
    staleTime: 0,
    refetchInterval: 15_000,
  });
  const organizationId =
    identity.data?.organizations.find((o) => o.id === selectedOrganization)
      ?.id ?? identity.data?.organizations[0]?.id;
  const detail = useQuery({
    queryKey: [
      "admin",
      "organization",
      identity.data?.user?.id,
      organizationId,
    ],
    queryFn: async ({ signal }) =>
      OrganizationDetailSchema.parse(
        await api(
          `identity/organization?id=${encodeURIComponent(organizationId!)}`,
          undefined,
          signal,
        ),
      ),
    enabled: !!organizationId && !identity.isError,
    staleTime: 0,
    refetchInterval: 15_000,
  });
  async function mutate(input: unknown, setup = false) {
    if (pending) return false;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      // Direct request: passwords must never be retained in the Query mutation cache.
      await api(setup ? "identity/bootstrap" : "identity/command", input);
      await client.cancelQueries({ queryKey: ["admin", "organization"] });
      // After setup the console runs as the new owner, not the recovery key.
      if (setup) await client.invalidateQueries({ queryKey: overviewKey });
      await Promise.all([
        client.invalidateQueries({ queryKey: ["admin", "identity"] }),
        client.invalidateQueries({ queryKey: ["admin", "organization"] }),
        client.invalidateQueries({ queryKey: ["admin", "catalog"] }),
      ]);
      setNotice(setup ? "setupDone" : "saved");
      return true;
    } catch (failure) {
      setError(issue(failure));
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) {
        await client.invalidateQueries({ queryKey: ["admin"] });
      }
      return false;
    } finally {
      setPending(false);
    }
  }
  const loading = identity.isPending || (!!organizationId && detail.isPending);
  const failure = identity.error ?? detail.error;
  const keepDraft =
    preserveDraft &&
    !!identity.data?.user &&
    !!detail.data &&
    ![identity.error, detail.error].some(
      (e) => e instanceof ApiError && [401, 403, 404].includes(e.status),
    );
  const pageTitle =
    title ?? copy[page === "accounts" ? "people" : "workspaces"];
  const ready =
    data.authentication.identityEnabled &&
    !loading &&
    !(failure && !keepDraft) &&
    !identity.data?.needsSetup &&
    !!identity.data?.user &&
    !!organizationId &&
    !!detail.data;
  const banner = (
    <>
      {(error || failure) && (
        <Alert variant="destructive">
          <AlertDescription>{copy[error ?? issue(failure)]}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {copy[notice]}
        </p>
      )}
    </>
  );
  if (ready)
    return content ? (
      <>
        {banner}
        {content(detail.data!, !!failure)}
      </>
    ) : (
      <OrganizationContent
        key={`${page}:${organizationId}`}
        page={page}
        title={pageTitle}
        detail={detail.data!}
        pending={pending || detail.isFetching}
        banner={banner}
        mutate={(input) => mutate({ ...input, organizationId })}
      />
    );
  return (
    <>
      <PageHeader title={pageTitle} />
      {banner}
      {!data.authentication.identityEnabled ? (
        <Nothing
          title={copy.identityDisabled}
          description={copy.identityDisabledHint}
        />
      ) : loading ? (
        <Skeleton className="h-48 w-full" />
      ) : failure && !keepDraft ? (
        <Button
          variant="outline"
          className="self-start"
          onClick={() => {
            void client.invalidateQueries({ queryKey: ["admin"] });
          }}
        >
          {copy.retry}
        </Button>
      ) : identity.data?.needsSetup ? (
        <div className="flex justify-center py-6">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>{copy.setupTitle}</CardTitle>
              <CardDescription>{copy.setupDescription}</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(event) => {
                  const values = formValues(event);
                  void mutate(values, true);
                }}
              >
                <fieldset disabled={pending} className="contents">
                  <FieldGroup>
                    <AccountFields setup />
                    <SubmitButton pending={pending}>
                      {copy.setupAction}
                    </SubmitButton>
                  </FieldGroup>
                </fieldset>
              </form>
            </CardContent>
          </Card>
        </div>
      ) : !identity.data?.user ? (
        <Nothing
          title={copy.accountRequired}
          description={copy.accountRequiredHint}
        />
      ) : (
        <Nothing
          title={copy.noOrganization}
          description={copy.noOrganizationHint}
        />
      )}
    </>
  );
}
type Mutation = (input: Record<string, unknown>) => Promise<boolean>;
function OrganizationContent(props: {
  page: "accounts" | "workspaces";
  title: string;
  detail: OrganizationDetail;
  pending: boolean;
  banner: ReactNode;
  mutate: Mutation;
}) {
  return props.page === "accounts" ? (
    <People {...props} />
  ) : (
    <WorkspaceList {...props} />
  );
}

/** Right-side form sheet shared by the create flows. */
function FormSheet({
  open,
  onOpenChange,
  title,
  description,
  pending,
  submitLabel,
  onSubmit,
  feedback,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  pending: boolean;
  submitLabel: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** Submit errors render here, above the footer, not behind the sheet. */
  feedback?: ReactNode;
  children: ReactNode;
}) {
  const { copy } = useAdmin();
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => !pending && onOpenChange(value)}
    >
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <fieldset
            disabled={pending}
            className="min-h-0 flex-1 overflow-y-auto px-4"
          >
            <FieldGroup>
              {children}
              {feedback}
            </FieldGroup>
          </fieldset>
          <SheetFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {copy.cancel}
            </Button>
            <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function People({
  title,
  detail,
  pending,
  banner,
  mutate,
}: {
  title: string;
  detail: OrganizationDetail;
  pending: boolean;
  banner: ReactNode;
  mutate: Mutation;
}) {
  const { copy } = useAdmin();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("all");

  const query = search.trim().toLocaleLowerCase();
  const visible = detail.members.filter(
    (member) =>
      (role === "all" || member.role === role) &&
      `${member.name} ${member.email}`.toLocaleLowerCase().includes(query),
  );
  const manage = detail.canManageMembers;
  const scope = useConsoleScope().identity.data;
  const me = scope?.user?.id;
  const myRole = scope?.organizations.find(
    (o) => o.id === detail.organizationId,
  )?.role;
  const owners = detail.members.filter((m) => m.role === "owner").length;
  // Removing yourself or the last owner is refused by the server; don't offer it.
  const removable = (member: Member) =>
    manage &&
    member.userId !== me &&
    !(member.role === "owner" && owners === 1);
  // Owners reset anyone else's password; administrators only members'.
  const resettable = (member: Member) =>
    member.userId !== me &&
    (myRole === "owner" || (myRole === "admin" && member.role === "member"));
  const rowActions = manage || myRole === "admin";
  const [removing, setRemoving] = useState<Member | null>(null);
  const [resetting, setResetting] = useState<Member | null>(null);
  const scopeWorkspace = useConsoleScope().workspace?.id;
  const [inviteWorkspace, setInviteWorkspace] = useState(
    scopeWorkspace ?? detail.workspaces[0]?.id ?? "",
  );
  return (
    <>
      <ConfirmAction
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={copy.confirmRemove}
        description={removing ? `${removing.name} (${removing.email})` : ""}
        confirmLabel={copy.removeMember}
        cancelLabel={copy.cancel}
        onConfirm={() => {
          if (removing)
            void mutate({ type: "removeMember", memberId: removing.id });
        }}
      />
      <PageHeader
        title={title}
        count={detail.members.length || undefined}
        toolbar={
          <>
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder={copy.searchPeople}
            />
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="w-40" aria-label={copy.role}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{copy.allRoles}</SelectItem>
                {roles.map((value) => (
                  <SelectItem key={value} value={value}>
                    {copy[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
        actions={
          manage && (
            <Button
              onClick={() => setCreating(true)}
              disabled={pending || !detail.workspaces.length}
            >
              <Mail data-icon="inline-start" aria-hidden="true" />
              {copy.inviteByEmail}
            </Button>
          )
        }
      />
      {banner}
      <div className="flex flex-col gap-4">
        <Card variant="flush">
          <Table aria-label={title}>
            <TableHeader>
              <TableRow>
                <TableHead>{copy.name}</TableHead>
                <TableHead className="hidden md:table-cell">
                  {copy.email}
                </TableHead>
                <TableHead className="w-32 sm:w-40">{copy.role}</TableHead>
                {rowActions && (
                  <TableHead className="w-12">
                    <span className="sr-only">{copy.memberActions}</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="max-w-0 md:w-1/3">
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar size="sm">
                        <AvatarFallback>{initials(member.name)}</AvatarFallback>
                      </Avatar>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">
                          {member.name}
                          {member.userId === me && (
                            <span className="font-normal text-muted-foreground">
                              {" "}
                              ({copy.you})
                            </span>
                          )}
                        </span>
                        <span className="truncate text-xs text-muted-foreground md:hidden">
                          {member.email}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden max-w-0 md:table-cell">
                    <span className="block truncate text-muted-foreground">
                      {member.email}
                    </span>
                  </TableCell>
                  <TableCell>
                    {manage ? (
                      <Select
                        value={member.role}
                        disabled={pending}
                        onValueChange={(value) => {
                          void mutate({
                            type: "changeRole",
                            memberId: member.id,
                            role: value,
                          });
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-full"
                          aria-label={`${copy.role}: ${member.name}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {roles.map((value) => (
                            <SelectItem key={value} value={value}>
                              {copy[value]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-muted-foreground">
                        {copy[member.role]}
                      </span>
                    )}
                  </TableCell>
                  {rowActions && (
                    <TableCell>
                      {(removable(member) || resettable(member)) && (
                        <MoreActions
                          size="sm"
                          label={`${copy.memberActions}: ${member.name}`}
                        >
                          {resettable(member) && (
                            <DropdownMenuItem
                              disabled={pending}
                              onSelect={() => setResetting(member)}
                            >
                              <KeyRound aria-hidden="true" />
                              {copy.passwordResetLink}
                            </DropdownMenuItem>
                          )}
                          {removable(member) && (
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={pending}
                              onSelect={() => setRemoving(member)}
                            >
                              <UserMinus aria-hidden="true" />
                              {copy.removeMember}
                            </DropdownMenuItem>
                          )}
                        </MoreActions>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {!visible.length && (
                <TableRow>
                  <TableCell
                    colSpan={rowActions ? 4 : 3}
                    className="h-24 text-center"
                  >
                    <span className="text-muted-foreground">
                      {copy.noMatchingPeople}
                    </span>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
      <PasswordResetSheet
        organizationId={detail.organizationId}
        member={resetting}
        onClose={() => setResetting(null)}
      />
      {manage && (
        <Sheet open={creating} onOpenChange={setCreating}>
          <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
            <SheetHeader>
              <SheetTitle>{copy.inviteToWorkspace}</SheetTitle>
              {detail.workspaces.length === 1 && (
                <SheetDescription>
                  {detail.workspaces[0]!.name}
                </SheetDescription>
              )}
            </SheetHeader>
            {inviteWorkspace && (
              <WorkspaceInvitations
                organizationId={detail.organizationId}
                workspaceId={inviteWorkspace}
                onCancel={() => setCreating(false)}
                fields={
                  detail.workspaces.length > 1 && (
                    <Field>
                      <FieldLabel htmlFor="invite-workspace">
                        {copy.workspace}
                      </FieldLabel>
                      <Select
                        value={inviteWorkspace}
                        onValueChange={setInviteWorkspace}
                      >
                        <SelectTrigger id="invite-workspace" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {detail.workspaces.map((w) => (
                            <SelectItem key={w.id} value={w.id}>
                              {w.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )
                }
              />
            )}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

/** A single row action shown as an icon button with a tooltip. */
function IconAction({
  label,
  tooltip,
  disabled,
  onClick,
  children,
}: {
  label: string;
  tooltip: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function WorkspaceList({
  title,
  detail,
  pending,
  banner,
  mutate,
}: {
  title: string;
  detail: OrganizationDetail;
  pending: boolean;
  banner: ReactNode;
  mutate: Mutation;
}) {
  const { copy, language, setSelectedWorkspace } = useAdmin();
  const scope = useConsoleScope();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [membersFor, setMembersFor] = useState<string | null>(null);
  const [pairingFor, setPairingFor] = useState<string | null>(null);
  const [rolesFor, setRolesFor] = useState<string | null>(null);
  const shell = useShellCopy();
  const manage = detail.canManageWorkspaces;
  const searchable = detail.workspaces.length > 6;
  const query = searchable ? search.trim().toLocaleLowerCase() : "";
  const visible = detail.workspaces.filter((workspace) =>
    workspace.name.toLocaleLowerCase().includes(query),
  );
  // Owners and administrators reach every workspace without an explicit grant.
  const withAccess = (workspace: Workspace) =>
    detail.members.filter(
      (m) => m.role !== "member" || workspace.members.includes(m.id),
    );
  const editing = detail.workspaces.find((w) => w.id === membersFor);
  const pairing = detail.workspaces.find((w) => w.id === pairingFor);
  const rolesWorkspace = detail.workspaces.find((w) => w.id === rolesFor);
  return (
    <>
      <PageHeader
        title={title}
        count={detail.workspaces.length || undefined}
        toolbar={
          searchable && (
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder={copy.searchWorkspaces}
            />
          )
        }
        actions={
          manage &&
          detail.workspaces.length > 0 && (
            <Button onClick={() => setCreating(true)} disabled={pending}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {copy.addWorkspace}
            </Button>
          )
        }
      />
      {banner}
      {!detail.workspaces.length ? (
        <Nothing
          icon={<Boxes />}
          title={copy.noWorkspaces}
          description={manage ? copy.noWorkspacesHint : undefined}
        >
          {manage && (
            <Button onClick={() => setCreating(true)} disabled={pending}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {copy.addWorkspace}
            </Button>
          )}
        </Nothing>
      ) : (
        <div className="flex flex-col gap-4">
          <Card variant="list" role="list" aria-label={title}>
            {visible.map((workspace) => {
              const current = workspace.id === scope.workspace?.id;
              const summary = [
                plural(
                  language,
                  withAccess(workspace).length,
                  shell.membersCount,
                ),
                workspace.connectionCount > 0 &&
                  plural(
                    language,
                    workspace.connectionCount,
                    shell.connectionsCount,
                  ),
                workspace.toolCount > 0 &&
                  plural(language, workspace.toolCount, shell.toolsCount),
              ]
                .filter(Boolean)
                .join(", ");
              return (
                <Item
                  key={workspace.id}
                  variant="row"
                  size="row"
                  role="listitem"
                  className="relative"
                >
                  <ItemMedia>
                    <EntityIcon size="md" tone="muted">
                      <span className="text-xs font-semibold">
                        {initials(workspace.name)}
                      </span>
                    </EntityIcon>
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      {manage ? (
                        // The whole row opens the members sheet.
                        <button
                          type="button"
                          className="text-left break-words outline-none after:absolute after:inset-0 hover:underline focus-visible:underline"
                          onClick={() => setMembersFor(workspace.id)}
                        >
                          {workspace.name}
                        </button>
                      ) : (
                        <span className="break-words">{workspace.name}</span>
                      )}
                    </ItemTitle>
                    <ItemDescription>{summary}</ItemDescription>
                  </ItemContent>
                  <ItemActions className="relative">
                    {current ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Check aria-hidden="true" className="size-3.5" />
                        {copy.currentWorkspace}
                      </span>
                    ) : (
                      <IconAction
                        label={`${copy.switchTo}: ${workspace.name}`}
                        tooltip={copy.switchTo}
                        onClick={() => setSelectedWorkspace(workspace.id)}
                      >
                        <ArrowRightLeft aria-hidden="true" />
                      </IconAction>
                    )}
                    {manage && (
                      <MoreActions
                        size="sm"
                        label={`${copy.moreActions}: ${workspace.name}`}
                      >
                        <DropdownMenuItem
                          disabled={pending}
                          onSelect={() => setMembersFor(workspace.id)}
                        >
                          <Users aria-hidden="true" />
                          {copy.manageMembers}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => setPairingFor(workspace.id)}
                        >
                          <Mail aria-hidden="true" />
                          {copy.inviteByEmail}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={pending}
                          onSelect={() => setRolesFor(workspace.id)}
                        >
                          <ShieldCheck aria-hidden="true" />
                          {copy.workspaceRoles}
                        </DropdownMenuItem>
                      </MoreActions>
                    )}
                  </ItemActions>
                </Item>
              );
            })}
            {!visible.length && (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {copy.noMatchingWorkspaces}
              </p>
            )}
          </Card>
        </div>
      )}
      {manage && (
        <FormSheet
          open={creating}
          onOpenChange={setCreating}
          title={copy.addWorkspace}
          pending={pending}
          submitLabel={copy.addWorkspace}
          feedback={banner}
          onSubmit={(event) => {
            const values = formValues(event);
            void mutate({ type: "createWorkspace", ...values }).then((ok) => {
              if (ok) setCreating(false);
            });
          }}
        >
          <Field>
            <FieldLabel htmlFor="workspace-name">
              {copy.workspaceName}
            </FieldLabel>
            <Input id="workspace-name" name="name" maxLength={100} required />
          </Field>
        </FormSheet>
      )}
      <Sheet
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setMembersFor(null);
        }}
      >
        <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          {editing && (
            <WorkspaceMembers
              key={editing.id}
              workspace={editing}
              members={withAccess(editing)}
              pending={pending}
              mutate={mutate}
              invite={() => {
                setMembersFor(null);
                setPairingFor(editing.id);
              }}
              close={() => setMembersFor(null)}
            />
          )}
        </SheetContent>
      </Sheet>
      {manage && rolesWorkspace && (
        <WorkspaceRoles
          workspace={rolesWorkspace}
          detail={detail}
          pending={pending}
          mutate={mutate}
          feedback={banner}
          open
          onOpenChange={(open) => {
            if (!open) setRolesFor(null);
          }}
        />
      )}
      <Sheet
        open={!!pairing}
        onOpenChange={(open) => {
          if (!open) setPairingFor(null);
        }}
      >
        <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{copy.inviteToWorkspace}</SheetTitle>
            <SheetDescription>{pairing?.name}</SheetDescription>
          </SheetHeader>
          {pairing && (
            <WorkspaceInvitations
              organizationId={detail.organizationId}
              workspaceId={pairing.id}
              onCancel={() => setPairingFor(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * Everyone with access to a workspace. Owners and administrators always have
 * it; members get it by invitation and can lose it here.
 */
function WorkspaceMembers({
  workspace,
  members,
  pending,
  mutate,
  invite,
  close,
}: {
  workspace: Workspace;
  members: Member[];
  pending: boolean;
  mutate: Mutation;
  invite: () => void;
  close?: () => void;
}) {
  const { copy } = useAdmin();
  const me = useConsoleScope().identity.data?.user?.id;
  const [search, setSearch] = useState("");
  const [removing, setRemoving] = useState<Member | null>(null);
  const query = search.trim().toLocaleLowerCase();
  const visible = members.filter((member) =>
    `${member.name} ${member.email}`.toLocaleLowerCase().includes(query),
  );
  return (
    <>
      <SheetHeader>
        <SheetTitle>{copy.workspaceMembers}</SheetTitle>
        <SheetDescription>{workspace.name}</SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
        {members.length > 8 && (
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={copy.searchPeople}
          />
        )}
        <Card variant="list" role="list" aria-label={copy.workspaceMembers}>
          {visible.map((member) => (
            <Item key={member.id} variant="row" size="row" role="listitem">
              <ItemMedia>
                <Avatar size="sm">
                  <AvatarFallback>{initials(member.name)}</AvatarFallback>
                </Avatar>
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  <span className="truncate">
                    {member.name}
                    {member.userId === me && (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        ({copy.you})
                      </span>
                    )}
                  </span>
                </ItemTitle>
                <ItemDescription>{member.email}</ItemDescription>
              </ItemContent>
              <ItemActions>
                {member.role === "member" ? (
                  <MoreActions
                    size="sm"
                    label={`${copy.moreActions}: ${member.name}`}
                  >
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={pending}
                      onSelect={() => setRemoving(member)}
                    >
                      <UserMinus aria-hidden="true" />
                      {copy.removeAccess}
                    </DropdownMenuItem>
                  </MoreActions>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {copy[member.role]}
                  </span>
                )}
              </ItemActions>
            </Item>
          ))}
          {!visible.length && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {copy.noMatchingPeople}
            </p>
          )}
        </Card>
      </div>
      <SheetFooter>
        {close && (
          <Button type="button" variant="ghost" onClick={close}>
            {copy.close}
          </Button>
        )}
        <Button type="button" disabled={pending} onClick={invite}>
          <Mail data-icon="inline-start" aria-hidden="true" />
          {copy.inviteByEmail}
        </Button>
      </SheetFooter>
      <ConfirmAction
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={copy.removeAccessConfirm}
        description={removing ? `${removing.name} · ${workspace.name}` : ""}
        confirmLabel={copy.removeAccess}
        cancelLabel={copy.cancel}
        onConfirm={() => {
          if (removing)
            void mutate({
              type: "setWorkspaceMember",
              workspaceId: workspace.id,
              memberId: removing.id,
              allowed: false,
            });
        }}
      />
    </>
  );
}

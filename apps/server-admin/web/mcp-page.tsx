import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { Ban, Cable, Copy, Plus } from "lucide-react";
import { z } from "zod";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@admin/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@admin/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@admin/components/ui/field";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Spinner } from "@admin/components/ui/spinner";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@admin/components/ui/item";
import { Checkbox } from "@admin/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import { PageHeader, Section } from "@admin/components/console/page";
import {
  ConfirmAction,
  DetailList,
  MoreActions,
  SubmitButton,
} from "@admin/components/console/forms";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@admin/components/ui/dropdown-menu";
import { CodeBlock, Disclosure } from "@admin/components/console/disclosure";
import { StatusBadge } from "@admin/components/console/status";
import { useAdmin } from "./context";
import { useConsoleScope } from "./console-scope";
import { api, ApiError } from "./lib/api";
import {
  MCP_SCOPES,
  mcpScopeCopy,
  useMcpCopy,
  type McpCopy,
  type McpScope,
} from "./mcp-copy";
import { McpOAuthClient } from "./mcp-oauth-client";
import { loadMcpAdmin, mcpAdminKey } from "./lib/mcp-admin";
import type {
  McpAdminApp,
  McpAdminGrant,
  McpPolicy,
} from "../../../packages/protocol/mcp-admin";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import { SettingRow, SettingRows } from "@admin/components/console/setting-row";

const searchId = z.string().trim().min(1).max(200).optional().catch(undefined);
export const mcpSearchSchema = z.object({
  approval: searchId,
  workspaceId: searchId,
});
const GrantSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(100),
  scopes: z.array(z.enum(MCP_SCOPES)).min(1).max(3),
  createdAt: z.iso.datetime().optional(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
const AccessSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  grants: z.array(GrantSchema).max(1000),
});
const IssuedSchema = z.object({
  grant: GrantSchema,
  accessToken: z.string().min(1).max(4096),
});
const day = 86_400_000;

function issueMessage(
  error: unknown,
  copy: McpCopy,
  fallback: "failed" | "loadFailed" | "callLoadFailed" = "failed",
) {
  if (error instanceof ApiError) {
    if (error.status === 401) return copy.authError;
    if (error.status === 403) return copy.forbidden;
    if (error.status === 404) return copy.notFound;
    if (error.status === 409) return copy.conflict;
    if (error.status === 422 || error.status === 400) return copy.invalid;
    if (error.status === 429) return copy.rateError;
  }
  return copy[fallback];
}
function ErrorNotice({
  message,
  retry,
  pending,
}: {
  message: string;
  retry?: () => void;
  pending?: boolean;
}) {
  const copy = useMcpCopy();
  return (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
      {retry ? (
        <AlertAction>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={retry}
          >
            {copy.refresh}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}

export function McpPage() {
  const copy = useMcpCopy();
  const { data, authorityGeneration, setSelectedWorkspace } = useAdmin();
  const scope = useConsoleScope();
  const search = mcpSearchSchema.parse(useSearch({ strict: false }));
  const mismatch =
    !!search.approval && search.workspaceId !== scope.workspace?.id;
  const callWorkspace = scope.detail.data?.workspaces.find(
    (workspace) => workspace.id === search.workspaceId,
  );
  const error = scope.identity.error ?? scope.detail.error;
  const [creating, setCreating] = useState(false);
  const ready =
    data.authentication.current === "better-auth" &&
    !error &&
    !!scope.workspace &&
    !scope.identity.isPending &&
    !scope.detail.isPending;
  return (
    <>
      <PageHeader
        title={copy.title}
        description={copy.subtitle}
        actions={
          ready ? (
            <Button onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {copy.createToken}
            </Button>
          ) : undefined
        }
      />
      {data.authentication.current !== "better-auth" ? (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Cable />
            </EmptyMedia>
            <EmptyTitle>{copy.accountOnly}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : error ? (
        <ErrorNotice
          message={issueMessage(error, copy, "loadFailed")}
          retry={() => {
            void scope.identity.refetch();
            void scope.detail.refetch();
          }}
        />
      ) : scope.identity.isPending ||
        (scope.organization && scope.detail.isPending) ? (
        <div role="status">
          <span className="sr-only">{copy.loading}</span>
          <Skeleton className="h-72 w-full" />
        </div>
      ) : !scope.workspace ? (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Cable />
            </EmptyMedia>
            <EmptyTitle>{copy.noWorkspace}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link to="/workspaces">{copy.workspaces}</Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          {mismatch ? (
            <Alert>
              <AlertDescription>{copy.callWorkspaceMismatch}</AlertDescription>
              {callWorkspace ? (
                <AlertAction>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedWorkspace(callWorkspace.id)}
                  >
                    {copy.selectCallWorkspace}: {callWorkspace.name}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          ) : null}
          {search.approval && !mismatch ? (
            <ConnectorApproval
              key={`${authorityGeneration}:${scope.workspace.id}:${search.approval}`}
              workspaceId={scope.workspace.id}
              requestId={search.approval}
            />
          ) : null}
          {scope.organization && scope.detail.data?.canManageWorkspaces ? (
            <MembersMcp
              key={`${authorityGeneration}:${data.authentication.principalId}:${scope.workspace.id}`}
              organizationId={scope.organization.id}
              workspaceId={scope.workspace.id}
            />
          ) : null}
          <WorkspaceMcp
            key={`${authorityGeneration}:${data.authentication.principalId}:${scope.workspace.id}`}
            workspaceId={scope.workspace.id}
            creating={creating}
            onCreatingChange={setCreating}
          />
        </>
      )}
    </>
  );
}

function WorkspaceMcp({
  workspaceId,
  creating,
  onCreatingChange: setCreating,
}: {
  workspaceId: string;
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
}) {
  const copy = useMcpCopy();
  const { data, authorityGeneration, language } = useAdmin();
  const shortDate = (value: string) =>
    new Date(value).toLocaleDateString(language, { dateStyle: "medium" });
  const client = useQueryClient();
  const id = useId();
  const [revoking, setRevoking] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<McpScope[]>([...MCP_SCOPES]);
  const [days, setDays] = useState("7");
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The issue response contains a secret: keep it out of Query's caches.
  const [token, setToken] = useState<{ value: string; grantId: string } | null>(
    null,
  );
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const query = useQuery({
    queryKey: [
      "admin",
      "mcp",
      "access",
      authorityGeneration,
      data.authentication.principalId,
      workspaceId,
    ],
    queryFn: async ({ signal }) =>
      AccessSchema.parse(
        await api("identity/mcp/access/list", { workspaceId }, signal),
      ),
    staleTime: 0,
    refetchInterval: pending ? false : 15_000,
    retry: false,
  });
  const labelValid = label.trim().length > 0 && label.trim().length <= 100;
  const disabled = pending || query.isError || !query.data;
  async function issue(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!labelValid || !scopes.length || disabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    setNotice(null);
    setToken(null);
    setCopyStatus(null);
    try {
      const issued = IssuedSchema.parse(
        await api(
          "identity/mcp/access/issue",
          {
            workspaceId,
            label: label.trim(),
            scopes: MCP_SCOPES.filter((scope) => scopes.includes(scope)),
            // Slightly under the 30-day server maximum to absorb clock skew.
            expiresAt: Date.now() + Number(days) * day - 60_000,
          },
          controller.signal,
        ),
      );
      if (controller.signal.aborted) return;
      setToken({ value: issued.accessToken, grantId: issued.grant.id });
      setLabel("");
      setSubmitted(false);
      setCreating(false);
      await query.refetch();
      void client.invalidateQueries({ queryKey: ["admin", "audit"] });
    } catch (cause) {
      if (!controller.signal.aborted) setError(issueMessage(cause, copy));
    } finally {
      if (!controller.signal.aborted) {
        setPending(false);
        request.current = null;
      }
    }
  }
  async function revoke(grantId: string) {
    if (disabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    setNotice(null);
    if (token?.grantId === grantId) setToken(null);
    try {
      await api(
        "identity/mcp/access/revoke",
        { workspaceId, grantId },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setNotice(copy.revokedMessage);
      await query.refetch();
      void client.invalidateQueries({ queryKey: ["admin", "audit"] });
    } catch (cause) {
      if (!controller.signal.aborted) setError(issueMessage(cause, copy));
    } finally {
      if (!controller.signal.aborted) {
        setPending(false);
        request.current = null;
      }
    }
  }
  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(copy.copied);
    } catch {
      setCopyStatus(copy.copyFailed);
    }
  }
  if (query.isError)
    return (
      <ErrorNotice
        message={issueMessage(query.error, copy, "loadFailed")}
        retry={() => void query.refetch()}
        pending={query.isFetching}
      />
    );
  if (!query.data)
    return (
      <div role="status">
        <span className="sr-only">{copy.loading}</span>
        <Skeleton className="h-72 w-full" />
      </div>
    );
  const config = {
    mcpServers: {
      niaro: {
        url: query.data.endpoint,
        headers: { Authorization: "Bearer YOUR_TOKEN" },
      },
    },
  };
  const grants = [...query.data.grants].sort(
    (a, b) =>
      Number(a.revokedAt !== null) - Number(b.revokedAt !== null) ||
      Date.parse(b.expiresAt) - Date.parse(a.expiresAt),
  );
  return (
    <>
      {error ? <ErrorNotice message={error} /> : null}
      {notice ? (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {token ? (
        <Alert>
          <AlertTitle>{copy.tokenHint}</AlertTitle>
          <AlertDescription>
            <CodeBlock value={token.value} />
            {copyStatus ? <p role="status">{copyStatus}</p> : null}
          </AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void copyText(token.value)}
            >
              <Copy data-icon="inline-start" aria-hidden="true" />
              {copy.copyToken}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setToken(null);
                setCopyStatus(null);
              }}
            >
              {copy.closeToken}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      <Section title={copy.endpoint}>
        <Card variant="list">
          <div className="flex min-h-11 items-center justify-between gap-4 px-4 py-2">
            <code className="min-w-0 font-mono text-xs break-all">
              {query.data.endpoint}
            </code>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => void copyText(query.data!.endpoint)}
            >
              <Copy data-icon="inline-start" aria-hidden="true" />
              {copy.copyEndpoint}
            </Button>
          </div>
          <div className="flex flex-col gap-1 px-4 py-2">
            <Disclosure title={copy.configuration}>
              <CodeBlock value={config} />
            </Disclosure>
            <Disclosure title={copy.register}>
              <McpOAuthClient workspaceId={workspaceId} />
            </Disclosure>
          </div>
        </Card>
      </Section>
      <Section title={copy.tokens} count={grants.length}>
        {grants.length === 0 ? (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Cable />
              </EmptyMedia>
              <EmptyTitle>{copy.empty}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card variant="list">
            {grants.map((grant) => {
              const revoked = grant.revokedAt !== null;
              const expired =
                Date.parse(grant.expiresAt) <= query.dataUpdatedAt;
              return (
                <Item key={grant.id} variant="row" size="row">
                  <ItemContent>
                    <ItemTitle>{grant.label}</ItemTitle>
                    <ItemDescription>
                      {MCP_SCOPES.filter((scope) =>
                        grant.scopes.includes(scope),
                      )
                        .map((scope) => copy[mcpScopeCopy[scope][0]])
                        .join(", ")}
                      {" · "}
                      {copy.expires} {shortDate(grant.expiresAt)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {revoked || expired ? (
                      <StatusBadge tone={revoked ? "neutral" : "warning"}>
                        {revoked ? copy.revoked : copy.expired}
                      </StatusBadge>
                    ) : (
                      <MoreActions label={copy.moreActions} size="sm">
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={disabled}
                            onSelect={() =>
                              setRevoking({ id: grant.id, label: grant.label })
                            }
                          >
                            <Ban aria-hidden="true" />
                            {copy.revoke}
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </MoreActions>
                    )}
                  </ItemActions>
                </Item>
              );
            })}
          </Card>
        )}
      </Section>
      <ConfirmAction
        open={!!revoking}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={copy.revokeTitle}
        description={revoking ? `${revoking.label} · ${copy.revokeHint}` : ""}
        confirmLabel={copy.revoke}
        cancelLabel={copy.cancel}
        onConfirm={() => {
          if (revoking) return revoke(revoking.id);
        }}
      />
      <Sheet
        open={creating}
        onOpenChange={(open) => !pending && setCreating(open)}
      >
        <SheetContent>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => void issue(event)}
          >
            <SheetHeader>
              <SheetTitle>{copy.createToken}</SheetTitle>
              <SheetDescription>{copy.createTokenHint}</SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-4">
              <FieldGroup>
                <Field data-invalid={submitted && !labelValid}>
                  <FieldLabel htmlFor={`${id}-label`}>{copy.label}</FieldLabel>
                  <Input
                    id={`${id}-label`}
                    value={label}
                    maxLength={100}
                    autoComplete="off"
                    placeholder={copy.labelPlaceholder}
                    disabled={pending}
                    aria-invalid={submitted && !labelValid}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                  {submitted && !labelValid ? (
                    <FieldError>{copy.labelInvalid}</FieldError>
                  ) : null}
                </Field>
                <FieldSet data-invalid={submitted && !scopes.length}>
                  <FieldLegend variant="label">{copy.permissions}</FieldLegend>
                  <FieldGroup>
                    {MCP_SCOPES.map((scope) => (
                      <Field
                        key={scope}
                        orientation="horizontal"
                        data-disabled={pending}
                      >
                        <Checkbox
                          id={`${id}-${scope}`}
                          disabled={pending}
                          checked={scopes.includes(scope)}
                          onCheckedChange={(checked) =>
                            setScopes((previous) =>
                              checked === true
                                ? [
                                    ...previous.filter(
                                      (item) => item !== scope,
                                    ),
                                    scope,
                                  ]
                                : previous.filter((item) => item !== scope),
                            )
                          }
                        />
                        <FieldContent>
                          <FieldLabel htmlFor={`${id}-${scope}`}>
                            {copy[mcpScopeCopy[scope][0]]}
                          </FieldLabel>
                          <FieldDescription>
                            {copy[mcpScopeCopy[scope][1]]}
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                    ))}
                  </FieldGroup>
                  {submitted && !scopes.length ? (
                    <FieldError>{copy.scopesRequired}</FieldError>
                  ) : null}
                </FieldSet>
                <Field>
                  <FieldLabel id={`${id}-days`}>{copy.validFor}</FieldLabel>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={days}
                    disabled={pending}
                    aria-labelledby={`${id}-days`}
                    onValueChange={(value) => value && setDays(value)}
                  >
                    <ToggleGroupItem value="1">{copy.day1}</ToggleGroupItem>
                    <ToggleGroupItem value="7">{copy.days7}</ToggleGroupItem>
                    <ToggleGroupItem value="30">{copy.days30}</ToggleGroupItem>
                  </ToggleGroup>
                </Field>
              </FieldGroup>
            </div>
            <SheetFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => setCreating(false)}
              >
                {copy.cancel}
              </Button>
              <SubmitButton pending={pending} disabled={disabled}>
                {copy.createToken}
              </SubmitButton>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}

const ConnectorCallSchema = z.object({
  call: z.object({
    requestId: z.string(),
    organizationId: z.string(),
    workspaceId: z.string(),
    serviceId: z.string(),
    actionId: z.string(),
    serviceRevision: z.number(),
    actionRevision: z.number(),
    title: z.string(),
    serviceName: z.string(),
    effect: z.enum(["read", "write"]),
    input: z.record(z.string(), z.unknown()),
    status: z.string(),
  }),
});

/** A connector call that needs a person: approve re-sends the same receipt
 * through the console's catalog invoke, which owns authorization and audit. */
function ConnectorApproval({
  workspaceId,
  requestId,
}: {
  workspaceId: string;
  requestId: string;
}) {
  const copy = useMcpCopy();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["admin", "mcp", "connector-call", workspaceId, requestId],
    queryFn: async ({ signal }) =>
      ConnectorCallSchema.parse(
        await api(
          "identity/mcp/access/connector-call",
          { workspaceId, requestId },
          signal,
        ),
      ).call,
    retry: false,
  });
  async function decide(approve: boolean) {
    const call = query.data;
    if (!call || pending) return;
    setPending(true);
    setError(null);
    try {
      if (approve)
        await api("identity/catalog/invoke", {
          organizationId: call.organizationId,
          workspaceId: call.workspaceId,
          serviceId: call.serviceId,
          actionId: call.actionId,
          revision: call.actionRevision,
          serviceRevision: call.serviceRevision,
          input: call.input,
          requestId: call.requestId,
          approve: true,
        });
      else
        await api("identity/mcp/access/connector-reject", {
          workspaceId,
          requestId,
        });
    } catch (cause) {
      setError(issueMessage(cause, copy));
    } finally {
      setPending(false);
      void query.refetch();
    }
  }
  if (query.isPending) return <Skeleton className="h-48 w-full" />;
  if (query.isError)
    return (
      <ErrorNotice
        message={issueMessage(query.error, copy, "callLoadFailed")}
        retry={() => void query.refetch()}
      />
    );
  const call = query.data;
  const waiting = call.status === "awaiting_approval";
  return (
    <Section title={copy.approvalCall}>
      <Card>
        <CardHeader>
          <CardTitle>{call.title}</CardTitle>
          {!waiting && (
            <CardDescription>
              {call.status === "succeeded"
                ? copy.callDone
                : call.status === "rejected"
                  ? copy.callDeclined
                  : call.status === "failed" || call.status === "unknown"
                    ? copy.callFailed
                    : copy.callClosed}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            {error ? <ErrorNotice message={error} /> : null}
            <DetailList
              items={[
                { label: copy.service, value: call.serviceName },
                {
                  label: copy.effect,
                  value: call.effect === "write" ? copy.write : copy.read,
                },
              ]}
            />
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">
                {copy.input}
              </span>
              <CodeBlock value={call.input} />
            </div>
          </div>
        </CardContent>
        {waiting && (
          <CardFooter>
            <div className="flex w-full flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => void decide(false)}
              >
                {copy.decline}
              </Button>
              <Button disabled={pending} onClick={() => void decide(true)}>
                {pending && <Spinner data-icon="inline-start" />}
                {copy.approve}
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>
    </Section>
  );
}

const appTone = {
  approved: "success",
  pending: "warning",
  rejected: "danger",
} as const;
const appLabel = {
  approved: "appApproved",
  pending: "appPending",
  rejected: "appRejected",
} as const;
const person = (value: { name: string; email: string }) =>
  value.name ? `${value.name} (${value.email})` : value.email;

/** A waiting grant or app: approve, or reject with a reason the person sees. */
function RequestRow({
  title,
  description,
  disabled,
  decide,
}: {
  title: string;
  description: string;
  disabled: boolean;
  decide: (decision: "approve" | "reject", reason?: string) => void;
}) {
  const copy = useMcpCopy();
  const [reason, setReason] = useState("");
  return (
    <Item variant="row" size="row" data-testid="mcp-request">
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription className="break-words">{description}</ItemDescription>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            aria-label={copy.rejectReason}
            placeholder={copy.rejectReason}
            className="min-w-0 flex-1 basis-48"
            maxLength={500}
            value={reason}
            disabled={disabled}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => decide("reject", reason.trim() || undefined)}
          >
            {copy.decline}
          </Button>
          <Button disabled={disabled} onClick={() => decide("approve")}>
            {copy.approve}
          </Button>
        </div>
      </ItemContent>
    </Item>
  );
}

/** Owners and administrators: members' policy, requests, access and apps
 * of the selected workspace (NIAR-237). Every decision is revision-checked. */
function MembersMcp({
  organizationId,
  workspaceId,
}: {
  organizationId: string;
  workspaceId: string;
}) {
  const copy = useMcpCopy();
  const { data, language } = useAdmin();
  const client = useQueryClient();
  const target = { organizationId, workspaceId };
  const query = useQuery({
    queryKey: mcpAdminKey(data.authentication.principalId, workspaceId),
    queryFn: ({ signal }) => loadMcpAdmin(target, signal),
    staleTime: 0,
    refetchInterval: 15_000,
    retry: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    label: string;
    path: string;
    body: object;
  } | null>(null);
  async function send(path: string, body: object) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await api(`identity/mcp/admin/${path}`, { ...target, ...body });
      void client.invalidateQueries({ queryKey: ["admin", "audit"] });
    } catch (cause) {
      setError(issueMessage(cause, copy));
    } finally {
      setPending(false);
      void query.refetch();
    }
  }
  if (query.isError)
    return (
      <ErrorNotice
        message={issueMessage(query.error, copy, "loadFailed")}
        retry={() => void query.refetch()}
        pending={query.isFetching}
      />
    );
  if (!query.data) return <Skeleton className="h-40 w-full" />;
  const state = query.data;
  const shortDate = (value: string) =>
    new Date(value).toLocaleDateString(language, { dateStyle: "medium" });
  const scopes = (grant: McpAdminGrant) =>
    MCP_SCOPES.filter((scope) => grant.scopes.includes(scope))
      .map((scope) => copy[mcpScopeCopy[scope][0]])
      .join(", ");
  const grantLine = (grant: McpAdminGrant) =>
    [
      person(grant.person),
      grant.appName ? copy.linkedThrough.replace("{app}", grant.appName) : null,
      scopes(grant),
      `${copy.expires} ${shortDate(grant.expiresAt)}`,
    ]
      .filter(Boolean)
      .join(" · ");
  const appLine = (app: McpAdminApp) =>
    [
      app.requestedBy
        ? copy.requestedBy.replace("{person}", person(app.requestedBy))
        : null,
      app.host ?? app.redirectUris.join(", "),
    ]
      .filter(Boolean)
      .join(" · ");
  const requests = state.requests.grants.length + state.requests.apps.length;
  return (
    <>
      {error ? <ErrorNotice message={error} /> : null}
      <Section title={copy.membersApps} description={copy.membersAppsHint}>
        <SettingRows>
          <SettingRow
            label={copy.policyLabel}
            labelId="mcp-policy-label"
            meta={copy.policyOffHint}
            wide
          >
            <Select
              value={state.policy}
              disabled={pending}
              onValueChange={(value) => {
                const body = {
                  policy: value as McpPolicy,
                  revision: state.revision,
                };
                // Off ends members' access: confirm first.
                if (value === "off")
                  setConfirm({
                    title: copy.policyOff,
                    description: copy.policyOffHint,
                    label: copy.policyOff,
                    path: "policy",
                    body,
                  });
                else void send("policy", body);
              }}
            >
              <SelectTrigger
                aria-labelledby="mcp-policy-label"
                className="w-full"
                data-testid="mcp-policy"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">{copy.policyOff}</SelectItem>
                <SelectItem value="review">{copy.policyReview}</SelectItem>
                <SelectItem value="free">{copy.policyFree}</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </SettingRows>
      </Section>
      {requests > 0 ? (
        <Section title={copy.requests} count={requests}>
          <Card variant="list">
            {state.requests.grants.map((grant) => (
              <RequestRow
                key={grant.id}
                title={grant.label}
                description={grantLine(grant)}
                disabled={pending}
                decide={(decision, reason) =>
                  void send("review", {
                    kind: "grant",
                    id: grant.id,
                    revision: grant.revision,
                    decision,
                    ...(reason ? { reason } : {}),
                  })
                }
              />
            ))}
            {state.requests.apps.map((app) => (
              <RequestRow
                key={app.clientId}
                title={app.name}
                description={appLine(app)}
                disabled={pending}
                decide={(decision, reason) =>
                  void send("review", {
                    kind: "app",
                    clientId: app.clientId,
                    revision: app.revision,
                    decision,
                    ...(reason ? { reason } : {}),
                  })
                }
              />
            ))}
          </Card>
        </Section>
      ) : null}
      <Section title={copy.membersAccess} count={state.access.length}>
        {state.access.length === 0 ? (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyTitle>{copy.membersAccessEmpty}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card variant="list">
            {state.access.map((grant) => (
              <Item key={grant.id} variant="row" size="row">
                <ItemContent>
                  <ItemTitle>{grant.label}</ItemTitle>
                  <ItemDescription className="break-words">
                    {grantLine(grant)}
                    {" · "}
                    {grant.lastUsedAt
                      ? copy.lastUsed.replace(
                          "{date}",
                          shortDate(grant.lastUsedAt),
                        )
                      : copy.neverUsed}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <MoreActions label={copy.moreActions} size="sm">
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={pending}
                        onSelect={() =>
                          setConfirm({
                            title: copy.memberRevokeTitle,
                            description: `${grant.label} · ${copy.memberRevokeHint}`,
                            label: copy.revoke,
                            path: "revoke",
                            body: { grantId: grant.id },
                          })
                        }
                      >
                        <Ban aria-hidden="true" />
                        {copy.revoke}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </MoreActions>
                </ItemActions>
              </Item>
            ))}
          </Card>
        )}
      </Section>
      <Section title={copy.apps} count={state.apps.length}>
        {state.apps.length === 0 ? (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyTitle>{copy.appsEmpty}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card variant="list">
            {state.apps.map((app) => (
              <Item key={app.clientId} variant="row" size="row">
                <ItemContent>
                  <ItemTitle>
                    {app.name}
                    <StatusBadge
                      tone={app.state ? appTone[app.state] : "neutral"}
                    >
                      {copy[app.state ? appLabel[app.state] : "appUndecided"]}
                    </StatusBadge>
                  </ItemTitle>
                  <ItemDescription className="break-words">
                    {appLine(app)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {app.state === "approved" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        setConfirm({
                          title: copy.withdrawTitle,
                          description: `${app.name} · ${copy.withdrawHint}`,
                          label: copy.withdraw,
                          path: "review",
                          body: {
                            kind: "app",
                            clientId: app.clientId,
                            revision: app.revision,
                            decision: "withdraw",
                          },
                        })
                      }
                    >
                      {copy.withdraw}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        void send("review", {
                          kind: "app",
                          clientId: app.clientId,
                          revision: app.revision,
                          decision: "approve",
                        })
                      }
                    >
                      {copy.approve}
                    </Button>
                  )}
                </ItemActions>
              </Item>
            ))}
          </Card>
        )}
      </Section>
      <ConfirmAction
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm?.title ?? ""}
        description={confirm?.description ?? ""}
        confirmLabel={confirm?.label ?? ""}
        cancelLabel={copy.cancel}
        onConfirm={() => {
          if (confirm) return send(confirm.path, confirm.body);
        }}
      />
    </>
  );
}

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { Ban, Cable, Copy, Plus } from "lucide-react";
import { z } from "zod";
import {
  ServiceResultSchema,
  type ServiceResult,
} from "../../../packages/protocol/service-result";
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
  FieldTitle,
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
import { RadioGroup, RadioGroupItem } from "@admin/components/ui/radio-group";
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
import { StatusBadge, type Tone } from "@admin/components/console/status";
import { useAdmin } from "./context";
import { useConsoleScope } from "./console-scope";
import { api, ApiError } from "./lib/api";
import { useMcpCopy, type McpCopy } from "./mcp-copy";
import { McpOAuthClient } from "./mcp-oauth-client";

const searchId = z.string().trim().min(1).max(200).optional().catch(undefined);
export const mcpSearchSchema = z.object({
  taskId: searchId,
  approval: searchId,
  workspaceId: searchId,
});
const GrantSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(100),
  scopes: z
    .array(z.enum(["native.view", "native.run", "services.call"]))
    .min(1)
    .max(3),
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
const ApprovalSchema = z.object({
  kind: z.literal("human_approval"),
  operationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  message: z.string().max(4000).optional(),
});
const TaskSchema = z.object({
  taskId: z.string().min(1).max(200),
  status: z.string().min(1).max(100),
  reply: z.string().max(131072),
  result: ServiceResultSchema.optional(),
  nextInput: z.record(z.string(), z.unknown()).optional(),
});
type Approval = z.infer<typeof ApprovalSchema>;
const day = 86_400_000;

function issueMessage(
  error: unknown,
  copy: McpCopy,
  fallback: "failed" | "loadFailed" | "taskLoadFailed" = "failed",
  task = false,
) {
  if (error instanceof ApiError) {
    if (error.status === 401) return copy.authError;
    if (error.status === 403) return task ? copy.taskForbidden : copy.forbidden;
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
    !!(search.taskId || search.approval) &&
    search.workspaceId !== scope.workspace?.id;
  const taskWorkspace = scope.detail.data?.workspaces.find(
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
              <AlertDescription>{copy.taskWorkspaceMismatch}</AlertDescription>
              {taskWorkspace ? (
                <AlertAction>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedWorkspace(taskWorkspace.id)}
                  >
                    {copy.selectTaskWorkspace}: {taskWorkspace.name}
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
          <WorkspaceMcp
            key={`${authorityGeneration}:${data.authentication.principalId}:${scope.workspace.id}`}
            workspaceId={scope.workspace.id}
            creating={creating}
            onCreatingChange={setCreating}
          />
          {search.taskId && !mismatch ? (
            <McpTask
              key={`${authorityGeneration}:${data.authentication.principalId}:${scope.workspace.id}:${search.taskId}`}
              workspaceId={scope.workspace.id}
              taskId={search.taskId}
            />
          ) : null}
        </>
      )}
    </>
  );
}

type Mode = "connector" | "processor";
const modeOf = (scopes: string[]): Mode[] => [
  ...(scopes.includes("services.call") ? (["connector"] as const) : []),
  ...(scopes.some((scope) => scope.startsWith("native."))
    ? (["processor"] as const)
    : []),
];

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
  const [mode, setMode] = useState<Mode>("connector");
  const [permission, setPermission] = useState("run");
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
    if (!labelValid || disabled || request.current) return;
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
            scopes:
              mode === "connector"
                ? ["services.call"]
                : permission === "run"
                  ? ["native.view", "native.run"]
                  : ["native.view"],
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
              <McpOAuthClient />
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
                      {modeOf(grant.scopes)
                        .map(
                          (item) =>
                            copy[item] +
                            (item === "processor" &&
                            !grant.scopes.includes("native.run")
                              ? ` (${copy.viewOnly})`
                              : ""),
                        )
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
                <FieldSet>
                  <FieldLegend variant="label">{copy.mode}</FieldLegend>
                  <RadioGroup
                    value={mode}
                    disabled={pending}
                    onValueChange={(value) => setMode(value as Mode)}
                  >
                    {(["connector", "processor"] as const).map((item) => (
                      <FieldLabel key={item} htmlFor={`${id}-${item}`}>
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldTitle>{copy[item]}</FieldTitle>
                            <FieldDescription>
                              {copy[`${item}Hint`]}
                            </FieldDescription>
                          </FieldContent>
                          <RadioGroupItem value={item} id={`${id}-${item}`} />
                        </Field>
                      </FieldLabel>
                    ))}
                  </RadioGroup>
                </FieldSet>
                {mode === "processor" && (
                  <Field>
                    <FieldLabel id={`${id}-permission`}>
                      {copy.permissions}
                    </FieldLabel>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      value={permission}
                      disabled={pending}
                      aria-labelledby={`${id}-permission`}
                      onValueChange={(value) => {
                        if (value === "view" || value === "run")
                          setPermission(value);
                      }}
                    >
                      <ToggleGroupItem value="run">
                        {copy.viewRun}
                      </ToggleGroupItem>
                      <ToggleGroupItem value="view">
                        {copy.viewOnly}
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </Field>
                )}
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
        message={issueMessage(query.error, copy, "taskLoadFailed")}
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

function McpTask({
  workspaceId,
  taskId,
}: {
  workspaceId: string;
  taskId: string;
}) {
  const copy = useMcpCopy();
  const { data, authorityGeneration } = useAdmin();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const decisionIds = useRef(new Map<string, string>());
  useEffect(() => () => request.current?.abort(), []);
  const queryKey = [
    "admin",
    "mcp",
    "task",
    authorityGeneration,
    data.authentication.principalId,
    workspaceId,
    taskId,
  ];
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      TaskSchema.refine((task) => task.taskId === taskId).parse(
        await api("identity/mcp/task/get", { workspaceId, taskId }, signal),
      ),
    refetchInterval: (query) =>
      pending ||
      query.state.error !== null ||
      [
        "succeeded",
        "failed",
        "cancelled",
        "expired",
        "superseded",
        "unknown",
      ].includes(query.state.data?.status ?? "")
        ? false
        : 3000,
    staleTime: 0,
    retry: false,
    gcTime: 0,
  });
  async function decide(approval: Approval, approved: boolean) {
    if (pending || request.current || query.isFetching || query.isError) return;
    const controller = new AbortController();
    request.current = controller;
    const key = `${approval.operationId}:${approval.expectedRevision}:${approved}`;
    const requestId = decisionIds.current.get(key) ?? crypto.randomUUID();
    decisionIds.current.set(key, requestId);
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = TaskSchema.refine((task) => task.taskId === taskId).parse(
        await api(
          "identity/mcp/task/decide",
          {
            workspaceId,
            taskId,
            requestId,
            input: {
              operationId: approval.operationId,
              expectedRevision: approval.expectedRevision,
            },
            approved,
          },
          controller.signal,
        ),
      );
      if (controller.signal.aborted) return;
      client.setQueryData(queryKey, result);
      setNotice(copy.decisionSaved);
      await query.refetch();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(issueMessage(cause, copy, "taskLoadFailed", true));
        await query.refetch();
      }
    } finally {
      if (!controller.signal.aborted) {
        setPending(false);
        request.current = null;
      }
    }
  }
  const task = query.data;
  const approval = ApprovalSchema.safeParse(task?.nextInput);
  const statusLabels: Record<string, string> = {
    queued: copy.queued,
    running: copy.pending,
    waiting_input: copy.waiting,
    waiting_approval: copy.waitingApproval,
    waiting_system: copy.waitingSystem,
    scheduled: copy.scheduled,
    succeeded: copy.completed,
    failed: copy.failedTask,
    cancelled: copy.cancelled,
    expired: copy.expired,
    superseded: copy.superseded,
    unknown: copy.unknown,
  };
  const statusTone: Tone =
    task?.status === "succeeded"
      ? "success"
      : task?.status === "failed"
        ? "danger"
        : ["waiting_input", "waiting_approval", "expired", "unknown"].includes(
              task?.status ?? "",
            )
          ? "warning"
          : task?.status === "running"
            ? "info"
            : "neutral";
  return (
    <Section title={copy.task}>
      {query.isError ? (
        <ErrorNotice
          message={issueMessage(query.error, copy, "taskLoadFailed", true)}
          retry={() => void query.refetch()}
          pending={query.isFetching}
        />
      ) : !task ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <>
          {error ? <ErrorNotice message={error} /> : null}
          {notice ? (
            <Alert role="status">
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>
                <span className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-xs">{task.taskId}</code>
                  {task.status !== "completed" && (
                    <StatusBadge tone={statusTone}>
                      {statusLabels[task.status] ?? copy.unknown}
                    </StatusBadge>
                  )}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4">
                {task.reply ? (
                  <p className="whitespace-pre-wrap break-words">
                    {task.reply}
                  </p>
                ) : null}
                {task.result ? <OperationDetails result={task.result} /> : null}
              </div>
            </CardContent>
          </Card>
          {approval.success ? (
            <ApprovalCard
              key={`${approval.data.operationId}:${approval.data.expectedRevision}`}
              approval={approval.data}
              result={task.result}
              awaiting={task.status === "waiting_approval"}
              pending={pending}
              refreshing={query.isFetching}
              decide={(approved) => void decide(approval.data, approved)}
            />
          ) : task.nextInput?.kind === "human_approval" ? (
            <ErrorNotice message={copy.incompleteReview} />
          ) : task.nextInput ? (
            <Alert>
              <AlertDescription>{copy.inputRequired}</AlertDescription>
            </Alert>
          ) : null}
        </>
      )}
    </Section>
  );
}

function OperationDetails({ result }: { result: ServiceResult }) {
  const copy = useMcpCopy();
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <DetailList
        items={[
          { label: copy.operation, value: result.title },
          { label: copy.service, value: result.service },
          {
            label: copy.effect,
            value: result.effect === "write" ? copy.write : copy.read,
          },
          ...result.fields,
        ]}
      />
      {result.summary ? (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {result.summary}
        </p>
      ) : null}
    </div>
  );
}

function ApprovalCard({
  approval,
  result,
  awaiting,
  pending,
  refreshing,
  decide,
}: {
  approval: Approval;
  result?: ServiceResult;
  awaiting: boolean;
  pending: boolean;
  refreshing: boolean;
  decide: (approved: boolean) => void;
}) {
  const copy = useMcpCopy();
  const [inputOpen, setInputOpen] = useState(false);
  let inputComplete = false;
  try {
    inputComplete = !!result && JSON.parse(result.inputJson) !== null;
  } catch {
    /* A truncated or invalid input cannot support a decision. */
  }
  const complete =
    awaiting &&
    result?.status === "awaiting_approval" &&
    result.operationId === approval.operationId &&
    inputComplete;
  const canConfirm = complete && (!result.reviewTruncated || inputOpen);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.approval}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex min-w-0 flex-col gap-4">
          {approval.message ? (
            <p className="whitespace-pre-wrap break-words">
              {approval.message}
            </p>
          ) : null}
          {!complete ? (
            <ErrorNotice message={copy.incompleteReview} />
          ) : (
            <>
              {result.reviewTruncated ? (
                <Alert>
                  <AlertDescription>{copy.fullReviewHint}</AlertDescription>
                </Alert>
              ) : null}
              <Disclosure
                title={copy.fullInput}
                open={inputOpen}
                onOpenChange={setInputOpen}
              >
                <CodeBlock value={result.inputJson} />
              </Disclosure>
            </>
          )}
          <Disclosure title={copy.details}>
            <DetailList
              items={[
                { label: copy.operationId, value: approval.operationId },
                { label: copy.revision, value: approval.expectedRevision },
              ]}
            />
          </Disclosure>
        </div>
      </CardContent>
      <CardFooter className="flex-wrap justify-end">
        <Button
          type="button"
          variant="ghost"
          disabled={pending || refreshing || !complete}
          onClick={() => decide(false)}
        >
          {copy.reject}
        </Button>
        <Button
          type="button"
          disabled={pending || refreshing || !canConfirm}
          onClick={() => decide(true)}
        >
          {copy.confirm}
        </Button>
      </CardFooter>
    </Card>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { AuthLayout } from "@admin/components/console/auth-layout";
import { DetailList } from "@admin/components/console/forms";
import { CodeBlock, Disclosure } from "@admin/components/console/disclosure";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import { Button } from "@admin/components/ui/button";
import { Checkbox } from "@admin/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@admin/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Spinner } from "@admin/components/ui/spinner";
import { useAdmin } from "./context";
import { useConsoleScope } from "./console-scope";
import { authApi, ApiError } from "./lib/api";
import { useMcpCopy } from "./mcp-copy";
import { readMcpOAuthQuery } from "./lib/mcp-oauth-query";

const ScopeSchema = z.enum(["native.view", "native.run", "services.call"]);
type Scope = z.infer<typeof ScopeSchema>;
const ConsentInfoSchema = z.object({
  clientName: z.string().min(1).max(100),
  clientId: z.string().min(1).max(200),
  scopes: z.array(ScopeSchema).min(1).max(3),
  resource: z.url().max(2048),
  redirectUri: z.url().max(2048),
  requiresSignIn: z.boolean().default(false),
});
type ConsentInfo = z.infer<typeof ConsentInfoSchema>;
export function validMcpCallback(value: string) {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

/** Signed request stays in memory; reads never approve or redirect the client. */
export function McpConsent({ logout }: { logout?: () => void } = {}) {
  const copy = useMcpCopy();
  const { data, setSelectedOrganization } = useAdmin();
  const scope = useConsoleScope();
  const id = useId();
  const [oauthQuery] = useState(readMcpOAuthQuery);
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState<{
    organizationId: string;
    id: string;
  } | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const request = useRef<AbortController | null>(null);
  const account = data.authentication.current === "better-auth";
  useEffect(() => {
    if (!account) return;
    const controller = new AbortController();
    request.current = controller;
    void authApi(
      "mcp/oauth/consent-info",
      { oauth_query: oauthQuery },
      controller.signal,
    )
      .then((value) => {
        const result = ConsentInfoSchema.parse(value);
        if (!validMcpCallback(result.redirectUri))
          throw new Error("invalid callback");
        if (!controller.signal.aborted) setInfo(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof ApiError && cause.status === 401
              ? copy.authError
              : copy.consentFailed,
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          request.current = null;
        }
      });
    return () => controller.abort();
  }, [account, oauthQuery, copy]);
  useEffect(() => () => request.current?.abort(), []);
  const workspaceId =
    selectedWorkspace !== null &&
    selectedWorkspace.organizationId === scope.organization?.id &&
    scope.detail.data?.workspaces.some(
      (workspace) => workspace.id === selectedWorkspace.id,
    )
      ? selectedWorkspace.id
      : "";
  const disabled =
    pending || loading || scope.identity.isFetching || scope.detail.isFetching;
  async function decide(accept: boolean) {
    if (!info || disabled || request.current) return;
    if (accept && info.requiresSignIn) {
      setError(copy.reauthenticate);
      return;
    }
    if (accept && (!workspaceId || scopes.length === 0)) {
      setError(copy.consentPermission);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    try {
      const result = z.object({ redirect_uri: z.url().max(8192) }).parse(
        await authApi(
          "mcp/oauth/consent",
          {
            oauth_query: oauthQuery,
            accept,
            ...(workspaceId ? { workspaceId } : {}),
            scopes: accept ? scopes : info.scopes,
          },
          controller.signal,
        ),
      );
      const redirect = new URL(result.redirect_uri);
      const registered = new URL(info.redirectUri);
      if (
        !validMcpCallback(redirect.href) ||
        redirect.origin !== registered.origin ||
        redirect.pathname !== registered.pathname
      )
        throw new Error("invalid redirect");
      if (!controller.signal.aborted) window.location.assign(redirect.href);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof ApiError && cause.status === 401
            ? copy.authError
            : cause instanceof ApiError && cause.status === 403
              ? copy.consentForbidden
              : copy.consentFailed,
        );
        setPending(false);
        request.current = null;
      }
    }
  }
  return (
    <AuthLayout
      title={account ? copy.oauthConsent : copy.accountOnly}
      description={account ? copy.consentHint : undefined}
      icon={<ShieldCheck />}
      footer={
        <>
          <Button variant="link" size="sm" asChild>
            <Link to="/mcp">{copy.title}</Link>
          </Button>
          {logout ? (
            <Button variant="outline" onClick={logout}>
              {account ? copy.reauthenticateAction : copy.switchAccount}
            </Button>
          ) : null}
        </>
      }
    >
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {account ? (
        loading ||
        scope.identity.isPending ||
        (scope.organization && scope.detail.isPending) ? (
          <Skeleton className="h-48 w-full" />
        ) : info ? (
          <>
            {info.requiresSignIn ? (
              <Alert>
                <AlertDescription>{copy.reauthenticate}</AlertDescription>
              </Alert>
            ) : null}
            <DetailList
              stacked
              items={[
                { label: copy.oauthClient, value: info.clientName },
                {
                  label: copy.redirectDomain,
                  value: new URL(info.redirectUri).host,
                },
              ]}
            />
            <Disclosure title={copy.requestDetails}>
              <DetailList
                stacked
                items={[{ label: copy.clientId, value: info.clientId }]}
              />
              <CodeBlock
                value={{
                  redirectUri: info.redirectUri,
                  resource: info.resource,
                }}
              />
            </Disclosure>
            {scope.identity.isError || scope.detail.isError ? (
              <Alert variant="destructive">
                <AlertDescription>{copy.loadFailed}</AlertDescription>
                <AlertAction>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => {
                      void scope.identity.refetch();
                      void scope.detail.refetch();
                    }}
                  >
                    {copy.refresh}
                  </Button>
                </AlertAction>
              </Alert>
            ) : null}
            <FieldGroup>
              {(scope.identity.data?.organizations.length ?? 0) > 1 ? (
                <Field data-disabled={disabled}>
                  <FieldLabel htmlFor={`${id}-organization`}>
                    {copy.organization}
                  </FieldLabel>
                  <Select
                    value={scope.organization?.id ?? ""}
                    disabled={disabled}
                    onValueChange={(value) => {
                      setSelectedWorkspace(null);
                      setSelectedOrganization(value);
                    }}
                  >
                    <SelectTrigger id={`${id}-organization`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {scope.identity.data?.organizations.map(
                          (organization) => (
                            <SelectItem
                              key={organization.id}
                              value={organization.id}
                            >
                              {organization.name}
                            </SelectItem>
                          ),
                        )}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              <Field data-disabled={disabled}>
                <FieldLabel htmlFor={`${id}-workspace`}>
                  {copy.workspace}
                </FieldLabel>
                <Select
                  value={workspaceId}
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (scope.organization)
                      setSelectedWorkspace({
                        organizationId: scope.organization.id,
                        id: value,
                      });
                  }}
                >
                  <SelectTrigger id={`${id}-workspace`} className="w-full">
                    <SelectValue placeholder={copy.selectWorkspace} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {scope.detail.data?.workspaces.map((workspace) => (
                        <SelectItem key={workspace.id} value={workspace.id}>
                          {workspace.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <FieldSet>
                <FieldLegend variant="label">{copy.permissions}</FieldLegend>
                <FieldGroup>
                  {info.scopes.map((permission) => (
                    <Field
                      key={permission}
                      orientation="horizontal"
                      data-disabled={disabled}
                    >
                      <Checkbox
                        id={`${id}-${permission}`}
                        disabled={disabled}
                        checked={scopes.includes(permission)}
                        onCheckedChange={(checked) =>
                          setScopes((previous) =>
                            checked === true
                              ? [
                                  ...previous.filter(
                                    (value) => value !== permission,
                                  ),
                                  permission,
                                ]
                              : previous.filter(
                                  (value) => value !== permission,
                                ),
                          )
                        }
                      />
                      <FieldLabel htmlFor={`${id}-${permission}`}>
                        {permission === "services.call"
                          ? copy.connectorScope
                          : permission === "native.run"
                            ? copy.runOnly
                            : copy.viewOnly}
                      </FieldLabel>
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
            </FieldGroup>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => void decide(false)}
              >
                {copy.denyClient}
              </Button>
              <Button
                type="button"
                disabled={
                  disabled ||
                  !workspaceId ||
                  scopes.length === 0 ||
                  info.requiresSignIn ||
                  !scope.ready
                }
                onClick={() => void decide(true)}
              >
                {pending ? <Spinner data-icon="inline-start" /> : null}
                {pending ? copy.consentSending : copy.allowClient}
              </Button>
            </div>
          </>
        ) : null
      ) : null}
    </AuthLayout>
  );
}

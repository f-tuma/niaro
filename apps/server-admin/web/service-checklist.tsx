import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  FlaskConical,
  Globe,
  KeyRound,
  Link2,
  ListChecks,
  Users,
} from "lucide-react";
import type { z } from "zod";
import {
  ServiceProbeResponse,
  providerDenied,
  type Service,
} from "../../../packages/protocol/service-catalog";
import type { AuthProvidersSchema } from "../../../packages/protocol/auth-providers";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import { Section } from "@admin/components/console/page";
import { StatusDot, type Tone } from "@admin/components/console/status";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { CodeBlock, Disclosure } from "@admin/components/console/disclosure";
import { DetailList } from "@admin/components/console/forms";
import { CopyLinkField } from "./copy-link";
import { catalogIssue, type CatalogState } from "./catalog-shared";
import { useAdmin } from "./context";
import { api, ApiError } from "./lib/api";
import { oauthIssue, useServiceAuthCopy } from "./service-auth";
import {
  clearReadOnly,
  markReadOnly,
  readOnlyActions,
  discoveryKey,
  runDiscovery,
  useDiscoveryJob,
  type DiscoveryJob,
} from "./service-discovery";
import {
  OAuthStatusWithRedirect,
  applySignIn,
  onboardingSettings,
  signInProvider,
  useAuthProviders,
  useHostedService,
  type HostedSignIn,
} from "./service-onboarding";
import { fill, useServiceSetupCopy } from "./service-setup-copy";

type SetupCopy = ReturnType<typeof useServiceSetupCopy>;
type AuthProvider = z.infer<typeof AuthProvidersSchema>["providers"][number];
type OAuthStatus = z.infer<typeof OAuthStatusWithRedirect>;
export type StepState = "done" | "action" | "failed" | "waiting" | "running";
export type StepFix =
  | "editConnection"
  | "settings"
  | "providers"
  | "applySignIn"
  | "accessTab"
  | "discover"
  | "continue"
  | "actionsTab"
  | "markReads"
  | "addScopes"
  | "findReads"
  | "connect"
  | "test";
export type SetupStep = {
  id: "address" | "signIn" | "actions" | "access" | "connected" | "test";
  state: StepState;
  reason: string;
  fix?: { kind: StepFix; label: string };
};
export type TestState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; ok: boolean; reason: string; result?: unknown };
export type ChecklistInput = {
  service: Service;
  /** null while the address is being checked. */
  probe: z.infer<typeof ServiceProbeResponse> | null;
  oauth: OAuthStatus | null;
  providers: AuthProvider[];
  /** What the hosted server's definition asks for, when it has a definition. */
  signIn?: HostedSignIn;
  job: DiscoveryJob;
  /** Who may use the service, already in words. */
  who: string;
  test: TestState;
  /** The job's error in words. */
  jobIssue: string;
};
const tones: Record<StepState, Tone> = {
  done: "success",
  action: "warning",
  failed: "danger",
  waiting: "neutral",
  running: "info",
};
const kindName = { microsoft: "Microsoft", google: "Google" } as const;

/** A read the Test step can run as is: on, a read, and nothing required. */
export function testAction(service: Service) {
  return service.actions.find(
    (action) =>
      action.enabled &&
      action.effect === "read" &&
      !(
        Array.isArray(action.inputSchema.required) &&
        action.inputSchema.required.length
      ),
  );
}

/**
 * The service's setup in order: each step done, waiting for an earlier one,
 * or needing an action, with one line saying why and the fix.
 */
export function setupSteps(
  input: ChecklistInput,
  copy: SetupCopy,
): SetupStep[] {
  const { service, probe, oauth, signIn, job } = input;
  const settings = oauth?.config.settings;
  const personal = !!settings && settings.requiredFor !== "none";
  const steps: SetupStep[] = [];

  steps.push(
    !probe
      ? { id: "address", state: "running", reason: copy.checking }
      : probe.status === "ok"
        ? { id: "address", state: "done", reason: copy.reachable }
        : probe.status === "sign_in"
          ? { id: "address", state: "done", reason: copy.reachableSignIn }
          : probe.error === "catalog_key_required"
            ? {
                id: "address",
                state: "waiting",
                reason: copy.sharedKeyMissing,
              }
            : probe.error === "integration_origin_denied"
              ? {
                  id: "address",
                  state: "failed",
                  reason: copy.originDenied,
                  fix: { kind: "settings", label: copy.openSettings },
                }
              : {
                  id: "address",
                  state: "failed",
                  reason: fill(copy.unreachable, {
                    code: probe.error ?? "?",
                  }),
                  fix: { kind: "editConnection", label: copy.editConnection },
                },
  );

  // Sign-in: none, a shared key, or each person's own account.
  const provider = settings?.authProviderId
    ? input.providers.find((p) => p.id === settings.authProviderId)
    : undefined;
  if (!oauth)
    steps.push({ id: "signIn", state: "running", reason: copy.checking });
  else if (personal && settings?.source === "provider")
    steps.push(
      provider?.enabled && missingScopes(settings, signIn).length
        ? {
            id: "signIn",
            state: "action",
            reason: fill(copy.scopesMissing, {
              scopes: missingScopes(settings, signIn).join(" "),
            }),
            fix: { kind: "addScopes", label: copy.addScopes },
          }
        : provider?.enabled
          ? {
              id: "signIn",
              state: "done",
              reason: fill(copy.personalProvider, { name: provider.name }),
            }
          : {
              id: "signIn",
              state: "action",
              reason: provider
                ? fill(copy.providerOff, { name: provider.name })
                : fill(copy.providerMissing, {
                    kind: signIn ? kindName[signIn.provider] : "",
                  }),
              fix: { kind: "providers", label: copy.addProvider },
            },
    );
  else if (personal)
    steps.push(
      oauth.config.discovery && oauth.config.hasClientId
        ? { id: "signIn", state: "done", reason: copy.personalService }
        : {
            id: "signIn",
            state: "action",
            reason: copy.serviceOAuthMissing,
            fix: { kind: "accessTab", label: copy.setUp },
          },
    );
  else if (signIn) {
    // The definition asks for personal sign-in that is not set up yet.
    const ready = signInProvider(signIn, input.providers);
    steps.push({
      id: "signIn",
      state: "action",
      reason: ready
        ? fill(copy.providerNeeded, { kind: kindName[signIn.provider] })
        : fill(copy.providerMissing, { kind: kindName[signIn.provider] }),
      fix: ready
        ? {
            kind: "applySignIn",
            label: fill(copy.useProvider, { name: ready.name }),
          }
        : { kind: "providers", label: copy.addProvider },
    });
  } else if (service.auth.type === "none")
    steps.push({ id: "signIn", state: "done", reason: copy.noSignIn });
  else
    steps.push(
      service.hasCredential
        ? { id: "signIn", state: "done", reason: copy.sharedKey }
        : {
            id: "signIn",
            state: "action",
            reason: copy.sharedKeyMissing,
            fix: { kind: "editConnection", label: copy.editConnection },
          },
    );

  const signedIn = steps.at(-1)!.state === "done";
  steps.push(
    job.running
      ? {
          id: "actions",
          state: "running",
          reason: job.progress
            ? fill(copy.describing, job.progress)
            : copy.importing,
        }
      : job.error
        ? {
            id: "actions",
            state: "failed",
            reason: input.jobIssue,
            fix: job.continuation
              ? { kind: "continue", label: copy.continueImport }
              : { kind: "discover", label: copy.discover },
          }
        : service.actions.length
          ? {
              id: "actions",
              state: "done",
              reason: fill(copy.actionsCount, { n: service.actions.length }),
            }
          : {
              id: "actions",
              state: "action",
              reason: copy.noActions,
              fix: { kind: "discover", label: copy.discover },
            },
  );

  const enabled = service.actions.filter((a) => a.enabled);
  // Overview widgets read unattended: reads that never wait for approval.
  // Under a person's own account every read runs without asking.
  const reads = enabled.filter(
    (a) => a.effect === "read" && (personal || a.approval === "never"),
  );
  // Reads nobody was granted are on, yet neither the agent nor widgets get them.
  const granted = reads.filter(
    ({ policy }) =>
      personal ||
      policy.roles.length ||
      policy.workspaceRoles?.length ||
      policy.users.some((user) => user.access === "allow"),
  );
  const hinted = readOnlyActions(service, job.readOnly).length;
  const markReads = {
    kind: "markReads",
    label: fill(copy.markReadsCount, { n: hinted }),
  } as const;
  steps.push(
    !service.actions.length
      ? { id: "access", state: "waiting", reason: copy.afterActions }
      : !enabled.length
        ? {
            id: "access",
            state: "action",
            reason: copy.noneEnabled,
            fix: hinted
              ? markReads
              : { kind: "actionsTab", label: copy.chooseActions },
          }
        : reads.length && !granted.length
          ? {
              id: "access",
              state: "action",
              reason: fill(copy.noGrant, { n: reads.length }),
              fix: { kind: "actionsTab", label: copy.chooseWho },
            }
          : !reads.length
            ? {
                id: "access",
                state: "action",
                reason: fill(copy.noReads, { n: enabled.length }),
                fix: hinted
                  ? markReads
                  : service.protocol === "mcp"
                    ? { kind: "findReads", label: copy.findReads }
                    : { kind: "actionsTab", label: copy.chooseActions },
              }
            : {
                id: "access",
                state: "done",
                reason: fill(copy.accessDone, {
                  n: enabled.length,
                  reads: granted.length,
                  who: input.who,
                }),
              },
  );

  if (personal) {
    const connection = oauth?.connection;
    steps.push(
      !signedIn
        ? { id: "connected", state: "waiting", reason: copy.afterSignIn }
        : connection?.status === "connected"
          ? {
              id: "connected",
              state: "done",
              reason:
                connection.identity && "label" in connection.identity
                  ? fill(copy.connectedAs, {
                      name: connection.identity.label ?? "",
                    })
                  : copy.connected,
            }
          : {
              id: "connected",
              state: "action",
              reason:
                connection?.status === "expired"
                  ? copy.expired
                  : copy.notConnected,
              fix: { kind: "connect", label: copy.connect },
            },
    );
  }

  const candidate = testAction(service);
  const { test } = input;
  steps.push(
    !candidate
      ? { id: "test", state: "waiting", reason: copy.testNone }
      : test.status === "running"
        ? { id: "test", state: "running", reason: copy.running }
        : test.status === "done"
          ? {
              id: "test",
              state: test.ok ? "done" : "failed",
              reason: test.reason,
              fix: { kind: "test", label: copy.testRun },
            }
          : {
              id: "test",
              state: "waiting",
              reason: fill(copy.testIdle, { action: candidate.name }),
              fix: { kind: "test", label: copy.testRun },
            },
  );
  return steps;
}

/** The permissions the hosted server's definition asks for that the
 * service's sign-in doesn't request. */
function missingScopes(
  settings: OAuthStatus["config"]["settings"],
  signIn: HostedSignIn | undefined,
) {
  const requested = new Set(settings.scopes ?? []);
  return (signIn?.scopes ?? []).filter((scope) => !requested.has(scope));
}

const icons: Record<SetupStep["id"], ReactNode> = {
  address: <Globe />,
  signIn: <KeyRound />,
  actions: <ListChecks />,
  access: <Users />,
  connected: <Link2 />,
  test: <FlaskConical />,
};

/** The service's setup as a checklist for administrators, at the top of its overview. */
export function ServiceChecklist({
  state,
  service,
  who,
  onEditConnection,
  onDiscover,
  onTab,
}: {
  state: CatalogState;
  service: Service;
  who: string;
  onEditConnection: () => void;
  onDiscover: () => void;
  onTab: (tab: "actions" | "access") => void;
}) {
  const copy = useServiceSetupCopy();
  const authCopy = useServiceAuthCopy();
  const { data } = useAdmin();
  const client = useQueryClient();
  const { target } = state;
  const scope = [
    data.authentication.principalId,
    target.organizationId,
    target.workspaceId,
    service.id,
    service.revision,
  ];
  const probe = useQuery({
    queryKey: ["admin", "catalog", "probe", ...scope],
    queryFn: async ({ signal }) =>
      ServiceProbeResponse.parse(
        await api(
          "identity/catalog/probe",
          { ...target, serviceId: service.id },
          signal,
        ),
      ),
    retry: false,
  });
  // The same query as the Access tab's sign-in settings.
  const oauth = useQuery({
    queryKey: ["admin", "catalog", "oauth", ...scope],
    queryFn: async ({ signal }) =>
      OAuthStatusWithRedirect.parse(
        await api(
          "identity/catalog/oauth/status",
          { ...target, serviceId: service.id },
          signal,
        ),
      ),
    retry: false,
  });
  const providers = useAuthProviders(target.organizationId);
  const hosted = useHostedService(target.organizationId, service.url);
  const signIn = hosted?.onboarding?.signIn;
  const key = discoveryKey(target.workspaceId, service.id);
  const job = useDiscoveryJob(key);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const steps = setupSteps(
    {
      service,
      probe: probe.isError
        ? { status: "failed", error: "integration_unavailable" }
        : (probe.data ?? null),
      oauth: oauth.data ?? null,
      providers: providers.data?.providers ?? [],
      ...(signIn ? { signIn } : {}),
      job,
      who,
      test,
      jobIssue: job.error ? catalogIssue(job.error, state.copy) : "",
    },
    copy,
  );
  const refresh = () =>
    client.invalidateQueries({ queryKey: ["admin", "catalog"] });
  const discover = (enrich: boolean) =>
    void runDiscovery(key, {
      send: (body) => api("identity/catalog/discover", { ...target, ...body }),
      body: {
        serviceId: service.id,
        revision: job.continuation?.revision ?? service.revision,
      },
      enrich,
      resume: !!job.continuation,
      onBatch: refresh,
    });
  async function runTest() {
    const action = testAction(service);
    if (!action) return;
    setTest({ status: "running" });
    try {
      const receipt = (await api("identity/catalog/invoke", {
        ...target,
        serviceId: service.id,
        serviceRevision: service.revision,
        actionId: action.id,
        revision: action.revision,
        input: {},
        requestId: crypto.randomUUID(),
        approve: false,
      })) as {
        status?: string;
        result?: unknown;
        failure?: { message?: string };
      };
      const ok = receipt.status === "succeeded";
      const message = receipt.failure?.message;
      setTest({
        status: "done",
        ok,
        reason: ok
          ? fill(copy.testOk, { action: action.name })
          : fill(copy.testFailed, {
              action: action.name,
              reason: providerDenied(message)
                ? copy.testDenied
                : message
                  ? message.slice(0, 200)
                  : String(receipt.status ?? "?"),
            }),
        result: receipt.result,
      });
    } catch (e) {
      const code = e instanceof ApiError ? (e.code ?? "") : "";
      setTest({
        status: "done",
        ok: false,
        reason: fill(copy.testFailed, {
          action: action.name,
          reason: /connection|oauth/.test(code)
            ? copy.connectFirst
            : catalogIssue(e, state.copy),
        }),
      });
    }
  }
  async function addScopes() {
    const settings = oauth.data?.config.settings;
    if (!settings) return;
    setBusy(true);
    setError(null);
    const saved = await applySignIn(target, service.id, {
      ...settings,
      scopes: [
        ...new Set([...(settings.scopes ?? []), ...(signIn?.scopes ?? [])]),
      ],
    });
    if (!saved.ok)
      setError(oauthIssue(new ApiError(400, saved.code), authCopy));
    await refresh();
    setBusy(false);
  }
  async function adoptProvider() {
    const provider =
      signIn && signInProvider(signIn, providers.data?.providers ?? []);
    if (!signIn || !provider) return;
    setBusy(true);
    setError(null);
    const saved = await applySignIn(
      target,
      service.id,
      onboardingSettings(signIn, provider),
    );
    if (!saved.ok)
      setError(oauthIssue(new ApiError(400, saved.code), authCopy));
    await refresh();
    setBusy(false);
  }
  function fixButton(step: SetupStep) {
    const fix = step.fix;
    if (!fix) return null;
    const button = (onClick: () => void) => (
      <Button
        variant="outline"
        size="sm"
        disabled={busy || state.busy || job.running}
        onClick={onClick}
      >
        {fix.label}
      </Button>
    );
    switch (fix.kind) {
      case "settings":
        return (
          <Button asChild variant="outline" size="sm">
            <Link to="/settings">{fix.label}</Link>
          </Button>
        );
      case "providers":
        return (
          <Button asChild variant="outline" size="sm">
            <Link to="/auth-providers">{fix.label}</Link>
          </Button>
        );
      case "connect":
        // People connect in the app, where the sign-in returns.
        return (
          <Button asChild variant="outline" size="sm">
            <a href={`/connections/${service.id}`}>{fix.label}</a>
          </Button>
        );
      case "editConnection":
        return button(onEditConnection);
      case "accessTab":
        return button(() => onTab("access"));
      case "actionsTab":
        return button(() => onTab("actions"));
      case "discover":
        return button(onDiscover);
      case "continue":
        return button(() => discover(job.enrich));
      case "findReads":
        // Only lists the tools again: nothing new is described.
        return button(() => discover(false));
      case "applySignIn":
        return button(() => void adoptProvider());
      case "addScopes":
        return button(() => void addScopes());
      case "test":
        return button(() => void runTest());
      case "markReads":
        return button(
          () =>
            void markReadOnly(state, service, job.readOnly).then((saved) => {
              if (saved) clearReadOnly(key);
            }),
        );
    }
  }
  const done = steps.filter((step) => step.state === "done").length;
  const missingProvider =
    !!signIn &&
    steps.some((s) => s.id === "signIn" && s.fix?.kind === "providers");
  return (
    <Section
      title={copy.setup}
      actions={
        <span className="text-xs text-muted-foreground tabular-nums">
          {done}/{steps.length}
        </span>
      }
    >
      <div data-service-checklist className="flex flex-col gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Card variant="list">
          {steps.map((step) => (
            <Item
              key={step.id}
              variant="row"
              size="row"
              data-step={step.id}
              data-state={step.state}
            >
              <ItemMedia>
                <EntityIcon size="sm">{icons[step.id]}</EntityIcon>
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{title(step.id, copy)}</ItemTitle>
                <ItemDescription>
                  <StatusDot tone={tones[step.state]} size="sm">
                    {step.reason}
                  </StatusDot>
                </ItemDescription>
              </ItemContent>
              {step.fix && <ItemActions>{fixButton(step)}</ItemActions>}
            </Item>
          ))}
        </Card>
        {missingProvider && oauth.data && signIn && (
          <ProviderNeeds
            copy={copy}
            signIn={signIn}
            redirectUri={oauth.data.redirectUri}
          />
        )}
        {test.status === "done" && test.result !== undefined && (
          <Disclosure title={copy.result}>
            <CodeBlock value={test.result} />
          </Disclosure>
        )}
      </div>
    </Section>
  );
}
function title(id: SetupStep["id"], copy: SetupCopy) {
  return {
    address: copy.address,
    signIn: copy.stepSignIn,
    actions: copy.stepActions,
    access: copy.stepAccess,
    connected: copy.stepConnected,
    test: copy.stepTest,
  }[id];
}
/** What the missing sign-in method needs: its fields, the redirect URL to
 * register and the permissions to grant. */
function ProviderNeeds({
  copy,
  signIn,
  redirectUri,
}: {
  copy: SetupCopy;
  signIn: HostedSignIn;
  redirectUri: string;
}) {
  return (
    <div data-provider-needs className="flex flex-col gap-4">
      <DetailList
        items={[
          {
            label: copy.providerFields,
            value:
              signIn.provider === "microsoft"
                ? copy.microsoftFields
                : copy.googleFields,
          },
          ...(signIn.scopes.length
            ? [
                {
                  label: copy.permissions,
                  value: (
                    <span className="font-mono text-xs">
                      {signIn.scopes.join(" ")}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
      <CopyLinkField label={copy.redirectUrl} value={redirectUri} copy={copy} />
    </div>
  );
}

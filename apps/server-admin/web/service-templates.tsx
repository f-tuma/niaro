import { useState, useRef, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Cable, ChevronRight, Mail, Server, Users } from "lucide-react";
import { AuthProvidersSchema } from "../../../packages/protocol/auth-providers";
import { IdentityId } from "../../../packages/protocol/identity";
import type { ServiceSettings } from "../../../packages/protocol/service-catalog";
import type { z } from "zod";
import { useAdmin } from "./context";
import type { CatalogState } from "./catalog-shared";
import { api } from "./lib/api";
import {
  HostedStatus,
  useHostedCommand,
  useHostedServers,
} from "./hosted-page";
import { Section } from "@admin/components/console/page";
import { StatusDot } from "@admin/components/console/status";
import { SubmitButton } from "@admin/components/console/forms";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { Button } from "@admin/components/ui/button";
import { Card, CardContent } from "@admin/components/ui/card";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Input } from "@admin/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";

export type ServiceTemplate = "microsoft-365" | "twenty" | "custom";
/** Twenty publishes MCP and its own OAuth; only its address and key differ per company. */
export const twentyPreset: Partial<z.infer<typeof ServiceSettings>> = {
  name: "Twenty CRM",
  description:
    "Company CRM: contacts (people), companies, deals (opportunities), notes and tasks.",
  protocol: "mcp",
  icon: "users",
  auth: { type: "bearer" },
};
const MICROSOFT_SCOPES = "Calendars.ReadWrite Mail.ReadWrite Mail.Send";

const en = {
  templates: "Start from",
  microsoft: "Microsoft 365",
  microsoftHint: "Outlook calendar and mail, personal sign-in.",
  twenty: "Twenty CRM",
  twentyHint: "Contacts, companies and deals over MCP.",
  custom: "Other service",
  customHint: "Any OpenAPI or MCP address.",
  server: "MCP server",
  run: "Run on this server",
  signIn: "Sign-in method",
  signInHint: "Its app needs the redirect URL from Access.",
  noSignIn: "Add a Microsoft sign-in method first.",
  manage: "Sign-in methods",
  scopes: "Permissions",
  scopesHint: "Microsoft Graph, separated by spaces.",
  create: "Add service",
  waiting: "Waiting for the server",
  failed: "Could not add the service. Check the settings and retry.",
};
const cs: typeof en = {
  templates: "Začít od",
  microsoft: "Microsoft 365",
  microsoftHint: "Kalendář a pošta v Outlooku, osobní přihlášení.",
  twenty: "Twenty CRM",
  twentyHint: "Kontakty, firmy a obchody přes MCP.",
  custom: "Jiná služba",
  customHint: "Libovolná OpenAPI nebo MCP adresa.",
  server: "MCP server",
  run: "Spustit na tomto serveru",
  signIn: "Přihlašovací metoda",
  signInHint: "Její aplikace potřebuje adresu pro návrat ze záložky Přístup.",
  noSignIn: "Nejdřív přidej přihlašovací metodu Microsoft.",
  manage: "Metody přihlášení",
  scopes: "Oprávnění",
  scopesHint: "Microsoft Graph, oddělené mezerou.",
  create: "Přidat službu",
  waiting: "Čekám na server",
  failed: "Službu se nepodařilo přidat. Zkontroluj nastavení a zkus znovu.",
};
function useCopy() {
  return useAdmin().language === "cs" ? cs : en;
}

export function ServiceTemplates({
  onChoose,
}: {
  onChoose: (template: ServiceTemplate) => void;
}) {
  const copy = useCopy();
  const templates: {
    id: ServiceTemplate;
    title: string;
    hint: string;
    icon: ReactNode;
  }[] = [
    {
      id: "microsoft-365",
      title: copy.microsoft,
      hint: copy.microsoftHint,
      icon: <Mail />,
    },
    {
      id: "twenty",
      title: copy.twenty,
      hint: copy.twentyHint,
      icon: <Users />,
    },
    {
      id: "custom",
      title: copy.custom,
      hint: copy.customHint,
      icon: <Cable />,
    },
  ];
  return (
    <Section title={copy.templates}>
      <Card variant="list">
        {templates.map((template) => (
          <Item key={template.id} asChild variant="row" size="row">
            <button type="button" onClick={() => onChoose(template.id)}>
              <ItemMedia>
                <EntityIcon>{template.icon}</EntityIcon>
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{template.title}</ItemTitle>
                <ItemDescription>{template.hint}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
              </ItemActions>
            </button>
          </Item>
        ))}
      </Card>
    </Section>
  );
}

/** Hosted MCP server + personal Microsoft sign-in, created as one service. */
export function Microsoft365Setup({
  state,
  onSaved,
}: {
  state: CatalogState;
  onSaved: (id: string, result: { personalSignInConfigured: boolean }) => void;
}) {
  const copy = useCopy();
  const { data } = useAdmin();
  const organizationId = state.target.organizationId;
  const hosted = useHostedServers(organizationId);
  const command = useHostedCommand(organizationId);
  const providers = useQuery({
    queryKey: [
      "admin",
      "auth-providers",
      data.authentication.principalId,
      organizationId,
    ],
    queryFn: async ({ signal }) =>
      AuthProvidersSchema.parse(
        await api("identity/auth-providers/list", { organizationId }, signal),
      ),
    enabled: !!organizationId,
  });
  const microsoft =
    providers.data?.providers.filter(
      (p) => p.kind === "microsoft" && p.enabled,
    ) ?? [];
  const [providerId, setProviderId] = useState<string | null>(null);
  const selected = providerId ?? microsoft[0]?.id ?? null;
  const [scopes, setScopes] = useState(MICROSOFT_SCOPES);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const server = hosted.data?.servers.find(
    (s) => s.template === "microsoft-365",
  );
  const ready = server?.status === "running" && !!selected;
  async function create() {
    if (!server || !selected) return;
    setFailed(false);
    const saved = await state.mutate("command", {
      type: "saveService",
      revision: 0,
      settings: {
        name: "Microsoft 365",
        description:
          "The person's own Outlook calendar (events, availability, meetings) and mailbox (reading, drafts, sending email).",
        url: server.url,
        protocol: "mcp",
        icon: "mail",
        // The hosted server holds no key; every call carries the person's token.
        auth: { type: "none" },
        enabled: true,
      },
    });
    if (
      !mounted.current ||
      !saved ||
      typeof saved !== "object" ||
      !("id" in saved)
    )
      return;
    const savedId = IdentityId.safeParse(saved.id);
    if (!savedId.success) {
      setFailed(true);
      state.setError(state.copy.invalid);
      return;
    }
    const id = savedId.data;
    const signIn = await state.mutate("oauth/save", {
      serviceId: id,
      revision: 0,
      settings: {
        requiredFor: "all",
        source: "provider",
        authProviderId: selected,
        scopes: scopes.split(/\s+/).filter(Boolean),
      },
      client: {},
    });
    if (!mounted.current) return;
    if (!signIn) setFailed(true);
    onSaved(id, { personalSignInConfigured: !!signIn });
  }
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <fieldset disabled={state.busy} className="contents">
        {failed && (
          <Alert variant="destructive">
            <AlertDescription>{copy.failed}</AlertDescription>
          </Alert>
        )}
        <Card>
          <CardContent>
            <FieldGroup>
              <Item variant="muted">
                <ItemMedia variant="icon">
                  <Server />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {copy.server}
                    {server && <HostedStatus server={server} />}
                  </ItemTitle>
                  {server && (
                    <ItemDescription>
                      <span className="font-mono break-all">{server.url}</span>
                    </ItemDescription>
                  )}
                </ItemContent>
                {!server && hosted.data?.canManage && (
                  <ItemActions>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={command.isPending}
                      onClick={() =>
                        command.mutate({
                          type: "create",
                          template: "microsoft-365",
                        })
                      }
                    >
                      {copy.run}
                    </Button>
                  </ItemActions>
                )}
              </Item>
              <div className="grid gap-5 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="m365-provider">{copy.signIn}</FieldLabel>
                  {microsoft.length ? (
                    <Select
                      value={selected ?? ""}
                      onValueChange={setProviderId}
                    >
                      <SelectTrigger id="m365-provider" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {microsoft.map((provider) => (
                            <SelectItem key={provider.id} value={provider.id}>
                              {provider.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Button variant="outline" asChild className="self-start">
                      <Link to="/auth-providers">{copy.manage}</Link>
                    </Button>
                  )}
                  <FieldDescription>
                    {microsoft.length ? copy.signInHint : copy.noSignIn}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="m365-scopes">{copy.scopes}</FieldLabel>
                  <Input
                    id="m365-scopes"
                    mono
                    value={scopes}
                    onChange={(e) => setScopes(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <FieldDescription>{copy.scopesHint}</FieldDescription>
                </Field>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {!ready && <StatusDot tone="neutral">{copy.waiting}</StatusDot>}
          <SubmitButton pending={state.busy} disabled={!ready}>
            {copy.create}
          </SubmitButton>
        </div>
      </fieldset>
    </form>
  );
}

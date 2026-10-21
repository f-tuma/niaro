import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { AuthProviderLinkedStatusSchema } from "../../../packages/protocol/auth-providers";
import { Button } from "@admin/components/ui/button";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { KeyRound } from "lucide-react";
import { Card } from "@admin/components/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { Section } from "@admin/components/console/page";
import { useConsoleScope } from "./console-scope";
import { useAdmin } from "./context";
import { providerRedirect } from "./lib/provider-redirect";
import { api } from "./lib/api";

export function AccountProviders() {
  const { language } = useAdmin();
  const scope = useConsoleScope();
  return (
    <AccountProviderLinks
      language={language}
      userId={scope.identity.data?.user?.id}
      organizationId={scope.organization?.id}
    />
  );
}
export function AccountProviderLinks({
  language,
  userId,
  organizationId,
  returnPath,
}: {
  language: "cs" | "en";
  userId?: string;
  organizationId?: string;
  returnPath?: string;
}) {
  const cs = language === "cs";
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const query = useQuery({
    queryKey: ["admin", "account-providers", userId, organizationId],
    enabled: !!organizationId && !!userId,
    queryFn: async () =>
      z.object({ providers: z.array(AuthProviderLinkedStatusSchema) }).parse(
        await api("identity/auth-providers/account", {
          organizationId: organizationId!,
        }),
      ),
  });
  if (!organizationId || (!query.isError && !query.data?.providers.length))
    return null;
  return (
    <Section title={cs ? "Metody přihlášení" : "Sign-in methods"}>
      {(failed || query.isError) && (
        <Alert variant="destructive">
          <AlertDescription>
            {cs
              ? "Připojení účtu se nezdařilo. Zkus to znovu."
              : "Could not connect the account. Try again."}
          </AlertDescription>
        </Alert>
      )}
      <Card variant="list">
        {query.data?.providers.map((provider) => (
          <Item key={provider.providerId} variant="row" size="row">
            <ItemMedia>
              <EntityIcon size="sm">
                <KeyRound />
              </EntityIcon>
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{provider.name}</ItemTitle>
            </ItemContent>
            <ItemActions>
              {provider.linked ? (
                <span className="text-xs text-muted-foreground">
                  {cs ? "Připojeno" : "Connected"}
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(provider.providerId);
                    setFailed(false);
                    try {
                      const result = z
                        .object({ authorizationUrl: z.url() })
                        .parse(
                          await api("identity/auth-providers/link", {
                            organizationId: organizationId!,
                            providerId: provider.providerId,
                            ...(returnPath ? { returnPath } : {}),
                          }),
                        );
                      window.location.assign(
                        providerRedirect(result.authorizationUrl),
                      );
                    } catch {
                      setFailed(true);
                      setBusy(null);
                    }
                  }}
                >
                  {cs ? "Připojit účet" : "Connect account"}
                </Button>
              )}
            </ItemActions>
          </Item>
        ))}
      </Card>
    </Section>
  );
}

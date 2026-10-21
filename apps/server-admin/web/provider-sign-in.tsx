import { useEffect, useRef, useState } from "react";
import { providerReturnPath } from "./lib/provider-return-path";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Fingerprint } from "lucide-react";
import { AuthProviderChoiceSchema } from "../../../packages/protocol/auth-providers";
import { api } from "./lib/api";
import { Button } from "@admin/components/ui/button";
import { Field, FieldLabel } from "@admin/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import { Spinner } from "@admin/components/ui/spinner";
import { AuthDivider } from "@admin/components/console/auth-layout";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { readMcpOAuthQuery } from "./lib/mcp-oauth-query";
export function ProviderSignIn({
  language,
  disabled,
  divider,
  alternativeLabel,
  invitationToken,
  invitationOrganizationId,
  organizationId,
  returnHash,
}: {
  language: "en" | "cs";
  disabled: boolean;
  /** Label for an "or" divider rendered above the provider button. */
  divider?: string;
  alternativeLabel?: string;
  invitationToken?: string;
  invitationOrganizationId?: string;
  organizationId?: string;
  /** The page's fragment when it already removed it from the address bar. */
  returnHash?: string;
}) {
  const cs = language === "cs";
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const [longReturnPath, setLongReturnPath] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const query = useQuery({
    queryKey: ["auth-provider-choices"],
    queryFn: async ({ signal }) =>
      z
        .object({ providers: z.array(AuthProviderChoiceSchema).max(10000) })
        .parse(await api("identity/auth-providers/choices", undefined, signal)),
    retry: false,
  });
  const providers = (query.data?.providers ?? []).filter(
    (provider) => !organizationId || provider.organizationId === organizationId,
  );
  if (!providers.length) return null;
  const providerId = selected || providers[0]!.id;
  async function start() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(false);
    setLongReturnPath(false);
    try {
      const mcpConsent =
        window.location.pathname.replace(/\/$/, "") === "/admin/mcp/consent";
      const mcpApproval =
        window.location.pathname.replace(/\/$/, "") === "/admin/mcp";
      const path =
        (mcpConsent ? "/admin/mcp/consent" : window.location.pathname) +
        (mcpConsent
          ? `?${readMcpOAuthQuery()}`
          : mcpApproval
            ? window.location.search
            : "") +
        (returnHash ?? window.location.hash);
      if (path.length > 2048 && mcpConsent) {
        setLongReturnPath(true);
        return;
      }
      const returnPath = providerReturnPath(path);
      const result = z.object({ authorizationUrl: z.url() }).parse(
        await api(
          "identity/auth-providers/sign-in",
          {
            providerId,
            returnPath,
            ...(invitationToken &&
            providers.find((p) => p.id === providerId)?.organizationId ===
              invitationOrganizationId
              ? { invitationToken }
              : {}),
          },
          controller.signal,
        ),
      );
      const target = new URL(result.authorizationUrl);
      if (target.protocol !== "https:" || target.username || target.password)
        throw Error("invalid redirect");
      if (!controller.signal.aborted) window.location.assign(target.href);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <div className="flex flex-col gap-4">
      {divider && <AuthDivider>{divider}</AuthDivider>}
      {providers.length > 1 && (
        <Field>
          <FieldLabel htmlFor="provider-sign-in">
            {cs ? "Firemní přihlášení" : "Organization sign-in"}
          </FieldLabel>
          <Select
            value={providerId}
            onValueChange={setSelected}
            disabled={disabled || busy}
          >
            <SelectTrigger id="provider-sign-in" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={disabled || busy}
        onClick={() => void start()}
      >
        {busy ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <Fingerprint data-icon="inline-start" />
        )}
        {cs ? "Pokračovat přes" : "Continue with"}{" "}
        {providers.find((p) => p.id === providerId)?.name}
      </Button>
      {alternativeLabel && <AuthDivider>{alternativeLabel}</AuthDivider>}
      {(error || longReturnPath) && (
        <Alert variant="destructive">
          <AlertDescription>
            {longReturnPath
              ? cs
                ? "Tento požadavek je pro firemní přihlášení příliš dlouhý. Přihlas se e-mailem a heslem na této stránce."
                : "This request is too long for organization sign-in. Use email and password on this page."
              : cs
                ? "Přihlášení se nepodařilo zahájit. Zkus to znovu."
                : "Could not start sign-in. Try again."}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

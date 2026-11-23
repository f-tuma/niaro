import { PageHeader, Section } from "@admin/components/console/page";
import {
  SettingRow,
  SettingRows,
  SettingValue,
} from "@admin/components/console/setting-row";
import { RelativeTime } from "@admin/components/console/time";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import { useAdmin } from "./context";
import { useConsoleScope } from "./console-scope";
import { ServerSettingsSections } from "./server-settings";
import { AccountProviderLinks } from "./account-providers";
import { useShellCopy } from "./shell-copy";
import { Link } from "@tanstack/react-router";
import { FileJson, Settings2 } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { useConfigBundleCopy } from "./config-bundle-copy";

function SessionLifetime() {
  const copy = useShellCopy();
  const { data } = useAdmin();
  return (
    <SettingRow label={copy.appSessionLifetime}>
      <SettingValue>
        {Math.round(data.server.sessionSeconds / 60)} {copy.minutes}
      </SettingValue>
    </SettingRow>
  );
}

/**
 * Server-wide settings in titled groups, for the server's owners only; the
 * personal parts live on Account. Theme and language live in the account
 * menu; sign-in methods and export/import have their own pages.
 */
export function Settings() {
  const copy = useShellCopy();
  const bundleCopy = useConfigBundleCopy();
  const { data } = useAdmin();
  const scope = useConsoleScope();
  // The server checks again on every request; this only picks what to show.
  const organizationId =
    data.authentication.current === "better-auth"
      ? scope.identity.data?.instance.organizationId
      : undefined;
  if (scope.identity.isPending) return null;
  return (
    <>
      <PageHeader
        title={copy.settings}
        actions={
          organizationId && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/settings/configuration">
                <FileJson data-icon="inline-start" aria-hidden="true" />
                {bundleCopy.open}
              </Link>
            </Button>
          )
        }
      />
      {organizationId ? (
        <div className="grid items-start gap-8 lg:grid-cols-2 2xl:grid-cols-3">
          <ServerSettingsSections organizationId={organizationId}>
            <SessionLifetime />
          </ServerSettingsSections>
        </div>
      ) : (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Settings2 />
            </EmptyMedia>
            <EmptyTitle>{copy.ownerSettingsTitle}</EmptyTitle>
            <EmptyDescription>{copy.ownerSettingsHint}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  );
}

/**
 * The person's own account for every console user: linking sign-in methods,
 * the session and read-only server facts. A recovery session sees the facts.
 */
export function AccountPage() {
  const copy = useShellCopy();
  const { data, language } = useAdmin();
  const scope = useConsoleScope();
  const account = data.authentication.current === "better-auth";
  return (
    <>
      <PageHeader title={copy.account} />
      <div className="grid items-start gap-8 lg:grid-cols-2 2xl:grid-cols-3">
        {account && (
          <AccountProviderLinks
            language={language}
            userId={scope.identity.data?.user?.id}
            organizationId={scope.organization?.id}
          />
        )}
        <Section title={copy.session} description={copy.sessionHint}>
          <SettingRows>
            <SettingRow label={copy.signInMethod}>
              <SettingValue>
                {account ? copy.accountSignIn : copy.recoverySession}
              </SettingValue>
            </SettingRow>
            <SettingRow label={copy.expires}>
              <SettingValue>
                <RelativeTime value={data.authentication.expiresAt} />
              </SettingValue>
            </SettingRow>
          </SettingRows>
        </Section>
        <Section title={copy.groupServer}>
          <SettingRows>
            <SettingRow label={copy.serverName}>
              <SettingValue>{data.server.name}</SettingValue>
            </SettingRow>
            <SessionLifetime />
          </SettingRows>
        </Section>
      </div>
      <p className="text-xs text-muted-foreground">
        {copy.aboutServer}: {copy.started}{" "}
        <RelativeTime value={data.server.startedAt} /> · {copy.protocol}{" "}
        <code className="font-mono">{data.server.workflowProfile}</code>
      </p>
    </>
  );
}

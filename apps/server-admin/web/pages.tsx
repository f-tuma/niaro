import { PageHeader, Section } from "@admin/components/console/page";
import {
  SettingRow,
  SettingRows,
  SettingValue,
} from "@admin/components/console/setting-row";
import { RelativeTime } from "@admin/components/console/time";
import { useAdmin } from "./context";
import { useConsoleScope } from "./console-scope";
import { ServerSettingsSections } from "./server-settings";
import { useShellCopy } from "./shell-copy";
import { Link } from "@tanstack/react-router";
import { FileJson } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { useConfigBundleCopy } from "./config-bundle-copy";

/**
 * Server-wide settings in titled groups, then the console session. Theme and
 * language live in the account menu; sign-in methods and export/import have
 * their own pages.
 */
export function Settings() {
  const copy = useShellCopy();
  const bundleCopy = useConfigBundleCopy();
  const { data } = useAdmin();
  const scope = useConsoleScope();
  const account = data.authentication.current === "better-auth";
  // Server settings change from an owner's or administrator's account.
  const manager =
    account && scope.organization && scope.organization.role !== "member"
      ? scope.organization.id
      : undefined;
  const sessionLifetime = (
    <SettingRow label={copy.appSessionLifetime}>
      <SettingValue>
        {Math.round(data.server.sessionSeconds / 60)} {copy.minutes}
      </SettingValue>
    </SettingRow>
  );
  return (
    <>
      <PageHeader
        title={copy.settings}
        actions={
          manager && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/settings/configuration">
                <FileJson data-icon="inline-start" aria-hidden="true" />
                {bundleCopy.open}
              </Link>
            </Button>
          )
        }
      />
      <div className="grid items-start gap-8 lg:grid-cols-2 2xl:grid-cols-3">
        {manager ? (
          <ServerSettingsSections organizationId={manager}>
            {sessionLifetime}
          </ServerSettingsSections>
        ) : (
          <Section title={copy.groupServer}>
            <SettingRows>
              <SettingRow label={copy.serverName}>
                <SettingValue>{data.server.name}</SettingValue>
              </SettingRow>
              {sessionLifetime}
            </SettingRows>
          </Section>
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
            {manager && (
              <SettingRow label={copy.signIn} meta={copy.signInMethodsHint}>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/auth-providers">{copy.open}</Link>
                </Button>
              </SettingRow>
            )}
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

import { AccountProviders } from "./account-providers";
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

/** Theme and language live in the account menu in the sidebar footer. */
export function Settings() {
  const copy = useShellCopy();
  const { data } = useAdmin();
  const scope = useConsoleScope();
  const account = data.authentication.current === "better-auth";
  // Server settings change from an owner's or administrator's account.
  const manager =
    account && scope.organization && scope.organization.role !== "member"
      ? scope.organization.id
      : undefined;
  const server = (
    <>
      <SettingRow label={copy.started}>
        <SettingValue>
          <RelativeTime value={data.server.startedAt} />
        </SettingValue>
      </SettingRow>
      <SettingRow label={copy.appSessionLifetime}>
        <SettingValue>
          {Math.round(data.server.sessionSeconds / 60)} {copy.minutes}
        </SettingValue>
      </SettingRow>
      <SettingRow label={copy.protocol}>
        <SettingValue>
          <code className="font-mono text-xs">
            {data.server.workflowProfile}
          </code>
        </SettingValue>
      </SettingRow>
    </>
  );
  return (
    <>
      <PageHeader title={copy.settings} />
      <div className="grid items-start gap-8 lg:grid-cols-2 2xl:grid-cols-3">
        {account && <AccountProviders />}
        <Section title={copy.session}>
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
        {manager ? (
          <ServerSettingsSections organizationId={manager}>
            {server}
          </ServerSettingsSections>
        ) : (
          <Section title={copy.groupServer}>
            <SettingRows>
              <SettingRow label={copy.serverName}>
                <SettingValue>{data.server.name}</SettingValue>
              </SettingRow>
              {server}
            </SettingRows>
          </Section>
        )}
      </div>
    </>
  );
}

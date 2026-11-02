import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Badge } from "@admin/components/ui/badge";
import { Card } from "@admin/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle } from "@admin/components/ui/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import { PageHeader, Section } from "@admin/components/console/page";
import { StatusDot } from "@admin/components/console/status";
import { DetailList } from "@admin/components/console/forms";
import { RelativeTime } from "@admin/components/console/time";
import { plural } from "../lib/plural";
import {
  MemberServiceList,
  type MemberService,
  type MemberServiceAction,
} from "../../../../packages/protocol/member-services";
import { api } from "../lib/api";
import { useApp, type AppWorkspace } from "./context";
import {
  useMemberServicesCopy,
  type MemberServicesCopy,
} from "./member-services-copy";
import { MenuPage } from "./menu-page";
import { useMenuCopy } from "./menu-copy";
import { ServiceMark } from "./connections-page";

export function memberServicesKey(workspace: AppWorkspace) {
  return [
    "app",
    "member-services",
    workspace.organizationId,
    workspace.workspaceId,
  ] as const;
}

/** Every service the person may use as the server projects it for them:
 * whose account it reads with, what they may run, their own last outcomes. */
export function useMemberServices(workspace: AppWorkspace) {
  return useQuery({
    queryKey: memberServicesKey(workspace),
    queryFn: async ({ signal }) =>
      MemberServiceList.parse(
        await api(
          "identity/catalog/member/services",
          {
            organizationId: workspace.organizationId,
            workspaceId: workspace.workspaceId,
          },
          signal,
        ),
      ),
    retry: false,
  });
}

/** Read with the company's account only: nothing to sign in to. */
export function companyServices(services: readonly MemberService[]) {
  return services.filter((service) => !service.own && service.signIn === null);
}

/** Whose account reads and changes use, as one or two quiet labels. */
export function accountLabels(
  service: Pick<MemberService, "reads" | "changes">,
  copy: MemberServicesCopy,
) {
  const name = (account: MemberService["reads"]["account"]) =>
    account === "own" ? copy.accountOwn : copy.accountCompany;
  if (service.reads.account === service.changes.account)
    return [
      service.reads.account === "own"
        ? copy.accountOwnTitle
        : copy.accountCompanyTitle,
    ];
  return [
    copy.readingAccount.replace("{account}", name(service.reads.account)),
    copy.changesAccount.replace("{account}", name(service.changes.account)),
  ];
}

export function AccountBadges({
  service,
}: {
  service: Pick<MemberService, "reads" | "changes">;
}) {
  const copy = useMemberServicesCopy();
  return (
    <>
      {accountLabels(service, copy).map((label) => (
        <Badge key={label} variant="outline">
          {label}
        </Badge>
      ))}
    </>
  );
}

/**
 * The row's last outcome: a failure when it is newer than the last read,
 * otherwise the last read. Nothing before the first one.
 */
export function ServiceActivityMeta({
  service,
}: {
  service: Pick<MemberService, "lastRead" | "lastFailure">;
}) {
  const copy = useMemberServicesCopy();
  const { lastRead, lastFailure } = service;
  if (lastFailure && (!lastRead || lastFailure.at > lastRead.at))
    return (
      <StatusDot tone="warning" size="sm">
        {copy.failedAt} <RelativeTime value={lastFailure.at} />
      </StatusDot>
    );
  if (lastRead)
    return (
      <span>
        {copy.readAt} <RelativeTime value={lastRead.at} />
      </span>
    );
  return null;
}

/** The person's own last read and last failure in one service. */
export function ServiceActivitySection({
  service,
}: {
  service: Pick<MemberService, "lastRead" | "lastFailure">;
}) {
  const copy = useMemberServicesCopy();
  return (
    <Section title={copy.activityTitle}>
      <DetailList
        items={[
          {
            label: copy.lastRead,
            value: service.lastRead ? (
              <RelativeTime value={service.lastRead.at} />
            ) : (
              <span className="text-muted-foreground">{copy.never}</span>
            ),
          },
          {
            label: copy.lastFailure,
            value: service.lastFailure ? (
              <span className="flex flex-wrap items-center gap-x-2">
                <RelativeTime value={service.lastFailure.at} />
                <StatusDot tone="warning" size="sm">
                  {copy.failure[service.lastFailure.kind]}
                </StatusDot>
              </span>
            ) : (
              <span className="text-muted-foreground">{copy.none}</span>
            ),
          },
        ]}
      />
    </Section>
  );
}

/** The "Company account" group of Connections: read-only rows, no sign-in. */
export function CompanyServices({
  services,
  workspace,
}: {
  services: readonly MemberService[];
  workspace: AppWorkspace;
}) {
  const copy = useMemberServicesCopy();
  const { language } = useApp();
  if (!services.length) return null;
  return (
    <Section title={copy.accountCompanyTitle}>
      <Card variant="list">
        {services.map((service) => (
          <Item
            key={service.serviceId}
            variant="row"
            size="row"
            data-testid="company-service"
          >
            <Link
              to="/connections/$serviceId"
              params={{ serviceId: service.serviceId }}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-sm outline-offset-4 focus-visible:outline-2"
            >
              <ItemMedia>
                <ServiceMark service={service} workspace={workspace} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{service.name}</ItemTitle>
                <ItemDescription>
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span>{effectCounts(service, copy, language)}</span>
                    <ServiceActivityMeta service={service} />
                  </span>
                </ItemDescription>
              </ItemContent>
              <ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
            </Link>
          </Item>
        ))}
      </Card>
    </Section>
  );
}

/** "3 reads, 1 change": what the person may run there. */
export function effectCounts(
  service: Pick<MemberService, "reads" | "changes">,
  copy: MemberServicesCopy,
  language: string,
) {
  return [
    plural(language, service.reads.actions.length, copy.reads),
    ...(service.changes.actions.length
      ? [plural(language, service.changes.actions.length, copy.changes)]
      : []),
  ].join(", ");
}

/** A service read with the company's account: what the assistant may do
 * there for the person, set by administrators, and the person's own
 * activity. No sign-in, no switches, no configuration. */
export function CompanyServiceDetail({
  service,
  workspace,
  back,
}: {
  service: MemberService;
  workspace: AppWorkspace;
  back: { to: "/connections"; label: string };
}) {
  const copy = useMemberServicesCopy();
  const menu = useMenuCopy();
  const groups = [
    { title: menu.permissionsReads, actions: service.reads.actions },
    { title: menu.permissionsWrites, actions: service.changes.actions },
  ].filter((group) => group.actions.length > 0);
  return (
    <MenuPage>
      <PageHeader
        title={service.name}
        back={back}
        media={
          <ServiceMark service={service} workspace={workspace} size="lg" />
        }
        meta={<AccountBadges service={service} />}
      />
      <Section title={menu.permissionsTitle}>
        <div className="flex flex-col gap-6">
          <p className="text-sm text-muted-foreground">{copy.setByAdmin}</p>
          {groups.length ? (
            groups.map((group) => (
              <ActionGroup
                key={group.title}
                title={group.title}
                actions={group.actions}
              />
            ))
          ) : (
            <Empty variant="outline">
              <EmptyHeader>
                <EmptyTitle>{copy.actionsNone}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </Section>
      <ServiceActivitySection service={service} />
    </MenuPage>
  );
}

function ActionGroup({
  title,
  actions,
}: {
  title: string;
  actions: MemberServiceAction[];
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className="flex min-h-8 items-baseline gap-2 text-sm font-medium">
        {title}
        <span className="font-normal text-muted-foreground tabular-nums">
          {actions.length}
        </span>
      </h3>
      <Card variant="list">
        {actions.map((action) => (
          <Item key={action.id} variant="row" size="row">
            <ItemContent>
              <ItemTitle>{action.name}</ItemTitle>
              {action.description && (
                <ItemDescription>{action.description}</ItemDescription>
              )}
            </ItemContent>
          </Item>
        ))}
      </Card>
    </section>
  );
}

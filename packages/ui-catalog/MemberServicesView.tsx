import React from "react";
import { tokens as t } from "../design-tokens";
import type { Language } from "../protocol";
import type { MemberService } from "../protocol/member-services";
import { Group, IconTile, ListRow, Text, type IconName } from "../ui";
import { formatInstant } from "./field-format";
import {
  memberServicesCopy,
  type MemberServicesCopy,
} from "./member-services-copy";

const ICONS: Record<MemberService["icon"], IconName> = {
  plug: "link",
  database: "server",
  users: "people",
  calendar: "calendar",
  mail: "mail",
  code: "wrench",
  folder: "archive",
  search: "search",
};

/** Read with the company's account only: nothing for the person to sign in to. */
export function isCompanyService(service: MemberService) {
  return !service.own && service.signIn === null;
}

function count(
  language: Language,
  value: number,
  forms: { one: string; few: string; other: string },
) {
  // Hermes on the phone has no Intl.PluralRules: the rule is written out.
  const word =
    value === 1
      ? forms.one
      : language === "cs" && value >= 2 && value <= 4
        ? forms.few
        : forms.other;
  return `${value} ${word}`;
}

/** "2 reads, 1 change", or that nothing is usable. */
export function memberServiceCounts(
  service: MemberService,
  language: Language,
  copy: MemberServicesCopy = memberServicesCopy[language],
) {
  const reads = service.reads.actions.length,
    changes = service.changes.actions.length;
  if (!reads && !changes) return copy.noActions;
  return [
    ...(reads ? [count(language, reads, copy.reads)] : []),
    ...(changes ? [count(language, changes, copy.changes)] : []),
  ].join(", ");
}

const at = (value: number, language: Language) =>
  formatInstant(new Date(value).toISOString(), language) ?? "";

function ServiceRow({
  service,
  language,
}: {
  service: MemberService;
  language: Language;
}) {
  const copy = memberServicesCopy[language];
  const name = (account: MemberService["reads"]["account"]) =>
    account === "own" ? copy.ownLower : copy.companyLower;
  const accounts =
    service.reads.account === service.changes.account
      ? [
          service.reads.account === "own"
            ? copy.accountOwn
            : copy.accountCompany,
        ]
      : [
          copy.readingAccount.replace("{account}", name(service.reads.account)),
          copy.changesAccount.replace(
            "{account}",
            name(service.changes.account),
          ),
        ];
  const description = [
    ...(service.signIn ? [copy.signIn[service.signIn]] : []),
    ...accounts,
    memberServiceCounts(service, language, copy),
  ].join(" · ");
  return (
    <ListRow
      testID={`member-service-${service.serviceId}`}
      leading={<IconTile icon={ICONS[service.icon]} size={32} />}
      label={service.name}
      description={description}
      strong
    >
      {service.lastRead ? (
        <Text role="meta" tone="secondary">
          {copy.lastRead.replace("{time}", at(service.lastRead.at, language))}
        </Text>
      ) : null}
      {service.lastFailure ? (
        <Text role="meta" style={{ color: t.color.status.warning }}>
          {copy.lastFailure
            .replace("{time}", at(service.lastFailure.at, language))
            .replace("{kind}", copy.failure[service.lastFailure.kind])}
        </Text>
      ) : null}
    </ListRow>
  );
}

/**
 * Where the assistant reads and changes things for the person: the services
 * under their own account, then those under the company's account, read-only.
 * Each says whose account it uses, what the person may run and their own last
 * read and failure. No sign-in, switches or configuration here.
 */
export function MemberServicesView({
  language,
  services,
  failed = false,
}: {
  language: Language;
  /** Undefined while loading. */
  services?: readonly MemberService[];
  failed?: boolean;
}) {
  const copy = memberServicesCopy[language];
  if (failed || !services)
    return (
      <Group title={copy.title}>
        <ListRow
          icon={failed ? "alert" : "clock"}
          label={failed ? copy.failed : copy.loading}
        />
      </Group>
    );
  if (!services.length)
    return (
      <Group title={copy.title}>
        <ListRow icon="info" label={copy.empty} />
      </Group>
    );
  const own = services.filter((service) => !isCompanyService(service));
  const company = services.filter(isCompanyService);
  return (
    <>
      {own.length ? (
        <Group title={copy.accountOwn} testID="member-services-own">
          {own.map((service) => (
            <ServiceRow
              key={service.serviceId}
              service={service}
              language={language}
            />
          ))}
        </Group>
      ) : null}
      {company.length ? (
        <Group title={copy.accountCompany} testID="member-services-company">
          {company.map((service) => (
            <ServiceRow
              key={service.serviceId}
              service={service}
              language={language}
            />
          ))}
        </Group>
      ) : null}
    </>
  );
}

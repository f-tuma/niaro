import type { MemberService } from "../../../../packages/protocol/member-services";
import { useApp } from "./context";

/** Copy of "where Niaro reads for you" on Connections (NIAR-274). */
const en = {
  accountOwnTitle: "Your account",
  accountCompanyTitle: "Company account",
  readsCompany: "Reads with company account",
  readingAccount: "Reading: {account}",
  changesAccount: "Changes: {account}",
  accountOwn: "your account",
  accountCompany: "company account",
  setByAdmin: "Set by an administrator.",
  activityTitle: "Your activity",
  lastRead: "Last read",
  lastFailure: "Last failure",
  readAt: "Read",
  failedAt: "Failed",
  never: "Not yet",
  none: "None",
  actionsNone: "Nothing you can use here.",
  reads: { one: "read", few: "reads", other: "reads" },
  changes: { one: "change", few: "changes", other: "changes" },
  failure: {
    validation: "Input rejected",
    permission: "Access denied",
    connection: "Connection failed",
    rate_limit: "Too many requests",
    provider: "Service error",
    response: "No valid result",
    cancelled: "Interrupted",
    unknown: "Unknown cause",
  } satisfies Record<NonNullable<MemberService["lastFailure"]>["kind"], string>,
};
export type MemberServicesCopy = typeof en;
const cs: MemberServicesCopy = {
  accountOwnTitle: "Tvůj účet",
  accountCompanyTitle: "Firemní účet",
  readsCompany: "Čte firemním účtem",
  readingAccount: "Čtení: {account}",
  changesAccount: "Změny: {account}",
  accountOwn: "tvůj účet",
  accountCompany: "firemní účet",
  setByAdmin: "Nastavuje správce.",
  activityTitle: "Tvoje aktivita",
  lastRead: "Naposledy čteno",
  lastFailure: "Poslední chyba",
  readAt: "Čteno",
  failedAt: "Chyba",
  never: "Zatím ne",
  none: "Žádná",
  actionsNone: "Nic tu nemůžeš použít.",
  reads: { one: "čtení", few: "čtení", other: "čtení" },
  changes: { one: "změna", few: "změny", other: "změn" },
  failure: {
    validation: "Vstup odmítnut",
    permission: "Přístup odepřen",
    connection: "Spojení selhalo",
    rate_limit: "Moc požadavků",
    provider: "Chyba služby",
    response: "Neplatný výsledek",
    cancelled: "Přerušeno",
    unknown: "Neznámá příčina",
  },
};
export const memberServicesCopy = { en, cs };
export function useMemberServicesCopy(): MemberServicesCopy {
  return memberServicesCopy[useApp().language];
}

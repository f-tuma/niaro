import type { Language } from "../protocol";
import type { MemberService } from "../protocol/member-services";

/** Copy of "where Niaro reads for you" on the phone (NIAR-274). */
const en = {
  title: "Where Niaro reads",
  accountOwn: "Your account",
  accountCompany: "Company account",
  readingAccount: "Reading: {account}",
  changesAccount: "Changes: {account}",
  ownLower: "your account",
  companyLower: "company account",
  lastRead: "Last read: {time}",
  lastFailure: "Last failure: {time} · {kind}",
  noActions: "Nothing you can use here",
  loading: "Loading…",
  failed: "Couldn't load the services.",
  empty: "No services yet.",
  reads: { one: "read", few: "reads", other: "reads" },
  changes: { one: "change", few: "changes", other: "changes" },
  signIn: {
    connected: "Connected",
    expired: "Sign-in expired",
    disconnected: "Not connected",
    not_ready: "Not set up",
  } satisfies Record<NonNullable<MemberService["signIn"]>, string>,
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
  title: "Kde Niaro čte",
  accountOwn: "Tvůj účet",
  accountCompany: "Firemní účet",
  readingAccount: "Čtení: {account}",
  changesAccount: "Změny: {account}",
  ownLower: "tvůj účet",
  companyLower: "firemní účet",
  lastRead: "Naposledy čteno: {time}",
  lastFailure: "Poslední chyba: {time} · {kind}",
  noActions: "Nic tu nemůžeš použít",
  loading: "Načítám…",
  failed: "Služby se nepodařilo načíst.",
  empty: "Zatím žádné služby.",
  reads: { one: "čtení", few: "čtení", other: "čtení" },
  changes: { one: "změna", few: "změny", other: "změn" },
  signIn: {
    connected: "Připojeno",
    expired: "Přihlášení vypršelo",
    disconnected: "Nepřipojeno",
    not_ready: "Nenastaveno",
  },
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
export const memberServicesCopy: Record<Language, MemberServicesCopy> = {
  en,
  cs,
};

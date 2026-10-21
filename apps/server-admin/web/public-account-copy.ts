import { ApiError } from "./lib/api";

/** Words of the public account pages: sign-in, invitation and password reset. */
export const en = {
  signInFailed:
    "Sign-in failed. Use the account with the invited email, or sign in with a password.",
  continueFailed: "Could not continue. Check your sign-in and the link.",
  reopen: "Open sign-in again from the app.",
  inviteAccepted: "Invitation accepted",
  inviteAcceptedHint:
    "You can now sign in to the app with this server address.",
  signedIn: "Signed in",
  returnToApp: "Return to the app.",
  inviteTitle: "Workspace invitation",
  appTitle: "Sign in to the app",
  invalidLink:
    "This link is not valid. Ask for a new invitation or start in the app.",
  orPassword: "or create a password",
  or: "or",
  name: "Name",
  newPassword: "New password",
  passwordHint: "At least 12 characters.",
  accept: "Accept invitation",
  email: "Email",
  password: "Password",
  signIn: "Sign in",
  signingInAs: "Signing in as",
  organization: "Organization",
  workspace: "Workspace",
  noWorkspace:
    "You have no workspace access. Ask an administrator for an invitation.",
  continue: "Continue to the app",
  otherAccount: "Use another account",
  haveAccount: "I already have an account",
  loading: "Loading",
  invitation_invalid:
    "This invitation link isn't valid. Ask the administrator for a new one.",
  invitation_expired:
    "This invitation has expired (links last 48 hours). Ask for a new one.",
  invitation_used: "This invitation has already been used. Just sign in.",
  invitation_revoked:
    "This invitation was cancelled. Ask the administrator for a new one.",
  invitation_account_mismatch:
    "That account has a different email than the invitation. Use the invited one.",
  invitation_sign_in_required: "Sign in with the invited account first.",
  auth_provider_link_required:
    "An account with this email already exists. Sign in with your password, then connect the provider.",
  loginLinkRequired:
    "This sign-in isn't connected to your account yet. Sign in with your password and connect it.",
  wrongPassword: "Wrong email or password.",
  shortPassword: "The password needs at least 12 characters.",
  resetTitle: "Set a new password",
  resetDone: "Password set",
  resetDoneHint:
    "You were signed out everywhere. Sign in with the new password.",
  resetSave: "Save password",
  repeatPassword: "Repeat password",
  mismatch: "The passwords don't match.",
  toSignIn: "Sign in",
  password_reset_invalid:
    "This link isn't valid anymore. Ask the administrator for a new one.",
  password_reset_expired:
    "This link has expired (links last 48 hours). Ask for a new one.",
  password_reset_used: "This link has already been used.",
  rateLimited: "Too many attempts. Wait a while and try again.",
  mobile_device_limit:
    "You're signed in on too many devices (8 at most). Remove one in your account on the web (Account → Devices) and try again.",
};
export const cs: typeof en = {
  signInFailed:
    "Přihlášení se nezdařilo. Použij účet s e-mailem z pozvánky, případně se přihlas heslem.",
  continueFailed:
    "Nepodařilo se pokračovat. Ověř přihlášení a platnost odkazu.",
  reopen: "Otevři přihlášení znovu přímo z aplikace.",
  inviteAccepted: "Pozvánka přijata",
  inviteAcceptedHint:
    "Nyní se můžeš přihlásit v aplikaci adresou tohoto serveru.",
  signedIn: "Přihlášeno",
  returnToApp: "Vrať se do aplikace.",
  inviteTitle: "Pozvánka do pracovního prostoru",
  appTitle: "Přihlášení do aplikace",
  invalidLink:
    "Odkaz není platný. Vyžádej si novou pozvánku nebo začni v aplikaci.",
  orPassword: "nebo vytvořit heslo",
  or: "nebo",
  name: "Jméno",
  newPassword: "Nové heslo",
  passwordHint: "Alespoň 12 znaků.",
  accept: "Přijmout pozvánku",
  email: "E-mail",
  password: "Heslo",
  signIn: "Přihlásit",
  signingInAs: "Přihlašuješ se jako",
  organization: "Organizace",
  workspace: "Workspace",
  noWorkspace:
    "Nemáš přístup k žádnému pracovnímu prostoru. Požádej správce o pozvánku.",
  continue: "Pokračovat do aplikace",
  otherAccount: "Použít jiný účet",
  haveAccount: "Už účet mám",
  loading: "Načítám",
  invitation_invalid:
    "Tenhle odkaz na pozvánku neplatí. Požádej správce o nový.",
  invitation_expired:
    "Pozvánka vypršela (platí 48 hodin). Požádej správce o novou.",
  invitation_used: "Pozvánka už byla přijatá. Stačí se přihlásit.",
  invitation_revoked: "Pozvánku správce zrušil. Požádej ho o novou.",
  invitation_account_mismatch:
    "Tenhle účet má jiný e-mail než pozvánka. Použij účet s e-mailem z pozvánky.",
  invitation_sign_in_required: "Nejdřív se přihlas účtem z pozvánky.",
  auth_provider_link_required:
    "Účet s tímhle e-mailem už existuje. Přihlas se heslem a poskytovatele si propoj potom.",
  loginLinkRequired:
    "Tohle přihlášení ještě není propojené s tvým účtem. Přihlas se heslem a propoj ho.",
  wrongPassword: "Špatný e-mail nebo heslo.",
  shortPassword: "Heslo musí mít aspoň 12 znaků.",
  resetTitle: "Nové heslo",
  resetDone: "Heslo je nastavené",
  resetDoneHint: "Všude jsme tě odhlásili. Přihlas se novým heslem.",
  resetSave: "Uložit heslo",
  repeatPassword: "Heslo znovu",
  mismatch: "Hesla se neshodují.",
  toSignIn: "Přihlásit se",
  password_reset_invalid: "Odkaz už neplatí. Požádej správce o nový.",
  password_reset_expired:
    "Odkaz vypršel (platí 48 hodin). Požádej správce o nový.",
  password_reset_used: "Tenhle odkaz už byl použitý.",
  rateLimited: "Moc pokusů. Chvíli počkej a zkus to znovu.",
  mobile_device_limit:
    "Jsi přihlášený na moc zařízeních (nejvýš 8). Některé odeber v účtu na webu (Účet → Zařízení) a zkus to znovu.",
};
export type Copy = typeof en;
const reasons = [
  "invitation_invalid",
  "invitation_expired",
  "invitation_used",
  "invitation_revoked",
  "invitation_account_mismatch",
  "invitation_sign_in_required",
  "auth_provider_link_required",
  "password_reset_invalid",
  "password_reset_expired",
  "password_reset_used",
  "mobile_device_limit",
] as const;
/** A short reason the person can act on; falls back to `fallback`. */
export function failureText(
  error: unknown,
  copy: Copy,
  fallback: string,
): string {
  if (!(error instanceof ApiError)) return fallback;
  const code = reasons.find((r) => r === error.code);
  if (code) return copy[code];
  if (error.status === 429) return copy.rateLimited;
  return fallback;
}
/** The reason a provider sign-in returned with, named when the person can fix it. */
export function redirectFailure(
  search: string,
  copy: Copy,
  invite: boolean,
): string {
  const params = new URLSearchParams(search);
  if (!params.has("error")) return "";
  const code = params.get("error");
  if (code === "invitation_account_mismatch") return copy[code];
  if (code === "auth_provider_link_required")
    return invite ? copy[code] : copy.loginLinkRequired;
  return copy.signInFailed;
}

import { useState } from "react";
import { z } from "zod";
import { Button } from "@admin/components/ui/button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@admin/components/ui/alert";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import { SubmitButton } from "@admin/components/console/forms";
import { api, ApiError } from "./lib/api";
import { useAdmin } from "./context";
import { CopyLinkField } from "./copy-link";

const en = {
  title: "New password for",
  intro:
    "One-time link, valid 48 hours; using it signs the person out everywhere.",
  create: "Create link",
  done: "Done",
  cancel: "Cancel",
  emailed: "The link was emailed",
  emailedHint: "You can also pass it on yourself.",
  ready: "The link is ready",
  readyHint: "The server has no email set up. Send the link yourself.",
  mailFailed: "The email didn't go out. Send the link yourself.",
  link: "Password link",
  linkRule: "Works once. You won't see it again.",
  copy: "Copy link",
  copied: "Link copied",
  copyFailed: "Couldn't copy. Select the link and copy it by hand.",
  forbidden: "You can't reset this person's password.",
  otherOrganization:
    "This person also belongs to another organization, so a reset link can't be issued here.",
  limited: "Too many links at once. Try again later.",
  failed: "Couldn't create the link. Try again.",
};
const cs: typeof en = {
  title: "Nové heslo pro",
  intro: "Jednorázový odkaz na 48 hodin; po použití se člověk všude odhlásí.",
  create: "Vytvořit odkaz",
  done: "Hotovo",
  cancel: "Zrušit",
  emailed: "Odkaz odešel e-mailem",
  emailedHint: "Můžeš ho poslat i sám.",
  ready: "Odkaz je připravený",
  readyHint: "Server nemá nastavený e-mail. Pošli odkaz sám.",
  mailFailed: "E-mail neodešel. Pošli odkaz sám.",
  link: "Odkaz na heslo",
  linkRule: "Funguje jen jednou. Znovu ho už neuvidíš.",
  copy: "Zkopírovat odkaz",
  copied: "Odkaz zkopírován",
  copyFailed: "Kopírování nevyšlo. Označ odkaz a zkopíruj ho ručně.",
  forbidden: "Tomuhle člověku heslo obnovit nemůžeš.",
  otherOrganization:
    "Tenhle člověk je i v jiné organizaci, takže mu tady odkaz vydat nejde.",
  limited: "Moc odkazů najednou. Zkus to později.",
  failed: "Odkaz se nepodařilo vytvořit. Zkus to znovu.",
};

const Issued = z.object({
  link: z.url(),
  delivery: z.enum(["email", "link"]),
  mail: z.boolean(),
});

/** Owners and administrators issue a one-time password link for a member. */
export function PasswordResetSheet({
  organizationId,
  member,
  onClose,
}: {
  organizationId: string;
  member: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const { language } = useAdmin();
  const copy = language === "cs" ? cs : en;
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [issued, setIssued] = useState<z.infer<typeof Issued> | null>(null);
  function close() {
    if (pending) return;
    setIssued(null);
    setError("");
    onClose();
  }
  async function create() {
    if (!member || pending) return;
    setPending(true);
    setError("");
    try {
      setIssued(
        Issued.parse(
          await api("identity/password-reset", {
            organizationId,
            memberId: member.id,
          }),
        ),
      );
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.code === "password_reset_other_organization"
            ? copy.otherOrganization
            : failure.status === 403
              ? copy.forbidden
              : failure.status === 429
                ? copy.limited
                : copy.failed
          : copy.failed,
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <Sheet open={!!member} onOpenChange={(open) => !open && close()}>
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {copy.title} {member?.name}
          </SheetTitle>
          <SheetDescription>{copy.intro}</SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (issued) close();
            else void create();
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {issued && (
              <Alert>
                <AlertTitle>
                  {issued.delivery === "email" ? copy.emailed : copy.ready}
                </AlertTitle>
                <AlertDescription>
                  {issued.delivery === "email"
                    ? copy.emailedHint
                    : issued.mail
                      ? copy.mailFailed
                      : copy.readyHint}
                </AlertDescription>
              </Alert>
            )}
            {issued && (
              <CopyLinkField
                label={copy.link}
                value={issued.link}
                description={copy.linkRule}
                copy={copy}
              />
            )}
          </div>
          <SheetFooter>
            {!issued && (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={close}
              >
                {copy.cancel}
              </Button>
            )}
            <SubmitButton pending={pending}>
              {issued ? copy.done : copy.create}
            </SubmitButton>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

import { Ban } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { api, ApiError } from "./lib/api";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@admin/components/ui/field";
import { SheetFooter } from "@admin/components/ui/sheet";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@admin/components/ui/alert";
import { Card } from "@admin/components/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@admin/components/ui/item";
import {
  ConfirmAction,
  SubmitButton,
  MoreActions,
} from "@admin/components/console/forms";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
import { Section } from "@admin/components/console/page";
import { useAdmin } from "./context";
import { CopyLinkField } from "./copy-link";

const en = {
  email: "Email",
  send: "Send invitation",
  create: "Create invitation link",
  sentTitle: "Invitation emailed",
  linkTitle: "Invitation ready",
  linkHint:
    "The server has no email set up. Send this link to the person yourself.",
  link: "Invitation link",
  linkRule: "Valid for 48 hours, works once. You won't see it again.",
  copy: "Copy link",
  copied: "Link copied",
  copyFailed: "Couldn't copy. Select the link and copy it by hand.",
  viaEmail: "emailed",
  viaLink: "link",
  revoked: "Invitation revoked.",
  mailFailed: "The email didn't go out. Check the server's SMTP or try again.",
  limited: "Too many invitations at once. Try again later.",
  failed: "Could not process the invitation. Try again.",
  loadFailed: "Could not load invitations.",
  pending: "Pending invitations",
  validUntil: "Valid until",
  revoke: "Revoke",
  revokeTitle: "Revoke invitation?",
  revokeHint: "The invitation link stops working.",
};
const cs: typeof en = {
  email: "E-mail",
  send: "Odeslat pozvánku",
  create: "Vytvořit odkaz",
  sentTitle: "Pozvánka odešla e-mailem",
  linkTitle: "Pozvánka je připravená",
  linkHint: "Server nemá nastavený e-mail. Pošli odkaz člověku sám.",
  link: "Odkaz na pozvánku",
  linkRule: "Platí 48 hodin a jen jednou. Znovu ho už neuvidíš.",
  copy: "Zkopírovat odkaz",
  copied: "Odkaz zkopírován",
  copyFailed: "Kopírování nevyšlo. Označ odkaz a zkopíruj ho ručně.",
  viaEmail: "e-mailem",
  viaLink: "odkazem",
  revoked: "Pozvánka zrušena.",
  mailFailed: "E-mail neodešel. Zkontroluj SMTP serveru nebo to zkus znovu.",
  limited: "Moc pozvánek najednou. Zkus to později.",
  failed: "Pozvánku se nepodařilo zpracovat. Zkus to znovu.",
  loadFailed: "Pozvánky se nepodařilo načíst.",
  pending: "Čekající pozvánky",
  validUntil: "Platí do",
  revoke: "Odvolat",
  revokeTitle: "Odvolat pozvánku?",
  revokeHint: "Odkaz z pozvánky přestane fungovat.",
};

/**
 * The body and footer of an invite sheet: an email field (plus any `fields`
 * the caller puts above it, such as a workspace picker), pending invitations,
 * and the standard Cancel + Send footer.
 */
export function WorkspaceInvitations({
  organizationId,
  workspaceId,
  onCancel,
  fields,
}: {
  organizationId: string;
  workspaceId: string;
  onCancel: () => void;
  fields?: ReactNode;
}) {
  const { language, copy: admin } = useAdmin();
  const copy = language === "cs" ? cs : en;
  const target = { organizationId, workspaceId };
  const [email, setEmail] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [failed, setFailed] = useState(false),
    [revoking, setRevoking] = useState<string | null>(null),
    [created, setCreated] = useState<{
      email: string;
      link: string;
      delivery: "email" | "link";
    } | null>(null);
  const query = useQuery({
    queryKey: ["invitations", workspaceId],
    queryFn: async () =>
      z
        .object({
          mail: z.boolean().optional(),
          invitations: z.array(
            z.object({
              id: z.string(),
              email: z.email(),
              expiresAt: z.number(),
              delivery: z.enum(["email", "link"]).optional(),
            }),
          ),
        })
        .parse(
          await api("identity/invitations", { ...target, action: "list" }),
        ),
  });
  async function change(action: "send" | "revoke", id?: string) {
    setBusy(true);
    setMessage("");
    setFailed(false);
    if (action === "send") setCreated(null);
    try {
      const result = await api("identity/invitations", {
        ...target,
        action,
        ...(id ? { id } : { email }),
      });
      if (action === "send") {
        const sent = z
          .object({ link: z.url(), delivery: z.enum(["email", "link"]) })
          .parse(result);
        setCreated({ email, ...sent });
        setEmail("");
      } else setMessage(copy.revoked);
      setRevoking(null);
      await query.refetch();
    } catch (e) {
      setFailed(true);
      setMessage(
        e instanceof ApiError && e.code === "mail_delivery_failed"
          ? copy.mailFailed
          : e instanceof ApiError && e.status === 429
            ? copy.limited
            : copy.failed,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void change("send");
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
        <FieldGroup>
          {fields}
          <Field>
            <FieldLabel htmlFor="invite-email">{copy.email}</FieldLabel>
            <Input
              id="invite-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={busy}
            />
          </Field>
        </FieldGroup>
        {created && (
          <Alert>
            <AlertTitle>
              {created.delivery === "email" ? copy.sentTitle : copy.linkTitle}
            </AlertTitle>
            <AlertDescription>
              <p>
                {created.email}
                {created.delivery !== "email" && ` · ${copy.linkHint}`}
              </p>
            </AlertDescription>
          </Alert>
        )}
        {created && (
          <CopyLinkField
            label={copy.link}
            value={created.link}
            description={copy.linkRule}
            copy={copy}
          />
        )}
        {message && (
          <Alert variant={failed ? "destructive" : "default"}>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {query.isError && (
          <Alert variant="destructive">
            <AlertDescription>{copy.loadFailed}</AlertDescription>
          </Alert>
        )}
        {!!query.data?.invitations.length && (
          <Section title={copy.pending} count={query.data.invitations.length}>
            <Card variant="list">
              {query.data.invitations.map((i) => (
                <Item key={i.id} variant="row" size="row">
                  <ItemContent>
                    <ItemTitle>{i.email}</ItemTitle>
                    <ItemDescription>
                      {i.delivery === "link" ? copy.viaLink : copy.viaEmail} ·{" "}
                      {copy.validUntil}{" "}
                      {new Date(i.expiresAt).toLocaleString(language, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <MoreActions size="sm" label={admin.moreActions}>
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={busy}
                        onSelect={() => setRevoking(i.id)}
                      >
                        <Ban aria-hidden="true" />
                        {copy.revoke}
                      </DropdownMenuItem>
                    </MoreActions>
                  </ItemActions>
                </Item>
              ))}
            </Card>
          </Section>
        )}
      </div>
      <SheetFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          {admin.cancel}
        </Button>
        <SubmitButton pending={busy} disabled={!email}>
          {query.data?.mail === false ? copy.create : copy.send}
        </SubmitButton>
      </SheetFooter>
      <ConfirmAction
        open={!!revoking}
        onOpenChange={(v) => {
          if (!v && !busy) setRevoking(null);
        }}
        title={copy.revokeTitle}
        description={copy.revokeHint}
        confirmLabel={copy.revoke}
        cancelLabel={admin.cancel}
        onConfirm={() => {
          if (revoking) void change("revoke", revoking);
        }}
      />
    </form>
  );
}

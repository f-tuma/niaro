import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { AuthLayout } from "@admin/components/console/auth-layout";
import { Button } from "@admin/components/ui/button";
import { Alert, AlertDescription } from "@admin/components/ui/alert";

const en = {
  title: "Connect the Niaro app",
  hint: "Open Niaro on this phone and confirm the connection to {host}.",
  open: "Open Niaro",
  invalid: "This link is incomplete. Create a new code in your account.",
};
const cs: typeof en = {
  title: "Připojit aplikaci Niaro",
  hint: "Otevři Niaro v tomto telefonu a potvrď připojení k {host}.",
  open: "Otevřít Niaro",
  invalid: "Odkaz je neúplný. Vytvoř si v účtu nový kód.",
};

/**
 * Where a scanned pairing QR code lands. The server address comes from this
 * page's own origin, never from the link, so a code cannot point the app at
 * another server; the app still asks before it connects.
 */
export function PublicPhonePairing({ language }: { language: "en" | "cs" }) {
  const copy = language === "cs" ? cs : en;
  const [target] = useState(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const workspace = fragment.get("w") ?? "";
    const code = fragment.get("c") ?? "";
    if (!/^[\w-]{1,128}$/.test(workspace) || !/^[a-f0-9]{32}$/.test(code))
      return null;
    return `niaro://pair?${new URLSearchParams({
      address: `${window.location.origin}/v1/${workspace}`,
      code,
    })}`;
  });
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  // The code is read once; it does not stay in the address bar or history.
  useEffect(() => {
    if (window.location.hash)
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
  }, []);
  return (
    <AuthLayout
      icon={<Smartphone />}
      title={copy.title}
      description={copy.hint.replace("{host}", window.location.host)}
    >
      {target ? (
        <Button asChild>
          <a href={target}>{copy.open}</a>
        </Button>
      ) : (
        <Alert variant="destructive">
          <AlertDescription>{copy.invalid}</AlertDescription>
        </Alert>
      )}
    </AuthLayout>
  );
}

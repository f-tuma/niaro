import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { QrCode, RefreshCw } from "lucide-react";
import { renderSVG } from "uqr";
import { MobilePairingResult } from "../../../../packages/protocol/mobile-access";
import { Button } from "@admin/components/ui/button";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@admin/components/ui/dialog";
import { api } from "../lib/api";
import { useApp } from "./context";

const en = {
  open: "Connect phone",
  title: "Connect the Niaro app",
  hint: "Scan the code with your phone's camera, then open Niaro. It works once, for five minutes.",
  until: "Valid until",
  expired: "The code has expired.",
  fresh: "New code",
  failed: "Couldn't create a code. Try again.",
  qr: "QR code for connecting the phone",
};
const cs: typeof en = {
  open: "Připojit telefon",
  title: "Připojit aplikaci Niaro",
  hint: "Naskenuj kód fotoaparátem telefonu a otevři Niaro. Platí jednou a pět minut.",
  until: "Platí do",
  expired: "Kód vypršel.",
  fresh: "Nový kód",
  failed: "Kód se nepodařilo vytvořit. Zkus to znovu.",
  qr: "QR kód pro připojení telefonu",
};

/**
 * A one-time code for this workspace as a QR code. It leads to this server's
 * phone page, which hands it to the app; the code sits in the fragment, so
 * it never reaches a server log.
 */
export function PhonePairing({ onClosed }: { onClosed?: () => void }) {
  const { language, workspace } = useApp();
  const copy = language === "cs" ? cs : en;
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pairing = useMutation({
    mutationFn: async () =>
      MobilePairingResult.parse(
        await api("identity/mobile/pairing", {
          organizationId: workspace.organizationId,
          workspaceId: workspace.workspaceId,
        }),
      ),
  });
  const { mutate, reset } = pairing;
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  const result = pairing.data;
  const expired = !!result && Date.parse(result.expiresAt) <= now;
  const link = result
    ? `${window.location.origin}/account/phone#${new URLSearchParams({
        w: result.workspaceId,
        c: result.code,
      })}`
    : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setNow(Date.now());
          mutate();
        } else {
          reset();
          onClosed?.();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <QrCode data-icon="inline-start" aria-hidden="true" />
          {copy.open}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.hint}</DialogDescription>
        </DialogHeader>
        {pairing.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{copy.failed}</AlertDescription>
          </Alert>
        ) : link && !expired ? (
          <div className="flex flex-col items-center gap-3">
            <img
              alt={copy.qr}
              data-testid="phone-pairing-qr"
              className="size-56 rounded-lg bg-white p-3"
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(
                renderSVG(link, { border: 0 }),
              )}`}
            />
            <p className="text-sm text-muted-foreground tabular-nums">
              {copy.until}{" "}
              {new Date(result!.expiresAt).toLocaleTimeString(language, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          </div>
        ) : expired ? (
          <p className="text-center text-sm text-muted-foreground">
            {copy.expired}
          </p>
        ) : (
          <Skeleton className="mx-auto size-56" />
        )}
        {(expired || pairing.isError) && (
          <Button
            variant="outline"
            className="self-center"
            onClick={() => mutate()}
          >
            <RefreshCw data-icon="inline-start" aria-hidden="true" />
            {copy.fresh}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

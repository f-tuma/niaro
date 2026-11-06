import { useRef, useState } from "react";
import { ChevronDown, Download, FileUp, KeyRound } from "lucide-react";
import {
  CONFIG_BUNDLE_MAX_BYTES,
  ConfigBundleImportResult,
  ConfigBundlePreview,
  parseConfigBundle,
  type ConfigBundle,
  type ConfigSectionResult,
} from "../../../packages/protocol/config-bundle";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import { Badge } from "@admin/components/ui/badge";
import { Spinner } from "@admin/components/ui/spinner";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@admin/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@admin/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@admin/components/ui/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@admin/components/ui/item";
import { PageHeader, Section } from "@admin/components/console/page";
import { Disclosure } from "@admin/components/console/disclosure";
import { StatusBadge } from "@admin/components/console/status";
import { api, ApiError } from "./lib/api";
import { useConsoleScope } from "./console-scope";
import { useConfigBundleCopy } from "./config-bundle-copy";

type Copy = ReturnType<typeof useConfigBundleCopy>;
type Loaded = {
  bundle: ConfigBundle;
  preview: ConfigBundlePreview;
  /** Set once the import went through. */
  imported?: boolean;
};

const exportHref = (organizationId: string, workspaceId?: string) =>
  `/admin/api/identity/config-bundle/export?${new URLSearchParams({
    organizationId,
    ...(workspaceId ? { workspaceId } : {}),
  })}`;

/**
 * Export and import of the organization's configuration without secrets.
 * An import is always checked first: the page shows what each section adds,
 * changes and leaves out, and applies it only after a confirmation.
 */
export function ConfigBundlePage() {
  const copy = useConfigBundleCopy();
  const scope = useConsoleScope();
  const upload = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; retry?: boolean } | null>(
    null,
  );
  const organizationId = scope.organization?.id;
  const workspaceId = scope.workspace?.id;
  const manager = scope.organization && scope.organization.role !== "member";

  const check = async (bundle: ConfigBundle) => {
    if (!organizationId) return;
    setBusy(true);
    setError(null);
    try {
      const preview = ConfigBundlePreview.parse(
        await api("identity/config-bundle/preview", {
          organizationId,
          ...(workspaceId ? { workspaceId } : {}),
          bundle,
        }),
      );
      setLoaded({ bundle, preview });
    } catch (failure) {
      setLoaded(null);
      setError({
        text:
          failure instanceof ApiError && failure.status === 400
            ? copy.notBundle
            : copy.previewFailed,
      });
    } finally {
      setBusy(false);
    }
  };
  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (upload.current) upload.current.value = "";
    if (!file) return;
    let bundle: ConfigBundle;
    try {
      if (file.size > CONFIG_BUNDLE_MAX_BYTES) throw Error();
      bundle = parseConfigBundle(await file.text());
    } catch {
      setLoaded(null);
      setError({ text: copy.notBundle });
      return;
    }
    await check(bundle);
  };
  const apply = async () => {
    if (!loaded || !organizationId) return;
    setBusy(true);
    setError(null);
    try {
      const result = ConfigBundleImportResult.parse(
        await api("identity/config-bundle/import", {
          organizationId,
          ...(workspaceId ? { workspaceId } : {}),
          bundle: loaded.bundle,
          revision: loaded.preview.revision,
        }),
      );
      setLoaded({ ...loaded, preview: result, imported: true });
      setConfirming(false);
    } catch (failure) {
      const stale = failure instanceof ApiError && failure.status === 409;
      setError({
        text: stale ? copy.conflict : copy.importFailed,
        retry: stale,
      });
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const picker = (
    <input
      ref={upload}
      type="file"
      hidden
      accept=".json,application/json"
      aria-label={copy.import}
      onChange={(event) => void pick(event.target.files)}
    />
  );
  const actions = manager && organizationId && (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={busy}>
            <Download data-icon="inline-start" aria-hidden="true" />
            {copy.export}
            <ChevronDown data-icon="inline-end" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <a href={exportHref(organizationId)} download>
              {copy.exportOrganization}
            </a>
          </DropdownMenuItem>
          {workspaceId && (
            <DropdownMenuItem asChild>
              <a href={exportHref(organizationId, workspaceId)} download>
                {copy.exportWorkspace}
              </a>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {loaded && !loaded.imported ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setLoaded(null);
              setError(null);
            }}
          >
            {copy.cancel}
          </Button>
          <Button
            size="sm"
            disabled={busy || !loaded.preview.changes}
            onClick={() => setConfirming(true)}
          >
            {copy.import}
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => upload.current?.click()}
        >
          <FileUp data-icon="inline-start" aria-hidden="true" />
          {copy.import}
        </Button>
      )}
    </>
  );

  return (
    <>
      <PageHeader
        title={copy.title}
        back={{ to: "/settings", label: copy.back }}
        actions={actions}
      />
      {picker}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.text}</AlertDescription>
          {error.retry && loaded && (
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void check(loaded.bundle)}
              >
                {copy.checkAgain}
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      {busy && !loaded && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />
          {copy.previewing}
        </p>
      )}
      {!loaded && !busy && manager && (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileUp aria-hidden="true" />
            </EmptyMedia>
            <EmptyDescription>{copy.empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {loaded && <Outcome loaded={loaded} copy={copy} />}
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!busy) setConfirming(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{copy.confirmBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                // Stays open until the import is applied.
                event.preventDefault();
                void apply();
              }}
            >
              {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
              {copy.import}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const sectionTitle = (copy: Copy, key: string) => copy.sections[key] ?? key;

function Outcome({ loaded, copy }: { loaded: Loaded; copy: Copy }) {
  const { preview, imported } = loaded;
  const needsKey = preview.sections.flatMap((s) =>
    s.needsKey.map((name) => ({ section: s.key, name })),
  );
  // Organization sections first, then each workspace, as the file has them.
  const groups = new Map<string | null, ConfigSectionResult[]>();
  for (const s of preview.sections)
    groups.set(s.workspace, [...(groups.get(s.workspace) ?? []), s]);
  return (
    <>
      {imported ? (
        <StatusBadge tone="success">{copy.imported}</StatusBadge>
      ) : (
        !preview.changes && (
          <p className="text-sm text-muted-foreground">{copy.nothingChanges}</p>
        )
      )}
      {needsKey.length > 0 && (
        <Section title={copy.needsKey} count={needsKey.length}>
          <Card variant="list">
            {needsKey.map((item) => (
              <Item
                key={`${item.section}:${item.name}`}
                variant="row"
                size="row"
              >
                <KeyRound
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
                <ItemContent>
                  <ItemTitle>{item.name}</ItemTitle>
                  <ItemDescription>
                    {sectionTitle(copy, item.section)}
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </Card>
        </Section>
      )}
      {[...groups].map(([workspace, sections]) => (
        <Section key={workspace ?? ""} title={workspace ?? copy.organization}>
          <Card variant="list">
            {sections.map((s) => (
              <SectionRow key={s.key} result={s} copy={copy} />
            ))}
          </Card>
        </Section>
      ))}
    </>
  );
}

function SectionRow({
  result,
  copy,
}: {
  result: ConfigSectionResult;
  copy: Copy;
}) {
  const lists = [
    ["added", result.added],
    ["changed", result.changed],
  ] as const;
  const details =
    result.added.length + result.changed.length + result.conflicts.length > 0;
  return (
    <Item variant="row" size="row" className="flex-wrap">
      <ItemContent>
        <ItemTitle>
          {sectionTitle(copy, result.key)}
          {result.conflicts.length > 0 && (
            <StatusBadge tone="warning">
              {copy.conflicts} {result.conflicts.length}
            </StatusBadge>
          )}
        </ItemTitle>
        <ItemDescription>
          <span className="flex flex-wrap gap-x-3 tabular-nums">
            {lists.map(
              ([key, names]) =>
                names.length > 0 && (
                  <span key={key}>
                    {copy[key]} {names.length}
                  </span>
                ),
            )}
            {result.unchanged.length > 0 && (
              <span>
                {copy.unchanged} {result.unchanged.length}
              </span>
            )}
          </span>
        </ItemDescription>
        {details && (
          <Disclosure title={copy.details}>
            <ul className="flex flex-col gap-1 text-sm">
              {lists.flatMap(([key, names]) =>
                names.map((name) => (
                  <li key={`${key}:${name}`} className="flex gap-2">
                    <Badge variant="outline">{copy[key]}</Badge>
                    <span className="min-w-0 break-words">{name}</span>
                  </li>
                )),
              )}
              {result.conflicts.map((conflict) => (
                <li
                  key={`conflict:${conflict.name}`}
                  className="flex flex-wrap gap-2"
                >
                  <Badge variant="outline">{copy.conflicts}</Badge>
                  <span className="min-w-0 break-words">{conflict.name}</span>
                  <span className="text-muted-foreground">
                    {copy.reasons[conflict.reason]}
                    {conflict.code && (
                      <code className="ml-1 font-mono text-xs">
                        {conflict.code}
                      </code>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </ItemContent>
    </Item>
  );
}

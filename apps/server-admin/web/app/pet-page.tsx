import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Link } from "@tanstack/react-router";
import {
  Bookmark,
  BriefcaseBusiness,
  Clock3,
  ExternalLink,
  History,
  MessageSquare,
  Moon,
  Palette,
  Pencil,
  Tags,
  Trash2,
  UserRound,
  UsersRound,
  Workflow,
  Wrench,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Switch } from "@admin/components/ui/switch";
import { Input } from "@admin/components/ui/input";
import { Textarea } from "@admin/components/ui/textarea";
import { Label } from "@admin/components/ui/label";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Toggle } from "@admin/components/ui/toggle";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@admin/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
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
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import { MoreActions } from "@admin/components/console/forms";
import { Disclosure } from "@admin/components/console/disclosure";
import { PageHeader } from "@admin/components/console/page";
import { SettingRow, SettingRows } from "@admin/components/console/setting-row";
import { PET_PALETTE } from "../../../shared/pet-appearance";
import {
  PetSettingsSchema,
  PetShapeSchema,
  type PetMemoryCommand,
  type PetSettings,
  type SavePetProfile,
} from "../../../../packages/protocol/work-pet";
import type { MemoryItem } from "../../../../packages/protocol/memory";
import {
  PetFallbackDrawing,
  type PetSvgPrimitives,
} from "../../../../packages/ui/pet-fallback-drawing";
import { useApp } from "./context";
import { MenuPage } from "./menu-page";
import { petCopy } from "./pet-copy";
import { profileAppearance, usePetMemory, usePetProfile } from "./pet-memory";
import { WebPetView } from "./pet-view";

const sections = [
  "work",
  "projects",
  "tools",
  "people",
  "style",
  "rhythm",
] as const;
type Section = (typeof sections)[number];
type View = "overview" | "saved" | Section;
const icons = [
  BriefcaseBusiness,
  Workflow,
  Wrench,
  UsersRound,
  MessageSquare,
  Clock3,
];
const isSection = (view: View): view is Section =>
  (sections as readonly string[]).includes(view);

/** The web layout folds to the one-column one under the `lg` breakpoint. */
const narrowQuery = "(max-width: 1023px)";
const canMatch = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function";
function subscribeNarrow(callback: () => void) {
  if (!canMatch()) return () => {};
  const media = window.matchMedia(narrowQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
const readNarrow = () => canMatch() && window.matchMedia(narrowQuery).matches;
const serverNarrow = () => false;

/** Whole days between a timestamp and today, in local time. */
function daysAgo(value: string, now = new Date()) {
  const then = new Date(value);
  const start = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.max(0, Math.round((start(now) - start(then)) / 86_400_000));
}

const svgPrimitives: PetSvgPrimitives = {
  Svg: "svg",
  Circle: "circle",
  ClipPath: "clipPath",
  Defs: "defs",
  Ellipse: "ellipse",
  G: "g",
  Path: "path",
  RadialGradient: "radialGradient",
  Stop: "stop",
};

export function PetPage({ manager = false }: { manager?: boolean }) {
  const { workspace, identity } = useApp();
  return (
    <PetPageOwner
      key={`${workspace.organizationId}:${workspace.workspaceId}:${identity.user?.id}`}
      manager={manager}
    />
  );
}

function PetPageOwner({ manager }: { manager: boolean }) {
  const { language } = useApp(),
    copy = petCopy(language);
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    readNarrow,
    serverNarrow,
  );
  const profile = usePetProfile();
  const [view, setView] = useState<View>(manager ? "saved" : "overview");
  const [personal, setPersonal] = useState<"work" | "personal">("work");
  const [history, setHistory] = useState(false);
  const [sheet, setSheet] = useState<"about" | "appearance">();
  const [draft, setDraft] = useState<PetSettings>();
  const [edit, setEdit] = useState<{ item: MemoryItem; content: string }>();
  const [confirm, setConfirm] = useState<PetMemoryCommand>();
  const [pending, setPending] = useState<PetMemoryCommand | SavePetProfile>();
  const [conflict, setConflict] = useState(false);
  const [issue, setIssue] = useState(false),
    [saving, setSaving] = useState(false),
    [status, setStatus] = useState("");
  const section = isSection(view) ? view : undefined;
  const memory = usePetMemory({
    origin: view === "saved" ? "explicit" : "observed",
    ...(view !== "saved" ? { personal, ...(section ? { section } : {}) } : {}),
    history,
    limit: 30,
  });
  const detail = useRef<HTMLHeadingElement>(null),
    opener = useRef<HTMLButtonElement | null>(null);
  // The overview pet is sized to its column: 300–480 px, measured from the
  // stage's width, so a wide window gets a bigger pet with no empty sides.
  const [stageSize, setStageSize] = useState(280);
  const stage = useCallback((node: HTMLDivElement | null) => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      setStageSize(Math.max(300, Math.min(480, Math.round(width * 0.8))));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // While the appearance sheet is open the page previews the draft live.
  const previewDraft = sheet === "appearance" ? draft : undefined;
  const preview = useMemo(
    () =>
      previewDraft && profile.data
        ? { ...profile.data, settings: previewDraft }
        : profile.data,
    [previewDraft, profile.data],
  );
  const look = useMemo(
    () => (preview ? profileAppearance(preview) : undefined),
    [preview],
  );
  useEffect(() => {
    if (view !== "overview" && !manager) detail.current?.focus();
  }, [view, manager]);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 2500);
    return () => clearTimeout(timer);
  }, [status]);

  async function mutate(command: PetMemoryCommand | SavePetProfile) {
    setSaving(true);
    setIssue(false);
    setConflict(false);
    setPending(command);
    try {
      if ("settings" in command) await profile.save(command);
      else {
        await memory.save(command);
        if (!alive.current) return;
        // Memory changes also alter the automatic silhouette and observed ink.
        await profile.refetch({ throwOnError: true });
      }
      if (!alive.current) return;
      setPending(undefined);
      if ("settings" in command) {
        setDraft(undefined);
        setSheet(undefined);
      }
      setEdit(undefined);
      setConfirm(undefined);
      setStatus(copy.savedStatus);
      if ("type" in command && command.type === "revise" && !manager)
        setView("saved");
      else await memory.read();
      requestAnimationFrame(() => detail.current?.focus());
    } catch (error) {
      if (alive.current) {
        setIssue(true);
        setConflict(
          (error as { status?: number }).status === 409 ||
            String(error).includes("conflict") ||
            String(error).includes("context_changed"),
        );
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  }
  const editable = !!memory.page?.enabled && !memory.page.optOut;
  const settings = draft ?? profile.data?.settings;
  const animate = preview?.settings.animate ?? true;
  const petState =
    memory.page && (!memory.page.enabled || memory.page.optOut)
      ? "resting"
      : "idle";
  const counts = useMemo(
    () =>
      sections.map(
        (value) =>
          profile.data?.look.find((item) => item.section === value)?.count ?? 0,
      ),
    [profile.data],
  );
  const total = counts.reduce((sum, count) => sum + count, 0);
  const statusLine = !profile.data
    ? profile.isError
      ? copy.statusError
      : copy.loading
    : memory.page && !memory.page.enabled
      ? copy.unavailable
      : memory.page?.optOut
        ? copy.statusAsleep
        : total === 0
          ? copy.statusEmpty
          : copy.statusKnows(total);
  const open = view !== "overview";
  const compact = manager || (open && narrow);
  const petSize = compact ? 56 : open ? 160 : narrow ? 220 : stageSize;

  function openSheet(kind: "about" | "appearance") {
    setDraft(profile.data?.settings);
    setSheet(kind);
  }
  function closeSheet() {
    setDraft(undefined);
    setSheet(undefined);
  }
  function toggleView(next: Exclude<View, "overview">) {
    setEdit(undefined);
    if (view === next) {
      setView("overview");
      requestAnimationFrame(() => opener.current?.focus());
    } else setView(next);
  }
  function rove(e: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const buttons = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    e.preventDefault();
    const next =
      e.key === "ArrowRight"
        ? (index + 1) % buttons.length
        : e.key === "ArrowLeft"
          ? (index + buttons.length - 1) % buttons.length
          : e.key === "Home"
            ? 0
            : buttons.length - 1;
    buttons[next]?.focus();
  }

  // An unconfirmed save asks in a dialog; nothing inline shifts the page.
  const recover = async () => {
    await profile.refetch();
    const fresh = await memory.read();
    if (conflict) {
      setPending(undefined);
      setIssue(false);
      if (edit) {
        const item = fresh?.items.find((item) => item.id === edit.item.id);
        if (item) setEdit({ ...edit, item });
      }
    }
  };
  const issueDialog = (
    <AlertDialog
      open={issue && !confirm}
      onOpenChange={(next) => {
        if (!next && !saving) setIssue(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.uncertain}</AlertDialogTitle>
          <AlertDialogDescription>{copy.conflict}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>{copy.cancel}</AlertDialogCancel>
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => void recover()}
          >
            {copy.refresh}
          </Button>
          {pending && (
            <Button disabled={saving} onClick={() => void mutate(pending)}>
              {copy.retry}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const memorySwitch = (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <Moon className="size-4" aria-hidden="true" />
      <Switch
        aria-label={copy.memory}
        checked={!!memory.page && !memory.page.optOut}
        disabled={saving || !memory.page || !memory.page.enabled}
        onCheckedChange={(checked) =>
          void mutate({
            type: "preference",
            optOut: !checked,
            requestId: crypto.randomUUID(),
          })
        }
      />
    </span>
  );
  const pet = profile.data ? (
    <WebPetView
      size={petSize}
      label={preview?.settings.name ?? profile.data.settings.name}
      appearance={look}
      animate={profile.data.settings.animate}
      state={petState}
    />
  ) : (
    <span aria-hidden="true" className="block opacity-60">
      <PetFallbackDrawing components={svgPrimitives} size={petSize} resting />
    </span>
  );
  const about = profile.data
    ? [profile.data.settings.jobTitle, profile.data.settings.department]
        .filter(Boolean)
        .join(" · ")
    : "";
  const retry = profile.isError && !profile.data && (
    <Button
      variant="outline"
      size="sm"
      className="data-[stage=true]:mt-2"
      data-stage={!compact}
      onClick={() => void profile.refetch()}
    >
      {copy.retry}
    </Button>
  );
  // The pet lives directly on the page: a strip when a section is open on a
  // narrow window or on the memory page, otherwise the stage.
  const screen = compact ? (
    <div className="flex items-center gap-3 border-b border-border pb-3 text-left">
      <span className="shrink-0">{pet}</span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base font-semibold">
          {preview?.settings.name}
        </span>
        <span className="truncate text-sm text-muted-foreground">
          {statusLine}
        </span>
      </div>
      {retry}
      {memorySwitch}
    </div>
  ) : (
    <div
      ref={open ? undefined : stage}
      data-open={open}
      className="relative flex flex-1 flex-col items-center justify-center gap-1 px-4 pt-6 pb-4 text-center data-[open=true]:flex-none data-[open=true]:pt-2"
    >
      {open && <span className="absolute top-0 right-0">{memorySwitch}</span>}
      {pet}
      <h2
        data-open={open}
        className="mt-3 max-w-full text-2xl font-semibold break-words data-[open=true]:mt-1 data-[open=true]:text-xl"
      >
        {preview?.settings.name}
      </h2>
      {about && !open && (
        <p className="text-md text-muted-foreground">{about}</p>
      )}
      <p className="text-md">{statusLine}</p>
      {retry}
    </div>
  );
  // A save shows in place: the sheet or dialog closes, the switch or the
  // edited memory shows its new state. No toast (toasts are only Copied and
  // Undo); a screen reader hears "Saved" from this hidden region.
  const live = (
    <div role="status" aria-live="polite" className="sr-only">
      {status}
    </div>
  );
  // The six section tiles fill their column; the keys row sits under them.
  const dock = open && !compact;
  const controls = !manager && (
    <div
      data-dock={dock}
      className="flex flex-1 flex-col justify-center gap-3 data-[dock=true]:flex-none"
    >
      {!dock && (
        <div className="mb-1 flex items-center justify-between gap-3 px-1">
          <span className="text-md text-muted-foreground">{copy.memory}</span>
          {memorySwitch}
        </div>
      )}
      <div
        role="toolbar"
        aria-label={copy.sections}
        data-dock={dock}
        className="grid grid-cols-2 gap-2.5 data-[dock=true]:gap-2"
        onKeyDown={rove}
      >
        {sections.map((value, i) => {
          const Icon = icons[i]!;
          const pressed = section === value;
          return (
            <button
              key={value}
              type="button"
              title={copy[value]}
              aria-label={`${copy[value]} · ${copy.countLabel(counts[i]!)}`}
              aria-pressed={pressed}
              disabled={!profile.data}
              tabIndex={(section ? pressed : i === 0) ? 0 : -1}
              onClick={(e) => {
                opener.current = e.currentTarget;
                toggleView(value);
              }}
              data-dock={dock}
              className="flex min-h-14 items-center gap-3 rounded-xl border border-transparent bg-secondary px-4 py-3 text-left text-foreground transition-colors duration-100 outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-primary data-[dock=true]:min-h-11 data-[dock=true]:px-3 data-[dock=true]:py-2"
            >
              <Icon className="size-5 shrink-0" aria-hidden="true" />
              <span
                aria-hidden="true"
                className="min-w-0 flex-1 truncate text-base font-medium data-[dock=true]:text-sm"
                data-dock={dock}
              >
                {copy[value]}
              </span>
              {counts[i]! > 0 && (
                <span
                  aria-hidden="true"
                  className="text-sm font-semibold text-muted-foreground tabular-nums"
                >
                  {counts[i]}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div
        className="grid grid-cols-2 gap-2.5 data-[dock=true]:gap-2"
        data-dock={dock}
      >
        <Toggle
          variant="outline"
          size="lg"
          className="w-full"
          pressed={view === "saved"}
          onPressedChange={() => toggleView("saved")}
          onClick={(e) => {
            opener.current = e.currentTarget;
          }}
        >
          <Bookmark data-icon="inline-start" aria-hidden="true" />
          {copy.saved}
        </Toggle>
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          disabled={!profile.data}
          onClick={() => openSheet("about")}
        >
          <UserRound data-icon="inline-start" aria-hidden="true" />
          {copy.about}
        </Button>
      </div>
      {live}
    </div>
  );

  // The status screen: the list of one section, or the saved items.
  const items = memory.page?.items ?? [];
  const lastSeen = items.reduce<string | undefined>((latest, item) => {
    const at = item.seenAt ?? item.createdAt;
    return !latest || at > latest ? at : latest;
  }, undefined);
  const listCount =
    section && personal === "work"
      ? counts[sections.indexOf(section)]!
      : items.length;
  const list = (
    <section
      key={`${view}:${personal}:${history}`}
      data-still={!animate}
      aria-labelledby="pet-detail-title"
      className="pet-fade flex min-w-0 flex-col gap-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="pet-detail-title"
            ref={detail}
            tabIndex={-1}
            className="text-xl font-semibold outline-none"
          >
            {section ? copy[section] : copy.saved}
          </h2>
          <p className="text-sm text-muted-foreground tabular-nums">
            {memory.page
              ? `${copy.countLabel(listCount)}${
                  lastSeen
                    ? ` · ${copy.lastSeen(copy.relative(daysAgo(lastSeen)))}`
                    : ""
                }`
              : copy.loading}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {section && (
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              aria-label={copy.observed}
              value={personal}
              onValueChange={(value) => {
                if (value === "work" || value === "personal")
                  setPersonal(value);
              }}
            >
              <ToggleGroupItem value="work">{copy.workScope}</ToggleGroupItem>
              <ToggleGroupItem value="personal">
                {copy.personal}
              </ToggleGroupItem>
            </ToggleGroup>
          )}
          <Toggle
            variant="outline"
            aria-label={copy.history}
            title={copy.history}
            pressed={history}
            onPressedChange={setHistory}
          >
            <History aria-hidden="true" />
          </Toggle>
        </div>
      </div>
      {memory.error ? (
        <Alert variant="destructive">
          <AlertDescription>{copy.statusError}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void memory.read()}
            >
              {copy.refresh}
            </Button>
          </AlertAction>
        </Alert>
      ) : !memory.page ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-5/6" />
          <Skeleton className="h-12 w-2/3" />
        </div>
      ) : (
        <>
          {items.length === 0 && !memory.busy && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {copy.empty}
            </p>
          )}
          <ul className="divide-y divide-border">
            {items.map((item) => {
              const sourceCount =
                item.source?.type === "observed"
                  ? item.source.sources.length
                  : 1;
              const trust =
                item.source?.type === "external_app"
                  ? `${copy.fromApp} ${item.source.name}`
                  : item.trust === "user_assertion"
                    ? copy.assertion
                    : item.trust === "verified_result"
                      ? copy.verified
                      : copy.inference;
              const meta = [
                trust +
                  (item.seenAt
                    ? ` · ${copy.lastSeen(copy.relative(daysAgo(item.seenAt)))}`
                    : ""),
                item.status === "superseded"
                  ? copy.earlier
                  : item.status !== "active"
                    ? copy.unused
                    : "",
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={item.id} className="flex items-start gap-2 py-3.5">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="text-base break-words whitespace-pre-wrap">
                      {item.content}
                    </p>
                    <p className="text-sm text-muted-foreground">{meta}</p>
                    {edit?.item.id === item.id && (
                      <form
                        className="mt-2 flex flex-col gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void mutate({
                            type: "revise",
                            id: item.id,
                            revision: edit.item.revision,
                            content: edit.content,
                            requestId: crypto.randomUUID(),
                          });
                        }}
                      >
                        <Textarea
                          aria-label={copy.edit}
                          value={edit.content}
                          maxLength={4000}
                          onChange={(e) =>
                            setEdit({ ...edit, content: e.target.value })
                          }
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setEdit(undefined)}
                          >
                            {copy.cancel}
                          </Button>
                          <Button
                            type="submit"
                            disabled={
                              saving ||
                              !!pending ||
                              !editable ||
                              !edit.content.trim()
                            }
                          >
                            {copy.save}
                          </Button>
                        </div>
                      </form>
                    )}
                    <Disclosure title={copy.sourcesCount(sourceCount)}>
                      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                        {item.source?.type === "observed" ? (
                          item.source.sources.map((source) => (
                            <p key={source.sourceId}>
                              {source.type === "chat"
                                ? copy.chatSource
                                : copy.meetingSource}{" "}
                              · {new Date(source.at).toLocaleString(language)} ·{" "}
                              {source.removed
                                ? copy.removed
                                : source.href && (
                                    <a
                                      href={source.href}
                                      className="inline-flex items-center gap-1 text-foreground underline underline-offset-3"
                                    >
                                      {copy.sources}
                                      <ExternalLink
                                        className="size-3.5"
                                        aria-hidden="true"
                                      />
                                    </a>
                                  )}
                            </p>
                          ))
                        ) : (
                          <p>
                            {item.source?.type === "verified_operation"
                              ? `${copy.verified} · ${item.source.serviceId}`
                              : item.source?.type === "external_app"
                                ? `${copy.fromApp} ${item.source.name}`
                                : copy.assertion}{" "}
                            ·{" "}
                            {new Date(item.createdAt).toLocaleString(language)}
                          </p>
                        )}
                      </div>
                    </Disclosure>
                  </div>
                  <MoreActions label={copy.more} size="sm">
                    {editable && item.status !== "superseded" && (
                      <DropdownMenuItem
                        onSelect={() =>
                          setEdit({ item, content: item.content ?? "" })
                        }
                      >
                        <Pencil aria-hidden="true" />
                        {item.origin === "observed" ? copy.correct : copy.edit}
                      </DropdownMenuItem>
                    )}
                    {editable && item.source?.type === "observed" && (
                      <DropdownMenuItem
                        onSelect={() =>
                          setConfirm({
                            type: "classify",
                            id: item.id,
                            revision: item.revision,
                            personal:
                              item.source?.type === "observed"
                                ? !item.source.personal
                                : false,
                            requestId: crypto.randomUUID(),
                          })
                        }
                      >
                        <Tags aria-hidden="true" />
                        {item.source.personal
                          ? copy.classifyWork
                          : copy.classify}
                      </DropdownMenuItem>
                    )}
                    {editable && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() =>
                        setConfirm({
                          type: "forget",
                          id: item.id,
                          revision: item.revision,
                          requestId: crypto.randomUUID(),
                        })
                      }
                    >
                      <Trash2 aria-hidden="true" />
                      {copy.remove}
                    </DropdownMenuItem>
                  </MoreActions>
                </li>
              );
            })}
          </ul>
          {memory.page.nextCursor && (
            <Button
              variant="outline"
              className="self-start"
              disabled={memory.busy}
              onClick={() => void memory.read(true)}
            >
              {copy.loadMore}
            </Button>
          )}
        </>
      )}
    </section>
  );

  const valid = !!settings && PetSettingsSchema.safeParse(settings).success;
  const sheetPanel = (
    <Sheet
      open={!!sheet}
      onOpenChange={(next) => {
        if (!next) closeSheet();
      }}
    >
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>
            {sheet === "about" ? copy.about : copy.appearance}
          </SheetTitle>
        </SheetHeader>
        {settings && (
          <form
            id="pet-sheet-form"
            className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (profile.data && valid)
                void mutate({
                  requestId: crypto.randomUUID(),
                  revision: profile.data.revision,
                  settings,
                });
            }}
          >
            {sheet === "about" ? (
              <>
                {(["jobTitle", "department"] as const).map((field) => (
                  <div key={field} className="flex flex-col gap-2">
                    <Label htmlFor={`pet-${field}`}>
                      {field === "jobTitle" ? copy.job : copy.department}
                    </Label>
                    <Input
                      id={`pet-${field}`}
                      value={settings[field]}
                      maxLength={120}
                      onChange={(e) =>
                        setDraft({ ...settings, [field]: e.target.value })
                      }
                    />
                  </div>
                ))}
                <Disclosure title={copy.neverLearns}>
                  <p className="text-sm text-muted-foreground">
                    {copy.neverLearnsList} {copy.neverLearnsHint}
                  </p>
                </Disclosure>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="pet-name">{copy.name}</Label>
                  <Input
                    id="pet-name"
                    value={settings.name}
                    maxLength={40}
                    onChange={(e) =>
                      setDraft({ ...settings, name: e.target.value })
                    }
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <span id="pet-colour" className="text-sm font-medium">
                    {copy.colour}
                  </span>
                  <div
                    role="radiogroup"
                    aria-labelledby="pet-colour"
                    className="flex flex-wrap gap-2"
                  >
                    {PET_PALETTE.map((colour) => (
                      <button
                        key={colour.hex}
                        type="button"
                        role="radio"
                        aria-checked={settings.colour === colour.hex}
                        aria-label={colour[language]}
                        title={colour[language]}
                        style={{ "--swatch": colour.hex } as CSSProperties}
                        className="pet-swatch size-9 rounded-full border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-checked:ring-2 aria-checked:ring-primary aria-checked:ring-offset-2 aria-checked:ring-offset-popover"
                        onClick={() =>
                          setDraft({ ...settings, colour: colour.hex })
                        }
                      />
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <span id="pet-shape" className="text-sm font-medium">
                    {copy.shape}
                  </span>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    aria-labelledby="pet-shape"
                    className="flex-wrap"
                    value={settings.shape}
                    onValueChange={(value) => {
                      if (value)
                        setDraft({
                          ...settings,
                          shape: value as PetSettings["shape"],
                        });
                    }}
                  >
                    <ToggleGroupItem value="auto">{copy.auto}</ToggleGroupItem>
                    {PetShapeSchema.options.map((shape, i) => (
                      <ToggleGroupItem value={shape} key={shape}>
                        {copy.shapes[i]}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
                <SettingRows>
                  {(["animate", "showInChat"] as const).map((field) => (
                    <SettingRow
                      key={field}
                      label={field === "animate" ? copy.animate : copy.chat}
                      htmlFor={`pet-${field}`}
                    >
                      <Switch
                        id={`pet-${field}`}
                        aria-label={
                          field === "animate" ? copy.animate : copy.chat
                        }
                        checked={settings[field]}
                        onCheckedChange={(checked) =>
                          setDraft({ ...settings, [field]: checked })
                        }
                      />
                    </SettingRow>
                  ))}
                </SettingRows>
              </>
            )}
          </form>
        )}
        <SheetFooter>
          <Button type="button" variant="ghost" onClick={closeSheet}>
            {copy.cancel}
          </Button>
          <Button
            type="submit"
            form="pet-sheet-form"
            disabled={saving || !draft || !valid}
          >
            {copy.save}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );

  const confirmTitle = confirm
    ? confirm.type === "forgetAll"
      ? copy.erase
      : confirm.type === "personalThings"
        ? confirm.value === "drop"
          ? copy.personalDrop
          : copy.personalKeep
        : confirm.type === "classify"
          ? confirm.personal
            ? copy.classify
            : copy.classifyWork
          : copy.remove
    : "";
  const confirmHint = confirm
    ? confirm.type === "forgetAll"
      ? copy.eraseHint
      : confirm.type === "personalThings"
        ? confirm.value === "drop"
          ? copy.dropHint
          : ""
        : confirm.type === "classify"
          ? confirm.personal && memory.page?.personalThings === "drop"
            ? copy.dropHint
            : ""
          : copy.removeHint
    : "";
  const destructive =
    !!confirm &&
    (confirm.type === "forget" ||
      confirm.type === "forgetAll" ||
      (confirm.type === "personalThings" && confirm.value === "drop") ||
      (confirm.type === "classify" &&
        confirm.personal &&
        memory.page?.personalThings === "drop"));
  const confirmDialog = (
    <AlertDialog
      open={!!confirm}
      onOpenChange={(next) => {
        if (!next && !saving) setConfirm(undefined);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
          {confirmHint && (
            <AlertDialogDescription>{confirmHint}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {issue && (
          <Alert variant="destructive">
            <AlertDescription>{copy.uncertain}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>{copy.cancel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={saving}
            onClick={(e) => {
              e.preventDefault();
              if (confirm) void mutate(confirm);
            }}
          >
            {confirm?.type === "forget" || confirm?.type === "forgetAll"
              ? copy.remove
              : copy.save}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (manager)
    return (
      <MenuPage>
        <PageHeader
          title={copy.manager}
          back={{ to: "/pet", label: copy.title }}
        />
        <div data-still={!animate} className="pet-page flex flex-col gap-8">
          <div className="flex flex-col gap-3">
            {screen}
            {live}
          </div>
          {list}
          <SettingRows>
            <SettingRow label={copy.personalKeep} htmlFor="pet-personal">
              <Switch
                id="pet-personal"
                aria-label={copy.personalKeep}
                checked={memory.page?.personalThings !== "drop"}
                disabled={saving || !memory.page}
                onCheckedChange={(checked) =>
                  setConfirm({
                    type: "personalThings",
                    value: checked ? "keep" : "drop",
                    requestId: crypto.randomUUID(),
                  })
                }
              />
            </SettingRow>
          </SettingRows>
          <SettingRows>
            <SettingRow label={copy.erase}>
              <Button
                variant="destructive"
                size="sm"
                disabled={saving || !memory.page}
                onClick={() =>
                  setConfirm({
                    type: "forgetAll",
                    requestId: crypto.randomUUID(),
                  })
                }
              >
                <Trash2 data-icon="inline-start" aria-hidden="true" />
                {copy.remove}
              </Button>
            </SettingRow>
          </SettingRows>
        </div>
        {confirmDialog}
      </MenuPage>
    );

  return (
    <MenuPage wide fill>
      <PageHeader
        title={copy.title}
        actions={
          <>
            <Button
              variant="outline"
              disabled={!profile.data}
              onClick={() => openSheet("appearance")}
            >
              <Palette data-icon="inline-start" aria-hidden="true" />
              {copy.appearance}
            </Button>
            <MoreActions label={copy.more}>
              <DropdownMenuItem asChild>
                <Link to="/me/memory">{copy.manager}</Link>
              </DropdownMenuItem>
            </MoreActions>
          </>
        }
      />
      <div
        data-open={open}
        data-still={!animate}
        className="pet-page pet-layout"
      >
        {open ? (
          <div
            data-compact={compact}
            className="flex flex-col gap-4 data-[compact=false]:lg:sticky data-[compact=false]:lg:top-4"
          >
            {screen}
            {controls}
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-4">{screen}</div>
            {controls}
          </>
        )}
        {open && list}
      </div>
      {sheetPanel}
      {confirmDialog}
      {issueDialog}
    </MenuPage>
  );
}

export function PetMemoryPage() {
  return <PetPage manager />;
}

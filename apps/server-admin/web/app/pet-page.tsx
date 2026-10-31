import { Switch } from "@admin/components/ui/switch";
import { NativeSelect } from "@admin/components/ui/native-select";
import { MoreActions } from "@admin/components/console/forms";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
import { PET_PALETTE } from "../../../shared/pet-appearance";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  BriefcaseBusiness,
  Workflow,
  Wrench,
  UsersRound,
  MessageSquare,
  Clock3,
  ChevronRight,
} from "lucide-react";
import {
  PetSettingsSchema,
  PetShapeSchema,
  type PetMemoryCommand,
  type PetSettings,
  type SavePetProfile,
} from "../../../../packages/protocol/work-pet";
import type { MemoryItem } from "../../../../packages/protocol/memory";
import { useApp } from "./context";
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
const icons = [
  BriefcaseBusiness,
  Workflow,
  Wrench,
  UsersRound,
  MessageSquare,
  Clock3,
];
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
  const profile = usePetProfile();
  const [tab, setTab] = useState<"observed" | "saved" | "about">(
    manager ? "saved" : "observed",
  );
  const [section, setSection] = useState<(typeof sections)[number]>();
  const [personal, setPersonal] = useState<"work" | "personal">("work");
  const [history, setHistory] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const [draft, setDraft] = useState<PetSettings>();
  const [edit, setEdit] = useState<{ item: MemoryItem; content: string }>();
  const [confirm, setConfirm] = useState<PetMemoryCommand>();
  const [pending, setPending] = useState<PetMemoryCommand | SavePetProfile>();
  const [conflict, setConflict] = useState(false);
  const [issue, setIssue] = useState(false),
    [saving, setSaving] = useState(false),
    [status, setStatus] = useState("");
  const memory = usePetMemory({
    origin: tab === "observed" ? "observed" : "explicit",
    ...(tab === "observed"
      ? { personal, ...(section ? { section } : {}) }
      : {}),
    history,
    limit: 30,
  });
  const dialog = useRef<HTMLDialogElement>(null),
    detail = useRef<HTMLHeadingElement>(null),
    opener = useRef<HTMLButtonElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const look = useMemo(
    () => (profile.data ? profileAppearance(profile.data) : undefined),
    [profile.data],
  );
  useEffect(() => {
    if (confirm) dialog.current?.showModal();
  }, [confirm]);
  useEffect(() => {
    if (section) detail.current?.focus();
  }, [section]);
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
        setAppearance(false);
      }
      setEdit(undefined);
      dialog.current?.close();
      setConfirm(undefined);
      setStatus(copy.savedStatus);
      if ("type" in command && command.type === "revise") {
        setTab("saved");
        setSection(undefined);
      } else await memory.read();
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
  const editable = memory.page?.enabled && !memory.page.optOut;
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 2500);
    return () => clearTimeout(timer);
  }, [status]);
  const settings = draft ?? profile.data?.settings;
  return (
    <div className="pet-page">
      <header className="pet-heading">
        <h1>{manager ? copy.manager : copy.title}</h1>
        <div className="pet-actions">
          <button
            onClick={() => {
              setAppearance(true);
              setDraft(profile.data?.settings);
            }}
            disabled={!profile.data}
          >
            {copy.appearance}
          </button>
          <MoreActions label={copy.manager}>
            <DropdownMenuItem
              disabled={!memory.page}
              onSelect={() =>
                setConfirm({
                  type: "forgetAll",
                  requestId: crypto.randomUUID(),
                })
              }
            >
              {copy.erase}
            </DropdownMenuItem>
          </MoreActions>
        </div>
      </header>
      <div className="pet-toolbar">
        <div className="pet-tabs" role="tablist" aria-label={copy.title}>
          {(["observed", "saved", "about"] as const).map((value) => (
            <button
              key={value}
              role="tab"
              disabled={saving}
              tabIndex={tab === value ? 0 : -1}
              onKeyDown={(e) => {
                const tabs = ["observed", "saved", "about"] as const;
                const i = tabs.indexOf(value);
                const next =
                  e.key === "ArrowRight"
                    ? tabs[(i + 1) % 3]
                    : e.key === "ArrowLeft"
                      ? tabs[(i + 2) % 3]
                      : e.key === "Home"
                        ? tabs[0]
                        : e.key === "End"
                          ? tabs[2]
                          : undefined;
                if (next) {
                  e.preventDefault();
                  setTab(next);
                  setSection(undefined);
                  (
                    e.currentTarget.parentElement?.querySelectorAll("button")[
                      tabs.indexOf(next)
                    ] as HTMLButtonElement
                  )?.focus();
                }
              }}
              aria-selected={tab === value}
              onClick={() => {
                setTab(value);
                setSection(undefined);
                setAppearance(false);
              }}
            >
              {copy[value]}
            </button>
          ))}
        </div>
        <div className="pet-actions">
          {tab === "observed" && (
            <NativeSelect
              aria-label={copy.observed}
              value={personal}
              onChange={(e) =>
                setPersonal(e.target.value as "work" | "personal")
              }
            >
              <option value="work">{copy.workScope}</option>
              <option value="personal">{copy.personal}</option>
            </NativeSelect>
          )}
          {memory.page && (
            <label className="pet-memory-toggle">
              <Switch
                aria-label={copy.memory}
                checked={!memory.page.optOut}
                disabled={saving || !memory.page.enabled}
                onCheckedChange={(checked) =>
                  void mutate({
                    type: "preference",
                    optOut: !checked,
                    requestId: crypto.randomUUID(),
                  })
                }
              />
              <span>{copy.memory}</span>
            </label>
          )}
        </div>
      </div>
      <div role="status" aria-live="polite">
        {status}
      </div>
      {issue && !confirm && (
        <div role="alert">
          <p>
            {copy.uncertain} {copy.conflict}
          </p>
          <button
            disabled={saving}
            onClick={async () => {
              await profile.refetch();
              const fresh = await memory.read();
              if (conflict) {
                setPending(undefined);
                setIssue(false);
                if (edit) {
                  const item = fresh?.items.find(
                    (item) => item.id === edit.item.id,
                  );
                  if (item) setEdit({ ...edit, item });
                }
              }
            }}
          >
            {copy.refresh}
          </button>
          {pending && (
            <button disabled={saving} onClick={() => void mutate(pending)}>
              {copy.retry}
            </button>
          )}
        </div>
      )}
      {profile.isError && (
        <p role="alert">
          {copy.failed}{" "}
          <button onClick={() => void profile.refetch()}>{copy.retry}</button>
        </p>
      )}
      {appearance || tab === "about" ? (
        settings && (
          <form
            className="pet-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (profile.data && PetSettingsSchema.safeParse(settings).success)
                void mutate({
                  requestId: crypto.randomUUID(),
                  revision: profile.data.revision,
                  settings,
                });
            }}
          >
            {!appearance && profile.data && (
              <div className="pet-center">
                <WebPetView
                  size={140}
                  label={profile.data.settings.name}
                  appearance={look}
                  animate={profile.data.settings.animate}
                />
                <h2>{profile.data.settings.name}</h2>
              </div>
            )}
            {(appearance
              ? (["name"] as const)
              : (["jobTitle", "department"] as const)
            ).map((field) => (
              <label key={field}>
                {field === "jobTitle"
                  ? copy.job
                  : field === "department"
                    ? copy.department
                    : copy[field]}
                <input
                  type="text"
                  value={settings[field]}
                  maxLength={field === "name" ? 40 : 120}
                  onChange={(e) =>
                    setDraft({ ...settings, [field]: e.target.value })
                  }
                />
              </label>
            ))}
            {appearance && (
              <>
                <label>
                  {copy.colour}
                  <NativeSelect
                    value={settings.colour}
                    onChange={(e) =>
                      setDraft({
                        ...settings,
                        colour: e.target.value as PetSettings["colour"],
                      })
                    }
                  >
                    {PET_PALETTE.map((colour) => (
                      <option key={colour.hex} value={colour.hex}>
                        {colour[language]}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label>
                  {copy.shape}
                  <NativeSelect
                    value={settings.shape}
                    onChange={(e) =>
                      setDraft({
                        ...settings,
                        shape: e.target.value as PetSettings["shape"],
                      })
                    }
                  >
                    <option value="auto">{copy.auto}</option>
                    {PetShapeSchema.options.map((shape, i) => (
                      <option value={shape} key={shape}>
                        {copy.shapes[i]}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                {(["animate", "showInChat"] as const).map((field) => (
                  <label key={field}>
                    <span>
                      <Switch
                        aria-label={
                          field === "animate" ? copy.animate : copy.chat
                        }
                        checked={settings[field]}
                        onCheckedChange={(checked) =>
                          setDraft({ ...settings, [field]: checked })
                        }
                      />{" "}
                      {field === "animate" ? copy.animate : copy.chat}
                    </span>
                  </label>
                ))}
              </>
            )}
            <div className="pet-actions">
              <button
                type="button"
                onClick={() => {
                  setDraft(undefined);
                  setAppearance(false);
                }}
              >
                {copy.cancel}
              </button>
              <button
                disabled={
                  saving ||
                  !draft ||
                  !PetSettingsSchema.safeParse(settings).success
                }
              >
                {copy.save}
              </button>
            </div>
          </form>
        )
      ) : (
        <>
          {!manager && (
            <div
              className={`pet-stage${section || tab !== "observed" ? " is-open" : ""}`}
            >
              <div className="pet-center">
                {profile.data ? (
                  <WebPetView
                    size={section || tab !== "observed" ? 140 : 320}
                    label={profile.data.settings.name}
                    appearance={look}
                    animate={profile.data.settings.animate}
                    state={
                      memory.page &&
                      (!memory.page.enabled || memory.page.optOut)
                        ? "resting"
                        : "idle"
                    }
                  />
                ) : (
                  <p>{profile.isPending ? copy.loading : copy.unavailable}</p>
                )}
                <h2>{profile.data?.settings.name}</h2>
              </div>
              {tab === "observed" &&
                sections.map((value, i) => {
                  const Icon = icons[i]!;
                  return (
                    <button
                      className="pet-section"
                      key={value}
                      aria-pressed={section === value}
                      onClick={(e) => {
                        opener.current = e.currentTarget;
                        setSection(value);
                      }}
                    >
                      <Icon size={18} aria-hidden />
                      <span>{copy[value]}</span>
                      <ChevronRight size={14} aria-hidden />
                    </button>
                  );
                })}
            </div>
          )}
          {(section || tab === "saved" || manager) && (
            <section className="pet-details">
              <div className="pet-actions">
                {section && (
                  <button
                    onClick={() => {
                      setSection(undefined);
                      requestAnimationFrame(() => opener.current?.focus());
                    }}
                  >
                    {copy.all}
                  </button>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={history}
                    onChange={(e) => setHistory(e.target.checked)}
                  />{" "}
                  {copy.history}
                </label>
              </div>
              <h2 tabIndex={-1} ref={detail}>
                {section ? copy[section] : copy.saved}
              </h2>
              {memory.error ? (
                <p role="alert">
                  {copy.failed}{" "}
                  <button onClick={() => void memory.read()}>
                    {copy.refresh}
                  </button>
                </p>
              ) : !memory.page ? (
                <p>{copy.loading}</p>
              ) : (
                <>
                  {!memory.page.enabled && <p>{copy.unavailable}</p>}
                  {memory.page.items.length === 0 && !memory.busy && (
                    <p>{copy.empty}</p>
                  )}
                  {memory.page.items.map((item) => (
                    <article className="pet-memory-row" key={item.id}>
                      <p>{item.content}</p>
                      <p className="pet-meta">
                        {item.trust === "user_assertion"
                          ? copy.assertion
                          : item.trust === "verified_result"
                            ? copy.verified
                            : copy.inference}
                        {item.status !== "active"
                          ? ` · ${item.status === "superseded" ? copy.earlier : copy.unused}`
                          : ""}
                      </p>
                      {edit?.item.id === item.id ? (
                        <form
                          className="pet-form"
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
                          <textarea
                            aria-label={copy.edit}
                            value={edit.content}
                            onChange={(e) =>
                              setEdit({ ...edit, content: e.target.value })
                            }
                            maxLength={4000}
                          />
                          <div className="pet-actions">
                            <button
                              type="button"
                              onClick={() => setEdit(undefined)}
                            >
                              {copy.cancel}
                            </button>
                            <button
                              disabled={
                                saving ||
                                !!pending ||
                                !editable ||
                                !edit.content.trim()
                              }
                            >
                              {copy.save}
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="pet-actions">
                          {editable && item.status !== "superseded" && (
                            <button
                              onClick={() =>
                                setEdit({ item, content: item.content ?? "" })
                              }
                            >
                              {item.origin === "observed"
                                ? copy.correct
                                : copy.edit}
                            </button>
                          )}
                          <button
                            onClick={() =>
                              setConfirm({
                                type: "forget",
                                id: item.id,
                                revision: item.revision,
                                requestId: crypto.randomUUID(),
                              })
                            }
                          >
                            {copy.remove}
                          </button>
                          {editable && item.source?.type === "observed" && (
                            <button
                              onClick={() =>
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
                              {item.source.personal
                                ? copy.classifyWork
                                : copy.classify}
                            </button>
                          )}
                        </div>
                      )}
                      <details>
                        <summary>{copy.sources}</summary>
                        {item.source?.type === "observed" ? (
                          item.source.sources.map((source) => (
                            <p className="pet-meta" key={source.sourceId}>
                              {source.type === "chat"
                                ? copy.chatSource
                                : copy.meetingSource}{" "}
                              · {new Date(source.at).toLocaleString(language)} ·{" "}
                              {source.removed
                                ? copy.removed
                                : source.href && (
                                    <a href={source.href}>{copy.sources}</a>
                                  )}
                            </p>
                          ))
                        ) : (
                          <p className="pet-meta">
                            {item.source?.type === "verified_operation"
                              ? `${copy.verified} · ${item.source.serviceId}`
                              : copy.assertion}{" "}
                            ·{" "}
                            {new Date(item.createdAt).toLocaleString(language)}
                          </p>
                        )}
                      </details>
                    </article>
                  ))}
                  {memory.page.nextCursor && (
                    <button
                      disabled={memory.busy}
                      onClick={() => void memory.read(true)}
                    >
                      {copy.loadMore}
                    </button>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
      <footer className="pet-details pet-actions">
        {!manager && <Link to="/me/memory">{copy.manager}</Link>}
        {memory.page && appearance && (
          <button
            disabled={saving}
            onClick={() =>
              setConfirm({
                type: "personalThings",
                value: memory.page!.personalThings === "keep" ? "drop" : "keep",
                requestId: crypto.randomUUID(),
              })
            }
          >
            {memory.page.personalThings === "keep"
              ? copy.personalDrop
              : copy.personalKeep}
          </button>
        )}
      </footer>
      <dialog
        ref={dialog}
        onCancel={() => setConfirm(undefined)}
        onClose={() => setConfirm(undefined)}
      >
        {confirm && (
          <>
            {issue && <p role="alert">{copy.uncertain}</p>}
            <p>
              {confirm.type === "forgetAll"
                ? copy.eraseHint
                : confirm.type === "personalThings"
                  ? confirm.value === "drop"
                    ? copy.dropHint
                    : copy.personalKeep
                  : confirm.type === "classify"
                    ? confirm.personal
                      ? memory.page?.personalThings === "drop"
                        ? copy.dropHint
                        : copy.classify
                      : copy.classifyWork
                    : copy.removeHint}
            </p>
            <div className="pet-actions">
              <button
                disabled={saving}
                onClick={() => {
                  dialog.current?.close();
                  setConfirm(undefined);
                }}
              >
                {copy.cancel}
              </button>
              <button disabled={saving} onClick={() => void mutate(confirm)}>
                {confirm.type === "forget" || confirm.type === "forgetAll"
                  ? copy.remove
                  : copy.save}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
export function PetMemoryPage() {
  return <PetPage manager />;
}

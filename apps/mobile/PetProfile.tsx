import { PET_PALETTE } from "../shared/pet-appearance";
import React, {
  useCallback,
  useEffectEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AccessibilityInfo,
  findNodeHandle,
  Alert,
  Pressable,
  StyleSheet,
  Switch,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { randomUUID } from "expo-crypto";
import type { ClientSession } from "../../packages/client-core/session";
import type { Language } from "../../packages/protocol";
import {
  PetSettingsSchema,
  PetShapeSchema,
  type PetMemoryCommand,
  type PetMemoryPage,
  type PetProfile as Profile,
  type PetSettings,
  type SavePetProfile,
} from "../../packages/protocol/work-pet";
import type { MemoryItem } from "../../packages/protocol/memory";
import { Button, Field, Text } from "../../packages/ui";
import type { HomePetBounds } from "./home-pet-visibility";
import { PetView } from "../../packages/ui/PetView";
import { tokens as t } from "../../packages/design-tokens";
import { petCopy } from "./pet-profile-copy";
import { nativePetAppearance } from "./pet-profile-model";
const sections = [
  "work",
  "projects",
  "tools",
  "people",
  "style",
  "rhythm",
] as const;
export function PetProfile({
  session,
  language,
  profile,
  onSave,
  onRefresh,
  appearance,
  onAppearance,
  onOpenSource,
  profileError = false,
  petVisible = true,
  onPetBounds,
}: {
  session: ClientSession;
  language: Language;
  profile: Profile | undefined | null;
  onSave: (command: SavePetProfile) => Promise<Profile>;
  onRefresh: () => Promise<void>;
  appearance: boolean;
  onAppearance: (open: boolean) => void;
  onOpenSource: (href: string) => void;
  profileError?: boolean;
  petVisible?: boolean;
  onPetBounds?: (bounds: HomePetBounds | null) => void;
}) {
  const { width, fontScale } = useWindowDimensions();
  const petSize = Math.min(250, width - 40) / Math.max(1, fontScale);
  const c = petCopy(language),
    [tab, setTab] = useState<"observed" | "saved" | "about">("observed");
  const [section, setSection] = useState<(typeof sections)[number]>(),
    [personal, setPersonal] = useState<"work" | "personal">("work"),
    [history, setHistory] = useState(false);
  const [page, setPage] = useState<PetMemoryPage | null>(),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  const [draft, setDraft] = useState<PetSettings>(),
    [edit, setEdit] = useState<{ item: MemoryItem; content: string }>(),
    [pending, setPending] = useState<PetMemoryCommand | SavePetProfile>();
  const [issue, setIssue] = useState(false);
  const [conflict, setConflict] = useState(false);
  const generation = useRef(0),
    alive = useRef(true),
    opener = useRef<View | null>(null),
    heading = useRef<View | null>(null);
  const profileY = useRef(0),
    petBounds = useRef<{ y: number; height: number } | null>(null);
  const publishBounds = useCallback(() => {
    if (petBounds.current)
      onPetBounds?.({
        top: profileY.current + petBounds.current.y,
        height: petBounds.current.height,
      });
  }, [onPetBounds]);
  useEffect(() => {
    if (appearance || tab === "about") onPetBounds?.(null);
    else publishBounds();
    return () => onPetBounds?.(null);
  }, [appearance, tab, onPetBounds, publishBounds]);
  useEffect(() => {
    if (!section) return;
    const frame = requestAnimationFrame(() => {
      const target = findNodeHandle(heading.current);
      if (target != null) AccessibilityInfo.setAccessibilityFocus(target);
    });
    return () => cancelAnimationFrame(frame);
  }, [section]);
  const query = useMemo(
    () => ({
      origin:
        tab === "observed" ? ("observed" as const) : ("explicit" as const),
      ...(tab === "observed"
        ? { personal, ...(section ? { section } : {}) }
        : {}),
      history,
      limit: 30,
    }),
    [tab, personal, section, history],
  );
  const look = useMemo(
    () => (profile ? nativePetAppearance(profile) : undefined),
    [profile],
  );
  async function read(more = false) {
    const ticket = ++generation.current;
    setBusy(true);
    setError(false);
    try {
      const next = await session.petMemory({
        ...query,
        ...(more && page?.nextCursor ? { cursor: page.nextCursor } : {}),
      });
      if (!alive.current || ticket !== generation.current) return;
      if (more && page && next && page.version !== next.version)
        throw Error("memory_context_changed");
      setPage(
        more && page && next
          ? { ...next, items: [...page.items, ...next.items] }
          : next,
      );
      return next;
    } catch {
      if (alive.current && ticket === generation.current) setError(true);
    } finally {
      if (alive.current && ticket === generation.current) setBusy(false);
    }
  }
  const readSelection = useEffectEvent(read);
  useEffect(() => {
    const tickets = generation;
    alive.current = true;
    return () => {
      alive.current = false;
      tickets.current++;
    };
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A changed server query must hide the previous private slice before reading.
    setPage(undefined);
    void readSelection();
  }, [query, session]);
  async function mutate(command: PetMemoryCommand | SavePetProfile) {
    setBusy(true);
    setPending(command);
    setIssue(false);
    setConflict(false);
    try {
      if ("settings" in command) await onSave(command);
      else {
        const next = await session.savePetMemory(command);
        if (!next) throw Error("unsupported");
      }
      if (!alive.current) return;
      setPending(undefined);
      setEdit(undefined);
      setDraft(undefined);
      onAppearance(false);
      setStatus(c.savedStatus);
      AccessibilityInfo.announceForAccessibility(c.savedStatus);
      if ("type" in command && command.type === "revise") {
        setTab("saved");
        setSection(undefined);
      } else await read();
      if ("type" in command) void onRefresh();
    } catch (error) {
      if (alive.current) {
        setIssue(true);
        setConflict(
          String(error).includes("conflict") ||
            String(error).includes("context_changed"),
        );
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const confirm = (command: PetMemoryCommand, hint: string) =>
    Alert.alert(hint, undefined, [
      { text: c.cancel, style: "cancel" },
      {
        text:
          command.type === "forget" || command.type === "forgetAll"
            ? c.remove
            : c.save,
        style: "destructive",
        onPress: () => void mutate(command),
      },
    ]);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 2500);
    return () => clearTimeout(timer);
  }, [status]);
  const settings = draft ?? profile?.settings,
    editable = page?.enabled && !page.optOut;
  const control = (label: string, selected: boolean, action: () => void) => (
    <Pressable
      key={label}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      disabled={busy}
      onPress={action}
      style={[styles.control, selected && styles.selected]}
    >
      <Text>{label}</Text>
    </Pressable>
  );
  return (
    <View
      style={styles.root}
      testID="pet-profile"
      onLayout={(event) => {
        profileY.current = event.nativeEvent.layout.y;
        publishBounds();
      }}
    >
      <View style={styles.row}>
        {(["observed", "saved", "about"] as const).map((value) =>
          control(c[value], tab === value, () => {
            setTab(value);
            setSection(undefined);
            onAppearance(false);
          }),
        )}
      </View>
      <View style={styles.row}>
        {tab === "observed" && (
          <>
            {control(c.workScope, personal === "work", () =>
              setPersonal("work"),
            )}
            {control(c.personal, personal === "personal", () =>
              setPersonal("personal"),
            )}
          </>
        )}
        {page && (
          <View style={styles.row}>
            <Text>{c.memory}</Text>
            <Switch
              accessibilityLabel={c.memory}
              value={!page.optOut}
              disabled={busy || !page.enabled}
              onValueChange={(value) =>
                void mutate({
                  type: "preference",
                  optOut: !value,
                  requestId: randomUUID(),
                })
              }
            />
          </View>
        )}
      </View>
      {!!status && <Text accessibilityLiveRegion="polite">{status}</Text>}
      {issue && (
        <View>
          <Text>
            {c.uncertain} {c.conflict}
          </Text>
          <Button
            label={c.refresh}
            onPress={async () => {
              await onRefresh();
              const fresh = await read();
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
          />
          {pending && (
            <Button
              label={c.retry}
              disabled={busy}
              onPress={() => void mutate(pending)}
            />
          )}
        </View>
      )}
      {appearance || tab === "about" ? (
        settings && (
          <View style={styles.form}>
            {(appearance
              ? (["name"] as const)
              : (["jobTitle", "department"] as const)
            ).map((field) => (
              <Field
                key={field}
                label={
                  field === "jobTitle"
                    ? c.job
                    : field === "department"
                      ? c.department
                      : c[field]
                }
                value={settings[field]}
                maxLength={field === "name" ? 40 : 120}
                onChangeText={(value) =>
                  setDraft({ ...settings, [field]: value })
                }
              />
            ))}
            {appearance && (
              <>
                <Text>{c.colour}</Text>
                <View style={styles.grid}>
                  {PET_PALETTE.map((colour) =>
                    control(
                      colour[language],
                      settings.colour === colour.hex,
                      () => setDraft({ ...settings, colour: colour.hex }),
                    ),
                  )}
                </View>
                <Text>{c.shape}</Text>
                <View style={styles.grid}>
                  {control(c.auto, settings.shape === "auto", () =>
                    setDraft({ ...settings, shape: "auto" }),
                  )}
                  {PetShapeSchema.options.map((shape, i) =>
                    control(c.shapes[i]!, settings.shape === shape, () =>
                      setDraft({ ...settings, shape }),
                    ),
                  )}
                </View>
                {(["animate", "showInChat"] as const).map((field) => (
                  <View key={field} style={styles.row}>
                    <Text>{field === "animate" ? c.animate : c.chat}</Text>
                    <Switch
                      accessibilityLabel={
                        field === "animate" ? c.animate : c.chat
                      }
                      value={settings[field]}
                      onValueChange={(value) =>
                        setDraft({ ...settings, [field]: value })
                      }
                    />
                  </View>
                ))}
              </>
            )}
            <View style={styles.row}>
              <Button
                label={c.cancel}
                variant="quiet"
                onPress={() => {
                  setDraft(undefined);
                  onAppearance(false);
                }}
              />
              <Button
                label={c.save}
                disabled={
                  busy ||
                  !draft ||
                  !PetSettingsSchema.safeParse(settings).success
                }
                onPress={() => {
                  if (profile)
                    void mutate({
                      requestId: randomUUID(),
                      revision: profile.revision,
                      settings,
                    });
                }}
              />
            </View>
          </View>
        )
      ) : (
        <>
          <View
            style={styles.center}
            testID="profile-pet-bounds"
            onLayout={(event) => {
              petBounds.current = event.nativeEvent.layout;
              publishBounds();
            }}
          >
            {profile ? (
              <>
                <PetView
                  visible={petVisible}
                  size={
                    section || tab !== "observed"
                      ? Math.min(136, petSize)
                      : petSize
                  }
                  label={profile.settings.name}
                  appearance={look}
                  animate={profile.settings.animate}
                  interactive
                  state={
                    page && (!page.enabled || page.optOut) ? "resting" : "idle"
                  }
                />
                <Text role="title">{profile.settings.name}</Text>
              </>
            ) : (
              <View>
                <Text>
                  {profileError
                    ? c.failed
                    : profile === null
                      ? c.unavailable
                      : c.loading}
                </Text>
                {(profileError || profile === null) && (
                  <Button label={c.retry} onPress={() => void onRefresh()} />
                )}
              </View>
            )}
          </View>
          {tab === "observed" && (
            <View style={styles.grid}>
              {sections.map((value) => (
                <Pressable
                  ref={section === value ? opener : undefined}
                  key={value}
                  accessibilityRole="button"
                  accessibilityLabel={c[value]}
                  accessibilityState={{ selected: section === value }}
                  onPress={() => setSection(value)}
                  style={[
                    styles.section,
                    fontScale >= 1.5 && { width: "100%" },
                    section === value && styles.selected,
                  ]}
                >
                  <Text style={{ flex: 1, flexShrink: 1 }}>{c[value]}</Text>
                  <Text>›</Text>
                </Pressable>
              ))}
            </View>
          )}
          {(section || tab === "saved") && (
            <View style={styles.form}>
              {section && (
                <Button
                  variant="quiet"
                  label={c.all}
                  onPress={() => {
                    setSection(undefined);
                    opener.current?.focus();
                  }}
                />
              )}
              <View ref={heading} accessible accessibilityRole="header">
                <Text role="title">{section ? c[section] : c.saved}</Text>
              </View>
              <View style={styles.row}>
                <Text>{c.history}</Text>
                <Switch
                  accessibilityLabel={c.history}
                  value={history}
                  onValueChange={setHistory}
                />
              </View>
              {error ? (
                <>
                  <Text>{c.failed}</Text>
                  <Button label={c.refresh} onPress={() => void read()} />
                </>
              ) : !page ? (
                <Text>{c.loading}</Text>
              ) : (
                <>
                  {!page.enabled && <Text>{c.unavailable}</Text>}
                  {!page.items.length && !busy && <Text>{c.empty}</Text>}
                  {page.items.map((item) => (
                    <View key={item.id} style={styles.memory}>
                      <Text>{item.content}</Text>
                      <Text role="caption" tone="secondary">
                        {item.trust === "user_assertion"
                          ? c.assertion
                          : item.trust === "verified_result"
                            ? c.verified
                            : c.inference}
                        {item.status !== "active"
                          ? ` · ${item.status === "superseded" ? c.earlier : c.unused}`
                          : ""}
                      </Text>
                      {edit?.item.id === item.id ? (
                        <>
                          <TextInput
                            accessibilityLabel={c.edit}
                            multiline
                            value={edit.content}
                            onChangeText={(content) =>
                              setEdit({ ...edit, content })
                            }
                            style={styles.input}
                          />
                          <View style={styles.row}>
                            <Button
                              label={c.cancel}
                              variant="quiet"
                              onPress={() => setEdit(undefined)}
                            />
                            <Button
                              label={c.save}
                              disabled={
                                busy ||
                                !!pending ||
                                !editable ||
                                !edit.content.trim()
                              }
                              onPress={() =>
                                void mutate({
                                  type: "revise",
                                  id: item.id,
                                  revision: edit.item.revision,
                                  content: edit.content,
                                  requestId: randomUUID(),
                                })
                              }
                            />
                          </View>
                        </>
                      ) : (
                        <View style={styles.row}>
                          {editable && item.status !== "superseded" && (
                            <Button
                              variant="quiet"
                              label={
                                item.origin === "observed" ? c.correct : c.edit
                              }
                              onPress={() =>
                                setEdit({ item, content: item.content ?? "" })
                              }
                            />
                          )}
                          <Button
                            variant="quiet"
                            label={c.remove}
                            onPress={() =>
                              confirm(
                                {
                                  type: "forget",
                                  id: item.id,
                                  revision: item.revision,
                                  requestId: randomUUID(),
                                },
                                c.removeHint,
                              )
                            }
                          />
                          {editable && item.source?.type === "observed" && (
                            <Button
                              variant="quiet"
                              label={
                                item.source.personal
                                  ? c.classifyWork
                                  : c.classify
                              }
                              onPress={() => {
                                if (item.source?.type === "observed")
                                  confirm(
                                    {
                                      type: "classify",
                                      id: item.id,
                                      revision: item.revision,
                                      personal: !item.source.personal,
                                      requestId: randomUUID(),
                                    },
                                    c.dropHint,
                                  );
                              }}
                            />
                          )}
                        </View>
                      )}
                      {item.source?.type === "observed" ? (
                        item.source.sources.map((source) => (
                          <View key={source.sourceId}>
                            <Text role="caption" tone="secondary">
                              {source.type === "chat"
                                ? c.chatSource
                                : c.meetingSource}{" "}
                              · {new Date(source.at).toLocaleString(language)}
                              {source.removed ? ` · ${c.removed}` : ""}
                            </Text>
                            {/* Source navigation is supplied only for server-valid hrefs. */}
                            {source.href && (
                              <Button
                                variant="quiet"
                                label={c.sources}
                                onPress={() => onOpenSource(source.href!)}
                              />
                            )}
                          </View>
                        ))
                      ) : (
                        <Text role="caption" tone="secondary">
                          {item.source?.type === "verified_operation"
                            ? `${c.verified} · ${item.source.serviceId}`
                            : c.assertion}{" "}
                          · {new Date(item.createdAt).toLocaleString(language)}
                        </Text>
                      )}
                    </View>
                  ))}
                  {page.nextCursor && (
                    <Button
                      label={c.loadMore}
                      disabled={busy}
                      onPress={() => void read(true)}
                    />
                  )}
                </>
              )}
            </View>
          )}
        </>
      )}
      {page && appearance && (
        <Button
          variant="quiet"
          label={
            page.personalThings === "keep" ? c.personalDrop : c.personalKeep
          }
          disabled={busy}
          onPress={() =>
            confirm(
              {
                type: "personalThings",
                value: page.personalThings === "keep" ? "drop" : "keep",
                requestId: randomUUID(),
              },
              page.personalThings === "keep" ? c.dropHint : c.personalKeep,
            )
          }
        />
      )}
      {page && tab === "saved" && !appearance && (
        <Button
          variant="quiet"
          label={c.manager}
          onPress={() =>
            Alert.alert(c.manager, undefined, [
              { text: c.cancel, style: "cancel" },
              {
                text: c.erase,
                style: "destructive",
                onPress: () =>
                  confirm(
                    { type: "forgetAll", requestId: randomUUID() },
                    c.eraseHint,
                  ),
              },
            ])
          }
        />
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { gap: 20 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  control: {
    minHeight: 48,
    padding: 12,
    borderBottomWidth: 2,
    borderColor: "transparent",
    justifyContent: "center",
  },
  selected: { borderColor: t.color.action.link },
  center: { alignItems: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  section: {
    width: "47%",
    minHeight: 56,
    borderWidth: 1,
    borderColor: t.color.border,
    borderRadius: 12,
    padding: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
  },
  form: { gap: 16 },
  memory: {
    gap: 12,
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderColor: t.color.border,
  },
  input: {
    minHeight: 100,
    color: t.color.text.primary,
    borderColor: t.color.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
});

import { PET_PALETTE } from "../shared/pet-appearance";
import React, {
  useCallback,
  useContext,
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
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { randomUUID } from "expo-crypto";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
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
import {
  Button,
  Disclosure,
  Field,
  Icon,
  ListRow,
  Text,
  Toggle,
  type IconName,
} from "../../packages/ui";
import { Entrance, useReducedMotion } from "../../packages/ui/motion";
import { Tabs } from "../../packages/ui/Tabs";
import type { HomePetBounds } from "./home-pet-visibility";
import { PetView } from "../../packages/ui/PetView";
import { PetSlot } from "../../packages/ui/PetStage";
import { tokens as t } from "../../packages/design-tokens";
import { petCopy, petFormat } from "./pet-profile-copy";
import { nativePetAppearance } from "./pet-profile-model";
import { DetailSheet, chrome } from "./ScreenChrome";

const sections = [
  "work",
  "projects",
  "tools",
  "people",
  "style",
  "rhythm",
] as const;
type Section = (typeof sections)[number];
const sectionIcon: Record<Section, IconName> = {
  work: "briefcase",
  projects: "workflow",
  tools: "wrench",
  people: "people",
  style: "chat",
  rhythm: "clock",
};
export type PetScreenView =
  | { kind: "overview" }
  | { kind: "section"; section: Section }
  | { kind: "saved" };
/**
 * The nested screen state lives with the app so the one TopBar can show the
 * section title, the history toggle and the way back to the overview.
 */
/** The memory switch's state, published by the page for the TopBar to render. */
export type PetMemoryControl = {
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
};
export function usePetScreen() {
  const [view, setView] = useState<PetScreenView>({ kind: "overview" });
  const [history, setHistory] = useState(false);
  const [memory, setMemory] = useState<PetMemoryControl | null>(null);
  return useMemo(
    () => ({
      view,
      setView,
      history,
      setHistory,
      memory,
      setMemory,
      nested: view.kind !== "overview",
      /** Returns to the overview; false when already there. */
      back: () => {
        if (view.kind === "overview") return false;
        setView({ kind: "overview" });
        return true;
      },
      reset: () => setView({ kind: "overview" }),
    }),
    [view, history, memory],
  );
}
export type PetScreen = ReturnType<typeof usePetScreen>;
export function petScreenTitle(screen: PetScreen, language: Language) {
  const c = petCopy(language);
  return screen.view.kind === "section"
    ? c[screen.view.section]
    : screen.view.kind === "saved"
      ? c.saved
      : c.title;
}
/** TopBar trailing actions: the memory switch on the overview, the history toggle on nested screens. */
export function PetTopBarActions({
  screen,
  language,
}: {
  screen: PetScreen;
  language: Language;
}) {
  const c = petCopy(language);
  if (screen.nested)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={c.history}
        accessibilityState={{ selected: screen.history }}
        aria-pressed={screen.history}
        onPress={() => screen.setHistory(!screen.history)}
        style={({ pressed }) => [
          styles.iconButton,
          screen.history && { backgroundColor: t.color.accent.softBlue },
          pressed && { backgroundColor: t.color.pressed },
        ]}
      >
        <Icon
          name="rotate"
          size={22}
          color={screen.history ? t.color.action.link : t.color.text.primary}
        />
      </Pressable>
    );
  return screen.memory ? (
    <View style={styles.light}>
      <Icon name="moon" size={16} color={t.color.text.secondary} />
      <Toggle
        accessibilityLabel={c.memory}
        value={screen.memory.value}
        disabled={screen.memory.disabled}
        onChange={screen.memory.onChange}
      />
    </View>
  ) : null;
}
const deviceKeys = [
  ["saved", "bookmark"],
  ["about", "person"],
  ["appearance", "palette"],
] as const satisfies readonly (readonly [string, IconName])[];
/**
 * The page ends where the screen's scroll content does: above the content's
 * bottom padding and the tab bar the app keeps under every root screen.
 */
const belowPage =
  Number(chrome.content.paddingBottom ?? 0) +
  Number(chrome.nav.paddingTop ?? 0) +
  Number(chrome.nav.paddingBottom ?? 0) +
  Number(chrome.navItem.minHeight ?? 0) +
  StyleSheet.hairlineWidth;
const PET_MIN = 180,
  PET_MAX = 280;
const latest = (items: MemoryItem[], key: "seenAt" | "createdAt") =>
  items.reduce<string | null>((best, item) => {
    const value = item[key];
    return value && (!best || value > best) ? value : best;
  }, null);

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
  screen: controlled,
  manage: manageControlled,
  onManage,
  changes = 0,
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
  /** Nested screen state shared with the TopBar; owned here when absent. */
  screen?: PetScreen;
  /** The manage-memory sheet, opened from the saved screen. */
  manage?: boolean;
  onManage?: (open: boolean) => void;
  /** Bumped when the pet changed on another device. */
  changes?: number;
}) {
  const own = usePetScreen();
  const screen = controlled ?? own;
  const [manageOwn, setManageOwn] = useState(false);
  const manage = manageControlled ?? manageOwn;
  const setManage = onManage ?? setManageOwn;
  const { width, height: windowHeight, fontScale } = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext);
  const reduced = useReducedMotion();
  const compact = fontScale >= 1.5 || width < 360;
  // The pet grows with the room the stage leaves it, within the brief's clamp.
  const petMax = Math.min(PET_MAX, width - 72) / Math.max(1, fontScale);
  const petMin = Math.min(PET_MIN / Math.max(1, fontScale), petMax);
  // Unknown until the pet's box is laid out: the pet waits for it instead of starting at a
  // guessed size (NIAR-275).
  const [petSize, setPetSize] = useState<number>();
  const [fill, setFill] = useState(0);
  const c = petCopy(language),
    f = petFormat(language);
  const { view, history } = screen;
  const section = view.kind === "section" ? view.section : undefined;
  const [personal, setPersonal] = useState<"work" | "personal">("work");
  const [page, setPage] = useState<PetMemoryPage | null>(),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<PetSettings>(),
    [edit, setEdit] = useState<{ item: MemoryItem; content: string }>(),
    [pending, setPending] = useState<PetMemoryCommand | SavePetProfile>();
  const [issue, setIssue] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [about, setAbout] = useState(false);
  const [rowMenu, setRowMenu] = useState<MemoryItem>();
  const [rowWidth, setRowWidth] = useState(0);
  const generation = useRef(0),
    alive = useRef(true),
    opener = useRef<Section | "saved" | null>(null),
    wells = useRef<Partial<Record<Section | "saved", View | null>>>({}),
    heading = useRef<View | null>(null);
  const root = useRef<View | null>(null);
  const profileY = useRef(0),
    stageY = useRef(0),
    bodyY = useRef(0),
    petBounds = useRef<{ y: number; height: number } | null>(null);
  const publishBounds = useCallback(() => {
    if (petBounds.current)
      onPetBounds?.({
        top:
          profileY.current +
          stageY.current +
          bodyY.current +
          petBounds.current.y,
        height: petBounds.current.height,
      });
  }, [onPetBounds]);
  // The overview fills the scroll viewport: the page's own top in the window
  // and the safe bottom edge bound the height the stage and tiles share.
  const bottomInset = insets?.bottom ?? 0;
  const measureFill = useCallback(() => {
    root.current?.measureInWindow?.((_x, y) => {
      if (!Number.isFinite(y)) return;
      const next = Math.max(
        0,
        Math.floor(windowHeight - y - bottomInset - belowPage),
      );
      setFill((current) => (current === next ? current : next));
    });
  }, [windowHeight, bottomInset]);
  useEffect(() => {
    measureFill();
    // The screen entrance still slides the page when the first layout lands.
    const timer = setTimeout(measureFill, t.motion.stateTransition + 50);
    return () => clearTimeout(timer);
  }, [measureFill]);
  const sheetOpen = appearance || about || manage;
  useEffect(() => {
    if (sheetOpen || view.kind !== "overview") onPetBounds?.(null);
    else publishBounds();
    return () => onPetBounds?.(null);
  }, [sheetOpen, view.kind, onPetBounds, publishBounds]);
  // Opening a nested screen reads its heading; returning restores the opener.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (view.kind !== "overview") {
        const target = findNodeHandle(heading.current);
        if (target != null) AccessibilityInfo.setAccessibilityFocus(target);
      } else if (opener.current) {
        const well = wells.current[opener.current];
        opener.current = null;
        const target = well ? findNodeHandle(well) : null;
        if (target != null) AccessibilityInfo.setAccessibilityFocus(target);
        well?.focus?.();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [view]);
  const query = useMemo(
    () =>
      view.kind === "saved"
        ? { origin: "explicit" as const, history, limit: 30 }
        : section
          ? {
              origin: "observed" as const,
              personal,
              section,
              history,
              limit: 30,
            }
          : { origin: "observed" as const, limit: 1 },
    [view.kind, section, personal, history],
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
  // A save in flight reads its own result; otherwise follow the other device.
  const followChange = useEffectEvent(() => {
    if (!busy) void read();
  });
  const seenChanges = useRef(changes);
  useEffect(() => {
    if (seenChanges.current === changes) return;
    seenChanges.current = changes;
    followChange();
  }, [changes]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A changed server query must hide the previous private slice before reading.
    setPage(undefined);
    setRowMenu(undefined);
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
      setAbout(false);
      // The closed sheet or form is the visible confirmation; no toast.
      AccessibilityInfo.announceForAccessibility(c.savedStatus);
      if ("type" in command && command.type === "revise")
        screen.setView({ kind: "saved" });
      else await read();
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
  const settings = draft ?? profile?.settings,
    editable = !!page?.enabled && !page.optOut,
    resting = !!page && (!page.enabled || page.optOut),
    motion = !!profile?.settings.animate && !reduced;
  const counts = useMemo(
    () =>
      Object.fromEntries(
        (profile?.look ?? []).map((entry) => [entry.section, entry.count]),
      ) as Partial<Record<Section, number>>,
    [profile],
  );
  const total = sections.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  const statusLine = !profile
    ? profileError || profile === null
      ? c.statusError
      : c.loading
    : page === null || (page && !page.enabled)
      ? c.unavailable
      : page?.optOut
        ? c.statusAsleep
        : total > 0
          ? f.statusKnows(total)
          : c.statusEmpty;
  const about_line = [profile?.settings.jobTitle, profile?.settings.department]
    .filter((value) => !!value?.trim())
    .join(" · ");
  const columns = compact ? 2 : 3;
  const tileWidth = rowWidth
    ? Math.floor((rowWidth - (columns - 1) * t.spacing.sm) / columns)
    : undefined;
  const savedRef = useCallback((node: View | null) => {
    wells.current.saved = node;
  }, []);
  const open = (next: Section | "saved") => {
    opener.current = next;
    screen.setView(
      next === "saved" ? { kind: "saved" } : { kind: "section", section: next },
    );
  };
  const mutateRef = useRef(mutate);
  useEffect(() => {
    mutateRef.current = mutate;
  });
  // An unconfirmed save asks in a dialog; nothing inline shifts the page.
  const recover = async () => {
    await onRefresh();
    const fresh = await read();
    if (conflict) {
      setPending(undefined);
      setIssue(false);
      if (edit) {
        const item = fresh?.items.find((item) => item.id === edit.item.id);
        if (item) setEdit({ ...edit, item });
      }
    }
  };
  const recoverRef = useRef(recover);
  useEffect(() => {
    recoverRef.current = recover;
  });
  useEffect(() => {
    if (!issue) return;
    Alert.alert(c.uncertain, c.conflict, [
      { text: c.cancel, style: "cancel", onPress: () => setIssue(false) },
      { text: c.refresh, onPress: () => void recoverRef.current() },
      ...(pending
        ? [{ text: c.retry, onPress: () => void mutateRef.current(pending) }]
        : []),
    ]);
    // The dialog opens once per failed save; its buttons read the latest handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue]);
  const memoryValue = !!page && !page.optOut,
    memoryDisabled = busy || !page || !page.enabled;
  const { setMemory } = screen;
  useEffect(() => {
    setMemory({
      value: memoryValue,
      disabled: memoryDisabled,
      onChange: (value) =>
        void mutateRef.current({
          type: "preference",
          optOut: !value,
          requestId: randomUUID(),
        }),
    });
  }, [setMemory, memoryValue, memoryDisabled]);
  useEffect(() => () => setMemory(null), [setMemory]);
  // The overview and the section strip are one pet that continues between them; it draws at
  // the largest size the stage allows, so a measured box only scales it.
  const pet = (
    size: number | undefined,
    interactive: boolean,
    visible = true,
    drawingSize = size,
  ) =>
    profile && size ? (
      <PetSlot
        clipped
        visible={visible}
        size={size}
        drawingSize={drawingSize}
        motionKey="profile"
        label={profile.settings.name}
        appearance={look}
        animate={profile.settings.animate}
        interactive={interactive}
        state={resting ? "resting" : "idle"}
      />
    ) : size ? (
      // Holds the pet's room while the profile loads; no still drawing flashes.
      <View style={{ width: size, height: size }} />
    ) : null;
  const overview = (
    <View style={[styles.page, fill > 0 && { minHeight: fill }]}>
      <View
        style={styles.stage}
        onLayout={(event) => {
          stageY.current = event.nativeEvent.layout.y;
          publishBounds();
        }}
      >
        <View
          style={styles.stageBody}
          onLayout={(event) => {
            bodyY.current = event.nativeEvent.layout.y;
            publishBounds();
          }}
        >
          <View
            testID="profile-pet-bounds"
            style={[styles.petBox, { minHeight: petMin, maxHeight: petMax }]}
            onLayout={(event) => {
              petBounds.current = event.nativeEvent.layout;
              publishBounds();
              const next = Math.round(event.nativeEvent.layout.height);
              if (next > 0) setPetSize(next);
            }}
          >
            {pet(petSize, true, petVisible, Math.round(petMax))}
          </View>
          {profile ? (
            <Text role="title" style={styles.centerText}>
              {profile.settings.name}
            </Text>
          ) : null}
          {about_line ? (
            <Text role="meta" tone="secondary" style={styles.centerText}>
              {about_line}
            </Text>
          ) : null}
          <Text tone="secondary" style={styles.centerText}>
            {statusLine}
          </Text>
          {profile ? null : profileError || profile === null ? (
            <Button
              label={c.retry}
              variant="secondary"
              size="small"
              onPress={() => void onRefresh()}
            />
          ) : null}
        </View>
      </View>
      <View
        accessibilityRole="list"
        accessibilityLabel={c.observed}
        style={styles.tiles}
        onLayout={(event) => {
          const next = Math.round(event.nativeEvent.layout.width);
          if (next !== rowWidth) setRowWidth(next);
        }}
      >
        {sections.map((key) => {
          const count = counts[key] ?? 0;
          return (
            <Pressable
              key={key}
              ref={(node) => {
                wells.current[key] = node;
              }}
              accessibilityRole="button"
              accessibilityLabel={c[key]}
              accessibilityValue={{ text: f.countLabel(count) }}
              accessibilityState={{ disabled: !profile }}
              disabled={!profile}
              onPress={() => open(key)}
              style={({ pressed }) => [
                styles.tile,
                tileWidth ? { width: tileWidth } : null,
                pressed && { backgroundColor: t.color.fillPressed },
                !profile && { opacity: 0.5 },
              ]}
            >
              <View style={styles.tileTop}>
                <Icon name={sectionIcon[key]} size={22} />
                {count > 0 ? (
                  <Text role="meta" tone="secondary" style={styles.count}>
                    {count}
                  </Text>
                ) : null}
              </View>
              <Text role="label">{c[key]}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.keys}>
        {deviceKeys.map(([key, icon]) => (
          <Pressable
            key={key}
            ref={key === "saved" ? savedRef : undefined}
            accessibilityRole="button"
            accessibilityLabel={c[key]}
            accessibilityState={{ disabled: key !== "saved" && !profile }}
            disabled={key !== "saved" && !profile}
            onPress={() =>
              key === "saved"
                ? open("saved")
                : key === "about"
                  ? setAbout(true)
                  : onAppearance(true)
            }
            style={({ pressed }) => [
              styles.key,
              // Equal widths so the keys line up with the tile grid above.
              compact ? { width: "100%" } : { flexBasis: 0 },
              pressed && { backgroundColor: t.color.fillPressed },
              key !== "saved" && !profile && { opacity: 0.5 },
            ]}
          >
            <Icon name={icon} size={18} />
            <Text role="label" style={{ flexShrink: 1 }}>
              {c[key]}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
  const items = page?.items ?? [];
  const stripCount =
    view.kind === "section"
      ? personal === "work"
        ? counts[view.section]
        : page && !page.nextCursor
          ? items.length
          : undefined
      : page && !page.nextCursor
        ? items.length
        : undefined;
  const stripSeen = page
    ? latest(items, view.kind === "saved" ? "createdAt" : "seenAt")
    : null;
  const stripMeta = [
    stripCount !== undefined ? f.countLabel(stripCount) : null,
    stripSeen ? f.lastSeen(stripSeen) : null,
    page === null || (page && !page.enabled)
      ? c.unavailable
      : page?.optOut
        ? c.statusAsleep
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const row = (item: MemoryItem) => {
    const observed = item.source?.type === "observed" ? item.source : null;
    const meta = [
      item.trust === "user_assertion"
        ? c.assertion
        : item.trust === "verified_result"
          ? item.source?.type === "verified_operation"
            ? `${c.verified} · ${item.source.serviceId}`
            : c.verified
          : c.inference,
      observed && item.seenAt
        ? f.lastSeen(item.seenAt)
        : !observed
          ? f.lastSeen(item.createdAt)
          : null,
      item.status === "superseded"
        ? c.earlier
        : item.status !== "active"
          ? c.unused
          : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <View key={item.id} style={styles.memory}>
        <View style={styles.memoryMain}>
          <Text>{item.content}</Text>
          <Text role="meta" tone="secondary">
            {meta}
          </Text>
          {observed ? (
            <Disclosure label={f.sourcesCount(observed.sources.length)}>
              {observed.sources.map((source) => {
                const label = `${
                  source.type === "chat" ? c.chatSource : c.meetingSource
                } · ${new Date(source.at).toLocaleDateString(language)}${
                  source.removed ? ` · ${c.removed}` : ""
                }`;
                // Source navigation is supplied only for server-valid hrefs.
                return source.href ? (
                  <Pressable
                    key={source.sourceId}
                    accessibilityRole="link"
                    accessibilityLabel={label}
                    onPress={() => onOpenSource(source.href!)}
                    style={styles.source}
                  >
                    <Text role="caption" style={{ flex: 1 }}>
                      {label}
                    </Text>
                    <Icon name="link" size={16} color={t.color.action.link} />
                  </Pressable>
                ) : (
                  <Text key={source.sourceId} role="caption" tone="secondary">
                    {label}
                  </Text>
                );
              })}
            </Disclosure>
          ) : null}
          {edit?.item.id === item.id ? (
            <View style={{ gap: t.spacing.sm }}>
              <TextInput
                accessibilityLabel={c.edit}
                multiline
                value={edit.content}
                onChangeText={(content) => setEdit({ ...edit, content })}
                style={styles.input}
              />
              <View style={styles.actions}>
                <Button
                  label={c.cancel}
                  variant="quiet"
                  size="small"
                  onPress={() => setEdit(undefined)}
                />
                <Button
                  label={c.save}
                  size="small"
                  disabled={
                    busy || !!pending || !editable || !edit.content.trim()
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
            </View>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={c.more}
          accessibilityHint={item.content ?? undefined}
          onPress={() => setRowMenu(item)}
          style={({ pressed }) => [
            styles.iconButton,
            pressed && { backgroundColor: t.color.pressed },
          ]}
        >
          <Icon name="more" size={20} />
        </Pressable>
      </View>
    );
  };
  const nested = (
    <View style={{ gap: t.spacing.lg }}>
      <View style={styles.strip}>
        <View style={styles.stripPet}>{pet(56, false)}</View>
        <View
          ref={heading}
          accessible
          accessibilityRole="header"
          style={{ flex: 1, minWidth: 0, gap: 2 }}
        >
          <Text role="rowTitle">{profile?.settings.name ?? c.title}</Text>
          {stripMeta ? (
            <Text role="meta" tone="secondary">
              {stripMeta}
            </Text>
          ) : null}
        </View>
      </View>
      {view.kind === "section" ? (
        <Tabs
          testID="pet-scope"
          options={[
            { id: "work", label: c.workScope },
            { id: "personal", label: c.personal },
          ]}
          value={personal}
          onChange={setPersonal}
        />
      ) : null}
      {error ? (
        <View style={styles.empty}>
          <Text tone="secondary">{c.statusError}</Text>
          <Button
            label={c.refresh}
            variant="secondary"
            size="small"
            onPress={() => void read()}
          />
        </View>
      ) : page === undefined ? (
        <View
          accessible
          accessibilityLabel={c.loading}
          testID="memory-skeleton"
          style={{ gap: t.spacing.sm }}
        >
          {[0, 1, 2].map((index) => (
            <View key={index} style={styles.skeletonRow}>
              <View style={styles.skeleton} />
              <View style={[styles.skeleton, { width: "55%" }]} />
            </View>
          ))}
        </View>
      ) : page === null ? (
        <View style={styles.empty}>
          <Text tone="secondary">{c.unavailable}</Text>
        </View>
      ) : (
        <View>
          {!items.length && !busy ? (
            <View style={styles.empty}>
              <Text tone="secondary">{c.empty}</Text>
            </View>
          ) : null}
          {items.map(row)}
          {page.nextCursor ? (
            <Button
              label={c.loadMore}
              variant="secondary"
              disabled={busy}
              onPress={() => void read(true)}
              style={{ marginTop: t.spacing.md }}
            />
          ) : null}
          {view.kind === "saved" ? (
            <Button
              label={c.manager}
              variant="quiet"
              onPress={() => setManage(true)}
              style={{ marginTop: t.spacing.md, alignSelf: "center" }}
            />
          ) : null}
        </View>
      )}
    </View>
  );
  const viewKey = view.kind === "section" ? view.section : view.kind;
  const content = view.kind === "overview" ? overview : nested;
  const menuItem = rowMenu;
  const menuObserved =
    menuItem?.source?.type === "observed" ? menuItem.source : null;
  const sheetFooter = (
    <View style={styles.actions}>
      <Button
        label={c.cancel}
        variant="quiet"
        onPress={() => {
          setDraft(undefined);
          onAppearance(false);
          setAbout(false);
        }}
      />
      <Button
        label={c.save}
        disabled={
          busy || !draft || !PetSettingsSchema.safeParse(settings).success
        }
        onPress={() => {
          if (profile && settings)
            void mutate({
              requestId: randomUUID(),
              revision: profile.revision,
              settings,
            });
        }}
      />
    </View>
  );
  const draftLook =
    profile && settings ? nativePetAppearance({ ...profile, settings }) : look;
  return (
    <View
      ref={root}
      style={styles.root}
      testID="pet-profile"
      onLayout={(event) => {
        profileY.current = event.nativeEvent.layout.y;
        publishBounds();
        measureFill();
      }}
    >
      {motion ? (
        <Entrance
          key={viewKey}
          duration={t.motion.stateTransition}
          distance={0}
        >
          {content}
        </Entrance>
      ) : (
        <View key={viewKey}>{content}</View>
      )}
      {menuItem ? (
        <DetailSheet
          title={c.more}
          language={language}
          onClose={() => setRowMenu(undefined)}
        >
          <View style={{ marginHorizontal: -t.spacing.screenGutter }}>
            {editable && menuItem.status !== "superseded" ? (
              <ListRow
                icon="edit"
                label={menuItem.origin === "observed" ? c.correct : c.edit}
                chevron={false}
                onPress={() => {
                  setRowMenu(undefined);
                  setEdit({ item: menuItem, content: menuItem.content ?? "" });
                }}
              />
            ) : null}
            {editable && menuObserved ? (
              <ListRow
                icon="person"
                label={menuObserved.personal ? c.classifyWork : c.classify}
                chevron={false}
                onPress={() => {
                  setRowMenu(undefined);
                  confirm(
                    {
                      type: "classify",
                      id: menuItem.id,
                      revision: menuItem.revision,
                      personal: !menuObserved.personal,
                      requestId: randomUUID(),
                    },
                    c.dropHint,
                  );
                }}
              />
            ) : null}
            <ListRow
              icon="trash"
              label={c.remove}
              danger
              onPress={() => {
                setRowMenu(undefined);
                confirm(
                  {
                    type: "forget",
                    id: menuItem.id,
                    revision: menuItem.revision,
                    requestId: randomUUID(),
                  },
                  c.removeHint,
                );
              }}
            />
          </View>
        </DetailSheet>
      ) : null}
      {about && settings ? (
        <DetailSheet
          title={c.about}
          language={language}
          onClose={() => {
            setDraft(undefined);
            setAbout(false);
          }}
          actions={sheetFooter}
        >
          <View style={styles.form}>
            <Field
              label={c.job}
              value={settings.jobTitle}
              maxLength={120}
              onChangeText={(jobTitle) => setDraft({ ...settings, jobTitle })}
            />
            <Field
              label={c.department}
              value={settings.department}
              maxLength={120}
              onChangeText={(department) =>
                setDraft({ ...settings, department })
              }
            />
            <Disclosure label={c.neverLearns}>
              <Text role="caption" tone="secondary">
                {`${c.neverLearnsList} ${c.neverLearnsHint}`}
              </Text>
            </Disclosure>
          </View>
        </DetailSheet>
      ) : null}
      {appearance && settings && profile ? (
        <DetailSheet
          title={c.appearance}
          language={language}
          onClose={() => {
            setDraft(undefined);
            onAppearance(false);
          }}
          actions={sheetFooter}
        >
          <View style={styles.form}>
            <View style={styles.sheetPet}>
              <PetView
                size={120 / Math.max(1, fontScale)}
                background={t.color.surface}
                appearance={draftLook}
                animate={settings.animate}
                state={resting ? "resting" : "idle"}
              />
            </View>
            <Field
              label={c.name}
              value={settings.name}
              maxLength={40}
              onChangeText={(name) => setDraft({ ...settings, name })}
            />
            <View style={{ gap: 6 }}>
              <Text role="section" tone="secondary">
                {c.colour}
              </Text>
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={c.colour}
                style={styles.swatches}
              >
                {PET_PALETTE.map((colour) => {
                  const checked = settings.colour === colour.hex;
                  return (
                    <Pressable
                      key={colour.hex}
                      accessibilityRole="radio"
                      accessibilityLabel={colour[language]}
                      accessibilityState={{ checked }}
                      onPress={() =>
                        setDraft({ ...settings, colour: colour.hex })
                      }
                      style={styles.swatchHit}
                    >
                      <View
                        style={[
                          styles.swatch,
                          { backgroundColor: colour.hex },
                          checked && styles.swatchOn,
                        ]}
                      />
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <View style={{ gap: 6 }}>
              <Text role="section" tone="secondary">
                {c.shape}
              </Text>
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={c.shape}
                style={styles.chips}
              >
                {(
                  [
                    ["auto", c.auto],
                    ...PetShapeSchema.options.map(
                      (shape, index) => [shape, c.shapes[index]!] as const,
                    ),
                  ] as const
                ).map(([shape, label]) => {
                  const checked = settings.shape === shape;
                  return (
                    <Pressable
                      key={shape}
                      accessibilityRole="radio"
                      accessibilityLabel={label}
                      accessibilityState={{ checked }}
                      onPress={() => setDraft({ ...settings, shape })}
                      style={[styles.chip, checked && styles.chipOn]}
                    >
                      <Text
                        role="label"
                        style={checked ? { color: t.color.action.link } : null}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <View style={styles.settingRows}>
              {(["animate", "showInChat"] as const).map((field) => (
                <ListRow
                  key={field}
                  label={field === "animate" ? c.animate : c.chat}
                  trailing={
                    <Toggle
                      accessibilityLabel={
                        field === "animate" ? c.animate : c.chat
                      }
                      value={settings[field]}
                      onChange={(value) =>
                        setDraft({ ...settings, [field]: value })
                      }
                    />
                  }
                />
              ))}
            </View>
          </View>
        </DetailSheet>
      ) : null}
      {manage ? (
        <DetailSheet
          title={c.manager}
          language={language}
          onClose={() => setManage(false)}
          actions={
            <Button
              label={c.done}
              variant="secondary"
              onPress={() => setManage(false)}
            />
          }
        >
          <View style={styles.form}>
            <View style={styles.settingRows}>
              <ListRow
                label={c.personalKeep}
                trailing={
                  <Toggle
                    accessibilityLabel={c.personalKeep}
                    value={page?.personalThings !== "drop"}
                    disabled={busy || !page}
                    onChange={(keep) =>
                      confirm(
                        {
                          type: "personalThings",
                          value: keep ? "keep" : "drop",
                          requestId: randomUUID(),
                        },
                        keep ? c.personalKeep : c.dropHint,
                      )
                    }
                  />
                }
              />
            </View>
            <Button
              label={c.erase}
              variant="danger"
              disabled={busy || !page}
              onPress={() =>
                confirm(
                  { type: "forgetAll", requestId: randomUUID() },
                  c.eraseHint,
                )
              }
            />
          </View>
        </DetailSheet>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { gap: t.spacing.md },
  page: { gap: t.spacing.md },
  stage: { flex: 1, gap: t.spacing.xs },
  light: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingRight: 6,
  },
  stageBody: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: t.spacing.xs,
  },
  petBox: {
    flex: 1,
    aspectRatio: 1,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
  },
  centerText: { textAlign: "center" },
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: t.spacing.md,
    paddingBottom: t.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: t.color.border,
  },
  stripPet: { width: 56, height: 56 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm },
  tile: {
    minHeight: 72,
    borderRadius: t.radius.card,
    backgroundColor: t.color.fill,
    padding: t.spacing.md,
    gap: 6,
    justifyContent: "center",
  },
  tileTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: t.spacing.sm,
  },
  count: { fontVariant: ["tabular-nums"] },
  keys: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm },
  key: {
    flexGrow: 1,
    minHeight: 48,
    paddingHorizontal: 14,
    borderRadius: t.radius.control,
    borderWidth: 1,
    borderColor: t.color.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: t.spacing.sm,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: t.radius.action,
    alignItems: "center",
    justifyContent: "center",
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: t.spacing.sm,
  },
  memory: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: t.spacing.xs,
    paddingVertical: t.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: t.color.border,
  },
  memoryMain: { flex: 1, minWidth: 0, gap: t.spacing.xs },
  source: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: t.spacing.sm,
  },
  input: {
    minHeight: 100,
    color: t.color.text.primary,
    borderColor: t.color.border,
    borderWidth: 1,
    borderRadius: t.radius.control,
    padding: t.spacing.md,
    textAlignVertical: "top",
  },
  empty: { alignItems: "center", gap: t.spacing.md, paddingVertical: 24 },
  skeletonRow: { gap: 6, paddingVertical: t.spacing.md },
  skeleton: {
    height: 14,
    borderRadius: 7,
    backgroundColor: t.color.fill,
    width: "85%",
  },
  form: { gap: t.spacing.lg },
  sheetPet: { alignItems: "center" },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.xs },
  swatchHit: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  swatch: { width: 32, height: 32, borderRadius: 16 },
  swatchOn: { borderWidth: 3, borderColor: t.color.action.link },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm },
  chip: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: t.radius.pill,
    backgroundColor: t.color.fill,
    justifyContent: "center",
  },
  chipOn: { backgroundColor: t.color.accent.softBlue },
  settingRows: {
    backgroundColor: t.color.surface,
    borderRadius: t.radius.group,
    overflow: "hidden",
  },
});

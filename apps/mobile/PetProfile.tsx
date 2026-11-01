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
import {
  Button,
  Disclosure,
  Field,
  Icon,
  ListRow,
  Notice,
  Segmented,
  Text,
  Toggle,
  type IconName,
} from "../../packages/ui";
import { Entrance, useReducedMotion } from "../../packages/ui/motion";
import type { HomePetBounds } from "./home-pet-visibility";
import { PetView } from "../../packages/ui/PetView";
import { PetFallback } from "../../packages/ui/PetFallback";
import { tokens as t } from "../../packages/design-tokens";
import { petCopy, petFormat } from "./pet-profile-copy";
import { nativePetAppearance } from "./pet-profile-model";
import { DetailSheet, IconButton } from "./ScreenChrome";

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
export function usePetScreen() {
  const [view, setView] = useState<PetScreenView>({ kind: "overview" });
  const [history, setHistory] = useState(false);
  return useMemo(
    () => ({
      view,
      setView,
      history,
      setHistory,
      nested: view.kind !== "overview",
      /** Returns to the overview; false when already there. */
      back: () => {
        if (view.kind === "overview") return false;
        setView({ kind: "overview" });
        return true;
      },
      reset: () => setView({ kind: "overview" }),
    }),
    [view, history],
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
/** TopBar trailing actions: the history toggle on nested screens, then `…`. */
export function PetTopBarActions({
  screen,
  language,
  onMenu,
}: {
  screen: PetScreen;
  language: Language;
  onMenu: () => void;
}) {
  const c = petCopy(language);
  return (
    <>
      {screen.nested ? (
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
            name="history"
            size={22}
            color={
              screen.history ? t.color.action.link : t.color.text.primary
            }
          />
        </Pressable>
      ) : null}
      <IconButton icon="more" label={c.more} onPress={onMenu} />
    </>
  );
}
/** The `…` menu of the pet page: an Alert so no sheet stacks on a sheet. */
export function petMenu(
  language: Language,
  actions: { manage: () => void; appearance: () => void },
) {
  const c = petCopy(language);
  Alert.alert(c.title, undefined, [
    { text: c.cancel, style: "cancel" },
    { text: c.manager, onPress: actions.manage },
    { text: c.appearance, onPress: actions.appearance },
  ]);
}
const deviceKeys = [
  ["saved", "bookmark"],
  ["about", "person"],
  ["appearance", "palette"],
] as const satisfies readonly (readonly [string, IconName])[];
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
  /** The manage-memory sheet, opened from the TopBar `…` menu. */
  manage?: boolean;
  onManage?: (open: boolean) => void;
}) {
  const own = usePetScreen();
  const screen = controlled ?? own;
  const [manageOwn, setManageOwn] = useState(false);
  const manage = manageControlled ?? manageOwn;
  const setManage = onManage ?? setManageOwn;
  const { width, fontScale } = useWindowDimensions();
  const reduced = useReducedMotion();
  const compact = fontScale >= 1.5 || width < 360;
  const petSize = Math.min(220, width - 72) / Math.max(1, fontScale);
  const c = petCopy(language),
    f = petFormat(language);
  const { view, history } = screen;
  const section = view.kind === "section" ? view.section : undefined;
  const [personal, setPersonal] = useState<"work" | "personal">("work");
  const [page, setPage] = useState<PetMemoryPage | null>(),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
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
  const profileY = useRef(0),
    shellY = useRef(0),
    screenY = useRef(0),
    petBounds = useRef<{ y: number; height: number } | null>(null);
  const publishBounds = useCallback(() => {
    if (petBounds.current)
      onPetBounds?.({
        top:
          profileY.current +
          shellY.current +
          screenY.current +
          petBounds.current.y,
        height: petBounds.current.height,
      });
  }, [onPetBounds]);
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
      setStatus(c.savedStatus);
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
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 2500);
    return () => clearTimeout(timer);
  }, [status]);
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
  const columns =
    !compact && rowWidth >= 6 * 48 + 5 * t.spacing.sm ? 6 : 3;
  const wellWidth = rowWidth
    ? Math.floor((rowWidth - (columns - 1) * t.spacing.sm) / columns)
    : undefined;
  const savedRef = useCallback((node: View | null) => {
    wells.current.saved = node;
  }, []);
  const open = (next: Section | "saved") => {
    opener.current = next;
    screen.setView(next === "saved" ? { kind: "saved" } : { kind: "section", section: next });
  };
  const issueBlock = issue ? (
    <View style={styles.issue}>
      <Notice error>
        {c.uncertain} {c.conflict}
      </Notice>
      <View style={styles.actions}>
        <Button
          label={c.refresh}
          variant="secondary"
          size="small"
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
            size="small"
            disabled={busy}
            onPress={() => void mutate(pending)}
          />
        )}
      </View>
    </View>
  ) : null;
  const memorySwitch = (
    <Toggle
      accessibilityLabel={c.memory}
      value={!!page && !page.optOut}
      disabled={busy || !page || !page.enabled}
      onChange={(value) =>
        void mutate({
          type: "preference",
          optOut: !value,
          requestId: randomUUID(),
        })
      }
    />
  );
  const pet = (size: number, interactive: boolean, visible = true) =>
    profile ? (
      <PetView
        visible={visible}
        size={size}
        label={profile.settings.name}
        appearance={look}
        animate={profile.settings.animate}
        interactive={interactive}
        state={resting ? "resting" : "idle"}
      />
    ) : (
      <PetFallback size={size} resting />
    );
  const overview = (
    <View
      style={styles.shell}
      onLayout={(event) => {
        shellY.current = event.nativeEvent.layout.y;
        publishBounds();
      }}
    >
      <View
        style={styles.screen}
        onLayout={(event) => {
          screenY.current = event.nativeEvent.layout.y;
          publishBounds();
        }}
      >
        {!compact && (
          <View style={styles.light}>
            <Icon name="moon" size={16} color={t.color.text.secondary} />
            {memorySwitch}
          </View>
        )}
        <View
          testID="profile-pet-bounds"
          onLayout={(event) => {
            petBounds.current = event.nativeEvent.layout;
            publishBounds();
          }}
        >
          {pet(petSize, true, petVisible)}
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
      {compact && (
        <View style={styles.lightRow}>
          <Icon name="moon" size={18} color={t.color.text.secondary} />
          <Text style={{ flex: 1 }}>{c.memory}</Text>
          {memorySwitch}
        </View>
      )}
      <View
        accessibilityRole="list"
        accessibilityLabel={c.observed}
        style={styles.wells}
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
                styles.well,
                compact && styles.wellStacked,
                wellWidth ? { width: wellWidth } : null,
                pressed && { backgroundColor: t.color.fillPressed },
                !profile && { opacity: 0.5 },
              ]}
            >
              <Icon name={sectionIcon[key]} size={20} />
              {count > 0 ? (
                <Text role="overline" tone="secondary" style={styles.count}>
                  {count}
                </Text>
              ) : null}
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
              compact && { width: "100%" },
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
      <View style={[styles.shell, styles.shellCompact]}>
        <View style={[styles.screen, styles.screenCompact]}>
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
      </View>
      {view.kind === "section" ? (
        <Segmented
          accessibilityLabel={c.observed}
          options={[
            { value: "work", label: c.workScope },
            { value: "personal", label: c.personal },
          ]}
          value={personal}
          onChange={setPersonal}
        />
      ) : null}
      {!sheetOpen && issueBlock}
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
      style={styles.root}
      testID="pet-profile"
      onLayout={(event) => {
        profileY.current = event.nativeEvent.layout.y;
        publishBounds();
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
      {view.kind === "overview" && !sheetOpen ? issueBlock : null}
      {!!status && (
        <Text
          accessibilityLiveRegion="polite"
          role="meta"
          tone="secondary"
          style={styles.centerText}
        >
          {status}
        </Text>
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
            {issueBlock}
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
            {issueBlock}
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
            {issueBlock}
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
  shell: {
    backgroundColor: t.color.surface,
    borderWidth: 1,
    borderColor: t.color.border,
    borderRadius: t.radius.sheet,
    padding: t.spacing.lg,
    gap: t.spacing.md,
  },
  shellCompact: { padding: 10 },
  screen: {
    backgroundColor: t.color.background,
    borderWidth: 1,
    borderColor: t.color.hairline,
    borderRadius: t.radius.group,
    padding: t.spacing.lg,
    alignItems: "center",
    gap: t.spacing.xs,
  },
  screenCompact: {
    flexDirection: "row",
    alignItems: "center",
    gap: t.spacing.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  stripPet: { width: 56, height: 56 },
  light: {
    position: "absolute",
    top: t.spacing.md,
    right: t.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    zIndex: 1,
  },
  lightRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: t.spacing.sm,
    minHeight: t.control.minHeight,
  },
  centerText: { textAlign: "center" },
  wells: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm },
  well: {
    minWidth: 48,
    minHeight: 48,
    borderRadius: t.radius.control,
    backgroundColor: t.color.fill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 10,
  },
  wellStacked: {
    flexDirection: "column",
    gap: 2,
    paddingVertical: 6,
    minHeight: 56,
  },
  count: { fontVariant: ["tabular-nums"] },
  keys: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm },
  key: {
    minHeight: 48,
    paddingHorizontal: 14,
    borderRadius: t.radius.control,
    borderWidth: 1,
    borderColor: t.color.border,
    flexDirection: "row",
    alignItems: "center",
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
  issue: { gap: t.spacing.sm },
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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  AppState,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import type { ClientSession } from "../../packages/client-core/session";
import {
  applyMentionPick,
  captureMentionIntent,
  messageMentions,
  mentionsInText,
  mentionKey,
  removeMention,
  type MentionDraftOwner,
  type MentionIntent,
  filterMentions,
  type MentionItem,
} from "../../packages/client-core/mentions";
import type { Language } from "../../packages/protocol";
import { tokens as t } from "../../packages/design-tokens";
import { Text, Icon, type IconName } from "../../packages/ui";
import { DetailSheet } from "./ScreenChrome";

const emptyMentions: MentionItem[] = [];
const copy = {
  en: {
    title: "References",
    search: "Find a reference",
    empty: "No matches",
    remove: "Remove reference",
    kinds: {
      service: "Connection",
      process: "Process",
      skill: "Skill",
      meeting: "Meeting",
    },
  },
  cs: {
    title: "Odkazy",
    search: "Najít odkaz",
    empty: "Nic nenalezeno",
    remove: "Odebrat odkaz",
    kinds: {
      service: "Propojení",
      process: "Proces",
      skill: "Dovednost",
      meeting: "Schůzka",
    },
  },
};
const glyph: Record<MentionItem["kind"], IconName> = {
  service: "link",
  process: "bolt",
  skill: "sparkle",
  meeting: "waveform",
};

/** Bounded existing server directory; late/foreign reads cannot populate this identity. */
export function useMobileMentionDirectory(
  session: ClientSession | null,
  online: boolean,
) {
  const [directory, setDirectory] = useState<{
    session: ClientSession;
    identity: string;
    items: MentionItem[];
  }>();
  useEffect(() => {
    if (!session || !online || typeof session.readMentions !== "function")
      return;
    const identity = session.identityKey;
    let current = true,
      generation = 0,
      last = -Infinity;
    let controller: AbortController | undefined;
    const refresh = () => {
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal,
        request = ++generation;
      void session.readMentions(signal).then(
        (value) => {
          if (
            current &&
            !signal.aborted &&
            request === generation &&
            identity === session.identityKey
          )
            setDirectory({ session, identity, items: value.items });
        },
        () => {},
      );
    };
    refresh();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") refresh();
      else {
        controller?.abort();
        last = -Infinity;
      }
    });
    return () => {
      current = false;
      generation++;
      controller?.abort();
      subscription.remove();
    };
  }, [session, online]);
  return directory?.session === session &&
    directory.identity === session?.identityKey
    ? directory.items
    : emptyMentions;
}

/** Inline rows keep the composer mounted and keyboard ownership unchanged. */
export function MobileMentionSuggestions({
  items,
  language,
  onPick,
}: {
  items: readonly MentionItem[];
  language: Language;
  onPick: (item: MentionItem) => void;
}) {
  const words = copy[language];
  if (!items.length) return null;
  return (
    <ScrollView
      keyboardShouldPersistTaps="always"
      accessibilityLabel={words.title}
      style={{ maxHeight: 240 }}
    >
      {items.map((item) => (
        <Pressable
          key={`${item.kind}:${item.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${item.name}, ${words.kinds[item.kind]}`}
          onPress={() => onPick(item)}
          style={({ pressed }) => ({
            minHeight: 48,
            padding: t.spacing.md,
            gap: t.spacing.sm,
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: pressed ? t.color.fillPressed : t.color.surface,
          })}
        >
          <Icon name={glyph[item.kind]} />
          <View style={{ flex: 1 }}>
            <Text>{item.name}</Text>
            {item.description ? (
              <Text tone="secondary" numberOfLines={1}>
                {item.description}
              </Text>
            ) : null}
          </View>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** Explicit @ uses the existing accessible sheet; selecting only updates a draft. */
export function MobileMentionSheet({
  items,
  language,
  onPick,
  onClose,
}: {
  items: readonly MentionItem[];
  language: Language;
  onPick: (item: MentionItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const words = copy[language],
    matches = filterMentions(items, query);
  const input = useRef<TextInput>(null);
  const focusOwner = useRef({
    alive: true,
    allowed:
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive",
    focused: false,
  });
  useEffect(() => {
    const owner = focusOwner.current;
    owner.alive = true;
    const app = AppState.addEventListener("change", (state) => {
      if (state !== "active") owner.allowed = false;
    });
    return () => {
      owner.alive = false;
      app.remove();
    };
  }, []);
  return (
    <DetailSheet
      title={words.title}
      language={language}
      onClose={onClose}
      onShown={() => {
        const owner = focusOwner.current;
        if (owner.alive && owner.allowed && !owner.focused) {
          owner.focused = true;
          input.current?.focus();
        }
      }}
    >
      <TextInput
        ref={input}
        accessibilityLabel={words.search}
        placeholder={words.search}
        placeholderTextColor={t.color.text.secondary}
        value={query}
        onChangeText={setQuery}
        maxLength={40}
        style={{
          minHeight: 48,
          padding: t.spacing.md,
          color: t.color.text.primary,
          backgroundColor: t.color.fill,
          borderRadius: t.radius.control,
        }}
      />
      {matches.length ? (
        <MobileMentionSuggestions
          items={matches}
          language={language}
          onPick={(item) => {
            focusOwner.current.allowed = false;
            onPick(item);
          }}
        />
      ) : (
        <Text tone="secondary">{words.empty}</Text>
      )}
    </DetailSheet>
  );
}

/** Selected context stays inside the same composer frame; each chip removes only its owned reference. */
export function MobileMentionTray({
  selected,
  language,
}: {
  selected: readonly { item: MentionItem; remove: () => void }[];
  language: Language;
}) {
  if (!selected.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.spacing.xs }}>
      {selected.map(({ item, remove }) => (
        <Pressable
          key={mentionKey(item)}
          accessibilityRole="button"
          accessibilityLabel={`${copy[language].remove} ${item.name}`}
          onPress={remove}
          style={({ pressed }) => ({
            minHeight: 44,
            maxWidth: "100%",
            paddingHorizontal: t.spacing.sm,
            flexDirection: "row",
            alignItems: "center",
            gap: t.spacing.xs,
            borderRadius: t.radius.control,
            backgroundColor: pressed ? t.color.fillPressed : t.color.fill,
          })}
        >
          <Icon name={glyph[item.kind]} size={16} />
          <Text role="caption" numberOfLines={1} style={{ flexShrink: 1 }}>
            {item.name}
          </Text>
          <Icon name="close" size={16} />
        </Pressable>
      ))}
    </View>
  );
}

export type MobileMentionDraft = MentionDraftOwner & { text: string };
type MentionFocusReturn = {
  modalReturn: boolean;
  scheduled: boolean;
  owned: () => boolean;
  stop?: () => void;
};
const mentionScopeKey = (owner: MentionDraftOwner) =>
  `${owner.identityKey}\n${owner.conversationId}`;
const mentionOccurrence = (value: MentionIntent) =>
  `${mentionScopeKey(value)}\n${value.revision}\n${value.at?.start ?? value.caret}`;

/** UI ownership only; parsing and insertion are the same pure functions the web uses. */
export function useMobileComposerMentions(options: {
  session: ClientSession | null;
  online: boolean;
  conversationId: string;
  context: unknown;
  enabled: boolean;
  read: () => MobileMentionDraft;
  onChange: (text: string) => void;
  onFocus: () => void;
}) {
  const directory = useMobileMentionDirectory(options.session, options.online);
  const latest = useRef(options),
    dir = useRef(directory),
    intentRef = useRef<MentionIntent | null>(null),
    sheetRef = useRef(false),
    selectionRef = useRef({ start: 0, end: 0 });
  const lastTyped = useRef<MobileMentionDraft | null>(null);
  const suppressed = useRef(""),
    picked = useRef(new Map<string, MentionItem[]>()),
    pendingFocus = useRef<number | null>(null),
    pendingReturn = useRef<MentionFocusReturn | null>(null);
  const [pickedView, setPickedView] = useState<
    ReadonlyMap<string, readonly MentionItem[]>
  >(new Map());
  const updatePicked = useCallback((scope: string, items: MentionItem[]) => {
    const next = new Map(picked.current);
    next.set(scope, items);
    picked.current = next;
    setPickedView(next);
  }, []);
  const [intent, setIntent] = useState<MentionIntent | null>(null),
    [sheet, setSheet] = useState(false),
    [selection, setSelection] = useState<{ start: number; end: number }>();
  useLayoutEffect(() => {
    latest.current = options;
    dir.current = directory;
  });
  const cancelFocus = useCallback(() => {
    if (pendingFocus.current !== null) {
      cancelAnimationFrame(pendingFocus.current);
      pendingFocus.current = null;
    }
    const pending = pendingReturn.current;
    pendingReturn.current = null;
    pending?.stop?.();
  }, []);
  const focus = useCallback(
    (afterSheet = false) => {
      cancelFocus();
      const source = latest.current;
      const owned = source.read();
      const request: MentionFocusReturn = {
        modalReturn: afterSheet && Platform.OS === "android",
        scheduled: false,
        owned: () => {
          const current = latest.current.read();
          return (
            latest.current.session === source.session &&
            latest.current.context === source.context &&
            latest.current.enabled &&
            mentionScopeKey(current) === mentionScopeKey(owned) &&
            current.revision === owned.revision &&
            current.text === owned.text
          );
        },
      };
      pendingReturn.current = request;
      const ready = () => {
        if (pendingReturn.current !== request || request.scheduled) return;
        request.scheduled = true;
        request.stop?.();
        request.stop = undefined;
        if (!request.owned()) {
          cancelFocus();
          return;
        }
        pendingFocus.current = requestAnimationFrame(() => {
          pendingFocus.current = null;
          if (pendingReturn.current !== request) return;
          pendingReturn.current = null;
          if (request.owned()) latest.current.onFocus();
        });
      };
      if (request.modalReturn) {
        // RN0.86 Android Modal has no onDismiss. Activity window focus is the
        // native signal that its Dialog window has returned ownership.
        const window = AppState.addEventListener("focus", ready);
        request.stop = () => window.remove();
      } else ready();
    },
    [cancelFocus],
  );
  useLayoutEffect(() => {
    if (pendingReturn.current && !pendingReturn.current.owned()) cancelFocus();
  });
  const dismiss = useCallback(
    (force = false, restoreFocus = false) => {
      if (!force && (sheetRef.current || pendingReturn.current?.modalReturn))
        return;
      const wasSheet = sheetRef.current;
      cancelFocus();
      if (intentRef.current)
        suppressed.current = mentionOccurrence(intentRef.current);
      if (intentRef.current) {
        intentRef.current = null;
        setIntent(null);
      }
      if (sheetRef.current) {
        sheetRef.current = false;
        setSheet(false);
      }
      setSelection(undefined);
      if (restoreFocus) focus(wasSheet);
    },
    [focus, cancelFocus],
  );
  const track = useCallback((text: string, caret: number) => {
    if (sheetRef.current) return;
    const current = latest.current.read();
    const found =
      latest.current.enabled && dir.current.length
        ? captureMentionIntent(current, text, caret)
        : null;
    const next =
      found && mentionOccurrence(found) !== suppressed.current ? found : null;
    const before = intentRef.current;
    if (
      before?.text === next?.text &&
      before?.revision === next?.revision &&
      before?.caret === next?.caret &&
      mentionScopeKey(before ?? current) === mentionScopeKey(next ?? current)
    )
      return;
    intentRef.current = next;
    setIntent(next);
  }, []);
  useEffect(() => {
    dismiss(true);
    lastTyped.current = null;
    const current = latest.current.read();
    selectionRef.current = {
      start: current.text.length,
      end: current.text.length,
    };
    suppressed.current = "";
    const app = AppState.addEventListener("change", (state) => {
      if (state !== "active") dismiss(true);
    });
    const keyboard = Keyboard.addListener("keyboardDidHide", () => dismiss());
    return () => {
      app.remove();
      keyboard.remove();
      dismiss(true);
    };
  }, [options.session, options.conversationId, options.context, dismiss]);
  useEffect(() => {
    if (!options.enabled) dismiss(true);
  }, [options.enabled, dismiss]);
  useEffect(() => {
    const current = latest.current.read(),
      typed = lastTyped.current;
    if (
      typed &&
      mentionScopeKey(typed) === mentionScopeKey(current) &&
      typed.revision === current.revision &&
      typed.text === current.text
    )
      track(current.text, selectionRef.current.start);
  }, [directory, track]);
  const type = useCallback(
    (text: string) => {
      cancelFocus();
      const current = latest.current.read(),
        previous = selectionRef.current;
      const caret = Math.max(
        0,
        Math.min(
          text.length,
          previous.start +
            text.length -
            current.text.length +
            previous.end -
            previous.start,
        ),
      );
      latest.current.onChange(text);
      lastTyped.current = latest.current.read();
      selectionRef.current = { start: caret, end: caret };
      track(text, caret);
    },
    [track, cancelFocus],
  );
  const select = useCallback(
    (value: { start: number; end: number }) => {
      selectionRef.current = value;
      setSelection(undefined);
      if (value.start === value.end)
        track(latest.current.read().text, value.start);
      else dismiss();
    },
    [track, dismiss],
  );
  const open = useCallback(() => {
    if (!latest.current.enabled || !dir.current.length) return;
    cancelFocus();
    const current = latest.current.read(),
      at = Math.min(selectionRef.current.start, current.text.length),
      next = captureMentionIntent(current, current.text, at, true);
    intentRef.current = next;
    setIntent(next);
    sheetRef.current = true;
    setSheet(true);
  }, [cancelFocus]);
  const pick = useCallback(
    (item: MentionItem) => {
      const owned = intentRef.current;
      if (!owned || !latest.current.enabled) {
        dismiss(true);
        return;
      }
      const current = latest.current.read(),
        next = applyMentionPick(
          owned,
          {
            ...current,
            picked: picked.current.get(mentionScopeKey(current)) ?? [],
            directory: dir.current,
          },
          item,
        );
      if (!next) {
        dismiss(true);
        return;
      }
      const wasSheet = sheetRef.current;
      updatePicked(mentionScopeKey(current), next.picked);
      latest.current.onChange(next.text);
      intentRef.current = null;
      sheetRef.current = false;
      setIntent(null);
      setSheet(false);
      suppressed.current = "";
      selectionRef.current = { start: next.caret, end: next.caret };
      setSelection(selectionRef.current);
      focus(wasSheet);
    },
    [dismiss, focus, updatePicked],
  );
  const payload = useCallback((text: string) => {
    const owner = latest.current.read();
    return messageMentions(text, [
      ...(picked.current.get(mentionScopeKey(owner)) ?? []),
      ...mentionsInText(text, dir.current),
    ]);
  }, []);
  const currentDraft = options.read();
  const candidates = [
    ...(pickedView.get(mentionScopeKey(currentDraft)) ?? []),
    ...mentionsInText(currentDraft.text, directory),
  ];
  const selected =
    options.enabled &&
    currentDraft.identityKey === options.session?.identityKey &&
    currentDraft.conversationId === options.conversationId
      ? messageMentions(currentDraft.text, candidates).flatMap((reference) => {
          const item = candidates.find(
            (candidate) => mentionKey(candidate) === mentionKey(reference),
          );
          return item
            ? [
                {
                  item,
                  remove: () => {
                    const current = latest.current.read();
                    if (
                      !latest.current.enabled ||
                      mentionScopeKey(current) !==
                        mentionScopeKey(currentDraft) ||
                      current.revision !== currentDraft.revision ||
                      current.text !== currentDraft.text
                    )
                      return;
                    const text = removeMention(current.text, item);
                    dismiss(true);
                    updatePicked(
                      mentionScopeKey(current),
                      candidates.filter(
                        (candidate) =>
                          mentionKey(candidate) !== mentionKey(item),
                      ),
                    );
                    latest.current.onChange(text);
                    lastTyped.current = null;
                    selectionRef.current = {
                      start: text.length,
                      end: text.length,
                    };
                    setSelection(selectionRef.current);
                    focus();
                  },
                },
              ]
            : [];
        })
      : [];
  const owned =
    !!intent &&
    options.enabled &&
    intent?.identityKey === options.session?.identityKey &&
    intent.conversationId === options.conversationId;
  return {
    available: options.enabled && directory.length > 0,
    items:
      owned && !sheet ? filterMentions(directory, intent.at?.query ?? "") : [],
    sheet: !!owned && sheet,
    directory,
    selected,
    selection,
    type,
    select,
    open,
    pick,
    payload,
    blur: () => dismiss(),
    close: () => dismiss(true, true),
  };
}

import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Image,
  PixelRatio,
  Platform,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";
import { tokens as t } from "../design-tokens";
import { useReducedMotion } from "./motion";
import { PetFallback } from "./PetFallback";
import { petRenderSize, type PetAppearance, type PetState } from "./pet-motion";
import { petPerfNote } from "./pet-perf";
import { petStill, type PetSnapshot } from "./pet-snapshot";
import {
  attachFollow,
  Follower,
  FollowView,
  useFollowRef,
  type FollowRef,
} from "./pet-stage-follow";
import { PetView, type PetControls, type PetViewProps } from "./PetView";

/**
 * The app's one pet (NIAR-276). A single live `PetView` is created near the app root when the app
 * starts, so its GL context and shader are ready by the time the first screen shows, and it is
 * never rebuilt: screens place empty `PetSlot`s and the stage draws the pet over the newest one,
 * following it on the UI thread. The slot is what the person touches and what a screen reader
 * reads; the drawn pet only draws. Without a stage (the browser, tests, stories) a slot is simply
 * a `PetView` of its own.
 *
 * Handing the pet to a new slot takes the UI thread a frame or more after the new screen shows.
 * Meanwhile the drawn pet is out of sight and the slot shows the pet's still itself, inside the
 * new screen from its first frame: never an empty slot, never the pet at the old place on the new
 * slot's card (NIAR-277).
 */
export type PetSlotProps = Omit<PetViewProps, "controls"> & {
  size: number;
  /** In the screen's scrolling area (`usePetClip`): the drawn pet is clipped to it. */
  clipped?: boolean;
};

type Slot = {
  id: number;
  target: FollowRef;
  props: PetSlotProps;
  controls: { current: PetControls | null };
};
type Stage = {
  add(slot: Slot): void;
  update(id: number, props: PetSlotProps): void;
  remove(id: number): void;
  /** Names the screen's scrolling area, which clips slots marked `clipped`. */
  setClip(clip: FollowRef | null): void;
  look: PetAppearance | null | undefined;
  /** The newest slot, which holds the pet. */
  active: number | null;
  /** The slot the drawn pet is shown over; until then the active slot shows a still. */
  covered: number | null;
};
const StageContext = createContext<Stage | null>(null);

/** The pet's drawing size: Home's pet; the profile's larger box only scales it (≤ 1.3×). */
export const PET_STAGE_SIZE = 220;
let nextSlot = 0;

export function PetStage({
  children,
  look,
  enabled = Platform.OS !== "web",
  onReady,
}: {
  children: React.ReactNode;
  /**
   * The look remembered from the last run, known before any screen: the pet is created with it at
   * once. `undefined` while it is still being read (the pet waits for it), `null` for the default.
   */
  look: PetAppearance | null | undefined;
  enabled?: boolean;
  /**
   * Once the pet's stand-in is on screen (its still decoded): the app may hold its first screen
   * for it, so that screen's first frame already has the pet. Called at once without a stage.
   */
  onReady?: () => void;
}) {
  // The newest slot holds the pet; the one before it gets it back when it closes. With none, the
  // pet keeps the last one's look and state, hidden.
  const [{ slots, last }, setSlots] = useState<{
    slots: Slot[];
    last: PetSlotProps | null;
  }>({ slots: [], last: null });
  const [clip, setClip] = useState<FollowRef | null>(null);
  const [stage] = useState<Omit<Stage, "look" | "active" | "covered">>(() => ({
    add: (slot) =>
      setSlots(({ slots }) => ({ slots: [...slots, slot], last: slot.props })),
    update: (id, props) =>
      setSlots(({ slots, last }) => ({
        slots: slots.map((slot) =>
          slot.id === id ? { ...slot, props } : slot,
        ),
        last: slots.at(-1)?.id === id ? props : last,
      })),
    remove: (id) =>
      setSlots(({ slots, last }) => {
        const next = slots.filter((slot) => slot.id !== id);
        return { slots: next, last: next.at(-1)?.props ?? last };
      }),
    // A ref is a function: wrapped, so React does not take it for an updater.
    setClip: (next) => setClip(() => next),
  }));
  const active = slots.at(-1);
  const activeId = active?.id ?? null;
  const [covered, setCovered] = useState<number | null>(null);
  // A new slot is covered only once the pet has been placed over it.
  if (covered !== null && covered !== activeId) setCovered(null);
  const value = useMemo(
    () => ({ ...stage, look, active: activeId, covered }),
    [stage, look, activeId, covered],
  );
  const current = useRef(active);
  useLayoutEffect(() => {
    current.current = active;
  });
  // Placed on the UI thread: shown once the live pet also shows the slot's card, so its old
  // card is never seen as a box on the new one.
  const placed = useCallback((id: number) => {
    let frames = 0;
    const settle = () => {
      const slot = current.current;
      if (slot?.id !== id) return;
      if (slot.controls.current?.upToDate() === false && ++frames < 30) {
        requestAnimationFrame(settle);
        return;
      }
      petPerfNote(
        `stage: shown over ${slot.props.testID ?? "niaro-pet"}${frames ? ` after ${frames} frames for its card` : ""}`,
      );
      setCovered(id);
    };
    settle();
  }, []);
  const props = active?.props ?? last;
  // A slot that is not visible (under a sheet, scrolled away) keeps its pet, only paused: hiding
  // it would empty the slot for the frames before the sheet covers it.
  const shown = !!active && active.props.visible !== false;
  const [idle] = useState(() => ({ current: null as PetControls | null }));
  const announced = useRef<number | null>(null);
  useLayoutEffect(() => {
    const id = active?.id ?? null;
    if (announced.current === id) return;
    announced.current = id;
    petPerfNote(
      active
        ? `stage: pet over ${active.props.testID ?? "niaro-pet"} ${Math.round(active.props.size)}pt`
        : "stage: no slot, pet hidden",
    );
  });
  const disabled = !enabled;
  useLayoutEffect(() => {
    if (disabled) onReady?.();
    // Once: there is no pet to wait for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);
  if (!enabled) return <>{children}</>;
  return (
    <StageContext.Provider value={value}>
      {children}
      {look !== undefined ? (
        <Follower
          target={active?.target ?? null}
          clip={active?.props.clipped ? clip : null}
          size={PET_STAGE_SIZE}
          shown={!!active}
          slot={activeId}
          onPlaced={placed}
          revealed={covered !== null}
        >
          <PetView
            {...props}
            // The remembered look until a screen places the pet; then that screen's look.
            appearance={props ? props.appearance : (look ?? undefined)}
            testID="pet-stage-pet"
            size={PET_STAGE_SIZE}
            drawingSize={PET_STAGE_SIZE}
            motionKey={undefined}
            visible={shown}
            controls={active?.controls ?? idle}
            onStandIn={onReady}
          />
        </Follower>
      ) : null}
    </StageContext.Provider>
  );
}

/** The look the stage remembered, for a screen whose own look is not known yet. */
export function usePetStageLook() {
  return useContext(StageContext)?.look ?? undefined;
}

/**
 * A ref for the screen's scrolling area: the pet of a `clipped` slot is drawn only inside it, as a
 * pet inside the scrolling content would be (never over the top bar or the tab bar).
 */
export function usePetClip() {
  const stage = useContext(StageContext);
  const ref = useFollowRef();
  useLayoutEffect(() => {
    if (!stage) return;
    stage.setClip(ref);
    return () => stage.setClip(null);
  }, [stage, ref]);
  // A callback ref, to share the view with the screen's own ref.
  return useCallback((node: unknown) => attachFollow(ref, node), [ref]);
}

const RESPONDER = [
  "onStartShouldSetResponder",
  "onResponderGrant",
  "onResponderStart",
  "onResponderMove",
  "onResponderRelease",
  "onResponderTerminate",
] as const;

/**
 * Where the pet stands on a screen. Under a `PetStage` it is an empty box the app's pet is drawn
 * over (touches and accessibility stay here, in the screen's own order); otherwise a `PetView`.
 */
export function PetSlot(props: PetSlotProps) {
  const stage = useContext(StageContext);
  if (!stage) {
    const { clipped: _clipped, ...own } = props;
    return <PetView {...own} />;
  }
  return <StagedSlot stage={stage} {...props} />;
}

function StagedSlot({ stage, ...props }: PetSlotProps & { stage: Stage }) {
  const target = useFollowRef();
  const [id] = useState(() => ++nextSlot);
  const [controls] = useState(() => ({ current: null as PetControls | null }));
  // The newest props, for the slot's first registration (effects run in this order).
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const published = useRef<PetSlotProps | null>(null);
  useLayoutEffect(() => {
    published.current = latest.current;
    stage.add({ id, target, props: latest.current, controls });
    return () => stage.remove(id);
  }, [stage, id, target, controls]);
  useLayoutEffect(() => {
    if (published.current && shallowEqual(published.current, props)) return;
    published.current = props;
    stage.update(id, props);
  });
  const {
    size,
    label = "Niaro",
    testID = "niaro-pet",
    interactive = false,
    onPress,
    disabled = false,
    visible = true,
    state = "idle",
  } = props;
  // Newest, not yet covered by the drawn pet: this slot shows the pet itself meanwhile.
  const standIn = stage.active === id && stage.covered !== id;
  const actionable = interactive || !!onPress;
  const enabled =
    actionable &&
    !disabled &&
    visible &&
    (state === "idle" || state === "resting");
  const side = Math.max(16, Math.min(480, size));
  // Touches arrive in this box; the pet reads them in its own size.
  const forward = (name: string) => (event: GestureResponderEvent) => {
    const pet = controls.current;
    const handler = pet?.handlers[name];
    if (typeof handler !== "function") return false;
    const native = event?.nativeEvent;
    if (!native) return false;
    const k = pet!.size / side;
    return handler({
      ...event,
      nativeEvent: {
        ...native,
        locationX: native.locationX * k,
        locationY: native.locationY * k,
      },
    });
  };
  const call = (name: string) => (event?: unknown) => {
    const handler = controls.current?.handlers[name];
    if (typeof handler === "function") handler(event);
  };
  return (
    <FollowView
      ref={target}
      collapsable={false}
      testID={testID}
      accessible
      accessibilityRole={actionable ? "button" : "image"}
      accessibilityLabel={label}
      accessibilityState={actionable ? { disabled: !enabled } : undefined}
      accessibilityActions={actionable ? [{ name: "activate" }] : undefined}
      onAccessibilityAction={call("onAccessibilityAction")}
      onAccessibilityTap={call("onAccessibilityTap")}
      focusable={enabled}
      {...Object.fromEntries(RESPONDER.map((name) => [name, forward(name)]))}
      onResponderTerminationRequest={() => true}
      style={{ width: side, height: side }}
    >
      {standIn ? (
        <SlotStill
          size={side}
          appearance={props.appearance}
          background={props.background}
          state={state}
          animate={props.animate}
        />
      ) : null}
    </FollowView>
  );
}

/**
 * The stage pet's still for a slot (its first frame at the stage's drawing size, else a near one),
 * over the drawing of its look until the still is decoded: what the slot shows until the drawn
 * pet stands over it.
 */
function SlotStill({
  size,
  appearance,
  background = t.color.background,
  state,
  animate = true,
}: {
  size: number;
  appearance?: PetAppearance;
  background?: string;
  state: PetState;
  animate?: boolean;
}) {
  const reduced = useReducedMotion() || !animate;
  const pixels = petRenderSize(
    PET_STAGE_SIZE,
    Math.max(1, PixelRatio.get()),
  ).pixels;
  const still = useMemo(
    () => petStill({ appearance, background, state, pixels, reduced }),
    [appearance, background, state, pixels, reduced],
  );
  const [decoded, setDecoded] = useState<PetSnapshot | null>(null);
  const source = still?.source ?? null;
  return (
    <View
      pointerEvents="none"
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="pet-slot-still"
      style={styles.still}
    >
      {source === null || decoded !== source ? (
        <PetFallback
          appearance={appearance}
          size={size}
          resting={state === "resting"}
        />
      ) : null}
      {source !== null ? (
        <Image
          source={typeof source === "number" ? source : { uri: source }}
          fadeDuration={0}
          // One decoded bitmap per still, whatever the slot's size: shown from memory at once.
          resizeMethod="scale"
          onLoad={() => setDecoded(source)}
          style={[styles.image, { width: size, height: size }]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  still: {
    position: "absolute",
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  image: { position: "absolute", left: 0, top: 0 },
});

function shallowEqual(a: object, b: object) {
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return (
    keys.length === Object.keys(y).length &&
    keys.every((key) => Object.is(x[key], y[key]))
  );
}

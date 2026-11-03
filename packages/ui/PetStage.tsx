import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Platform, type GestureResponderEvent } from "react-native";
import type { PetAppearance } from "./pet-motion";
import { petPerfNote } from "./pet-perf";
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
  const [stage] = useState<Omit<Stage, "look">>(() => ({
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
  const value = useMemo(() => ({ ...stage, look }), [stage, look]);
  const active = slots.at(-1);
  const props = active?.props ?? last;
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
          shown={shown}
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
    />
  );
}

function shallowEqual(a: object, b: object) {
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return (
    keys.length === Object.keys(y).length &&
    keys.every((key) => Object.is(x[key], y[key]))
  );
}

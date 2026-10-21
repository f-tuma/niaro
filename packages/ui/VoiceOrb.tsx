import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Animated, Easing, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  RadialGradient,
  Stop,
} from "react-native-svg";
import type { ExpoWebGLRenderingContext } from "expo-gl";
import { tokens as t } from "../design-tokens";
import { Icon } from "./index";
import { MotionPressable, nativeMotion, useReducedMotion } from "./motion";
import { Ripple } from "./Ripple";
import { TiltView, useGravity, useTilt } from "./liquid-tilt";
import { createLiquid, screenGravity } from "./liquid-sim";
import { createLiquidShader, type LiquidColors } from "./liquid-shader";
import { GLBoundary, supportedGLView } from "./gl-surface";

export type OrbState = "ready" | "live" | "disabled" | "dormant";
type Glyph = "mic" | "record" | "stop";
// Three periods: a drift of one period plus a phase offset of up to one more
// must still cover the whole glass, or the wave's end shows.
const PERIODS = 3;
/** Soft wave periods filled down to the bottom, so a drift loops without a seam. */
function liquid(period: number, height: number, level: number, amp: number) {
  let d = `M0 ${level}`;
  for (let x = 0; x < period * PERIODS; x += period)
    d += ` C${x + period * 0.25} ${level - amp} ${x + period * 0.25} ${level - amp} ${x + period * 0.5} ${level} S${x + period * 0.75} ${level + amp} ${x + period} ${level}`;
  return `${d} L${period * PERIODS} ${height} L0 ${height}Z`;
}
/** A sideways loop of one wave: whole periods, so the end meets the start. */
function useDrift(
  period: number,
  duration: number,
  running: boolean,
  direction: 1 | -1,
  /** Phase offset as a share of a period: the waves must never line up. */
  offset = 0,
) {
  const [x] = useState(() => new Animated.Value(0));
  useEffect(() => {
    x.stopAnimation();
    x.setValue(0);
    if (!running) return;
    const loop = Animated.loop(
      Animated.timing(x, {
        toValue: 1,
        duration,
        easing: Easing.linear,
        useNativeDriver: nativeMotion,
        isInteraction: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [x, duration, running]);
  const start = -period * offset;
  return x.interpolate({
    inputRange: [0, 1],
    outputRange:
      direction < 0 ? [start, start - period] : [start - period, start],
  });
}
type LiquidProps = {
  core: number;
  colors: LiquidColors;
  glyph: Glyph;
  grey: boolean;
  moving: boolean;
  live: boolean;
};
function GlyphMark({ core, glyph }: { core: number; glyph: Glyph }) {
  return glyph === "mic" ? (
    <Icon
      name="mic"
      size={Math.round(core * 0.36)}
      color={t.color.text.inverse}
    />
  ) : (
    <View
      style={{
        width: Math.round(core * (glyph === "stop" ? 0.24 : 0.28)),
        height: Math.round(core * (glyph === "stop" ? 0.24 : 0.28)),
        borderRadius: glyph === "stop" ? Math.round(core * 0.06) : core,
        backgroundColor: t.color.text.inverse,
      }}
    />
  );
}
/** The drawn liquid, for builds without GL: two drifting waves, sensor-tilted. */
function SvgLiquid({ core, colors, glyph, grey, moving, live }: LiquidProps) {
  const id = useId().replace(/:/g, "");
  // Opposite directions, different speeds and half a period apart: the two
  // surfaces cross like liquid turning evenly in the glass.
  const back = useDrift(core, live ? 3400 : 6800, moving, -1, 0.5);
  const front = useDrift(core, live ? 2300 : 4600, moving, 1);
  // The liquid turns about the lens centre to stay level; the glyph stays upright.
  const tilt = useTilt(moving);
  const layer = {
    position: "absolute" as const,
    left: 0,
    top: 0,
    width: core,
    height: core,
  };
  const wave = (
    drift: Animated.AnimatedInterpolation<number>,
    path: string,
    color: string,
    opacity: number,
  ) => (
    <TiltView style={[layer, tilt]}>
      <Animated.View
        style={{
          position: "absolute",
          width: core * PERIODS,
          height: core,
          transform: [{ translateX: drift }],
        }}
      >
        <Svg width={core * PERIODS} height={core} aria-hidden>
          <Path d={path} fill={color} fillOpacity={opacity} />
        </Svg>
      </Animated.View>
    </TiltView>
  );
  return (
    <>
      {/* The glass: deep at the bottom, lit softly from the upper left. */}
      <Svg
        width={core}
        height={core}
        style={{ position: "absolute" }}
        aria-hidden
      >
        <Defs>
          <LinearGradient id={`${id}g`} x1="0" y1="0" x2="0.4" y2="1">
            <Stop offset="0" stopColor={colors.via} />
            <Stop offset="1" stopColor={colors.to} />
          </LinearGradient>
          <RadialGradient id={`${id}l`} cx="30%" cy="18%" r="60%">
            <Stop
              offset="0"
              stopColor={t.color.text.inverse}
              stopOpacity={0.22}
            />
            <Stop offset="1" stopColor={t.color.text.inverse} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle
          cx={core / 2}
          cy={core / 2}
          r={core / 2}
          fill={`url(#${id}g)`}
        />
        <Circle
          cx={core / 2}
          cy={core / 2}
          r={core / 2}
          fill={`url(#${id}l)`}
        />
      </Svg>
      {/* The back surface is always darker than the front: that gap is the depth. */}
      {wave(
        back,
        liquid(core, core, core * 0.53, core * 0.05),
        colors.from,
        grey ? 0.35 : 0.6,
      )}
      {/* The glyph rests in the liquid: behind the front surface, never above it. */}
      <View
        aria-hidden
        style={[layer, { alignItems: "center", justifyContent: "center" }]}
      >
        <GlyphMark core={core} glyph={glyph} />
      </View>
      {wave(
        front,
        liquid(core, core, core * 0.58, core * 0.045),
        colors.surface,
        grey ? 0.4 : 0.82,
      )}
    </>
  );
}
/**
 * The simulated liquid: one shader draws glass, both surfaces and the glyph.
 * Per frame a shallow-water height field (liquid-sim.ts) is pushed by the
 * gravity sensor, so tilting pours the liquid to the low side where it
 * sloshes and settles; small waves travel faster and higher while voice is
 * live.
 */
function GlLiquid({
  level,
  fallback,
  ...props
}: LiquidProps & {
  level?: Animated.Value;
  fallback: React.ReactNode;
}) {
  const [Surface] = useState(supportedGLView);
  const [failed, setFailed] = useState(false);
  const gravity = useGravity();
  const latest = useRef({ ...props, voice: 0 });
  useLayoutEffect(() => {
    latest.current = { ...latest.current, ...props };
  });
  useEffect(() => {
    if (!level) return;
    const id = level.addListener(({ value }) => {
      latest.current.voice = value;
    });
    return () => level.removeListener(id);
  }, [level]);
  const stop = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stop.current?.(), []);
  const create = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      stop.current?.();
      let frame = 0;
      let stopped = false;
      let renderer: ReturnType<typeof createLiquidShader> | undefined;
      const finish = () => {
        stopped = true;
        cancelAnimationFrame(frame);
        try {
          renderer?.dispose();
        } catch {
          /* The platform may have already lost this context. */
        }
      };
      stop.current = finish;
      try {
        renderer = createLiquidShader(gl);
        const liquid = createLiquid();
        const sim = { time: 0, amp: 0.035 };
        let last = 0;
        let drawn = "";
        const render = (now: number) => {
          if (stopped) return;
          frame = requestAnimationFrame(render);
          const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
          last = now;
          const look = latest.current;
          if (look.moving && dt > 0) {
            const g = gravity();
            const pull = g
              ? screenGravity(g.x, g.y)
              : { sideways: 0, down: 9.81 };
            // Lying flat the screen has no "down"; the liquid eases to rest.
            const onScreen = g ? Math.hypot(g.x, g.y) / 9.81 : 1;
            const upright = Math.min(1, Math.max(0, (onScreen - 0.15) / 0.35));
            liquid.step(dt, pull.sideways * upright, pull.down);
            sim.time += dt * (look.live ? 1.8 : 1);
            const height =
              0.035 +
              (look.live ? Math.min(1, Math.max(0, look.voice)) * 0.07 : 0);
            sim.amp += (height - sim.amp) * (1 - Math.exp(-dt / 0.12));
          }
          const signature = `${look.moving}${look.glyph}${look.grey}${sim.time}`;
          // At rest one frame is enough; the loop only checks for a new look.
          if (!look.moving && drawn === signature) return;
          drawn = signature;
          renderer!.draw(
            {
              time: sim.time,
              amp: sim.amp,
              heights: liquid.height,
              trailing: liquid.trailing,
            },
            look,
          );
          gl.endFrameEXP();
        };
        frame = requestAnimationFrame(render);
      } catch (error) {
        // Visible in the Metro log: tells the drawn fallback from the shader.
        if (__DEV__) console.warn("Liquid shader unavailable", error);
        finish();
        setFailed(true);
      }
    },
    [gravity],
  );
  if (!Surface || failed) return fallback;
  return (
    <GLBoundary fallback={fallback}>
      <Surface
        style={{ width: props.core, height: props.core }}
        onContextCreate={create}
      />
    </GLBoundary>
  );
}

/**
 * The app's one voice control: a glass lens half full of the brand's liquid,
 * the glyph resting in it. Ready, the liquid turns slowly and a sparse ripple
 * invites a tap; live (the microphone or recorder really runs) it moves faster
 * and the glass breathes with `level`. The liquid stays level as the phone
 * tilts.
 */
export function VoiceOrb({
  label = "",
  onPress,
  state = "ready",
  tone = "voice",
  glyph = tone === "record" ? "record" : "mic",
  level,
  size = 148,
  testID,
}: {
  /** Required when pressable. */
  label?: string;
  onPress?: () => void;
  state?: OrbState;
  tone?: "voice" | "record";
  glyph?: Glyph;
  /** 0–1 microphone level; read only while `state` is "live". */
  level?: Animated.Value;
  size?: number;
  testID?: string;
}) {
  const id = useId().replace(/:/g, "");
  const reduced = useReducedMotion();
  // Whole pixels: a fractional SVG box clips the circle's right and bottom edge.
  const core = Math.round(size * 0.72);
  const grey = state === "disabled" || state === "dormant";
  const lens = t.color.lens[grey ? "idle" : tone];
  const moving = !grey && !reduced;
  const live = state === "live" ? level : undefined;
  const liquidProps: LiquidProps = {
    core,
    colors: lens,
    glyph,
    grey,
    moving,
    live: state === "live",
  };
  const breathe = (to: number) =>
    live
      ? [
          {
            scale: live.interpolate({
              inputRange: [0, 1],
              outputRange: [1, to],
              extrapolate: "clamp",
            }),
          },
        ]
      : undefined;
  const orb = (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Halo: depth at rest; while live it breathes with the real level. */}
      <Animated.View
        style={{
          position: "absolute",
          width: size,
          height: size,
          opacity: grey ? 0.35 : 0.8,
          transform: breathe(1.22),
        }}
      >
        <Svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
          <Defs>
            <RadialGradient id={`${id}h`} cx="50%" cy="50%" r="50%">
              <Stop offset="0.55" stopColor={lens.via} stopOpacity={0.3} />
              <Stop offset="0.8" stopColor={lens.to} stopOpacity={0.12} />
              <Stop offset="1" stopColor={lens.from} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={50} cy={50} r={50} fill={`url(#${id}h)`} />
        </Svg>
      </Animated.View>
      <Ripple
        size={core}
        color={lens.via}
        running={!grey}
        period={live ? 1300 : 1800}
        // At rest an occasional ring invites a tap; while live it never stops.
        pause={live ? 0 : 2600}
        reach={live ? 1.55 : 1.4}
        strength={0.3}
      />
      <Animated.View
        style={{
          width: core,
          height: core,
          borderRadius: core / 2,
          overflow: "hidden",
          transform: breathe(1.06),
        }}
      >
        <GlLiquid
          {...liquidProps}
          level={live}
          fallback={<SvgLiquid {...liquidProps} />}
        />
      </Animated.View>
    </View>
  );
  // Without an action it is decoration; the headline beside it says the rest.
  if (!onPress)
    return (
      <View
        testID={testID}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
      >
        {orb}
      </View>
    );
  return (
    <MotionPressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: grey }}
      aria-disabled={grey}
      disabled={grey}
      onPress={onPress}
      style={{ borderRadius: size / 2 }}
    >
      {orb}
    </MotionPressable>
  );
}

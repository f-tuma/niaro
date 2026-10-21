import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Animated, StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import type { ExpoWebGLRenderingContext } from "expo-gl";
import { tokens as t } from "../design-tokens";
import { nativeMotion, useMotionTarget, useReducedMotion } from "./motion";
import { createVoiceShader, SPECTRUM_BANDS } from "./voice-shader";
import { GLBoundary, supportedGLView } from "./gl-surface";
type VisualMode = "recording" | "starting" | "processing";

/** A fixed central shape; only its amplitude follows the current microphone level. */
function VoiceWaveFallback({ level }: { level: number }) {
  const id = useId().replace(/:/g, "");
  const strength = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  const scale = useMotionTarget(0.07 + strength * 0.93, 100);
  return (
    <Animated.View
      style={{ width: "100%", height: 40, transform: [{ scaleY: scale }] }}
    >
      <Svg
        width="100%"
        height={40}
        viewBox="0 0 400 40"
        preserveAspectRatio="none"
        aria-hidden
      >
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={t.color.wave.cyan} stopOpacity={0.15} />
            <Stop offset="0.25" stopColor={t.color.accent.blue} />
            <Stop offset="0.5" stopColor={t.color.action.primary} />
            <Stop offset="0.75" stopColor={t.color.wave.violet} />
            <Stop offset="1" stopColor={t.color.wave.cyan} stopOpacity={0.15} />
          </LinearGradient>
        </Defs>
        <Path
          d="M0 20C38 20 51 5 82 5S127 34 152 20S182 0 200 0S225 5 248 20S287 5 318 5S362 20 400 20C362 20 349 35 318 35S273 6 248 20S218 40 200 40S175 35 152 20S113 35 82 35S38 20 0 20Z"
          fill={`url(#${id})`}
          opacity={0.22}
        />
        <Path
          d="M0 20C48 20 62 11 86 11S139 29 160 15S184 3 200 3S219 1 240 15S290 11 314 11S352 20 400 20C352 20 338 29 314 29S261 11 240 25S216 37 200 37S181 39 160 25S110 29 86 29S48 20 0 20Z"
          fill={`url(#${id})`}
          opacity={0.62}
        />
        <Path
          d="M0 20C62 20 66 15 96 15S142 26 164 16S184 7 200 7S214 6 236 16S274 15 304 15S338 20 400 20"
          fill="none"
          stroke={`url(#${id})`}
          strokeWidth={1.5}
        />
      </Svg>
    </Animated.View>
  );
}

function WaveFallback({ level, mode }: { level: number; mode: VisualMode }) {
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    opacity.stopAnimation();
    opacity.setValue(1);
    if (mode === "recording" || reduced) return;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.35,
          duration: 650,
          useNativeDriver: nativeMotion,
          isInteraction: false,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 650,
          useNativeDriver: nativeMotion,
          isInteraction: false,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [mode, reduced, opacity]);
  return (
    <Animated.View style={{ opacity }}>
      <VoiceWaveFallback level={mode === "recording" ? level : 0.4} />
    </Animated.View>
  );
}

// Old development builds and devices without GL retain a working microphone.
export function VoiceVisualizer({
  level,
  bands,
  spectrum,
  mode = "recording",
  variant = "wave",
}: {
  level: number;
  mode?: VisualMode;
  variant?: "wave" | "border";
  bands?: readonly [number, number, number];
  /** 24 bands, 0–1; when present the ribbon follows the voice's spectral shape. */
  spectrum?: readonly number[];
}) {
  const reduced = useReducedMotion();
  const [Surface] = useState(supportedGLView);
  const [failed, setFailed] = useState(false);
  const sample = useRef<{
    level: number;
    bands?: readonly [number, number, number];
    spectrum?: readonly number[];
    reduced: boolean;
    mode: VisualMode;
  }>({ level: 0, reduced: true, mode: "recording" });
  const stop = useRef<(() => void) | undefined>(undefined);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    sample.current = { level, bands, spectrum, reduced, mode };
  }, [level, bands, spectrum, reduced, mode]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop.current?.();
    };
  }, []);
  const create = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      stop.current?.();
      if (!mounted.current) return;
      let renderer: ReturnType<typeof createVoiceShader> | undefined;
      let frame = 0;
      let stopped = false;
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
        renderer = createVoiceShader(gl, variant);
        let appearedAt: number | undefined;
        let previous = 0,
          phase = 0;
        let amplitudes: [number, number, number] = [0, 0, 0];
        const shape = new Array<number>(SPECTRUM_BANDS).fill(0);
        let shaped = 0;
        let lastMode: VisualMode = "recording",
          age = 0;
        let lastDraw = "",
          width = 0,
          height = 0;
        const render = (now: number) => {
          if (stopped) return;
          appearedAt ??= now;
          frame = requestAnimationFrame(render);
          const elapsed = now - previous;
          if (elapsed < 1000 / 30) return;
          const dt = Math.min(0.1, elapsed / 1000);
          previous = now;
          const clamp = (value: number) =>
            Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
          const progress = sample.current.reduced
            ? 1
            : clamp((now - appearedAt) / 550);
          const entrance = progress * progress * (3 - 2 * progress);
          const currentMode = sample.current.mode;
          age = currentMode === lastMode ? age + dt : 0;
          lastMode = currentMode;
          const pending = currentMode !== "recording";
          const overall = clamp(sample.current.level);
          // RMS-only native recorders get an amplitude visual, without invented spectral evidence.
          // Waiting states stay visibly quieter than speech: nothing is being heard.
          const targets = pending
            ? currentMode === "starting"
              ? [0.06, 0.08, 0.04]
              : [0.14, 0.18, 0.1]
            : (sample.current.bands ?? [overall, overall, overall]);
          amplitudes = amplitudes.map((value, index) => {
            const target = clamp(targets[index]!);
            const next = sample.current.reduced
              ? target
              : value +
                (target - value) *
                  (1 -
                    Math.exp(
                      -dt /
                        (target > value
                          ? 0.045 + index * 0.01
                          : 0.18 - index * 0.04),
                    ));
            return next < 0.001 ? 0 : next;
          }) as [number, number, number];
          // Each band rises fast and falls slowly, like the eye expects of a voice.
          const incoming = pending ? undefined : sample.current.spectrum;
          for (let i = 0; i < SPECTRUM_BANDS; i++) {
            const target = incoming ? clamp(incoming[i] ?? 0) : 0;
            shape[i] = sample.current.reduced
              ? target
              : shape[i]! +
                (target - shape[i]!) *
                  (1 - Math.exp(-dt / (target > shape[i]! ? 0.04 : 0.16)));
          }
          shaped += ((incoming ? 1 : 0) - shaped) * (1 - Math.exp(-dt / 0.25));
          const active = Math.max(...amplitudes);
          if (!sample.current.reduced)
            phase +=
              dt *
              (variant === "border"
                ? 1
                : pending
                  ? 0.7
                  : 0.15 + Math.min(0.85, active * 1.6));
          const signature =
            currentMode +
            entrance.toFixed(3) +
            amplitudes.map((value) => value.toFixed(4)).join() +
            shape.map((value) => value.toFixed(3)).join() +
            shaped.toFixed(3);
          try {
            if (gl.isContextLost()) throw new Error("Graphics context lost");
            if (
              lastDraw === signature &&
              (sample.current.reduced ||
                (variant === "wave" && active === 0)) &&
              width === gl.drawingBufferWidth &&
              height === gl.drawingBufferHeight
            )
              return;
            renderer!.draw(
              amplitudes,
              sample.current.reduced ? 0 : phase,
              currentMode === "starting" && !sample.current.reduced
                ? Math.min(entrance, age / 0.45)
                : entrance,
              shape,
              shaped,
            );
            gl.endFrameEXP();
            lastDraw = signature;
            width = gl.drawingBufferWidth;
            height = gl.drawingBufferHeight;
          } catch {
            finish();
            if (mounted.current) setFailed(true);
          }
        };
        frame = requestAnimationFrame(render);
      } catch {
        finish();
        setFailed(true);
      }
    },
    [variant],
  );
  const fallback =
    variant === "border" ? (
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            borderWidth: 2,
            borderColor: t.color.accent.blue,
            borderRadius: 27,
          },
        ]}
      />
    ) : (
      <WaveFallback level={level} mode={mode} />
    );
  return (
    <View
      style={[
        { pointerEvents: "none" },
        // The border lies over the composer's own 1px edge, never outside it:
        // starting to record must not make the field grow or move.
        variant === "border"
          ? { position: "absolute", top: -1, left: -1, right: -1, bottom: -1 }
          : { height: 40, width: "100%" },
      ]}
    >
      {!Surface || failed ? (
        fallback
      ) : (
        <GLBoundary fallback={fallback}>
          <Surface
            testID={
              variant === "border" ? "voice-border-shader" : "voice-shader"
            }
            style={[StyleSheet.absoluteFill, { pointerEvents: "none" }]}
            onContextCreate={create}
          />
        </GLBoundary>
      )}
    </View>
  );
}

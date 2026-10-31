import {
  PetFallbackDrawing,
  type PetSvgPrimitives,
} from "../../../../packages/ui/pet-fallback-drawing";
import { tokens as t } from "../../../../packages/design-tokens";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPetShader } from "../../../../packages/ui/pet-shader";
import {
  advancePetMotion,
  createPetCadence,
  createPetInteraction,
  petCadenceDue,
  petRenderSize,
  petFrame,
  setPetAppearance,
  type PetFrame,
  pressPet,
  movePet,
  releasePet,
  resetPetInteraction,
  type PetAppearance,
  type PetMotion,
  type PetState,
} from "../../../../packages/ui/pet-motion";
import {
  focusPetPlay,
  hoverPetPlay,
  keyPetPlay,
  petPlayBusy,
  type PetFace,
  type PetSignName,
} from "../../../../packages/ui/pet-interaction";

/** DOM adapter only: the native companion owns geometry, motion and play. */
export function WebPetView({
  size = 320,
  label = "Niaro",
  appearance,
  animate = true,
  interactive = true,
  state = "idle",
  background,
}: {
  size?: number;
  label?: string;
  appearance?: PetAppearance;
  animate?: boolean;
  interactive?: boolean;
  state?: PetState;
  background?: string;
}) {
  size = petRenderSize(size, 1).logical;
  const [still, setStill] = useState<{
    frame: PetFrame;
    face: PetFace;
    sign: PetSignName | null;
  }>();
  const motionRef = useRef<PetMotion>({
    time: 2,
    level: 0,
    touch: 0,
    sleep: state === "resting" ? 1 : 0,
    interaction: createPetInteraction(),
    appearance,
  });
  const rendererActive = useRef(false);
  const wakeRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    setPetAppearance(
      motionRef.current,
      appearance,
      !rendererActive.current ||
        !animate ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    wakeRef.current?.();
  }, [appearance, animate]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);
  const input = useRef<
    ((kind: string, x?: number, y?: number, key?: string) => boolean) | null
  >(null);
  useEffect(() => {
    const surface = canvas.current;
    if (!surface) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motion = motionRef.current;
    let renderer: ReturnType<typeof createPetShader> | undefined;
    let raf = 0,
      last = 0,
      visible = true,
      disposed = false;
    const cadence = createPetCadence();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const reduced = () => !animate || media.matches;
    const backdrop = () => {
      if (background) return background;
      if (typeof getComputedStyle !== "undefined") {
        for (
          let element: HTMLElement | null = host.current;
          element;
          element = element.parentElement
        ) {
          const colour = getComputedStyle(element).backgroundColor;
          const rgb = colour.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
          if (rgb)
            return (
              "#" +
              rgb
                .slice(1)
                .map((value) => Number(value).toString(16).padStart(2, "0"))
                .join("")
            );
        }
      }
      return document.documentElement?.classList.contains("dark")
        ? t.color.background
        : "#ffffff";
    };
    const live = () =>
      !disposed && visible && document.visibilityState !== "hidden";
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      resetPetInteraction(motion);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
    const draw = (now: number) => {
      raf = 0;
      if (!live()) return;
      if (petCadenceDue(cadence, now, 30, !last)) {
        if (!renderer || reduced())
          setPetAppearance(motion, motion.appearance, true);
        advancePetMotion(
          motion,
          reduced() || !last ? 0 : (now - last) / 1000,
          state,
          0,
          reduced() ? now / 1000 : undefined,
          reduced(),
        );
        last = now;
        renderer?.draw(motion, state, reduced(), backdrop());
        if (!renderer) {
          const play = motion.interaction!.play;
          setStill({
            frame: petFrame(motion, state, reduced()),
            face: { ...play.target },
            sign: play.sign && play.now >= play.sign.at ? play.sign.name : null,
          });
        }
      }
      if (!reduced() && (renderer || petPlayBusy(motion.interaction!.play)))
        raf = requestAnimationFrame(draw);
    };
    const wake = () => {
      if (live() && !raf) raf = requestAnimationFrame(draw);
    };
    const schedule = (delay: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        wake();
      }, delay);
      timers.add(timer);
    };
    wakeRef.current = wake;
    const lifecycle = () => {
      stop();
      wake();
    };
    try {
      const dimensions = petRenderSize(size, window.devicePixelRatio);
      surface.width = dimensions.pixels;
      surface.height = dimensions.pixels;
      const gl = surface.getContext("webgl", {
        alpha: false,
        antialias: false,
      });
      if (!gl) throw new Error("No GL");
      renderer = createPetShader(gl, backdrop());
      rendererActive.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reflect whether the external GL context was created successfully.
      setFallback(false);
      wake();
    } catch {
      setFallback(true);
    }
    const lost = (event: Event) => {
      event.preventDefault();
      stop();
      renderer?.dispose();
      renderer = undefined;
      rendererActive.current = false;
      setFallback(true);
      wake();
    };
    const themeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(lifecycle);
    if (document.documentElement)
      themeObserver?.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting ?? false;
            lifecycle();
          });
    if (host.current) observer?.observe(host.current);
    document.addEventListener("visibilitychange", lifecycle);
    media.addEventListener("change", lifecycle);
    surface.addEventListener("webglcontextlost", lost);
    input.current = (kind, x = size / 2, y = size / 2, key = "") => {
      if (!live() || !interactive) return false;
      const now = reduced() ? performance.now() / 1000 : motion.time;
      let accepted = true;
      if (kind === "down")
        accepted = pressPet(
          motion,
          x,
          y,
          size,
          now,
          state,
          reduced(),
          performance.now() / 1000,
        );
      if (kind === "move")
        movePet(motion, x, y, size, now, state, performance.now() / 1000);
      if (kind === "up") releasePet(motion, now, false, reduced());
      if (kind === "cancel") {
        resetPetInteraction(motion);
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      }
      if (kind === "leave")
        hoverPetPlay(motion.interaction!.play, 0, 0, now, false);
      if (kind === "key")
        keyPetPlay(motion.interaction!.play, key, now, reduced());
      if (kind === "focus")
        focusPetPlay(motion.interaction!.play, now, reduced());
      if (kind === "hover" && !reduced())
        hoverPetPlay(
          motion.interaction!.play,
          (x - size / 2) / (size * 1.2),
          -(y - size / 2) / (size * 1.2),
          now,
        );
      if (reduced() && ["down", "up", "key"].includes(kind))
        schedule(kind === "down" ? 650 : 1420);
      wake();
      return accepted;
    };
    return () => {
      disposed = true;
      rendererActive.current = false;
      stop();
      input.current = null;
      wakeRef.current = null;
      observer?.disconnect();
      themeObserver?.disconnect();
      media.removeEventListener("change", lifecycle);
      document.removeEventListener("visibilitychange", lifecycle);
      surface.removeEventListener("webglcontextlost", lost);
      renderer?.dispose();
    };
  }, [size, animate, interactive, state, background]);
  const point = (event: React.PointerEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    return [
      ((event.clientX - box.left) * size) / box.width,
      ((event.clientY - box.top) * size) / box.height,
    ] as const;
  };
  return (
    <div
      ref={host}
      role={interactive ? "button" : "img"}
      aria-label={label}
      tabIndex={interactive ? 0 : undefined}
      className="aspect-square max-w-full shrink-0 w-(--pet-size) h-(--pet-size)"
      style={{ "--pet-size": `${size}px` } as React.CSSProperties}
      onPointerDown={(e) => {
        if (!e.isPrimary) {
          input.current?.("cancel");
          return;
        }
        if (e.isPrimary && input.current?.("down", ...point(e)))
          e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) =>
        input.current?.(
          e.currentTarget.hasPointerCapture(e.pointerId) ? "move" : "hover",
          ...point(e),
        )
      }
      onPointerUp={(e) => {
        input.current?.("up");
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => input.current?.("cancel")}
      onPointerLeave={() => input.current?.("leave")}
      onBlur={() => input.current?.("cancel")}
      onFocus={() => input.current?.("focus")}
      onKeyDown={(e) => {
        if (e.repeat) return;
        if (
          [
            "Enter",
            " ",
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
          ].includes(e.key)
        ) {
          e.preventDefault();
          input.current?.(
            e.key === " " ? "down" : "key",
            undefined,
            undefined,
            e.key,
          );
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " ") {
          e.preventDefault();
          input.current?.("up");
        }
      }}
    >
      <canvas
        ref={canvas}
        aria-hidden
        className={fallback ? "hidden" : "block h-full w-full"}
      />
      {fallback && (
        <PetFallbackDrawing
          components={domPrimitives}
          size={size}
          resting={state === "resting"}
          appearance={appearance}
          geometry={still?.frame.geometry}
          face={still?.face}
          sign={still?.sign}
        />
      )}
    </div>
  );
}

const domPrimitives: PetSvgPrimitives = {
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

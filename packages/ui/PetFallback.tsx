import React, { useId } from "react";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  Ellipse,
  G,
  Path,
  RadialGradient,
  Stop,
} from "react-native-svg";
import { tokens as t } from "../design-tokens";
import { PET_COLORS, PET_COUNTS, PET_FOV, PET_RADIUS } from "./pet-motion";

// Same radial silhouette, face scale and droplet palette as the GL renderer.
const scale = 240 / (3.2 * PET_FOV),
  faceScale = 240 / ((3.2 - 0.365) * PET_FOV);
const x = (value: number) => 240 + value * scale;
const y = (value: number) => 240 - value * scale;
const body =
  Array.from({ length: 97 }, (_, i) => {
    const angle = (i / 96) * 2 * Math.PI;
    const radius = PET_RADIUS * (1 + 0.075 * Math.cos(9 * angle));
    return `${i ? "L" : "M"}${x(radius * Math.cos(angle))} ${y(radius * Math.sin(angle))}`;
  }).join(" ") + "Z";

export function PetFallback({
  size,
  resting,
  pleased = false,
}: {
  size: number;
  resting: boolean;
  pleased?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  return (
    <Svg width={size} height={size} viewBox="0 0 480 480" aria-hidden>
      <Defs>
        <RadialGradient id={`${id}body`} cx="42%" cy="36%" r="70%">
          <Stop offset="0" stopColor={t.color.pet.bodyLight} />
          <Stop offset="1" stopColor={t.color.pet.bodyDeep} />
        </RadialGradient>
        <ClipPath id={`${id}clip`}>
          <Path d={body} />
        </ClipPath>
        {PET_COLORS.map((color, i) => (
          <RadialGradient key={i} id={`${id}ink${i}`}>
            <Stop
              offset="0"
              stopColor={`rgb(${color.map((v) => Math.round(v * 255)).join(",")})`}
              stopOpacity={0.9}
            />
            <Stop
              offset="1"
              stopColor={`rgb(${color.map((v) => Math.round(v * 255)).join(",")})`}
              stopOpacity={0}
            />
          </RadialGradient>
        ))}
      </Defs>
      <Ellipse
        cx={240}
        cy={389}
        rx={110}
        ry={12}
        fill={t.color.pet.shadow}
        opacity={0.22}
      />
      <Path
        d={body}
        fill={`url(#${id}body)`}
        stroke={t.color.pet.rim}
        strokeOpacity={0.65}
        strokeWidth={2}
      />
      <G clipPath={`url(#${id}clip)`} opacity={resting ? 0.35 : 1}>
        {PET_COUNTS.map((count, i) => {
          if (!count) return null;
          const radius =
            Math.min(0.36, 0.17 + 0.05 * Math.sqrt(count)) * (PET_RADIUS / 0.8);
          const phase = i * 1.047 + 0.3,
            orbit = Math.max(0, PET_RADIUS * 0.4 - radius * 0.55);
          return (
            <Circle
              key={i}
              cx={x(resting ? (i - 2) * 0.182 : Math.cos(phase) * orbit)}
              cy={y(resting ? -0.385 : Math.sin(phase) * orbit * 0.75 - 0.056)}
              r={radius * scale * 1.3}
              fill={`url(#${id}ink${i})`}
            />
          );
        })}
        <Ellipse
          cx={x(-0.25)}
          cy={y(0.365)}
          rx={35}
          ry={13}
          fill={t.color.pet.highlight}
          opacity={0.22}
        />
      </G>
      {[-1, 1].map((side) => {
        const cx = 240 + side * 0.21 * faceScale,
          cy = 240 - 0.112 * faceScale;
        return resting || pleased ? (
          <Path
            key={side}
            d={`M${cx - 18} ${cy}q18 22 36 0`}
            fill="none"
            stroke={t.color.pet.face}
            strokeWidth={5}
            strokeLinecap="round"
          />
        ) : (
          <G key={side}>
            <Ellipse
              cx={cx}
              cy={cy}
              rx={0.078 * faceScale}
              ry={0.104 * faceScale}
              fill={t.color.pet.face}
              stroke={t.color.pet.eyeRim}
              strokeWidth={1.2}
            />
            <Circle
              cx={cx - 0.0234 * faceScale}
              cy={cy - 0.0468 * faceScale}
              r={0.0172 * faceScale}
              fill={t.color.pet.highlight}
              opacity={0.9}
            />
          </G>
        );
      })}
      {resting ? (
        <Ellipse cx={240} cy={255} rx={4} ry={5} fill={t.color.pet.face} />
      ) : (
        <Path
          d={
            pleased ? "M224 250 Q240 270 256 250" : "M227 251 Q240 263 253 251"
          }
          fill="none"
          stroke={t.color.pet.face}
          strokeWidth={4.5}
          strokeLinecap="round"
        />
      )}
    </Svg>
  );
}

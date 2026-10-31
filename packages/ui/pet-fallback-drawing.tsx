import { petBodyPath, petGeometry, type PetAppearance } from "./pet-motion";
import React, { useId } from "react";
import { tokens as t } from "../design-tokens";
import {
  PET_FACES,
  PET_SIGNS,
  type PetFace,
  type PetSignName,
} from "./pet-interaction";
import {
  petSignAnchor,
  PET_COLORS,
  PET_COUNTS,
  PET_FOV,
  PET_RADIUS,
} from "./pet-motion";

// Same radial silhouette, face scale and droplet palette as the GL renderer.
const scale = 240 / (3.2 * PET_FOV),
  faceScale = 240 / ((3.2 - 0.365) * PET_FOV);
const x = (value: number) => 240 + value * scale;
const y = (value: number) => 240 - value * scale;

export function PetFallbackDrawing({
  size,
  resting,
  pleased = false,
  face,
  sign,
  appearance,
  geometry,
  components,
}: {
  size: number;
  resting: boolean;
  pleased?: boolean;
  face?: PetFace;
  sign?: PetSignName | null;
  appearance?: PetAppearance;
  geometry?: ReturnType<typeof petGeometry>;
  components: PetSvgPrimitives;
}) {
  const {
    Svg,
    Circle,
    ClipPath,
    Defs,
    Ellipse,
    G,
    Path,
    RadialGradient,
    Stop,
  } = components;
  const body = petBodyPath(appearance, geometry);
  const id = useId().replace(/:/g, "");
  const expression = face ?? (pleased ? PET_FACES.happy : PET_FACES.neutral);
  const symbolColor = sign
    ? `rgb(${PET_SIGNS[sign].color.map((v) => Math.round(v * 255)).join(",")})`
    : t.color.pet.rim;
  const anchor = sign
    ? petSignAnchor(
        {
          leanX: 0,
          leanY: 0,
          stretch: 0,
          axis: Math.PI / 2,
          bob: 0,
          appearance,
          geometry,
        },
        PET_SIGNS[sign].kind,
        0,
      )
    : [0, 0];
  return (
    <Svg width={size} height={size} viewBox="0 0 480 480" aria-hidden>
      <Defs>
        <RadialGradient id={`${id}body`} cx="42%" cy="36%" r="70%">
          <Stop
            offset="0"
            stopColor={
              appearance?.tint
                ? `rgb(${appearance.tint.map((v) => Math.round(v * 255)).join(",")})`
                : t.color.pet.bodyLight
            }
          />
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
        {(appearance?.counts ?? PET_COUNTS).map((count, i) => {
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
      {expression.blush > 0.05
        ? [-1, 1].map((side) => (
            <Ellipse
              key={`blush${side}`}
              cx={240 + side * 55}
              cy={247}
              rx={17}
              ry={9}
              fill={t.color.tile.rose.background}
              opacity={expression.blush * 0.65}
            />
          ))
        : null}
      {[-1, 1].map((side) => {
        const cx = 240 + side * 0.21 * faceScale,
          cy = 240 - 0.112 * faceScale;
        const closed =
          resting ||
          expression.low >= 0.8 ||
          (expression.wink > 0 && side < 0) ||
          (expression.wink < 0 && side > 0);
        return closed ? (
          <Path
            key={side}
            d={`M${cx - 18} ${cy + 3} Q${cx} ${cy + (resting ? 17 : -14)} ${cx + 18} ${cy + 3}`}
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
              ry={
                0.104 *
                faceScale *
                Math.max(0.16, expression.open * Math.min(1, expression.lid))
              }
              fill={t.color.pet.face}
              stroke={t.color.pet.eyeRim}
              strokeWidth={1.2}
            />
            {expression.love > 0.2 ? (
              <Path
                d={`M${cx - 7} ${cy - 9} C${cx - 13} ${cy - 15} ${cx - 17} ${cy - 5} ${cx - 7} ${cy + 2} C${cx + 3} ${cy - 5} ${cx - 1} ${cy - 15} ${cx - 7} ${cy - 9}`}
                fill={t.color.pet.highlight}
              />
            ) : (
              <Circle
                cx={cx - 0.0234 * faceScale}
                cy={cy - 0.0468 * faceScale}
                r={0.0172 * faceScale}
                fill={t.color.pet.highlight}
                opacity={0.9}
              />
            )}
          </G>
        );
      })}
      {expression.mouth >= 0.15 || resting ? (
        <G>
          <Ellipse
            cx={240}
            cy={257}
            rx={resting ? 4 : 8 + expression.smile * 7}
            ry={resting ? 5 : 5 + expression.mouth * 14}
            fill={t.color.pet.face}
          />
          {expression.mouth > 0.5 && !resting ? (
            <Ellipse
              cx={240}
              cy={265}
              rx={7}
              ry={3}
              fill={t.color.tile.rose.background}
            />
          ) : null}
        </G>
      ) : (
        <Path
          d={`M227 251 Q240 ${251 + expression.smile * 15} 253 251`}
          fill="none"
          stroke={t.color.pet.face}
          strokeWidth={4.5}
          strokeLinecap="round"
        />
      )}
      {sign ? (
        <G
          transform={`translate(${240 * anchor[0]!} ${240 - 240 * anchor[1]! - 48})`}
          fill={symbolColor}
          stroke={t.color.pet.rim}
          strokeWidth={1.5}
        >
          {sign === "sparkle" ? (
            <Path d="M240 29 Q241 46 257 49 Q242 51 240 68 Q237 51 223 49 Q237 46 240 29 Z" />
          ) : null}
          {sign === "hearts" ? (
            <G>
              <Path d="M235 44 C219 26 207 48 235 69 C263 48 251 26 235 44 Z" />
              <Path d="M263 34 C254 24 248 36 263 47 C278 36 272 24 263 34 Z" />
            </G>
          ) : null}
          {sign === "notes" ? (
            <G>
              <Path
                d="M235 55 V31 L262 27 V50"
                fill="none"
                stroke={symbolColor}
                strokeWidth={6}
              />
              <Ellipse cx={228} cy={57} rx={9} ry={6} />
              <Ellipse cx={255} cy={52} rx={9} ry={6} />
            </G>
          ) : null}
          {sign === "bang" ? (
            <G>
              <Path d="M237 27 H244 L242 53 H239 Z" />
              <Circle cx={240.5} cy={63} r={4} />
            </G>
          ) : null}
          {sign === "sweat" ? (
            <Path d="M240 27 C235 38 222 48 229 59 C236 70 253 61 251 51 C250 43 243 35 240 27 Z" />
          ) : null}
          {sign === "zz" ? (
            <Path
              d="M220 48 H237 L220 64 H237 M246 29 H261 L246 44 H261"
              fill="none"
              stroke={symbolColor}
              strokeWidth={5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
          {sign === "dots"
            ? [-1, 0, 1].map((i) => (
                <Circle key={i} cx={240 + i * 14} cy={48} r={4} />
              ))
            : null}
        </G>
      ) : null}
    </Svg>
  );
}

export type PetSvgPrimitives = Record<
  | "Svg"
  | "Circle"
  | "ClipPath"
  | "Defs"
  | "Ellipse"
  | "G"
  | "Path"
  | "RadialGradient"
  | "Stop",
  React.ElementType
>;

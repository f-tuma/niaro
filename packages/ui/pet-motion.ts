import {
  createPetPlay,
  cancelPetPlay,
  pressPetPlay,
  movePetPlay,
  releasePetPlay,
  updatePetPlay,
  petNoise,
  PET_FACES,
  PET_SIGNS,
  type PetSign,
  type PetPlay,
  type PetPoint,
} from "./pet-interaction";
export type PetState =
  | "idle"
  | "listening"
  | "working"
  | "speaking"
  | "resting";
export type PetMotion = {
  time: number;
  level: number;
  touch: number;
  sleep: number;
  interaction?: PetInteraction;
};
export type PetInteraction = {
  pressed: boolean;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  stroke: number;
  acknowledgement: number;
  play: PetPlay;
};
export const createPetInteraction = (): PetInteraction => ({
  pressed: false,
  x: 0,
  y: 0,
  targetX: 0,
  targetY: 0,
  stroke: 0,
  acknowledgement: 0,
  play: createPetPlay(),
});

/** Conservative inner silhouette: transparent corners never take the scroll. */
export function petHitTest(x: number, y: number, size: number) {
  return petContactPoint(x, y, size) !== null;
}

export function resetPetInteraction(motion: PetMotion) {
  motion.touch = 0;
  const play = motion.interaction?.play;
  if (play) cancelPetPlay(play);
  motion.interaction = { ...createPetInteraction(), ...(play ? { play } : {}) };
}

/** A held finger has no repeating impulse; only distance adds soft attention. */
export function strokePet(
  motion: PetMotion,
  dx: number,
  dy: number,
  size: number,
) {
  const interaction = motion.interaction;
  if (!interaction?.pressed || !Number.isFinite(dx) || !Number.isFinite(dy))
    return;
  const length = Math.hypot(dx, dy);
  if (length < 0.5) return;
  const distance = Math.min(0.18, length / Math.max(16, size));
  interaction.stroke = Math.min(1, interaction.stroke + distance * 3);
  interaction.targetX = dx / length;
  interaction.targetY = dy / length;
}

export const PET_RADIUS = 0.7;
export const PET_FOV = 0.37;
// Fixed appearance from the approved study; these are not a user profile.
export const PET_COUNTS = [3, 2, 1, 1, 1, 0] as const;
export const PET_COLORS = [
  [0.36, 0.33, 0.86],
  [0.98, 0.45, 0.36],
  [0.12, 0.7, 0.66],
  [0.99, 0.72, 0.18],
  [0.93, 0.36, 0.66],
  [0.55, 0.8, 0.25],
] as const;
const clamp = (v: number) =>
  Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;

/** One clock for the dye: state changes never reset or accelerate its orbits. */
export function advancePetMotion(
  motion: PetMotion,
  dt: number,
  state: PetState,
  level: number,
  now?: number,
  reduced = false,
  occupied = false,
) {
  const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
  motion.time += step;
  const follow = 1 - Math.exp(-step / 0.16);
  motion.level +=
    ((state === "listening" ? clamp(level) : 0) - motion.level) * follow;
  motion.sleep +=
    ((state === "resting" ? 1 : 0) - motion.sleep) *
    (1 - Math.exp(-step / 0.4));
  const interaction = motion.interaction;
  if (interaction) {
    const followSign = (h: number) => {
      const emblem = interaction.play.sign;
      if (emblem) {
        const pose = petFrame(motion, state, reduced),
          anchor = petSignAnchor(
            pose,
            emblem.kind,
            interaction.play.now - emblem.at,
          );
        if (!emblem.anchorInitialized) {
          emblem.x.x = emblem.x.t = anchor[0];
          emblem.y.x = emblem.y.t = anchor[1];
          emblem.anchorInitialized = true;
        }
        emblem.x.t = anchor[0];
        emblem.y.t = anchor[1];
        if (!reduced) {
          emblem.x.step(h);
          emblem.y.step(h);
        }
      }
    };
    updatePetPlay(
      interaction.play,
      step,
      now ?? motion.time,
      state,
      reduced,
      occupied,
      followSign,
    );
    if (reduced || !step) followSign(0);
    interaction.acknowledgement *= Math.exp(-step / 0.28);
    interaction.stroke *= Math.exp(-step / 0.45);
    const interactive = state === "idle";
    const target = interactive
      ? Math.max(
          interaction.acknowledgement,
          interaction.pressed ? 0.25 + interaction.stroke * 0.65 : 0,
        )
      : 0;
    motion.touch += (target - motion.touch) * (1 - Math.exp(-step / 0.08));
    const direction = interactive && interaction.pressed ? 1 : 0;
    interaction.x += (interaction.targetX * direction - interaction.x) * follow;
    interaction.y += (interaction.targetY * direction - interaction.y) * follow;
  } else motion.touch *= Math.exp(-step / 0.3);
}

/** One frame feeds GL, native/SVG fallback, geometry hit tests and their shared transform. */
export function petFrame(
  motion: PetMotion,
  state: PetState,
  reduced: boolean,
  pixels = 480,
) {
  const time = reduced ? 2 : motion.time;
  const ch = motion.interaction?.play.ch;
  const bodySleep = reduced
    ? +(state === "resting")
    : (ch?.sleep.x ?? motion.sleep);
  const active = state === "idle" || state === "resting";
  const p = active ? motion.interaction?.play : undefined;
  const face = p?.face ?? PET_FACES.neutral;
  const legacyTouch = !p && !reduced && state === "idle" ? motion.touch : 0;
  const blink = reduced ? 1 : (ch?.frameBlink ?? 1);
  const sleep = reduced
    ? bodySleep
    : Math.max(bodySleep * (1 - (ch?.stir ?? 0)), ch?.doze.x ?? 0);
  const catT = p ? p.now - p.ch.catAt : -1;
  const catSmile =
    catT < 0 || catT >= 1.51
      ? 0
      : 0.15 * smooth(0, 0.2, catT) * (1 - smooth(1.16, 1.51, catT));
  const laugh =
    !reduced && p && p.now < p.ch.laughUntil
      ? 0.035 *
        Math.sin(2 * Math.PI * 4.8 * (p.now - p.ch.laughAt)) *
        smooth(0, 0.12, p.now - p.ch.laughAt) *
        (1 - smooth(p.ch.laughUntil - 0.3, p.ch.laughUntil, p.now))
      : 0;
  const oW =
    smooth(0.35, 0.85, bodySleep * (1 - (ch?.stir ?? 0))) *
    (1 - (ch?.quiet ?? 0));
  const o = reduced
    ? 0.2
    : 0.2 + 0.04 * (2 * breathCurve(ch?.breath.phase ?? 0) - 1);
  const emblem = p?.sign;
  const age = emblem ? p!.now - emblem.at : -1;
  const sign = emblem && age >= 0 ? PET_SIGNS[emblem.name] : undefined;
  const frame = {
    time,
    bodySleep,
    sleep,
    eyeSleep: Math.max(bodySleep, reduced ? 0 : (ch?.doze.x ?? 0)),
    inkTime: reduced ? 2 : (ch?.inkClock ?? motion.time),
    lagX: reduced ? 0 : (ch?.sloshX.x ?? 0) - (p?.leanX.x ?? 0) * 0.12,
    lagY: reduced ? 0 : (ch?.sloshY.x ?? 0) - (ch?.frameBob ?? 0),
    blink,
    stretch: reduced
      ? 0
      : Math.max(
          -0.05,
          Math.min(
            0.05,
            (ch?.frameStretch ?? Math.sin(time * 1.35) * 0.004) +
              motion.level * 0.014 -
              legacyTouch * 0.02,
          ),
        ),
    bob: reduced ? 0 : (ch?.frameBob ?? Math.sin(time * 1.1) * 0.003),
    gazeX: reduced
      ? 0
      : Math.max(
          -1,
          Math.min(
            1,
            (p?.gazeX.x ?? 0) + 0.5 * ((p?.gazeX.x ?? 0) - (p?.leanX.x ?? 0)),
          ),
        ),
    gazeY: reduced
      ? 0
      : Math.max(
          -1,
          Math.min(
            1,
            (p?.gazeY.x ?? 0) + 0.5 * ((p?.gazeY.x ?? 0) - (p?.leanY.x ?? 0)),
          ),
        ),
    leanX: reduced
      ? 0
      : Math.max(-1, Math.min(1, (p?.leanX.x ?? 0) + (ch?.sway ?? 0))),
    leanY: reduced ? 0 : (p?.leanY.x ?? 0),
    tilt: reduced ? 0 : (p?.leanX.x ?? 0) * 0.16,
    axis: p?.axis ?? Math.PI / 2,
    open: face.open,
    lid:
      Math.max(0, Math.min(1.1, face.lid)) *
      (1 - 0.15 * Math.max(0, -(p?.gazeY.x ?? 0))),
    pleased: face.low + legacyTouch * 0.55,
    faceTilt: face.tilt,
    love: Math.max(0, Math.min(1, face.love)),
    wink: face.wink,
    asym: face.asym,
    roll: reduced ? 0 : face.roll + laugh,
    smile: face.smile + catSmile + legacyTouch * 0.45,
    blush: face.blush + legacyTouch * 0.5,
    wave: face.wave,
    mouth:
      state === "speaking" && !reduced
        ? 0.18 + 0.03 * Math.sin(time * 3)
        : Math.max(0, face.mouth + (o - face.mouth) * oW),
    dent: reduced ? 0 : Math.max(0, p?.dent.x ?? 0) * 0.03 * PET_RADIUS,
    dentPoint: p?.point ?? null,
    sign: sign
      ? {
          kind: sign.kind,
          color: sign.color,
          scale: reduced
            ? 1
            : emblem!.scale.x *
              (1 + 0.18 * Math.exp(-(p!.now - emblem!.bumpAt) / 0.09)),
          opacity: reduced ? 1 : emblem!.opacity.x,
          formed: reduced ? 1 : emblem!.material,
          x: 0,
          y: 0,
          rotation: 0,
          sx: 1,
          sy: 1,
          w: 1,
          w2: 0,
          age,
        }
      : null,
    faceName: p?.faceName ?? "neutral",
  };
  if (frame.sign && emblem)
    Object.assign(
      frame.sign,
      petSignAppearance(frame, emblem, reduced, pixels, age),
    );
  return frame;
}
export type PetFrame = ReturnType<typeof petFrame>;

type PetPose = {
  leanX: number;
  leanY: number;
  stretch: number;
  axis: number;
  bob: number;
};
/** Original fromLocal()/toUv(), inverse of the exact affine sent to the shader. */
export function petToUv(v: PetPose, point: readonly number[]) {
  let [x, y, z] = point as [number, number, number];
  y += 0.4 * PET_RADIUS;
  const ca = Math.cos(v.axis),
    sa = Math.sin(v.axis),
    sy = 1 + v.stretch,
    isx = Math.sqrt(sy);
  const pb = x * sa - y * ca,
    pa = x * ca + y * sa;
  [x, y, z] = [
    (pb / isx) * sa + pa * sy * ca,
    pa * sy * sa - (pb / isx) * ca - 0.4 * PET_RADIUS,
    z / isx,
  ];
  const ay = -v.leanX * 0.16,
    ax = -v.leanY * 0.12;
  let c = Math.cos(ax),
    s = Math.sin(ax);
  [y, z] = [c * y - s * z, s * y + c * z];
  c = Math.cos(ay);
  s = Math.sin(ay);
  [x, z] = [c * x - s * z, s * x + c * z];
  y += v.bob;
  const scale = 1 / ((3.2 - z) * PET_FOV);
  return [x * scale, y * scale] as const;
}
/** Verbatim prototype signAt geometry: projected upper-right crown, arc clamp, temple drop. */
export function petSignAnchor(v: PetPose, kind: number, age: number) {
  const camS = 3.2 * PET_FOV;
  if (kind === 5) {
    const u = Math.max(0, Math.min(1, (age - 0.15) / 1.1)),
      th = 0.55 - 0.1 * u * u,
      r = PET_RADIUS * (1 + 0.075 * Math.cos(9 * th));
    const q = petToUv(v, [r * Math.cos(th), r * Math.sin(th), 0]);
    return [q[0] + 0.026 * Math.cos(th), q[1] + 0.026 * Math.sin(th)] as const;
  }
  let ex = (0.52 * PET_RADIUS) / camS + 0.1 + 0.05 * v.leanX,
    ey = petToUv(v, [0, PET_RADIUS, 0])[1] + 0.1 + 0.03 * v.leanY;
  if (ey > 0.772) {
    const cy = v.bob / camS,
      rr = Math.hypot(ex, ey - cy);
    ey = 0.772;
    ex = Math.max(ex, Math.sqrt(Math.max(0, rr * rr - (ey - cy) ** 2)));
  }
  return [Math.min(ex, 0.7), ey] as const;
}
const signExt = [
  [0, 0],
  [1.15, 1],
  [1.15, 0.95],
  [0.3, 0.85],
  [1.05, 1.1],
  [0.5, 0.75],
  [0.75, 0.75],
  [0.7, 0.2],
];
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const fbm = petNoise;
const breathCurve = (p: number) =>
  p < 0.38
    ? 0.5 - 0.5 * Math.cos((Math.PI * p) / 0.38)
    : p < 0.85
      ? 0.5 + 0.5 * Math.cos((Math.PI * (p - 0.38)) / 0.47)
      : 0;
const thump = (u: number) => (u <= 0 ? 0 : (u / 0.05) * Math.exp(1 - u / 0.05));
const popAt = (t: number) =>
  t <= 0
    ? 0
    : 1 -
      Math.exp(-16.98 * t) * (Math.cos(22.64 * t) + 0.75 * Math.sin(22.64 * t));
/** Original per-kind signLook, including multipart motion, condensation and actual pixel margin. */
function petSignAppearance(
  v: PetPose,
  e: PetSign,
  still: boolean,
  pixels: number,
  t: number,
) {
  let dx = 0,
    dy = 0,
    rotation = 0,
    sx = 1,
    sy = 1,
    w = kDefault(e.kind),
    w2 = e.kind === 6 ? 1 : 0,
    float = 0.008 * fbm(1.2 * t + 5.1 * e.kind);
  const k = e.kind;
  if (still) float = 0;
  else if (k === 1) {
    rotation = 0.2 * Math.sin(2.2 * t) * Math.exp(-t);
    w = popAt(t - 0.12) * (0.8 + 0.2 * Math.cos(9 * t));
  } else if (k === 2) {
    const b = Math.abs(Math.sin(6.5 * t));
    dy = 0.1 * b;
    rotation = 0.14 * Math.sin(6.5 * t);
    w = popAt(t - 0.15);
    w2 = 0.08 * Math.abs(Math.cos(6.5 * t)) - 0.1 * b;
  } else if (k === 3) {
    if (t < 0.035) {
      sx = 0.8;
      sy = 1.25;
    }
    dx = 0.06 * Math.sin(110 * t) * Math.exp(-18 * t);
    float = 0;
  } else if (k === 4) {
    const u = Math.max(0, t - 0.3) % 0.9;
    sx = sy = 1 + 0.12 * thump(u) + 0.07 * thump(u - 0.18);
    dy = 0.15 * Math.min(t, 1.4);
    w2 = 0.35 * smooth(0, 1.4, t);
  } else if (k === 5) {
    sy = 1 + 0.08 * Math.min(1, t);
    rotation = -0.2;
    float = 0;
  } else if (k === 6) {
    const a = 2 * Math.PI * ((0.55 * t) % 1);
    w = Math.sin(a);
    w2 = Math.cos(a);
  } else if (k === 7) w = Math.min(3, (e.fresh ? 0 : 1) + t / 0.25);
  const now = e.at + t,
    scale = still
      ? 1
      : e.scale.x * (1 + 0.18 * Math.exp(-(now - e.bumpAt) / 0.09)),
    S = 0.12 * scale;
  const anchor =
    still || !e.anchorInitialized ? petSignAnchor(v, k, 0) : [e.x.x, e.y.x];
  const rise =
    !still && e.phase === "out"
      ? 0.03 * smooth(e.until - 0.22, e.until, now)
      : 0;
  const m = 16 / Math.max(1, pixels),
    g = S * Math.max(sx, sy) * 1.05,
    ext = signExt[k]!;
  return {
    scale,
    opacity: still ? 1 : e.opacity.x,
    formed: still ? 1 : e.material,
    rotation,
    sx,
    sy,
    w,
    w2,
    x: Math.min(anchor[0]! + dx * S, 1 - m - ext[0]! * g),
    y: Math.min(anchor[1]! + dy * S + float + rise, 1 - m - ext[1]! * g),
  };
}
const kDefault = (k: number) => (k === 7 ? 3 : k === 6 ? 0 : 1);

/** Identical CPU affine matrix for shader geometry and local-space touch classification. */
export function petTransform(frame: PetPose, out = new Float32Array(9)) {
  const ay = -frame.leanX * 0.16,
    ax = -frame.leanY * 0.12,
    cy = Math.cos(ay),
    sy = Math.sin(ay),
    cx = Math.cos(ax),
    sx = Math.sin(ax);
  out[0] = cy;
  out[1] = -sx * sy;
  out[2] = -cx * sy;
  out[3] = 0;
  out[4] = cx;
  out[5] = -sx;
  out[6] = sy;
  out[7] = sx * cy;
  out[8] = cx * cy;
  const isx = Math.sqrt(1 + frame.stretch),
    iy = 1 / (1 + frame.stretch),
    ca = Math.cos(frame.axis),
    sa = Math.sin(frame.axis);
  const xx = isx * sa * sa + iy * ca * ca,
    xy = (iy - isx) * ca * sa,
    yy = isx * ca * ca + iy * sa * sa;
  for (let c = 0; c < 9; c += 3) {
    const x = out[c]!,
      y = out[c + 1]!;
    out[c] = xx * x + xy * y;
    out[c + 1] = xy * x + yy * y;
    out[c + 2] = out[c + 2]! * isx;
  }
  return {
    matrix: out,
    offsetX: 0.4 * PET_RADIUS * xy,
    offsetY: 0.4 * PET_RADIUS * (yy - 1),
  };
}
export function petContactPoint(
  x: number,
  y: number,
  size: number,
  motion?: PetMotion,
  state: PetState = "idle",
): PetPoint | null {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(size) ||
    size <= 0
  )
    return null;
  const frame = petFrame(
      motion ?? { time: 2, level: 0, touch: 0, sleep: 0 },
      state,
      false,
    ),
    { matrix: r, offsetX, offsetY } = petTransform(frame);
  const u = ((2 * x) / size - 1) * PET_FOV,
    w = (1 - (2 * y) / size) * PET_FOV,
    n = Math.hypot(u, w, 1),
    dx = u / n,
    dy = w / n,
    dz = -1 / n;
  const local = (t: number) => {
    const X = dx * t,
      Y = dy * t - frame.bob,
      Z = 3.2 + dz * t;
    return [
      r[0]! * X + r[3]! * Y + r[6]! * Z + offsetX,
      r[1]! * X + r[4]! * Y + r[7]! * Z + offsetY,
      r[2]! * X + r[5]! * Y + r[8]! * Z,
    ];
  };
  let t = 1.8,
    q = local(t),
    hit = false;
  for (let i = 0; i < 80; i++) {
    q = local(t);
    const L = Math.hypot(q[0]!, q[1]!),
      a = Math.atan2(q[1]!, q[0]!);
    const f = Math.max(0, Math.min(1, (L - 0.05) / 0.3));
    const smooth = f * f * (3 - 2 * f);
    const d2 =
      (L - PET_RADIUS * (1 + 0.075 * Math.cos(9 * a) * smooth)) / 1.675;
    const d = Math.hypot(Math.max(d2 + 0.42, 0), q[2]! * 1.15) - 0.42;
    if (d < 0.001) {
      hit = true;
      break;
    }
    t += d * 0.8;
    if (t > 4.8) break;
  }
  if (!hit) return null;
  const c = Math.cos(frame.roll),
    s = Math.sin(frame.roll),
    py = 0.05 * PET_RADIUS;
  const fx = c * q[0]! - s * (q[1]! - py),
    fy = s * q[0]! + c * (q[1]! - py) + py;
  const ex = 0.21,
    ey = 0.112,
    gx = fx - frame.gazeX * 0.035 * PET_RADIUS,
    gy = fy - frame.gazeY * 0.025 * PET_RADIUS;
  let zone: PetPoint["zone"] = "body",
    side = 0;
  for (const sd of [-1, 1]) {
    if (
      Math.hypot(
        (gx - sd * ex) / 0.078,
        (gy - ey) / (0.104 * Math.max(0.05, frame.open)),
      ) < 1.3
    ) {
      zone = "eye";
      side = sd;
      break;
    }
    if (
      Math.hypot(fx - sd * (ex + 0.035), fy - (ey - 0.135)) <
      0.12 * PET_RADIUS
    ) {
      zone = "cheek";
      side = sd;
      break;
    }
  }
  if (zone === "body") {
    if (q[1]! > ey + 0.3 * PET_RADIUS) zone = "top";
    else if (q[1]! < ey - 0.4 * PET_RADIUS) zone = "low";
    else if (Math.hypot(q[0]!, q[1]!) > 0.8 * PET_RADIUS) zone = "rim";
  }
  return { x: q[0]!, y: q[1]!, z: q[2]!, logicalX: x, logicalY: y, zone, side };
}
export function pressPet(
  motion: PetMotion,
  x: number,
  y: number,
  size: number,
  now: number,
  state: PetState = "idle",
  reduced = false,
  sampleTime = now,
) {
  const point = petContactPoint(x, y, size, motion, state);
  if (!point) return false;
  motion.interaction ??= createPetInteraction();
  motion.interaction.pressed = true;
  pressPetPlay(motion.interaction.play, point, now, state, reduced, sampleTime);
  return true;
}
export function movePet(
  motion: PetMotion,
  x: number,
  y: number,
  size: number,
  now: number,
  state: PetState = "idle",
  sampleTime = now,
) {
  const point = petContactPoint(x, y, size, motion, state);
  if (!point) {
    resetPetInteraction(motion);
    return false;
  }
  if (motion.interaction)
    movePetPlay(motion.interaction.play, point, now, sampleTime);
  return true;
}
export function releasePet(
  motion: PetMotion,
  now: number,
  cancel = false,
  reduced = false,
) {
  const interaction = motion.interaction;
  if (!interaction) return false;
  interaction.pressed = false;
  return releasePetPlay(interaction.play, now, cancel, reduced);
}

export function petRenderSize(size: number, pixelRatio: number) {
  const logical = Number.isFinite(size)
    ? Math.max(16, Math.min(480, size))
    : 156;
  const density = Number.isFinite(pixelRatio) ? Math.max(1, pixelRatio) : 1;
  const pixels = Math.round(Math.min(480, logical * Math.min(2, density)));
  return { logical, pixels, surface: pixels / density };
}

/** Original refreshNow / stable-vsync divider; no accumulated catch-up draws. */
export function createPetCadence() {
  return {
    gaps: new Float32Array(30),
    sorted: new Float32Array(30),
    count: 0,
    previous: 0,
    refresh: 1000 / 60,
    dividers: new Map<number, number>(),
    lastDraw: 0,
    drawn: false,
  };
}
export function petCadenceDue(
  c: ReturnType<typeof createPetCadence>,
  now: number,
  fps = 30,
  force = false,
) {
  if (!Number.isFinite(now)) return false;
  if (c.previous) {
    const d = now - c.previous;
    if (d > 3 && d < 60) {
      c.gaps[c.count++ % 30] = d;
      if (c.count >= 6) {
        const m = Math.min(c.count, 30);
        c.sorted.set(c.gaps);
        if (m < 30) c.sorted.fill(Infinity, m);
        c.sorted.sort();
        let j = 1;
        const limit = 1.5 * c.sorted[Math.floor(0.2 * m)]!;
        while (j < m && c.sorted[j]! < limit) j++;
        c.refresh = c.sorted[j >> 1]!;
      }
    }
  }
  c.previous = now;
  const ratio = 1000 / fps / c.refresh + 0.1,
    lo = Math.max(
      Math.ceil(15.5 / c.refresh),
      Math.ceil(1000 / (30 * c.refresh) - 0.1),
    );
  let n = c.dividers.get(fps) ?? 0;
  if (!n || n < lo || Math.abs(ratio - n) > 0.6) {
    n = Math.max(1, Math.round(ratio), lo);
    c.dividers.set(fps, n);
  }
  if (force || !c.drawn || now - c.lastDraw >= (n - 0.5) * c.refresh) {
    c.drawn = true;
    c.lastDraw = now;
    return true;
  }
  return false;
}

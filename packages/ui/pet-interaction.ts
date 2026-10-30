/** Local-only interaction channels ported from the approved Niaro pet study. */
export type PetFace = {
  open: number;
  lid: number;
  low: number;
  tilt: number;
  love: number;
  wink: number;
  smile: number;
  mouth: number;
  blush: number;
  wave: number;
  asym: number;
  roll: number;
};
export type PetFaceName =
  | "neutral"
  | "happy"
  | "giggle"
  | "laugh"
  | "surprise"
  | "wink"
  | "love"
  | "pat"
  | "shy"
  | "content"
  | "bliss"
  | "moment"
  | "mumble"
  | "stir"
  | "sleepy"
  | "curious"
  | "yawn"
  | "stretch"
  | "sheepish"
  | "sunny"
  | "glum"
  | "cozy"
  | "worried"
  | "transform";
export type PetZone = "body" | "top" | "eye" | "cheek" | "low" | "rim";
export type PetPoint = {
  x: number;
  y: number;
  z: number;
  logicalX: number;
  logicalY: number;
  zone: PetZone;
  side?: number;
};
export type PetPlayState =
  | "idle"
  | "resting"
  | "listening"
  | "working"
  | "speaking";
export type PetSignName =
  | "sparkle"
  | "notes"
  | "bang"
  | "hearts"
  | "sweat"
  | "zz"
  | "dots";
const preset = (values: Partial<PetFace> = {}): PetFace => ({
  open: 1,
  lid: 1,
  low: 0,
  tilt: 0,
  love: 0,
  wink: 0,
  smile: 0,
  mouth: 0,
  blush: 0,
  wave: 0,
  asym: 0,
  roll: 0,
  ...values,
});
// Original study presets, including its intentionally restrained closed happy mouth.
export const PET_FACES: Record<PetFaceName, PetFace> = {
  sunny: preset({ low: 0.3, smile: 0.9, blush: 0.25 }),
  glum: preset({ open: 0.95, lid: 0.72, tilt: 0.7, smile: -0.45 }),
  cozy: preset({
    open: 0.95,
    lid: 0.78,
    low: 0.35,
    tilt: 0.2,
    smile: 0.5,
    blush: 1,
  }),
  worried: preset({
    open: 1.12,
    lid: 0.95,
    low: 0.15,
    tilt: 0.9,
    smile: -0.6,
    wave: 1,
  }),
  sheepish: preset({
    lid: 0.9,
    low: 0.3,
    tilt: 0.4,
    smile: 0.4,
    wave: 0.4,
    blush: 0.7,
    asym: 0.05,
  }),
  transform: preset({ lid: 0.15, low: 0.4, smile: 0.6 }),
  stretch: preset({ lid: 0.55, low: 1.3, smile: 0.8, blush: 0.2 }),
  neutral: preset({ smile: 0.45 }),
  happy: preset({ low: 0.85, smile: 1, blush: 0.45 }),
  giggle: preset({ low: 1.05, tilt: 0.1, smile: 1, mouth: 0.8, blush: 0.6 }),
  laugh: preset({ low: 1.6, tilt: 0.1, smile: 1, mouth: 0.95, blush: 0.75 }),
  surprise: preset({ open: 1.28, tilt: 0.35, mouth: 0.6 }),
  wink: preset({ low: 0.3, wink: 1, smile: 1, blush: 0.35 }),
  love: preset({ open: 1.12, low: 0.35, love: 1, smile: 0.95, blush: 1 }),
  pat: preset({ lid: 0.55, low: 1.4, smile: 0.85, blush: 0.5 }),
  shy: preset({ low: 0.5, tilt: 0.15, smile: 0.7, blush: 0.9, asym: 0.04 }),
  content: preset({ lid: 0.55, low: 0.6, smile: 0.85, blush: 0.5 }),
  bliss: preset({ lid: 0.12, low: 0.6, smile: 0.95, blush: 0.95 }),
  moment: preset({ lid: 0.8, low: 0.2, tilt: 0.3, smile: 0.2, asym: 0.05 }),
  mumble: preset({ lid: 0.42, tilt: 0.15, smile: 0.6, wave: 0.5 }),
  stir: preset({
    lid: 0.3,
    tilt: 0.3,
    wink: 1,
    smile: -0.1,
    wave: 0.6,
    roll: -0.08,
  }),
  sleepy: preset({ lid: 0.42, tilt: 0.15, smile: 0.15 }),
  curious: preset({
    open: 1.08,
    low: 0.1,
    tilt: -0.25,
    smile: 0.2,
    asym: 0.05,
    roll: 0.12,
  }),
  yawn: preset({ lid: 0, tilt: 0.2, mouth: 0.95 }),
};
export const PET_SIGNS: Record<
  PetSignName,
  { kind: number; color: readonly number[] }
> = {
  sparkle: { kind: 1, color: [1, 0.92, 0.6] },
  notes: { kind: 2, color: [0.78, 0.74, 1] },
  bang: { kind: 3, color: [1, 0.72, 0.45] },
  hearts: { kind: 4, color: [1, 0.6, 0.72] },
  sweat: { kind: 5, color: [0.62, 0.82, 1] },
  zz: { kind: 6, color: [0.8, 0.78, 1] },
  dots: { kind: 7, color: [0.85, 0.85, 0.92] },
};
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/** The study's exact damped spring: retargets preserve velocity across frame rates. */
export class PetSpring {
  t: number;
  v = 0;
  constructor(
    public x = 0,
    public z = 1,
    public w = 10,
  ) {
    this.t = x;
  }
  step(dt: number) {
    const { z, w } = this,
      x0 = this.x - this.t,
      v0 = this.v;
    if (z < 1) {
      const a = w * Math.sqrt(1 - z * z),
        E = Math.exp(-z * w * dt),
        c = Math.cos(a * dt),
        s = Math.sin(a * dt);
      this.x = this.t + E * (x0 * (c + ((z * w) / a) * s) + (v0 * s) / a);
      this.v = E * (v0 * (c - ((z * w) / a) * s) - ((x0 * w * w) / a) * s);
    } else {
      const E = Math.exp(-w * dt);
      this.x = this.t + E * (x0 * (1 + w * dt) + v0 * dt);
      this.v = E * (v0 * (1 - w * dt) - x0 * w * w * dt);
    }
    return this.x;
  }
  get busy() {
    return Math.abs(this.v) > 1e-3 || Math.abs(this.x - this.t) > 1e-3;
  }
}
const faceKeys = Object.keys(PET_FACES.neutral) as (keyof PetFace)[];
type TimedEffect = { at: number; generation: number; run: () => void };
const CAT = [
  [0, 1],
  [0.09, 0.55],
  [0.18, 1],
  [0.27, 0.55],
  [0.36, 1],
  [0.56, 0.3],
  [1.16, 0.3],
  [1.51, 1],
] as const;
const faceChannels: Partial<
  Record<
    keyof PetFace,
    {
      attack: readonly [number, number];
      release: readonly [number, number];
      delay?: number;
    }
  >
> = {
  open: { attack: [0.45, 45], release: [0.95, 16.5] },
  lid: { attack: [0.65, 39], release: [0.95, 16.5] },
  low: { attack: [0.65, 39], release: [0.95, 16.5] },
  tilt: { attack: [0.65, 39], release: [0.95, 16.5] },
  asym: { attack: [0.65, 39], release: [0.95, 16.5] },
  mouth: { attack: [0.7, 35], release: [1, 18], delay: 0.04 },
  smile: { attack: [0.7, 31], release: [1, 14], delay: 0.05 },
  wink: { attack: [0.8, 70], release: [1, 28] },
  love: { attack: [0.8, 25], release: [1, 12.5] },
  wave: { attack: [0.8, 25], release: [1, 12.5] },
  roll: { attack: [0.8, 25], release: [1, 12.5] },
};
const curve = (phase: number) =>
  phase < 0.38
    ? 0.5 - 0.5 * Math.cos((Math.PI * phase) / 0.38)
    : phase < 0.85
      ? 0.5 + 0.5 * Math.cos((Math.PI * (phase - 0.38)) / 0.47)
      : 0;
const ss = (a: number, b: number, value: number) => {
  const f = clamp((value - a) / (b - a), 0, 1);
  return f * f * (3 - 2 * f);
};
export const petNoise = (x: number) => {
  const hash = (value: number) => {
    let n = Math.imul(value ^ 0x27d4eb2d, 0x165667b1);
    n ^= n >>> 15;
    n = Math.imul(n, 0x85ebca6b);
    n ^= n >>> 13;
    return ((n >>> 0) / 4294967296) * 2 - 1;
  };
  const noise = (v: number) => {
    const i = Math.floor(v),
      f = v - i,
      u = f * f * f * (f * (f * 6 - 15) + 10);
    return 2 * ((1 - u) * hash(i) * f + u * hash(i + 1) * (f - 1));
  };
  return (noise(x) + 0.5 * noise(x * 2.07 + 13.1)) / 1.5;
};
const half = (value: number, target: number, life: number, dt: number) =>
  target + (value - target) * Math.pow(2, -dt / life);
type Choreography = {
  initialized: boolean;
  asleepWas: boolean;
  sleepGeneration: number;
  dozeUp: boolean;
  inkClock: number;
  seed: number;
  idleSeed: number;
  timeline: TimedEffect[];
  generation: number;
  faceAt: number;
  attack: boolean;
  lastReaction: number;
  faceGeneration: number;
  bodyGeneration: number;
  hopGeneration: number;
  leanGeneration: number;
  breath: {
    phase: number;
    period: number;
    amplitude: number;
    previous: number;
    sigh: number;
  };
  hop: PetSpring;
  axis: PetSpring;
  sloshX: PetSpring;
  sloshY: PetSpring;
  inkStir: PetSpring;
  sleep: PetSpring;
  sink: PetSpring;
  doze: PetSpring;
  blink: {
    next: number;
    start: number;
    close: number;
    holdTime: number;
    open: number;
    holdUntil: number;
    depth: number;
    double: boolean;
    evoked: number;
    soft: boolean;
  };
  catAt: number;
  slowAt: number;
  laughAt: number;
  laughUntil: number;
  stir: number;
  stirTarget: number;
  turn: number;
  turns: number;
  quiet: number;
  lastInput: number;
  lookAt: number;
  lookX: number;
  lookY: number;
  lookNear: boolean;
  fixX: number;
  fixY: number;
  nextFix: number;
  glanceUntil: number;
  glanceEnd: number;
  lookBudget: number;
  idleNext: number;
  idleLast: string;
  idleBag: string[];
  idleRan: Record<string, number>;
  idleCurrent: { name: string; at: number; until: number; side: number } | null;
  idleGeneration: number;
  idleSignAt: number;
  idleDotsAt: number;
  frameStretch: number;
  frameBob: number;
  frameBlink: number;
  breathLift: number;
  breathStretch: number;
  sway: number;
  nextZz: number;
  previousBag: number;
};
function createChoreography(): Choreography {
  return {
    initialized: false,
    asleepWas: false,
    sleepGeneration: 0,
    dozeUp: false,
    inkClock: 2,
    seed: 1,
    idleSeed: 0x2545f491,
    timeline: [],
    generation: 0,
    faceAt: 0,
    attack: false,
    lastReaction: -Infinity,
    faceGeneration: 0,
    bodyGeneration: 0,
    hopGeneration: 0,
    leanGeneration: 0,
    breath: {
      phase: 0.95,
      period: 3.6,
      amplitude: 0.0105,
      previous: 0.0105,
      sigh: 0,
    },
    hop: new PetSpring(0, 0.5, 14),
    axis: new PetSpring(Math.PI / 2, 1, 12),
    sloshX: new PetSpring(0, 0.85, 11.3),
    sloshY: new PetSpring(0, 0.85, 11.3),
    inkStir: new PetSpring(1, 1, 6),
    sleep: new PetSpring(0, 1, (2 * Math.PI) / 2.2),
    sink: new PetSpring(0, 1, 4),
    doze: new PetSpring(0, 1, (2 * Math.PI) / 4),
    blink: {
      next: 3,
      start: -1,
      close: 0.075,
      holdTime: 0.045,
      open: 0.15,
      holdUntil: -Infinity,
      depth: 1,
      double: false,
      evoked: -Infinity,
      soft: false,
    },
    catAt: -Infinity,
    slowAt: -Infinity,
    laughAt: -Infinity,
    laughUntil: -Infinity,
    stir: 0,
    stirTarget: 0,
    turn: 0,
    turns: 0,
    quiet: 0,
    lastInput: 0,
    lookAt: -Infinity,
    lookX: 0,
    lookY: 0,
    lookNear: false,
    fixX: 0,
    fixY: 0,
    nextFix: 0,
    glanceUntil: 0,
    glanceEnd: 0,
    lookBudget: 3,
    idleNext: 9,
    idleLast: "",
    idleBag: [],
    idleRan: {},
    idleCurrent: null,
    idleGeneration: 0,
    idleSignAt: -Infinity,
    idleDotsAt: -Infinity,
    frameStretch: 0,
    frameBob: 0,
    frameBlink: 1,
    breathLift: 0,
    breathStretch: 0,
    sway: 0,
    nextZz: 4,
    previousBag: -1,
  };
}
function random(p: PetPlay, idle = false) {
  const c = p.ch,
    key = idle ? "idleSeed" : "seed";
  c[key] = (c[key] + 0x6d2b79f5) >>> 0;
  let t = c[key];
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gaussian(p: PetPlay, idle = false) {
  let u = 0;
  while (!u) u = random(p, idle);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random(p, idle));
}
function logNormal(
  p: PetPlay,
  median: number,
  sigma: number,
  lo: number,
  hi: number,
  idle = false,
) {
  return clamp(median * Math.exp(sigma * gaussian(p, idle)), lo, hi);
}
function later(p: PetPlay, delay: number, run: () => void) {
  p.ch.timeline.push({ at: p.now + delay, generation: p.ch.generation, run });
}
function runTimeline(p: PetPlay, now: number) {
  const c = p.ch;
  let fired = 0;
  for (;;) {
    let index = -1,
      at = Infinity;
    for (let i = 0; i < c.timeline.length; i++)
      if (c.timeline[i]!.at <= now && c.timeline[i]!.at < at) {
        at = c.timeline[i]!.at;
        index = i;
      }
    if (index < 0 || fired++ > 128) break;
    const [event] = c.timeline.splice(index, 1);
    if (event!.generation === c.generation) {
      const time = p.now;
      p.now = event!.at;
      event!.run();
      p.now = time;
    }
  }
}
function kick(p: PetPlay) {
  return clamp(1 - Math.abs(p.ch.frameStretch) / 0.05, 0, 1);
}
function blinkNow(p: PetPlay, soft = false) {
  const b = p.ch.blink;
  if (b.start < 0) b.next = Math.min(b.next, p.now);
  if (soft) b.soft = true;
}
function slowBlink(p: PetPlay) {
  p.ch.catAt = p.now;
  p.ch.blink.holdUntil = p.now + 1.6;
}
function leanTo(p: PetPlay, x: number, y: number, delay = 0) {
  const generation = ++p.ch.leanGeneration;
  const go = () => {
    if (generation === p.ch.leanGeneration) {
      p.leanX.t = x;
      p.leanY.t = y;
    }
  };
  if (delay) later(p, delay, go);
  else go();
}
function lookAt(
  p: PetPlay,
  x: number,
  y: number,
  options: { lean?: number; eyesOnly?: boolean; blink?: boolean } = {},
) {
  const c = p.ch,
    k = options.lean ?? 1,
    lx = x * k,
    ly = y * k;
  if (!options.eyesOnly && k < 1) {
    x = lx + (x - lx) / 1.5;
    y = ly + (y - ly) / 1.5;
  }
  const jump = Math.hypot(x - c.lookX, y - c.lookY);
  c.lookX = x;
  c.lookY = y;
  if (jump > 0.35) c.fixX = c.fixY = 0;
  p.gazeX.t = x + c.fixX;
  p.gazeY.t = y + c.fixY;
  if (!options.eyesOnly)
    leanTo(p, lx, ly, jump > 0.35 ? 0.06 + 0.04 * random(p) : 0);
  if (
    jump > 0.5 &&
    options.blink !== false &&
    p.now - c.blink.evoked >= 0.6 &&
    random(p) < 0.65
  ) {
    c.blink.evoked = p.now;
    blinkNow(p);
  }
}
export function notePetInput(p: PetPlay, now: number) {
  p.now = now;
  const c = p.ch;
  c.lastInput = now;
  c.lookAt = now;
  c.idleNext = now + 8 + 6 * random(p, true);
  c.idleCurrent = null;
  c.idleGeneration++;
  if (c.doze.t === 1) {
    c.doze.z = 1;
    c.doze.w = (2 * Math.PI) / 1.6;
    c.doze.t = 0;
    c.inkStir.t = 1;
    c.dozeUp = true;
  }
}
export function hoverPetPlay(
  p: PetPlay,
  x: number,
  y: number,
  now: number,
  near = true,
) {
  notePetInput(p, now);
  p.ch.lookNear = near;
  if (near && p.ch.doze.x <= 0.35 && p.state === "idle")
    lookAt(p, x, y, {
      eyesOnly: p.pressed || p.petting || now - p.started < 0.45,
    });
  else if (!p.pressed) lookAt(p, 0, 0);
}
function stirInk(p: PetPlay) {
  p.ch.inkStir.t = 2.5;
  later(p, 0.35, () => {
    p.ch.inkStir.t = 1;
  });
}
function launch(p: PetPlay, k: number) {
  const generation = ++p.ch.hopGeneration;
  p.ch.hop.t = 0.08 * k;
  later(p, 0.05, () => {
    if (generation === p.ch.hopGeneration) p.ch.hop.t = 0;
  });
}
function nearAxis(p: PetPlay, axis: number) {
  return axis + Math.PI * Math.round((p.ch.axis.x - axis) / Math.PI);
}
function stepBlink(p: PetPlay, now: number) {
  const c = p.ch,
    b = c.blink;
  if (b.start >= 0 && now - b.start >= b.close + b.holdTime + b.open) {
    const end = b.start + b.close + b.holdTime + b.open;
    b.start = -1;
    b.double = !b.double && random(p) < 0.12;
    b.next =
      end +
      (b.double ? 0.2 + 0.08 * random(p) : logNormal(p, 3.4, 0.55, 1.2, 9));
  }
  const at = Math.max(b.next, b.holdUntil);
  if (b.start < 0 && p.state !== "resting" && c.doze.x < 0.3 && now >= at) {
    b.start = now - at > 1 / 120 ? now : at;
    const sleepy = b.soft;
    b.close = sleepy ? 0.14 : 0.075;
    b.holdTime = sleepy ? 0.12 : 0.045;
    b.open = sleepy ? 0.32 : 0.15;
    b.depth = sleepy ? 0.8 : 1;
    b.soft = false;
  }
  let value = 1;
  if (b.start >= 0) {
    const t = now - b.start;
    const lid =
      t < b.close
        ? 1 - (t / b.close) ** 2
        : t < b.close + b.holdTime
          ? 0
          : 1 - Math.max(0, 1 - (t - b.close - b.holdTime) / b.open) ** 3;
    value = 1 - (1 - lid) * b.depth;
  }
  const cat = now - c.catAt;
  let catLid = 1;
  if (cat >= 0 && cat < 1.51) {
    let i = 1;
    while (CAT[i]![0] <= cat) i++;
    catLid =
      CAT[i - 1]![1] +
      (CAT[i]![1] - CAT[i - 1]![1]) * ss(CAT[i - 1]![0], CAT[i]![0], cat);
  }
  const sb = now - c.slowAt,
    slow =
      sb < 0 || sb > 0.85
        ? 1
        : sb < 0.25
          ? 1 - (sb / 0.25) ** 2
          : sb < 0.4
            ? 0
            : 1 - (1 - (sb - 0.4) / 0.45) ** 3;
  c.frameBlink = Math.min(value, catLid, slow);
}
const idleWeights = {
  glance: 3,
  around: 2,
  cat: 2,
  ponder: 1,
  sigh: 1,
  stretch: 1,
  sky: 3,
  yawn: 3,
  hum: 1,
};
function ownSign(p: PetPlay, name: PetSignName, duration: number) {
  const c = p.ch;
  if (p.now - c.idleSignAt < 45 || p.sign) return false;
  c.idleSignAt = p.now;
  sign(p, name, p.now, false, duration, 0.08);
  return true;
}
function runIdle(p: PetPlay, name: string) {
  const c = p.ch,
    at = p.now,
    side = random(p, true) < 0.5 ? -1 : 1,
    generation = ++c.idleGeneration;
  const end = (seconds: number, fn?: () => void) => {
    c.idleCurrent = { name, at, until: at + seconds, side };
    later(p, seconds, () => {
      if (c.idleGeneration !== generation) return;
      fn?.();
      c.idleCurrent = null;
    });
  };
  const back = (blink: boolean) => {
    if (c.lookAt <= at) lookAt(p, 0, 0, { blink: false });
    if (blink) blinkNow(p);
  };
  if (name === "glance") {
    lookAt(
      p,
      side * (0.35 + 0.5 * random(p, true)),
      -0.2 + 0.5 * random(p, true),
      { lean: 0.25, blink: false },
    );
    end(1.2 + random(p, true), () => back(random(p, true) < 0.5));
  } else if (name === "around") {
    lookAt(p, 0.8 * side, 0.05, { lean: 0.6, blink: false });
    later(p, 0.9, () => {
      if (c.idleGeneration === generation && c.lookAt <= at)
        lookAt(p, -0.8 * side, 0.05, { lean: 0.6 });
    });
    end(1.8, () => back(false));
  } else if (name === "cat") {
    slowBlink(p);
    end(1.6);
  } else if (name === "ponder") {
    const hold = 1.2 + 1.3 * random(p, true);
    reaction(p, "curious", at, hold);
    p.target.roll = 0.12 * side;
    lookAt(p, 0.35 * side, 0.55, { lean: 0.3, blink: false });
    if (
      random(p, true) < 0.25 &&
      at - c.idleDotsAt >= 120 &&
      ownSign(p, "dots", 1.8)
    )
      c.idleDotsAt = at;
    end(hold, () => back(false));
  } else if (name === "sigh") {
    if (!c.breath.sigh) c.breath.sigh = 1;
    end(2);
  } else if (name === "stretch") {
    reaction(p, "stretch", at, 1.4);
    end(1, () => {
      p.squash.t = 0;
    });
  } else if (name === "sky") {
    lookAt(p, 0.15 * side, 0.85, { lean: 0.3, blink: false });
    later(p, 0.5, () => {
      if (c.idleGeneration === generation) blinkNow(p, true);
    });
    end(1.5, () => back(false));
  } else if (name === "yawn") {
    reaction(p, "yawn", at, 1.9);
    end(1.9, () => {
      p.squash.t = 0;
      slowBlink(p);
    });
  } else if (name === "hum") {
    reaction(p, "happy", at, 1.7);
    ownSign(p, "notes", 1.6);
    end(1.7);
  }
}
function stepIdle(p: PetPlay, now: number, occupied: boolean) {
  const c = p.ch;
  if (occupied) {
    c.idleNext = now + 8 + 6 * random(p, true);
    if (c.idleCurrent) {
      c.idleCurrent = null;
      c.idleGeneration++;
      p.squash.t = 0;
    }
    return;
  }
  if (
    now < c.idleNext ||
    c.idleCurrent ||
    p.pressed ||
    p.petting ||
    (now < p.faceUntil &&
      p.faceName !== "neutral" &&
      p.faceName !== "sleepy") ||
    p.state === "resting" ||
    c.doze.x > 0.3
  )
    return;
  if (
    now - c.lookAt < 1.5 ||
    now - c.lastReaction < 3 ||
    now - c.lastInput >= 180
  ) {
    c.idleNext = now + 0.5;
    return;
  }
  const ok = (name: string) =>
    name !== c.idleLast &&
    (name !== "cat" || c.lookNear) &&
    !["sky", "yawn", "hum"].includes(name) &&
    now - (c.idleRan[name] ?? -Infinity) >= 0;
  let cards = c.idleBag.filter(ok);
  if (!cards.length) {
    c.idleBag = Object.entries(idleWeights).flatMap(([name, weight]) =>
      Array<string>(weight).fill(name),
    );
    cards = c.idleBag.filter(ok);
  }
  c.idleNext =
    now +
    Math.min(
      45,
      logNormal(p, 7, 0.45, 4, 18, true) *
        Math.pow(1.4, (now - c.lastInput) / 60),
    );
  if (!cards.length) return;
  const name = cards[Math.floor(random(p, true) * cards.length)]!;
  c.idleBag.splice(c.idleBag.indexOf(name), 1);
  c.idleLast = name;
  c.idleRan[name] = now;
  runIdle(p, name);
}
function stepChoreography(
  p: PetPlay,
  h: number,
  now: number,
  reduced: boolean,
  occupied: boolean,
) {
  const c = p.ch;
  if (!c.initialized) {
    c.initialized = true;
    c.lastInput = now;
    c.idleNext = now + 8 + 6 * random(p, true);
    c.blink.next = now + logNormal(p, 3.4, 0.55, 1.2, 9);
    c.asleepWas = p.state === "resting";
    c.sleep.x = c.sleep.t = c.asleepWas ? 1 : 0;
    c.sink.x = c.sink.t = c.sleep.x;
    c.nextZz = now + 30 + random(p) * 15;
  }
  runTimeline(p, now);
  if (reduced) return;
  if ((p.state === "resting") !== c.asleepWas) {
    c.asleepWas = p.state === "resting";
    const generation = ++c.sleepGeneration;
    if (c.asleepWas) {
      later(p, 0.35, () => {
        if (generation === c.sleepGeneration) c.slowAt = p.now;
      });
      later(p, 0.65, () => {
        if (generation === c.sleepGeneration) {
          c.sleep.z = 1;
          c.sleep.w = (2 * Math.PI) / 2.2;
          c.sleep.t = 1;
        }
      });
      c.nextZz = now + 4 + 3 * random(p);
    } else {
      c.sleep.z = 1;
      c.sleep.w = (2 * Math.PI) / 0.9;
      c.sleep.t = 0;
    }
  }
  if (p.state === "resting" && c.doze.t) {
    c.doze.t = 0;
    c.dozeUp = false;
    c.inkStir.t = 1;
  }
  if (c.dozeUp && c.doze.x < 0.35) {
    c.dozeUp = false;
    lookAt(p, c.lookNear ? c.lookX : 0, c.lookNear ? c.lookY : 0, {
      blink: false,
    });
    blinkNow(p);
  }
  if (
    p.state === "idle" &&
    now - c.lastInput >= 180 &&
    !p.pressed &&
    p.faceName === "neutral" &&
    !c.idleCurrent &&
    !p.sign
  ) {
    if (c.doze.t !== 1) {
      c.doze.z = 1;
      c.doze.w = (2 * Math.PI) / 4;
      c.doze.t = 1;
      c.inkStir.t = 0.7;
      c.slowAt = now;
    }
  }
  const br = c.breath,
    asleep = p.state === "resting",
    dozing = c.doze.t === 1;
  br.phase += h / (br.period * (p.hug ? 1.3 : 1));
  while (br.phase >= 1) {
    br.phase -= 1;
    if (br.sigh === 2) {
      br.sigh = 0;
      p.squash.v += 0.3 * kick(p);
    }
    const sighing = br.sigh === 1;
    if (sighing) br.sigh = 2;
    const period = asleep ? 5.2 : dozing ? 4.8 : 3.6,
      depth = asleep ? 1.5 : dozing ? 1.25 : 1;
    br.period =
      period *
      Math.pow(0.7 / 0.62, 0.75) *
      (1 + (asleep ? 0.03 : 0.07) * gaussian(p)) *
      (sighing ? 1.6 : 1);
    br.previous = br.amplitude;
    br.amplitude =
      0.0105 *
      depth *
      clamp(1 + 0.1 * gaussian(p), 0.85, 1.15) *
      (sighing ? 1.8 : 1);
  }
  const amplitude =
    br.previous + (br.amplitude - br.previous) * ss(0, 0.38, br.phase);
  c.breathStretch = 2 * amplitude * (curve(br.phase) - 0.425);
  c.breathLift = 1.8 * amplitude * (curve((br.phase + 0.93) % 1) - 0.425);
  if (c.idleCurrent && !p.pressed) {
    const idle = c.idleCurrent,
      t = now - idle.at;
    if (idle.name === "stretch") p.squash.t = -0.04 * ss(0, 0.6, t);
    if (idle.name === "yawn") {
      const env = t < 0.8 ? ss(0, 0.8, t) : t < 1.3 ? 1 : 1 - ss(1.3, 1.9, t);
      p.target.mouth = 0.95 * env;
      p.squash.t = 0.04 * env;
    }
  }
  if (p.pressed)
    p.squash.t =
      p.pressSquash - Math.min(0, clamp(0.06 * c.hop.v, -0.03, 0.03));
  c.hop.step(h);
  c.axis.step(h);
  p.axis = c.axis.x;
  c.sleep.step(h);
  c.sink.t = c.sleep.x;
  c.sink.step(h);
  c.doze.step(h);
  c.stir += clamp(c.stirTarget - c.stir, -h / 0.6, h / 0.15);
  c.inkStir.step(h);
  c.inkClock += h * c.inkStir.x;
  c.sway = half(
    c.sway,
    !c.lookNear && !p.pressed && p.state === "idle" && c.doze.x < 0.3
      ? clamp(0.08 * petNoise(0.15 * now + 11.3), -0.1, 0.1)
      : 0,
    0.6,
    h,
  );
  c.frameStretch = clamp(
    c.breathStretch + p.squash.x + clamp(0.06 * c.hop.v, -0.03, 0.03),
    -0.05,
    0.05,
  );
  c.frameBob = c.breathLift + c.hop.x - 0.02 * c.sink.x;
  c.sloshX.t = p.leanX.x * 0.12;
  c.sloshY.t = c.frameBob;
  c.sloshX.step(h);
  c.sloshY.step(h);
  const reacting =
    p.pressed ||
    (p.faceName !== "neutral" && p.faceName !== "sleepy") ||
    Number.isFinite(p.faceUntil);
  if (reacting) c.lastReaction = now;
  c.quiet = half(c.quiet, reacting ? 1 : 0, 0.077, h);
  if (p.state === "resting") {
    p.gazeX.t = p.leanX.t = c.turn;
    p.gazeY.t = p.leanY.t = 0;
    if (c.sleep.x > 0.99 && now > c.nextZz && !p.sign) {
      c.nextZz = now + 30 + 15 * random(p);
      sign(p, "zz", now, false, 2.2, 0);
    }
  } else if (c.doze.x > 0.35) {
    p.gazeX.t = p.gazeY.t = p.leanX.t = p.leanY.t = 0;
  } else if (!p.pressed && p.state === "idle") {
    if (now - c.lookAt > 3 && !c.idleCurrent) lookAt(p, 0, 0, { blink: false });
    if (c.lookNear && !c.idleCurrent && now >= c.nextFix) {
      c.nextFix = now + logNormal(p, 1.1, 0.5, 0.4, 3);
      if (now - c.lookAt >= 0.4) {
        if ((c.fixX || c.fixY) && random(p) < 0.5) c.fixX = c.fixY = 0;
        else {
          const angle = random(p) * Math.PI * 2,
            m = (0.25 + 0.15 * random(p)) / 1.5;
          c.fixX = m * Math.cos(angle);
          c.fixY = m * Math.sin(angle);
        }
        p.gazeX.t = c.lookX + c.fixX;
        p.gazeY.t = c.lookY + c.fixY;
      }
    }
    if (
      c.lookNear &&
      !c.idleCurrent &&
      now - c.lookAt >= 1.5 &&
      now - Math.max(c.lookAt, c.glanceEnd) >= c.lookBudget &&
      now >= c.glanceUntil
    ) {
      c.glanceUntil = now + 0.6 + 0.6 * random(p);
      const angle = random(p) * Math.PI * 2,
        m = (0.5 + 0.3 * random(p)) / 1.5;
      p.gazeX.t = clamp(c.lookX + m * Math.cos(angle), -1, 1);
      p.gazeY.t = clamp(c.lookY + 0.6 * m * Math.sin(angle), -1, 1);
      later(p, c.glanceUntil - now, () => {
        c.glanceEnd = p.now;
        c.lookBudget = 2.5 + 2 * random(p);
        p.gazeX.t = c.lookX + c.fixX;
        p.gazeY.t = c.lookY + c.fixY;
      });
    }
  }
  stepIdle(p, now, occupied || p.state !== "idle");
  stepBlink(p, now);
}

export type PetSign = {
  name: PetSignName;
  kind: number;
  at: number;
  until: number;
  bumpAt: number;
  fresh: boolean;
  swap: boolean;
  material: number;
  phase: "" | "in" | "swap" | "out";
  pending: { name: PetSignName; duration: number } | null;
  scale: PetSpring;
  opacity: PetSpring;
  x: PetSpring;
  y: PetSpring;
  anchorInitialized: boolean;
};
export type PetPlay = {
  ch: Choreography;
  reduced: boolean;
  hugs: number;
  pressSquash: number;
  pressKick: number;
  pulled: boolean;
  gestureGeneration: number;
  sleepTapTimes: number[];
  faceName: PetFaceName;
  face: PetFace;
  target: PetFace;
  faceUntil: number;
  sign: PetSign | null;
  pendingSign: { name: PetSignName; at: number; duration: number } | null;
  hugRewarded: boolean;
  blushRise: number;
  pressed: boolean;
  hug: boolean;
  petting: boolean;
  state: PetPlayState;
  now: number;
  started: number;
  lastMove: number;
  lastStroke: number;
  travel: number;
  origin: PetPoint | null;
  point: PetPoint | null;
  releaseAt: number;
  strokeDirection: number;
  strokeDistance: number;
  reversals: number[];
  pettedAt: number;
  pettingRewarded: boolean;
  wasPetted: boolean;
  lastTap: number;
  tapN: number;
  cycle: number;
  pauseUntil: number;
  lastHeart: number;
  sleepTaps: number;
  idleAt: number;
  idleEnd: number;
  idleIndex: number;
  squash: PetSpring;
  leanX: PetSpring;
  leanY: PetSpring;
  gazeX: PetSpring;
  gazeY: PetSpring;
  dent: PetSpring;
  axis: number;
  springs: Record<keyof PetFace, PetSpring>;
};
export function createPetPlay(): PetPlay {
  const springs = {} as PetPlay["springs"];
  for (const key of faceKeys)
    springs[key] = new PetSpring(PET_FACES.neutral[key], 0.8, 25);
  return {
    ch: createChoreography(),
    reduced: false,
    hugs: 0,
    pressSquash: 0,
    pressKick: 1,
    pulled: false,
    gestureGeneration: 0,
    sleepTapTimes: [],
    faceName: "neutral",
    face: { ...PET_FACES.neutral },
    target: { ...PET_FACES.neutral },
    faceUntil: 0,
    sign: null,
    pendingSign: null,
    hugRewarded: false,
    blushRise: 0.12,
    pressed: false,
    hug: false,
    petting: false,
    state: "idle",
    now: 0,
    started: 0,
    lastMove: 0,
    lastStroke: 0,
    travel: 0,
    origin: null,
    point: null,
    releaseAt: Infinity,
    strokeDirection: 0,
    strokeDistance: 0,
    reversals: [],
    pettedAt: 0,
    pettingRewarded: false,
    wasPetted: false,
    lastTap: -Infinity,
    tapN: 0,
    cycle: 0,
    pauseUntil: 0,
    lastHeart: -Infinity,
    sleepTaps: 0,
    idleAt: Infinity,
    idleEnd: 0,
    idleIndex: 0,
    squash: new PetSpring(0, 0.8, 40),
    leanX: new PetSpring(0, 0.78, 11),
    leanY: new PetSpring(0, 0.78, 11),
    gazeX: new PetSpring(0, 1, 45),
    gazeY: new PetSpring(0, 1, 45),
    dent: new PetSpring(0, 0.6, 30),
    axis: Math.PI / 2,
    springs,
  };
}
function startSign(
  p: PetPlay,
  name: PetSignName,
  duration: number,
  now: number,
  fresh: boolean,
  reduced = false,
) {
  const old = p.sign,
    moved = (old?.kind === 5) !== (PET_SIGNS[name].kind === 5);
  const scale = old?.scale ?? new PetSpring(0.6, 0.6, 28.3),
    opacity = old?.opacity ?? new PetSpring(0, 1, 61.6);
  scale.z = name === "bang" ? 0.45 : 0.6;
  scale.w = name === "bang" ? 45 : 28.3;
  if (fresh) {
    scale.x = scale.t = 0.6;
    scale.v = 0;
    opacity.x = opacity.t = 0;
    opacity.v = 0;
  }
  p.sign = {
    name,
    kind: PET_SIGNS[name].kind,
    at: now,
    until: now + (reduced ? 1.4 : duration),
    bumpAt: -Infinity,
    fresh,
    swap: false,
    material: fresh || moved ? 0 : (old?.material ?? 0),
    phase: "",
    pending: null,
    scale,
    opacity,
    x: old?.x ?? new PetSpring(0, 0.7, 18),
    y: old?.y ?? new PetSpring(0, 0.7, 18),
    anchorInitialized: !!old?.anchorInitialized && !fresh && !moved,
  };
  if (reduced) {
    scale.x = scale.t = opacity.x = opacity.t = p.sign.material = 1;
  }
}
function popSign(
  p: PetPlay,
  name: PetSignName,
  duration: number,
  now: number,
  reduced = false,
) {
  const active = p.sign;
  if (reduced) {
    startSign(p, name, duration, now, true, true);
    return;
  }
  if (active && active.name === name && !active.swap) {
    active.bumpAt = now;
    active.until = Math.max(active.until, now + duration);
    return;
  }
  if (active) {
    active.pending = { name, duration };
    if (!active.swap) {
      active.swap = true;
      active.until = Math.min(active.until, now + 0.12);
    }
    return;
  }
  startSign(p, name, duration, now, true);
}
function sign(
  p: PetPlay,
  name: PetSignName,
  now: number,
  reduced = false,
  duration = 1.4,
  delay = 0.11,
) {
  if (reduced || delay <= 0) popSign(p, name, duration, now, reduced);
  else p.pendingSign = { name, at: now + delay, duration };
}
function stepSign(p: PetPlay, h: number, now: number, reduced: boolean) {
  if (p.pendingSign && now >= p.pendingSign.at) {
    const pending = p.pendingSign;
    p.pendingSign = null;
    popSign(p, pending.name, pending.duration, pending.at, reduced);
  }
  if (p.sign && now >= p.sign.until) {
    const next = p.sign.pending;
    if (!next) p.sign = null;
    else startSign(p, next.name, next.duration, p.sign.until, false, reduced);
  }
  const active = p.sign;
  if (!active) return;
  if (reduced) {
    active.scale.x = active.opacity.x = active.material = 1;
    return;
  }
  const phase =
    now < active.until - (active.swap ? 0.12 : 0.22)
      ? "in"
      : active.swap
        ? "swap"
        : "out";
  if (phase !== active.phase) {
    active.phase = phase;
    if (phase === "in") {
      active.scale.z = active.name === "bang" ? 0.45 : 0.6;
      active.scale.w = active.name === "bang" ? 45 : 28.3;
      active.scale.t = 1;
      active.opacity.z = 1;
      active.opacity.w = 61.6;
      active.opacity.t = 1;
    } else {
      active.scale.z = active.opacity.z = 1;
      active.scale.w = active.opacity.w = 40;
      active.scale.t = 0.85;
      active.opacity.t = 1;
    }
  }
  if (phase === "out" && now >= active.until - 0.11) active.opacity.t = 0;
  const target = phase === "in" ? 1 : phase === "swap" ? 0.2 : 0;
  const dt = Math.min(h, Math.max(0, now - active.at));
  active.material += clamp(
    target - active.material,
    -dt / (phase === "swap" ? 0.15 : 0.2),
    dt / 0.165,
  );
  active.scale.step(dt);
  active.opacity.step(dt);
}

function reaction(
  p: PetPlay,
  name: PetFaceName,
  now: number,
  duration = 1.4,
  emote?: PetSignName,
  reduced = false,
) {
  p.ch.faceAt = now;
  p.ch.attack = true;
  p.ch.faceGeneration++;
  p.ch.lastReaction = now;
  p.faceName = name;
  p.target = { ...PET_FACES[name] };
  p.faceUntil = now + (reduced ? 1.4 : duration);
  if (name === "surprise") p.ch.blink.holdUntil = now + 0.6;
  if (emote) sign(p, emote, now, reduced);
  if (reduced) Object.assign(p.face, p.target);
}
function heart(p: PetPlay, now: number, reduced = false, first = false) {
  if (first || now - p.lastHeart >= 25) {
    p.lastHeart = now;
    sign(p, "hearts", now, reduced, 1.8, 0);
  } else sign(p, "sparkle", now, reduced, 1.4, 0);
}
export function cancelPetPlay(p: PetPlay) {
  const { lastHeart, cycle, lastTap, tapN, now, state, ch, hugs, reduced } = p;
  Object.assign(p, createPetPlay(), {
    lastHeart,
    cycle,
    lastTap,
    tapN,
    now,
    state,
    idleAt: now + 12,
    hugs,
    reduced,
  });
  p.ch.seed = ch.seed;
  p.ch.idleSeed = ch.idleSeed;
  p.ch.breath = ch.breath;
  p.ch.blink = ch.blink;
  p.ch.sleep = ch.sleep;
  p.ch.sink = ch.sink;
  p.ch.inkStir = ch.inkStir;
  p.ch.inkStir.t = 1;
  p.ch.initialized = ch.initialized;
  p.ch.asleepWas = state === "resting";
  p.ch.nextZz = ch.nextZz;
  p.ch.sleepGeneration = ch.sleepGeneration + 1;
  p.ch.sleep.z = 1;
  p.ch.sleep.w = (2 * Math.PI) / (state === "resting" ? 2.2 : 0.9);
  p.ch.sleep.t = state === "resting" ? 1 : 0;
  p.ch.inkClock = ch.inkClock;
  p.ch.lastInput = now;
  p.ch.idleNext = now + 12;
  p.ch.generation = ch.generation + 1;
}
export function pressPetPlay(
  p: PetPlay,
  point: PetPoint,
  now: number,
  state: PetPlayState = "idle",
  reduced = false,
  sampleTime = now,
) {
  if (!Number.isFinite(now) || !["idle", "resting"].includes(state)) return;
  if (p.pressed && Number.isFinite(p.releaseAt)) finishRelease(p, now, false);
  p.state = state;
  p.reduced = reduced;
  p.now = now;
  notePetInput(p, now);
  p.gestureGeneration++;
  p.pressed = true;
  p.hug = p.petting = p.wasPetted = p.pettingRewarded = p.hugRewarded = false;
  p.blushRise = 0.12;
  p.origin = { ...point };
  p.point = { ...point };
  p.started = p.lastStroke = now;
  p.lastMove = sampleTime;
  p.travel = 0;
  p.releaseAt = Infinity;
  p.strokeDirection = p.strokeDistance = 0;
  p.reversals = [];
  p.idleAt = now + 12;
  p.idleEnd = 0;
  if (reduced) return;
  p.squash.z = 0.8;
  p.squash.w = 40;
  p.pressKick = kick(p) * (state === "resting" ? 0.35 : 1);
  p.pressSquash = -0.04 * p.pressKick;
  p.pulled = false;
  p.squash.t = p.pressSquash;
  p.squash.v = Math.max(Math.min(p.squash.v, -p.pressKick), -1);
  p.ch.axis.t = nearAxis(
    p,
    Math.hypot(point.x, point.y) > 0.05 * 0.7
      ? Math.atan2(point.y, point.x)
      : Math.PI / 2,
  );
  p.ch.sloshX.v -= (point.x / 0.7) * 0.5 * p.pressKick;
  p.ch.sloshY.v -= (point.y / 0.7) * 0.5 * p.pressKick;
  stirInk(p);
  p.dent.t = 1;
  p.gazeX.t = clamp((point.x / 0.7) * 0.8, -1, 1);
  p.gazeY.t = clamp((point.y / 0.7) * 0.8, -1, 1);
  leanTo(p, -p.gazeX.t * 0.75, -p.gazeY.t * 0.75);
  const leanGeneration = p.ch.leanGeneration;
  later(p, 0.45, () => {
    if (leanGeneration === p.ch.leanGeneration)
      lookAt(
        p,
        p.ch.lookNear ? p.ch.lookX : 0,
        p.ch.lookNear ? p.ch.lookY : 0,
        { blink: false },
      );
  });
  if (state === "idle") {
    const base = p.faceName === "neutral" ? PET_FACES.neutral : p.target;
    p.target = { ...base, lid: Math.min(base.lid, 0.82), low: base.low + 0.15 };
    p.ch.faceAt = now;
    p.ch.attack = true;
    p.faceName = "neutral";
    p.faceUntil = Infinity;
  }
}
export function movePetPlay(
  p: PetPlay,
  point: PetPoint,
  now: number,
  sampleTime = now,
) {
  if (!p.pressed || !p.point || !p.origin || !Number.isFinite(now)) return;
  const dx = point.logicalX - p.point.logicalX,
    dt = sampleTime - p.lastMove;
  p.travel = Math.max(
    p.travel,
    Math.hypot(
      point.logicalX - p.origin.logicalX,
      point.logicalY - p.origin.logicalY,
    ),
  );
  const speed = dt > 0 ? Math.abs(dx) / dt : 0,
    direction = Math.sign(dx);
  if (
    p.state === "idle" &&
    !p.reduced &&
    direction &&
    Math.abs(dx) >= 0.5 &&
    speed >= 120 &&
    speed <= 1600 &&
    dt <= 0.25
  ) {
    if (!p.strokeDirection) p.strokeDirection = direction;
    if (direction === p.strokeDirection) p.strokeDistance = 0;
    else {
      p.strokeDistance += Math.abs(dx);
      if (p.strokeDistance >= 6) {
        p.reversals.push(now);
        p.strokeDirection = direction;
        p.strokeDistance = 0;
      }
    }
    p.reversals = p.reversals.filter((t) => now - t <= 1.5);
    if (p.reversals.length >= 3 || p.petting) {
      if (!p.petting) {
        p.petting = true;
        p.pettedAt = now;
        p.wasPetted = true;
        reaction(p, "content", now, Infinity);
      }
      p.lastStroke = now;
      p.hug = false;
      p.dent.t = 0;
      p.squash.t = p.pressSquash;
      leanTo(p, direction * 0.22, 0.05);
      p.ch.inkStir.t = 3;
      p.pressSquash = -0.02 * p.pressKick;
      p.pulled = false;
    }
  }
  p.now = now;
  p.lastMove = sampleTime;
  p.point = { ...point };
  p.gazeX.t = clamp((point.x / 0.7) * 0.8, -1, 1);
  p.gazeY.t = clamp((point.y / 0.7) * 0.8, -1, 1);
  if (
    p.travel > 12 &&
    !p.hug &&
    !p.petting &&
    !p.reduced &&
    p.state === "idle"
  ) {
    p.pulled = true;
    p.pressSquash = 0.04 * p.pressKick * clamp((p.travel - 12) / 60, 0, 1);
    p.squash.t = p.pressSquash;
    p.ch.axis.t = nearAxis(
      p,
      Math.atan2(
        p.origin!.logicalY - point.logicalY,
        point.logicalX - p.origin!.logicalX,
      ),
    );
    p.dent.t = 0;
  }
}
function zoneReaction(
  p: PetPlay,
  point: PetPoint | null,
  now: number,
  reduced: boolean,
) {
  switch (point?.zone) {
    case "top":
      reaction(p, "pat", now, 1.3, "notes", reduced);
      if (!reduced) {
        ++p.ch.hopGeneration;
        p.ch.hop.t = 0;
        p.squash.v -= 0.6 * p.pressKick;
        p.squash.t = -0.012 * p.pressKick;
        const generation = ++p.ch.bodyGeneration;
        later(p, 0.22, () => {
          if (generation === p.ch.bodyGeneration && !p.pressed) p.squash.t = 0;
        });
      }
      return true;
    case "eye":
      reaction(p, "wink", now, 0.12, undefined, reduced);
      p.target = {
        ...PET_FACES.neutral,
        wink: (point!.side ?? -1) < 0 ? 1 : -1,
      };
      p.target.wink = (point.side ?? -1) < 0 ? 1 : -1;
      if (reduced) p.face.wink = p.target.wink;
      return true;
    case "cheek":
      reaction(p, "shy", now, 1.4, "sparkle", reduced);
      p.target.blush = Math.min(1, p.face.blush + 0.6);
      lookAt(p, -0.45 * (point.side ?? 1), -0.55, {
        eyesOnly: true,
        blink: false,
      });
      later(p, 0.8, () => {
        if (!p.pressed) lookAt(p, 0, 0);
      });
      return true;
    case "low":
      reaction(p, "giggle", now, 1.3, "notes", reduced);
      if (!reduced)
        later(p, 0.2, () => {
          p.squash.v -= 0.45 * p.pressKick;
        });
      return true;
    case "rim":
      reaction(p, "surprise", now, 0.9, "bang", reduced);
      return true;
    default:
      return false;
  }
}
function zoneOrBag(
  p: PetPlay,
  point: PetPoint | null,
  now: number,
  reduced: boolean,
) {
  if (zoneReaction(p, point, now, reduced)) return;
  const bag = [
    { face: "happy", sign: "sparkle" },
    { face: "wink", sign: "sparkle" },
    { face: "happy", sign: "notes" },
  ] as const;
  let index = Math.floor(random(p) * 3);
  if (index === p.ch.previousBag)
    index = (index + 1 + Math.floor(random(p) * 2)) % 3;
  p.ch.previousBag = index;
  const chosen = bag[index]!;
  reaction(p, chosen.face, now, 1.4, chosen.sign, reduced);
}
function finishRelease(p: PetPlay, now: number, reduced: boolean) {
  if (!p.pressed) return;
  const wasHug = p.hug,
    wasPetting = p.petting,
    point = p.point;
  p.pressed = p.hug = false;
  p.releaseAt = Infinity;
  p.dent.t = 0;
  p.squash.t = 0;
  p.squash.z = wasHug ? 0.45 : 0.5;
  p.squash.w = 20;
  p.ch.axis.t = nearAxis(p, Math.PI / 2);
  if (!p.pulled && !reduced) {
    p.squash.v += (wasHug ? 1.3 : 0.9) * p.pressKick;
    if (p.state !== "resting") launch(p, p.pressKick);
  }
  if (wasHug && !reduced) {
    slowBlink(p);
    later(p, 0.7, () => {
      if (!p.pressed) {
        p.squash.z = 0.5;
        p.squash.w = 20;
      }
    });
  }
  const gesture = p.gestureGeneration;
  later(p, 0.45, () => {
    if (gesture === p.gestureGeneration && !p.pressed) lookAt(p, 0, 0);
  });
  p.idleAt = now + 12;
  if (p.state === "resting") {
    p.sleepTapTimes = p.sleepTapTimes.filter((time) => now - time < 4);
    p.sleepTapTimes.push(now);
    if (p.sleepTapTimes.length === 1) {
      reaction(p, "mumble", now, 0.7, undefined, reduced);
      sign(p, "zz", now, reduced, 1.6, 0);
    } else if (p.sleepTapTimes.length === 2) {
      reaction(p, "stir", now, 1.5, undefined, reduced);
      p.ch.stirTarget = 1;
      later(p, 0.9, () => {
        p.ch.stirTarget = 0;
      });
    } else {
      reaction(p, "sleepy", now, 1.4, undefined, reduced);
      sign(p, "zz", now, reduced, 1.6, 0);
      p.ch.turn = -0.3;
      p.ch.turns++;
      later(p, 1.4, () => {
        if (--p.ch.turns === 0) p.ch.turn = 0;
      });
    }
    return;
  }
  if (wasHug) {
    reaction(p, "happy", now, 1.2, undefined, reduced);
    return;
  }
  if (wasPetting || p.wasPetted) return;
  if (p.pulled) {
    reaction(p, "giggle", now, 1.1, "notes", reduced);
    return;
  }
  const gap = now - p.lastTap;
  p.lastTap = now;
  if (gap >= 30) {
    p.tapN = 1;
    p.cycle = 1;
    reaction(p, "happy", now, 1.4, "sparkle", reduced);
    return;
  }
  if (now < p.pauseUntil) return;
  if (reduced) {
    zoneOrBag(p, point, now, true);
    return;
  }
  p.tapN = gap < 0.7 ? p.tapN + 1 : Math.max(1, p.tapN - gap / 1.5);
  if (p.tapN >= 9) {
    p.pauseUntil = now + 2;
    p.tapN = 0;
    p.ch.laughUntil = -Infinity;
    reaction(p, "moment", now, 2, undefined, reduced);
    sign(p, "dots", now, reduced, 1.85, 0.11);
    lookAt(p, 0.55 * (random(p) < 0.5 ? -1 : 1), -0.2, {
      eyesOnly: true,
      blink: false,
    });
    later(p, 1.1, () => lookAt(p, 0, 0));
    later(p, 2, () => {
      if (!p.pressed) reaction(p, "wink", p.now, 0.9, "sparkle", false);
    });
    return;
  }
  if (p.tapN >= 5) {
    const fresh = now >= p.ch.laughUntil;
    if (fresh) p.ch.laughAt = now;
    p.ch.laughUntil = now + 1.4;
    if (fresh)
      for (let i = 0; i < 4; i++)
        later(p, 0.21 * i, () => {
          if (p.now < p.ch.laughUntil && !p.pressed)
            p.squash.v -= 0.35 * Math.pow(0.8, i) * kick(p);
        });
    reaction(p, "laugh", now, 1.4, "notes", reduced);
    return;
  }
  if (p.tapN >= 2) {
    reaction(p, "giggle", now, 1.2, "notes", reduced);
    return;
  }
  if (p.travel > 12) {
    reaction(p, "giggle", now, 1.1, "notes", reduced);
    return;
  }
  zoneOrBag(p, point, now, reduced);
}
export function releasePetPlay(
  p: PetPlay,
  now: number,
  cancel = false,
  reduced = false,
) {
  if (!p.pressed) return false;
  if (cancel) {
    cancelPetPlay(p);
    return false;
  }
  p.now = now;
  if (
    !reduced &&
    now - p.started >= 0.45 - 1e-9 &&
    p.travel < 12 &&
    !p.wasPetted
  )
    p.hug = true;
  const tapped = !p.hug && !p.petting && !p.wasPetted && p.travel < 8;
  if (!reduced && now - p.started < 0.09) p.releaseAt = p.started + 0.09;
  else finishRelease(p, now, reduced);
  return tapped;
}
function stepPetPlay(
  p: PetPlay,
  dt: number,
  now: number,
  state: PetPlayState,
  reduced = false,
  occupied = false,
) {
  if (!Number.isFinite(now)) return;
  p.now = now;
  p.state = state;
  p.reduced = reduced;
  if (!["idle", "resting"].includes(state)) {
    if (p.pressed || p.petting || p.sign || p.faceName !== "neutral")
      cancelPetPlay(p);
    p.state = state;
    stepChoreography(p, dt, now, reduced, true);
    return;
  }
  if (p.pressed && now >= p.releaseAt) finishRelease(p, now, reduced);
  if (
    p.pressed &&
    (p.hug || p.travel < 12) &&
    !p.wasPetted &&
    now - p.started >= 0.45 - 1e-9 &&
    state === "idle" &&
    !reduced
  ) {
    if (!p.hug) {
      p.hug = true;
      p.hugs++;
      p.squash.t = p.pressSquash;
      reaction(p, "bliss", now, Infinity, undefined, reduced);
      p.target.blush = 1;
      p.blushRise = 0.3;
    }
    if (now - p.started >= 0.9 && !p.hugRewarded) {
      p.hugRewarded = true;
      heart(p, now, reduced, p.hugs === 1);
    }
  }
  if (p.petting) {
    if (now - p.lastStroke > 0.6) {
      p.petting = false;
      p.reversals = [];
      p.ch.inkStir.t = 1;
      reaction(p, "happy", now, 0.8, undefined, reduced);
    } else if (now - p.pettedAt >= 2 && !p.pettingRewarded) {
      p.pettingRewarded = true;
      heart(p, now, reduced);
    }
  }
  stepSign(p, clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1), now, reduced);
  if (now >= p.faceUntil) {
    p.ch.faceAt = now;
    p.ch.attack = false;
    p.ch.faceGeneration++;
    if (!reduced && random(p) < 0.6) blinkNow(p);
    p.blushRise = 0.12;
    p.faceName = state === "resting" ? "sleepy" : "neutral";
    p.target = { ...PET_FACES[p.faceName] };
    p.faceUntil = Infinity;
  }
  stepChoreography(
    p,
    clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1),
    now,
    reduced,
    occupied,
  );
  if (reduced) {
    p.ch.timeline.length = 0;
    Object.assign(p.face, p.target);
    return;
  }
  const h = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
  for (const key of faceKeys) {
    const s = p.springs[key];
    const channel = faceChannels[key] ?? {
      attack: [0.8, 25] as const,
      release: [1, 12.5] as const,
    };
    if (!p.ch.attack || now - p.ch.faceAt >= (channel.delay ?? 0))
      s.t = p.target[key];
    const tuning = p.ch.attack ? channel.attack : channel.release;
    s.z = tuning[0];
    s.w = tuning[1];
    if (key === "blush") {
      p.face[key] +=
        (p.target[key] - p.face[key]) *
        (1 -
          Math.pow(2, -h / (p.target[key] > p.face[key] ? p.blushRise : 0.45)));
      s.x = p.face[key];
      s.v = 0;
    } else p.face[key] = s.step(h);
  }
  for (const s of [p.squash, p.leanX, p.leanY, p.gazeX, p.gazeY, p.dent])
    s.step(h);
}
/** Fixed 120Hz grid and exact timeline boundaries, as in the original simulate(). */
export function updatePetPlay(
  p: PetPlay,
  dt: number,
  now: number,
  state: PetPlayState,
  reduced = false,
  occupied = false,
  afterStep?: (dt: number) => void,
) {
  if (!Number.isFinite(now)) return;
  if (reduced) {
    stepPetPlay(p, 0, now, state, true, occupied);
    return;
  }
  const duration = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
  let clock = now - duration;
  if (!duration) {
    stepPetPlay(p, 0, now, state, false, occupied);
    return;
  }
  while (clock < now - 1e-9) {
    let to = Math.min(now, (Math.floor(clock * 120 + 1e-6) + 1) / 120);
    for (const event of p.ch.timeline)
      if (event.at > clock + 1e-9 && event.at < to) to = event.at;
    for (const at of [
      ...(p.pressed ? [p.started + 0.45, p.started + 0.9] : []),
      ...(p.petting ? [p.lastStroke + 0.6, p.pettedAt + 2] : []),
      ...(p.ch.attack ? [p.ch.faceAt + 0.04, p.ch.faceAt + 0.05] : []),
      p.releaseAt,
      p.faceUntil,
      p.pendingSign?.at ?? Infinity,
    ])
      if (at > clock + 1e-9 && at < to) to = at;
    stepPetPlay(p, to - clock, clock, state, false, occupied);
    const h = to - clock;
    clock = to;
    stepPetPlay(p, 0, clock, state, false, occupied);
    afterStep?.(h);
  }
}

/** Keyboard adapters retain the original pat / arrow / focus behavior. */
export function keyPetPlay(
  p: PetPlay,
  key: string,
  now: number,
  reduced = false,
) {
  notePetInput(p, now);
  if (key === "Enter") {
    pressPetPlay(
      p,
      { x: 0, y: 0.75 * 0.7, z: 0.25, logicalX: 0, logicalY: 0, zone: "top" },
      now - 0.1,
      p.state,
      reduced,
    );
    releasePetPlay(p, now, false, reduced);
    return;
  }
  if (reduced || p.state !== "idle") return;
  const d: Record<string, readonly [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, 1],
    ArrowDown: [0, -1],
  };
  const v = d[key];
  if (!v) return;
  leanTo(p, 0.6 * v[0], 0.6 * v[1]);
  p.ch.axis.t = nearAxis(p, Math.atan2(v[1], v[0]));
  p.squash.z = 0.5;
  p.squash.w = 20;
  p.squash.t = 0.03;
  const gen = ++p.ch.bodyGeneration;
  later(p, 0.25, () => {
    if (gen === p.ch.bodyGeneration && !p.pressed) p.squash.t = 0;
  });
  later(p, 0.45, () => {
    if (gen === p.ch.bodyGeneration && !p.pressed) {
      p.ch.axis.t = nearAxis(p, Math.PI / 2);
      lookAt(p, 0, 0);
    }
  });
}
export function focusPetPlay(p: PetPlay, now: number, reduced = false) {
  notePetInput(p, now);
  if (reduced || p.state !== "idle" || p.pressed) return;
  const base = { ...p.target };
  reaction(p, "neutral", now, 0.9);
  p.target = { ...base, open: base.open * 1.06 };
  lookAt(p, 0, 0.15, { eyesOnly: true, blink: false });
  blinkNow(p);
  later(p, 0.3, () => lookAt(p, 0, 0, { eyesOnly: true }));
}
export function petPlayBusy(p: PetPlay) {
  return (
    p.pressed ||
    p.petting ||
    !!p.sign ||
    !!p.pendingSign ||
    [p.squash, p.leanX, p.leanY, p.dent].some((s) => s.busy)
  );
}

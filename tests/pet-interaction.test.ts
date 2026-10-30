import {
  PET_FACES,
  createPetPlay,
  pressPetPlay,
  movePetPlay,
  releasePetPlay,
  updatePetPlay,
  cancelPetPlay,
  keyPetPlay,
  focusPetPlay,
  type PetPoint,
  type PetPlay,
} from "../packages/ui/pet-interaction";
const point = (
  logicalX = 100,
  zone: PetPoint["zone"] = "body",
  side = 0,
): PetPoint => ({
  x: (logicalX - 100) / 100,
  y: 0,
  z: 0.365,
  logicalX,
  logicalY: 100,
  zone,
  side,
});
function tick(
  p: PetPlay,
  now: number,
  reduced = false,
  state: PetPlay["state"] = "idle",
) {
  updatePetPlay(p, 1 / 30, now, state, reduced);
}
function tap(
  p: PetPlay,
  now: number,
  zone: PetPoint["zone"] = "body",
  side = 0,
  reduced = false,
) {
  pressPetPlay(p, point(100, zone, side), now);
  if (!reduced) simulate(p, now, now + 0.1);
  releasePetPlay(p, now + 0.1, false, reduced);
  if (reduced) tick(p, now + 0.32, true);
  else simulate(p, now + 0.1, now + 0.32);
}
test("ordinary slow body touches use the original three nonrepeat reactions", () => {
  const p = createPetPlay(),
    choices = new Set();
  let previous = "";
  tap(p, 40);
  for (let i = 1; i <= 18; i++) {
    tap(p, 40 + i * 2);
    tick(p, 40 + i * 2 + 0.5);
    const choice = `${p.faceName}:${p.sign?.name}`;
    expect(["happy:sparkle", "wink:sparkle", "happy:notes"]).toContain(choice);
    expect(choice).not.toBe(previous);
    previous = choice;
    choices.add(choice);
  }
  expect(choices.size).toBe(3);
});
test("six quick taps reach laugh and the ninth gives a bounded quiet moment", () => {
  const p = createPetPlay();
  for (let i = 0; i < 6; i++) tap(p, 40 + i * 0.4);
  expect(p.faceName).toBe("laugh");
  expect(p.sign?.name).toBe("notes");
  for (let i = 6; i < 9; i++) tap(p, 40 + i * 0.4);
  expect(p.faceName).toBe("moment");
  simulate(p, 43.52, 43.8);
  expect(p.sign?.name).toBe("dots");
});
test("a450ms still hold becomes a hug, hearts after900ms, release is happy", () => {
  const p = createPetPlay();
  pressPetPlay(p, point(), 1);
  tick(p, 1.449);
  expect(p.hug).toBe(false);
  tick(p, 1.45);
  expect(p.hug).toBe(true);
  expect(p.faceName).toBe("bliss");
  tick(p, 1.91);
  expect(p.sign?.name).toBe("hearts");
  expect(releasePetPlay(p, 2.2)).toBe(false);
  expect(p.faceName).toBe("happy");
});
test("petting requires three deliberate reversals, jitter is insufficient, then expires", () => {
  const p = createPetPlay();
  pressPetPlay(p, point(), 1);
  for (let i = 1; i < 8; i++)
    movePetPlay(p, point(100 + (i % 2)), 1 + i * 0.05);
  expect(p.petting).toBe(false);
  for (const [i, x] of [115, 85, 115, 85].entries())
    movePetPlay(p, point(x), 1.45 + i * 0.1);
  expect(p.petting).toBe(true);
  expect(p.faceName).toBe("content");
  tick(p, 2.4);
  expect(p.petting).toBe(false);
  expect(p.faceName).toBe("happy");
});
test.each(["listening", "working", "speaking"] as const)(
  "%s preempts hold and pending signs",
  (state) => {
    const p = createPetPlay();
    pressPetPlay(p, point(), 1);
    tick(p, 1.5);
    tick(p, 1.6, false, state);
    tick(p, 3, false, state);
    expect(p.hug).toBe(false);
    expect(p.pressed).toBe(false);
    expect(p.sign).toBeNull();
    expect(p.faceName).toBe("neutral");
  },
);
test("cancelling before a delayed release cannot produce a late face or heart", () => {
  const p = createPetPlay();
  pressPetPlay(p, point(), 1);
  releasePetPlay(p, 1.02);
  cancelPetPlay(p);
  tick(p, 3);
  expect(p.faceName).toBe("neutral");
  expect(p.sign).toBeNull();
});
test("a reduced-motion tap is a distinct still acknowledgement and expires", () => {
  const p = createPetPlay();
  tap(p, 40, "body", 0, true);
  expect(p.face.smile).toBe(1);
  expect(p.sign?.name).toBe("sparkle");
  tick(p, 42, true);
  expect(p.faceName).toBe("neutral");
  expect(p.sign).toBeNull();
});
test("eye reactions shut the touched side and a resting contact only stirs locally", () => {
  const p = createPetPlay();
  tap(p, 40);
  tap(p, 42, "eye", -1, true);
  expect(p.face.wink).toBe(1);
  tap(p, 44, "eye", 1, true);
  expect(p.face.wink).toBe(-1);
  pressPetPlay(p, point(), 50, "resting");
  releasePetPlay(p, 50.1, false, true);
  tick(p, 50.2, true, "resting");
  expect(p.state).toBe("resting");
  expect(p.sign?.name).toBe("zz");
});

test.each(["top", "eye", "cheek", "rim"] as const)(
  "first quiet %s touch is always the original happy sparkle",
  (zone) => {
    const p = createPetPlay();
    tap(p, 40, zone, -1, true);
    expect(p.faceName).toBe("happy");
    expect(p.sign?.name).toBe("sparkle");
  },
);
test("cadence precedes zones, whereas still mode skips its ladder", () => {
  const p = createPetPlay();
  tap(p, 40, "eye");
  tap(p, 40.4, "eye");
  expect(p.faceName).toBe("giggle");
  tap(p, 41, "eye", -1, true);
  expect(p.faceName).toBe("wink");
  expect(p.face.wink).toBe(1);
});
test("stationary noise cannot extend petting or earn sustained-stroke hearts", () => {
  const p = createPetPlay();
  pressPetPlay(p, point(), 1);
  for (const [i, x] of [115, 85, 115, 85].entries())
    movePetPlay(p, point(x), 1.1 + i * 0.2);
  expect(p.petting).toBe(true);
  for (let i = 1; i <= 9; i++) {
    movePetPlay(p, point(85), 1.7 + i * 0.1);
    tick(p, 1.7 + i * 0.1);
  }
  expect(p.petting).toBe(false);
  expect(p.sign?.name).not.toBe("hearts");
});
test("an established hug persists through movement until deliberate stroke or release", () => {
  const p = createPetPlay();
  pressPetPlay(p, point(), 1);
  tick(p, 1.6);
  expect(p.hug).toBe(true);
  movePetPlay(p, point(130), 1.7);
  expect(p.hug).toBe(true);
  tick(p, 2);
  expect(p.sign?.name).toBe("hearts");
  releasePetPlay(p, 2.1);
  expect(p.faceName).toBe("happy");
});

function simulate(
  p: PetPlay,
  from: number,
  to: number,
  hz = 60,
  state: PetPlay["state"] = "idle",
  occupied = false,
) {
  for (let clock = from; clock < to - 1e-9; ) {
    const next = Math.min(to, clock + 1 / hz);
    updatePetPlay(p, next - clock, next, state, false, occupied);
    clock = next;
  }
}
test("the original face delay leads the smile and its eye flinch reopens", () => {
  const p = createPetPlay();
  tap(p, 40);
  simulate(p, 40.32, 42);
  pressPetPlay(p, point(100, "eye", -1), 42);
  releasePetPlay(p, 42.1);
  simulate(p, 42.1, 42.16);
  expect(p.face.wink).toBeGreaterThan(0.5);
  simulate(p, 42.16, 42.6);
  expect(Math.abs(p.face.wink)).toBeLessThan(0.01);
});
test("laugh rolls and bounded body pulses settle without resetting ink", () => {
  const p = createPetPlay();
  for (let i = 0; i < 6; i++) tap(p, 40 + i * 0.4);
  const ink = p.ch.inkClock;
  const samples = [];
  for (let t = 42.4; t < 43; t += 1 / 60) {
    tick(p, t);
    samples.push(p.ch.frameStretch);
  }
  expect(samples.some((v) => Math.abs(v) > 0.01)).toBe(true);
  expect(samples.every((v) => Math.abs(v) <= 0.05)).toBe(true);
  expect(p.ch.inkClock).toBeGreaterThan(ink);
});
test("fixed substeps retain the same breath, blink and spring state at30 and120fps", () => {
  const a = createPetPlay(),
    b = createPetPlay();
  pressPetPlay(a, point(), 2);
  pressPetPlay(b, point(), 2);
  simulate(a, 2, 3.2, 30);
  simulate(b, 2, 3.2, 120);
  for (const k of Object.keys(a.face) as (keyof typeof a.face)[])
    expect(a.face[k]).toBeCloseTo(b.face[k], 10);
  expect(a.ch.hop.x).toBeCloseTo(b.ch.hop.x, 10);
  expect(a.ch.breath.phase).toBeCloseTo(b.ch.breath.phase, 10);
});
test("resting taps mumble, crack one eye, then turn without changing supplied sleep", () => {
  const p = createPetPlay();
  for (let i = 0; i < 3; i++) {
    pressPetPlay(p, point(), 40 + i, "resting");
    releasePetPlay(p, 40.1 + i);
    tick(p, 40.2 + i, false, "resting");
    expect(p.faceName).toBe(["mumble", "stir", "sleepy"][i]);
  }
  expect(p.ch.turn).toBe(-0.3);
  expect(p.state).toBe("resting");
  simulate(p, 42.2, 44, 60, "resting");
  expect(p.ch.turn).toBe(0);
  expect(p.state).toBe("resting");
});
test("idle is bounded, respects occupied state, and doze never makes a sleep sign", () => {
  const p = createPetPlay();
  tick(p, 1);
  simulate(p, 1, 90, 30, "idle", true);
  expect(p.ch.idleCurrent).toBeNull();
  expect(p.sign).toBeNull();
  simulate(p, 90, 185, 30);
  expect(p.ch.doze.t).toBe(1);
  expect(p.sign?.name).not.toBe("zz");
  pressPetPlay(p, point(), 185);
  expect(p.ch.doze.t).toBe(0);
  cancelPetPlay(p);
  expect(p.ch.timeline).toEqual([]);
});
test("still holds produce only the released 1.4s acknowledgement and no hidden hug", () => {
  const p = createPetPlay();
  pressPetPlay(p, point(), 1, "idle", true);
  tick(p, 2, true);
  expect(p.hug).toBe(false);
  expect(p.sign).toBeNull();
  releasePetPlay(p, 2, false, true);
  expect(p.faceName).toBe("happy");
  tick(p, 3.39, true);
  expect(p.faceName).toBe("happy");
  tick(p, 3.41, true);
  expect(p.faceName).toBe("neutral");
  expect(p.ch.timeline).toEqual([]);
});
test("keyboard arrow and focus choreography cancel without a late semantic action", () => {
  const p = createPetPlay();
  focusPetPlay(p, 1);
  expect(p.target.open).toBeCloseTo(1.06);
  keyPetPlay(p, "ArrowRight", 1.1);
  expect(p.leanX.t).toBe(0.6);
  cancelPetPlay(p);
  simulate(p, 1.1, 3);
  expect(p.faceName).toBe("neutral");
  expect(p.sign).toBeNull();
});

test("cancelling500ms into sleep entry preserves the authoritative resting target", () => {
  const p = createPetPlay();
  updatePetPlay(p, 0, 2, "idle");
  simulate(p, 2, 2.5, 60, "resting");
  expect(p.ch.sleep.t).toBe(0);
  cancelPetPlay(p);
  expect(p.ch.timeline).toEqual([]);
  simulate(p, 2.5, 5.5, 60, "resting");
  expect(p.ch.sleep.x).toBeGreaterThan(0.99);
  expect(p.sign).toBeNull();
  expect(p.ch.timeline).toEqual([]);
});

test("original surprise and yawn have a neutral open mouth rather than a smile", () => {
  expect(PET_FACES.surprise.smile).toBe(0);
  expect(PET_FACES.yawn.smile).toBe(0);
  expect(PET_FACES.neutral.smile).toBe(0.45);
});

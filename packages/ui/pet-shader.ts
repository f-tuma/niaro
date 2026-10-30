// Approved Niaro water renderer, extracted from the 2026-10-30 pet study (external halo removed).
// Only the platform lifecycle and uniform adapter are new. No DOM or profile state.
import {
  PET_COLORS,
  PET_COUNTS,
  petFrame,
  type PetMotion,
  type PetState,
} from "./pet-motion";

const vertex = `attribute vec2 p; varying vec2 uv; void main(){ uv=p; gl_Position=vec4(p,0.,1.); }`;
const fragment = `
precision highp float;
varying vec2 uv;
uniform vec4 uShapeA; // n, a, cos(rot), sin(rot)
uniform vec4 uShapeB;
uniform vec4 uTenA; uniform vec2 uTenB; // surface-tension phases as unit complex numbers, from the CPU
uniform float uMorph, uR, uBob, uBlink, uGlow, uDark, uWobble, uPix;
uniform vec3 uSq;     // squash and stretch: x the stretch (+ taller), yz its unit axis ((0, 1) is vertical)
uniform float uSleep; // 0 awake .. 1 asleep, eased: the lids droop shut with it
uniform float uInk;   // ink density: 1 awake, faint asleep, when the clouds settle like sediment (SLEEP_INK)
uniform float uFov;  // field of view: 0.37 up to stage 2, widening to 0.41 at stage 4 (mirrored in JS)
uniform vec2 uLean; // how far the body leans toward the pointer, -1..1 (a spring that lags the eyes)
uniform vec2 uGaze; // where the eyes look, -1..1: they jump first and counter-rotate as the lean arrives
uniform vec4 uFace;  // eyes: open (height), upper lid (1 open .. 0 shut), lower lid (smile), tilt (+ sad, - cross)
uniform vec4 uFace2; // love sparkle, wink (left eye shut), asym (left lid a little lower), heart catchlight (0..love)
uniform vec2 uRoll;  // the face's roll as (cos, sin): it turns the eyes, mouth and cheeks, never the body
uniform vec4 uEye;   // eye jiggle phase e^(-9it) (only while the body ripples), sparkle twinkle scale, and the
                     // body's sleep 0..1, which a stir leaves alone (only the lids follow uSleep)
uniform float uGrow; // 1: from stage 3 the face grows and the eyes sit closer (GROWN_FACE), 0: as before
uniform vec4 uMouth; // smile (-1..1), open, blush, wave
uniform vec3 uMood;  // weather light: warm (+) or cool (-), night, lightning flash
uniform vec2 uWx;    // the light's quality, eased 0..1: sun (a crisp, warm shadow), fog (soft lights, a hazy studio)
uniform vec4 uEmote; // the sign above the head: kind, pop scale, opacity, canvas pixel in uv
uniform vec2 uEmotePos;  // its centre in uv, its own motion and the frame's margin included
uniform vec3 uEmoteCol;
uniform vec4 uEmoteXf;   // its own turn and scale: cos r, sin r (sent, never trig per pixel), scale x, y
uniform vec2 uEmotePart; // its parts: w (the second star, note or heart, the dots counting up), w2 (their own bob)
uniform float uEmoteM;   // how condensed it is: 0 clear water .. 1 formed and lightly tinted
uniform vec4 uDent;      // the touch dent: its centre in the body's own space, its depth (0: none)
uniform vec3 uBg;    // the card behind the canvas, sRGB
uniform vec4 uDrop[6];  // ink clouds: centre in body space, size (0: none)
uniform vec3 uInkA[6];  // per cloud, linear and fixed (set once from the CPU): absorption (1 - colour)·1.5 + 0.04
uniform vec3 uInkG[6];  // and the colour it glows in (the old uDropCol, made linear once instead of per pixel)
// Per-frame values from the CPU (engine()), so no pixel recomputes them:
uniform vec3 uRot[3];   // local()'s lean and volume-preserving squash composed on the CPU (columns)
uniform vec2 uOffset;   // the squash about its pivot, 0.4 R below the centre
uniform vec4 uBound;    // where the body can be: x its centre's height, y a sphere round it, z half the slab |local z| it lies in
uniform vec3 uBgL, uTintL; // uBg and uTint, linear
uniform vec4 uShapeK;   // the morph's stretch (xy), min(stretch)/lip (z) and lip (w), for shape2() and edgeGL()
const float T = 0.42;
const float CAM = 3.2;
const float WALL = -1.2;

// Light is computed in linear space; the result rolls off highlights softly
// and goes back to sRGB, so bright reflections never clip into flat white.
vec3 lin(vec3 c){ return pow(c, vec3(2.2)); }
vec3 srgb(vec3 c){ return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)); }
vec3 shoulder(vec3 x){ vec3 k = vec3(0.72); return mix(x, k + (1.0 - k) * (1.0 - exp(-(x - k) / (1.0 - k))), step(k, x)); }

// ---- shape
// Lobes and rim waves are powers of the unit direction u = e^(i*th) instead of
// atan() and cos(n*th): the same curves, but exact on every GPU. Driver error in
// atan/cos, amplified by the finite-difference normals, was the grain and the
// dotted streaks on NVIDIA.
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
// u^n for an integer n in 0..15 from the ladder u, u^2, u^4, u^8 (n is a uniform, so the branches are coherent)
vec2 cpick(vec2 u1, vec2 u2, vec2 u4, vec2 u8, float n){
  vec2 r = vec2(1.0, 0.0);
  if (mod(n, 2.0) >= 0.5) r = u1;
  if (mod(floor(n * 0.5), 2.0) >= 0.5) r = cmul(r, u2);
  if (mod(floor(n * 0.25), 2.0) >= 0.5) r = cmul(r, u4);
  if (n >= 7.5) r = cmul(r, u8);
  return r;
}
vec2 cpowi(vec2 u, float n){ vec2 u2 = cmul(u, u), u4 = cmul(u2, u2); return cpick(u, u2, u4, cmul(u4, u4), n); }
// a*cos(n*th + rot) = a*Re(u^n * e^(i*rot)), with s = (n, a, cos rot, sin rot)
float lobe(vec2 u1, vec2 u2, vec2 u4, vec2 u8, vec4 s){ return s.y * cmul(cpick(u1, u2, u4, u8, s.x), s.zw).x; }
float shape2(vec2 p){
  vec2 st = uShapeK.xy;
  vec2 q = p / st;
  float L = length(q);
  vec2 u = q / max(L, 1e-6), u2 = cmul(u, u), u4 = cmul(u2, u2), u8 = cmul(u4, u4);
  // at rest only one shape is on screen, so only that one is paid for
  float k = 0.0;
  if (uMorph < 0.999) k += (1.0 - uMorph) * lobe(u, u2, u4, u8, uShapeA);
  if (uMorph > 0.001) k += uMorph * lobe(u, u2, u4, u8, uShapeB);
  float r = uR * (1.0 + k * smoothstep(0.05, 0.35, L));
  return (L - r) * uShapeK.z;
}
vec3 local(vec3 p){
  p.y -= uBob;
  return mat3(uRot[0], uRot[1], uRot[2]) * p + vec3(uOffset, 0.0);
}
// Surface tension: slow waves travelling round the rim, barely there.
// sin(3th + a + 3z)*0.55 + sin(5th + b)*0.30 + sin(7th + c - 5z)*0.15, with the
// time phases a, b, c sent as e^(ia) etc., so a tab left open for days never steps.
float tension(vec3 p){
  float L = length(p.xy);
  vec2 u = p.xy / max(L, 1e-6), u2 = cmul(u, u), u3 = cmul(u2, u), u5 = cmul(u3, u2), u7 = cmul(u5, u2);
  float rim = smoothstep(0.25, 0.85, L / uR);
  float w = cmul(cmul(u3, uTenA.xy), vec2(cos(3.0 * p.z), sin(3.0 * p.z))).y * 0.55
          + cmul(u5, uTenA.zw).y * 0.30
          + cmul(cmul(u7, uTenB), vec2(cos(5.0 * p.z), -sin(5.0 * p.z))).y * 0.15;
  return w * rim * uWobble * 0.004 * uR;
}
// The touch dent (TOUCH_DENT): a Gaussian dip under the finger, σ 0.22 R, in the body's own space,
// so it stays where it was pressed while the body squashes. Its slope is under 0.1: the march holds.
float dent(vec3 p){
  if (uDent.w == 0.0) return 0.0;
  vec3 v = p - uDent.xyz;
  return uDent.w * exp(-dot(v, v) / (0.0968 * uR * uR));
}
// the body at a point already in its own space (local() is affine, so a ray stays a line there)
float bodyL(vec3 p){
  float d2 = shape2(p.xy) - tension(p);
  return length(vec2(max(d2 + T, 0.0), p.z * 1.15)) - T + dent(p);
}
float body(vec3 p){ return bodyL(local(p)); }
// without the rim waves, which move it by at most 0.004 R uWobble: for the march through the water
float bodyCheapL(vec3 p){ return length(vec2(max(shape2(p.xy) + T, 0.0), p.z * 1.15)) - T + dent(p); }
vec3 normalAt(vec3 p){
  const vec2 e = vec2(0.0012, -0.0012);
  return normalize(e.xyy*body(p+e.xyy) + e.yyx*body(p+e.yyx) + e.yxy*body(p+e.yxy) + e.xxx*body(p+e.xxx));
}

// ---- the little studio the pet sits in
// A wall with a soft spotlight and a floor below a gentle horizon. The pet
// refracts it, which is what makes it read as water rather than film. At the
// canvas edge it fades to exactly the card colour.
vec3 moodKey(){
  return vec3(1.0) + max(uMood.x, 0.0) * (vec3(1.28, 1.0, 0.7) - 1.0) + max(-uMood.x, 0.0) * (vec3(0.78, 0.92, 1.22) - 1.0);
}
vec3 backdrop(vec2 s){
  vec3 bg = uBgL;
  float edge = 1.0 - smoothstep(0.6, 1.0, length(s));
  float spot = 1.0 - smoothstep(0.0, 0.85, length(s - vec2(0.0, 0.2)));
  vec3 wall = bg * (1.0 + spot * mix(0.06, 0.35, uDark));
  float floorMix = smoothstep(-0.36, -0.60, s.y);
  vec3 c = mix(wall, bg * mix(0.86, 1.55, uDark) + mix(0.0, 0.004, uDark), floorMix * 0.75);
  // the shadow is as wide as the pet looks, so it narrows with it when the camera widens. It stays
  // on the floor: lifted by a hop the pet leaves it to widen and fade, and a squash spreads it. From
  // stage 3 it sits a little lower, never so low that the canvas edge fades it (|y| <= 0.82)
  float lift = clamp(uBob / uR, 0.0, 0.3);
  vec2 g = (s - vec2(0.0, -min(0.80 + 0.6 * max(uR - 0.70, 0.0), 0.82)))
         / (vec2(0.5 * uR / 0.8 * (0.37 / uFov), 0.075) * (1.0 + 0.9 * lift - 0.5 * min(uSq.x, 0.0)));
  // weather sizes the shadow without moving its centre
  g /= vec2(1.0 - 0.2 * uWx.x + 0.6 * uWx.y, 1.0 - 0.2 * uWx.x);
  float shade = exp(-dot(g, g)) * (1.0 - 1.6 * lift);
  vec2 g2 = g * vec2(2.0, 1.6);
  float caustic = exp(-dot(g2, g2));
  c *= 1.0 - shade * 0.5;
  c += uTintL * caustic * mix(0.35, 0.18, uDark);
  // ... and its depth: 20% darker under the sun, whose caustic burns warmer; lighter in fog
  c *= 1.0 - shade * (0.2 * uWx.x - 0.4 * uWx.y);
  c += uTintL * caustic * mix(0.35, 0.18, uDark) * vec3(0.5, 0.2, -0.1) * uWx.x;
  // weather light: warmer sun, cooler rain or snow, dim night
  c *= mix(vec3(1.0), moodKey(), 0.25 + 0.75 * spot) * (1.0 - uMood.y * 0.45 * (0.4 + 0.6 * spot));
  // lightning: cold light on the wall behind the pet, within the spot only, so the card round it
  // never lights up as a disc; the contact shadow goes hard
  c += vec3(0.62, 0.70, 0.95) * uMood.z * 0.22 * spot;
  c *= 1.0 - shade * 0.35 * uMood.z;
  // fog lifts the studio's black level by 0.04 in display terms: hazy, and the white card stays white
  if (uWx.y > 0.001){ vec3 sc = pow(c, vec3(1.0 / 2.2)); c = pow(sc + 0.04 * uWx.y * max(1.0 - sc, 0.0), vec3(2.2)); }
  return mix(bg, c, edge);
}
// Studio reflections: a big key softbox upper left, a strip light on the
// right, a soft ceiling. Bright (HDR) so highlights stay crisp after roll-off.
float box(vec2 p, vec2 b, float soft){ vec2 d = abs(p) - b; return 1.0 - smoothstep(-soft, soft, max(d.x, d.y)); }
// the studio's walls and floor without its lights (the eyes keep only a little of it on the light card)
vec3 envAmb(vec3 d){
  vec3 bg = uBgL;
  return mix(bg * mix(0.62, 0.25, uDark) + 0.01, bg * mix(0.98, 0.8, uDark) + 0.04, smoothstep(-0.5, 0.9, d.y));
}
vec3 env(vec3 d){
  vec3 c = envAmb(d);
  if (d.z > 0.05){
    vec2 p = d.xy / d.z;
    vec3 key = moodKey() * (1.0 - uMood.y * 0.6) + uMood.z;
    // fog diffuses the lights: edges 1.5x softer, peaks lowered so the light they reflect in all
    // is never more than without fog (0.84 and 0.76: each box's integral, less the 2% the body's
    // grazing angles add)
    float sf = 1.0 + 0.5 * uWx.y;
    c += vec3(9.0) * key * box(p - vec2(-0.85, 1.0), vec2(0.42, 0.26), 0.26 * sf) * (1.0 - 0.16 * uWx.y);
    c += vec3(2.5) * key * box(p - vec2(1.35, 0.05), vec2(0.08, 0.75), 0.2 * sf) * (1.0 - 0.24 * uWx.y);
  }
  c += vec3(0.9) * smoothstep(0.55, 1.0, d.y);
  return c;
}

// The same studio seen blurred, for light bouncing inside the water: soft
// lobes instead of hard boxes, so inner reflections never look like shards.
vec3 envSoft(vec3 d){
  vec3 bg = uBgL;
  vec3 c = mix(bg * mix(0.62, 0.25, uDark) + 0.01, bg * mix(0.98, 0.8, uDark) + 0.04, smoothstep(-0.5, 0.9, d.y));
  c += vec3(1.6) * pow(max(dot(d, normalize(vec3(-0.55, 0.65, 0.52))), 0.0), 6.0);
  return c;
}
// ---- inside
// Dye clouds: each known part of the profile is a soft Gaussian cloud of
// colour suspended in the water. They absorb the light passing through and
// scatter a little of their own, so they blend like ink, never like stickers.
// A Gaussian cloud integrates in closed form along the straight chord through the
// water (local() is affine): one erf pair per cloud instead of 14 slices, with no
// slice bands while the body morphs.
// erf after Abramowitz-Stegun 7.1.27 (error below 5e-4)
float erfA(float x){
  float a = abs(x);
  float t = 1.0 + a * (0.278393 + a * (0.230389 + a * (0.000972 + a * 0.078108)));
  t *= t; t *= t;
  return sign(x) * (1.0 - 1.0 / t);
}
// Where the clouds pile up past the densest overlap of the default pose (total optical
// depth 3.9), their glow stops adding up toward white and saturates by up to KINK more
const float INK_PILE = 4.0;
const float KINK = 0.6;
// c0, c1: cosines of the chord with the entry and exit walls; deep: how deep it gets
void ink(vec3 entry, vec3 dir, float thick, float c0, float c1, float deep, out vec3 absorb, out vec3 glow){
  vec3 od = vec3(0.0), g1 = vec3(0.0), g2 = vec3(0.0); float w1 = 0.0, w2 = 0.0;
  vec3 s0 = local(entry), sv = local(entry + dir) - s0;
  float Ls = length(sv); vec3 v = sv / Ls;
  // The ink keeps clear of the walls, as the old per-slice fade over the first 0.06 of
  // depth did: the chord stops 0.03 of depth short of each wall (further along a slanted
  // chord), and a chord that never gets 0.08 deep, the rim seen edge-on, carries less.
  // The silhouette stays at least as clear as before, the inside is unchanged.
  float m0 = 0.03 / max(c0, 0.3), m1 = 0.03 / max(c1, 0.3);
  float k = min(1.0, thick * 0.5 / (m0 + m1));
  float a0 = m0 * k * Ls, a1 = (thick - m1 * k) * Ls;
  float f = smoothstep(0.0, 0.08, deep) * uInk * 7.0898 / Ls;
  for (int j = 0; j < 6; j++){
    vec4 d = uDrop[j];
    if (d.w <= 0.0) continue;
    // the density 8·exp(-1.8 r²/w²) = 8·exp(-(sa·r)²) per world unit, integrated along
    // the chord: 8·(√π/2)/sa times an erf difference (7.0898 and / Ls are in f)
    float sa = 1.3416 / d.w;
    vec3 oc = d.xyz - s0;
    float sc = dot(oc, v), b2 = max(dot(oc, oc) - sc * sc, 0.0);
    if (sa * sa * b2 > 12.0) continue; // (the chord passes 2.6 sizes away or more: below e^-12)
    float dens = exp(-sa * sa * b2) / sa * (erfA(sa * (a1 - sc)) - erfA(sa * (a0 - sc))) * f;
    od += uInkA[j] * dens;
    g1 += uInkG[j] * dens; w1 += dens;
    g2 += uInkG[j] * (dens * dens); w2 += dens * dens;
  }
  absorb = exp(-od);
  // Each cloud glows in its own colour. Up to INK_PILE the glows add, exactly as before;
  // above it the glow saturates and its hue leans toward the densest cloud there
  // (weights dens²), so a pile of six hues never sums to a white-hot core.
  float pile = smoothstep(INK_PILE, INK_PILE + 4.0, w1);
  float mag = 0.6 * min(w1, INK_PILE) + KINK * (1.0 - exp(-0.6 / KINK * max(w1 - INK_PILE, 0.0)));
  glow = mix(g1 / max(w1, 1e-4), g2 / max(w2, 1e-8), pile) * mag;
}
// Light leaving through the far side, bent once more; a slightly different
// bend per colour channel gives a faint rainbow at the rims. Past the critical
// angle the ray carries on along the surface, where the internal Fresnel term
// in main() has already turned it into reflection, so nothing switches abruptly.
vec3 through(vec3 e, vec3 r1, vec3 ne, float ior){
  vec3 r2 = refract(r1, -ne, ior);
  if (dot(r2, r2) < 0.01) r2 = normalize(r1 - ne * dot(r1, ne));
  float tt = (WALL - e.z) / min(r2.z, -0.05);
  return backdrop((e.xy + r2.xy * tt) / ((CAM - WALL) * uFov));
}
// How close a ray passes the body, for the stage-4 glow, without marching it, so rays that skip the
// march keep their glow. Near the body both parts of the distance without rim waves, the outline
// distance plus T and 1.15 z, are close to linear along the ray, so its minimum is the distance of
// the origin from the line through two samples, where the ray passes z = 0.3 and z = 0.1. (The
// smaller of the two samples alone was up to 28 levels off the marched glow on the dark card.)
float glowDist(vec3 ro, vec3 rd){
  vec3 la = local(ro + rd * ((0.3 - CAM) / rd.z)), lb = local(ro + rd * ((0.1 - CAM) / rd.z));
  vec2 a = vec2(shape2(la.xy) + T, la.z * 1.15), ab = vec2(shape2(lb.xy) + T, lb.z * 1.15) - a;
  return length(a + ab * clamp(-dot(a, ab) / dot(ab, ab), -2.0, 3.0)) - T;
}

// ---- face
// smooth max: rounds the corners where a lid meets the bead
float smax(float a, float b, float k){ float h = max(k - abs(a - b), 0.0) / k; return max(a, b) + h * h * k * 0.25; }
// An eye shaped by its lids, the way animators draw expressions: the upper lid
// drops as an arch or tilts, the lower lid rises into a smiling crescent. Where the
// lids meet, a tapered line instead: a relaxed ∪ for sleep and blinks, a happy ∩
// when the cheek closes the eye. Returns the open part, that line, how far below the
// upper lid the point is, and how shut the eye is; u is the eye's own coordinates, for
// shading it as a bead. Edges are one pixel wide (pxw: a canvas pixel at the face, fs: growth).
vec4 eyeShape(vec2 q, vec2 c, float side, float open, float lid, float low, float tilt, float fs, float pxw, out vec2 u){
  vec2 ab = vec2(0.078 * (1.0 + 0.5 * max(open - 1.0, 0.0)), 0.104 * max(open, 0.05)) * fs; // surprise widens it too
  u = (q - c) / ab;
  // solid at rest; a slight jiggle only while the body ripples
  float jig = 1.0;
  if (uWobble > 1.0){ vec2 un = u / max(length(u), 1e-4), u2 = cmul(un, un); jig += 0.02 * (uWobble - 1.0) * cmul(cmul(u2, u2), uEye.xy).y; }
  float c1 = 1.0 - lid, x2 = u.x * u.x, xin = u.x * side, kb = mix(0.05, 0.30, smoothstep(0.3, 1.0, low)), sm = smoothstep(0.4, 1.0, low);
  float topY = 1.15 - 2.35 * c1 + 0.18 * c1 * (1.0 - x2) + tilt * 0.45 * xin; // arches over the bead, never sags into a U
  float botY = -1.15 + low * 1.4 * (1.0 - kb * x2); // a flat cheek push, a soft arch when smiling
  float gap = min(1.15 - 2.17 * c1, 0.95) - max(-1.15 + low * 1.4, -0.95);
  float shut = 1.0 - smoothstep(0.08, 0.4, gap);
  float lineY = mix(-0.62 + 0.30 * x2, 0.16 - 0.42 * x2, sm);
  float w = 0.045 + 0.105 * (1.0 - x2), aaL = 0.5 * pxw / ab.y, taper = 1.0 - smoothstep(0.86, 1.0, abs(u.x));
  // Closing, the bead itself becomes the line: its top and bottom converge on the line's band from
  // wherever the lids are (a lid or cheek already past the band comes back to it) and it widens to
  // the band's tips, so a closing eye stays one opaque shape, never a pale ∪ beside a dark blob.
  // Only when it is the band does the flat line take over, underneath it. At rest shut is 0 or 1.
  float cl = smoothstep(0.0, 0.25, shut);
  // (the lids' slopes along u.x, for the edge width below)
  float sLine = mix(0.6, -0.84, sm) * u.x;
  float sTop = mix(-0.36 * c1 * u.x + 0.45 * tilt * side, sLine - 0.21 * u.x, cl);
  float sBot = mix(-2.8 * low * kb * u.x, sLine + 0.21 * u.x, cl);
  botY = mix(botY, lineY - w, cl);
  topY = mix(topY, lineY + w, cl);
  // the bead's edge sits at 0.95, where today's soft edge was half covered, so it stays the approved size
  float sx = 1.0 - 0.14 * cl; // (closing, it widens to reach the band's tips)
  float bA = length(vec2(u.x * sx, u.y)) / jig - 0.95, bB = u.y - topY, bC = botY - u.y, lids = smax(bB, bC, 0.22);
  float d = smax(bA, lids, 0.22);
  // d is in the eye's own units, taller than wide (and wider still when surprised); the gradient of the
  // nearest edge, round side or lid, blended as smax blends them, turns it into canvas pixels, so the
  // lids are one pixel wide like the sides (the magnitudes blend, so a closing slit fades, never snaps)
  float gA = length(vec2(u.x * sx * sx / ab.x, u.y / ab.y)) / (max(length(vec2(u.x * sx, u.y)), 1e-4) * jig);
  float gL = mix(length(vec2(sBot / ab.x, 1.0 / ab.y)), length(vec2(sTop / ab.x, 1.0 / ab.y)), clamp(0.5 + (bB - bC) / 0.44, 0.0, 1.0));
  float m = clamp(0.5 - d / (max(mix(gL, gA, clamp(0.5 + (bA - lids) / 0.44, 0.0, 1.0)), 1.0 / max(ab.x, ab.y)) * pxw), 0.0, 1.0);
  m *= mix(1.0, taper, cl) * (1.0 - smoothstep(0.6, 1.0, shut));
  float lash = smoothstep(0.4, 0.6, shut) * (1.0 - smoothstep(w - aaL, w + aaL, abs(u.y - lineY))) * taper;
  return vec4(m, lash, topY - u.y, shut);
}

// ---- the sign above the head, like an anime emote, made of the same water
float seg(vec2 p, vec2 a, vec2 b, float r){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
float heartD(vec2 p){
  p.y += 0.55; p.x = abs(p.x);
  if (p.y + p.x > 1.0) return length(p - vec2(0.25, 0.75)) - 0.35355;
  return sqrt(min(dot(p - vec2(0.0, 1.0), p - vec2(0.0, 1.0)), dot(p - 0.5 * max(p.x + p.y, 0.0), p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}
float dropD(vec2 p){ // a sweat drop: round below, pointed above
  p.x = abs(p.x); p.y += 0.25;
  float r1 = 0.42, r2 = 0.02, h = 0.95;
  float b = (r1 - r2) / h, a = sqrt(1.0 - b * b), k = dot(p, vec2(-b, a));
  if (k < 0.0) return length(p) - r1;
  if (k > a * h) return length(p - vec2(0.0, h)) - r2;
  return dot(p, vec2(a, b)) - r1;
}
float sparkD(vec2 p){ p = abs(p); return (pow(p.x + 0.001, 0.6) + pow(p.y + 0.001, 0.6) - pow(0.85, 0.6)) * 0.55; }
float noteD(vec2 p){
  float head = length((p - vec2(-0.2, -0.45)) * mat2(0.9, 0.35, -0.35, 0.9) / vec2(1.0, 0.75)) - 0.26;
  float stem = seg(p, vec2(0.05, -0.42), vec2(0.05, 0.62), 0.065);
  float flag = seg(p, vec2(0.05, 0.62), vec2(0.4, 0.3), 0.075);
  return min(head, min(stem, flag));
}
float zD(vec2 p){ return min(min(seg(p, vec2(-0.4, 0.4), vec2(0.4, 0.4), 0.09), seg(p, vec2(0.4, 0.4), vec2(-0.4, -0.4), 0.09)), seg(p, vec2(-0.4, -0.4), vec2(0.4, -0.4), 0.09)); }
float dotD(vec2 p, float r){ return r > 0.004 ? length(p) - r : 9.0; } // (a dot not grown yet is not there at all)
// Each sign acts with its parts (w, w2 from JS): the second star pops and twinkles, the second note
// bobs on its own, the small heart floats up, the two Zs bob and breathe in turn, the dots count up.
float emoteD(vec2 p){
  float k = uEmote.x, w = uEmotePart.x, w2 = uEmotePart.y;
  if (k < 1.5){ float a = sparkD(p); if (w < 0.02) return a; float s2 = 0.45 * w; return min(a, sparkD((p - vec2(0.75, 0.6)) / s2) * s2); }
  if (k < 2.5){ float a = noteD(p); if (w < 0.02) return a; float s2 = 0.6 * w; return min(a, noteD((p - vec2(0.85, 0.35 + w2)) / s2) * s2); }
  if (k < 3.5) return min(seg(p, vec2(0.0, -0.02), vec2(0.0, 0.62), 0.17 - 0.06 * smoothstep(0.62, -0.02, p.y)), length(p - vec2(0.0, -0.52)) - 0.17);
  if (k < 4.5) return min(heartD(p / 0.95) * 0.95, heartD((p - vec2(0.8, 0.55 + w2)) / 0.42) * 0.42);
  if (k < 5.5) return dropD(p);
  if (k < 6.5){ float a = 0.55 * (1.0 + 0.05 * w2), b = 0.38 * (1.0 - 0.05 * w2); // (w, w2: sin and cos of their phase)
    return min(zD((p + vec2(0.3, 0.25 - 0.06 * w)) / a) * a, zD((p - vec2(0.45, 0.45 - 0.06 * w)) / b) * b); }
  return min(min(dotD(p - vec2(-0.5, 0.0), 0.15 * clamp(w, 0.0, 1.0)), dotD(p, 0.15 * clamp(w - 1.0, 0.0, 1.0))), dotD(p - vec2(0.5, 0.0), 0.15 * clamp(w - 2.0, 0.0, 1.0)));
}
// The sign is a domed drop of water across the whole stroke: thick in the middle, thin and steep at
// its edge, lensing what is behind it and lightly tinted, its edge one canvas pixel wide (the field's
// value over its slope is a true distance, also for the sparkle's field, which is not one). Condensing
// (uEmoteM), the lens forms first and the tint follows. under: what it sits on (linear), cov: how much
// of that is the body, which it then shows instead of the studio (the sweat drop runs down the rim).
vec4 emote(vec2 s, vec3 under, float cov){
  if (uEmote.x < 0.5 || uEmote.z <= 0.0) return vec4(0.0);
  float S = 0.12 * uEmote.y;
  vec2 P = (s - uEmotePos) / max(S, 0.001);
  if (dot(P, P) > 6.0) return vec4(0.0);
  mat2 rot = mat2(uEmoteXf.x, uEmoteXf.y, -uEmoteXf.y, uEmoteXf.x);
  vec2 isc = 1.0 / uEmoteXf.zw;
  vec2 p = (rot * P) * isc;
  float d = emoteD(p);
  float px = uEmote.w / max(S, 0.001);
  // (the field's slope is at most about 5.3 at the sparkle's spikes and 1.3 elsewhere, so where it is
  // surely more than 2 px away the slope samples are skipped)
  if (d > 2.0 * px * (uEmote.x < 1.5 ? 6.0 : 1.4) * max(isc.x, isc.y)) return vec4(0.0);
  // (forward differences, 0.3 px apart: two more evaluations of the field instead of four, which
  // matters for the software renderer, where each one is inlined)
  float e = 0.01;
  vec2 ex = (rot * vec2(e, 0.0)) * isc, ey = (rot * vec2(0.0, e)) * isc;
  vec2 g = vec2(emoteD(p + ex) - d, emoteD(p + ey) - d) / e;
  float gl = max(length(g), 1e-3), dn = d / gl;
  float a = clamp(0.5 - dn / px, 0.0, 1.0);
  if (a <= 0.0) return vec4(0.0);
  float mL = smoothstep(0.0, 0.5, uEmoteM), mT = smoothstep(0.15, 1.0, uEmoteM);
  // the dome's depth from the same distance, its slope held to 1..2 (near the sparkle's middle the
  // field's slope runs away and would dimple the top)
  float k = clamp(1.0 + d / clamp(gl, 1.0, 2.0) / 0.3, 0.0, 0.985), hgt = sqrt(1.0 - k * k);
  vec3 nn = normalize(vec3(g / gl * k / hgt * 0.55 * mL, 1.0));
  vec3 rdv = vec3(0.0, 0.0, -1.0);
  float F = 0.04 + 0.96 * pow(clamp(1.0 - nn.z, 0.0, 1.0), 5.0);
  vec3 tl = lin(uEmoteCol);
  vec3 seen = mix(backdrop(s + nn.xy * 0.12 * mL), under, cov);
  // absorbed through the drop's depth, with a little glow of its own and a bright inner rim; on the
  // light card it keeps today's light tint (core saturation about 0.1-0.3) and holds it closer to the
  // edge, so it reads by its dome, its lens and a crisp edge rather than by a stronger colour
  vec3 body = seen * exp(-(1.0 - tl) * mix(1.12 + 0.14 * hgt, 1.2 + 1.6 * hgt, uDark) * mT) + tl * mix(0.16, 0.42, uDark) * (0.45 + 0.55 * hgt) * mT;
  body += tl * mix(0.1, 0.35, uDark) * smoothstep(0.55, 0.95, k) * (1.0 - smoothstep(0.95, 1.0, k)) * mT;
  vec3 c = body * (1.0 - F) + env(reflect(rdv, nn)) * F * 0.6;
  // (today's peak, 1.2 x 0.5, in a tighter lobe: the reflection is never stronger)
  c += vec3(0.6) * pow(max(dot(reflect(rdv, nn), normalize(vec3(-0.5, 0.7, 0.5))), 0.0), 40.0);
  return vec4(srgb(shoulder(c)), a * uEmote.z);
}

// Half a level of interleaved-gradient noise, so dark gradients do not band.
// Pixels that already equal the card colour stay exact: the canvas edge never shows.
vec3 dither(vec3 c){
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  return c + (ign - 0.5) / 255.0 * step(0.5 / 255.0, length(c - uBg));
}

// The outline's slope at x: (|grad d2| * lip, lip) with d2 from shape2(). It turns
// a distance value into true distance, so the edge is 1 px wide at lobe tips and
// valleys alike (squash and lean are ignored: a few percent).
vec2 edgeGL(vec3 x){
  vec3 l = local(x);
  vec2 st = uShapeK.xy;
  vec2 q = l.xy / st;
  float r = max(length(q), 1e-3);
  vec2 qh = q / r;
  // d(a*cos(n*th + rot))/dth = -a*n*sin(n*th + rot)
  float kd = mix(-uShapeA.y * uShapeA.x * cmul(cpowi(qh, uShapeA.x), uShapeA.zw).y,
                 -uShapeB.y * uShapeB.x * cmul(cpowi(qh, uShapeB.x), uShapeB.zw).y, uMorph);
  float lip = uShapeK.w;
  vec2 gq = qh - vec2(-qh.y, qh.x) * (uR * kd / r);
  return vec2(length(gq / st) * min(st.x, st.y), lip);
}

void main(){
  vec3 ro = vec3(0.0, 0.0, CAM);
  vec3 rd = normalize(vec3(uv * uFov, -1.0));
  // The march runs only where the ray crosses both bounds of the body: the sphere round its widest
  // reach and the slab |local z| <= T/1.15 that holds it exactly (local z is the third row of uRot).
  // The background skips it, and the march starts where the body can begin, in the body's own space.
  float t = 1.8, minD = 9.0, tMin = 1.8; bool hit = false;
  vec3 oc = ro - vec3(0.0, uBound.x, 0.0), ns = vec3(uRot[0].z, uRot[1].z, uRot[2].z);
  float bq = dot(oc, rd), disc = bq * bq - dot(oc, oc) + uBound.y * uBound.y, sq = sqrt(max(disc, 0.0));
  float s0 = dot(ns, oc), sv = -dot(ns, rd); // the ray goes into the slab: sv is near 1
  float t0 = max(max(1.8, -bq - sq), (s0 - uBound.z) / sv), t1 = min(-bq + sq, (s0 + uBound.z) / sv);
  if (disc > 0.0 && t0 < t1){
    vec3 l0 = local(ro), lv = local(ro + rd) - l0;
    t = t0; tMin = t;
    for (int i = 0; i < 80; i++){
      float d = bodyL(l0 + lv * t);
      if (d < minD){ minD = d; tMin = t; }
      if (d < 0.001){ hit = true; break; }
      t += d * 0.8;
      if (t > t1) break;
    }
  }
  // No external aura: colour and light stay inside the body.
  vec3 bgc = backdrop(uv);
  // anti-aliased silhouette: pixels the surface only grazes are shaded at the
  // closest point and blended by how much of the pixel it covers, a 1-px box
  // centred on the outline. The distance to it comes from the outline's slope
  // (misses) or the rim's curvature (hits); both measure from where the march
  // calls it a hit (0.001), so they meet without a step.
  float pxw = uPix / 1.5; // one canvas pixel in world units, at the camera distance
  float cov = 1.0;
  if (!hit){
    cov = 0.0;
    if (minD < uPix){ vec2 eg = edgeGL(ro + rd * tMin); cov = clamp(0.5 - (minD - 0.001) * eg.y / eg.x / (pxw * tMin / CAM), 0.0, 1.0); }
    if (cov <= 0.0){ vec4 em = emote(uv, bgc, 0.0); gl_FragColor = vec4(dither(mix(srgb(bgc), em.rgb, em.a)), 1.0); return; }
    t = tMin;
  }
  vec3 p = ro + rd * t; vec3 n = normalAt(p);
  float cosi = clamp(dot(n, -rd), 0.0, 1.0);
  if (hit && cosi < 0.5){
    // the rim's cross-section is an ellipse; rho is its radius of curvature at the outline
    vec2 eg = edgeGL(p); float rho = T * eg.x / (1.3225 * eg.y);
    cov = clamp(0.5 + rho * (1.0 - sqrt(1.0 - cosi * cosi)) / (pxw * t / CAM), 0.0, 1.0);
  }
  float F = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);

  vec3 r1 = refract(rd, n, 1.0 / 1.33);
  // The way out is marched without the rim waves, in the body's own space, and its last step is a
  // secant onto the surface instead of the step floor's overshoot. (Full steps: the secant and the
  // exact steps below take back any overshoot.)
  vec3 c0 = local(p), cv = local(p + r1) - c0;
  float th = 0.02, deep = 0.0, thP = 0.02, dP = 0.0; // (deep: the chord's greatest depth, for the ink)
  for (int i = 0; i < 32; i++){
    float d = -bodyCheapL(c0 + cv * th);
    deep = max(deep, d);
    if (d < 0.0015){ if (i > 0) th = thP + (th - thP) * dP / max(dP - d, 1e-4); break; }
    thP = th; dP = d;
    th += max(d, 0.008);
  }
  // two distance steps on the exact body put the exit point on the true surface, rim waves
  // included, whose normal it takes: the waves keep moving the light seen through the back
  th -= bodyL(c0 + cv * th); th -= bodyL(c0 + cv * th);
  vec3 e = p + r1 * th; vec3 ne = normalAt(e);
  // Reflection back inside at the exit (Schlick on the transmitted angle). Each
  // colour has its own critical angle, so the rim keeps a thin continuous
  // rainbow, but the rise to total reflection is smooth instead of a per-pixel switch.
  float ce = clamp(dot(r1, ne), 0.0, 1.0);
  vec3 s2t = vec3(1.7161, 1.7689, 1.836) * (1.0 - ce * ce); // ior^2 * sin^2, per channel
  vec3 Rin = 0.02 + 0.98 * pow(1.0 - sqrt(max(1.0 - s2t, 0.0)), vec3(5.0));
  Rin = mix(Rin, vec3(1.0), smoothstep(0.9, 1.0, s2t));
  vec3 tr = vec3(through(e, r1, ne, 1.31).r, through(e, r1, ne, 1.33).g, through(e, r1, ne, 1.355).b);
  tr = mix(tr, envSoft(reflect(r1, -ne)) * 0.6, Rin);

  vec3 tint = uTintL;
  vec3 water = exp(-((vec3(1.0) - tint) * 0.85 + 0.02) * th);
  vec3 inkA, inkG; ink(p, r1, th, dot(r1, -n), ce, deep, inkA, inkG);
  vec3 trans = tr * water * inkA + inkG * 0.55;

  // light from behind glowing through thin parts (translucency)
  vec3 Lb = normalize(vec3(-0.15, 0.45, -0.88));
  float sss = pow(clamp(dot(-rd, -(Lb + n * 0.45)), 0.0, 1.0), 3.0) * exp(-th * 2.0);
  vec3 glow = (tint * 1.3 + 0.08) * sss * 0.9;
  // lightning lights the pet from behind too: a cold-white rim where the water is thin
  if (uMood.z > 0.001) glow += vec3(0.7, 0.8, 1.0) * uMood.z * 2.2 * pow(clamp(dot(-rd, -(Lb + n * 0.45)), 0.0, 1.0), 2.0) * exp(-th * 3.0);
  // (reflections caught inside, off the far surface, are Rin above: they pass
  // through the water and the ink like the rest of the transmitted light)

  // The face sits on the surface, over the reflections: glossy black beads that reflect the
  // same studio as the body, a small cavity for a mouth, and a blush only when a face asks
  // for one, a pigment under the clear coat.
  float eyeM = 0.0; vec3 eyeShade = vec3(0.0);
  float mouthM = 0.0; vec3 mouthShade = vec3(0.0);
  vec3 q = local(p);
  if (n.z > 0.15){
    // the face alone may roll a little, about a point just above the centre; the body,
    // its ink and its reflections never turn with it
    vec2 piv = vec2(0.0, uR * 0.05);
    vec2 qf = mat2(uRoll.x, uRoll.y, -uRoll.y, uRoll.x) * (q.xy - piv) + piv;
    float pxf = pxw * t / CAM; // one canvas pixel in world units, at the face
    // from stage 3 the features grow a little with the body and sit closer together
    // (no wide-set eyes); stages 1-2 keep their approved face exactly
    float fs = 1.0 + 0.5 * max(uR / 0.70 - 1.0, 0.0) * uGrow;
    float ey = uR * 0.16; float ex = uR <= 0.70 || uGrow < 0.5 ? 0.30 * uR : 0.21 * fs;
    // Past this box the eye sockets end and the soft cheek pigment is below a pixel's precision.
    // It is measured in the rolled face space, so every glance and expression stays inside.
    if (abs(qf.x) < ex + 0.23 * fs && abs(qf.y - ey) < max(0.34, 0.18 * uFace.x) * fs) {
    vec2 gaze = uGaze * vec2(0.035, 0.025) * uR;
    vec2 qe = qf - gaze;
    // a blink squeezes the eye a little and lifts the lower lid to meet the upper one
    float open = uFace.x * (1.0 - 0.22 * (1.0 - uBlink));
    // falling asleep the upper lids droop shut and the lower ones relax, into the ∪ line
    float sl = smoothstep(0.35, 0.85, uSleep);
    float lid = mix(uFace.y * uBlink, 0.0, sl);
    float low = mix(uFace.z + 0.12 * (1.0 - uBlink), 0.0, uSleep);
    vec2 ul, ur;
    // the wink shuts the left eye (+), or the right one when a tap on it makes it flinch (-)
    float wl = max(uFace2.y, 0.0), wr = max(-uFace2.y, 0.0);
    vec4 L = eyeShape(qe, vec2(-ex, ey), 1.0, open, lid * (1.0 - wl) - uFace2.z, low + wl * 0.6, uFace.w, fs, pxf, ul);
    vec4 Rr = eyeShape(qe, vec2(ex, ey), -1.0, open, lid * (1.0 - wr), low + wr * 0.6, uFace.w, fs, pxf, ur);
    bool left = L.x + L.y >= Rr.x + Rr.y;
    vec2 u = left ? ul : ur;
    float m = left ? L.x : Rr.x;
    float lash = left ? L.y : Rr.y;
    eyeM = max(m, lash);
    float shut = left ? L.w : Rr.w;
    if (eyeM > 0.0) {
    // the bead: a sphere-ish normal from the eye's own coordinates, nudged by the body
    vec3 en = normalize(vec3(u * 0.7 + n.xy * 0.4, sqrt(max(0.0, 1.0 - 0.49 * dot(u, u))) * 1.1));
    float Fe = 0.04 + 0.96 * pow(1.0 - clamp(dot(en, -rd), 0.0, 1.0), 5.0);
    // black in every mood, love too; on the light card it keeps the studio lights but only
    // 15% of the white wall, so it stays a near-black bead there as well
    vec3 rde = reflect(rd, en);
    vec3 bead = vec3(0.0012, 0.0012, 0.003) + (env(rde) - envAmb(rde) * 0.85 * (1.0 - uDark)) * (Fe * 0.9 + 0.03 * uDark);
    // Painted catchlights, so both eyes match: a key just under the lid where the softbox
    // lands, a small fill below, both round on the surface. They follow the bead only
    // halfway, so they stay with the light. In love the key becomes a heart and a
    // 4-point sparkle twinkles opposite.
    vec2 ab = vec2(0.078 * (1.0 + 0.5 * max(open - 1.0, 0.0)), 0.104 * max(open, 0.05)) * fs; // eye units in world units
    float lidE = left ? uFace.y * (1.0 - wl) - uFace2.z : uFace.y * (1.0 - wr); // the expression's lid, without blinks
    vec2 kc = vec2(-0.34, min(0.46, 1.15 - 2.17 * (1.0 - lidE) - 0.3)) - 0.5 * gaze / ab;
    vec2 iso = vec2(1.0, ab.y / ab.x);
    float pe = ab.x / pxf; // canvas pixels per round eye unit
    float cl1 = clamp(0.5 - (length((u - kc) * iso) - 0.17) * pe, 0.0, 1.0);
    float hrt = clamp(0.5 - heartD((u - kc - vec2(0.02, -0.04)) * iso / 0.42) * 0.42 * pe, 0.0, 1.0);
    cl1 = mix(cl1, hrt, uFace2.w);
    // (the fill fades under a low lid, where it would sit beside the key like a second pupil)
    float cl2 = clamp(0.5 - (length((u - vec2(0.30, -0.38)) * iso) - 0.08) * pe, 0.0, 1.0) * (0.35 + 0.65 * uFace2.x) * smoothstep(0.45, 0.8, lidE);
    float star = uFace2.x * clamp(0.5 - sparkD((u - vec2(0.3, 0.3)) * iso / (0.3 * uEye.z)) * 0.3 * uEye.z * pe, 0.0, 1.0);
    // (a closing eye loses its glints first: the band it turns into must not rise into one)
    bead += (vec3(1.6) * cl1 + vec3(1.2) * cl2 + vec3(1.4) * star) * m * (1.0 - smoothstep(0.0, 0.06, shut));
    // light bounced into the lower edge
    bead += mix(tint, vec3(1.0), 0.4) * smoothstep(0.55, 0.95, length(u)) * smoothstep(-0.2, -0.8, u.y) * 0.08 * m;
    // a lowered lid shades the bead just below its edge, so it reads as a lid and not a mask
    bead *= 1.0 - 0.25 * (1.0 - smoothstep(0.8, 0.9, lidE)) * (1.0 - smoothstep(0.0, 1.5 * pxf / ab.y, left ? L.z : Rr.z));
    // (and while it turns into the line it darkens into the line's flat black)
    eyeShade = mix(vec3(0.0015, 0.0015, 0.004), bead, m / max(eyeM, 0.001) * (1.0 - smoothstep(0.0, 0.25, shut)));
    }
    // a soft socket: the body dims a little around each eye, and its lower rim catches light
    float halo = max(1.0 - smoothstep(1.0, 1.6, length((qe - vec2(-ex, ey)) / (vec2(0.078, 0.104 * open) * fs))),
                     1.0 - smoothstep(1.0, 1.6, length((qe - vec2(ex, ey)) / (vec2(0.078, 0.104 * open) * fs))));
    // (asleep it fades: over closed eyes the light card would show it as a grey oval; it follows the
    // body's sleep, not the lids, so a stir that cracks an eye open does not bring it back)
    trans *= 1.0 - halo * 0.18 * (1.0 - eyeM) * (1.0 - 0.8 * uEye.w);

    // One mouth that opens, so there is never a double line: a tapered smile or frown
    // when closed, a D when laughing, an O when surprised, a wavy line when worried or
    // mumbling; the wink pulls one corner into a smirk. It turns with the head, not the eyes.
    vec2 mq = (qf - uLean * vec2(0.035, 0.025) * uR * 0.6 - vec2(0.0, ey - 0.165 * fs)) / fs;
    float o = uMouth.y, s = uMouth.x, sp = smoothstep(0.1, 0.6, s);
    float W = mix(0.058, mix(0.012 + 0.034 * o, 0.058 + 0.006 * o, sp), smoothstep(0.0, 0.25, o));
    float x = mq.x / W;
    float bowl = sqrt(max(1.0 - x * x, 0.0));
    float ks = s * (s > 0.0 ? 0.022 : 0.036), wv = uMouth.w * 0.0055, wk = uFace2.y * 0.010;
    float yc = ks * (x * x - 0.45) + wv * sin(x * 6.2832) - wk * x;
    float lth = mix(0.0095 * (1.0 - x * x) + 0.0022, 0.0052, uMouth.w);
    float up = o * 0.040 * (1.0 - sp), dn = o * 0.060;
    float yT = yc + lth + up * bowl, yB = yc - lth - dn * bowl;
    // the lips' slopes turn the vertical distance into a true one, so the steep sides of
    // an O or a D are one pixel wide too (the bowl's slope is capped near the corners)
    float dyc = 2.0 * ks * x + wv * 6.2832 * cos(x * 6.2832) - wk, dth = -0.019 * x * (1.0 - uMouth.w), db = -x / max(bowl, 0.15);
    float sT = (dyc + dth + up * db) / W, sB = (dyc - dth - dn * db) / W;
    float md = max((mq.y - yT) * inversesqrt(1.0 + sT * sT), (yB - mq.y) * inversesqrt(1.0 + sB * sB));
    mouthM = clamp(0.5 - md * fs / pxf, 0.0, 1.0) * clamp(0.5 - (abs(x) - 1.0) * W * fs / pxf, 0.0, 1.0);
    float vy = clamp((mq.y - yB) / max(yT - yB, 1e-4), 0.0, 1.0);
    vec3 inside = mix(lin(vec3(0.26, 0.05, 0.09)), lin(vec3(0.06, 0.01, 0.03)), smoothstep(0.15, 0.85, vy));
    // the tongue starts just above the lower lip, so a dark rim keeps the mouth's outline over pink ink
    float tongue = smoothstep(0.09, 0.15, vy) * (1.0 - smoothstep(0.28, 0.42, vy)) * (1.0 - smoothstep(0.35, 0.7, abs(x))) * smoothstep(0.3, 0.55, o);
    inside = mix(inside, lin(vec3(0.95, 0.45, 0.55)) * 0.8, tongue);
    inside += mix(tint, vec3(1.0), 0.5) * smoothstep(0.88, 1.0, vy) * (1.0 - smoothstep(0.6, 0.95, abs(x))) * 0.12; // wet upper lip
    mouthShade = mix(vec3(0.0015, 0.0012, 0.003), inside, smoothstep(0.1, 0.3, o) * smoothstep(0.004, 0.02, yT - yB - 2.0 * lth));

    // blush: a pigment under the clear coat, soft ovals under the outer half of each eye;
    // the reflection is still added on top, so the cheeks stay wet glass
    vec2 gL = (qf - vec2(-(ex + 0.035 * fs), ey - 0.135 * fs)) / (vec2(0.075, 0.045) * fs);
    vec2 gR = (qf - vec2(ex + 0.035 * fs, ey - 0.135 * fs)) / (vec2(0.075, 0.045) * fs);
    float cheekM = max(exp(-2.5 * dot(gL, gL)), exp(-2.5 * dot(gR, gR)));
    vec3 bc = lin(vec3(1.0, 0.56, 0.64)) * mix(1.0, 0.8, uDark) * (0.55 + 0.45 * dot(trans, vec3(0.2126, 0.7152, 0.0722)));
    // (0.55 on the light card: the cheek over pink ink still shows, the other never glows)
    trans = mix(trans, bc, cheekM * uMouth.z * mix(0.55, 0.6, uDark));
  }
  }

  vec3 col = trans * (1.0 - F) + env(reflect(rd, n)) * F + glow;
  col = mix(col, eyeShade, eyeM);
  col = mix(col, mouthShade, mouthM);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(l), col, 1.12), 0.0);
  vec3 outc = srgb(shoulder(col));
  vec4 em = emote(uv, mix(bgc, col, cov), cov);
  gl_FragColor = vec4(dither(mix(mix(srgb(bgc), outc, cov), em.rgb, em.a)), 1.0);
}`;

const uniformNames = [
  "uEmote",
  "uEmotePos",
  "uEmoteCol",
  "uEmoteXf",
  "uEmotePart",
  "uEmoteM",
  "uDent",
  "uFace",
  "uFace2",
  "uMouth",
  "uMood",
  "uBg",
  "uPix",
  "uFov",
  "uLean",
  "uGaze",
  "uWobble",
  "uShapeA",
  "uShapeB",
  "uTenA",
  "uTenB",
  "uMorph",
  "uR",
  "uSq",
  "uBob",
  "uBlink",
  "uSleep",
  "uInk",
  "uRoll",
  "uEye",
  "uGrow",
  "uGlow",
  "uDark",
  "uDrop[0]",
  "uWx",
  "uInkA[0]",
  "uInkG[0]",
  "uRot[0]",
  "uOffset",
  "uBound",
  "uBgL",
  "uTintL",
  "uShapeK",
] as const;
const rgb = (hex: string) =>
  [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
const linear = (color: readonly number[]) =>
  color.map((value) => Math.pow(value, 2.2));
const inkGlow = PET_COLORS.flatMap(linear);
const inkAbs = inkGlow.map((value) => (1 - value) * 1.5 + 0.04);

/** Owns only its GL resources. Dispose also handles partial compilation failures. */
export function createPetShader(gl: WebGLRenderingContext, background: string) {
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  const dispose = () => {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
    buffer = null;
    program = null;
    shaders.length = 0;
  };
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw Error("Pet shader unavailable");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error("Pet shader compile failed");
      return shader;
    };
    program = gl.createProgram();
    if (!program) throw Error("Pet program unavailable");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error("Pet shader link failed");
    gl.useProgram(program);
    buffer = gl.createBuffer();
    if (!buffer) throw Error("Pet buffer unavailable");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const locations = new Map(
      uniformNames.map((name) => [name, gl.getUniformLocation(program!, name)]),
    );
    type Name = (typeof uniformNames)[number];
    const one = (name: Name, value: number) => {
      const loc = locations.get(name);
      if (loc != null) gl.uniform1f(loc, value);
    };
    const two = (name: Name, a: number, b: number) => {
      const loc = locations.get(name);
      if (loc != null) gl.uniform2f(loc, a, b);
    };
    const three = (name: Name, values: readonly number[] | Float32Array) => {
      const loc = locations.get(name);
      if (loc != null) gl.uniform3fv(loc, values as number[]);
    };
    const four = (name: Name, a: number, b: number, c: number, d: number) => {
      const loc = locations.get(name);
      if (loc != null) gl.uniform4f(loc, a, b, c, d);
    };
    let lastBackground = "";
    const backdrop = (color: string) => {
      if (color === lastBackground) return;
      lastBackground = color;
      const bg = rgb(color);
      three("uBg", bg);
      three("uBgL", linear(bg));
      one("uDark", bg.reduce((a, b) => a + b, 0) < 1.5 ? 1 : 0);
    };
    backdrop(background);
    three("uTintL", linear([0.74, 0.7, 0.98]));
    three("uInkA[0]", inkAbs);
    three("uInkG[0]", inkGlow);
    four("uShapeA", 9, 0.075, 1, 0);
    four("uShapeB", 9, 0.075, 1, 0);
    four("uShapeK", 1, 1, 1 / 1.675, 1.675);
    one("uMorph", 1);
    one("uR", 0.7);
    one("uFov", 0.37);
    one("uGrow", 1);
    one("uGlow", 0);
    two("uLean", 0, 0);
    two("uRoll", 1, 0);
    four("uFace2", 0, 0, 0, 0);
    three("uMood", [0, 0, 0]);
    two("uWx", 0, 0);
    four("uDent", 0, 0, 0, 0);
    four("uEmote", 0, 1, 0, 0);
    four("uEmoteXf", 1, 0, 1, 1);
    const drops = new Float32Array(24);
    const rotation = new Float32Array(9);
    return {
      draw(
        motion: PetMotion,
        state: PetState,
        reduced: boolean,
        backgroundColor = background,
      ) {
        if (!program) return;
        gl.useProgram(program);
        backdrop(backgroundColor);
        const frame = petFrame(motion, state, reduced);
        const time = frame.time;
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        one(
          "uPix",
          ((2 * 3.2 * 0.37) / Math.max(1, gl.drawingBufferWidth)) * 1.5,
        );
        four(
          "uTenA",
          Math.cos(1.3 * time),
          Math.sin(1.3 * time),
          Math.cos(1.7 - 1.9 * time),
          Math.sin(1.7 - 1.9 * time),
        );
        two("uTenB", Math.cos(2.7 * time), Math.sin(2.7 * time));
        one("uWobble", reduced ? 0.6 : 1 - 0.5 * frame.sleep);
        two("uGaze", frame.gazeX, frame.gazeY);
        four("uFace", 1, 1, frame.pleased, 0);
        four("uMouth", frame.smile, frame.mouth, frame.blush, 0);
        four("uEye", Math.cos(9 * time), -Math.sin(9 * time), 1, frame.sleep);
        one("uBlink", frame.blink);
        one("uSleep", frame.sleep);
        one("uInk", 1 - 0.8 * frame.sleep);
        three("uSq", [frame.stretch, 0, 1]);
        one("uBob", frame.bob);
        const inverseX = Math.sqrt(1 + frame.stretch),
          inverseY = 1 / (1 + frame.stretch);
        rotation.fill(0);
        // One affine transform for geometry, ink and studio reflections.
        const cos = Math.cos(frame.tilt),
          sin = Math.sin(frame.tilt);
        rotation[0] = inverseX * cos;
        rotation[1] = -inverseY * sin;
        rotation[3] = inverseX * sin;
        rotation[4] = inverseY * cos;
        rotation[8] = inverseX;
        three("uRot[0]", rotation);
        two("uOffset", 0, 0.4 * 0.7 * (inverseY - 1));
        const scale = Math.max(1 + frame.stretch, 1 / inverseX);
        const shift =
          0.4 *
          0.7 *
          Math.max(Math.abs(frame.stretch), Math.abs(1 / inverseX - 1));
        four(
          "uBound",
          frame.bob,
          (0.7 * 1.075 + 0.004 * 0.7 * 1.675) * scale + shift + 0.02,
          0.42 / 1.15,
          0,
        );
        PET_COUNTS.forEach((count, i) => {
          const size = count
            ? Math.min(0.36, 0.17 + 0.05 * Math.sqrt(count)) * (0.7 / 0.8)
            : 0;
          const phase = i * 1.047 + 0.3,
            speed = 0.18 + i * 0.035;
          const orbit = Math.max(0, 0.7 * 0.4 - size * 0.55);
          const x = Math.cos(time * speed + phase) * orbit;
          const y =
            Math.sin(time * speed * 1.3 + phase) * orbit * 0.75 - 0.7 * 0.08;
          drops[i * 4] = x + ((i - 2) * 0.182 - x) * frame.sleep;
          drops[i * 4 + 1] = y + (-0.385 - y) * frame.sleep;
          drops[i * 4 + 2] =
            Math.sin(time * speed * 0.7 + phase * 2) * 0.08 * (1 - frame.sleep);
          drops[i * 4 + 3] = size;
        });
        const loc = locations.get("uDrop[0]");
        if (loc != null) gl.uniform4fv(loc, drops);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.flush();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

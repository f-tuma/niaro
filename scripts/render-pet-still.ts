// Renders the bundled pet still (packages/ui/assets/pet-still.png): the first live frame of the
// default pet on the app's card, 200 pt at 1.5x, exactly as PetView draws it, and stamps the
// shader version into pet-snapshot.ts. Run after any shader change (a test fails until then):
//
//   npx tsx scripts/render-pet-still.ts [path to Chrome or chrome-headless-shell]
//
// The renderer's GL calls are recorded here in Node and replayed in headless Chrome on the
// SwiftShader CPU renderer, so the image does not depend on this machine's GPU.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tokens } from "../packages/design-tokens";
import { petHash } from "../packages/ui/pet-hash";
import {
  advancePetMotion,
  petRenderSize,
  setPetAppearance,
} from "../packages/ui/pet-motion";
import { createPetShader, PET_SHADER_SOURCE } from "../packages/ui/pet-shader";
import { createPetMotion } from "../packages/ui/pet-store";

const root = join(import.meta.dirname, "..");
const { pixels } = petRenderSize(200, 1.5);

type Arg =
  | number
  | string
  | boolean
  | null
  | { ref: number }
  | { f32: number[] };
const calls: [string, Arg[], number?][] = [];
let next = 0;
const constants: Record<string, number> = {
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  ARRAY_BUFFER: 0x8892,
  STATIC_DRAW: 0x88e4,
  FLOAT: 0x1406,
  TRIANGLES: 0x0004,
};
const encode = (value: unknown): Arg =>
  value instanceof Float32Array
    ? { f32: [...value] }
    : Array.isArray(value)
      ? { f32: value as number[] }
      : value && typeof value === "object" && "ref" in value
        ? (value as { ref: number })
        : (value as Arg);
const gl = new Proxy(
  { drawingBufferWidth: pixels, drawingBufferHeight: pixels, ...constants },
  {
    get(target, key: string) {
      if (key in target) return target[key as keyof typeof target];
      return (...args: unknown[]) => {
        const returns = /^(create|getUniformLocation|getAttribLocation)/.test(
          key,
        );
        const ref = returns ? ++next : undefined;
        calls.push([key, args.map(encode), ref]);
        if (key === "getShaderParameter" || key === "getProgramParameter")
          return true;
        if (key === "getExtension") return null;
        return returns ? { ref } : undefined;
      };
    },
  },
) as unknown as WebGLRenderingContext;

// PetView's first frame: a new motion, the default look, one step of zero length, then draw.
const background = tokens.color.background;
const renderer = createPetShader(gl, background);
const motion = createPetMotion("idle");
setPetAppearance(motion, undefined, false);
advancePetMotion(motion, 0, "idle", 0, undefined, false, false);
renderer.draw(motion, "idle", false, background);

const page = `<!doctype html><html><body><script>
const calls = ${JSON.stringify(calls)};
const canvas = document.createElement("canvas");
canvas.width = ${pixels}; canvas.height = ${pixels};
const gl = canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: true });
const refs = new Map();
const decode = (a) => a && typeof a === "object" ? ("ref" in a ? refs.get(a.ref) : new Float32Array(a.f32)) : a;
for (const [name, args, ref] of calls) {
  if (name === "getExtension") continue;
  const result = gl[name](...args.map(decode));
  if (ref !== undefined) refs.set(ref, result);
}
const program = [...refs.values()].find((v) => v instanceof WebGLProgram);
const ok = gl.getProgramParameter(program, gl.LINK_STATUS);
document.body.setAttribute("data-png", ok ? canvas.toDataURL("image/png") : "ERR " + gl.getProgramInfoLog(program));
</script></body></html>`;

function chrome() {
  const given = process.argv[2] ?? process.env.PET_STILL_CHROME;
  if (given) return given;
  const cache = join(homedir(), ".cache", "ms-playwright");
  for (const dir of existsSync(cache)
    ? readdirSync(cache).sort().reverse()
    : []) {
    const shell = join(
      cache,
      dir,
      "chrome-headless-shell-linux64",
      "chrome-headless-shell",
    );
    if (dir.startsWith("chromium_headless_shell") && existsSync(shell))
      return shell;
  }
  throw Error("Pass the path to Chrome or chrome-headless-shell");
}
const dir = mkdtempSync(join(tmpdir(), "pet-still-"));
writeFileSync(join(dir, "still.html"), page);
const dom = execFileSync(
  chrome(),
  [
    "--headless",
    "--no-sandbox",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    `--user-data-dir=${join(dir, "profile")}`,
    "--dump-dom",
    `file://${join(dir, "still.html")}`,
  ],
  { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 },
).toString();
const png = dom.match(/data-png="data:image\/png;base64,([^"]+)"/)?.[1];
if (!png)
  throw Error(
    "Render failed: " +
      (dom.match(/data-png="([^"]*)"/)?.[1] ?? dom.slice(0, 500)),
  );
writeFileSync(
  join(root, "packages/ui/assets/pet-still.png"),
  Buffer.from(png, "base64"),
);
const version = petHash(PET_SHADER_SOURCE);
const snapshotFile = join(root, "packages/ui/pet-snapshot.ts");
writeFileSync(
  snapshotFile,
  readFileSync(snapshotFile, "utf8").replace(
    /export const BUNDLED_STILL_VERSION = "[^"]*";/,
    `export const BUNDLED_STILL_VERSION = "${version}";`,
  ),
);
console.log(`pet-still.png ${pixels}px, shader ${version}`);

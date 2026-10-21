import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  createReadStream,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const revision = "927cfce34f31707e17f2bff35c349632fb9e2c3a"; // whisper.cpp v1.9.4
const digest =
  "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${command} failed`);
}
async function hash(path) {
  const result = createHash("sha256");
  for await (const chunk of createReadStream(path)) result.update(chunk);
  return result.digest("hex");
}
const directory = resolve(".voice");
const source = `${directory}/whisper.cpp`;
mkdirSync(`${directory}/models`, { recursive: true, mode: 0o700 });
if (!existsSync(source))
  run("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    "v1.9.4",
    "https://github.com/ggml-org/whisper.cpp.git",
    source,
  ]);
const head = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], {
  encoding: "utf8",
});
if (head.status !== 0 || head.stdout.trim() !== revision)
  throw new Error(
    "Whisper source revision mismatch; existing checkout was not modified.",
  );
run("cmake", [
  "-S",
  source,
  "-B",
  `${source}/build`,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DWHISPER_BUILD_TESTS=OFF",
  "-DWHISPER_BUILD_EXAMPLES=ON",
  "-DGGML_NATIVE=OFF",
]);
run("cmake", [
  "--build",
  `${source}/build`,
  "--target",
  "whisper-cli",
  "whisper-vad-speech-segments",
  "-j",
  "8",
]);
const model = `${directory}/models/ggml-small.bin`;
if (!existsSync(model)) {
  run("curl", [
    "--fail",
    "--location",
    "--retry",
    "2",
    "--output",
    `${model}.part`,
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin",
  ]);
  if ((await hash(`${model}.part`)) !== digest)
    throw new Error("Model checksum mismatch");
  renameSync(`${model}.part`, model);
}
if ((await hash(model)) !== digest)
  throw new Error("Installed model checksum mismatch");
const vad = `${directory}/models/ggml-silero-v6.2.0.bin`;
const vadDigest =
  "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987";
if (!existsSync(vad)) {
  run("curl", [
    "--fail",
    "--location",
    "--retry",
    "2",
    "--output",
    `${vad}.part`,
    "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin",
  ]);
  if ((await hash(`${vad}.part`)) !== vadDigest)
    throw new Error("VAD model checksum mismatch");
  renameSync(`${vad}.part`, vad);
}
if ((await hash(vad)) !== vadDigest)
  throw new Error("Installed VAD model checksum mismatch");
run("ffmpeg", ["-version"]);
// Assert the package manager entry point exists; no global install or system service.
JSON.parse(readFileSync("package.json", "utf8"));
console.log(
  "Local Whisper v1.9.4 / multilingual small with Silero v6.2.0 speech detection is ready; no audio captured.",
);

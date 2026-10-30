import { existsSync } from "node:fs";
import { loadStorageConfiguration } from "../apps/server-storage/config";
import { checkStorageContract } from "../apps/server-storage/probe";
export async function runStorageCheck(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const config = loadStorageConfiguration(env);
  if (config.state !== "configured") {
    console.log(
      JSON.stringify({
        ok: false,
        state: config.state,
        code: config.state === "invalid" ? config.code : "unavailable",
      }),
    );
    process.exitCode = 1;
    return;
  }
  const result = await checkStorageContract(config.config);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
if (existsSync(".env")) process.loadEnvFile(".env");
void runStorageCheck();

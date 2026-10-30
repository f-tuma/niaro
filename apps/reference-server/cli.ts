import {
  verifyAttachmentRestore,
  restoreVerifyArguments,
} from "../server-attachments/restore";
import { loadStorageConfiguration } from "../server-storage/config";
import { safeStatus } from "../server-storage/types";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { issueAdminKey } from "../server-admin/auth";
import { issuePairingCode } from "../fixture-server/auth";
import { loadServerConfig, ServerConfigError } from "./config";
import { createReferenceServer, loadServerAdapters } from "./runtime";

// Operator secrets (e.g. SMTP) may live in an ignored .env next to the repo.
if (existsSync(".env")) process.loadEnvFile(".env");

const [mode, ...rest] = process.argv.slice(2);
// The profile is optional: `admin-key --initial` may follow the mode directly.
if (rest[0]?.startsWith("--")) rest.unshift("");
const [profileArgument, user, workspace, ...extra] = rest;
/** No profile: the automatic profile is built from the environment. */
const file = profileArgument || process.env.SERVER_PROFILE || undefined;
/** `admin-key <profile> --initial`: show a key left by an older version once, then delete it. */
const initial = mode === "admin-key" && user === "--initial" && !workspace;
async function main() {
  try {
    if (mode === "attachment-restore-verify") {
      let args: ReturnType<typeof restoreVerifyArguments>;
      try {
        args = restoreVerifyArguments(process.argv.slice(3));
      } catch {
        console.error(
          "Usage: attachment-restore-verify PROFILE [--reconcile FILE] [--activate]",
        );
        process.exitCode = 64;
        return;
      }
      const config = loadServerConfig(
        args.profile || process.env.SERVER_PROFILE || undefined,
      );
      const outcome = await verifyAttachmentRestore(config, {
        reconcile: args.reconcile,
        activate: args.activate,
      });
      console.log(JSON.stringify(outcome.result));
      process.exitCode = outcome.exitCode;
      return;
    }
    if (
      extra.length ||
      !["start", "check", "pair", "admin-key", "admin-rotate-key"].includes(
        mode ?? "",
      ) ||
      (mode !== "pair" && !initial && (user || workspace)) ||
      (mode === "pair" && (!user || !workspace))
    )
      throw new ServerConfigError(
        "Usage: npm run server [-- <profile.json>] | npm run server:check [-- <profile.json>] | npm run server:pair -- <profile.json> <user> <a|b> | npm run server:admin-key -- <profile.json> [--initial] | npm run server:admin-rotate-key -- <profile.json> (the profile defaults to SERVER_PROFILE from .env; without one, the automatic profile is built from NIARO_PUBLIC_URL and NIARO_DATA)",
      );
    const config = loadServerConfig(file);
    if (!file && mode === "start")
      console.log(
        `No server profile: using the automatic profile (data in ${dirname(config.dataDirectory)}).`,
      );
    if (mode === "admin-key" || mode === "admin-rotate-key") {
      if (!config.administration)
        throw new ServerConfigError(
          "Enable administration in the server profile first.",
        );
      // Older versions left the first key in a file next to the key file.
      const waiting = join(
        dirname(config.administration.keyFile),
        "admin-key.initial",
      );
      if (initial) {
        // Printed once: the file is removed as soon as it has been read.
        if (!existsSync(waiting))
          throw new ServerConfigError(
            "No first-start key is waiting: it was already shown, or the key was created another way. Use admin-rotate-key to replace a lost key.",
          );
        const key = readFileSync(waiting, "utf8").trim();
        rmSync(waiting, { force: true });
        console.log(key);
        return;
      }
      if (mode === "admin-key" && existsSync(config.administration.keyFile))
        throw new ServerConfigError(
          "An administrator key already exists and is never shown again. Use admin-rotate-key to replace it.",
        );
      const key = issueAdminKey(
        config.administration.keyFile,
        mode === "admin-rotate-key",
      );
      // A first-start key nobody fetched is no longer valid after a rotation.
      rmSync(waiting, { force: true });
      console.log(key);
    } else if (mode === "pair") {
      const code = issuePairingCode(config.dataDirectory, user!, workspace!);
      console.log(
        `One-use pairing code for ${config.name} / ${user} / ${workspace}, valid five minutes:\n${code}`,
      );
    } else {
      const adapters = loadServerAdapters(config);
      if (mode === "check") {
        const storage = loadStorageConfiguration();
        if (storage.state === "invalid") process.exitCode = 1;
        console.log(
          JSON.stringify(
            {
              valid: storage.state !== "invalid",
              objectStorage: safeStatus(storage),
              name: config.name,
              adapters: Object.fromEntries(
                Object.entries(config.adapters).map(([key, value]) => [
                  key,
                  value.provider,
                ]),
              ),
              note: "Local configuration checked. Remote availability, expiry and calendar scope are checked during use/startup. No network request made.",
            },
            null,
            2,
          ),
        );
      } else {
        // A new installation gets an administrator (recovery) key, stored
        // as a digest only and never shown: `admin-rotate-key` hands out a
        // usable one. The owner is whoever signs up first in the console.
        if (config.administration && !existsSync(config.administration.keyFile))
          issueAdminKey(config.administration.keyFile);
        const identity = config.administration?.identity
          ? await (
              await import("../server-identity/service")
            ).openIdentity(config)
          : undefined;
        if (identity?.setupPending())
          console.log(
            `No owner yet: open ${config.administration!.identity!.baseURL}/admin/ and create the owner account (the first account becomes the owner).`,
          );
        let server;
        try {
          server = createReferenceServer(config, adapters, identity);
          console.log(
            JSON.stringify({
              objectStorage:
                server.objectStorage.state === "unavailable"
                  ? { state: "unavailable", code: server.objectStorage.code }
                  : { state: server.objectStorage.state },
              note: "Storage connectivity is checked only with storage-check.",
            }),
          );
        } catch (error) {
          await identity?.close();
          throw error;
        }
        server.once("close", () => {
          void identity?.close();
        });
        const host = config.listen.host.includes(":")
          ? `[${config.listen.host}]`
          : config.listen.host;
        server.listen(config.listen.port, config.listen.host, () =>
          console.log(
            identity
              ? `${config.name}: ${config.administration!.identity!.baseURL} — sign in from the app using this server address.`
              : `${config.name}: http://${host}:${config.listen.port}/v1/a (or /v1/b). Fixture pairing required.`,
          ),
        );
        if (config.administration)
          console.log(
            `Administration: ${config.administration.identity?.baseURL ?? `http://${host}:${config.listen.port}`}/admin/`,
          );
        if (
          ["0.0.0.0", "::"].includes(config.listen.host) &&
          !config.administration?.identity?.baseURL.startsWith("https:")
        )
          console.warn(
            "Listening on all interfaces without an HTTPS public URL: publish this port on loopback only.",
          );
        for (const signal of ["SIGINT", "SIGTERM"] as const)
          process.once(signal, () => server.close());
        server.on("error", (error: NodeJS.ErrnoException) => {
          console.error(
            `Server could not listen (${error.code ?? "server_error"}).`,
          );
          process.exitCode = 1;
        });
      }
    }
  } catch (error) {
    console.error(
      error instanceof ServerConfigError
        ? error.message
        : "Server setup failed. Check the profile, private files and whether its data directory is already in use.",
    );
    process.exitCode = 1;
  }
}
void main();

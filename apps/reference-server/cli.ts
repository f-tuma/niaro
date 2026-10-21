import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { issueAdminKey } from "../server-admin/auth";
import { issuePairingCode } from "../fixture-server/auth";
import { loadServerConfig, ServerConfigError } from "./config";
import { createReferenceServer, loadServerAdapters } from "./runtime";

// Operator secrets (e.g. SMTP) may live in an ignored .env next to the repo.
if (existsSync(".env")) process.loadEnvFile(".env");

const [mode, profileArgument, user, workspace, ...extra] =
  process.argv.slice(2);
const file = profileArgument || process.env.SERVER_PROFILE;
/** `admin-key <profile> --initial`: show the first-start key once, then delete it. */
const initial = mode === "admin-key" && user === "--initial" && !workspace;
/** Where a first start without a terminal leaves the new key, next to the key file. */
const initialKeyFile = (keyFile: string) =>
  join(dirname(keyFile), "admin-key.initial");
async function main() {
  try {
    if (
      !file ||
      extra.length ||
      !["start", "check", "pair", "admin-key", "admin-rotate-key"].includes(
        mode ?? "",
      ) ||
      (mode !== "pair" && !initial && (user || workspace)) ||
      (mode === "pair" && (!user || !workspace))
    )
      throw new ServerConfigError(
        "Usage: npm run server [-- <profile.json>] | npm run server:check [-- <profile.json>] | npm run server:pair -- <profile.json> <user> <a|b> | npm run server:admin-key -- <profile.json> [--initial] | npm run server:admin-rotate-key -- <profile.json> (start/check profile defaults to SERVER_PROFILE from .env)",
      );
    const config = loadServerConfig(file);
    if (mode === "admin-key" || mode === "admin-rotate-key") {
      if (!config.administration)
        throw new ServerConfigError(
          "Enable administration in the server profile first.",
        );
      const waiting = initialKeyFile(config.administration.keyFile);
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
        console.log(
          JSON.stringify(
            {
              valid: true,
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
        // First start of a new installation: create the administrator key.
        // Only its digest is stored; the plain key waits in a private file
        // and is printed at every start until the owner account exists, so
        // activation needs nothing but the log. Once the owner exists the key
        // is replaced, so the copy in the logs no longer opens anything.
        const waiting = config.administration
          ? initialKeyFile(config.administration.keyFile)
          : undefined;
        if (
          config.administration &&
          !existsSync(config.administration.keyFile)
        ) {
          const key = issueAdminKey(config.administration.keyFile);
          writeFileSync(waiting!, `${key}\n`, { mode: 0o600 });
          chmodSync(waiting!, 0o600);
        }
        const identity = config.administration?.identity
          ? await (
              await import("../server-identity/service")
            ).openIdentity(config)
          : undefined;
        const admin = `${config.administration?.identity?.baseURL ?? "the server"}/admin/`;
        /** The owner exists: retire the logged key and its waiting copy. */
        const activated = () => {
          if (!config.administration || !waiting || !existsSync(waiting))
            return;
          issueAdminKey(config.administration.keyFile, true);
          rmSync(waiting, { force: true });
          console.log(
            "Owner account created: the activation key was replaced. A new recovery key: niaro admin-rotate-key",
          );
        };
        if (config.administration && waiting) {
          const pending = identity ? identity.setupPending() : true;
          if (pending && existsSync(waiting))
            console.log(
              [
                "",
                "=== Activation: create the owner account ===",
                `Open ${admin}, choose "Use a recovery key" and enter:`,
                readFileSync(waiting, "utf8").trim(),
                "This key is printed at every start until the owner exists, then replaced.",
                "============================================",
                "",
              ].join("\n"),
            );
          else if (pending)
            console.log(
              `No owner account yet. Get an activation key with: niaro admin-rotate-key (outside Docker: npm run server:admin-rotate-key -- <profile.json>), then open ${admin}`,
            );
          else activated();
          if (identity && pending) {
            const watch = setInterval(() => {
              if (identity.setupPending()) return;
              clearInterval(watch);
              activated();
            }, 5000);
            watch.unref();
          }
        }
        let server;
        try {
          server = createReferenceServer(config, adapters, identity);
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

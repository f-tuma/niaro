// Docker HEALTHCHECK: GET /healthz on the configured port, inside the container.
// Without a profile file the automatic profile listens on NIARO_PORT (8793).
import { readFileSync } from "node:fs";

const config = process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], "utf8"))
  : {};
const host =
  process.env.NIARO_LISTEN_HOST ?? config.listen?.host ?? "127.0.0.1";
const target = host === "::1" ? "[::1]" : "127.0.0.1";
const port = config.listen?.port ?? (Number(process.env.NIARO_PORT) || 8793);
try {
  const response = await fetch(`http://${target}:${port}/healthz`, {
    signal: AbortSignal.timeout(4000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}

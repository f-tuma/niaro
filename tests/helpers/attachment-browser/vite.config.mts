import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { attachmentClientHttp } from "../attachment-client-http";
const root = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
export default defineConfig(async () => {
  const fixture = await attachmentClientHttp();
  return {
    root,
    plugins: [
      tailwindcss(),
      {
        name: "owned-attachment-contract-fixture",
        configureServer(server) {
          server.middlewares.use("/bootstrap", (_req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                actor: fixture.actor,
                generation: fixture.generation,
              }),
            );
          });
          server.middlewares.use("/evidence", (_req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                calls: fixture.calls,
                puts: fixture.puts,
                commands: fixture.commands,
              }),
            );
          });
          server.httpServer?.on("close", () => {
            void fixture.close();
          });
        },
      },
    ],
    resolve: {
      alias: [
        { find: "@admin", replacement: `${repo}apps/server-admin/web` },
        {
          find: "@openuidev/devtools",
          replacement: `${repo}apps/server-admin/web/lib/openui-devtools-off.ts`,
        },
      ],
      dedupe: ["react", "react-dom"],
    },
    define: { __DEV__: "true", "process.env.NODE_ENV": '"development"' },
    server: {
      host: "127.0.0.1",
      port: 8891,
      strictPort: true,
      fs: { allow: [repo] },
      proxy: {
        "/v1": { target: new URL(fixture.address).origin, changeOrigin: true },
      },
    },
  };
});

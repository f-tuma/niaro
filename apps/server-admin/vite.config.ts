import { defineConfig, type ProxyOptions } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const apiOrigin = process.env.ADMIN_API_ORIGIN ?? "http://localhost:8793";
const apiProxy: ProxyOptions = {
  target: apiOrigin,
  changeOrigin: true,
  configure: (proxy) =>
    proxy.on("proxyReq", (request) => {
      if (request.getHeader("origin")) request.setHeader("origin", apiOrigin);
      request.setHeader("sec-fetch-site", "same-origin");
    }),
};

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/admin/",
  plugins: [tailwindcss()],
  // Development only: proxy the console API to a running reference server so
  // UI work gets hot reload. The server's same-origin checks see its own origin.
  server: {
    port: 5174,
    strictPort: true,
    proxy: { "^/admin/api/": apiProxy, "^/admin/auth/": apiProxy },
  },
  resolve: {
    alias: { "@admin": fileURLToPath(new URL("./web", import.meta.url)) },
  },
  build: {
    outDir: "../../dist-admin",
    emptyOutDir: true,
    assetsInlineLimit: 100000,
    cssCodeSplit: false,
    rolldownOptions: {
      onwarn(warning, warn) {
        // This bundle is entirely client-side; RSC directives carry no semantics here.
        if (
          warning.code === "MODULE_LEVEL_DIRECTIVE" &&
          warning.message.includes('"use client"')
        )
          return;
        warn(warning);
      },
      output: {
        entryFileNames: "app.js",
        assetFileNames: "app.[ext]",
        codeSplitting: false,
      },
    },
  },
});

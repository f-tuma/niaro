const { defineConfig } = require("eslint/config");
const { plugin: shadcn } = require("@shadcn/lint");
const expo = require("eslint-config-expo/flat");
module.exports = defineConfig([
  expo,
  {
    files: ["apps/server-admin/web/**/*.{ts,tsx}"],
    plugins: { shadcn },
    settings: {
      shadcn: {
        ui: "@admin/components/ui",
        note: "Follow apps/server-admin/DESIGN.md: use component variants and console primitives (@admin/components/console) instead of restyling.",
      },
    },
    rules: {
      "shadcn/no-raw-colors": "error",
      "shadcn/no-arbitrary-values": "error",
      "shadcn/no-unknown-classes": "error",
      "shadcn/no-inline-styles": "error",
      "shadcn/require-static-classes": "error",
      // Components own their color, type, shape and effects; call sites may
      // only place them (layout: margin, width, flex/grid placement).
      "shadcn/no-restyle": ["error", { allow: ["layout"] }],
    },
  },
  {
    // The component library owns its own measurements and styling.
    files: ["apps/server-admin/web/components/ui/**"],
    rules: {
      "shadcn/no-arbitrary-values": "off",
      "shadcn/no-restyle": "off",
      "shadcn/no-inline-styles": "off",
      "shadcn/require-static-classes": "off",
    },
  },
  {
    files: ["index.js"],
    rules: { "import/no-unresolved": ["error", { ignore: ["^@app-entry$"] }] },
  },
  {
    ignores: [
      "dist/**",
      "dist-admin/**",
      "dist-storybook/**",
      "dist-audio/**",
      ".fixture/**",
      ".fixture.backup-*/**",
      ".radicale/**",
      ".voice/**",
      ".fixture-calendar/**",
      ".fixture-calendar.backup-*/**",
      ".local-qa/**",
      ".identity/**",
      ".servers/**",
      ".rnstorybook/storybook.requires.ts",
    ],
  },
]);

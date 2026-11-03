// One time zone with daylight saving for every run, also in CI (UTC there):
// day grouping is tested across the autumn and spring changes.
process.env.TZ = "Europe/Prague";
const transformIgnorePatterns =
  require("jest-expo/jest-preset").transformIgnorePatterns.map((pattern) =>
    pattern.replace(
      "|standard-navigation",
      "|standard-navigation|mdast-util-|micromark|decode-named-character-reference|character-entities|devlop|unist-util-|ccount|escape-string-regexp|markdown-table|zwitch|longest-streak|stringify-entities|@assistant-ui|assistant-stream|assistant-cloud|safe-content-frame|nanoid",
    ),
  );
const moduleNameMapper = {
  // Jest's transform skips .mjs; Lucide's per-icon CommonJS build is equivalent.
  "^lucide-react-native/icons/(.*)$":
    "<rootDir>/node_modules/lucide-react-native/dist/cjs/icons/$1.js",
  // No gravity sensor or worklet runtime under Jest: the level liquid of web.
  "^\\./liquid-tilt$": "<rootDir>/packages/ui/liquid-tilt.web.tsx",
};
module.exports = {
  projects: [
    {
      displayName: "core",
      preset: "jest-expo",
      testEnvironment: "node",
      transformIgnorePatterns,
      moduleNameMapper,
      testMatch: ["<rootDir>/tests/**/*.test.ts"],
    },
    {
      displayName: "ui",
      preset: "jest-expo",
      setupFiles: ["<rootDir>/tests/meeting-device-mock.ts"],
      transformIgnorePatterns,
      moduleNameMapper,
      testMatch: ["<rootDir>/tests/**/*.test.tsx"],
      testPathIgnorePatterns: ["/node_modules/", "\\.dom\\.test\\.tsx$"],
    },
    {
      // The web app in a browser-like DOM with its real components, so
      // roles, accessible names and live regions are computed as a browser
      // and a screen reader would (`*.dom.test.tsx`).
      displayName: "dom",
      preset: "jest-expo",
      testEnvironment: "<rootDir>/tests/helpers/jsdom-environment.js",
      transformIgnorePatterns,
      moduleNameMapper,
      testMatch: ["<rootDir>/tests/**/*.dom.test.tsx"],
    },
  ],
};

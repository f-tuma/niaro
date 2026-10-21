# ADR 002 — SDK baseline and isolated Storybook

Date: 2026-09-23. Status: dependency compatibility and Android emulator compilation checked; physical-device compatibility pending.

We retain npm's lockfile and use Expo 57.0.24, React Native 0.86.3, React 19.2.3 and React Native Web 0.21. SDK libraries follow Expo's bundled versions: safe-area-context 5.7, SVG 15.15.4, and Expo audio/dev-client/build-properties/crypto/linear-gradient SDK 57 modules. TypeScript 6.0.3, Jest 29.7 and jest-expo 57 follow the installed SDK recommendations. Node minimum is 22.13; local checks used 22.23.2.

These choices were checked against the [Expo SDK reference](https://docs.expo.dev/versions/latest/), the installed Expo package's `bundledNativeModules.json` and `npx expo install --check`. The latter reports “Dependencies are up to date.” Successful exports are JavaScript/asset checks, not native compilation or hardware verification.

Storybook React Native is pinned to 10.4.0, including its UI/common/theming/React packages through npm overrides. Newer candidate releases required safe-area-context 5.8 while this Expo SDK recommends 5.7. No forced or legacy peer-dependency installation is used. Follow the [Storybook RN setup](https://storybookjs.github.io/react-native/docs/intro/getting-started/) and [Metro configuration](https://storybookjs.github.io/react-native/docs/intro/configuration/metro-configuration/).

`withStorybook` swaps the root entry only when `STORYBOOK_ENABLED=true`; `.rnstorybook/index.tsx` registers the catalog root. The normal app imports neither stories nor Storybook UI. The local scripts disable Storybook's optional channel/MCP server and the Metro config disables its telemetry. Storybook requires a Metro restart when changing entry modes. The audio spike has a third isolated entry and a separate native app identifier.

React Native Testing Library 13.3.3 plus React Test Renderer 19.2.3 test shared component behavior. Core tests use a Node Jest project, including an ephemeral loopback HTTP listener; UI tests use jest-expo. Dependency boundaries and raw UI colors have a lightweight lint check. GitHub Actions config runs these same checks and exports; remote CI remains unexecuted.

Android follow-up: added SDK-compatible `expo-system-ui ~57.0.4` after prebuild identified it as necessary for the configured light appearance. Gradle 9.3.1 / JDK 17 compiled the x86_64 development APK and Expo installed/launched it on the existing `droid` AVD (Android 17/API 37, 16 KiB pages, emulator 37.1.11.0). React Native/Fabric loaded `main`. A native SVG warning required changing the gradient stop offset from a leading-dot string to numeric `0.45`. Android physical hardware, ARM64 and iOS builds remain unverified.

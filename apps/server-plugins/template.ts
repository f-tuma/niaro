/**
 * What "New plugin" in Administration → Plugins starts from: a pure plugin
 * with one tool and one setting, small enough to read in a minute. The same
 * plugin is walked through in docs/plugins.md ("Write your first plugin").
 */
export function pluginTemplate(id: string) {
  const prefix = `internal_${id.replaceAll("-", "_")}_`;
  const title = id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  const manifest = {
    id,
    version: 1,
    name: { en: title, cs: title },
    description: {
      en: "Counts the words and characters of a text.",
      cs: "Spočítá slova a znaky v textu.",
    },
    effect: "pure",
    tools: [
      {
        name: `${prefix}count`,
        title: { en: "Count words", cs: "Spočítat slova" },
        access: "read",
        approval: "none",
      },
    ],
    settings: {
      countSpaces: {
        type: "boolean",
        label: {
          en: "Count spaces as characters",
          cs: "Počítat mezery jako znaky",
        },
        default: false,
      },
    },
  };
  const source = `/**
 * ${title}: a pure plugin made from the template.
 *
 * plugin.json says what the plugin is: its id, names, the tool the model may
 * call (read only, no approval) and one workspace setting. This file says how
 * the tool works. Change both, then Check and Save; docs/plugins.md explains
 * every field.
 */
import type { PluginSdk } from "@niaro/plugin-sdk";

export default function plugin({
  definePlugin,
  defineTool,
  resolved,
  z,
}: PluginSdk) {
  const count = defineTool({
    // The same name as in plugin.json.
    name: "${prefix}count",
    // The model reads this to decide when to call the tool.
    description:
      "Count the words and characters of a text the person gives. Use it instead of counting yourself.",
    // The server checks the model's arguments against this schema first.
    input: z.strictObject({ text: z.string().min(1).max(20000) }),
    run(input, ctx) {
      const words = input.text.trim().split(/\\s+/).filter(Boolean).length;
      // ctx.settings holds this workspace's values of plugin.json's settings.
      const characters = ctx.settings.countSpaces
        ? input.text.length
        : input.text.replace(/\\s/g, "").length;
      // Flat values; an action can use them as $plugin.result_1.words.
      return resolved({ words, characters });
    },
  });

  return definePlugin({ tools: [count] });
}
`;
  return {
    "plugin.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "index.ts": source,
  };
}
